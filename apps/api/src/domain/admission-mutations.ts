// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, NodeId, ProjectId, RegionId } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import type { AdmissionMutationIntent } from "./admission-state.ts";
import { databaseActor, readDatabasePresence } from "./database-actor-sync.ts";
import { hintDatabases } from "./node-hints.ts";

export interface AdmissionSqlGuard {
  sql: string;
  bindings: (string | number | null)[];
}
export type AdmissionScope = {
  kind: "project" | "region" | "node";
  id: string;
  databases?: AdmissionSqlGuard;
};
export interface LocalAdmissionActor {
  database_id: string;
  begin: (intent: AdmissionMutationIntent) => Promise<boolean>;
  publish: (completedMutation: string) => Promise<boolean>;
}
interface EpochRow {
  database_id: string;
  admission_revision: number;
  route_revision: number;
  mutation_id: string | null;
}
const scopeSchema = { project: ProjectId, region: RegionId, node: NodeId };
const scopeTable = { project: "projects", region: "regions", node: "nodes" };
const scopeColumn = {
  project: "project_id",
  region: "region_id",
  node: "node_id",
};
const conflict = () =>
  new ApiError("conflict", "Database admission mutation is in progress", {
    reason: "mutation_in_progress",
  });

export class AdmissionMutation {
  private submitted = false;
  assertSubmitted() {
    if (!this.submitted)
      throw new Error("database_admission_mutation_not_submitted");
  }
  readonly env: Env;
  readonly intents: AdmissionMutationIntent[];
  readonly scope: AdmissionScope | undefined;
  readonly scopeRevision: number | undefined;
  readonly mutationId: string;
  constructor(
    env: Env,
    intents: AdmissionMutationIntent[],
    scope?: AdmissionScope,
    scopeRevision?: number,
    mutationId = intents[0]?.mutation_id ?? crypto.randomUUID(),
  ) {
    this.env = env;
    this.intents = intents;
    this.scope = scope;
    this.scopeRevision = scopeRevision;
    this.mutationId = mutationId;
  }
  guard(databaseId: string): AdmissionSqlGuard {
    const intent = this.intents.find(
      (value) => value.database_id === databaseId,
    );
    if (!intent) throw new Error("database_admission_mutation_scope_mismatch");
    const scope = this.scope ? this.scopeGuard() : undefined;
    return {
      sql: `EXISTS(SELECT 1 FROM database_admission_epochs admission_guard WHERE admission_guard.database_id=? AND admission_guard.admission_revision=? AND admission_guard.route_revision=? AND admission_guard.mutation_id=? AND admission_guard.mutation_status='pending') AND (${scope?.sql ?? "1=1"})`,
      bindings: [
        databaseId,
        intent.admission_revision,
        intent.route_revision,
        intent.mutation_id,
        ...(scope?.bindings ?? []),
      ],
    };
  }
  scopeGuard(): AdmissionSqlGuard {
    if (!this.scope || this.scopeRevision === undefined)
      throw new Error("database_admission_scope_missing");
    return {
      sql: "EXISTS(SELECT 1 FROM admission_scope_fences admission_scope_guard WHERE admission_scope_guard.kind=? AND admission_scope_guard.scope_id=? AND admission_scope_guard.revision=? AND admission_scope_guard.mutation_id=? AND admission_scope_guard.mutation_status='pending')",
      bindings: [
        this.scope.kind,
        this.scope.id,
        this.scopeRevision,
        this.mutationId,
      ],
    };
  }
  /** Exactly one guarded business batch. Its epoch receipts commit atomically with the write. */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return AdmissionMutation.batchScopes([this], statements);
  }
  /** One atomic declared-scope writer may close several regions without an installation barrier. */
  static async batchScopes(
    mutations: readonly AdmissionMutation[],
    statements: D1PreparedStatement[],
  ): Promise<D1Result[]> {
    const env = mutations[0]?.env;
    if (
      !env ||
      mutations.some((mutation) => mutation.env !== env || mutation.submitted)
    )
      throw new Error("database_admission_mutation_already_submitted");
    for (const mutation of mutations) mutation.submitted = true;
    const commit: D1PreparedStatement[] = [];
    for (const mutation of mutations) {
      const scopeGuard = mutation.scope ? mutation.scopeGuard() : undefined;
      commit.push(
        ...mutation.intents.map((intent) =>
          env.DB.prepare(
            `UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1,completed_mutation_id=mutation_id,mutation_outcome='committed',mutation_id=NULL,mutation_started_at=NULL,mutation_status=NULL WHERE database_id=? AND admission_revision=? AND route_revision=? AND mutation_id=? AND mutation_status='pending' AND (${scopeGuard?.sql ?? "1=1"})`,
          ).bind(
            intent.database_id,
            intent.admission_revision,
            intent.route_revision,
            intent.mutation_id,
            ...(scopeGuard?.bindings ?? []),
          ),
        ),
      );
      if (mutation.scope) {
        const guard = mutation.scopeGuard();
        commit.push(
          env.DB.prepare(
            `UPDATE admission_scope_fences SET revision=revision+1,mutation_id=NULL,mutation_started_at=NULL,mutation_status=NULL WHERE kind=? AND scope_id=? AND ${guard.sql}`,
          ).bind(mutation.scope.kind, mutation.scope.id, ...guard.bindings),
        );
      }
    }
    const result = await env.DB.batch([...statements, ...commit]);
    const receipts = result.slice(statements.length);
    if (
      receipts.length !== commit.length ||
      receipts.some((receipt) => receipt.meta.changes !== 1)
    )
      throw conflict();
    return result.slice(0, statements.length);
  }
}
/** Trusted callers close Actors before a guarded authoritative write; no callback is retried. */
export async function withAdmissionMutation<T>(
  env: Env,
  databaseIds: string[],
  execute: (mutation: AdmissionMutation) => Promise<T>,
  scope?: AdmissionScope,
  local?: LocalAdmissionActor,
): Promise<T> {
  let ids = [...new Set(databaseIds.map((id) => DatabaseId.parse(id)))].sort();
  const mutationId = crypto.randomUUID(),
    now = new Date().toISOString();
  let scopeRevision: number | undefined;
  const intents: AdmissionMutationIntent[] = [];
  if (scope) {
    scopeSchema[scope.kind].parse(scope.id);
    await env.DB.prepare(
      `INSERT INTO admission_scope_fences(kind,scope_id,${scopeColumn[scope.kind]}) SELECT ?,id,id FROM ${scopeTable[scope.kind]} WHERE id=? ON CONFLICT(kind,scope_id) DO NOTHING`,
    )
      .bind(scope.kind, scope.id)
      .run();
    const reserved = await env.DB.prepare(
      "UPDATE admission_scope_fences SET mutation_id=?,mutation_started_at=?,mutation_status='pending' WHERE kind=? AND scope_id=? AND mutation_id IS NULL RETURNING revision",
    )
      .bind(mutationId, now, scope.kind, scope.id)
      .first<{ revision: number }>();
    if (!reserved) throw conflict();
    scopeRevision = reserved.revision;
    // New create/placement commits reject this pending scope before membership is read. A database
    // whose deletion is confirmed admits nothing, so it is no member: each member costs Actor and D1
    // round trips while the fence holds every member.
    const rows = await env.DB.prepare(
      `SELECT d.id FROM databases d WHERE d.${scopeColumn[scope.kind]}=? AND NOT (d.deleted_at IS NOT NULL AND d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation) AND (${scope.databases?.sql ?? "1=1"}) ORDER BY d.id`,
    )
      .bind(scope.id, ...(scope.databases?.bindings ?? []))
      .all<{ id: string }>();
    ids = rows.results.map((row) => DatabaseId.parse(row.id));
  }
  try {
    for (const id of ids) {
      const readEpoch = () =>
        env.DB.prepare(
          "SELECT database_id,admission_revision,route_revision,mutation_id FROM database_admission_epochs WHERE database_id=?",
        )
          .bind(id)
          .first<EpochRow>();
      let epoch = await readEpoch();
      if (!epoch) {
        // Only a database that never had an epoch needs its first one inserted.
        await env.DB.prepare(
          "INSERT INTO database_admission_epochs(database_id) SELECT id FROM databases WHERE id=? ON CONFLICT(database_id) DO NOTHING",
        )
          .bind(id)
          .run();
        epoch = await readEpoch();
      }
      if (!epoch || epoch.mutation_id !== null) throw conflict();
      // Only a remote Actor is seeded with the presence; the local one is the caller itself.
      const presence =
        local?.database_id === id
          ? undefined
          : await readDatabasePresence(env.DB, id);
      if (local?.database_id !== id && !presence) throw conflict();
      const intent = {
        database_id: id,
        mutation_id: mutationId,
        admission_revision: epoch.admission_revision,
        route_revision: epoch.route_revision,
      };
      if (local?.database_id === id) {
        if (!(await local.begin(intent))) throw conflict();
      } else {
        const actor = databaseActor(env, id);
        await actor.seed(presence!);
        if (!(await actor.beginAdmissionMutation(intent))) throw conflict();
      }
      intents.push(intent);
      const scopeGuard = scope
        ? new AdmissionMutation(
            env,
            intents,
            scope,
            scopeRevision,
            mutationId,
          ).scopeGuard()
        : undefined;
      const result = await env.DB.prepare(
        `UPDATE database_admission_epochs SET mutation_id=?,mutation_started_at=?,mutation_status='pending' WHERE database_id=? AND admission_revision=? AND route_revision=? AND mutation_id IS NULL AND (${scopeGuard?.sql ?? "1=1"})`,
      )
        .bind(
          mutationId,
          now,
          id,
          intent.admission_revision,
          intent.route_revision,
          ...(scopeGuard?.bindings ?? []),
        )
        .run();
      if (result.meta.changes !== 1) throw conflict();
    }
    const mutation = new AdmissionMutation(
      env,
      intents,
      scope,
      scopeRevision,
      mutationId,
    );
    const result = await execute(mutation);
    // Callers must use batch: otherwise their write has no positive epoch receipt. A batch that
    // returned has committed every epoch receipt it carried (a missing one throws), so the fence
    // that closes a failed mutation's delayed statements has nothing left to close here.
    mutation.assertSubmitted();
    await publishMutation(env, intents, local);
    if (!local)
      await notifyAdmissionRevisions(
        env,
        intents.map((intent) => intent.database_id),
      );
    return result;
  } catch (error) {
    // The fence CAS invalidates delayed business statements before publication. Missing D1 leaves it closed.
    await fenceAdmissionMutation(env, mutationId, scope)
      .then(async () => {
        await publishMutation(env, intents, local);
        if (!local)
          await notifyAdmissionRevisions(
            env,
            intents.map((intent) => intent.database_id),
          );
      })
      .catch(() => undefined);
    throw error;
  }
}

async function publishMutation(
  env: Env,
  intents: AdmissionMutationIntent[],
  local?: LocalAdmissionActor,
) {
  const { publishDatabaseAdmission } =
    await import("./database-admission-snapshot.ts");
  for (const intent of intents) {
    if (local?.database_id === intent.database_id)
      await local.publish(intent.mutation_id);
    else
      await publishDatabaseAdmission(
        env,
        intent.database_id,
        intent.mutation_id,
      );
  }
}

/** A changed epoch tells the node of each database to pull its page. */
export async function notifyAdmissionRevisions(env: Env, ids: string[]) {
  await hintDatabases(env, ids).catch(() => 0);
}

/** Positive fence, not a timeout-based unfreeze: old tokens can no longer write after this CAS. */
export async function fenceAdmissionMutation(
  env: Env,
  mutationId: string,
  scope?: AdmissionScope,
) {
  if (scope)
    await env.DB.prepare(
      "UPDATE admission_scope_fences SET mutation_status='fenced' WHERE kind=? AND scope_id=? AND mutation_id=? AND mutation_status='pending'",
    )
      .bind(scope.kind, scope.id, mutationId)
      .run();
  const result = await env.DB.prepare(
    "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1,completed_mutation_id=mutation_id,mutation_outcome='fenced',mutation_id=NULL,mutation_started_at=NULL,mutation_status=NULL WHERE mutation_id=? RETURNING database_id",
  )
    .bind(mutationId)
    .all<{ database_id: string }>();
  if (scope)
    await env.DB.prepare(
      "UPDATE admission_scope_fences SET revision=revision+1,mutation_id=NULL,mutation_started_at=NULL,mutation_status=NULL WHERE kind=? AND scope_id=? AND mutation_id=? AND mutation_status='fenced'",
    )
      .bind(scope.kind, scope.id, mutationId)
      .run();
  return result.results.map((row) => row.database_id);
}

export async function recoverAdmissionMutations(env: Env, now = Date.now()) {
  const threshold = new Date(now - 60000).toISOString();
  const scopes = await env.DB.prepare(
    "SELECT kind,scope_id,mutation_id FROM admission_scope_fences WHERE mutation_id IS NOT NULL AND mutation_started_at<=? ORDER BY mutation_started_at LIMIT 8",
  )
    .bind(threshold)
    .all<{
      kind: AdmissionScope["kind"];
      scope_id: string;
      mutation_id: string;
    }>();
  for (const row of scopes.results) {
    const ids = await fenceAdmissionMutation(env, row.mutation_id, {
      kind: row.kind,
      id: row.scope_id,
    });
    await publishRecoveredMutation(env, ids, row.mutation_id);
  }
  const rows = await env.DB.prepare(
    "SELECT DISTINCT e.mutation_id FROM database_admission_epochs e WHERE e.mutation_id IS NOT NULL AND e.mutation_started_at<=? AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.mutation_id=e.mutation_id) ORDER BY e.mutation_started_at LIMIT 8",
  )
    .bind(threshold)
    .all<{ mutation_id: string }>();
  for (const row of rows.results) {
    const ids = await fenceAdmissionMutation(env, row.mutation_id);
    await publishRecoveredMutation(env, ids, row.mutation_id);
  }
  return scopes.results.length + rows.results.length;
}

async function publishRecoveredMutation(
  env: Env,
  ids: string[],
  mutationId: string,
) {
  const { publishDatabaseAdmission } =
    await import("./database-admission-snapshot.ts");
  for (const id of ids) await publishDatabaseAdmission(env, id, mutationId);
  await notifyAdmissionRevisions(env, ids);
}
