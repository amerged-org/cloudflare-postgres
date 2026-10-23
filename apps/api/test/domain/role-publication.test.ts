// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { DatabaseWithOperation, Role, listEnvelope } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture, rawRequest, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

/**
 * The real DatabaseActor namespace whose publication of the snapshot, the last step of a
 * publish, stalls for `stallMs` and then fails as the platform does when it loses the connection
 * (found live, 2026-10-23: a role create answered 500 after 12.6 s, "Network connection lost.",
 * and the role existed). The seed and the barrier before the commit are the real ones.
 */
function lostConnection(stallMs: number) {
  return {
    idFromName: (name: string) => env.DATABASE_ACTOR.idFromName(name),
    get: (
      id: DurableObjectId,
      options?: DurableObjectNamespaceGetDurableObjectOptions,
    ) =>
      new Proxy(env.DATABASE_ACTOR.get(id, options), {
        get(target, property) {
          if (property !== "publishAdmissionSnapshot")
            return Reflect.get(target, property);
          return async () => {
            await sleep(stallMs);
            throw new Error("Network connection lost.");
          };
        },
      }),
  } as unknown as Env["DATABASE_ACTOR"];
}

async function database(f: Fixture): Promise<string> {
  const response = await f.create("roles");
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json()).database.id;
}
/** The same body, as a client that sends its request again sends it. */
const reporter = { name: "reporter", valid_until: inOneHour() };
/** A role create with the given key, and how long the answer took: the work it leaves behind is awaited after. */
async function createRole(
  f: Fixture,
  id: string,
  key: string,
  actors?: Env["DATABASE_ACTOR"],
) {
  const context = createExecutionContext();
  const started = Date.now();
  const response = await rawRequest(
    `/v1/databases/${id}/roles`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.integrator}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(reporter),
    },
    context,
    actors ? { DATABASE_ACTOR: actors } : {},
  );
  const answeredMs = Date.now() - started;
  await waitOnExecutionContext(context);
  return { response, answeredMs };
}
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

it("a role create is answered 201 although the publication after its commit fails, and the same key replays it", async () => {
  const f = await fixture(),
    id = await database(f),
    key = crypto.randomUUID();
  const first = await createRole(f, id, key, lostConnection(0));
  expect(first.response.status).toBe(201);
  const created = Role.parse(await first.response.json());
  expect(created).toMatchObject({ name: "reporter", password_revision: 1 });
  // The commit stands and the Actor has not been told: its barrier is still closed.
  expect(await closedBarrier(id)).toBe(true);
  // A client that did not see the answer sends the request again.
  const retry = await createRole(f, id, key, lostConnection(0));
  expect(retry.response.status).toBe(201);
  expect(Role.parse(await retry.response.json())).toEqual(created);
  expect(await rolesOf(f, id)).toHaveLength(1);
  // The next publish, from the node's report or the cron, opens it again.
  expect(await publishDatabaseAdmission(env, id)).toBe(true);
  expect(await closedBarrier(id)).toBe(false);
}, 30_000);

it("a role create is answered within the publication bound when the publication stalls", async () => {
  const f = await fixture(),
    id = await database(f);
  const stalled = await createRole(
    f,
    id,
    crypto.randomUUID(),
    lostConnection(3500),
  );
  expect(stalled.response.status).toBe(201);
  expect(stalled.answeredMs).toBeLessThan(2500);
  expect(await rolesOf(f, id)).toHaveLength(1);
}, 30_000);
