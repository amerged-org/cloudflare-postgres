// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDatabase } from "../src/database-reconcile.ts";

const claim = {
  schemaVersion: 1,
  kind: "database.create",
  operationId: "11111111-1111-4111-8111-111111111111",
  organizationId: "88888888-8888-4888-8888-888888888888",
  projectId: "99999999-9999-4999-8999-999999999999",
  environmentId: "22222222-2222-4222-8222-222222222222",
  regionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  specRevision: 1,
  specHash: "a".repeat(64),
  namespaceUid: "33333333-3333-4333-8333-333333333333",
  clusterUid: "44444444-4444-4444-8444-444444444444",
  databaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  databaseName: "customerdb",
  ownerRoleId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ownerRoleName: "dbowner",
  ownerRoleUid: "55555555-5555-4555-8555-555555555555",
  ownerCredentialRevision: 1,
  secretUid: "66666666-6666-4666-8666-666666666666",
  secretResourceVersion: "101",
  password: "p".repeat(43),
  leaseToken: "cplease_" + "l".repeat(43),
  leaseEpoch: 1,
  leaseExpiresAt: new Date(Date.now() + 90000).toISOString(),
};
const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`;
const config = {
  verifierNamespace: "pgcf-system",
  verifierPodLabels: { "app.kubernetes.io/name": "pgcf-regional-controller" },
};
function fixture(existingSql = false) {
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": claim.environmentId,
    "pgcf.io/region-id": claim.regionId,
  };
  const annotations = { "pgcf.io/spec-hash": claim.specHash };
  const owner = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    name: "database",
    uid: claim.clusterUid,
    controller: true,
  };
  const key = (kind, ns, name) => `${kind}/${ns}/${name}`;
  const resources = new Map();
  const put = (v) =>
    resources.set(key(v.kind, v.metadata.namespace ?? "", v.metadata.name), v);
  put({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: claim.namespaceUid,
      resourceVersion: "10",
      labels,
      annotations,
    },
  });
  put({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "database",
      namespace,
      uid: claim.clusterUid,
      resourceVersion: "20",
      generation: 1,
      labels,
      annotations,
    },
    spec: { bootstrap: { initdb: { database: "app", owner: "app" } } },
    status: {
      readyInstances: 1,
      currentPrimary: "database-1",
      conditions: [{ type: "Ready", status: "True" }],
      certificates: { serverCASecret: "database-ca" },
    },
  });
  const secretName = `pgcf-role-${claim.ownerRoleId.replaceAll("-", "")}-v1`;
  put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace,
      uid: claim.secretUid,
      resourceVersion: "101",
      labels: { ...labels, "pgcf.io/role-id": claim.ownerRoleId },
      annotations: { ...annotations, "pgcf.io/credential-revision": "1" },
      ownerReferences: [owner],
    },
    immutable: true,
    type: "kubernetes.io/basic-auth",
    data: {
      username: Buffer.from("dbowner").toString("base64"),
      password: Buffer.from(claim.password).toString("base64"),
    },
  });
  put({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "DatabaseRole",
    metadata: {
      name: `pgcf-role-${claim.ownerRoleId.replaceAll("-", "")}`,
      namespace,
      uid: claim.ownerRoleUid,
      resourceVersion: "102",
      generation: 1,
      labels: { ...labels, "pgcf.io/role-id": claim.ownerRoleId },
      annotations: { ...annotations, "pgcf.io/credential-revision": "1" },
      ownerReferences: [owner],
    },
    spec: {
      cluster: { name: "database" },
      name: "dbowner",
      ensure: "present",
      login: true,
      superuser: false,
      createdb: false,
      createrole: false,
      replication: false,
      bypassrls: false,
      inherit: false,
      inRoles: [],
      connectionLimit: 20,
      passwordSecret: { name: secretName },
    },
    status: {
      applied: true,
      observedGeneration: 1,
      secretResourceVersion: "101",
    },
  });
  put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "database-ca",
      namespace,
      uid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      resourceVersion: "30",
      ownerReferences: [owner],
    },
    data: { "ca.crt": Buffer.from("PUBLIC TEST CA").toString("base64") },
  });
  put({
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: "role-verifier-access",
      namespace,
      uid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      resourceVersion: "40",
      labels,
      annotations,
      ownerReferences: [owner],
    },
    spec: {
      endpointSelector: {
        matchLabels: {
          "cnpg.io/cluster": "database",
          "cnpg.io/podRole": "instance",
        },
      },
      ingress: [
        {
          fromEndpoints: [
            {
              matchLabels: {
                "k8s:io.kubernetes.pod.namespace": config.verifierNamespace,
                "k8s:app.kubernetes.io/name": "pgcf-regional-controller",
              },
            },
          ],
          toPorts: [{ ports: [{ port: "5432", protocol: "TCP" }] }],
        },
      ],
    },
  });
  const writes = [],
    probes = [];
  const runtime = {
    async read(kind, ns, name) {
      return structuredClone(resources.get(key(kind, ns, name)) ?? null);
    },
    async listDatabases() {
      return structuredClone(
        [...resources.values()].filter((v) => v.kind === "Database"),
      );
    },
    async create(input) {
      const v = structuredClone(input);
      assert.equal(v.kind, "Database");
      assert(
        !resources.has(key(v.kind, v.metadata.namespace, v.metadata.name)),
      );
      v.metadata.uid = "77777777-7777-4777-8777-777777777777";
      v.metadata.generation = 1;
      v.metadata.resourceVersion = "50";
      v.status = { applied: true, observedGeneration: 0 };
      put(v);
      writes.push(v);
      throw new Error("lost_after_database_commit");
    },
  };
  const verifier = {
    async absent(input) {
      probes.push({ kind: "absence", ...input });
      return !existingSql;
    },
    async verify(input) {
      probes.push({ kind: "owner", ...input });
      return {
        databaseOid: "16400",
        authenticatedUser: input.username,
        authenticatedDatabase: input.database,
        writablePrimary: true,
        databaseOwned: true,
        schemaCreateVerified: true,
        probeRolledBack: true,
      };
    },
  };
  return { resources, key, runtime, verifier, writes, probes };
}

test("an uncertain owned database create waits for applied generation and fresh SQL ownership without duplicate resources", async () => {
  const f = fixture();
  const pending = await reconcileDatabase(
    f.runtime,
    claim,
    config,
    f.verifier,
    () => {},
  );
  assert.equal(f.writes.length, 1);
  assert.equal(pending.applied, false);
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].kind, "absence");
  assert.equal(f.probes[0].database, "app");
  assert.equal(f.probes[0].targetDatabase, "customerdb");
  const db = [...f.resources.values()].find((v) => v.kind === "Database");
  assert.deepEqual(db.spec, {
    cluster: { name: "database" },
    name: "customerdb",
    owner: "dbowner",
    ensure: "present",
    template: "template0",
    isTemplate: false,
    allowConnections: true,
    databaseReclaimPolicy: "retain",
  });
  db.status = { applied: true, observedGeneration: db.metadata.generation };
  const ready = await reconcileDatabase(
    f.runtime,
    claim,
    config,
    f.verifier,
    () => {},
  );
  assert.equal(ready.applied, true);
  assert.equal(ready.observation.databaseOid, "16400");
  assert.equal(ready.observation.databaseUid, db.metadata.uid);
  assert.equal(ready.observation.ownerRoleUid, claim.ownerRoleUid);
  assert.equal(ready.observation.probeRolledBack, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.probes.filter((p) => p.kind === "absence").length, 1);
  assert.equal(f.probes[1].host, `database-rw.${namespace}.svc`);
  assert.equal(f.probes[1].database, "customerdb");
});

test("a pre-existing unmanaged SQL database is rejected before CNPG can adopt or alter its owner", async () => {
  const f = fixture(true);
  const original = structuredClone([...f.resources.entries()]);
  await assert.rejects(
    reconcileDatabase(f.runtime, claim, config, f.verifier, () => {}),
    /database_name_conflict/,
  );
  assert.deepEqual(f.writes, []);
  assert.deepEqual([...f.resources.entries()], original);
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].kind, "absence");
});
