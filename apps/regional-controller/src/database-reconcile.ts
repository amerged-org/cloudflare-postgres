// SPDX-License-Identifier: Apache-2.0
import type {
  DatabaseClaim,
  DatabaseConfig,
  DatabaseObservation,
  DatabaseRuntime,
  DatabaseVerifier,
} from "./database-types.ts";
import { validRoleConfig } from "./role-reconcile.ts";
import type { Resource } from "./types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function validDatabaseClaim(claim: DatabaseClaim): boolean {
  return (
    !!claim &&
    claim.schemaVersion === 1 &&
    claim.kind === "database.create" &&
    [
      claim.operationId,
      claim.organizationId,
      claim.projectId,
      claim.environmentId,
      claim.regionId,
      claim.namespaceUid,
      claim.clusterUid,
      claim.databaseId,
      claim.ownerRoleId,
      claim.ownerRoleUid,
      claim.secretUid,
    ].every((id) => uuid.test(id)) &&
    Number.isSafeInteger(claim.specRevision) &&
    claim.specRevision > 0 &&
    /^[a-f0-9]{64}$/.test(claim.specHash) &&
    Number.isSafeInteger(claim.ownerCredentialRevision) &&
    claim.ownerCredentialRevision > 0 &&
    /^[a-z][a-z0-9_]{0,62}$/.test(claim.databaseName) &&
    !["app", "postgres", "template0", "template1"].includes(
      claim.databaseName,
    ) &&
    !/^(pg_|cnpg_)/.test(claim.databaseName) &&
    /^[a-z][a-z0-9_]{0,62}$/.test(claim.ownerRoleName) &&
    !["app", "postgres", "streaming_replica"].includes(claim.ownerRoleName) &&
    !/^(pg_|cnpg_)/.test(claim.ownerRoleName) &&
    typeof claim.secretResourceVersion === "string" &&
    claim.secretResourceVersion.length > 0 &&
    claim.secretResourceVersion.length <= 128 &&
    /^[A-Za-z0-9_-]{43}$/.test(claim.password) &&
    /^cplease_[A-Za-z0-9_-]{43}$/.test(claim.leaseToken) &&
    Number.isSafeInteger(claim.leaseEpoch) &&
    claim.leaseEpoch > 0 &&
    Number.isFinite(Date.parse(claim.leaseExpiresAt))
  );
}
function owned(resource: Resource, claim: DatabaseClaim): boolean {
  return (
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    resource.metadata.labels?.["pgcf.io/environment-id"] ===
      claim.environmentId &&
    resource.metadata.labels?.["pgcf.io/region-id"] === claim.regionId &&
    resource.metadata.annotations?.["pgcf.io/spec-hash"] === claim.specHash &&
    !resource.metadata.deletionTimestamp
  );
}
function clusterOwner(resource: Resource, claim: DatabaseClaim): boolean {
  const references = resource.metadata.ownerReferences?.filter(
    (owner) => owner.kind === "Cluster" && owner.controller === true,
  );
  return (
    references?.length === 1 &&
    references[0]?.apiVersion === "postgresql.cnpg.io/v1" &&
    references[0]?.name === "database" &&
    references[0]?.uid === claim.clusterUid
  );
}
export async function reconcileDatabase(
  runtime: DatabaseRuntime,
  claim: DatabaseClaim,
  config: DatabaseConfig,
  verifier: DatabaseVerifier,
  authorized: () => void,
): Promise<{ applied: boolean; observation?: DatabaseObservation }> {
  authorized();
  if (!validDatabaseClaim(claim) || !validRoleConfig(config))
    throw new Error("database_spec_conflict");
  const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`,
    name = `pgcf-database-${claim.databaseId.replaceAll("-", "")}`;
  const ownerRoleName = `pgcf-role-${claim.ownerRoleId.replaceAll("-", "")}`,
    secretName = `${ownerRoleName}-v${claim.ownerCredentialRevision}`;
  const read = async (
    kind: Parameters<DatabaseRuntime["read"]>[0],
    ns: string,
    resourceName: string,
  ) => {
    authorized();
    const value = await runtime.read(kind, ns, resourceName);
    authorized();
    return value;
  };
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": claim.environmentId,
    "pgcf.io/region-id": claim.regionId,
    "pgcf.io/database-id": claim.databaseId,
    "pgcf.io/owner-role-id": claim.ownerRoleId,
  };
  const desired: Resource = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name,
      namespace,
      labels,
      annotations: { "pgcf.io/spec-hash": claim.specHash },
      ownerReferences: [
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Cluster",
          name: "database",
          uid: claim.clusterUid,
          controller: true,
        },
      ],
    },
    spec: {
      cluster: { name: "database" },
      name: claim.databaseName,
      owner: claim.ownerRoleName,
      ensure: "present",
      template: "template0",
      isTemplate: false,
      allowConnections: true,
      databaseReclaimPolicy: "retain",
    },
  };
  const matchingDatabase = (database: Resource) =>
    database.apiVersion === desired.apiVersion &&
    database.kind === "Database" &&
    database.metadata.name === name &&
    database.metadata.namespace === namespace &&
    owned(database, claim) &&
    database.metadata.labels?.["pgcf.io/database-id"] === claim.databaseId &&
    database.metadata.labels?.["pgcf.io/owner-role-id"] === claim.ownerRoleId &&
    clusterOwner(database, claim) &&
    !!database.metadata.uid &&
    !!database.metadata.resourceVersion &&
    equal(database.spec, desired.spec);
  // An existing deterministic owned resource is authoritative after an uncertain
  // create. Never run the absence/adoption path again for that resource.
  let database = await read("Database", namespace, name);
  if (database && !matchingDatabase(database))
    throw new Error("database_ownership_mismatch");
  const [ns, cluster, ownerRole, secret, policy] = await Promise.all([
    read("Namespace", "", namespace),
    read("Cluster", namespace, "database"),
    read("DatabaseRole", namespace, ownerRoleName),
    read("Secret", namespace, secretName),
    read("CiliumNetworkPolicy", namespace, "role-verifier-access"),
  ]);
  if (
    !ns ||
    !cluster ||
    !ownerRole ||
    !secret ||
    !policy ||
    ns.metadata.uid !== claim.namespaceUid ||
    !owned(ns, claim) ||
    cluster.metadata.uid !== claim.clusterUid ||
    !owned(cluster, claim) ||
    ownerRole.metadata.uid !== claim.ownerRoleUid ||
    !owned(ownerRole, claim) ||
    ownerRole.metadata.labels?.["pgcf.io/role-id"] !== claim.ownerRoleId ||
    !clusterOwner(ownerRole, claim) ||
    secret.metadata.uid !== claim.secretUid ||
    secret.metadata.resourceVersion !== claim.secretResourceVersion ||
    !owned(secret, claim) ||
    !clusterOwner(secret, claim) ||
    secret.metadata.labels?.["pgcf.io/role-id"] !== claim.ownerRoleId ||
    secret.metadata.annotations?.["pgcf.io/credential-revision"] !==
      String(claim.ownerCredentialRevision) ||
    object(secret).immutable !== true ||
    object(secret).type !== "kubernetes.io/basic-auth" ||
    secret.data?.username !==
      Buffer.from(claim.ownerRoleName).toString("base64") ||
    secret.data?.password !== Buffer.from(claim.password).toString("base64") ||
    !owned(policy, claim) ||
    !clusterOwner(policy, claim)
  )
    throw new Error("database_ownership_mismatch");
  if (
    [ns, cluster, ownerRole, secret, policy].some(
      (resource) =>
        typeof resource.metadata.uid !== "string" ||
        typeof resource.metadata.resourceVersion !== "string" ||
        resource.metadata.resourceVersion.length === 0,
    )
  )
    throw new Error("database_identity_deferred");
  const bootstrap = object(
    object(object(cluster.spec).bootstrap).initdb,
  ).database;
  if (
    typeof bootstrap !== "string" ||
    bootstrap !== "app" ||
    claim.databaseName === bootstrap
  )
    throw new Error("database_spec_conflict");
  const roleSpec = object(ownerRole.spec),
    roleStatus = object(ownerRole.status);
  if (
    ownerRole.metadata.annotations?.["pgcf.io/credential-revision"] !==
      String(claim.ownerCredentialRevision) ||
    !equal(roleSpec.cluster, { name: "database" }) ||
    roleSpec.name !== claim.ownerRoleName ||
    roleSpec.ensure !== "present" ||
    roleSpec.login !== true ||
    [
      "superuser",
      "createdb",
      "createrole",
      "replication",
      "bypassrls",
      "inherit",
    ].some((field) => roleSpec[field] !== false) ||
    !equal(roleSpec.inRoles, []) ||
    !Number.isSafeInteger(roleSpec.connectionLimit) ||
    Number(roleSpec.connectionLimit) < 1 ||
    Number(roleSpec.connectionLimit) > 1000 ||
    !equal(roleSpec.passwordSecret, { name: secretName })
  )
    throw new Error("database_spec_conflict");
  const selector = Object.fromEntries(
    Object.entries(config.verifierPodLabels).map(([key, value]) => [
      `k8s:${key}`,
      value,
    ]),
  );
  const expectedPolicy = {
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
              ...selector,
            },
          },
        ],
        toPorts: [{ ports: [{ port: "5432", protocol: "TCP" }] }],
      },
    ],
  };
  if (!equal(policy.spec, expectedPolicy))
    throw new Error("database_spec_conflict");
  if (
    cluster.metadata.annotations?.["cnpg.io/hibernation"] === "on" ||
    !cluster.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) ||
    !Number.isSafeInteger(cluster.status.readyInstances) ||
    Number(cluster.status.readyInstances) < 1 ||
    !Number.isSafeInteger(ownerRole.metadata.generation) ||
    Number(ownerRole.metadata.generation) < 1 ||
    roleStatus.applied !== true ||
    roleStatus.observedGeneration !== ownerRole.metadata.generation ||
    roleStatus.secretResourceVersion !== claim.secretResourceVersion
  )
    return { applied: false };
  const caName = object(object(cluster.status).certificates).serverCASecret;
  if (
    typeof caName !== "string" ||
    !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(caName)
  )
    return { applied: false };
  const ca = await read("Secret", namespace, caName);
  if (
    !ca ||
    !clusterOwner(ca, claim) ||
    !ca.metadata.uid ||
    !ca.metadata.resourceVersion ||
    !ca.data?.["ca.crt"] ||
    ca.data["ca.crt"].length > 131_072
  )
    return { applied: false };
  const certificate = Buffer.from(ca.data["ca.crt"], "base64").toString("utf8"),
    host = `database-rw.${namespace}.svc`;
  if (!certificate) return { applied: false };
  const freshBinding = async () => {
    const current = await Promise.all([
      read("Namespace", "", namespace),
      read("Cluster", namespace, "database"),
      read("DatabaseRole", namespace, ownerRoleName),
      read("Secret", namespace, secretName),
      read("CiliumNetworkPolicy", namespace, "role-verifier-access"),
      read("Secret", namespace, caName),
    ]);
    return [ns, cluster, ownerRole, secret, policy, ca].every(
      (expected, index) =>
        current[index]?.metadata.uid === expected.metadata.uid &&
        current[index]?.metadata.resourceVersion ===
          expected.metadata.resourceVersion &&
        !current[index]?.metadata.deletionTimestamp,
    );
  };
  const probeInput = {
    host,
    username: claim.ownerRoleName,
    password: claim.password,
    ca: certificate,
    deadline: Math.min(
      Date.now() + 15_000,
      Date.parse(claim.leaseExpiresAt) - 5000,
    ),
  };
  if (!database) {
    authorized();
    const managers = await runtime.listDatabases(namespace);
    authorized();
    if (
      !Array.isArray(managers) ||
      managers.some(
        (manager) =>
          manager.kind !== "Database" ||
          manager.apiVersion !== "postgresql.cnpg.io/v1" ||
          manager.metadata.namespace !== namespace ||
          !manager.metadata.uid ||
          typeof object(manager.spec).name !== "string" ||
          typeof object(object(manager.spec).cluster).name !== "string",
      )
    )
      throw new Error("database_inventory_deferred");
    if (
      managers.some(
        (manager) =>
          object(manager.spec).name === claim.databaseName &&
          object(object(manager.spec).cluster).name === "database",
      )
    )
      throw new Error("database_name_conflict");
    if (!(await freshBinding())) return { applied: false };
    const absent = await verifier.absent({
      ...probeInput,
      database: "app",
      targetDatabase: claim.databaseName,
    });
    authorized();
    if (!absent) throw new Error("database_name_conflict");
    if (!(await freshBinding())) return { applied: false };
    const raced = await read("Database", namespace, name);
    if (raced) {
      if (!matchingDatabase(raced))
        throw new Error("database_ownership_mismatch");
      database = raced;
    } else {
      authorized();
      try {
        database = await runtime.create(desired);
      } catch {
        database = await read("Database", namespace, name);
      }
      authorized();
      if (!database) throw new Error("database_creation_deferred");
    }
  }
  if (!matchingDatabase(database)) throw new Error("database_spec_conflict");
  const status = object(database.status);
  if (
    status.applied !== true ||
    status.observedGeneration !== database.metadata.generation ||
    !Number.isSafeInteger(database.metadata.generation)
  )
    return { applied: false };
  if (!(await freshBinding())) return { applied: false };
  const before = await read("Database", namespace, name);
  if (
    !before ||
    !matchingDatabase(before) ||
    before.metadata.uid !== database.metadata.uid ||
    before.metadata.resourceVersion !== database.metadata.resourceVersion
  )
    return { applied: false };
  const result = await verifier.verify({
    ...probeInput,
    database: claim.databaseName,
    deadline: Math.min(
      Date.now() + 15_000,
      Date.parse(claim.leaseExpiresAt) - 5000,
    ),
  });
  authorized();
  const after = await read("Database", namespace, name);
  if (
    !(await freshBinding()) ||
    !after ||
    !matchingDatabase(after) ||
    after.metadata.uid !== database.metadata.uid ||
    after.metadata.resourceVersion !== database.metadata.resourceVersion ||
    !/^[1-9][0-9]{0,9}$/.test(result.databaseOid) ||
    result.authenticatedUser !== claim.ownerRoleName ||
    result.authenticatedDatabase !== claim.databaseName ||
    result.writablePrimary !== true ||
    result.databaseOwned !== true ||
    result.schemaCreateVerified !== true ||
    result.probeRolledBack !== true
  )
    return { applied: false };
  return {
    applied: true,
    observation: {
      namespaceUid: claim.namespaceUid,
      clusterUid: claim.clusterUid,
      ownerRoleUid: claim.ownerRoleUid,
      ownerCredentialRevision: claim.ownerCredentialRevision,
      secretUid: claim.secretUid,
      secretResourceVersion: claim.secretResourceVersion,
      databaseUid: database.metadata.uid!,
      databaseGeneration: database.metadata.generation!,
      databaseObservedGeneration: Number(status.observedGeneration),
      ...result,
    },
  };
}
