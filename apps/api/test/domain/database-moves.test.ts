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
  moveOrigins,
  startDatabaseMove,
} from "../../src/domain/database-moves.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import { openNodeOrders } from "../../src/domain/lifecycle-orders.ts";
import {
  addNode,
  BACKUP,
  cleanup,
  desiredPage,
  done,
  failed,
  keyedEnv,
  lifecycle,
  observation,
  PROOF,
  report,
} from "./lifecycle-fixture.ts";

afterEach(cleanup);
const actorFor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
async function ready() {
  const f = await lifecycle();
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  return f;
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
/** The target reports the new storage generation. */
async function reportTarget(
  f: Fixture,
  move: { operation: string },
  patch: Record<string, unknown>,
  node = f.other,
) {
  const row = await f.row();
  await applyLifecycleObservations(
    env,
    node,
    report([
      observation({
        id: f.id,
        generation: row.generation,
        operation: move.operation,
        storage_generation: row.storage_generation,
        ...patch,
      }),
    ]),
  );
}
const status = async (operation: string) =>
  (await env.DB.prepare(
    "SELECT status,failure,source_acknowledged_at,target_generation FROM database_moves WHERE operation=?",
  )
    .bind(operation)
    .first())!;

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

it("bumps the generation behind the admission fence, with a fresh archive path, a fence on the source and credentials for the target", async () => {
  const f = await ready(),
    before = await f.row(),
    oldPath = before.archive_path;
  await env.DB.exec(
    `CREATE TRIGGER move_requires_fence BEFORE UPDATE OF node_id,archive_path,storage_generation ON databases WHEN NEW.id='${f.id}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'database mutation lacks admission fence'); END`,
  );
  try {
    const move = await restoring(f);
    const row = await f.row();
    expect(row).toMatchObject({
      node_id: f.other,
      generation: before.generation + 1,
      storage_generation: 2,
      observed_state: "provisioning",
      observed_generation: before.generation,
      desired_state: "running",
    });
    const path = parseArchivePath(row.archive_path)!;
    expect(path).toMatchObject({
      database: f.id,
      generation: 2,
      operation: move.operation,
      region: f.region,
    });
    expect(row.archive_path).not.toBe(oldPath);
    expect(await status(move.operation)).toMatchObject({
      status: "restoring",
      target_generation: before.generation + 1,
    });
    const stored = (await env.DB.prepare(
      "SELECT target_storage_generation,target_archive_path,backup_id,proven_sleep_json FROM database_moves WHERE operation=?",
    )
      .bind(move.operation)
      .first<{
        target_storage_generation: number;
        target_archive_path: string;
        backup_id: string;
        proven_sleep_json: string;
      }>())!;
    expect(stored).toMatchObject({
      target_storage_generation: 2,
      target_archive_path: row.archive_path,
      backup_id: BACKUP.backup_id,
    });
    expect(JSON.parse(stored.proven_sleep_json)).toEqual(PROOF);
    // The route closed with the bump: the Actor admits nothing until the target is ready.
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    expect(
      await env.DB.prepare(
        "SELECT mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({ mutation_id: null, mutation_outcome: "committed" });
  } finally {
    await env.DB.exec("DROP TRIGGER IF EXISTS move_requires_fence");
  }
});

it("leaves the source with a superseded order and no database, and the target with the move origin", async () => {
  const f = await ready(),
    move = await restoring(f),
    row = await f.row(),
    now = Date.now();
  const orders = await openNodeOrders(env.DB, f.node);
  expect(orders).toEqual([
    {
      type: "superseded",
      operation: expect.stringMatching(/^op_[a-z0-9]{20}$/),
      database: f.id,
      storage_generation: 1,
      remove_volume: false,
    },
  ]);
  expect(orders[0]!.operation).not.toBe(move.operation);
  expect(await openNodeOrders(env.DB, f.other)).toEqual([]);
  const origins = await moveOrigins(env.DB, f.other, now);
  expect([...origins.keys()]).toEqual([f.id]);
  const { operation, origin } = origins.get(f.id)!;
  expect(operation).toBe(move.operation);
  expect(DatabaseOrigin.parse(origin)).toEqual(origin);
  expect(origin).toMatchObject({
    kind: "move",
    source: {
      database_id: f.id,
      backup_id: BACKUP.backup_id,
      end: PROOF,
    },
  });
  const source = (
    origin as { source: { path: string; credential: { id: string } } }
  ).source;
  expect(parseArchivePath(source.path)).toMatchObject({
    database: f.id,
    generation: 1,
  });
  // The target reads the source archive and writes its own; the source reads and writes nothing.
  const read = await deliverArchiveCredential(
    keyedEnv(),
    f.other,
    source.credential.id,
    now,
  );
  expect(read).toMatchObject({ access: "read_only", path: source.path });
  const write = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.other, archivePath: row.archive_path, access: "read_write" },
    now,
  );
  expect(
    ArchiveCredential.parse(
      await deliverArchiveCredential(keyedEnv(), f.other, write.id, now),
    ),
  ).toMatchObject({ access: "read_write", path: row.archive_path });
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
  // Both pages are valid under the node contract.
  await desiredPage(f.node, [], orders);
  await desiredPage(
    f.other,
    [{ row, operation: move.operation, credential: write, origin }],
    [],
  );
});

it("finishes when the target is ready, and then removes the source's volume", async () => {
  const f = await ready(),
    move = await restoring(f),
    row = await f.row();
  // Not yet: building, the wrong node, an older storage generation.
  await reportTarget(f, move, { state: "building" });
  await reportTarget(f, move, { state: "ready" }, f.node);
  await reportTarget(f, move, { state: "ready", storage_generation: 1 });
  expect(await status(move.operation)).toMatchObject({ status: "restoring" });
  await reportTarget(f, move, { state: "ready" });
  expect(await status(move.operation)).toMatchObject({ status: "done" });
  expect(await f.row()).toEqual(row);
  const orders = await openNodeOrders(env.DB, f.node);
  expect(orders).toEqual([
    {
      type: "superseded",
      operation: expect.stringMatching(/^op_[a-z0-9]{20}$/),
      database: f.id,
      storage_generation: 1,
      remove_volume: true,
    },
  ]);
  // The target keeps no origin once its generation was ready.
  expect((await moveOrigins(env.DB, f.other, Date.now())).size).toBe(0);
  // The source reports the removal; the order leaves its page.
  await applyLifecycleObservations(
    env,
    f.node,
    report([], [done(orders[0]!.operation)]),
  );
  expect(await openNodeOrders(env.DB, f.node)).toEqual([]);
  // A report that arrives twice changes nothing.
  await reportTarget(f, move, { state: "ready" });
  expect(await status(move.operation)).toMatchObject({ status: "done" });
  expect(await openNodeOrders(env.DB, f.node)).toEqual([]);
  // The database can move again, now from the other node.
  await settle(f);
  expect(await start(f, f.node)).toMatchObject({
    status: "proving",
    source_node_id: f.other,
    source_storage_generation: 2,
  });
});

it("fails when the target cannot build, keeps the source's volume and says what the node reported", async () => {
  const f = await ready(),
    move = await restoring(f);
  await reportTarget(f, move, { state: "error", error: "no_recovery_point" });
  expect(await status(move.operation)).toMatchObject({
    status: "failed",
    failure: "no_recovery_point",
  });
  const orders = await openNodeOrders(env.DB, f.node);
  expect(orders).toEqual([
    expect.objectContaining({ type: "superseded", remove_volume: false }),
  ]);
  expect((await f.row()).node_id).toBe(f.other);
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
  expect(await openNodeOrders(env.DB, f.node)).toEqual([]);
  expect(await f.row()).toEqual(before);
  // The next attempt is a new move.
  const again = await start(f);
  expect(again.operation).not.toBe(move.operation);
  expect(
    (await listDatabaseMoves(env.DB, f.id)).map((m) => m.status).sort(),
  ).toEqual(["failed", "proving"]);
});

it("fails a move whose database is deleted while it restores", async () => {
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
});

it("moves between two volumes of the same node, whose page then serves the new generation and retires the old", async () => {
  const f = await ready(),
    move = await restoring(f, f.node),
    row = await f.row();
  expect(row).toMatchObject({ node_id: f.node, storage_generation: 2 });
  const orders = await openNodeOrders(env.DB, f.node);
  expect(orders).toEqual([
    expect.objectContaining({ type: "superseded", storage_generation: 1 }),
  ]);
  const credential = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: row.archive_path, access: "read_write" },
    Date.now(),
  );
  const { operation, origin } = (
    await moveOrigins(env.DB, f.node, Date.now())
  ).get(f.id)!;
  await desiredPage(f.node, [{ row, operation, credential, origin }], orders);
  await reportTarget(f, move, { state: "ready" }, f.node);
  expect(await status(move.operation)).toMatchObject({ status: "done" });
});

it("never lowers a storage generation or serves one an order retired", async () => {
  const f = await ready();
  const move = await restoring(f);
  await reportTarget(f, move, { state: "ready" });
  await settle(f);
  // Back to the first node: the generation counts up from the other's, never from the first's.
  const back = await restoring(f, f.node);
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
