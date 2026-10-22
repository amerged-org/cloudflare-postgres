// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, NodeLoss } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { startDatabaseMove } from "../../src/domain/database-moves.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import {
  isNodeFenced,
  openNodeOrders,
} from "../../src/domain/lifecycle-orders.ts";
import { fenceOperation } from "../../src/domain/node-desired.ts";
import {
  declareNodeLost,
  nodeLossStatus,
  runNodeFencing,
  type FenceActions,
} from "../../src/domain/node-loss.ts";
import {
  cleanup,
  pageOf,
  done,
  lifecycle,
  observation,
  report,
} from "./lifecycle-fixture.ts";

afterEach(cleanup);
async function lost() {
  const f = await lifecycle();
  const second = DatabaseWithOperation.parse(
    await (await f.create("second")).json(),
  ).database.id;
  await env.DB.prepare(
    "UPDATE databases SET node_id=?,observed_state='ready',observed_generation=generation WHERE id=?",
  )
    .bind(f.node, second)
    .run();
  const uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid"))!;
  const declare = (at = Date.now(), reason = "host unreachable") =>
    declareNodeLost(env, f.node, { expected_node_uid: uid, reason }, at);
  return { ...f, second, uid, declare };
}
const statusOf = async (node: string) => (await nodeLossStatus(env.DB, node))!;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{
    n: number;
  }>())!.n;

/** The fencing steps of the Worker, recorded and scripted. */
function actions(
  script: {
    tunnel?: (call: number) => void;
    power?: (call: number) => void;
    states?: ("stopped" | "other")[];
  } = {},
) {
  const calls: string[] = [],
    tunnelMade: boolean[] = [],
    accounts: (string | null)[] = [];
  let tunnels = 0,
    powers = 0,
    polls = 0;
  const impl: FenceActions = {
    async deleteTunnel(target) {
      calls.push(`tunnel:${target.nodeId}`);
      tunnelMade.push(target.tunnelMade);
      accounts.push(target.accountId);
      script.tunnel?.(++tunnels);
    },
    async powerOff(target) {
      calls.push(`power:${target.providerInstanceId}`);
      script.power?.(++powers);
    },
    async powerState(target) {
      calls.push(`state:${target.providerInstanceId}`);
      const states = script.states ?? ["stopped"];
      return states[Math.min(polls++, states.length - 1)]!;
    },
  };
  return { impl, calls, tunnelMade, accounts };
}

it("declares a node lost: the fence and a superseded order for each database, nothing else changed", async () => {
  const f = await lost(),
    before = await f.row(),
    at = Date.parse("2026-10-18T12:00:00.000Z");
  const loss = await f.declare(at);
  expect(NodeLoss.parse(loss)).toMatchObject({
    node_id: f.node,
    region_id: f.region,
    node_uid: f.uid,
    reason: "host unreachable",
  });
  expect(
    await env.DB.prepare(
      "SELECT lost_at,ready,schedulable FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first(),
  ).toMatchObject({ ready: 0, schedulable: 0 });
  expect(await isNodeFenced(env.DB, f.node)).toBe(true);
  const orders = await openNodeOrders(env.DB, f.node);
  expect(
    orders
      .map((order) => ({ ...order }))
      .sort((a, b) =>
        (a as { database: string }).database.localeCompare(
          (b as { database: string }).database,
        ),
      ),
  ).toEqual(
    [f.id, f.second].sort().map((database) => ({
      type: "superseded",
      operation: expect.stringMatching(/^op_[a-z0-9]{20}$/),
      database,
      storage_generation: 1,
      remove_volume: false,
    })),
  );
  // The databases stay at their old generation on the lost node: they are fenced, not rewritten.
  expect(await f.row()).toEqual(before);
  // What the lost node sees when it comes back: the fence first, then the retired generations,
  // and no database.
  const page = await pageOf(f.node);
  expect(page.databases).toEqual([]);
  expect(page.orders).toEqual([
    { type: "fence", operation: await fenceOperation(f.node) },
    ...orders,
  ]);
  // The same declaration again changes nothing.
  expect(await f.declare(at + 60_000)).toEqual(loss);
  expect(await openNodeOrders(env.DB, f.node)).toEqual(orders);
  expect(await count("node_losses")).toBe(1);
});

it("refuses the wrong node identity and an unknown node, and writes nothing", async () => {
  const f = await lost();
  await expect(
    declareNodeLost(env, f.node, {
      expected_node_uid: crypto.randomUUID(),
      reason: "x",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    declareNodeLost(env, "nod_" + "a".repeat(20), {
      expected_node_uid: f.uid,
      reason: "x",
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(await count("node_losses")).toBe(0);
  expect(await count("lifecycle_orders")).toBe(0);
  expect(await isNodeFenced(env.DB, f.node)).toBe(false);
});

it("fences a node that was marked lost before, and ends the moves that needed it", async () => {
  const f = await lost();
  const move = await startDatabaseMove(env, {
    databaseId: f.id,
    targetNodeId: f.other,
  });
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,lost_reason='marked',ready=0,schedulable=0 WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  await f.declare();
  expect(await isNodeFenced(env.DB, f.node)).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT status,failure FROM database_moves WHERE operation=?",
    )
      .bind(move.operation)
      .first(),
  ).toEqual({ status: "failed", failure: "node_lost" });
  expect(
    (await openNodeOrders(env.DB, f.node)).filter((o) => o.type === "move"),
  ).toEqual([]);
});

it("never places a database on a fenced node, and reads nothing from it but its orders", async () => {
  const f = await lost();
  await f.declare();
  // A database created later is placed on the other node and cannot be put on the fenced one.
  const later = DatabaseWithOperation.parse(
    await (await f.create("later")).json(),
  ).database.id;
  await env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
    .bind(f.other, later)
    .run();
  await expect(
    env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
      .bind(f.node, later)
      .run(),
  ).rejects.toThrow("node_fenced");
  // Nor can a retired generation be served again by the node it was retired on.
  await expect(
    env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
      .bind(f.other, f.second)
      .run()
      .then(() =>
        env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
          .bind(f.node, f.second)
          .run(),
      ),
  ).rejects.toThrow("storage_generation_superseded");
  // A node that comes back reports that it obeyed; the superseded orders end, the fence never.
  const orders = await openNodeOrders(env.DB, f.node);
  const superseded = orders.filter((order) => order.type === "superseded");
  const points = async () =>
    (await env.DB.prepare("SELECT * FROM database_recovery_points").all())
      .results;
  const known = await points();
  expect(known).toHaveLength(1);
  await applyLifecycleObservations(
    env,
    f.node,
    report(
      [
        observation({
          id: f.id,
          generation: 1,
          operation: f.operation,
          state: "asleep",
        }),
      ],
      superseded.map((order) => done(order.operation)),
    ),
  );
  expect((await pageOf(f.node)).orders.map((o) => o.type)).toEqual(["fence"]);
  // A fenced node's report changes no recovery point.
  expect(await points()).toEqual(known);
  await applyLifecycleObservations(
    env,
    f.node,
    report([], [done(await fenceOperation(f.node))]),
  );
  expect((await pageOf(f.node)).orders.map((o) => o.type)).toEqual(["fence"]);
});

it("fences in the order the plan sets: Tunnel, power off, then a stopped instance", async () => {
  const f = await lost();
  await f.declare();
  const run = actions({ states: ["other", "stopped"] });
  const at = Date.parse("2026-10-18T12:01:00.000Z");
  expect(await runNodeFencing(env, at, run.impl)).toEqual([
    "instance_not_stopped",
  ]);
  const instance = (await env.DB.prepare(
    "SELECT provider_instance_id FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first<string>("provider_instance_id"))!;
  expect(run.calls).toEqual([
    `tunnel:${f.node}`,
    `power:${instance}`,
    `state:${instance}`,
  ]);
  expect(await statusOf(f.node)).toMatchObject({
    status: "fencing",
    steps: {
      tunnel_deleted_at: new Date(at).toISOString(),
      power_off_requested_at: new Date(at).toISOString(),
      powered_off_at: null,
    },
    error: "instance_not_stopped",
  });
  const later = at + 60_000;
  expect(await runNodeFencing(env, later, run.impl)).toEqual([]);
  // The Tunnel and the order to power off are not repeated; only the status is read.
  expect(run.calls.slice(3)).toEqual([`state:${instance}`]);
  expect(await statusOf(f.node)).toMatchObject({
    status: "fenced",
    steps: { powered_off_at: new Date(later).toISOString() },
    error: null,
  });
  await runNodeFencing(env, later + 60_000, run.impl);
  expect(run.calls).toHaveLength(4);
});

it("tells the fence the account that holds the archive bucket, whatever the node's region, and none while the endpoint names none", async () => {
  const f = await lost();
  await f.declare();
  const run = actions();
  await runNodeFencing(env, Date.now(), run.impl);
  expect(run.accounts).toEqual(["0123456789abcdef0123456789abcdef"]);
  const g = await lost();
  await g.declare();
  const unnamed = actions();
  await runNodeFencing(
    {
      ...env,
      ARCHIVE_ENDPOINT_URL: `https://${["archive", "invalid"].join(".")}`,
    },
    Date.now(),
    unnamed.impl,
  );
  expect(unnamed.accounts).toEqual([null]);
});

it("tells the fence that a node that never read its credentials made no Tunnel", async () => {
  const f = await lost();
  await f.declare();
  const run = actions();
  await runNodeFencing(env, Date.now(), run.impl);
  expect(run.tunnelMade).toEqual([false]);
});

it("tells the fence that a node with a gateway made its Tunnel", async () => {
  const f = await lost();
  await env.DB.prepare("UPDATE nodes SET gateway_url=? WHERE id=?")
    .bind("https://pgcf-node.example.test", f.node)
    .run();
  await f.declare();
  const run = actions();
  await runNodeFencing(env, Date.now(), run.impl);
  expect(run.tunnelMade).toEqual([true]);
});

it("does not touch the instance before the Tunnel is gone, and retries each step on its own", async () => {
  const f = await lost();
  await f.declare();
  const run = actions({
    tunnel: (call) => {
      if (call === 1) throw new Error("secret-token-value");
    },
    power: (call) => {
      if (call === 1) throw new Error("provider said no");
    },
  });
  const at = Date.now();
  expect(await runNodeFencing(env, at, run.impl)).toEqual([
    "tunnel_delete_failed",
  ]);
  expect(run.calls).toEqual([`tunnel:${f.node}`]);
  let status = await statusOf(f.node);
  expect(status).toMatchObject({
    status: "fencing",
    error: "tunnel_delete_failed",
    steps: { tunnel_deleted_at: null, power_off_requested_at: null },
  });
  // The class of the failure is kept, never what the failing service said.
  expect(JSON.stringify(status)).not.toContain("secret-token-value");
  expect(await runNodeFencing(env, at + 60_000, run.impl)).toEqual([
    "power_off_failed",
  ]);
  status = await statusOf(f.node);
  expect(status).toMatchObject({
    error: "power_off_failed",
    steps: { power_off_requested_at: null },
  });
  expect(status.steps.tunnel_deleted_at).not.toBeNull();
  expect(await runNodeFencing(env, at + 120_000, run.impl)).toEqual([]);
  expect(run.calls.filter((call) => call.startsWith("tunnel"))).toHaveLength(2);
  expect(run.calls.filter((call) => call.startsWith("power"))).toHaveLength(2);
  expect(await statusOf(f.node)).toMatchObject({
    status: "fenced",
    error: null,
  });
  // The schema itself refuses another order of the steps.
  await expect(
    env.DB.prepare("UPDATE node_losses SET powered_off_at=NULL WHERE node_id=?")
      .bind(f.node)
      .run(),
  ).rejects.toThrow("node_loss_immutable");
});

it("cannot power off a node that has no provider instance", async () => {
  const f = await lost();
  await env.DB.prepare("UPDATE nodes SET provider_instance_id=NULL WHERE id=?")
    .bind(f.node)
    .run();
  await f.declare();
  const run = actions();
  await runNodeFencing(env, Date.now(), run.impl);
  expect(run.calls).toEqual([`tunnel:${f.node}`]);
  expect(await statusOf(f.node)).toMatchObject({
    status: "fencing",
    error: "no_provider_instance",
  });
});

it("records a missing configuration and an unknown Tunnel as classes of their own", async () => {
  const f = await lost();
  await f.declare();
  for (const code of ["fence_unconfigured", "tunnel_unknown"]) {
    const run = actions({
      tunnel: () => {
        throw new Error(code);
      },
    });
    expect(await runNodeFencing(env, Date.now(), run.impl)).toEqual([code]);
    expect(await statusOf(f.node)).toMatchObject({ error: code });
  }
});

it("reports the recovery point of each database of a lost node", async () => {
  const f = await lost();
  // The first database slept with a proof and a backup; the second never reported.
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: 1,
        operation: f.operation,
        state: "asleep",
      }),
    ]),
  );
  await f.declare();
  const status = await statusOf(f.node);
  expect(status.databases.map((d) => d.id)).toEqual([f.id, f.second].sort());
  const first = status.databases.find((d) => d.id === f.id)!;
  expect(first.recovery_point).toMatchObject({
    state: "asleep",
    proven_sleep: { last_archived_segment: "000000010000000000000002" },
    backup: { backup_id: "20261018T093000" },
  });
  expect(
    status.databases.find((d) => d.id === f.second)!.recovery_point,
  ).toBeNull();
  expect(status.reinstall).toEqual({ blocked: [f.second], overridden: false });
});
