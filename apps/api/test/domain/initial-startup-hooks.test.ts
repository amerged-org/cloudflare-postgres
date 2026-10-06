// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, SIDECAR, newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import {
  placePendingDatabases,
  runNodeCapacity,
} from "../../src/domain/node-capacity.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

const mib = 1024 * 1024,
  capacity = 24 * 1024 * mib;
const extraClasses: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of extraClasses.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});
async function physical() {
  const f = await fixture(capacity / mib, 40),
    uid = crypto.randomUUID(),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=?,allocatable_cpu_millicores=12000 WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  return { ...f, uid, provider };
}
async function actual(f: Awaited<ReturnType<typeof physical>>) {
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
}
async function sample(
  f: Awaited<ReturnType<typeof physical>>,
  available: number,
  observedAt = Date.now(),
  percent = 20,
) {
  const observed_at = new Date(observedAt).toISOString();
  await recordNodeMemoryObservation(
    env.DB,
    f.region,
    {
      node_id: f.node,
      provider_instance_id: f.provider,
      node_uid: f.uid,
      memory: {
        node_uid: f.uid,
        observed_at,
        working_set_bytes: Math.ceil((capacity * percent) / 100),
        capacity_memory_bytes: capacity,
        available_bytes: available,
        memory_pressure: false,
      },
    },
    observed_at,
    Math.max(Date.now(), observedAt),
  );
}
async function baseline(
  f: Awaited<ReturnType<typeof physical>>,
  available: number,
  percent = 20,
) {
  const now = Date.now();
  for (let i = 9; i >= 0; i--)
    await sample(f, available, now - i * 60_000, percent);
}

it("admits one concurrent placed create with one full startup hold and leaves the other unplaced", async () => {
  const f = await physical();
  await actual(f);
  await baseline(f, (512 + SIDECAR.limitMemoryMib) * mib);
  const results = await Promise.all([f.create("first"), f.create("second")]);
  expect(results.map((r) => r.status)).toEqual([202, 202]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM databases WHERE project_id=? AND node_id IS NOT NULL",
    )
      .bind(f.project)
      .first("count(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM database_start_admissions WHERE node_id=?",
    )
      .bind(f.node)
      .first("count(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT budget_bytes FROM database_start_admissions WHERE node_id=?",
    )
      .bind(f.node)
      .first("budget_bytes"),
  ).toBe((512 + SIDECAR.limitMemoryMib) * mib);
  expect((await runNodeCapacity(env, f.region, true)).action).toBe(
    "starts_in_progress",
  );
  const placed = await env.DB.prepare(
    "SELECT id FROM databases WHERE project_id=? AND node_id IS NOT NULL",
  )
    .bind(f.project)
    .first<{ id: string }>();
  const pending = await env.DB.prepare(
    "SELECT id FROM databases WHERE project_id=? AND node_id IS NULL",
  )
    .bind(f.project)
    .first<{ id: string }>();
  const ready = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(placed!.id, 1)]),
  );
  expect(await ready.json()).toEqual({ accepted: 1 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM lifecycle_events WHERE database_id=? AND kind='ready'",
    )
      .bind(placed!.id)
      .first("count(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT ready_at FROM database_start_admissions WHERE database_id=?",
    )
      .bind(placed!.id)
      .first("ready_at"),
  ).toBeTruthy();
  await sample(f, (512 + SIDECAR.limitMemoryMib) * mib);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM database_start_admissions WHERE node_id=?",
    )
      .bind(f.node)
      .first("count(*)"),
  ).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  await sample(f, (512 + SIDECAR.limitMemoryMib) * mib);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM database_start_admissions WHERE node_id=?",
    )
      .bind(f.node)
      .first("count(*)"),
  ).toBe(0);
  expect(await placePendingDatabases(env.DB, f.region)).toEqual([pending!.id]);
  expect(
    await env.DB.prepare(
      "SELECT database_id,generation FROM database_start_admissions WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({ database_id: pending!.id, generation: 1 });
}, 15_000);

it("refuses a running resize without target peak RAM, then reserves its new operation and exact target generation", async () => {
  const f = await physical();
  await actual(f);
  await baseline(f, 4 * 1024 * mib);
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_memory_mib=4096 WHERE id=?",
  )
    .bind(f.node)
    .run();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(created.database.id, 1)]),
  );
  await baseline(f, 1024 * mib);
  const target = "target-" + crypto.randomUUID().slice(0, 12);
  extraClasses.push(target);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
    SELECT ?,1024,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(target, f.size)
    .run();
  expect(
    (
      await request(
        `/v1/databases/${created.database.id}`,
        f.integrator,
        "PATCH",
        { size_class_id: target },
      )
    ).status,
  ).toBe(503);
  expect(
    await env.DB.prepare(
      "SELECT generation,size_class_id FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first(),
  ).toEqual({ generation: 1, size_class_id: f.size });
  await sample(
    f,
    (1024 + SIDECAR.limitMemoryMib + 512 + SIDECAR.limitMemoryMib) * mib,
    Date.now() + 1000,
  );
  const accepted = await request(
    `/v1/databases/${created.database.id}`,
    f.integrator,
    "PATCH",
    { size_class_id: target },
  );
  expect(accepted.status).toBe(202);
  const resized = DatabaseWithOperation.parse(await accepted.json());
  expect(
    await env.DB.prepare(
      "SELECT operation_id,generation,budget_bytes,ready_at FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(resized.operation.id)
      .first(),
  ).toEqual({
    operation_id: resized.operation.id,
    generation: 2,
    budget_bytes: (1024 + SIDECAR.limitMemoryMib) * mib,
    ready_at: null,
  });
  const confirmed = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(created.database.id, 2)]),
  );
  expect(await confirmed.json()).toEqual({ accepted: 1 });
  expect(
    await env.DB.prepare(
      "SELECT ready_at FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(resized.operation.id)
      .first("ready_at"),
  ).toBeTruthy();
});
it("selects a free worker when the lower-average worker already holds all startup RAM", async () => {
  const f = await physical();
  await actual(f);
  await baseline(f, (512 + SIDECAR.limitMemoryMib) * mib, 20);
  const first = DatabaseWithOperation.parse(
    await (await f.create("busy-low-average")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(first.database.id)
      .first("node_id"),
  ).toBe(f.node);
  const other = newNodeId(),
    uid = crypto.randomUUID(),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    `INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,provider_instance_id)
    SELECT ?,region_id,?,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,?,? FROM nodes WHERE id=?`,
  )
    .bind(other, "free-" + crypto.randomUUID(), uid, provider, f.node)
    .run();
  await baseline(
    { ...f, node: other, uid, provider },
    (512 + SIDECAR.limitMemoryMib) * mib,
    30,
  );
  const second = DatabaseWithOperation.parse(
    await (await f.create("free-worker")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(second.database.id)
      .first("node_id"),
  ).toBe(other);
});
it("queues an instant RAM shortage below the valid ten-minute threshold without adding a node", async () => {
  const f = await physical();
  await actual(f);
  await baseline(f, 512 * mib);
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=1,order_config=? WHERE region_id=?",
  )
    .bind(
      JSON.stringify({
        product_id: crypto.randomUUID(),
        provider_region: "test",
        image_id: crypto.randomUUID(),
        term_months: 1,
        location: "fixture location",
      }),
      f.region,
    )
    .run();
  const pending = DatabaseWithOperation.parse(
    await (await f.create("instant-shortage")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(pending.database.id)
      .first("node_id"),
  ).toBeNull();
  expect((await runNodeCapacity(env, f.region, true)).action).toBe(
    "memory_headroom_wait",
  );
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count(*)"),
  ).toBe(0);
});
