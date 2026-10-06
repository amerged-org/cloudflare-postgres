// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);
const actual = (region: string) => ({
  region_id: region,
  max_nodes: 3,
  purchases_enabled: false,
  order: null,
  placement_mode: "actual_ram",
  maximum_database_memory_mib: 4096,
  postgres_memory_request_mib: 128,
});

it("does not change request geometry for an assigned cohort or shrink its maximum below an existing class", async () => {
  const f = await fixture(4096, 40);
  const uid = crypto.randomUUID();
  const provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  await configureNodeRegionPolicy(env.DB, actual(f.region));
  const capacity = 24 * 1024 ** 3;
  for (let i = 9; i >= 0; i--) {
    const observedAt = new Date(Date.now() - i * 60000).toISOString();
    await recordNodeMemoryObservation(
      env.DB,
      f.region,
      {
        node_id: f.node,
        provider_instance_id: provider,
        node_uid: uid,
        memory: {
          node_uid: uid,
          observed_at: observedAt,
          working_set_bytes: capacity / 4,
          capacity_memory_bytes: capacity,
          available_bytes: (capacity * 3) / 4,
          memory_pressure: false,
        },
      },
      observedAt,
      Date.parse(observedAt),
    );
  }
  const created = DatabaseWithOperation.parse(
    await (await f.create("policy-cohort")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(created.database.id)
      .first("node_id"),
  ).toBe(f.node);
  for (const change of [
    { ...actual(f.region), placement_mode: "reserved" },
    { ...actual(f.region), postgres_memory_request_mib: 256 },
    { ...actual(f.region), maximum_database_memory_mib: 256 },
  ]) {
    await expect(
      configureNodeRegionPolicy(env.DB, change),
    ).rejects.toMatchObject({ code: "conflict" });
  }
  await configureNodeRegionPolicy(env.DB, {
    ...actual(f.region),
    max_nodes: 4,
  });
  expect(
    await env.DB.prepare(
      "SELECT placement_mode,postgres_memory_request_mib,maximum_database_memory_mib,max_nodes FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toMatchObject({
    placement_mode: "actual_ram",
    postgres_memory_request_mib: 128,
    maximum_database_memory_mib: 4096,
    max_nodes: 4,
  });
});

it("requires an empty assigned cohort before reserved placement becomes actual RAM, while pending unplaced demand is safe", async () => {
  const assigned = await fixture(4096, 40);
  const created = DatabaseWithOperation.parse(
    await (await assigned.create("reserved-cohort")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(created.database.id)
      .first("node_id"),
  ).toBe(assigned.node);
  await expect(
    configureNodeRegionPolicy(env.DB, actual(assigned.region)),
  ).rejects.toMatchObject({ code: "conflict" });
  const pending = await fixture(4096, 40);
  await env.DB.prepare(
    "UPDATE nodes SET ready=0,schedulable=0 WHERE region_id=?",
  )
    .bind(pending.region)
    .run();
  const waiting = DatabaseWithOperation.parse(
    await (await pending.create("unplaced-cohort")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(waiting.database.id)
      .first("node_id"),
  ).toBeNull();
  await configureNodeRegionPolicy(env.DB, actual(pending.region));
  expect(
    await env.DB.prepare(
      "SELECT placement_mode FROM node_region_policies WHERE region_id=?",
    )
      .bind(pending.region)
      .first("placement_mode"),
  ).toBe("actual_ram");
});
