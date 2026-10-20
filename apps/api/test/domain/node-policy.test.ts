// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { NodePolicy } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  nodePolicy,
  refusal,
  request,
} from "./fixtures.ts";
import { nextMessage, openLink } from "./node-fixtures.ts";

afterEach(cleanupFixtures);

const path = (region: string) => `/v1/regions/${region}/node-policy`;

it("is read and set by an administrator, region by region, and refuses what the contract does not allow", async () => {
  const f = await fixture();
  expect((await request(path(f.region), f.admin)).status).toBe(404);
  const set = await request(path(f.region), f.admin, "PUT", nodePolicy());
  expect(set.status).toBe(200);
  expect(NodePolicy.parse(await set.json())).toEqual(nodePolicy());
  expect(
    NodePolicy.parse(await (await request(path(f.region), f.admin)).json()),
  ).toEqual(nodePolicy());
  // Another region keeps no policy of its own until it is set.
  expect((await request(path(f.foreign), f.admin)).status).toBe(404);
  expect((await request(path(f.region), f.integrator)).status).toBe(403);
  expect(
    (await request(path(f.region), f.integrator, "PUT", nodePolicy())).status,
  ).toBe(403);
  const invalid = await request(path(f.region), f.admin, "PUT", {
    ...nodePolicy(),
    extra: true,
  });
  expect((await refusal(invalid)).status).toBe(400);
  expect(
    (await request(path("no-such-region"), f.admin, "PUT", nodePolicy()))
      .status,
  ).toBe(404);
  expect(
    await env.DB.prepare(
      "SELECT node_policy_json FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first("node_policy_json"),
  ).toBe(JSON.stringify(nodePolicy()));
});

it("tells the connected nodes of the region to pull their page", async () => {
  const f = await fixture();
  const socket = await openLink(f);
  const hint = nextMessage(socket);
  expect(
    (await request(path(f.region), f.admin, "PUT", nodePolicy())).status,
  ).toBe(200);
  expect(JSON.parse(await hint)).toEqual({ type: "desired" });
  socket.close(1000);
});

it("sets the CPU burst after a wake as it is given, 0 included, and refuses a burst the contract does not allow", async () => {
  const f = await fixture();
  const burst = (cpu_boost_ms: unknown) => ({
    ...nodePolicy(),
    admission: { ...nodePolicy().admission, cpu_boost_ms },
  });
  for (const cpu_boost_ms of [0, 1500, 60_000]) {
    const set = await request(
      path(f.region),
      f.admin,
      "PUT",
      burst(cpu_boost_ms),
    );
    expect(set.status).toBe(200);
    expect(
      NodePolicy.parse(await (await request(path(f.region), f.admin)).json())
        .admission.cpu_boost_ms,
    ).toBe(cpu_boost_ms);
  }
  // A policy is replaced as a whole: one without the field, or with a number that is no burst, is
  // refused, and the policy that was set stays.
  for (const broken of [undefined, -1, 1.5, 60_001, "5000"]) {
    const refused = await request(
      path(f.region),
      f.admin,
      "PUT",
      burst(broken),
    );
    expect((await refusal(refused)).status).toBe(400);
  }
  expect(
    NodePolicy.parse(await (await request(path(f.region), f.admin)).json())
      .admission.cpu_boost_ms,
  ).toBe(60_000);
});

it("reaches the node's page, and a policy stored before the field existed is read with the default after migration 0081", async () => {
  const f = await fixture();
  const legacy = nodePolicy();
  delete (legacy.admission as Partial<typeof legacy.admission>).cpu_boost_ms;
  await env.DB.prepare(
    "INSERT INTO node_region_policies(region_id,node_policy_json) VALUES(?,?) ON CONFLICT(region_id) DO UPDATE SET node_policy_json=excluded.node_policy_json",
  )
    .bind(f.region, JSON.stringify(legacy))
    .run();
  // The stored policy no longer parses: the page of every node of the region would fail with it.
  expect((await request(path(f.region), f.admin)).status).toBe(500);
  const migration = (
    env as typeof env & { TEST_MIGRATIONS: D1Migration[] }
  ).TEST_MIGRATIONS.filter((m) => m.name.startsWith("0081_"));
  expect(migration.map((m) => m.name)).toEqual([
    "0081_node_policy_cpu_boost.sql",
  ]);
  await env.DB.batch(
    migration.flatMap((m) => m.queries.map((q) => env.DB.prepare(q))),
  );
  const read = await request(path(f.region), f.admin);
  expect(read.status).toBe(200);
  expect(NodePolicy.parse(await read.json())).toEqual(nodePolicy());
  // A policy that has the field keeps its value.
  const kept = {
    ...nodePolicy(),
    admission: { ...nodePolicy().admission, cpu_boost_ms: 0 },
  };
  await request(path(f.region), f.admin, "PUT", kept);
  await env.DB.batch(
    migration.flatMap((m) => m.queries.map((q) => env.DB.prepare(q))),
  );
  expect(
    NodePolicy.parse(await (await request(path(f.region), f.admin)).json())
      .admission.cpu_boost_ms,
  ).toBe(0);
});
