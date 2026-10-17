// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
afterEach(async () => {
  await cleanupFixtures();
});

it("the actual host HTTPS route exposes only the current region's retained thick assignments", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  const { request } = await import("./fixtures.ts");
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
  )
    .bind(f.region)
    .run();
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    legacy: unknown[];
    databases: unknown[];
    node_uid: string;
  };
  expect(value.legacy).toEqual([
    {
      database_id: created.id,
      generation: 1,
      namespace: `pgcf-db-${created.id}`,
    },
  ]);
  expect(value.databases).toEqual([]);
  expect(
    (await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.foreignAgent))
      .status,
  ).toBe(404);
  expect(
    (await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.integrator))
      .status,
  ).toBe(401);
});
