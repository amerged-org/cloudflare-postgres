// SPDX-License-Identifier: Apache-2.0
// A report of many databases (plan 5.3, 11.1): the API takes its databases together, not one after
// the other, and never keeps a node waiting past its budget. Real D1 and Durable Objects; the only
// double wraps the real DatabaseActor binding to add the latency a cold Actor has (250-1100 ms of
// publish measured on EU1 with 235 databases).
import { env } from "cloudflare:workers";
import { newOperationId } from "@pgcf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api-error.ts";
import { nodeObservations } from "../../src/domain/node-observations.ts";
import type { ApiContext, Env } from "../../src/env.ts";
import {
  cleanupFixtures,
  fixture,
  nodeRequest,
  observationOf,
  refusal,
  reportBody,
  setNodePolicy,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

const DATABASES = 64;
const PUBLISH_MS = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real DatabaseActor namespace, whose `publishAdmissionSnapshot` (the last step of a publish)
 * takes `ms` longer. `failing` names a database whose publish throws instead; `published` counts
 * the publishes that began.
 */
function slowActors(ms: number, failing?: string) {
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
          return async (...args: unknown[]) => {
            const database = (args[0] as { database_id: string }).database_id;
            published.push(database);
            await sleep(ms);
            if (database === failing) throw new Error("publish_failed");
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

/** A node with room for `count` databases, each created through the API and placed on it. */
async function populated(count: number) {
  const f = await fixture(400_000, 10_000);
  await setNodePolicy(f);
  const ids: string[] = [];
  for (let at = 0; at < count; at += 8) {
    const created = await Promise.all(
      Array.from({ length: Math.min(8, count - at) }, (_, i) =>
        f.create(`scale-${at + i}`),
      ),
    );
    for (const response of created) {
      expect(response.status).toBe(202);
      ids.push(
        ((await response.json()) as { database: { id: string } }).database.id,
      );
    }
  }
  return { f, ids };
}
const readyCount = async (ids: string[]) =>
  (await env.DB.prepare(
    "SELECT count(*) n FROM databases WHERE observed_state='ready' AND id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(ids))
    .first<{ n: number }>())!.n;

/**
 * What the node reports of database `index`: most are ready, some belong to no database of this
 * node (stale), some name another operation than D1's (conflict).
 */
async function observed(id: string, index: number) {
  if (index % 8 === 3)
    return {
      ...(await observationOf(id, 1)),
      id: "a".repeat(18) + index.toString(36).padStart(2, "0"),
    };
  if (index % 8 === 5)
    return observationOf(id, 1, "ready", { operation: newOperationId() });
  return observationOf(id, 1);
}
const expectedVerdict = (index: number) =>
  index % 8 === 3 ? "stale" : index % 8 === 5 ? "conflict" : "accept";

describe("a report of many databases", () => {
  it("is taken together, answered in the report's order, and keeps every verdict", async () => {
    const { f, ids } = await populated(DATABASES);
    const reported = await Promise.all(ids.map(observed));
    const accepted = ids.filter((_, i) => expectedVerdict(i) === "accept");
    const actors = slowActors(PUBLISH_MS);
    const started = Date.now();
    const response = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(reported),
      bindings: { DATABASE_ACTOR: actors.namespace },
    });
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      databases: { id: string; verdict: string }[];
    };
    // The answer names each database once, where the report named it.
    expect(answer.databases.map((d) => d.id)).toEqual(
      reported.map((o) => o.id),
    );
    expect(answer.databases.map((d) => d.verdict)).toEqual(
      ids.map((_, i) => expectedVerdict(i)),
    );
    // The accepted ones are applied and published; the stale and the conflicting are not.
    expect(await readyCount(ids)).toBe(accepted.length);
    expect(new Set(actors.published)).toEqual(new Set(accepted));
    // One after the other the publishes alone take this long; together they take a fraction.
    const sequential = accepted.length * PUBLISH_MS;
    expect(
      elapsed,
      `${accepted.length} publishes of ${PUBLISH_MS} ms in ${elapsed} ms, one after the other ${sequential} ms`,
    ).toBeLessThan(sequential / 2);
  }, 60_000);

  it("logs one line for a large or a slow report, and none for a small quick one", async () => {
    const { f, ids } = await populated(DATABASES);
    const lines = vi.spyOn(console, "log");
    const logged = () =>
      lines.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((line) => line.event === "node_observation_report");
    const one = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody([await observationOf(ids[0]!, 1)]),
    });
    expect(one.status).toBe(200);
    expect(logged()).toEqual([]);
    const reported = await Promise.all(ids.map(observed));
    const actors = slowActors(PUBLISH_MS);
    const big = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(reported),
      bindings: { DATABASE_ACTOR: actors.namespace },
    });
    expect(big.status).toBe(200);
    const [line, ...rest] = logged();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      node_id: f.node,
      databases: DATABASES,
      accept: ids.filter((_, i) => expectedVerdict(i) === "accept").length,
      stale: ids.filter((_, i) => expectedVerdict(i) === "stale").length,
      conflict: ids.filter((_, i) => expectedVerdict(i) === "conflict").length,
      deferred: 0,
    });
    expect(line!.elapsed_ms).toEqual(expect.any(Number));
    expect(line!.slowest_ms).toBeGreaterThanOrEqual(PUBLISH_MS);
  }, 60_000);

  it("starts nothing after its budget and is refused whole, so the node sends it again", async () => {
    const { f, ids } = await populated(DATABASES);
    const reported = await Promise.all(ids.map((id) => observationOf(id, 1)));
    const actors = slowActors(PUBLISH_MS);
    const caller = {
      id: f.node,
      uid: f.nodeUid,
      region_id: f.region,
      fenced: false,
    };
    const context = (namespace: Env["DATABASE_ACTOR"]) =>
      ({
        env: { ...env, DATABASE_ACTOR: namespace },
        json: (body: unknown) => Response.json(body),
      }) as unknown as ApiContext;
    const lines = vi.spyOn(console, "log");
    const refused = await nodeObservations(
      context(actors.namespace),
      caller,
      reportBody(reported),
      PUBLISH_MS,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    // A retryable 503: both the previous agent and this one keep the whole report and post it again.
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      code: "capacity_exhausted",
      details: { reason: "not_ready" },
    });
    const done = await readyCount(ids);
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(DATABASES);
    const [line] = lines.mock.calls
      .map(([text]) => JSON.parse(String(text)) as Record<string, unknown>)
      .filter((entry) => entry.event === "node_observation_report");
    expect(line).toMatchObject({
      databases: DATABASES,
      accept: done,
      deferred: DATABASES - done,
    });
    // The retry is the same report: the ones already applied are accepted again, the rest follow.
    const again = await nodeObservations(
      context(env.DATABASE_ACTOR),
      caller,
      reportBody(reported),
    );
    expect(
      ((await again.json()) as { databases: { verdict: string }[] }).databases,
    ).toHaveLength(DATABASES);
    expect(await readyCount(ids)).toBe(DATABASES);
  }, 60_000);

  it("stops starting databases when one fails, and the failure is the report's", async () => {
    const { f, ids } = await populated(DATABASES);
    const reported = await Promise.all(ids.map((id) => observationOf(id, 1)));
    const actors = slowActors(PUBLISH_MS, ids[2]);
    const response = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(reported),
      bindings: { DATABASE_ACTOR: actors.namespace },
    });
    expect((await refusal(response)).code).toBe("internal");
    // The window of databases in flight finished; no database was started after the failure.
    await sleep(PUBLISH_MS * 3);
    expect(actors.published.length).toBeLessThan(DATABASES / 2);
  }, 60_000);
});
