// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  DesiredDatabaseStorage,
  DatabaseStorageVolumeReceipt,
  newOperationId,
} from "@pgcf/contracts";
import {
  PostgresPoolQualification,
  FleetReleaseSpec,
} from "@pgcf/contracts/releases";
import {
  DatabasePoolRuntimeAttestationV2,
  DatabaseRuntimeAttestation,
} from "@pgcf/contracts/reclaim";
import {
  PoolBinding,
  PoolBindingScope,
  PoolSleepRecord,
  PoolStorageObservation,
  PoolPodAttestation,
  PoolNodeReport,
  PoolSupervisorReport,
  PostgresPoolPolicy,
  PostgresPoolPolicyState,
  PoolBindClaims,
  PoolBindingSnapshot,
  PoolBindingDetails,
  PoolIoAttestation,
  PoolCleanupIoAttestation,
  POSTGRES_POOL,
  poolBindingScopeHash,
  poolCleanupIoAttestationHash,
  signPoolBindPermission,
  type DesiredPoolBinding,
} from "@pgcf/contracts/postgres-pool";
import { verifyStorageWriteAuthority } from "@pgcf/contracts/storage-write-authority";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import { ApiError } from "../app.ts";
import type { Env, ApiContext } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import {
  postgresPoolCapable,
  postgresPoolQualificationCapable,
} from "./fleet-releases.ts";
import { nodeProofSigningKey } from "./node-proof-session.ts";
import {
  PoolCleanupClaims,
  verifyPoolCleanupAuthority,
} from "@pgcf/contracts/pool-cleanup-authority";
import { readPostgresPoolQualificationAuthority } from "./postgres-pool-qualification-authority.ts";
import { readPostgresPoolFleetFence } from "./postgres-pool-fleet-fence.ts";
import { currentStorageStopSql } from "./storage-capacity.ts";
import { readPostgresPoolHostController } from "./postgres-pool-host.ts";
import { postgresPoolCnpgSelectionStatements } from "./postgres-pool-cold-start.ts";
export { readPostgresPoolQualificationAuthority } from "./postgres-pool-qualification-authority.ts";
export { readPostgresPoolQualificationCleanupAuthority } from "./postgres-pool-qualification-cleanup.ts";
import {
  withAdmissionMutation,
  type AdmissionMutation,
  type AdmissionSqlGuard,
} from "./admission-mutations.ts";

import { readPostgresPoolDatabaseContext as input } from "./postgres-pool-context.ts";
export { readPostgresPoolDatabaseContext } from "./postgres-pool-context.ts";

const conflict = (message = "PostgreSQL pool authority changed") =>
  new ApiError("conflict", message);
const fresh = (at: number, now: number) =>
  at <= now + POSTGRES_POOL.clock_skew_ms &&
  at > now - POSTGRES_POOL.observation_max_age_ms;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const terminal = (state: string) => ["released", "refused"].includes(state);
async function hintPostgresPoolProgress(env: Env, binding: PoolBinding) {
  const scope = binding.scope;
  const link = env.REGION_LINK.get(env.REGION_LINK.idFromName(scope.region_id));
  await link.notify([scope.database_id]);
  const delivery = await readDesiredPostgresPoolBinding(env, scope.database_id);
  if (delivery) await link.notifyPoolBinding(scope.node_id, delivery);
}
async function currentNode(env: Env, id: string, region?: string) {
  const node = await env.DB.prepare(
    `SELECT n.id,n.region_id,n.node_uid,json_extract(o.facts_json,'$.boot_id') boot_id FROM nodes n
    JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
    JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision
    WHERE n.id=? AND n.ready=1 AND n.lost_at IS NULL AND julianday(n.last_observed_at)>=julianday('now','-180 seconds')
    AND julianday(o.observed_at)>=julianday('now','-180 seconds')`,
  )
    .bind(id)
    .first<{
      id: string;
      region_id: string;
      node_uid: string;
      boot_id: string;
    }>();
  if (!node || !node.boot_id || (region && node.region_id !== region))
    throw conflict("Current node boot authority is unavailable");
  return node;
}
export const readPostgresPoolNodeContext = currentNode;
export async function assertPostgresPoolQualificationReceipt(
  db: D1Database,
  qualification: PostgresPoolQualification,
) {
  const q = PostgresPoolQualification.parse(qualification);
  const row = await db
    .prepare(
      "SELECT qualification_json,evidence_json,evidence_sha256 FROM postgres_pool_qualification_receipts WHERE receipt_sha256=? AND run_id=? AND candidate_release_id=? AND candidate_spec_sha256=? AND scope_sha256=? AND evidence_sha256=? AND driver_image=? AND driver_sha256=? AND supervisor_sha256=? AND host_controller_sha256=? AND postgres_image_sha256=? AND archiver_image_sha256=? AND qualified_at=?",
    )
    .bind(
      q.receipt_sha256,
      q.run_id,
      q.candidate_release_id,
      q.candidate_spec_sha256,
      q.scope_sha256,
      q.evidence_sha256,
      q.driver_image,
      q.driver_sha256,
      q.supervisor_sha256,
      q.host_controller_sha256,
      q.postgres_image_sha256,
      q.archiver_image_sha256,
      q.qualified_at,
    )
    .first<{
      qualification_json: string;
      evidence_json: string;
      evidence_sha256: string;
    }>();
  if (
    !row ||
    !equal(
      PostgresPoolQualification.parse(JSON.parse(row.qualification_json)),
      q,
    ) ||
    bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(row.evidence_json),
        ),
      ),
    ) !== q.evidence_sha256
  )
    throw conflict(
      "PostgreSQL pool qualification has no verified completed run",
    );
}
export async function readPostgresPoolPolicies(env: Env, regionId: string) {
  if (!(await postgresPoolCapable(env.DB, regionId))) return [];
  const rows = await env.DB.prepare(
    "SELECT p.*,n.region_id FROM node_postgres_pool_policies p JOIN nodes n ON n.id=p.node_id AND n.node_uid=p.node_uid WHERE n.region_id=? AND n.lost_at IS NULL ORDER BY n.id",
  )
    .bind(regionId)
    .all();
  return rows.results.map((row) =>
    PostgresPoolPolicyState.parse({
      node_id: row.node_id,
      node_uid: row.node_uid,
      region_id: row.region_id,
      revision: row.revision,
      updated_at: row.updated_at,
      policy: JSON.parse(row.policy_json as string),
    }),
  );
}
async function bindingRow(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM pool_bindings WHERE id=?")
    .bind(id)
    .first<Record<string, unknown>>();
}
function bindingFrom(row: Record<string, unknown>): PoolBinding {
  return PoolBinding.parse({
    v: 1,
    scope: JSON.parse(row.scope_json as string),
    scope_sha256: row.scope_sha256,
    holder_revision: row.holder_revision,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
function scopeMatches(
  state: Awaited<ReturnType<typeof input>>,
  binding: PoolBinding,
) {
  const { scope } = binding,
    { row } = state;
  return (
    row.deleted_at === null &&
    row.project_deleted_at === null &&
    row.node_id === scope.node_id &&
    row.node_uid === scope.node_uid &&
    row.boot_id === scope.boot_id &&
    row.lost_at === null &&
    row.ready === 1 &&
    row.generation === scope.generation &&
    (binding.state === "serving"
      ? row.route_revision >= scope.route_revision &&
        row.admission_revision >= scope.admission_epoch
      : row.route_revision === scope.route_revision &&
        row.admission_revision === scope.admission_epoch) &&
    row.mutation_id === null &&
    scope.storage.storage_generation === (row.storage_generation ?? 1) &&
    state.fingerprint === scope.configuration_fingerprint &&
    equal(state.class, scope.class)
  );
}
async function permission(env: Env, binding: PoolBinding, now: number) {
  const key = await nodeProofSigningKey(env);
  return signPoolBindPermission(
    PoolBindClaims.parse({
      v: 1,
      kid: key.kid,
      scope: binding.scope,
      scope_sha256: binding.scope_sha256,
      holder_revision: binding.holder_revision,
      iat: binding.created_at,
      exp: binding.created_at + POSTGRES_POOL.permission_ms,
    }),
    key.privateKey,
    now,
  );
}
export async function readDesiredPostgresPoolBinding(
  env: Env,
  id: string,
  now = Date.now(),
): Promise<DesiredPoolBinding | undefined> {
  const state = await input(env, id);
  const capable = await postgresPoolCapable(env.DB, state.row.region_id);
  const qualification = capable
    ? undefined
    : await readPostgresPoolQualificationAuthority(
        env,
        id,
        state.row.generation,
        now,
      );
  if (!capable && !qualification) return undefined;
  const holder = await env.DB.prepare(
    "SELECT binding_id FROM database_runtime_holders WHERE database_id=? AND kind='pool'",
  )
    .bind(id)
    .first<{ binding_id: string }>();
  if (!holder) return undefined;
  const row = await bindingRow(env, holder.binding_id);
  if (!row) throw conflict("Pool holder has no binding outcome");
  const binding = bindingFrom(row);
  if ((await poolBindingScopeHash(binding.scope)) !== binding.scope_sha256)
    throw conflict();
  // Keep stale/nonterminal ownership visible with no permission; it must detach before any CNPG start.
  const token =
    ["claimed", "mounted"].includes(binding.state) &&
    scopeMatches(state, binding) &&
    binding.created_at + POSTGRES_POOL.permission_ms > now
      ? await permission(env, binding, now)
      : null;
  const storageAuthority =
    binding.scope.storage.backend === "lvm-thin-v1"
      ? await (
          await import("./node-thin-storage.ts")
        ).issuePostgresPoolStorageAuthority(env, binding, now)
      : undefined;
  return {
    binding,
    storage_authority: storageAuthority ?? null,
    authority:
      scopeMatches(state, binding) &&
      ["claimed", "mounted", "serving"].includes(binding.state)
        ? "current"
        : "revoked",
    permission: token,
  };
}
export type PoolClaimResult =
  | { kind: "hit"; binding: PoolBinding; permission: string }
  | { kind: "miss"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "disabled" };
export interface PreparedPostgresPoolClaim {
  statements: D1PreparedStatement[];
  finish: () => Promise<PoolClaimResult>;
}
export async function preparePostgresPoolClaim(
  env: Env,
  id: string,
  wakeGeneration: number,
  mutation: AdmissionMutation,
  /** The database's region, when the caller has just read its row. */
  regionId?: string,
): Promise<PreparedPostgresPoolClaim> {
  const region =
    regionId ??
    (await env.DB.prepare("SELECT region_id FROM databases WHERE id=?")
      .bind(id)
      .first<string>("region_id"));
  if (!region) throw new ApiError("not_found", "Database not found");
  const [capable, pendingRun] = await Promise.all([
    postgresPoolCapable(env.DB, region),
    env.DB.prepare(
      "SELECT id FROM postgres_pool_qualification_runs WHERE database_id=? AND status IN('running','cleanup')",
    )
      .bind(id)
      .first(),
  ]);
  if (!capable && !pendingRun)
    return { statements: [], finish: async () => ({ kind: "disabled" }) };
  const state = await input(env, id),
    { row } = state;
  const qualification = pendingRun
    ? await readPostgresPoolQualificationAuthority(env, id, wakeGeneration)
    : undefined;
  if (pendingRun && !qualification)
    return {
      statements: [],
      finish: async () => ({
        kind: "blocked",
        reason: "qualification_run_not_current",
      }),
    };
  const mutationGuard = mutation.guard(id);
  const guard: AdmissionSqlGuard = qualification
    ? {
        sql: `(${mutationGuard.sql}) AND (${qualification.fence.sql})`,
        bindings: [...mutationGuard.bindings, ...qualification.fence.bindings],
      }
    : mutationGuard;
  const intent = mutation.intents.find((i) => i.database_id === id)!;
  if (
    wakeGeneration !== row.generation + 1 ||
    row.mutation_id !== intent.mutation_id
  )
    throw conflict();
  const holder = await env.DB.prepare(
    "SELECT * FROM database_runtime_holders WHERE database_id=?",
  )
    .bind(id)
    .first<{
      kind: string;
      revision: number;
      binding_id: string | null;
      state: string;
      clean_stop: number | null;
      sleep_json: string | null;
    }>();
  if (holder && !terminal(holder.state))
    return {
      statements: [],
      finish: async () => ({
        kind: "blocked",
        reason: "previous_holder_unresolved",
      }),
    };
  const now = Date.now(),
    attempt = crypto.randomUUID();
  const miss = (reason: string): PreparedPostgresPoolClaim =>
    qualification
      ? { statements: [], finish: async () => ({ kind: "blocked", reason }) }
      : {
          statements: [
            env.DB.prepare(
              `INSERT INTO pool_claim_attempts(id,database_id,generation,mutation_id,outcome,reason,created_at) SELECT ?,?,?,?,'miss',?,? WHERE ${guard.sql}`,
            ).bind(
              attempt,
              id,
              wakeGeneration,
              intent.mutation_id,
              reason,
              now,
              ...guard.bindings,
            ),
          ],
          finish: async () => {
            const receipt = await env.DB.prepare(
              "SELECT outcome,reason FROM pool_claim_attempts WHERE id=? AND mutation_id=?",
            )
              .bind(attempt, intent.mutation_id)
              .first<{ outcome: string; reason: string }>();
            return receipt?.outcome === "miss"
              ? { kind: "miss", reason: receipt.reason }
              : { kind: "blocked", reason: "claim_commit_unconfirmed" };
          },
        };
  // A parked database's own Pod still holds the volume mounted, whatever an older clean sleep says.
  if (row.parked_json) return miss("parked_pod_holds_volume");
  if (!holder?.sleep_json || holder.clean_stop !== 1)
    return miss("no_verified_clean_sleep");
  const sleep = PoolSleepRecord.safeParse(JSON.parse(holder.sleep_json));
  if (
    !sleep.success ||
    !poolStorageProfileMatches(row.storage_profile_json, sleep.data.storage) ||
    !row.ever_ready ||
    !row.node_id ||
    !row.node_uid ||
    !row.boot_id ||
    sleep.data.generation !== row.generation ||
    sleep.data.node_uid !== row.node_uid ||
    sleep.data.boot_id !== row.boot_id ||
    sleep.data.configuration_fingerprint !== state.fingerprint ||
    !equal(sleep.data.class, state.class)
  )
    return miss("ineligible_sleep_identity");
  const policyRow = await env.DB.prepare(
    "SELECT policy_json,revision FROM node_postgres_pool_policies WHERE node_id=? AND node_uid=?",
  )
    .bind(row.node_id, row.node_uid)
    .first<{ policy_json: string; revision: number }>();
  if (!policyRow && !qualification) return miss("pool_policy_missing");
  const policy =
    qualification?.policy ??
    PostgresPoolPolicy.parse(JSON.parse(policyRow!.policy_json));
  const policyRevision = qualification ? 1 : policyRow!.revision;
  if (
    qualification &&
    (sleep.data.storage.backend !== "lvm-thin-v1" ||
      sleep.data.storage.thin_id !== qualification.scope.thin_id)
  )
    return miss("qualification_volume_mismatch");
  if (policy.target_slots === 0 || !equal(policy.class, state.class))
    return miss("pool_class_unavailable");
  const storageRow = await env.DB.prepare(
    "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
  )
    .bind(id)
    .first<{ observation_json: string }>();
  const storage = PoolStorageObservation.safeParse(
    storageRow ? JSON.parse(storageRow.observation_json) : null,
  );
  if (
    !storage.success ||
    !fresh(storage.data.observed_at, now) ||
    storage.data.generation !== row.generation ||
    storage.data.node_uid !== row.node_uid ||
    storage.data.boot_id !== row.boot_id ||
    !equal(storage.data.storage, sleep.data.storage) ||
    storage.data.kernel_proof.dm_open_count !== 0 ||
    storage.data.kernel_proof.foreign_mounts !== 0 ||
    !storage.data.kernel_proof.named_namespace_scan_complete
  )
    return miss("volume_precheck_unavailable");
  const podRow = await env.DB.prepare(
    "SELECT * FROM pool_pods WHERE node_id=? AND node_uid=? AND boot_id=? AND policy_revision=? AND state='ready' AND binding_id IS NULL AND last_observed_at>? AND qualification_run_id IS ? AND qualification_scope_sha256 IS ? ORDER BY first_observed_at,pod_uid LIMIT 1",
  )
    .bind(
      row.node_id,
      row.node_uid,
      row.boot_id,
      policyRevision,
      now - POSTGRES_POOL.observation_max_age_ms,
      qualification?.run_id ?? null,
      qualification?.scope_sha256 ?? null,
    )
    .first<Record<string, unknown>>();
  if (!podRow) return miss("no_eligible_free_pool_pod");
  const pod = PoolPodAttestation.parse(
    JSON.parse(podRow.attestation_json as string),
  );
  if (
    !equal(pod.class, state.class) ||
    pod.supervisor_sha256 !== policy.supervisor_sha256 ||
    !fresh(pod.observed_at, now)
  )
    return miss("pool_pod_attestation_stale");
  const bindingId = crypto.randomUUID(),
    scope = PoolBindingScope.parse({
      v: 1,
      binding_id: bindingId,
      database_id: id,
      generation: wakeGeneration,
      route_revision: intent.route_revision + 1,
      admission_epoch: intent.admission_revision + 1,
      configuration_fingerprint: state.fingerprint,
      region_id: row.region_id,
      node_id: row.node_id,
      node_uid: row.node_uid,
      boot_id: row.boot_id,
      pool_namespace: pod.pool_namespace,
      pool_namespace_uid: pod.pool_namespace_uid,
      container_ids: pod.container_ids,
      pool_pod_uid: pod.pool_pod_uid,
      pool_pod_name: pod.pool_pod_name,
      pool_pod_ip: pod.pool_pod_ip,
      container_id: pod.container_id,
      supervisor_key_sha256: pod.supervisor_key_sha256,
      supervisor_sha256: pod.supervisor_sha256,
      driver_image: policy.driver_image,
      driver_sha256: policy.driver_sha256,
      host_controller_sha256: policy.host_controller_sha256,
      class: state.class,
      storage: sleep.data.storage,
      system_identifier: sleep.data.system_identifier,
      timeline: sleep.data.timeline,
      bundle_nonce: crypto.randomUUID(),
    });
  const hash = await poolBindingScopeHash(scope),
    serialized = JSON.stringify(scope),
    revision = holder.revision + 1;
  const statements = [
    env.DB.prepare(
      `UPDATE pool_pods SET state='claimed',binding_id=? WHERE pod_uid=? AND state='ready' AND binding_id IS NULL AND node_uid=? AND boot_id=? AND policy_revision=? AND attestation_json=?
      AND EXISTS(SELECT 1 FROM database_runtime_holders h WHERE h.database_id=? AND h.revision=? AND h.state IN('released','refused') AND h.sleep_json=?) AND (${guard.sql})`,
    ).bind(
      bindingId,
      pod.pool_pod_uid,
      row.node_uid,
      row.boot_id,
      policyRevision,
      podRow.attestation_json,
      id,
      holder.revision,
      holder.sleep_json,
      ...guard.bindings,
    ),
    env.DB.prepare(
      `INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,scope_sha256,scope_json,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,? WHERE EXISTS(SELECT 1 FROM pool_pods p WHERE p.pod_uid=? AND p.binding_id=?) AND (${guard.sql})`,
    ).bind(
      bindingId,
      id,
      row.node_id,
      row.node_uid,
      row.boot_id,
      pod.pool_pod_uid,
      wakeGeneration,
      scope.route_revision,
      scope.admission_epoch,
      revision,
      hash,
      serialized,
      now,
      now,
      pod.pool_pod_uid,
      bindingId,
      ...guard.bindings,
    ),
    env.DB.prepare(
      `UPDATE database_runtime_holders SET kind='pool',revision=?,binding_id=?,state='claimed',clean_stop=NULL,sleep_json=NULL,updated_at=? WHERE database_id=? AND revision=? AND state IN('released','refused') AND EXISTS(SELECT 1 FROM pool_bindings b WHERE b.id=? AND b.database_id=database_runtime_holders.database_id) AND (${guard.sql})`,
    ).bind(
      revision,
      bindingId,
      now,
      id,
      holder.revision,
      bindingId,
      ...guard.bindings,
    ),
    env.DB.prepare(
      `INSERT INTO pool_claim_attempts(id,database_id,generation,mutation_id,outcome,reason,binding_id,created_at) SELECT ?,?,?,?,
      CASE WHEN EXISTS(SELECT 1 FROM database_runtime_holders h WHERE h.database_id=? AND h.binding_id=?) THEN 'hit' ELSE ${qualification ? "NULL" : "'miss'"} END,
      CASE WHEN EXISTS(SELECT 1 FROM database_runtime_holders h WHERE h.database_id=? AND h.binding_id=?) THEN NULL ELSE 'pool_pod_claim_race' END,
      (SELECT id FROM pool_bindings WHERE id=?),? WHERE ${mutationGuard.sql}`,
    ).bind(
      attempt,
      id,
      wakeGeneration,
      intent.mutation_id,
      id,
      bindingId,
      id,
      bindingId,
      bindingId,
      now,
      ...mutationGuard.bindings,
    ),
  ];
  return {
    statements,
    finish: async () => {
      const receipt = await env.DB.prepare(
        "SELECT outcome,reason,binding_id FROM pool_claim_attempts WHERE id=? AND mutation_id=?",
      )
        .bind(attempt, intent.mutation_id)
        .first<{
          outcome: string;
          reason: string | null;
          binding_id: string | null;
        }>();
      if (!receipt)
        return { kind: "blocked", reason: "claim_commit_unconfirmed" };
      if (receipt.outcome === "miss")
        return { kind: "miss", reason: receipt.reason! };
      const actual = await readDesiredPostgresPoolBinding(env, id);
      if (
        !actual?.permission ||
        actual.binding.scope.binding_id !== receipt.binding_id
      )
        return { kind: "blocked", reason: "claim_authority_changed" };
      await env.REGION_LINK.get(
        env.REGION_LINK.idFromName(actual.binding.scope.region_id),
      ).notifyPoolBinding(actual.binding.scope.node_id, actual);
      return {
        kind: "hit",
        binding: actual.binding,
        permission: actual.permission,
      };
    },
  };
}

/** A missing or unconfirmed cleanup outcome never authorizes a second CNPG writer. */
export function hasNonterminalPoolHolderSql(databaseAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseAlias))
    throw new Error("invalid_database_sql_alias");
  return `(EXISTS(SELECT 1 FROM pool_bindings phb WHERE phb.database_id=${databaseAlias}.id AND phb.state NOT IN('released','refused'))
    OR EXISTS(SELECT 1 FROM database_runtime_holders phh WHERE phh.database_id=${databaseAlias}.id AND phh.kind='pool' AND phh.state NOT IN('released','refused')))`;
}
export function postgresPoolCnpgWakeGuard(id: string) {
  return {
    sql: "NOT EXISTS(SELECT 1 FROM pool_bindings WHERE database_id=? AND state NOT IN('released','refused')) AND NOT EXISTS(SELECT 1 FROM database_runtime_holders WHERE database_id=? AND kind='pool' AND state NOT IN('released','refused'))",
    bindings: [id, id],
  };
}
/** Prefix the owning guarded batch, before business SQL: every writer revokes an existing holder, never releases it. */
export function postgresPoolMutationStatements(
  env: Env,
  mutation: AdmissionMutation,
): D1PreparedStatement[] {
  return mutation.intents.flatMap((intent) => {
    const guard = mutation.guard(intent.database_id);
    return [
      env.DB.prepare(
        `UPDATE pool_bindings SET state='detaching',updated_at=?,detaching_at=COALESCE(detaching_at,?) WHERE database_id=? AND state IN('claimed','mounted','serving') AND ${guard.sql}`,
      ).bind(Date.now(), Date.now(), intent.database_id, ...guard.bindings),
      env.DB.prepare(
        `UPDATE database_runtime_holders SET state='detaching',sleep_json=NULL,updated_at=? WHERE database_id=? AND kind='pool' AND state IN('claimed','mounted','serving') AND ${guard.sql}`,
      ).bind(Date.now(), intent.database_id, ...guard.bindings),
    ];
  });
}
function physicalMatches(
  proof: DatabaseRuntimeAttestation,
  storage: PoolSleepRecord["storage"],
) {
  return (
    proof.storage_generation === storage.storage_generation &&
    proof.namespace_uid === storage.namespace_uid &&
    proof.cnpg_cluster_uid === storage.cnpg_cluster_uid &&
    proof.storage_uid === storage.storage_uid &&
    proof.pvc_uid === storage.pvc_uid &&
    proof.pv_uid === storage.pv_uid
  );
}
export async function recordPostgresPoolStorageObservation(
  env: Env,
  id: string,
  value: PoolStorageObservation,
) {
  const observation = PoolStorageObservation.parse(value),
    state = await input(env, id),
    now = Date.now();
  const runtime = DatabaseRuntimeAttestation.safeParse(
    state.row.runtime_attestation_json
      ? JSON.parse(state.row.runtime_attestation_json)
      : null,
  );
  if (
    observation.database_id !== id ||
    observation.generation !== state.row.generation ||
    observation.node_uid !== state.row.node_uid ||
    observation.boot_id !== state.row.boot_id ||
    !fresh(observation.observed_at, now) ||
    !runtime.success ||
    !physicalMatches(runtime.data, observation.storage) ||
    !poolStorageProfileMatches(
      state.row.storage_profile_json,
      observation.storage,
    ) ||
    !poolReceiptMatches(
      state.row.storage_volume_json,
      observation.storage,
      observation.node_uid,
    )
  )
    throw conflict("Pool physical storage identity is unavailable or changed");
  const previous = await env.DB.prepare(
    "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
  )
    .bind(id)
    .first<{ observation_json: string }>();
  if (
    previous &&
    !equal(
      PoolStorageObservation.parse(JSON.parse(previous.observation_json))
        .storage,
      observation.storage,
    )
  )
    throw conflict("Pool physical storage identity is immutable");
  const result = await env.DB.prepare(
    `INSERT INTO pool_storage_observations(database_id,node_id,observation_json,observed_at)
    SELECT id,node_id,?,? FROM databases WHERE id=? AND generation=? AND node_id=? AND storage_profile_json IS ?
    AND storage_volume_json IS ?
    AND EXISTS(SELECT 1 FROM nodes n JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid WHERE n.id=databases.node_id AND n.node_uid=? AND json_extract(o.facts_json,'$.boot_id')=?)
    ON CONFLICT(database_id) DO UPDATE SET observation_json=excluded.observation_json,observed_at=excluded.observed_at WHERE pool_storage_observations.observed_at<=excluded.observed_at`,
  )
    .bind(
      JSON.stringify(observation),
      observation.observed_at,
      id,
      observation.generation,
      state.row.node_id,
      state.row.storage_profile_json,
      state.row.storage_volume_json,
      observation.node_uid,
      observation.boot_id,
    )
    .run();
  if (result.meta.changes !== 1) throw conflict();
}
export async function recordPostgresPoolSleep(
  env: Env,
  id: string,
  value: PoolSleepRecord,
) {
  const sleep = PoolSleepRecord.parse(value),
    state = await input(env, id),
    now = Date.now();
  const observationRow = await env.DB.prepare(
    "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
  )
    .bind(id)
    .first<{ observation_json: string }>();
  const observation = PoolStorageObservation.safeParse(
    observationRow ? JSON.parse(observationRow.observation_json) : null,
  );
  if (
    sleep.database_id !== id ||
    sleep.generation !== state.row.generation ||
    sleep.node_uid !== state.row.node_uid ||
    sleep.boot_id !== state.row.boot_id ||
    !fresh(sleep.observed_at, now) ||
    state.row.observed_state !== "provisioning" ||
    state.row.observed_generation !== state.row.generation ||
    state.row.observed_power !== "hibernated" ||
    state.row.parked_json ||
    sleep.configuration_fingerprint !== state.fingerprint ||
    !equal(sleep.class, state.class) ||
    !observation.success ||
    !fresh(observation.data.observed_at, now) ||
    !equal(observation.data.storage, sleep.storage) ||
    observation.data.kernel_proof.dm_open_count !== 0 ||
    observation.data.kernel_proof.foreign_mounts !== 0 ||
    !observation.data.kernel_proof.named_namespace_scan_complete
  )
    throw conflict(
      "Clean CNPG sleep and complete volume release are not verified",
    );
  const unresolved = await env.DB.prepare(
    "SELECT 1 FROM pool_bindings WHERE database_id=? AND state NOT IN('released','refused')",
  )
    .bind(id)
    .first();
  if (unresolved) throw conflict("Previous pool holder has not released");
  await withAdmissionMutation(env, [id], async (mutation) => {
    const guard = mutation.guard(id);
    const result = await mutation.batch([
      env.DB.prepare(
        `INSERT INTO database_runtime_holders(database_id,kind,revision,binding_id,state,clean_stop,sleep_json,updated_at)
      SELECT id,'cnpg',1,NULL,'released',1,?,? FROM databases WHERE id=? AND generation=? AND (${guard.sql})
      ON CONFLICT(database_id) DO UPDATE SET kind='cnpg',revision=database_runtime_holders.revision+1,binding_id=NULL,state='released',clean_stop=1,sleep_json=excluded.sleep_json,updated_at=excluded.updated_at
      WHERE database_runtime_holders.kind='cnpg' OR database_runtime_holders.state IN('released','refused')`,
      ).bind(
        JSON.stringify(sleep),
        now,
        id,
        sleep.generation,
        ...guard.bindings,
      ),
    ]);
    if (result[0]!.meta.changes !== 1) throw conflict();
  });
}
export { recordPostgresPoolInventory } from "./postgres-pool-inventory.ts";
export async function readPostgresPoolAdmissionBinding(
  env: Env,
  id: string,
  proof?: DatabasePoolRuntimeAttestationV2,
  now = Date.now(),
): Promise<PoolBinding | null> {
  const state = await input(env, id);
  if (!(await postgresPoolCapable(env.DB, state.row.region_id))) return null;
  const holder = await env.DB.prepare(
    "SELECT binding_id,revision,state FROM database_runtime_holders WHERE database_id=? AND kind='pool'",
  )
    .bind(id)
    .first<{ binding_id: string; revision: number; state: string }>();
  if (!holder || holder.state !== "serving") return null;
  const row = await bindingRow(env, holder.binding_id);
  if (!row) return null;
  const binding = bindingFrom(row),
    scope = binding.scope;
  if (
    binding.state !== "serving" ||
    holder.revision !== binding.holder_revision ||
    !scopeMatches(state, binding) ||
    state.row.desired_state !== "running" ||
    (await poolBindingScopeHash(scope)) !== binding.scope_sha256
  )
    return null;
  const node = PoolNodeReport.safeParse(
    row.node_report_json ? JSON.parse(row.node_report_json as string) : null,
  );
  const verified = DatabasePoolRuntimeAttestationV2.safeParse(
    proof ??
      (row.controller_report_json
        ? JSON.parse(row.controller_report_json as string)
        : null),
  );
  if (
    !node.success ||
    !(await thinGuardMatches(env, node.data, binding, now)) ||
    !creatorProofMatches(node.data, binding) ||
    node.data.state !== "mounted" ||
    !fresh(node.data.observed_at, now) ||
    node.data.scope_sha256 !== binding.scope_sha256 ||
    node.data.node_uid !== scope.node_uid ||
    node.data.boot_id !== scope.boot_id ||
    node.data.pool_pod_uid !== scope.pool_pod_uid ||
    !verified.success ||
    verified.data.observation.expires_at <= now ||
    verified.data.observed_at > now + POSTGRES_POOL.clock_skew_ms
  )
    return null;
  const p = verified.data;
  if (
    p.pool_namespace_uid !== scope.pool_namespace_uid ||
    p.binding_id !== scope.binding_id ||
    p.scope_sha256 !== binding.scope_sha256 ||
    p.holder_revision !== binding.holder_revision ||
    p.database_id !== id ||
    p.generation !== scope.generation ||
    p.route_revision !== state.row.route_revision ||
    p.admission_epoch !== state.row.admission_revision ||
    p.node_uid !== scope.node_uid ||
    p.boot_id !== scope.boot_id ||
    p.pod_uid !== scope.pool_pod_uid ||
    p.pod_ip !== scope.pool_pod_ip ||
    p.container_id !== scope.container_id ||
    p.postgres_image_sha256 !== scope.class.postgres_image_sha256 ||
    p.configuration_fingerprint !== scope.configuration_fingerprint ||
    p.memory_request_bytes !== scope.class.memory_request_bytes ||
    p.memory_limit_bytes !== scope.class.memory_limit_bytes ||
    !physicalMatches(p, scope.storage) ||
    p.tls_server_name !== `database-rw.pgcf-db-${id}.svc` ||
    p.region_id !== scope.region_id
  )
    return null;
  return binding;
}

async function referenceDestructionFence(
  env: Env,
  binding: PoolBinding,
  report: PoolNodeReport,
): Promise<AdmissionSqlGuard & { completed: AdmissionSqlGuard }> {
  const witness = report.reference_destruction!,
    scope = binding.scope;
  const grant = await readPostgresPoolCleanupGrant(
    env,
    scope.binding_id,
    witness.operation_id,
  );
  const raw = await env.DB.prepare(
    "SELECT attestation_json FROM pool_cleanup_io_attestations WHERE binding_id=? AND operation_id=?",
  )
    .bind(scope.binding_id, witness.operation_id)
    .first<string>("attestation_json");
  const parsed = PoolCleanupIoAttestation.safeParse(
    raw ? JSON.parse(raw) : null,
  );
  if (
    !grant ||
    !grant.authority_token ||
    !["issued", "failed"].includes(grant.state) ||
    !parsed.success
  )
    throw conflict("Retained cleanup dispatch is unavailable");
  const io = parsed.data,
    claims = grant.claims;
  const verified = await verifyPoolCleanupAuthority(
    grant.authority_token,
    await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    ),
    claims.iat,
  );
  // Verify the retained historical dispatch signature; this read-only release grants no new IO.
  const stopped = (rows: typeof io.stopped_writers) =>
    [...rows].sort((a, b) => a.container_id.localeCompare(b.container_id));
  if (
    !verified ||
    !equal(verified, claims) ||
    report.boot_id !== scope.boot_id ||
    claims.boot_id !== scope.boot_id ||
    io.boot_id !== scope.boot_id ||
    io.binding_id !== scope.binding_id ||
    io.scope_sha256 !== binding.scope_sha256 ||
    io.holder_revision !== binding.holder_revision ||
    claims.authority_revision !== witness.authority_revision ||
    claims.cleanup_mode !== "drain_unmount" ||
    witness.cleanup_io_sha256 !== claims.cleanup_io_sha256 ||
    (await poolCleanupIoAttestationHash(io)) !== claims.cleanup_io_sha256 ||
    !equal(witness.worker, io.worker) ||
    !equal(stopped(witness.stopped_writers), stopped(io.stopped_writers)) ||
    io.worker.executable_sha256 !== scope.host_controller_sha256 ||
    report.kernel_proof.device_major !== claims.device_major ||
    report.kernel_proof.device_minor !== claims.device_minor
  )
    throw conflict(
      "Reference destruction differs from its exact retained cleanup dispatch",
    );
  return {
    sql: "EXISTS(SELECT 1 FROM pool_cleanup_grants g JOIN pool_cleanup_io_attestations i ON i.binding_id=g.binding_id AND i.operation_id=g.operation_id WHERE g.binding_id=? AND g.operation_id=? AND g.state=? AND g.claims_json=? AND g.authority_token=? AND i.attestation_json=?)",
    bindings: [
      scope.binding_id,
      witness.operation_id,
      grant.state,
      JSON.stringify(claims),
      grant.authority_token,
      raw,
    ],
    completed: {
      sql: "EXISTS(SELECT 1 FROM pool_cleanup_grants g JOIN pool_cleanup_io_attestations i ON i.binding_id=g.binding_id AND i.operation_id=g.operation_id WHERE g.binding_id=? AND g.operation_id=? AND g.state='completed' AND g.claims_json=? AND g.authority_token=? AND i.attestation_json=?)",
      bindings: [
        scope.binding_id,
        witness.operation_id,
        JSON.stringify(claims),
        grant.authority_token,
        raw,
      ],
    },
  };
}

export async function recordPostgresPoolNodeReport(
  env: Env,
  bindingId: string,
  value: PoolNodeReport,
) {
  const report = PoolNodeReport.parse(value),
    row = await bindingRow(env, bindingId);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  const binding = bindingFrom(row),
    scope = binding.scope,
    node = await currentNode(env, scope.node_id),
    now = Date.now();
  if (
    !creatorProofMatches(report, binding) ||
    report.binding_id !== bindingId ||
    report.scope_sha256 !== binding.scope_sha256 ||
    report.node_uid !== scope.node_uid ||
    report.node_uid !== node.node_uid ||
    report.boot_id !== node.boot_id ||
    report.pool_pod_uid !== scope.pool_pod_uid ||
    !fresh(report.observed_at, now) ||
    (report.state !== "lost" &&
      !terminal(report.state) &&
      report.boot_id !== scope.boot_id)
  )
    throw conflict("Node outcome does not match the authoritative binding");
  if (
    report.boot_loss &&
    (report.boot_loss.holder_boot_id !== scope.boot_id ||
      report.boot_id === scope.boot_id ||
      !equal(report.boot_loss.storage, scope.storage))
  )
    throw conflict("Post-boot absence differs from the immutable lost holder");
  let lossFence: AdmissionSqlGuard | undefined;
  if (report.boot_loss || report.reference_destruction) {
    lossFence =
      (await readPostgresPoolFleetFence(env.DB, scope.region_id)) ??
      (await readPostgresPoolFleetFence(env.DB, scope.region_id, true));
    const raw = await env.DB.prepare(
      "SELECT s.spec_json FROM fleet_node_releases a JOIN fleet_releases s ON s.id=a.release_id WHERE a.node_id=? AND a.node_uid=?",
    )
      .bind(scope.node_id, scope.node_uid)
      .first<string>("spec_json");
    const spec = raw ? FleetReleaseSpec.parse(JSON.parse(raw)) : undefined;
    if (
      !lossFence ||
      spec?.components.find((c) => c.name === "openebs-lvm")?.reference !==
        scope.driver_image ||
      (spec.postgres_pool_qualification?.driver_sha256 ??
        spec.postgres_pool_candidate?.driver_sha256) !== scope.driver_sha256
    )
      throw conflict(
        "Current guarded CSI software is not confirmed for lost-holder release",
      );
  }
  if (
    report.state === "mounted" &&
    !(await thinGuardMatches(env, report, binding, now))
  )
    throw conflict(
      "Thin write authority or actual cgroup IO protection is unavailable",
    );
  if (
    report.state === "refused" &&
    (row.mounted_at !== null ||
      row.served_at !== null ||
      row.controller_report_json !== null ||
      row.supervisor_report_json !== null ||
      ["mounted", "serving"].includes(binding.state))
  )
    throw conflict(
      "A previously mounted holder requires a verified physical release",
    );
  if (report.state === "accepted" || report.state === "mounted") {
    const state = await input(env, scope.database_id);
    if (
      !scopeMatches(state, binding) ||
      !["claimed", "mounted", "serving"].includes(binding.state) ||
      (binding.state === "claimed" &&
        report.observed_at >= binding.created_at + POSTGRES_POOL.permission_ms)
    )
      throw conflict("Pool mount authority is no longer current");
    const next =
      report.state === "mounted" && binding.state === "claimed"
        ? "mounted"
        : binding.state;
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE pool_bindings SET state=?,node_report_json=?,updated_at=?,mounted_at=CASE WHEN ?='mounted' THEN COALESCE(mounted_at,?) ELSE mounted_at END WHERE id=? AND scope_sha256=? AND state=?
        AND EXISTS(SELECT 1 FROM databases d JOIN database_admission_epochs ae ON ae.database_id=d.id WHERE d.id=pool_bindings.database_id AND d.generation=pool_bindings.generation
          AND ((pool_bindings.state='serving' AND ae.route_revision>=pool_bindings.route_revision AND ae.admission_revision>=pool_bindings.admission_epoch)
          OR (pool_bindings.state<>'serving' AND ae.route_revision=pool_bindings.route_revision AND ae.admission_revision=pool_bindings.admission_epoch)) AND ae.mutation_id IS NULL)`,
      ).bind(
        next,
        JSON.stringify(report),
        now,
        report.state,
        report.observed_at,
        bindingId,
        binding.scope_sha256,
        binding.state,
      ),
      env.DB.prepare(
        "UPDATE database_runtime_holders SET state=?,updated_at=? WHERE database_id=? AND binding_id=? AND revision=? AND EXISTS(SELECT 1 FROM pool_bindings b WHERE b.id=? AND b.state=? AND b.node_report_json=?)",
      ).bind(
        next,
        now,
        scope.database_id,
        bindingId,
        binding.holder_revision,
        bindingId,
        next,
        JSON.stringify(report),
      ),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) throw conflict();
    await hintPostgresPoolProgress(env, binding);
    return;
  }
  if (terminal(binding.state)) {
    if (
      binding.state === report.state &&
      row.node_report_json === JSON.stringify(report)
    )
      return;
    throw conflict("Pool cleanup outcome is immutable");
  }
  const destruction = report.reference_destruction
    ? await referenceDestructionFence(env, binding, report)
    : undefined;
  const target = report.state;
  const recoveryOperation =
    report.boot_loss || report.reference_destruction
      ? newOperationId()
      : undefined;
  const recoveryNow = new Date(now).toISOString();
  await withAdmissionMutation(env, [scope.database_id], async (mutation) => {
    const originalGuard = mutation.guard(scope.database_id);
    const guards = [
      originalGuard,
      ...(lossFence ? [lossFence] : []),
      ...(destruction ? [destruction] : []),
    ];
    const guard: AdmissionSqlGuard = {
      sql: guards.map((g) => `(${g.sql})`).join(" AND "),
      bindings: guards.flatMap((g) => g.bindings),
    };
    const results = await mutation.batch([
      env.DB.prepare(
        `UPDATE pool_bindings SET state=?,node_report_json=?,updated_at=? WHERE id=? AND scope_sha256=? AND state NOT IN('released','refused')
        AND (?!='refused' OR (mounted_at IS NULL AND served_at IS NULL AND controller_report_json IS NULL AND supervisor_report_json IS NULL)) AND ${guard.sql}`,
      ).bind(
        target,
        JSON.stringify(report),
        now,
        bindingId,
        binding.scope_sha256,
        target,
        ...guard.bindings,
      ),
      env.DB.prepare(
        `UPDATE database_runtime_holders SET state=?,clean_stop=?,sleep_json=NULL,updated_at=? WHERE database_id=? AND binding_id=? AND revision=? AND ${guard.sql}`,
      ).bind(
        target,
        report.clean_stop === null ? null : Number(report.clean_stop),
        now,
        scope.database_id,
        bindingId,
        binding.holder_revision,
        ...guard.bindings,
      ),
      env.DB.prepare(
        `UPDATE pool_pods SET state=? WHERE pod_uid=? AND binding_id=? AND ${guard.sql}`,
      ).bind(
        target === "lost" ? "lost" : "retired",
        scope.pool_pod_uid,
        bindingId,
        ...guard.bindings,
      ),
      env.DB.prepare(
        `UPDATE databases SET observed_state='provisioning',observed_power='hibernated',runtime_attestation_json=NULL
        WHERE id=? AND desired_state='running' AND generation=? AND ? IN('released','refused')
        AND json_extract(runtime_attestation_json,'$.kind')='pool' AND json_extract(runtime_attestation_json,'$.binding_id')=?
        AND json_extract(runtime_attestation_json,'$.scope_sha256')=? AND json_extract(runtime_attestation_json,'$.generation')=generation AND ${guard.sql}`,
      ).bind(
        scope.database_id,
        scope.generation,
        target,
        bindingId,
        binding.scope_sha256,
        ...guard.bindings,
      ),
      ...(recoveryOperation
        ? [
            env.DB.prepare(
              `UPDATE databases SET desired_state='suspended',suspension_reason='idle',power_operation=?,generation=generation+1,
          observed_state='provisioning',observed_power='hibernated',runtime_attestation_json=NULL,status_message=NULL,
          storage_protected_at=NULL,storage_protected_generation=NULL,storage_protected_operation=NULL,updated_at=?
          WHERE id=? AND generation=? AND desired_state='running' AND deleted_at IS NULL
          AND (runtime_attestation_json IS NULL OR (json_extract(runtime_attestation_json,'$.kind')='pool' AND json_extract(runtime_attestation_json,'$.binding_id')=?))
          AND EXISTS(SELECT 1 FROM pool_bindings b WHERE b.id=? AND b.state='released' AND b.node_report_json=?) AND ${guard.sql}`,
            ).bind(
              recoveryOperation,
              recoveryNow,
              scope.database_id,
              scope.generation,
              bindingId,
              bindingId,
              JSON.stringify(report),
              ...guard.bindings,
            ),
            env.DB.prepare(
              `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
          SELECT ?,'database.hibernate','pending',project_id,id,generation,?,? FROM databases
          WHERE id=? AND generation=? AND power_operation=? AND desired_state='suspended' AND suspension_reason='idle' AND ${guard.sql}`,
            ).bind(
              recoveryOperation,
              recoveryNow,
              recoveryNow,
              scope.database_id,
              scope.generation + 1,
              recoveryOperation,
              ...guard.bindings,
            ),
            env.DB.prepare(
              `UPDATE operations SET status='failed',error_code='superseded',error_message='Power intent superseded after verified unclean pool release',updated_at=?,completed_at=?
          WHERE database_id=? AND generation<? AND kind IN('database.suspend','database.resume','database.hibernate','database.wake') AND status IN('pending','running')
          AND EXISTS(SELECT 1 FROM databases WHERE id=? AND power_operation=? AND generation=?) AND ${guard.sql}`,
            ).bind(
              recoveryNow,
              recoveryNow,
              scope.database_id,
              scope.generation + 1,
              scope.database_id,
              recoveryOperation,
              scope.generation + 1,
              ...guard.bindings,
            ),
          ]
        : []),
      env.DB.prepare(
        `UPDATE pool_cleanup_grants SET state='completed',updated_at=? WHERE binding_id=? AND ? IN('released','refused')
        AND EXISTS(SELECT 1 FROM pool_bindings b WHERE b.id=pool_cleanup_grants.binding_id AND b.state=? AND b.node_report_json=?)
        AND ${guard.sql}`,
      ).bind(
        now,
        bindingId,
        target,
        target,
        JSON.stringify(report),
        ...guard.bindings,
      ),
      env.DB.prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM pool_bindings b JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id
         WHERE b.id=? AND b.scope_sha256=? AND b.state=? AND b.node_report_json=? AND h.state=b.state AND h.revision=? ) AND (${destruction?.completed.sql ?? "1"}) THEN 'true' ELSE '' END)`,
      ).bind(
        bindingId,
        binding.scope_sha256,
        target,
        JSON.stringify(report),
        binding.holder_revision,
        ...(destruction?.completed.bindings ?? []),
      ),
      ...(terminal(target)
        ? postgresPoolCnpgSelectionStatements(env.DB, {
            databaseId: scope.database_id,
            now,
            guard: originalGuard,
          })
        : []),
    ]);
    if (results[0]!.meta.changes !== 1 || results[1]!.meta.changes !== 1)
      throw conflict();
  });
  await (
    await import("./roles.ts")
  ).finalizeDeferredPoolRoleChange(env, scope.database_id);
  await hintPostgresPoolProgress(env, binding);
}
export async function recordPostgresPoolServing(
  env: Env,
  bindingId: string,
  proof: DatabasePoolRuntimeAttestationV2,
  supervisor: PoolSupervisorReport,
) {
  const p = DatabasePoolRuntimeAttestationV2.parse(proof),
    report = PoolSupervisorReport.parse(supervisor),
    row = await bindingRow(env, bindingId);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  const binding = bindingFrom(row),
    scope = binding.scope,
    state = await input(env, scope.database_id),
    now = Date.now();
  const node = PoolNodeReport.safeParse(
    row.node_report_json ? JSON.parse(row.node_report_json as string) : null,
  );
  if (
    !scopeMatches(state, binding) ||
    !["mounted", "serving"].includes(binding.state) ||
    !node.success ||
    !(await thinGuardMatches(env, node.data, binding, now)) ||
    !creatorProofMatches(node.data, binding) ||
    node.data.state !== "mounted" ||
    !fresh(node.data.observed_at, now) ||
    report.state !== "ready" ||
    report.binding_id !== bindingId ||
    report.scope_sha256 !== binding.scope_sha256 ||
    report.bundle_nonce !== scope.bundle_nonce ||
    report.system_identifier !== scope.system_identifier ||
    report.timeline !== scope.timeline ||
    !fresh(report.observed_at, now) ||
    p.binding_id !== bindingId ||
    p.scope_sha256 !== binding.scope_sha256 ||
    p.holder_revision !== binding.holder_revision ||
    p.database_id !== scope.database_id ||
    p.generation !== scope.generation ||
    p.route_revision !== state.row.route_revision ||
    p.admission_epoch !== state.row.admission_revision ||
    p.node_uid !== scope.node_uid ||
    p.boot_id !== scope.boot_id ||
    p.pod_uid !== scope.pool_pod_uid ||
    p.pod_ip !== scope.pool_pod_ip ||
    p.container_id !== scope.container_id ||
    !physicalMatches(p, scope.storage) ||
    p.configuration_fingerprint !== state.fingerprint ||
    p.postgres_image_sha256 !== scope.class.postgres_image_sha256 ||
    p.memory_request_bytes !== scope.class.memory_request_bytes ||
    p.memory_limit_bytes !== scope.class.memory_limit_bytes ||
    p.observation.expires_at <= now
  )
    throw conflict(
      "Pool readiness is not jointly verified by controller, supervisor and node",
    );
  const roles = [...p.applied_role_revisions].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (
    !equal(
      roles,
      state.roles.map(({ name, revision }) => ({ name, revision })),
    ) ||
    p.tls_server_name !== `database-rw.pgcf-db-${scope.database_id}.svc`
  )
    throw conflict();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE pool_bindings SET state='serving',controller_report_json=?,supervisor_report_json=?,updated_at=?,served_at=COALESCE(served_at,?) WHERE id=? AND scope_sha256=? AND state IN('mounted','serving')
      AND EXISTS(SELECT 1 FROM databases d JOIN database_admission_epochs ae ON ae.database_id=d.id WHERE d.id=pool_bindings.database_id AND d.generation=pool_bindings.generation
        AND ae.route_revision=? AND ae.admission_revision=? AND ae.mutation_id IS NULL)`,
    ).bind(
      JSON.stringify(p),
      JSON.stringify(report),
      now,
      report.observed_at,
      bindingId,
      binding.scope_sha256,
      p.route_revision,
      p.admission_epoch,
    ),
    env.DB.prepare(
      "UPDATE database_runtime_holders SET state='serving',updated_at=? WHERE database_id=? AND binding_id=? AND revision=? AND EXISTS(SELECT 1 FROM pool_bindings WHERE id=? AND state='serving')",
    ).bind(
      now,
      scope.database_id,
      bindingId,
      binding.holder_revision,
      bindingId,
    ),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) throw conflict();
  await hintPostgresPoolProgress(env, binding);
}
export { postgresPoolIdleChargeSql } from "./startup-admission.ts";

/** Cross-record comparison is separate from structural Zod proof validation. */
function creatorProofMatches(report: PoolNodeReport, binding: PoolBinding) {
  const fence = report.kernel_proof.creator_fence,
    storage = binding.scope.storage;
  return (
    (report.state !== "mounted" &&
      report.boot_loss === undefined &&
      report.reference_destruction === undefined) ||
    (fence !== null &&
      fence.scope_sha256 === binding.scope_sha256 &&
      fence.storage_uid === storage.storage_uid &&
      fence.volume_handle === storage.volume_handle &&
      fence.volume_group_uuid === storage.volume_group_uuid &&
      fence.lv_uuid === storage.lv_uuid &&
      fence.driver_image === binding.scope.driver_image &&
      fence.driver_sha256 === binding.scope.driver_sha256)
  );
}

export async function getPostgresPoolPolicy(c: ApiContext, nodeId: string) {
  const { requireScope } = await import("../middleware/auth.ts");
  await requireScope(c, "admin");
  const row = await c.env.DB.prepare(
    "SELECT p.*,n.region_id FROM node_postgres_pool_policies p JOIN nodes n ON n.id=p.node_id WHERE p.node_id=?",
  )
    .bind(nodeId)
    .first<Record<string, unknown>>();
  if (!row)
    throw new ApiError(
      "not_found",
      "PostgreSQL Pod pool policy not configured",
    );
  return c.json(
    PostgresPoolPolicyState.parse({
      node_id: row.node_id,
      node_uid: row.node_uid,
      region_id: row.region_id,
      revision: row.revision,
      policy: JSON.parse(row.policy_json as string),
      updated_at: row.updated_at,
    }),
  );
}
export async function setPostgresPoolPolicy(
  c: ApiContext,
  nodeId: string,
  body: {
    expected_revision: number;
    node_uid: string;
    policy: PostgresPoolPolicy;
  },
) {
  const { requireScope } = await import("../middleware/auth.ts"),
    { withIdempotency } = await import("../middleware/idempotency.ts");
  await requireScope(c, "admin");
  const policy = PostgresPoolPolicy.parse(body.policy),
    release = await c.env.DB.prepare(
      "SELECT spec_json FROM fleet_releases WHERE id=?",
    )
      .bind(policy.release_id)
      .first<{ spec_json: string }>();
  if (!release)
    throw conflict("Pool policy requires an approved qualified release");
  const spec = FleetReleaseSpec.parse(JSON.parse(release.spec_json)),
    q = spec.postgres_pool_qualification;
  if (
    spec.postgres_pool_version !== 1 ||
    !q ||
    q.supervisor_sha256 !== policy.supervisor_sha256 ||
    q.host_controller_sha256 !== policy.host_controller_sha256 ||
    q.postgres_image_sha256 !== policy.class.postgres_image_sha256 ||
    q.driver_image !== policy.driver_image ||
    q.driver_sha256 !== policy.driver_sha256 ||
    q.archiver_image_sha256 !== policy.archiver_sha256 ||
    spec.components.find((c) => c.name === "pool-supervisor")?.reference !==
      policy.supervisor_image ||
    spec.components.find((c) => c.name === "barman")?.reference !==
      policy.archiver_image
  )
    throw conflict("Pool policy differs from its qualified software pins");
  await assertPostgresPoolQualificationReceipt(c.env.DB, q);
  return withIdempotency(c, {
    replay: () => getPostgresPoolPolicy(c, nodeId),
    execute: async (lease) => {
      const previous = await c.env.DB.prepare(
        "SELECT * FROM node_postgres_pool_policies WHERE node_id=?",
      )
        .bind(nodeId)
        .first<{ node_uid: string; revision: number; policy_json: string }>();
      if (
        (previous?.revision ?? 0) !== body.expected_revision ||
        (previous && previous.node_uid !== body.node_uid)
      )
        throw conflict("Compute policy revision changed");
      const old = previous
        ? PostgresPoolPolicy.parse(JSON.parse(previous.policy_json))
        : null;
      const effective = (p: PostgresPoolPolicy) =>
        JSON.stringify([
          p.class,
          p.driver_image,
          p.driver_sha256,
          p.supervisor_image,
          p.supervisor_sha256,
          p.archiver_image,
          p.archiver_sha256,
          p.release_id,
        ]);
      const changed = !old || effective(old) !== effective(policy),
        next = body.expected_revision + 1,
        now = new Date().toISOString(),
        serialized = JSON.stringify(policy);
      const open = {
        sql: "NOT EXISTS(SELECT 1 FROM admission_scope_fences WHERE kind='node' AND scope_id=? AND mutation_id IS NOT NULL)",
        bindings: [nodeId],
      };
      const statements = (guard: AdmissionSqlGuard = open) => [
        c.env.DB.prepare(
          `INSERT INTO node_postgres_pool_policies(node_id,node_uid,revision,release_id,policy_json,updated_at)
        SELECT id,node_uid,?,?,?,? FROM nodes WHERE id=? AND node_uid=? AND ready=1 AND lost_at IS NULL AND ?=0 AND NOT EXISTS(SELECT 1 FROM node_postgres_pool_policies WHERE node_id=nodes.id)
        AND NOT EXISTS(SELECT 1 FROM node_compute_pool_policies cp WHERE cp.node_id=nodes.id AND json_extract(cp.policy_json,'$.target_slots')>0)
        AND ?<=allocatable_cpu_millicores AND ?<=allocatable_memory_mib AND (${guard.sql}) ON CONFLICT(node_id) DO NOTHING`,
        ).bind(
          next,
          policy.release_id,
          serialized,
          now,
          nodeId,
          body.node_uid,
          body.expected_revision,
          policy.max_idle_cpu_millicores,
          policy.max_idle_memory_mib,
          ...guard.bindings,
        ),
        c.env.DB.prepare(
          `UPDATE node_postgres_pool_policies SET revision=?,release_id=?,policy_json=?,updated_at=? WHERE node_id=? AND node_uid=? AND revision=? AND policy_json=?
        AND NOT EXISTS(SELECT 1 FROM node_compute_pool_policies cp WHERE cp.node_id=node_postgres_pool_policies.node_id AND json_extract(cp.policy_json,'$.target_slots')>0)
        AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=node_id AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND ?<=n.allocatable_cpu_millicores AND ?<=n.allocatable_memory_mib) AND (${guard.sql})`,
        ).bind(
          next,
          policy.release_id,
          serialized,
          now,
          nodeId,
          body.node_uid,
          body.expected_revision,
          previous?.policy_json ?? "",
          body.node_uid,
          policy.max_idle_cpu_millicores,
          policy.max_idle_memory_mib,
          ...guard.bindings,
        ),
        lease.completeStatement(nodeId, 200, {
          sql: `EXISTS(SELECT 1 FROM node_postgres_pool_policies WHERE node_id=? AND revision=? AND policy_json=?) AND (${guard.sql})`,
          bindings: [nodeId, next, serialized, ...guard.bindings],
        }),
      ];
      const check = (results: D1Result[]) => {
        if (results[0]!.meta.changes + results[1]!.meta.changes !== 1)
          throw conflict(
            "Current node budget, revision or competing pool policy changed",
          );
      };
      if (changed)
        await withAdmissionMutation(
          c.env,
          [],
          async (mutation) => {
            check(await mutation.batch(statements(mutation.scopeGuard())));
          },
          { kind: "node", id: nodeId },
        );
      else check(await c.env.DB.batch(statements()));
      return getPostgresPoolPolicy(c, nodeId);
    },
  });
}

export async function getPostgresPoolBindingSnapshot(
  c: ApiContext,
  nodeId: string,
  after = 0,
  waitMs = 0,
) {
  const region = await agentRegion(c),
    node = await currentNode(c.env, nodeId, region.id);
  if (
    !(await postgresPoolCapable(c.env.DB, region.id)) &&
    !(await postgresPoolQualificationCapable(c.env.DB, region.id))
  )
    throw conflict("The complete PostgreSQL pool fleet is unavailable");
  const link = c.env.REGION_LINK.get(c.env.REGION_LINK.idFromName(region.id));
  const rows = await c.env.DB.prepare(
    "SELECT database_id FROM database_runtime_holders WHERE kind='pool' AND state NOT IN('released','refused') AND database_id IN(SELECT id FROM databases WHERE node_id=?) ORDER BY database_id LIMIT 257",
  )
    .bind(nodeId)
    .all<{ database_id: string }>();
  if (rows.results.length > POSTGRES_POOL.max_inventory)
    throw conflict("Bounded holder inventory is incomplete");
  const authoritative: DesiredPoolBinding[] = [];
  for (const row of rows.results) {
    const binding = await readDesiredPostgresPoolBinding(
      c.env,
      row.database_id,
    );
    if (!binding) throw conflict("Authoritative pool holder is unavailable");
    authoritative.push(binding);
  }
  await link.replacePoolBindings(nodeId, authoritative);
  const delivery = await link.waitForPoolBinding(
    nodeId,
    after,
    Date.now() + waitMs,
  );
  const now = Date.now();
  return c.json(
    PoolBindingSnapshot.parse({
      v: 1,
      revision: delivery?.revision ?? after,
      node_id: nodeId,
      node_uid: node.node_uid,
      boot_id: node.boot_id,
      issued_at: now,
      expires_at: now + POSTGRES_POOL.permission_ms,
      bindings: delivery?.bindings ?? [],
    }),
    200,
  );
}
export async function authorizePostgresPoolNode(c: ApiContext, nodeId: string) {
  const region = await agentRegion(c);
  return currentNode(c.env, nodeId, region.id);
}
export async function authorizePostgresPoolDatabase(c: ApiContext, id: string) {
  const region = await agentRegion(c),
    state = await input(c.env, id);
  if (state.row.region_id !== region.id || !state.row.node_id)
    throw new ApiError("not_found", "Database not found");
  await currentNode(c.env, state.row.node_id, region.id);
}
export async function authorizePostgresPoolBinding(c: ApiContext, id: string) {
  const row = await bindingRow(c.env, id);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  await authorizePostgresPoolDatabase(c, bindingFrom(row).scope.database_id);
}
export async function recordPostgresPoolSupervisorReport(
  env: Env,
  id: string,
  value: PoolSupervisorReport,
) {
  const report = PoolSupervisorReport.parse(value),
    row = await bindingRow(env, id);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  const binding = bindingFrom(row),
    scope = binding.scope;
  if (
    report.binding_id !== id ||
    report.scope_sha256 !== binding.scope_sha256 ||
    report.bundle_nonce !== scope.bundle_nonce ||
    report.system_identifier !== scope.system_identifier ||
    report.timeline !== scope.timeline ||
    report.state !== "stopped" ||
    !fresh(report.observed_at, Date.now()) ||
    !["detaching", "failed"].includes(binding.state)
  )
    throw conflict("Clean stop does not match the held volume");
  const result = await env.DB.prepare(
    "UPDATE pool_bindings SET supervisor_report_json=?,updated_at=? WHERE id=? AND scope_sha256=? AND state IN('detaching','failed')",
  )
    .bind(JSON.stringify(report), Date.now(), id, binding.scope_sha256)
    .run();
  if (result.meta.changes !== 1) throw conflict();
  await hintPostgresPoolProgress(env, binding);
}

function poolStorageProfileMatches(
  serialized: string | null,
  storage: PoolSleepRecord["storage"],
): boolean {
  return storage.backend === "lvm-thin-v1"
    ? serialized !== null &&
        equal(
          DesiredDatabaseStorage.parse(JSON.parse(serialized)),
          storage.profile,
        )
    : serialized === null;
}
function poolReceiptMatches(
  serialized: string | null,
  storage: PoolSleepRecord["storage"],
  nodeUid: string,
): boolean {
  const receipt = DatabaseStorageVolumeReceipt.safeParse(
    serialized ? JSON.parse(serialized) : null,
  );
  if (!receipt.success) return false;
  const value = receipt.data;
  return (
    value.node_uid === nodeUid &&
    value.storage_generation === storage.storage_generation &&
    value.storage_uid === storage.storage_uid &&
    value.namespace_uid === storage.namespace_uid &&
    value.cluster_uid === storage.cnpg_cluster_uid &&
    value.pvc_uid === storage.pvc_uid &&
    value.pv_uid === storage.pv_uid &&
    value.volume_handle === storage.volume_handle &&
    value.volume_group_uuid === storage.volume_group_uuid &&
    value.lv_uuid === storage.lv_uuid &&
    (storage.backend !== "lvm-thin-v1" ||
      value.pool_uuid === storage.profile.pool_uuid)
  );
}
function ioMatches(
  binding: PoolBinding,
  attestation: PoolIoAttestation,
): boolean {
  const scope = binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1") return false;
  const profile = scope.storage.profile;
  const ids = [...scope.container_ids].sort(),
    observed = attestation.cgroups.map((c) => c.container_id).sort();
  return (
    attestation.binding_id === scope.binding_id &&
    attestation.scope_sha256 === binding.scope_sha256 &&
    attestation.node_uid === scope.node_uid &&
    attestation.boot_id === scope.boot_id &&
    attestation.pool_namespace_uid === scope.pool_namespace_uid &&
    attestation.pool_pod_uid === scope.pool_pod_uid &&
    equal(ids, observed) &&
    attestation.device.volume_group_uuid === scope.storage.volume_group_uuid &&
    attestation.device.lv_uuid === scope.storage.lv_uuid &&
    attestation.device.thin_id === scope.storage.thin_id &&
    attestation.shared_pod_io.device_major ===
      attestation.device.device_major &&
    attestation.shared_pod_io.device_minor ===
      attestation.device.device_minor &&
    attestation.shared_pod_io.write_bytes_per_second ===
      profile.write_bytes_per_second &&
    attestation.shared_pod_io.write_iops_per_second ===
      profile.write_iops_per_second &&
    attestation.cgroups.every(
      (c) =>
        c.write_bytes_per_second === profile.write_bytes_per_second &&
        c.write_iops_per_second === profile.write_iops_per_second &&
        c.device_major === attestation.device.device_major &&
        c.device_minor === attestation.device.device_minor,
    )
  );
}
function ioCustodyMatches(
  state: Awaited<ReturnType<typeof input>>,
  binding: PoolBinding,
  detachingAt: unknown,
  now: number,
): boolean {
  const { row } = state,
    scope = binding.scope;
  if (
    scope.storage.backend !== "lvm-thin-v1" ||
    !["claimed", "mounted", "serving", "detaching"].includes(binding.state) ||
    row.deleted_at !== null ||
    row.project_deleted_at !== null ||
    row.node_id !== scope.node_id ||
    row.node_uid !== scope.node_uid ||
    row.boot_id !== scope.boot_id ||
    row.lost_at !== null ||
    row.ready !== 1 ||
    !poolStorageProfileMatches(row.storage_profile_json, scope.storage) ||
    !poolReceiptMatches(row.storage_volume_json, scope.storage, scope.node_uid)
  )
    return false;
  if (binding.state !== "detaching") return scopeMatches(state, binding);
  return (
    typeof detachingAt === "number" &&
    now < detachingAt + scope.storage.profile.drain_seconds * 1000 &&
    row.generation >= scope.generation &&
    row.route_revision >= scope.route_revision &&
    row.admission_revision >= scope.admission_epoch &&
    row.mutation_id === null
  );
}
export async function readPostgresPoolIoAttestation(
  env: Env,
  binding: PoolBinding,
  now = Date.now(),
): Promise<PoolIoAttestation | undefined> {
  const current = await bindingRow(env, binding.scope.binding_id);
  if (!current) return undefined;
  const actual = bindingFrom(current);
  if (
    actual.scope_sha256 !== binding.scope_sha256 ||
    actual.holder_revision !== binding.holder_revision ||
    !ioCustodyMatches(
      await input(env, binding.scope.database_id),
      actual,
      current.detaching_at,
      now,
    )
  )
    return undefined;
  const row = await env.DB.prepare(
    "SELECT i.attestation_json FROM pool_io_attestations i JOIN database_runtime_holders h ON h.binding_id=i.binding_id WHERE i.binding_id=? AND h.revision=? AND h.state=?",
  )
    .bind(binding.scope.binding_id, binding.holder_revision, actual.state)
    .first<{ attestation_json: string }>();
  const parsed = PoolIoAttestation.safeParse(
    row ? JSON.parse(row.attestation_json) : null,
  );
  return parsed.success &&
    fresh(parsed.data.observed_at, now) &&
    ioMatches(binding, parsed.data)
    ? parsed.data
    : undefined;
}
export async function recordPostgresPoolIoAttestation(
  env: Env,
  id: string,
  value: PoolIoAttestation,
) {
  const attestation = PoolIoAttestation.parse(value),
    row = await bindingRow(env, id);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  const binding = bindingFrom(row),
    state = await input(env, binding.scope.database_id);
  const now = Date.now();
  if (
    !ioCustodyMatches(state, binding, row.detaching_at, now) ||
    !fresh(attestation.observed_at, now) ||
    !ioMatches(binding, attestation)
  )
    throw conflict("IO custody does not match the current bounded pool holder");
  const physical = await env.DB.prepare(
    "SELECT observation_json FROM pool_storage_observations WHERE database_id=?",
  )
    .bind(binding.scope.database_id)
    .first<string>("observation_json");
  const measured = PoolStorageObservation.safeParse(
    physical ? JSON.parse(physical) : null,
  );
  if (
    !measured.success ||
    !equal(measured.data.storage, binding.scope.storage) ||
    measured.data.kernel_proof.device_major !==
      attestation.device.device_major ||
    measured.data.kernel_proof.device_minor !== attestation.device.device_minor
  )
    throw conflict("IO device does not match the observed thin LV");
  const result = await env.DB.prepare(
    `INSERT INTO pool_io_attestations(binding_id,attestation_json,observed_at) SELECT id,?,? FROM pool_bindings WHERE id=? AND state=? AND scope_sha256=? AND detaching_at IS ?
    AND EXISTS(SELECT 1 FROM database_runtime_holders h WHERE h.binding_id=pool_bindings.id AND h.revision=pool_bindings.holder_revision AND h.state=pool_bindings.state)
    AND EXISTS(SELECT 1 FROM databases d JOIN database_admission_epochs e ON e.database_id=d.id
      WHERE d.id=pool_bindings.database_id AND d.generation=? AND d.node_id=? AND d.storage_profile_json IS ? AND d.storage_volume_json IS ?
      AND e.route_revision=? AND e.admission_revision=? AND e.mutation_id IS NULL)
    AND EXISTS(SELECT 1 FROM pool_storage_observations p WHERE p.database_id=pool_bindings.database_id AND p.observation_json=?)
    ON CONFLICT(binding_id) DO UPDATE SET attestation_json=excluded.attestation_json,observed_at=excluded.observed_at WHERE pool_io_attestations.observed_at<=excluded.observed_at`,
  )
    .bind(
      JSON.stringify(attestation),
      attestation.observed_at,
      id,
      binding.state,
      binding.scope_sha256,
      row.detaching_at,
      state.row.generation,
      state.row.node_id,
      state.row.storage_profile_json,
      state.row.storage_volume_json,
      state.row.route_revision,
      state.row.admission_revision,
      physical,
    )
    .run();
  if (result.meta.changes !== 1) throw conflict();
  await hintPostgresPoolProgress(env, binding);
}
async function thinGuardMatches(
  env: Env,
  report: PoolNodeReport,
  binding: PoolBinding,
  now = Date.now(),
): Promise<boolean> {
  const scope = binding.scope;
  if (report.storage_backend !== scope.storage.backend) return false;
  if (scope.storage.backend !== "lvm-thin-v1")
    return report.thin_guard === null;
  const guard = report.thin_guard;
  if (!guard) return false;
  const claims = await verifyStorageWriteAuthority(
    guard.authority_token,
    await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS) as Record<string, string>,
    ),
    now,
  );
  const profile = scope.storage.profile;
  return (
    !!claims &&
    claims.write_allowed &&
    claims.generation === scope.generation &&
    claims.database_id === scope.database_id &&
    claims.node_uid === scope.node_uid &&
    claims.storage_uid === scope.storage.storage_uid &&
    claims.volume_group_uuid === scope.storage.volume_group_uuid &&
    claims.pool_uuid === profile.pool_uuid &&
    claims.profile_sha256 === profile.profile_sha256 &&
    claims.volume_handle === scope.storage.volume_handle &&
    claims.lv_uuid === scope.storage.lv_uuid &&
    claims.pvc_uid === scope.storage.pvc_uid &&
    claims.pv_uid === scope.storage.pv_uid &&
    claims.pod_uid === scope.pool_pod_uid &&
    guard.authority_revision === claims.authority_revision &&
    guard.expires_at === claims.exp &&
    ioMatches(binding, {
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: binding.scope_sha256,
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      pool_namespace_uid: scope.pool_namespace_uid,
      pool_pod_uid: scope.pool_pod_uid,
      observed_at: report.observed_at,
      device: {
        volume_group_uuid: scope.storage.volume_group_uuid,
        lv_uuid: scope.storage.lv_uuid,
        thin_id: scope.storage.thin_id,
        device_major: report.kernel_proof.device_major,
        device_minor: report.kernel_proof.device_minor,
      },
      cgroups: guard.cgroups,
      shared_pod_io: guard.shared_pod_io,
    }) &&
    guard.cgroups.every(
      (c) =>
        c.device_major === report.kernel_proof.device_major &&
        c.device_minor === report.kernel_proof.device_minor,
    )
  );
}

export async function readPostgresPoolBinding(
  env: Env,
  id: string,
): Promise<PoolBinding | undefined> {
  const row = await bindingRow(env, id);
  if (!row) return undefined;
  const binding = bindingFrom(row);
  return (await poolBindingScopeHash(binding.scope)) === binding.scope_sha256
    ? binding
    : undefined;
}
/**
 * The pool holders of every database that `scope` (a predicate over `databases d`) selects, in one
 * statement: a row for each database with a binding or holder row that is not terminal
 * (`hasNonterminalPoolHolderSql`), carrying the binding whose holder row agrees with it.
 */
export function postgresPoolHoldersStatement(
  db: D1Database,
  scope: { sql: string; bindings: unknown[] },
) {
  return db
    .prepare(
      `SELECT d.id database_id,b.scope_json,b.scope_sha256,b.holder_revision,b.state,b.created_at,b.updated_at,h.binding_id holder_binding
    FROM databases d
    LEFT JOIN pool_bindings b ON b.database_id=d.id AND b.state NOT IN('released','refused')
    LEFT JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id AND h.revision=b.holder_revision AND h.kind='pool' AND h.state=b.state
    WHERE (${scope.sql}) AND ${hasNonterminalPoolHolderSql("d")}`,
    )
    .bind(...scope.bindings);
}
/** The result of `postgresPoolHoldersStatement`: which databases have an unresolved pool holder,
 * and the binding of each whose holder row agrees and whose scope hash holds. */
export async function readPostgresPoolHolders(
  rows: readonly Record<string, unknown>[],
) {
  const bindings = new Map<string, PoolBinding>(),
    unresolved = new Set<string>();
  for (const row of rows) {
    const id = row.database_id as string;
    unresolved.add(id);
    if (row.scope_json === null || row.holder_binding === null) continue;
    const binding = bindingFrom(row);
    if ((await poolBindingScopeHash(binding.scope)) === binding.scope_sha256)
      bindings.set(id, binding);
  }
  return { bindings, unresolved };
}
export async function readPostgresPoolBindingForDatabase(
  env: Env,
  id: string,
): Promise<PoolBinding | undefined> {
  const rows = await postgresPoolHoldersStatement(env.DB, {
    sql: "d.id=?",
    bindings: [id],
  }).all<Record<string, unknown>>();
  return (await readPostgresPoolHolders(rows.results)).bindings.get(id);
}

export interface PostgresPoolCleanupGrant {
  claims: PoolCleanupClaims;
  authority_token: string | null;
  state: "reserved" | "issued" | "failed" | "completed";
  headroom_authority_revision: number;
  headroom_snapshot_sha256: string;
  created_at: number;
  updated_at: number;
}
export async function readPostgresPoolCleanupGrant(
  env: Env,
  bindingId: string,
  operationId?: string,
): Promise<PostgresPoolCleanupGrant | undefined> {
  const row = await env.DB.prepare(
    `SELECT * FROM pool_cleanup_grants WHERE binding_id=? ${operationId === undefined ? "AND state<>'completed'" : "AND operation_id=?"} ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(bindingId, ...(operationId === undefined ? [] : [operationId]))
    .first<Record<string, unknown>>();
  if (!row) return undefined;
  const claims = PoolCleanupClaims.parse(JSON.parse(row.claims_json as string)),
    binding = await readPostgresPoolBinding(env, bindingId);
  if (
    !binding ||
    claims.binding_id !== bindingId ||
    claims.scope_sha256 !== binding.scope_sha256 ||
    claims.holder_revision !== binding.holder_revision ||
    claims.holder_generation !== binding.scope.generation ||
    claims.database_id !== binding.scope.database_id ||
    claims.node_uid !== binding.scope.node_uid ||
    !equal(claims.storage, binding.scope.storage)
  )
    throw conflict("Stored cleanup scope differs from its immutable holder");
  return {
    claims,
    authority_token: row.authority_token as string | null,
    state: row.state as PostgresPoolCleanupGrant["state"],
    headroom_authority_revision: row.headroom_authority_revision as number,
    headroom_snapshot_sha256: row.headroom_snapshot_sha256 as string,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

/** Includes retained terminal history, so disappearance is never a cleanup acknowledgment. */
export async function getPostgresPoolBindingDetails(c: ApiContext, id: string) {
  await authorizePostgresPoolBinding(c, id);
  const row = await bindingRow(c.env, id);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  const binding = bindingFrom(row);
  if ((await poolBindingScopeHash(binding.scope)) !== binding.scope_sha256)
    throw conflict();
  const pod = await c.env.DB.prepare(
    "SELECT attestation_json FROM pool_pods WHERE pod_uid=? AND node_id=? AND node_uid=? AND boot_id=?",
  )
    .bind(
      binding.scope.pool_pod_uid,
      binding.scope.node_id,
      binding.scope.node_uid,
      binding.scope.boot_id,
    )
    .first<string>("attestation_json");
  if (!pod) throw conflict("Attested pool runtime is unavailable");
  const desired = terminal(binding.state)
    ? undefined
    : await readDesiredPostgresPoolBinding(c.env, binding.scope.database_id);
  return c.json(
    PoolBindingDetails.parse({
      binding: desired ?? {
        binding,
        authority: "revoked",
        permission: null,
        storage_authority: null,
      },
      pod_attestation: PoolPodAttestation.parse(JSON.parse(pod)),
      node_report: row.node_report_json
        ? PoolNodeReport.parse(JSON.parse(row.node_report_json as string))
        : null,
      io_attestation:
        (await readPostgresPoolIoAttestation(c.env, binding)) ?? null,
      supervisor_report: row.supervisor_report_json
        ? PoolSupervisorReport.parse(
            JSON.parse(row.supervisor_report_json as string),
          )
        : null,
    }),
    200,
  );
}

const cleanupOperationSql =
  () => `(EXISTS(SELECT 1 FROM pool_role_mutations q WHERE q.id=? AND q.binding_id=? AND q.holder_revision=?
  AND q.expected_generation=? AND q.database_id=? AND q.status IN('pending','failed')) OR EXISTS(SELECT 1 FROM databases d JOIN operations o ON o.database_id=d.id
  WHERE d.id=? AND d.generation=? AND o.id=? AND ${currentStorageStopSql("d", "o")}))`;
function cleanupOperationBindings(
  value: PoolCleanupIoAttestation,
  databaseId: string,
) {
  return [
    value.operation_id,
    value.binding_id,
    value.holder_revision,
    value.holder_generation,
    databaseId,
    databaseId,
    value.database_generation,
    value.operation_id,
  ];
}
async function cleanupIoContext(
  env: Env,
  binding: PoolBinding,
  value: PoolCleanupIoAttestation,
  now: number,
) {
  const scope = binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1") return undefined;
  const node = await currentNode(env, scope.node_id),
    profile = scope.storage.profile;
  const host = await readPostgresPoolHostController(
    env,
    scope.node_id,
    scope.node_uid,
  );
  if (
    !host ||
    host.sha256 !== scope.host_controller_sha256 ||
    value.worker.executable_sha256 !== host.sha256
  )
    return undefined;
  if (
    value.binding_id !== scope.binding_id ||
    value.scope_sha256 !== binding.scope_sha256 ||
    value.holder_revision !== binding.holder_revision ||
    value.holder_generation !== scope.generation ||
    value.node_uid !== scope.node_uid ||
    node.node_uid !== scope.node_uid ||
    value.boot_id !== node.boot_id ||
    value.boot_id !== scope.boot_id ||
    value.worker.pool_pod_uid !== scope.pool_pod_uid ||
    value.worker.container_id !== scope.container_id ||
    !fresh(value.observed_at, now) ||
    !equal(
      [...value.stopped_writers.map((w) => w.container_id)].sort(),
      [...scope.container_ids].sort(),
    ) ||
    value.device.volume_group_uuid !== scope.storage.volume_group_uuid ||
    value.device.lv_uuid !== scope.storage.lv_uuid ||
    value.device.thin_id !== scope.storage.thin_id ||
    value.shared_pod_io.write_bytes_per_second !==
      profile.write_bytes_per_second ||
    value.shared_pod_io.write_iops_per_second !== profile.write_iops_per_second
  )
    return undefined;
  const holder = await env.DB.prepare(
    `SELECT 1 FROM database_runtime_holders h JOIN databases d ON d.id=h.database_id
    WHERE h.database_id=? AND h.binding_id=? AND h.revision=? AND h.state IN('detaching','failed','lost') AND d.generation=? AND ${cleanupOperationSql()}`,
  )
    .bind(
      scope.database_id,
      scope.binding_id,
      binding.holder_revision,
      value.database_generation,
      ...cleanupOperationBindings(value, scope.database_id),
    )
    .first();
  const raw = await env.DB.prepare(
    "SELECT attestation_json FROM pool_pods WHERE pod_uid=? AND node_id=? AND node_uid=? AND boot_id=? AND state IN('ready','claimed')",
  )
    .bind(
      value.worker.pool_pod_uid,
      scope.node_id,
      scope.node_uid,
      node.boot_id,
    )
    .first<string>("attestation_json");
  const pod = PoolPodAttestation.safeParse(raw ? JSON.parse(raw) : null);
  // Retained inode lineage is identity evidence only, never a reused tenant authority.
  const oldRaw = await env.DB.prepare(
    "SELECT attestation_json FROM pool_io_attestations WHERE binding_id=?",
  )
    .bind(scope.binding_id)
    .first<string>("attestation_json");
  const old = PoolIoAttestation.safeParse(oldRaw ? JSON.parse(oldRaw) : null);
  if (
    !holder ||
    !pod.success ||
    !old.success ||
    !ioMatches(binding, old.data) ||
    !equal(
      [
        ...old.data.cgroups.map((c) => ({
          container_id: c.container_id,
          cgroup_inode: c.cgroup_inode,
          tenant_tasks_remaining: 0,
        })),
      ].sort((a, b) =>
        a.container_id < b.container_id
          ? -1
          : a.container_id > b.container_id
            ? 1
            : 0,
      ),
      [...value.stopped_writers].sort((a, b) =>
        a.container_id < b.container_id
          ? -1
          : a.container_id > b.container_id
            ? 1
            : 0,
      ),
    ) ||
    old.data.shared_pod_io.pod_cgroup_inode !==
      value.shared_pod_io.pod_cgroup_inode ||
    old.data.cgroups.find((c) => c.container_id === scope.container_id)
      ?.cgroup_inode !== value.worker.cgroup_inode ||
    !pod.data.container_ids.includes(value.worker.container_id) ||
    pod.data.supervisor_sha256 !== scope.supervisor_sha256 ||
    !equal(pod.data.class, scope.class)
  )
    return undefined;
  return { pod: raw!, node, oldIo: oldRaw!, host };
}
/** Actual new cleanup worker report; old tenant IO is never projected into this source. */
export async function recordPostgresPoolCleanupIoAttestation(
  env: Env,
  bindingId: string,
  value: PoolCleanupIoAttestation,
) {
  const report = PoolCleanupIoAttestation.parse(value),
    row = await bindingRow(env, bindingId);
  if (!row) throw new ApiError("not_found", "Pool binding not found");
  const binding = bindingFrom(row),
    context = await cleanupIoContext(env, binding, report, Date.now());
  if (
    !context ||
    bindingId !== report.binding_id ||
    (await poolBindingScopeHash(binding.scope)) !== binding.scope_sha256
  )
    throw conflict("Current cleanup-worker custody is unavailable");
  const result = await env.DB.prepare(
    `INSERT INTO pool_cleanup_io_attestations(binding_id,operation_id,attestation_json,observed_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM database_runtime_holders h JOIN databases d ON d.id=h.database_id
      JOIN pool_bindings b ON b.id=h.binding_id JOIN nodes n ON n.id=b.node_id JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid
      WHERE h.binding_id=? AND h.revision=? AND h.state IN('detaching','failed','lost') AND b.scope_sha256=? AND d.generation=?
      AND n.node_uid=? AND n.lost_at IS NULL AND json_extract(o.facts_json,'$.boot_id')=? AND ${cleanupOperationSql()})
    AND EXISTS(SELECT 1 FROM pool_pods p WHERE p.pod_uid=? AND p.attestation_json=? AND p.state IN('ready','claimed'))
    AND EXISTS(SELECT 1 FROM pool_io_attestations i WHERE i.binding_id=? AND i.attestation_json=?)
    AND EXISTS(SELECT 1 FROM node_compute_pool_policies p JOIN node_host_configurations h ON h.node_id=p.node_id AND h.node_uid=p.node_uid
      WHERE p.node_id=? AND p.node_uid=? AND p.policy_json=? AND h.profile_sha256=? AND h.sha256=?)
    AND (NOT EXISTS(SELECT 1 FROM pool_cleanup_grants g WHERE g.binding_id=? AND g.operation_id=?)
      OR EXISTS(SELECT 1 FROM pool_cleanup_io_attestations retained WHERE retained.binding_id=? AND retained.operation_id=? AND retained.attestation_json=?))
    ON CONFLICT(binding_id,operation_id) DO UPDATE SET attestation_json=excluded.attestation_json,observed_at=excluded.observed_at
    WHERE pool_cleanup_io_attestations.observed_at<=excluded.observed_at
      AND (NOT EXISTS(SELECT 1 FROM pool_cleanup_grants g WHERE g.binding_id=pool_cleanup_io_attestations.binding_id AND g.operation_id=pool_cleanup_io_attestations.operation_id)
        OR pool_cleanup_io_attestations.attestation_json=excluded.attestation_json)`,
  )
    .bind(
      bindingId,
      report.operation_id,
      JSON.stringify(report),
      report.observed_at,
      bindingId,
      binding.holder_revision,
      binding.scope_sha256,
      report.database_generation,
      report.node_uid,
      report.boot_id,
      ...cleanupOperationBindings(report, binding.scope.database_id),
      report.worker.pool_pod_uid,
      context.pod,
      bindingId,
      context.oldIo,
      binding.scope.node_id,
      binding.scope.node_uid,
      context.host.policy_json,
      context.host.profile_sha256,
      context.host.host_sha256,
      bindingId,
      report.operation_id,
      bindingId,
      report.operation_id,
      JSON.stringify(report),
    )
    .run();
  if (result.meta.changes !== 1)
    throw conflict("Cleanup operation changed before IO report commit");
}
export async function readPostgresPoolCleanupIoAttestation(
  env: Env,
  binding: PoolBinding,
  operationId: string,
  now = Date.now(),
): Promise<PoolCleanupIoAttestation | undefined> {
  const raw = await env.DB.prepare(
    "SELECT attestation_json FROM pool_cleanup_io_attestations WHERE binding_id=? AND operation_id=?",
  )
    .bind(binding.scope.binding_id, operationId)
    .first<string>("attestation_json");
  const report = PoolCleanupIoAttestation.safeParse(
    raw ? JSON.parse(raw) : null,
  );
  return report.success &&
    (await cleanupIoContext(env, binding, report.data, now))
    ? report.data
    : undefined;
}
