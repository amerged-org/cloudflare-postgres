// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { test } from "node:test";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { networkInterfaces, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import {
  kubernetesFromConfig,
  kubeletSummary,
} from "../../src/agent/kubernetes.ts";
import type { Resource } from "../../src/agent/types.ts";
import { validateKubeletTrust } from "../../src/agent/kubelet-trust.ts";
import { nodeMemorySample } from "../../src/agent/node-memory.ts";

test("PVC reads use the core API and retain resource identity", async (t) => {
  const namespace = "pgcf-test";
  const name = "database-1";
  const uid = randomUUID();
  let reads = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) => {
    if (type === CoreV1Api)
      return {
        async readNamespacedPersistentVolumeClaim(input: {
          namespace: string;
          name: string;
        }) {
          assert.deepEqual(input, { namespace, name });
          reads++;
          return {
            metadata: { namespace, name, uid, resourceVersion: "1" },
            status: { phase: "Bound" },
          };
        },
      };
    return {};
  });
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  const claim = await k8s.read("PersistentVolumeClaim", namespace, name);
  assert.equal(reads, 1);
  assert.equal(claim?.kind, "PersistentVolumeClaim");
  assert.equal(claim?.apiVersion, "v1");
  assert.equal(claim?.metadata.uid, uid);
});

test("ConfigMap deletion routes exact UID and resourceVersion preconditions through the core client", async (t) => {
  const namespace = "pgcf-system",
    name = "fixture",
    uid = randomUUID(),
    resourceVersion = "12";
  let deleted = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) =>
    type === CoreV1Api
      ? {
          async deleteNamespacedConfigMap(input: unknown) {
            assert.deepEqual(input, {
              name,
              namespace,
              body: {
                preconditions: { uid, resourceVersion },
                propagationPolicy: "Foreground",
              },
            });
            deleted++;
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  await k8s.delete("ConfigMap", namespace, name, uid, resourceVersion);
  assert.equal(deleted, 1);
});

test("Backup reads and lists use the pinned CNPG API and bounded namespaced pagination", async (t) => {
  const namespace = "pgcf-test",
    name = "base-backup",
    uid = randomUUID();
  let pages = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) =>
    type === CustomObjectsApi
      ? {
          async getNamespacedCustomObject(input: unknown) {
            assert.deepEqual(input, {
              group: "postgresql.cnpg.io",
              version: "v1",
              plural: "backups",
              namespace,
              name,
            });
            return { metadata: { name, namespace, uid, resourceVersion: "2" } };
          },
          async listNamespacedCustomObject(input: { _continue?: string }) {
            pages++;
            assert.deepEqual(input, {
              group: "postgresql.cnpg.io",
              version: "v1",
              plural: "backups",
              namespace,
              limit: 100,
              labelSelector: "cnpg.io/cluster=database",
              _continue: pages === 1 ? undefined : "next",
            });
            return {
              metadata: {
                resourceVersion: "2",
                ...(pages === 1 ? { continue: "next" } : {}),
              },
              items:
                pages === 1
                  ? [
                      {
                        metadata: {
                          name,
                          namespace,
                          uid,
                          resourceVersion: "2",
                        },
                      },
                    ]
                  : [],
            };
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  assert.equal((await k8s.read("Backup", namespace, name))?.metadata.uid, uid);
  const backups = await k8s.list(
    "Backup",
    namespace,
    "cnpg.io/cluster=database",
  );
  assert.equal(backups[0]?.kind, "Backup");
  assert.equal(backups[0]?.apiVersion, "postgresql.cnpg.io/v1");
  assert.equal(pages, 2);
});

test("direct kubelet stats require the cluster CA and verified TLS, use only InternalIP and bound JSON", async (t) => {
  const config = new KubeConfig(),
    signal = new AbortController().signal;
  const address = [10, 20, 1, 2].join(".");
  const node: Resource = {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "worker", uid: randomUUID() },
    status: { addresses: [{ type: "InternalIP", address }] },
  };
  t.mock.method(config, "getCurrentCluster", () => ({
    name: "fixture",
    server: "https://kubernetes",
    caData: Buffer.from(randomUUID()).toString("base64"),
  }));
  t.mock.method(
    config,
    "applyToHTTPSOptions",
    async (options: https.RequestOptions) => {
      options.ca = Buffer.from(randomUUID());
      options.headers = { Authorization: `Bearer ${randomUUID()}` };
    },
  );
  let requests = 0;
  t.mock.method(
    https,
    "request",
    (
      options: https.RequestOptions,
      callback: (response: PassThrough & { statusCode: number }) => void,
    ) => {
      requests++;
      assert.equal(options.hostname, address);
      assert.equal(options.port, 10250);
      assert.equal(options.path, "/stats/summary");
      assert.equal(options.method, "GET");
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assert.equal(options.servername, "");
      assert.ok(options.ca);
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () => {
        const response = Object.assign(new PassThrough(), { statusCode: 200 });
        callback(response);
        response.end(
          JSON.stringify({ node: { nodeName: node.metadata.name }, pods: [] }),
        );
      };
      return request;
    },
  );
  assert.deepEqual(await kubeletSummary(config, node, signal), {
    node: { nodeName: node.metadata.name },
    pods: [],
  });
  node.status = { addresses: [{ type: "ExternalIP", address }] };
  await assert.rejects(
    kubeletSummary(config, node, signal),
    /kubelet_node_invalid/,
  );
  node.status = { addresses: [{ type: "InternalIP", address }] };
  t.mock.method(config, "getCurrentCluster", () => ({
    name: "fixture",
    server: "https://kubernetes",
    skipTLSVerify: true,
  }));
  await assert.rejects(
    kubeletSummary(config, node, signal),
    /kubelet_tls_invalid/,
  );
  assert.equal(requests, 1);
});

test("PVC inventory routes core API pages, including hibernated claims", async (t) => {
  const namespace = "pgcf-test",
    uid = randomUUID();
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) =>
    type === CoreV1Api
      ? {
          async listNamespacedPersistentVolumeClaim(input: unknown) {
            assert.deepEqual(input, {
              namespace,
              limit: 100,
              labelSelector: "cnpg.io/cluster=database",
              _continue: undefined,
            });
            return {
              metadata: { resourceVersion: "1" },
              items: [{ metadata: { name: "database-1", namespace, uid } }],
            };
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  assert.equal(
    (
      await k8s.list(
        "PersistentVolumeClaim",
        namespace,
        "cnpg.io/cluster=database",
      )
    )[0]?.metadata.uid,
    uid,
  );
});

test("kubelet summaries reject responses beyond the fixed byte bound and retain no open request", async (t) => {
  const config = new KubeConfig(),
    signal = new AbortController().signal;
  const node: Resource = {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "worker", uid: randomUUID() },
    status: {
      addresses: [{ type: "InternalIP", address: [10, 20, 1, 2].join(".") }],
    },
  };
  t.mock.method(config, "getCurrentCluster", () => ({
    name: "fixture",
    server: "https://kubernetes",
    caData: Buffer.from(randomUUID()).toString("base64"),
  }));
  t.mock.method(
    config,
    "applyToHTTPSOptions",
    async (options: https.RequestOptions) => {
      options.ca = Buffer.from(randomUUID());
    },
  );
  let destroyed = false;
  t.mock.method(
    https,
    "request",
    (
      _options: https.RequestOptions,
      callback: (response: PassThrough & { statusCode: number }) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () => {
        const response = Object.assign(new PassThrough(), { statusCode: 200 });
        response.on("close", () => {
          destroyed = response.destroyed;
        });
        callback(response);
        response.end(Buffer.alloc(8 * 1024 * 1024 + 1));
      };
      return request;
    },
  );
  await assert.rejects(
    kubeletSummary(config, node, signal),
    /kubelet_stats_too_large/,
  );
  assert.equal(destroyed, true);
});

test("an authenticated kubelet certificate pin enables real TLS for the bound node hostname and refuses a replacement leaf", async (t) => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.internal && entry.family === "IPv4")?.address;
  assert.ok(address);
  const directory = mkdtempSync(join(tmpdir(), "pgcf-kubelet-cert-"));
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const keyPath = join(directory, "credential");
  writeFileSync(keyPath, key, { mode: 0o600 });
  let certificatePem: string;
  let noSanCertificatePem: string;
  try {
    certificatePem = execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        keyPath,
        "-days",
        "1",
        "-subj",
        "/CN=pgcf-test",
        "-addext",
        "subjectAltName=DNS:kubernetes",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    noSanCertificatePem = execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        keyPath,
        "-days",
        "1",
        "-subj",
        "/CN=kubernetes",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const token = randomUUID();
  const observedAt = Date.now();
  const summary = {
    node: {
      nodeName: "kubernetes",
      memory: {
        time: new Date(observedAt).toISOString(),
        workingSetBytes: 512 * 2 ** 20,
        availableBytes: 512 * 2 ** 20,
      },
    },
    pods: [],
  };
  let status = 200;
  const server = https.createServer(
    { cert: certificatePem, key },
    (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.url, "/stats/summary");
      response.statusCode = status;
      response.end(JSON.stringify(summary));
    },
  );
  server.listen(0, address);
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const original = https.request.bind(https);
  t.mock.method(
    https,
    "request",
    (
      options: https.RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => original({ ...options, port }, callback),
  );
  const config = new KubeConfig();
  t.mock.method(config, "getCurrentCluster", () => ({
    name: "fixture",
    server: "https://kubernetes",
    caData: Buffer.from(randomUUID()).toString("base64"),
  }));
  t.mock.method(
    config,
    "applyToHTTPSOptions",
    async (options: https.RequestOptions) => {
      options.ca = Buffer.from(randomUUID());
      options.headers = { Authorization: `Bearer ${token}` };
    },
  );
  const node: Resource = {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "kubernetes", uid: randomUUID() },
    status: {
      addresses: [{ type: "InternalIP", address }],
      capacity: { memory: "1Gi" },
      conditions: [
        { type: "Ready", status: "True" },
        { type: "MemoryPressure", status: "False" },
      ],
    },
  };
  const pin = {
    certificatePem,
    leafSha256: createHash("sha256")
      .update(new X509Certificate(certificatePem).raw)
      .digest("hex"),
    serverName: node.metadata.name,
  };
  assert.deepEqual(
    await kubeletSummary(config, node, new AbortController().signal, pin),
    summary,
  );
  assert.equal(
    nodeMemorySample(
      node,
      await kubeletSummary(config, node, new AbortController().signal, pin),
      observedAt,
    )?.capacity_memory_bytes,
    2 ** 30,
  );
  status = 503;
  await assert.rejects(
    kubeletSummary(config, node, new AbortController().signal, pin),
    /kubelet_stats_unavailable/,
  );
  status = 200;
  await assert.rejects(
    kubeletSummary(config, node, new AbortController().signal, {
      ...pin,
      leafSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    }),
    /kubelet_pin_mismatch/,
  );
  await assert.rejects(
    kubeletSummary(config, node, new AbortController().signal),
    /kubelet_tls_failed/,
  );
  const clusterUid = randomUUID();
  const map: Resource = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `kubelet-${node.metadata.uid}`,
      namespace: "pgcf-system",
      uid: randomUUID(),
      resourceVersion: "1",
      labels: { "pgcf.io/kubelet-node-uid": node.metadata.uid! },
    },
    data: {
      node_name: node.metadata.name,
      node_uid: node.metadata.uid,
      cluster_uid: clusterUid,
      certificate_pem: noSanCertificatePem,
      certificate_sha256: createHash("sha256")
        .update(noSanCertificatePem, "utf8")
        .digest("hex"),
    },
  };
  assert.throws(
    () => validateKubeletTrust(map, node, clusterUid, Date.now()),
    /kubelet_trust_invalid/,
  );
  server.setSecureContext({ cert: noSanCertificatePem, key });
  await assert.rejects(
    kubeletSummary(config, node, new AbortController().signal, {
      ...pin,
      certificatePem: noSanCertificatePem,
      leafSha256: createHash("sha256")
        .update(new X509Certificate(noSanCertificatePem).raw)
        .digest("hex"),
    }),
    /kubelet_tls_identity_invalid/,
  );
  server.setSecureContext({ cert: certificatePem, key });
  const data = map.data as Record<string, string>;
  data.certificate_pem = certificatePem;
  data.certificate_sha256 = createHash("sha256")
    .update(certificatePem, "utf8")
    .digest("hex");
  let artifactReads = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "getCurrentCluster", () => ({
    name: "fixture",
    server: "https://kubernetes",
    caData: Buffer.from(randomUUID()).toString("base64"),
  }));
  t.mock.method(
    KubeConfig.prototype,
    "applyToHTTPSOptions",
    async (options: https.RequestOptions) => {
      options.ca = Buffer.from(randomUUID());
      options.headers = { Authorization: `Bearer ${token}` };
    },
  );
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) =>
    type === CoreV1Api
      ? {
          async readNamespace(input: { name: string }) {
            assert.equal(input.name, "kube-system");
            return {
              metadata: {
                name: input.name,
                uid: clusterUid,
                resourceVersion: "1",
              },
            };
          },
          async readNamespacedConfigMap(input: {
            namespace: string;
            name: string;
          }) {
            assert.deepEqual(input, {
              namespace: "pgcf-system",
              name: map.metadata.name,
            });
            artifactReads++;
            return structuredClone(map);
          },
        }
      : {},
  );
  const adapter = kubernetesFromConfig(
    new AbortController().signal,
    "test-config",
  );
  assert.deepEqual(await adapter.statsSummary!(node), summary);
  assert.equal(artifactReads, 1);
  data.cluster_uid = randomUUID();
  const foreign = kubernetesFromConfig(
    new AbortController().signal,
    "test-config",
  );
  await assert.rejects(foreign.statsSummary!(node), /kubelet_trust_invalid/);
});
