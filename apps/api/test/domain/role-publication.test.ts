// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { DatabaseWithOperation, Role, listEnvelope } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  cleanupFixtures,
  fixture,
  lostConnection,
  rawRequest,
  refusal,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
/** What a client waits at most for the answer of a request whose publication stalls for 3.5 s. */
const ANSWERED_WITHIN_MS = 2500;

async function database(f: Fixture): Promise<string> {
  const response = await f.create("roles");
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json()).database.id;
}
/** The same body, as a client that sends its request again sends it. */
const reporter = { name: "reporter", valid_until: inOneHour() };
/**
 * A request with the given key, and how long the answer took: the work it leaves behind is awaited
 * after. `bindings` replace those of the Worker under test; omitted, they are the real ones.
 */
async function send(
  f: Fixture,
  path: string,
  method: "POST" | "DELETE",
  key: string,
  bindings: Partial<Env> = {},
  body?: unknown,
) {
  const context = createExecutionContext();
  const started = Date.now();
  const response = await rawRequest(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${f.integrator}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    context,
    bindings,
  );
  const answeredMs = Date.now() - started;
  await waitOnExecutionContext(context);
  return { response, answeredMs };
}
const createRole = (
  f: Fixture,
  id: string,
  key: string,
  bindings?: Partial<Env>,
) => send(f, `/v1/databases/${id}/roles`, "POST", key, bindings, reporter);
const resetPassword = (
  f: Fixture,
  id: string,
  key: string,
  bindings?: Partial<Env>,
) =>
  send(
    f,
    `/v1/databases/${id}/roles/reporter/reset-password`,
    "POST",
    key,
    bindings,
  );
const deleteRole = (
  f: Fixture,
  id: string,
  key: string,
  bindings?: Partial<Env>,
) => send(f, `/v1/databases/${id}/roles/reporter`, "DELETE", key, bindings);
/** The Actors' publication stalls for `stallMs` and then fails, as it did live. */
const publishing = (stallMs: number): Partial<Env> => ({
  DATABASE_ACTOR: lostConnection(stallMs),
});
/** Whether the Actor of the database still refuses every connection for a mutation whose publication it has not seen. */
const closedBarrier = (id: string) =>
  runInDurableObject(
    env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id)),
    (_instance, state) =>
      state.storage.sql
        .exec<{ barrier: string | null }>(
          "SELECT barrier FROM database_snapshot WHERE singleton=1",
        )
        .toArray()[0]?.barrier != null,
  );
const rolesOf = async (f: Fixture, id: string) =>
  listEnvelope(Role)
    .parse(
      await (await request(`/v1/databases/${id}/roles`, f.integrator)).json(),
    )
    .data.filter((role) => role.name === "reporter");
/** A database with the role `reporter`, created with the real Actor, and its Actor's barrier open. */
async function withReporter() {
  const f = await fixture(),
    id = await database(f);
  expect((await createRole(f, id, crypto.randomUUID())).response.status).toBe(
    201,
  );
  expect(await closedBarrier(id)).toBe(false);
  return { f, id };
}

it("a delayed password reset cannot change credentials after its idempotency lease was removed", async () => {
  const { f, id } = await withReporter(),
    key = crypto.randomUUID();
  const role = () =>
    env.DB.prepare(
      "SELECT * FROM roles WHERE database_id=? AND name='reporter'",
    )
      .bind(id)
      .first();
  const database = () =>
    env.DB.prepare("SELECT generation,updated_at FROM databases WHERE id=?")
      .bind(id)
      .first();
  const beforeRole = await role(),
    beforeDatabase = await database();
  let delayed: D1PreparedStatement[] | undefined;
  let reservations = 0,
    lostFences = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...args: Parameters<D1PreparedStatement["bind"]>) =>
            wrap(target.bind(...args), sql);
        if (property === "run" && sql.includes("INSERT INTO idempotency_keys"))
          return async () => {
            const result = await target.run();
            reservations += result.meta.changes;
            return result;
          };
        if (property === "all" && sql.includes("mutation_outcome='fenced'"))
          return () => {
            if (lostFences++ === 0)
              return Promise.reject(new Error("Network connection lost."));
            return target.all();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    sqlOf.set(proxy, sql);
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          const native = statements.map(
            (statement) => originals.get(statement) ?? statement,
          );
          if (
            !delayed &&
            statements.some((statement) =>
              sqlOf
                .get(statement)
                ?.includes("UPDATE roles SET password_ciphertext="),
            )
          ) {
            delayed = native;
            return Promise.reject(new Error("Network connection lost."));
          }
          return target.batch(native);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const submit = () => resetPassword(f, id, key, { DB });
  expect((await submit()).response.status).toBe(500);
  expect(delayed).toBeDefined();
  expect(lostFences).toBe(1);
  expect(reservations).toBe(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE key=?")
      .bind(key)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await env.DB.prepare(
      "SELECT mutation_status FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({ mutation_status: "pending" });
  // A repeated caller/key/body has a new lease, but the pending epoch refuses its writer.
  expect((await submit()).response.status).toBe(409);
  expect(reservations).toBe(2);
  const result = await env.DB.batch(delayed!);
  expect(result[0]!.meta.changes).toBe(0);
  expect(result[1]!.meta.changes).toBe(0);
  expect(result[2]!.meta.changes).toBe(0);
  expect(await role()).toEqual(beforeRole);
  expect(await database()).toEqual(beforeDatabase);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE key=?")
      .bind(key)
      .first(),
  ).toEqual({ n: 0 });
});

it("a role create is answered 201 although the publication after its commit fails, and the same key replays it and opens the barrier", async () => {
  const f = await fixture(),
    id = await database(f),
    key = crypto.randomUUID();
  const first = await createRole(f, id, key, publishing(0));
  expect(first.response.status).toBe(201);
  const created = Role.parse(await first.response.json());
  expect(created).toMatchObject({ name: "reporter", password_revision: 1 });
  // The commit stands and the Actor has not been told: its barrier is still closed.
  expect(await closedBarrier(id)).toBe(true);
  // A client that did not see the answer sends the request again, and the publication fails again.
  const failing = await createRole(f, id, key, publishing(0));
  expect(failing.response.status).toBe(201);
  expect(Role.parse(await failing.response.json())).toEqual(created);
  expect(await closedBarrier(id)).toBe(true);
  // Once the platform answers, the replay itself tells the Actor.
  const retry = await createRole(f, id, key);
  expect(retry.response.status).toBe(201);
  expect(Role.parse(await retry.response.json())).toEqual(created);
  expect(await closedBarrier(id)).toBe(false);
  expect(await rolesOf(f, id)).toHaveLength(1);
}, 30_000);

it("a role create whose batch lost its answer after the commit answers 500, and the same key replays the 201 with the one role", async () => {
  const f = await fixture(),
    id = await database(f),
    key = crypto.randomUUID();
  // The guarded batch commits, the role and the completed key with it, and its reply is lost.
  const lostAnswer = new Proxy(env.DB, {
    get(actual, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await actual.batch(statements);
          throw new Error("Network connection lost.");
        };
      const value = Reflect.get(actual, property, actual);
      return typeof value === "function" ? value.bind(actual) : value;
    },
  });
  const first = await createRole(f, id, key, { DB: lostAnswer });
  expect(first.response.status).toBe(500);
  expect(await rolesOf(f, id)).toHaveLength(1);
  const retry = await createRole(f, id, key);
  expect(retry.response.status).toBe(201);
  expect(Role.parse(await retry.response.json())).toMatchObject({
    name: "reporter",
    password_revision: 1,
  });
  expect(await rolesOf(f, id)).toHaveLength(1);
  expect(await closedBarrier(id)).toBe(false);
}, 30_000);

it("a role create is answered within the publication bound when the publication stalls", async () => {
  const f = await fixture(),
    id = await database(f);
  const stalled = await createRole(
    f,
    id,
    crypto.randomUUID(),
    publishing(3500),
  );
  expect(stalled.response.status).toBe(201);
  expect(stalled.answeredMs).toBeLessThan(ANSWERED_WITHIN_MS);
  expect(await rolesOf(f, id)).toHaveLength(1);
}, 30_000);

it("a role create that is refused after its reservation is answered within the bound too", async () => {
  const { f, id } = await withReporter();
  // The name is taken: the batch's constraint refuses it, and the close of its mutation publishes.
  const duplicate = await createRole(
    f,
    id,
    crypto.randomUUID(),
    publishing(3500),
  );
  expect(await refusal(duplicate.response)).toMatchObject({
    status: 409,
    reason: "role_exists",
  });
  expect(duplicate.answeredMs).toBeLessThan(ANSWERED_WITHIN_MS);
  expect(await rolesOf(f, id)).toHaveLength(1);
}, 30_000);

it("a password reset is answered 200 within the bound when the publication stalls and then fails, and its key replays it", async () => {
  const { f, id } = await withReporter(),
    key = crypto.randomUUID();
  const reset = await resetPassword(f, id, key, publishing(3500));
  expect(reset.response.status).toBe(200);
  expect(reset.answeredMs).toBeLessThan(ANSWERED_WITHIN_MS);
  const role = Role.parse(await reset.response.json());
  expect(role.password_revision).toBe(2);
  expect(await closedBarrier(id)).toBe(true);
  // The client retries, and the platform answers: the same role, never a third revision.
  const retry = await resetPassword(f, id, key);
  expect(retry.response.status).toBe(200);
  expect(Role.parse(await retry.response.json())).toEqual(role);
  expect(await closedBarrier(id)).toBe(false);
}, 30_000);

it("a role delete is answered 202 within the bound when the publication stalls and then fails, and its key replays the operation", async () => {
  const { f, id } = await withReporter(),
    key = crypto.randomUUID();
  const removed = await deleteRole(f, id, key, publishing(3500));
  expect(removed.response.status).toBe(202);
  // Two publications are waited for, the commit's and the response's, each for at most the bound.
  expect(removed.answeredMs).toBeLessThan(3000);
  const { operation } = DatabaseWithOperation.parse(
    await removed.response.json(),
  );
  expect(operation.kind).toBe("database.role.delete");
  expect(await rolesOf(f, id)).toHaveLength(0);
  const retry = await deleteRole(f, id, key, publishing(0));
  expect(retry.response.status).toBe(202);
  expect(
    DatabaseWithOperation.parse(await retry.response.json()).operation.id,
  ).toBe(operation.id);
}, 30_000);
