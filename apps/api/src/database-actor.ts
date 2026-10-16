// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import {
  DatabaseId,
  DatabaseRegionRoute as RegionRoute,
  type DatabaseAdmission,
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
import { thinStorageTurnsFor } from "./domain/databases.ts";
import { wakeHintPage } from "./domain/desired.ts";
import type { DatabaseRow } from "./domain/rows.ts";
import { readDatabasePresence } from "./domain/database-actor-sync.ts";
import {
  AdmissionMutationIntent,
  DatabaseAdmissionSnapshot,
} from "./domain/admission-state.ts";
import { withAdmissionMutation } from "./domain/admission-mutations.ts";
import { readDatabaseAdmissionSnapshot } from "./domain/database-admission-snapshot.ts";
import {
  readWakeGuard,
  wakeGuardBlocks,
  wakeGuardFacts,
  wakeGuardVerdict,
} from "./domain/wake-guard.ts";
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
 * A claim refused only because a periodic report is late (a stale inventory, a node sample, an
 * identity proof that has not read the generation yet) waits for it, reading the guard this often.
 * One read costs about what the claim's own guard does, so at most WAKE_GUARD_WAITERS connects
 * of a database read it at once.
 */
const WAKE_GUARD_POLL_MS = 1000;
/** The wait ends this long before the caller's deadline: a parked wake takes 1.2 to 1.5 s from its claim. */
const WAKE_GUARD_MARGIN_MS = 3000;
/** Connects of one database that wait on the guard together; any further one is refused at once. */
const WAKE_GUARD_WAITERS = 4;
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
  /** Connects waiting for the start guard of an idle sleeper, by waiter id: each one's way out. */
  private guardWaits = new Map<string, () => void>();
  private polling = false;
  private pushed = false;
  private wake: { operation: string; revision: number } | undefined;
  /** When the waiters of the current wake began to wait; only for the actor_release measurement. */
  private waitStartedAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private interruptPoll: (() => void) | undefined;
  private admissionState() {
    if (!this.presence()) return undefined;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1),snapshot TEXT,barrier TEXT)",
    );
    const row = this.ctx.storage.sql
      .exec<{ snapshot: string | null; barrier: string | null }>(
        "SELECT snapshot,barrier FROM database_snapshot WHERE singleton=1",
      )
      .toArray()[0];
    return {
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
  private snapshotAdmission(user: string): DatabaseAdmission | undefined {
    const state = this.admissionState();
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
  private reclaimState(): ReclaimState {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_reclaim(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL)",
    );
    const stored = this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM database_reclaim WHERE singleton=1",
      )
      .toArray()[0];
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
    await this.gate("revokeBeforeAdmission", async () => {
      const state = this.reclaimState();
      if (recordAdmission) {
        state.last_admitted_at = Date.now();
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
      now - Math.max(lastActivity, state.last_admitted_at) <
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
  ): DatabaseAdmission | undefined {
    const id = DatabaseId.safeParse(databaseId),
      role = RoleName.safeParse(user);
    if (!id.success) return { ok: false, sqlstate: "3D000" };
    if (!role.success) return { ok: false, sqlstate: "28P01" };
    this.identity(id.data);
    const snapshot = this.presence();
    if (!snapshot || snapshot.deleted) return { ok: false, sqlstate: "3D000" };
    if (!roleAdmitted(snapshot, role.data))
      return { ok: false, sqlstate: "28P01" };
    const configured = this.env.DATABASE_CONNECTION_LIMIT_PER_MINUTE ?? "12000";
    if (!/^[1-9][0-9]{0,4}$/.test(configured) || Number(configured) > 12000)
      return { ok: false, sqlstate: "53300" };
    // Only a trusted seeded role can allocate this single bounded admission row.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),minute INTEGER NOT NULL,attempts INTEGER NOT NULL)",
    );
    const allowed = this.ctx.storage.sql
      .exec(
        `INSERT INTO database_admission(singleton,minute,attempts) VALUES(1,?,1)
       ON CONFLICT(singleton) DO UPDATE SET minute=excluded.minute,
       attempts=CASE WHEN database_admission.minute=excluded.minute THEN database_admission.attempts+1 ELSE 1 END
       WHERE database_admission.minute<>excluded.minute OR database_admission.attempts<? RETURNING attempts`,
        Math.floor(Date.now() / 60_000),
        Number(configured),
      )
      .toArray();
    return allowed.length === 1 ? undefined : { ok: false, sqlstate: "53300" };
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
  /**
   * The wake claim's answer to a refusal that left the row unmoved: the transition's other
   * predicates are read part by part, once, and logged. "wait" when only late reports refuse it,
   * "retry" when everything holds now (a report landed in between), "refuse" otherwise. A read
   * that fails never changes the answer the claim always gave: refused.
   */
  private async diagnoseRefusal(
    id: string,
    user: string,
    revision: number,
    attempt: number,
  ): Promise<"wait" | "retry" | "refuse"> {
    try {
      const reading = await readWakeGuard(this.env.DB, id, user);
      const blocks = reading ? wakeGuardBlocks(reading) : [];
      const verdict = wakeGuardVerdict(reading, blocks);
      console.log(
        JSON.stringify({
          event: "actor_claim_refused",
          database_id: id,
          revision,
          attempt,
          at_ms: Date.now(),
          verdict,
          blocked_by: blocks.map((block) => block.reason),
          ...reading,
          ...(reading ? wakeGuardFacts(reading) : {}),
        }),
      );
      return verdict === "waits"
        ? "wait"
        : verdict === "refused"
          ? "refuse"
          : "retry";
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "actor_claim_refused",
          database_id: id,
          revision,
          attempt,
          at_ms: Date.now(),
          verdict: "unread",
          error: error instanceof Error ? error.name : "error",
        }),
      );
      return "refuse";
    }
  }
  private async claimWake(
    id: string,
    user: string,
    requested: number,
    deadline: number,
  ): Promise<
    | { operation: string; revision: number }
    | { failure: "08006" }
    | { wait: true }
    | undefined
  > {
    return this.gate("claimWake", async () => {
      const started = Date.now();
      try {
        // The row a lost commit was made from: a read that finds it unchanged says the commit was
        // refused for another reason, and the same commit would be refused again.
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
          if (lost !== undefined && JSON.stringify(row) === lost) {
            const answer = await this.diagnoseRefusal(
              id,
              user,
              row.generation + 1,
              attempt,
            );
            if (answer === "retry") {
              lost = undefined;
              continue;
            }
            return answer === "wait" ? { wait: true } : undefined;
          }
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
            this.ctx.waitUntil(thinStorageTurnsFor(this.env, [id]));
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
  /**
   * Known routes only. One shared observation loop for a running wake, never application SQL. The
   * only reads a waiter makes of its own are the start guard's, while its claim is refused for a
   * late report (waitForWakeGuard), and only a few connects of a database make them.
   */
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
      parsed.data.deadline ?? Date.now() + 30_000,
      Date.now() + 30_000,
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
      parsed.data.deadline ?? Date.now() + 30_000,
      Date.now() + 30_000,
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
      // The id this connect is known by at the Actor: in the guard wait, then as the waiter.
      const waiter = parsed.data.waiterId ?? crypto.randomUUID();
      // A connect that finds others waiting for the start guard of the sleeper joins their wait
      // instead of making a claim of its own that the same late report would refuse.
      let wake =
        this.guardWaits.size > 0 && current.desired_state === "suspended"
          ? { wait: true as const }
          : await this.claimWake(id.data, role.data, Date.now(), deadline);
      // A claim refused only because a periodic report is late waits for it outside the gate,
      // then claims again; the claim is the gate's, so connects that waited together make one
      // claim and the others find the wake it made.
      while (wake && "wait" in wake)
        wake = (await this.waitForWakeGuard(
          id.data,
          role.data,
          waiter,
          deadline - WAKE_GUARD_MARGIN_MS,
        ))
          ? await this.claimWake(id.data, role.data, Date.now(), deadline)
          : undefined;
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
   * A refused claim's wait for the reports the start guard needs. The guard is read here, outside
   * the Actor's gate and without an admission mutation, every WAKE_GUARD_POLL_MS until `until`.
   * True when a claim should be made (every part holds, or the database moved: the claim decides);
   * false when a part fails on current facts, the bound is reached, the connect gave up or too many
   * connects already wait. The claim itself stays the one authority and is serialised by the gate,
   * so connects that wait together make one claim and the others join it.
   */
  private async waitForWakeGuard(
    id: string,
    user: string,
    waiterId: string,
    until: number,
  ): Promise<boolean> {
    const started = Date.now();
    let polls = 0,
      outcome = "expired",
      blockedBy: string[] = [];
    if (
      this.guardWaits.size >= WAKE_GUARD_WAITERS ||
      this.guardWaits.has(waiterId)
    )
      outcome = "crowded";
    else {
      let cancelled = false,
        wake: (() => void) | undefined;
      this.guardWaits.set(waiterId, () => {
        cancelled = true;
        wake?.();
      });
      try {
        for (;;) {
          const left = until - Date.now();
          if (left <= 0) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(
              resolve,
              Math.min(WAKE_GUARD_POLL_MS, left),
            );
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          if (cancelled) {
            outcome = "cancelled";
            break;
          }
          // The role's presence is the Actor's own: a revoked role claims nothing.
          const presence = this.presence();
          if (!presence || presence.deleted || !roleAdmitted(presence, user)) {
            outcome = "claim";
            break;
          }
          polls++;
          let reading: Awaited<ReturnType<typeof readWakeGuard>>;
          try {
            reading = await readWakeGuard(this.env.DB, id, user);
          } catch {
            // A failed read says nothing about the guard; the bound ends the wait.
            continue;
          }
          if (cancelled) {
            outcome = "cancelled";
            break;
          }
          const blocks = reading ? wakeGuardBlocks(reading) : [];
          blockedBy = blocks.map((block) => block.reason);
          const verdict = wakeGuardVerdict(reading, blocks);
          if (verdict === "holds" || verdict === "moved") {
            outcome = "claim";
            break;
          }
          if (verdict === "refused") {
            outcome = "refused";
            break;
          }
        }
      } finally {
        this.guardWaits.delete(waiterId);
      }
    }
    console.log(
      JSON.stringify({
        event: "actor_claim_waited",
        database_id: id,
        waiter_id: waiterId,
        outcome,
        polls,
        waited_ms: Date.now() - started,
        blocked_by: blockedBy,
        at_ms: Date.now(),
      }),
    );
    return outcome === "claim";
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
    // A connect still waiting for the start guard has no waiter yet: it stops waiting.
    const leave = this.guardWaits.get(waiterId);
    if (leave) {
      leave();
      return true;
    }
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
