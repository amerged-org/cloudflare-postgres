// SPDX-License-Identifier: Apache-2.0
// The cron step `database_actors` publishes the admission snapshot of one page of databases each
// minute: the publishes of a page overlap, up to a bound, and stop starting at the step's budget.
// Real D1 and Durable Objects. Controlled publication barriers prove concurrency independently
// of host speed; the budget test adds latency to the real DatabaseActor binding.
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_RECONCILE_CONCURRENCY,
  reconcileDatabaseActors,
} from "../../src/domain/database-actor-sync.ts";
import type { Env } from "../../src/env.ts";
import * as admission from "../../src/domain/database-admission-snapshot.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

const PUBLISH_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real DatabaseActor namespace whose `publishAdmissionSnapshot` takes `PUBLISH_MS` longer;
 * `inFlight` is the most publishes that were under way at once, `published` those that began.
 */
function slowActors() {
  const seen = { inFlight: 0, mostInFlight: 0, published: [] as string[] };
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
          return async (...args: unknown[]) => {
            seen.published.push(
              (args[0] as { database_id: string }).database_id,
            );
            seen.mostInFlight = Math.max(seen.mostInFlight, ++seen.inFlight);
            try {
              await sleep(PUBLISH_MS);
              return await (
                target as unknown as Record<
                  string,
                  (...a: unknown[]) => Promise<unknown>
                >
              ).publishAdmissionSnapshot!(...args);
            } finally {
              seen.inFlight--;
            }
          };
        },
      });
    },
  } as unknown as Env["DATABASE_ACTOR"];
  return { namespace, seen };
}

/** `count` databases of the fixture's node, in order of their identifiers. */
async function databases(count: number): Promise<string[]> {
  const f = await fixture();
  const now = new Date().toISOString();
  const ids = Array.from({ length: count }, () => newDatabaseId()).sort();
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,observed_generation,archive_path,created_at,updated_at) VALUES(?,?,?,?,?,?,'running','ready',1,1,?,?,?)",
      ).bind(
        id,
        f.project,
        f.region,
        f.node,
        id,
        f.size,
        archiveDestinationPath(
          "test-backups",
          f.region,
          id,
          1,
          newOperationId(),
        ),
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO database_admission_epochs(database_id) VALUES(?)",
      ).bind(id),
    ]),
  );
  return ids;
}
const context = (actors: ReturnType<typeof slowActors>) =>
  ({ ...env, DATABASE_ACTOR: actors.namespace }) as Env;

describe("the actors of a page", () => {
  it("are published together, never more than the bound at once", async () => {
    const ids = await databases(24);
    const publish = admission.publishDatabaseAdmission;
    let signalFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      signalFirstWave = resolve;
    });
    let releasePublishes!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePublishes = resolve;
    });
    const seen = {
      inFlight: 0,
      mostInFlight: 0,
      started: [] as string[],
      completed: [] as string[],
    };
    vi.spyOn(admission, "publishDatabaseAdmission").mockImplementation(
      async (...args) => {
        seen.started.push(args[1]);
        seen.mostInFlight = Math.max(seen.mostInFlight, ++seen.inFlight);
        if (seen.started.length === ACTOR_RECONCILE_CONCURRENCY)
          signalFirstWave();
        try {
          await blocked;
          const result = await publish(...args);
          expect(result, `snapshot accepted for ${args[1]}`).toBe(true);
          seen.completed.push(args[1]);
          return result;
        } finally {
          seen.inFlight--;
        }
      },
    );
    // This test isolates concurrency from the deadline, which the next two tests cover.
    const publishing = reconcileDatabaseActors(env, undefined, 24, Infinity);
    let page: Awaited<typeof publishing>;
    try {
      await firstWave;
      // No publish can finish before this assertion: the complete first wave must overlap,
      // and an unbounded implementation must not have started the rest of the page.
      expect(seen.started).toEqual(ids.slice(0, ACTOR_RECONCILE_CONCURRENCY));
      expect(seen.inFlight).toBe(ACTOR_RECONCILE_CONCURRENCY);
      expect(seen.completed).toEqual([]);
    } finally {
      releasePublishes();
      page = await publishing;
    }
    expect(page.ids).toEqual(ids);
    expect(page.next).toBe(ids.at(-1));
    expect(seen.started).toEqual(ids);
    expect(seen.completed.slice().sort()).toEqual(ids);
    expect(seen.inFlight).toBe(0);
    expect(seen.mostInFlight).toBe(ACTOR_RECONCILE_CONCURRENCY);
  }, 60_000);

  it("stop starting at the budget, and the next page begins after the last one that was published", async () => {
    const ids = await databases(60);
    const actors = slowActors();
    // A budget of two and a half publish times: the first waves start, the rest wait.
    const first = await reconcileDatabaseActors(
      context(actors),
      undefined,
      60,
      PUBLISH_MS * 2.5,
    );
    expect(first.ids.length).toBeGreaterThan(0);
    expect(first.ids.length).toBeLessThan(60);
    // What was published is the head of the page, each once, and the cursor stands after it.
    expect(first.ids).toEqual(ids.slice(0, first.ids.length));
    expect(new Set(actors.seen.published)).toEqual(new Set(first.ids));
    expect(actors.seen.published).toHaveLength(first.ids.length);
    expect(first.next).toBe(first.ids.at(-1));
    // The next minute goes on from the cursor, and the whole table is published once in the end.
    let page = first;
    for (let pass = 0; pass < 20 && page.next !== null; pass++)
      page = await reconcileDatabaseActors(
        context(actors),
        page.next,
        60,
        PUBLISH_MS * 2.5,
      );
    expect(page.next).toBeNull();
    expect(new Set(actors.seen.published)).toEqual(new Set(ids));
    expect(actors.seen.published).toHaveLength(60);
  }, 60_000);

  it("keep the cursor where it was when the budget is spent before the first publish", async () => {
    const ids = await databases(3);
    const actors = slowActors();
    const page = await reconcileDatabaseActors(context(actors), ids[0], 3, 0);
    expect(page).toEqual({ ids: [], next: ids[0] });
    expect(actors.seen.published).toEqual([]);
  });
});
