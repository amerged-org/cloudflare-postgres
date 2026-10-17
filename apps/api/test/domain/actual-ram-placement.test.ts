// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const physicalCapacity = 24 * 2 ** 30;
async function setup() {
  const f = await fixture(physicalCapacity / 1024 ** 2, 40),
    uid = crypto.randomUUID(),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=?,allocatable_cpu_millicores=12000 WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    ram_expansion_threshold_ppm: 760_000,
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  return { ...f, uid, provider };
}
async function seed(
  f: Fixture & { uid: string; provider: string },
  percent: number,
  at = Date.now(),
  accepted = true,
) {
  for (let i = 9; i >= 0; i--) {
    const time = at - i * 60_000,
      observed_at = new Date(time).toISOString();
    const recorded = await recordNodeMemoryObservation(
      env.DB,
      f.region,
      {
        node_id: f.node,
        provider_instance_id: f.provider,
        node_uid: f.uid,
        memory: {
          node_uid: f.uid,
          observed_at,
          working_set_bytes: Math.ceil((physicalCapacity * percent) / 100),
          capacity_memory_bytes: physicalCapacity,
          available_bytes:
            physicalCapacity - Math.ceil((physicalCapacity * percent) / 100),
          memory_pressure: false,
        },
      },
      observed_at,
      time,
    );
    expect(recorded).toBe(accepted);
  }
}

it("expands proactively at 76 percent while keeping old placement available under hard capacity guards", async () => {
  const f = await setup();
  expect(
    DatabaseWithOperation.parse(await (await f.create("missing-sample")).json())
      .database.observed_state,
  ).toBe("pending");
  // Keep newer synthetic observations within the same ten minute buckets.
  const sampleAt = Math.floor(Date.now() / 60_000) * 60_000;
  await seed(f, 75, sampleAt);
  const first = DatabaseWithOperation.parse(
    await (await f.create("overbooked")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(first.database.id)
      .first("node_id"),
  ).toBe(f.node);
  expect(
    await env.DB.prepare(
      "SELECT memory_expansion_triggered_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first("memory_expansion_triggered_at"),
  ).toBeNull();
  await seed(f, 76, sampleAt, false);
  await seed(f, 76, sampleAt + 1);
  const expanding = await env.DB.prepare(
    "SELECT ready,schedulable,database_placement_closed_at,memory_expansion_triggered_at FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first<{
      ready: number;
      schedulable: number;
      database_placement_closed_at: string | null;
      memory_expansion_triggered_at: string;
    }>();
  expect(expanding).toMatchObject({
    ready: 1,
    schedulable: 1,
    database_placement_closed_at: null,
  });
  expect(expanding?.memory_expansion_triggered_at).toBeTruthy();
  await seed(f, 81, sampleAt + 2);
  const later = DatabaseWithOperation.parse(
    await (await f.create("onboard-during-rollout")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(later.database.id)
      .first("node_id"),
  ).toBe(f.node);
  await seed(f, 20, sampleAt + 3);
  expect(
    await env.DB.prepare(
      "SELECT memory_expansion_triggered_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first("memory_expansion_triggered_at"),
  ).toBe(expanding?.memory_expansion_triggered_at);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(desired.databases.map((d) => d.id)).toContain(first.database.id);
  expect(desired.region.scheduling).toEqual({
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  expect(
    desired.databases.find((d) => d.id === first.database.id)?.size
      .memory_request_mib,
  ).toBe(128);
});

it("binds samples to physical UID, keeps control nodes Ready, and rejects oversized classes", async () => {
  const f = await setup();
  await seed(f, 20);
  const wrong = crypto.randomUUID(),
    time = new Date().toISOString();
  expect(
    await recordNodeMemoryObservation(
      env.DB,
      f.region,
      {
        node_id: f.node,
        provider_instance_id: f.provider,
        node_uid: wrong,
        memory: {
          node_uid: wrong,
          observed_at: time,
          working_set_bytes: Math.ceil(physicalCapacity * 0.99),
          capacity_memory_bytes: physicalCapacity,
          available_bytes:
            physicalCapacity - Math.ceil(physicalCapacity * 0.99),
          memory_pressure: false,
        },
      },
      time,
    ),
  ).toBe(false);
  const control = await request(
    `/v1/nodes/${f.node}/database-placement`,
    f.admin,
    "PUT",
    { expected_node_uid: f.uid, database_placement_enabled: false },
  );
  expect(control.status).toBe(200);
  const nodeReport = {
    name: f.nodeName,
    node_id: f.node,
    node_uid: f.uid,
    provider_instance_id: f.provider,
    ready: true,
    allocatable_memory_mib: 128,
    allocatable_cpu_millicores: 12000,
    storage_gib_total: 40,
    platform_reserved_memory_mib: 128,
    platform_reserved_cpu_millicores: 100,
  };
  expect(
    (
      await request("/agent/v1/observations", f.agent, "POST", {
        observed_at: new Date().toISOString(),
        nodes: [nodeReport],
        databases: [],
        orphans: [],
      })
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT ready,schedulable,database_placement_enabled FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({ ready: 1, schedulable: 1, database_placement_enabled: 0 });
  expect(
    DatabaseWithOperation.parse(await (await f.create()).json()).database
      .observed_state,
  ).toBe("pending");
  await env.DB.prepare("UPDATE size_classes SET memory_mib=8192 WHERE id=?")
    .bind(f.size)
    .run();
  expect((await f.create("too-large")).status).toBe(400);
});
it("accepts a samples-only report without replacing node or orphan inventory", async () => {
  const f = await setup();
  const stub = env.REGION_LINK.get(env.REGION_LINK.idFromName(f.region)),
    at = new Date().toISOString(),
    orphans = [{ namespace: "owned-orphan", database_id: null }];
  await stub.reportOrphans(at, orphans);
  const observed_at = new Date(Date.now() + 1000).toISOString();
  const result = await request("/agent/v1/observations", f.agent, "POST", {
    observed_at,
    nodes: [],
    databases: [],
    orphans: [],
    node_memory_samples: [
      {
        node_id: f.node,
        provider_instance_id: f.provider,
        node_uid: f.uid,
        memory: {
          node_uid: f.uid,
          observed_at,
          working_set_bytes: Math.ceil(physicalCapacity * 0.2),
          capacity_memory_bytes: physicalCapacity,
          available_bytes: physicalCapacity - Math.ceil(physicalCapacity * 0.2),
          memory_pressure: false,
        },
      },
    ],
  });
  expect(result.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT ready,schedulable FROM nodes WHERE id=?")
      .bind(f.node)
      .first(),
  ).toEqual({ ready: 1, schedulable: 1 });
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ observed_at: string; orphans: string }>(
        "SELECT observed_at,orphans FROM orphan_reports",
      )
      .toArray(),
  );
  expect(rows).toEqual([{ observed_at: at, orphans: JSON.stringify(orphans) }]);
});
