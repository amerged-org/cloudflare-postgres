// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  Operation,
  Role,
  listEnvelope,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  nodeRequest,
  observationOf,
  refusal,
  reportBody,
  request,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Ready = Fixture & { id: string };
const key = () => crypto.randomUUID();
const generationOf = async (id: string) =>
  (await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
    .bind(id)
    .first<number>("generation"))!;
/** The node reports these observations; the answer is the verdict on each. */
const post = async (f: Fixture, ...observations: Promise<object>[]) =>
  verdicts(
    await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(await Promise.all(observations)),
    }),
  );

/** A ready database holding the owner and the given roles; the region has seen its generation. */
async function ready(...roles: Record<string, unknown>[]): Promise<Ready> {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  for (const body of roles)
    expect(
      (
        await request(
          `/v1/databases/${id}/roles`,
          f.integrator,
          "POST",
          body,
          key(),
        )
      ).status,
    ).toBe(201);
  expect(await post(f, observationOf(id, await generationOf(id)))).toEqual([
    "accept",
  ]);
  return { ...f, id };
}
const removeRole = (
  f: Ready,
  name: string,
  idempotency: string | null = key(),
  as: string = f.integrator,
) =>
  request(
    `/v1/databases/${f.id}/roles/${name}`,
    as,
    "DELETE",
    undefined,
    idempotency ?? undefined,
  );
async function removal(f: Ready, name: string, idempotency?: string) {
  const response = await removeRole(f, name, idempotency);
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json());
}
const listed = async (f: Ready) =>
  listEnvelope(Role)
    .parse(
      await (await request(`/v1/databases/${f.id}/roles`, f.integrator)).json(),
    )
    .data.map((role) => role.name);
async function desired(f: Ready) {
  return (await desiredPage(f)).databases.find((db) => db.id === f.id)!;
}
const readOperation = async (f: Fixture, id: string) =>
  Operation.parse(
    await (await request(`/v1/operations/${id}`, f.integrator)).json(),
  );
/** A ready observation that reports what became of the roles the page asked to remove. */
const withRoles = (id: string, generation: number, roles: unknown) =>
  observationOf(id, generation, "ready", { roles });

describe("role removal", () => {
  it("makes the role unroutable and unlisted at once and hands its name to the region", async () => {
    const f = await ready({ name: "report_job" });
    const before = await generationOf(f.id);
    const result = await removal(f, "report_job");
    expect(result.operation).toMatchObject({
      kind: "database.role.delete",
      status: "pending",
      database_id: f.id,
      project_id: f.project,
      generation: before + 1,
      error: null,
      completed_at: null,
    });
    expect(result.database.generation).toBe(before + 1);
    expect(await listed(f)).toEqual(["app"]);
    expect(
      (
        await request(
          `/v1/databases/${f.id}/roles/report_job/connection-uri`,
          f.integrator,
        )
      ).status,
    ).toBe(404);
    const presence = await env.DATABASE_ACTOR.get(
      env.DATABASE_ACTOR.idFromName(f.id),
    ).admit(f.id, "report_job");
    expect(presence).toEqual({ ok: false, sqlstate: "28P01" });
    // The region is told to remove it, with no credential; the owner is untouched.
    const roles = (await desired(f)).roles;
    expect(roles.map((role) => role.name)).toEqual(["app", "report_job"]);
    expect(roles[1]).toEqual({ name: "report_job", state: "absent" });
    expect(roles[0]).toMatchObject({ name: "app", owner: true });
    // The operation is readable and the response carries its location.
    expect(await readOperation(f, result.operation.id)).toMatchObject({
      status: "pending",
      kind: "database.role.delete",
    });
  });

  it("lets an administrator key delete a role and records the key that did", async () => {
    const f = await ready({ name: "report_job" });
    expect((await removeRole(f, "report_job", key(), f.admin)).status).toBe(
      202,
    );
    const row = await env.DB.prepare(
      "SELECT deleted_by_key_id,created_by_key_id,delete_operation_id FROM roles WHERE database_id=? AND name='report_job'",
    )
      .bind(f.id)
      .first<{
        deleted_by_key_id: string;
        created_by_key_id: string;
        delete_operation_id: string;
      }>();
    expect(row!.deleted_by_key_id).toMatch(/^key_/);
    expect(row!.created_by_key_id).toMatch(/^key_/);
    // Different keys: the integrator created it, the administrator deleted it.
    expect(row!.deleted_by_key_id).not.toBe(row!.created_by_key_id);
    expect(row!.delete_operation_id).toMatch(/^op_/);
  });

  it("answers the same request again with the same operation and bumps the generation once", async () => {
    const f = await ready({ name: "report_job" });
    const idempotency = key();
    const first = await removal(f, "report_job", idempotency);
    const generation = await generationOf(f.id);
    const replay = await removal(f, "report_job", idempotency);
    expect(replay.operation.id).toBe(first.operation.id);
    // Another key while the removal is not over names the same operation.
    const again = await removal(f, "report_job");
    expect(again.operation.id).toBe(first.operation.id);
    expect(await generationOf(f.id)).toBe(generation);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM role_deletions WHERE database_id=?",
      )
        .bind(f.id)
        .first("count"),
    ).toBe(1);
  });

  it("refuses the owner, unknown roles and foreign projects", async () => {
    const f = await ready({ name: "report_job" });
    const response = await removeRole(f, "app");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    // The names of the Kubernetes runtime are ordinary names: a role that does not exist is
    // unknown, however it is called.
    for (const name of ["nobody", "pgcf_maintenance", "cnpg_app"])
      expect((await removeRole(f, name)).status, name).toBe(404);
    for (const name of ["postgres", "pgcf_backup"])
      expect((await removeRole(f, name)).status, name).toBe(400);
    expect((await removeRole(f, "report_job", null)).status).toBe(400);
    expect((await removeRole(f, "report_job", key(), f.otherKey)).status).toBe(
      404,
    );
    expect(await listed(f)).toEqual(["app", "report_job"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM role_deletions WHERE database_id=?",
      )
        .bind(f.id)
        .first("count"),
    ).toBe(0);
  });

  it("removes a role that has the name of one the Kubernetes runtime reserved", async () => {
    const f = await ready({ name: "cnpg_app" }, { name: "streaming_replica" });
    const result = await removal(f, "cnpg_app");
    expect(result.operation).toMatchObject({
      kind: "database.role.delete",
      status: "pending",
    });
    expect(await listed(f)).toEqual(["app", "streaming_replica"]);
    expect((await desired(f)).roles).toContainEqual({
      name: "cnpg_app",
      state: "absent",
    });
  });

  it("shows a removal operation only to its own project", async () => {
    const f = await ready({ name: "report_job" });
    const { operation } = await removal(f, "report_job");
    expect(
      (await request(`/v1/operations/${operation.id}`, f.otherKey)).status,
    ).toBe(404);
    expect(
      (await request(`/v1/operations/${operation.id}`, f.admin)).status,
    ).toBe(200);
  });

  it("keeps a role that others are members of until they are gone", async () => {
    const f = await ready(
      { name: "reader" },
      { name: "report_job", member_of: ["reader"] },
    );
    const refused = await removeRole(f, "reader");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "conflict",
        message: expect.stringContaining("member"),
        details: { reason: "role_has_members" },
      },
    });
    expect(await listed(f)).toEqual(["app", "reader", "report_job"]);
    await removal(f, "report_job");
    // A member that is itself being deleted no longer holds the target.
    expect((await removeRole(f, "reader")).status).toBe(202);
  });

  it("does not let a deleted role be a membership target of a new role", async () => {
    const f = await ready({ name: "reader" });
    await removal(f, "reader");
    const created = await request(
      `/v1/databases/${f.id}/roles`,
      f.integrator,
      "POST",
      { name: "report_job", member_of: ["reader"] },
      key(),
    );
    expect(created.status).toBe(400);
  });

  it("succeeds when the region reports the role removed and then frees the name", async () => {
    const f = await ready({ name: "report_job" });
    const { operation } = await removal(f, "report_job");
    const generation = await generationOf(f.id);
    // A report of an older generation proves nothing about this removal.
    expect(
      await post(
        f,
        withRoles(f.id, generation - 1, {
          removed: ["report_job"],
          blocked: [],
        }),
      ),
    ).toEqual(["stale"]);
    expect((await readOperation(f, operation.id)).status).toBe("pending");
    expect(
      await post(f, withRoles(f.id, generation, { removed: [], blocked: [] })),
    ).toEqual(["accept"]);
    expect((await readOperation(f, operation.id)).status).toBe("pending");
    expect(
      await post(
        f,
        withRoles(f.id, generation, { removed: ["report_job"], blocked: [] }),
      ),
    ).toEqual(["accept"]);
    expect(await readOperation(f, operation.id)).toMatchObject({
      status: "succeeded",
      error: null,
    });
    // The tombstone and its credential are gone and the region is no longer asked.
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM roles WHERE database_id=? AND name='report_job'",
      )
        .bind(f.id)
        .first("count"),
    ).toBe(0);
    expect((await desired(f)).roles.map((role) => role.name)).toEqual(["app"]);
    const created = await request(
      `/v1/databases/${f.id}/roles`,
      f.integrator,
      "POST",
      { name: "report_job" },
      key(),
    );
    expect(created.status).toBe(201);
    expect(Role.parse(await created.json()).password_revision).toBe(1);
  });

  it("fails with role_not_droppable while the role stays unroutable, and a later attempt can finish", async () => {
    const f = await ready({ name: "report_job" });
    const first = await removal(f, "report_job");
    let generation = await generationOf(f.id);
    expect(
      await post(
        f,
        withRoles(f.id, generation, { removed: [], blocked: ["report_job"] }),
      ),
    ).toEqual(["accept"]);
    const failed = await readOperation(f, first.operation.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "role_not_droppable" },
    });
    expect(failed.completed_at).not.toBeNull();
    // Still unroutable, unlisted, and still asked for.
    expect(await listed(f)).toEqual(["app"]);
    expect(
      (await desired(f)).roles.find((role) => role.name === "report_job"),
    ).toEqual({ name: "report_job", state: "absent" });
    // The name stays reserved until PostgreSQL has dropped the role.
    expect(
      await refusal(
        await request(
          `/v1/databases/${f.id}/roles`,
          f.integrator,
          "POST",
          { name: "report_job" },
          key(),
        ),
      ),
    ).toMatchObject({ status: 409, reason: "role_being_deleted" });
    // Deleting again is a new attempt with its own operation and generation.
    const second = await removal(f, "report_job");
    expect(second.operation.id).not.toBe(first.operation.id);
    expect(second.operation.status).toBe("pending");
    generation = await generationOf(f.id);
    expect(second.operation.generation).toBe(generation);
    await post(
      f,
      withRoles(f.id, generation, { removed: ["report_job"], blocked: [] }),
    );
    expect((await readOperation(f, second.operation.id)).status).toBe(
      "succeeded",
    );
    expect((await readOperation(f, first.operation.id)).status).toBe("failed");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM roles WHERE database_id=? AND name='report_job'",
      )
        .bind(f.id)
        .first("count"),
    ).toBe(0);
  });

  it("purges a role the region removes after its operation failed", async () => {
    const f = await ready({ name: "report_job" });
    const { operation } = await removal(f, "report_job");
    const generation = await generationOf(f.id);
    await post(
      f,
      withRoles(f.id, generation, { removed: [], blocked: ["report_job"] }),
    );
    // The owner cleaned up and the region's level-triggered pass dropped the role.
    await post(
      f,
      withRoles(f.id, generation, { removed: ["report_job"], blocked: [] }),
    );
    expect((await readOperation(f, operation.id)).status).toBe("failed");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM roles WHERE database_id=? AND name='report_job'",
      )
        .bind(f.id)
        .first("count"),
    ).toBe(0);
  });

  it("reports success at once for a suspended database and removes the role at its next wake", async () => {
    const f = await ready({ name: "report_job" });
    expect(
      (
        await request(
          `/v1/databases/${f.id}/suspend`,
          f.integrator,
          "POST",
          undefined,
          key(),
        )
      ).status,
    ).toBe(202);
    const { operation } = await removal(f, "report_job");
    expect(operation).toMatchObject({
      kind: "database.role.delete",
      status: "succeeded",
      error: null,
    });
    expect(operation.completed_at).not.toBeNull();
    // The role is unroutable now, but the region still has to drop it.
    expect(await listed(f)).toEqual(["app"]);
    expect(
      (await desired(f)).roles.find((role) => role.name === "report_job"),
    ).toEqual({ name: "report_job", state: "absent" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM roles WHERE database_id=? AND name='report_job'",
      )
        .bind(f.id)
        .first("count"),
    ).toBe(1);
    // Asking again while it still sleeps names the same operation; nothing is left to learn.
    expect((await removal(f, "report_job")).operation.id).toBe(operation.id);
    // Once the database runs, asking again starts an operation that reports what PostgreSQL did.
    await env.DB.prepare(
      "UPDATE databases SET desired_state='running',power_operation=NULL,suspension_reason=NULL WHERE id=?",
    )
      .bind(f.id)
      .run();
    const verifying = await removal(f, "report_job");
    expect(verifying.operation.id).not.toBe(operation.id);
    expect(verifying.operation.status).toBe("pending");
    await post(
      f,
      withRoles(f.id, await generationOf(f.id), {
        removed: [],
        blocked: ["report_job"],
      }),
    );
    expect((await readOperation(f, verifying.operation.id)).status).toBe(
      "failed",
    );
    expect((await readOperation(f, operation.id)).status).toBe("succeeded");
  });

  it("ends a removal that was still waiting when the database went to sleep", async () => {
    const f = await ready({ name: "report_job" });
    const { operation } = await removal(f, "report_job");
    // The region has applied the new generation, but its report names no removal yet, and the
    // database is suspended and reports its hibernation.
    await post(
      f,
      withRoles(f.id, await generationOf(f.id), { removed: [], blocked: [] }),
    );
    expect(
      (
        await request(
          `/v1/databases/${f.id}/suspend`,
          f.integrator,
          "POST",
          undefined,
          key(),
        )
      ).status,
    ).toBe(202);
    const generation = await generationOf(f.id);
    expect(await post(f, observationOf(f.id, generation, "asleep"))).toEqual([
      "accept",
    ]);
    expect(await readOperation(f, operation.id)).toMatchObject({
      status: "succeeded",
      error: null,
    });
    // The role is still asked for: the next wake removes it.
    expect(
      (await desired(f)).roles.find((role) => role.name === "report_job"),
    ).toEqual({ name: "report_job", state: "absent" });
  });

  it("counts a role awaiting removal toward the limit of one hundred", async () => {
    const f = await ready();
    for (let index = 1; index < 100; index++)
      await env.DB.prepare(
        "INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at) SELECT database_id,?,0,password_ciphertext,password_iv,password_kid,1,created_at,updated_at FROM roles WHERE database_id=? AND name='app'",
      )
        .bind(`filler_${index}`, f.id)
        .run();
    expect((await removeRole(f, "filler_1")).status).toBe(202);
    const created = await request(
      `/v1/databases/${f.id}/roles`,
      f.integrator,
      "POST",
      { name: "one_more" },
      key(),
    );
    expect(await refusal(created)).toEqual({
      status: 409,
      code: "conflict",
      reason: "role_limit",
      retryAfter: null,
    });
    // Once the region has confirmed the removal the slot is free again.
    await post(
      f,
      withRoles(f.id, await generationOf(f.id), {
        removed: ["filler_1"],
        blocked: [],
      }),
    );
    expect(
      (
        await request(
          `/v1/databases/${f.id}/roles`,
          f.integrator,
          "POST",
          { name: "one_more" },
          key(),
        )
      ).status,
    ).toBe(201);
  });

  it("ends a removal the database deletion made pointless", async () => {
    const f = await ready({ name: "report_job" });
    const { operation } = await removal(f, "report_job");
    expect(
      (
        await request(
          `/v1/databases/${f.id}`,
          f.integrator,
          "DELETE",
          undefined,
          key(),
        )
      ).status,
    ).toBe(202);
    expect(await readOperation(f, operation.id)).toMatchObject({
      status: "failed",
      error: { code: "superseded" },
    });
  });

  it("times out a removal the region never answered", async () => {
    const f = await ready({ name: "report_job" });
    const { operation } = await removal(f, "report_job");
    await env.DB.prepare("UPDATE role_deletions SET updated_at=? WHERE id=?")
      .bind(new Date(Date.now() - 21 * 60_000).toISOString(), operation.id)
      .run();
    await runCron(env);
    expect(await readOperation(f, operation.id)).toMatchObject({
      status: "failed",
      error: { code: "operation_timeout" },
    });
    // The role stays unroutable and asked for; only the operation ended.
    expect(
      (await desired(f)).roles.find((role) => role.name === "report_job"),
    ).toEqual({ name: "report_job", state: "absent" });
  });
});
