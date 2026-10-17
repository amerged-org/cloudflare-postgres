// SPDX-License-Identifier: Apache-2.0
// A region's desired page: the controller pulls it on every wake hint, so its reads that do not
// depend on one another are issued together. Real D1 harness; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { DesiredResponse } from "@pgcf/contracts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { awakeWriter } from "./thin-writer-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("the desired page reads the region's independent data together", async () => {
  const f = await fixture();
  await request("/v1/databases", f.integrator, "POST", {
    name: "page",
    region_id: f.region,
    size_class: f.size,
  });
  // The first execution of the admission capability read is held back until the page has issued
  // its other region reads.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started: string[] = [];
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  let held = false;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (
            property === "first" ||
            property === "all" ||
            property === "run" ||
            property === "raw"
          )
            return async (...args: unknown[]) => {
              started.push(sql);
              const holdThis =
                !held &&
                sql.includes(
                  "json_extract(ars.spec_json,'$.admission_snapshot_version')=1",
                );
              if (holdThis) {
                held = true;
                await gate;
              }
              return Reflect.apply(Reflect.get(target, property), target, args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(original.call(this, sql));
  });
  const response = request("/agent/v1/desired", f.agent);
  for (
    let i = 0;
    i < 400 &&
    !started.some((sql) => sql.includes("FROM node_region_policies")) &&
    !started.some((sql) => sql.includes("FROM region_archive_sources"));
    i++
  )
    await sleep(5);
  expect(held).toBe(true);
  expect(started.some((sql) => sql.includes("FROM node_region_policies"))).toBe(
    true,
  );
  expect(
    started.some((sql) => sql.includes("FROM region_archive_sources")),
  ).toBe(true);
  open();
  expect((await response).status).toBe(200);
}, 30_000);

it("the desired page reads a thin node's identity proof once for its region and its databases", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  let reads = 0;
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "first" && sql.startsWith("SELECT t.*,n.region_id"))
            return (...args: unknown[]) => {
              reads++;
              return Reflect.apply(target.first, target, args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(original.call(this, sql));
  });
  const page = DesiredResponse.parse(
    await (await request("/agent/v1/desired", w.f.agent)).json(),
  );
  const record = page.databases.find((database) => database.id === w.id)!;
  expect(record.storage).toBeDefined();
  expect(page.region.storage_nodes).toHaveLength(1);
  expect(reads).toBe(1);
}, 30_000);
