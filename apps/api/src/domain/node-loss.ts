// SPDX-License-Identifier: Apache-2.0
import { NodeId, ProvenSleepRecord } from "@pgcf/contracts";
import { NodeMarkLost, type NodeLoss } from "@pgcf/contracts/nodes";
import type { Env } from "../env.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";
import { failMovesOfLostNode } from "./database-moves.ts";
import { fenceActionsFromEnv } from "./fence-actions.ts";
import { reinstallBlockers, reinstallOverridden } from "./reinstall-guard.ts";
import { markNodeLost, NodeStateError } from "./node-state.ts";

/**
 * Node loss (ULTRA plan 9.4, 7.11). An operator declares a node lost; staleness never does. The
 * declaration writes the fence in one batch before anything else: the row restricts the node's key
 * to the fenced scope at once, the `fence` order and one `superseded` order per database (at its
 * current storage generation, volume kept) wait on the node's page for the day it comes back, and
 * every move from or toward the node ends, which ends its `move` order too: a fenced page holds
 * none. Then the node is marked lost, which closes its
 * databases at the Edge. D1 generations are not bumped here: the databases are recovered from R2
 * by restores, which are new databases, and only after `fenced`.
 *
 * `runNodeFencing` finishes the fence in the plan's order, one step per run and each retried until
 * it holds: delete the node's Tunnel (its token dies with it), order the instance off, and read
 * the provider's status until it says stopped. The table refuses any other order of the steps.
 * A step that fails is recorded with its class and reported to the caller, so that the cron step
 * fails and a fence stuck for days raises `control_cron_step_failing`.
 */
export interface FenceTarget {
  nodeId: string;
  regionId: string;
  /** The provider's ID of the node's instance; null if the node was never bound to one. */
  providerInstanceId: string | null;
  /** The Cloudflare account that holds the Tunnel; null if the region's endpoint does not name it. */
  accountId: string | null;
}
export interface FenceActions {
  /**
   * Deletes the node's Tunnel and revokes its token. A Tunnel that is already deleted is a
   * success; a node with no Tunnel under its name is `tunnel_unknown`, not a success.
   */
  deleteTunnel(target: FenceTarget): Promise<void>;
  /** Resolves once the provider accepted the order to power the instance off. */
  powerOff(target: FenceTarget): Promise<void>;
  powerState(target: FenceTarget): Promise<"stopped" | "other">;
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function declareNodeLost(
  env: Env,
  nodeId: string,
  value: NodeMarkLost,
  now = Date.now(),
): Promise<NodeLoss> {
  NodeId.parse(nodeId);
  const request = NodeMarkLost.parse(value);
  const node = await env.DB.prepare(
    "SELECT region_id,node_uid,lost_at FROM nodes WHERE id=?",
  )
    .bind(nodeId)
    .first<{
      region_id: string;
      node_uid: string | null;
      lost_at: string | null;
    }>();
  if (!node) throw new NodeStateError("not_found", "Node not found");
  if (node.node_uid !== request.expected_node_uid)
    throw new NodeStateError(
      "conflict",
      "Loss requires the exact observed node UID",
    );
  const at = iso(now);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO node_losses(node_id,region_id,declared_at,reason) VALUES(?,?,?,?)",
    ).bind(nodeId, node.region_id, at, request.reason),
    env.DB.prepare(
      "INSERT OR IGNORE INTO lifecycle_orders(operation,node_id,type,created_at) VALUES('op_'||lower(hex(randomblob(10))),?,'fence',?)",
    ).bind(nodeId, at),
    env.DB.prepare(
      `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,created_at)
      SELECT 'op_'||lower(hex(randomblob(10))),d.node_id,'superseded',d.id,d.storage_generation,? FROM databases d
      WHERE d.node_id=? AND d.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM lifecycle_orders o WHERE o.node_id=d.node_id AND o.type='superseded'
        AND o.database_id=d.id AND o.storage_generation=d.storage_generation AND o.closed_at IS NULL)`,
    ).bind(at, nodeId),
  ]);
  await failMovesOfLostNode(env.DB, nodeId, at);
  if (node.lost_at !== null) return markNodeLost(env.DB, nodeId, request);
  return withAdmissionMutation(
    env,
    [],
    (mutation) => markNodeLost(env.DB, nodeId, request, mutation),
    { kind: "node", id: nodeId },
  );
}

export interface NodeLossStatus {
  node_id: string;
  region_id: string;
  declared_at: string;
  reason: string;
  /** `fenced` once the instance is confirmed stopped; the generations may then move on. */
  status: "fencing" | "fenced";
  steps: {
    tunnel_deleted_at: string | null;
    power_off_requested_at: string | null;
    powered_off_at: string | null;
  };
  /** The class of the step that failed last, null while the steps go well. */
  error: string | null;
  /** The databases of the node (the first 200 by ID) and what is known of each one's recovery. */
  databases: {
    id: string;
    storage_generation: number;
    recovery_point: {
      state: string;
      proven_sleep: ProvenSleepRecord | null;
      backup: {
        backup_id: string;
        timeline: number;
        completed_at: string;
      } | null;
      observed_at: string;
    } | null;
  }[];
  reinstall: { blocked: string[]; overridden: boolean };
}

export async function nodeLossStatus(
  db: D1Database,
  nodeId: string,
): Promise<NodeLossStatus | null> {
  const row = await db
    .prepare(
      "SELECT node_id,region_id,declared_at,reason,tunnel_deleted_at,power_off_requested_at,powered_off_at,fencing_error FROM node_losses WHERE node_id=?",
    )
    .bind(nodeId)
    .first<{
      node_id: string;
      region_id: string;
      declared_at: string;
      reason: string;
      tunnel_deleted_at: string | null;
      power_off_requested_at: string | null;
      powered_off_at: string | null;
      fencing_error: string | null;
    }>();
  if (!row) return null;
  const databases = (
    await db
      .prepare(
        `SELECT d.id,d.storage_generation,p.state,p.proven_sleep_json,p.backup_json,p.observed_at
        FROM databases d LEFT JOIN database_recovery_points p ON p.database_id=d.id AND p.node_id=d.node_id AND p.storage_generation=d.storage_generation
        WHERE d.node_id=? AND d.deleted_at IS NULL ORDER BY d.id LIMIT 200`,
      )
      .bind(nodeId)
      .all<{
        id: string;
        storage_generation: number;
        state: string | null;
        proven_sleep_json: string | null;
        backup_json: string | null;
        observed_at: string | null;
      }>()
  ).results;
  return {
    node_id: row.node_id,
    region_id: row.region_id,
    declared_at: row.declared_at,
    reason: row.reason,
    status: row.powered_off_at === null ? "fencing" : "fenced",
    steps: {
      tunnel_deleted_at: row.tunnel_deleted_at,
      power_off_requested_at: row.power_off_requested_at,
      powered_off_at: row.powered_off_at,
    },
    error: row.fencing_error,
    databases: databases.map((database) => ({
      id: database.id,
      storage_generation: database.storage_generation,
      recovery_point:
        database.state === null
          ? null
          : {
              state: database.state,
              proven_sleep:
                database.proven_sleep_json === null
                  ? null
                  : ProvenSleepRecord.parse(
                      JSON.parse(database.proven_sleep_json),
                    ),
              backup:
                database.backup_json === null
                  ? null
                  : JSON.parse(database.backup_json),
              observed_at: database.observed_at!,
            },
    })),
    reinstall: {
      blocked: (await reinstallBlockers(db, nodeId)).map((b) => b.id),
      overridden: await reinstallOverridden(db, nodeId),
    },
  };
}

interface FencingRow {
  node_id: string;
  region_id: string;
  provider_instance_id: string | null;
  backup_endpoint_url: string;
  tunnel_deleted_at: string | null;
  power_off_requested_at: string | null;
}
/** How many nodes one run works on; a lost node is rare and each step calls out. */
const FENCING_PER_RUN = 4;

/** The classes a fence action may name itself; any other failure is the step's own class. */
const ACTION_ERRORS = new Set(["fence_unconfigured", "tunnel_unknown"]);

/**
 * Carries the fence of every declared node one step further, in order, and returns the class of
 * each step that failed. A failed step records its class and stops that node until the next run;
 * what a service said when it failed is never kept.
 */
export async function runNodeFencing(
  env: Pick<Env, "DB">,
  now: number,
  actions: FenceActions,
): Promise<string[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT l.node_id,l.region_id,n.provider_instance_id,r.backup_endpoint_url,l.tunnel_deleted_at,l.power_off_requested_at
      FROM node_losses l JOIN nodes n ON n.id=l.node_id JOIN regions r ON r.id=l.region_id
      WHERE l.powered_off_at IS NULL ORDER BY l.declared_at,l.node_id LIMIT ?`,
    )
      .bind(FENCING_PER_RUN)
      .all<FencingRow>()
  ).results;
  const at = iso(now),
    failures: string[] = [];
  for (const row of rows) {
    const target: FenceTarget = {
      nodeId: row.node_id,
      regionId: row.region_id,
      providerInstanceId: row.provider_instance_id,
      accountId: accountOf(row.backup_endpoint_url),
    };
    const fail = async (code: string) => {
      failures.push(code);
      console.error(
        JSON.stringify({
          event: "node_fencing_step_failed",
          node_id: row.node_id,
          error_code: code,
        }),
      );
      await env.DB.prepare(
        "UPDATE node_losses SET fencing_error=? WHERE node_id=?",
      )
        .bind(code, row.node_id)
        .run();
    };
    const succeed = (column: string) =>
      env.DB.prepare(
        `UPDATE node_losses SET ${column}=?,fencing_error=NULL WHERE node_id=? AND ${column} IS NULL`,
      )
        .bind(at, row.node_id)
        .run();
    if (row.tunnel_deleted_at === null) {
      try {
        await actions.deleteTunnel(target);
      } catch (error) {
        await fail(
          error instanceof Error && ACTION_ERRORS.has(error.message)
            ? error.message
            : "tunnel_delete_failed",
        );
        continue;
      }
      await succeed("tunnel_deleted_at");
    }
    if (row.power_off_requested_at === null) {
      if (target.providerInstanceId === null) {
        await fail("no_provider_instance");
        continue;
      }
      try {
        await actions.powerOff(target);
      } catch (error) {
        await fail(
          error instanceof Error && ACTION_ERRORS.has(error.message)
            ? error.message
            : "power_off_failed",
        );
        continue;
      }
      await succeed("power_off_requested_at");
    }
    let state: "stopped" | "other";
    try {
      state = await actions.powerState(target);
    } catch {
      await fail("instance_status_failed");
      continue;
    }
    if (state === "stopped") await succeed("powered_off_at");
    else await fail("instance_not_stopped");
  }
  return failures;
}

/**
 * The runner of the minute cron, with the Worker's own Cloudflare and Contabo credentials. It
 * fails after the run when a step of the fence failed, naming the class of the first.
 */
export async function runNodeFencingCron(env: Env, now: number) {
  const failures = await runNodeFencing(env, now, fenceActionsFromEnv(env));
  if (failures.length > 0) throw new Error(failures[0]);
}

function accountOf(endpoint: string): string | null {
  try {
    return /^([0-9a-f]{32})\./.exec(new URL(endpoint).host)?.[1] ?? null;
  } catch {
    return null;
  }
}
