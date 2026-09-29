import {
  boundNativeConnection,
  readNativeConnection,
  validNativeAccess,
  validNativeConnection,
  type NativeAccessPolicy,
  type NativeConnectionObservation,
} from "./native-access";
import { assertion } from "./accounting";
import { environmentNotDeleting } from "./environment-runtime";
import {
  deletionReadColumns,
  deletionReadJoins,
  deletionView,
  type DeletionPointer,
} from "./environment-deletion";
import {
  actorBindings,
  actorPredicate,
  authorize,
  idempotencyKey,
  type Actor,
} from "./execution-auth";
type Env = Cloudflare.Env;
type Database = D1DatabaseSession;
type JsonObject = Record<string, unknown>;

interface PoolingPolicy {
  version: 1;
  image: string;
  mode: "session";
  compute: {
    requests: { cpuMilli: number; memoryMiB: number };
    limits: { cpuMilli: number; memoryMiB: number };
  };
  connections: {
    maxClients: number;
    poolSize: number;
    maxDatabaseConnections: number;
    maxUserConnections: number;
  };
  timeouts: {
    queryWaitSeconds: number;
    connectSeconds: number;
    cancelWaitSeconds: number;
  };
}

interface PoolerObservation {
  uid: string;
  generation: number;
  deploymentUid: string;
  readyInstances: 1;
}

interface EnvironmentObservation {
  nativeConnection?: NativeConnectionObservation;
  clusterUid: string;
  clusterGeneration: number;
  readyInstances: number;
  pooler?: PoolerObservation;
  runEpoch?: string;
  nodeCohort?: { uid: string; hash: string };
}

interface ComputeScalingPolicy {
  version: 1;
  initialSizeId: string;
  sizes: { id: string; cpuMilli: number; memoryMiB: number }[];
}

interface Profile {
  id: string;
  postgresImage: string;
  compute: { cpuMilli: number; memoryMiB: number };
  computeScaling?: ComputeScalingPolicy;
  storage: {
    classId: string;
    storageClassName: string;
    minGiB: number;
    maxGiB: number;
    stepGiB: number;
  };
  instances: number;
  backup: {
    region: string;
    endpointURL: string;
    destinationPath: string;
    retentionPolicy: string;
    credentialSecret: {
      namespace: string;
      name: string;
      accessKeyIdKey: string;
      secretAccessKeyKey: string;
    };
  };
  pooling?: PoolingPolicy;
  nativeAccess?: NativeAccessPolicy;
  executionFencing?: { version: 1 };
  nodeTracking?: { version: 1 };
}

interface EnvironmentInput {
  name: string;
  regionId: string;
  catalogVersion: string;
  profileId: string;
  volumeGiB: number;
}

interface ResolvedSpec extends EnvironmentInput {
  profile: Profile;
}

export interface EnvironmentRow extends DeletionPointer {
  id: string;
  organization_id: string;
  project_id: string;
  region_id: string;
  name: string;
  status: string;
  spec_revision: number;
  spec_hash: string;
  resolved_spec: string;
  created_at: string;
  observed_at: string | null;
  observation_json: string | null;
  run_epoch: string | null;
}

interface ExecutionRow {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  kind: string;
  status: string;
  lease_token_hash: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  created_at: string;
  observed_at: string | null;
  result_code: string | null;
  result_hash: string | null;
}

interface CatalogRow {
  region_id: string;
  version: string;
  profiles_json: string;
  catalog_hash: string;
  created_at: string;
}

interface AdmissionRow {
  catalog_version: string;
  accepting_new_environments: number;
  updated_at: string;
}

interface RequestRow {
  request_hash: string;
  environment_id: string;
  operation_id: string;
}
interface AdmissionPermitRow {
  id: string;
  organization_id: string;
  project_id: string;
  region_id: string;
  catalog_version: string;
  binding_json: string;
  spec_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_environment_id: string | null;
  consumed_operation_id: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
}
interface PermitRequestRow {
  request_hash: string;
  permit_id: string;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const identifier = /^[a-z][a-z0-9_-]{0,63}$/;
const version = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const secretKey = /^[A-Za-z0-9._-]{1,253}$/;
const runEpoch = /^[1-9][0-9]{0,18}$/;
const digest = /^[0-9a-f]{64}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function error(status: number, code: string): Response {
  return json({ error: { code } }, status);
}

function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => keys.includes(key) || optional.includes(key),
    )
  );
}

function text(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function name(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 120 &&
    value === value.trim() &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

async function body(request: Request, maximumBytes = 4096): Promise<unknown> {
  if (
    !request.body ||
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    ) ||
    Number(request.headers.get("content-length")) > maximumBytes
  )
    return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(value + decoder.decode()) as unknown;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        return null;
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bearer(request: Request): string | null {
  return (
    /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1] ?? null
  );
}

async function installAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.INSTALLATION_BOOTSTRAP_TOKEN)
    return error(503, "bootstrap_unconfigured");
  const token = bearer(request);
  if (!token) return error(401, "unauthorized");
  const actual = await sha256(token);
  const expected = await sha256(env.INSTALLATION_BOOTSTRAP_TOKEN);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1)
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0 ? null : error(401, "unauthorized");
}

async function scopedAuth(
  request: Request,
  db: Database,
  id: string,
  kind: "organization" | "region",
  scope: string,
): Promise<Response | null> {
  const raw = bearer(request);
  if (!raw) return error(401, "unauthorized");
  const row = await db
    .prepare(
      kind === "organization"
        ? "SELECT organization_id AS owner_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL"
        : "SELECT region_id AS owner_id, scopes FROM region_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(await sha256(raw))
    .first<{ owner_id: string; scopes: string }>();
  if (!row) return error(401, "unauthorized");
  if (row.owner_id !== id) return error(404, "not_found");
  if (!row.scopes.split(" ").includes(scope)) return error(403, "forbidden");
  if (kind === "region") {
    const region = await db
      .prepare("SELECT status FROM regions WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    if (!region || region.status === "disabled")
      return error(403, "region_disabled");
  }
  return null;
}

function poolingFromJson(value: unknown): PoolingPolicy | null {
  if (
    !object(value, [
      "version",
      "image",
      "mode",
      "compute",
      "connections",
      "timeouts",
    ]) ||
    value.version !== 1 ||
    value.mode !== "session" ||
    !text(value.image, /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/) ||
    !object(value.compute, ["requests", "limits"]) ||
    !object(value.compute.requests, ["cpuMilli", "memoryMiB"]) ||
    !integer(value.compute.requests.cpuMilli, 1, 1_000_000) ||
    !integer(value.compute.requests.memoryMiB, 1, 1_048_576) ||
    !object(value.compute.limits, ["cpuMilli", "memoryMiB"]) ||
    !integer(
      value.compute.limits.cpuMilli,
      value.compute.requests.cpuMilli,
      1_000_000,
    ) ||
    !integer(
      value.compute.limits.memoryMiB,
      value.compute.requests.memoryMiB,
      1_048_576,
    ) ||
    !object(value.connections, [
      "maxClients",
      "poolSize",
      "maxDatabaseConnections",
      "maxUserConnections",
    ]) ||
    !integer(value.connections.maxClients, 1, 10_000) ||
    !integer(value.connections.poolSize, 1, 1_000) ||
    value.connections.poolSize > value.connections.maxClients ||
    !integer(
      value.connections.maxDatabaseConnections,
      value.connections.poolSize,
      1_000,
    ) ||
    !integer(
      value.connections.maxUserConnections,
      value.connections.poolSize,
      1_000,
    ) ||
    !object(value.timeouts, [
      "queryWaitSeconds",
      "connectSeconds",
      "cancelWaitSeconds",
    ]) ||
    !integer(value.timeouts.queryWaitSeconds, 1, 300) ||
    !integer(value.timeouts.connectSeconds, 1, 300) ||
    !integer(value.timeouts.cancelWaitSeconds, 1, 300)
  )
    return null;
  return {
    version: 1,
    image: value.image,
    mode: "session",
    compute: {
      requests: {
        cpuMilli: value.compute.requests.cpuMilli,
        memoryMiB: value.compute.requests.memoryMiB,
      },
      limits: {
        cpuMilli: value.compute.limits.cpuMilli,
        memoryMiB: value.compute.limits.memoryMiB,
      },
    },
    connections: {
      maxClients: value.connections.maxClients,
      poolSize: value.connections.poolSize,
      maxDatabaseConnections: value.connections.maxDatabaseConnections,
      maxUserConnections: value.connections.maxUserConnections,
    },
    timeouts: {
      queryWaitSeconds: value.timeouts.queryWaitSeconds,
      connectSeconds: value.timeouts.connectSeconds,
      cancelWaitSeconds: value.timeouts.cancelWaitSeconds,
    },
  };
}

export function validNodeCohortPointer(
  value: unknown,
): value is { uid: string; hash: string } {
  return (
    object(value, ["uid", "hash"]) &&
    text(value.uid, uuid) &&
    text(value.hash, /^[a-f0-9]{64}$/)
  );
}

export function validEnvironmentObservation(
  value: unknown,
  pooled: boolean,
  expectedRunEpoch?: string,
  tracked = false,
  native = false,
): value is EnvironmentObservation {
  return (
    object(
      value,
      ["clusterUid", "clusterGeneration", "readyInstances"],
      ["pooler", "runEpoch", "nodeCohort", "nativeConnection"],
    ) &&
    name(value.clusterUid) &&
    integer(value.clusterGeneration, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.readyInstances, 1, 9) &&
    Object.hasOwn(value, "nativeConnection") === native &&
    (!native ||
      (validNativeConnection(value.nativeConnection) &&
        value.nativeConnection.clusterUid === value.clusterUid &&
        value.nativeConnection.clusterGeneration ===
          value.clusterGeneration)) &&
    Object.hasOwn(value, "runEpoch") === (expectedRunEpoch !== undefined) &&
    (expectedRunEpoch === undefined ||
      (runEpoch.test(expectedRunEpoch) &&
        value.runEpoch === expectedRunEpoch)) &&
    Object.hasOwn(value, "nodeCohort") === tracked &&
    (!tracked ||
      (expectedRunEpoch !== undefined &&
        validNodeCohortPointer(value.nodeCohort))) &&
    Object.hasOwn(value, "pooler") === pooled &&
    (!pooled ||
      (object(value.pooler, [
        "uid",
        "generation",
        "deploymentUid",
        "readyInstances",
      ]) &&
        text(value.pooler.uid, uuid) &&
        integer(value.pooler.generation, 1, Number.MAX_SAFE_INTEGER) &&
        text(value.pooler.deploymentUid, uuid) &&
        value.pooler.readyInstances === 1))
  );
}

function computeScalingFromJson(
  value: unknown,
  initial: Record<string, unknown>,
): ComputeScalingPolicy | null {
  if (
    !object(value, ["version", "initialSizeId", "sizes"]) ||
    value.version !== 1 ||
    !text(value.initialSizeId, identifier) ||
    !Array.isArray(value.sizes) ||
    value.sizes.length < 2 ||
    value.sizes.length > 8
  )
    return null;
  const sizes: ComputeScalingPolicy["sizes"] = [];
  const ids = new Set<string>();
  for (const entry of value.sizes) {
    if (
      !object(entry, ["id", "cpuMilli", "memoryMiB"]) ||
      !text(entry.id, identifier) ||
      !integer(entry.cpuMilli, 1, 1_000_000) ||
      !integer(entry.memoryMiB, 1, 1_048_576) ||
      ids.has(entry.id) ||
      (sizes.length > 0 &&
        (entry.cpuMilli <= sizes[sizes.length - 1]!.cpuMilli ||
          entry.memoryMiB <= sizes[sizes.length - 1]!.memoryMiB))
    )
      return null;
    ids.add(entry.id);
    sizes.push({
      id: entry.id,
      cpuMilli: entry.cpuMilli,
      memoryMiB: entry.memoryMiB,
    });
  }
  const selected = sizes.find((size) => size.id === value.initialSizeId);
  if (
    !selected ||
    selected.cpuMilli !== initial.cpuMilli ||
    selected.memoryMiB !== initial.memoryMiB
  )
    return null;
  return { version: 1, initialSizeId: value.initialSizeId, sizes };
}

function profileFromJson(value: unknown): Profile | null {
  if (
    !object(
      value,
      ["id", "postgresImage", "compute", "storage", "instances", "backup"],
      [
        "pooling",
        "executionFencing",
        "nodeTracking",
        "nativeAccess",
        "computeScaling",
      ],
    ) ||
    !text(value.id, identifier) ||
    !text(
      value.postgresImage,
      /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/,
    ) ||
    !integer(value.instances, 1, 9) ||
    !object(value.compute, ["cpuMilli", "memoryMiB"]) ||
    !integer(value.compute.cpuMilli, 1, 1_000_000) ||
    !integer(value.compute.memoryMiB, 1, 1_048_576) ||
    !object(value.storage, [
      "classId",
      "storageClassName",
      "minGiB",
      "maxGiB",
      "stepGiB",
    ]) ||
    !text(value.storage.classId, identifier) ||
    !text(value.storage.storageClassName, dnsLabel) ||
    !integer(value.storage.minGiB, 1, 1_048_576) ||
    !integer(value.storage.maxGiB, value.storage.minGiB, 1_048_576) ||
    !integer(value.storage.stepGiB, 1, 1_048_576) ||
    !object(value.backup, [
      "region",
      "endpointURL",
      "destinationPath",
      "retentionPolicy",
      "credentialSecret",
    ]) ||
    !text(value.backup.region, /^[a-z0-9][a-z0-9-]{0,62}$/) ||
    typeof value.backup.endpointURL !== "string" ||
    !text(
      value.backup.destinationPath,
      /^s3:\/\/[a-z0-9][a-z0-9.-]{1,62}(?:\/[A-Za-z0-9/._-]*)?$/,
    ) ||
    !text(value.backup.retentionPolicy, /^[1-9][0-9]{0,3}[dwm]$/) ||
    !object(value.backup.credentialSecret, [
      "namespace",
      "name",
      "accessKeyIdKey",
      "secretAccessKeyKey",
    ]) ||
    !text(value.backup.credentialSecret.namespace, dnsLabel) ||
    !text(value.backup.credentialSecret.name, dnsLabel) ||
    !text(value.backup.credentialSecret.accessKeyIdKey, secretKey) ||
    !text(value.backup.credentialSecret.secretAccessKeyKey, secretKey)
  )
    return null;
  const pooling = Object.hasOwn(value, "pooling")
    ? poolingFromJson(value.pooling)
    : undefined;
  if (pooling === null) return null;
  const computeScaling = Object.hasOwn(value, "computeScaling")
    ? computeScalingFromJson(value.computeScaling, value.compute)
    : undefined;
  if (computeScaling === null) return null;
  if (
    Object.hasOwn(value, "nativeAccess") &&
    !validNativeAccess(value.nativeAccess)
  )
    return null;
  if (
    Object.hasOwn(value, "executionFencing") &&
    (!object(value.executionFencing, ["version"]) ||
      value.executionFencing.version !== 1)
  )
    return null;
  if (
    Object.hasOwn(value, "nodeTracking") &&
    (!object(value.nodeTracking, ["version"]) ||
      value.nodeTracking.version !== 1 ||
      !Object.hasOwn(value, "executionFencing"))
  )
    return null;
  try {
    const endpoint = new URL(value.backup.endpointURL);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.pathname !== "/" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      return null;
  } catch {
    return null;
  }
  return {
    id: value.id,
    postgresImage: value.postgresImage,
    compute: {
      cpuMilli: value.compute.cpuMilli,
      memoryMiB: value.compute.memoryMiB,
    },
    ...(computeScaling === undefined ? {} : { computeScaling }),
    storage: {
      classId: value.storage.classId,
      storageClassName: value.storage.storageClassName,
      minGiB: value.storage.minGiB,
      maxGiB: value.storage.maxGiB,
      stepGiB: value.storage.stepGiB,
    },
    instances: value.instances,
    backup: {
      region: value.backup.region,
      endpointURL: value.backup.endpointURL,
      destinationPath: value.backup.destinationPath,
      retentionPolicy: value.backup.retentionPolicy,
      credentialSecret: {
        namespace: value.backup.credentialSecret.namespace,
        name: value.backup.credentialSecret.name,
        accessKeyIdKey: value.backup.credentialSecret.accessKeyIdKey,
        secretAccessKeyKey: value.backup.credentialSecret.secretAccessKeyKey,
      },
    },
    ...(pooling === undefined ? {} : { pooling }),
    ...(Object.hasOwn(value, "nativeAccess")
      ? {
          nativeAccess: {
            version: 1 as const,
            clientProfileId: (value.nativeAccess as NativeAccessPolicy)
              .clientProfileId,
          },
        }
      : {}),
    ...(Object.hasOwn(value, "nodeTracking")
      ? { nodeTracking: { version: 1 as const } }
      : {}),
    ...(Object.hasOwn(value, "executionFencing")
      ? { executionFencing: { version: 1 as const } }
      : {}),
  };
}

function publicProfile(profile: Profile) {
  return {
    id: profile.id,
    postgresImage: profile.postgresImage,
    compute: profile.compute,
    ...(profile.computeScaling === undefined
      ? {}
      : { computeScaling: profile.computeScaling }),
    storage: {
      classId: profile.storage.classId,
      minGiB: profile.storage.minGiB,
      maxGiB: profile.storage.maxGiB,
      stepGiB: profile.storage.stepGiB,
    },
    instances: profile.instances,
    backup: { retentionPolicy: profile.backup.retentionPolicy },
    ...(profile.pooling === undefined ? {} : { pooling: profile.pooling }),
    ...(profile.nativeAccess === undefined
      ? {}
      : { nativeAccess: profile.nativeAccess }),
    ...(profile.nodeTracking === undefined
      ? {}
      : { nodeTracking: profile.nodeTracking }),
    ...(profile.executionFencing === undefined
      ? {}
      : { executionFencing: profile.executionFencing }),
  };
}

export function publicEnvironment(row: EnvironmentRow) {
  const spec = JSON.parse(row.resolved_spec) as ResolvedSpec;
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    regionId: row.region_id,
    name: row.name,
    status: row.status,
    lifecycle: deletionView(row),
    specRevision: row.spec_revision,
    specHash: row.spec_hash,
    resolvedSpec: { ...spec, profile: publicProfile(spec.profile) },
    createdAt: row.created_at,
    observedAt: row.observed_at,
    observation:
      row.observation_json === null
        ? null
        : (JSON.parse(row.observation_json) as unknown),
    ...(row.run_epoch === null ? {} : { runEpoch: row.run_epoch }),
  };
}

function publicOperation(row: ExecutionRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    observedAt: row.observed_at,
    resultCode: row.result_code,
  };
}

async function catalog(
  db: Database,
  regionId: string,
  catalogVersion: string,
): Promise<CatalogRow | null> {
  return db
    .prepare(
      "SELECT * FROM region_catalogs WHERE region_id = ? AND version = ?",
    )
    .bind(regionId, catalogVersion)
    .first<CatalogRow>();
}

async function admission(db: Database, regionId: string) {
  const row = await db
    .prepare("SELECT * FROM region_admission WHERE region_id = ?")
    .bind(regionId)
    .first<AdmissionRow>();
  return {
    catalogVersion: row?.catalog_version ?? null,
    acceptingNewEnvironments: row?.accepting_new_environments === 1,
    updatedAt: row?.updated_at ?? null,
  };
}

async function publishCatalog(
  request: Request,
  env: Env,
  db: Database,
  regionId: string,
): Promise<Response> {
  const denied = await installAuth(request, env);
  if (denied) return denied;
  const input = await body(request, 16_384);
  if (
    !object(input, ["version", "profiles"]) ||
    !text(input.version, version) ||
    !Array.isArray(input.profiles) ||
    input.profiles.length < 1 ||
    input.profiles.length > 16
  )
    return error(400, "invalid_request");
  const profiles = input.profiles.map(profileFromJson);
  if (
    profiles.some((item) => item === null) ||
    new Set(profiles.map((item) => item!.id)).size !== profiles.length
  )
    return error(400, "invalid_request");
  const region = await db
    .prepare("SELECT id FROM regions WHERE id = ?")
    .bind(regionId)
    .first();
  if (!region) return error(404, "not_found");
  const serialized = JSON.stringify(profiles);
  const hash = await sha256(serialized);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        "INSERT INTO region_catalogs (region_id, version, profiles_json, catalog_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(regionId, input.version, serialized, hash, now)
      .run();
  } catch {
    return (await catalog(db, regionId, input.version))
      ? error(409, "catalog_version_conflict")
      : error(500, "write_failed");
  }
  return json(
    {
      catalog: {
        regionId,
        version: input.version,
        profiles: profiles.map((item) => publicProfile(item!)),
        catalogHash: hash,
        createdAt: now,
      },
    },
    201,
  );
}

async function setAdmission(
  request: Request,
  env: Env,
  db: Database,
  regionId: string,
): Promise<Response> {
  const denied = await installAuth(request, env);
  if (denied) return denied;
  const input = await body(request);
  if (
    !object(input, ["catalogVersion", "acceptingNewEnvironments"]) ||
    !text(input.catalogVersion, version) ||
    typeof input.acceptingNewEnvironments !== "boolean"
  )
    return error(400, "invalid_request");
  const region = await db
    .prepare("SELECT status FROM regions WHERE id = ?")
    .bind(regionId)
    .first<{ status: string }>();
  if (!region) return error(404, "not_found");
  if (region.status === "disabled" && input.acceptingNewEnvironments)
    return error(409, "region_disabled");
  if (!(await catalog(db, regionId, input.catalogVersion)))
    return error(404, "not_found");
  await db
    .prepare(
      "INSERT INTO region_admission (region_id, catalog_version, accepting_new_environments, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(region_id) DO UPDATE SET catalog_version = excluded.catalog_version, accepting_new_environments = excluded.accepting_new_environments, updated_at = excluded.updated_at",
    )
    .bind(
      regionId,
      input.catalogVersion,
      input.acceptingNewEnvironments ? 1 : 0,
      new Date().toISOString(),
    )
    .run();
  return json({ admission: await admission(db, regionId) });
}

function environmentInput(
  input: unknown,
  optional: readonly string[] = [],
): EnvironmentInput | null {
  if (
    !object(
      input,
      ["name", "regionId", "catalogVersion", "profileId", "volumeGiB"],
      optional,
    ) ||
    !name(input.name) ||
    !text(input.regionId, uuid) ||
    !text(input.catalogVersion, version) ||
    !text(input.profileId, identifier) ||
    !integer(input.volumeGiB, 1, 1_048_576)
  )
    return null;
  return {
    name: input.name,
    regionId: input.regionId,
    catalogVersion: input.catalogVersion,
    profileId: input.profileId,
    volumeGiB: input.volumeGiB,
  };
}

function permitBinding(input: EnvironmentInput, catalogHash: string): string {
  return JSON.stringify({
    name: input.name,
    profileId: input.profileId,
    volumeGiB: input.volumeGiB,
    catalogHash,
  });
}
function publicPermit(row: AdmissionPermitRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    regionId: row.region_id,
    catalogVersion: row.catalog_version,
    ...(JSON.parse(row.binding_json) as {
      name: string;
      profileId: string;
      volumeGiB: number;
      catalogHash: string;
    }),
    specHash: row.spec_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    status: row.consumed_at
      ? "consumed"
      : row.revoked_at
        ? "revoked"
        : row.expires_at <= new Date().toISOString()
          ? "expired"
          : "issued",
    consumedEnvironmentId: row.consumed_environment_id,
    consumedOperationId: row.consumed_operation_id,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}
const readPermit = (db: Database, id: string) =>
  db
    .prepare("SELECT * FROM environment_admission_permits WHERE id=?")
    .bind(id)
    .first<AdmissionPermitRow>();
const readPermitRequest = (db: Database, key: string) =>
  db
    .prepare(
      "SELECT request_hash,permit_id FROM admission_permit_requests WHERE idempotency_key=?",
    )
    .bind(key)
    .first<PermitRequestRow>();
async function permitReplay(
  db: Database,
  row: PermitRequestRow,
  requestHash: string,
  status: number,
) {
  if (row.request_hash !== requestHash)
    return error(409, "idempotency_conflict");
  const permit = await readPermit(db, row.permit_id);
  return permit
    ? json({ permit: publicPermit(permit) }, status)
    : error(500, "state_inconsistent");
}
function resolveSpec(
  input: EnvironmentInput,
  release: CatalogRow,
): ResolvedSpec | null {
  const profile = (JSON.parse(release.profiles_json) as Profile[]).find(
    (item) => item.id === input.profileId,
  );
  if (
    !profile ||
    input.volumeGiB < profile.storage.minGiB ||
    input.volumeGiB > profile.storage.maxGiB ||
    (input.volumeGiB - profile.storage.minGiB) % profile.storage.stepGiB !== 0
  )
    return null;
  return { ...input, profile };
}
async function issueAdmissionPermit(
  request: Request,
  env: Env,
  db: Database,
): Promise<Response> {
  const denied = await installAuth(request, env);
  if (denied) return denied;
  const key = idempotencyKey(request);
  if (!key) return error(400, "invalid_idempotency_key");
  const value = await body(request);
  const input = environmentInput(value, [
    "organizationId",
    "projectId",
    "catalogHash",
    "specHash",
    "expiresAt",
  ]);
  if (
    !input ||
    !object(value, [
      "organizationId",
      "projectId",
      "name",
      "regionId",
      "catalogVersion",
      "profileId",
      "volumeGiB",
      "catalogHash",
      "specHash",
      "expiresAt",
    ]) ||
    !text(value.organizationId, uuid) ||
    !text(value.projectId, uuid) ||
    !text(value.catalogHash, digest) ||
    !text(value.specHash, digest) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    return error(400, "invalid_request");
  const organizationId = value.organizationId,
    projectId = value.projectId;
  const requestHash = await sha256(
    `POST /v1/environment-admission-permits\n${JSON.stringify({ organizationId, projectId, ...input, catalogHash: value.catalogHash, specHash: value.specHash, expiresAt: value.expiresAt })}`,
  );
  const prior = await readPermitRequest(db, key);
  if (prior) return permitReplay(db, prior, requestHash, 201);
  const now = new Date().toISOString();
  if (
    value.expiresAt <= now ||
    Date.parse(value.expiresAt) - Date.parse(now) > 3_600_000
  )
    return error(400, "invalid_expiry");
  const release = await catalog(db, input.regionId, input.catalogVersion);
  if (!release) return error(404, "not_found");
  const spec = resolveSpec(input, release);
  if (!spec) return error(400, "unsupported_profile");
  const specHash = await sha256(JSON.stringify(spec));
  if (release.catalog_hash !== value.catalogHash || specHash !== value.specHash)
    return error(409, "permit_binding_conflict");
  const predicate =
    "EXISTS (SELECT 1 FROM projects p JOIN regions g ON g.id=? JOIN region_catalogs c ON c.region_id=g.id AND c.version=? WHERE p.id=? AND p.organization_id=? AND p.status='active' AND g.status<>'disabled' AND c.catalog_hash=?)";
  const bindings = [
    input.regionId,
    input.catalogVersion,
    projectId,
    organizationId,
    release.catalog_hash,
  ];
  const id = crypto.randomUUID();
  try {
    await db.batch([
      assertion(db, predicate, bindings),
      db
        .prepare(
          "INSERT INTO environment_admission_permits(id,organization_id,project_id,region_id,catalog_version,binding_json,spec_hash,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          organizationId,
          projectId,
          input.regionId,
          input.catalogVersion,
          permitBinding(input, release.catalog_hash),
          specHash,
          now,
          value.expiresAt,
        ),
      assertion(db, "changes()=1"),
      db
        .prepare(
          "INSERT INTO admission_permit_requests(idempotency_key,request_hash,action,permit_id,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(key, requestHash, "issue", id, now),
      assertion(db, "changes()=1"),
    ]);
  } catch {
    const winner = await readPermitRequest(db, key);
    if (winner) return permitReplay(db, winner, requestHash, 201);
    if (
      !(await db
        .prepare(`SELECT 1 WHERE ${predicate}`)
        .bind(...bindings)
        .first())
    )
      return error(409, "permit_scope_unavailable");
    return error(500, "write_failed");
  }
  return json({ permit: publicPermit((await readPermit(db, id))!) }, 201);
}
async function revokeAdmissionPermit(
  request: Request,
  env: Env,
  db: Database,
  id: string,
): Promise<Response> {
  const denied = await installAuth(request, env);
  if (denied) return denied;
  const key = idempotencyKey(request);
  if (!key) return error(400, "invalid_idempotency_key");
  if (!text(id, uuid) || !object(await body(request), []))
    return error(400, "invalid_request");
  const requestHash = await sha256(
    `POST /v1/environment-admission-permits/${id}/revoke\n{}`,
  );
  const prior = await readPermitRequest(db, key);
  if (prior) return permitReplay(db, prior, requestHash, 200);
  const row = await readPermit(db, id);
  if (!row) return error(404, "not_found");
  if (row.consumed_at || row.revoked_at)
    return error(409, "admission_permit_unavailable");
  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          "UPDATE environment_admission_permits SET revoked_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL",
        )
        .bind(now, id),
      assertion(db, "changes()=1"),
      db
        .prepare(
          "INSERT INTO admission_permit_requests(idempotency_key,request_hash,action,permit_id,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(key, requestHash, "revoke", id, now),
      assertion(db, "changes()=1"),
    ]);
  } catch {
    const winner = await readPermitRequest(db, key);
    return winner
      ? permitReplay(db, winner, requestHash, 200)
      : error(409, "admission_permit_unavailable");
  }
  return json({ permit: publicPermit((await readPermit(db, id))!) });
}

async function replay(
  db: Database,
  organizationId: string,
  row: RequestRow,
  actor: Actor,
): Promise<Response> {
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${actorPredicate(actor)}`)
      .bind(...actorBindings(actor))
      .first())
  )
    return error(401, "unauthorized");
  const [environment, operation] = await Promise.all([
    db
      .prepare(
        `SELECT e.*,${deletionReadColumns} FROM environments e ${deletionReadJoins("e")} WHERE e.id = ? AND e.organization_id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(row.environment_id, organizationId, ...actorBindings(actor))
      .first<EnvironmentRow>(),
    db
      .prepare(
        `SELECT * FROM operations WHERE id = ? AND organization_id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(row.operation_id, organizationId, ...actorBindings(actor))
      .first<ExecutionRow>(),
  ]);
  if (!environment || !operation) return error(500, "state_inconsistent");
  return json(
    {
      environment: publicEnvironment(environment),
      operation: publicOperation(operation),
    },
    202,
  );
}

async function createEnvironment(
  request: Request,
  db: Database,
  organizationId: string,
  projectId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    "projects:write",
  );
  if (actor instanceof Response) return actor;
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key))
    return error(400, "invalid_idempotency_key");
  const value = await body(request);
  const input = environmentInput(value, ["admissionPermitId"]);
  if (
    !input ||
    !object(
      value,
      ["name", "regionId", "catalogVersion", "profileId", "volumeGiB"],
      ["admissionPermitId"],
    ) ||
    (Object.hasOwn(value, "admissionPermitId") &&
      !text(value.admissionPermitId, uuid))
  )
    return error(400, "invalid_request");
  const permitId = value.admissionPermitId as string | undefined;
  const requestHash = await sha256(
    `POST /v1/organizations/${organizationId}/projects/${projectId}/environments\n${JSON.stringify({ ...input, ...(permitId ? { admissionPermitId: permitId } : {}) })}`,
  );
  const existing = () =>
    db
      .prepare(
        `SELECT request_hash, environment_id, operation_id FROM environment_requests WHERE organization_id = ? AND idempotency_key = ? AND ${actorPredicate(actor)}`,
      )
      .bind(organizationId, key, ...actorBindings(actor))
      .first<RequestRow>();
  const previous = await existing();
  if (previous)
    return previous.request_hash === requestHash
      ? replay(db, organizationId, previous, actor)
      : error(409, "idempotency_conflict");
  const unavailable = async (code: string): Promise<Response> => {
    // An identical concurrent request may have committed since the first read.
    const winner = await existing();
    if (winner)
      return winner.request_hash === requestHash
        ? replay(db, organizationId, winner, actor)
        : error(409, "idempotency_conflict");
    if (
      !(await db
        .prepare(`SELECT 1 WHERE ${actorPredicate(actor)}`)
        .bind(...actorBindings(actor))
        .first())
    )
      return error(401, "unauthorized");
    return error(409, code);
  };
  const project = await db
    .prepare("SELECT status FROM projects WHERE id = ? AND organization_id = ?")
    .bind(projectId, organizationId)
    .first<{ status: string }>();
  if (!project) return error(404, "not_found");
  if (project.status !== "active") return error(409, "project_not_active");
  const currentAdmission = await admission(db, input.regionId);
  if (
    !permitId &&
    (!currentAdmission.acceptingNewEnvironments ||
      currentAdmission.catalogVersion !== input.catalogVersion)
  )
    return unavailable("region_admission_closed");
  const release = await catalog(db, input.regionId, input.catalogVersion);
  if (!release) return error(404, "not_found");
  const spec = resolveSpec(input, release);
  if (!spec) return error(400, "unsupported_profile");
  const serialized = JSON.stringify(spec);
  const specHash = await sha256(serialized);
  const initialRunEpoch =
    spec.profile.executionFencing === undefined ? null : "1";
  const environmentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const binding = permitBinding(input, release.catalog_hash);
  const permitPredicate =
    "EXISTS (SELECT 1 FROM environment_admission_permits q WHERE q.id=? AND q.organization_id=? AND q.project_id=? AND q.region_id=? AND q.catalog_version=? AND q.binding_json=? AND q.spec_hash=? AND q.issued_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND q.consumed_at IS NULL AND q.revoked_at IS NULL)";
  const permitBindings = [
    permitId ?? "",
    organizationId,
    projectId,
    input.regionId,
    input.catalogVersion,
    binding,
    specHash,
  ];
  const scopePredicate =
    "EXISTS (SELECT 1 FROM projects p JOIN regions g ON g.id=? JOIN region_catalogs c ON c.region_id=g.id AND c.version=? WHERE p.id=? AND p.organization_id=? AND p.status='active' AND g.status<>'disabled' AND c.catalog_hash=?)";
  const scopeBindings = [
    input.regionId,
    input.catalogVersion,
    projectId,
    organizationId,
    release.catalog_hash,
  ];
  const budgetPredicate =
    "NOT EXISTS (SELECT 1 FROM budget_targets b WHERE b.organization_id=? AND b.project_id=? AND b.environment_id IS NULL AND b.requested_state<>'running')";
  const budgetBindings = [organizationId, projectId];
  if (
    permitId &&
    !(await db
      .prepare(`SELECT 1 WHERE ${permitPredicate}`)
      .bind(...permitBindings)
      .first())
  )
    return unavailable("admission_permit_unavailable");
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${budgetPredicate}`)
      .bind(...budgetBindings)
      .first())
  )
    return unavailable("budget_paused");
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      assertion(db, scopePredicate, scopeBindings),
      assertion(db, budgetPredicate, budgetBindings),
      permitId
        ? assertion(db, permitPredicate, permitBindings)
        : assertion(
            db,
            "EXISTS (SELECT 1 FROM region_admission WHERE region_id=? AND catalog_version=? AND accepting_new_environments=1)",
            [input.regionId, input.catalogVersion],
          ),
      db
        .prepare(
          "INSERT INTO environments (id, organization_id, project_id, region_id, catalog_version, profile_id, name, status, spec_revision, spec_hash, resolved_spec, created_at, run_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)",
        )
        .bind(
          environmentId,
          organizationId,
          projectId,
          input.regionId,
          input.catalogVersion,
          input.profileId,
          input.name,
          specHash,
          serialized,
          now,
          initialRunEpoch,
        ),
      assertion(db, "changes()=1"),
      db
        .prepare(
          "INSERT INTO operations (id, organization_id, project_id, environment_id, region_id, kind, status, created_at) SELECT ?, organization_id, project_id, id, region_id, 'environment.create', 'queued', ? FROM environments WHERE id = ?",
        )
        .bind(operationId, now, environmentId),
      assertion(db, "changes()=1"),
      db
        .prepare(
          "INSERT INTO environment_requests (organization_id, idempotency_key, request_hash, project_id, environment_id, operation_id, created_at) SELECT organization_id, ?, ?, project_id, id, ?, ? FROM environments WHERE id = ?",
        )
        .bind(key, requestHash, operationId, now, environmentId),
      assertion(db, "changes()=1"),
      ...(permitId
        ? [
            db
              .prepare(
                "UPDATE environment_admission_permits SET consumed_environment_id=?,consumed_operation_id=?,consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND issued_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
              )
              .bind(environmentId, operationId, permitId),
            assertion(db, "changes()=1"),
          ]
        : []),
    ]);
  } catch {
    if (
      !(await db
        .prepare(`SELECT 1 WHERE ${actorPredicate(actor)}`)
        .bind(...actorBindings(actor))
        .first())
    )
      return error(401, "unauthorized");
    const winner = await existing();
    if (!winner) {
      if (
        permitId &&
        !(await db
          .prepare(`SELECT 1 WHERE ${permitPredicate}`)
          .bind(...permitBindings)
          .first())
      )
        return error(409, "admission_permit_unavailable");
      if (
        !(await db
          .prepare(`SELECT 1 WHERE ${budgetPredicate}`)
          .bind(...budgetBindings)
          .first())
      )
        return error(409, "budget_paused");
      if (
        !(await db
          .prepare(`SELECT 1 WHERE ${scopePredicate}`)
          .bind(...scopeBindings)
          .first())
      )
        return error(409, "permit_scope_unavailable");
      if (
        !permitId &&
        !(await db
          .prepare(
            "SELECT 1 FROM region_admission WHERE region_id=? AND catalog_version=? AND accepting_new_environments=1",
          )
          .bind(input.regionId, input.catalogVersion)
          .first())
      )
        return error(409, "region_admission_closed");
      return error(500, "write_failed");
    }
    return winner.request_hash === requestHash
      ? replay(db, organizationId, winner, actor)
      : error(409, "idempotency_conflict");
  }
  return replay(
    db,
    organizationId,
    {
      request_hash: requestHash,
      environment_id: environmentId,
      operation_id: operationId,
    },
    actor,
  );
}

async function readEnvironment(
  request: Request,
  db: Database,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Response> {
  const denied = await scopedAuth(
    request,
    db,
    organizationId,
    "organization",
    "projects:read",
  );
  if (denied) return denied;
  const row = await db
    .prepare(
      `SELECT e.*,${deletionReadColumns} FROM environments e ${deletionReadJoins("e")} WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ?`,
    )
    .bind(environmentId, organizationId, projectId)
    .first<EnvironmentRow>();
  return row
    ? json({ environment: publicEnvironment(row) })
    : error(404, "not_found");
}

function leaseToken(): string {
  return (
    "cplease_" +
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );
}

async function claimOperation(
  request: Request,
  db: Database,
  regionId: string,
): Promise<Response> {
  const denied = await scopedAuth(
    request,
    db,
    regionId,
    "region",
    "operations:claim",
  );
  if (denied) return denied;
  const input = await body(request);
  if (!object(input, ["leaseSeconds"]) || !integer(input.leaseSeconds, 30, 300))
    return error(400, "invalid_request");
  const token = leaseToken();
  const hash = await sha256(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  let written: D1Result<ExecutionRow>[];
  try {
    written = await db.batch<ExecutionRow>([
      db
        .prepare(
          `UPDATE operations SET status = 'running', lease_token_hash = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?
          WHERE id = (SELECT candidate.id FROM operations candidate JOIN environments e ON e.id=candidate.environment_id
            WHERE candidate.region_id = ? AND candidate.kind = 'environment.create'
            AND (candidate.status = 'queued' OR (candidate.status = 'running' AND candidate.lease_expires_at <= ?))
            AND ${environmentNotDeleting("e")} ORDER BY candidate.created_at, candidate.id LIMIT 1)
          AND region_id = ? AND kind = 'environment.create' AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))
          AND EXISTS (SELECT 1 FROM environments e WHERE e.id=operations.environment_id AND ${environmentNotDeleting("e")}) RETURNING *`,
        )
        .bind(hash, expiresAt, regionId, now, regionId, now),
      assertion(
        db,
        `NOT EXISTS (SELECT 1 FROM operations o WHERE o.lease_token_hash=? AND o.region_id=? AND o.status='running'
          AND NOT EXISTS (SELECT 1 FROM environments e WHERE e.id=o.environment_id AND ${environmentNotDeleting("e")}))`,
        [hash, regionId],
      ),
      db
        .prepare(
          `UPDATE environments AS e SET status = 'provisioning'
          WHERE e.id IN (SELECT environment_id FROM operations WHERE lease_token_hash = ? AND region_id = ? AND status = 'running')
          AND ${environmentNotDeleting("e")}`,
        )
        .bind(hash, regionId),
    ]);
  } catch {
    return error(409, "lease_conflict");
  }
  const operation = written[0]!.results[0];
  if (!operation) return json({ claim: null });
  const environment = await db
    .prepare(
      `SELECT e.* FROM environments e JOIN operations o ON o.environment_id=e.id
      WHERE e.id=? AND o.id=? AND o.region_id=? AND o.status='running' AND o.lease_token_hash=? AND o.lease_epoch=?
      AND o.lease_expires_at=? AND ${environmentNotDeleting("e")}`,
    )
    .bind(
      operation.environment_id,
      operation.id,
      regionId,
      hash,
      operation.lease_epoch,
      expiresAt,
    )
    .first<EnvironmentRow>();
  if (!environment) return error(409, "lease_conflict");
  return json({
    claim: {
      operationId: operation.id,
      environmentId: environment.id,
      regionId,
      kind: operation.kind,
      leaseToken: token,
      leaseEpoch: operation.lease_epoch,
      leaseExpiresAt: expiresAt,
      specRevision: environment.spec_revision,
      specHash: environment.spec_hash,
      spec: JSON.parse(environment.resolved_spec) as ResolvedSpec,
      ...(environment.run_epoch === null
        ? {}
        : { runEpoch: environment.run_epoch }),
    },
  });
}

function validLease(input: JsonObject): boolean {
  return (
    text(input.leaseToken, /^cplease_[A-Za-z0-9_-]{43}$/) &&
    integer(input.leaseEpoch, 1, Number.MAX_SAFE_INTEGER)
  );
}

async function renewOperation(
  request: Request,
  db: Database,
  regionId: string,
  operationId: string,
): Promise<Response> {
  const denied = await scopedAuth(
    request,
    db,
    regionId,
    "region",
    "operations:claim",
  );
  if (denied) return denied;
  const input = await body(request);
  if (
    !object(input, ["leaseToken", "leaseEpoch", "leaseSeconds"]) ||
    !validLease(input) ||
    !integer(input.leaseSeconds, 30, 300)
  )
    return error(400, "invalid_request");
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  const leaseHash = await sha256(input.leaseToken as string);
  let updated: unknown;
  try {
    const written = await db.batch([
      assertion(
        db,
        `EXISTS (SELECT 1 FROM operations o JOIN environments e ON e.id=o.environment_id
        WHERE o.id=? AND o.region_id=? AND o.kind='environment.create' AND o.status='running'
        AND o.lease_token_hash=? AND o.lease_epoch=? AND o.lease_expires_at>? AND ${environmentNotDeleting("e")})`,
        [operationId, regionId, leaseHash, input.leaseEpoch as number, now],
      ),
      db
        .prepare(
          `UPDATE operations SET lease_expires_at = ? WHERE id = ? AND region_id = ? AND kind = 'environment.create'
          AND status = 'running' AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ?
          AND EXISTS (SELECT 1 FROM environments e WHERE e.id=operations.environment_id AND ${environmentNotDeleting("e")}) RETURNING id`,
        )
        .bind(
          expiresAt,
          operationId,
          regionId,
          leaseHash,
          input.leaseEpoch,
          now,
        ),
      assertion(db, "changes()=1"),
    ]);
    updated = written[1]!.results[0];
  } catch {
    return error(409, "lease_conflict");
  }
  if (updated)
    updated = await db
      .prepare(
        `SELECT o.id FROM operations o JOIN environments e ON e.id=o.environment_id
        WHERE o.id=? AND o.region_id=? AND o.kind='environment.create' AND o.status='running'
        AND o.lease_token_hash=? AND o.lease_epoch=? AND o.lease_expires_at=? AND ${environmentNotDeleting("e")}`,
      )
      .bind(operationId, regionId, leaseHash, input.leaseEpoch, expiresAt)
      .first();
  return updated
    ? json({ leaseExpiresAt: expiresAt })
    : error(409, "lease_conflict");
}

async function reportResult(
  request: Request,
  db: Database,
  regionId: string,
  operationId: string,
): Promise<Response> {
  const denied = await scopedAuth(
    request,
    db,
    regionId,
    "region",
    "operations:report",
  );
  if (denied) return denied;
  const input = await body(request, 16_384);
  if (
    !object(input, [
      "leaseToken",
      "leaseEpoch",
      "status",
      "resultCode",
      "observation",
    ]) ||
    !validLease(input)
  )
    return error(400, "invalid_request");
  const reportedPooling =
    typeof input.observation === "object" &&
    input.observation !== null &&
    Object.hasOwn(input.observation, "pooler");
  const reportedNodeTracking =
    typeof input.observation === "object" &&
    input.observation !== null &&
    Object.hasOwn(input.observation, "nodeCohort");
  const reportedNative =
    typeof input.observation === "object" &&
    input.observation !== null &&
    Object.hasOwn(input.observation, "nativeConnection");
  const reportedRunEpoch =
    typeof input.observation === "object" &&
    input.observation !== null &&
    typeof (input.observation as JsonObject).runEpoch === "string"
      ? ((input.observation as JsonObject).runEpoch as string)
      : undefined;
  const ready =
    input.status === "ready" &&
    input.resultCode === "cnpg_ready" &&
    validEnvironmentObservation(
      input.observation,
      reportedPooling,
      reportedRunEpoch,
      reportedNodeTracking,
      reportedNative,
    );
  const failed =
    input.status === "failed" &&
    ["ownership_mismatch", "spec_conflict", "reconcile_failed"].includes(
      input.resultCode as string,
    ) &&
    input.observation === null;
  if (!ready && !failed) return error(400, "invalid_request");
  const environment = await db
    .prepare(
      "SELECT e.* FROM environments AS e JOIN operations AS o ON o.environment_id = e.id WHERE o.id = ? AND o.region_id = ?",
    )
    .bind(operationId, regionId)
    .first<EnvironmentRow>();
  if (!environment) return error(409, "lease_conflict");
  const profile = (JSON.parse(environment.resolved_spec) as ResolvedSpec)
    .profile;
  if (
    ready &&
    (!validEnvironmentObservation(
      input.observation,
      profile.pooling !== undefined,
      environment.run_epoch ?? undefined,
      profile.nodeTracking !== undefined,
      profile.nativeAccess !== undefined,
    ) ||
      (input.observation as EnvironmentObservation).readyInstances <
        profile.instances)
  )
    return error(400, "invalid_observation");
  if (ready && profile.nativeAccess !== undefined) {
    const native = (input.observation as EnvironmentObservation)
      .nativeConnection;
    if (
      !boundNativeConnection(
        native,
        environment,
        profile,
        input.observation as EnvironmentObservation,
      ) ||
      Date.parse(native.observedAt) > Date.now() ||
      (await sha256(native.caCertificate)) !== native.caCertificateSha256
    )
      return error(400, "invalid_observation");
  }
  const observation = ready
    ? {
        clusterUid: (input.observation as JsonObject).clusterUid,
        clusterGeneration: (input.observation as JsonObject).clusterGeneration,
        readyInstances: (input.observation as JsonObject).readyInstances,
        ...(reportedNative
          ? {
              nativeConnection: (input.observation as EnvironmentObservation)
                .nativeConnection,
            }
          : {}),
        ...(reportedPooling
          ? {
              pooler: {
                uid: (input.observation as EnvironmentObservation).pooler!.uid,
                generation: (input.observation as EnvironmentObservation)
                  .pooler!.generation,
                deploymentUid: (input.observation as EnvironmentObservation)
                  .pooler!.deploymentUid,
                readyInstances: 1,
              },
            }
          : {}),
        ...(profile.nodeTracking === undefined
          ? {}
          : {
              nodeCohort: {
                uid: (input.observation as EnvironmentObservation).nodeCohort!
                  .uid,
                hash: (input.observation as EnvironmentObservation).nodeCohort!
                  .hash,
              },
            }),
        ...(environment.run_epoch === null
          ? {}
          : { runEpoch: environment.run_epoch }),
      }
    : null;
  const resultHash = await sha256(
    JSON.stringify({
      status: input.status,
      resultCode: input.resultCode,
      observation,
    }),
  );
  const leaseHash = await sha256(input.leaseToken as string);
  const now = new Date().toISOString();
  const terminalResult = () =>
    db
      .prepare(
        "SELECT * FROM operations WHERE id = ? AND region_id = ? AND kind='environment.create' AND lease_token_hash = ? AND lease_epoch = ? AND result_hash = ? AND status IN ('succeeded', 'failed')",
      )
      .bind(operationId, regionId, leaseHash, input.leaseEpoch, resultHash)
      .first<ExecutionRow>();
  // Exact terminal replay is historical recovery, not a fresh publication or
  // authority to rewrite the environment after its deletion was accepted.
  let operation = await terminalResult();
  if (!operation) {
    try {
      await db.batch([
        assertion(
          db,
          `EXISTS (SELECT 1 FROM operations o JOIN environments e ON e.id=o.environment_id
          WHERE o.id=? AND o.region_id=? AND o.kind='environment.create' AND o.status='running'
          AND o.lease_token_hash=? AND o.lease_epoch=? AND o.lease_expires_at>? AND ${environmentNotDeleting("e")})`,
          [operationId, regionId, leaseHash, input.leaseEpoch as number, now],
        ),
        db
          .prepare(
            `UPDATE operations SET status = ?, observed_at = ?, result_code = ?, result_hash = ?, observation_json = ?
            WHERE id = ? AND region_id = ? AND kind = 'environment.create' AND status = 'running'
            AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ?
            AND EXISTS (SELECT 1 FROM environments e WHERE e.id=operations.environment_id AND ${environmentNotDeleting("e")})`,
          )
          .bind(
            ready ? "succeeded" : "failed",
            now,
            input.resultCode,
            resultHash,
            JSON.stringify(observation),
            operationId,
            regionId,
            leaseHash,
            input.leaseEpoch,
            now,
          ),
        assertion(db, "changes()=1"),
        db
          .prepare(
            `UPDATE environments AS e SET status = ?, observed_at = (SELECT observed_at FROM operations WHERE id = ?),
            observation_json = (SELECT observation_json FROM operations WHERE id = ?) WHERE e.id = ?
            AND ${environmentNotDeleting("e")} AND EXISTS (SELECT 1 FROM operations WHERE id = ? AND region_id = ?
            AND lease_token_hash = ? AND lease_epoch = ? AND result_hash = ? AND status IN ('succeeded', 'failed'))`,
          )
          .bind(
            input.status,
            operationId,
            operationId,
            environment.id,
            operationId,
            regionId,
            leaseHash,
            input.leaseEpoch,
            resultHash,
          ),
        assertion(db, "changes()=1"),
      ]);
    } catch {
      // A concurrent identical terminal publication may already be durable.
      // Read its exact historical identity; never retry the effect batch.
    }
    operation = await terminalResult();
  }
  if (!operation) return error(409, "lease_conflict");
  const observedEnvironment = await db
    .prepare(
      `SELECT e.*,${deletionReadColumns} FROM environments e ${deletionReadJoins("e")} WHERE e.id = ?`,
    )
    .bind(environment.id)
    .first<EnvironmentRow>();
  if (!observedEnvironment) return error(500, "state_inconsistent");
  return json({
    operation: publicOperation(operation),
    environment: publicEnvironment(observedEnvironment),
  });
}

export async function environmentRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const db = env.DB.withSession("first-primary");
  if (
    pathname === "/v1/environment-admission-permits" &&
    request.method === "POST"
  )
    return issueAdmissionPermit(request, env, db);
  const permitPath =
    /^\/v1\/environment-admission-permits\/([^/]+)(\/revoke)?$/.exec(pathname);
  if (permitPath && request.method === "POST" && permitPath[2])
    return revokeAdmissionPermit(request, env, db, permitPath[1]!);
  if (permitPath && request.method === "GET" && !permitPath[2]) {
    const denied = await installAuth(request, env);
    if (denied) return denied;
    const row = await readPermit(db, permitPath[1]!);
    return row ? json({ permit: publicPermit(row) }) : error(404, "not_found");
  }
  const catalogs = /^\/v1\/regions\/([^/]+)\/catalogs$/.exec(pathname);
  if (request.method === "POST" && catalogs)
    return publishCatalog(request, env, db, catalogs[1]!);
  const admissionPath = /^\/v1\/regions\/([^/]+)\/admission$/.exec(pathname);
  if (request.method === "PUT" && admissionPath)
    return setAdmission(request, env, db, admissionPath[1]!);
  if (request.method === "GET" && admissionPath) {
    const denied = await installAuth(request, env);
    if (denied) return denied;
    if (
      !(await db
        .prepare("SELECT id FROM regions WHERE id = ?")
        .bind(admissionPath[1]!)
        .first())
    )
      return error(404, "not_found");
    return json({ admission: await admission(db, admissionPath[1]!) });
  }
  const publicCatalogPath =
    /^\/v1\/organizations\/([^/]+)\/regions\/([^/]+)\/catalogs\/([^/]+)$/.exec(
      pathname,
    );
  if (request.method === "GET" && publicCatalogPath) {
    const denied = await scopedAuth(
      request,
      db,
      publicCatalogPath[1]!,
      "organization",
      "projects:read",
    );
    if (denied) return denied;
    const row = await catalog(db, publicCatalogPath[2]!, publicCatalogPath[3]!);
    if (!row) return error(404, "not_found");
    return json({
      catalog: {
        regionId: row.region_id,
        version: row.version,
        profiles: (JSON.parse(row.profiles_json) as Profile[]).map(
          publicProfile,
        ),
        catalogHash: row.catalog_hash,
        createdAt: row.created_at,
      },
      admission: await admission(db, row.region_id),
    });
  }
  const environments =
    /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments$/.exec(
      pathname,
    );
  if (request.method === "POST" && environments)
    return createEnvironment(request, db, environments[1]!, environments[2]!);
  const environment =
    /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)$/.exec(
      pathname,
    );
  if (request.method === "GET" && environment)
    return readEnvironment(
      request,
      db,
      environment[1]!,
      environment[2]!,
      environment[3]!,
    );
  const connections =
    /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/connections$/.exec(
      pathname,
    );
  if (request.method === "GET" && connections)
    return readNativeConnection(
      request,
      db,
      connections[1]!,
      connections[2]!,
      connections[3]!,
    );
  const claim = /^\/v1\/regions\/([^/]+)\/operations\/claim$/.exec(pathname);
  if (request.method === "POST" && claim)
    return claimOperation(request, db, claim[1]!);
  const renewal = /^\/v1\/regions\/([^/]+)\/operations\/([^/]+)\/renew$/.exec(
    pathname,
  );
  if (request.method === "POST" && renewal)
    return renewOperation(request, db, renewal[1]!, renewal[2]!);
  const result = /^\/v1\/regions\/([^/]+)\/operations\/([^/]+)\/result$/.exec(
    pathname,
  );
  if (request.method === "POST" && result)
    return reportResult(request, db, result[1]!, result[2]!);
  return null;
}
