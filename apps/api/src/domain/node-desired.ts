// SPDX-License-Identifier: Apache-2.0
import {
  NodeDesiredPage,
  NodePolicy,
  NodeRelease,
  FleetReleaseSpec,
  bytesToHex,
  type DesiredRole,
  type DesiredRoleRemoval,
  type NodeDesiredQuery,
  type NodeOrder,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import { keyring } from "../crypto/keyring.ts";
import type { ApiContext, Env } from "../env.ts";
import { effectiveSleepAfterSql, type RoleRow } from "./rows.ts";
import type { NodeCaller } from "./node-auth.ts";

interface NodeRow {
  id: string;
  uid: string;
  hostname: string;
  region_id: string;
  credentials_revision: number;
}
interface DatabaseRow {
  id: string;
  generation: number;
  desired_state: "running" | "suspended" | "deleted";
  suspension_reason: "manual" | "idle" | null;
  storage_generation: number;
  archive_path: string;
  pg_major: 18;
  route_revision: number;
  memory_mib: number;
  cpu_millicores: number;
  storage_gib: number;
  max_connections: number;
  archive_timeout_seconds: number;
  sleep_after_seconds: number | null;
  operation: string;
  roles_json: string;
  credential: string | null;
  ever_ready: number;
  source_database_id: string | null;
  source_archive_path: string | null;
  backup_id: string | null;
  target_time: string | null;
  restore_verified_at: string | null;
  source_credential: string | null;
}

/** The operation of a fence, the same every time the node reads it. */
export async function fenceOperation(nodeId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pgcf-fence\n${nodeId}`),
  );
  return `op_${bytesToHex(new Uint8Array(digest)).slice(0, 20)}`;
}

const credentialOf = (value: string) => {
  const [id, expires_at] = value.split("|") as [string, string];
  return { id, expires_at };
};

async function pageOrders(
  env: Env,
  node: NodeRow,
  fenced: boolean,
): Promise<NodeOrder[]> {
  const stored = await env.DB.prepare(
    `SELECT operation,type,database_id,storage_generation,remove_volume FROM node_orders
     WHERE node_id=? AND (result IS NULL OR type='superseded') ${fenced ? "AND type='superseded'" : ""}
     ORDER BY created_at,operation LIMIT 1000`,
  )
    .bind(node.id)
    .all<{
      operation: string;
      type: "move" | "superseded" | "maintenance";
      database_id: string | null;
      storage_generation: number | null;
      remove_volume: number;
    }>();
  const orders: NodeOrder[] = [];
  if (fenced)
    orders.push({
      type: "fence",
      operation: await fenceOperation(node.id),
    });
  else {
    // A resume asks the node to start the database now: its pending operation is the order.
    const wakes = await env.DB.prepare(
      `SELECT d.id,d.generation,d.power_operation FROM databases d
       JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.kind='database.resume' AND o.status IN('pending','running')
       WHERE d.node_id=? AND d.desired_state='running' AND d.deleted_at IS NULL ORDER BY d.id LIMIT 1000`,
    )
      .bind(node.id)
      .all<{ id: string; generation: number; power_operation: string }>();
    for (const wake of wakes.results)
      orders.push({
        type: "wake",
        operation: wake.power_operation,
        database: wake.id,
        generation: wake.generation,
      });
  }
  for (const order of stored.results)
    orders.push(
      order.type === "maintenance"
        ? { type: "maintenance", operation: order.operation }
        : order.type === "move"
          ? {
              type: "move",
              operation: order.operation,
              database: order.database_id!,
              storage_generation: order.storage_generation!,
            }
          : {
              type: "superseded",
              operation: order.operation,
              database: order.database_id!,
              storage_generation: order.storage_generation!,
              remove_volume: order.remove_volume === 1,
            },
    );
  return orders.slice(0, 1000);
}

async function pageRelease(
  env: Env,
  regionId: string,
): Promise<NodeRelease | null> {
  const row = await env.DB.prepare(
    `SELECT r.id,r.spec_json FROM fleet_region_releases f JOIN fleet_releases r ON r.id=f.release_id WHERE f.region_id=?`,
  )
    .bind(regionId)
    .first<{ id: string; spec_json: string }>();
  if (row === null) return null;
  const spec = FleetReleaseSpec.parse(JSON.parse(row.spec_json));
  return NodeRelease.parse({
    id: row.id,
    binaries: spec.binaries,
    os: spec.os,
  });
}

async function databaseRoles(
  credentials: ReturnType<typeof keyring>,
  row: DatabaseRow,
): Promise<(DesiredRole | DesiredRoleRemoval)[]> {
  // Deletion can recover even if a credential key has been retired.
  if (row.desired_state === "deleted") return [];
  const stored = JSON.parse(row.roles_json) as (Omit<
    RoleRow,
    "member_of_json"
  > & {
    member_of: string[];
  })[];
  const roles: (DesiredRole | DesiredRoleRemoval)[] = [];
  for (const role of stored.sort((a, b) => a.name.localeCompare(b.name))) {
    // A deleted role is only named: the node removes it from PostgreSQL and reports back, and its
    // credential is never sent again.
    if (role.deleted_at !== null) {
      roles.push({ name: role.name, state: "absent" });
      continue;
    }
    roles.push({
      name: role.name,
      owner: Boolean(role.owner),
      revision: role.password_revision,
      password: await credentials.decrypt(row.id, role.name, {
        ciphertext: role.password_ciphertext,
        iv: role.password_iv,
        kid: role.password_kid,
      }),
      // Attributes appear only where they differ from a plain role.
      ...(role.valid_until === null ? {} : { valid_until: role.valid_until }),
      ...(role.connection_limit === null
        ? {}
        : { connection_limit: role.connection_limit }),
      ...(role.member_of.length === 0 ? {} : { member_of: role.member_of }),
      ...(role.bypass_rls ? { bypass_rls: true as const } : {}),
    });
  }
  return roles;
}

/**
 * One page of the databases a node serves, with its release, policy and open orders (plan 5.3).
 * A database is on the page once its archive credential is issued. A fenced node's page holds the
 * fence and the retired storage generations and nothing else.
 */
export async function nodeDesiredPage(
  env: Env,
  caller: NodeCaller,
  query: NodeDesiredQuery,
): Promise<NodeDesiredPage> {
  const node = await env.DB.prepare(
    "SELECT id,node_uid uid,k8s_node_name hostname,region_id,credentials_revision FROM nodes WHERE id=? AND node_uid=?",
  )
    .bind(caller.id, caller.uid)
    .first<NodeRow>();
  if (node === null) throw new ApiError("not_found", "Node not found");
  const policyRow = await env.DB.prepare(
    "SELECT node_policy_json FROM node_region_policies WHERE region_id=?",
  )
    .bind(node.region_id)
    .first<{ node_policy_json: string | null }>();
  if (!policyRow?.node_policy_json)
    throw new ApiError("conflict", "The region's node policy is not set");
  const policy = NodePolicy.parse(JSON.parse(policyRow.node_policy_json)),
    identity = {
      id: node.id,
      uid: node.uid,
      hostname: node.hostname,
      region_id: node.region_id,
    };
  const orders = await pageOrders(env, node, caller.fenced);
  if (caller.fenced)
    return NodeDesiredPage.parse({
      node: identity,
      release: null,
      policy,
      credentials_revision: node.credentials_revision,
      orders,
      databases: [],
      next: null,
    });
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `SELECT * FROM (
       SELECT d.id,d.generation,d.desired_state,d.suspension_reason,d.storage_generation,d.archive_path,d.pg_major,
         COALESCE(ae.route_revision,1) route_revision,dr.memory_mib,dr.cpu_millicores,dr.storage_gib,s.max_connections,
         s.archive_timeout_seconds,${effectiveSleepAfterSql("d")} sleep_after_seconds,
         (SELECT o.id FROM operations o WHERE o.database_id=d.id AND o.generation<=d.generation
            ORDER BY o.generation DESC,o.created_at DESC,o.id DESC LIMIT 1) operation,
         (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_revision',r.password_revision,
            'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid,'deleted_at',r.deleted_at,
            'valid_until',r.valid_until,'connection_limit',r.connection_limit,'member_of',json(r.member_of_json),'bypass_rls',r.bypass_rls))
            FROM roles r WHERE r.database_id=d.id) roles_json,
         (SELECT c.id||'|'||c.expires_at FROM database_archive_credentials c WHERE c.database_id=d.id AND c.archive_path=d.archive_path
            AND c.access='read_write' AND (d.desired_state='deleted' OR c.expires_at>?) ORDER BY c.expires_at DESC LIMIT 1) credential,
         EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.database_id=d.id AND e.kind='ready') ever_ready,
         x.source_database_id,x.source_archive_path,x.backup_id,x.target_time,
         x.verified_at restore_verified_at,
         (SELECT c.id||'|'||c.expires_at FROM database_archive_credentials c WHERE c.database_id=d.id AND c.archive_path=x.source_archive_path
            AND c.access='read_only' AND c.expires_at>? ORDER BY c.expires_at DESC LIMIT 1) source_credential
       FROM databases d JOIN size_classes s ON s.id=d.size_class_id JOIN database_resources dr ON dr.database_id=d.id
       LEFT JOIN database_admission_epochs ae ON ae.database_id=d.id
       LEFT JOIN database_restores x ON x.target_database_id=d.id
       WHERE d.node_id=? AND d.region_id=? AND d.desired_state IN('running','suspended','deleted')
         AND (d.desired_state<>'suspended' OR d.power_operation IS NOT NULL)
         AND NOT(d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation)
     ) WHERE credential IS NOT NULL AND (source_database_id IS NULL OR restore_verified_at IS NOT NULL OR source_credential IS NOT NULL)
       ${query.after ? "AND id>?" : ""} ${query.ids ? "AND id IN(SELECT value FROM json_each(?))" : ""} ORDER BY id LIMIT ?`,
  )
    .bind(
      now,
      now,
      node.id,
      node.region_id,
      ...(query.after ? [query.after] : []),
      ...(query.ids ? [JSON.stringify(query.ids.split(","))] : []),
      query.limit + 1,
    )
    .all<DatabaseRow>();
  const rows = result.results.slice(0, query.limit),
    credentials = keyring(env.CREDENTIAL_KEYS);
  const databases = [];
  for (const row of rows) {
    const origin =
      row.source_database_id !== null && row.restore_verified_at === null
        ? {
            kind: "restore" as const,
            source: {
              database_id: row.source_database_id,
              path: row.source_archive_path,
              backup_id: row.backup_id,
              ...(row.target_time ? { target_time: row.target_time } : {}),
              credential: credentialOf(row.source_credential!),
            },
          }
        : row.source_database_id === null && row.ever_ready === 0
          ? { kind: "create" as const }
          : undefined;
    databases.push({
      id: row.id,
      generation: row.generation,
      operation: row.operation,
      // An idle sleeper wakes on connect like any running database; only a manual suspend does not.
      desired_state:
        row.desired_state === "suspended" && row.suspension_reason === "idle"
          ? "running"
          : row.desired_state,
      route_revision: row.route_revision,
      storage_generation: row.storage_generation,
      pg_major: row.pg_major,
      // The database's effective values: its own, else its size class's.
      resources: {
        memory_mib: row.memory_mib,
        cpu_millicores: row.cpu_millicores,
        storage_gib: row.storage_gib,
      },
      settings: {
        max_connections: row.max_connections,
        archive_timeout_seconds: row.archive_timeout_seconds,
      },
      sleep_after_seconds: row.sleep_after_seconds,
      roles: await databaseRoles(credentials, row),
      archive: {
        path: row.archive_path,
        credential: credentialOf(row.credential!),
      },
      ...(origin ? { origin } : {}),
    });
  }
  return NodeDesiredPage.parse({
    node: identity,
    release: await pageRelease(env, node.region_id),
    policy,
    credentials_revision: node.credentials_revision,
    orders,
    databases,
    next: result.results.length > query.limit ? rows.at(-1)!.id : null,
  });
}

/** `GET /node/v1/desired`. One line per page, so a wake's pull is measured where the agent reads it. */
export async function desiredResponse(
  c: ApiContext,
  caller: NodeCaller,
  query: NodeDesiredQuery,
): Promise<Response> {
  const started = Date.now();
  const page = await nodeDesiredPage(c.env, caller, query);
  console.log(
    JSON.stringify({
      event: "node_desired_page",
      node_id: caller.id,
      ...(page.databases.length === 1
        ? { database_id: page.databases[0]!.id }
        : {}),
      databases: page.databases.length,
      at_ms: Date.now(),
      elapsedMs: Date.now() - started,
    }),
  );
  return c.json(page);
}
