// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { bytesToHex, DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { ApiError } from "../../src/app.ts";
import { withAdmissionMutation } from "../../src/domain/admission-mutations.ts";
import { scheduleDatabaseResize } from "../../src/domain/databases.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  refusal,
  request,
} from "./fixtures.ts";

const key = () => crypto.randomUUID();
const classes: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM resource_profile_revisions"),
    env.DB.prepare("DELETE FROM resource_profiles"),
    env.DB.prepare("DELETE FROM size_classes WHERE id LIKE 'rp-%'"),
  ]);
  for (const id of classes.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});

async function ready() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([observation(created.database.id, 1)]),
      )
    ).status,
  ).toBe(200);
  return { ...f, id: created.database.id };
}
/** Another size class that differs from the fixture's in memory and CPU. */
async function otherClass(
  f: Awaited<ReturnType<typeof fixture>>,
  memory: number,
  cpu: number,
) {
  const id = "r" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  classes.push(id);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
    SELECT ?,?,?,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(id, memory, cpu, f.size)
    .run();
  return id;
}

it("names a database name that is already in use and advises no retry", async () => {
  const f = await fixture();
  expect((await f.create("orders")).status).toBe(202);
  expect(await refusal(await f.create("orders"))).toEqual({
    status: 409,
    code: "conflict",
    reason: "name_in_use",
    retryAfter: null,
  });
});

it("tells a database that is not ready from one that is deleted", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  const target = await otherClass(f, 1024, 750);
  // The regional controller has not reported the first generation yet.
  const early = await request(`/v1/databases/${id}`, f.integrator, "PATCH", {
    size_class_id: target,
  });
  expect(await refusal(early)).toEqual({
    status: 409,
    code: "conflict",
    reason: "not_ready",
    retryAfter: "5",
  });
  expect(
    await refusal(
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST"),
    ),
  ).toMatchObject({ reason: "not_ready", retryAfter: "5" });
  expect(
    (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  for (const action of ["suspend", "resume"])
    expect(
      await refusal(
        await request(`/v1/databases/${id}/${action}`, f.integrator, "POST"),
      ),
    ).toEqual({
      status: 409,
      code: "conflict",
      reason: "database_deleted",
      retryAfter: null,
    });
  expect(
    await refusal(
      await request(`/v1/databases/${id}`, f.integrator, "PATCH", {
        size_class_id: target,
      }),
    ),
  ).toMatchObject({ reason: "database_deleted", retryAfter: null });
});

it("advises a short retry while another change holds the database", async () => {
  const f = await ready();
  const [id, project] = [f.id, f.project];
  await withAdmissionMutation(env, [id], async (mutation) => {
    for (const refused of [
      await request(`/v1/databases/${id}`, f.integrator, "DELETE"),
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST"),
      await request(
        `/v1/databases/${id}/roles`,
        f.integrator,
        "POST",
        {
          name: "reader",
        },
        key(),
      ),
    ])
      expect(await refusal(refused)).toEqual({
        status: 409,
        code: "conflict",
        reason: "mutation_in_progress",
        retryAfter: "1",
      });
    const guard = mutation.guard(id);
    await mutation.batch([
      env.DB.prepare(
        `UPDATE databases SET updated_at=updated_at WHERE id=? AND project_id=? AND ${guard.sql}`,
      ).bind(id, project, ...guard.bindings),
    ]);
  });
  // The refusals changed nothing, so the same request is accepted once the change is over.
  expect(
    (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
});

it("names a database that changed under the request", async () => {
  const f = await ready();
  const target = await otherClass(f, 1024, 750);
  const row = (await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(f.id)
    .first<DatabaseRow>())!;
  // The caller read the row before another request changed it.
  const stale = { ...row, updated_at: "2000-01-01T00:00:00.000Z" };
  const error = await scheduleDatabaseResize(
    env,
    stale,
    target,
    new Date().toISOString(),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    code: "conflict",
    details: { reason: "generation_changed" },
  });
});

it("answers missing node capacity with the capacity code, a reason and a longer delay", async () => {
  const f = await ready();
  const target = await otherClass(f, 4096, 1000);
  expect(
    await refusal(
      await request(`/v1/databases/${f.id}`, f.integrator, "PATCH", {
        size_class_id: target,
      }),
    ),
  ).toEqual({
    status: 503,
    code: "capacity_exhausted",
    reason: "node_capacity",
    retryAfter: "30",
  });
});

it("names a role that exists and advises no retry", async () => {
  const f = await ready();
  const create = (name: string) =>
    request(
      `/v1/databases/${f.id}/roles`,
      f.integrator,
      "POST",
      { name },
      key(),
    );
  expect((await create("reader")).status).toBe(201);
  expect(await refusal(await create("reader"))).toEqual({
    status: 409,
    code: "conflict",
    reason: "role_exists",
    retryAfter: null,
  });
});

it("names a project that still holds a database", async () => {
  const f = await ready();
  expect(
    await refusal(
      await request(
        `/v1/projects/${f.project}`,
        f.admin,
        "DELETE",
        undefined,
        key(),
      ),
    ),
  ).toEqual({
    status: 409,
    code: "conflict",
    reason: "project_not_empty",
    retryAfter: null,
  });
});

it("advises a retry on a request that is still executing under its key", async () => {
  const f = await ready();
  const reserved = key();
  // The reservation of the very request that is repeated, still in progress.
  const hash = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`POST\n/v1/databases/${f.id}/resume\nnull`),
      ),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO idempotency_keys(api_key_id,key,request_hash,state,created_at) SELECT id,?,?,'in_progress',? FROM api_keys WHERE lookup_id=?",
  )
    .bind(reserved, hash, new Date().toISOString(), f.integrator.split("_")[2])
    .run();
  expect(
    await refusal(
      await request(
        `/v1/databases/${f.id}/resume`,
        f.integrator,
        "POST",
        undefined,
        reserved,
      ),
    ),
  ).toEqual({
    status: 409,
    code: "idempotency_in_progress",
    reason: null,
    retryAfter: "1",
  });
});

it("refuses every keyed database mutation that omits its Idempotency-Key", async () => {
  const f = await ready();
  const { id } = f;
  // The assignment of a resource profile is a resize and needs its key like one.
  expect(
    (
      await request("/v1/resource-profiles/entry", f.admin, "PUT", {
        expected_revision: 0,
        resources: {
          memory_mib: 256,
          cpu_millicores: 250,
          cpu_request_millicores: 25,
          storage_gib: 5,
          max_connections: 20,
          sleep_after_seconds: 60,
          archive_timeout_seconds: 60,
          backup_retention_days: 7,
          enabled: true,
        },
      })
    ).status,
  ).toBe(200);
  const attempts: [string, string, unknown?][] = [
    [
      "PUT",
      `/v1/databases/${id}/resource-profile`,
      { profile_id: "entry", profile_revision: 1, expected_generation: 1 },
    ],
    [
      "POST",
      "/v1/databases",
      {
        project_id: f.project,
        region_id: f.region,
        name: "x",
        size_class_id: f.size,
      },
    ],
    ["PATCH", `/v1/databases/${id}`, { size_class_id: f.size }],
    ["DELETE", `/v1/databases/${id}`],
    ["POST", `/v1/databases/${id}/suspend`],
    ["POST", `/v1/databases/${id}/resume`],
    ["POST", `/v1/databases/${id}/restore`, { mode: "full", name: "copy" }],
  ];
  for (const [method, path, body] of attempts) {
    const response = await request(path, f.integrator, method, body, null);
    expect(response.status, `${method} ${path}`).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining("Idempotency-Key"),
      },
    });
  }
  // Nothing was started and the database is as it was.
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM databases WHERE project_id=?")
      .bind(f.project)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(id)
      .first("generation"),
  ).toBe(1);
});
