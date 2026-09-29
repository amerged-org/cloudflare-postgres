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
import { runtimeAllowsExecution } from "./environment-runtime";
import {
  validEnvironmentObservation,
  type EnvironmentRow,
} from "./environments";

export interface Backup {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  spec_revision: number;
  spec_hash: string;
  spec_json: string;
  archive_hash: string;
  cluster_uid: string;
  run_epoch: string | null;
  runtime_revision: number;
  resource_name: string;
  status: "pending" | "completed" | "failed";
  version_token: string;
  created_at: string;
  observed_at: string | null;
  observation_json: string | null;
}
interface Operation {
  id: string;
  backup_id: string;
  kind: "environment.backup";
  status: "queued" | "running" | "completed" | "failed";
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
interface Binding {
  namespaceUid: string;
  clusterUid: string;
  specHash: string;
  objectStoreUid: string;
  objectStoreGeneration: number;
  objectStoreSpecHash: string;
  backupName: string;
  backupSpecHash: string;
}
interface DispatchRow {
  operation_id: string;
  backup_id: string;
  nonce: string;
  lease_actor_token_id: string;
  lease_token_hash: string;
  lease_epoch: number;
  binding_json: string;
  binding_hash: string;
  created_at: string;
}
interface Artifact {
  backupId: string;
  backupName: string;
  majorVersion: number;
  startedAt: string;
  stoppedAt: string;
  beginWal: string;
  endWal: string;
  beginLSN: string;
  endLSN: string;
  online: true;
  pluginMetadata: {
    timeline: string;
    version: "0.15.0";
    name: string;
    displayName: "BarmanCloudInstance";
    clusterUID: string;
    pluginName: string;
  };
}
interface Observation {
  namespaceUid: string;
  clusterUid: string;
  objectStoreUid: string;
  objectStoreGeneration: number;
  objectStoreSpecHash: string;
  backupResourceUid: string;
  backupResourceVersion: string;
  backupSpecHash: string;
  phase: "completed" | "failed";
  artifact: Artifact | null;
  remoteObjectsVerified: false;
  restoreVerified: false;
}
const plugin = "barman-cloud.cloudnative-pg.io",
  hash = /^[a-f0-9]{64}$/;
const joins =
  "JOIN environments e ON e.id=b.environment_id JOIN projects p ON p.id=b.project_id AND p.organization_id=b.organization_id JOIN regions g ON g.id=b.region_id";
const identity =
  "e.organization_id=b.organization_id AND e.project_id=b.project_id AND e.region_id=b.region_id AND e.spec_revision=b.spec_revision AND e.spec_hash=b.spec_hash AND e.resolved_spec=b.spec_json AND e.run_epoch IS b.run_epoch AND json_extract(e.observation_json,'$.clusterUid')=b.cluster_uid";
const budgetRunning =
  "NOT EXISTS (SELECT 1 FROM budget_targets bt WHERE bt.organization_id=e.organization_id AND bt.project_id=e.project_id AND (bt.environment_id IS NULL OR bt.environment_id=e.id) AND bt.requested_state<>'running')";
const currentWithoutBudget = `${identity} AND e.status='ready' AND p.status='active' AND g.status<>'disabled' AND ${runtimeAllowsExecution("e")} AND COALESCE((SELECT revision FROM environment_runtime WHERE environment_id=e.id),0)=b.runtime_revision`;
const current = `${currentWithoutBudget} AND ${budgetRunning}`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
async function specHash(): Promise<string> {
  return sha256(
    JSON.stringify(
      canonical({
        cluster: { name: "database" },
        target: "primary",
        method: "plugin",
        pluginConfiguration: { name: plugin },
      }),
    ),
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function time(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const n = Date.parse(value);
  if (!Number.isFinite(n)) return null;
  const normalized = new Date(n).toISOString();
  return normalized === value || normalized.replace(".000Z", "Z") === value
    ? normalized
    : null;
}
function lsn(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(value)
  );
}
function lsnNumber(value: string): bigint {
  const [a, b] = value.split("/");
  return (BigInt("0x" + a) << 32n) + BigInt("0x" + b);
}
export function publicBackup(b: Backup) {
  const observation = b.observation_json
    ? (JSON.parse(b.observation_json) as Observation)
    : null;
  const artifact = observation?.artifact;
  return {
    id: b.id,
    organizationId: b.organization_id,
    projectId: b.project_id,
    environmentId: b.environment_id,
    regionId: b.region_id,
    status: b.status,
    createdAt: b.created_at,
    observedAt: b.observed_at,
    artifact: artifact
      ? {
          backupId: artifact.backupId,
          backupName: artifact.backupName,
          majorVersion: artifact.majorVersion,
          startedAt: artifact.startedAt,
          stoppedAt: artifact.stoppedAt,
          beginWal: artifact.beginWal,
          endWal: artifact.endWal,
          beginLSN: artifact.beginLSN,
          endLSN: artifact.endLSN,
          online: true,
        }
      : null,
    remoteObjectsVerified: false,
    restoreVerified: false,
    PITRVerified: false,
  };
}
export function publicBackupOperation(
  o: Pick<
    Operation,
    | "id"
    | "backup_id"
    | "kind"
    | "status"
    | "created_at"
    | "observed_at"
    | "result_code"
  >,
) {
  return {
    id: o.id,
    backupId: o.backup_id,
    kind: o.kind,
    status: o.status,
    createdAt: o.created_at,
    observedAt: o.observed_at,
    resultCode: o.result_code,
  };
}
function dispatchValue(d: DispatchRow | null) {
  return d
    ? {
        version: 1,
        nonce: d.nonce,
        leaseEpoch: d.lease_epoch,
        binding: JSON.parse(d.binding_json) as Binding,
      }
    : null;
}
const readBackup = (db: AccountingDb, id: string) =>
  db
    .prepare("SELECT * FROM environment_backups WHERE id=?")
    .bind(id)
    .first<Backup>();
const readOperation = (db: AccountingDb, id: string, regionId: string) =>
  db
    .prepare(
      "SELECT o.* FROM backup_operations o JOIN environment_backups b ON b.id=o.backup_id WHERE o.id=? AND b.region_id=?",
    )
    .bind(id, regionId)
    .first<Operation>();
const readDispatch = (db: AccountingDb, id: string) =>
  db
    .prepare("SELECT * FROM backup_dispatches WHERE operation_id=?")
    .bind(id)
    .first<DispatchRow>();
function guard(
  actor: Actor,
  regionId: string,
  operationId: string,
  tokenHash: string,
  epoch: number,
  at: string,
  requireRunning = true,
) {
  return {
    predicate: `EXISTS (SELECT 1 FROM backup_operations o JOIN environment_backups b ON b.id=o.backup_id ${joins} WHERE o.id=? AND b.region_id=? AND o.status='running' AND b.status='pending' AND o.lease_actor_token_id=? AND o.lease_token_hash=? AND o.lease_epoch=? AND o.lease_expires_at>? AND ${requireRunning ? current : currentWithoutBudget} AND ${actorPredicate(actor)})`,
    bindings: [
      operationId,
      regionId,
      actor.id,
      tokenHash,
      epoch,
      at,
      ...actorBindings(actor),
    ],
  };
}
async function intent(
  db: AccountingDb,
  actor: Actor,
  scope: string,
  key: string,
) {
  return db
    .prepare(
      `SELECT request_hash,response_json FROM backup_requests WHERE organization_id=? AND scope_key=? AND idempotency_key=? AND ${actorPredicate(actor)}`,
    )
    .bind(actor.ownerId, scope, key, ...actorBindings(actor))
    .first<{ request_hash: string; response_json: string }>();
}
function replay(
  row: { request_hash: string; response_json: string },
  h: string,
) {
  return row.request_hash === h
    ? json(JSON.parse(row.response_json) as unknown, 202)
    : error(409, "idempotency_conflict");
}
async function create(
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
  if (!fields(await body(request), [])) return error(400, "invalid_request");
  const scope = new URL(request.url).pathname,
    h = await sha256(JSON.stringify({ scope }));
  const previous = await intent(db, actor, scope, key);
  if (previous) return replay(previous, h);
  const environment = await db
    .prepare(
      `SELECT e.*,COALESCE(rt.revision,0) AS runtime_revision,p.status AS project_status,g.status AS region_status FROM environments e JOIN projects p ON p.id=e.project_id AND p.organization_id=e.organization_id JOIN regions g ON g.id=e.region_id LEFT JOIN environment_runtime rt ON rt.environment_id=e.id WHERE e.id=? AND e.organization_id=? AND e.project_id=? AND ${actorPredicate(actor)}`,
    )
    .bind(environmentId, organizationId, projectId, ...actorBindings(actor))
    .first<
      EnvironmentRow & {
        runtime_revision: number;
        project_status: string;
        region_status: string;
      }
    >();
  if (!environment) return error(404, "not_found");
  const resolved = JSON.parse(environment.resolved_spec) as {
    profile: {
      backup: unknown;
      instances: number;
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
    !validEnvironmentObservation(
      observed,
      resolved.profile.pooling !== undefined,
      environment.run_epoch ?? undefined,
      resolved.profile.nodeTracking !== undefined,
      resolved.profile.nativeAccess !== undefined,
    ) ||
    !uid(observed.clusterUid) ||
    !resolved.profile.backup
  )
    return error(409, "environment_not_ready");
  const at = new Date().toISOString(),
    id = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const backup: Backup = {
    id,
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    region_id: environment.region_id,
    spec_revision: environment.spec_revision,
    spec_hash: environment.spec_hash,
    spec_json: environment.resolved_spec,
    archive_hash: await sha256(
      JSON.stringify(canonical(resolved.profile.backup)),
    ),
    cluster_uid: observed.clusterUid,
    run_epoch: environment.run_epoch,
    runtime_revision: environment.runtime_revision,
    resource_name: `backup-${id.replaceAll("-", "")}`,
    status: "pending",
    version_token: crypto.randomUUID(),
    created_at: at,
    observed_at: null,
    observation_json: null,
  };
  const operation = {
    id: operationId,
    backup_id: id,
    kind: "environment.backup" as const,
    status: "queued" as const,
    created_at: at,
    observed_at: null,
    result_code: null,
  };
  const response = {
    backup: publicBackup(backup),
    operation: publicBackupOperation(operation),
  };
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor)),
      assertion(
        db,
        `EXISTS (SELECT 1 FROM environments e JOIN projects p ON p.id=e.project_id AND p.organization_id=e.organization_id JOIN regions g ON g.id=e.region_id WHERE e.id=? AND e.organization_id=? AND e.project_id=? AND e.region_id=? AND e.status='ready' AND p.status='active' AND g.status<>'disabled' AND e.spec_revision=? AND e.spec_hash=? AND e.resolved_spec=? AND e.observation_json=? AND e.run_epoch IS ? AND COALESCE((SELECT revision FROM environment_runtime WHERE environment_id=e.id),0)=? AND ${runtimeAllowsExecution("e")} AND ${budgetRunning})`,
        [
          environmentId,
          organizationId,
          projectId,
          backup.region_id,
          backup.spec_revision,
          backup.spec_hash,
          backup.spec_json,
          environment.observation_json,
          backup.run_epoch,
          backup.runtime_revision,
        ],
      ),
      assertion(
        db,
        "NOT EXISTS (SELECT 1 FROM operations WHERE environment_id=? AND status IN ('queued','running') AND kind='environment.suspend') AND NOT EXISTS (SELECT 1 FROM backup_operations o JOIN environment_backups b ON b.id=o.backup_id WHERE b.environment_id=? AND o.status IN ('queued','running')) AND NOT EXISTS (SELECT 1 FROM resize_operations o WHERE o.environment_id=? AND o.status IN ('queued','running'))",
        [environmentId, environmentId, environmentId],
      ),
      db
        .prepare(
          "INSERT INTO environment_backups (id,organization_id,project_id,environment_id,region_id,spec_revision,spec_hash,spec_json,archive_hash,cluster_uid,run_epoch,runtime_revision,resource_name,status,version_token,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)",
        )
        .bind(
          id,
          organizationId,
          projectId,
          environmentId,
          backup.region_id,
          backup.spec_revision,
          backup.spec_hash,
          backup.spec_json,
          backup.archive_hash,
          backup.cluster_uid,
          backup.run_epoch,
          backup.runtime_revision,
          backup.resource_name,
          backup.version_token,
          at,
        ),
      db
        .prepare(
          "INSERT INTO backup_operations(id,backup_id,kind,status,version_token,created_at) VALUES (?,?,'environment.backup','queued',?,?)",
        )
        .bind(operationId, id, crypto.randomUUID(), at),
      db
        .prepare(
          "INSERT INTO backup_requests(organization_id,project_id,environment_id,scope_key,idempotency_key,request_hash,backup_id,operation_id,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          organizationId,
          projectId,
          environmentId,
          scope,
          key,
          h,
          id,
          operationId,
          JSON.stringify(response),
          at,
        ),
    ]);
  } catch {
    const winner = await intent(db, actor, scope, key);
    return winner ? replay(winner, h) : error(409, "backup_state_conflict");
  }
  return json(response, 202);
}
async function read(
  request: Request,
  db: AccountingDb,
  org: string,
  project: string,
  environment: string,
  id: string,
) {
  const actor = await authorize(
    request,
    db,
    "organization",
    org,
    "projects:read",
  );
  if (actor instanceof Response) return actor;
  const rows = await db.batch([
    db
      .prepare(`SELECT 1 WHERE ${actorPredicate(actor)}`)
      .bind(...actorBindings(actor)),
    db
      .prepare(
        `SELECT b.* FROM environment_backups b JOIN environments e ON e.id=b.environment_id AND e.organization_id=b.organization_id AND e.project_id=b.project_id JOIN projects p ON p.id=b.project_id AND p.organization_id=b.organization_id WHERE b.id=? AND b.organization_id=? AND b.project_id=? AND b.environment_id=? AND ${actorPredicate(actor)}`,
      )
      .bind(id, org, project, environment, ...actorBindings(actor)),
  ]);
  if (!rows[0]?.results.length) return error(401, "unauthorized");
  const b = rows[1]?.results[0] as unknown as Backup | undefined;
  return b ? json({ backup: publicBackup(b) }) : error(404, "not_found");
}
async function claim(request: Request, db: AccountingDb, regionId: string) {
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
  const o = await db
    .prepare(
      `SELECT o.* FROM backup_operations o JOIN environment_backups b ON b.id=o.backup_id ${joins} WHERE b.region_id=? AND b.status='pending' AND o.lease_epoch<9007199254740991 AND (o.status='queued' OR (o.status='running' AND o.lease_expires_at<=?)) AND ${current} AND ${actorPredicate(actor)} ORDER BY o.created_at,o.id LIMIT 1`,
    )
    .bind(regionId, at, ...actorBindings(actor))
    .first<Operation>();
  if (!o) return json({ claim: null });
  const token = leaseToken(),
    tokenHash = await sha256(token),
    expires = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
  const changed = await db
    .prepare(
      `UPDATE backup_operations SET status='running',lease_actor_token_id=?,lease_token_hash=?,lease_epoch=lease_epoch+1,lease_expires_at=?,version_token=? WHERE id=? AND version_token=? AND lease_epoch<9007199254740991 AND (status='queued' OR (status='running' AND lease_expires_at<=?)) AND EXISTS(SELECT 1 FROM environment_backups b ${joins} WHERE b.id=backup_operations.backup_id AND b.region_id=? AND b.status='pending' AND ${current}) AND ${actorPredicate(actor)} RETURNING *`,
    )
    .bind(
      actor.id,
      tokenHash,
      expires,
      crypto.randomUUID(),
      o.id,
      o.version_token,
      at,
      regionId,
      ...actorBindings(actor),
    )
    .first<Operation>();
  if (!changed) return error(409, "lease_conflict");
  const stable = guard(
    actor,
    regionId,
    o.id,
    tokenHash,
    changed.lease_epoch,
    new Date().toISOString(),
  );
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${stable.predicate}`)
      .bind(...stable.bindings)
      .first())
  )
    return error(409, "lease_conflict");
  const b = await readBackup(db, o.backup_id),
    d = await readDispatch(db, o.id);
  if (!b) return error(409, "lease_conflict");
  return json({
    claim: {
      schemaVersion: 1,
      kind: "environment.backup",
      operationId: o.id,
      backupId: b.id,
      organizationId: b.organization_id,
      projectId: b.project_id,
      environmentId: b.environment_id,
      regionId,
      specRevision: b.spec_revision,
      specHash: b.spec_hash,
      clusterUid: b.cluster_uid,
      runtimeRevision: b.runtime_revision,
      ...(b.run_epoch === null ? {} : { runEpoch: b.run_epoch }),
      spec: JSON.parse(b.spec_json) as unknown,
      dispatch: dispatchValue(d),
      leaseToken: token,
      leaseEpoch: changed.lease_epoch,
      leaseExpiresAt: changed.lease_expires_at,
    },
  });
}
async function renew(
  request: Request,
  db: AccountingDb,
  regionId: string,
  id: string,
) {
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
  const at = new Date().toISOString(),
    expires = new Date(Date.now() + input.leaseSeconds * 1000).toISOString(),
    g = guard(
      actor,
      regionId,
      id,
      await sha256(input.leaseToken),
      input.leaseEpoch,
      at,
    );
  const row = await db
    .prepare(
      `UPDATE backup_operations SET lease_expires_at=?,version_token=? WHERE id=? AND ${g.predicate} RETURNING id`,
    )
    .bind(expires, crypto.randomUUID(), id, ...g.bindings)
    .first();
  return row ? json({ leaseExpiresAt: expires }) : error(409, "lease_conflict");
}
async function binding(value: unknown, b: Backup): Promise<Binding | null> {
  if (
    !fields(value, [
      "namespaceUid",
      "clusterUid",
      "specHash",
      "objectStoreUid",
      "objectStoreGeneration",
      "objectStoreSpecHash",
      "backupName",
      "backupSpecHash",
    ]) ||
    !uid(value.namespaceUid) ||
    value.clusterUid !== b.cluster_uid ||
    value.specHash !== b.spec_hash ||
    !uid(value.objectStoreUid) ||
    !integer(value.objectStoreGeneration) ||
    typeof value.objectStoreSpecHash !== "string" ||
    !hash.test(value.objectStoreSpecHash) ||
    value.backupName !== b.resource_name ||
    value.backupSpecHash !== (await specHash())
  )
    return null;
  return value as unknown as Binding;
}
async function dispatch(
  request: Request,
  db: AccountingDb,
  regionId: string,
  id: string,
) {
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
    !fields(input, ["leaseToken", "leaseEpoch", "nonce", "binding"]) ||
    !lease(input) ||
    !uid(input.nonce)
  )
    return error(400, "invalid_request");
  const o = await readOperation(db, id, regionId),
    b = o ? await readBackup(db, o.backup_id) : null;
  if (!o || !b) return error(409, "lease_conflict");
  const bound = await binding(input.binding, b);
  if (!bound) return error(400, "invalid_observation");
  const tokenHash = await sha256(input.leaseToken),
    at = new Date().toISOString(),
    g = guard(actor, regionId, id, tokenHash, input.leaseEpoch, at);
  const bindingJson = JSON.stringify(canonical(bound)),
    bindingHash = await sha256(bindingJson);
  const existing = await readDispatch(db, id);
  if (existing) {
    if (
      existing.nonce !== input.nonce ||
      existing.lease_epoch !== input.leaseEpoch ||
      existing.lease_actor_token_id !== actor.id ||
      existing.lease_token_hash !== tokenHash ||
      existing.binding_hash !== bindingHash
    )
      return error(409, "dispatch_conflict");
    if (
      !(await db
        .prepare(`SELECT 1 WHERE ${g.predicate}`)
        .bind(...g.bindings)
        .first())
    )
      return error(409, "lease_conflict");
    return json({ dispatch: dispatchValue(existing), created: false });
  }
  try {
    await db.batch([
      assertion(db, g.predicate, g.bindings),
      db
        .prepare(
          "INSERT INTO backup_dispatches(operation_id,backup_id,nonce,lease_actor_token_id,lease_token_hash,lease_epoch,binding_json,binding_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          b.id,
          input.nonce,
          actor.id,
          tokenHash,
          input.leaseEpoch,
          bindingJson,
          bindingHash,
          at,
        ),
    ]);
  } catch {
    return error(409, "dispatch_conflict");
  }
  const saved = await readDispatch(db, id);
  if (!saved) return error(409, "dispatch_conflict");
  const stable = guard(
    actor,
    regionId,
    id,
    tokenHash,
    input.leaseEpoch,
    new Date().toISOString(),
  );
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${stable.predicate}`)
      .bind(...stable.bindings)
      .first())
  )
    return error(409, "lease_conflict");
  return json({ dispatch: dispatchValue(saved), created: true });
}
function artifact(value: unknown, b: Backup): Artifact | null {
  if (
    !fields(value, [
      "backupId",
      "backupName",
      "majorVersion",
      "startedAt",
      "stoppedAt",
      "beginWal",
      "endWal",
      "beginLSN",
      "endLSN",
      "online",
      "pluginMetadata",
    ]) ||
    !text(value.backupId) ||
    !text(value.backupName) ||
    !integer(value.majorVersion, 10, 99) ||
    value.online !== true ||
    typeof value.beginWal !== "string" ||
    !/^[0-9A-F]{24}$/.test(value.beginWal) ||
    typeof value.endWal !== "string" ||
    !/^[0-9A-F]{24}$/.test(value.endWal) ||
    !lsn(value.beginLSN) ||
    !lsn(value.endLSN) ||
    lsnNumber(value.beginLSN) > lsnNumber(value.endLSN) ||
    !fields(value.pluginMetadata, [
      "timeline",
      "version",
      "name",
      "displayName",
      "clusterUID",
      "pluginName",
    ])
  )
    return null;
  const meta = value.pluginMetadata;
  if (
    typeof meta.timeline !== "string" ||
    !/^[1-9][0-9]{0,9}$/.test(meta.timeline) ||
    BigInt(meta.timeline) > 4294967295n ||
    meta.version !== "0.15.0" ||
    meta.name !== plugin ||
    meta.displayName !== "BarmanCloudInstance" ||
    meta.clusterUID !== b.cluster_uid ||
    meta.pluginName !== plugin
  )
    return null;
  const started = time(value.startedAt),
    stopped = time(value.stoppedAt);
  if (!started || !stopped || started > stopped) return null;
  return {
    ...value,
    startedAt: started,
    stoppedAt: stopped,
  } as unknown as Artifact;
}
function observation(
  value: unknown,
  b: Backup,
  d: DispatchRow,
): Observation | null {
  const bound = JSON.parse(d.binding_json) as Binding;
  if (
    !fields(value, [
      "namespaceUid",
      "clusterUid",
      "objectStoreUid",
      "objectStoreGeneration",
      "objectStoreSpecHash",
      "backupResourceUid",
      "backupResourceVersion",
      "backupSpecHash",
      "phase",
      "artifact",
      "remoteObjectsVerified",
      "restoreVerified",
    ]) ||
    value.namespaceUid !== bound.namespaceUid ||
    value.clusterUid !== b.cluster_uid ||
    value.objectStoreUid !== bound.objectStoreUid ||
    value.objectStoreGeneration !== bound.objectStoreGeneration ||
    value.objectStoreSpecHash !== bound.objectStoreSpecHash ||
    value.backupSpecHash !== bound.backupSpecHash ||
    !uid(value.backupResourceUid) ||
    !rv(value.backupResourceVersion) ||
    value.remoteObjectsVerified !== false ||
    value.restoreVerified !== false
  )
    return null;
  if (value.phase === "failed" && value.artifact === null)
    return value as unknown as Observation;
  if (value.phase !== "completed") return null;
  const a = artifact(value.artifact, b);
  return a ? ({ ...value, artifact: a } as unknown as Observation) : null;
}
async function report(
  request: Request,
  db: AccountingDb,
  regionId: string,
  id: string,
) {
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
  const o = await readOperation(db, id, regionId),
    b = o ? await readBackup(db, o.backup_id) : null,
    d = await readDispatch(db, id);
  if (!o || !b || !d) return error(409, "lease_conflict");
  const observed = observation(input.observation, b, d);
  if (
    !observed ||
    input.status !== observed.phase ||
    input.resultCode !==
      (observed.phase === "completed"
        ? "base_backup_completed"
        : "backup_failed")
  )
    return error(400, "invalid_observation");
  const resultHash = await sha256(
      JSON.stringify(
        canonical({
          status: input.status,
          resultCode: input.resultCode,
          observation: observed,
        }),
      ),
    ),
    tokenHash = await sha256(input.leaseToken);
  const result = () =>
    json({
      backup: publicBackup({
        ...b,
        status: observed.phase,
        observed_at: o.observed_at,
        observation_json: JSON.stringify(observed),
      }),
      operation: publicBackupOperation(o),
    });
  if (o.status === "completed" || o.status === "failed")
    return o.lease_actor_token_id === actor.id &&
      o.lease_token_hash === tokenHash &&
      o.lease_epoch === input.leaseEpoch &&
      o.result_hash === resultHash
      ? result()
      : error(409, "lease_conflict");
  const at = new Date().toISOString(),
    g = guard(actor, regionId, id, tokenHash, input.leaseEpoch, at, false);
  // Terminal custody alone may survive requested budget pause; this does not
  // grant dispatch, renewal, wake, funding or permission to continue compute.
  try {
    await db.batch([
      assertion(db, g.predicate, g.bindings),
      db
        .prepare(
          "UPDATE backup_operations SET status=?,observed_at=?,result_code=?,result_hash=?,observation_json=?,version_token=? WHERE id=? AND status='running'",
        )
        .bind(
          observed.phase,
          at,
          input.resultCode,
          resultHash,
          JSON.stringify(observed),
          crypto.randomUUID(),
          id,
        ),
      db
        .prepare(
          "UPDATE environment_backups SET status=?,observed_at=?,observation_json=?,version_token=? WHERE id=? AND status='pending'",
        )
        .bind(
          observed.phase,
          at,
          JSON.stringify(observed),
          crypto.randomUUID(),
          b.id,
        ),
    ]);
  } catch {
    return error(409, "lease_conflict");
  }
  const done = await readOperation(db, id, regionId),
    saved = await readBackup(db, b.id);
  return done && saved
    ? json({
        backup: publicBackup(saved),
        operation: publicBackupOperation(done),
      })
    : error(500, "state_inconsistent");
}
export async function backupRoutes(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    customer =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/backups(?:\/([^/]+))?$/.exec(
        path,
      ),
    regional =
      /^\/v1\/regions\/([^/]+)\/backup-operations\/(claim|([^/]+)\/(renew|dispatch|result))$/.exec(
        path,
      );
  if (!customer && !regional) return null;
  const ids = customer
    ? [
        customer[1],
        customer[2],
        customer[3],
        ...(customer[4] ? [customer[4]] : []),
      ]
    : [regional![1], ...(regional![3] ? [regional![3]] : [])];
  if (!ids.every(uid)) return error(400, "invalid_request");
  if (new URL(request.url).search) return error(400, "invalid_request");
  const db = env.DB.withSession("first-primary");
  try {
    if (customer) {
      if (request.method === "POST" && !customer[4])
        return await create(
          request,
          db,
          customer[1]!,
          customer[2]!,
          customer[3]!,
        );
      if (request.method === "GET" && customer[4])
        return await read(
          request,
          db,
          customer[1]!,
          customer[2]!,
          customer[3]!,
          customer[4],
        );
      return null;
    }
    if (request.method !== "POST") return null;
    if (regional![2] === "claim")
      return await claim(request, db, regional![1]!);
    if (regional![4] === "renew")
      return await renew(request, db, regional![1]!, regional![3]!);
    if (regional![4] === "dispatch")
      return await dispatch(request, db, regional![1]!, regional![3]!);
    return await report(request, db, regional![1]!, regional![3]!);
  } catch {
    return error(500, "backup_unavailable");
  }
}
