// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  thinStorageAuthorityMatches,
  thinStorageInventory,
} from "@pgcf/contracts";
import {
  PoolBinding,
  poolBindingScopeHash,
  poolCleanupIoAttestationHash,
  PoolNodeReport,
} from "@pgcf/contracts/postgres-pool";
import {
  PoolCleanupClaims,
  POOL_CLEANUP_MAX_MS,
  poolCleanupValidAt,
  signPoolCleanupAuthority,
  verifyPoolCleanupAuthority,
} from "@pgcf/contracts/pool-cleanup-authority";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import type { Env } from "../env.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";
import {
  readCurrentNodeThinStorage,
  qualifiedThinStorageSql,
} from "./node-thin-storage.ts";
import { nodeProofSigningKey } from "./node-proof-session.ts";
import { installationHash } from "./node-installation.ts";
import {
  currentStorageStopSql,
  knownStorageHoldVolume,
  thinLogicalVolumeExposures,
} from "./storage-capacity.ts";
import {
  minimumHeadroom,
  storageHolds,
  storageHoldSnapshotSql,
  thinStorageWriteAllowed,
} from "./node-thin-storage-execution.ts";
import { readPostgresPoolFleetFence } from "./postgres-pool-fleet-fence.ts";
import {
  readPostgresPoolCleanupGrant,
  readPostgresPoolCleanupIoAttestation,
  readPostgresPoolQualificationCleanupAuthority,
} from "./postgres-pool.ts";

interface Stop {
  id: string;
  generation: number;
  database_generation: number;
  deadline: number | null;
  kind: string;
}
async function readCleanupStop(
  env: Env,
  binding: PoolBinding,
): Promise<Stop | null> {
  const scope = binding.scope;
  if (
    !["detaching", "failed", "lost"].includes(binding.state) ||
    (await poolBindingScopeHash(scope)) !== binding.scope_sha256
  )
    return null;
  return env.DB.prepare(
    `SELECT q.id,q.generation,d.generation database_generation,q.drain_deadline deadline,q.kind FROM pool_bindings b
    JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id AND h.revision=b.holder_revision AND h.kind='pool'
    JOIN databases d ON d.id=b.database_id JOIN pool_role_mutations q ON q.database_id=d.id
    WHERE b.id=? AND b.scope_sha256=? AND b.holder_revision=? AND b.state=? AND h.state=b.state AND q.binding_id=b.id
      AND q.holder_revision=h.revision AND q.expected_generation=d.generation AND q.expected_generation=? AND q.status IN('pending','failed')
    UNION ALL SELECT stop.id,stop.generation,d.generation,NULL,stop.kind FROM pool_bindings b
    JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id AND h.revision=b.holder_revision AND h.kind='pool'
    JOIN databases d ON d.id=b.database_id JOIN operations stop ON stop.database_id=d.id
    WHERE b.id=? AND b.scope_sha256=? AND b.holder_revision=? AND b.state=? AND h.state=b.state AND ${currentStorageStopSql()} LIMIT 1`,
  )
    .bind(
      scope.binding_id,
      binding.scope_sha256,
      binding.holder_revision,
      binding.state,
      scope.generation,
      scope.binding_id,
      binding.scope_sha256,
      binding.holder_revision,
      binding.state,
    )
    .first<Stop>();
}
/** Metadata for preparing a readback; it is not a worker IO, mount, resume or tenant grant. */
export async function readPostgresPoolCleanupIntent(
  env: Env,
  value: PoolBinding,
) {
  const binding = PoolBinding.parse(value),
    operation = await readCleanupStop(env, binding);
  return operation
    ? {
        operation_id: operation.id,
        database_generation: operation.database_generation,
        operation_target_generation: operation.generation,
      }
    : undefined;
}
function operationFence(
  scope: PoolBinding["scope"],
  holderRevision: number,
  operation: Stop,
): AdmissionSqlGuard {
  return operation.kind.startsWith("database.role.")
    ? {
        sql: "EXISTS(SELECT 1 FROM pool_role_mutations q WHERE q.id=? AND q.database_id=? AND q.binding_id=? AND q.holder_revision=? AND q.expected_generation=? AND q.generation=? AND q.drain_deadline=? AND q.status IN('pending','failed'))",
        bindings: [
          operation.id,
          scope.database_id,
          scope.binding_id,
          holderRevision,
          scope.generation,
          operation.generation,
          operation.deadline,
        ],
      }
    : {
        sql: `EXISTS(SELECT 1 FROM databases d JOIN operations stop ON stop.database_id=d.id WHERE d.id=? AND stop.id=? AND d.generation=? AND ${currentStorageStopSql()})`,
        bindings: [
          scope.database_id,
          operation.id,
          operation.database_generation,
        ],
      };
}
/** Fixed drain/unmount permission with a full logical allocation reserve, not a BIO byte cap. */
export async function issuePostgresPoolCleanupAuthority(
  env: Env,
  value: PoolBinding,
  now = Date.now(),
): Promise<string | undefined> {
  const binding = PoolBinding.parse(value),
    scope = binding.scope;
  if (
    scope.storage.backend !== "lvm-thin-v1" ||
    !["detaching", "failed", "lost"].includes(binding.state) ||
    (await poolBindingScopeHash(scope)) !== binding.scope_sha256
  )
    return undefined;
  const stored = await env.DB.prepare(
    `SELECT b.state,b.scope_json,b.scope_sha256,b.detaching_at,b.updated_at,b.node_report_json,h.revision,h.state holder_state,
    d.generation,d.storage_generation,d.storage_profile_json,d.storage_volume_json,e.admission_revision,e.route_revision,e.mutation_id
    FROM pool_bindings b JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id AND h.kind='pool'
    JOIN databases d ON d.id=b.database_id JOIN database_admission_epochs e ON e.database_id=d.id WHERE b.id=?`,
  )
    .bind(scope.binding_id)
    .first<{
      state: string;
      scope_json: string;
      scope_sha256: string;
      detaching_at: number | null;
      updated_at: number;
      node_report_json: string | null;
      revision: number;
      holder_state: string;
      generation: number;
      storage_generation: number;
      storage_profile_json: string | null;
      storage_volume_json: string | null;
      admission_revision: number;
      route_revision: number;
      mutation_id: string | null;
    }>();
  if (
    !stored ||
    stored.state !== binding.state ||
    stored.holder_state !== binding.state ||
    stored.revision !== binding.holder_revision ||
    stored.scope_sha256 !== binding.scope_sha256 ||
    stored.mutation_id !== null
  )
    return undefined;
  const operation = await readCleanupStop(env, binding);
  if (!operation || stored.generation !== operation.database_generation)
    return undefined;
  const profile = scope.storage.profile,
    cutoff =
      operation.deadline ??
      (stored.detaching_at === null
        ? stored.updated_at + profile.guard_seconds * 1000 + 5000
        : stored.detaching_at + profile.drain_seconds * 1000);
  // Every possible detaching SA1 is capped here. A stale mounted report is not the latest issued token.
  if (now < cutoff) return undefined;
  const io = await readPostgresPoolCleanupIoAttestation(
    env,
    binding,
    operation.id,
    now,
  );
  if (
    !io ||
    io.boot_id !== scope.boot_id ||
    io.database_generation !== stored.generation
  )
    return undefined;
  const receipt = DatabaseStorageVolumeReceipt.safeParse(
      JSON.parse(stored.storage_volume_json ?? "null"),
    ),
    selected = DesiredDatabaseStorage.safeParse(
      JSON.parse(stored.storage_profile_json ?? "null"),
    );
  if (
    !receipt.success ||
    !selected.success ||
    JSON.stringify(selected.data) !== JSON.stringify(profile) ||
    receipt.data.storage_generation !== scope.storage.storage_generation ||
    stored.storage_generation !== scope.storage.storage_generation ||
    receipt.data.storage_uid !== scope.storage.storage_uid ||
    receipt.data.namespace_uid !== scope.storage.namespace_uid ||
    receipt.data.cluster_uid !== scope.storage.cnpg_cluster_uid ||
    receipt.data.node_uid !== scope.node_uid ||
    receipt.data.volume_group_uuid !== scope.storage.volume_group_uuid ||
    receipt.data.pool_uuid !== profile.pool_uuid ||
    receipt.data.lv_uuid !== scope.storage.lv_uuid ||
    receipt.data.volume_handle !== scope.storage.volume_handle ||
    receipt.data.pvc_uid !== scope.storage.pvc_uid ||
    receipt.data.pv_uid !== scope.storage.pv_uid
  )
    return undefined;
  const current = await readCurrentNodeThinStorage(env, scope.node_id, now),
    authority = current?.authority;
  if (
    !current ||
    !authority ||
    current.row.current_qualified !== 1 ||
    current.row.error_code !== null ||
    current.row.action_json !== null ||
    !authority.data_accounting_complete ||
    (
      JSON.parse(current.row.qualification_json ?? "null") as {
        boot_id?: unknown;
      } | null
    )?.boot_id !== scope.boot_id ||
    !thinStorageAuthorityMatches(profile, authority, undefined, now, false) ||
    thinStorageInventory(authority).expires_at <= now ||
    authority.physical.free_bytes < current.profile.vg_reserve_bytes ||
    !authority.physical_lvs.some(
      (lv) =>
        lv.lv_uuid === scope.storage.lv_uuid &&
        lv.name === scope.storage.volume_handle &&
        lv.segtype === "thin",
    )
  )
    return undefined;
  const allocationKey = knownStorageHoldVolume({
    binding: stored.storage_volume_json,
    current: stored.storage_volume_json,
    profile: stored.storage_profile_json,
    storageGeneration: stored.storage_generation,
    databaseId: scope.database_id,
    authority,
    now,
  });
  const allocation =
    allocationKey === null
      ? undefined
      : thinLogicalVolumeExposures(authority)?.get(allocationKey);
  if (
    allocationKey === null ||
    allocation === undefined ||
    !Number.isSafeInteger(allocation) ||
    allocation <= 0
  )
    return undefined;
  const fleet = await readPostgresPoolFleetFence(env.DB, scope.region_id),
    qualification = fleet
      ? undefined
      : await readPostgresPoolQualificationCleanupAuthority(env, binding, now);
  const capability = fleet ?? qualification?.fence;
  if (
    !capability ||
    (qualification &&
      (qualification.operation_id !== operation.id ||
        qualification.database_generation !== stored.generation))
  )
    return undefined;
  const existing = await readPostgresPoolCleanupGrant(env, scope.binding_id),
    ioHash = await poolCleanupIoAttestationHash(io);
  if (
    existing &&
    (existing.claims.operation_id !== operation.id ||
      !["reserved", "issued"].includes(existing.state) ||
      (existing.state === "issued" && !existing.authority_token) ||
      (existing.state === "reserved" && existing.authority_token !== null) ||
      !poolCleanupValidAt(existing.claims, now) ||
      existing.claims.cleanup_io_sha256 !== ioHash ||
      existing.claims.database_generation !== stored.generation ||
      existing.claims.boot_id !== io.boot_id ||
      existing.claims.cleanup_mode !== "drain_unmount" ||
      existing.claims.allocation_reserve_bytes !== allocation)
  )
    return undefined;
  const held = await storageHolds(
      env,
      scope.node_id,
      scope.node_uid,
      authority,
      now,
    ),
    expires = Math.min(
      Date.parse(authority.expires_at),
      now + Math.min(POOL_CLEANUP_MAX_MS, profile.drain_seconds * 1000),
    );
  if (!existing && expires <= now) return undefined;
  const exposures = new Map(held.exposures);
  exposures.set(
    allocationKey,
    Math.max(exposures.get(allocationKey) ?? 0, allocation),
  );
  const headroom = minimumHeadroom(current.profile, authority, {
    ...held,
    exposures,
  });
  if (
    !thinStorageWriteAllowed(
      current.profile,
      authority,
      authority.physical,
      headroom,
    )
  )
    return undefined;
  const opFence = operationFence(scope, binding.holder_revision, operation),
    holdsGuard = storageHoldSnapshotSql.replaceAll("node_thin_storage.", "t.");
  const eligible: AdmissionSqlGuard = {
    sql: `EXISTS(SELECT 1 FROM pool_bindings b JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id
    JOIN databases d ON d.id=b.database_id JOIN database_admission_epochs e ON e.database_id=d.id JOIN nodes n ON n.id=b.node_id JOIN regions r ON r.id=d.region_id
    JOIN node_thin_storage t ON t.node_id=n.id JOIN pool_cleanup_io_attestations i ON i.binding_id=b.id AND i.operation_id=?
    WHERE b.id=? AND b.state=? AND b.scope_sha256=? AND b.scope_json=? AND b.detaching_at IS ? AND b.updated_at=? AND h.kind='pool' AND h.revision=? AND h.state=b.state
    AND d.generation=? AND d.storage_profile_json=? AND d.storage_volume_json=? AND e.admission_revision=? AND e.route_revision=? AND e.mutation_id IS NULL
    AND i.attestation_json=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND t.authority_revision=? AND t.authority_json=? AND t.error_code IS NULL AND t.action_json IS NULL
    AND julianday(json_extract(t.authority_json,'$.expires_at'))>julianday('now') AND ${qualifiedThinStorageSql("t")} AND (${capability.sql}) AND (${opFence.sql}) AND ${holdsGuard})`,
    bindings: [
      operation.id,
      scope.binding_id,
      binding.state,
      binding.scope_sha256,
      stored.scope_json,
      stored.detaching_at,
      stored.updated_at,
      binding.holder_revision,
      stored.generation,
      stored.storage_profile_json,
      stored.storage_volume_json,
      stored.admission_revision,
      stored.route_revision,
      JSON.stringify(io),
      scope.node_uid,
      authority.revision,
      current.row.authority_json,
      ...capability.bindings,
      ...opFence.bindings,
      JSON.stringify(held.operations),
    ],
  };
  if (existing?.state === "issued") {
    const verified = await verifyPoolCleanupAuthority(
      existing.authority_token!,
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      ),
      now,
    );
    if (
      !verified ||
      JSON.stringify(verified) !== JSON.stringify(existing.claims)
    )
      return undefined;
    return (await env.DB.prepare(
      `SELECT 1 FROM pool_cleanup_grants WHERE binding_id=? AND operation_id=? AND state='issued'
       AND authority_token=? AND claims_json=? AND expires_at>? AND ${eligible.sql}`,
    )
      .bind(
        scope.binding_id,
        operation.id,
        existing.authority_token,
        JSON.stringify(existing.claims),
        Date.now(),
        ...eligible.bindings,
      )
      .first())
      ? existing.authority_token!
      : undefined;
  }
  const prior = PoolNodeReport.safeParse(
      JSON.parse(stored.node_report_json ?? "null"),
    ),
    key = await nodeProofSigningKey(env);
  const claims =
    existing?.claims ??
    PoolCleanupClaims.parse({
      v: 1,
      kid: key.kid,
      binding_id: scope.binding_id,
      scope_sha256: binding.scope_sha256,
      holder_revision: binding.holder_revision,
      operation_id: operation.id,
      cleanup_io_sha256: ioHash,
      holder_generation: scope.generation,
      database_generation: stored.generation,
      operation_target_generation: operation.generation,
      authority_revision:
        Math.max(
          authority.revision,
          prior.success ? (prior.data.thin_guard?.authority_revision ?? 0) : 0,
        ) + 1,
      database_id: scope.database_id,
      node_uid: scope.node_uid,
      boot_id: io.boot_id,
      storage: scope.storage,
      device_major: io.device.device_major,
      device_minor: io.device.device_minor,
      allocation_reserve_bytes: allocation,
      cleanup_mode: "drain_unmount",
      write_bytes_per_second: io.shared_pod_io.write_bytes_per_second,
      write_iops_per_second: io.shared_pod_io.write_iops_per_second,
      iat: now,
      exp: expires,
    });
  if (claims.kid !== key.kid) return undefined;
  const serialized = JSON.stringify(claims),
    snapshot = await installationHash(authority);
  if (!existing) {
    const result = await env.DB.prepare(
      `INSERT INTO pool_cleanup_grants(binding_id,operation_id,authority_revision,claims_json,issued_at,expires_at,allocation_reserve_bytes,
    headroom_authority_revision,headroom_snapshot_sha256,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,'reserved',?,? WHERE ${eligible.sql}
    AND NOT EXISTS(SELECT 1 FROM pool_cleanup_grants WHERE binding_id=? AND state<>'completed')`,
    )
      .bind(
        scope.binding_id,
        operation.id,
        claims.authority_revision,
        serialized,
        now,
        expires,
        allocation,
        authority.revision,
        snapshot,
        now,
        now,
        ...eligible.bindings,
        scope.binding_id,
      )
      .run();
    if (result.meta.changes !== 1) return undefined;
  }
  // Resume only publication of the same reserved claims before their original expiry.
  // A command, allocation budget and deadline are never replayed or extended.
  const token = await signPoolCleanupAuthority(
    claims,
    key.privateKey,
    Date.now(),
  );
  const finalBindings = [...eligible.bindings];
  if (!existing)
    finalBindings[finalBindings.length - 1] = JSON.stringify([
      ...held.operations,
      operation.id,
    ]);
  const issued = await env.DB.prepare(
    `UPDATE pool_cleanup_grants SET authority_token=?,state='issued',updated_at=? WHERE binding_id=? AND operation_id=? AND state='reserved' AND authority_token IS NULL AND claims_json=? AND expires_at>? AND ${eligible.sql}`,
  )
    .bind(
      token,
      Date.now(),
      scope.binding_id,
      operation.id,
      serialized,
      Date.now(),
      ...finalBindings,
    )
    .run();
  return issued.meta.changes === 1 ? token : undefined;
}
