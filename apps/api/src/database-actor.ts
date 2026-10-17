// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import {
  ADMISSION_DEADLINE_MS,
  DatabaseId,
  DatabaseRegionRoute as RegionRoute,
  type DatabaseAdmission,
  type DatabaseWakeAdmission,
  CnpgDatabaseTarget,
  RoleName,
  Timestamp,
  newOperationId,
  roleExpiryInstant,
} from "@pgcf/contracts";
import { z } from "zod";
import {
  ReclaimClaims,
  ReclaimObservation,
  RECLAIM_LIMITS,
  signReclaimIntent,
  DatabaseRuntimeAttestation,
  reclaimScopeFromRuntime,
} from "@pgcf/contracts/reclaim";
import { roleRevisionHash } from "@pgcf/contracts/route-token";
import { nodeProofSigningKey } from "./domain/node-proof-session.ts";
import {
  routeTokenV3Sql,
  admissionSnapshotSql,
} from "./domain/fleet-releases.ts";
import { warmReclaimCandidate } from "./domain/warm-reclaim.ts";
interface ReclaimState {
  revision: number;
  claims: ReclaimClaims | null;
  token: string | null;
  revoked: boolean;
  acknowledged_revision: number;
  reclaim_expires_at: number;
  last_admitted_at: number;
  configuration_fingerprint: string | null;
}

import type { Env } from "./env.ts";
import { powerTransitionStatements } from "./domain/lifecycle.ts";
import { wakeHintPage } from "./domain/desired.ts";
import type { DatabaseRow } from "./domain/rows.ts";
import { readDatabasePresence } from "./domain/database-actor-sync.ts";
import {
  AdmissionMutationIntent,
  DatabaseAdmissionSnapshot,
} from "./domain/admission-state.ts";
import {
  withAdmissionMutation,
  type LocalAdmissionActor,
} from "./domain/admission-mutations.ts";
import { readDatabaseAdmissionSnapshot } from "./domain/database-admission-snapshot.ts";
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
export type { DatabaseAdmission } from "@pgcf/contracts";
export const DATABASE_ADMISSION_QUERY = `SELECT d.desired_state,d.observed_state,d.generation,d.observed_generation,d.observed_power,d.suspension_reason,d.power_operation,d.deleted_at database_deleted_at,p.deleted_at project_deleted_at,
  d.runtime_attestation_json,CASE WHEN ${routeTokenV3Sql("g")} THEN 1 ELSE 0 END route_token_v3,
  CASE WHEN ${admissionSnapshotSql("g")} THEN 1 ELSE 0 END admission_snapshot_capable,r.name role_name,g.id,g.gateway_url,g.gateway_binding,n.id node_id,n.lost_at,
  CASE WHEN EXISTS(SELECT 1 FROM roles changed WHERE changed.database_id=d.id AND changed.owner=0 AND changed.deleted_at IS NULL
    AND changed.name<>r.name AND changed.updated_at=d.updated_at) THEN 1 ELSE 0 END unrelated_role_configuration,
  CASE WHEN NOT EXISTS(SELECT 1 FROM database_admission_epochs ae WHERE ae.database_id=d.id AND ae.mutation_id IS NOT NULL) THEN 0 ELSE 1 END admission_blocked
  FROM databases d JOIN projects p ON p.id=d.project_id JOIN regions g ON g.id=d.region_id
  LEFT JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id
  LEFT JOIN roles r ON r.database_id=d.id AND r.name=? AND r.deleted_at IS NULL
    AND (r.valid_until IS NULL OR substr(r.valid_until,1,19)>strftime('%Y-%m-%dT%H:%M:%S','now')) WHERE d.id=? LIMIT 1`;
interface AdmissionRow {
  unrelated_role_configuration: number;
  admission_snapshot_capable: number;
  generation: number;
  observed_generation: number;
  observed_power: string;
  suspension_reason: string | null;
  power_operation: string | null;
  desired_state: string;
  observed_state: string;
  database_deleted_at: string | null;
  project_deleted_at: string | null;
  runtime_attestation_json: string | null;
  route_token_v3: number;
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
  // Temporary rollout compatibility (route-token.ts): a region whose gateways may still verify
  // only v2 gets an untargeted route.
  if (row.route_token_v3 !== 1) return { ok: true, region: region.data };
  const target = verifiedTarget(row, databaseId);
  // A v3 region never falls back to an untargeted route: without the verified Pod of the observed
  // revision the database is not ready for a connection yet.
  return target
    ? { ok: true, region: region.data, target }
    : { ok: false, sqlstate: "57P03" };
}

/** The controller's runtime attestation of the observed revision names its verified Pod. */
function verifiedTarget(
  row: AdmissionRow,
  databaseId: string,
): z.infer<typeof CnpgDatabaseTarget> | undefined {
  if (row.runtime_attestation_json === null) return undefined;
  const attestation = DatabaseRuntimeAttestation.safeParse(
    JSON.parse(row.runtime_attestation_json),
  );
  return attestation.success &&
    attestation.data.database_id === databaseId &&
    attestation.data.generation === row.observed_generation
    ? {
        revision: attestation.data.generation,
        pod_uid: attestation.data.pod_uid,
      }
    : undefined;
}

export class DatabaseActor extends DurableObject<Env> {
  private hasSchema: boolean | undefined;
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
  /**
   * When this instance last admitted a connection. It is written durably (last_admitted_at) only
   * by an admission that revokes an outstanding reclaim; warm idle takes the later of the two.
   */
  private admittedAt = 0;
  private admissionState() {
    const presence = this.presence();
    if (!presence) return undefined;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1),snapshot TEXT,barrier TEXT)",
    );
    const row = this.ctx.storage.sql
      .exec<{ snapshot: string | null; barrier: string | null }>(
        "SELECT snapshot,barrier FROM database_snapshot WHERE singleton=1",
      )
      .toArray()[0];
    return {
      presence,
      snapshot: row?.snapshot
        ? DatabaseAdmissionSnapshot.parse(JSON.parse(row.snapshot))
        : undefined,
      barrier: row?.barrier
        ? PersistedAdmissionMutationIntent.parse(JSON.parse(row.barrier))
        : undefined,
    };
  }
  private saveAdmissionState(
    snapshot: DatabaseAdmissionSnapshot | undefined,
    barrier: PersistedAdmissionMutationIntent | undefined,
  ) {
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
    await this.revokeReclaimLocked();
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
      // another read. A cached runtime proof must still be current.
      if (
        !snapshot.cache_capable ||
        (snapshot.runtime &&
          snapshot.runtime.observation.expires_at > Date.now())
      ) {
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
    if (!snapshot?.cache_capable) return undefined;
    if (snapshot.deleted) return { ok: false, sqlstate: "3D000" };
    if (!snapshot.roles.some((role) => role.name === user))
      return { ok: false, sqlstate: "28P01" };
    const runtime = snapshot.runtime;
    if (
      !snapshot.admissible ||
      !runtime ||
      runtime.observation.expires_at <= Date.now() ||
      runtime.observed_at > Date.now() + 1000
    )
      return { ok: false, sqlstate: "57P03" };
    const target = {
      revision: snapshot.generation,
      pod_uid: runtime.pod_uid,
      route_revision: snapshot.route_revision,
    };
    return { ok: true, region: snapshot.region, target };
  }
  /** Whether the reclaim table exists; a read never creates it, so an admission writes nothing. */
  private reclaimTable = false;
  private reclaimState(): ReclaimState {
    this.reclaimTable ||=
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_reclaim'",
        )
        .toArray().length === 1;
    const stored = this.reclaimTable
      ? this.ctx.storage.sql
          .exec<{ state: string }>(
            "SELECT state FROM database_reclaim WHERE singleton=1",
          )
          .toArray()[0]
      : undefined;
    return stored
      ? (JSON.parse(stored.state) as ReclaimState)
      : {
          revision: 0,
          claims: null,
          token: null,
          revoked: true,
          acknowledged_revision: 0,
          reclaim_expires_at: 0,
          last_admitted_at: 0,
          configuration_fingerprint: null,
        };
  }
  private saveReclaim(value: ReclaimState): void {
    if (!this.reclaimTable) {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS database_reclaim(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL)",
      );
      this.reclaimTable = true;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO database_reclaim(singleton,state) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET state=excluded.state",
      JSON.stringify(value),
    );
  }
  private async revokeReclaimLocked(): Promise<ReclaimState> {
    const state = this.reclaimState();
    if (!state.claims || state.revoked) return state;
    const now = Date.now(),
      claims: ReclaimClaims = {
        ...state.claims,
        intent_revision: state.revision + 1,
        mode: "revoked",
        budget_bytes: 0,
        step_bytes: 0,
        issued_at: now,
        expires_at: now + RECLAIM_LIMITS.lease_ms,
      };
    // Persist revocation before signing/publishing. Interruption can never renew the previous grant.
    const next: ReclaimState = {
      ...state,
      revision: claims.intent_revision,
      claims,
      revoked: true,
      token: null,
    };
    this.saveReclaim(next);
    try {
      const key = await nodeProofSigningKey(this.env);
      claims.kid = key.kid;
      next.token = await signReclaimIntent(claims, key.privateKey, now);
      this.saveReclaim(next);
    } catch {
      /* The previous lease still expires; missing signing authority never reopens it. */
    }
    return next;
  }
  async revokeWarmReclaim(databaseId: string): Promise<void> {
    this.identity(DatabaseId.parse(databaseId));
    await this.gate("revokeWarmReclaim", () => this.revokeReclaimLocked());
  }
  /** Mutations revoke reclaim under the same real acknowledgement/expiry rule, without activity. */
  async revokeBeforeChange(
    databaseId: string,
    deadline = Date.now() + 30000,
  ): Promise<boolean> {
    this.identity(DatabaseId.parse(databaseId));
    return this.revokeBeforeAdmission(
      databaseId,
      Math.min(deadline, Date.now() + 30000),
      false,
    );
  }
  private async revokeBeforeAdmission(
    databaseId: string,
    deadline: number,
    recordAdmission = true,
  ): Promise<boolean> {
    this.identity(databaseId);
    if (recordAdmission) this.admittedAt = Date.now();
    // Without an outstanding reclaim there is nothing to revoke or wait for: the admission passes
    // without the gate and without a durable write.
    if (!this.reclaimOutstanding()) return true;
    await this.gate("revokeBeforeAdmission", async () => {
      const state = this.reclaimState();
      if (recordAdmission) {
        state.last_admitted_at = Math.max(
          state.last_admitted_at,
          this.admittedAt,
        );
        this.saveReclaim(state);
      }
      await this.revokeReclaimLocked();
    });
    while (Date.now() < deadline) {
      const state = this.reclaimState();
      if (
        !state.claims ||
        state.acknowledged_revision >= state.revision ||
        Date.now() >= state.reclaim_expires_at + RECLAIM_LIMITS.clock_skew_ms
      )
        return true;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(25, deadline - Date.now())),
      );
    }
    return false;
  }
  /** A reclaim grant that is live, or revoked without an Ack while its lease may still run. */
  private reclaimOutstanding(): boolean {
    const state = this.reclaimState();
    return (
      state.claims !== null &&
      (!state.revoked ||
        (state.acknowledged_revision < state.revision &&
          Date.now() < state.reclaim_expires_at + RECLAIM_LIMITS.clock_skew_ms))
    );
  }
  /** Trusted node publisher RPC. The reclaimer receives only this short-lived signed scope. */
  async reclaimIntent(databaseId: string): Promise<string | null> {
    this.identity(DatabaseId.parse(databaseId));
    return this.gate("reclaimIntent", async () => {
      const state = this.reclaimState();
      if (!state.claims) return null;
      if (state.revoked)
        return state.claims.expires_at > Date.now() ? state.token : null;
      const current = await warmReclaimCandidate(this.env, databaseId),
        activity = this.ctx.storage.sql
          .exec<{
            revision: number;
            observed_at: string;
            last_activity_at: string;
            active_connections: number;
          }>("SELECT * FROM database_activity WHERE singleton=1")
          .toArray()[0],
        runtime = current?.runtime,
        now = Date.now();
      if (
        !current ||
        !runtime ||
        !activity ||
        activity.revision !== runtime.generation ||
        Date.parse(activity.observed_at) < now - 30000 ||
        activity.active_connections !== 0 ||
        now -
          Math.max(
            Date.parse(activity.last_activity_at),
            state.last_admitted_at,
            this.admittedAt,
          ) <
          current.policy.idle_after_seconds * 1000 ||
        state.configuration_fingerprint !== runtime.configuration_fingerprint ||
        !this.sameReclaimRuntime(state.claims, runtime)
      ) {
        return (await this.revokeReclaimLocked()).token;
      }
      if (state.claims.expires_at > now + RECLAIM_LIMITS.snapshot_ms)
        return state.token;
      const key = await nodeProofSigningKey(this.env),
        claims: ReclaimClaims = {
          ...state.claims,
          kid: key.kid,
          intent_revision: state.revision + 1,
          issued_at: now,
          expires_at: now + RECLAIM_LIMITS.lease_ms,
        };
      const next: ReclaimState = {
        ...state,
        revision: claims.intent_revision,
        claims,
        token: null,
        reclaim_expires_at: claims.expires_at,
      };
      this.saveReclaim(next);
      next.token = await signReclaimIntent(claims, key.privateKey, now);
      this.saveReclaim(next);
      return next.token;
    });
  }
  private sameReclaimRuntime(
    claims: ReclaimClaims,
    runtime: DatabaseRuntimeAttestation,
  ): boolean {
    return (
      [
        "database_id",
        "generation",
        "storage_generation",
        "node_uid",
        "boot_id",
        "cluster_uid",
        "namespace_uid",
        "cnpg_cluster_uid",
        "storage_uid",
        "pvc_uid",
        "pv_uid",
        "pod_uid",
        "container_id",
        "postgres_image_sha256",
        "memory_request_bytes",
        "memory_limit_bytes",
      ] as const
    ).every((key) => claims[key] === runtime[key]);
  }
  /** A revoked acknowledgement permits admission even while one previously started bounded syscall finishes. */
  async recordReclaimObservation(
    databaseId: string,
    raw: unknown,
  ): Promise<boolean> {
    this.identity(DatabaseId.parse(databaseId));
    const parsed = ReclaimObservation.safeParse(raw);
    if (!parsed.success) return false;
    return this.gate("recordReclaimObservation", async () => {
      const state = this.reclaimState(),
        claims = state.claims,
        ack = parsed.data,
        now = Date.now();
      if (
        !claims ||
        ack.database_id !== databaseId ||
        ack.operation_id !== claims.operation_id ||
        ack.intent_revision !== state.revision ||
        ack.generation !== claims.generation ||
        ack.storage_generation !== claims.storage_generation ||
        ack.pod_uid !== claims.pod_uid ||
        ack.container_id !== claims.container_id ||
        ack.observed_at < now - RECLAIM_LIMITS.snapshot_ms ||
        ack.observed_at > now + RECLAIM_LIMITS.clock_skew_ms ||
        ack.observed_at < claims.issued_at - RECLAIM_LIMITS.clock_skew_ms
      )
        return false;
      if (ack.outcome === "revoked") {
        if (!state.revoked || claims.mode !== "revoked") return false;
        state.acknowledged_revision = state.revision;
        this.saveReclaim(state);
      }
      return true;
    });
  }
  private async enterWarmIdle(
    databaseId: string,
    revision: number,
    lastActivity: number,
  ): Promise<{ operation: string; revision: number } | null> {
    const current = await warmReclaimCandidate(this.env, databaseId);
    if (!current) return null;
    const state = this.reclaimState(),
      now = Date.now();
    if (
      now - Math.max(lastActivity, state.last_admitted_at, this.admittedAt) <
      current.policy.idle_after_seconds * 1000
    )
      return null;
    if (
      state.claims &&
      !state.revoked &&
      this.sameReclaimRuntime(state.claims, current.runtime) &&
      state.configuration_fingerprint ===
        current.runtime.configuration_fingerprint
    )
      return { operation: state.claims.operation_id, revision };
    if (state.claims && !state.revoked) {
      await this.revokeReclaimLocked();
      return null;
    }
    if (
      state.claims &&
      state.acknowledged_revision < state.revision &&
      now < state.reclaim_expires_at + RECLAIM_LIMITS.clock_skew_ms
    )
      return null;
    const key = await nodeProofSigningKey(this.env),
      configuration_fingerprint = current.runtime.configuration_fingerprint,
      runtime = reclaimScopeFromRuntime(current.runtime);
    const claims: ReclaimClaims = {
      ...runtime,
      kid: key.kid,
      operation_id: newOperationId(),
      intent_revision: state.revision + 1,
      mode: "reclaim",
      budget_bytes: current.policy.budget_bytes,
      step_bytes: current.policy.step_bytes,
      issued_at: now,
      expires_at: now + RECLAIM_LIMITS.lease_ms,
    };
    const next: ReclaimState = {
      ...state,
      revision: claims.intent_revision,
      claims,
      token: null,
      revoked: false,
      reclaim_expires_at: claims.expires_at,
      configuration_fingerprint,
    };
    this.saveReclaim(next);
    next.token = await signReclaimIntent(claims, key.privateKey, now);
    this.saveReclaim(next);
    return { operation: claims.operation_id, revision };
  }
  private initializeSchema(): void {
    if (this.hasSchema) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_presence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),database_id TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,roles TEXT NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_wake(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation TEXT NOT NULL,revision INTEGER NOT NULL,hint_claimed INTEGER NOT NULL CHECK(hint_claimed IN(0,1)))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_activity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,observed_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,active_connections INTEGER NOT NULL)",
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
          "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name IN('database_presence','database_wake','database_activity')",
        )
        .toArray()[0]!.count === 3;
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
    return this.seedPresence(value, false);
  }
  /** A trusted current legacy Fleet page may only remove cached admission, never enable it. */
  async seedLegacyPresence(value: unknown): Promise<boolean> {
    await this.seedPresence(value, true);
    return this.admissionState()?.barrier !== undefined;
  }
  private async seedPresence(
    value: unknown,
    clearAdmissionSnapshot: boolean,
  ): Promise<void> {
    const parsed = DatabasePresence.safeParse(value);
    if (!parsed.success) throw new Error("invalid_actor_snapshot");
    this.identity(parsed.data.database_id);
    await this.gate("seedPresence", async () => {
      this.initializeSchema();
      if (clearAdmissionSnapshot) {
        const state = this.admissionState();
        if (state) this.saveAdmissionState(undefined, state.barrier);
      }
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
      if (
        previous &&
        (next.deleted ||
          next.revision !== previous.revision ||
          JSON.stringify(next.roles) !== JSON.stringify(previous.roles))
      )
        await this.revokeReclaimLocked();
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
      if (!(await this.revokeBeforeAdmission(id.data, Date.now() + 30000)))
        return { ok: false, sqlstate: "57P03" };
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
    const id = DatabaseId.safeParse(databaseId),
      role = RoleName.safeParse(user);
    if (!id.success) return { ok: false, sqlstate: "3D000" };
    if (!role.success) return { ok: false, sqlstate: "28P01" };
    this.identity(id.data);
    try {
      const read = this.admissionState();
      const snapshot = read?.snapshot;
      if (!snapshot?.cache_capable || snapshot.wakeable === undefined)
        return await this.ensureAwake(id.data, role.data, options);
      const failure = this.earlyAdmission(id.data, role.data, read!.presence);
      if (failure) return failure;
      // A revocation awaits the gate, and the state may change meanwhile: only then is it read
      // again. Without one, nothing ran between the read and this admission.
      const revoking = this.reclaimOutstanding();
      if (
        !(await this.revokeBeforeAdmission(
          id.data,
          Math.min(options?.deadline ?? Infinity, Date.now() + 30000),
        ))
      )
        return { ok: false, sqlstate: "57P03" };
      const state = revoking ? this.admissionState()! : read!;
      if (state.barrier) {
        if (state.barrier.mutation_id !== this.ticketMutation)
          return { ok: false, sqlstate: "57P03" };
      } else {
        const admitted = this.snapshotAdmission(role.data, state);
        if (admitted?.ok) return admitted;
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
        if (!current.wakeable)
          return await this.ensureAwake(id.data, role.data, options);
        ticket = {
          operation: newOperationId(),
          generation: current.generation + 1,
          route_revision: current.route_revision,
          role_revision_hash: await roleRevisionHash(current.roles),
          state: "pending",
          issued_at: Date.now(),
        };
        this.saveTicket(ticket);
      }
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
      return {
        ok: true,
        region: current.region,
        wake: {
          operation: ticket!.operation,
          generation: ticket!.generation,
          route_revision: ticket!.route_revision,
          role_revision_hash: ticket!.role_revision_hash,
        },
      };
    } catch {
      return { ok: false, sqlstate: "08006" };
    }
  }
  private storedTicket(): WakeTicket | undefined {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_ticket(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation TEXT NOT NULL,generation INTEGER NOT NULL,route_revision INTEGER NOT NULL,role_revision_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','claimed','refused')),issued_at INTEGER NOT NULL)",
    );
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
    this.storedTicket();
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
                true,
              ),
            );
            // Committed at the ticket's generation: the region may pull it now, ahead of the
            // snapshot publish that closes this mutation.
            if (transition[0]!.meta.changes === 1)
              await this.hintWake(
                id,
                row.region_id,
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
  /** Tells the region a ticket was refused, with the database's current page when it is a wake. */
  private async refuteTicket(id: string): Promise<void> {
    try {
      const row = await this.env.DB.prepare(
        "SELECT region_id,power_operation,generation FROM databases WHERE id=?",
      )
        .bind(id)
        .first<{
          region_id: string;
          power_operation: string | null;
          generation: number;
        }>();
      if (!row) return;
      const page = row.power_operation
        ? await wakeHintPage(this.env, row.region_id, id, {
            operation: row.power_operation,
            revision: row.generation,
          }).catch(() => undefined)
        : undefined;
      await this.env.REGION_LINK.get(
        this.env.REGION_LINK.idFromName(row.region_id),
      )
        .notify([id], page)
        .catch(() => undefined);
    } catch {
      /* The region's periodic pull finds the refusal; the ticket lease refutes it meanwhile. */
    }
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
    if (row.observed_generation === row.generation) return true;
    // Legacy role configuration advances desired metadata without restarting
    // the live server. Create/reset atomically stamp the changed non-owner role
    // and database; a raw generation bump or this role's own change is no proof.
    // This D1 path still revalidates the role and all admission
    // fences. V3 still verifies the observed Pod/revision in admittedRoute;
    // snapshot-capable routing requires the exact current generation.
    return (
      row.observed_generation > 0 &&
      row.observed_generation < row.generation &&
      row.unrelated_role_configuration === 1 &&
      row.admission_snapshot_capable === 0 &&
      !this.admissionState()?.snapshot?.cache_capable
    );
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
    regionId: string,
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
      // Already claimed, so nothing replays it: the claim does not wait for its delivery. The hint
      // carries the page the region's targeted pull would read now; without it the region pulls.
      const hinted = Date.now();
      this.ctx.waitUntil(
        wakeHintPage(this.env, regionId, id, { operation, revision })
          .catch(() => undefined)
          .then(async (page) => {
            const read = Date.now();
            await this.env.REGION_LINK.get(
              this.env.REGION_LINK.idFromName(regionId),
            )
              .notify([id], page)
              .catch(() => undefined);
            // The wake split's first stage on this side: the claim itself and the region hint.
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
                page: page !== undefined,
                page_ms: read - hinted,
                hint_ms: Date.now() - read,
              }),
            );
          }),
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
                    previous.region_id,
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
              row.region_id,
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
      if (!(await this.revokeBeforeAdmission(id.data, deadline)))
        return { ok: false, sqlstate: "57P03" };
      const current = await this.known(id.data, role.data);
      if ("ok" in current) return current;
      if (
        current.desired_state === "running" &&
        current.observed_state === "ready" &&
        current.observed_power === "awake" &&
        this.readyRevision(current)
      )
        return (
          this.snapshotAdmission(role.data) ?? admittedRoute(current, id.data)
        );
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
              (!snapshot?.cache_capable ||
                (snapshot.admissible &&
                  snapshot.generation === this.wake.revision &&
                  snapshot.runtime &&
                  snapshot.runtime.observation.expires_at > Date.now()))
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
  /** Trusted gateway activity RPC; absence of authenticated measurements never starts an idle intent. */
  async recordActivity(databaseId: string, value: unknown): Promise<boolean> {
    this.identity(DatabaseId.parse(databaseId));
    if (!this.presence() || this.presence()!.deleted) return false;
    const parsed = z
      .strictObject({
        revision: z.number().int().positive(),
        observed_at: Timestamp,
        last_activity_at: Timestamp,
        active_connections: z.number().int().nonnegative().max(1_000_000),
      })
      .safeParse(value);
    if (!parsed.success) return false;
    const activity = parsed.data,
      now = Date.now();
    if (
      Date.parse(activity.observed_at) > now + 5000 ||
      Date.parse(activity.observed_at) < now - 30_000 ||
      activity.last_activity_at > activity.observed_at
    )
      return false;
    // The report of every ready database comes through here every few seconds: its read of the row
    // is not made inside the gate, where a slow one would hold every other event of the database.
    // A report of a generation that has moved on is stored harmlessly: whoever uses it compares its
    // revision with the row's.
    try {
      const current = await this.env.DB.prepare(
        "SELECT generation FROM databases d JOIN projects p ON p.id=d.project_id WHERE d.id=? AND d.deleted_at IS NULL AND p.deleted_at IS NULL",
      )
        .bind(databaseId)
        .first<{ generation: number }>();
      if (current?.generation !== activity.revision) return false;
    } catch {
      return false;
    }
    return this.gate("recordActivity", async () => {
      try {
        if (activity.active_connections > 0) await this.revokeReclaimLocked();
        return (
          this.ctx.storage.sql.exec(
            "INSERT INTO database_activity(singleton,revision,observed_at,last_activity_at,active_connections) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,observed_at=excluded.observed_at,last_activity_at=excluded.last_activity_at,active_connections=excluded.active_connections WHERE excluded.revision>database_activity.revision OR (excluded.revision=database_activity.revision AND excluded.observed_at>database_activity.observed_at AND excluded.last_activity_at>=database_activity.last_activity_at)",
            activity.revision,
            activity.observed_at,
            activity.last_activity_at,
            activity.active_connections,
          ).rowsWritten === 1
        );
      } catch {
        return false;
      }
    });
  }

  /**
   * A refusal that needs no gate: no current report, a row that moved on, or a database busy or
   * idle for less than its sleep threshold. Undefined when the database may be idle or has a warm
   * reclaim policy, which decides on its own thresholds.
   */
  private async idleRefusal(
    databaseId: string,
    revision: number,
  ): Promise<
    | { ok: false; reason: "activity_unavailable" | "not_idle" | "changed" }
    | undefined
  > {
    const activity = this.ctx.storage.sql
      .exec<{
        revision: number;
        observed_at: string;
        last_activity_at: string;
        active_connections: number;
      }>("SELECT * FROM database_activity WHERE singleton=1")
      .toArray()[0];
    if (
      !activity ||
      activity.revision !== revision ||
      Date.parse(activity.observed_at) < Date.now() - 30_000
    )
      return { ok: false, reason: "activity_unavailable" };
    const row = await this.env.DB.prepare(
      "SELECT d.*,s.sleep_after_seconds FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=? AND d.deleted_at IS NULL",
    )
      .bind(databaseId)
      .first<DatabaseRow & { sleep_after_seconds: number | null }>();
    if (
      !row ||
      row.generation !== revision ||
      row.desired_state !== "running" ||
      row.observed_state !== "ready" ||
      row.observed_generation !== revision ||
      row.observed_power !== "awake"
    )
      return { ok: false, reason: "changed" };
    if (
      row.warm_reclaim_policy_json === null &&
      (activity.active_connections !== 0 ||
        row.sleep_after_seconds === null ||
        Date.now() - Date.parse(activity.last_activity_at) <
          row.sleep_after_seconds * 1000)
    )
      return { ok: false, reason: "not_idle" };
    return undefined;
  }

  async requestIdle(
    databaseId: string,
    revision: number,
  ): Promise<
    | { ok: true; operation: string; revision: number }
    | { ok: false; reason: "activity_unavailable" | "not_idle" | "changed" }
  > {
    this.identity(DatabaseId.parse(databaseId));
    if (!this.presence() || this.presence()!.deleted)
      return { ok: false, reason: "changed" };
    // Most probes find nothing to do. Their answer is given before the gate, from the report in the
    // Actor's own storage and one read of the row; a database that may be idle takes the gate,
    // which decides on fresh reads as before.
    const early = await this.idleRefusal(databaseId, revision);
    if (early) return early;
    return this.gate("requestIdle", async () => {
      const activity = this.ctx.storage.sql
        .exec<{
          revision: number;
          observed_at: string;
          last_activity_at: string;
          active_connections: number;
        }>("SELECT * FROM database_activity WHERE singleton=1")
        .toArray()[0];
      if (
        !activity ||
        activity.revision !== revision ||
        Date.parse(activity.observed_at) < Date.now() - 30_000
      )
        return { ok: false, reason: "activity_unavailable" };
      const row = await this.env.DB.prepare(
        "SELECT d.*,s.sleep_after_seconds FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=? AND d.deleted_at IS NULL",
      )
        .bind(databaseId)
        .first<DatabaseRow & { sleep_after_seconds: number | null }>();
      if (
        !row ||
        row.generation !== revision ||
        row.desired_state !== "running" ||
        row.observed_state !== "ready" ||
        row.observed_generation !== revision ||
        row.observed_power !== "awake"
      )
        return { ok: false, reason: "changed" };
      const warm = await warmReclaimCandidate(this.env, databaseId);
      if (
        warm &&
        activity.active_connections === 0 &&
        Date.now() - Date.parse(activity.last_activity_at) >=
          warm.policy.idle_after_seconds * 1000
      ) {
        const intent = await this.enterWarmIdle(
          databaseId,
          revision,
          Date.parse(activity.last_activity_at),
        );
        return intent
          ? { ok: true, ...intent }
          : { ok: false, reason: "not_idle" };
      }
      if (warm) return { ok: false, reason: "not_idle" };
      if (
        activity.active_connections !== 0 ||
        row.sleep_after_seconds === null ||
        Date.now() - Date.parse(activity.last_activity_at) <
          row.sleep_after_seconds * 1000
      )
        return { ok: false, reason: "not_idle" };
      await this.revokeReclaimLocked();
      const operation = newOperationId(),
        now = new Date().toISOString();
      const result = await withAdmissionMutation(
        this.env,
        [databaseId],
        async (mutation) =>
          mutation.batch(
            powerTransitionStatements(
              this.env.DB,
              row,
              "hibernate",
              operation,
              now,
              undefined,
              mutation.guard(databaseId),
            ),
          ),
        undefined,
        this.localAdmissionActor(databaseId),
      );
      if (result[0]!.meta.changes !== 1)
        return { ok: false, reason: "changed" };
      await this.env.REGION_LINK.get(
        this.env.REGION_LINK.idFromName(row.region_id),
      )
        .notify([databaseId])
        .catch(() => undefined);
      return { ok: true, operation, revision: revision + 1 };
    });
  }
  override async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}
