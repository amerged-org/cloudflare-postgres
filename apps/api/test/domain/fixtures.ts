// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  ErrorBody,
  NodeDesiredPage,
  hashApiKey,
  newApiKey,
  newApiKeyId,
  newNodeId,
  newProjectId,
  nodePublicKey,
  nodeRequestClaims,
  randomString,
  signNodeRequest,
  type NodeKey,
} from "@pgcf/contracts";
import { expect } from "vitest";
import { createApp } from "../../src/app.ts";

const fixtures: {
  projects: string[];
  regions: string[];
  keyIds: string[];
  size: string;
}[] = [];
export async function cleanupFixtures(): Promise<void> {
  for (const fixture of fixtures.splice(0)) {
    const [project, other] = fixture.projects;
    const [region, foreign] = fixture.regions;
    const databaseScope =
      "database_id IN(SELECT id FROM databases WHERE project_id IN(?,?))";
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_provider_mutations WHERE operation_id IN(SELECT operation_id FROM node_additions WHERE region_id IN(?,?))",
      ).bind(region, foreign),
      env.DB.prepare("DELETE FROM node_additions WHERE region_id IN(?,?)").bind(
        region,
        foreign,
      ),
      env.DB.prepare(
        "DELETE FROM node_region_policies WHERE region_id IN(?,?)",
      ).bind(region, foreign),
      env.DB.prepare(`DELETE FROM role_deletions WHERE ${databaseScope}`).bind(
        project,
        other,
      ),
      env.DB.prepare(`DELETE FROM operations WHERE ${databaseScope}`).bind(
        project,
        other,
      ),
      env.DB.prepare(`DELETE FROM roles WHERE ${databaseScope}`).bind(
        project,
        other,
      ),
      env.DB.prepare(
        `DELETE FROM lifecycle_events WHERE ${databaseScope}`,
      ).bind(project, other),
      env.DB.prepare("DELETE FROM databases WHERE project_id IN(?,?)").bind(
        project,
        other,
      ),
      env.DB.prepare(
        "DELETE FROM idempotency_keys WHERE api_key_id IN(?,?,?)",
      ).bind(...fixture.keyIds),
      env.DB.prepare("DELETE FROM api_keys WHERE id IN(?,?,?)").bind(
        ...fixture.keyIds,
      ),
      env.DB.prepare("DELETE FROM projects WHERE id IN(?,?)").bind(
        project,
        other,
      ),
      env.DB.prepare("DELETE FROM nodes WHERE region_id IN(?,?)").bind(
        region,
        foreign,
      ),
      env.DB.prepare("DELETE FROM regions WHERE id IN(?,?)").bind(
        region,
        foreign,
      ),
      env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(fixture.size),
    ]);
  }
}

/** The database mutations that refuse a request without an Idempotency-Key, as `METHOD path`. */
const KEYED_DATABASE_MUTATION =
  /^(?:(?:POST|PATCH|DELETE) \/v1\/databases(?:\/[a-z][a-z0-9]{19}(?:\/(?:suspend|resume|restore))?)?|PUT \/v1\/databases\/[a-z][a-z0-9]{19}\/(?:resource-profile|idle-time))$/;
export async function request(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
  /** A string is sent as is; `null` sends none; omitted sends a fresh key where one is required. */
  idempotency?: string | null,
  extraHeaders?: HeadersInit,
): Promise<Response> {
  const context = createExecutionContext();
  const headers = new Headers(extraHeaders);
  headers.set("Authorization", `Bearer ${key}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (idempotency) headers.set("Idempotency-Key", idempotency);
  else if (
    idempotency === undefined &&
    KEYED_DATABASE_MUTATION.test(`${method} ${path.split("?")[0]}`)
  )
    headers.set("Idempotency-Key", crypto.randomUUID());
  const response = await createApp().fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, DB_ENDPOINT_HOST: ["db", "invalid"].join(".") },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
/** What a refusal tells a client: its code, the stable reason and the advised delay. */
export async function refusal(response: Response) {
  const { error } = ErrorBody.parse(await response.json());
  return {
    status: response.status,
    code: error.code,
    reason: error.details?.reason ?? null,
    retryAfter: response.headers.get("Retry-After"),
  };
}
/** A node's Ed25519 key, as the installer's enrollment leaves it. */
export async function nodeKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey as NodeKey,
    publicKey: await nodePublicKey(pair.publicKey as NodeKey),
  };
}
export async function fixture(memory = 4096, storage: number | null = 30) {
  const key = await nodeKeyPair(),
    nodeUid = crypto.randomUUID();
  const now = new Date().toISOString(),
    project = newProjectId(),
    other = newProjectId(),
    region = "eu-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8),
    foreign = "us-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8),
    node = newNodeId();
  const admin = newApiKey().key,
    integrator = newApiKey().key,
    otherKey = newApiKey().key;
  const size = "s" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8),
    nodeName =
      "node-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8);
  const statements = [
    env.DB.prepare(
      "INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)",
    ).bind(project, "one", now, now),
    env.DB.prepare(
      "INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)",
    ).bind(other, "two", now, now),
    env.DB.prepare(
      `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at) VALUES (?,512,500,5,50,NULL,60,7,1,?,?)`,
    ).bind(size, now, now),
  ];
  for (const id of [region, foreign])
    statements.push(
      env.DB.prepare(
        "INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        "contabo",
        "test",
        `https://${["gateway", "invalid"].join(".")}`,
        env.ARCHIVE_BUCKET_NAME,
        `https://${["archive", "invalid"].join(".")}`,
        now,
        now,
      ),
    );
  const keyIds: string[] = [];
  for (const [key, scope, projectId] of [
    [admin, "admin", null],
    [integrator, "integrator", project],
    [otherKey, "integrator", other],
  ]) {
    const keyId = newApiKeyId();
    keyIds.push(keyId);
    statements.push(
      env.DB.prepare(
        "INSERT INTO api_keys(id,lookup_id,key_hash,scope,project_id,name,created_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(
        keyId,
        key!.split("_")[2]!,
        await hashApiKey(env.API_KEY_PEPPER, key!),
        scope,
        projectId,
        "test",
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,public_key,enrolled_at) VALUES (?,?,?,1,?,2000,?,128,100,?,?,?,?,?,?)",
    ).bind(
      node,
      region,
      nodeName,
      memory,
      storage,
      now,
      now,
      now,
      nodeUid,
      key.publicKey,
      now,
    ),
  );
  await env.DB.batch(statements);
  fixtures.push({
    projects: [project, other],
    regions: [region, foreign],
    keyIds,
    size,
  });
  const create = (name = "database", key = integrator, idempotency?: string) =>
    request(
      "/v1/databases",
      key,
      "POST",
      { project_id: project, region_id: region, name, size_class_id: size },
      idempotency,
    );
  return {
    project,
    other,
    region,
    foreign,
    node,
    nodeName,
    size,
    admin,
    integrator,
    otherKey,
    create,
    nodeUid,
    nodeKey: key.privateKey,
    nodePublicKey: key.publicKey,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type NodeFixture = Pick<Fixture, "node" | "nodeUid" | "nodeKey">;

/** The bearer token a node signs for a request: its method, path with the query and body bytes. */
export async function nodeToken(
  f: NodeFixture,
  path: string,
  method: string,
  body: Uint8Array = new Uint8Array(),
  init: { now?: number; key?: NodeKey; node?: string; uid?: string } = {},
): Promise<string> {
  return signNodeRequest(
    init.key ?? f.nodeKey,
    await nodeRequestClaims({
      node: init.node ?? f.node,
      uid: init.uid ?? f.nodeUid,
      method: method as "GET" | "POST" | "PUT",
      path,
      body,
      now: init.now,
    }),
  );
}
/**
 * A request the API receives exactly as given; the test signs, or does not. The work it leaves in
 * the execution context is awaited, unless the test brings its own context and awaits it.
 */
export async function rawRequest(
  path: string,
  init: RequestInit = {},
  own?: ExecutionContext,
): Promise<Response> {
  const context = own ?? createExecutionContext();
  const response = await createApp().fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), init),
    { ...env, DB_ENDPOINT_HOST: ["db", "invalid"].join(".") },
    context,
  );
  if (!own) await waitOnExecutionContext(context);
  return response;
}
/**
 * A request signed with the node's key (plan 8): its method, its path with the query and the
 * bytes of its body are what the signature covers.
 */
export async function nodeRequest(
  f: NodeFixture,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
    now?: number;
    key?: NodeKey;
    node?: string;
    uid?: string;
    context?: ExecutionContext;
  } = {},
): Promise<Response> {
  const method = init.method ?? "GET",
    body =
      init.body === undefined
        ? undefined
        : new TextEncoder().encode(JSON.stringify(init.body)),
    headers = new Headers(init.headers);
  headers.set(
    "Authorization",
    `Bearer ${await nodeToken(f, path, method, body, init)}`,
  );
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return rawRequest(
    path,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    },
    init.context,
  );
}

/** The generation's own operation: what the node's page names and its report echoes. */
export async function operationOf(id: string, generation: number) {
  const row = await env.DB.prepare(
    "SELECT id FROM operations WHERE database_id=? AND generation<=? ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1",
  )
    .bind(id, generation)
    .first<{ id: string }>();
  if (!row) throw new Error("operation_fixture_missing");
  return row.id;
}
const instances = new Map<string, string>();
/** The unit a database runs on in the tests: one invocation ID for as long as the test runs. */
export function instanceOf(id: string): string {
  let instance = instances.get(id);
  if (instance === undefined) {
    instance = crypto.randomUUID();
    instances.set(id, instance);
  }
  return instance;
}
export const PROVEN_SLEEP = {
  system_identifier: "7428512345678901234",
  timeline: 1,
  checkpoint_lsn: "0/3000028",
  last_archived_segment: "000000010000000000000002",
};
/** What a node reports of a database in `state` at `generation`; `extra` replaces any field. */
export async function observationOf(
  id: string,
  generation: number,
  state = "ready",
  extra: Record<string, unknown> = {},
) {
  const row = await env.DB.prepare(
    "SELECT storage_generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ storage_generation: number }>();
  const now = new Date().toISOString();
  return {
    id,
    generation,
    operation: await operationOf(id, generation),
    storage_generation: row?.storage_generation ?? 1,
    state,
    ...(state === "ready" ? { instance: instanceOf(id) } : {}),
    proven_sleep:
      state === "asleep" ? { ...PROVEN_SLEEP, proven_at: now } : null,
    // A ready database has the DONE base backup of its storage generation.
    backup:
      state === "ready"
        ? { backup_id: "20261017T110000", timeline: 1, completed_at: now }
        : null,
    archive: { last_segment: null, ready_files: 0, failing_since: null },
    ...extra,
  };
}
/** The body of a node's observation report. */
export const reportBody = (
  databases: unknown[],
  orders: unknown[] = [],
  observedAt = new Date().toISOString(),
) => ({ observed_at: observedAt, databases, orders });
/** A node reports one database; the answer is the API's. */
export async function report(
  f: NodeFixture,
  id: string,
  generation: number,
  state = "ready",
  extra: Record<string, unknown> = {},
) {
  return nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: reportBody([await observationOf(id, generation, state, extra)]),
  });
}
/** What the API answers one reported database with. */
export const verdicts = async (response: Response) =>
  (
    (await response.json()) as { databases: { verdict: string }[] }
  ).databases.map((database) => database.verdict);

/** A valid sample of a node (plan 4.9), taken at `at`. */
export function nodeSample(
  at = Date.now(),
  extra: Record<string, unknown> = {},
) {
  const observed_at = new Date(at).toISOString();
  return {
    observed_at,
    memory: { total_bytes: 12 * 1024 ** 3, available_bytes: 9 * 1024 ** 3 },
    cpu: { cores: 6, busy_millicores: 1200 },
    pool: {
      observed_at,
      data_total_bytes: 125 * 1024 ** 3,
      data_used_bytes: 40 * 1024 ** 3,
      metadata_total_bytes: 1024 ** 3,
      metadata_used_bytes: 1024 ** 2,
      nominal_bytes: 300 * 1024 ** 3,
    },
    room: true,
    volumes: { total: 3, mounted: 3 },
    archive: { ready_files: 0, oldest_ready_seconds: null },
    awake: [],
    awake_memory_mib: 0,
    starting: 0,
    queued: 0,
    credentials_revision: 1,
    ...extra,
  };
}

/** The rules a region's nodes decide by when they act alone (plan 4.3-4.7). */
export const nodePolicy = () => ({
  admission: {
    memory_rule: "measured",
    memory_floor_mib: 600,
    awake_budget_mib: 9913,
    reservation_overhead_mib: 8,
    start_concurrency: 4,
    queue_wait_ms: 10_000,
    retry_after_seconds: 5,
  },
  early_sleep: { enabled: true, min_idle_seconds: 30 },
  storage: {
    reserve_bytes: 6 * 1024 ** 3,
    metadata_no_room_percent: 75,
    sample_max_age_seconds: 10,
  },
  backup: {
    wal_uploads: 2,
    base_backups: 1,
    memory_mib: { wal_upload: 128, wal_fetch: 128, base_backup: 256 },
  },
  io: { write_bytes_per_second: 16 * 1024 ** 2, write_iops: 1000 },
});
/** Sets the node policy of the fixture's region, through the administrator route. */
export async function setNodePolicy(f: Pick<Fixture, "region" | "admin">) {
  const response = await request(
    `/v1/regions/${f.region}/node-policy`,
    f.admin,
    "PUT",
    nodePolicy(),
  );
  if (response.status !== 200) throw new Error("node_policy_fixture_failed");
}
/**
 * The desired page a node pulls. It needs what the operator and the credential issuer provide
 * before a node can pull it: the region's node policy and, for each database, the reference of its
 * archive credential.
 */
export async function desiredPage(
  f: Pick<Fixture, "region" | "admin" | "node" | "nodeUid" | "nodeKey">,
  query = "",
) {
  await setNodePolicy(f);
  const lacking = await env.DB.prepare(
    `SELECT d.id FROM databases d WHERE d.node_id=? AND d.desired_state IN('running','suspended','deleted')
       AND NOT EXISTS(SELECT 1 FROM database_archive_credentials c WHERE c.database_id=d.id
         AND c.archive_path=d.archive_path AND c.access='read_write'
         AND (d.desired_state='deleted' OR c.expires_at>?))`,
  )
    .bind(f.node, new Date().toISOString())
    .all<{ id: string }>();
  for (const { id } of lacking.results) await grantCredential(id);
  const response = await nodeRequest(f, `/node/v1/desired${query}`);
  if (response.status !== 200) throw new Error("desired_page_fixture_failed");
  return NodeDesiredPage.parse(await response.json());
}
/**
 * The reference of a temporary credential, as the credential issuer leaves it: `database` holds
 * it for `path` (its own archive by default) for `lifetimeMs`.
 */
export async function grantCredential(
  database: string,
  options: {
    path?: string;
    access?: "read_write" | "read_only";
    lifetimeMs?: number;
  } = {},
) {
  const path =
    options.path ??
    (await env.DB.prepare("SELECT archive_path FROM databases WHERE id=?")
      .bind(database)
      .first<string>("archive_path"))!;
  const id = `crd_${randomString("abcdefghijklmnopqrstuvwxyz0123456789", 20)}`,
    now = Date.now();
  await env.DB.prepare(
    "INSERT INTO database_archive_credentials(id,database_id,archive_path,access,created_at,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      database,
      path,
      options.access ?? "read_write",
      new Date(now - 1000).toISOString(),
      new Date(now + (options.lifetimeMs ?? 7 * 86_400_000)).toISOString(),
    )
    .run();
  return {
    id,
    expires_at: new Date(
      now + (options.lifetimeMs ?? 7 * 86_400_000),
    ).toISOString(),
  };
}
/** A database created through the API on the fixture's node, with its credential and the region's policy. */
export async function served(f: Fixture, name = "database") {
  await setNodePolicy(f);
  const response = await f.create(name);
  if (response.status !== 202) throw new Error("database_fixture_failed");
  const created = (await response.json()) as {
    database: { id: string };
    operation: { id: string };
  };
  const credential = await grantCredential(created.database.id);
  return {
    id: created.database.id,
    operation: created.operation.id,
    credential,
  };
}

const pinned = (name: string) => ({
  url: `https://${["releases", "invalid"].join(".")}/${name}`,
  sha256: "a".repeat(64),
  size_bytes: 4096,
});
/** The spec of a release: a node image, its four binaries and the package lock. */
export const releaseSpec = (version = "1.2.0") => ({
  version: 2,
  image: {
    url: `https://${["releases", "invalid"].join(".")}/pgcf-node-${version}.raw.zst`,
    sha256: "b".repeat(64),
    format: "raw.zst",
    size_bytes: 1_500_000_000,
    raw_sha256: "c".repeat(64),
    raw_bytes: 8_589_934_592,
  },
  binaries: {
    "pgcf-agent": pinned("pgcf-agent"),
    "pgcf-native-gateway": pinned("pgcf-native-gateway"),
    "pgcf-archive": pinned("pgcf-archive"),
    "pgcf-wal-fetch": pinned("pgcf-wal-fetch"),
  },
  os: {
    image_version: version,
    debian_snapshot: "20261015T000000Z",
    package_lock: pinned("packages.lock.json"),
  },
});
/** Approves a release and assigns it to the region. */
export async function assignRelease(
  f: Pick<Fixture, "region" | "admin">,
  id = `release-${randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8)}`,
  expectedRevision = 0,
) {
  expect(
    (await request(`/v1/fleet/releases/${id}`, f.admin, "PUT", releaseSpec()))
      .status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        expected_revision: expectedRevision,
        release_id: id,
      })
    ).status,
  ).toBe(200);
  return id;
}
