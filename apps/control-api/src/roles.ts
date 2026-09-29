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
  encryptCredential,
  newPassword,
  readRoleCredential as credential,
  roleCredentialContext as context,
  type RoleEnv,
} from "./role-credentials";
import {
  actorBindings,
  actorPredicate,
  authorize,
  idempotencyKey,
  integer,
  lease,
  leaseToken,
  rv,
  uid,
  type Actor,
} from "./execution-auth";
import { validEnvironmentObservation } from "./environments";
interface Target {
  organization_id: string;
  project_id: string;
  id: string;
  region_id: string;
  spec_revision: number;
  spec_hash: string;
  resolved_spec: string;
  observation_json: string;
}
export interface Role {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  spec_revision: number;
  spec_hash: string;
  cluster_uid: string;
  name: string;
  connection_limit: number;
  desired_credential_revision: number;
  applied_credential_revision: number;
  status: "pending" | "applied" | "failed";
  version_token: string;
  created_at: string;
  observed_at: string | null;
  observation_json: string | null;
}
interface Operation {
  id: string;
  role_id: string;
  credential_revision: number;
  kind: "database.role.apply";
  status: "queued" | "running" | "applied" | "failed";
  lease_actor_token_id: string | null;
  lease_token_hash: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  version_token: string;
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
interface Observation {
  namespaceUid: string;
  clusterUid: string;
  roleUid: string;
  roleGeneration: number;
  roleObservedGeneration: number;
  secretUid: string;
  secretResourceVersion: string;
  roleSecretResourceVersion: string;
  authenticatedUser: string;
  authenticatedDatabase: "app";
  writablePrimary: true;
  previousCredentialRejected: true | null;
}
const joins =
  "JOIN environments e ON e.id = r.environment_id JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id JOIN regions g ON g.id = r.region_id";
const currentScope =
  "e.organization_id = r.organization_id AND e.project_id = r.project_id AND e.region_id = r.region_id AND e.spec_revision = r.spec_revision AND e.spec_hash = r.spec_hash AND e.status = 'ready' AND json_extract(e.observation_json, '$.clusterUid') = r.cluster_uid AND p.status = 'active' AND g.status <> 'disabled'";
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
    !["app", "postgres", "streaming_replica"].includes(value) &&
    !/^(?:pg_|cnpg_)/.test(value)
  );
}
export function publicRole(role: Role) {
  return {
    id: role.id,
    organizationId: role.organization_id,
    projectId: role.project_id,
    environmentId: role.environment_id,
    regionId: role.region_id,
    name: role.name,
    connectionLimit: role.connection_limit,
    status: role.status,
    desiredCredentialRevision: role.desired_credential_revision,
    appliedCredentialRevision: role.applied_credential_revision,
    createdAt: role.created_at,
    observedAt: role.observed_at,
  };
}
export function publicOperation(
  operation: Pick<
    Operation,
    | "id"
    | "role_id"
    | "credential_revision"
    | "kind"
    | "status"
    | "created_at"
    | "observed_at"
    | "result_code"
  >,
) {
  return {
    id: operation.id,
    roleId: operation.role_id,
    credentialRevision: operation.credential_revision,
    kind: operation.kind,
    status: operation.status,
    createdAt: operation.created_at,
    observedAt: operation.observed_at,
    resultCode: operation.result_code,
  };
}
async function target(
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Target | null> {
  return db
    .prepare(
      "SELECT e.id, e.organization_id, e.project_id, e.region_id, e.spec_revision, e.spec_hash, e.resolved_spec, e.observation_json FROM environments e JOIN projects p ON p.id = e.project_id AND p.organization_id = e.organization_id JOIN regions g ON g.id = e.region_id WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND e.status = 'ready' AND p.status = 'active' AND g.status <> 'disabled'",
    )
    .bind(environmentId, organizationId, projectId)
    .first<Target>();
}
function targetAssertion(db: AccountingDb, role: Role): D1PreparedStatement {
  return assertion(
    db,
    "EXISTS (SELECT 1 FROM environments e JOIN projects p ON p.id = e.project_id AND p.organization_id = e.organization_id JOIN regions g ON g.id = e.region_id WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND e.region_id = ? AND e.spec_revision = ? AND e.spec_hash = ? AND json_extract(e.observation_json, '$.clusterUid') = ? AND e.status = 'ready' AND p.status = 'active' AND g.status <> 'disabled')",
    [
      role.environment_id,
      role.organization_id,
      role.project_id,
      role.region_id,
      role.spec_revision,
      role.spec_hash,
      role.cluster_uid,
    ],
  );
}
async function readRole(
  db: AccountingDb,
  roleId: string,
): Promise<Role | null> {
  return db
    .prepare("SELECT * FROM database_roles WHERE id = ?")
    .bind(roleId)
    .first<Role>();
}
async function readOperation(
  db: AccountingDb,
  operationId: string,
  regionId: string,
): Promise<Operation | null> {
  return db
    .prepare(
      "SELECT o.* FROM role_operations o JOIN database_roles r ON r.id = o.role_id WHERE o.id = ? AND r.region_id = ?",
    )
    .bind(operationId, regionId)
    .first<Operation>();
}
function newOperation(role: Role, at: string): Operation {
  return {
    id: crypto.randomUUID(),
    role_id: role.id,
    credential_revision: role.desired_credential_revision,
    kind: "database.role.apply",
    status: "queued",
    lease_actor_token_id: null,
    lease_token_hash: null,
    lease_epoch: 0,
    lease_expires_at: null,
    version_token: crypto.randomUUID(),
    created_at: at,
    observed_at: null,
    result_code: null,
    result_hash: null,
    observation_json: null,
  };
}
function operationInsert(
  db: AccountingDb,
  operation: Operation,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO role_operations (id, role_id, credential_revision, kind, status, version_token, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
    )
    .bind(
      operation.id,
      operation.role_id,
      operation.credential_revision,
      operation.kind,
      operation.version_token,
      operation.created_at,
    );
}
async function previousIntent(
  db: AccountingDb,
  actor: Actor,
  scope: string,
  key: string,
): Promise<Intent | null> {
  return db
    .prepare(
      `SELECT request_hash, response_json FROM role_requests WHERE organization_id = ? AND scope_key = ? AND idempotency_key = ? AND ${actorPredicate(actor)}`,
    )
    .bind(actor.ownerId, scope, key, ...actorBindings(actor))
    .first<Intent>();
}
function replay(intent: Intent, requestHash: string): Response {
  return intent.request_hash === requestHash
    ? json(JSON.parse(intent.response_json), 202)
    : error(409, "idempotency_conflict");
}
function intentInsert(
  db: AccountingDb,
  role: Role,
  operation: Operation,
  scope: string,
  key: string,
  requestHash: string,
  response: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO role_requests (organization_id, project_id, environment_id, scope_key, idempotency_key, request_hash, role_id, operation_id, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      role.organization_id,
      role.project_id,
      role.environment_id,
      scope,
      key,
      requestHash,
      role.id,
      operation.id,
      JSON.stringify(response),
      operation.created_at,
    );
}
async function createRole(
  request: Request,
  env: RoleEnv,
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
    !fields(input, ["name", "connectionLimit"]) ||
    !identifier(input.name) ||
    !integer(input.connectionLimit, 1, 1000)
  )
    return error(400, "invalid_request");
  const scope = new URL(request.url).pathname;
  const requestHash = await sha256(
    JSON.stringify({
      scope,
      name: input.name,
      connectionLimit: input.connectionLimit,
    }),
  );
  const prior = await previousIntent(db, actor, scope, key);
  if (prior) return replay(prior, requestHash);
  const current = await target(db, organizationId, projectId, environmentId);
  if (!current) return error(409, "environment_not_ready");
  const observation: unknown = JSON.parse(current.observation_json);
  const spec = JSON.parse(current.resolved_spec) as {
    profile: { pooling?: unknown };
  };
  if (
    !validEnvironmentObservation(
      observation,
      spec.profile.pooling !== undefined,
    ) ||
    !uid(observation.clusterUid)
  )
    return error(409, "environment_not_ready");
  const at = new Date().toISOString();
  const role: Role = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    region_id: current.region_id,
    spec_revision: current.spec_revision,
    spec_hash: current.spec_hash,
    cluster_uid: observation.clusterUid,
    name: input.name,
    connection_limit: input.connectionLimit,
    desired_credential_revision: 1,
    applied_credential_revision: 0,
    status: "pending",
    version_token: crypto.randomUUID(),
    created_at: at,
    observed_at: null,
    observation_json: null,
  };
  const encrypted = await encryptCredential(
    env,
    newPassword(),
    context(role, 1),
  );
  const operation = newOperation(role, at);
  const response = {
    role: publicRole(role),
    operation: publicOperation(operation),
  };
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      targetAssertion(db, role),
      db
        .prepare(
          "INSERT INTO database_roles (id, organization_id, project_id, environment_id, region_id, spec_revision, spec_hash, cluster_uid, name, connection_limit, desired_credential_revision, applied_credential_revision, status, version_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'pending', ?, ?)",
        )
        .bind(
          role.id,
          organizationId,
          projectId,
          environmentId,
          role.region_id,
          role.spec_revision,
          role.spec_hash,
          role.cluster_uid,
          role.name,
          role.connection_limit,
          role.version_token,
          at,
        ),
      db
        .prepare(
          "INSERT INTO role_credentials (role_id, credential_revision, encrypted_json, created_at) VALUES (?, 1, ?, ?)",
        )
        .bind(role.id, encrypted, at),
      operationInsert(db, operation),
      intentInsert(db, role, operation, scope, key, requestHash, response),
    ]);
  } catch {
    const winner = await previousIntent(db, actor, scope, key);
    if (winner) return replay(winner, requestHash);
    const duplicate = await db
      .prepare(
        "SELECT id FROM database_roles WHERE environment_id = ? AND name = ?",
      )
      .bind(environmentId, input.name)
      .first();
    return duplicate
      ? error(409, "role_name_conflict")
      : error(409, "role_conflict");
  }
  return json(response, 202);
}
async function scopedRole(
  db: AccountingDb,
  actor: Actor,
  roleId: string,
  projectId: string,
  environmentId: string,
): Promise<Role | null> {
  return db
    .prepare(
      `SELECT * FROM database_roles WHERE id = ? AND organization_id = ? AND project_id = ? AND environment_id = ? AND ${actorPredicate(actor)}`,
    )
    .bind(
      roleId,
      actor.ownerId,
      projectId,
      environmentId,
      ...actorBindings(actor),
    )
    .first<Role>();
}
async function customerRead(
  request: Request,
  env: RoleEnv,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
  roleId: string,
  reveal: boolean,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    reveal ? "projects:write" : "projects:read",
  );
  if (actor instanceof Response) return actor;
  const role = await scopedRole(db, actor, roleId, projectId, environmentId);
  if (!role) return error(404, "not_found");
  if (!reveal) return json({ role: publicRole(role) });
  if (
    role.status !== "applied" ||
    role.desired_credential_revision !== role.applied_credential_revision ||
    !role.observation_json
  )
    return error(409, "credential_not_applied");
  const password = await credential(
    db,
    role,
    role.desired_credential_revision,
    env,
  );
  const stable = await db
    .prepare(
      `SELECT 1 FROM database_roles r ${joins} WHERE r.id = ? AND r.version_token = ? AND r.status = 'applied' AND r.desired_credential_revision = ? AND r.applied_credential_revision = ? AND ${currentScope} AND ${actorPredicate(actor)}`,
    )
    .bind(
      role.id,
      role.version_token,
      role.desired_credential_revision,
      role.desired_credential_revision,
      ...actorBindings(actor),
    )
    .first();
  if (!stable) return error(409, "credential_not_applied");
  return json({
    credential: {
      roleId: role.id,
      credentialRevision: role.desired_credential_revision,
      username: role.name,
      password,
      database: "app",
      observedAt: role.observed_at,
    },
  });
}
async function rotateRole(
  request: Request,
  env: RoleEnv,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
  roleId: string,
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
    !fields(input, ["expectedCredentialRevision"]) ||
    !integer(input.expectedCredentialRevision, 1, Number.MAX_SAFE_INTEGER - 1)
  )
    return error(400, "invalid_request");
  const scope = new URL(request.url).pathname;
  const requestHash = await sha256(
    JSON.stringify({
      scope,
      expectedCredentialRevision: input.expectedCredentialRevision,
    }),
  );
  const prior = await previousIntent(db, actor, scope, key);
  if (prior) return replay(prior, requestHash);
  const current = await scopedRole(db, actor, roleId, projectId, environmentId);
  if (!current) return error(404, "not_found");
  if (
    current.status !== "applied" ||
    current.applied_credential_revision !== input.expectedCredentialRevision ||
    current.desired_credential_revision !== input.expectedCredentialRevision
  )
    return error(409, "credential_revision_conflict");
  const at = new Date().toISOString();
  const role: Role = {
    ...current,
    desired_credential_revision: current.desired_credential_revision + 1,
    status: "pending",
    version_token: crypto.randomUUID(),
  };
  const encrypted = await encryptCredential(
    env,
    newPassword(),
    context(role, role.desired_credential_revision),
  );
  const operation = newOperation(role, at);
  const response = {
    role: publicRole(role),
    operation: publicOperation(operation),
  };
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      targetAssertion(db, role),
      assertion(
        db,
        "EXISTS (SELECT 1 FROM database_roles WHERE id = ? AND version_token = ? AND status = 'applied' AND desired_credential_revision = ? AND applied_credential_revision = ?)",
        [
          role.id,
          current.version_token,
          input.expectedCredentialRevision,
          input.expectedCredentialRevision,
        ],
      ),
      assertion(
        db,
        "NOT EXISTS (SELECT 1 FROM database_operations WHERE owner_role_id = ? AND status IN ('queued', 'running'))",
        [role.id],
      ),
      db
        .prepare(
          "UPDATE database_roles SET desired_credential_revision = ?, status = 'pending', version_token = ? WHERE id = ? AND version_token = ?",
        )
        .bind(
          role.desired_credential_revision,
          role.version_token,
          role.id,
          current.version_token,
        ),
      db
        .prepare(
          "INSERT INTO role_credentials (role_id, credential_revision, encrypted_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(role.id, role.desired_credential_revision, encrypted, at),
      operationInsert(db, operation),
      intentInsert(db, role, operation, scope, key, requestHash, response),
    ]);
  } catch {
    const winner = await previousIntent(db, actor, scope, key);
    return winner
      ? replay(winner, requestHash)
      : error(409, "credential_revision_conflict");
  }
  return json(response, 202);
}
async function claim(
  request: Request,
  env: RoleEnv,
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
  const at = new Date().toISOString();
  const operation = await db
    .prepare(
      `SELECT o.* FROM role_operations o JOIN database_roles r ON r.id = o.role_id ${joins} WHERE r.region_id = ? AND r.status = 'pending' AND r.desired_credential_revision = o.credential_revision AND r.applied_credential_revision + 1 = o.credential_revision AND o.lease_epoch < 9007199254740991 AND (o.status = 'queued' OR (o.status = 'running' AND o.lease_expires_at <= ?)) AND ${currentScope} ORDER BY o.created_at, o.id LIMIT 1`,
    )
    .bind(regionId, at)
    .first<Operation>();
  if (!operation) return json({ claim: null });
  const role = await readRole(db, operation.role_id);
  if (!role) return error(409, "lease_conflict");
  const password = await credential(
    db,
    role,
    operation.credential_revision,
    env,
  );
  const previousPassword =
    operation.credential_revision > 1
      ? await credential(db, role, operation.credential_revision - 1, env)
      : null;
  const token = leaseToken();
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  const updated = await db
    .prepare(
      `UPDATE role_operations SET status = 'running', lease_actor_token_id = ?, lease_token_hash = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?, version_token = ? WHERE id = ? AND version_token = ? AND lease_epoch < 9007199254740991 AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?)) AND EXISTS (SELECT 1 FROM database_roles r ${joins} WHERE r.id = role_operations.role_id AND r.region_id = ? AND r.version_token = ? AND r.status = 'pending' AND r.desired_credential_revision = role_operations.credential_revision AND r.applied_credential_revision + 1 = role_operations.credential_revision AND ${currentScope}) AND ${actorPredicate(actor)} RETURNING *`,
    )
    .bind(
      actor.id,
      tokenHash,
      expiresAt,
      crypto.randomUUID(),
      operation.id,
      operation.version_token,
      now,
      regionId,
      role.version_token,
      ...actorBindings(actor),
    )
    .first<Operation>();
  if (!updated) return error(409, "lease_conflict");
  const stable = await db
    .prepare(
      `SELECT 1 FROM role_operations o JOIN database_roles r ON r.id = o.role_id ${joins} WHERE o.id = ? AND o.status = 'running' AND o.lease_actor_token_id = ? AND o.lease_token_hash = ? AND o.lease_epoch = ? AND o.lease_expires_at > ? AND r.version_token = ? AND r.desired_credential_revision = o.credential_revision AND ${currentScope} AND ${actorPredicate(actor)}`,
    )
    .bind(
      updated.id,
      actor.id,
      tokenHash,
      updated.lease_epoch,
      new Date().toISOString(),
      role.version_token,
      ...actorBindings(actor),
    )
    .first();
  if (!stable) return error(409, "lease_conflict");
  return json({
    claim: {
      schemaVersion: 1,
      kind: "database.role.apply",
      operationId: updated.id,
      organizationId: role.organization_id,
      projectId: role.project_id,
      environmentId: role.environment_id,
      regionId,
      specRevision: role.spec_revision,
      specHash: role.spec_hash,
      clusterUid: role.cluster_uid,
      roleId: role.id,
      roleName: role.name,
      connectionLimit: role.connection_limit,
      credentialRevision: updated.credential_revision,
      password,
      previousPassword,
      secretName: `pgcf-role-${role.id.replaceAll("-", "")}-v${updated.credential_revision}`,
      leaseToken: token,
      leaseEpoch: updated.lease_epoch,
      leaseExpiresAt: updated.lease_expires_at,
    },
  });
}
async function renew(
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
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  const changed = await db
    .prepare(
      `UPDATE role_operations SET lease_expires_at = ?, version_token = ? WHERE id = ? AND status = 'running' AND lease_actor_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM database_roles r ${joins} WHERE r.id = role_operations.role_id AND r.region_id = ? AND r.status = 'pending' AND r.desired_credential_revision = role_operations.credential_revision AND r.applied_credential_revision + 1 = role_operations.credential_revision AND ${currentScope}) AND ${actorPredicate(actor)} RETURNING id`,
    )
    .bind(
      expiresAt,
      crypto.randomUUID(),
      operationId,
      actor.id,
      await sha256(input.leaseToken),
      input.leaseEpoch,
      now,
      regionId,
      ...actorBindings(actor),
    )
    .first();
  return changed
    ? json({ leaseExpiresAt: expiresAt })
    : error(409, "lease_conflict");
}
function observation(
  value: unknown,
  role: Role,
  revision: number,
  comparePrevious = true,
): Observation | null {
  if (
    !fields(value, [
      "namespaceUid",
      "clusterUid",
      "roleUid",
      "roleGeneration",
      "roleObservedGeneration",
      "secretUid",
      "secretResourceVersion",
      "roleSecretResourceVersion",
      "authenticatedUser",
      "authenticatedDatabase",
      "writablePrimary",
      "previousCredentialRejected",
    ]) ||
    !uid(value.namespaceUid) ||
    value.clusterUid !== role.cluster_uid ||
    !uid(value.roleUid) ||
    !uid(value.secretUid) ||
    !integer(value.roleGeneration) ||
    value.roleObservedGeneration !== value.roleGeneration ||
    !rv(value.secretResourceVersion) ||
    value.roleSecretResourceVersion !== value.secretResourceVersion ||
    value.authenticatedUser !== role.name ||
    value.authenticatedDatabase !== "app" ||
    value.writablePrimary !== true ||
    value.previousCredentialRejected !== (revision > 1 ? true : null)
  )
    return null;
  if (comparePrevious && revision > 1) {
    if (!role.observation_json) return null;
    const prior = JSON.parse(role.observation_json) as Observation;
    if (
      value.namespaceUid !== prior.namespaceUid ||
      value.roleUid !== prior.roleUid ||
      value.secretUid === prior.secretUid ||
      value.roleGeneration <= prior.roleGeneration
    )
      return null;
  }
  return {
    namespaceUid: value.namespaceUid,
    clusterUid: role.cluster_uid,
    roleUid: value.roleUid,
    roleGeneration: value.roleGeneration,
    roleObservedGeneration: value.roleGeneration,
    secretUid: value.secretUid,
    secretResourceVersion: value.secretResourceVersion,
    roleSecretResourceVersion: value.secretResourceVersion,
    authenticatedUser: role.name,
    authenticatedDatabase: "app",
    writablePrimary: true,
    previousCredentialRejected: revision > 1 ? true : null,
  };
}
async function report(
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
    !lease(input)
  )
    return error(400, "invalid_request");
  const operation = await readOperation(db, operationId, regionId);
  if (!operation) return error(409, "lease_conflict");
  const role = await readRole(db, operation.role_id);
  if (!role) return error(409, "lease_conflict");
  const failed =
    input.status === "failed" &&
    [
      "ownership_mismatch",
      "spec_conflict",
      "credential_verification_failed",
    ].includes(input.resultCode as string) &&
    input.observation === null;
  // Old verified results are validated against their immutable recorded proof,
  // not against a newer role observation installed by a later credential task.
  let proof: Observation | null = null;
  if (input.status === "applied" && input.resultCode === "role_verified") {
    proof = observation(
      input.observation,
      role,
      operation.credential_revision,
      operation.status !== "applied",
    );
    if (!proof) return error(400, "invalid_observation");
  } else if (!failed) return error(400, "invalid_request");
  const resultHash = await sha256(
    JSON.stringify({
      status: input.status,
      resultCode: input.resultCode,
      observation: proof,
    }),
  );
  const tokenHash = await sha256(input.leaseToken);
  const exactReplay = async (): Promise<Operation | null> =>
    db
      .prepare(
        `SELECT o.* FROM role_operations o JOIN database_roles r ON r.id = o.role_id JOIN regions g ON g.id = r.region_id WHERE o.id = ? AND r.region_id = ? AND g.status <> 'disabled' AND o.status IN ('applied', 'failed') AND o.lease_actor_token_id = ? AND o.lease_token_hash = ? AND o.lease_epoch = ? AND o.result_hash = ? AND ${actorPredicate(actor)}`,
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
      .first<Operation>();
  const completed = await exactReplay();
  if (completed) return json({ operation: publicOperation(completed) });
  const now = new Date().toISOString();
  const status = failed ? "failed" : "applied";
  const results = await db.batch<Operation>([
    db
      .prepare(
        `UPDATE role_operations SET status = ?, observed_at = ?, result_code = ?, result_hash = ?, observation_json = ?, version_token = ? WHERE id = ? AND status = 'running' AND lease_actor_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM database_roles r ${joins} WHERE r.id = role_operations.role_id AND r.region_id = ? AND r.version_token = ? AND r.status = 'pending' AND r.desired_credential_revision = role_operations.credential_revision AND r.applied_credential_revision + 1 = role_operations.credential_revision AND ${currentScope}) AND ${actorPredicate(actor)} RETURNING *`,
      )
      .bind(
        status,
        now,
        input.resultCode,
        resultHash,
        proof ? JSON.stringify(proof) : null,
        crypto.randomUUID(),
        operationId,
        actor.id,
        tokenHash,
        input.leaseEpoch,
        now,
        regionId,
        role.version_token,
        ...actorBindings(actor),
      ),
    db
      .prepare(
        "UPDATE database_roles SET status = ?, applied_credential_revision = CASE WHEN ? = 'applied' THEN ? ELSE applied_credential_revision END, observed_at = ?, observation_json = CASE WHEN ? = 'applied' THEN ? ELSE observation_json END, version_token = ? WHERE id = ? AND version_token = ? AND status = 'pending' AND desired_credential_revision = ? AND applied_credential_revision + 1 = ? AND EXISTS (SELECT 1 FROM role_operations WHERE id = ? AND status = ? AND lease_actor_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND result_hash = ?)",
      )
      .bind(
        status,
        status,
        operation.credential_revision,
        now,
        status,
        proof ? JSON.stringify(proof) : null,
        crypto.randomUUID(),
        role.id,
        role.version_token,
        operation.credential_revision,
        operation.credential_revision,
        operationId,
        status,
        actor.id,
        tokenHash,
        input.leaseEpoch,
        resultHash,
      ),
  ]);
  const applied = results[0]!.results[0];
  if (applied) return json({ operation: publicOperation(applied) });
  const winner = await exactReplay();
  return winner
    ? json({ operation: publicOperation(winner) })
    : error(409, "lease_conflict");
}

export async function roleRoutes(
  request: Request,
  env: RoleEnv,
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const customer =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/roles(?:\/([^/]+)(?:\/(credentials|rotate))?)?$/.exec(
        url.pathname,
      );
    const regional =
      /^\/v1\/regions\/([^/]+)\/role-operations\/(claim|[^/]+\/(?:renew|result))$/.exec(
        url.pathname,
      );
    if (!customer && !regional) return null;
    if (url.searchParams.size > 0) return error(400, "invalid_request");
    const db = env.DB.withSession("first-primary");
    if (customer) {
      const [, organizationId, projectId, environmentId, roleId, action] =
        customer;
      if (
        ![
          organizationId,
          projectId,
          environmentId,
          ...(roleId ? [roleId] : []),
        ].every(uid)
      )
        return error(400, "invalid_request");
      if (request.method === "POST" && !roleId)
        return await createRole(
          request,
          env,
          db,
          organizationId!,
          projectId!,
          environmentId!,
        );
      if (
        request.method === "GET" &&
        roleId &&
        (!action || action === "credentials")
      )
        return await customerRead(
          request,
          env,
          db,
          organizationId!,
          projectId!,
          environmentId!,
          roleId,
          action === "credentials",
        );
      if (request.method === "POST" && roleId && action === "rotate")
        return await rotateRole(
          request,
          env,
          db,
          organizationId!,
          projectId!,
          environmentId!,
          roleId,
        );
      return null;
    }
    const regionId = regional![1]!;
    if (!uid(regionId)) return error(400, "invalid_request");
    if (request.method === "POST" && regional![2] === "claim")
      return await claim(request, env, db, regionId);
    const [operationId, action] = regional![2]!.split("/");
    if (!uid(operationId)) return null;
    if (request.method === "POST" && action === "renew")
      return await renew(request, db, regionId, operationId);
    if (request.method === "POST" && action === "result")
      return await report(request, db, regionId, operationId);
    return null;
  } catch (failure) {
    return failure instanceof Error &&
      failure.message.startsWith("role_credential")
      ? error(503, "role_credential_key_unavailable")
      : error(500, "role_unavailable");
  }
}
