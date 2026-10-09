// SPDX-License-Identifier: Apache-2.0
import {
  NodeId,
  NodeThinStorageAuthority,
  type ThinStorageProfile,
} from "@pgcf/contracts";
import {
  NodeThinStorageSelection,
  NodeThinStorageState,
} from "@pgcf/contracts/node-thin-storage";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  withIdempotency,
  type IdempotencyLease,
} from "../middleware/idempotency.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import {
  installationHash,
  canonicalInstallation,
} from "./node-installation.ts";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
import {
  readCurrentNodeThinStorage,
  qualifiedThinStorageSql,
  type NodeThinStorageRow,
} from "./node-thin-storage.ts";

const conflict = (message: string): never => {
  throw new ApiError("conflict", message);
};
/** Only volume/runtime settings enter the immutable class hash; driver and pool geometry may advance. */
export function thinVolumeProfile(profile: ThinStorageProfile) {
  return {
    backend: "lvm-thin-v1",
    version: profile.version,
    startup_reserve_bytes: profile.startup_reserve_bytes,
    write_bytes_per_second: profile.write_bytes_per_second,
    write_iops_per_second: profile.write_iops_per_second,
    guard_seconds: profile.guard_seconds,
    drain_seconds: profile.drain_seconds,
  };
}
async function state(env: Pick<Env, "DB">, nodeId: string) {
  const row = await env.DB.prepare(
    "SELECT t.*,n.region_id FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE t.node_id=?",
  )
    .bind(nodeId)
    .first<NodeThinStorageRow & { region_id: string }>();
  if (!row)
    throw new ApiError("not_found", "Thin storage profile is not configured");
  return NodeThinStorageState.parse({
    node_id: row.node_id,
    node_uid: row.node_uid,
    region_id: row.region_id,
    revision: row.profile_revision,
    profile_sha256: row.profile_sha256,
    profile: JSON.parse(row.profile_json),
    allow_new_databases: row.allow_new_databases === 1,
    status: row.status,
    error_code: row.error_code,
    updated_at: row.updated_at,
  });
}
export async function getNodeThinStorageProfile(c: ApiContext, nodeId: string) {
  await requireScope(c, "admin");
  NodeId.parse(nodeId);
  return c.json(await state(c.env, nodeId), 200);
}

/** Accepted host proof is tied to the current assignment, pool, agent and physical boot. */
const hostActivationSql = `EXISTS(SELECT 1 FROM node_host_configurations h
  JOIN node_compute_pool_policies cp ON cp.node_id=h.node_id AND cp.node_uid=h.node_uid
  JOIN fleet_patch_operations p ON p.node_id=h.node_id AND p.node_uid=h.node_uid
  JOIN nodes hn ON hn.id=h.node_id AND hn.node_uid=h.node_uid
  JOIN regions hr ON hr.id=hn.region_id
  JOIN fleet_node_release_observations o ON o.node_id=h.node_id AND o.node_uid=h.node_uid
  WHERE (h.node_id=? AND h.node_uid=? AND h.release_id=? AND h.material_revision=? AND h.cluster_uid=?)
    AND (cp.release_id=h.release_id AND cp.revision=h.pool_policy_revision AND json_extract(cp.policy_json,'$.profile.image')=?)
    AND (p.release_id=h.release_id AND p.cluster_uid=h.cluster_uid AND p.material_revision=h.material_revision)
    AND (p.assignment_revision=? AND p.region_revision=? AND p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL)
    AND (p.host_configuration_revision=h.revision AND p.host_configuration_sha256=h.sha256)
    AND (json_extract(p.observed_json,'$.host_configuration_sha256')=h.sha256 AND json_extract(p.observed_json,'$.runtime_admission_sha256')=h.profile_sha256)
    AND (json_extract(p.observed_json,'$.node_ready')=1 AND json_extract(p.observed_json,'$.boot_id')=?)
    AND (o.assignment_revision=p.assignment_revision AND o.agent_key_hash=hr.agent_key_hash AND json_extract(o.facts_json,'$.boot_id')=json_extract(p.observed_json,'$.boot_id'))
    AND (julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')))`;

/** Bootstrap may call the same CAS after it has verified its sealed regional template authority. */
export async function configureNodeThinStorage(
  env: Env,
  nodeId: string,
  raw: NodeThinStorageSelection,
  lease?: IdempotencyLease,
) {
  NodeId.parse(nodeId);
  const body = NodeThinStorageSelection.parse(raw),
    now = new Date().toISOString();
  const source = await env.DB.prepare(
    `SELECT n.region_id,n.node_uid,n.provider_instance_id,a.role,a.revision assignment_revision,a.release_id,
    f.revision region_revision,s.spec_json,s.spec_sha256,r.bootstrap_material_revision material_revision
    FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
    JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=a.release_id JOIN fleet_releases s ON s.id=a.release_id
    WHERE n.id=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND n.provider_instance_id IS NOT NULL
      AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')`,
  )
    .bind(nodeId, body.node_uid)
    .first<{
      region_id: string;
      node_uid: string;
      provider_instance_id: string;
      role: "control_relay" | "customer";
      assignment_revision: number;
      release_id: string;
      region_revision: number;
      spec_json: string;
      spec_sha256: string;
      material_revision: number;
    }>();
  if (!source)
    return conflict("Current assigned physical node and release are required");
  const spec = FleetReleaseSpec.parse(JSON.parse(source.spec_json));
  if ((await installationHash(spec)) !== source.spec_sha256)
    return conflict("Approved release contents changed");
  const driver = spec.components.find((value) => value.name === "openebs-lvm");
  if (
    !driver ||
    driver.kind !== "image" ||
    driver.reference !== body.profile.driver_image ||
    !driver.reference.endsWith("@sha256:" + driver.sha256) ||
    !spec.roles[source.role].components.includes(driver.name)
  )
    return conflict("Thin driver differs from the selected immutable release");
  const keys = await storageAuthorityPublicKeys(env);
  if (
    !spec.storage_authority_keys_sha256 ||
    spec.storage_authority_keys_sha256 !== keys.sha256
  )
    return conflict(
      "Selected release does not pin the current storage verifier",
    );
  const ref = await loadCurrentRegionMaterialReference(
    env.DB,
    source.region_id,
    "join_bundle",
  );
  if (ref.revision !== source.material_revision)
    return conflict("Current sealed region material changed");
  const material = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref),
    clusterUid = material.kube_system_uid;
  const old = await env.DB.prepare(
    "SELECT * FROM node_thin_storage WHERE node_id=?",
  )
    .bind(nodeId)
    .first<NodeThinStorageRow>();
  if ((old?.profile_revision ?? 0) !== body.expected_revision)
    return conflict("Thin profile revision changed");
  if (
    old &&
    (old.node_uid !== body.node_uid ||
      old.cluster_uid !== clusterUid ||
      old.volume_group_uuid !== body.volume_group_uuid)
  )
    return conflict("Selected physical storage identity changed");
  if (old?.lease_expires_at && Date.parse(old.lease_expires_at) > Date.now())
    return conflict("Native physical operation is still active");
  if (old?.action_json && JSON.parse(old.action_json).state !== "pending")
    return conflict(
      "Uncertain physical write must be resolved before profile change",
    );
  const serialized = canonicalInstallation(body.profile),
    hash = await installationHash(thinVolumeProfile(body.profile));
  const references = await env.DB.prepare(
    `SELECT COUNT(*) count,COALESCE(MAX(s.storage_gib),0) maximum_quota FROM databases d JOIN size_classes s ON s.id=d.size_class_id
    WHERE d.node_id=? AND d.storage_profile_json IS NOT NULL AND d.observed_state<>'deleted'`,
  )
    .bind(nodeId)
    .first<{ count: number; maximum_quota: number }>();
  if (body.profile.maximum_quota_gib < (references?.maximum_quota ?? 0))
    return conflict("Thin quota cap is below a retained database quota");
  const prior = NodeThinStorageAuthority.safeParse(
      old?.authority_json ? JSON.parse(old.authority_json) : null,
    ),
    pool = prior.success ? prior.data.physical.thin_pool : null;
  if (
    old &&
    old.profile_sha256 !== hash &&
    ((references?.count ?? 0) > 0 || pool)
  )
    return conflict("Volume settings require an explicit physical migration");
  if (
    pool &&
    (body.profile.maximum_data_bytes < pool.data_total_bytes ||
      body.profile.metadata_bytes < pool.metadata_total_bytes)
  )
    return conflict("Physical thin pool shrink is not supported");
  const sandbox = spec.components.find(
    (value) => value.name === "sandbox-controller" && value.kind === "image",
  );
  const qualification = old?.qualification_json
    ? (JSON.parse(old.qualification_json) as { boot_id?: string })
    : null;
  const hostBindings = [
    nodeId,
    body.node_uid,
    source.release_id,
    source.material_revision,
    clusterUid,
    sandbox?.reference ?? "",
    source.assignment_revision,
    source.region_revision,
    qualification?.boot_id ?? "",
  ];
  if (body.allow_new_databases) {
    const current = await readCurrentNodeThinStorage(env, nodeId);
    if (
      !spec.thin_storage_qualification ||
      spec.thin_storage_qualification.profile_sha256 !==
        (await installationHash(body.profile)) ||
      spec.thin_storage_qualification.driver_image !==
        body.profile.driver_image ||
      Date.parse(spec.thin_storage_qualification.qualified_at) >
        Date.now() + 5000 ||
      !old ||
      old.profile_json !== serialized ||
      old.profile_sha256 !== hash ||
      !old.qualification_json ||
      old.status !== "ready" ||
      !current?.authority?.write_allowed ||
      !current.authority.data_accounting_complete ||
      !spec.roles[source.role].host_configuration_required ||
      !sandbox ||
      !spec.roles[source.role].components.includes(sandbox.name) ||
      !(await env.DB.prepare(`SELECT 1 WHERE ${hostActivationSql}`)
        .bind(...hostBindings)
        .first())
    )
      return conflict(
        "Current physical, host and runtime qualification are required before customer placement",
      );
  }
  const authority = `EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
    JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=a.release_id JOIN fleet_releases s ON s.id=a.release_id
    WHERE (n.id=? AND n.node_uid=? AND n.region_id=? AND n.ready=1 AND n.lost_at IS NULL)
      AND (a.revision=? AND a.release_id=? AND f.revision=? AND s.spec_sha256=? AND r.bootstrap_material_revision=?)
      AND (julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')))`;
  const authorityBindings = [
    nodeId,
    body.node_uid,
    source.region_id,
    source.assignment_revision,
    source.release_id,
    source.region_revision,
    source.spec_sha256,
    source.material_revision,
  ];
  // Recheck referenced database quotas in the mutation, not only in the preceding reads.
  const referenceFence = `NOT EXISTS(SELECT 1 FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.node_id=? AND d.storage_profile_json IS NOT NULL AND d.observed_state<>'deleted' AND s.storage_gib>?)
    AND (?=1 OR NOT EXISTS(SELECT 1 FROM databases d WHERE d.node_id=? AND d.storage_profile_json IS NOT NULL AND d.observed_state<>'deleted'))`;
  const referenceBindings = [
    nodeId,
    body.profile.maximum_quota_gib,
    Number(!old || old.profile_sha256 === hash),
    nodeId,
  ];
  const activationFence = body.allow_new_databases
    ? `AND (status='ready' AND qualification_json IS NOT NULL AND json_extract(authority_json,'$.write_allowed')=1 AND json_extract(authority_json,'$.data_accounting_complete')=1)
    AND (julianday(authority_received_at)>=julianday('now','-120 seconds') AND julianday(json_extract(authority_json,'$.expires_at'))>julianday('now')) AND ${hostActivationSql} AND ${qualifiedThinStorageSql("node_thin_storage")}`
    : "";
  const next = body.expected_revision + 1;
  const statement = old
    ? env.DB.prepare(
        `UPDATE node_thin_storage SET profile_revision=?,profile_sha256=?,profile_json=?,address=?,material_revision=?,qualified_driver_image=?,allow_new_databases=?,status='selected',error_code=NULL,lease_id=NULL,lease_expires_at=NULL,action_json=NULL,updated_at=?
    WHERE (node_id=? AND profile_revision=? AND node_uid=? AND cluster_uid=? AND volume_group_uuid=?)
      AND (profile_json=? AND profile_sha256=? AND authority_revision=? AND authority_json IS ? AND action_json IS ? AND lease_revision=?)
      AND (status=? AND qualification_json IS ? AND material_revision=? AND address=? AND qualified_driver_image IS ?)
      AND (lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now')) AND ${referenceFence} AND ${authority} ${activationFence}`,
      ).bind(
        next,
        hash,
        serialized,
        body.address,
        source.material_revision,
        driver.reference,
        Number(body.allow_new_databases),
        now,
        nodeId,
        body.expected_revision,
        body.node_uid,
        clusterUid,
        body.volume_group_uuid,
        old.profile_json,
        old.profile_sha256,
        old.authority_revision,
        old.authority_json,
        old.action_json,
        old.lease_revision,
        old.status,
        old.qualification_json,
        old.material_revision,
        old.address,
        old.qualified_driver_image,
        ...referenceBindings,
        ...authorityBindings,
        ...(body.allow_new_databases ? hostBindings : []),
      )
    : env.DB.prepare(
        `INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,material_revision,qualified_driver_image,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,'selected',?,? WHERE ${referenceFence} AND ${authority} ON CONFLICT(node_id) DO NOTHING`,
      ).bind(
        nodeId,
        body.node_uid,
        clusterUid,
        body.address,
        body.volume_group_uuid,
        next,
        hash,
        serialized,
        0,
        source.material_revision,
        driver.reference,
        now,
        now,
        ...referenceBindings,
        ...authorityBindings,
      );
  const statements = [statement];
  if (lease)
    statements.push(
      lease.completeStatement(nodeId, 200, {
        sql: "EXISTS(SELECT 1 FROM node_thin_storage WHERE node_id=? AND node_uid=? AND cluster_uid=? AND profile_revision=? AND profile_sha256=? AND profile_json=? AND material_revision=?)",
        bindings: [
          nodeId,
          body.node_uid,
          clusterUid,
          next,
          hash,
          serialized,
          source.material_revision,
        ],
      }),
    );
  const result = await env.DB.batch(statements);
  if (result[0]!.meta.changes !== 1)
    return conflict("Thin selection changed before admission");
  return state(env, nodeId);
}
export async function selectNodeThinStorage(
  c: ApiContext,
  nodeId: string,
  body: NodeThinStorageSelection,
) {
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: () => getNodeThinStorageProfile(c, nodeId),
    execute: async (lease) =>
      c.json(await configureNodeThinStorage(c.env, nodeId, body, lease), 200),
  });
}
