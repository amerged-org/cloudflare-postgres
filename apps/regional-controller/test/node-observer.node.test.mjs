// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:https";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { KubeConfig } from "@kubernetes/client-node";
import { nodeObserverFromConfig } from "../src/node-observer.ts";

const ids = {
  ns: "11111111-1111-4111-8111-111111111111",
  pod: "22222222-2222-4222-8222-222222222222",
  node: "33333333-3333-4333-8333-333333333333",
  boot: "44444444-4444-4444-8444-444444444444",
  owner: "55555555-5555-4555-8555-555555555555",
  replacement: "66666666-6666-4666-8666-666666666666",
};
const digest = (char) => `sha256:${char.repeat(64)}`;
const config = {
  installationId: "test-installation",
  regionId: "test-region",
  observerNamespace: "observer-platform",
  observerNamespaceUid: ids.ns,
  owner: { kind: "DaemonSet", name: "observer", uid: ids.owner },
  image: {
    reference: `ghcr.io/amerged-org/cloudflare-postgres/node-runtime-observer@${digest("a")}`,
    indexDigest: digest("a"),
    amd64Digest: digest("b"),
    configDigest: digest("c"),
  },
  peers: [
    {
      nodeName: "node-a",
      nodeUid: ids.node,
      bootId: ids.boot,
      podName: "observer-a",
      podUid: ids.pod,
    },
  ],
};
const labels = {
  "app.kubernetes.io/managed-by": "cloudflare-postgres",
  "pgcf.io/component": "node-runtime-observer",
};
const podSpec = {
  nodeName: "node-a",
  automountServiceAccountToken: false,
  hostNetwork: false,
  hostPID: false,
  hostIPC: false,
  securityContext: { seccompProfile: { type: "RuntimeDefault" } },
  containers: [
    {
      name: "observer",
      image: config.image.reference,
      command: ["/node-runtime-observer"],
      args: ["agent"],
      env: [
        {
          name: "PGCF_OBSERVER_POD_UID",
          valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
        },
        {
          name: "PGCF_OBSERVER_NAMESPACE",
          valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } },
        },
        {
          name: "PGCF_OBSERVER_NODE_NAME",
          valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } },
        },
        { name: "PGCF_OBSERVER_INSTALLATION_ID", value: config.installationId },
        { name: "PGCF_OBSERVER_REGION_ID", value: config.regionId },
      ],
      securityContext: {
        runAsUser: 0,
        runAsGroup: 0,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      volumeMounts: [
        { name: "cri-socket", mountPath: "/run/cri.sock", readOnly: true },
      ],
    },
  ],
  volumes: [
    {
      name: "cri-socket",
      hostPath: { path: "/run/containerd/containerd.sock", type: "Socket" },
    },
  ],
};
const nanoIso = () =>
  new Date().toISOString().replace(/(\.[0-9]{3})Z$/, "$1000000Z");
function snapshot() {
  return {
    version: 1,
    scope: {
      installationId: config.installationId,
      regionId: config.regionId,
      nodeName: "node-a",
      nodeUid: ids.node,
      expectedBootId: ids.boot,
    },
    bootId: ids.boot,
    startedAt: nanoIso(),
    finishedAt: nanoIso(),
    sandboxes: [
      {
        id: "d".repeat(64),
        podUid: "opaque-tenant-pod",
        namespace: "private-tenant",
        name: "database-1",
        state: "ready",
        createdAtUnixNs: "100",
      },
    ],
    containers: [
      {
        id: "e".repeat(64),
        sandboxId: "d".repeat(64),
        podUid: "opaque-tenant-pod",
        namespace: "private-tenant",
        name: "postgres",
        attempt: 0,
        state: "running",
        createdAtUnixNs: "100",
        startedAtUnixNs: "101",
        finishedAtUnixNs: "0",
      },
    ],
  };
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-node-observer-tls-"));
  const cert = readFileSync(
    fileURLToPath(
      new URL("./fixtures/node-observer-tls/cert.pem", import.meta.url),
    ),
  );
  const key = readFileSync(
    fileURLToPath(
      new URL("./fixtures/node-observer-tls/key.pem", import.meta.url),
    ),
  );
  const state = {
    mode: "valid",
    execs: 0,
    authenticatedReads: 0,
    commands: [],
    replaced: false,
  };
  const server = createServer(
    { key, cert, ca: cert, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      assert.equal(
        request.socket.authorized,
        true,
        "SDK must preserve the configured client certificate",
      );
      state.authenticatedReads += 1;
      const path = new URL(request.url, "https://localhost").pathname;
      let resource;
      if (path === "/api/v1/nodes/node-a")
        resource = {
          apiVersion: "v1",
          kind: "Node",
          metadata: { name: "node-a", uid: ids.node, resourceVersion: "1" },
          status: { nodeInfo: { bootID: ids.boot, architecture: "amd64" } },
        };
      else if (path === "/api/v1/namespaces/observer-platform")
        resource = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: config.observerNamespace, uid: ids.ns, labels },
          status: { phase: "Active" },
        };
      else if (path === "/api/v1/namespaces/observer-platform/pods/observer-a")
        resource = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: "observer-a",
            namespace: config.observerNamespace,
            uid: state.replaced ? ids.replacement : ids.pod,
            labels,
            resourceVersion: "1",
            ownerReferences: [
              {
                kind: "DaemonSet",
                apiVersion: "apps/v1",
                name: "observer",
                uid: ids.owner,
                controller: true,
              },
            ],
          },
          spec: structuredClone(podSpec),
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
            containerStatuses: [
              {
                name: "observer",
                image: config.image.reference,
                imageID:
                  state.mode === "index-image"
                    ? config.image.reference
                    : digest("c"),
                containerID: `containerd://${"f".repeat(64)}`,
                restartCount: 0,
                ready: true,
                state: { running: { startedAt: "2026-09-29T00:00:00Z" } },
              },
            ],
          },
        };
      else if (
        path ===
        "/apis/apps/v1/namespaces/observer-platform/daemonsets/observer"
      )
        resource = {
          apiVersion: "apps/v1",
          kind: "DaemonSet",
          metadata: {
            name: "observer",
            namespace: config.observerNamespace,
            uid: ids.owner,
            generation: 1,
            labels,
          },
          spec: {
            selector: { matchLabels: labels },
            template: { metadata: { labels }, spec: structuredClone(podSpec) },
          },
          status: { observedGeneration: 1 },
        };
      if (!resource) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (state.mode === "unconfined" && resource.kind === "Pod")
        resource.spec.containers[0].securityContext.seccompProfile = {
          type: "Unconfined",
        };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(resource));
    },
  );
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => "v4.channel.k8s.io",
  });
  server.on("upgrade", (request, socket, head) => {
    state.offeredProtocols = request.headers["sec-websocket-protocol"]
      .split(",")
      .map((value) => value.trim());
    assert.equal(request.socket.authorized, true);
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request),
    );
  });
  wss.on("connection", (ws, request) => {
    state.execs += 1;
    const commands = new URL(
      request.url,
      "https://localhost",
    ).searchParams.getAll("command");
    state.commands.push(commands);
    const requestId = commands[commands.indexOf("--request-id") + 1];
    const envelope = {
      version: 1,
      requestId,
      observerPodUid: ids.pod,
      observerNamespace: config.observerNamespace,
      observerNodeName: "node-a",
      snapshot: snapshot(),
    };
    setImmediate(() => {
      ws.send(
        Buffer.concat([
          Buffer.from([1]),
          Buffer.from(JSON.stringify(envelope)),
        ]),
      );
      if (state.mode === "premature") {
        ws.close();
        return;
      }
      if (state.mode === "replacement") state.replaced = true;
      const status =
        state.mode === "nonzero"
          ? {
              kind: "Status",
              apiVersion: "v1",
              status: "Failure",
              reason: "NonZeroExitCode",
              details: { causes: [{ reason: "ExitCode", message: "2" }] },
            }
          : { kind: "Status", apiVersion: "v1", status: "Success" };
      ws.send(
        Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify(status))]),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const kubeconfigFile = join(directory, "kubeconfig.json");
  writeFileSync(
    kubeconfigFile,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "local",
          cluster: {
            server: `https://127.0.0.1:${server.address().port}`,
            "tls-server-name": "localhost",
            "certificate-authority-data": cert.toString("base64"),
          },
        },
      ],
      contexts: [
        { name: "test", context: { cluster: "local", user: "fixture" } },
      ],
      "current-context": "test",
      users: [
        {
          name: "fixture",
          user: {
            "client-certificate-data": cert.toString("base64"),
            "client-key-data": key.toString("base64"),
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return { state, kubeconfigFile };
}

test("observes through maintained SDK mutual-TLS Exec only after full challenged stdout, successful exit and unchanged scope metadata", async (t) => {
  const f = await fixture(t);
  const observer = nodeObserverFromConfig(f.kubeconfigFile, "test", config);
  const result = await observer.observeNode("node-a");
  assert.equal(result.envelope.observerPodUid, ids.pod);
  assert.equal(
    result.envelope.snapshot.scope.installationId,
    config.installationId,
  );
  assert.equal(result.envelope.snapshot.containers[0].createdAtUnixNs, "100");
  assert.match(result.probeHash, /^[a-f0-9]{64}$/);
  assert.ok(
    f.state.authenticatedReads >= 8,
    "fresh owner, namespace, Pod and Node reads bracket Exec",
  );
  assert.equal(f.state.execs, 1);
  assert.deepEqual(f.state.offeredProtocols, ["v4.channel.k8s.io"]);
  f.state.mode = "index-image";
  const pinned = await observer.observeNode("node-a");
  assert.equal(pinned.envelope.observerPodUid, ids.pod);
  assert.equal(
    f.state.execs,
    2,
    "the observed exact repository index reference remains qualified",
  );

  assert.deepEqual(f.state.commands[0].slice(0, 3), [
    "/node-runtime-observer",
    "observe",
    "--request-id",
  ]);
  assert.match(
    f.state.commands[0][3],
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
  );
  await assert.rejects(
    observer.observeNode("foreign-node"),
    /node_observation_unknown/,
  );
  assert.equal(f.state.execs, 2, "unconfigured peer must never dispatch");
});

test("refuses nonzero or premature Exec, replaced observer identity and authority lost during async SDK authentication without exposing raw responses", async (t) => {
  const f = await fixture(t);
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    assert.throws(
      () => nodeObserverFromConfig(f.kubeconfigFile, "test", config),
      /^Error: node_observation_unknown$/,
    );
  } finally {
    if (previousTls === undefined)
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  }
  const observer = nodeObserverFromConfig(f.kubeconfigFile, "test", config);
  await observer.observeNode("node-a");
  f.state.mode = "nonzero";
  await assert.rejects(
    observer.observeNode("node-a"),
    /^Error: node_observation_unknown$/,
  );
  f.state.mode = "premature";
  await assert.rejects(
    observer.observeNode("node-a"),
    /^Error: node_observation_unknown$/,
  );
  f.state.mode = "replacement";
  await assert.rejects(
    observer.observeNode("node-a"),
    /^Error: node_observation_unknown$/,
  );
  f.state.replaced = false;
  f.state.mode = "unconfined";
  await assert.rejects(
    observer.observeNode("node-a"),
    /^Error: node_observation_unknown$/,
  );

  f.state.mode = "valid";
  let permitted = true;
  const original = KubeConfig.prototype.applyToHTTPSOptions;
  KubeConfig.prototype.applyToHTTPSOptions = async function (options) {
    await original.call(this, options);
    permitted = false;
  };
  const before = f.state.execs;
  try {
    const guarded = nodeObserverFromConfig(
      f.kubeconfigFile,
      "test",
      config,
      () => {
        if (!permitted) throw new Error("private authority error");
      },
    );
    await assert.rejects(
      guarded.observeNode("node-a"),
      /^Error: node_observation_unknown$/,
    );
  } finally {
    KubeConfig.prototype.applyToHTTPSOptions = original;
  }
  assert.equal(
    f.state.execs,
    before,
    "late authentication must not bypass authority at socket dispatch",
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    nodeObserverFromConfig(
      f.kubeconfigFile,
      "test",
      config,
      () => {},
      aborted.signal,
    ).observeNode("node-a"),
    /^Error: node_observation_unknown$/,
  );
  assert.equal(f.state.execs, before);
});
