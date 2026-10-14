// SPDX-License-Identifier: Apache-2.0
// Real local D1/RegionLink metadata; no physical or live first-hit result is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { PoolBindingDetails } from "@pgcf/contracts/postgres-pool";
import { servingPostgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";

afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("hints the exact held database after committed node and IO progress without waking on refused custody", async () => {
  const f = await servingPostgresPoolFixture({ thin: true });
  const link = env.REGION_LINK.get(env.REGION_LINK.idFromName(f.region));
  const response = await link.fetch("https://link.invalid/", {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket!;
  socket.accept();
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "test",
      instance_id: crypto.randomUUID(),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(messages).toContainEqual({ type: "welcome", protocol: 1 });
  messages.splice(0);
  const path = `/agent/v1/pool-bindings/${f.binding.scope.binding_id}`;
  try {
    const detail = PoolBindingDetails.parse(
      await (await request(path, f.agent)).json(),
    );
    const io = { ...detail.io_attestation!, observed_at: Date.now() };
    const node = { ...detail.node_report!, observed_at: Date.now() };
    expect((await request(path + "/io", f.agent, "POST", io)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect.soft(messages).toContainEqual({ type: "desired", ids: [f.id] });
    messages.splice(0);
    const current = await link.waitForPoolBinding(f.node, 0, Date.now());
    expect(current).not.toBeNull();
    const waiting = link.waitForPoolBinding(
      f.node,
      current!.revision,
      Date.now() + 1000,
    );
    await env.DB.exec(
      "CREATE TRIGGER ignore_pool_hint_node BEFORE UPDATE OF node_report_json ON pool_bindings BEGIN SELECT RAISE(IGNORE); END",
    );
    try {
      expect
        .soft(
          (
            await request(path + "/node", f.agent, "POST", {
              ...node,
              observed_at: node.observed_at + 1,
            })
          ).status,
        )
        .toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages).toEqual([]);
    } finally {
      await env.DB.exec("DROP TRIGGER ignore_pool_hint_node");
    }
    expect((await request(path + "/node", f.agent, "POST", node)).status).toBe(
      200,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect.soft(messages).toContainEqual({ type: "desired", ids: [f.id] });
    const delivered = await waiting;
    expect(delivered?.revision).toBeGreaterThan(current!.revision);
    expect(delivered?.bindings[0]?.binding.scope_sha256).toBe(
      f.binding.scope_sha256,
    );
    messages.splice(0);
    expect(
      (
        await request(path + "/io", f.agent, "POST", {
          ...io,
          scope_sha256: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toEqual([]);
  } finally {
    socket.close();
  }
});
