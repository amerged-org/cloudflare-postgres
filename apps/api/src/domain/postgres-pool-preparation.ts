// SPDX-License-Identifier: Apache-2.0
import {
  PoolPodPreparationContext,
  PostgresPoolPolicy,
  POSTGRES_POOL,
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
      WHERE p.node_id=? AND p.node_uid=? AND p.revision=? AND p.policy_json=?) AND ${fleet.sql}`,
      bindings: [
        nodeId,
        node.node_uid,
        row.revision,
        row.policy_json,
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
  const result = await env.DB.prepare(
    `INSERT INTO pool_preparation_contexts(node_id,node_uid,boot_id,context_json,observed_at,expires_at)
    SELECT ?,?,?,?,?,? WHERE ${policy.guard.sql} ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,boot_id=excluded.boot_id,
    context_json=excluded.context_json,observed_at=excluded.observed_at,expires_at=excluded.expires_at WHERE pool_preparation_contexts.observed_at<=excluded.observed_at`,
  )
    .bind(
      nodeId,
      context.node_uid,
      context.boot_id,
      JSON.stringify(context),
      context.observed_at,
      context.expires_at,
      ...policy.guard.bindings,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(
      "conflict",
      "Preparation authority changed before publication",
    );
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
  return context.success && matches(context.data, policy, now)
    ? [context.data]
    : [];
}
export { readPostgresPoolQualificationPreparation } from "./postgres-pool-qualification-preparation.ts";
