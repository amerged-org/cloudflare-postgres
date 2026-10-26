// SPDX-License-Identifier: Apache-2.0
// A node that posts an observation of a database only when it changed, and again once in each
// anti-entropy period (plan 5.3, 11.2). Real D1 and Durable Objects; the only double wraps the
// real DatabaseActor binding to count the admission publishes it receives and, when told, to fail
// them as an Actor that cannot be reached does.
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, NODE_DATABASE_STALE_MS } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
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

const classes: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of classes.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});

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
  const refusing = { on: false };
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
            if (refusing.on) return Promise.reject(new Error("unreachable"));
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
  return { namespace, published, refusing };
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
  it("writes nothing but the time it proves the database alive, and publishes the Actor's snapshot as before", async () => {
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
    // The Actor's snapshot is published again: the repair of a publish that failed.
    expect(actors.published).toHaveLength(published + 1);
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
    expect(actors.published).toHaveLength(published + 1);
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
    expect(actors.published).toHaveLength(count + 1);
  });
});

describe("a report whose Actor publish failed", () => {
  it("is repaired by the report the node sends again, which publishes although D1 holds it", async () => {
    const f = await fixture();
    const id = await created(f);
    const actors = countingActors();
    const observed = await observationOf(id, 1);
    // D1 commits the ready state, the Actor cannot be reached: the report fails, so the node posts
    // it again.
    actors.refusing.on = true;
    expect((await post(f, actors, [observed])).status).toBe(500);
    expect(await row(id)).toMatchObject({ observed_state: "ready" });
    expect(actors.published).toHaveLength(0);
    // The Actor is reached again; D1 holds the observation already, and the snapshot is published.
    actors.refusing.on = false;
    expect(await verdicts(await post(f, actors, [observed]))).toEqual([
      "accept",
    ]);
    expect(actors.published).toEqual([id]);
    // A publish that fails again fails the report of an unchanged database as well.
    actors.refusing.on = true;
    expect((await post(f, actors, [observed])).status).toBe(500);
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

/** A sleeping database and the larger class a cold resize of it asks for. */
async function sleeper(f: F, actors: ReturnType<typeof countingActors>) {
  const id = await created(f);
  await post(f, actors, [await observationOf(id, 1)]);
  await suspend(f, id);
  const asleep = await observationOf(id, 2, "asleep");
  await post(f, actors, [asleep]);
  const target = "r" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  classes.push(target);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_mib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
     SELECT ?,1024,750,5120,80,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(target, f.size)
    .run();
  return { id, asleep, target };
}
const sleepEvents = (id: string, generation: number) =>
  env.DB.prepare(
    "SELECT kind FROM lifecycle_events WHERE database_id=? AND generation=? AND kind IN('suspended','hibernated')",
  )
    .bind(id, generation)
    .all<{ kind: string }>();

describe("a database that D1 itself moved to the state the node reports", () => {
  it("still ends the cold resize that moved it with the asleep report of its generation", async () => {
    const f = await fixture();
    const actors = countingActors();
    // A cold resize takes the next generation and observes it at once: the row is already what
    // the node will report of it, but no report of it has run the statements that end the resize.
    const { id, asleep, target } = await sleeper(f, actors);
    const resized = await request(
      `/v1/databases/${id}`,
      f.integrator,
      "PATCH",
      { size_class_id: target },
      crypto.randomUUID(),
    );
    expect(resized.status).toBe(202);
    const operation = DatabaseWithOperation.parse(
      await resized.json(),
    ).operation;
    expect(await row(id)).toMatchObject({
      generation: 3,
      observed_generation: 3,
    });
    expect(
      await verdicts(
        await post(f, actors, [
          // The same proof of the same sleep: the node has no other to give.
          await observationOf(id, 3, "asleep", {
            proven_sleep: asleep.proven_sleep,
          }),
        ]),
      ),
    ).toEqual(["accept"]);
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(operation.id)
        .first("status"),
    ).toBe("succeeded");
  });

  it("still writes the sleep's event of that generation when the node reports it after the resize timed out", async () => {
    const f = await fixture();
    const actors = countingActors();
    const { id, asleep, target } = await sleeper(f, actors);
    const resized = DatabaseWithOperation.parse(
      await (
        await request(
          `/v1/databases/${id}`,
          f.integrator,
          "PATCH",
          { size_class_id: target },
          crypto.randomUUID(),
        )
      ).json(),
    ).operation;
    // The node, its agent or its link was down for 20 minutes: the resize is failed, and the row
    // stays what the cold resize made it, which is what the node reports when it returns.
    await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
      .bind(new Date(Date.now() - 21 * 60_000).toISOString(), resized.id)
      .run();
    await runCron(env);
    expect(
      await env.DB.prepare("SELECT error_code FROM operations WHERE id=?")
        .bind(resized.id)
        .first("error_code"),
    ).toBe("operation_timeout");
    expect((await sleepEvents(id, 3)).results).toEqual([]);
    expect(
      await verdicts(
        await post(f, actors, [
          await observationOf(id, 3, "asleep", {
            proven_sleep: asleep.proven_sleep,
          }),
        ]),
      ),
    ).toEqual(["accept"]);
    // The event is where a sleeping database's resources are metered from.
    expect((await sleepEvents(id, 3)).results).toHaveLength(1);
  });
});
