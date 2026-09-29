// SPDX-License-Identifier: Apache-2.0
// This lane stores an intention only. No regional claim or effect is exposed.
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
import { runtimeAllowsExecution } from "./environment-runtime";
import {
  validEnvironmentObservation,
  type EnvironmentRow,
} from "./environments";

interface OwnedEnvironment extends EnvironmentRow {
  project_status: string;
  region_status: string;
  runtime_revision: number;
}
interface ComputeRow {
  environment_id: string;
  revision: number;
  requested_size_id: string;
  effective_size_id: string;
  phase: "requested" | "applying" | "effective" | "failed";
  operation_id: string;
  version_token: string;
  updated_at: string;
  observed_at: string | null;
}
interface SizePolicy {
  version: 1;
  initialSizeId: string;
  sizes: Array<{ id: string; cpuMilli: number; memoryMiB: number }>;
}
interface ResizeOperation {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  kind: "environment.resize";
  cause: "manual";
  status: "queued" | "running" | "completed" | "failed";
  compute_revision: number;
  from_size_id: string;
  target_size_id: string;
  created_at: string;
  observed_at: string | null;
  result_code: string | null;
}
const hash = /^[a-f0-9]{64}$/;
const budgetRunning =
  "NOT EXISTS (SELECT 1 FROM budget_targets bt WHERE bt.organization_id=e.organization_id AND bt.project_id=e.project_id AND (bt.environment_id IS NULL OR bt.environment_id=e.id) AND bt.requested_state<>'running')";
const noPending =
  "NOT EXISTS (SELECT 1 FROM operations o WHERE o.environment_id=? AND o.status IN ('queued','running') AND o.kind IN ('environment.create','environment.suspend')) " +
  "AND NOT EXISTS (SELECT 1 FROM role_operations o JOIN database_roles r ON r.id=o.role_id WHERE r.environment_id=? AND o.status IN ('queued','running')) " +
  "AND NOT EXISTS (SELECT 1 FROM database_operations o JOIN logical_databases d ON d.id=o.database_id WHERE d.environment_id=? AND o.status IN ('queued','running')) " +
  "AND NOT EXISTS (SELECT 1 FROM backup_operations o JOIN environment_backups b ON b.id=o.backup_id WHERE b.environment_id=? AND o.status IN ('queued','running')) " +
  "AND NOT EXISTS (SELECT 1 FROM resize_operations o WHERE o.environment_id=? AND o.status IN ('queued','running'))";

function policyFor(environment: EnvironmentRow): SizePolicy | null {
  try {
    const spec = JSON.parse(environment.resolved_spec) as {
      profile?: { computeScaling?: SizePolicy };
    };
    const policy = spec.profile?.computeScaling;
    return policy?.version === 1 && Array.isArray(policy.sizes) ? policy : null;
  } catch {
    return null;
  }
}
function publicCompute(
  environmentId: string,
  initialSizeId: string,
  row: ComputeRow | null,
) {
  return {
    environmentId,
    revision: row?.revision ?? 0,
    requestedSizeId: row?.requested_size_id ?? initialSizeId,
    effectiveSizeId: row?.effective_size_id ?? initialSizeId,
    phase: row?.phase ?? "effective",
    operationId: row?.operation_id ?? null,
    updatedAt: row?.updated_at ?? null,
    observedAt: row?.observed_at ?? null,
  };
}
export function publicResizeOperation(
  row: Pick<
    ResizeOperation,
    | "id"
    | "kind"
    | "cause"
    | "status"
    | "compute_revision"
    | "from_size_id"
    | "target_size_id"
    | "created_at"
    | "observed_at"
    | "result_code"
  >,
) {
  return {
    id: row.id,
    kind: row.kind,
    cause: row.cause,
    status: row.status,
    computeRevision: row.compute_revision,
    fromSizeId: row.from_size_id,
    targetSizeId: row.target_size_id,
    createdAt: row.created_at,
    observedAt: row.observed_at,
    resultCode: row.result_code,
  };
}
async function ownedEnvironment(
  db: AccountingDb,
  actor: Actor,
  organizationId: string,
  projectId: string,
  environmentId: string,
) {
  return db
    .prepare(
      `SELECT e.*,p.status AS project_status,g.status AS region_status,COALESCE(rt.revision,0) AS runtime_revision FROM environments e JOIN projects p ON p.id=e.project_id AND p.organization_id=e.organization_id JOIN regions g ON g.id=e.region_id LEFT JOIN environment_runtime rt ON rt.environment_id=e.id WHERE e.id=? AND e.organization_id=? AND e.project_id=? AND ${actorPredicate(actor)}`,
    )
    .bind(environmentId, organizationId, projectId, ...actorBindings(actor))
    .first<OwnedEnvironment>();
}
async function readState(db: AccountingDb, environmentId: string) {
  return db
    .prepare("SELECT * FROM environment_compute WHERE environment_id=?")
    .bind(environmentId)
    .first<ComputeRow>();
}
async function priorIntent(
  db: AccountingDb,
  actor: Actor,
  scope: string,
  key: string,
) {
  return db
    .prepare(
      `SELECT request_hash,response_json FROM resize_requests WHERE organization_id=? AND scope_key=? AND idempotency_key=? AND ${actorPredicate(actor)}`,
    )
    .bind(actor.ownerId, scope, key, ...actorBindings(actor))
    .first<{ request_hash: string; response_json: string }>();
}
function replay(
  row: { request_hash: string; response_json: string },
  requestHash: string,
) {
  return row.request_hash === requestHash
    ? json(JSON.parse(row.response_json) as unknown, 202)
    : error(409, "idempotency_conflict");
}
async function read(
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
  const environment = await ownedEnvironment(
    db,
    actor,
    organizationId,
    projectId,
    environmentId,
  );
  if (!environment) return error(404, "not_found");
  const policy = policyFor(environment);
  if (!policy) return error(409, "compute_scaling_unavailable");
  const state = await readState(db, environmentId);
  if (!state && environment.status !== "ready")
    return error(409, "environment_not_ready");
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${actorPredicate(actor)}`)
      .bind(...actorBindings(actor))
      .first())
  )
    return error(401, "unauthorized");
  return json({
    compute: publicCompute(environmentId, policy.initialSizeId, state),
  });
}
async function create(
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
    !fields(input, ["sizeId", "expectedRevision"]) ||
    typeof input.sizeId !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(input.sizeId) ||
    !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
  )
    return error(400, "invalid_request");
  const scope = new URL(request.url).pathname;
  const requestHash = await sha256(
    JSON.stringify({
      scope,
      sizeId: input.sizeId,
      expectedRevision: input.expectedRevision,
    }),
  );
  const previous = await priorIntent(db, actor, scope, key);
  if (previous) return replay(previous, requestHash);
  const environment = await ownedEnvironment(
    db,
    actor,
    organizationId,
    projectId,
    environmentId,
  );
  if (!environment) return error(404, "not_found");
  const policy = policyFor(environment);
  if (!policy) return error(409, "compute_scaling_unavailable");
  if (!policy.sizes.some((size) => size.id === input.sizeId))
    return error(400, "size_not_approved");
  const state = await readState(db, environmentId);
  if ((state?.revision ?? 0) !== input.expectedRevision)
    return error(409, "revision_conflict");
  if (state && state.phase !== "effective") return error(409, "resize_pending");
  const fromSizeId = state?.effective_size_id ?? policy.initialSizeId;
  if (input.sizeId === fromSizeId) return error(409, "size_already_effective");
  const resolved = JSON.parse(environment.resolved_spec) as {
    profile: {
      pooling?: unknown;
      nodeTracking?: unknown;
      nativeAccess?: unknown;
    };
  };
  const observed: unknown = JSON.parse(environment.observation_json ?? "null");
  if (
    environment.status !== "ready" ||
    environment.project_status !== "active" ||
    environment.region_status === "disabled" ||
    !integer(environment.runtime_revision, 0) ||
    !hash.test(environment.spec_hash) ||
    !validEnvironmentObservation(
      observed,
      resolved.profile.pooling !== undefined,
      environment.run_epoch ?? undefined,
      resolved.profile.nodeTracking !== undefined,
      resolved.profile.nativeAccess !== undefined,
    ) ||
    !uid(observed.clusterUid)
  )
    return error(409, "environment_not_ready");
  const at = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const next: ComputeRow = {
    environment_id: environmentId,
    revision: input.expectedRevision + 1,
    requested_size_id: input.sizeId,
    effective_size_id: fromSizeId,
    phase: "requested",
    operation_id: operationId,
    version_token: crypto.randomUUID(),
    updated_at: at,
    observed_at: null,
  };
  const operation: ResizeOperation = {
    id: operationId,
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    region_id: environment.region_id,
    kind: "environment.resize",
    cause: "manual",
    status: "queued",
    compute_revision: next.revision,
    from_size_id: fromSizeId,
    target_size_id: input.sizeId,
    created_at: at,
    observed_at: null,
    result_code: "awaiting_authority",
  };
  const response = {
    compute: publicCompute(environmentId, policy.initialSizeId, next),
    operation: {
      ...publicResizeOperation(operation),
      organizationId,
      projectId,
      environmentId,
    },
  };
  const statePredicate = state
    ? "EXISTS (SELECT 1 FROM environment_compute WHERE environment_id=? AND revision=? AND version_token=? AND phase='effective' AND effective_size_id=?)"
    : "NOT EXISTS (SELECT 1 FROM environment_compute WHERE environment_id=?)";
  const stateBindings: Array<string | number> = state
    ? [environmentId, state.revision, state.version_token, fromSizeId]
    : [environmentId];
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      assertion(db, statePredicate, stateBindings),
      assertion(
        db,
        `EXISTS (SELECT 1 FROM environments e JOIN projects p ON p.id=e.project_id AND p.organization_id=e.organization_id JOIN regions g ON g.id=e.region_id WHERE e.id=? AND e.organization_id=? AND e.project_id=? AND e.region_id=? AND e.status='ready' AND p.status='active' AND g.status<>'disabled' AND e.spec_revision=? AND e.spec_hash=? AND e.resolved_spec=? AND e.observation_json=? AND e.run_epoch IS ? AND COALESCE((SELECT revision FROM environment_runtime WHERE environment_id=e.id),0)=? AND ${runtimeAllowsExecution("e")} AND ${budgetRunning})`,
        [
          environmentId,
          organizationId,
          projectId,
          environment.region_id,
          environment.spec_revision,
          environment.spec_hash,
          environment.resolved_spec,
          environment.observation_json,
          environment.run_epoch,
          environment.runtime_revision,
        ],
      ),
      assertion(db, noPending, [
        environmentId,
        environmentId,
        environmentId,
        environmentId,
        environmentId,
      ]),
      db
        .prepare(
          "INSERT INTO resize_operations(id,organization_id,project_id,environment_id,region_id,kind,cause,status,spec_revision,spec_hash,spec_json,cluster_uid,run_epoch,runtime_revision,policy_hash,compute_revision,from_size_id,target_size_id,created_at,result_code) VALUES(?,?,?,?,?,'environment.resize','manual','queued',?,?,?,?,?,?,?,?,?,?,?,'awaiting_authority')",
        )
        .bind(
          operationId,
          organizationId,
          projectId,
          environmentId,
          environment.region_id,
          environment.spec_revision,
          environment.spec_hash,
          environment.resolved_spec,
          observed.clusterUid,
          environment.run_epoch,
          environment.runtime_revision,
          await sha256(JSON.stringify(policy)),
          next.revision,
          fromSizeId,
          input.sizeId,
          at,
        ),
      db
        .prepare(
          "INSERT INTO environment_compute(environment_id,organization_id,project_id,revision,requested_size_id,effective_size_id,phase,operation_id,version_token,updated_at) VALUES(?,?,?,?,?,?,'requested',?,?,?) ON CONFLICT(environment_id) DO UPDATE SET revision=excluded.revision,requested_size_id=excluded.requested_size_id,effective_size_id=excluded.effective_size_id,phase=excluded.phase,operation_id=excluded.operation_id,version_token=excluded.version_token,updated_at=excluded.updated_at,observed_at=NULL",
        )
        .bind(
          environmentId,
          organizationId,
          projectId,
          next.revision,
          input.sizeId,
          fromSizeId,
          operationId,
          next.version_token,
          at,
        ),
      db
        .prepare(
          "INSERT INTO resize_requests(organization_id,project_id,environment_id,scope_key,idempotency_key,request_hash,operation_id,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          organizationId,
          projectId,
          environmentId,
          scope,
          key,
          requestHash,
          operationId,
          JSON.stringify(response),
          at,
        ),
    ]);
  } catch {
    const winner = await priorIntent(db, actor, scope, key);
    return winner
      ? replay(winner, requestHash)
      : error(409, "resize_state_conflict");
  }
  return json(response, 202);
}

export async function resizeRoutes(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const match =
    /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/(compute|resize)$/.exec(
      path,
    );
  if (!match) return null;
  if (![match[1], match[2], match[3]].every(uid))
    return error(400, "invalid_request");
  if (new URL(request.url).search) return error(400, "invalid_request");
  const db = env.DB.withSession("first-primary");
  try {
    if (match[4] === "compute" && request.method === "GET")
      return await read(request, db, match[1]!, match[2]!, match[3]!);
    if (match[4] === "resize" && request.method === "POST")
      return await create(request, db, match[1]!, match[2]!, match[3]!);
    return null;
  } catch {
    return error(500, "resize_unavailable");
  }
}
