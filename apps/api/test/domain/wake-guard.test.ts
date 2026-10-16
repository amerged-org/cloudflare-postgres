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
  hibernated,
  idleIntent,
  parkedPod,
  parkedWriter,
  type AwakeWriter,
} from "./parked-tier-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
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

/** A thin database that sleeps idle with its Pod parked, and whose guard holds: the controller's
 * report is accepted and the node's identity proof has read the volume at the sleep's generation. */
async function parked() {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const intent = await parkedWriter(w);
  await actor(w.id).seed((await readDatabasePresence(env.DB, w.id))!);
  return { w, intent };
}
/** The accepted thin authority as it stood `ms` ago: no renewal or identity proof since. */
async function agedAuthority(w: AwakeWriter, ms: number) {
  const row = (await env.DB.prepare(
    "SELECT authority_json,authority_received_at FROM node_thin_storage WHERE node_id=?",
  )
    .bind(w.f.node)
    .first<{ authority_json: string; authority_received_at: string }>())!;
  const authority = JSON.parse(row.authority_json) as Record<string, string>;
  const back = (value: string) =>
    new Date(Date.parse(value) - ms).toISOString();
  for (const key of [
    "observed_at",
    "captured_at",
    "expires_at",
    "inventory_observed_at",
    "inventory_expires_at",
  ])
    authority[key] = back(authority[key]!);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=?,authority_received_at=? WHERE node_id=?",
  )
    .bind(JSON.stringify(authority), back(row.authority_received_at), w.f.node)
    .run();
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

it("a wake claim refused with its row unmoved logs the start predicates, part by part, once", async () => {
  const log = vi.spyOn(console, "log");
  const { w, intent } = await parked();
  await agedAuthority(w, 200_000);
  // A deadline too near to wait: the claim is refused and diagnosed exactly as it is when it waits.
  expect(
    await actor(w.id).ensureAwake(w.id, "app", { deadline: Date.now() + 1500 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  expect(await wakeOperations(w.id)).toBe(0);
  expect(logged(log, "actor_claim_refused")).toEqual([
    expect.objectContaining({
      database_id: w.id,
      revision: intent.generation + 1,
      verdict: "waits",
      blocked_by: ["thin_authority_stale"],
      // Everything but the thin authority's renewal is as the guard needs it.
      live: true,
      role: true,
      node_ready: true,
      node_schedulable: true,
      node_lost: false,
      cpu: true,
      memory: true,
      protection: true,
      thin: true,
      storage: false,
      qualified: true,
      authority_write_allowed: true,
      volume_bound: true,
      volume_current: true,
      admission_pending: false,
      // The ages of what is stale say how stale.
      authority_age_ms: expect.any(Number),
      authority_received_age_ms: expect.any(Number),
      authority_expires_in_ms: expect.any(Number),
      inventory_age_ms: expect.any(Number),
      inventory_expires_in_ms: expect.any(Number),
    }),
  ]);
  const [event] = logged(log, "actor_claim_refused") as Record<
    string,
    number
  >[];
  expect(event!.authority_age_ms).toBeGreaterThanOrEqual(200_000);
  expect(event!.authority_received_age_ms).toBeGreaterThanOrEqual(200_000);
  expect(event!.authority_expires_in_ms).toBeLessThan(0);
  // The identity proof stays valid for its 300 s; its age alone is what the start window judges.
  expect(event!.inventory_age_ms).toBeGreaterThanOrEqual(200_000);
  expect(event!.inventory_expires_in_ms).toBeGreaterThan(0);
  // The event carries facts of the guard, never a credential, a token or the role's name.
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain('"app"');
  expect(serialized).not.toContain(w.f.agent);
}, 30_000);

it("a claim refused for a stale thin inventory waits for the next one within the deadline, then claims and wakes", async () => {
  const log = vi.spyOn(console, "log");
  const { w, intent } = await parked();
  await agedAuthority(w, 200_000);
  const waiterId = crypto.randomUUID();
  const connecting = actor(w.id).ensureAwake(w.id, "app", {
    waiterId,
    deadline: Date.now() + 15_000,
  });
  let settled = false;
  void connecting.finally(() => {
    settled = true;
  });
  // Held, not refused: the connect waits while the inventory is stale, and nothing is claimed.
  await until(
    async () => (await waiting(w.id)) === 1,
    "connect_not_waiting_for_the_guard",
  );
  await sleep(1200);
  expect(settled).toBe(false);
  expect(await wakeOperations(w.id)).toBe(0);
  expect((await databaseRow(w.id)).desired_state).toBe("suspended");
  // The next accepted identity proof of the node arrives.
  await w.evidence({ generation: intent.generation });
  await until(
    async () => (await databaseRow(w.id)).desired_state === "running",
    "wake_not_claimed",
  );
  await woken(w, intent.generation + 1);
  expect(await connecting).toMatchObject({ ok: true });
  expect(await wakeOperations(w.id)).toBe(1);
  expect(await waiting(w.id)).toBe(0);
  expect(logged(log, "actor_claim_refused")).toEqual([
    expect.objectContaining({
      database_id: w.id,
      verdict: "waits",
      blocked_by: ["thin_authority_stale"],
    }),
  ]);
  expect(logged(log, "actor_claim_waited")).toEqual([
    expect.objectContaining({
      database_id: w.id,
      waiter_id: waiterId,
      outcome: "claim",
      polls: expect.any(Number),
      waited_ms: expect.any(Number),
    }),
  ]);
}, 30_000);

it("a claim whose stale inventory outlasts the deadline is refused as before, without a wake", async () => {
  const log = vi.spyOn(console, "log");
  const { w } = await parked();
  await agedAuthority(w, 200_000);
  const started = Date.now();
  expect(
    await actor(w.id).ensureAwake(w.id, "app", { deadline: Date.now() + 5000 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  const waited = Date.now() - started;
  // It waited for what the deadline leaves after the margin, and gave the answer before the deadline.
  expect(waited).toBeGreaterThanOrEqual(1000);
  expect(waited).toBeLessThan(5000);
  expect(await wakeOperations(w.id)).toBe(0);
  expect((await databaseRow(w.id)).desired_state).toBe("suspended");
  expect(logged(log, "actor_claim_waited")).toEqual([
    expect.objectContaining({ database_id: w.id, outcome: "expired" }),
  ]);
}, 30_000);

it("a claim refused for lack of capacity with fresh facts is refused at once, not waited for", async () => {
  const log = vi.spyOn(console, "log");
  const { w, intent } = await parked();
  // The node cannot fit another start: its CPU is spoken for, and every report of it is current.
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+100 WHERE id=?",
  )
    .bind(w.f.node)
    .run();
  const started = Date.now();
  expect(
    await actor(w.id).ensureAwake(w.id, "app", {
      deadline: Date.now() + 20_000,
    }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  // A wait would have lasted until the deadline less the margin.
  expect(Date.now() - started).toBeLessThan(8000);
  expect(await wakeOperations(w.id)).toBe(0);
  expect(logged(log, "actor_claim_refused")).toEqual([
    expect.objectContaining({
      database_id: w.id,
      revision: intent.generation + 1,
      verdict: "refused",
      blocked_by: ["cpu_capacity"],
      cpu: false,
    }),
  ]);
  expect(logged(log, "actor_claim_waited")).toEqual([]);
}, 30_000);

it("a second connect during the wait joins the one claim: one operation, one hint, both released", async () => {
  const log = vi.spyOn(console, "log");
  const { w, intent } = await parked();
  await agedAuthority(w, 200_000);
  const region = (await databaseRow(w.id)).region_id;
  const notified = await runInDurableObject(
    env.REGION_LINK.get(env.REGION_LINK.idFromName(region)),
    (instance) => vi.spyOn(Object.getPrototypeOf(instance), "notify"),
  );
  const first = actor(w.id).ensureAwake(w.id, "app", {
    waiterId: crypto.randomUUID(),
    deadline: Date.now() + 20_000,
  });
  await until(async () => (await waiting(w.id)) === 1, "first_not_waiting");
  const second = actor(w.id).ensureAwake(w.id, "app", {
    waiterId: crypto.randomUUID(),
    deadline: Date.now() + 20_000,
  });
  await until(async () => (await waiting(w.id)) === 2, "second_not_waiting");
  expect(await wakeOperations(w.id)).toBe(0);
  // Only the first connect made a claim: the second found it waiting and joined the wait.
  expect(logged(log, "actor_claim_refused")).toHaveLength(1);
  await w.evidence({ generation: intent.generation });
  await until(
    async () => (await databaseRow(w.id)).desired_state === "running",
    "wake_not_claimed",
  );
  await woken(w, intent.generation + 1);
  expect(await Promise.all([first, second])).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
  ]);
  expect(await wakeOperations(w.id)).toBe(1);
  expect(notified).toHaveBeenCalledTimes(1);
  expect(await databaseRow(w.id)).toMatchObject({
    generation: intent.generation + 1,
  });
  expect(logged(log, "actor_claim_refused")).toHaveLength(1);
  expect(
    logged(log, "actor_claim_waited").map((event) => event.outcome),
  ).toEqual(["claim", "claim"]);
}, 40_000);

it("a connect that gives up leaves the wait and claims nothing when the inventory arrives", async () => {
  const { w, intent } = await parked();
  await agedAuthority(w, 200_000);
  const waiterId = crypto.randomUUID();
  const connecting = actor(w.id).ensureAwake(w.id, "app", {
    waiterId,
    deadline: Date.now() + 20_000,
  });
  await until(async () => (await waiting(w.id)) === 1, "not_waiting");
  expect(await actor(w.id).cancelWakeWaiter(w.id, waiterId)).toBe(true);
  expect(await connecting).toEqual({ ok: false, sqlstate: "57P03" });
  expect(await waiting(w.id)).toBe(0);
  await w.evidence({ generation: intent.generation });
  await sleep(1800);
  expect(await wakeOperations(w.id)).toBe(0);
  expect((await databaseRow(w.id)).desired_state).toBe("suspended");
}, 30_000);

it("more connects than the cap are refused at once while the others keep waiting", async () => {
  const { w, intent } = await parked();
  await agedAuthority(w, 200_000);
  const connects = Array.from({ length: 4 }, () =>
    actor(w.id).ensureAwake(w.id, "app", {
      waiterId: crypto.randomUUID(),
      deadline: Date.now() + 20_000,
    }),
  );
  await until(async () => (await waiting(w.id)) === 4, "cap_not_reached");
  const started = Date.now();
  expect(
    await actor(w.id).ensureAwake(w.id, "app", {
      waiterId: crypto.randomUUID(),
      deadline: Date.now() + 20_000,
    }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await waiting(w.id)).toBe(4);
  await w.evidence({ generation: intent.generation });
  await until(
    async () => (await databaseRow(w.id)).desired_state === "running",
    "wake_not_claimed",
  );
  await woken(w, intent.generation + 1);
  expect((await Promise.all(connects)).every((value) => value.ok)).toBe(true);
  expect(await wakeOperations(w.id)).toBe(1);
}, 40_000);

it("a sleep whose identity proof has not read its generation yet is waited for, not refused", async () => {
  const log = vi.spyOn(console, "log");
  const w = await awakeWriter(await thinExecutionFixture(releases));
  // The idle intent moved the generation; the node's last proof still describes the awake one.
  const intent = await idleIntent(w);
  expect(await (await hibernated(w, intent, parkedPod(w))).json()).toEqual({
    accepted: 1,
  });
  await actor(w.id).seed((await readDatabasePresence(env.DB, w.id))!);
  const connecting = actor(w.id).ensureAwake(w.id, "app", {
    deadline: Date.now() + 15_000,
  });
  await until(async () => (await waiting(w.id)) === 1, "not_waiting");
  expect(logged(log, "actor_claim_refused")).toEqual([
    expect.objectContaining({
      verdict: "waits",
      blocked_by: ["thin_identity_behind"],
      volume_bound: true,
      volume_current: false,
    }),
  ]);
  await w.evidence({ generation: intent.generation });
  await until(
    async () => (await databaseRow(w.id)).desired_state === "running",
    "wake_not_claimed",
  );
  await woken(w, intent.generation + 1);
  expect(await connecting).toMatchObject({ ok: true });
}, 40_000);

it("stale node reports are waited for like a stale inventory: the node's observation and its memory sample", async () => {
  const log = vi.spyOn(console, "log");
  const { w, intent } = await parked();
  const stale = new Date(Date.now() - 200_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?").bind(
      stale,
      w.f.node,
    ),
    env.DB.prepare(
      "UPDATE node_memory_samples SET observed_at=? WHERE node_id=?",
    ).bind(stale, w.f.node),
  ]);
  const connecting = actor(w.id).ensureAwake(w.id, "app", {
    deadline: Date.now() + 15_000,
  });
  await until(async () => (await waiting(w.id)) === 1, "not_waiting");
  expect(logged(log, "actor_claim_refused")).toEqual([
    expect.objectContaining({
      verdict: "waits",
      blocked_by: ["node_observation_stale", "memory_sample_stale"],
      placement: "actual_ram",
      cpu: false,
      memory: false,
    }),
  ]);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?").bind(
      now,
      w.f.node,
    ),
    env.DB.prepare(
      "UPDATE node_memory_samples SET observed_at=? WHERE node_id=?",
    ).bind(now, w.f.node),
  ]);
  await until(
    async () => (await databaseRow(w.id)).desired_state === "running",
    "wake_not_claimed",
  );
  await woken(w, intent.generation + 1);
  expect(await connecting).toMatchObject({ ok: true });
}, 40_000);

/** A reading of a sleeper whose every part holds, to change one fact at a time. */
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
