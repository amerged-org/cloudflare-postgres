// SPDX-License-Identifier: Apache-2.0
import {
  PoolPodPreparationContext,
  PostgresPoolPolicy,
  POSTGRES_POOL,
  PoolBindingScope,
  poolBindingScopeHash,
} from "@pgcf/contracts/postgres-pool";
import type { Env } from "../env.ts";
import { ApiError } from "../app.ts";
import { postgresPoolCapable } from "./fleet-releases.ts";
import { readPostgresPoolFleetFence } from "./postgres-pool-fleet-fence.ts";
import { readPostgresPoolNodeContext } from "./postgres-pool.ts";
import { readPostgresPoolQualificationSetup } from "./postgres-pool-qualification-authority.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export async function readPostgresPoolNodePolicy(
  env: Env,
  nodeId: string,
  now = Date.now(),
) {
  const node = await readPostgresPoolNodeContext(env, nodeId);
  if (await postgresPoolCapable(env.DB, node.region_id)) {
    const row = await env.DB.prepare(
      "SELECT p.* FROM node_postgres_pool_policies p JOIN fleet_node_releases a ON a.node_id=p.node_id AND a.node_uid=p.node_uid AND a.release_id=p.release_id WHERE p.node_id=? AND p.node_uid=?",
    )
      .bind(nodeId, node.node_uid)
      .first<{ policy_json: string; revision: number }>();
    if (!row) return undefined;
    const policy = PostgresPoolPolicy.parse(JSON.parse(row.policy_json));
    const fleet = await readPostgresPoolFleetFence(env.DB, node.region_id);
    if (!fleet) return undefined;
    const guard: AdmissionSqlGuard = {
      sql: `EXISTS(SELECT 1 FROM node_postgres_pool_policies p JOIN nodes n ON n.id=p.node_id JOIN regions r ON r.id=n.region_id
      WHERE p.node_id=? AND p.node_uid=? AND p.revision=? AND p.policy_json=? AND n.node_uid=p.node_uid AND n.ready=1 AND n.schedulable=1 AND n.lost_at IS NULL
        AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')
        AND EXISTS(SELECT 1 FROM fleet_node_releases a JOIN fleet_node_release_observations o ON o.node_id=a.node_id AND o.node_uid=a.node_uid AND o.assignment_revision=a.revision WHERE a.node_id=n.id AND a.node_uid=n.node_uid AND json_extract(o.facts_json,'$.boot_id')=? AND julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds'))) AND ${fleet.sql}`,
      bindings: [
        nodeId,
        node.node_uid,
        row.revision,
        row.policy_json,
        node.boot_id,
        ...fleet.bindings,
      ],
    };
    return {
      node,
      policy,
      revision: row.revision,
      qualification_run_id: undefined,
      qualification_scope_sha256: undefined,
      guard,
    };
  }
  const run = await env.DB.prepare(
    "SELECT database_id,database_generation FROM postgres_pool_qualification_runs WHERE node_id=? AND node_uid=? AND boot_id=? AND status='running' AND expires_at>?",
  )
    .bind(nodeId, node.node_uid, node.boot_id, now)
    .first<{ database_id: string; database_generation: number }>();
  if (!run) return undefined;
  const setup = await readPostgresPoolQualificationSetup(
    env,
    run.database_id,
    run.database_generation,
    now,
  );
  return setup
    ? {
        node,
        policy: setup.policy,
        revision: setup.policy_revision,
        qualification_run_id: setup.run_id,
        qualification_scope_sha256: setup.scope_sha256,
        guard: setup.fence,
      }
    : undefined;
}
function matches(
  context: PoolPodPreparationContext,
  policy: NonNullable<Awaited<ReturnType<typeof readPostgresPoolNodePolicy>>>,
  now: number,
) {
  return (
    context.node_id === policy.node.id &&
    context.node_uid === policy.node.node_uid &&
    context.boot_id === policy.node.boot_id &&
    context.policy_revision === policy.revision &&
    equal(context.policy, policy.policy) &&
    context.qualification_run_id === policy.qualification_run_id &&
    context.qualification_scope_sha256 === policy.qualification_scope_sha256 &&
    context.expires_at > now &&
    context.observed_at <= now + POSTGRES_POOL.clock_skew_ms &&
    context.observed_at > now - POSTGRES_POOL.observation_max_age_ms
  );
}
const boundWitnessSql = `SELECT json_group_array(json(j)) witness FROM (SELECT json_array(b.id,b.scope_json,b.scope_sha256,b.state,b.holder_revision,h.binding_id,h.revision,h.state) j FROM pool_bindings b LEFT JOIN database_runtime_holders h ON h.database_id=b.database_id WHERE b.node_id=? AND b.state NOT IN('released','refused') ORDER BY b.id)`;
async function boundPreparation(
  env: Env,
  nodeId: string,
  context: PoolPodPreparationContext,
) {
  const witness = await env.DB.prepare(boundWitnessSql)
    .bind(nodeId)
    .first<string>("witness");
  for (const row of JSON.parse(witness ?? "[]") as [
    string,
    string,
    string,
    string,
    number,
    string | null,
    number | null,
    string | null,
  ][]) {
    const [id, raw, sha, state, revision, holder, holderRevision, holderState] =
        row,
      scope = PoolBindingScope.parse(JSON.parse(raw));
    const pod = context.pods.find((p) => p.pod_uid === scope.pool_pod_uid);
    if (
      scope.binding_id !== id ||
      (await poolBindingScopeHash(scope)) !== sha ||
      holder !== id ||
      holderRevision !== revision ||
      holderState !== state ||
      scope.node_id !== nodeId ||
      scope.node_uid !== context.node_uid ||
      scope.boot_id !== context.boot_id ||
      scope.pool_namespace_uid !== context.pool_namespace_uid ||
      !pod ||
      pod.pod_name !== scope.pool_pod_name ||
      pod.pod_ip !== scope.pool_pod_ip ||
      !equal([...pod.container_ids].sort(), [...scope.container_ids].sort())
    )
      return undefined;
  }
  return {
    sql: `(${boundWitnessSql}) IS ?`,
    bindings: [nodeId, witness],
  } satisfies AdmissionSqlGuard;
}
/** A failed assertion aborts the entire real D1 batch, including trigger-side changes. */
function assertion(env: Env, guard: AdmissionSqlGuard) {
  return env.DB.prepare(
    `SELECT json(CASE WHEN (${guard.sql}) THEN 'true' ELSE '' END)`,
  ).bind(...guard.bindings);
}
/** The controller reports its authenticated Kubernetes read; CF derives the policy itself. */
export async function recordPostgresPoolPreparationContext(
  env: Env,
  nodeId: string,
  value: PoolPodPreparationContext,
  now = Date.now(),
) {
  const context = PoolPodPreparationContext.parse(value),
    policy = await readPostgresPoolNodePolicy(env, nodeId, now);
  if (!policy || !matches(context, policy, now))
    throw new ApiError(
      "conflict",
      "Preparation does not match the current node policy or qualification",
    );
  const lineage = await boundPreparation(env, nodeId, context);
  if (!lineage)
    throw new ApiError(
      "conflict",
      "Preparation must retain every unresolved bound Pod identity",
    );
  const guard = {
    sql: `(${policy.guard.sql}) AND (${lineage.sql})`,
    bindings: [...policy.guard.bindings, ...lineage.bindings],
  };
  const serialized = JSON.stringify(context);
  try {
    await env.DB.batch([
      assertion(env, guard),
      env.DB.prepare(
        `INSERT INTO pool_preparation_contexts(node_id,node_uid,boot_id,context_json,observed_at,expires_at)
        SELECT ?,?,?,?,?,? WHERE ${guard.sql} ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,boot_id=excluded.boot_id,
        context_json=excluded.context_json,observed_at=excluded.observed_at,expires_at=excluded.expires_at WHERE pool_preparation_contexts.observed_at<=excluded.observed_at`,
      ).bind(
        nodeId,
        context.node_uid,
        context.boot_id,
        serialized,
        context.observed_at,
        context.expires_at,
        ...guard.bindings,
      ),
      assertion(env, {
        sql: `(${guard.sql}) AND EXISTS(SELECT 1 FROM pool_preparation_contexts WHERE node_id=? AND context_json=? AND expires_at>unixepoch('now')*1000)`,
        bindings: [...guard.bindings, nodeId, serialized],
      }),
    ]);
  } catch {
    throw new ApiError(
      "conflict",
      "Preparation authority changed before publication",
    );
  }
}
/** Authenticated host lease projection only. This grants no mount, writer or postmaster start. */
export async function readPostgresPoolPreparationContexts(
  env: Env,
  nodeId: string,
  now = Date.now(),
): Promise<PoolPodPreparationContext[]> {
  const policy = await readPostgresPoolNodePolicy(env, nodeId, now);
  if (!policy) return [];
  const row = await env.DB.prepare(
    "SELECT context_json FROM pool_preparation_contexts WHERE node_id=? AND node_uid=? AND boot_id=?",
  )
    .bind(nodeId, policy.node.node_uid, policy.node.boot_id)
    .first<string>("context_json");
  const context = PoolPodPreparationContext.safeParse(
    row ? JSON.parse(row) : null,
  );
  return context.success &&
    matches(context.data, policy, now) &&
    (await boundPreparation(env, nodeId, context.data))
    ? [context.data]
    : [];
}
export { readPostgresPoolQualificationPreparation } from "./postgres-pool-qualification-preparation.ts";
