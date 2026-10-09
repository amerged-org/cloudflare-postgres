// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import {
  DatabaseId,
  DatabaseRegionRoute as RegionRoute,
  type DatabaseAdmission,
  RoleName,
  Timestamp,
  newOperationId,
} from "@pgcf/contracts";
import { z } from "zod";
import {
  ReclaimClaims,
  ReclaimObservation,
  RECLAIM_LIMITS,
  signReclaimIntent,
  type DatabaseRuntimeAttestation,
} from "@pgcf/contracts/reclaim";
import { nodeProofSigningKey } from "./domain/node-proof-session.ts";
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
import type { DatabaseRow } from "./domain/rows.ts";
import { readDatabasePresence } from "./domain/database-actor-sync.ts";

export const DatabasePresence = z
  .strictObject({
    database_id: DatabaseId,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updated_at: Timestamp,
    roles: z
      .array(RoleName)
      .max(100)
      .refine((roles) => new Set(roles).size === roles.length)
      .transform((roles) => [...roles].sort()),
    deleted: z.boolean(),
  })
  .refine((snapshot) => !snapshot.deleted || snapshot.roles.length === 0);
export type DatabasePresence = z.infer<typeof DatabasePresence>;
export type { DatabaseAdmission } from "@pgcf/contracts";
export const DATABASE_ADMISSION_QUERY = `SELECT d.desired_state,d.observed_state,d.generation,d.observed_generation,d.observed_power,d.suspension_reason,d.power_operation,d.deleted_at database_deleted_at,p.deleted_at project_deleted_at,
  r.name role_name,g.id,g.gateway_url,g.gateway_binding,n.id node_id,n.lost_at
  FROM databases d JOIN projects p ON p.id=d.project_id JOIN regions g ON g.id=d.region_id
  LEFT JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id
  LEFT JOIN roles r ON r.database_id=d.id AND r.name=? AND r.deleted_at IS NULL WHERE d.id=? LIMIT 1`;
interface AdmissionRow {
  generation: number;
  observed_generation: number;
  observed_power: string;
  suspension_reason: string | null;
  power_operation: string | null;
  desired_state: string;
  observed_state: string;
  database_deleted_at: string | null;
  project_deleted_at: string | null;
  role_name: string | null;
  id: string;
  gateway_url: string;
  gateway_binding: string | null;
  node_id: string | null;
  lost_at: string | null;
}

function admittedRoute(row: AdmissionRow): DatabaseAdmission {
  const region = RegionRoute.safeParse({
    id: row.id,
    gateway_url: row.gateway_url,
    gateway_binding: row.gateway_binding,
  });
  return region.success
    ? { ok: true, region: region.data }
    : { ok: false, sqlstate: "08006" };
}

export class DatabaseActor extends DurableObject<Env> {
  private hasSchema: boolean | undefined;
  private waiters = new Map<
    string,
    { deadline: number; resolve: (ready: boolean) => void; owner: object }
  >();
  private polling = false;
  private wake: { operation: string; revision: number } | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private interruptPoll: (() => void) | undefined;
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
    await this.ctx.blockConcurrencyWhile(() => this.revokeReclaimLocked());
  }
  private async revokeBeforeAdmission(
    databaseId: string,
    deadline: number,
  ): Promise<boolean> {
    this.identity(databaseId);
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = this.reclaimState();
      state.last_admitted_at = Date.now();
      this.saveReclaim(state);
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
    return this.ctx.blockConcurrencyWhile(async () => {
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
    return this.ctx.blockConcurrencyWhile(async () => {
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
      { observed_at, configuration_fingerprint, ...runtime } = current.runtime;
    void observed_at;
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
    const parsed = DatabasePresence.safeParse(value);
    if (!parsed.success) throw new Error("invalid_actor_snapshot");
    this.identity(parsed.data.database_id);
    await this.ctx.blockConcurrencyWhile(async () => {
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
        JSON.stringify(next.roles),
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
      if (!snapshot.roles.includes(role.data))
        return { ok: false, sqlstate: "28P01" };
      if (!(await this.revokeBeforeAdmission(id.data, Date.now() + 30000)))
        return { ok: false, sqlstate: "57P03" };
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
        row.lost_at !== null ||
        row.desired_state !== "running" ||
        row.observed_state !== "ready" ||
        row.observed_power !== "awake" ||
        (row.power_operation !== null &&
          row.observed_generation !== row.generation)
      )
        return { ok: false, sqlstate: "57P03" };
      return admittedRoute(row);
    } catch {
      return { ok: false, sqlstate: "08006" };
    }
  }
  private async known(
    id: string,
    user: string,
  ): Promise<AdmissionRow | DatabaseAdmission> {
    const snapshot = this.presence();
    if (!snapshot || snapshot.deleted) return { ok: false, sqlstate: "3D000" };
    if (!snapshot.roles.includes(user)) return { ok: false, sqlstate: "28P01" };
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
    if (row.node_id === null || row.lost_at !== null)
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
    if (!snapshot.roles.includes(role.data))
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
  private async claimWake(
    id: string,
    user: string,
  ): Promise<
    { operation: string; revision: number } | { failure: "08006" } | undefined
  > {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const authorized = await this.known(id, user);
        if ("ok" in authorized) return undefined;
        let row = await this.env.DB.prepare(
          "SELECT * FROM databases WHERE id=?",
        )
          .bind(id)
          .first<DatabaseRow>();
        if (!row) return undefined;
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
            now = new Date().toISOString();
          const result = await this.env.DB.batch(
            powerTransitionStatements(
              this.env.DB,
              row,
              "wake",
              operation,
              now,
              user,
            ),
          );
          if (result[0]!.meta.changes !== 1) return undefined;
          row = await this.env.DB.prepare("SELECT * FROM databases WHERE id=?")
            .bind(id)
            .first<DatabaseRow>();
        }
        if (!row || row.desired_state !== "running" || !row.power_operation)
          return undefined;
        const operation = await this.env.DB.prepare(
          "SELECT id FROM operations WHERE id=? AND database_id=? AND project_id=? AND generation=? AND kind IN('database.wake','database.resume') AND status IN('pending','running','succeeded')",
        )
          .bind(row.power_operation, id, row.project_id, row.generation)
          .first<{ id: string }>();
        if (!operation) return undefined;
        const stored = this.ctx.storage.sql
          .exec<{ operation: string; revision: number; hint_claimed: number }>(
            "SELECT operation,revision,hint_claimed FROM database_wake WHERE singleton=1",
          )
          .toArray()[0];
        if (stored && stored.revision > row.generation) return undefined;
        if (
          !stored ||
          stored.operation !== operation.id ||
          stored.revision !== row.generation
        )
          this.ctx.storage.sql.exec(
            "INSERT INTO database_wake(singleton,operation,revision,hint_claimed) VALUES(1,?,?,0) ON CONFLICT(singleton) DO UPDATE SET operation=excluded.operation,revision=excluded.revision,hint_claimed=0",
            operation.id,
            row.generation,
          );
        // Claim before notifying: a lost response never replays a hint; periodic desired pulls recover its loss.
        const current = this.ctx.storage.sql
          .exec<{ hint_claimed: number }>(
            "SELECT hint_claimed FROM database_wake WHERE singleton=1",
          )
          .toArray()[0]!;
        if (!current.hint_claimed) {
          this.ctx.storage.sql.exec(
            "UPDATE database_wake SET hint_claimed=1 WHERE singleton=1",
          );
          await this.env.REGION_LINK.get(
            this.env.REGION_LINK.idFromName(row.region_id),
          )
            .notify([id])
            .catch(() => undefined);
        }
        return { operation: operation.id, revision: row.generation };
      } catch {
        return { failure: "08006" as const };
      }
    });
  }
  /** Known routes only. One shared observation loop, never application SQL or per-waiter polling. */
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
        (!current.power_operation ||
          current.observed_generation === current.generation)
      )
        return admittedRoute(current);
      if (
        current.desired_state === "suspended" &&
        current.suspension_reason !== "idle"
      )
        return { ok: false, sqlstate: "57P03" };
      if (current.observed_state === "error")
        return { ok: false, sqlstate: "57P03" };
      const wake = await this.claimWake(id.data, role.data);
      if (wake && "failure" in wake)
        return { ok: false, sqlstate: wake.failure };
      if (!wake || deadline <= Date.now() || this.waiters.size >= 32)
        return { ok: false, sqlstate: "57P03" };
      if (
        this.wake &&
        (this.wake.operation !== wake.operation ||
          this.wake.revision !== wake.revision)
      )
        this.finishWaiters(false);
      this.wake = wake;
      const waiter = parsed.data.waiterId ?? crypto.randomUUID();
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
        const row = await this.env.DB.prepare(
          `SELECT d.generation,d.power_operation,d.desired_state,d.observed_state,d.observed_generation,d.observed_power,p.deleted_at project_deleted_at FROM databases d JOIN projects p ON p.id=d.project_id WHERE d.id=?`,
        )
          .bind(id)
          .first<AdmissionRow>();
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
          this.finishWaiters(true);
          break;
        }
        const delay = Math.max(
          1,
          Math.min(
            250,
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
    } catch {
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
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const current = await this.env.DB.prepare(
          "SELECT generation FROM databases d JOIN projects p ON p.id=d.project_id WHERE d.id=? AND d.deleted_at IS NULL AND p.deleted_at IS NULL",
        )
          .bind(databaseId)
          .first<{ generation: number }>();
        if (current?.generation !== activity.revision) return false;
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
    return this.ctx.blockConcurrencyWhile(async () => {
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
      const result = await this.env.DB.batch(
        powerTransitionStatements(
          this.env.DB,
          row,
          "hibernate",
          operation,
          now,
        ),
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
