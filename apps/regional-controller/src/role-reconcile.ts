// SPDX-License-Identifier: Apache-2.0
import type {
  RoleClaim,
  RoleConfig,
  RoleObservation,
  RoleRuntime,
  RoleVerifier,
} from "./role-types.ts";
import type { Resource } from "./types.ts";
import { restrictedRoleSpec } from "./role-spec.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const dns = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
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
const basic = (value: string) => Buffer.from(value, "utf8").toString("base64");
export function validRoleConfig(config: RoleConfig): boolean {
  return (
    !!config &&
    dns.test(config.verifierNamespace) &&
    !!config.verifierPodLabels &&
    typeof config.verifierPodLabels === "object" &&
    !Array.isArray(config.verifierPodLabels) &&
    Object.keys(config.verifierPodLabels).length > 0 &&
    Object.keys(config.verifierPodLabels).length <= 16 &&
    Object.entries(config.verifierPodLabels).every(
      ([key, value]) =>
        key !== "io.kubernetes.pod.namespace" &&
        /^[A-Za-z0-9][A-Za-z0-9./_-]{0,252}$/.test(key) &&
        /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(value),
    )
  );
}
export function validRoleClaim(claim: RoleClaim): boolean {
  return (
    !!claim &&
    claim.schemaVersion === 1 &&
    claim.kind === "database.role.apply" &&
    [
      claim.operationId,
      claim.organizationId,
      claim.projectId,
      claim.environmentId,
      claim.regionId,
      claim.clusterUid,
      claim.roleId,
    ].every((id) => uuid.test(id)) &&
    Number.isSafeInteger(claim.specRevision) &&
    claim.specRevision > 0 &&
    hash.test(claim.specHash) &&
    Number.isSafeInteger(claim.credentialRevision) &&
    claim.credentialRevision > 0 &&
    /^[a-z][a-z0-9_]{0,62}$/.test(claim.roleName) &&
    !["app", "postgres", "streaming_replica"].includes(claim.roleName) &&
    !/^(pg_|cnpg_)/.test(claim.roleName) &&
    Number.isSafeInteger(claim.connectionLimit) &&
    claim.connectionLimit >= 1 &&
    claim.connectionLimit <= 1000 &&
    /^[A-Za-z0-9_-]{43}$/.test(claim.password) &&
    (claim.credentialRevision === 1
      ? claim.previousPassword === null
      : typeof claim.previousPassword === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(claim.previousPassword)) &&
    claim.secretName ===
      `pgcf-role-${claim.roleId.replaceAll("-", "")}-v${claim.credentialRevision}` &&
    /^cplease_[A-Za-z0-9_-]{43}$/.test(claim.leaseToken) &&
    Number.isSafeInteger(claim.leaseEpoch) &&
    claim.leaseEpoch > 0 &&
    Number.isFinite(Date.parse(claim.leaseExpiresAt))
  );
}
function owned(resource: Resource, claim: RoleClaim, role = false): boolean {
  return (
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    resource.metadata.labels?.["pgcf.io/environment-id"] ===
      claim.environmentId &&
    resource.metadata.labels?.["pgcf.io/region-id"] === claim.regionId &&
    resource.metadata.annotations?.["pgcf.io/spec-hash"] === claim.specHash &&
    (!role || resource.metadata.labels?.["pgcf.io/role-id"] === claim.roleId) &&
    !resource.metadata.deletionTimestamp
  );
}
function clusterOwner(resource: Resource, claim: RoleClaim): boolean {
  const owners = resource.metadata.ownerReferences?.filter(
    (owner) => owner.kind === "Cluster" && owner.controller === true,
  );
  return (
    owners?.length === 1 &&
    owners[0]?.uid === claim.clusterUid &&
    owners[0]?.name === "database" &&
    owners[0]?.apiVersion === "postgresql.cnpg.io/v1"
  );
}
function revision(role: Resource): bigint {
  const value = role.metadata.annotations?.["pgcf.io/credential-revision"];
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value))
    throw new Error("role_spec_conflict");
  return BigInt(value);
}
function matched(actual: Resource, expected: Resource): boolean {
  const actualSpec =
    expected.kind === "DatabaseRole"
      ? restrictedRoleSpec(actual.spec)
      : actual.spec;
  return (
    actual.apiVersion === expected.apiVersion &&
    actual.kind === expected.kind &&
    actual.metadata.name === expected.metadata.name &&
    actual.metadata.namespace === expected.metadata.namespace &&
    Object.entries(expected.metadata.labels ?? {}).every(
      ([key, value]) => actual.metadata.labels?.[key] === value,
    ) &&
    Object.entries(expected.metadata.annotations ?? {}).every(
      ([key, value]) => actual.metadata.annotations?.[key] === value,
    ) &&
    equal(actual.metadata.ownerReferences, expected.metadata.ownerReferences) &&
    (expected.spec === undefined ||
      Object.entries(expected.spec).every(([key, value]) =>
        equal(actualSpec?.[key], value),
      )) &&
    (expected.data === undefined || equal(actual.data, expected.data)) &&
    typeof actual.metadata.uid === "string" &&
    typeof actual.metadata.resourceVersion === "string" &&
    !actual.metadata.deletionTimestamp
  );
}
export async function reconcileRole(
  runtime: RoleRuntime,
  claim: RoleClaim,
  config: RoleConfig,
  verifier: RoleVerifier,
  authorized: () => void,
): Promise<{ applied: boolean; observation?: RoleObservation }> {
  authorized();
  if (!validRoleClaim(claim) || !validRoleConfig(config))
    throw new Error("role_spec_conflict");
  const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`,
    roleName = `pgcf-role-${claim.roleId.replaceAll("-", "")}`;
  const read = async (
    kind: Parameters<RoleRuntime["read"]>[0],
    ns: string,
    name: string,
  ) => {
    authorized();
    const result = await runtime.read(kind, ns, name);
    authorized();
    return result;
  };
  // Read the stable role before any Secret or network-policy mutation. Reclaimed
  // work must never roll an already-newer credential back.
  let role = await read("DatabaseRole", namespace, roleName);
  if (role) {
    if (!owned(role, claim, true) || !clusterOwner(role, claim))
      throw new Error("role_ownership_mismatch");
    const current = revision(role);
    if (current > BigInt(claim.credentialRevision))
      throw new Error("role_revision_superseded");
    if (current < BigInt(claim.credentialRevision - 1))
      throw new Error("role_spec_conflict");
  }
  const ns = await read("Namespace", "", namespace),
    cluster = await read("Cluster", namespace, "database");
  if (
    !ns ||
    !cluster ||
    !owned(ns, claim) ||
    !owned(cluster, claim) ||
    !ns.metadata.uid ||
    cluster.metadata.uid !== claim.clusterUid ||
    object(object(cluster.spec).bootstrap).initdb === undefined ||
    object(object(object(cluster.spec).bootstrap).initdb).database !== "app"
  )
    throw new Error("role_ownership_mismatch");
  if (
    cluster.metadata.annotations?.["cnpg.io/hibernation"] === "on" ||
    cluster.status?.readyInstances === undefined ||
    cluster.status.readyInstances < 1 ||
    !cluster.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    )
  )
    return { applied: false };
  const inline = object(object(cluster.spec).managed).roles;
  if (
    Array.isArray(inline) &&
    inline.some((value) => object(value).name === claim.roleName)
  )
    throw new Error("role_spec_conflict");
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": claim.environmentId,
    "pgcf.io/region-id": claim.regionId,
  };
  const owner = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    name: "database",
    uid: claim.clusterUid,
    controller: true,
  };
  const metadata = (name: string, credential = false) => ({
    name,
    namespace,
    labels: {
      ...labels,
      ...(credential ? { "pgcf.io/role-id": claim.roleId } : {}),
    },
    annotations: {
      "pgcf.io/spec-hash": claim.specHash,
      ...(credential
        ? { "pgcf.io/credential-revision": String(claim.credentialRevision) }
        : {}),
    },
    ownerReferences: [owner],
  });
  const create = async (expected: Resource) => {
    let actual = await read(
      expected.kind as Parameters<RoleRuntime["read"]>[0],
      namespace,
      expected.metadata.name,
    );
    if (!actual) {
      authorized();
      try {
        actual = await runtime.create(expected);
      } catch {
        actual = await read(
          expected.kind as Parameters<RoleRuntime["read"]>[0],
          namespace,
          expected.metadata.name,
        );
      }
      authorized();
    }
    if (!actual) throw new Error("role_application_deferred");
    if (!matched(actual, expected)) throw new Error("role_spec_conflict");
    return actual;
  };
  const desiredSecret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata(claim.secretName, true),
    immutable: true,
    type: "kubernetes.io/basic-auth",
    data: { username: basic(claim.roleName), password: basic(claim.password) },
  } as unknown as Resource;
  const secret = await create(desiredSecret);
  if (
    object(secret).immutable !== true ||
    object(secret).type !== "kubernetes.io/basic-auth"
  )
    throw new Error("role_spec_conflict");
  const desiredRole: Resource = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "DatabaseRole",
    metadata: metadata(roleName, true),
    spec: {
      cluster: { name: "database" },
      name: claim.roleName,
      ensure: "present",
      login: true,
      superuser: false,
      createdb: false,
      createrole: false,
      replication: false,
      bypassrls: false,
      inherit: false,
      inRoles: [],
      connectionLimit: claim.connectionLimit,
      passwordSecret: { name: claim.secretName },
    },
  };
  if (role) {
    const actualSpec = restrictedRoleSpec(role.spec);
    for (const [key, value] of Object.entries(desiredRole.spec!)) {
      if (key !== "passwordSecret" && !equal(actualSpec?.[key], value))
        throw new Error("role_spec_conflict");
    }
    if (revision(role) < BigInt(claim.credentialRevision)) {
      if (
        role.spec?.passwordSecret === undefined ||
        !role.metadata.resourceVersion ||
        !role.metadata.uid
      )
        throw new Error("role_spec_conflict");
      authorized();
      try {
        await runtime.patchRole(namespace, roleName, [
          { op: "test", path: "/metadata/uid", value: role.metadata.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: role.metadata.resourceVersion,
          },
          {
            op: "replace",
            path: "/spec/passwordSecret/name",
            value: claim.secretName,
          },
          {
            op: "replace",
            path: "/metadata/annotations/pgcf.io~1credential-revision",
            value: String(claim.credentialRevision),
          },
        ]);
      } catch {
        /* The same stable resource, never another Role or a blind patch retry. */
      }
      role = await read("DatabaseRole", namespace, roleName);
    }
    if (role && revision(role) < BigInt(claim.credentialRevision))
      return { applied: false };
    if (!role) throw new Error("role_application_deferred");
    if (!matched(role, desiredRole)) throw new Error("role_spec_conflict");
  } else role = await create(desiredRole);
  const selectors = Object.fromEntries(
    Object.entries(config.verifierPodLabels).map(([key, value]) => [
      `k8s:${key}`,
      value,
    ]),
  );
  await create({
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: metadata("role-verifier-access"),
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
                ...selectors,
                "k8s:io.kubernetes.pod.namespace": config.verifierNamespace,
              },
            },
          ],
          toPorts: [{ ports: [{ port: "5432", protocol: "TCP" }] }],
        },
      ],
    },
  });
  const status = object(role.status);
  if (
    status.applied !== true ||
    status.observedGeneration !== role.metadata.generation ||
    status.secretResourceVersion !== secret.metadata.resourceVersion ||
    !Number.isSafeInteger(role.metadata.generation)
  )
    return { applied: false };
  const caName = object(object(cluster.status).certificates).serverCASecret;
  if (typeof caName !== "string" || !dns.test(caName))
    return { applied: false };
  const ca = await read("Secret", namespace, caName);
  if (
    !ca ||
    !clusterOwner(ca, claim) ||
    !ca.metadata.uid ||
    !ca.metadata.resourceVersion ||
    typeof ca.data?.["ca.crt"] !== "string" ||
    ca.data["ca.crt"].length > 131_072
  )
    return { applied: false };
  const certificate = Buffer.from(ca.data["ca.crt"], "base64").toString("utf8");
  if (!certificate) return { applied: false };
  const same = (a: Resource | null, b: Resource) =>
    a !== null &&
    a.metadata.uid === b.metadata.uid &&
    a.metadata.resourceVersion === b.metadata.resourceVersion &&
    !a.metadata.deletionTimestamp;
  const snapshot = async () => {
    const [namespaceNow, clusterNow, roleNow, secretNow, caNow] =
      await Promise.all([
        read("Namespace", "", namespace),
        read("Cluster", namespace, "database"),
        read("DatabaseRole", namespace, roleName),
        read("Secret", namespace, claim.secretName),
        read("Secret", namespace, caName),
      ]);
    return (
      same(namespaceNow, ns) &&
      same(clusterNow, cluster) &&
      same(roleNow, role!) &&
      same(secretNow, secret) &&
      same(caNow, ca)
    );
  };
  if (!(await snapshot())) return { applied: false };
  const result = await verifier.verify({
    host: `database-rw.${namespace}.svc`,
    database: "app",
    username: claim.roleName,
    password: claim.password,
    previousPassword: claim.previousPassword,
    ca: certificate,
    deadline: Math.min(
      Date.now() + 15_000,
      Date.parse(claim.leaseExpiresAt) - 5000,
    ),
  });
  authorized();
  if (
    !(await snapshot()) ||
    result.authenticatedUser !== claim.roleName ||
    result.authenticatedDatabase !== "app" ||
    result.writablePrimary !== true ||
    result.previousCredentialRejected !==
      (claim.previousPassword === null ? null : true)
  )
    return { applied: false };
  return {
    applied: true,
    observation: {
      namespaceUid: ns.metadata.uid,
      clusterUid: claim.clusterUid,
      roleUid: role.metadata.uid!,
      roleGeneration: role.metadata.generation!,
      roleObservedGeneration: Number(status.observedGeneration),
      secretUid: secret.metadata.uid!,
      secretResourceVersion: secret.metadata.resourceVersion!,
      roleSecretResourceVersion: String(status.secretResourceVersion),
      ...result,
    },
  };
}
