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
  rv,
  uid,
  type Actor,
} from "./execution-auth";
import {
  readRoleCredential,
  type RoleCredentialIdentity,
  type RoleEnv,
} from "./role-credentials";

interface Owner extends RoleCredentialIdentity {
  desired_credential_revision: number;
  applied_credential_revision: number;
  status: string;
  version_token: string;
  observed_at: string | null;
  observation_json: string | null;
}
interface OwnerProof {
  namespaceUid: string;
  clusterUid: string;
  roleUid: string;
  roleGeneration: number;
  roleObservedGeneration: number;
  secretUid: string;
  secretResourceVersion: string;
  roleSecretResourceVersion: string;
  authenticatedUser: string;
  authenticatedDatabase: string;
  writablePrimary: true;
}
interface Database {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  spec_revision: number;
  spec_hash: string;
  namespace_uid: string;
  cluster_uid: string;
  name: string;
  owner_role_id: string;
  owner_role_name: string;
  owner_role_uid: string;
  owner_credential_revision: number;
  secret_uid: string;
  secret_resource_version: string;
  status: "pending" | "applied" | "failed";
  version_token: string;
  created_at: string;
  observed_at: string | null;
  observation_json: string | null;
}
interface Operation {
  id: string;
  database_id: string;
  owner_role_id: string;
  kind: "database.create";
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
interface Observation {
  namespaceUid: string;
  clusterUid: string;
  ownerRoleUid: string;
  ownerCredentialRevision: number;
  secretUid: string;
  secretResourceVersion: string;
  databaseUid: string;
  databaseGeneration: number;
  databaseObservedGeneration: number;
  databaseOid: string;
  authenticatedUser: string;
  authenticatedDatabase: string;
  writablePrimary: true;
  databaseOwned: true;
  schemaCreateVerified: true;
  probeRolledBack: true;
}
interface Intent {
  request_hash: string;
  response_json: string;
}

const joins =
  "JOIN database_roles r ON r.id = d.owner_role_id JOIN environments e ON e.id = d.environment_id JOIN projects p ON p.id = d.project_id AND p.organization_id = d.organization_id JOIN regions g ON g.id = d.region_id";
const currentOwner = `e.organization_id = d.organization_id AND e.project_id = d.project_id
  AND e.region_id = d.region_id AND e.spec_revision = d.spec_revision AND e.spec_hash = d.spec_hash
  AND e.status = 'ready' AND json_extract(e.observation_json, '$.clusterUid') = d.cluster_uid
  AND p.status = 'active' AND g.status <> 'disabled'
  AND r.organization_id = d.organization_id AND r.project_id = d.project_id AND r.environment_id = d.environment_id
  AND r.region_id = d.region_id AND r.spec_revision = d.spec_revision AND r.spec_hash = d.spec_hash
  AND r.cluster_uid = d.cluster_uid AND r.name = d.owner_role_name
  AND r.status = 'applied' AND r.desired_credential_revision = r.applied_credential_revision
  AND json_extract(r.observation_json, '$.namespaceUid') = d.namespace_uid
  AND json_extract(r.observation_json, '$.clusterUid') = d.cluster_uid
  AND json_extract(r.observation_json, '$.roleUid') = d.owner_role_uid
  AND json_extract(r.observation_json, '$.roleGeneration') = json_extract(r.observation_json, '$.roleObservedGeneration')
  AND json_extract(r.observation_json, '$.secretResourceVersion') = json_extract(r.observation_json, '$.roleSecretResourceVersion')`;
const initialOwner = `${currentOwner} AND r.desired_credential_revision = d.owner_credential_revision
  AND json_extract(r.observation_json, '$.secretUid') = d.secret_uid
  AND json_extract(r.observation_json, '$.secretResourceVersion') = d.secret_resource_version`;
function databaseName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
    !["app", "postgres", "template0", "template1"].includes(value) &&
    !/^(?:pg_|cnpg_)/.test(value)
  );
}
function ownerProof(owner: Owner): OwnerProof | null {
  if (
    !owner.observation_json ||
    owner.status !== "applied" ||
    owner.desired_credential_revision !== owner.applied_credential_revision
  )
    return null;
  const value: unknown = JSON.parse(owner.observation_json);
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
    value.clusterUid !== owner.cluster_uid ||
    !uid(value.roleUid) ||
    !integer(value.roleGeneration) ||
    value.roleObservedGeneration !== value.roleGeneration ||
    !uid(value.secretUid) ||
    !rv(value.secretResourceVersion) ||
    value.roleSecretResourceVersion !== value.secretResourceVersion ||
    value.authenticatedUser !== owner.name ||
    value.authenticatedDatabase !== "app" ||
    value.writablePrimary !== true
  )
    return null;
  return {
    namespaceUid: value.namespaceUid,
    clusterUid: owner.cluster_uid,
    roleUid: value.roleUid,
    roleGeneration: value.roleGeneration,
    roleObservedGeneration: value.roleGeneration,
    secretUid: value.secretUid,
    secretResourceVersion: value.secretResourceVersion,
    roleSecretResourceVersion: value.secretResourceVersion,
    authenticatedUser: owner.name,
    authenticatedDatabase: "app",
    writablePrimary: true,
  };
}
function publicDatabase(database: Database) {
  return {
    id: database.id,
    organizationId: database.organization_id,
    projectId: database.project_id,
    environmentId: database.environment_id,
    regionId: database.region_id,
    name: database.name,
    ownerRoleId: database.owner_role_id,
    status: database.status,
    createdAt: database.created_at,
    observedAt: database.observed_at,
    observation:
      database.observation_json === null
        ? null
        : (JSON.parse(database.observation_json) as Observation),
  };
}
function publicOperation(operation: Operation) {
  return {
    id: operation.id,
    databaseId: operation.database_id,
    kind: operation.kind,
    status: operation.status,
    createdAt: operation.created_at,
    observedAt: operation.observed_at,
    resultCode: operation.result_code,
  };
}
async function readOwner(
  db: AccountingDb,
  ownerId: string,
): Promise<Owner | null> {
  return db
    .prepare("SELECT * FROM database_roles WHERE id = ?")
    .bind(ownerId)
    .first<Owner>();
}
async function readDatabase(
  db: AccountingDb,
  id: string,
): Promise<Database | null> {
  return db
    .prepare("SELECT * FROM logical_databases WHERE id = ?")
    .bind(id)
    .first<Database>();
}
async function readOperation(
  db: AccountingDb,
  operationId: string,
  regionId: string,
): Promise<Operation | null> {
  return db
    .prepare(
      "SELECT o.* FROM database_operations o JOIN logical_databases d ON d.id = o.database_id WHERE o.id = ? AND d.region_id = ?",
    )
    .bind(operationId, regionId)
    .first<Operation>();
}
async function intent(
  db: AccountingDb,
  actor: Actor,
  scope: string,
  key: string,
): Promise<Intent | null> {
  return db
    .prepare(
      `SELECT request_hash, response_json FROM database_requests WHERE organization_id = ? AND scope_key = ? AND idempotency_key = ? AND ${actorPredicate(actor)}`,
    )
    .bind(actor.ownerId, scope, key, ...actorBindings(actor))
    .first<Intent>();
}
function replay(value: Intent, requestHash: string): Response {
  return value.request_hash === requestHash
    ? json(JSON.parse(value.response_json), 202)
    : error(409, "idempotency_conflict");
}
async function create(
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
    !fields(input, ["name", "ownerRoleId"]) ||
    !databaseName(input.name) ||
    !uid(input.ownerRoleId)
  )
    return error(400, "invalid_request");
  const scope = new URL(request.url).pathname;
  const requestHash = await sha256(
    JSON.stringify({ scope, name: input.name, ownerRoleId: input.ownerRoleId }),
  );
  const prior = await intent(db, actor, scope, key);
  if (prior) return replay(prior, requestHash);
  const owner = await db
    .prepare(
      `SELECT r.* FROM database_roles r WHERE r.id = ? AND r.organization_id = ? AND r.project_id = ? AND r.environment_id = ? AND ${actorPredicate(actor)}`,
    )
    .bind(
      input.ownerRoleId,
      organizationId,
      projectId,
      environmentId,
      ...actorBindings(actor),
    )
    .first<Owner>();
  if (!owner) return error(404, "not_found");
  const proof = ownerProof(owner);
  if (!proof) return error(409, "owner_not_applied");
  await readRoleCredential(db, owner, owner.desired_credential_revision, env);
  const at = new Date().toISOString();
  const database: Database = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    region_id: owner.region_id,
    spec_revision: owner.spec_revision,
    spec_hash: owner.spec_hash,
    namespace_uid: proof.namespaceUid,
    cluster_uid: owner.cluster_uid,
    name: input.name,
    owner_role_id: owner.id,
    owner_role_name: owner.name,
    owner_role_uid: proof.roleUid,
    owner_credential_revision: owner.applied_credential_revision,
    secret_uid: proof.secretUid,
    secret_resource_version: proof.secretResourceVersion,
    status: "pending",
    version_token: crypto.randomUUID(),
    created_at: at,
    observed_at: null,
    observation_json: null,
  };
  const operation: Operation = {
    id: crypto.randomUUID(),
    database_id: database.id,
    owner_role_id: owner.id,
    kind: "database.create",
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
  const response = {
    database: publicDatabase(database),
    operation: publicOperation(operation),
  };
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      assertion(
        db,
        `EXISTS (SELECT 1 FROM database_roles r JOIN environments e ON e.id = r.environment_id JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id JOIN regions g ON g.id = r.region_id WHERE r.id = ? AND r.version_token = ? AND r.organization_id = ? AND r.project_id = ? AND r.environment_id = ? AND r.status = 'applied' AND r.desired_credential_revision = ? AND r.applied_credential_revision = ? AND r.spec_revision = e.spec_revision AND r.spec_hash = e.spec_hash AND r.region_id = e.region_id AND e.organization_id = r.organization_id AND e.project_id = r.project_id AND e.status = 'ready' AND json_extract(e.observation_json, '$.clusterUid') = ? AND p.status = 'active' AND g.status <> 'disabled' AND NOT EXISTS (SELECT 1 FROM role_operations WHERE role_id = r.id AND status IN ('queued', 'running')))`,
        [
          owner.id,
          owner.version_token,
          organizationId,
          projectId,
          environmentId,
          owner.desired_credential_revision,
          owner.desired_credential_revision,
          owner.cluster_uid,
        ],
      ),
      db
        .prepare(
          "INSERT INTO logical_databases (id, organization_id, project_id, environment_id, region_id, spec_revision, spec_hash, namespace_uid, cluster_uid, name, owner_role_id, owner_role_name, owner_role_uid, owner_credential_revision, secret_uid, secret_resource_version, status, version_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .bind(
          database.id,
          organizationId,
          projectId,
          environmentId,
          database.region_id,
          database.spec_revision,
          database.spec_hash,
          database.namespace_uid,
          database.cluster_uid,
          database.name,
          owner.id,
          database.owner_role_name,
          database.owner_role_uid,
          database.owner_credential_revision,
          database.secret_uid,
          database.secret_resource_version,
          database.version_token,
          at,
        ),
      db
        .prepare(
          "INSERT INTO database_operations (id, database_id, owner_role_id, kind, status, version_token, created_at) VALUES (?, ?, ?, 'database.create', 'queued', ?, ?)",
        )
        .bind(operation.id, database.id, owner.id, operation.version_token, at),
      db
        .prepare(
          "INSERT INTO database_requests (organization_id, project_id, environment_id, scope_key, idempotency_key, request_hash, database_id, operation_id, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          organizationId,
          projectId,
          environmentId,
          scope,
          key,
          requestHash,
          database.id,
          operation.id,
          JSON.stringify(response),
          at,
        ),
    ]);
  } catch {
    const winner = await intent(db, actor, scope, key);
    if (winner) return replay(winner, requestHash);
    const duplicate = await db
      .prepare(
        `SELECT 1 FROM logical_databases WHERE environment_id = ? AND name = ? AND ${actorPredicate(actor)}`,
      )
      .bind(environmentId, input.name, ...actorBindings(actor))
      .first();
    return error(
      409,
      duplicate ? "database_name_conflict" : "database_conflict",
    );
  }
  return json(response, 202);
}
async function read(
  request: Request,
  env: RoleEnv,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
  databaseId: string,
  disclose: boolean,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    disclose ? "projects:write" : "projects:read",
  );
  if (actor instanceof Response) return actor;
  const database = await db
    .prepare(
      `SELECT * FROM logical_databases WHERE id = ? AND organization_id = ? AND project_id = ? AND environment_id = ? AND ${actorPredicate(actor)}`,
    )
    .bind(
      databaseId,
      organizationId,
      projectId,
      environmentId,
      ...actorBindings(actor),
    )
    .first<Database>();
  if (!database) return error(404, "not_found");
  if (!disclose) return json({ database: publicDatabase(database) });
  if (database.status !== "applied" || !database.observation_json)
    return error(409, "database_not_applied");
  const owner = await readOwner(db, database.owner_role_id);
  const proof = owner ? ownerProof(owner) : null;
  if (
    !owner ||
    !proof ||
    proof.roleUid !== database.owner_role_uid ||
    proof.namespaceUid !== database.namespace_uid ||
    proof.clusterUid !== database.cluster_uid
  )
    return error(409, "owner_not_applied");
  const password = await readRoleCredential(
    db,
    owner,
    owner.applied_credential_revision,
    env,
  );
  const stable = await db
    .prepare(
      `SELECT 1 FROM logical_databases d ${joins} WHERE d.id = ? AND d.version_token = ? AND d.status = 'applied' AND r.version_token = ? AND r.applied_credential_revision = ? AND ${currentOwner} AND ${actorPredicate(actor)}`,
    )
    .bind(
      database.id,
      database.version_token,
      owner.version_token,
      owner.applied_credential_revision,
      ...actorBindings(actor),
    )
    .first();
  if (!stable) return error(409, "credential_not_applied");
  return json({
    credential: {
      databaseId: database.id,
      ownerRoleId: owner.id,
      credentialRevision: owner.applied_credential_revision,
      username: owner.name,
      password,
      database: database.name,
      observedAt: database.observed_at,
      credentialVerifiedAt: owner.observed_at,
    },
  });
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
  const operation = await db
    .prepare(
      `SELECT o.* FROM database_operations o JOIN logical_databases d ON d.id = o.database_id ${joins} WHERE d.region_id = ? AND d.status = 'pending' AND o.lease_epoch < 9007199254740991 AND (o.status = 'queued' OR (o.status = 'running' AND o.lease_expires_at <= ?)) AND ${initialOwner} AND ${actorPredicate(actor)} ORDER BY o.created_at, o.id LIMIT 1`,
    )
    .bind(regionId, new Date().toISOString(), ...actorBindings(actor))
    .first<Operation>();
  if (!operation) return json({ claim: null });
  const database = await readDatabase(db, operation.database_id);
  if (!database) return error(409, "lease_conflict");
  const owner = await readOwner(db, database.owner_role_id);
  if (!owner) return error(409, "lease_conflict");
  const password = await readRoleCredential(
    db,
    owner,
    database.owner_credential_revision,
    env,
  );
  const token = leaseToken();
  const tokenHash = await sha256(token);
  const at = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  const updated = await db
    .prepare(
      `UPDATE database_operations SET status = 'running', lease_actor_token_id = ?, lease_token_hash = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?, version_token = ? WHERE id = ? AND version_token = ? AND lease_epoch < 9007199254740991 AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?)) AND EXISTS (SELECT 1 FROM logical_databases d ${joins} WHERE d.id = database_operations.database_id AND d.region_id = ? AND d.status = 'pending' AND d.version_token = ? AND r.version_token = ? AND ${initialOwner}) AND ${actorPredicate(actor)} RETURNING *`,
    )
    .bind(
      actor.id,
      tokenHash,
      expiresAt,
      crypto.randomUUID(),
      operation.id,
      operation.version_token,
      at,
      regionId,
      database.version_token,
      owner.version_token,
      ...actorBindings(actor),
    )
    .first<Operation>();
  if (!updated) return error(409, "lease_conflict");
  const stable = await db
    .prepare(
      `SELECT 1 FROM database_operations o JOIN logical_databases d ON d.id = o.database_id ${joins} WHERE o.id = ? AND o.status = 'running' AND o.lease_actor_token_id = ? AND o.lease_token_hash = ? AND o.lease_epoch = ? AND o.lease_expires_at > ? AND d.status = 'pending' AND d.version_token = ? AND r.version_token = ? AND ${initialOwner} AND ${actorPredicate(actor)}`,
    )
    .bind(
      updated.id,
      actor.id,
      tokenHash,
      updated.lease_epoch,
      new Date().toISOString(),
      database.version_token,
      owner.version_token,
      ...actorBindings(actor),
    )
    .first();
  if (!stable) return error(409, "lease_conflict");
  return json({
    claim: {
      schemaVersion: 1,
      kind: "database.create",
      operationId: updated.id,
      organizationId: database.organization_id,
      projectId: database.project_id,
      environmentId: database.environment_id,
      regionId,
      specRevision: database.spec_revision,
      specHash: database.spec_hash,
      namespaceUid: database.namespace_uid,
      clusterUid: database.cluster_uid,
      databaseId: database.id,
      databaseName: database.name,
      ownerRoleId: database.owner_role_id,
      ownerRoleName: database.owner_role_name,
      ownerRoleUid: database.owner_role_uid,
      ownerCredentialRevision: database.owner_credential_revision,
      secretUid: database.secret_uid,
      secretResourceVersion: database.secret_resource_version,
      password,
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
  const at = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + input.leaseSeconds * 1000,
  ).toISOString();
  const changed = await db
    .prepare(
      `UPDATE database_operations SET lease_expires_at = ?, version_token = ? WHERE id = ? AND status = 'running' AND lease_actor_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM logical_databases d ${joins} WHERE d.id = database_operations.database_id AND d.region_id = ? AND d.status = 'pending' AND ${initialOwner}) AND ${actorPredicate(actor)} RETURNING id`,
    )
    .bind(
      expiresAt,
      crypto.randomUUID(),
      operationId,
      actor.id,
      await sha256(input.leaseToken),
      input.leaseEpoch,
      at,
      regionId,
      ...actorBindings(actor),
    )
    .first();
  return changed
    ? json({ leaseExpiresAt: expiresAt })
    : error(409, "lease_conflict");
}
function observation(value: unknown, database: Database): Observation | null {
  if (
    !fields(value, [
      "namespaceUid",
      "clusterUid",
      "ownerRoleUid",
      "ownerCredentialRevision",
      "secretUid",
      "secretResourceVersion",
      "databaseUid",
      "databaseGeneration",
      "databaseObservedGeneration",
      "databaseOid",
      "authenticatedUser",
      "authenticatedDatabase",
      "writablePrimary",
      "databaseOwned",
      "schemaCreateVerified",
      "probeRolledBack",
    ]) ||
    value.namespaceUid !== database.namespace_uid ||
    value.clusterUid !== database.cluster_uid ||
    value.ownerRoleUid !== database.owner_role_uid ||
    value.ownerCredentialRevision !== database.owner_credential_revision ||
    value.secretUid !== database.secret_uid ||
    value.secretResourceVersion !== database.secret_resource_version ||
    !uid(value.databaseUid) ||
    !integer(value.databaseGeneration) ||
    value.databaseObservedGeneration !== value.databaseGeneration ||
    typeof value.databaseOid !== "string" ||
    !/^[1-9][0-9]{0,9}$/.test(value.databaseOid) ||
    BigInt(value.databaseOid) > 4_294_967_295n ||
    value.authenticatedUser !== database.owner_role_name ||
    value.authenticatedDatabase !== database.name ||
    value.writablePrimary !== true ||
    value.databaseOwned !== true ||
    value.schemaCreateVerified !== true ||
    value.probeRolledBack !== true
  )
    return null;
  return {
    namespaceUid: database.namespace_uid,
    clusterUid: database.cluster_uid,
    ownerRoleUid: database.owner_role_uid,
    ownerCredentialRevision: database.owner_credential_revision,
    secretUid: database.secret_uid,
    secretResourceVersion: database.secret_resource_version,
    databaseUid: value.databaseUid,
    databaseGeneration: value.databaseGeneration,
    databaseObservedGeneration: value.databaseGeneration,
    databaseOid: value.databaseOid,
    authenticatedUser: database.owner_role_name,
    authenticatedDatabase: database.name,
    writablePrimary: true,
    databaseOwned: true,
    schemaCreateVerified: true,
    probeRolledBack: true,
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
  const database = operation
    ? await readDatabase(db, operation.database_id)
    : null;
  if (!operation || !database) return error(409, "lease_conflict");
  const failed =
    input.status === "failed" &&
    [
      "ownership_mismatch",
      "spec_conflict",
      "database_name_conflict",
      "database_verification_failed",
    ].includes(input.resultCode as string) &&
    input.observation === null;
  const proof =
    input.status === "applied" && input.resultCode === "database_verified"
      ? observation(input.observation, database)
      : null;
  if (!failed && !proof) return error(400, "invalid_observation");
  const resultHash = await sha256(
    JSON.stringify({
      status: input.status,
      resultCode: input.resultCode,
      observation: proof,
    }),
  );
  const tokenHash = await sha256(input.leaseToken);
  const replayResult = () =>
    db
      .prepare(
        `SELECT o.* FROM database_operations o JOIN logical_databases d ON d.id = o.database_id JOIN regions g ON g.id = d.region_id WHERE o.id = ? AND d.region_id = ? AND g.status <> 'disabled' AND o.status IN ('applied', 'failed') AND o.lease_actor_token_id = ? AND o.lease_token_hash = ? AND o.lease_epoch = ? AND o.result_hash = ? AND ${actorPredicate(actor)}`,
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
  const prior = await replayResult();
  if (prior) return json({ operation: publicOperation(prior) });
  const at = new Date().toISOString();
  const status = failed ? "failed" : "applied";
  const updated = await db.batch<Operation>([
    db
      .prepare(
        `UPDATE database_operations SET status = ?, observed_at = ?, result_code = ?, result_hash = ?, observation_json = ?, version_token = ? WHERE id = ? AND status = 'running' AND lease_actor_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM logical_databases d ${joins} WHERE d.id = database_operations.database_id AND d.region_id = ? AND d.status = 'pending' AND d.version_token = ? AND ${initialOwner}) AND ${actorPredicate(actor)} RETURNING *`,
      )
      .bind(
        status,
        at,
        input.resultCode,
        resultHash,
        proof ? JSON.stringify(proof) : null,
        crypto.randomUUID(),
        operationId,
        actor.id,
        tokenHash,
        input.leaseEpoch,
        at,
        regionId,
        database.version_token,
        ...actorBindings(actor),
      ),
    db
      .prepare(
        "UPDATE logical_databases SET status = ?, observed_at = ?, observation_json = ?, version_token = ? WHERE id = ? AND status = 'pending' AND version_token = ? AND EXISTS (SELECT 1 FROM database_operations WHERE id = ? AND status = ? AND lease_actor_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND result_hash = ?)",
      )
      .bind(
        status,
        at,
        proof ? JSON.stringify(proof) : null,
        crypto.randomUUID(),
        database.id,
        database.version_token,
        operationId,
        status,
        actor.id,
        tokenHash,
        input.leaseEpoch,
        resultHash,
      ),
  ]);
  const applied = updated[0]!.results[0];
  if (applied) return json({ operation: publicOperation(applied) });
  const winner = await replayResult();
  return winner
    ? json({ operation: publicOperation(winner) })
    : error(409, "lease_conflict");
}
export async function databaseRoutes(
  request: Request,
  env: RoleEnv,
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const customer =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/databases(?:\/([^/]+)(?:\/(credentials))?)?$/.exec(
        url.pathname,
      );
    const regional =
      /^\/v1\/regions\/([^/]+)\/database-operations\/(claim|[^/]+\/(?:renew|result))$/.exec(
        url.pathname,
      );
    if (!customer && !regional) return null;
    if (url.searchParams.size > 0) return error(400, "invalid_request");
    const db = env.DB.withSession("first-primary");
    if (customer) {
      const [, organizationId, projectId, environmentId, databaseId, action] =
        customer;
      if (
        ![
          organizationId,
          projectId,
          environmentId,
          ...(databaseId ? [databaseId] : []),
        ].every(uid)
      )
        return error(400, "invalid_request");
      if (request.method === "POST" && !databaseId)
        return await create(
          request,
          env,
          db,
          organizationId!,
          projectId!,
          environmentId!,
        );
      if (request.method === "GET" && databaseId)
        return await read(
          request,
          env,
          db,
          organizationId!,
          projectId!,
          environmentId!,
          databaseId,
          action === "credentials",
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
      : error(500, "database_unavailable");
  }
}
