// SPDX-License-Identifier: Apache-2.0
import {
  NodeDesiredPage,
  NodePolicy,
  NodeRelease,
  FleetReleaseSpec,
  bytesToHex,
  NODE_ORDER_LIMIT,
  type DesiredRole,
  type DesiredRoleRemoval,
  type NodeDesiredQuery,
  type NodeOrder,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import { keyring } from "../crypto/keyring.ts";
import type { ApiContext, Env } from "../env.ts";
import { effectiveSleepAfterSql, type RoleRow } from "./rows.ts";
import type { NodeCaller } from "./node-auth.ts";
import { ensureArchiveCredentials } from "./archive-credentials.ts";
import { moveTargets } from "./database-moves.ts";
import { openNodeOrders } from "./lifecycle-orders.ts";
import { openDiagnosticRequests } from "./node-diagnostics.ts";
import {
  credentialsRevision,
  nodeRouteKeyring,
  type CredentialsRow,
} from "./node-credentials.ts";

interface NodeRow extends CredentialsRow {
  hostname: string;
  region_id: string;
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
  ever_ready: number;
  source_database_id: string | null;
  source_archive_path: string | null;
  backup_id: string | null;
  target_time: string | null;
  restore_verified_at: string | null;
}

/** The operation of a fence, the same every time the node reads it. */
export async function fenceOperation(nodeId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pgcf-fence\n${nodeId}`),
  );
  return `op_${bytesToHex(new Uint8Array(digest)).slice(0, 20)}`;
}

async function pageOrders(
  env: Env,
  node: NodeRow,
  fenced: boolean,
): Promise<NodeOrder[]> {
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
  orders.push(...(await openNodeOrders(env.DB, node.id, fenced)));
  return orders.slice(0, NODE_ORDER_LIMIT);
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
  // The kernel and the digests of the packages and the host files a node is expected to report
  // stay with the API, which compares them; the host files themselves are on the page, because
  // the agent writes them and the release key signs them. So is the image's identity (never its
  // URL, which only the installer reads): the agent builds the signed manifest from its page.
  return NodeRelease.parse({
    id: row.id,
    image: NodeRelease.shape.image.parse({
      sha256: spec.image.sha256,
      size_bytes: spec.image.size_bytes,
      raw_sha256: spec.image.raw_sha256,
      raw_bytes: spec.image.raw_bytes,
    }),
    binaries: spec.binaries,
    os: NodeRelease.shape.os.strip().parse(spec.os),
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
 * The keyring the page's credentials revision holds. A keyring the Worker cannot read (a variable
 * that is not one) is no reason to refuse the page, which carries the fence and the wakes: the
 * revision stays as it is, the credentials read fails until the variable is fixed, and the
 * failure is logged for every page.
 */
async function pageKeyring(env: Env, nodeId: string) {
  try {
    return await nodeRouteKeyring(env, nodeId);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "node_keyring_unreadable",
        node_id: nodeId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return null;
  }
}

/**
 * One page of the databases a node serves, with its release, policy and open orders (plan 5.3).
 * A database is on the page once its archive credential is issued. A fenced node's page holds the
 * fence and the retired storage generations and nothing else. The probes an administrator asked
 * the node for and the node has not answered are on the first page of a full pull (SEC-09).
 */
export async function nodeDesiredPage(
  env: Env,
  caller: NodeCaller,
  query: NodeDesiredQuery,
): Promise<NodeDesiredPage> {
  const node = await env.DB.prepare(
    `SELECT id,node_uid uid,hostname,region_id,credentials_revision,shell_state,route_keyring_state
     FROM nodes WHERE id=? AND node_uid=?`,
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
  const now = Date.now();
  // The databases of the node, and those a move restores onto it from another.
  const result = await env.DB.prepare(
    `SELECT d.id,d.generation,d.desired_state,d.suspension_reason,d.storage_generation,d.archive_path,d.pg_major,
       COALESCE(ae.route_revision,1) route_revision,dr.memory_mib,dr.cpu_millicores,dr.storage_gib,s.max_connections,
       s.archive_timeout_seconds,${effectiveSleepAfterSql("d")} sleep_after_seconds,
       (SELECT o.id FROM operations o WHERE o.database_id=d.id AND o.generation<=d.generation
          ORDER BY o.generation DESC,o.created_at DESC,o.id DESC LIMIT 1) operation,
       (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_revision',r.password_revision,
          'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid,'deleted_at',r.deleted_at,
          'valid_until',r.valid_until,'connection_limit',r.connection_limit,'member_of',json(r.member_of_json),'bypass_rls',r.bypass_rls))
          FROM roles r WHERE r.database_id=d.id) roles_json,
       EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.database_id=d.id AND e.kind='ready') ever_ready,
       x.source_database_id,x.source_archive_path,x.backup_id,x.target_time,
       x.verified_at restore_verified_at
     FROM databases d JOIN size_classes s ON s.id=d.size_class_id JOIN database_resources dr ON dr.database_id=d.id
     LEFT JOIN database_admission_epochs ae ON ae.database_id=d.id
     LEFT JOIN database_restores x ON x.target_database_id=d.id
     WHERE d.region_id=? AND d.desired_state IN('running','suspended','deleted')
       AND ((d.node_id=? AND (d.desired_state<>'suspended' OR d.power_operation IS NOT NULL)
           AND NOT(d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation))
         OR d.id IN(SELECT database_id FROM database_moves WHERE target_node_id=? AND status='restoring'))
       ${query.after ? "AND d.id>?" : ""} ${query.ids ? "AND d.id IN(SELECT value FROM json_each(?))" : ""} ORDER BY d.id LIMIT ?`,
  )
    .bind(
      node.region_id,
      node.id,
      node.id,
      ...(query.after ? [query.after] : []),
      ...(query.ids ? [JSON.stringify(query.ids.split(","))] : []),
      query.limit + 1,
    )
    .all<DatabaseRow>();
  const rows = result.results.slice(0, query.limit),
    credentials = keyring(env.CREDENTIAL_KEYS);
  // The credentials the page names are issued here, a batch for the whole page. A database the
  // node may not hold one for is not on the page.
  const staged = await moveTargets(env.DB, node.id, now),
    issued = await ensureArchiveCredentials(
      env.DB,
      node.id,
      rows.flatMap((row) =>
        staged.has(row.id)
          ? []
          : [
              { archivePath: row.archive_path, access: "read_write" as const },
              ...(row.source_archive_path !== null &&
              row.restore_verified_at === null
                ? [
                    {
                      archivePath: row.source_archive_path,
                      access: "read_only" as const,
                    },
                  ]
                : []),
            ],
      ),
      now,
    );
  const databases = [];
  for (const row of rows) {
    const move = staged.get(row.id),
      credential = issued.get(`read_write|${row.archive_path}`),
      source =
        row.source_archive_path === null
          ? undefined
          : issued.get(`read_only|${row.source_archive_path}`);
    const restoring =
      row.source_database_id !== null && row.restore_verified_at === null;
    if (
      move === undefined &&
      (credential === undefined || (restoring && source === undefined))
    )
      continue;
    const origin =
      move !== undefined
        ? move.origin
        : restoring
          ? {
              kind: "restore" as const,
              source: {
                database_id: row.source_database_id!,
                path: row.source_archive_path!,
                backup_id: row.backup_id!,
                ...(row.target_time ? { target_time: row.target_time } : {}),
                credential: source!,
              },
            }
          : row.source_database_id === null && row.ever_ready === 0
            ? { kind: "create" as const }
            : undefined;
    databases.push({
      id: row.id,
      // A move target serves the generation the move staged; the database row still says the source's.
      generation: move?.generation ?? row.generation,
      operation: move?.operation ?? row.operation,
      // An idle sleeper wakes on connect like any running database; only a manual suspend does not.
      desired_state:
        row.desired_state === "suspended" && row.suspension_reason === "idle"
          ? "running"
          : row.desired_state,
      route_revision: row.route_revision,
      storage_generation: move?.storage_generation ?? row.storage_generation,
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
      archive: move?.archive ?? {
        path: row.archive_path,
        credential: credential!,
      },
      ...(origin ? { origin } : {}),
    });
  }
  // A pull of named databases is a wake's, and a later page repeats the first: the probes wait for
  // the first page of a full pull, which a request for one is followed by at once.
  const diagnostics =
    query.ids === undefined && query.after === undefined
      ? await openDiagnosticRequests(env.DB, node.id, now)
      : [];
  return NodeDesiredPage.parse({
    node: identity,
    release: await pageRelease(env, node.region_id),
    policy,
    credentials_revision: await credentialsRevision(
      env,
      node,
      await pageKeyring(env, node.id),
    ),
    orders,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
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
