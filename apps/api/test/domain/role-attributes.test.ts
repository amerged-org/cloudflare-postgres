// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, Role, listEnvelope } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  request,
  report,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = () => crypto.randomUUID();
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
async function database(f: Fixture): Promise<string> {
  const response = await f.create("roles");
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json()).database.id;
}
/** `null` sends no Idempotency-Key. */
const createRole = (
  f: Fixture,
  id: string,
  body: unknown,
  idempotency: string | null = key(),
  as: string = f.integrator,
) =>
  request(
    `/v1/databases/${id}/roles`,
    as,
    "POST",
    body,
    idempotency ?? undefined,
  );
const listRoles = async (f: Fixture, id: string) =>
  listEnvelope(Role).parse(
    await (await request(`/v1/databases/${id}/roles`, f.integrator)).json(),
  ).data;
async function desiredRoles(f: Fixture, id: string): Promise<unknown[]> {
  return (await desiredPage(f)).databases.find((db) => db.id === id)!.roles;
}

describe("role attributes", () => {
  it("creates a role with expiry, a connection limit, memberships and RLS bypass and lists them", async () => {
    const f = await fixture(),
      id = await database(f);
    expect((await createRole(f, id, { name: "reader" })).status).toBe(201);
    const until = inOneHour();
    const created = await createRole(f, id, {
      name: "report_job",
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader"],
      bypass_rls: true,
    });
    expect(created.status).toBe(201);
    expect(Role.parse(await created.json())).toMatchObject({
      database_id: id,
      name: "report_job",
      owner: false,
      password_revision: 1,
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader"],
      bypass_rls: true,
    });
    const listed = await listRoles(f, id);
    expect(listed.map((role) => role.name)).toEqual([
      "app",
      "reader",
      "report_job",
    ]);
    expect(listed[0]).toMatchObject({
      owner: true,
      valid_until: null,
      connection_limit: null,
      member_of: [],
      bypass_rls: false,
    });
    expect(listed[2]).toMatchObject({
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader"],
      bypass_rls: true,
    });
  });

  it("takes the role names of the Kubernetes runtime as ordinary roles, in the list, the page and as membership targets", async () => {
    const f = await fixture(),
      id = await database(f);
    for (const name of ["cnpg_app", "streaming_replica"])
      expect((await createRole(f, id, { name })).status, name).toBe(201);
    const member = await createRole(f, id, {
      name: "pgcf_maintenance",
      member_of: ["cnpg_app", "streaming_replica"],
    });
    expect(member.status).toBe(201);
    expect(Role.parse(await member.json())).toMatchObject({
      name: "pgcf_maintenance",
      owner: false,
      member_of: ["cnpg_app", "streaming_replica"],
    });
    expect((await listRoles(f, id)).map((role) => role.name)).toEqual([
      "app",
      "cnpg_app",
      "pgcf_maintenance",
      "streaming_replica",
    ]);
    expect(
      ((await desiredRoles(f, id)) as { name: string }[]).map(
        (role) => role.name,
      ),
    ).toEqual(["app", "cnpg_app", "pgcf_maintenance", "streaming_replica"]);
  });

  it("sends the attributes to the node only for the role that has them", async () => {
    const f = await fixture(),
      id = await database(f);
    const until = inOneHour();
    await createRole(f, id, { name: "reader" });
    await createRole(f, id, {
      name: "report_job",
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader"],
      bypass_rls: true,
    });
    const roles = (await desiredRoles(f, id)) as Record<string, unknown>[];
    // A plain role keeps the plain wire shape.
    expect(Object.keys(roles[1]!).sort()).toEqual([
      "name",
      "owner",
      "password",
      "revision",
    ]);
    expect(roles[2]).toMatchObject({
      name: "report_job",
      owner: false,
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader"],
      bypass_rls: true,
    });
    const owner = roles[0]!;
    expect(Object.keys(owner).sort()).toEqual([
      "name",
      "owner",
      "password",
      "revision",
    ]);
  });

  it("refuses an expiry that is not in the future, unknown memberships, the owner as a target and the names a customer role cannot take", async () => {
    const f = await fixture(),
      id = await database(f);
    for (const body of [
      { name: "late", valid_until: new Date(Date.now() - 1000).toISOString() },
      // PostgreSQL applies an expiry at whole seconds, truncated: this one has begun already.
      {
        name: "begun",
        valid_until: new Date(
          Math.floor(Date.now() / 1000) * 1000 + 999,
        ).toISOString(),
      },
      { name: "alone", member_of: ["nobody"] },
      { name: "boss", member_of: ["app"] },
      { name: "boss", member_of: ["pg_read_all_data"] },
      { name: "limit", connection_limit: 0 },
      { name: "boss", member_of: ["pgcf_backup"] },
      { name: "postgres" },
      { name: "pg_monitor" },
      { name: "pgcf_backup" },
      // PostgreSQL refuses `CREATE ROLE public` and `none`: such a role would be registered, fail at
      // the node and stop its database from waking.
      { name: "public" },
      { name: "none" },
      { name: "boss", member_of: ["public"] },
    ]) {
      const response = await createRole(f, id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    expect(await listRoles(f, id)).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
        .bind(id)
        .first("generation"),
    ).toBe(1);
  });

  it("requires an Idempotency-Key on every role mutation", async () => {
    const f = await fixture(),
      id = await database(f);
    expect((await createRole(f, id, { name: "reader" }, null)).status).toBe(
      400,
    );
    expect(
      (
        await request(
          `/v1/databases/${id}/roles/app/reset-password`,
          f.integrator,
          "POST",
        )
      ).status,
    ).toBe(400);
    expect(await listRoles(f, id)).toHaveLength(1);
  });

  it("replays a creation with its expiry after the expiry has passed", async () => {
    const f = await fixture(),
      id = await database(f),
      idempotency = key();
    const body = {
      name: "short_lived",
      valid_until: new Date(Date.now() + 1500).toISOString(),
    };
    const first = await createRole(f, id, body, idempotency);
    expect(first.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    // The same request is answered from the retained result, not refused as a past expiry.
    const replay = await createRole(f, id, body, idempotency);
    expect(replay.status).toBe(201);
    expect(Role.parse(await replay.json()).valid_until).toBe(body.valid_until);
    // A new request with the same expiry is a new attempt and is refused.
    expect((await createRole(f, id, { ...body, name: "other" })).status).toBe(
      400,
    );
  });

  it("answers a different body under the same key with a conflict", async () => {
    const f = await fixture(),
      id = await database(f),
      idempotency = key();
    expect(
      (
        await createRole(
          f,
          id,
          { name: "reader", connection_limit: 3 },
          idempotency,
        )
      ).status,
    ).toBe(201);
    const different = await createRole(
      f,
      id,
      { name: "reader", connection_limit: 4 },
      idempotency,
    );
    expect(different.status).toBe(409);
    expect(await different.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });

  it("bounds a database to one hundred roles and four-digit limits are accepted", async () => {
    const f = await fixture(),
      id = await database(f);
    for (let index = 1; index < 100; index++)
      await env.DB.prepare(
        "INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at) SELECT database_id,?,0,password_ciphertext,password_iv,password_kid,1,created_at,updated_at FROM roles WHERE database_id=? AND name='app'",
      )
        .bind(`filler_${index}`, id)
        .run();
    const refused = await createRole(f, id, { name: "one_too_many" });
    expect(refused.status).toBe(409);
    expect(await listRoles(f, id)).toHaveLength(100);
    await env.DB.prepare("DELETE FROM roles WHERE database_id=? AND name=?")
      .bind(id, "filler_1")
      .run();
    expect(
      (
        await createRole(f, id, {
          name: "at_the_limit",
          connection_limit: 1000,
        })
      ).status,
    ).toBe(201);
  });

  it("leaves usage and metering records as role changes always left them", async () => {
    const f = await fixture(),
      id = await database(f);
    const post = (generation: number) => report(f, id, generation);
    const count = async (table: string) =>
      env.DB.prepare(`SELECT COUNT(*) count FROM ${table} WHERE database_id=?`)
        .bind(id)
        .first<number>("count");
    const kinds = async () =>
      (
        await env.DB.prepare(
          "SELECT DISTINCT kind FROM lifecycle_events WHERE database_id=? ORDER BY kind",
        )
          .bind(id)
          .all<{ kind: string }>()
      ).results.map((row) => row.kind);
    expect((await post(1)).status).toBe(200);
    const before = {
      operations: await count("operations"),
      samples: await count("usage_samples"),
      kinds: await kinds(),
    };
    expect(
      (
        await createRole(f, id, {
          name: "report_job",
          connection_limit: 2,
          bypass_rls: true,
        })
      ).status,
    ).toBe(201);
    expect((await post(2)).status).toBe(200);
    // The ready generation records its `ready` event as before; no resize, wake or sleep appears.
    expect({
      operations: await count("operations"),
      samples: await count("usage_samples"),
      kinds: await kinds(),
    }).toEqual(before);
  });
});
