// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
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
  await cleanupFixtures();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM resource_profile_revisions"),
    env.DB.prepare("DELETE FROM resource_profiles"),
    env.DB.prepare("DELETE FROM size_classes WHERE id LIKE 'rp-%'"),
  ]);
});

it("versions central profiles without mutating an earlier resource class", async () => {
  const f = await fixture();
  const path = "/v1/resource-profiles/entry";
  const first = await request(
    path,
    f.admin,
    "PUT",
    {
      expected_revision: 0,
      resources,
    },
    "profile-first",
  );
  expect(first.status).toBe(200);
  const initial = (await first.json()) as {
    revision: number;
    size_class_id: string;
  };
  expect(initial.revision).toBe(1);
  expect(
    (
      await request(
        path,
        f.admin,
        "PUT",
        {
          expected_revision: 0,
          resources,
        },
        "stale-profile",
      )
    ).status,
  ).toBe(409);
  const next = await request(path, f.admin, "PUT", {
    expected_revision: 1,
    resources: { ...resources, memory_mib: 512 },
  });
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({
    revision: 2,
    resources: { memory_mib: 512 },
  });
  expect(
    await env.DB.prepare("SELECT memory_mib FROM size_classes WHERE id=?")
      .bind(initial.size_class_id)
      .first("memory_mib"),
  ).toBe(256);
  const replay = await request(
    path,
    f.admin,
    "PUT",
    { expected_revision: 0, resources },
    "profile-first",
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(initial);

  expect(
    (
      await request(path, f.integrator, "PUT", {
        expected_revision: 2,
        resources,
      })
    ).status,
  ).toBe(403);
});

it("assigns a profile through the existing generation and regional desired-state path", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(created.database.id, 1)]),
  );
  const path = "/v1/resource-profiles/entry";
  expect(
    (
      await request(path, f.admin, "PUT", {
        expected_revision: 0,
        resources,
      })
    ).status,
  ).toBe(200);
  const assignment = `/v1/databases/${created.database.id}/resource-profile`;
  expect(
    (
      await request(assignment, f.otherKey, "PUT", {
        profile_id: "entry",
        profile_revision: 1,
        expected_generation: 1,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(assignment, f.admin, "PUT", {
        profile_id: "entry",
        profile_revision: 1,
        expected_generation: 9,
      })
    ).status,
  ).toBe(409);
  const applied = await request(
    assignment,
    f.admin,
    "PUT",
    {
      profile_id: "entry",
      profile_revision: 1,
      expected_generation: 1,
    },
    "assign-entry",
  );
  expect(applied.status).toBe(202);
  const operation = DatabaseWithOperation.parse(await applied.json());
  expect(operation.database.generation).toBe(2);
  expect(operation.operation.kind).toBe("database.resize");
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(
    desired.databases.find((d) => d.id === created.database.id)?.size,
  ).toMatchObject({
    memory_mib: 256,
    cpu_millicores: 250,
    cpu_request_millicores: 25,
  });
  expect(await (await request(assignment, f.admin)).json()).toMatchObject({
    profile_id: "entry",
    profile_revision: 1,
    desired_generation: 2,
    applied: false,
  });
  expect(
    (
      await request(
        assignment,
        f.admin,
        "PUT",
        {
          profile_id: "entry",
          profile_revision: 1,
          expected_generation: 1,
        },
        "assign-entry",
      )
    ).status,
  ).toBe(202);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(created.database.id, 2)]),
  );
  expect(await (await request(assignment, f.integrator)).json()).toMatchObject({
    profile_id: "entry",
    profile_revision: 1,
    applied: true,
  });
});
