// SPDX-License-Identifier: Apache-2.0
import {
  PoolPodPreparationContext,
  POSTGRES_POOL,
  poolPreparationContextHash,
} from "@pgcf/contracts/postgres-pool";
import type { Env } from "../env.ts";
import { readPostgresPoolQualificationSetup } from "./postgres-pool-qualification-authority.ts";
/** Signer lookup: only CF-persisted, currently validated preparation for this exact run. */
export async function readPostgresPoolQualificationPreparation(
  env: Env,
  nodeId: string,
  runId: string,
  scopeHash: string,
  now = Date.now(),
) {
  const run = await env.DB.prepare(
    "SELECT database_id,database_generation FROM postgres_pool_qualification_runs WHERE id=? AND node_id=? AND scope_sha256=? AND status='running' AND expires_at>?",
  )
    .bind(runId, nodeId, scopeHash, now)
    .first<{ database_id: string; database_generation: number }>();
  if (!run) return undefined;
  const setup = await readPostgresPoolQualificationSetup(
    env,
    run.database_id,
    run.database_generation,
    now,
  );
  if (!setup || setup.run_id !== runId || setup.scope_sha256 !== scopeHash)
    return undefined;
  const raw = await env.DB.prepare(
    "SELECT context_json FROM pool_preparation_contexts WHERE node_id=? AND node_uid=? AND boot_id=?",
  )
    .bind(nodeId, setup.scope.node_uid, setup.scope.boot_id)
    .first<string>("context_json");
  const parsed = PoolPodPreparationContext.safeParse(
    raw ? JSON.parse(raw) : null,
  );
  if (!parsed.success) return undefined;
  const context = parsed.data;
  if (
    context.node_id !== nodeId ||
    context.node_uid !== setup.scope.node_uid ||
    context.boot_id !== setup.scope.boot_id ||
    context.qualification_run_id !== runId ||
    context.qualification_scope_sha256 !== scopeHash ||
    context.policy_revision !== setup.policy_revision ||
    JSON.stringify(context.policy) !== JSON.stringify(setup.policy) ||
    context.expires_at <= now ||
    context.observed_at > now + POSTGRES_POOL.clock_skew_ms ||
    context.observed_at <= now - POSTGRES_POOL.observation_max_age_ms
  )
    return undefined;
  return {
    context,
    preparation_sha256: await poolPreparationContextHash(context),
    fence: {
      sql: `EXISTS(SELECT 1 FROM pool_preparation_contexts p WHERE p.node_id=? AND p.node_uid=? AND p.boot_id=? AND p.context_json=?
        AND p.expires_at>(julianday('now')-2440587.5)*86400000) AND (${setup.fence.sql})`,
      bindings: [
        nodeId,
        context.node_uid,
        context.boot_id,
        raw!,
        ...setup.fence.bindings,
      ],
    },
  };
}
