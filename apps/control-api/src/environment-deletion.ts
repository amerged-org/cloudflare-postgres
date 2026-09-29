// SPDX-License-Identifier: Apache-2.0
import {
  assertion,
  body,
  error,
  fields,
  json,
  sha256,
  type AccountingDb,
} from "./accounting";
import {
  actorBindings,
  actorPredicate,
  authorize,
  idempotencyKey,
  integer,
  uid,
  type Actor,
} from "./execution-auth";
import { operationFromRow, type LegacyOperationRow } from "./execution-reads";
import { planSuspend, publicRuntime, type RuntimeRow } from "./suspend";
import type { EnvironmentRow } from "./environments";

export interface DeletionPointer {
  deletion_operation_id?: string | null;
  deletion_stop_operation_id?: string | null;
  deletion_stop_status?: string | null;
}
export const deletionReadColumns =
  "ed.operation_id AS deletion_operation_id, ed.stop_operation_id AS deletion_stop_operation_id, es.status AS deletion_stop_status";
export function deletionReadJoins(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("deletion_query_alias_invalid");
  return `LEFT JOIN environment_deletions ed ON ed.environment_id=${alias}.id LEFT JOIN operations es ON es.id=ed.stop_operation_id`;
}
export function deletionView(row: DeletionPointer) {
  if (!row.deletion_operation_id) return null;
  return {
    desiredState: "deleted" as const,
    phase:
      row.deletion_stop_status === "succeeded"
        ? ("pending_physical_deletion" as const)
        : ("stopping" as const),
    operationId: row.deletion_operation_id,
    stopOperationId: row.deletion_stop_operation_id!,
    volumePolicy: "delete" as const,
    backupPolicy: "retain" as const,
    physicalDeletionVerified: false as const,
  };
}
interface DeletionRow {
  environment_id: string;
  organization_id: string;
  project_id: string;
  region_id: string;
  operation_id: string;
  stop_operation_id: string;
  request_hash: string;
  response_json: string;
}
async function previous(
  db: AccountingDb,
  actor: Actor,
  scope: string,
  key: string,
) {
  return db
    .prepare(
      `SELECT * FROM environment_deletions WHERE organization_id=? AND scope_key=? AND idempotency_key=? AND ${actorPredicate(actor)}`,
    )
    .bind(actor.ownerId, scope, key, ...actorBindings(actor))
    .first<DeletionRow>();
}
function replay(row: DeletionRow, requestHash: string): Response {
  return row.request_hash === requestHash
    ? json(JSON.parse(row.response_json), 202)
    : error(409, "idempotency_conflict");
}
async function createDeletion(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
) {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    "projects:write",
  );
  if (actor instanceof Response) return actor;
  const key = idempotencyKey(request);
  if (!key) return error(400, "invalid_idempotency_key");
  const input = await body(request);
  if (
    !fields(input, ["expectedRevision", "volumePolicy", "backupPolicy"]) ||
    !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    input.volumePolicy !== "delete" ||
    input.backupPolicy !== "retain"
  )
    return error(400, "invalid_request");
  const scope = new URL(request.url).pathname;
  const requestHash = await sha256(
    JSON.stringify({
      scope,
      expectedRevision: input.expectedRevision,
      volumePolicy: input.volumePolicy,
      backupPolicy: input.backupPolicy,
    }),
  );
  const prior = await previous(db, actor, scope, key);
  if (prior) return replay(prior, requestHash);
  const planned = await planSuspend(
    db,
    actor,
    organizationId,
    projectId,
    environmentId,
    input.expectedRevision,
    scope,
    key,
    requestHash,
    true,
  );
  if (planned instanceof Response) return planned;
  const at = new Date().toISOString();
  const operation = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    region_id: planned.environment.region_id,
    kind: "environment.delete",
    status: "queued",
    created_at: at,
    observed_at: null,
    result_code: null,
  };
  const deletion = deletionView({
    deletion_operation_id: operation.id,
    deletion_stop_operation_id: planned.operation.id,
    deletion_stop_status: planned.operation.status,
  });
  const response = {
    deletion,
    operation: operationFromRow(operation),
    stopOperation: operationFromRow(planned.operation),
    runtime: planned.response.runtime,
  };
  try {
    await db.batch([
      ...planned.statements,
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      db
        .prepare(
          "INSERT INTO operations (id,organization_id,project_id,environment_id,region_id,kind,status,created_at) VALUES (?,?,?,?,?,'environment.delete','queued',?)",
        )
        .bind(
          operation.id,
          organizationId,
          projectId,
          environmentId,
          planned.environment.region_id,
          at,
        ),
      db
        .prepare(
          "INSERT INTO environment_deletions (environment_id,organization_id,project_id,region_id,operation_id,stop_operation_id,expected_runtime_revision,runtime_revision,spec_revision,spec_hash,spec_json,observation_json,run_epoch,volume_policy,backup_policy,scope_key,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'delete','retain',?,?,?,?,?)",
        )
        .bind(
          environmentId,
          organizationId,
          projectId,
          planned.environment.region_id,
          operation.id,
          planned.operation.id,
          input.expectedRevision,
          planned.runtime.revision,
          planned.environment.spec_revision,
          planned.environment.spec_hash,
          planned.environment.resolved_spec,
          planned.environment.observation_json,
          planned.environment.run_epoch,
          scope,
          key,
          requestHash,
          JSON.stringify(response),
          at,
        ),
    ]);
  } catch {
    const winner = await previous(db, actor, scope, key);
    return winner
      ? replay(winner, requestHash)
      : error(409, "deletion_conflict");
  }
  return json(response, 202);
}
async function readLifecycle(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
) {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    "projects:read",
  );
  if (actor instanceof Response) return actor;
  const read = await db.batch([
    db
      .prepare(`SELECT 1 WHERE ${actorPredicate(actor)}`)
      .bind(...actorBindings(actor)),
    db
      .prepare(
        `SELECT e.*,${deletionReadColumns} FROM environments e ${deletionReadJoins("e")} WHERE e.id=? AND e.organization_id=? AND e.project_id=? AND ${actorPredicate(actor)}`,
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
    db
      .prepare(
        `SELECT o.* FROM operations o JOIN environment_deletions d ON o.id IN (d.operation_id,d.stop_operation_id) WHERE d.environment_id=? AND d.organization_id=? AND d.project_id=? AND ${actorPredicate(actor)}`,
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
    db
      .prepare(
        `SELECT r.* FROM environment_runtime r JOIN environments e ON e.id=r.environment_id WHERE e.id=? AND e.organization_id=? AND e.project_id=? AND ${actorPredicate(actor)}`,
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
  ]);
  if (read[0]!.results.length !== 1) return error(401, "unauthorized");
  const environment = read[1]!.results[0] as
    (EnvironmentRow & DeletionPointer) | undefined;
  if (!environment) return error(404, "not_found");
  const operations = read[2]!.results as unknown as LegacyOperationRow[];
  const parent = operations.find(
    (o) => o.id === environment.deletion_operation_id,
  );
  const stop = operations.find(
    (o) => o.id === environment.deletion_stop_operation_id,
  );
  if (environment.deletion_operation_id && (!parent || !stop))
    return error(500, "deletion_state_inconsistent");
  return json({
    lifecycle: deletionView(environment),
    operation: parent ? operationFromRow(parent) : null,
    stopOperation: stop ? operationFromRow(stop) : null,
    runtime: publicRuntime(
      environment,
      (read[3]!.results[0] as RuntimeRow | undefined) ?? null,
    ),
  });
}

export async function deletionRoutes(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const match =
    /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)(\/lifecycle)?$/.exec(
      new URL(request.url).pathname,
    );
  if (
    !match ||
    (match[4] ? request.method !== "GET" : request.method !== "DELETE")
  )
    return null;
  if (![match[1], match[2], match[3]].every(uid))
    return error(400, "invalid_request");
  const db = env.DB.withSession("first-primary");
  try {
    return match[4]
      ? await readLifecycle(request, db, match[1]!, match[2]!, match[3]!)
      : await createDeletion(request, db, match[1]!, match[2]!, match[3]!);
  } catch {
    // Keep private specification, credentials and provider errors out of replies.
    return error(500, "deletion_unavailable");
  }
}
