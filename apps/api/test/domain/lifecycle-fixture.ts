// SPDX-License-Identifier: Apache-2.0
// A database on a node with a second node beside it in the same region, on real D1, R2 and Durable
// Object fixtures, and the node's reports in the shape of the node contract.
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  newNodeId,
  newRolePassword,
  NodeDesiredPage,
  type NodeDatabaseObservation,
  type NodeObservationReport,
  type NodeOrderResult,
  type ProvenSleepRecord,
} from "@pgcf/contracts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

export const PARENT_KEY = {
  R2_PARENT_ACCESS_KEY_ID: "p".repeat(32),
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-" + "q".repeat(40),
};
export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const ENDPOINT = `https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`;
/** The Worker environment as a deployment with the parent key has it. */
export const keyedEnv = () => ({ ...env, ...PARENT_KEY });

export const cleanup = async () => {
  await env.DB.exec(
    "DELETE FROM node_reinstall_overrides; DELETE FROM node_losses; DELETE FROM lifecycle_orders; DELETE FROM database_moves; DELETE FROM archive_credentials; DELETE FROM database_recovery_points; DELETE FROM backup_retention_runs;",
  );
  await cleanupFixtures();
};

export const PROOF: ProvenSleepRecord = {
  system_identifier: "7428392847382937483",
  timeline: 1,
  checkpoint_lsn: "0/3000060",
  last_archived_segment: "000000010000000000000002",
  proven_at: "2026-10-18T10:00:00.000Z",
};
export const BACKUP = {
  backup_id: "20261018T093000",
  timeline: 1,
  completed_at: "2026-10-18T09:31:00.000Z",
};

export interface DatabaseRecord {
  id: string;
  node_id: string | null;
  generation: number;
  storage_generation: number;
  archive_path: string;
  observed_state: string;
  observed_generation: number;
  desired_state: string;
  deleted_at: string | null;
}
export async function record(id: string): Promise<DatabaseRecord> {
  return (await env.DB.prepare(
    "SELECT id,node_id,generation,storage_generation,archive_path,observed_state,observed_generation,desired_state,deleted_at FROM databases WHERE id=?",
  )
    .bind(id)
    .first<DatabaseRecord>())!;
}

/** Another node of the same region, usable for moves. */
export async function addNode(regionId: string): Promise<string> {
  const id = newNodeId(),
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,provider_instance_id) VALUES (?,?,?,1,8192,2000,30,128,100,?,?,?,?,?)",
  )
    .bind(
      id,
      regionId,
      "node-" + id.slice(4, 12),
      now,
      now,
      now,
      crypto.randomUUID(),
      String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
    )
    .run();
  return id;
}

/** A ready database on the fixture's node, with the archive path the create flow gave it. */
export async function lifecycle() {
  const f = await fixture(8192);
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation,power_operation=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  await env.DB.prepare("UPDATE regions SET backup_endpoint_url=? WHERE id=?")
    .bind(ENDPOINT, f.region)
    .run();
  await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
    .bind(String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!), f.node)
    .run();
  const other = await addNode(f.region);
  const row = await record(id);
  if (row.node_id !== f.node) throw new Error("fixture_database_not_placed");
  const operation = (await env.DB.prepare(
    "SELECT id FROM operations WHERE database_id=?",
  )
    .bind(id)
    .first<{ id: string }>())!.id;
  return { ...f, id, operation, other, row: () => record(id) };
}

type Observation = Partial<NodeDatabaseObservation> &
  Pick<NodeDatabaseObservation, "id" | "generation" | "operation">;
/** What a node reports for one database; every field the contract requires has a plain default. */
export function observation(o: Observation): NodeDatabaseObservation {
  const state = o.state ?? "ready";
  return {
    storage_generation: 1,
    state,
    proven_sleep: state === "asleep" ? PROOF : null,
    backup: BACKUP,
    archive: { last_segment: null, ready_files: 0, failing_since: null },
    ...(state === "error" ? { error: "build_failed" as const } : {}),
    ...o,
  } as NodeDatabaseObservation;
}
export function report(
  databases: NodeDatabaseObservation[],
  orders: NodeOrderResult[] = [],
): NodeObservationReport {
  return { observed_at: new Date().toISOString(), databases, orders };
}
export const done = (operation: string): NodeOrderResult => ({
  operation,
  status: "done",
});
export const failed = (operation: string, reason: string): NodeOrderResult => ({
  operation,
  status: "failed",
  reason,
});

/**
 * A desired page as the node contract defines it, around what this module contributes: the
 * database entries (each with the page's own archive credential) and the node's open orders.
 */
export async function desiredPage(
  nodeId: string,
  databases: {
    row: DatabaseRecord;
    operation: string;
    credential: { id: string; expires_at: string };
    origin?: unknown;
  }[],
  orders: unknown[],
) {
  const node = (await env.DB.prepare(
    "SELECT id,node_uid uid,k8s_node_name hostname,region_id FROM nodes WHERE id=?",
  )
    .bind(nodeId)
    .first())!;
  return NodeDesiredPage.parse({
    node,
    release: null,
    policy: {
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
        memory_mib: { wal_upload: 128, wal_fetch: 192, base_backup: 256 },
      },
      io: { write_bytes_per_second: 16_000_000, write_iops: 1000 },
    },
    credentials_revision: 1,
    orders,
    databases: databases.map(({ row, operation, credential, origin }) => ({
      id: row.id,
      generation: row.generation,
      operation,
      desired_state: row.desired_state,
      route_revision: 1,
      storage_generation: row.storage_generation,
      pg_major: 18,
      resources: { memory_mib: 512, cpu_millicores: 500, storage_gib: 5 },
      settings: { max_connections: 50, archive_timeout_seconds: 60 },
      sleep_after_seconds: 300,
      roles: [
        {
          name: "app",
          owner: true,
          password: newRolePassword(),
          revision: 1,
        },
      ],
      archive: { path: row.archive_path, credential },
      ...(origin === undefined ? {} : { origin }),
    })),
    next: null,
  });
}
