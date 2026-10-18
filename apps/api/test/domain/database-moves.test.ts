// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  ArchiveCredential,
  DatabaseOrigin,
  NodeOrder,
  parseArchivePath,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  ensureArchiveCredential,
  deliverArchiveCredential,
} from "../../src/domain/archive-credentials.ts";
import {
  listDatabaseMoves,
  moveTargets,
  startDatabaseMove,
} from "../../src/domain/database-moves.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import { openNodeOrders } from "../../src/domain/lifecycle-orders.ts";
import { declareNodeLost } from "../../src/domain/node-loss.ts";
import {
  addNode,
  BACKUP,
  cleanup,
  done,
  failed,
  keyedEnv,
  lifecycle,
  observation,
  pageOf,
  PROOF,
  report,
} from "./lifecycle-fixture.ts";
import { nextMessage, openLink } from "./node-fixtures.ts";
import { nodeRequest, observationOf, reportBody } from "./fixtures.ts";
import {
  GIB,
  MIB,
  OPEN_POOL,
  patchSample,
  seedSamples,
} from "./node-samples.ts";

const keys = new Set<string>();
afterEach(async () => {
  if (keys.size) await env.ARCHIVE.delete([...keys]);
  keys.clear();
  await cleanup();
});
const actorFor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
/**
 * The archive of the database's current storage generation as its node left it: the newest base
 * backup with its data, and the WAL through the last segment of the proof.
 */
async function archive(f: { row: () => Promise<{ archive_path: string }> }) {
  const prefix = `${(await f.row()).archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "")}/database/`;
  const put = async (key: string) => {
    keys.add(key);
    await env.ARCHIVE.put(
      key,
      key.endsWith("backup.info")
        ? `status=DONE\nbegin_time=2026-10-18T09:30:00.000Z\nend_time=2026-10-18T09:31:00.000Z\nbegin_wal=000000010000000000000001\nend_wal=000000010000000000000001\nxlog_segment_size=16777216\n`
        : "x",
    );
  };
  const info = `${prefix}base/${BACKUP.backup_id}/backup.info`,
    data = `${prefix}base/${BACKUP.backup_id}/data.tar.gz`,
    segment = (n: string) =>
      `${prefix}wals/0000000100000000/0000000100000000000000${n}.gz`;
  for (const key of [info, data, segment("01"), segment("02")]) await put(key);
  return { info, data, last: segment("02"), put };
}
async function ready() {
  const f = await lifecycle();
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  return { ...f, source: await archive(f) };
}
type Fixture = Awaited<ReturnType<typeof ready>>;
const start = (f: Fixture, target = f.other) =>
  startDatabaseMove(env, { databaseId: f.id, targetNodeId: target });
/** The source node reports its `move` order done and the database asleep with its proof. */
async function proven(f: Fixture, operation: string, node = f.node) {
  const row = await f.row();
  await applyLifecycleObservations(
    env,
    node,
    report(
      [
        observation({
          id: f.id,
          generation: row.generation,
          operation: f.operation,
          storage_generation: row.storage_generation,
          state: "asleep",
        }),
      ],
      [done(operation)],
    ),
  );
}
async function restoring(f: Fixture, target = f.other) {
  const move = await start(f, target);
  await proven(f, move.operation, move.source_node_id);
  return move;
}
/** What the node's report to the generic observation intake does once a generation is ready. */
const settle = (f: Fixture) =>
  env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation WHERE id=?",
  )
    .bind(f.id)
    .run();
/**
 * The target reports the storage generation the move staged; its backup is the first one after it
 * promoted the cluster on the timeline after the source's.
 */
async function reportTarget(
  f: Fixture,
  move: { operation: string },
  patch: Record<string, unknown>,
  node = f.other,
) {
  const staged = await status(move.operation);
  await applyLifecycleObservations(
    env,
    node,
    report([
      observation({
        id: f.id,
        generation: staged.target_generation as number,
        operation: move.operation,
        storage_generation: staged.target_storage_generation as number,
        backup: { ...BACKUP, timeline: PROOF.timeline + 1 },
        ...patch,
      }),
    ]),
  );
}
const status = async (operation: string) =>
  (await env.DB.prepare(
    "SELECT status,failure,source_acknowledged_at,target_generation,target_storage_generation FROM database_moves WHERE operation=?",
  )
    .bind(operation)
    .first())!;
const ordersOf = (node: string) => openNodeOrders(env.DB, node);

it("moves on what the source reports to the node API, and tells the nodes to pull", async () => {
  const f = await ready();
  const other = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.other)
    .first<string>("node_uid");
  const sourceLink = await openLink(f),
    targetLink = await openLink({ node: f.other, nodeUid: other! });
  const toSource = nextMessage(sourceLink),
    toTarget = nextMessage(targetLink);
  const move = await start(f);
  // The source pulls its page to find the order.
  expect(JSON.parse(await toSource)).toMatchObject({ type: "desired" });
  expect((await pageOf(f.node)).orders).toEqual([
    expect.objectContaining({ type: "move", operation: move.operation }),
  ]);
  // The source stops the database and reports it asleep; D1 takes the sleep, which advances its
  // generation, and the node's next report answers that generation.
  const send = async (generation: number, orders: unknown[]) =>
    nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(
        [await observationOf(f.id, generation, "asleep", { backup: BACKUP })],
        orders,
      ),
    });
  const first = await send((await f.row()).generation, [done(move.operation)]);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    databases: [{ id: f.id, verdict: "accept" }],
    orders: 1,
  });
  expect(await status(move.operation)).toMatchObject({
    status: "proving",
    source_acknowledged_at: expect.any(String),
  });
  const row = await f.row();
  expect(row.generation).toBe(2);
  expect((await send(row.generation, [done(move.operation)])).status).toBe(200);
  expect(await status(move.operation)).toMatchObject({
    status: "restoring",
    source_acknowledged_at: expect.any(String),
  });
  // The target pulls its page and finds the staged generation.
  expect(JSON.parse(await toTarget)).toMatchObject({ type: "desired" });
  expect((await pageOf(f.other)).databases).toEqual([
    expect.objectContaining({
      id: f.id,
      operation: move.operation,
      generation: row.generation + 1,
      storage_generation: 2,
      origin: expect.objectContaining({ kind: "move" }),
    }),
  ]);
  // The node's report also left the recovery point the loss status reads.
  expect(
    await env.DB.prepare(
      "SELECT state,node_id FROM database_recovery_points WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ state: "asleep", node_id: f.node });
  sourceLink.close(1000);
  targetLink.close(1000);
});

it("puts the staged entry of a suspended database on the target's page, which lists no other suspended database", async () => {
  const f = await ready();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended',suspension_reason='manual',observed_state='provisioning',observed_power='hibernated',observed_generation=generation,power_operation=NULL WHERE id=?",
  )
    .bind(f.id)
    .run();
  // A suspended database is not on its node's page: the node keeps it asleep by itself.
  expect((await pageOf(f.node)).databases).toEqual([]);
  const move = await restoring(f);
  expect((await pageOf(f.other)).databases).toEqual([
    expect.objectContaining({
      id: f.id,
      operation: move.operation,
      desired_state: "suspended",
      storage_generation: 2,
    }),
  ]);
  expect((await pageOf(f.node)).databases).toEqual([]);
});

it("refuses a move that cannot start and says why", async () => {
  const f = await ready();
  const refused = (input: Parameters<typeof startDatabaseMove>[1]) =>
    startDatabaseMove(env, input).catch((error) => error);
  expect(
    await refused({ databaseId: "z".repeat(20), targetNodeId: f.other }),
  ).toMatchObject({ code: "not_found" });
  expect(
    await refused({ databaseId: f.id, targetNodeId: "nod_" + "a".repeat(20) }),
  ).toMatchObject({ code: "not_found" });
  // A target in another region.
  const foreignNode = "nod_" + "b".repeat(20),
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,created_at,updated_at) VALUES (?,?,?,1,8192,2000,30,128,?,?)",
  )
    .bind(foreignNode, f.foreign, "foreign-node", now, now)
    .run();
  expect(
    await refused({ databaseId: f.id, targetNodeId: foreignNode }),
  ).toMatchObject({ code: "invalid_request" });
  // A lost or fenced target.
  const lostNode = await addNode(f.region);
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,lost_reason='x',ready=0,schedulable=0 WHERE id=?",
  )
    .bind(now, lostNode)
    .run();
  const fencedNode = await addNode(f.region);
  await env.DB.prepare(
    "INSERT INTO node_losses(node_id,region_id,declared_at,reason) VALUES(?,?,?,'x')",
  )
    .bind(fencedNode, f.region, now)
    .run();
  for (const targetNodeId of [lostNode, fencedNode])
    expect(await refused({ databaseId: f.id, targetNodeId })).toMatchObject({
      code: "conflict",
    });
  // A database that is still applying a change.
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1 WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(
    await refused({ databaseId: f.id, targetNodeId: f.other }),
  ).toMatchObject({
    code: "conflict",
    details: { reason: "not_ready" },
  });
  await env.DB.prepare(
    "UPDATE databases SET observed_generation=generation WHERE id=?",
  )
    .bind(f.id)
    .run();
  // A deleted database.
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
  )
    .bind(now, f.id)
    .run();
  expect(
    await refused({ databaseId: f.id, targetNodeId: f.other }),
  ).toMatchObject({
    code: "conflict",
    details: { reason: "database_deleted" },
  });
  expect(
    (await env.DB.prepare("SELECT COUNT(*) n FROM database_moves").first<{
      n: number;
    }>())!.n,
  ).toBe(0);
});

it("refuses a target that is not open for placement or has no room for the second volume, with a reason that says to retry", async () => {
  const f = await ready();
  const broken: [string, string, ...(string | number)[]][] = [
    ["ready=0", "ready=0"],
    ["schedulable=0", "schedulable=0"],
    ["database_placement_enabled=0", "database_placement_enabled=0"],
    ["closed", "database_placement_closed_at=?", new Date().toISOString()],
    ["unobserved", "last_observed_at=NULL"],
    [
      "stale",
      "last_observed_at=?",
      new Date(Date.now() - 10 * 60_000).toISOString(),
    ],
  ];
  for (const [, assignment, ...bindings] of broken) {
    const node = await addNode(f.region);
    await env.DB.prepare(`UPDATE nodes SET ${assignment} WHERE id=?`)
      .bind(...bindings, node)
      .run();
    await expect(start(f, node)).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "node_capacity" },
    });
  }
  // A node whose pool has no room is closed as well.
  const full = await addNode(f.region);
  await patchSample(full, { room: false });
  await expect(start(f, full)).rejects.toMatchObject({
    code: "conflict",
    details: { reason: "node_capacity" },
  });
  // On its own node the move needs a second volume: 398 GiB of the 400 the pool may sell are sold,
  // and the database brings 5 more.
  await seedSamples(f.node, [
    {
      at: Date.now(),
      totalBytes: 8192 * MIB,
      pool: { ...OPEN_POOL, nominal: 398 * GIB },
    },
  ]);
  await expect(start(f, f.node)).rejects.toMatchObject({
    code: "conflict",
    details: { reason: "node_capacity" },
  });
  expect(
    (await env.DB.prepare("SELECT COUNT(*) n FROM database_moves").first<{
      n: number;
    }>())!.n,
  ).toBe(0);
  expect(await start(f)).toMatchObject({ status: "proving" });
});

it("puts no move order on a node that is declared lost between the checks and the write", async () => {
  const f = await ready();
  const uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.other)
    .first<string>("node_uid"))!;
  let raced = false;
  const racing = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          raced = true;
          await declareNodeLost(env, f.other, {
            expected_node_uid: uid,
            reason: "gone",
          });
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    startDatabaseMove(
      { ...env, DB: racing },
      { databaseId: f.id, targetNodeId: f.other },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(raced).toBe(true);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) n FROM database_moves").first<{
      n: number;
    }>())!.n,
  ).toBe(0);
  expect(await ordersOf(f.node)).toEqual([]);
});

it("starts as one order to the source and changes nothing else", async () => {
  const f = await ready(),
    before = await f.row();
  const move = await start(f);
  expect(move).toMatchObject({
    database_id: f.id,
    source_node_id: f.node,
    target_node_id: f.other,
    status: "proving",
    failure: null,
    source_storage_generation: 1,
    target_storage_generation: null,
  });
  expect(await f.row()).toEqual(before);
  const orders = await openNodeOrders(env.DB, f.node);
  expect(orders).toEqual([
    {
      type: "move",
      operation: move.operation,
      database: f.id,
      storage_generation: 1,
    },
  ]);
  for (const order of orders) NodeOrder.parse(order);
  expect(await openNodeOrders(env.DB, f.other)).toEqual([]);
  expect(await listDatabaseMoves(env.DB, f.id)).toEqual([move]);
  // The same request again is the same move; another target is refused while it runs.
  expect(await start(f)).toEqual(move);
  const third = await (async () => {
    const id = "nod_" + "c".repeat(20),
      now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,created_at,updated_at) VALUES (?,?,?,1,8192,2000,30,128,?,?)",
    )
      .bind(id, f.region, "third-node", now, now)
      .run();
    return id;
  })();
  await expect(start(f, third)).rejects.toMatchObject({
    code: "conflict",
    details: { reason: "mutation_in_progress" },
  });
});

it("waits for the source's acknowledgement and a proof of the current generation before it bumps", async () => {
  const f = await ready();
  await env.DB.prepare(
    "UPDATE databases SET generation=3,observed_generation=3 WHERE id=?",
  )
    .bind(f.id)
    .run();
  const move = await start(f),
    row = await f.row();
  const sleeping = (patch: Record<string, unknown> = {}) =>
    observation({
      id: f.id,
      generation: row.generation,
      operation: f.operation,
      state: "asleep",
      ...patch,
    });
  const unchanged = async () => {
    expect(await status(move.operation)).toMatchObject({ status: "proving" });
    expect(await f.row()).toEqual(row);
  };
  // Awake: no proof, nothing to move yet.
  await applyLifecycleObservations(
    env,
    f.node,
    report([sleeping({ state: "ready" })], [done(move.operation)]),
  );
  await unchanged();
  expect((await status(move.operation)).source_acknowledged_at).not.toBeNull();
  // Asleep, but reported by a node that is not the source, for another storage generation or
  // for a generation D1 has left behind: none of them is the proof.
  await applyLifecycleObservations(env, f.other, report([sleeping()]));
  await applyLifecycleObservations(
    env,
    f.node,
    report([sleeping({ storage_generation: 2 })]),
  );
  await applyLifecycleObservations(
    env,
    f.node,
    report([sleeping({ generation: row.generation - 1 })]),
  );
  await unchanged();
  // Asleep without a backup is not movable either: a restore needs a DONE base backup.
  await applyLifecycleObservations(
    env,
    f.node,
    report([sleeping({ backup: null })]),
  );
  await unchanged();
  await applyLifecycleObservations(env, f.node, report([sleeping()]));
  expect(await status(move.operation)).toMatchObject({
    status: "restoring",
    target_generation: row.generation + 1,
  });
});

it("takes the proof only with or after the acknowledgement of the order", async () => {
  const f = await ready(),
    move = await start(f),
    row = await f.row();
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: row.generation,
        operation: f.operation,
        state: "asleep",
      }),
    ]),
  );
  expect(await status(move.operation)).toMatchObject({
    status: "proving",
    source_acknowledged_at: null,
  });
  // A proof that came before the acknowledgement is not carried over to it.
  await applyLifecycleObservations(
    env,
    f.node,
    report([], [done(move.operation)]),
  );
  expect(await status(move.operation)).toMatchObject({ status: "proving" });
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: row.generation,
        operation: f.operation,
        state: "asleep",
      }),
    ]),
  );
  expect(await status(move.operation)).toMatchObject({ status: "restoring" });
});

it("stages the next storage generation without touching the database it serves, and the source keeps holding", async () => {
  const f = await ready(),
    before = await f.row();
  const move = await restoring(f);
  expect(await f.row()).toEqual(before);
  const staged = (await env.DB.prepare(
    "SELECT target_generation,target_storage_generation,target_archive_path,backup_id,proven_sleep_json FROM database_moves WHERE operation=?",
  )
    .bind(move.operation)
    .first<{
      target_generation: number;
      target_storage_generation: number;
      target_archive_path: string;
      backup_id: string;
      proven_sleep_json: string;
    }>())!;
  expect(staged).toMatchObject({
    target_generation: before.generation + 1,
    target_storage_generation: 2,
    backup_id: BACKUP.backup_id,
  });
  expect(parseArchivePath(staged.target_archive_path)).toMatchObject({
    database: f.id,
    generation: 2,
    operation: move.operation,
    region: f.region,
  });
  expect(staged.target_archive_path).not.toBe(before.archive_path);
  expect(JSON.parse(staged.proven_sleep_json)).toEqual(PROOF);
  // Still served by the source, which holds its wakes until the order ends.
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  expect(await ordersOf(f.node)).toEqual([
    {
      type: "move",
      operation: move.operation,
      database: f.id,
      storage_generation: 1,
    },
  ]);
});

it("does not stage a move whose source archive lacks what the proof names, and ends it", async () => {
  for (const missing of ["last", "data", "info"] as const) {
    const f = await ready(),
      move = await start(f),
      before = await f.row();
    await env.ARCHIVE.delete(f.source[missing]);
    await proven(f, move.operation);
    expect(await status(move.operation)).toMatchObject({
      status: "failed",
      failure: "no_recovery_point",
    });
    expect(await f.row()).toEqual(before);
    expect(await ordersOf(f.node)).toEqual([]);
    expect(await ordersOf(f.other)).toEqual([]);
    await cleanup();
  }
});

it("waits for an archive it cannot read instead of ending the move", async () => {
  const f = await ready(),
    move = await start(f);
  await env.DB.prepare("UPDATE regions SET backup_bucket=? WHERE id=?")
    .bind("unbound-bucket", f.region)
    .run();
  await proven(f, move.operation);
  expect(await status(move.operation)).toMatchObject({ status: "proving" });
  expect(await ordersOf(f.node)).toHaveLength(1);
  await env.DB.prepare("UPDATE regions SET backup_bucket=? WHERE id=?")
    .bind(env.ARCHIVE_BUCKET_NAME, f.region)
    .run();
  await proven(f, move.operation);
  expect(await status(move.operation)).toMatchObject({ status: "restoring" });
});

it("ends a move whose target stopped being eligible before it was staged", async () => {
  const f = await ready(),
    move = await start(f),
    before = await f.row();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
  )
    .bind(f.other)
    .run();
  await proven(f, move.operation);
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "target_not_eligible",
  });
  expect(await f.row()).toEqual(before);
  expect(await ordersOf(f.node)).toEqual([]);
  expect((await moveTargets(env.DB, f.other, Date.now())).size).toBe(0);
});

it("gives the target the staged entry, with the origin and credentials, and the source nothing new", async () => {
  const f = await ready(),
    move = await restoring(f),
    row = await f.row(),
    now = Date.now();
  expect(await ordersOf(f.other)).toEqual([]);
  const targets = await moveTargets(env.DB, f.other, now);
  expect([...targets.keys()]).toEqual([f.id]);
  const staged = targets.get(f.id)!;
  expect(DatabaseOrigin.parse(staged.origin)).toEqual(staged.origin);
  expect(staged).toMatchObject({
    operation: move.operation,
    generation: row.generation + 1,
    storage_generation: 2,
    origin: {
      kind: "move",
      source: { database_id: f.id, backup_id: BACKUP.backup_id, end: PROOF },
    },
  });
  expect(parseArchivePath(staged.archive.path)).toMatchObject({
    database: f.id,
    generation: 2,
    operation: move.operation,
  });
  const source = (
    staged.origin as {
      source: { path: string; credential: { id: string } };
    }
  ).source;
  expect(source.path).toBe(row.archive_path);
  // The target reads the source archive and writes its own; the source gets no right to write it.
  expect(
    await deliverArchiveCredential(
      keyedEnv(),
      f.other,
      source.credential.id,
      now,
    ),
  ).toMatchObject({ access: "read_only", path: source.path });
  expect(
    ArchiveCredential.parse(
      await deliverArchiveCredential(
        keyedEnv(),
        f.other,
        staged.archive.credential.id,
        now,
      ),
    ),
  ).toMatchObject({ access: "read_write", path: staged.archive.path });
  expect(
    (
      await env.DB.prepare(
        "SELECT node_id,access FROM archive_credentials ORDER BY access",
      ).all()
    ).results,
  ).toEqual([
    { node_id: f.other, access: "read_only" },
    { node_id: f.other, access: "read_write" },
  ]);
  await expect(
    ensureArchiveCredential(
      env.DB,
      {
        nodeId: f.node,
        archivePath: staged.archive.path,
        access: "read_write",
      },
      now,
    ),
  ).rejects.toThrow("archive_credential_refused");
  // The source's page keeps its own entry and the move order; the target's holds the staged one.
  const sourcePage = await pageOf(f.node);
  const own = (await env.DB.prepare(
    "SELECT id,expires_at FROM archive_credentials WHERE node_id=? AND archive_path=? AND access='read_write'",
  )
    .bind(f.node, row.archive_path)
    .first<{ id: string; expires_at: string }>())!;
  expect(sourcePage.databases).toEqual([
    expect.objectContaining({
      id: f.id,
      generation: row.generation,
      operation: f.operation,
      storage_generation: 1,
      archive: { path: row.archive_path, credential: own },
    }),
  ]);
  expect(sourcePage.orders).toEqual(await ordersOf(f.node));
  expect((await pageOf(f.other)).databases).toEqual([
    expect.objectContaining({
      id: f.id,
      generation: staged.generation,
      operation: staged.operation,
      storage_generation: staged.storage_generation,
      archive: staged.archive,
      origin: staged.origin,
    }),
  ]);
});

it("finishes when the target is ready: the database moves behind the admission fence and the source retires its volume", async () => {
  const f = await ready(),
    before = await f.row();
  await env.DB.exec(
    `CREATE TRIGGER move_requires_fence BEFORE UPDATE OF node_id,archive_path,storage_generation ON databases WHEN NEW.id='${f.id}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'database mutation lacks admission fence'); END`,
  );
  try {
    const move = await restoring(f);
    // Not yet: building, the wrong node, an older storage generation, a lower generation.
    await reportTarget(f, move, { state: "building" });
    await reportTarget(f, move, { state: "ready" }, f.node);
    await reportTarget(f, move, { state: "ready", storage_generation: 1 });
    await reportTarget(f, move, {
      state: "ready",
      generation: before.generation,
    });
    await reportTarget(f, move, { state: "ready", backup: null });
    expect(await status(move.operation)).toMatchObject({
      status: "restoring",
    });
    expect(await f.row()).toEqual(before);
    const staged = (await moveTargets(env.DB, f.other, Date.now())).get(f.id)!;
    await reportTarget(f, move, { state: "ready" });
    expect(await status(move.operation)).toMatchObject({ status: "done" });
    expect(await f.row()).toEqual({
      ...before,
      node_id: f.other,
      generation: before.generation + 1,
      storage_generation: 2,
      archive_path: staged.archive.path,
      observed_state: "provisioning",
    });
    expect(
      await env.DB.prepare(
        "SELECT mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({ mutation_id: null, mutation_outcome: "committed" });
    // The route is closed until the target's generation is settled.
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    // The move order ends and the source is told to retire its generation and remove the volume.
    const orders = await ordersOf(f.node);
    expect(orders).toEqual([
      {
        type: "superseded",
        operation: expect.stringMatching(/^op_[a-z0-9]{20}$/),
        database: f.id,
        storage_generation: 1,
        remove_volume: true,
      },
    ]);
    // The target keeps no staged entry once its generation is the database's.
    expect((await moveTargets(env.DB, f.other, Date.now())).size).toBe(0);
    // The source reports the removal; the order leaves its page.
    await applyLifecycleObservations(
      env,
      f.node,
      report([], [done(orders[0]!.operation)]),
    );
    expect(await ordersOf(f.node)).toEqual([]);
    // A report that arrives twice changes nothing.
    await reportTarget(f, move, { state: "ready" });
    expect(await status(move.operation)).toMatchObject({ status: "done" });
    expect(await ordersOf(f.node)).toEqual([]);
    // The database can move again, now from the other node.
    await settle(f);
    expect(await start(f, f.node)).toMatchObject({
      status: "proving",
      source_node_id: f.other,
      source_storage_generation: 2,
    });
  } finally {
    await env.DB.exec("DROP TRIGGER IF EXISTS move_requires_fence");
  }
});

it("finishes when the target is asleep after the proven sleep of a later timeline of the same cluster", async () => {
  const f = await ready(),
    move = await restoring(f);
  const sleeping = (patch: Record<string, unknown>) => ({
    state: "asleep",
    proven_sleep: { ...PROOF, ...patch },
    backup: { ...BACKUP, timeline: 2 },
  });
  // The proof of the source's own timeline is not a promoted target.
  await reportTarget(f, move, sleeping({ timeline: 1 }));
  expect(await status(move.operation)).toMatchObject({ status: "restoring" });
  await reportTarget(f, move, sleeping({ timeline: 2 }));
  expect(await status(move.operation)).toMatchObject({ status: "done" });
  expect((await f.row()).node_id).toBe(f.other);
});

it("ends a move whose target sleeps with another cluster's proof", async () => {
  const f = await ready(),
    move = await restoring(f),
    before = await f.row();
  await reportTarget(f, move, {
    state: "asleep",
    proven_sleep: { ...PROOF, timeline: 2, system_identifier: "1234" },
    backup: { ...BACKUP, timeline: 2 },
  });
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "identity_mismatch",
  });
  expect(await f.row()).toEqual(before);
});

it("ends a move whose target reports ready with a backup of the source's own timeline: it never promoted", async () => {
  const f = await ready(),
    move = await restoring(f),
    before = await f.row();
  await reportTarget(f, move, {
    state: "ready",
    backup: { ...BACKUP, timeline: PROOF.timeline },
  });
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "not_promoted",
  });
  expect(await f.row()).toEqual(before);
  // The source serves again, and the target removes what it staged.
  expect(await ordersOf(f.node)).toEqual([]);
  expect(await ordersOf(f.other)).toEqual([
    expect.objectContaining({
      type: "superseded",
      storage_generation: 2,
      remove_volume: true,
    }),
  ]);
});

it("leaves the database with its source when the target cannot build, retires what the target staged, and the next attempt stages a new generation", async () => {
  const f = await ready(),
    move = await restoring(f),
    before = await f.row();
  await reportTarget(f, move, { state: "error", error: "no_recovery_point" });
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "no_recovery_point",
  });
  expect(await f.row()).toEqual(before);
  // The source serves again; the target is told never to start what it staged, and to remove it.
  expect(await ordersOf(f.node)).toEqual([]);
  expect(await ordersOf(f.other)).toEqual([
    {
      type: "superseded",
      operation: expect.stringMatching(/^op_[a-z0-9]{20}$/),
      database: f.id,
      storage_generation: 2,
      remove_volume: true,
    },
  ]);
  expect((await moveTargets(env.DB, f.other, Date.now())).size).toBe(0);
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  // A new attempt counts on from the generation the target retired.
  const again = await restoring(f);
  expect(again.operation).not.toBe(move.operation);
  expect(await status(again.operation)).toMatchObject({
    target_storage_generation: 3,
  });
  await reportTarget(f, again, { state: "ready" });
  expect(await f.row()).toMatchObject({
    node_id: f.other,
    storage_generation: 3,
  });
});

it("cannot tell the node of a failed same-node move to retire its staged volume without retiring the source's", async () => {
  const f = await ready(),
    move = await restoring(f, f.node);
  await reportTarget(
    f,
    move,
    { state: "error", error: "storage_full" },
    f.node,
  );
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "storage_full",
  });
  expect(await ordersOf(f.node)).toEqual([]);
});

it("fails a move whose database changed after the stage, and the database stays where it is", async () => {
  const f = await ready(),
    move = await restoring(f);
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1 WHERE id=?",
  )
    .bind(f.id)
    .run();
  const changed = await f.row();
  await reportTarget(f, move, { state: "ready" });
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "database_changed",
  });
  expect(await f.row()).toEqual(changed);
  expect(await ordersOf(f.node)).toEqual([]);
});

it("fails in proving when the source refuses, and the source serves again", async () => {
  const f = await ready(),
    move = await start(f),
    before = await f.row();
  await applyLifecycleObservations(
    env,
    f.node,
    report([], [failed(move.operation, "power_busy")]),
  );
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "power_busy",
  });
  expect(await ordersOf(f.node)).toEqual([]);
  expect(await f.row()).toEqual(before);
  // The next attempt is a new move.
  const again = await start(f);
  expect(again.operation).not.toBe(move.operation);
  expect(
    (await listDatabaseMoves(env.DB, f.id)).map((m) => m.status).sort(),
  ).toEqual(["failed", "proving"]);
});

it("fails a move whose database is deleted while it restores, and leaves the source's volume to the delete", async () => {
  const f = await ready(),
    move = await restoring(f);
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,generation=generation+1 WHERE id=?",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  await reportTarget(f, move, { state: "ready" });
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "database_deleted",
  });
  // The deleted database still sits on the source, whose page orders the volume removed; the
  // target removes what it staged.
  expect(await ordersOf(f.node)).toEqual([]);
  expect(await ordersOf(f.other)).toEqual([
    expect.objectContaining({
      type: "superseded",
      storage_generation: 2,
      remove_volume: true,
    }),
  ]);
});

it("ends a restoring move when either node is lost, and the lost node's page stays valid", async () => {
  for (const lost of ["target", "source"] as const) {
    const f = await ready(),
      move = await restoring(f),
      before = await f.row();
    const node = lost === "target" ? f.other : f.node;
    const uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(node)
      .first<string>("node_uid"))!;
    await declareNodeLost(env, node, {
      expected_node_uid: uid,
      reason: "gone",
    });
    expect(await status(move.operation)).toMatchObject({
      status: "failed",
      failure: "node_lost",
    });
    expect(await f.row()).toEqual(before);
    // The fenced page holds the fence and the retired generations, no move order and no database.
    const page = await pageOf(node);
    expect(page.databases).toEqual([]);
    expect(page.orders.map((order) => order.type)).not.toContain("move");
    expect(page.orders[0]).toMatchObject({ type: "fence" });
    if (lost === "target") expect(await ordersOf(f.node)).toEqual([]);
    await cleanup();
  }
});

it("moves between two volumes of the same node, whose page then serves the staged generation and retires the old", async () => {
  const f = await ready(),
    move = await restoring(f, f.node),
    row = await f.row();
  expect(row).toMatchObject({ node_id: f.node, storage_generation: 1 });
  const orders = await ordersOf(f.node);
  expect(orders).toEqual([expect.objectContaining({ type: "move" })]);
  const staged = (await moveTargets(env.DB, f.node, Date.now())).get(f.id)!;
  // The page serves the staged generation in place of the entry of the database, with the move order.
  const page = await pageOf(f.node);
  expect(page.databases).toEqual([
    expect.objectContaining({
      id: f.id,
      generation: staged.generation,
      operation: staged.operation,
      storage_generation: 2,
      archive: staged.archive,
      origin: staged.origin,
    }),
  ]);
  expect(page.orders).toEqual(orders);
  await reportTarget(f, move, { state: "ready" }, f.node);
  expect(await status(move.operation)).toMatchObject({ status: "done" });
  expect(await f.row()).toMatchObject({
    node_id: f.node,
    storage_generation: 2,
  });
  expect(await ordersOf(f.node)).toEqual([
    expect.objectContaining({
      type: "superseded",
      storage_generation: 1,
      remove_volume: true,
    }),
  ]);
});

it("never lowers a storage generation or serves one an order retired", async () => {
  const f = await ready();
  const move = await restoring(f);
  await reportTarget(f, move, { state: "ready" });
  await settle(f);
  await archive(f);
  // Back to the first node: the generation counts up from the other's, never from the first's.
  const back = await restoring(f, f.node);
  await reportTarget(f, back, { state: "ready" }, f.node);
  expect(await f.row()).toMatchObject({
    node_id: f.node,
    storage_generation: 3,
  });
  expect(back.operation).not.toBe(move.operation);
  const lower = env.DB.prepare(
    "UPDATE databases SET storage_generation=2 WHERE id=?",
  ).bind(f.id);
  await expect(lower.run()).rejects.toThrow("storage_generation_monotonic");
  // The first node holds a superseded order for generation 1, and one for 3 is placed on the other.
  await env.DB.prepare(
    "INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,created_at) VALUES (?,?, 'superseded',?,3,?)",
  )
    .bind("op_" + "e".repeat(20), f.other, f.id, new Date().toISOString())
    .run();
  await expect(
    env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
      .bind(f.other, f.id)
      .run(),
  ).rejects.toThrow("storage_generation_superseded");
  // An order, once closed, never reopens or loses its volume removal.
  const [order] = (
    await env.DB.prepare(
      "SELECT operation FROM lifecycle_orders WHERE type='superseded' AND remove_volume=1 LIMIT 1",
    ).all<{ operation: string }>()
  ).results;
  await env.DB.prepare(
    "UPDATE lifecycle_orders SET closed_at=? WHERE operation=?",
  )
    .bind(new Date().toISOString(), order!.operation)
    .run();
  await expect(
    env.DB.prepare(
      "UPDATE lifecycle_orders SET closed_at=NULL WHERE operation=?",
    )
      .bind(order!.operation)
      .run(),
  ).rejects.toThrow("lifecycle_order_immutable");
  await expect(
    env.DB.prepare(
      "UPDATE lifecycle_orders SET remove_volume=0 WHERE operation=?",
    )
      .bind(order!.operation)
      .run(),
  ).rejects.toThrow("lifecycle_order_immutable");
});
