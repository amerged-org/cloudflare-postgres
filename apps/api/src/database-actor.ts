// SPDX-License-Identifier: Apache-2.0
// This module is what a cold DatabaseActor evaluates before it answers an admission, so it imports
// only the contract modules and the snapshot schema it needs. What writes D1 and tells the region
// loads on first use (`d1`), so the awake path never evaluates it. A wake ticket's claim starts in
// the moment the answer is returned, and the answer leaves only after that microtask has evaluated
// the module: database-actor-d1.ts therefore stays small.
import { DurableObject } from "cloudflare:workers";
import {
  ADMISSION_DEADLINE_MS,
  DatabaseRegionRoute as RegionRoute,
  DatabaseRuntime,
} from "@pgcf/contracts/database-admission";
import type {
  DatabaseAdmission,
  DatabaseWakeAdmission,
  NodeDatabaseTarget,
} from "@pgcf/contracts/database-admission";
import { DatabaseId, RoleName, newOperationId } from "@pgcf/contracts/ids";
import { roleRevisionHash } from "@pgcf/contracts/route-token";
import { Timestamp, roleExpiryInstant } from "@pgcf/contracts/timestamp";
import { z } from "zod";

import type { Env } from "./env.ts";
import type { DatabaseRow } from "./domain/rows.ts";
import {
  AdmissionMutationIntent,
  DatabaseAdmissionSnapshot,
} from "./domain/admission-state.ts";
import type { LocalAdmissionActor } from "./domain/admission-mutations.ts";
/** The D1 side of the actor: the claim, the snapshot read and the hint. */
const d1 = () => import("./database-actor-d1.ts");
const PersistedAdmissionMutationIntent = AdmissionMutationIntent.extend({
  started_at: z.number().int().nonnegative().default(0),
});
type PersistedAdmissionMutationIntent = z.infer<
  typeof PersistedAdmissionMutationIntent
>;

/** A committed ready observation's push starts the wake loop's D1 read at once; this bounded read only recovers a lost push. */
const WAKE_FALLBACK_READ_MS = 1000;
/** A concurrency block held this long is logged with its callback's name. */
const GATE_LOG_MS = 1000;
/** A wake claim whose commit lost its row to a concurrent write is read and tried again this often. */
const WAKE_CLAIM_RETRIES = 2;
/** Actors constructed by this isolate; only for the actor_admit line. */
let isolateActors = 0;
/**
 * A wake ticket of a sleeping database (pool design 2026-10-16): the operation and generation its
 * claim commits in D1, and the route revision and role hash the Edge signs into route v5 with it.
 * Every connect of the same wake answers the same ticket, so the gateway coalesces them.
 */
interface WakeTicket {
  operation: string;
  generation: number;
  route_revision: number;
  role_revision_hash: string;
  state: "pending" | "claimed" | "refused";
  issued_at: number;
}
/**
 * How one admitWake was answered, for the actor_admit line: from the snapshot of an awake database,
 * with a wake ticket (`reused` when it is one an earlier connect issued), through ensureAwake, or
 * refused by the Actor's own state.
 */
interface AdmissionTrace {
  path: "snapshot" | "ticket" | "ensure_awake" | "refused";
  reused: boolean | null;
}
/**
 * A role the actor may admit: live in D1, with the time its credential stops being accepted.
 * A bare name (the form older persisted presence and seeds use) is a role without expiry.
 */
const PresenceRole = z.union([
  RoleName.transform((name) => ({ name, valid_until: null as string | null })),
  z.strictObject({ name: RoleName, valid_until: Timestamp.nullable() }),
]);
export const DatabasePresence = z
  .strictObject({
    database_id: DatabaseId,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updated_at: Timestamp,
    roles: z
      .array(PresenceRole)
      .max(100)
      .refine(
        (roles) =>
          new Set(roles.map((role) => role.name)).size === roles.length,
      )
      .transform((roles) =>
        [...roles].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
      ),
    deleted: z.boolean(),
  })
  .refine((snapshot) => !snapshot.deleted || snapshot.roles.length === 0);
export type DatabasePresence = z.infer<typeof DatabasePresence>;
/**
 * Whether a role can start a session now. PostgreSQL enforces VALID UNTIL on the password, but a
 * hibernated database would be woken for a credential that can no longer log in, so the actor
 * refuses it first, with the SQLSTATE PostgreSQL itself answers an expired password with. It
 * refuses from the instant PostgreSQL does: the start of the second the expiry falls in.
 */
function roleAdmitted(
  presence: DatabasePresence,
  name: string,
  now = Date.now(),
): boolean {
  const role = presence.roles.find((value) => value.name === name);
  return (
    role !== undefined &&
    (role.valid_until === null || roleExpiryInstant(role.valid_until) > now)
  );
}
export type { DatabaseAdmission } from "@pgcf/contracts/database-admission";
/**
 * The gateway the Edge dials for a database (plan 5.3, 5.8): routes are signed with the key of one
 * node and only its gateway verifies them, so the node's own gateway, a public hostname with no
 * service binding, and only for a node that has none, the region's.
 */
export const GATEWAY_COLUMNS = (region: string, node: string) =>
  `CASE WHEN ${node}.gateway_url IS NOT NULL THEN ${node}.gateway_url ELSE ${region}.gateway_url END gateway_url,CASE WHEN ${node}.gateway_url IS NOT NULL THEN NULL ELSE ${region}.gateway_binding END gateway_binding`;
export const DATABASE_ADMISSION_QUERY = `SELECT d.desired_state,d.observed_state,d.generation,d.observed_generation,d.storage_generation,d.observed_power,d.suspension_reason,d.power_operation,d.deleted_at database_deleted_at,p.deleted_at project_deleted_at,
  d.runtime_json,COALESCE(e.route_revision,1) route_revision,r.name role_name,g.id,${GATEWAY_COLUMNS("g", "n")},n.id node_id,n.lost_at,
  CASE WHEN NOT EXISTS(SELECT 1 FROM database_admission_epochs ae WHERE ae.database_id=d.id AND ae.mutation_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=d.id AND p.phase IN('proving','restoring','rolling_back')) THEN 0 ELSE 1 END admission_blocked
  FROM databases d JOIN projects p ON p.id=d.project_id JOIN regions g ON g.id=d.region_id
  LEFT JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id
  LEFT JOIN database_admission_epochs e ON e.database_id=d.id
  LEFT JOIN roles r ON r.database_id=d.id AND r.name=? AND r.deleted_at IS NULL
    AND (r.valid_until IS NULL OR substr(r.valid_until,1,19)>strftime('%Y-%m-%dT%H:%M:%S','now')) WHERE d.id=? LIMIT 1`;
interface AdmissionRow {
  route_revision: number;
  generation: number;
  observed_generation: number;
  storage_generation: number;
  observed_power: string;
  suspension_reason: string | null;
  power_operation: string | null;
  desired_state: string;
  observed_state: string;
  database_deleted_at: string | null;
  project_deleted_at: string | null;
  runtime_json: string | null;
  role_name: string | null;
  id: string;
  gateway_url: string;
  gateway_binding: string | null;
  node_id: string | null;
  lost_at: string | null;
  admission_blocked: number;
}

function admittedRoute(
  row: AdmissionRow,
  databaseId: string,
): DatabaseAdmission {
  const region = RegionRoute.safeParse({
    id: row.id,
    gateway_url: row.gateway_url,
    gateway_binding: row.gateway_binding,
  });
  if (!region.success) return { ok: false, sqlstate: "08006" };
  // Without the unit the node reported for the observed generation the database is not ready for
  // a connection yet.
  const target = verifiedTarget(row, databaseId);
  return target && row.node_id !== null
    ? { ok: true, region: region.data, node: row.node_id, target }
    : { ok: false, sqlstate: "57P03" };
}

/** The node's report of the observed generation and the storage generation names the unit that serves it. */
function verifiedTarget(
  row: AdmissionRow,
  databaseId: string,
): NodeDatabaseTarget | undefined {
  if (row.runtime_json === null) return undefined;
  const runtime = DatabaseRuntime.safeParse(JSON.parse(row.runtime_json));
  return runtime.success &&
    runtime.data.database_id === databaseId &&
    runtime.data.node_id === row.node_id &&
    runtime.data.generation === row.observed_generation &&
    runtime.data.storage_generation === row.storage_generation
    ? {
        revision: runtime.data.generation,
        route_revision: row.route_revision,
        instance: runtime.data.instance,
      }
    : undefined;
}

export class DatabaseActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    isolateActors++;
  }
  /** When this instance was constructed (not the isolate: workerd answers Date.now() with 0 in the global scope). */
  private readonly constructedAt = Date.now();
  private hasSchema: boolean | undefined;
  /**
   * The tables of the admission path this instance knows to exist. A read never creates one: SQLite
   * counts CREATE TABLE IF NOT EXISTS as a write even when the table is there, and the Actor's
   * answer then waits for a commit. Only the write that needs the table creates it.
   */
  private tables = new Set<string>();
  private waiters = new Map<
    string,
    { deadline: number; resolve: (ready: boolean) => void; owner: object }
  >();
  private polling = false;
  private pushed = false;
  private wake: { operation: string; revision: number } | undefined;
  /** When the waiters of the current wake began to wait; only for the actor_release measurement. */
  private waitStartedAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private interruptPoll: (() => void) | undefined;
  /** The admission mutation of the ticket claim in flight: its barrier does not refuse admitWake. */
  private ticketMutation: string | undefined;
  /** The ticket claim in flight, by operation; claims run one at a time. */
  private claim: { operation: string; done: Promise<void> } | undefined;
  /**
   * Admission attempts in the current minute. They are counted in memory, so a connect makes no
   * durable write; eviction restarts the count, and the Edge rate limiters still bound the rate.
   */
  private admissions = { minute: 0, attempts: 0 };
  private admissionState() {
    const presence = this.presence();
    if (!presence) return undefined;
    const row = this.hasTable("database_snapshot")
      ? this.ctx.storage.sql
          .exec<{ snapshot: string | null; barrier: string | null }>(
            "SELECT snapshot,barrier FROM database_snapshot WHERE singleton=1",
          )
          .toArray()[0]
      : undefined;
    // The snapshot is a cache of what D1 holds. One written by an earlier release that this release
    // cannot read is no snapshot: the Actor falls back to D1 and the next publish replaces it.
    const stored = row?.snapshot
      ? DatabaseAdmissionSnapshot.safeParse(JSON.parse(row.snapshot))
      : undefined;
    return {
      presence,
      snapshot: stored?.success ? stored.data : undefined,
      barrier: row?.barrier
        ? PersistedAdmissionMutationIntent.parse(JSON.parse(row.barrier))
        : undefined,
    };
  }
  private saveAdmissionState(
    snapshot: DatabaseAdmissionSnapshot | undefined,
    barrier: PersistedAdmissionMutationIntent | undefined,
  ) {
    this.createTable(
      "database_snapshot",
      "CREATE TABLE IF NOT EXISTS database_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1),snapshot TEXT,barrier TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO database_snapshot(singleton,snapshot,barrier) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET snapshot=excluded.snapshot,barrier=excluded.barrier",
      snapshot ? JSON.stringify(snapshot) : null,
      barrier ? JSON.stringify(barrier) : null,
    );
  }
  /**
   * The Actor's concurrency block, named. Every other event of the database waits while a callback
   * runs, so one held for a second is logged with its name: a stalled RPC of a wake then names its
   * holder. (The RPC that waited is measured by its caller, as the publish steps are.)
   */
  private gate<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const started = Date.now();
      try {
        return await callback();
      } finally {
        const ms = Date.now() - started;
        if (ms >= GATE_LOG_MS)
          console.warn(
            JSON.stringify({
              event: "actor_gate_held",
              callback: name,
              ms,
              at_ms: Date.now(),
            }),
          );
      }
    });
  }
  /** Trusted mutation RPC. The closed barrier is durable before the caller can touch desired state. */
  async beginAdmissionMutation(value: unknown): Promise<boolean> {
    const intent = AdmissionMutationIntent.parse(value);
    this.identity(intent.database_id);
    return this.gate("beginAdmissionMutation", () =>
      this.beginAdmissionMutationLocked(intent),
    );
  }
  private async beginAdmissionMutationLocked(
    intent: AdmissionMutationIntent,
  ): Promise<boolean> {
    const state = this.admissionState();
    if (!state) return false;
    if (state.barrier?.mutation_id === intent.mutation_id) return true;
    if (
      state.barrier &&
      intent.admission_revision <= state.barrier.admission_revision
    )
      return false;
    if (
      state.snapshot &&
      intent.admission_revision < state.snapshot.admission_revision
    )
      return false;
    this.saveAdmissionState(state.snapshot, {
      ...intent,
      started_at: Date.now(),
    });
    return true;
  }
  /** Repairs interruption before a D1 reservation existed; a positive CAS fences late reservations too. */
  async repairAdmissionMutation(): Promise<boolean> {
    return this.gate("repairAdmissionMutation", async () => {
      const barrier = this.admissionState()?.barrier;
      if (!barrier || barrier.started_at > Date.now() - 60000) return false;
      try {
        const result = await this.env.DB.prepare(
          `UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1,completed_mutation_id=?,mutation_outcome='fenced'
          WHERE database_id=? AND admission_revision=? AND route_revision=? AND mutation_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.mutation_id=?)`,
        )
          .bind(
            barrier.mutation_id,
            barrier.database_id,
            barrier.admission_revision,
            barrier.route_revision,
            barrier.mutation_id,
          )
          .run();
        return result.meta.changes === 1;
      } catch {
        return false;
      }
    });
  }
  /** Only the trusted full publisher may release a matching committed/fenced mutation. */
  async publishAdmissionSnapshot(
    value: unknown,
    completedMutation: string | null = null,
  ): Promise<boolean> {
    const snapshot = DatabaseAdmissionSnapshot.parse(value);
    this.identity(snapshot.database_id);
    return this.gate("publishAdmissionSnapshot", () =>
      this.publishAdmissionSnapshotLocked(snapshot, completedMutation),
    );
  }
  private async publishAdmissionSnapshotLocked(
    snapshot: DatabaseAdmissionSnapshot,
    completedMutation: string | null,
  ): Promise<boolean> {
    if (!this.presence()) return false;
    const state = this.admissionState()!;
    if (
      state.snapshot &&
      snapshot.admission_revision < state.snapshot.admission_revision
    )
      return false;
    if (state.snapshot?.deleted && !snapshot.deleted) return false;
    const epoch = await this.env.DB.prepare(
      "SELECT admission_revision,route_revision,mutation_id,completed_mutation_id FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(snapshot.database_id)
      .first<{
        admission_revision: number;
        route_revision: number;
        mutation_id: string | null;
        completed_mutation_id: string | null;
      }>();
    if (
      !epoch ||
      epoch.mutation_id !== null ||
      epoch.admission_revision !== snapshot.admission_revision ||
      epoch.route_revision !== snapshot.route_revision
    )
      return false;
    if (
      state.barrier &&
      (completedMutation !== state.barrier.mutation_id ||
        epoch.completed_mutation_id !== completedMutation ||
        snapshot.admission_revision <= state.barrier.admission_revision)
    )
      return false;
    if (
      state.snapshot?.runtime &&
      snapshot.runtime &&
      snapshot.admission_revision === state.snapshot.admission_revision &&
      snapshot.runtime.observed_at < state.snapshot.runtime.observed_at
    )
      return false;
    this.saveAdmissionState(snapshot, undefined);
    if (
      this.waiters.size &&
      snapshot.admissible &&
      this.wake?.revision === snapshot.generation
    ) {
      // The snapshot was read from the committed state after readiness and no barrier stands now:
      // it is the condition the readiness loop applies, so it releases the waiters itself without
      // another read.
      if (snapshot.runtime) {
        console.log(
          JSON.stringify({
            event: "actor_release",
            database_id: snapshot.database_id,
            operation: this.wake.operation,
            revision: this.wake.revision,
            at_ms: Date.now(),
            waited_ms: Date.now() - this.waitStartedAt,
            via: "publish",
          }),
        );
        this.finishWaiters(true);
      } else {
        this.pushed = true;
        this.interruptPoll?.();
      }
    }
    return true;
  }
  private localAdmissionActor(databaseId: string) {
    return {
      database_id: databaseId,
      begin: (intent: AdmissionMutationIntent) =>
        this.beginAdmissionMutationLocked(intent),
      publish: async (completedMutation: string) => {
        const { readDatabaseAdmissionSnapshot } = await d1();
        const state = await readDatabaseAdmissionSnapshot(this.env, databaseId);
        return state
          ? this.publishAdmissionSnapshotLocked(
              state.snapshot,
              completedMutation,
            )
          : false;
      },
    };
  }
  private snapshotAdmission(
    user: string,
    state = this.admissionState(),
  ): DatabaseAdmission | undefined {
    if (state?.barrier) return { ok: false, sqlstate: "57P03" };
    const snapshot = state?.snapshot;
    if (!snapshot) return undefined;
    if (snapshot.deleted) return { ok: false, sqlstate: "3D000" };
    // A credential PostgreSQL would refuse never admits, whatever else the snapshot says.
    const now = Date.now();
    if (
      !snapshot.roles.some(
        (role) =>
          role.name === user &&
          (role.valid_until === null ||
            roleExpiryInstant(role.valid_until) > now),
      )
    )
      return { ok: false, sqlstate: "28P01" };
    const runtime = snapshot.runtime;
    if (!snapshot.admissible || !runtime)
      return { ok: false, sqlstate: "57P03" };
    return {
      ok: true,
      region: snapshot.region,
      node: runtime.node_id,
      target: {
        revision: snapshot.generation,
        route_revision: snapshot.route_revision,
        instance: runtime.instance,
      },
    };
  }
  /** Whether the table exists, read once per instance with a statement SQLite counts as a read. */
  private hasTable(name: string): boolean {
    if (this.tables.has(name)) return true;
    const found =
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?",
          name,
        )
        .toArray()[0]!.count === 1;
    if (found) this.tables.add(name);
    return found;
  }
  /** Creates the table on a write path, once per instance. */
  private createTable(name: string, statement: string): void {
    if (this.tables.has(name)) return;
    this.ctx.storage.sql.exec(statement);
    this.tables.add(name);
  }
  private initializeSchema(): void {
    if (this.hasSchema) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_presence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),database_id TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,roles TEXT NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_wake(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation TEXT NOT NULL,revision INTEGER NOT NULL,hint_claimed INTEGER NOT NULL CHECK(hint_claimed IN(0,1)))",
    );
    this.hasSchema = true;
  }
  private identity(id: string): void {
    if (!this.env.DATABASE_ACTOR.idFromName(id).equals(this.ctx.id))
      throw new Error("actor_identity_mismatch");
  }
  private presence(): DatabasePresence | undefined {
    this.hasSchema ??=
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name IN('database_presence','database_wake')",
        )
        .toArray()[0]!.count === 2;
    if (!this.hasSchema) return undefined;
    const row = this.ctx.storage.sql
      .exec<{
        database_id: string;
        revision: number;
        updated_at: string;
        roles: string;
        deleted: number;
      }>(
        "SELECT database_id,revision,updated_at,roles,deleted FROM database_presence WHERE singleton=1",
      )
      .toArray()[0];
    if (!row) return undefined;
    const snapshot = DatabasePresence.parse({
      ...row,
      roles: JSON.parse(row.roles),
      deleted: Boolean(row.deleted),
    });
    this.identity(snapshot.database_id);
    return snapshot;
  }
  /** Management RPC only: incoming hints never invoke seeding or authoritative repair. */
  async seed(value: unknown): Promise<void> {
    const parsed = DatabasePresence.safeParse(value);
    if (!parsed.success) throw new Error("invalid_actor_snapshot");
    this.identity(parsed.data.database_id);
    await this.gate("seedPresence", async () => {
      this.initializeSchema();
      let next = parsed.data;
      const previous = this.presence();
      if (previous?.deleted) return;
      if (next.deleted && previous)
        next = {
          ...next,
          revision: Math.max(next.revision, previous.revision),
          updated_at:
            next.updated_at > previous.updated_at
              ? next.updated_at
              : previous.updated_at,
        };
      else if (previous) {
        if (
          next.revision < previous.revision ||
          (next.revision === previous.revision &&
            next.updated_at < previous.updated_at)
        )
          return;
        if (
          next.revision === previous.revision &&
          next.updated_at === previous.updated_at
        ) {
          if (JSON.stringify(next.roles) === JSON.stringify(previous.roles))
            return;
          // Equal clocks cannot order conflicting role sets; only a fresh trusted D1 read can repair them.
          const { readDatabasePresence } = await d1();
          const current = await readDatabasePresence(
            this.env.DB,
            next.database_id,
          );
          if (!current) throw new Error("database_actor_sync_unavailable");
          if (
            current.revision < previous.revision ||
            (current.revision === previous.revision &&
              current.updated_at < previous.updated_at)
          )
            return;
          next = current;
        }
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO database_presence(singleton,database_id,revision,updated_at,roles,deleted) VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,roles=excluded.roles,deleted=excluded.deleted",
        next.database_id,
        next.revision,
        next.updated_at,
        // A role without an expiry stays the bare name the previous Worker reads, so a rollback
        // leaves every database that does not use expiries with a presence it still parses.
        JSON.stringify(
          next.roles.map((role) =>
            role.valid_until === null ? role.name : role,
          ),
        ),
        Number(next.deleted),
      );
    });
  }
  async admit(databaseId: unknown, user: unknown): Promise<DatabaseAdmission> {
    const id = DatabaseId.safeParse(databaseId);
    if (!id.success) return { ok: false, sqlstate: "3D000" };
    const role = RoleName.safeParse(user);
    if (!role.success) return { ok: false, sqlstate: "28P01" };
    this.identity(id.data);
    try {
      const snapshot = this.presence();
      if (!snapshot || snapshot.deleted)
        return { ok: false, sqlstate: "3D000" };
      if (!roleAdmitted(snapshot, role.data))
        return { ok: false, sqlstate: "28P01" };
      const cached = this.snapshotAdmission(role.data);
      if (cached) return cached;
      const row = await this.env.DB.prepare(DATABASE_ADMISSION_QUERY)
        .bind(role.data, id.data)
        .first<AdmissionRow>();
      if (
        !row ||
        row.database_deleted_at !== null ||
        row.project_deleted_at !== null ||
        row.desired_state === "deleted"
      )
        return { ok: false, sqlstate: "3D000" };
      if (row.role_name !== role.data) return { ok: false, sqlstate: "28P01" };
      if (
        row.node_id === null ||
        row.admission_blocked !== 0 ||
        row.lost_at !== null ||
        row.desired_state !== "running" ||
        row.observed_state !== "ready" ||
        row.observed_power !== "awake" ||
        !this.readyRevision(row)
      )
        return { ok: false, sqlstate: "57P03" };
      return admittedRoute(row, id.data);
    } catch {
      return { ok: false, sqlstate: "08006" };
    }
  }
  /**
   * The Edge's admission (pool design 2026-10-16). It reads only this Actor's own state: an
   * admissible snapshot answers its verified target, and an idle sleeper answers a wake ticket
   * whose D1 claim runs after the answer, in the background. A snapshot that cannot say whether
   * the database is wakeable, or one that is neither admissible nor wakeable, takes ensureAwake,
   * today's authoritative path.
   */
  async admitWake(
    databaseId: unknown,
    user: unknown,
    options?: { deadline?: number; waiterId?: string },
  ): Promise<DatabaseWakeAdmission> {
    const started = Date.now();
    const trace: AdmissionTrace = { path: "refused", reused: null };
    const result = await this.#admitWake(databaseId, user, options, trace);
    if (!result.ok) this.refused("admit_wake", databaseId, result.sqlstate);
    // The waiter is the Edge's connection id, so this line joins its conn_admission.
    console.log(
      JSON.stringify({
        event: "actor_admit",
        database_id: typeof databaseId === "string" ? databaseId : null,
        waiter_id: options?.waiterId ?? null,
        path: trace.path,
        reused: trace.reused,
        // Time in this handler, excluding delivery/queueing before entry and transport afterwards.
        // Compare with the Edge's admit_ms using waiter_id/cid; this alone is not the RPC duration.
        // Cloudflare's clock advances after I/O: 0 does not prove that no CPU time was spent.
        handler_ms: Date.now() - started,
        // 0 when this very call built the instance; a node report or another call may have built it.
        instance_age_ms: Date.now() - this.constructedAt,
        isolate_actors: isolateActors,
        at_ms: Date.now(),
      }),
    );
    return result;
  }
  /** One log line per refused admission with what the actor knew, so a refusal says why. */
  private refused(path: string, databaseId: unknown, sqlstate: string) {
    let state: Record<string, unknown> = {};
    try {
      // An actor that holds nothing yet stays without tables.
      const read = this.presence() ? this.admissionState() : undefined,
        snapshot = read?.snapshot;
      if (read)
        state = {
          generation: snapshot?.generation ?? null,
          deleted: snapshot?.deleted ?? null,
          admissible: snapshot?.admissible ?? null,
          wakeable: snapshot?.wakeable ?? null,
          barrier: read.barrier !== undefined,
          ticket: this.storedTicket()?.state ?? null,
          wake: this.wake?.operation ?? null,
          waiters: this.waiters.size,
        };
    } catch {
      // The refusal is logged without the state it could not read.
    }
    console.log(
      JSON.stringify({
        event: "admission_refused",
        path,
        database_id: typeof databaseId === "string" ? databaseId : null,
        sqlstate,
        ...state,
        at_ms: Date.now(),
      }),
    );
  }
  async #admitWake(
    databaseId: unknown,
    user: unknown,
    options: { deadline?: number; waiterId?: string } | undefined,
    trace: AdmissionTrace,
  ): Promise<DatabaseWakeAdmission> {
    const id = DatabaseId.safeParse(databaseId),
      role = RoleName.safeParse(user);
    if (!id.success) return { ok: false, sqlstate: "3D000" };
    if (!role.success) return { ok: false, sqlstate: "28P01" };
    this.identity(id.data);
    try {
      const read = this.admissionState();
      const snapshot = read?.snapshot;
      if (snapshot?.wakeable === undefined) {
        trace.path = "ensure_awake";
        return await this.ensureAwake(id.data, role.data, options);
      }
      const failure = this.earlyAdmission(
        id.data,
        role.data,
        read!.presence,
        snapshot?.replacement_active ?? false,
      );
      if (failure) return failure;
      const state = read!;
      if (state.barrier) {
        if (state.barrier.mutation_id !== this.ticketMutation)
          return { ok: false, sqlstate: "57P03" };
      } else {
        const admitted = this.snapshotAdmission(role.data, state);
        if (admitted?.ok) {
          trace.path = "snapshot";
          return admitted;
        }
      }
      const current = state.snapshot!;
      if (current.deleted) return { ok: false, sqlstate: "3D000" };
      if (!current.roles.some((value) => value.name === role.data))
        return { ok: false, sqlstate: "28P01" };
      let ticket = this.storedTicket();
      const reused =
        ticket !== undefined &&
        ticket.state !== "refused" &&
        ((ticket.generation === current.generation + 1 &&
          current.wakeable === true) ||
          (ticket.generation === current.generation && !current.admissible));
      if (!reused) {
        // Not an idle sleeper and not admissible yet: resuming, being created, restarting at a
        // generation the controller has not reported, or suspended by hand. ensureAwake waits
        // for a start in progress and refuses the rest, as before the pool.
        if (!current.wakeable) {
          trace.path = "ensure_awake";
          return await this.ensureAwake(id.data, role.data, options);
        }
        ticket = {
          operation: newOperationId(),
          generation: current.generation + 1,
          route_revision: current.route_revision,
          role_revision_hash: await roleRevisionHash(current.roles),
          state: "pending",
          issued_at: Date.now(),
        };
        this.saveTicket(ticket);
        if (current.node !== null)
          this.observePendingSync(id.data, options?.waiterId, ticket);
      }
      trace.path = "ticket";
      trace.reused = reused;
      if (ticket!.state === "pending")
        this.startClaim(id.data, role.data, ticket!);
      console.log(
        JSON.stringify({
          event: "actor_ticket",
          database_id: id.data,
          operation: ticket!.operation,
          generation: ticket!.generation,
          reused,
          at_ms: Date.now(),
        }),
      );
      if (current.node === null) return { ok: false, sqlstate: "57P03" };
      return {
        ok: true,
        region: current.region,
        node: current.node,
        wake: {
          operation: ticket!.operation,
          generation: ticket!.generation,
          route_revision: ticket!.route_revision,
          role_revision_hash: ticket!.role_revision_hash,
        },
      };
    } catch {
      trace.path = "refused";
      return { ok: false, sqlstate: "08006" };
    }
  }
  private storedTicket(): WakeTicket | undefined {
    if (!this.hasTable("database_ticket")) return undefined;
    return this.ctx.storage.sql
      .exec<{
        operation: string;
        generation: number;
        route_revision: number;
        role_revision_hash: string;
        state: WakeTicket["state"];
        issued_at: number;
      }>(
        "SELECT operation,generation,route_revision,role_revision_hash,state,issued_at FROM database_ticket WHERE singleton=1",
      )
      .toArray()[0];
  }
  private saveTicket(ticket: WakeTicket): void {
    this.createTable(
      "database_ticket",
      "CREATE TABLE IF NOT EXISTS database_ticket(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation TEXT NOT NULL,generation INTEGER NOT NULL,route_revision INTEGER NOT NULL,role_revision_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','claimed','refused')),issued_at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO database_ticket(singleton,operation,generation,route_revision,role_revision_hash,state,issued_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET operation=excluded.operation,generation=excluded.generation,route_revision=excluded.route_revision,role_revision_hash=excluded.role_revision_hash,state=excluded.state,issued_at=excluded.issued_at",
      ticket.operation,
      ticket.generation,
      ticket.route_revision,
      ticket.role_revision_hash,
      ticket.state,
      ticket.issued_at,
    );
  }
  /**
   * Observe all writes pending now, before the claim's microtask starts. This completion interval
   * includes JavaScript scheduling, not just disk time; later claim writes may still gate the
   * reply. The observer never holds admission, and the automatic output gate remains unchanged.
   */
  private observePendingSync(
    databaseId: string,
    waiterId: string | undefined,
    ticket: WakeTicket,
  ): void {
    const started = Date.now();
    const waiter = z.uuid().safeParse(waiterId);
    const report = (outcome: "synced" | "failed") => {
      const at = Date.now();
      console.log(
        JSON.stringify({
          event: "actor_admit_pending_sync",
          database_id: databaseId,
          waiter_id: waiter.success ? waiter.data : null,
          operation: ticket.operation,
          generation: ticket.generation,
          started_at_ms: started,
          sync_ms: Math.max(0, at - started),
          outcome,
          at_ms: at,
        }),
      );
    };
    try {
      this.ctx.waitUntil(
        this.ctx.storage.sync().then(
          () => report("synced"),
          () => report("failed"),
        ),
      );
    } catch {
      report("failed");
    }
  }
  /** Starts the ticket's claim unless it is already in flight; claims run one after another. */
  private startClaim(id: string, user: string, ticket: WakeTicket): void {
    if (this.claim?.operation === ticket.operation) return;
    const previous = this.claim?.done ?? Promise.resolve();
    const done: Promise<void> = previous
      .then(() => this.claimTicket(id, user, ticket))
      .catch(() => undefined)
      .finally(() => {
        if (this.claim?.done === done) this.claim = undefined;
      });
    this.claim = { operation: ticket.operation, done };
    this.ctx.waitUntil(done);
  }
  /**
   * The D1 claim of a ticket, after its answer: the wake transition at the ticket's generation
   * with the ticket's operation, then the region hint. It never waits for a guard: a ticket D1
   * refuses is refused, and the region is told at once so the controller refutes it.
   */
  private async claimTicket(
    id: string,
    user: string,
    ticket: WakeTicket,
  ): Promise<void> {
    const started = Date.now();
    let outcome: "claimed" | "already" | "refused" | "lost" | "failed" =
      "failed";
    try {
      const { powerTransitionStatements, withAdmissionMutation } = await d1();
      for (let attempt = 0; ; attempt++) {
        const read = await this.env.DB.prepare(
          `SELECT d.*,EXISTS(SELECT 1 FROM operations o WHERE o.id=d.power_operation AND o.database_id=d.id AND o.project_id=d.project_id
            AND o.generation<=d.generation AND o.kind='database.hibernate') sleeping_intent FROM databases d WHERE d.id=?`,
        )
          .bind(id)
          .first<DatabaseRow & { sleeping_intent: number }>();
        if (!read) {
          outcome = "refused";
          break;
        }
        const { sleeping_intent, ...row } = read;
        if (
          row.generation + 1 !== ticket.generation ||
          row.desired_state !== "suspended" ||
          row.suspension_reason !== "idle" ||
          !row.power_operation ||
          sleeping_intent !== 1
        ) {
          outcome =
            row.generation === ticket.generation &&
            row.power_operation === ticket.operation
              ? "already"
              : "refused";
          break;
        }
        const now = new Date().toISOString();
        const result = await withAdmissionMutation(
          this.env,
          [id],
          async (mutation) => {
            const transition = await mutation.batch(
              powerTransitionStatements(
                this.env.DB,
                row,
                "wake",
                ticket.operation,
                now,
                user,
                mutation.guard(id),
              ),
            );
            // Committed at the ticket's generation: the region may pull it now, ahead of the
            // snapshot publish that closes this mutation.
            if (transition[0]!.meta.changes === 1)
              await this.hintWake(
                id,
                ticket.operation,
                ticket.generation,
                started,
                ticket.issued_at,
              );
            return transition;
          },
          undefined,
          this.ticketAdmissionActor(id),
        );
        if (result[0]!.meta.changes === 1) {
          outcome = "claimed";
          break;
        }
        // Compare-and-set on the row read above: a periodic report that landed since lost it.
        if (attempt >= WAKE_CLAIM_RETRIES) {
          outcome = "lost";
          break;
        }
      }
    } catch {
      // A D1 failure says nothing about the ticket: it stays pending, and the next connect of
      // this wake claims it again.
      outcome = "failed";
    } finally {
      this.ticketMutation = undefined;
    }
    const stored = this.storedTicket();
    if (stored?.operation === ticket.operation && outcome !== "failed")
      this.saveTicket({
        ...stored,
        state:
          outcome === "claimed" || outcome === "already"
            ? "claimed"
            : "refused",
      });
    if (outcome === "refused" || outcome === "lost")
      await this.refuteTicket(id);
    console.log(
      JSON.stringify({
        event: "actor_ticket_claim",
        database_id: id,
        operation: ticket.operation,
        generation: ticket.generation,
        outcome,
        claim_ms: Date.now() - started,
        at_ms: Date.now(),
      }),
    );
  }
  /** Tells the node a ticket was refused, so it pulls the page that refutes it. */
  private async refuteTicket(id: string): Promise<void> {
    await d1()
      .then(({ hintDatabases }) => hintDatabases(this.env, [id]))
      .catch(() => 0);
  }
  /** The local admission actor of a ticket claim: its barrier is the Actor's own ticket mutation. */
  private ticketAdmissionActor(databaseId: string): LocalAdmissionActor {
    return {
      database_id: databaseId,
      begin: (intent) =>
        this.gate("ticketBegin", async () => {
          this.ticketMutation = intent.mutation_id;
          return this.beginAdmissionMutationLocked(intent);
        }),
      publish: async (completedMutation) => {
        const { readDatabaseAdmissionSnapshot } = await d1();
        const state = await readDatabaseAdmissionSnapshot(this.env, databaseId);
        return state
          ? this.gate("ticketPublish", () =>
              this.publishAdmissionSnapshotLocked(
                state.snapshot,
                completedMutation,
              ),
            )
          : false;
      },
    };
  }
  private readyRevision(row: AdmissionRow): boolean {
    // A role change advances the generation too: the node applies it and reports the new one.
    return row.observed_generation === row.generation;
  }
  private async known(
    id: string,
    user: string,
  ): Promise<AdmissionRow | DatabaseAdmission> {
    const snapshot = this.presence();
    if (!snapshot || snapshot.deleted) return { ok: false, sqlstate: "3D000" };
    if (!roleAdmitted(snapshot, user)) return { ok: false, sqlstate: "28P01" };
    const cached = this.snapshotAdmission(user);
    // Expired/nonready proof may use authoritative cold preparation; a closed barrier never can.
    if (
      cached &&
      (cached.ok ||
        cached.sqlstate !== "57P03" ||
        this.admissionState()?.barrier)
    )
      return cached;
    const row = await this.env.DB.prepare(DATABASE_ADMISSION_QUERY)
      .bind(user, id)
      .first<AdmissionRow>();
    if (
      !row ||
      row.database_deleted_at !== null ||
      row.project_deleted_at !== null ||
      row.desired_state === "deleted"
    )
      return { ok: false, sqlstate: "3D000" };
    if (row.role_name !== user) return { ok: false, sqlstate: "28P01" };
    if (
      row.node_id === null ||
      row.lost_at !== null ||
      row.admission_blocked !== 0
    )
      return { ok: false, sqlstate: "57P03" };
    return row;
  }
  private earlyAdmission(
    databaseId: unknown,
    user: unknown,
    presence?: DatabasePresence,
    replacementActive?: boolean,
  ): DatabaseAdmission | undefined {
    const id = DatabaseId.safeParse(databaseId),
      role = RoleName.safeParse(user);
    if (!id.success) return { ok: false, sqlstate: "3D000" };
    if (!role.success) return { ok: false, sqlstate: "28P01" };
    this.identity(id.data);
    const snapshot = presence ?? this.presence();
    if (!snapshot || snapshot.deleted) return { ok: false, sqlstate: "3D000" };
    if (!roleAdmitted(snapshot, role.data))
      return { ok: false, sqlstate: "28P01" };
    if (
      replacementActive ??
      this.admissionState()?.snapshot?.replacement_active
    )
      return { ok: false, sqlstate: "57P03" };
    const configured = this.env.DATABASE_CONNECTION_LIMIT_PER_MINUTE ?? "12000";
    if (!/^[1-9][0-9]{0,4}$/.test(configured) || Number(configured) > 12000)
      return { ok: false, sqlstate: "53300" };
    // Only a trusted seeded role is counted; a refused attempt does not count.
    const minute = Math.floor(Date.now() / 60_000);
    if (this.admissions.minute !== minute)
      this.admissions = { minute, attempts: 0 };
    if (this.admissions.attempts >= Number(configured))
      return { ok: false, sqlstate: "53300" };
    this.admissions.attempts++;
    return undefined;
  }
  /**
   * The durable claim of one wake and its single hint to the region. Claim before notifying: a lost
   * response never replays a hint; periodic desired pulls recover its loss. False when a newer wake
   * is already stored.
   */
  private async hintWake(
    id: string,
    operation: string,
    revision: number,
    started: number,
    requested: number,
  ): Promise<boolean> {
    const stored = this.ctx.storage.sql
      .exec<{ operation: string; revision: number; hint_claimed: number }>(
        "SELECT operation,revision,hint_claimed FROM database_wake WHERE singleton=1",
      )
      .toArray()[0];
    if (stored && stored.revision > revision) return false;
    if (
      !stored ||
      stored.operation !== operation ||
      stored.revision !== revision
    )
      this.ctx.storage.sql.exec(
        "INSERT INTO database_wake(singleton,operation,revision,hint_claimed) VALUES(1,?,?,0) ON CONFLICT(singleton) DO UPDATE SET operation=excluded.operation,revision=excluded.revision,hint_claimed=0",
        operation,
        revision,
      );
    const current = this.ctx.storage.sql
      .exec<{ hint_claimed: number }>(
        "SELECT hint_claimed FROM database_wake WHERE singleton=1",
      )
      .toArray()[0]!;
    if (!current.hint_claimed) {
      this.ctx.storage.sql.exec(
        "UPDATE database_wake SET hint_claimed=1 WHERE singleton=1",
      );
      // Already claimed, so nothing replays it: the claim does not wait for its delivery. The node
      // pulls the page that holds the claimed generation.
      const hinted = Date.now();
      this.ctx.waitUntil(
        d1()
          .then(({ hintDatabases }) => hintDatabases(this.env, [id]))
          .catch(() => 0)
          .then(() =>
            // The wake split's first stage on this side: the claim itself and the node hint.
            console.log(
              JSON.stringify({
                event: "actor_claim",
                database_id: id,
                operation,
                revision,
                at_ms: Date.now(),
                // The wake was asked for at requested_at_ms; the claim began gate_ms later.
                requested_at_ms: requested,
                gate_ms: started - requested,
                claim_ms: hinted - started,
                hint_ms: Date.now() - hinted,
              }),
            ),
          ),
      );
    }
    return true;
  }
  private async claimWake(
    id: string,
    user: string,
    requested: number,
    deadline: number,
  ): Promise<
    { operation: string; revision: number } | { failure: "08006" } | undefined
  > {
    return this.gate("claimWake", async () => {
      const started = Date.now();
      try {
        // The row a lost commit was made from: a read that finds it unchanged says the commit was
        // refused for another reason, and the same commit would be refused again: the connect is
        // answered 57P03 at once and the client retries.
        let lost: string | undefined;
        for (let attempt = 0; ; attempt++) {
          // Every read here holds every other event of this database: independent reads go together.
          const [authorized, row] = await Promise.all([
            this.known(id, user),
            this.env.DB.prepare("SELECT * FROM databases WHERE id=?")
              .bind(id)
              .first<DatabaseRow>(),
          ]);
          if ("ok" in authorized) return undefined;
          if (!row) return undefined;
          if (lost !== undefined && JSON.stringify(row) === lost)
            return undefined;
          if (
            row.desired_state === "suspended" &&
            row.suspension_reason === "idle" &&
            row.power_operation
          ) {
            const sleepingIntent = await this.env.DB.prepare(
              "SELECT id FROM operations WHERE id=? AND database_id=? AND project_id=? AND generation<=? AND kind='database.hibernate'",
            )
              .bind(row.power_operation, id, row.project_id, row.generation)
              .first();
            if (!sleepingIntent) return undefined;
            const { powerTransitionStatements, withAdmissionMutation } =
              await d1();
            const operation = newOperationId(),
              now = new Date().toISOString(),
              previous = row,
              revision = previous.generation + 1;
            let hinted: boolean | undefined;
            const result = await withAdmissionMutation(
              this.env,
              [id],
              async (mutation) => {
                const transition = await mutation.batch(
                  powerTransitionStatements(
                    this.env.DB,
                    previous,
                    "wake",
                    operation,
                    now,
                    user,
                    mutation.guard(id),
                  ),
                );
                // The transition is committed with its operation, at the next generation: the region
                // may pull it now, ahead of the snapshot publish that closes this mutation.
                if (transition[0]!.meta.changes === 1)
                  hinted = await this.hintWake(
                    id,
                    operation,
                    revision,
                    started,
                    requested,
                  );
                return transition;
              },
              undefined,
              this.localAdmissionActor(id),
            );
            if (result[0]!.meta.changes !== 1) {
              // The commit is compare-and-set on the version of the row read above, and the
              // controller's periodic report of a sleeper rewrites that version: one that landed
              // since lost this claim, so the row is read and claimed again, within the caller's time.
              const retrying =
                attempt < WAKE_CLAIM_RETRIES && Date.now() < deadline;
              console.log(
                JSON.stringify({
                  event: "actor_claim_lost",
                  database_id: id,
                  revision,
                  attempt,
                  retrying,
                  at_ms: Date.now(),
                }),
              );
              if (!retrying) return undefined;
              lost = JSON.stringify(previous);
              continue;
            }
            return hinted ? { operation, revision } : undefined;
          }
          if (row.desired_state !== "running" || !row.power_operation)
            return undefined;
          const operation = await this.env.DB.prepare(
            "SELECT id FROM operations WHERE id=? AND database_id=? AND project_id=? AND generation=? AND kind IN('database.wake','database.resume') AND status IN('pending','running','succeeded')",
          )
            .bind(row.power_operation, id, row.project_id, row.generation)
            .first<{ id: string }>();
          if (!operation) return undefined;
          if (
            !(await this.hintWake(
              id,
              operation.id,
              row.generation,
              started,
              requested,
            ))
          )
            return undefined;
          return { operation: operation.id, revision: row.generation };
        }
      } catch {
        return { failure: "08006" as const };
      }
    });
  }
  /** Known routes only. One shared observation loop for a running wake, never application SQL. */
  async ensureAwake(
    databaseId: unknown,
    user: unknown,
    options?: { deadline?: number; waiterId?: string },
  ): Promise<DatabaseAdmission> {
    const result = await this.#ensureAwake(databaseId, user, options);
    if (!result.ok) this.refused("ensure_awake", databaseId, result.sqlstate);
    return result;
  }
  async #ensureAwake(
    databaseId: unknown,
    user: unknown,
    options?: { deadline?: number; waiterId?: string },
  ): Promise<DatabaseAdmission> {
    const parsed = z
      .strictObject({
        deadline: z.number().int().optional(),
        waiterId: z.uuid().optional(),
      })
      .safeParse(options ?? {});
    if (!parsed.success) return { ok: false, sqlstate: "57P03" };
    const deadline = Math.min(
      parsed.data.deadline ?? Date.now() + ADMISSION_DEADLINE_MS,
      Date.now() + ADMISSION_DEADLINE_MS,
    );
    if (deadline <= Date.now()) return { ok: false, sqlstate: "57P03" };
    try {
      const failure = this.earlyAdmission(databaseId, user);
      if (failure) return failure;
    } catch {
      return { ok: false, sqlstate: "08006" };
    }
    const waiterId = parsed.data.waiterId ?? crypto.randomUUID();
    const owner = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.waitForAwake(databaseId, user, { deadline, waiterId }, owner),
        new Promise<DatabaseAdmission>((resolve) => {
          timer = setTimeout(
            () => resolve({ ok: false, sqlstate: "57P03" }),
            deadline - Date.now(),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      const waiter = this.waiters.get(waiterId);
      if (waiter?.owner === owner) {
        this.waiters.delete(waiterId);
        waiter.resolve(false);
        this.interruptPoll?.();
      }
    }
  }
  private startPolling(id: string): void {
    if (this.polling) return;
    this.polling = true;
    void this.poll(id).finally(() => {
      this.polling = false;
      if (this.waiters.size) this.startPolling(id);
    });
  }
  private async waitForAwake(
    databaseId: unknown,
    user: unknown,
    options: { deadline: number; waiterId: string },
    owner: object,
  ): Promise<DatabaseAdmission> {
    const id = DatabaseId.safeParse(databaseId),
      role = RoleName.safeParse(user);
    if (!id.success) return { ok: false, sqlstate: "3D000" };
    if (!role.success) return { ok: false, sqlstate: "28P01" };
    this.identity(id.data);
    const parsed = z
      .strictObject({
        deadline: z.number().int().optional(),
        waiterId: z.uuid().optional(),
      })
      .safeParse(options ?? {});
    if (!parsed.success) return { ok: false, sqlstate: "57P03" };
    const deadline = Math.min(
      parsed.data.deadline ?? Date.now() + ADMISSION_DEADLINE_MS,
      Date.now() + ADMISSION_DEADLINE_MS,
    );
    if (deadline <= Date.now()) return { ok: false, sqlstate: "57P03" };
    try {
      const current = await this.known(id.data, role.data);
      if ("ok" in current) return current;
      if (
        current.desired_state === "running" &&
        current.observed_state === "ready" &&
        current.observed_power === "awake" &&
        this.readyRevision(current)
      ) {
        // D1 holds the readiness; a snapshot that does not show it yet is the publish still on its
        // way, and the verified unit of the row routes meanwhile.
        const cached = this.snapshotAdmission(role.data);
        return cached?.ok ? cached : admittedRoute(current, id.data);
      }
      if (
        current.desired_state === "suspended" &&
        current.suspension_reason !== "idle"
      )
        return { ok: false, sqlstate: "57P03" };
      if (current.observed_state === "error")
        return { ok: false, sqlstate: "57P03" };
      const waiter = parsed.data.waiterId ?? crypto.randomUUID();
      const wake = await this.claimWake(
        id.data,
        role.data,
        Date.now(),
        deadline,
      );
      if (wake && "failure" in wake)
        return { ok: false, sqlstate: wake.failure };
      if (!wake && deadline > Date.now()) return this.admit(id.data, role.data);
      if (!wake || deadline <= Date.now() || this.waiters.size >= 32)
        return { ok: false, sqlstate: "57P03" };
      const replaced =
        this.wake !== undefined &&
        (this.wake.operation !== wake.operation ||
          this.wake.revision !== wake.revision);
      if (replaced) this.finishWaiters(false);
      if (this.wake === undefined || replaced) this.waitStartedAt = Date.now();
      this.wake = wake;
      if (this.waiters.has(waiter)) return { ok: false, sqlstate: "57P03" };
      const pending = new Promise<boolean>((resolve) =>
        this.waiters.set(waiter, { deadline, resolve, owner }),
      );
      if (!this.polling) this.startPolling(id.data);
      else this.interruptPoll?.();
      return (await pending)
        ? this.admit(id.data, role.data)
        : { ok: false, sqlstate: "57P03" };
    } catch {
      return { ok: false, sqlstate: "08006" };
    }
  }
  /**
   * Trusted API RPC after D1 committed a ready observation of that exact wake revision and
   * operation. It never releases waiters itself: the shared loop reads D1 at once, so a push
   * ahead of a visible commit keeps its waiters waiting.
   */
  async observedReady(
    databaseId: string,
    revision: number,
    operation: string | null,
  ): Promise<boolean> {
    this.identity(DatabaseId.parse(databaseId));
    if (
      !this.wake ||
      this.wake.revision !== revision ||
      this.wake.operation !== operation ||
      !this.waiters.size
    )
      return false;
    this.pushed = true;
    this.interruptPoll?.();
    return true;
  }
  private finishWaiters(ready: boolean): void {
    for (const waiter of this.waiters.values())
      waiter.resolve(ready && waiter.deadline > Date.now());
    this.waiters.clear();
    this.interruptPoll?.();
  }
  private async poll(id: string): Promise<void> {
    try {
      while (this.waiters.size > 0 && this.wake) {
        for (const [key, waiter] of this.waiters)
          if (waiter.deadline <= Date.now()) {
            this.waiters.delete(key);
            waiter.resolve(false);
          }
        if (!this.waiters.size) break;
        const viaPush = this.pushed;
        this.pushed = false;
        let row: AdmissionRow | null | undefined;
        try {
          row = await this.env.DB.prepare(
            `SELECT d.generation,d.power_operation,d.desired_state,d.observed_state,d.observed_generation,d.observed_power,p.deleted_at project_deleted_at FROM databases d JOIN projects p ON p.id=d.project_id WHERE d.id=?`,
          )
            .bind(id)
            .first<AdmissionRow>();
        } catch (error) {
          // A failed read says nothing about the wake. Every waiter keeps its own deadline, and the
          // next read comes with the next push or after the fallback interval.
          console.warn(
            JSON.stringify({
              event: "actor_poll_read_failed",
              database_id: id,
              error: error instanceof Error ? error.name : "error",
            }),
          );
        }
        if (row !== undefined) {
          if (
            !row ||
            row.project_deleted_at !== null ||
            row.generation !== this.wake.revision ||
            row.power_operation !== this.wake.operation ||
            row.desired_state !== "running" ||
            ["error", "deleting", "deleted"].includes(row.observed_state)
          ) {
            this.finishWaiters(false);
            break;
          }
          if (
            row.observed_state === "ready" &&
            row.observed_generation === this.wake.revision &&
            row.observed_power === "awake"
          ) {
            const state = this.admissionState(),
              snapshot = state?.snapshot;
            if (
              !state?.barrier &&
              snapshot?.admissible &&
              snapshot.generation === this.wake.revision &&
              snapshot.runtime
            ) {
              console.log(
                JSON.stringify({
                  event: "actor_release",
                  database_id: id,
                  operation: this.wake.operation,
                  revision: this.wake.revision,
                  at_ms: Date.now(),
                  waited_ms: Date.now() - this.waitStartedAt,
                  via: viaPush ? "push" : "poll",
                }),
              );
              this.finishWaiters(true);
              break;
            }
          }
        }
        // A push that arrived during this read asks for another one at once.
        if (this.pushed) continue;
        const delay = Math.max(
          1,
          Math.min(
            WAKE_FALLBACK_READ_MS,
            ...[...this.waiters.values()].map(
              (waiter) => waiter.deadline - Date.now(),
            ),
          ),
        );
        await new Promise<void>((resolve) => {
          const done = () => {
            if (this.pollTimer) clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
            this.interruptPoll = undefined;
            resolve();
          };
          this.interruptPoll = done;
          this.pollTimer = setTimeout(done, delay);
        });
      }
    } catch (error) {
      // Not a read failure (those keep waiting above): the loop's own state is unusable.
      console.error(
        JSON.stringify({
          event: "actor_poll_failed",
          database_id: id,
          error: error instanceof Error ? error.name : "error",
        }),
      );
      this.finishWaiters(false);
    }
  }
  async cancelWakeWaiter(
    databaseId: string,
    waiterId: string,
  ): Promise<boolean> {
    this.identity(DatabaseId.parse(databaseId));
    if (!z.uuid().safeParse(waiterId).success) return false;
    const waiter = this.waiters.get(waiterId);
    if (!waiter) return false;
    this.waiters.delete(waiterId);
    waiter.resolve(false);
    this.interruptPoll?.();
    return true;
  }
  /**
   * The wake ticket whose claim D1 has not committed yet. The node releases a wake before that
   * commit, so its first report may name this generation while D1 still names the previous one
   * (`observationVerdict`).
   */
  async pendingTicket(): Promise<{
    generation: number;
    operation: string;
  } | null> {
    const ticket = this.presence() ? this.storedTicket() : undefined;
    return ticket?.state === "pending"
      ? { generation: ticket.generation, operation: ticket.operation }
      : null;
  }
  /** Waits, for at most `milliseconds`, for the claim of a ticket in flight to finish. */
  async awaitTicketClaim(
    operation: string,
    milliseconds: number,
  ): Promise<void> {
    const claim = this.claim;
    if (claim?.operation !== operation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      claim.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  /**
   * The keep-warm visit of an ActorWarmer (`actor-warmer.ts`). The call alone keeps this object's
   * isolate loaded, which is what makes the next admission fast; so it reads and writes nothing:
   * no row, no D1 statement, no counter, no clock and no ticket, and it creates no table.
   */
  warm(): void {}
  override async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}
