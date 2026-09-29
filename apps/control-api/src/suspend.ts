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
  lease,
  leaseToken,
  uid,
  type Actor,
} from "./execution-auth";
import {
  validEnvironmentObservation,
  validNodeCohortPointer,
  type EnvironmentRow,
} from "./environments";
import { operationFromRow } from "./execution-reads";

interface OwnedEnvironment extends EnvironmentRow {
  project_status: string;
  region_status: string;
}
interface RuntimeRow {
  environment_id: string;
  revision: number;
  desired_state: "running" | "suspended";
  phase: "running" | "suspending" | "suspended";
  operation_id: string;
  version_token: string;
  updated_at: string;
  observed_at: string | null;
  observation_json: string | null;
}
interface SuspendSpec {
  operation_id: string;
  environment_id: string;
  runtime_revision: number;
  spec_revision: number;
  spec_hash: string;
  spec_json: string;
  cluster_uid: string;
  pooler_json: string | null;
  created_at: string;
  run_epoch: string | null;
  node_cohort_json: string | null;
}
interface SuspendOperation {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  kind: "environment.suspend";
  status: "queued" | "running" | "succeeded";
  lease_actor_token_id: string | null;
  lease_token_hash: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  created_at: string;
  observed_at: string | null;
  result_code: string | null;
  result_hash: string | null;
  observation_json: string | null;
}
interface Intent {
  request_hash: string;
  response_json: string;
}
interface SuspendObservation {
  namespaceUid: string;
  clusterUid: string;
  quotaUid: string;
  volumesHash: string;
  pooler: { uid: string; deploymentUid: string } | null;
  computeAbsent: true;
  quotaPodsZero: true;
  clusterHibernated: true;
  poolerStopped: true;
  runEpoch?: string;
  nodeCohort?: { uid: string; hash: string };
}
const hash = /^[a-f0-9]{64}$/;
const environmentColumns =
  "e.*, p.status AS project_status, g.status AS region_status";
const environmentJoins =
  "JOIN projects p ON p.id = e.project_id AND p.organization_id = e.organization_id JOIN regions g ON g.id = e.region_id";

// Stop authority remains separate from the running predicate: accepting the
// intention closes admissions immediately, before regional work is complete.
function currentScope(operation: string): string {
  return (
    "EXISTS (SELECT 1 FROM environment_suspend_specs s JOIN environments e ON e.id = s.environment_id " +
    environmentJoins +
    " JOIN environment_runtime rt ON rt.environment_id = e.id WHERE s.operation_id = " +
    operation +
    ".id AND " +
    operation +
    ".kind = 'environment.suspend' AND e.id = " +
    operation +
    ".environment_id AND e.organization_id = " +
    operation +
    ".organization_id AND e.project_id = " +
    operation +
    ".project_id AND e.region_id = " +
    operation +
    ".region_id AND e.status = 'ready' " +
    "AND p.status = 'active' AND g.status <> 'disabled' AND e.spec_revision = s.spec_revision " +
    "AND e.spec_hash = s.spec_hash AND e.resolved_spec = s.spec_json " +
    "AND e.run_epoch IS s.run_epoch AND json_extract(e.observation_json, '$.runEpoch') IS e.run_epoch " +
    "AND json_extract(e.observation_json, '$.clusterUid') = s.cluster_uid " +
    "AND ((s.pooler_json IS NULL AND json_type(e.observation_json, '$.pooler') IS NULL) " +
    "OR (s.pooler_json IS NOT NULL AND json_extract(e.observation_json, '$.pooler.uid') = json_extract(s.pooler_json, '$.uid') " +
    "AND json_extract(e.observation_json, '$.pooler.deploymentUid') = json_extract(s.pooler_json, '$.deploymentUid'))) " +
    "AND ((s.node_cohort_json IS NULL AND json_type(e.observation_json, '$.nodeCohort') IS NULL) " +
    "OR (s.node_cohort_json IS NOT NULL AND json_extract(e.observation_json, '$.nodeCohort.uid') = json_extract(s.node_cohort_json, '$.uid') " +
    "AND json_extract(e.observation_json, '$.nodeCohort.hash') = json_extract(s.node_cohort_json, '$.hash'))) " +
    "AND rt.operation_id = " +
    operation +
    ".id AND rt.revision = s.runtime_revision " +
    "AND rt.desired_state = 'suspended' AND rt.phase = 'suspending')"
  );
}
async function ownedEnvironment(
  db: AccountingDb,
  actor: Actor,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<OwnedEnvironment | null> {
  return db
    .prepare(
      "SELECT " +
        environmentColumns +
        " FROM environments e " +
        environmentJoins +
        " WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND " +
        actorPredicate(actor),
    )
    .bind(environmentId, organizationId, projectId, ...actorBindings(actor))
    .first<OwnedEnvironment>();
}
async function runtimeRow(
  db: AccountingDb,
  environmentId: string,
): Promise<RuntimeRow | null> {
  return db
    .prepare("SELECT * FROM environment_runtime WHERE environment_id = ?")
    .bind(environmentId)
    .first<RuntimeRow>();
}
function publicRuntime(
  environment: EnvironmentRow,
  runtime: RuntimeRow | null,
) {
  return {
    environmentId: environment.id,
    revision: runtime?.revision ?? 0,
    desiredState: runtime?.desired_state ?? "running",
    phase:
      runtime?.phase ??
      (environment.status === "ready" ? "running" : "unknown"),
    operationId: runtime?.operation_id ?? null,
    updatedAt: runtime?.updated_at ?? null,
    observedAt: runtime?.observed_at ?? null,
    observation: runtime?.observation_json
      ? (JSON.parse(runtime.observation_json) as SuspendObservation)
      : null,
    ...(environment.run_epoch === null
      ? {}
      : { runEpoch: environment.run_epoch }),
  };
}
async function previousIntent(
  db: AccountingDb,
  actor: Actor,
  scope: string,
  key: string,
): Promise<Intent | null> {
  return db
    .prepare(
      "SELECT request_hash, response_json FROM environment_suspend_requests " +
        "WHERE organization_id = ? AND scope_key = ? AND idempotency_key = ? AND " +
        actorPredicate(actor),
    )
    .bind(actor.ownerId, scope, key, ...actorBindings(actor))
    .first<Intent>();
}
function replay(intent: Intent, requestHash: string): Response {
  return intent.request_hash === requestHash
    ? json(JSON.parse(intent.response_json), 202)
    : error(409, "idempotency_conflict");
}
async function readRuntime(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    "projects:read",
  );
  if (actor instanceof Response) return actor;
  const result = await db.batch([
    db
      .prepare("SELECT 1 AS authorized WHERE " + actorPredicate(actor))
      .bind(...actorBindings(actor)),
    db
      .prepare(
        "SELECT " +
          environmentColumns +
          " FROM environments e " +
          environmentJoins +
          " WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND " +
          actorPredicate(actor),
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
    db
      .prepare(
        "SELECT rt.* FROM environment_runtime rt JOIN environments e ON e.id = rt.environment_id " +
          "WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND " +
          actorPredicate(actor),
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
  ]);
  if (result[0]!.results.length !== 1) return error(401, "unauthorized");
  const environment = result[1]!.results[0] as OwnedEnvironment | undefined;
  if (!environment) return error(404, "not_found");
  return json({
    runtime: publicRuntime(
      environment,
      (result[2]!.results[0] as RuntimeRow | undefined) ?? null,
    ),
  });
}
async function createSuspend(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Response> {
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
    !fields(input, ["expectedRevision"]) ||
    !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
  )
    return error(400, "invalid_request");
  const scope = new URL(request.url).pathname;
  const requestHash = await sha256(
    JSON.stringify({ scope, expectedRevision: input.expectedRevision }),
  );
  const previous = await previousIntent(db, actor, scope, key);
  if (previous) return replay(previous, requestHash);
  const environment = await ownedEnvironment(
    db,
    actor,
    organizationId,
    projectId,
    environmentId,
  );
  if (!environment) return error(404, "not_found");
  if (
    environment.status !== "ready" ||
    environment.project_status !== "active" ||
    environment.region_status === "disabled"
  )
    return error(409, "environment_not_ready");
  const current = await runtimeRow(db, environmentId);
  if ((current?.revision ?? 0) !== input.expectedRevision)
    return error(409, "revision_conflict");
  if (
    current &&
    (current.desired_state !== "running" || current.phase !== "running")
  )
    return error(409, "environment_suspended");
  const spec: unknown = JSON.parse(environment.resolved_spec);
  if (
    !spec ||
    typeof spec !== "object" ||
    !("profile" in spec) ||
    !spec.profile ||
    typeof spec.profile !== "object" ||
    Array.isArray(spec.profile)
  )
    return error(409, "environment_not_ready");
  const pooled = Object.hasOwn(spec.profile, "pooling");
  const observed: unknown = JSON.parse(environment.observation_json ?? "null");
  if (
    !validEnvironmentObservation(
      observed,
      pooled,
      environment.run_epoch ?? undefined,
      Object.hasOwn(spec.profile, "nodeTracking"),
      Object.hasOwn(spec.profile, "nativeAccess"),
    ) ||
    !uid(observed.clusterUid) ||
    !hash.test(environment.spec_hash) ||
    !integer(environment.spec_revision)
  )
    return error(409, "environment_not_ready");
  const pooler = observed.pooler
    ? { uid: observed.pooler.uid, deploymentUid: observed.pooler.deploymentUid }
    : null;
  const operationId = crypto.randomUUID(),
    revision = input.expectedRevision + 1,
    at = new Date().toISOString();
  const operation: SuspendOperation = {
    id: operationId,
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    region_id: environment.region_id,
    kind: "environment.suspend",
    status: "queued",
    lease_actor_token_id: null,
    lease_token_hash: null,
    lease_epoch: 0,
    lease_expires_at: null,
    created_at: at,
    observed_at: null,
    result_code: null,
    result_hash: null,
    observation_json: null,
  };
  const nextRuntime: RuntimeRow = {
    environment_id: environmentId,
    revision,
    desired_state: "suspended",
    phase: "suspending",
    operation_id: operationId,
    version_token: crypto.randomUUID(),
    updated_at: at,
    observed_at: null,
    observation_json: null,
  };
  const response = {
    runtime: publicRuntime(environment, nextRuntime),
    operation: operationFromRow(operation),
  };
  const statePredicate = current
    ? "EXISTS (SELECT 1 FROM environment_runtime WHERE environment_id = ? AND revision = ? AND version_token = ? AND desired_state = 'running' AND phase = 'running')"
    : "NOT EXISTS (SELECT 1 FROM environment_runtime WHERE environment_id = ?)";
  const stateBindings: Array<string | number> = current
    ? [environmentId, current.revision, current.version_token]
    : [environmentId];
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      assertion(db, statePredicate, stateBindings),
      assertion(
        db,
        "EXISTS (SELECT 1 FROM environments e " +
          environmentJoins +
          " WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND e.region_id = ? " +
          "AND e.status = 'ready' AND p.status = 'active' AND g.status <> 'disabled' " +
          "AND e.spec_revision = ? AND e.spec_hash = ? AND e.resolved_spec = ? AND e.observation_json = ? AND e.run_epoch IS ?)",
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
        ],
      ),
      assertion(
        db,
        "NOT EXISTS (SELECT 1 FROM operations WHERE environment_id = ? AND kind = 'environment.create' AND status IN ('queued','running')) " +
          "AND NOT EXISTS (SELECT 1 FROM role_operations o JOIN database_roles r ON r.id = o.role_id WHERE r.environment_id = ? AND o.status IN ('queued','running')) " +
          "AND NOT EXISTS (SELECT 1 FROM database_operations o JOIN logical_databases d ON d.id = o.database_id WHERE d.environment_id = ? AND o.status IN ('queued','running'))",
        [environmentId, environmentId, environmentId],
      ),
      db
        .prepare(
          "INSERT INTO operations (id, organization_id, project_id, environment_id, region_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?, 'environment.suspend', 'queued', ?)",
        )
        .bind(
          operationId,
          organizationId,
          projectId,
          environmentId,
          environment.region_id,
          at,
        ),
      db
        .prepare(
          "INSERT INTO environment_suspend_specs (operation_id, environment_id, runtime_revision, spec_revision, spec_hash, spec_json, cluster_uid, pooler_json, created_at, run_epoch, node_cohort_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          operationId,
          environmentId,
          revision,
          environment.spec_revision,
          environment.spec_hash,
          environment.resolved_spec,
          observed.clusterUid,
          pooler ? JSON.stringify(pooler) : null,
          at,
          environment.run_epoch,
          observed.nodeCohort ? JSON.stringify(observed.nodeCohort) : null,
        ),
      db
        .prepare(
          "INSERT INTO environment_runtime (environment_id, revision, desired_state, phase, operation_id, version_token, updated_at) VALUES (?, ?, 'suspended', 'suspending', ?, ?, ?) " +
            "ON CONFLICT(environment_id) DO UPDATE SET revision=excluded.revision, desired_state=excluded.desired_state, phase=excluded.phase, operation_id=excluded.operation_id, " +
            "version_token=excluded.version_token, updated_at=excluded.updated_at, observed_at=NULL, observation_json=NULL",
        )
        .bind(
          environmentId,
          revision,
          operationId,
          nextRuntime.version_token,
          at,
        ),
      db
        .prepare(
          "INSERT INTO environment_suspend_requests (organization_id, project_id, environment_id, scope_key, idempotency_key, request_hash, operation_id, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    const winner = await previousIntent(db, actor, scope, key);
    return winner
      ? replay(winner, requestHash)
      : error(409, "suspend_conflict");
  }
  return json(response, 202);
}
async function operationRow(
  db: AccountingDb,
  id: string,
  regionId: string,
): Promise<SuspendOperation | null> {
  return db
    .prepare(
      "SELECT * FROM operations WHERE id = ? AND region_id = ? AND kind = 'environment.suspend'",
    )
    .bind(id, regionId)
    .first<SuspendOperation>();
}
async function snapshotRow(
  db: AccountingDb,
  id: string,
): Promise<SuspendSpec | null> {
  return db
    .prepare("SELECT * FROM environment_suspend_specs WHERE operation_id = ?")
    .bind(id)
    .first<SuspendSpec>();
}
async function claimSuspend(
  request: Request,
  db: AccountingDb,
  regionId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "region",
    regionId,
    "operations:claim",
  );
  if (actor instanceof Response) return actor;
  const input = await body(request);
  if (!fields(input, ["leaseSeconds"]) || !integer(input.leaseSeconds, 30, 300))
    return error(400, "invalid_request");
  const now = new Date().toISOString();
  const selected = await db
    .prepare(
      "SELECT o.* FROM operations o WHERE o.region_id = ? AND o.kind = 'environment.suspend' " +
        "AND o.lease_epoch < 9007199254740991 AND (o.status='queued' OR (o.status='running' AND o.lease_expires_at <= ?)) AND " +
        currentScope("o") +
        " AND " +
        actorPredicate(actor) +
        " ORDER BY o.created_at,o.id LIMIT 1",
    )
    .bind(regionId, now, ...actorBindings(actor))
    .first<SuspendOperation>();
  if (!selected) return json({ claim: null });
  const snapshot = await snapshotRow(db, selected.id);
  if (!snapshot) return error(409, "lease_conflict");
  const token = leaseToken(),
    tokenHash = await sha256(token);
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  const updated = await db
    .prepare(
      "UPDATE operations SET status='running',lease_actor_token_id=?,lease_token_hash=?,lease_epoch=lease_epoch+1,lease_expires_at=? " +
        "WHERE id=? AND region_id=? AND kind='environment.suspend' AND lease_epoch < 9007199254740991 " +
        "AND (status='queued' OR (status='running' AND lease_expires_at<=?)) AND " +
        currentScope("operations") +
        " AND " +
        actorPredicate(actor) +
        " RETURNING *",
    )
    .bind(
      actor.id,
      tokenHash,
      expiresAt,
      selected.id,
      regionId,
      now,
      ...actorBindings(actor),
    )
    .first<SuspendOperation>();
  if (!updated) return error(409, "lease_conflict");
  const stable = await db
    .prepare(
      "SELECT 1 FROM operations o WHERE o.id=? AND o.region_id=? AND o.status='running' AND o.lease_actor_token_id=? " +
        "AND o.lease_token_hash=? AND o.lease_epoch=? AND o.lease_expires_at>? AND " +
        currentScope("o") +
        " AND " +
        actorPredicate(actor),
    )
    .bind(
      updated.id,
      regionId,
      actor.id,
      tokenHash,
      updated.lease_epoch,
      new Date().toISOString(),
      ...actorBindings(actor),
    )
    .first();
  if (!stable) return error(409, "lease_conflict");
  return json({
    claim: {
      schemaVersion: 1,
      kind: "environment.suspend",
      operationId: updated.id,
      organizationId: updated.organization_id,
      projectId: updated.project_id,
      environmentId: updated.environment_id,
      regionId,
      runtimeRevision: snapshot.runtime_revision,
      specRevision: snapshot.spec_revision,
      specHash: snapshot.spec_hash,
      clusterUid: snapshot.cluster_uid,
      pooler: snapshot.pooler_json ? JSON.parse(snapshot.pooler_json) : null,
      leaseToken: token,
      leaseEpoch: updated.lease_epoch,
      leaseExpiresAt: expiresAt,
      ...(snapshot.run_epoch === null ? {} : { runEpoch: snapshot.run_epoch }),
      ...(snapshot.node_cohort_json === null
        ? {}
        : { nodeCohort: JSON.parse(snapshot.node_cohort_json) }),
    },
  });
}
async function renewSuspend(
  request: Request,
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "region",
    regionId,
    "operations:claim",
  );
  if (actor instanceof Response) return actor;
  const input = await body(request);
  if (
    !fields(input, ["leaseToken", "leaseEpoch", "leaseSeconds"]) ||
    !lease(input) ||
    !integer(input.leaseSeconds, 30, 300)
  )
    return error(400, "invalid_request");
  const now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
  const changed = await db
    .prepare(
      "UPDATE operations SET lease_expires_at=? WHERE id=? AND region_id=? AND kind='environment.suspend' " +
        "AND status='running' AND lease_actor_token_id=? AND lease_token_hash=? AND lease_epoch=? AND lease_expires_at>? AND " +
        currentScope("operations") +
        " AND " +
        actorPredicate(actor) +
        " RETURNING id",
    )
    .bind(
      expiresAt,
      operationId,
      regionId,
      actor.id,
      await sha256(input.leaseToken),
      input.leaseEpoch,
      now,
      ...actorBindings(actor),
    )
    .first();
  return changed
    ? json({ leaseExpiresAt: expiresAt })
    : error(409, "lease_conflict");
}
function suspendedObservation(
  value: unknown,
  snapshot: SuspendSpec,
): SuspendObservation | null {
  if (
    !fields(
      value,
      [
        "namespaceUid",
        "clusterUid",
        "quotaUid",
        "volumesHash",
        "pooler",
        "computeAbsent",
        "quotaPodsZero",
        "clusterHibernated",
        "poolerStopped",
      ],
      ["runEpoch", "nodeCohort"],
    ) ||
    Object.hasOwn(value, "runEpoch") !== (snapshot.run_epoch !== null) ||
    (snapshot.run_epoch !== null && value.runEpoch !== snapshot.run_epoch) ||
    Object.hasOwn(value, "nodeCohort") !==
      (snapshot.node_cohort_json !== null) ||
    (snapshot.node_cohort_json !== null &&
      (!validNodeCohortPointer(value.nodeCohort) ||
        value.nodeCohort.uid !== JSON.parse(snapshot.node_cohort_json).uid ||
        value.nodeCohort.hash !==
          JSON.parse(snapshot.node_cohort_json).hash)) ||
    !uid(value.namespaceUid) ||
    value.clusterUid !== snapshot.cluster_uid ||
    !uid(value.quotaUid) ||
    typeof value.volumesHash !== "string" ||
    !hash.test(value.volumesHash) ||
    value.computeAbsent !== true ||
    value.quotaPodsZero !== true ||
    value.clusterHibernated !== true ||
    value.poolerStopped !== true
  )
    return null;
  const expected: unknown = snapshot.pooler_json
    ? JSON.parse(snapshot.pooler_json)
    : null;
  let pooler: SuspendObservation["pooler"] = null;
  if (expected === null) {
    if (value.pooler !== null) return null;
  } else {
    if (
      !fields(expected, ["uid", "deploymentUid"]) ||
      !uid(expected.uid) ||
      !uid(expected.deploymentUid) ||
      !fields(value.pooler, ["uid", "deploymentUid"]) ||
      value.pooler.uid !== expected.uid ||
      value.pooler.deploymentUid !== expected.deploymentUid
    )
      return null;
    pooler = { uid: expected.uid, deploymentUid: expected.deploymentUid };
  }
  return {
    namespaceUid: value.namespaceUid,
    clusterUid: snapshot.cluster_uid,
    quotaUid: value.quotaUid,
    volumesHash: value.volumesHash,
    pooler,
    computeAbsent: true,
    quotaPodsZero: true,
    clusterHibernated: true,
    poolerStopped: true,
    ...(snapshot.run_epoch === null ? {} : { runEpoch: snapshot.run_epoch }),
    ...(snapshot.node_cohort_json === null
      ? {}
      : { nodeCohort: JSON.parse(snapshot.node_cohort_json) }),
  };
}
async function resultSuspend(
  request: Request,
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "region",
    regionId,
    "operations:report",
  );
  if (actor instanceof Response) return actor;
  const input = await body(request);
  if (
    !fields(input, [
      "leaseToken",
      "leaseEpoch",
      "status",
      "resultCode",
      "observation",
    ]) ||
    !lease(input) ||
    input.status !== "suspended" ||
    input.resultCode !== "compute_suspended"
  )
    return error(400, "invalid_request");
  const operation = await operationRow(db, operationId, regionId),
    snapshot = await snapshotRow(db, operationId);
  if (!operation || !snapshot) return error(409, "lease_conflict");
  const observation = suspendedObservation(input.observation, snapshot);
  if (!observation) return error(400, "invalid_observation");
  const resultHash = await sha256(
    JSON.stringify({
      status: input.status,
      resultCode: input.resultCode,
      observation,
    }),
  );
  const tokenHash = await sha256(input.leaseToken);
  const terminalReplay = () =>
    db
      .prepare(
        "SELECT o.* FROM operations o JOIN environments e ON e.id=o.environment_id " +
          "JOIN regions g ON g.id=o.region_id WHERE o.id=? AND o.region_id=? AND o.kind='environment.suspend' AND o.status='succeeded' " +
          "AND e.organization_id=o.organization_id AND e.project_id=o.project_id AND e.region_id=o.region_id AND g.status<>'disabled' " +
          "AND o.lease_actor_token_id=? AND o.lease_token_hash=? AND o.lease_epoch=? AND o.result_hash=? AND " +
          actorPredicate(actor),
      )
      .bind(
        operationId,
        regionId,
        actor.id,
        tokenHash,
        input.leaseEpoch,
        resultHash,
        ...actorBindings(actor),
      )
      .first<SuspendOperation>();
  const prior = await terminalReplay();
  if (prior) return json({ operation: operationFromRow(prior) });
  const runtime = await runtimeRow(db, snapshot.environment_id);
  if (
    !runtime ||
    runtime.operation_id !== operationId ||
    runtime.revision !== snapshot.runtime_revision
  )
    return error(409, "lease_conflict");
  const at = new Date().toISOString(),
    rawObservation = JSON.stringify(observation);
  let updated: D1Result<SuspendOperation>[];
  try {
    updated = await db.batch<SuspendOperation>([
      assertion(
        db,
        "EXISTS (SELECT 1 FROM environment_runtime WHERE environment_id=? AND operation_id=? " +
          "AND revision=? AND version_token=? AND desired_state='suspended' AND phase='suspending')",
        [
          snapshot.environment_id,
          operationId,
          snapshot.runtime_revision,
          runtime.version_token,
        ],
      ),
      db
        .prepare(
          "UPDATE operations SET status='succeeded',observed_at=?,result_code='compute_suspended',result_hash=?,observation_json=? " +
            "WHERE id=? AND region_id=? AND kind='environment.suspend' AND status='running' AND lease_actor_token_id=? " +
            "AND lease_token_hash=? AND lease_epoch=? AND lease_expires_at>? AND " +
            currentScope("operations") +
            " AND " +
            actorPredicate(actor) +
            " RETURNING *",
        )
        .bind(
          at,
          resultHash,
          rawObservation,
          operationId,
          regionId,
          actor.id,
          tokenHash,
          input.leaseEpoch,
          at,
          ...actorBindings(actor),
        ),
      db
        .prepare(
          "UPDATE environment_runtime SET phase='suspended',version_token=?,updated_at=?,observed_at=?,observation_json=? " +
            "WHERE environment_id=? AND operation_id=? AND revision=? AND version_token=? AND desired_state='suspended' AND phase='suspending' " +
            "AND EXISTS (SELECT 1 FROM operations WHERE id=? AND region_id=? AND kind='environment.suspend' AND status='succeeded' " +
            "AND lease_actor_token_id=? AND lease_token_hash=? AND lease_epoch=? AND result_hash=?)",
        )
        .bind(
          crypto.randomUUID(),
          at,
          at,
          rawObservation,
          snapshot.environment_id,
          operationId,
          snapshot.runtime_revision,
          runtime.version_token,
          operationId,
          regionId,
          actor.id,
          tokenHash,
          input.leaseEpoch,
          resultHash,
        ),
    ]);
  } catch {
    const winner = await terminalReplay();
    return winner
      ? json({ operation: operationFromRow(winner) })
      : error(409, "lease_conflict");
  }
  const applied = updated[1]!.results[0];
  if (applied && updated[2]!.meta.changes === 1)
    return json({ operation: operationFromRow(applied) });
  const winner = await terminalReplay();
  return winner
    ? json({ operation: operationFromRow(winner) })
    : error(409, "lease_conflict");
}
export async function suspendRoutes(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const customer =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/(runtime|suspend)$/.exec(
        url.pathname,
      );
    const regional =
      /^\/v1\/regions\/([^/]+)\/suspend-operations\/(claim|[^/]+\/(?:renew|result))$/.exec(
        url.pathname,
      );
    if (!customer && !regional) return null;
    if (url.searchParams.size) return error(400, "invalid_request");
    const db = env.DB.withSession("first-primary");
    if (customer) {
      const [, organizationId, projectId, environmentId, action] = customer;
      if (![organizationId, projectId, environmentId].every(uid))
        return error(400, "invalid_request");
      if (request.method === "GET" && action === "runtime")
        return await readRuntime(
          request,
          db,
          organizationId!,
          projectId!,
          environmentId!,
        );
      if (request.method === "POST" && action === "suspend")
        return await createSuspend(
          request,
          db,
          organizationId!,
          projectId!,
          environmentId!,
        );
      return null;
    }
    const regionId = regional![1]!;
    if (!uid(regionId)) return error(400, "invalid_request");
    if (request.method === "POST" && regional![2] === "claim")
      return await claimSuspend(request, db, regionId);
    const [operationId, action] = regional![2]!.split("/");
    if (!uid(operationId)) return error(400, "invalid_request");
    if (request.method === "POST" && action === "renew")
      return await renewSuspend(request, db, regionId, operationId);
    if (request.method === "POST" && action === "result")
      return await resultSuspend(request, db, regionId, operationId);
    return null;
  } catch {
    // An uncertain stop stays locked for observation; never echo private spec,
    // credentials, lease authority or database/provider exception bodies.
    return error(500, "suspend_unavailable");
  }
}
