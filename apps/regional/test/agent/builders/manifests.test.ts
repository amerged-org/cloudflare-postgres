// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ARCHIVE_SERVER_NAME,
  OWNER_ROLE_NAME,
  SIDECAR,
  archiveDestinationPath,
  newRolePassword,
  MAINTENANCE_ROLE,
  MAINTENANCE_BOOTSTRAP_SQL,
} from "@pgcf/contracts";
import type { DesiredDatabase, K8sObject } from "@pgcf/contracts";
import {
  buildCaConfigMap,
  buildDatabaseManifests,
  databaseNamespace,
  roleSecretName,
} from "../../../src/agent/builders/index.ts";
import type { BuildContext } from "../../../src/agent/builders/index.ts";

const id = "d" + "b".repeat(19);
const managedRole = "reader_query";
const operation = "op_" + "z".repeat(20);
const region = ["test", "region"].join("-");
const bucket = ["pgcf", "archive", "test"].join("-");
const endpointHost = ["backup", "example", "test"].join(".");
const caCrt = ["CERTIFICATE", randomBytes(32).toString("base64")].join("\n");

function fixture(): { db: DesiredDatabase; ctx: BuildContext } {
  return {
    db: {
      id,
      generation: 1,
      desired_state: "running",
      node: ["pgcf", "node", "test"].join("-"),
      pg_major: 18,
      size: {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 5,
        max_connections: 30,
        archive_timeout_seconds: 60,
        backup_retention_days: 7,
      },
      roles: [
        {
          name: OWNER_ROLE_NAME,
          owner: true,
          password: newRolePassword(),
          revision: 1,
        },
        {
          name: managedRole,
          owner: false,
          password: newRolePassword(),
          revision: 1,
        },
      ],
      archive: {
        destination_path: archiveDestinationPath(
          bucket,
          region,
          id,
          1,
          operation,
        ),
        server_name: ARCHIVE_SERVER_NAME,
      },
    },
    ctx: {
      backup: {
        bucket,
        endpointUrl: `https://${endpointHost}`,
        region: "auto",
        credentials: {
          accessKeyId: randomBytes(16).toString("hex"),
          secretAccessKey: randomBytes(32).toString("hex"),
        },
      },
      postgresImage:
        "ghcr.io/amerged-org/pgcf-postgres@sha256:2c0b286e616191e5103f972181fee2fa7481102bf1a8c0d19154d37f961f3d2d",
      systemNamespace: "pgcf-system",
      cnpgNamespace: "cnpg-system",
      gatewaySelector: {
        namespace: "pgcf-system",
        podLabels: { "app.kubernetes.io/name": "pgcf-gateway" },
      },
      agentSelector: {
        namespace: "pgcf-system",
        podLabels: { "app.kubernetes.io/name": "pgcf-agent" },
      },
      storageClass: "pgcf-lvm",
    },
  };
}

function object(
  manifests: K8sObject[],
  kind: string,
  name?: string,
): K8sObject {
  const resource = manifests.find(
    (item) =>
      item.kind === kind && (name === undefined || item.metadata.name === name),
  );
  assert.ok(resource, `${kind} resource must exist`);
  return resource;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function normalize(
  resources: K8sObject[],
  db: DesiredDatabase,
  ctx: BuildContext,
): unknown[] {
  const substitutions = new Map<string, string>([
    [db.node, "$NODE"],
    [caCrt, "$CA_CERT"],
    [Buffer.from(db.roles[0]!.password).toString("base64"), "$OWNER_PASSWORD"],
    [
      Buffer.from(db.roles[1]!.password).toString("base64"),
      "$MANAGED_PASSWORD",
    ],
    [
      Buffer.from(ctx.backup.credentials.accessKeyId).toString("base64"),
      "$ACCESS_KEY_ID",
    ],
    [
      Buffer.from(ctx.backup.credentials.secretAccessKey).toString("base64"),
      "$SECRET_ACCESS_KEY",
    ],
  ]);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return (
        substitutions.get(value) ??
        value
          .replaceAll(db.id, "$DATABASE_ID")
          .replaceAll(operation, "$OPERATION_ID")
          .replaceAll(ctx.backup.bucket, "$BUCKET")
          .replaceAll(endpointHost, "$ENDPOINT_HOST")
      );
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item)]),
      );
    }
    return value;
  };
  return resources.map(walk);
}

test("maintenance has a separate Secret, minimal managed role and ordered application bootstrap", () => {
  const { db, ctx } = fixture();
  db.maintenance = {
    role: MAINTENANCE_ROLE,
    password: newRolePassword(),
    revision: 1,
  };
  const manifests = buildDatabaseManifests(db, ctx);
  const secret = object(manifests, "Secret", "maintenance-credentials");
  assert.equal(secret.type, "kubernetes.io/basic-auth");
  assert.equal(
    Buffer.from(String(record(secret.data).username), "base64").toString(),
    MAINTENANCE_ROLE,
  );
  assert.equal(
    Buffer.from(String(record(secret.data).password), "base64").toString(),
    db.maintenance.password,
  );
  assert.equal(secret.metadata.labels?.["cnpg.io/reload"], "true");
  const spec = record(object(manifests, "Cluster").spec);
  const managed = array(record(spec.managed).roles).map(record);
  const role = managed.find((role) => role.name === MAINTENANCE_ROLE)!;
  assert.deepEqual(role, {
    name: MAINTENANCE_ROLE,
    ensure: "present",
    login: true,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    inherit: true,
    inRoles: ["pg_read_all_stats"],
    passwordSecret: { name: "maintenance-credentials" },
  });
  const bootstrap = record(record(spec.bootstrap).initdb);
  assert.deepEqual(bootstrap.postInitApplicationSQL, [
    ...MAINTENANCE_BOOTSTRAP_SQL,
  ]);
  assert.equal(bootstrap.postInitSQL, undefined);
  assert.equal(JSON.stringify(spec).includes(db.maintenance.password), false);
  assert.equal(JSON.stringify(bootstrap).includes("TO app"), false);
  assert.equal(
    managed.filter((role) => role.name === MAINTENANCE_ROLE).length,
    1,
  );
  assert.equal(spec.enableSuperuserAccess, false);
});

test("legacy pages add neither an internal Secret nor maintenance bootstrap grants", () => {
  const { db, ctx } = fixture();
  const manifests = buildDatabaseManifests(db, ctx);
  assert.equal(
    manifests.some(
      (resource) => resource.metadata.name === "maintenance-credentials",
    ),
    false,
  );
  const spec = record(object(manifests, "Cluster").spec);
  assert.equal(
    record(record(spec.bootstrap).initdb).postInitApplicationSQL,
    undefined,
  );
  assert.equal(
    array(record(spec.managed).roles).some(
      (role) => record(role).name === MAINTENANCE_ROLE,
    ),
    false,
  );
});

test("golden normalization preserves image, roles, Secret names and archive layout", () => {
  const { db, ctx } = fixture();
  const normalized = normalize(
    buildDatabaseManifests(db, ctx),
    db,
    ctx,
  ) as K8sObject[];
  const cluster = record(object(normalized, "Cluster").spec);
  assert.equal(cluster.imageName, ctx.postgresImage);
  const managed = record(array(record(cluster.managed).roles)[0]);
  assert.equal(managed.name, managedRole);
  assert.deepEqual(managed.passwordSecret, {
    name: roleSecretName(managedRole),
  });
  assert.equal(
    object(normalized, "Secret", roleSecretName(managedRole)).metadata.name,
    roleSecretName(managedRole),
  );
  const archive = record(
    record(object(normalized, "ObjectStore").spec).configuration,
  );
  assert.equal(
    archive.destinationPath,
    `s3://$BUCKET/${region}/$DATABASE_ID/g1-$OPERATION_ID`,
  );
  assert.equal(archive.endpointURL, "https://$ENDPOINT_HOST");
  const later = structuredClone(db);
  later.generation = 2;
  later.storage_generation = 2;
  later.archive.destination_path = archiveDestinationPath(
    bucket,
    region,
    id,
    2,
    operation,
  );
  const laterNormalized = normalize(
    buildDatabaseManifests(later, ctx),
    later,
    ctx,
  ) as K8sObject[];
  const laterArchive = record(
    record(object(laterNormalized, "ObjectStore").spec).configuration,
  );
  assert.equal(
    laterArchive.destinationPath,
    `s3://$BUCKET/${region}/$DATABASE_ID/g2-$OPERATION_ID`,
  );
  assert.notEqual(laterArchive.destinationPath, archive.destinationPath);
});

test("small database manifests match a golden file for every object kind", () => {
  const { db, ctx } = fixture();
  const actual = normalize(
    [...buildDatabaseManifests(db, ctx), buildCaConfigMap(id, caCrt)],
    db,
    ctx,
  );
  const kinds = [
    "Namespace",
    "ResourceQuota",
    "LimitRange",
    "NetworkPolicy",
    "CiliumNetworkPolicy",
    "Secret",
    "ObjectStore",
    "Cluster",
    "ScheduledBackup",
    "ConfigMap",
  ];
  assert.deepEqual(
    [...new Set(actual.map((item) => record(item).kind))].sort(),
    kinds.toSorted(),
  );
  for (const kind of kinds) {
    const expected = JSON.parse(
      readFileSync(new URL(`./golden/${kind}.json`, import.meta.url), "utf8"),
    ) as unknown;
    assert.deepEqual(
      actual.filter((item) => record(item).kind === kind),
      expected,
      kind,
    );
  }
});

test("resource names are bounded DNS labels and unsafe roles use collision-separated hashes", () => {
  const { db, ctx } = fixture();
  for (const name of [
    "a".repeat(63),
    ["a", "b"].join("_"),
    "a" + "_".repeat(62),
  ]) {
    const secret = roleSecretName(name);
    assert.match(secret, /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/);
    assert.ok(secret.length <= 63);
    assert.equal(secret.includes(name), false);
  }
  assert.notEqual(roleSecretName("a_b"), roleSecretName("a__b"));
  const unsafe = "a_b";
  const hashRole =
    "a" + createHash("sha256").update(unsafe).digest("hex").slice(0, 57);
  assert.notEqual(roleSecretName(unsafe), roleSecretName(hashRole));
  for (const manifest of buildDatabaseManifests(db, ctx)) {
    assert.match(
      manifest.metadata.name,
      /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
    );
    assert.ok(manifest.metadata.name.length <= 63);
    assert.equal(manifest.metadata.labels?.["pgcf.io/database-id"], id);
    assert.equal("ownerReferences" in manifest.metadata, false);
  }
  assert.equal(roleSecretName("app"), "role-app");
});

test("invalid names and reserved PostgreSQL roles are rejected before manifests are built", () => {
  for (const name of [
    "postgres",
    "streaming_replica",
    "pg_admin",
    "cnpg_admin",
    "a".repeat(64),
    "UPPER",
    "role-name",
    "../../role",
    "",
    "a\u0000b",
  ]) {
    assert.throws(() => roleSecretName(name), TypeError);
    const { db, ctx } = fixture();
    db.roles[1]!.name = name;
    assert.throws(() => buildDatabaseManifests(db, ctx), TypeError);
  }
  assert.throws(() => databaseNamespace("../../namespace"), TypeError);
});

test("explicit startup memory permits overbooking while preserving the PostgreSQL cap", () => {
  const { db, ctx } = fixture();
  db.size.memory_mib = 4096;
  db.size.memory_request_mib = 128;
  const manifests = buildDatabaseManifests(db, ctx);
  const resources = record(record(object(manifests, "Cluster").spec).resources);
  assert.deepEqual(resources.requests, { cpu: "500m", memory: "128Mi" });
  assert.deepEqual(resources.limits, { cpu: "500m", memory: "4096Mi" });
  const hard = record(record(object(manifests, "ResourceQuota").spec).hard);
  assert.equal(
    hard["limits.memory"],
    `${2 * (4096 + SIDECAR.limitMemoryMib)}Mi`,
  );
});

test("quota covers two PostgreSQL and Barman pod slots for the supported size examples", () => {
  const { db, ctx } = fixture();
  for (const size of [
    { memory_mib: 256, cpu_millicores: 100, storage_gib: 1 },
    { memory_mib: 512, cpu_millicores: 500, storage_gib: 5 },
    { memory_mib: 2048, cpu_millicores: 2000, storage_gib: 20 },
  ]) {
    db.size = { ...db.size, ...size };
    const hard = record(
      record(object(buildDatabaseManifests(db, ctx), "ResourceQuota").spec)
        .hard,
    );
    assert.equal(
      hard["requests.cpu"],
      `${2 * (size.cpu_millicores + SIDECAR.requestCpuMillicores)}m`,
    );
    assert.equal(
      hard["limits.cpu"],
      `${2 * (size.cpu_millicores + SIDECAR.limitCpuMillicores)}m`,
    );
    assert.equal(
      hard["requests.memory"],
      `${2 * (size.memory_mib + SIDECAR.requestMemoryMib)}Mi`,
    );
    assert.equal(
      hard["limits.memory"],
      `${2 * (size.memory_mib + SIDECAR.limitMemoryMib)}Mi`,
    );
    assert.equal(hard["requests.storage"], `${size.storage_gib}Gi`);
    assert.equal(hard.persistentvolumeclaims, "1");
    assert.equal(hard.pods, "2");
  }
});

test("gateway and agent ingress each require their namespace and pod labels in one peer", () => {
  const { db, ctx } = fixture();
  const manifests = buildDatabaseManifests(db, ctx);
  for (const [policyName, selector, ports] of [
    ["gateway-ingress", ctx.gatewaySelector, [5432]],
    ["agent-management-ingress", ctx.agentSelector, [5432, 9187]],
  ] as const) {
    const ingress = array(
      record(object(manifests, "NetworkPolicy", policyName).spec).ingress,
    );
    const rule = record(ingress[0]);
    const peers = array(rule.from);
    assert.equal(peers.length, 1);
    assert.deepEqual(record(peers[0]).namespaceSelector, {
      matchLabels: { "kubernetes.io/metadata.name": selector.namespace },
    });
    assert.deepEqual(record(peers[0]).podSelector, {
      matchLabels: selector.podLabels,
    });
    assert.deepEqual(
      rule.ports,
      ports.map((port) => ({ port, protocol: "TCP" })),
    );
  }
  const policy = record(object(manifests, "CiliumNetworkPolicy").spec);
  const ingress = array(policy.ingress);
  assert.equal(ingress.length, 3);
  const gateway = record(array(record(ingress[0]).fromEndpoints)[0]);
  assert.deepEqual(gateway.matchLabels, {
    "k8s:io.kubernetes.pod.namespace": ctx.gatewaySelector.namespace,
    "k8s:app.kubernetes.io/name": "pgcf-gateway",
  });
  const metrics = record(array(record(ingress[1]).fromEndpoints)[0]);
  assert.deepEqual(metrics.matchLabels, {
    "k8s:io.kubernetes.pod.namespace": ctx.agentSelector.namespace,
    "k8s:app.kubernetes.io/name": "pgcf-agent",
  });
  const egress = array(policy.egress);
  assert.equal(egress.length, 3);
  assert.deepEqual(record(egress[2]).toFQDNs, [{ matchName: endpointHost }]);
  assert.deepEqual(record(egress[2]).toPorts, [
    { ports: [{ port: "443", protocol: "TCP" }] },
  ]);
});

test("Barman uses explicit enabled plugin, fixed archive destination and runtime credentials", () => {
  const { db, ctx } = fixture();
  const manifests = buildDatabaseManifests(db, ctx);
  const store = object(manifests, "ObjectStore");
  const config = record(record(store.spec).configuration);
  assert.equal("serverName" in config, false);
  assert.equal("serverName" in record(store.spec), false);
  assert.equal(config.destinationPath, db.archive.destination_path);
  assert.deepEqual(config.s3Credentials, {
    accessKeyId: { name: "archive-credentials", key: "AWS_ACCESS_KEY_ID" },
    secretAccessKey: {
      name: "archive-credentials",
      key: "AWS_SECRET_ACCESS_KEY",
    },
  });
  const credentials = record(
    object(manifests, "Secret", "archive-credentials").data,
  );
  assert.equal(
    Buffer.from(String(credentials.AWS_ACCESS_KEY_ID), "base64").toString(),
    ctx.backup.credentials.accessKeyId,
  );
  assert.equal(
    Buffer.from(String(credentials.AWS_SECRET_ACCESS_KEY), "base64").toString(),
    ctx.backup.credentials.secretAccessKey,
  );
  const plugin = record(
    array(record(object(manifests, "Cluster").spec).plugins)[0],
  );
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.isWALArchiver, true);
  assert.deepEqual(plugin.parameters, {
    barmanObjectName: "archive",
    serverName: "database",
  });
  db.generation = 2;
  db.roles[1]!.revision = 2;
  db.roles[1]!.password = newRolePassword();
  assert.deepEqual(
    object(buildDatabaseManifests(db, ctx), "ObjectStore"),
    store,
  );
});

test("managed roles exclude owner and bootstrap uses the database ID and app secret", () => {
  const { db, ctx } = fixture();
  const manifests = buildDatabaseManifests(db, ctx);
  const cluster = record(object(manifests, "Cluster").spec);
  assert.deepEqual(record(cluster.bootstrap).initdb, {
    database: id,
    owner: "app",
    secret: { name: "role-app" },
  });
  const roles = array(record(cluster.managed).roles);
  assert.equal(roles.length, 1);
  assert.equal(record(roles[0]).name, managedRole);
  assert.equal(record(roles[0]).superuser, false);
  assert.deepEqual(record(roles[0]).passwordSecret, {
    name: roleSecretName(managedRole),
  });
  assert.deepEqual(
    record(cluster.resources).requests,
    record(cluster.resources).limits,
  );
  assert.equal(cluster.imageName, ctx.postgresImage);
  for (const manifest of manifests.filter((item) => item.kind !== "Secret")) {
    const serialized = JSON.stringify(manifest);
    for (const password of db.roles.map((role) => role.password))
      assert.equal(serialized.includes(password), false);
    assert.equal(
      serialized.includes(ctx.backup.credentials.secretAccessKey),
      false,
    );
  }
});

test("identical inputs produce identical manifests without mutating inputs", () => {
  const { db, ctx } = fixture();
  const before = JSON.stringify({ db, ctx });
  const first = buildDatabaseManifests(db, ctx);
  assert.deepEqual(first, buildDatabaseManifests(db, ctx));
  assert.equal(JSON.stringify({ db, ctx }), before);
  record(first[0]!.metadata.labels)["pgcf.io/database-id"] = "changed";
  assert.equal(
    buildDatabaseManifests(db, ctx)[0]!.metadata.labels?.[
      "pgcf.io/database-id"
    ],
    id,
  );
});

test("invalid backup endpoints, missing credentials and mutable image tags fail closed", () => {
  const { db, ctx } = fixture();
  const endpoint = ctx.backup.endpointUrl;
  for (const invalid of [
    `http://${endpointHost}`,
    `${endpoint}/path`,
    `${endpoint}?query=x`,
    `${endpoint}#fragment`,
    `https://user:pass@${endpointHost}`,
    `${endpoint}:8443`,
  ]) {
    ctx.backup.endpointUrl = invalid;
    assert.throws(() => buildDatabaseManifests(db, ctx), TypeError);
  }
  ctx.backup.endpointUrl = endpoint;
  ctx.backup.credentials.secretAccessKey = "";
  assert.throws(() => buildDatabaseManifests(db, ctx), TypeError);
  ctx.backup.credentials.secretAccessKey = randomBytes(32).toString("hex");
  ctx.postgresImage = "postgres:18";
  assert.throws(() => buildDatabaseManifests(db, ctx), TypeError);
});

test("deleted desired state and mismatched archive buckets cannot create resources", () => {
  const { db, ctx } = fixture();
  ctx.backup.bucket = ["pgcf", "other", "bucket"].join("-");
  assert.throws(() => buildDatabaseManifests(db, ctx), TypeError);
  ctx.backup.bucket = bucket;
  db.desired_state = "deleted";
  assert.throws(() => buildDatabaseManifests(db, ctx), TypeError);
});

test("CA ConfigMap publishes only the CA certificate in the gateway namespace", () => {
  const ca = buildCaConfigMap(id, caCrt);
  assert.equal(ca.metadata.namespace, "pgcf-system");
  assert.equal(ca.metadata.name, `ca-${id}`);
  assert.deepEqual(ca.data, { "ca.crt": caCrt });
  assert.throws(() => buildCaConfigMap(id, ""), TypeError);
  assert.throws(() => buildCaConfigMap("invalid", caCrt), TypeError);
});

test("agent ingress permits authenticated readiness and archive metrics only", () => {
  const { db, ctx } = fixture();
  const manifests = buildDatabaseManifests(db, ctx);
  const ingress = array(
    record(object(manifests, "NetworkPolicy", "agent-management-ingress").spec)
      .ingress,
  );
  assert.deepEqual(record(ingress[0]).ports, [
    { port: 5432, protocol: "TCP" },
    { port: 9187, protocol: "TCP" },
  ]);
  const cilium = array(
    record(object(manifests, "CiliumNetworkPolicy").spec).ingress,
  );
  assert.deepEqual(record(cilium[1]).toPorts, [
    {
      ports: [
        { port: "5432", protocol: "TCP" },
        { port: "9187", protocol: "TCP" },
      ],
    },
  ]);
});

test("one-second startup and readiness cadence preserves the startup budget and inherited probe checks", () => {
  const { db, ctx } = fixture();
  const cluster = record(
    object(buildDatabaseManifests(db, ctx), "Cluster").spec,
  );
  assert.deepEqual(cluster.probes, {
    startup: { periodSeconds: 1, failureThreshold: 3600 },
    readiness: { periodSeconds: 1 },
  });
  const probes = record(cluster.probes),
    startup = record(probes.startup);
  assert.equal(
    Number(startup.periodSeconds) * Number(startup.failureThreshold),
    3600,
  );
  assert.equal(probes.liveness, undefined);
  assert.equal(record(probes.readiness).failureThreshold, undefined);
  assert.equal(record(probes.readiness).type, undefined);
  assert.equal(startup.type, undefined);
  assert.equal(startup.timeoutSeconds, undefined);
  assert.equal(record(probes.readiness).timeoutSeconds, undefined);
  assert.equal(startup.successThreshold, undefined);
  assert.equal(record(probes.readiness).successThreshold, undefined);
});
