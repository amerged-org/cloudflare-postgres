// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

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

it("rejects active assigned cohorts while allowing pending unplaced demand to enter actual RAM", async () => {
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

it("preserves an assigned cohort while changing RAM policy only after every manual suspension is confirmed", async () => {
  const f = await fixture(4096, 40);
  const uid = crypto.randomUUID();
  const provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  const ids: string[] = [];
  for (const name of ["retained-first", "retained-second"]) {
    const created = DatabaseWithOperation.parse(
      await (await f.create(name)).json(),
    );
    ids.push(created.database.id);
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([
            observation(created.database.id, created.database.generation),
          ]),
        )
      ).status,
    ).toBe(200);
  }
  const readCohort = async () => ({
    databases: (
      await env.DB.prepare(
        "SELECT id,node_id,project_id,region_id,size_class_id,storage_generation,archive_path,generation,desired_state,suspension_reason,power_operation,observed_generation,observed_power,deleted_at FROM databases WHERE region_id=? ORDER BY id",
      )
        .bind(f.region)
        .all()
    ).results,
    roles: (
      await env.DB.prepare(
        "SELECT r.* FROM roles r JOIN databases d ON d.id=r.database_id WHERE d.region_id=? ORDER BY r.database_id,r.name",
      )
        .bind(f.region)
        .all()
    ).results,
  });
  const suspensions: DatabaseWithOperation[] = [];
  for (const id of ids) {
    const stopped = DatabaseWithOperation.parse(
      await (
        await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
      ).json(),
    );
    suspensions.push(stopped);
  }
  await expect(
    configureNodeRegionPolicy(env.DB, actual(f.region)),
  ).rejects.toMatchObject({ code: "conflict" });
  const confirm = async (stopped: DatabaseWithOperation) => {
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([
            {
              ...observation(
                stopped.database.id,
                stopped.database.generation,
                "hibernated",
              ),
              power: {
                operation: stopped.operation.id,
                revision: stopped.database.generation,
                state: "hibernated",
              },
            },
          ]),
        )
      ).status,
    ).toBe(200);
  };
  await confirm(suspensions[0]!);
  await expect(
    configureNodeRegionPolicy(env.DB, actual(f.region)),
  ).rejects.toMatchObject({ code: "conflict" });
  await confirm(suspensions[1]!);
  // Idle sleep is not the owner's explicit maintenance stop.
  const stopped = suspensions[0]!;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET suspension_reason='idle' WHERE id=?",
    ).bind(stopped.database.id),
    env.DB.prepare(
      "UPDATE operations SET kind='database.hibernate' WHERE id=?",
    ).bind(stopped.operation.id),
  ]);
  await expect(
    configureNodeRegionPolicy(env.DB, actual(f.region)),
  ).rejects.toMatchObject({ code: "conflict" });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET suspension_reason='manual' WHERE id=?",
    ).bind(stopped.database.id),
    env.DB.prepare(
      "UPDATE operations SET kind='database.suspend' WHERE id=?",
    ).bind(stopped.operation.id),
  ]);
  // A confirmed stop must not erase an unresolved old startup grant.
  await env.DB.prepare(
    "INSERT INTO database_start_admissions(operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      stopped.operation.id,
      stopped.database.id,
      stopped.database.generation,
      f.node,
      crypto.randomUUID(),
      1024 * 1024 ** 2,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await expect(
    configureNodeRegionPolicy(env.DB, actual(f.region)),
  ).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare(
    "DELETE FROM database_start_admissions WHERE operation_id=?",
  )
    .bind(stopped.operation.id)
    .run();
  // A newer intent cannot borrow the preceding generation's quiescence.
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1 WHERE id=?",
  )
    .bind(stopped.database.id)
    .run();
  await expect(
    configureNodeRegionPolicy(env.DB, actual(f.region)),
  ).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare(
    "UPDATE databases SET generation=generation-1 WHERE id=?",
  )
    .bind(stopped.database.id)
    .run();
  const before = await readCohort();
  await configureNodeRegionPolicy(env.DB, actual(f.region));
  expect(await readCohort()).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT placement_mode,postgres_memory_request_mib,maximum_database_memory_mib FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({
    placement_mode: "actual_ram",
    postgres_memory_request_mib: 128,
    maximum_database_memory_mib: 4096,
  });
  expect(
    (await request(`/v1/databases/${ids[0]}/resume`, f.integrator, "POST"))
      .status,
  ).toBe(409);
  expect(await readCohort()).toEqual(before);
  const observedAt = new Date().toISOString();
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
        working_set_bytes: 1024 ** 3,
        capacity_memory_bytes: 4 * 1024 ** 3,
        available_bytes: 3 * 1024 ** 3,
        memory_pressure: false,
      },
    },
    observedAt,
  );
  const resumed = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${ids[0]}/resume`, f.integrator, "POST")
    ).json(),
  );
  expect(resumed.database.id).toBe(ids[0]);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(
    desired.databases.find((d) => d.id === ids[0])?.size.memory_request_mib,
  ).toBe(128);
  expect(desired.databases.find((d) => d.id === ids[1])?.desired_state).toBe(
    "suspended",
  );
  expect(
    await env.DB.prepare(
      "SELECT budget_bytes FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(resumed.operation.id)
      .first("budget_bytes"),
  ).toBe(1024 * 1024 ** 2);
});
