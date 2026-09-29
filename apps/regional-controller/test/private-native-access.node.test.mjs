// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { reconcileEnvironment } from "../src/reconcile.ts";
import { testCA, testLeaf } from "./fixtures/native-certificates.mjs";

const environmentId = "11111111-1111-4111-8111-111111111111";
const regionId = "22222222-2222-4222-8222-222222222222";
const namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
const clusterUid = "33333333-3333-4333-8333-333333333333";
const namespaceUid = "44444444-4444-4444-8444-444444444444";
const clientNamespaceUid = "55555555-5555-4555-8555-555555555555";
const clientServiceAccountUid = "66666666-6666-4666-8666-666666666666";
const serviceUid = "77777777-7777-4777-8777-777777777777";
const primaryUid = "88888888-8888-4888-8888-888888888888";
const sliceUid = "99999999-9999-4999-8999-999999999999";
const clusterOwner = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  name: "database",
  uid: clusterUid,
  controller: true,
};
function fixture() {
  const spec = {
    name: "private-native",
    regionId,
    catalogVersion: "native-v1",
    profileId: "small",
    volumeGiB: 5,
    profile: {
      id: "small",
      postgresImage: `example.invalid/postgres@sha256:${"a".repeat(64)}`,
      compute: { cpuMilli: 500, memoryMiB: 512 },
      storage: {
        classId: "local",
        storageClassName: "test-local",
        minGiB: 5,
        maxGiB: 50,
        stepGiB: 5,
      },
      instances: 1,
      backup: {
        endpointURL: "https://archive.example.invalid",
        region: "auto",
        destinationPath: "s3://fixture-backups/native",
        retentionPolicy: "7d",
        credentialSecret: {
          namespace: "platform",
          name: "backups",
          accessKeyIdKey: "access",
          secretAccessKeyKey: "secret",
        },
      },
      nativeAccess: { version: 1, clientProfileId: "private-application" },
    },
  };
  const claim = {
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    environmentId,
    regionId,
    kind: "environment.create",
    leaseToken: "opaque-test-only",
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    specRevision: 1,
    specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    spec,
  };
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": environmentId,
    "pgcf.io/region-id": regionId,
  };
  const metadata = (name, uid) => ({
    name,
    namespace,
    uid,
    resourceVersion: "10",
    generation: 1,
    labels: { ...labels },
    annotations: { "pgcf.io/spec-hash": claim.specHash },
  });
  const primary = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...metadata("database-1", primaryUid),
      ownerReferences: [clusterOwner],
      labels: {
        "cnpg.io/cluster": "database",
        "cnpg.io/podRole": "instance",
        "cnpg.io/instanceRole": "primary",
      },
    },
    spec: { nodeName: "trusted-node" },
    status: {
      phase: "Running",
      podIP: "10.0.0.5",
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      ...metadata("database-rw", serviceUid),
      labels: { "cnpg.io/cluster": "database" },
      ownerReferences: [clusterOwner],
    },
    spec: {
      type: "ClusterIP",
      clusterIP: "10.96.0.4",
      selector: {
        "cnpg.io/cluster": "database",
        "cnpg.io/instanceRole": "primary",
      },
      ports: [
        { name: "postgres", protocol: "TCP", port: 5432, targetPort: 5432 },
      ],
    },
  };
  const slice = {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    addressType: "IPv4",
    metadata: {
      ...metadata("database-rw-one", sliceUid),
      labels: {
        "kubernetes.io/service-name": "database-rw",
        "endpointslice.kubernetes.io/managed-by":
          "endpointslice-controller.k8s.io",
      },
      ownerReferences: [
        {
          apiVersion: "v1",
          kind: "Service",
          name: "database-rw",
          uid: serviceUid,
          controller: true,
        },
      ],
    },
    ports: [{ name: "postgres", protocol: "TCP", port: 5432 }],
    endpoints: [
      {
        addresses: ["10.0.0.5"],
        conditions: { ready: true, serving: true, terminating: false },
        targetRef: {
          kind: "Pod",
          namespace,
          name: "database-1",
          uid: primaryUid,
        },
      },
    ],
  };
  const clientNamespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "private-applications",
      uid: clientNamespaceUid,
      resourceVersion: "10",
      labels: { "pgcf.io/native-client-uid": clientNamespaceUid },
    },
  };
  const clientServiceAccount = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: "private-client",
      namespace: "private-applications",
      uid: clientServiceAccountUid,
      resourceVersion: "10",
    },
  };
  const resources = new Map([
    ["Service:" + namespace + ":database-rw", service],
    ["Pod:" + namespace + ":database-1", primary],
    ["Namespace::private-applications", clientNamespace],
    [
      "ServiceAccount:private-applications:private-client",
      clientServiceAccount,
    ],
  ]);
  const creations = [];
  let lost = true;
  const api = {
    async read(kind, ns, name) {
      return structuredClone(resources.get(`${kind}:${ns}:${name}`) ?? null);
    },
    async create(value) {
      const item = structuredClone(value);
      item.metadata.uid =
        item.kind === "Cluster"
          ? clusterUid
          : item.kind === "Namespace"
            ? namespaceUid
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      item.metadata.resourceVersion = "10";
      item.metadata.generation = 1;
      if (item.kind === "Cluster") {
        item.status = {
          currentPrimary: "database-1",
          writeService: "database-rw",
          readyInstances: 1,
          conditions: [
            { type: "Ready", status: "True", observedGeneration: 1 },
          ],
          certificates: {
            serverCASecret: "database-ca",
            serverTLSSecret: "database-server",
          },
        };
      }
      resources.set(
        `${item.kind}:${item.metadata.namespace ?? ""}:${item.metadata.name}`,
        item,
      );
      creations.push(item);
      if (item.metadata.name === "native-client-access" && lost) {
        lost = false;
        throw new Error("lost committed policy response");
      }
      return structuredClone(item);
    },
    async readSecret(ns, name) {
      assert.equal(ns, "platform");
      assert.equal(name, "backups");
      return { access: "ZmFrZS1hY2Nlc3M=", secret: "ZmFrZS1zZWNyZXQ=" };
    },
    async listPods() {
      return [structuredClone(primary)];
    },
    async listEndpointSlices(ns, name) {
      assert.equal(ns, namespace);
      assert.equal(name, "database-rw");
      return [structuredClone(slice)];
    },
    async readPublicCertificate(ns, name, key) {
      assert.equal(ns, namespace);
      assert.equal(name, key === "ca.crt" ? "database-ca" : "database-server");
      return {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          ...metadata(
            name,
            key === "ca.crt"
              ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
              : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          ),
          ownerReferences: [clusterOwner],
        },
        data: {
          [key]: Buffer.from(key === "ca.crt" ? testCA : testLeaf).toString(
            "base64",
          ),
        },
      };
    },
  };
  const config = {
    operatorNamespace: "cnpg-system",
    operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
    allowedBackupSecrets: [spec.profile.backup.credentialSecret],
    nativeClientProfiles: [
      {
        id: "private-application",
        namespace: "private-applications",
        namespaceUid: clientNamespaceUid,
        serviceAccount: "private-client",
        serviceAccountUid: clientServiceAccountUid,
      },
    ],
  };
  return {
    api,
    claim,
    config,
    resources,
    creations,
    slice,
    service,
    primary,
    clientNamespace,
  };
}

test("converges an owned private native grant after an uncertain policy create and publishes the actual CNPG direct TLS identity", async () => {
  const f = fixture();
  assert.equal(f.service.spec.ports[0].name, "postgres");
  assert.equal(f.slice.ports[0].name, "postgres");
  const first = await reconcileEnvironment(f.api, f.claim, f.config);
  assert.equal(first.ready, true);
  assert.equal(
    first.observation?.nativeConnection?.host,
    `database-rw.${namespace}.svc`,
    "ordinary application access must produce an owned private direct endpoint",
  );
  assert.equal(first.observation.nativeConnection.serviceUid, serviceUid);
  assert.equal(first.observation.nativeConnection.endpointSliceUid, sliceUid);
  assert.equal(first.observation.nativeConnection.primaryPodUid, primaryUid);
  assert.equal(first.observation.nativeConnection.caCertificate, testCA);
  assert.equal(first.observation.nativeConnection.specHash, f.claim.specHash);
  const grant = f.creations.find(
    (item) => item.metadata.name === "native-client-access",
  );
  assert.deepEqual(grant.metadata.ownerReferences, [clusterOwner]);
  assert.deepEqual(grant.spec.ingress, [
    {
      fromEndpoints: [
        {
          matchLabels: {
            "k8s:io.kubernetes.pod.namespace": "private-applications",
            "k8s:io.cilium.k8s.policy.serviceaccount": "private-client",
            "k8s:io.cilium.k8s.namespace.labels.pgcf.io/native-client-uid":
              clientNamespaceUid,
          },
        },
      ],
      toPorts: [{ ports: [{ port: "5432", protocol: "TCP" }] }],
    },
  ]);
  const second = await reconcileEnvironment(f.api, f.claim, f.config);
  assert.equal(second.ready, true);
  assert.equal(
    f.creations.filter((item) => item.metadata.name === "native-client-access")
      .length,
    1,
  );
  assert.equal(JSON.stringify(second).includes("PRIVATE KEY"), false);
  const legacy = fixture();
  delete legacy.claim.spec.profile.nativeAccess;
  legacy.claim.specHash = createHash("sha256")
    .update(JSON.stringify(legacy.claim.spec))
    .digest("hex");
  const old = await reconcileEnvironment(
    legacy.api,
    legacy.claim,
    legacy.config,
  );
  assert.deepEqual(old.observation, {
    clusterUid,
    clusterGeneration: 1,
    readyInstances: 1,
  });
  assert.equal(
    legacy.creations.some(
      (item) => item.metadata.name === "native-client-access",
    ),
    false,
  );
});

test("refuses unapproved or replaced private-client identity, foreign routing, untrusted TLS and a lost authority before granting or publishing access", async () => {
  const unapproved = fixture();
  unapproved.config.nativeClientProfiles = [];
  await assert.rejects(
    reconcileEnvironment(unapproved.api, unapproved.claim, unapproved.config),
    /native_client_profile_unavailable/,
  );
  assert.equal(unapproved.creations.length, 0);
  const replaced = fixture();
  replaced.clientNamespace.metadata.uid =
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await assert.rejects(
    reconcileEnvironment(replaced.api, replaced.claim, replaced.config),
    /native_client_identity_changed/,
  );
  assert.equal(replaced.creations.length, 0);
  const foreign = fixture();
  foreign.service.metadata.ownerReferences = [
    { ...clusterOwner, uid: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
  ];
  await assert.rejects(
    reconcileEnvironment(foreign.api, foreign.claim, foreign.config),
    /native_service_identity_unproven/,
  );
  assert.equal(
    foreign.creations.some(
      (item) => item.metadata.name === "native-client-access",
    ),
    false,
  );
  const invalidTLS = fixture();
  const certificateReader = invalidTLS.api.readPublicCertificate;
  invalidTLS.api.readPublicCertificate = async (ns, name, key) => {
    const cert = await certificateReader(ns, name, key);
    if (key === "tls.crt")
      cert.data[key] = Buffer.from(testCA).toString("base64");
    return cert;
  };
  await assert.rejects(
    reconcileEnvironment(invalidTLS.api, invalidTLS.claim, invalidTLS.config),
    /native_tls_identity_unproven/,
  );
  assert.equal(
    invalidTLS.creations.some(
      (item) => item.metadata.name === "native-client-access",
    ),
    false,
  );
  const revoked = fixture();
  const originalRead = revoked.api.read;
  let authorized = true;
  revoked.api.read = async (kind, ns, name) => {
    const value = await originalRead(kind, ns, name);
    if (kind === "Service") authorized = false;
    return value;
  };
  await assert.rejects(
    reconcileEnvironment(revoked.api, revoked.claim, revoked.config, () => {
      if (!authorized) throw new Error("authority_lost");
    }),
    /authority_lost/,
  );
  assert.equal(
    revoked.creations.some(
      (item) => item.metadata.name === "native-client-access",
    ),
    false,
  );
});
