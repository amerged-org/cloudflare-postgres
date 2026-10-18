// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { NodeMaintenance } from "@pgcf/contracts/nodes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeOrders } from "../../src/domain/lifecycle-orders.ts";
import {
  assignRelease,
  cleanupFixtures,
  fixture,
  nodeRequest,
  refusal,
  reportBody,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type F = Awaited<ReturnType<typeof fixture>>;
/** A node that runs the release of its region, as its hello says. */
async function converged() {
  const f = await fixture();
  const release = await assignRelease(f);
  await env.DB.prepare("UPDATE nodes SET reported_release_id=? WHERE id=?")
    .bind(release, f.node)
    .run();
  return f;
}
const start = (f: F, body: unknown = { expected_node_uid: f.nodeUid }) =>
  request(
    `/v1/nodes/${f.node}/maintenance`,
    f.admin,
    "POST",
    body,
    crypto.randomUUID(),
  );
const read = (f: F, operation: string) =>
  request(`/v1/nodes/${f.node}/maintenance/${operation}`, f.admin);
async function started(f: F) {
  const response = await start(f);
  expect(response.status).toBe(202);
  return NodeMaintenance.parse(await response.json());
}
/** The node reports how its maintenance order ended. */
async function answer(f: F, status: "done" | "failed", operation: string) {
  const response = await nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: reportBody(
      [],
      [
        {
          operation,
          status,
          ...(status === "failed" ? { reason: "check_failed" } : {}),
        },
      ],
    ),
  });
  expect(response.status).toBe(200);
}
/** What the node's actor sends its agent: each call is a hint to pull the desired page. */
async function hints(f: F) {
  const notify = await runInDurableObject(
    env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node)),
    (instance) => vi.spyOn(Object.getPrototypeOf(instance), "notify"),
  );
  notify.mockClear();
  return notify;
}
const closedAt = async (f: F) =>
  env.DB.prepare("SELECT database_placement_closed_at c FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string | null>("c");
const orders = async (f: F) =>
  (
    await env.DB.prepare(
      "SELECT operation FROM lifecycle_orders WHERE node_id=? AND type='maintenance' ORDER BY created_at,operation",
    )
      .bind(f.node)
      .all<{ operation: string }>()
  ).results.map((row) => row.operation);

describe("the maintenance cycle of one node", () => {
  it("closes placement and gives the node one open maintenance order", async () => {
    const f = await converged();
    expect(await closedAt(f)).toBeNull();
    const response = await start(f);
    expect(response.status).toBe(202);
    const maintenance = NodeMaintenance.parse(await response.json());
    expect(response.headers.get("Location")).toBe(
      `/v1/nodes/${f.node}/maintenance/${maintenance.operation}`,
    );
    const at = await closedAt(f);
    expect(at).not.toBeNull();
    expect(maintenance).toEqual({
      operation: maintenance.operation,
      node_id: f.node,
      status: "open",
      result_reason: null,
      placement_closed_at: at,
      created_at: at,
      closed_at: null,
    });
    expect(await orders(f)).toEqual([maintenance.operation]);
    expect(await openNodeOrders(env.DB, f.node)).toEqual([
      { type: "maintenance", operation: maintenance.operation },
    ]);
    const read1 = await read(f, maintenance.operation);
    expect(read1.status).toBe(200);
    expect(await read1.json()).toEqual(maintenance);
  });

  it("answers a repeat while the order is open with the same operation", async () => {
    const f = await converged();
    const first = await started(f);
    const key = crypto.randomUUID(),
      path = `/v1/nodes/${f.node}/maintenance`,
      body = { expected_node_uid: f.nodeUid };
    // Another key and the same key both name the open order; nothing else is written.
    const other = await request(path, f.admin, "POST", body, key);
    expect(other.status).toBe(202);
    expect(NodeMaintenance.parse(await other.json())).toEqual(first);
    const replay = await request(path, f.admin, "POST", body, key);
    expect(replay.status).toBe(202);
    expect(NodeMaintenance.parse(await replay.json())).toEqual(first);
    expect(await orders(f)).toEqual([first.operation]);
    expect(await closedAt(f)).toBe(first.placement_closed_at);
  });

  it("reopens placement when the cycle is done and leaves it closed when it failed", async () => {
    const done = await converged();
    const first = await started(done);
    await answer(done, "done", first.operation);
    expect(await closedAt(done)).toBeNull();
    const finished = NodeMaintenance.parse(
      await (await read(done, first.operation)).json(),
    );
    expect(finished).toMatchObject({
      status: "done",
      result_reason: null,
      placement_closed_at: first.placement_closed_at,
    });
    expect(finished.closed_at).not.toBeNull();
    expect(await openNodeOrders(env.DB, done.node)).toEqual([]);

    const failed = await converged();
    const second = await started(failed);
    await answer(failed, "failed", second.operation);
    expect(await closedAt(failed)).toBe(second.placement_closed_at);
    expect(
      NodeMaintenance.parse(
        await (await read(failed, second.operation)).json(),
      ),
    ).toMatchObject({ status: "failed", result_reason: "check_failed" });
    expect(await openNodeOrders(env.DB, failed.node)).toEqual([]);
  });

  it("hints the node to pull its whole page when its order ends, so that it serves wakes again at once", async () => {
    for (const status of ["done", "failed"] as const) {
      const f = await converged();
      const order = await started(f);
      const notify = await hints(f);
      await answer(f, status, order.operation);
      // No ids: the page that clears the node's hold on wakes is the whole page.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0]).toBeUndefined();
      // The same answer again ends nothing and hints nothing.
      await answer(f, status, order.operation);
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });

  it("takes over the closure a failed cycle left, so that the next cycle that is done reopens it", async () => {
    const f = await converged();
    const first = await started(f);
    await answer(f, "failed", first.operation);
    const retry = await started(f);
    expect(retry.operation).not.toBe(first.operation);
    expect(retry.placement_closed_at).toBe(first.placement_closed_at);
    await answer(f, "done", retry.operation);
    expect(await closedAt(f)).toBeNull();
  });

  it("keeps closed the placement that an operator closed, before the cycle or during it", async () => {
    const f = await converged();
    const close = async () =>
      expect(
        (
          await request(
            `/v1/nodes/${f.node}/database-placement`,
            f.admin,
            "PUT",
            { expected_node_uid: f.nodeUid, database_placement_enabled: false },
          )
        ).status,
      ).toBe(200);
    await close();
    const operator = await closedAt(f);
    const before = await started(f);
    expect(before.placement_closed_at).toBeNull();
    expect(await closedAt(f)).toBe(operator);
    await answer(f, "done", before.operation);
    expect(await closedAt(f)).toBe(operator);
    expect(
      await env.DB.prepare(
        "SELECT database_placement_enabled e FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first<number>("e"),
    ).toBe(0);

    // The operator opens placement again, and closes it again while a cycle runs.
    expect(
      (
        await request(
          `/v1/nodes/${f.node}/database-placement`,
          f.admin,
          "PUT",
          {
            expected_node_uid: f.nodeUid,
            database_placement_enabled: true,
          },
        )
      ).status,
    ).toBe(200);
    const during = await started(f);
    expect(during.placement_closed_at).not.toBeNull();
    await close();
    const reclosed = await closedAt(f);
    expect(reclosed).not.toBe(during.placement_closed_at);
    await answer(f, "done", during.operation);
    expect(await closedAt(f)).toBe(reclosed);
  });

  it("refuses a node that cannot run the cycle", async () => {
    // Its binaries differ from the release of its region.
    const older = await converged();
    await env.DB.prepare(
      "UPDATE nodes SET reported_release_id='older' WHERE id=?",
    )
      .bind(older.node)
      .run();
    // Its region has no release.
    const unassigned = await fixture();
    // It was declared lost, or only fenced.
    const lost = await converged();
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date().toISOString(), lost.node)
      .run();
    const fenced = await converged();
    await env.DB.prepare(
      "INSERT INTO node_losses(node_id,region_id,declared_at,reason) VALUES(?,?,?,'dead')",
    )
      .bind(fenced.node, fenced.region, new Date().toISOString())
      .run();
    for (const f of [older, unassigned, lost, fenced]) {
      expect(await refusal(await start(f))).toMatchObject({
        status: 409,
        code: "conflict",
      });
      expect(await orders(f)).toEqual([]);
    }
    expect(await closedAt(older)).toBeNull();
    expect(await closedAt(unassigned)).toBeNull();
    expect(await closedAt(fenced)).toBeNull();
  });

  it("is an administrator's call about the node it names, with a key", async () => {
    const f = await converged();
    const path = `/v1/nodes/${f.node}/maintenance`;
    const body = { expected_node_uid: f.nodeUid };
    expect(
      (await refusal(await request(path, f.integrator, "POST", body, "k1")))
        .code,
    ).toBe("forbidden");
    expect(
      (await refusal(await request(path, f.admin, "POST", body, null))).code,
    ).toBe("invalid_request");
    expect(
      (await refusal(await start(f, { expected_node_uid: "x" }))).code,
    ).toBe("invalid_request");
    // Another physical node behind the same ID.
    expect(
      await refusal(await start(f, { expected_node_uid: crypto.randomUUID() })),
    ).toMatchObject({ status: 409, code: "conflict" });
    expect(
      await refusal(
        await request(
          `/v1/nodes/nod_${"z".repeat(20)}/maintenance`,
          f.admin,
          "POST",
          body,
          crypto.randomUUID(),
        ),
      ),
    ).toMatchObject({ status: 404, code: "not_found" });
    expect(await orders(f)).toEqual([]);
    expect(await closedAt(f)).toBeNull();

    // An order is read through the node it belongs to, by an administrator.
    const maintenance = await started(f);
    const other = await converged();
    expect(
      (
        await refusal(
          await request(
            `/v1/nodes/${other.node}/maintenance/${maintenance.operation}`,
            other.admin,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await refusal(
          await request(`${path}/${maintenance.operation}`, f.integrator),
        )
      ).code,
    ).toBe("forbidden");
  });
});
