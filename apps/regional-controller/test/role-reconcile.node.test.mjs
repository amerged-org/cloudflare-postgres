// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRole } from "../src/role-reconcile.ts";

const claim = {
  schemaVersion: 1,
  kind: "database.role.apply",
  operationId: "11111111-1111-4111-8111-111111111111",
  organizationId: "88888888-8888-4888-8888-888888888888",
  projectId: "99999999-9999-4999-8999-999999999999",
  environmentId: "22222222-2222-4222-8222-222222222222",
  regionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  specRevision: 1,
  specHash: "a".repeat(64),
  clusterUid: "44444444-4444-4444-8444-444444444444",
  roleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  roleName: "reporter",
  connectionLimit: 20,
  credentialRevision: 1,
  password: "p".repeat(43),
  previousPassword: null,
  secretName: "pgcf-role-bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb-v1",
  leaseToken: "cplease_" + "l".repeat(43),
  leaseEpoch: 1,
  leaseExpiresAt: new Date(Date.now() + 90000).toISOString(),
};
const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`;
const config = {
  verifierNamespace: "pgcf-system",
  verifierPodLabels: { "app.kubernetes.io/name": "regional-controller" },
};
function fixture() {
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
  const resources = new Map();
  const key = (kind, ns, name) => `${kind}/${ns}/${name}`;
  const save = (v) =>
    resources.set(key(v.kind, v.metadata.namespace ?? "", v.metadata.name), v);
  save({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: "33333333-3333-4333-8333-333333333333",
      resourceVersion: "10",
      labels,
      annotations,
    },
  });
  save({
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
    spec: {
      bootstrap: { initdb: { database: "app", owner: "app" } },
      managed: { roles: [] },
    },
    status: {
      currentPrimary: "database-1",
      readyInstances: 1,
      conditions: [{ type: "Ready", status: "True" }],
      certificates: { serverCASecret: "database-ca" },
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "database-ca",
      namespace,
      uid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      resourceVersion: "30",
      ownerReferences: [owner],
    },
    data: { "ca.crt": Buffer.from("PUBLIC TEST CA").toString("base64") },
  });
  const writes = [];
  let loseSecret = true,
    loseRole = true;
  const runtime = {
    async read(kind, ns, name) {
      return structuredClone(resources.get(key(kind, ns, name)) ?? null);
    },
    async create(input) {
      const v = structuredClone(input);
      assert(
        !resources.has(key(v.kind, v.metadata.namespace, v.metadata.name)),
      );
      v.metadata.uid =
        v.kind === "Secret"
          ? v.metadata.name.endsWith("-v2")
            ? "77777777-7777-4777-8777-777777777777"
            : "66666666-6666-4666-8666-666666666666"
          : v.kind === "DatabaseRole"
            ? "55555555-5555-4555-8555-555555555555"
            : "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      v.metadata.resourceVersion =
        v.kind === "Secret"
          ? v.metadata.name.endsWith("-v2")
            ? "202"
            : "101"
          : "102";
      v.metadata.generation = 1;
      if (v.kind === "DatabaseRole")
        v.status = {
          applied: true,
          observedGeneration: 0,
          secretResourceVersion: "old",
        };
      save(v);
      writes.push(v.kind);
      if (v.kind === "Secret" && loseSecret) {
        loseSecret = false;
        throw new Error("lost_after_secret_commit");
      }
      if (v.kind === "DatabaseRole" && loseRole) {
        loseRole = false;
        throw new Error("lost_after_role_commit");
      }
      return structuredClone(v);
    },
    async patchRole(ns, name, ops) {
      const role = resources.get(key("DatabaseRole", ns, name));
      assert(
        ops.some(
          (x) =>
            x.op === "test" &&
            x.path === "/metadata/uid" &&
            x.value === role.metadata.uid,
        ),
      );
      assert(
        ops.some(
          (x) =>
            x.op === "test" &&
            x.path === "/metadata/resourceVersion" &&
            x.value === role.metadata.resourceVersion,
        ),
      );
      writes.push("patch");
      for (const op of ops.filter((x) => x.op !== "test")) {
        if (op.path === "/spec/passwordSecret/name")
          role.spec.passwordSecret.name = op.value;
        else if (
          op.path === "/metadata/annotations/pgcf.io~1credential-revision"
        )
          role.metadata.annotations["pgcf.io/credential-revision"] = op.value;
        else throw new Error("unexpected_role_patch_scope");
      }
      role.metadata.resourceVersion = "203";
      role.metadata.generation += 1;
      throw new Error("lost_after_role_patch_commit");
    },
  };
  const verified = [];
  const verifier = {
    async verify(input) {
      verified.push(input);
      return {
        authenticatedUser: input.username,
        authenticatedDatabase: "app",
        writablePrimary: true,
        previousCredentialRejected: input.previousPassword ? true : null,
      };
    },
  };
  return {
    resources,
    key,
    runtime,
    verifier,
    verified,
    writes,
    labels,
    annotations,
    owner,
  };
}

test("uncertain owned role application waits for the exact credential version before a fresh verified connection", async () => {
  const f = fixture();
  const pending = await reconcileRole(
    f.runtime,
    claim,
    config,
    f.verifier,
    () => {},
  );
  assert.equal(f.writes.filter((x) => x === "Secret").length, 1);
  assert.equal(f.writes.filter((x) => x === "DatabaseRole").length, 1);
  assert.equal(pending.applied, false);
  assert.equal(f.verified.length, 0);
  const secret = f.resources.get(f.key("Secret", namespace, claim.secretName));
  assert.equal(secret.immutable, true);
  assert.equal(secret.type, "kubernetes.io/basic-auth");
  assert.equal(
    Buffer.from(secret.data.password, "base64").toString(),
    claim.password,
  );
  const role = [...f.resources.values()].find((x) => x.kind === "DatabaseRole");
  for (const flag of [
    "superuser",
    "createdb",
    "createrole",
    "replication",
    "bypassrls",
  ])
    assert.equal(role.spec[flag], false);
  // CNPG's typed serialization omits these false booleans and empty membership.
  for (const field of [
    "superuser",
    "createdb",
    "createrole",
    "replication",
    "bypassrls",
    "inRoles",
  ])
    delete role.spec[field];
  role.status = {
    applied: true,
    observedGeneration: role.metadata.generation,
    secretResourceVersion: secret.metadata.resourceVersion,
  };
  const ready = await reconcileRole(
    f.runtime,
    claim,
    config,
    f.verifier,
    () => {},
  );
  assert.equal(ready.applied, true);
  assert.equal(f.verified.length, 1);
  assert.equal(f.verified[0].host, `database-rw.${namespace}.svc`);
  assert.equal(f.verified[0].ca, "PUBLIC TEST CA");
  assert.equal(
    ready.observation.roleSecretResourceVersion,
    secret.metadata.resourceVersion,
  );
  assert.equal(ready.observation.secretUid, secret.metadata.uid);
  assert.equal(ready.observation.clusterUid, claim.clusterUid);
  const writesBeforePrivilegeChecks = f.writes.length;
  role.spec.superuser = true;
  await assert.rejects(
    reconcileRole(f.runtime, claim, config, f.verifier, () => {}),
    /role_spec_conflict/,
  );
  delete role.spec.superuser;
  role.spec.inRoles = ["pg_read_server_files"];
  await assert.rejects(
    reconcileRole(f.runtime, claim, config, f.verifier, () => {}),
    /role_spec_conflict/,
  );
  delete role.spec.inRoles;
  delete role.spec.inherit;
  await assert.rejects(
    reconcileRole(f.runtime, claim, config, f.verifier, () => {}),
    /role_spec_conflict/,
  );
  role.spec.inherit = false;
  assert.equal(f.writes.length, writesBeforePrivilegeChecks);
  assert.equal(
    f.writes.filter((x) => x === "Secret" || x === "DatabaseRole").length,
    2,
  );
  const rotation = {
    ...claim,
    credentialRevision: 2,
    previousPassword: claim.password,
    password: "n".repeat(43),
    secretName: claim.secretName.replace(/v1$/, "v2"),
  };
  const rotating = await reconcileRole(
    f.runtime,
    rotation,
    config,
    f.verifier,
    () => {},
  );
  assert.equal(rotating.applied, false);
  assert.equal(f.verified.length, 1);
  assert.equal(f.writes.filter((kind) => kind === "patch").length, 1);
  const nextSecret = f.resources.get(
    f.key("Secret", namespace, rotation.secretName),
  );
  assert.notEqual(nextSecret.metadata.uid, secret.metadata.uid);
  role.status = {
    applied: true,
    observedGeneration: role.metadata.generation,
    secretResourceVersion: nextSecret.metadata.resourceVersion,
  };
  const rotated = await reconcileRole(
    f.runtime,
    rotation,
    config,
    f.verifier,
    () => {},
  );
  assert.equal(rotated.applied, true);
  assert.equal(rotated.observation.roleUid, ready.observation.roleUid);
  assert.equal(rotated.observation.previousCredentialRejected, true);
  assert.equal(f.verified[1].password, rotation.password);
  assert.equal(f.verified[1].previousPassword, claim.password);
  assert.equal(f.writes.filter((kind) => kind === "patch").length, 1);
  assert.equal(
    Buffer.from(secret.data.password, "base64").toString(),
    claim.password,
  );
});

test("a reclaimed stale rotation cannot downgrade a newer role even after its operation authority returns", async () => {
  const f = fixture();
  const roleName = `pgcf-role-${claim.roleId.replaceAll("-", "")}`;
  const newer = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "DatabaseRole",
    metadata: {
      name: roleName,
      namespace,
      uid: "55555555-5555-4555-8555-555555555555",
      resourceVersion: "303",
      generation: 3,
      labels: { ...f.labels, "pgcf.io/role-id": claim.roleId },
      annotations: { ...f.annotations, "pgcf.io/credential-revision": "3" },
      ownerReferences: [f.owner],
    },
    spec: {
      cluster: { name: "database" },
      name: claim.roleName,
      login: true,
      superuser: false,
      createdb: false,
      createrole: false,
      replication: false,
      bypassrls: false,
      connectionLimit: 20,
      passwordSecret: { name: "newer-credential-v3" },
    },
  };
  f.resources.set(
    f.key("DatabaseRole", namespace, roleName),
    structuredClone(newer),
  );
  const stale = {
    ...claim,
    credentialRevision: 2,
    previousPassword: claim.password,
    password: "n".repeat(43),
    secretName: claim.secretName.replace(/v1$/, "v2"),
  };
  await assert.rejects(
    reconcileRole(f.runtime, stale, config, f.verifier, () => {
      throw new Error("lease_not_authorized");
    }),
    /lease_not_authorized/,
  );
  await assert.rejects(
    reconcileRole(f.runtime, stale, config, f.verifier, () => {}),
    /role_revision_superseded/,
  );
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.verified, []);
  assert.deepEqual(
    f.resources.get(f.key("DatabaseRole", namespace, roleName)),
    newer,
  );
});

test("rejects a verifier namespace selector override before reading or mutating credentials or policy", async () => {
  const calls = [];
  const runtime = new Proxy(
    {},
    {
      get(_target, method) {
        return async () => {
          calls.push(String(method));
          throw new Error("unexpected_kubernetes_or_secret_access");
        };
      },
    },
  );
  await assert.rejects(
    reconcileRole(
      runtime,
      claim,
      {
        ...config,
        verifierPodLabels: {
          ...config.verifierPodLabels,
          "io.kubernetes.pod.namespace": "foreign-namespace",
        },
      },
      async () => {
        throw new Error("unexpected_database_access");
      },
      () => {},
    ),
    /role_spec_conflict/,
  );
  assert.deepEqual(calls, []);
});
