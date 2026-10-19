// SPDX-License-Identifier: Apache-2.0
// A node that posts an observation of a database only when it changed, and again once in each
// anti-entropy period (plan 5.3, 11.2). Real D1 and Durable Objects; the only double wraps the
// real DatabaseActor binding to count the admission publishes it receives.
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, NODE_DATABASE_STALE_MS } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  cleanupFixtures,
  fixture,
  nodeRequest,
  observationOf,
  reportBody,
  request,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type F = Awaited<ReturnType<typeof fixture>>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (id: string) =>
  env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(id)
    .first<Record<string, string | number | null>>();
const eventCount = async (id: string) =>
  (await env.DB.prepare(
    "SELECT count(*) n FROM lifecycle_events WHERE database_id=?",
  )
    .bind(id)
    .first<{ n: number }>())!.n;

/** The real DatabaseActor namespace, which counts the publishes of each database. */
function countingActors() {
  const published: string[] = [];
  const namespace = {
    idFromName: (name: string) => env.DATABASE_ACTOR.idFromName(name),
    get: (
      id: DurableObjectId,
      options?: DurableObjectNamespaceGetDurableObjectOptions,
    ) => {
      const stub = env.DATABASE_ACTOR.get(id, options);
      return new Proxy(stub, {
        get(target, property) {
          if (property !== "publishAdmissionSnapshot")
            return Reflect.get(target, property);
          return (...args: unknown[]) => {
            published.push((args[0] as { database_id: string }).database_id);
            return (
              target as unknown as Record<
                string,
                (...a: unknown[]) => Promise<unknown>
              >
            ).publishAdmissionSnapshot!(...args);
          };
        },
      });
    },
  } as unknown as Env["DATABASE_ACTOR"];
  return { namespace, published };
}

async function created(f: F, name = "database") {
  const result = DatabaseWithOperation.parse(
    await (await f.create(name)).json(),
  );
  return result.database.id;
}
const suspend = (f: F, id: string) =>
  request(
    `/v1/databases/${id}/suspend`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
/** The node posts these observations, as one report, to an API that counts the publishes. */
const post = (
  f: F,
  actors: ReturnType<typeof countingActors>,
  observations: unknown[],
) =>
  nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: reportBody(observations),
    bindings: { DATABASE_ACTOR: actors.namespace },
  });

describe("an observation that says what D1 already holds", () => {
  it("writes nothing and publishes nothing, and still proves the database alive", async () => {
    const f = await fixture();
    const id = await created(f);
    const actors = countingActors();
    const observed = await observationOf(id, 1);
    expect(await verdicts(await post(f, actors, [observed]))).toEqual([
      "accept",
    ]);
    const published = actors.published.length;
    expect(published).toBeGreaterThan(0);
    const before = (await row(id))!;
    const events = await eventCount(id);
    await sleep(20);
    // The same observation again, as the anti-entropy sends it.
    expect(await verdicts(await post(f, actors, [observed]))).toEqual([
      "accept",
    ]);
    const after = (await row(id))!;
    // Nothing the report would write is written: not the row's version, not the runtime, no event.
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.runtime_json).toBe(before.runtime_json);
    expect(await eventCount(id)).toBe(events);
    expect(actors.published).toHaveLength(published);
    // What proves the database alive is touched.
    expect(after.backup_observed_at! > before.backup_observed_at!).toBe(true);
  });

  it("does the same for a sleeping database", async () => {
    const f = await fixture();
    const id = await created(f);
    const actors = countingActors();
    await post(f, actors, [await observationOf(id, 1)]);
    await suspend(f, id);
    const asleep = await observationOf(id, 2, "asleep");
    expect(await verdicts(await post(f, actors, [asleep]))).toEqual(["accept"]);
    expect(await row(id)).toMatchObject({
      observed_state: "provisioning",
      observed_power: "hibernated",
    });
    const published = actors.published.length;
    const before = (await row(id))!;
    await sleep(20);
    expect(await verdicts(await post(f, actors, [asleep]))).toEqual(["accept"]);
    const after = (await row(id))!;
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.proven_sleep_json).toBe(before.proven_sleep_json);
    expect(actors.published).toHaveLength(published);
    expect(after.backup_observed_at).toBe(before.backup_observed_at);
  });

  it("is written and published when any field it would write differs", async () => {
    const f = await fixture();
    const id = await created(f);
    const actors = countingActors();
    const observed = await observationOf(id, 1);
    await post(f, actors, [observed]);
    const published = actors.published.length;
    const since = new Date(Date.now() - 60_000).toISOString();
    // The archive began to fail: health and its time are what D1 writes.
    expect(
      await verdicts(
        await post(f, actors, [
          {
            ...observed,
            archive: {
              last_segment: null,
              ready_files: 4,
              failing_since: since,
            },
          },
        ]),
      ),
    ).toEqual(["accept"]);
    expect(await row(id)).toMatchObject({
      archiving_health: "failing",
      archiving_health_since: since,
    });
    expect(actors.published.length).toBeGreaterThan(published);
    // Only the archive's backlog changed: D1 stores no backlog, so nothing is written for it.
    const count = actors.published.length;
    const stored = (await row(id))!;
    await sleep(20);
    await post(f, actors, [
      {
        ...observed,
        archive: { last_segment: null, ready_files: 9, failing_since: since },
      },
    ]);
    expect((await row(id))!.updated_at).toBe(stored.updated_at);
    expect(actors.published).toHaveLength(count);
  });
});

describe("a report that carries only some of the databases of a node", () => {
  it("says nothing of the others: absent is not gone, asleep or stale", async () => {
    const f = await fixture();
    const first = await created(f, "first");
    const second = await created(f, "second");
    const actors = countingActors();
    await post(f, actors, [
      await observationOf(first, 1),
      await observationOf(second, 1),
    ]);
    const before = (await row(second))!;
    await sleep(20);
    // Many reports later, which name the first database only.
    for (let report = 0; report < 3; report++)
      await post(f, actors, [await observationOf(first, 1)]);
    expect(await row(second)).toEqual(before);
    expect(before).toMatchObject({
      observed_state: "ready",
      observed_power: "awake",
    });
  });
});

describe("a database that is unchanged and alive", () => {
  it("is not stale for the length of the anti-entropy period, and is when its report is older than that", async () => {
    const f = await fixture();
    const id = await created(f);
    const actors = countingActors();
    await post(f, actors, [await observationOf(id, 1)]);
    const health = async () =>
      (
        (await (await request(`/v1/databases/${id}`, f.integrator)).json()) as {
          health: { backup: { status: string } };
        }
      ).health.backup.status;
    const age = (ms: number) =>
      env.DB.prepare("UPDATE databases SET backup_observed_at=? WHERE id=?")
        .bind(new Date(Date.now() - ms).toISOString(), id)
        .run();
    // Nothing was sent for ten minutes: it was unchanged, and its next report is not yet due.
    await age(10 * 60_000);
    expect(await health()).toBe("ok");
    await age(NODE_DATABASE_STALE_MS - 60_000);
    expect(await health()).toBe("ok");
    // Three periods without a report of it: nobody is looking at it any more.
    await age(NODE_DATABASE_STALE_MS + 60_000);
    expect(await health()).toBe("unknown");
  });
});
