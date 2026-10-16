// SPDX-License-Identifier: Apache-2.0
// A wake claim whose power transition is refused while the database row has not moved: which start
// predicate refused it, and whether the connect waits for a periodic report instead of a 57P03.
// Real D1, Durable Object and thin storage fixtures; no live evidence.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { cleanupFixtures } from "./fixtures.ts";
import { readDatabasePresence } from "../../src/domain/database-actor-sync.ts";
import {
  awakeWriter,
  databaseRow,
  parkedWriter,
  type AwakeWriter,
} from "./parked-tier-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  readWakeGuard,
  wakeGuardBlocks,
  wakeGuardVerdict,
  type WakeGuardReading,
} from "../../src/domain/wake-guard.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A parked sleep that the node's identity proof has not read yet: the last proof is the one taken
 * while the Pod ran, at the generation it was started for (the sleep bumped the database's). */
async function parkedBeforeProof() {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const intent = await parkedWriter(w, undefined, { read: false });
  await actor(w.id).seed((await readDatabasePresence(env.DB, w.id))!);
  return { w, intent };
}
/** The wake the claim made, and the controller's ready report for it. */
async function woken(w: AwakeWriter, revision: number) {
  const row = await databaseRow(w.id);
  expect(row).toMatchObject({ desired_state: "running", generation: revision });
  expect((await w.ready(revision, row.power_operation!)).status).toBe(200);
}
const wakeOperations = (id: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
  )
    .bind(id)
    .first<number>("n");
function logged(log: MockInstance, event: string) {
  return log.mock.calls.flatMap(([value]) => {
    try {
      const parsed: unknown =
        typeof value === "string" ? JSON.parse(value) : undefined;
      return parsed !== null &&
        typeof parsed === "object" &&
        (parsed as { event?: unknown }).event === event
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(what);
}
const waiting = (id: string) =>
  runInDurableObject(
    actor(id),
    (instance) =>
      (Reflect.get(instance, "guardWaits") as Map<string, unknown>).size,
  );

it("a wake of a parked sleeper whose identity proof is the one of its start is claimed at once", async () => {
  const log = vi.spyOn(console, "log");
  const { w, intent } = await parkedBeforeProof();
  // The Pod, its volume and the proof of both are the ones the sleep left, and the guard says so.
  const reading = (await readWakeGuard(env.DB, w.id, "app"))!;
  expect(reading).toMatchObject({
    storage: true,
    volume_bound: true,
    volume_current: true,
  });
  expect(wakeGuardVerdict(reading)).toBe("holds");
  const connecting = actor(w.id).ensureAwake(w.id, "app", {
    deadline: Date.now() + 15_000,
  });
  await until(
    async () => (await databaseRow(w.id)).desired_state === "running",
    "wake_not_claimed",
  );
  expect(await waiting(w.id)).toBe(0);
  await woken(w, intent.generation + 1);
  expect(await connecting).toMatchObject({ ok: true });
  expect(await wakeOperations(w.id)).toBe(1);
  expect(logged(log, "actor_claim_refused")).toEqual([]);
  expect(logged(log, "actor_claim_waited")).toEqual([]);
}, 30_000);

it("the proof of the start stands in only while the controller's word and the proof's evidence hold", async () => {
  const { w } = await parkedBeforeProof();
  const reads = async () => {
    const reading = (await readWakeGuard(env.DB, w.id, "app"))!;
    expect(reading.volume_bound).toBe(true);
    return reading.volume_current;
  };
  expect(await reads()).toBe(true);
  // The controller's word is older than the host guard trusts it.
  const word = (await databaseRow(w.id)).parked_json!;
  await env.DB.prepare(
    "UPDATE databases SET parked_json=json_set(parked_json,'$.observed_at',?) WHERE id=?",
  )
    .bind(new Date(Date.now() - 181_000).toISOString(), w.id)
    .run();
  expect(await reads()).toBe(false);
  await env.DB.prepare("UPDATE databases SET parked_json=? WHERE id=?")
    .bind(word, w.id)
    .run();
  expect(await reads()).toBe(true);
  // A record of a shape this API does not know says nothing.
  await env.DB.prepare(
    "UPDATE databases SET parked_json=json_set(parked_json,'$.v',2) WHERE id=?",
  )
    .bind(w.id)
    .run();
  expect(await reads()).toBe(false);
  await env.DB.prepare("UPDATE databases SET parked_json=? WHERE id=?")
    .bind(word, w.id)
    .run();
  expect(await reads()).toBe(true);
  // The sleep is not confirmed as a stopped runtime.
  await env.DB.prepare("UPDATE databases SET observed_power='awake' WHERE id=?")
    .bind(w.id)
    .run();
  expect(await reads()).toBe(false);
  await env.DB.prepare(
    "UPDATE databases SET observed_power='hibernated' WHERE id=?",
  )
    .bind(w.id)
    .run();
  expect(await reads()).toBe(true);
  // Its operation is not completed.
  const stop = (await databaseRow(w.id)).power_operation!;
  const { completed_at } = (await env.DB.prepare(
    "SELECT completed_at FROM operations WHERE id=?",
  )
    .bind(stop)
    .first<{ completed_at: string }>())!;
  await env.DB.prepare(
    "UPDATE operations SET status='running',completed_at=NULL WHERE id=?",
  )
    .bind(stop)
    .run();
  expect(await reads()).toBe(false);
  await env.DB.prepare(
    "UPDATE operations SET status='succeeded',completed_at=? WHERE id=?",
  )
    .bind(completed_at, stop)
    .run();
  expect(await reads()).toBe(true);
  // The node found the volume frozen: the guard stopped the Pod, whose limits are no evidence.
  await w.evidence({ quiesced: true });
  expect(await reads()).toBe(false);
  await w.evidence();
  expect(await reads()).toBe(true);
}, 30_000);

const holding: WakeGuardReading = {
  generation: 2,
  desired_state: "suspended",
  suspension_reason: "idle",
  live: true,
  role: true,
  node_found: true,
  node_ready: true,
  node_schedulable: true,
  node_lost: false,
  node_observed_age_ms: 20_000,
  cpu: true,
  placement: "actual_ram",
  memory: true,
  memory_sample_age_ms: 10_000,
  memory_pressure: 0,
  memory_available_bytes: 4 * 1024 ** 3,
  memory_required_bytes: 1024 ** 3,
  thin: true,
  thin_status: "ready",
  thin_error: null,
  storage: true,
  authority_age_ms: 1_000,
  authority_received_age_ms: 1_000,
  authority_expires_in_ms: 9_000,
  inventory_age_ms: 60_000,
  inventory_expires_in_ms: 240_000,
  authority_write_allowed: true,
  qualified: true,
  qualification_age_ms: 30_000,
  parked: false,
  volume_generation: 2,
  volume_bound: true,
  volume_current: true,
  protected: false,
  protection: true,
  admission_pending: false,
};
const verdictOf = (changes: Partial<WakeGuardReading>) => {
  const reading = { ...holding, ...changes };
  const blocks = wakeGuardBlocks(reading);
  return {
    verdict: wakeGuardVerdict(reading, blocks),
    blocked_by: blocks.map((block) => block.reason),
  };
};

it("only a part that fails for a late report waits; a part that fails on current facts, and any part beside it, is refused", () => {
  expect(verdictOf({})).toEqual({ verdict: "holds", blocked_by: [] });
  // Late reports: the facts the part judges are older than the guard's window.
  expect(
    verdictOf({
      qualified: false,
      storage: false,
      qualification_age_ms: 200_000,
    }),
  ).toEqual({ verdict: "waits", blocked_by: ["thin_qualification_stale"] });
  expect(
    verdictOf({
      protected: true,
      protection: false,
      inventory_age_ms: 130_000,
    }),
  ).toEqual({ verdict: "waits", blocked_by: ["protection_proof_stale"] });
  // A stale report is not judged: what it says of the pool or the writer waits for the next one.
  expect(
    verdictOf({
      storage: false,
      authority_write_allowed: false,
      volume_current: false,
      authority_age_ms: 150_000,
    }),
  ).toEqual({ verdict: "waits", blocked_by: ["thin_authority_stale"] });
  // Current facts that do not fit stay refused, whatever else is late.
  expect(verdictOf({ storage: false, authority_write_allowed: false })).toEqual(
    { verdict: "refused", blocked_by: ["thin_write_denied"] },
  );
  expect(verdictOf({ storage: false })).toEqual({
    verdict: "refused",
    blocked_by: ["thin_capacity"],
  });
  expect(
    verdictOf({
      storage: false,
      qualified: false,
      qualification_age_ms: 5_000,
    }),
  ).toEqual({ verdict: "refused", blocked_by: ["thin_unqualified"] });
  expect(verdictOf({ protected: true, protection: false })).toEqual({
    verdict: "refused",
    blocked_by: ["protection_not_proved"],
  });
  expect(
    verdictOf({
      cpu: false,
      memory: false,
      node_observed_age_ms: 400_000,
      memory_sample_age_ms: 10_000,
    }),
  ).toEqual({
    verdict: "refused",
    blocked_by: ["node_observation_stale", "memory_capacity"],
  });
  // A node that is not ready is not a late report, whatever its observation's age.
  expect(
    verdictOf({ node_ready: false, cpu: false, node_observed_age_ms: 400_000 }),
  ).toEqual({ verdict: "refused", blocked_by: ["node_not_ready"] });
  expect(verdictOf({ storage: false, thin_error: "thin_storage_x" })).toEqual({
    verdict: "refused",
    blocked_by: ["thin_blocked"],
  });
  expect(verdictOf({ live: false })).toEqual({
    verdict: "refused",
    blocked_by: ["database_deleted"],
  });
  // A database that is no longer an idle sleeper is for the claim to decide.
  expect(verdictOf({ desired_state: "running" }).verdict).toBe("moved");
  expect(verdictOf({ suspension_reason: "manual" }).verdict).toBe("moved");
});
