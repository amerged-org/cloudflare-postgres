// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { NodeLoss } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { openNodeOrders } from "../../src/domain/lifecycle-orders.ts";
import { cleanup, lifecycle } from "./lifecycle-fixture.ts";
import { refusal, request } from "./fixtures.ts";

afterEach(cleanup);
const uidOf = async (node: string) =>
  (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(node)
    .first<string>("node_uid"))!;

it("starts a move for an administrator only, and lists the moves of a database", async () => {
  const f = await lifecycle();
  const path = `/v1/databases/${f.id}/move`;
  expect(
    (
      await refusal(
        await request(path, f.integrator, "POST", { target_node_id: f.other }),
      )
    ).code,
  ).toBe("forbidden");
  expect(
    (
      await refusal(
        await request(path, f.admin, "POST", { target_node_id: "x" }),
      )
    ).code,
  ).toBe("invalid_request");
  expect(
    await refusal(
      await request(`/v1/databases/${"z".repeat(20)}/move`, f.admin, "POST", {
        target_node_id: f.other,
      }),
    ),
  ).toMatchObject({ status: 404, code: "not_found" });
  const response = await request(path, f.admin, "POST", {
    target_node_id: f.other,
  });
  expect(response.status).toBe(202);
  const move = (await response.json()) as Record<string, unknown>;
  expect(move).toMatchObject({
    database_id: f.id,
    source_node_id: f.node,
    target_node_id: f.other,
    status: "proving",
  });
  // The same request is the same move; another target is refused while it runs.
  const again = await request(path, f.admin, "POST", {
    target_node_id: f.other,
  });
  expect(again.status).toBe(202);
  expect(await again.json()).toEqual(move);
  const listed = await request(`/v1/databases/${f.id}/moves`, f.admin);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ data: [move] });
  expect(
    (await refusal(await request(`/v1/databases/${f.id}/moves`, f.integrator)))
      .code,
  ).toBe("forbidden");
});

it("declares a node lost with its fence, reads the fencing back, and takes the owner's acknowledgement", async () => {
  const f = await lifecycle();
  const uid = await uidOf(f.node);
  expect(
    (await refusal(await request(`/v1/nodes/${f.node}/loss`, f.admin))).status,
  ).toBe(404);
  const wrong = await request(
    `/v1/nodes/${f.node}/mark-lost`,
    f.admin,
    "POST",
    {
      expected_node_uid: crypto.randomUUID(),
      reason: "dead",
    },
  );
  expect(wrong.status).toBe(409);
  const lost = await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
    expected_node_uid: uid,
    reason: "dead",
  });
  expect(lost.status).toBe(200);
  expect(NodeLoss.parse(await lost.json())).toMatchObject({
    node_id: f.node,
    reason: "dead",
  });
  const orders = await openNodeOrders(env.DB, f.node);
  expect(orders.map((order) => order.type)).toEqual(["fence", "superseded"]);
  const status = await request(`/v1/nodes/${f.node}/loss`, f.admin);
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    node_id: f.node,
    reason: "dead",
    status: "fencing",
    databases: [{ id: f.id, storage_generation: 1, recovery_point: null }],
    reinstall: { blocked: [f.id], overridden: false },
  });
  expect(
    (await refusal(await request(`/v1/nodes/${f.node}/loss`, f.integrator)))
      .code,
  ).toBe("forbidden");
  // The owner's acknowledgement, once; asking again is the same answer.
  const acknowledge = () =>
    request(`/v1/nodes/${f.node}/reinstall-override`, f.admin, "POST", {
      reason: "the data on it is test data",
    });
  const first = await acknowledge();
  expect(first.status).toBe(200);
  const body = (await first.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ node_id: f.node, overridden: true });
  expect(await (await acknowledge()).json()).toEqual(body);
  expect(
    (
      await refusal(
        await request(
          `/v1/nodes/${f.other}/reinstall-override`,
          f.admin,
          "POST",
          {
            reason: "x",
          },
        ),
      )
    ).code,
  ).toBe("conflict");
  expect(
    (await (await request(`/v1/nodes/${f.node}/loss`, f.admin)).json()) as {
      reinstall: unknown;
    },
  ).toMatchObject({ reinstall: { overridden: true } });
});
