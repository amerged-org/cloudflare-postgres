// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { placementNodes } from "../../src/domain/placement.ts";
import { runResourceProfileRollouts } from "../../src/domain/resource-profiles.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

const resources = {
  memory_mib: 256,
  cpu_millicores: 250,
  cpu_request_millicores: 25,
  storage_gib: 5,
  max_connections: 20,
  sleep_after_seconds: 60,
  archive_timeout_seconds: 60,
  backup_retention_days: 7,
  enabled: true,
};
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM resource_profile_revisions"),
    env.DB.prepare("DELETE FROM resource_profiles"),
    env.DB.prepare("DELETE FROM size_classes WHERE id LIKE 'rp-%'"),
  ]);
});
async function configured(createProfile = true) {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([observation(id, 1)]),
      )
    ).status,
  ).toBe(200);
  if (createProfile)
    expect(
      (
        await request("/v1/resource-profiles/entry", f.admin, "PUT", {
          expected_revision: 0,
          resources,
        })
      ).status,
    ).toBe(200);
  const assignment = `/v1/databases/${id}/resource-profile`;
  expect(
    (
      await request(assignment, f.admin, "PUT", {
        profile_id: "entry",
        profile_revision: 1,
        expected_generation: 1,
      })
    ).status,
  ).toBe(202);
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([observation(id, 2)]),
      )
    ).status,
  ).toBe(200);
  return { ...f, id, assignment };
}
it("accepts a future profile for a confirmed sleeping database without starting it", async () => {
  const f = await configured();
  const suspend = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/suspend`, f.admin, "POST")
    ).json(),
  );
  const generation = suspend.database.generation;
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([
          {
            ...observation(f.id, generation, "hibernated"),
            power: {
              operation: suspend.operation.id,
              revision: generation,
              state: "hibernated",
            },
          },
        ]),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/v1/resource-profiles/entry", f.admin, "PUT", {
        expected_revision: 1,
        resources: { ...resources, memory_mib: 512 },
      })
    ).status,
  ).toBe(200);
  const assigned = await request(
    f.assignment,
    f.admin,
    "PUT",
    {
      profile_id: "entry",
      profile_revision: 2,
      expected_generation: generation,
    },
    "sleeping-profile",
  );
  expect(assigned.status).toBe(202);
  const result = DatabaseWithOperation.parse(await assigned.json());
  expect(result.database.desired_state).toBe("suspended");
  expect(result.database.generation).toBe(generation + 1);
  expect(
    (await placementNodes(env.DB, f.region))[0]!.reserved_cpu_millicores,
  ).toBe(0);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(desired.databases.find((d) => d.id === f.id)).toMatchObject({
    desired_state: "suspended",
    size: { memory_mib: 512 },
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    profile_revision: 2,
    applied: false,
  });
  // A stale proof cannot complete the new configuration revision.
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, generation, "hibernated"),
        power: {
          operation: suspend.operation.id,
          revision: generation,
          state: "hibernated",
        },
      },
    ]),
  );
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(result.operation.id)
      .first("status"),
  ).toBe("pending");
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, generation + 1, "hibernated"),
        power: {
          operation: suspend.operation.id,
          revision: generation + 1,
          state: "hibernated",
        },
      },
    ]),
  );
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(result.operation.id)
      .first("status"),
  ).toBe("succeeded");
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    application_state: "deferred_until_wake",
    applied: false,
  });
});
it("stores a bounded centrally selected rollout and exposes its pending database assignments", async () => {
  const f = await configured();
  expect(
    (
      await request("/v1/resource-profiles/entry", f.admin, "PUT", {
        expected_revision: 1,
        resources: { ...resources, memory_mib: 512 },
      })
    ).status,
  ).toBe(200);
  const path = "/v1/resource-profiles/entry/rollout";
  expect(
    (
      await request(path, f.integrator, "PUT", {
        profile_revision: 2,
        expected_revision: 0,
      })
    ).status,
  ).toBe(403);
  const selected = await request(
    path,
    f.admin,
    "PUT",
    { profile_revision: 2, expected_revision: 0 },
    "central-rollout",
  );
  expect(selected.status).toBe(200);
  expect(await selected.json()).toMatchObject({
    profile_id: "entry",
    profile_revision: 2,
    assignments: 1,
    applied: 0,
    pending: 1,
  });
  expect(
    (
      await request(path, f.admin, "PUT", {
        profile_revision: 1,
        expected_revision: 0,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        path,
        f.admin,
        "PUT",
        { profile_revision: 2, expected_revision: 0 },
        "central-rollout",
      )
    ).status,
  ).toBe(200);
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    profile_revision: 1,
    target_profile_revision: 2,
    application_state: "pending",
  });
});

it("converges one profile change across two regions using owned database operations", async () => {
  const eu = await configured();
  const us = await configured(false);
  expect(
    (
      await request("/v1/resource-profiles/entry", eu.admin, "PUT", {
        expected_revision: 1,
        resources: { ...resources, memory_mib: 512 },
      })
    ).status,
  ).toBe(200);
  const rollout = "/v1/resource-profiles/entry/rollout";
  expect(
    (
      await request(rollout, eu.admin, "PUT", {
        profile_revision: 2,
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);
  const results = await Promise.all([
    runResourceProfileRollouts(env),
    runResourceProfileRollouts(env),
  ]);
  expect(results.reduce((a, b) => a + b, 0)).toBe(2);
  // Both cron contenders use generation CAS; each database gets exactly one resize.
  for (const f of [eu, us]) {
    const desired = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    );
    expect(desired.databases.find((d) => d.id === f.id)).toMatchObject({
      generation: 3,
      size: { memory_mib: 512 },
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM operations WHERE database_id=? AND kind='database.resize' AND generation=3",
      )
        .bind(f.id)
        .first("n"),
    ).toBe(1);
    await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([observation(f.id, 3)]),
    );
    expect(
      await (await request(f.assignment, f.integrator)).json(),
    ).toMatchObject({
      profile_revision: 2,
      target_profile_revision: 2,
      applied: true,
    });
  }
  expect(await (await request(rollout, eu.admin)).json()).toMatchObject({
    assignments: 2,
    applied: 2,
    pending: 0,
    deferred: 0,
  });
  expect(await runResourceProfileRollouts(env)).toBe(0);
});
it("keeps an unconfirmed stop protected from a future configuration change", async () => {
  const f = await configured();
  const stopped = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/suspend`, f.admin, "POST")
    ).json(),
  );
  await request("/v1/resource-profiles/entry", f.admin, "PUT", {
    expected_revision: 1,
    resources: { ...resources, memory_mib: 512 },
  });
  expect(
    (
      await request(f.assignment, f.admin, "PUT", {
        profile_id: "entry",
        profile_revision: 2,
        expected_generation: stopped.database.generation,
      })
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(stopped.database.generation);
});

it("does not classify degraded or failed hibernation as deferred application", async () => {
  const f = await configured();
  const stopped = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/suspend`, f.admin, "POST")
    ).json(),
  );
  const generation = stopped.database.generation;
  const power = {
    operation: stopped.operation.id,
    revision: generation,
    state: "hibernated",
  };
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([{ ...observation(f.id, generation, "hibernated"), power }]),
  );
  await request("/v1/resource-profiles/entry/rollout", f.admin, "PUT", {
    profile_revision: 1,
    expected_revision: 0,
  });
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    application_state: "deferred_until_wake",
  });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([{ ...observation(f.id, generation, "error"), power }]),
  );
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    application_state: "pending",
  });
  expect(
    await (
      await request("/v1/resource-profiles/entry/rollout", f.admin)
    ).json(),
  ).toMatchObject({ deferred: 0, pending: 1 });
});
it("rejects a captured rollout after the centrally selected target changes", async () => {
  const f = await configured();
  await request("/v1/resource-profiles/entry", f.admin, "PUT", {
    expected_revision: 1,
    resources: { ...resources, memory_mib: 512 },
  });
  await request("/v1/resource-profiles/entry/rollout", f.admin, "PUT", {
    profile_revision: 2,
    expected_revision: 0,
  });
  const original = env.DB.batch.bind(env.DB);
  let raced = false;
  const spy = vi.spyOn(env.DB, "batch").mockImplementation(async function (
    this: D1Database,
    statements: D1PreparedStatement[],
  ) {
    if (!raced) {
      raced = true;
      await env.DB.prepare(
        "UPDATE resource_profiles SET rollout_revision=1 WHERE id='entry'",
      ).run();
    }
    return original(statements);
  });
  expect(await runResourceProfileRollouts(env)).toBe(0);
  spy.mockRestore();
  expect(raced).toBe(true);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(2);
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    profile_revision: 1,
    target_profile_revision: 1,
    applied: true,
  });
});
it("rejects a changed ordinary class snapshot during a cold resize", async () => {
  const f = await configured();
  const stopped = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/suspend`, f.admin, "POST")
    ).json(),
  );
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, stopped.database.generation, "hibernated"),
        power: {
          operation: stopped.operation.id,
          revision: stopped.database.generation,
          state: "hibernated",
        },
      },
    ]),
  );
  const target = `cold-${f.size}`;
  expect(
    (await request(`/v1/size-classes/${target}`, f.admin, "PUT", resources))
      .status,
  ).toBe(200);
  const original = env.DB.batch.bind(env.DB);
  let raced = false;
  const spy = vi.spyOn(env.DB, "batch").mockImplementation(async function (
    this: D1Database,
    statements: D1PreparedStatement[],
  ) {
    if (!raced) {
      raced = true;
      await env.DB.prepare(
        "UPDATE size_classes SET max_connections=99 WHERE id=?",
      )
        .bind(target)
        .run();
    }
    return original(statements);
  });
  expect(
    (
      await request(`/v1/databases/${f.id}`, f.admin, "PATCH", {
        size_class_id: target,
      })
    ).status,
  ).toBe(409);
  spy.mockRestore();
  expect(raced).toBe(true);
  await env.DB.prepare("DELETE FROM size_classes WHERE id=?")
    .bind(target)
    .run();
});

it("finishes the cold configuration operation when its next wake proves the current configuration", async () => {
  const f = await configured();
  const stopped = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/suspend`, f.admin, "POST")
    ).json(),
  );
  const power = {
    operation: stopped.operation.id,
    revision: stopped.database.generation,
    state: "hibernated",
  };
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, stopped.database.generation, "hibernated"),
        power,
      },
    ]),
  );
  await request("/v1/resource-profiles/entry", f.admin, "PUT", {
    expected_revision: 1,
    resources: { ...resources, memory_mib: 512 },
  });
  const configuredOp = DatabaseWithOperation.parse(
    await (
      await request(f.assignment, f.admin, "PUT", {
        profile_id: "entry",
        profile_revision: 2,
        expected_generation: stopped.database.generation,
      })
    ).json(),
  );
  const resumed = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/resume`, f.admin, "POST")
    ).json(),
  );
  const generation = resumed.database.generation;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, generation),
        power: {
          operation: resumed.operation.id,
          revision: generation,
          state: "awake",
        },
      },
    ]),
  );
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(configuredOp.operation.id)
      .first("status"),
  ).toBe("succeeded");
  expect(await (await request(f.assignment, f.admin)).json()).toMatchObject({
    profile_revision: 2,
    applied: true,
    application_state: "applied",
  });
});
it("marks a superseded cold configuration explicitly instead of leaving its operation pending", async () => {
  const f = await configured();
  const stopped = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/suspend`, f.admin, "POST")
    ).json(),
  );
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, stopped.database.generation, "hibernated"),
        power: {
          operation: stopped.operation.id,
          revision: stopped.database.generation,
          state: "hibernated",
        },
      },
    ]),
  );
  await request("/v1/resource-profiles/entry", f.admin, "PUT", {
    expected_revision: 1,
    resources: { ...resources, memory_mib: 512 },
  });
  const earlier = DatabaseWithOperation.parse(
    await (
      await request(f.assignment, f.admin, "PUT", {
        profile_id: "entry",
        profile_revision: 2,
        expected_generation: stopped.database.generation,
      })
    ).json(),
  );
  await request("/v1/resource-profiles/entry", f.admin, "PUT", {
    expected_revision: 2,
    resources: { ...resources, memory_mib: 768 },
  });
  expect(
    (
      await request(f.assignment, f.admin, "PUT", {
        profile_id: "entry",
        profile_revision: 3,
        expected_generation: earlier.database.generation,
      })
    ).status,
  ).toBe(202);
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(earlier.operation.id)
      .first(),
  ).toEqual({ status: "failed", error_code: "superseded" });
});
