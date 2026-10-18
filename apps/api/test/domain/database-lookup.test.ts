// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  Database,
  DatabaseWithOperation,
  Operation,
  listEnvelope,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  refusal,
  request,
  report,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = () => crypto.randomUUID();
const names = async (path: string, as: string) =>
  listEnvelope(Database)
    .parse(await (await request(path, as)).json())
    .data.map((database) => database.name)
    .sort();

it("finds a database by its exact name inside the project of the key", async () => {
  const f = await fixture();
  expect((await f.create("orders")).status).toBe(202);
  expect((await f.create("orders-archive")).status).toBe(202);
  // The same name in another project is a different database.
  expect(
    (
      await request("/v1/databases", f.otherKey, "POST", {
        project_id: f.other,
        region_id: f.region,
        name: "orders",
        size_class_id: f.size,
      })
    ).status,
  ).toBe(202);
  expect(await names("/v1/databases?name=orders", f.integrator)).toEqual([
    "orders",
  ]);
  expect(await names("/v1/databases?name=Orders", f.integrator)).toEqual([]);
  expect(await names("/v1/databases?name=order", f.integrator)).toEqual([]);
  expect(await names("/v1/databases?name=orders", f.otherKey)).toEqual([
    "orders",
  ]);
  // An administrator key is not bound to one project and sees both, or narrows by project.
  expect(await names("/v1/databases?name=orders", f.admin)).toEqual([
    "orders",
    "orders",
  ]);
  expect(
    await names(`/v1/databases?name=orders&project_id=${f.other}`, f.admin),
  ).toEqual(["orders"]);
  // A project of another tenant is not searchable, whatever the name.
  expect(
    (
      await request(
        `/v1/databases?name=orders&project_id=${f.other}`,
        f.integrator,
      )
    ).status,
  ).toBe(404);
  expect(
    (await request("/v1/databases?name=not%20a%20name", f.integrator)).status,
  ).toBe(400);
});

it("lists the regions a database can be placed in with nothing else", async () => {
  const f = await fixture();
  const other = await fixture();
  const page = async (query = "") =>
    (await request(`/v1/regions${query}`, f.integrator)).json<{
      data: { id: string; provider_region: string }[];
      next_cursor: string | null;
    }>();
  const ours = [f.region, other.region];
  const body = await page("?limit=100");
  const listed = body.data.filter((region) => ours.includes(region.id));
  expect(listed.map((region) => region.id).sort()).toEqual([...ours].sort());
  // Exactly these two fields: no node, capacity, cost, gateway or backup data.
  for (const region of listed)
    expect(region).toEqual({ id: region.id, provider_region: "test" });
  // A region without a node that takes databases is not offered; the fixture's second region has none.
  expect(body.data.map((region) => region.id)).not.toContain(f.foreign);
  // Closing placement on its only node takes the region out.
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  expect(
    (await page("?limit=100")).data.map((region) => region.id),
  ).not.toContain(f.region);
  // An operator still reads the full record of every region.
  const admin = await (
    await request("/v1/regions?limit=100", f.admin)
  ).json<{
    data: { id: string; gateway_url?: string }[];
  }>();
  expect(admin.data.find((region) => region.id === f.foreign)).toHaveProperty(
    "gateway_url",
  );
});

it("pages through the regions newest first with a cursor", async () => {
  const f = await fixture();
  const other = await fixture();
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 50; turn++) {
    const query: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await (
      await request(`/v1/regions${query}`, f.integrator)
    ).json<{ data: { id: string }[]; next_cursor: string | null }>();
    expect(body.data.length).toBeLessThanOrEqual(1);
    seen.push(...body.data.map((region) => region.id));
    cursor = body.next_cursor;
    if (cursor === null) break;
  }
  expect(seen).toEqual(expect.arrayContaining([f.region, other.region]));
  expect(new Set(seen).size).toBe(seen.length);
});

async function ready(f: Fixture) {
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect((await report(f, id, 1)).status).toBe(200);
  return { id, create: created.operation };
}

it("lists the operations of one database newest first with a cursor", async () => {
  const f = await fixture();
  const { id, create } = await ready(f);
  const observe = async (generation: number) =>
    expect((await report(f, id, generation)).status).toBe(200);
  const role = await request(
    `/v1/databases/${id}/roles`,
    f.integrator,
    "POST",
    { name: "reader" },
    key(),
  );
  expect(role.status).toBe(201);
  await observe(2);
  const removed = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${id}/roles/reader`,
        f.integrator,
        "DELETE",
        undefined,
        key(),
      )
    ).json(),
  );
  await observe(3);
  const suspended = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  const page = (query = "") =>
    request(`/v1/databases/${id}/operations${query}`, f.integrator);
  const all = listEnvelope(Operation).parse(await (await page()).json());
  // Role removals live in their own table; the list shows them with the others.
  expect(new Set(all.data.map((operation) => operation.id))).toEqual(
    new Set([create.id, removed.operation.id, suspended.operation.id]),
  );
  expect(all.data.map((operation) => operation.kind).sort()).toEqual([
    "database.create",
    "database.role.delete",
    "database.suspend",
  ]);
  expect(all.data.every((operation) => operation.database_id === id)).toBe(
    true,
  );
  const created = all.data.map((operation) => operation.created_at);
  expect([...created].sort().reverse()).toEqual(created);
  // The same view as the single read.
  const single = Operation.parse(
    await (
      await request(`/v1/operations/${suspended.operation.id}`, f.integrator)
    ).json(),
  );
  expect(all.data.find((operation) => operation.id === single.id)).toEqual(
    single,
  );
  // One at a time, in the same order, without repeats.
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 10; turn++) {
    const next: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const part = (await (await page(next)).json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    walked.push(...part.data.map((operation) => operation.id));
    cursor = part.next_cursor;
    if (cursor === null) break;
  }
  expect(walked).toEqual(all.data.map((operation) => operation.id));
  expect(
    await refusal(
      await request(`/v1/databases/${id}/operations?limit=0`, f.integrator),
    ),
  ).toMatchObject({ status: 400 });
  expect(
    (await request(`/v1/databases/${id}/operations`, f.otherKey)).status,
  ).toBe(404);
});

it("keeps the operations of a deleted database readable", async () => {
  const f = await fixture();
  const { id } = await ready(f);
  const deleted = DatabaseWithOperation.parse(
    await (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).json(),
  );
  const listed = listEnvelope(Operation).parse(
    await (
      await request(`/v1/databases/${id}/operations`, f.integrator)
    ).json(),
  );
  expect(listed.data.map((operation) => operation.id)).toContain(
    deleted.operation.id,
  );
});
