// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, type Database } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Listed = { data: Database[]; next_cursor: string | null };

async function create(
  f: Fixture,
  name: string,
  project = f.project,
  region = f.region,
) {
  const response = await request(
    "/v1/databases",
    project === f.project ? f.integrator : f.otherKey,
    "POST",
    { project_id: project, region_id: region, name, size_class_id: f.size },
  );
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json()).database;
}

async function list(query: URLSearchParams, key: string): Promise<Listed> {
  const response = await request(`/v1/databases?${query}`, key);
  expect(response.status).toBe(200);
  return response.json<Listed>();
}

it("exposes actual placement and an explicit null for an unplaced database", async () => {
  const f = await fixture(8192),
    placed = await create(f, "placed"),
    unplaced = await create(f, "unplaced", f.project, f.foreign);
  const listed = await list(new URLSearchParams(), f.integrator);
  expect(
    listed.data.find((database) => database.id === placed.id),
  ).toMatchObject({
    node_id: f.node,
  });
  expect(
    listed.data.find((database) => database.id === unplaced.id),
  ).toMatchObject({
    node_id: null,
  });
  const detail = await request(`/v1/databases/${placed.id}`, f.integrator);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ node_id: f.node });
  expect(
    (
      await list(new URLSearchParams({ node_id: f.node }), f.integrator)
    ).data.map((database) => database.id),
  ).toEqual([placed.id]);
  expect(
    (
      await list(new URLSearchParams({ region_id: f.foreign }), f.integrator)
    ).data.map((database) => database.id),
  ).toEqual([unplaced.id]);
});

it("combines project, region, node and public state filters across cursor pages", async () => {
  const f = await fixture(8192),
    first = await create(f, "sleep-one"),
    second = await create(f, "sleep-two"),
    otherProject = await create(f, "other-project", f.other),
    otherRegion = await create(f, "other-region", f.project, f.foreign),
    awake = await create(f, "awake");
  for (const database of [first, second, otherProject, otherRegion])
    await env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',observed_state='provisioning',observed_generation=generation,observed_power='hibernated',created_at=? WHERE id=?",
    )
      .bind("2026-01-01T00:00:00.000Z", database.id)
      .run();
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation WHERE id=?",
  )
    .bind(awake.id)
    .run();
  const query = new URLSearchParams({
    project_id: f.project,
    region_id: f.region,
    node_id: f.node,
    desired_state: "suspended",
    observed_state: "hibernated",
    limit: "1",
  });
  const pageOne = await list(query, f.admin);
  expect(pageOne.data).toHaveLength(1);
  expect(pageOne.next_cursor).not.toBeNull();
  query.set("cursor", pageOne.next_cursor!);
  const pageTwo = await list(query, f.admin);
  expect(pageTwo.data).toHaveLength(1);
  expect(pageTwo.next_cursor).toBeNull();
  expect(
    [...pageOne.data, ...pageTwo.data].map((database) => database.id),
  ).toEqual([first.id, second.id].sort().reverse());
  expect([...pageOne.data, ...pageTwo.data]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        project_id: f.project,
        region_id: f.region,
        node_id: f.node,
        desired_state: "suspended",
        observed_state: "hibernated",
      }),
    ]),
  );
  query.delete("cursor");
  query.set("observed_state", "provisioning");
  expect((await list(query, f.admin)).data).toEqual([]);
  query.set("observed_state", "hibernated");
  query.set("desired_state", "running");
  expect((await list(query, f.admin)).data).toEqual([]);
  query.set("desired_state", "suspended");
  query.set("region_id", f.foreign);
  expect((await list(query, f.admin)).data).toEqual([]);
});

it("keeps node mapping project scoped and refuses a foreign project filter", async () => {
  const f = await fixture(8192),
    own = await create(f, "own"),
    foreign = await create(f, "foreign", f.other);
  const query = new URLSearchParams({ region_id: f.region, node_id: f.node });
  expect(
    (await list(query, f.integrator)).data.map((database) => database.id),
  ).toEqual([own.id]);
  expect(
    (await list(query, f.otherKey)).data.map((database) => database.id),
  ).toEqual([foreign.id]);
  query.set("project_id", f.other);
  const refused = await request(`/v1/databases?${query}`, f.integrator);
  expect(refused.status).toBe(404);
});

it("retains deleted database and project exclusion with placement filters", async () => {
  const f = await fixture(8192),
    own = await create(f, "own"),
    deleted = await create(f, "deleted"),
    foreign = await create(f, "foreign", f.other);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
    ).bind(new Date().toISOString(), deleted.id),
    env.DB.prepare("UPDATE projects SET deleted_at=? WHERE id=?").bind(
      new Date().toISOString(),
      f.other,
    ),
  ]);
  const query = new URLSearchParams({ region_id: f.region, node_id: f.node });
  const listed = await list(query, f.admin);
  expect(listed.data.map((database) => database.id)).toEqual([own.id]);
  expect(listed.data.some((database) => database.id === foreign.id)).toBe(
    false,
  );
});
