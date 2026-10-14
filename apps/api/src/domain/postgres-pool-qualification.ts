// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  thinStorageAuthorityMatches,
  thinStorageInventory,
  THIN_INVENTORY_MAX_SECONDS,
  hashApiKey,
} from "@pgcf/contracts";
import {
  FleetReleaseSpec,
  PostgresPoolQualification,
} from "@pgcf/contracts/releases";
import {
  PoolBindingScope,
  PoolNodeReport,
  PoolStorageObservation,
  PoolSupervisorReport,
  PoolIoAttestation,
  PoolSleepRecord,
} from "@pgcf/contracts/postgres-pool";
import {
  POSTGRES_POOL_QUALIFICATION_GATES,
  PostgresPoolQualificationScope,
  PostgresPoolQualificationReport,
  PostgresPoolQualificationChallenge,
  PostgresPoolQualificationEvidence,
  PostgresPoolQualificationRun,
  postgresPoolQualificationGatePassed,
  signPoolQualificationPermission,
  type PostgresPoolQualificationRequest,
  type PostgresPoolQualificationExecution,
  postgresPoolQualificationNonceHash,
} from "@pgcf/contracts/postgres-pool-qualification";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  withIdempotency,
  type IdempotencyLease,
} from "../middleware/idempotency.ts";
import { agentRegion } from "./agent-auth.ts";
import {
  canonicalInstallation,
  installationHash,
} from "./node-installation.ts";
import { readPostgresPoolDatabaseContext } from "./postgres-pool-context.ts";
import { hint } from "./databases.ts";
import { nodeProofSigningKey } from "./node-proof-session.ts";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
import { readPostgresPoolQualificationSetup } from "./postgres-pool-qualification-authority.ts";
import { readPostgresPoolFleetFence } from "./postgres-pool-fleet-fence.ts";
import { readPostgresPoolQualificationPreparation } from "./postgres-pool-qualification-preparation.ts";
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import {
  qualifiedThinStorageSql,
  readCurrentNodeThinStorage,
} from "./node-thin-storage.ts";

const RUN_MS = 60 * 60_000;
const CHALLENGE_MS = 10 * 60_000;
const SKEW_MS = 5_000;
const Journal = z.strictObject({
  version: z.literal(1),
  pending: PostgresPoolQualificationChallenge.nullable(),
  entries: z.array(PostgresPoolQualificationEvidence).max(10),
});
interface Row {
  id: string;
  region_id: string;
  node_id: string;
  node_uid: string;
  boot_id: string;
  database_id: string;
  database_generation: number;
  candidate_release_id: string;
  candidate_spec_sha256: string;
  scope_sha256: string;
  scope_json: string;
  status: "running" | "cleanup" | "completed" | "failed";
  evidence_json: string;
  cleanup_json: string | null;
  error_code: string | null;
  receipt_sha256: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  completed_at: number | null;
}
function conflict(
  message = "PostgreSQL pool qualification scope changed",
): never {
  throw new ApiError("conflict", message);
}
function scopeChanged(): never {
  const error = new ApiError(
    "conflict",
    "PostgreSQL pool qualification scope changed",
  );
  error.name = "PostgresPoolQualificationScopeChanged";
  throw error;
}
const equal = (a: unknown, b: unknown) =>
  canonicalInstallation(a) === canonicalInstallation(b);
const fresh = (at: number, now: number) =>
  at <= now + SKEW_MS && at >= now - 60_000;
function journal(row: Row) {
  return Journal.parse(JSON.parse(row.evidence_json));
}
function scope(row: Row) {
  return PostgresPoolQualificationScope.parse(JSON.parse(row.scope_json));
}
function originalExecution(
  s: PostgresPoolQualificationScope,
  e: PostgresPoolQualificationExecution,
) {
  return (
    e.node_uid === s.node_uid &&
    e.boot_id === s.boot_id &&
    e.candidate_release_id === s.candidate_release_id &&
    e.candidate_spec_sha256 === s.candidate_spec_sha256 &&
    e.driver_image === s.software.driver_image &&
    e.driver_sha256 === s.software.driver_sha256 &&
    e.host_extension_image === s.software.host_extension_image &&
    e.host_controller_sha256 === s.software.host_controller_sha256 &&
    e.kernel_version === s.software.kernel_version
  );
}
async function view(env: Env, row: Row) {
  const receipt = row.receipt_sha256
    ? await env.DB.prepare(
        "SELECT qualification_json FROM postgres_pool_qualification_receipts WHERE receipt_sha256=? AND run_id=? AND scope_sha256=?",
      )
        .bind(row.receipt_sha256, row.id, row.scope_sha256)
        .first<{ qualification_json: string }>()
    : null;
  if (row.status === "completed" && !receipt)
    throw new ApiError("internal", "Qualification receipt is unavailable");
  return PostgresPoolQualificationRun.parse({
    id: row.id,
    scope: scope(row),
    scope_sha256: row.scope_sha256,
    status: row.status,
    evidence: journal(row).entries,
    cleanup: row.cleanup_json ? JSON.parse(row.cleanup_json) : null,
    error_code: row.error_code,
    receipt_sha256: row.receipt_sha256,
    qualification: receipt ? JSON.parse(receipt.qualification_json) : null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    completed_at: row.completed_at,
  });
}
async function read(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM postgres_pool_qualification_runs WHERE id=?")
    .bind(z.uuid().parse(id))
    .first<Row>();
  if (!row)
    throw new ApiError("not_found", "PostgreSQL pool qualification not found");
  return row;
}
/** This predicate is also in every nonce/evidence CAS: a controller rollback cannot
 * continue using a nonce issued by the earlier candidate. No normal-pool receipt is implied. */
const candidateSql = `n.ready=1 AND n.lost_at IS NULL AND a.node_uid=n.node_uid
  AND a.release_id=f.release_id AND f.release_id=fr.id
  AND json_extract(fr.spec_json,'$.postgres_pool_qualification_version')=1
  AND json_extract(fr.spec_json,'$.route_token_version')=4
  AND json_extract(fr.spec_json,'$.runtime_attestation_version')=2
  AND json_extract(fr.spec_json,'$.admission_snapshot_version')=1
  AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash
  AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')
  AND julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')
  AND NOT EXISTS(SELECT 1 FROM json_each(fr.spec_json,'$.components') expected
    WHERE json_extract(expected.value,'$.name') IN('native-controller','native-gateway','openebs-lvm','pgcf-sandbox-controller')
    AND NOT EXISTS(SELECT 1 FROM json_each(o.facts_json,'$.components') actual
      WHERE json_extract(actual.value,'$.name')=json_extract(expected.value,'$.name')
      AND json_extract(actual.value,'$.version')=json_extract(expected.value,'$.version')
      AND json_extract(actual.value,'$.sha256')=json_extract(expected.value,'$.sha256')))
  AND NOT EXISTS(SELECT 1 FROM nodes nn JOIN fleet_node_releases aa ON aa.node_id=nn.id
    WHERE nn.region_id=r.id AND nn.lost_at IS NULL AND (aa.node_uid<>nn.node_uid OR aa.release_id<>f.release_id
      OR NOT EXISTS(SELECT 1 FROM fleet_patch_operations pp WHERE pp.node_id=nn.id AND pp.node_uid=nn.node_uid
        AND pp.release_id=fr.id AND pp.spec_sha256=fr.spec_sha256 AND pp.assignment_revision=aa.revision
        AND pp.region_revision=f.revision AND pp.stage='complete' AND pp.state='confirmed' AND pp.error_code IS NULL)))`;
const candidateFrom = `nodes n JOIN regions r ON r.id=n.region_id
  JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=r.id
  JOIN fleet_releases fr ON fr.id=f.release_id JOIN fleet_node_release_observations o ON o.node_id=n.id`;
async function candidate(env: Env, nodeId: string) {
  return env.DB.prepare(
    `SELECT n.id,n.node_uid,r.id region_id,r.agent_key_hash,
    json_extract(o.facts_json,'$.boot_id') boot_id,fr.id release_id,fr.spec_sha256,fr.spec_json
    FROM ${candidateFrom} WHERE n.id=? AND ${candidateSql}`,
  )
    .bind(nodeId)
    .first<{
      id: string;
      node_uid: string;
      region_id: string;
      agent_key_hash: string;
      boot_id: string;
      release_id: string;
      spec_sha256: string;
      spec_json: string;
    }>();
}
async function hostControllerPin(
  env: Env,
  current: NonNullable<Awaited<ReturnType<typeof candidate>>>,
  spec: FleetReleaseSpec,
) {
  const row = await env.DB.prepare(
      `SELECT p.policy_json,h.profile_sha256 FROM node_compute_pool_policies p
    JOIN node_host_configurations h ON h.node_id=p.node_id AND h.node_uid=p.node_uid AND h.pool_policy_revision=p.revision
    WHERE p.node_id=? AND p.node_uid=? AND p.release_id=? AND h.release_id=?`,
    )
      .bind(
        current.id,
        current.node_uid,
        current.release_id,
        current.release_id,
      )
      .first<{ policy_json: string; profile_sha256: string }>(),
    policy = ComputePoolPolicy.safeParse(
      row ? JSON.parse(row.policy_json) : null,
    ),
    pins = spec.postgres_pool_candidate;
  if (
    !row ||
    !policy.success ||
    !pins ||
    policy.data.profile.image !==
      spec.components.find((c) => c.name === "pgcf-sandbox-controller")
        ?.reference ||
    policy.data.profile.controller_sha256 !== pins.host_controller_sha256 ||
    (await installationHash(policy.data.profile)) !== row.profile_sha256
  )
    conflict(
      "Current sealed host controller executable is not candidate-qualified",
    );
  return { ...row, sha256: policy.data.profile.controller_sha256 };
}

async function cleanupState(env: Env, row: Row, code: string) {
  const j = journal(row);
  const next = canonicalInstallation({ ...j, pending: null });
  await env.DB.prepare(
    `UPDATE postgres_pool_qualification_runs SET status='cleanup',error_code=?,evidence_json=?,updated_at=?
    WHERE id=? AND status='running' AND evidence_json=?`,
  )
    .bind(code, next, Date.now(), row.id, row.evidence_json)
    .run();
  return read(env.DB, row.id);
}
export async function readActivePostgresPoolQualification(
  env: Env,
  nodeId: string,
) {
  let row = await env.DB.prepare(
    "SELECT * FROM postgres_pool_qualification_runs WHERE node_id=? AND status IN('running','cleanup')",
  )
    .bind(nodeId)
    .first<Row>();
  if (!row) return null;
  if (row.status === "running" && row.expires_at <= Date.now())
    row = await cleanupState(env, row, "pool_qualification_expired");
  return {
    scope: scope(row),
    scope_sha256: row.scope_sha256,
    status: row.status,
    expires_at: row.expires_at,
  };
}

export async function startPostgresPoolQualification(
  c: ApiContext,
  nodeId: string,
  body: PostgresPoolQualificationRequest,
) {
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: async (id, status) => {
      const stored = await read(c.env.DB, id);
      if (stored.status === "running" || stored.status === "cleanup")
        hint(c, stored.region_id, [stored.database_id]);
      return c.json(await view(c.env, stored), status as 202);
    },
    execute: (lease) => createRun(c, nodeId, body, lease),
  });
}
async function createRun(
  c: ApiContext,
  nodeId: string,
  body: PostgresPoolQualificationRequest,
  lease: IdempotencyLease,
) {
  const current = await candidate(c.env, nodeId);
  if (
    !current ||
    current.node_uid !== body.node_uid ||
    current.release_id !== body.candidate_release_id
  )
    conflict("The current confirmed controller cannot qualify this candidate");
  const state = await readPostgresPoolDatabaseContext(c.env, body.database_id),
    { row } = state,
    now = Date.now();
  if (
    row.node_id !== nodeId ||
    row.node_uid !== body.node_uid ||
    row.boot_id !== current.boot_id ||
    row.generation !== body.expected_generation ||
    row.desired_state !== "suspended" ||
    row.observed_generation !== row.generation ||
    row.observed_power !== "hibernated" ||
    row.deleted_at ||
    row.project_deleted_at ||
    !row.ever_ready ||
    row.mutation_id ||
    !row.storage_profile_json ||
    !row.storage_volume_json
  )
    conflict(
      "Qualification requires one established, currently hibernated thin database",
    );
  if (
    await c.env.DB.prepare(
      `SELECT 1 FROM node_postgres_pool_policies WHERE node_id=? AND json_extract(policy_json,'$.target_slots')>0
    UNION ALL SELECT 1 FROM pool_bindings WHERE node_id=? AND state NOT IN('released','refused')
    UNION ALL SELECT 1 FROM pool_pods WHERE node_id=? AND state<>'retired' LIMIT 1`,
    )
      .bind(nodeId, nodeId, nodeId)
      .first()
  )
    conflict(
      "Qualification requires the node's normal PostgreSQL pool to be quiescent",
    );
  const spec = FleetReleaseSpec.parse(JSON.parse(current.spec_json)),
    pins = spec.postgres_pool_candidate;
  if (!pins || spec.postgres_pool_qualification)
    conflict("Qualification requires an unqualified immutable candidate");
  const host = await hostControllerPin(c.env, current, spec);
  const component = (name: string) => {
    const item = spec.components.find((c) => c.name === name);
    if (
      !item ||
      item.kind !== "image" ||
      !item.reference.endsWith(`@sha256:${item.sha256}`)
    )
      conflict(`Candidate lacks the pinned ${name} image`);
    return item.reference;
  };
  const storage = DesiredDatabaseStorage.parse(
      JSON.parse(row.storage_profile_json),
    ),
    volume = DatabaseStorageVolumeReceipt.parse(
      JSON.parse(row.storage_volume_json),
    ),
    stored = await c.env.DB.prepare(
      "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
    )
      .bind(body.database_id)
      .first<{ observation_json: string }>(),
    physical = PoolStorageObservation.safeParse(
      stored ? JSON.parse(stored.observation_json) : null,
    ),
    selected = await readCurrentNodeThinStorage(c.env, nodeId, now),
    authority = selected?.authority;
  if (
    !physical.success ||
    physical.data.storage.backend !== "lvm-thin-v1" ||
    !fresh(physical.data.observed_at, now) ||
    physical.data.node_uid !== body.node_uid ||
    physical.data.boot_id !== current.boot_id ||
    physical.data.generation !== row.generation ||
    !equal(physical.data.storage.profile, storage) ||
    physical.data.storage.lv_uuid !== volume.lv_uuid ||
    physical.data.storage.pvc_uid !== volume.pvc_uid ||
    physical.data.storage.pv_uid !== volume.pv_uid ||
    physical.data.storage.storage_uid !== volume.storage_uid ||
    physical.data.storage.namespace_uid !== volume.namespace_uid ||
    physical.data.storage.cnpg_cluster_uid !== volume.cluster_uid ||
    selected?.row.current_qualified !== 1 ||
    !authority ||
    !thinStorageAuthorityMatches(storage, authority, undefined, now) ||
    authority.pool_uuid !== volume.pool_uuid ||
    authority.driver_image !== component("openebs-lvm") ||
    !spec.thin_storage_qualification ||
    row.image !== component("postgres")
  )
    conflict(
      "Current clean sleep, thin device and candidate software are not jointly verified",
    );
  const runScope = PostgresPoolQualificationScope.parse({
    version: 1,
    run_id: crypto.randomUUID(),
    region_id: current.region_id,
    node_id: nodeId,
    node_uid: body.node_uid,
    boot_id: current.boot_id,
    cluster_uid: selected.row.cluster_uid,
    database_id: body.database_id,
    database_generation: row.generation + 1,
    configuration_fingerprint: state.fingerprint,
    candidate_release_id: current.release_id,
    candidate_spec_sha256: current.spec_sha256,
    storage,
    volume,
    thin_id: physical.data.storage.thin_id,
    software: {
      driver_image: component("openebs-lvm"),
      driver_sha256: pins.driver_sha256,
      supervisor_image: component("pool-supervisor"),
      supervisor_sha256: pins.supervisor_sha256,
      postgres_image: component("postgres"),
      archiver_image: component("barman"),
      host_extension_image: component("pgcf-sandbox-controller"),
      host_controller_sha256: host.sha256,
      kernel_version: spec.thin_storage_qualification?.kernel_version,
    },
  });
  const scopeJson = canonicalInstallation(runScope),
    hash = await installationHash(runScope);
  const insert = c.env.DB.prepare(
    `WITH qualified_candidate AS MATERIALIZED(
      SELECT n.id node_id,n.node_uid,json_extract(o.facts_json,'$.boot_id') boot_id,fr.id release_id,fr.spec_sha256
      FROM ${candidateFrom} WHERE ${candidateSql}),
    qualified_thin AS MATERIALIZED(
      SELECT t.node_id,t.node_uid,t.authority_json,cp.policy_json compute_policy_json,h.profile_sha256 host_profile_sha256
      FROM node_thin_storage t JOIN node_compute_pool_policies cp ON cp.node_id=t.node_id AND cp.node_uid=t.node_uid
      JOIN node_host_configurations h ON h.node_id=t.node_id AND h.node_uid=t.node_uid AND h.pool_policy_revision=cp.revision
      WHERE ${qualifiedThinStorageSql()} AND t.status='ready'
      AND json_extract(t.authority_json,'$.write_allowed')=1
      AND cp.release_id=h.release_id
      AND julianday(json_extract(t.authority_json,'$.expires_at'))>julianday('now'))
    INSERT INTO postgres_pool_qualification_runs
    (id,region_id,node_id,node_uid,boot_id,database_id,database_generation,candidate_release_id,candidate_spec_sha256,scope_sha256,scope_json,status,evidence_json,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,? WHERE EXISTS(SELECT 1 FROM qualified_candidate q
      JOIN qualified_thin t ON t.node_id=q.node_id AND t.node_uid=q.node_uid
      JOIN databases d ON d.node_id=q.node_id JOIN database_admission_epochs ae ON ae.database_id=d.id
      WHERE q.node_id=? AND q.node_uid=? AND q.boot_id=? AND q.release_id=? AND q.spec_sha256=?
      AND d.id=? AND d.generation=? AND d.desired_state='suspended' AND d.observed_power='hibernated' AND d.observed_generation=d.generation
      AND d.storage_profile_json=? AND d.storage_volume_json=? AND ae.admission_revision=? AND ae.mutation_id IS NULL
      AND t.authority_json=? AND t.compute_policy_json=? AND t.host_profile_sha256=?)
      AND NOT EXISTS(SELECT 1 FROM postgres_pool_qualification_runs existing
        WHERE (existing.node_id=? OR existing.database_id=?) AND existing.status IN('running','cleanup'))
      AND NOT EXISTS(SELECT 1 FROM node_postgres_pool_policies WHERE node_id=? AND json_extract(policy_json,'$.target_slots')>0)
      AND NOT EXISTS(SELECT 1 FROM pool_bindings WHERE node_id=? AND state NOT IN('released','refused'))
      AND NOT EXISTS(SELECT 1 FROM pool_pods WHERE node_id=? AND state<>'retired')`,
  ).bind(
    runScope.run_id,
    current.region_id,
    nodeId,
    body.node_uid,
    current.boot_id,
    body.database_id,
    row.generation + 1,
    current.release_id,
    current.spec_sha256,
    hash,
    scopeJson,
    canonicalInstallation({ version: 1, pending: null, entries: [] }),
    now,
    now,
    now + RUN_MS,
    nodeId,
    body.node_uid,
    current.boot_id,
    current.release_id,
    current.spec_sha256,
    body.database_id,
    row.generation,
    row.storage_profile_json,
    row.storage_volume_json,
    row.admission_revision,
    selected.row.authority_json,
    host.policy_json,
    host.profile_sha256,
    nodeId,
    body.database_id,
    nodeId,
    nodeId,
    nodeId,
  );
  const results = await c.env.DB.batch([
    insert,
    lease.completeStatement(runScope.run_id, 202, {
      sql: "EXISTS(SELECT 1 FROM postgres_pool_qualification_runs WHERE id=? AND scope_sha256=?)",
      bindings: [runScope.run_id, hash],
    }),
  ]);
  if (results[0]!.meta.changes !== 1)
    conflict("Node or database remains reserved by an uncleaned qualification");
  hint(c, current.region_id, [body.database_id]);
  return c.json(await view(c.env, await read(c.env.DB, runScope.run_id)), 202);
}

export async function getPostgresPoolQualification(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  return c.json(await view(c.env, await read(c.env.DB, id)), 200);
}
export async function cancelPostgresPoolQualification(
  c: ApiContext,
  id: string,
) {
  await requireScope(c, "admin");
  let row = await read(c.env.DB, id);
  if (row.status === "running")
    row = await cleanupState(c.env, row, "pool_qualification_cancelled");
  if (row.status === "cleanup") hint(c, row.region_id, [row.database_id]);
  return c.json(await view(c.env, row), 200);
}

const nodeGates = new Set([
  "host_mount_context",
  "finite_creator_fence",
  "single_writer",
  "mount_propagation",
  "thin_write_authority",
  "thin_io_limits",
  "thin_expiry_protection",
  "cleanup",
]);
function producer(gate: string) {
  return nodeGates.has(gate)
    ? ("node_agent" as const)
    : ("controller" as const);
}
async function agent(c: ApiContext, nodeId: string) {
  const region = await agentRegion(c),
    node = await c.env.DB.prepare("SELECT region_id FROM nodes WHERE id=?")
      .bind(nodeId)
      .first<{ region_id: string }>();
  if (!node || node.region_id !== region.id)
    throw new ApiError("not_found", "Node not found");
  return {
    id: region.id,
    keyHash: await hashApiKey(
      c.env.API_KEY_PEPPER,
      c.req.header("Authorization")!.slice(7),
    ),
  };
}
export async function currentFence(env: Env, row: Row, keyHash: string) {
  const s = scope(row),
    current = await candidate(env, row.node_id),
    context = await readPostgresPoolDatabaseContext(env, s.database_id),
    thinFence = await readThinQualificationFence(
      env,
      row.node_id,
      row.status === "running",
    ),
    fleetFence = await readPostgresPoolFleetFence(env.DB, s.region_id, true),
    confirmedCurrent = await candidate(env, row.node_id);
  if (context.row.mutation_id)
    conflict(
      "Admission transaction is not complete; retry the current challenge",
    );
  const trusted = await storageAuthorityPublicKeys(env);
  if (current && equal(current, confirmedCurrent) && !fleetFence)
    conflict(
      "Qualification fleet readback changed; retry the current challenge",
    );
  if (
    !current ||
    !thinFence ||
    !fleetFence ||
    !equal(current, confirmedCurrent) ||
    FleetReleaseSpec.parse(JSON.parse(current.spec_json))
      .storage_authority_keys_sha256 !== trusted.sha256 ||
    current.node_uid !== s.node_uid ||
    (row.status === "running" &&
      (current.boot_id !== s.boot_id ||
        current.release_id !== s.candidate_release_id ||
        current.spec_sha256 !== s.candidate_spec_sha256)) ||
    current.agent_key_hash !== keyHash ||
    context.row.node_id !== s.node_id ||
    context.row.node_uid !== s.node_uid ||
    context.row.boot_id !== current.boot_id ||
    !context.row.storage_profile_json ||
    !context.row.storage_volume_json ||
    !equal(JSON.parse(context.row.storage_profile_json), s.storage) ||
    !equal(JSON.parse(context.row.storage_volume_json), s.volume) ||
    (row.status === "running" &&
      (context.fingerprint !== s.configuration_fingerprint ||
        ![s.database_generation - 1, s.database_generation].includes(
          context.row.generation,
        ) ||
        context.row.deleted_at ||
        context.row.project_deleted_at))
  )
    scopeChanged();
  return {
    current,
    context,
    authority: thinFence.authority,
    sql: `EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id
      JOIN fleet_node_release_observations o ON o.node_id=n.id JOIN databases d ON d.node_id=n.id
      JOIN database_admission_epochs ae ON ae.database_id=d.id WHERE n.id=? AND n.node_uid=?
      AND json_extract(o.facts_json,'$.boot_id')=? AND r.agent_key_hash=? AND n.ready=1 AND n.lost_at IS NULL
      AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')
      AND julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')
      AND d.id=? AND d.generation=? AND d.storage_profile_json=? AND d.storage_volume_json=?
      AND ae.admission_revision=? AND ae.mutation_id IS NULL) AND ${fleetFence.sql} AND ${thinFence.sql}`,
    bindings: [
      s.node_id,
      s.node_uid,
      current.boot_id,
      keyHash,
      s.database_id,
      context.row.generation,
      context.row.storage_profile_json,
      context.row.storage_volume_json,
      context.row.admission_revision,
      ...fleetFence.bindings,
      ...thinFence.bindings,
    ],
  };
}
const thinWitnessSql = `SELECT json_array(
  t.node_uid,t.cluster_uid,t.volume_group_uuid,t.profile_revision,t.profile_sha256,t.profile_json,
  t.material_revision,t.qualified_driver_image,t.qualification_json,
  h.node_uid,h.cluster_uid,h.release_id,h.material_revision,h.revision,h.sha256,h.profile_sha256,
  n.node_uid,n.ready,n.lost_at,r.bootstrap_material_revision,a.node_uid,a.release_id,a.revision,
  f.release_id,f.revision,s.spec_sha256,o.node_uid,o.assignment_revision,o.agent_key_hash,o.facts_json,o.observed_at,o.received_at,
  (SELECT json_group_array(json_array(p.operation_id,p.node_uid,p.cluster_uid,p.release_id,p.spec_sha256,
    p.assignment_revision,p.region_revision,p.material_revision,p.stage,p.state,p.error_code,
    p.host_configuration_revision,p.host_configuration_sha256,p.observed_json)) FROM fleet_patch_operations p
    WHERE p.node_id=n.id AND p.release_id=s.id AND p.assignment_revision=a.revision AND p.region_revision=f.revision),
  json_extract(t.authority_json,'$.driver_pod_uid'),cp.node_uid,cp.release_id,cp.revision,cp.policy_json,
  t.authority_json,t.authority_revision,t.authority_received_at) witness
  FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id JOIN regions r ON r.id=n.region_id
  JOIN node_host_configurations h ON h.node_id=n.id JOIN fleet_node_releases a ON a.node_id=n.id
  JOIN node_compute_pool_policies cp ON cp.node_id=n.id
  JOIN fleet_region_releases f ON f.region_id=r.id JOIN fleet_releases s ON s.id=f.release_id
  JOIN fleet_node_release_observations o ON o.node_id=n.id WHERE n.id=?`;
/** The full physical/host predicate is checked between identical snapshots, then
 * the nonce CAS fences those same facts without exceeding SQLite's expression depth. */
export async function readThinQualificationFence(
  env: Env,
  nodeId: string,
  requireQualified: boolean,
) {
  const before = await env.DB.prepare(thinWitnessSql)
      .bind(nodeId)
      .first<string>("witness"),
    thin = await readCurrentNodeThinStorage(env, nodeId),
    after = await env.DB.prepare(thinWitnessSql)
      .bind(nodeId)
      .first<string>("witness");
  if (before !== after)
    conflict(
      "Qualification physical-host readback changed; retry the current challenge",
    );
  if (
    !before ||
    !thin ||
    (requireQualified && thin.row.current_qualified !== 1)
  )
    return undefined;
  const parsedAuthority = NodeThinStorageAuthority.safeParse(
      thin.row.authority_json ? JSON.parse(thin.row.authority_json) : null,
    ),
    authority = parsedAuthority.success ? parsedAuthority.data : null,
    inventory = authority ? thinStorageInventory(authority) : null,
    now = Date.now();
  if (
    !authority ||
    !inventory ||
    inventory.expires_at <= now ||
    inventory.observed_at > now + SKEW_MS ||
    inventory.observed_at < now - THIN_INVENTORY_MAX_SECONDS * 1000 ||
    authority.node_id !== thin.row.node_id ||
    authority.name !== thin.row.k8s_node_name ||
    authority.node_uid !== thin.row.node_uid ||
    authority.cluster_uid !== thin.row.cluster_uid ||
    authority.volume_group_uuid !== thin.row.volume_group_uuid ||
    authority.profile_sha256 !== thin.row.profile_sha256 ||
    authority.profile_revision !== thin.row.profile_revision ||
    authority.revision !== thin.row.authority_revision ||
    authority.driver_image !== thin.row.qualified_driver_image ||
    (requireQualified && !thin.authority)
  )
    conflict(
      "Fresh physical driver identity is unavailable; retry the current challenge",
    );
  // Cleanup may use the newly attested boot, but never a different node, device,
  // unapproved host configuration or a removed creator-capable candidate.
  const values = JSON.parse(before) as unknown[];
  if (
    values[9] !== thin.row.node_uid ||
    values[10] !== thin.row.cluster_uid ||
    values[11] !== values[23] ||
    values[12] !== thin.row.material_revision ||
    values[19] !== thin.row.material_revision
  )
    return undefined;
  return {
    sql: `(${thinWitnessSql}) IS ? AND ?>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      ${requireQualified ? "AND ?>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)" : ""}`,
    bindings: [
      nodeId,
      after,
      inventory.expires_at,
      ...(requireQualified ? [Date.parse(authority.expires_at)] : []),
    ],
    authority,
  };
}
async function executionIdentity(
  env: Env,
  current: NonNullable<Awaited<ReturnType<typeof candidate>>>,
  authority: NodeThinStorageAuthority,
) {
  const currentSpec = FleetReleaseSpec.parse(JSON.parse(current.spec_json)),
    trusted = await storageAuthorityPublicKeys(env),
    component = (name: string) =>
      currentSpec.components.find((c) => c.name === name)?.reference;
  if (
    currentSpec.storage_authority_keys_sha256 !== trusted.sha256 ||
    !currentSpec.postgres_pool_candidate ||
    !currentSpec.thin_storage_qualification ||
    authority.node_uid !== current.node_uid ||
    authority.driver_image !== component("openebs-lvm")
  )
    conflict(
      "Current qualified software and verifier key custody are unavailable",
    );
  const execution = {
    node_uid: current.node_uid,
    boot_id: current.boot_id,
    candidate_release_id: current.release_id,
    candidate_spec_sha256: current.spec_sha256,
    verifier_keys_sha256: trusted.sha256,
    driver_pod_uid: authority.driver_pod_uid,
    driver_image: component("openebs-lvm")!,
    driver_sha256: currentSpec.postgres_pool_candidate.driver_sha256,
    host_extension_image: component("pgcf-sandbox-controller")!,
    host_controller_sha256: (await hostControllerPin(env, current, currentSpec))
      .sha256,
    kernel_version: currentSpec.thin_storage_qualification!.kernel_version,
  };
  return execution;
}

async function acceptedSleep(
  env: Env,
  row: Row,
  context: Awaited<ReturnType<typeof readPostgresPoolDatabaseContext>>,
) {
  const sql =
      "SELECT json_array(kind,revision,binding_id,state,clean_stop,sleep_json) witness FROM database_runtime_holders WHERE database_id=?",
    raw = await env.DB.prepare(sql)
      .bind(row.database_id)
      .first<string>("witness"),
    values = raw ? (JSON.parse(raw) as unknown[]) : null,
    parsed = PoolSleepRecord.safeParse(
      values?.[5] ? JSON.parse(values[5] as string) : null,
    ),
    s = scope(row),
    sleep = parsed.success ? parsed.data : null,
    physical = sleep?.storage,
    read = journal(row).entries.find(
      (e) => e.measurement.gate === "host_mount_context",
    )?.measurement;
  const valid =
    sleep &&
    values?.[0] === "cnpg" &&
    values[3] === "released" &&
    values[4] === 1 &&
    sleep.database_id === s.database_id &&
    sleep.generation === s.database_generation - 1 &&
    sleep.node_uid === s.node_uid &&
    sleep.boot_id === s.boot_id &&
    sleep.configuration_fingerprint === s.configuration_fingerprint &&
    equal(sleep.class, context.class) &&
    physical?.backend === "lvm-thin-v1" &&
    physical.thin_id === s.thin_id &&
    physical.storage_generation === s.volume.storage_generation &&
    physical.storage_uid === s.volume.storage_uid &&
    physical.namespace_uid === s.volume.namespace_uid &&
    physical.cnpg_cluster_uid === s.volume.cluster_uid &&
    physical.pvc_uid === s.volume.pvc_uid &&
    physical.pv_uid === s.volume.pv_uid &&
    physical.volume_handle === s.volume.volume_handle &&
    physical.lv_uuid === s.volume.lv_uuid &&
    physical.volume_group_uuid === s.volume.volume_group_uuid &&
    equal(physical.profile, s.storage) &&
    (!read ||
      "failure_code" in read ||
      read.gate !== "host_mount_context" ||
      (read.storage_read.system_identifier === sleep.system_identifier &&
        read.storage_read.timeline === sleep.timeline));
  return {
    value: valid ? sleep : null,
    sql: `(${sql}) IS ?`,
    bindings: [row.database_id, raw],
  };
}

export async function getPostgresPoolQualificationInput(
  c: ApiContext,
  nodeId: string,
) {
  const auth = await agent(c, nodeId);
  let row = await c.env.DB.prepare(
    "SELECT * FROM postgres_pool_qualification_runs WHERE node_id=? AND status IN('running','cleanup')",
  )
    .bind(nodeId)
    .first<Row>();
  if (!row) return c.json({ qualification: null }, 200);
  if (row.status === "running" && row.expires_at <= Date.now())
    row = await cleanupState(c.env, row, "pool_qualification_expired");
  let fence;
  try {
    fence = await currentFence(c.env, row, auth.keyHash);
  } catch (error) {
    if (
      row.status === "running" &&
      error instanceof ApiError &&
      error.name === "PostgresPoolQualificationScopeChanged"
    )
      await cleanupState(c.env, row, "pool_qualification_scope_changed");
    throw error;
  }
  const original = scope(row);
  if (
    row.status === "cleanup" &&
    !row.error_code &&
    (fence.current.boot_id !== original.boot_id ||
      fence.current.release_id !== original.candidate_release_id ||
      fence.current.spec_sha256 !== original.candidate_spec_sha256)
  ) {
    const result = await c.env.DB.prepare(
      `UPDATE postgres_pool_qualification_runs SET error_code='pool_qualification_scope_changed',updated_at=?
      WHERE id=? AND status='cleanup' AND error_code IS NULL AND evidence_json=? AND ${fence.sql}`,
    )
      .bind(Date.now(), row.id, row.evidence_json, ...fence.bindings)
      .run();
    if (result.meta.changes !== 1) conflict();
    row = { ...row, error_code: "pool_qualification_scope_changed" };
  }
  const j = journal(row),
    now = Date.now(),
    gate =
      row.status === "cleanup"
        ? "cleanup"
        : POSTGRES_POOL_QUALIFICATION_GATES[j.entries.length];
  if (!gate) conflict("Qualification is waiting for cleanup");
  let challenge = j.pending;
  if (!challenge || challenge.expires_at <= now) {
    challenge = PostgresPoolQualificationChallenge.parse({
      run_id: row.id,
      scope_sha256: row.scope_sha256,
      sequence: j.entries.length + 1,
      nonce: crypto.randomUUID().replaceAll("-", ""),
      producer: producer(gate),
      gate,
      issued_at: now,
      expires_at:
        row.status === "cleanup"
          ? now + CHALLENGE_MS
          : Math.min(now + CHALLENGE_MS, row.expires_at),
    });
    const next = canonicalInstallation({ ...j, pending: challenge }),
      result = await c.env.DB.prepare(
        `UPDATE postgres_pool_qualification_runs SET evidence_json=?,updated_at=?
        WHERE id=? AND status=? AND evidence_json=? AND ${fence.sql}`,
      )
        .bind(
          next,
          now,
          row.id,
          row.status,
          row.evidence_json,
          ...fence.bindings,
        )
        .run();
    if (result.meta.changes !== 1)
      conflict("Qualification challenge changed concurrently");
  }
  const preparation =
      row.status === "running"
        ? await readPostgresPoolQualificationPreparation(
            c.env,
            nodeId,
            row.id,
            row.scope_sha256,
          )
        : undefined,
    execution = await executionIdentity(c.env, fence.current, fence.authority),
    key = await nodeProofSigningKey(c.env),
    iat = Date.now(),
    permission = await signPoolQualificationPermission(
      {
        v: 1,
        kid: key.kid,
        scope: scope(row),
        scope_sha256: row.scope_sha256,
        challenge,
        execution,
        preparation_sha256: preparation?.preparation_sha256 ?? null,
        iat,
        exp: Math.min(
          iat + 30_000,
          challenge.expires_at,
          preparation?.context.expires_at ?? Number.MAX_SAFE_INTEGER,
        ),
      },
      key.privateKey,
      iat,
    );
  const setup =
      row.status === "running"
        ? await readPostgresPoolQualificationSetup(
            c.env,
            row.database_id,
            row.database_generation,
          )
        : undefined,
    sleep = await acceptedSleep(c.env, row, fence.context);
  const still = await c.env.DB.prepare(
    `SELECT 1 FROM postgres_pool_qualification_runs WHERE id=? AND status=?
    AND json_extract(evidence_json,'$.pending.nonce')=? AND ${fence.sql}
    AND ${sleep.sql}
    ${preparation ? `AND (${preparation.fence.sql})` : ""}`,
  )
    .bind(
      row.id,
      row.status,
      challenge.nonce,
      ...fence.bindings,
      ...sleep.bindings,
      ...(preparation?.fence.bindings ?? []),
    )
    .first();
  if (!still)
    conflict("Qualification authority changed during permission issuance");
  return c.json(
    {
      qualification: {
        scope: scope(row),
        scope_sha256: row.scope_sha256,
        status: row.status,
        expires_at: row.expires_at,
        challenge,
        permission,
        accepted_evidence: j.entries,
        accepted_sleep: sleep.value,
        policy: setup
          ? {
              node_id: row.node_id,
              node_uid: row.node_uid,
              region_id: row.region_id,
              revision: setup.policy_revision,
              policy: setup.policy,
              updated_at: new Date(row.created_at).toISOString(),
            }
          : null,
      },
    },
    200,
  );
}

async function measuredHolder(
  env: Env,
  row: Row,
  report: PostgresPoolQualificationReport,
  execution: PostgresPoolQualificationExecution,
) {
  const m = report.measurement,
    s = scope(row);
  if ("failure_code" in m) return;
  if (m.gate === "host_mount_context") {
    const context = await readPostgresPoolDatabaseContext(env, s.database_id),
      preparation = await readPostgresPoolQualificationPreparation(
        env,
        s.node_id,
        row.id,
        row.scope_sha256,
      ),
      r = m.storage_read,
      o = m.storage_observation,
      storage = o.storage;
    if (
      !preparation ||
      context.row.generation !== s.database_generation - 1 ||
      context.row.desired_state !== "suspended" ||
      context.row.observed_power !== "hibernated" ||
      r.qualification_run_id !== row.id ||
      r.qualification_scope_sha256 !== row.scope_sha256 ||
      r.nonce_sha256 !==
        (await postgresPoolQualificationNonceHash(report.nonce)) ||
      r.database_id !== s.database_id ||
      r.preparation_sha256 !== preparation.preparation_sha256 ||
      !preparation.context.pods.some((p) => p.pod_uid === r.pool_pod_uid) ||
      !fresh(r.observed_at, Date.now()) ||
      r.observed_at < report.started_at - SKEW_MS ||
      r.observed_at > report.observed_at + SKEW_MS ||
      !fresh(o.observed_at, Date.now()) ||
      o.observed_at > report.observed_at + SKEW_MS ||
      storage.backend !== "lvm-thin-v1" ||
      !equal(storage.profile, s.storage) ||
      storage.thin_id !== s.thin_id ||
      storage.lv_uuid !== s.volume.lv_uuid ||
      storage.volume_handle !== s.volume.volume_handle ||
      storage.storage_generation !== s.volume.storage_generation ||
      storage.storage_uid !== s.volume.storage_uid ||
      storage.namespace_uid !== s.volume.namespace_uid ||
      storage.cnpg_cluster_uid !== s.volume.cluster_uid ||
      storage.pvc_uid !== s.volume.pvc_uid ||
      storage.pv_uid !== s.volume.pv_uid ||
      storage.volume_group_uuid !== s.volume.volume_group_uuid ||
      r.device_major !== o.kernel_proof.device_major ||
      r.device_minor !== o.kernel_proof.device_minor
    )
      conflict(
        "Host inspection is not bound to the current preparation, physical volume and nonce",
      );
    return preparation.fence;
  }
  if (m.gate === "finite_creator_fence") {
    const priorDriver = journal(row).entries.find(
        (e) => e.measurement.gate === "host_mount_context",
      )?.execution.driver_pod_uid,
      currentDriver = execution.driver_pod_uid;
    const context = await readPostgresPoolDatabaseContext(env, s.database_id),
      stored = await env.DB.prepare(
        "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
      )
        .bind(s.database_id)
        .first<{ observation_json: string }>(),
      physical = PoolStorageObservation.safeParse(
        stored ? JSON.parse(stored.observation_json) : null,
      );
    if (
      m.binding_id !== null ||
      m.source_generation !== s.database_generation - 1 ||
      m.deny_record_scope_sha256 !== row.scope_sha256 ||
      m.driver_pod_uid_before_restart !== priorDriver ||
      m.driver_pod_uid_after_restart !== currentDriver ||
      m.driver_deleted_at < report.started_at - SKEW_MS ||
      m.driver_replacement_ready_at > report.observed_at + SKEW_MS ||
      m.denied_operations.some(
        (o) =>
          o.operation === "snapshot_create" &&
          (o.requested_at < report.started_at - SKEW_MS ||
            o.absent_at > report.observed_at + SKEW_MS),
      ) ||
      context.row.generation !== m.source_generation ||
      context.row.desired_state !== "suspended" ||
      context.row.observed_power !== "hibernated" ||
      !physical.success ||
      physical.data.generation !== m.source_generation ||
      physical.data.boot_id !== report.boot_id ||
      physical.data.node_uid !== s.node_uid ||
      !fresh(physical.data.observed_at, Date.now()) ||
      physical.data.observed_at < report.started_at - SKEW_MS ||
      physical.data.storage.backend !== "lvm-thin-v1" ||
      physical.data.storage.lv_uuid !== s.volume.lv_uuid ||
      physical.data.kernel_proof.dm_open_count !== 0 ||
      physical.data.kernel_proof.foreign_mounts !== 0 ||
      !physical.data.kernel_proof.named_namespace_scan_complete ||
      (await env.DB.prepare(
        "SELECT 1 FROM pool_bindings WHERE database_id=? AND generation=?",
      )
        .bind(s.database_id, s.database_generation)
        .first())
    )
      conflict();
    return;
  }
  if (m.gate === "cleanup") {
    const state = await readPostgresPoolDatabaseContext(env, s.database_id);
    if (
      state.row.desired_state !== "suspended" ||
      state.row.observed_power !== "hibernated" ||
      state.row.observed_generation !== state.row.generation ||
      ![
        s.database_generation - 1,
        s.database_generation,
        s.database_generation + 1,
      ].includes(state.row.generation)
    )
      conflict();
    if (m.binding_id === null) {
      if (
        row.error_code === null ||
        state.row.generation !== s.database_generation - 1 ||
        journal(row).entries.some(
          (e) =>
            "binding_id" in e.measurement && e.measurement.binding_id !== null,
        )
      )
        conflict();
      const active = await env.DB.prepare(
          `SELECT 1 FROM pool_bindings WHERE database_id=? AND generation=?
        UNION ALL SELECT 1 FROM pool_pods WHERE node_id=? AND node_uid=? AND state<>'retired' LIMIT 1`,
        )
          .bind(s.database_id, s.database_generation, s.node_id, s.node_uid)
          .first(),
        stored = await env.DB.prepare(
          "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
        )
          .bind(s.database_id)
          .first<{ observation_json: string }>(),
        physical = PoolStorageObservation.safeParse(
          stored ? JSON.parse(stored.observation_json) : null,
        );
      if (
        active ||
        !physical.success ||
        !fresh(physical.data.observed_at, Date.now()) ||
        physical.data.generation !== state.row.generation ||
        physical.data.boot_id !== report.boot_id ||
        physical.data.node_uid !== s.node_uid ||
        physical.data.storage.backend !== "lvm-thin-v1" ||
        physical.data.storage.lv_uuid !== s.volume.lv_uuid ||
        !equal(physical.data.storage.profile, s.storage) ||
        physical.data.kernel_proof.dm_open_count !== m.dm_open_count ||
        physical.data.kernel_proof.foreign_mounts !== m.foreign_mounts ||
        !physical.data.kernel_proof.named_namespace_scan_complete
      )
        conflict();
      return {
        sql: `NOT EXISTS(SELECT 1 FROM pool_bindings WHERE database_id=? AND generation=?)
          AND NOT EXISTS(SELECT 1 FROM pool_pods WHERE node_id=? AND node_uid=? AND state<>'retired')
          AND EXISTS(SELECT 1 FROM pool_storage_observations WHERE database_id=? AND observation_json=?)`,
        bindings: [
          s.database_id,
          s.database_generation,
          s.node_id,
          s.node_uid,
          s.database_id,
          stored!.observation_json,
        ],
      };
    }
  }
  const holder = await env.DB.prepare("SELECT * FROM pool_bindings WHERE id=?")
    .bind(m.binding_id)
    .first<{
      scope_json: string;
      scope_sha256: string;
      node_report_json: string | null;
      supervisor_report_json: string | null;
      state: string;
      served_at: number | null;
    }>();
  if (!holder)
    conflict("Measurement requires the actual qualification binding");
  const binding = PoolBindingScope.parse(JSON.parse(holder.scope_json)),
    b = binding.storage;
  if (
    binding.database_id !== s.database_id ||
    binding.generation !== s.database_generation ||
    binding.node_id !== s.node_id ||
    binding.node_uid !== s.node_uid ||
    binding.boot_id !== s.boot_id ||
    binding.configuration_fingerprint !== s.configuration_fingerprint ||
    binding.driver_image !== s.software.driver_image ||
    binding.driver_sha256 !== s.software.driver_sha256 ||
    binding.supervisor_sha256 !== s.software.supervisor_sha256 ||
    binding.host_controller_sha256 !== s.software.host_controller_sha256 ||
    b.backend !== "lvm-thin-v1" ||
    b.thin_id !== s.thin_id ||
    !equal(b.profile, s.storage) ||
    b.lv_uuid !== s.volume.lv_uuid ||
    b.pvc_uid !== s.volume.pvc_uid ||
    b.pv_uid !== s.volume.pv_uid ||
    b.storage_uid !== s.volume.storage_uid ||
    b.namespace_uid !== s.volume.namespace_uid ||
    b.cnpg_cluster_uid !== s.volume.cluster_uid ||
    b.volume_handle !== s.volume.volume_handle ||
    b.volume_group_uuid !== s.volume.volume_group_uuid
  )
    conflict();
  for (const previous of journal(row).entries) {
    if (
      "binding_id" in previous.measurement &&
      previous.measurement.binding_id !== null &&
      previous.measurement.binding_id !== m.binding_id
    )
      conflict("Qualification cannot switch volume holders");
  }
  const node = PoolNodeReport.safeParse(
      holder.node_report_json ? JSON.parse(holder.node_report_json) : null,
    ),
    supervisor = PoolSupervisorReport.safeParse(
      holder.supervisor_report_json
        ? JSON.parse(holder.supervisor_report_json)
        : null,
    );
  if (m.gate === "single_writer" || m.gate === "mount_propagation") {
    if (
      !node.success ||
      node.data.binding_id !== m.binding_id ||
      node.data.scope_sha256 !== holder.scope_sha256 ||
      node.data.node_uid !== s.node_uid ||
      node.data.boot_id !== s.boot_id ||
      node.data.state !== "mounted" ||
      !fresh(node.data.observed_at, Date.now())
    )
      conflict();
    const proof = node.data.kernel_proof;
    if (
      m.gate === "single_writer" &&
      (m.mounted_dm_open_count !== proof.dm_open_count ||
        m.foreign_mounts !== proof.foreign_mounts ||
        !proof.zero_before_bind ||
        !proof.exclusive_superblock_creation ||
        !proof.named_namespace_scan_complete)
    )
      conflict();
    if (
      m.gate === "mount_propagation" &&
      (m.device_major !== proof.device_major ||
        m.device_minor !== proof.device_minor)
    )
      conflict();
  }
  if (m.gate === "thin_write_authority") {
    if (
      !node.success ||
      node.data.state !== "mounted" ||
      !node.data.thin_guard ||
      node.data.thin_guard.authority_revision !== m.authority_revision ||
      node.data.thin_guard.expires_at !== m.expires_at ||
      !fresh(node.data.observed_at, Date.now())
    )
      conflict();
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(node.data.thin_guard.authority_token),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== m.authority_sha256) conflict();
  }
  if (m.gate === "thin_io_limits") {
    const stored = await env.DB.prepare(
        "SELECT attestation_json FROM pool_io_attestations WHERE binding_id=?",
      )
        .bind(m.binding_id)
        .first<{ attestation_json: string }>(),
      io = PoolIoAttestation.safeParse(
        stored ? JSON.parse(stored.attestation_json) : null,
      );
    if (
      !io.success ||
      io.data.scope_sha256 !== holder.scope_sha256 ||
      io.data.node_uid !== s.node_uid ||
      io.data.boot_id !== s.boot_id ||
      !fresh(io.data.observed_at, Date.now()) ||
      m.device_major !== io.data.device.device_major ||
      m.device_minor !== io.data.device.device_minor ||
      !equal(
        [...m.writer_cgroups.map((c) => c.container_id)].sort(),
        [...binding.container_ids].sort(),
      ) ||
      !equal(
        m.writer_cgroups,
        io.data.cgroups.map(({ io_max_verified: verified, ...c }) => {
          void verified;
          return c;
        }),
      )
    )
      conflict();
  }
  if (
    m.gate === "wal_archive" ||
    m.gate === "base_backup" ||
    m.gate === "clean_stop"
  ) {
    if (
      m.system_identifier !== binding.system_identifier ||
      m.timeline !== binding.timeline ||
      !holder.served_at
    )
      conflict();
    if (
      m.gate === "clean_stop" &&
      (!supervisor.success ||
        supervisor.data.state !== "stopped" ||
        supervisor.data.control_state !== m.control_state ||
        supervisor.data.postmaster_pid !== m.postmaster_pid ||
        supervisor.data.system_identifier !== m.system_identifier ||
        supervisor.data.timeline !== m.timeline ||
        !fresh(supervisor.data.observed_at, Date.now()))
    )
      conflict();
  }
  if (m.gate === "thin_expiry_protection") {
    const accepted = journal(row).entries.find(
      (e) => e.measurement.gate === "thin_write_authority",
    )?.measurement;
    if (
      !accepted ||
      "failure_code" in accepted ||
      accepted.gate !== "thin_write_authority" ||
      m.authority_expires_at !== accepted.expires_at ||
      m.authority_expires_at > report.observed_at
    )
      conflict();
  }
  if (
    m.gate === "cleanup" &&
    (!node.success ||
      node.data.binding_id !== m.binding_id ||
      node.data.scope_sha256 !== holder.scope_sha256 ||
      node.data.node_uid !== s.node_uid ||
      node.data.boot_id !== report.boot_id ||
      node.data.state !== "released" ||
      holder.state !== "released" ||
      !fresh(node.data.observed_at, Date.now()) ||
      node.data.kernel_proof.dm_open_count !== m.dm_open_count ||
      node.data.kernel_proof.foreign_mounts !== m.foreign_mounts ||
      !node.data.kernel_proof.nonlazy_unmount_verified ||
      !node.data.kernel_proof.named_namespace_scan_complete)
  )
    conflict();
}

export async function reportPostgresPoolQualification(
  c: ApiContext,
  nodeId: string,
  raw: PostgresPoolQualificationReport,
) {
  const auth = await agent(c, nodeId),
    report = PostgresPoolQualificationReport.parse(raw);
  let row = await read(c.env.DB, report.run_id);
  if (row.node_id !== nodeId || row.region_id !== auth.id)
    throw new ApiError("not_found", "Qualification not found");
  if (row.status === "running" && row.expires_at <= Date.now())
    row = await cleanupState(c.env, row, "pool_qualification_expired");
  if (!["running", "cleanup"].includes(row.status))
    conflict("Qualification already ended");
  const j = journal(row),
    p = j.pending,
    s = scope(row),
    now = Date.now();
  if (
    !p ||
    p.nonce !== report.nonce ||
    p.sequence !== report.sequence ||
    p.expires_at <= now ||
    p.gate !== report.measurement.gate ||
    p.producer !== report.producer ||
    report.scope_sha256 !== row.scope_sha256 ||
    report.node_uid !== s.node_uid ||
    report.started_at < p.issued_at - SKEW_MS ||
    report.observed_at > now + SKEW_MS ||
    report.observed_at < now - 60_000
  )
    conflict("Qualification challenge, measurement window or producer changed");
  let fence;
  try {
    fence = await currentFence(c.env, row, auth.keyHash);
  } catch (error) {
    if (
      row.status === "running" &&
      error instanceof ApiError &&
      error.name === "PostgresPoolQualificationScopeChanged"
    )
      await cleanupState(c.env, row, "pool_qualification_scope_changed");
    throw error;
  }
  if (
    report.boot_id !== fence.current.boot_id ||
    report.candidate_spec_sha256 !== fence.current.spec_sha256
  )
    conflict();
  const execution = await executionIdentity(
    c.env,
    fence.current,
    fence.authority,
  );
  const measurementFence = await measuredHolder(c.env, row, report, execution),
    sql = measurementFence
      ? `(${fence.sql}) AND (${measurementFence.sql})`
      : fence.sql,
    bindings = [...fence.bindings, ...(measurementFence?.bindings ?? [])];
  const evidence = PostgresPoolQualificationEvidence.parse({
      sequence: report.sequence,
      producer: report.producer,
      issued_at: p.issued_at,
      started_at: report.started_at,
      observed_at: report.observed_at,
      received_at: now,
      execution,
      measurement: report.measurement,
    }),
    passed = postgresPoolQualificationGatePassed(s, report.measurement);
  if (report.measurement.gate === "cleanup") {
    if (!passed) {
      const result = await c.env.DB.prepare(
        `UPDATE postgres_pool_qualification_runs SET cleanup_json=?,evidence_json=?,updated_at=?
        WHERE id=? AND status='cleanup' AND evidence_json=? AND ${sql}`,
      )
        .bind(
          canonicalInstallation(evidence),
          canonicalInstallation({ ...j, pending: null }),
          now,
          row.id,
          row.evidence_json,
          ...bindings,
        )
        .run();
      if (result.meta.changes !== 1) conflict();
    } else await complete(c.env, row, evidence, sql, bindings);
  } else {
    const entries = [...j.entries, evidence],
      ended =
        !passed || entries.length === POSTGRES_POOL_QUALIFICATION_GATES.length,
      result = await c.env.DB.prepare(
        `UPDATE postgres_pool_qualification_runs SET evidence_json=?,status=?,error_code=?,updated_at=?
        WHERE id=? AND status='running' AND expires_at>? AND evidence_json=? AND ${sql}`,
      )
        .bind(
          canonicalInstallation({ version: 1, pending: null, entries }),
          ended ? "cleanup" : "running",
          passed ? null : "pool_qualification_gate_failed",
          now,
          row.id,
          now,
          row.evidence_json,
          ...bindings,
        )
        .run();
    if (result.meta.changes !== 1) conflict();
  }
  return c.json(
    { accepted: true, run: await view(c.env, await read(c.env.DB, row.id)) },
    200,
  );
}

async function complete(
  env: Env,
  row: Row,
  cleanup: PostgresPoolQualificationEvidence,
  sql: string,
  bindings: unknown[],
) {
  const s = scope(row),
    j = journal(row),
    now = Date.now(),
    error =
      row.error_code ??
      (row.expires_at <= now
        ? "pool_qualification_expired"
        : !originalExecution(s, cleanup.execution)
          ? "pool_qualification_scope_changed"
          : null);
  if (error) {
    const result = await env.DB.prepare(
      `UPDATE postgres_pool_qualification_runs SET status='failed',cleanup_json=?,error_code=?,
      evidence_json=?,updated_at=?,completed_at=? WHERE id=? AND status='cleanup' AND evidence_json=? AND ${sql}`,
    )
      .bind(
        canonicalInstallation(cleanup),
        error,
        canonicalInstallation({ ...j, pending: null }),
        now,
        now,
        row.id,
        row.evidence_json,
        ...bindings,
      )
      .run();
    if (result.meta.changes !== 1) conflict();
    return;
  }
  if (
    j.entries.length !== POSTGRES_POOL_QUALIFICATION_GATES.length ||
    j.entries.some(
      (e, i) =>
        e.sequence !== i + 1 ||
        e.measurement.gate !== POSTGRES_POOL_QUALIFICATION_GATES[i] ||
        e.producer !== producer(e.measurement.gate) ||
        "failure_code" in e.measurement ||
        !originalExecution(s, e.execution) ||
        (e.measurement.gate === "finite_creator_fence" &&
          e.measurement.deny_record_scope_sha256 !== row.scope_sha256) ||
        !postgresPoolQualificationGatePassed(s, e.measurement),
    )
  )
    conflict("Qualification gates are incomplete");
  const material = { scope: s, evidence: j.entries, cleanup },
    evidenceJson = canonicalInstallation(material),
    evidenceHash = await installationHash(material),
    qualifiedAt = new Date(now).toISOString(),
    gates = Object.fromEntries(
      POSTGRES_POOL_QUALIFICATION_GATES.map((g) => [g, true]),
    ),
    unsigned = {
      version: 1,
      run_id: row.id,
      candidate_release_id: s.candidate_release_id,
      candidate_spec_sha256: s.candidate_spec_sha256,
      scope_sha256: row.scope_sha256,
      evidence_sha256: evidenceHash,
      driver_image: s.software.driver_image,
      driver_sha256: s.software.driver_sha256,
      supervisor_sha256: s.software.supervisor_sha256,
      host_controller_sha256: s.software.host_controller_sha256,
      postgres_image_sha256: s.software.postgres_image.split("@sha256:")[1],
      archiver_image_sha256: s.software.archiver_image.split("@sha256:")[1],
      qualified_at: qualifiedAt,
      gates,
    },
    receipt = await installationHash(unsigned),
    q = PostgresPoolQualification.parse({
      ...unsigned,
      receipt_sha256: receipt,
    }),
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO postgres_pool_qualification_receipts(receipt_sha256,run_id,scope_sha256,evidence_sha256,
        candidate_release_id,candidate_spec_sha256,driver_image,driver_sha256,supervisor_sha256,host_controller_sha256,postgres_image_sha256,
        archiver_image_sha256,qualified_at,qualification_json,evidence_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM postgres_pool_qualification_runs
          WHERE id=? AND status='cleanup' AND error_code IS NULL AND expires_at>? AND evidence_json=?) AND ${sql}`,
      ).bind(
        receipt,
        row.id,
        row.scope_sha256,
        evidenceHash,
        s.candidate_release_id,
        s.candidate_spec_sha256,
        q.driver_image,
        q.driver_sha256,
        q.supervisor_sha256,
        q.host_controller_sha256,
        q.postgres_image_sha256,
        q.archiver_image_sha256,
        qualifiedAt,
        canonicalInstallation(q),
        evidenceJson,
        row.id,
        now,
        row.evidence_json,
        ...bindings,
      ),
      env.DB.prepare(
        `UPDATE postgres_pool_qualification_runs SET status='completed',cleanup_json=?,receipt_sha256=?,
        evidence_json=?,updated_at=?,completed_at=? WHERE id=? AND status='cleanup' AND error_code IS NULL AND expires_at>?
        AND evidence_json=? AND EXISTS(SELECT 1 FROM postgres_pool_qualification_receipts WHERE run_id=? AND receipt_sha256=?)`,
      ).bind(
        canonicalInstallation(cleanup),
        receipt,
        canonicalInstallation({ ...j, pending: null }),
        now,
        now,
        row.id,
        now,
        row.evidence_json,
        row.id,
        receipt,
      ),
    ]);
  if (results[0]!.meta.changes !== 1 || results[1]!.meta.changes !== 1)
    conflict();
}
