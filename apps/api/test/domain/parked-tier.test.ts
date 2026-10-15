// SPDX-License-Identifier: Apache-2.0
// The API half of the parked sleep tier on real D1: observation, accounting, host lease and policy.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  awakeWriter,
  databaseRow,
  hibernated,
  idleIntent,
  parkedPod,
  parkedWriter,
} from "./parked-tier-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  databaseCpuChargeSql,
  databaseParkedCpuSql,
  nodeCpuHeadroomSql,
} from "../../src/domain/startup-admission.ts";
import { placementNodes } from "../../src/domain/placement.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

const parkedRecord = async (id: string) => {
  const raw = (await databaseRow(id)).parked_json;
  return raw === null || raw === undefined ? null : JSON.parse(raw);
};
it("parked_observation_is_stored_only_for_idle_sleeps_and_cleared_by_ready_or_demotion", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases)),
    intent = await idleIntent(w);
  await w.evidence({ generation: intent.generation });
  // Nothing is stored before the controller confirms a parked sleep.
  expect(await parkedRecord(w.id)).toBeNull();
  const first = await hibernated(w, intent, parkedPod(w));
  expect(await first.json()).toEqual({ accepted: 1 });
  const stored = await parkedRecord(w.id);
  expect(stored).toEqual({
    v: 1,
    pod_uid: w.pod,
    generation: intent.generation,
    cpu_millicores: 15,
    memory_mib: 160,
    parked_at: expect.any(String),
    observed_at: expect.any(String),
  });
  // The customer-visible state is the ordinary hibernated one.
  expect(
    await (await request(`/v1/databases/${w.id}`, w.f.integrator)).json(),
  ).toMatchObject({
    desired_state: "suspended",
    observed_state: "hibernated",
    suspension_reason: "idle",
  });
  expect(
    await env.DB.prepare("SELECT observed_power FROM databases WHERE id=?")
      .bind(w.id)
      .first("observed_power"),
  ).toBe("hibernated");
  // A repeated report refreshes the freshness but keeps when the Pod was parked.
  await new Promise((done) => setTimeout(done, 5));
  expect(await (await hibernated(w, intent, parkedPod(w))).json()).toEqual({
    accepted: 1,
  });
  const again = await parkedRecord(w.id);
  expect(again.parked_at).toBe(stored.parked_at);
  expect(Date.parse(again.observed_at)).toBeGreaterThan(
    Date.parse(stored.observed_at),
  );
  // Demotion: the controller reports plain hibernation once the Pod is gone.
  expect(await (await hibernated(w, intent)).json()).toEqual({ accepted: 1 });
  expect(await parkedRecord(w.id)).toBeNull();
  expect(
    await env.DB.prepare("SELECT observed_power FROM databases WHERE id=?")
      .bind(w.id)
      .first("observed_power"),
  ).toBe("hibernated");
  // Parked again, then the wake's ready observation clears the hint for good.
  expect(await (await hibernated(w, intent, parkedPod(w))).json()).toEqual({
    accepted: 1,
  });
  expect(await parkedRecord(w.id)).not.toBeNull();
  const resumed = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${w.id}/resume`,
        w.f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  // An unrelated provisioning report leaves the hint untouched.
  await request("/agent/v1/observations", w.f.agent, "POST", {
    observed_at: new Date(Date.now() + 1000).toISOString(),
    nodes: [],
    databases: [
      {
        id: w.id,
        generation: resumed.database.generation,
        state: "provisioning",
        power: {
          operation: resumed.operation.id,
          revision: resumed.database.generation,
          state: "awake",
        },
        archive: { continuous: true, ready_wal_files: 0 },
      },
    ],
    orphans: [],
  });
  expect(await parkedRecord(w.id)).not.toBeNull();
  expect(
    (await w.ready(resumed.database.generation, resumed.operation.id)).status,
  ).toBe(200);
  expect(await parkedRecord(w.id)).toBeNull();
  expect(
    await env.DB.prepare("SELECT observed_power FROM databases WHERE id=?")
      .bind(w.id)
      .first("observed_power"),
  ).toBe("awake");
});

it("a_parked_observation_is_refused_for_a_manual_suspend", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const suspended = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${w.id}/suspend`,
        w.f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  const manual = {
    operation: suspended.operation.id,
    generation: suspended.database.generation,
  };
  // An explicit suspend is always a real hibernation; a Pod claim there is not recorded and does
  // not complete the sleep, so the full charge stays.
  expect(await (await hibernated(w, manual, parkedPod(w))).json()).toEqual({
    accepted: 0,
  });
  expect(await parkedRecord(w.id)).toBeNull();
  expect(
    await env.DB.prepare("SELECT observed_power FROM databases WHERE id=?")
      .bind(w.id)
      .first("observed_power"),
  ).toBe("awake");
  expect(await (await hibernated(w, manual)).json()).toEqual({ accepted: 1 });
});

it("parked_cpu_is_charged_in_node_headroom_and_placement_but_cold_predicates_still_hold", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases)),
    f = w.f;
  const evaluate = (sql: string) =>
    env.DB.prepare(
      `SELECT ${sql} value FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
    )
      .bind(w.id)
      .first<number>("value");
  const reserved = async () =>
    (await placementNodes(env.DB, f.region))[0]!.reserved_cpu_millicores;
  // Awake: the full request; the parked term is zero.
  expect(await evaluate(databaseCpuChargeSql("d", "s"))).toBe(600);
  expect(await evaluate(databaseParkedCpuSql("d", "s"))).toBe(0);
  expect(await reserved()).toBe(600);
  // Until the controller confirms the sleep nothing is released.
  const intent = await idleIntent(w);
  await w.evidence({ generation: intent.generation });
  expect(await reserved()).toBe(600);
  expect(await (await hibernated(w, intent, parkedPod(w))).json()).toEqual({
    accepted: 1,
  });
  // The parked sleep keeps only the Pod's shrunken request, in placement and in start admission,
  // while every "confirmed cold" predicate (resize, rollouts) still sees a stopped database.
  expect(await evaluate(databaseCpuChargeSql("d", "s"))).toBe(0);
  expect(await evaluate(databaseParkedCpuSql("d", "s"))).toBe(15);
  expect(await reserved()).toBe(15);
  const canStart = async () =>
    (
      await env.DB.prepare(
        `SELECT n.id FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=? AND ${nodeCpuHeadroomSql("n", "s")}`,
      )
        .bind(f.size, f.node)
        .all()
    ).results.length === 1;
  // Free CPU is 14 millicores short of one 600 millicore start while the parked Pod is counted.
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+600+14 WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(await canStart()).toBe(false);
  const hint = (await databaseRow(w.id)).parked_json!;
  await env.DB.prepare("UPDATE databases SET parked_json=NULL WHERE id=?")
    .bind(w.id)
    .run();
  expect(await canStart()).toBe(true);
  await env.DB.prepare("UPDATE databases SET parked_json=? WHERE id=?")
    .bind(hint, w.id)
    .run();
  // A wake claims the full request again, and the term is gone with the desired state.
  const resumed = await request(
    `/v1/databases/${w.id}/resume`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(resumed.status).toBe(202);
  expect(await evaluate(databaseParkedCpuSql("d", "s"))).toBe(0);
  expect(await evaluate(databaseCpuChargeSql("d", "s"))).toBe(600);
  expect(await reserved()).toBe(600);
});

it("the_hibernated_lifecycle_snapshot_of_a_parked_sleep_reserves_the_parked_cpu", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases)),
    intent = await idleIntent(w);
  expect(await (await hibernated(w, intent, parkedPod(w))).json()).toEqual({
    accepted: 1,
  });
  expect(
    JSON.parse(
      (await env.DB.prepare(
        "SELECT resource_snapshot FROM lifecycle_events WHERE database_id=? AND kind='hibernated'",
      )
        .bind(w.id)
        .first<string>("resource_snapshot"))!,
    ),
  ).toMatchObject({ reserved_cpu_millicores: 15 });
});

it("a_parked_database_can_be_resized_while_it_counts_as_cold", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  await parkedWriter(w);
  const target = "r" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
    SELECT ?,1024,750,storage_gib,80,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(target, w.f.size)
    .run();
  try {
    const resized = await request(
      `/v1/databases/${w.id}`,
      w.f.integrator,
      "PATCH",
      { size_class_id: target },
      crypto.randomUUID(),
    );
    expect(resized.status).toBe(202);
    // The hint survives a D1-only resize; the controller's next pass demotes on the drifted spec.
    expect(await parkedRecord(w.id)).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT size_class_id FROM databases WHERE id=?")
        .bind(w.id)
        .first("size_class_id"),
    ).toBe(target);
  } finally {
    await env.DB.prepare("UPDATE databases SET size_class_id=? WHERE id=?")
      .bind(w.f.size, w.id)
      .run();
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?")
      .bind(target)
      .run();
  }
});
