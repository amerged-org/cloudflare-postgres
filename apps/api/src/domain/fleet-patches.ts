// SPDX-License-Identifier: Apache-2.0
import {
  bytesToBase64url,
  newOperationId,
  timingSafeEqual,
  RegionBootstrapMaterialUpdate,
} from "@pgcf/contracts";
import {
  FleetPatchCheckpoint,
  FleetPatchInput,
  FleetPatchStatus,
  fleetPatchCheckpointAllowed,
  fleetPatchKubernetesImagesMatch,
  type FleetPatchRequest,
  FleetPostgresPatchProgress,
  FleetTalosUpgradeReceipt,
  FleetPatchFacts,
  retainedTalosInstallationMatches,
  FLEET_PATCH_PROOF_MAX_AGE_MS,
} from "@pgcf/contracts/fleet-patches";
import {
  FleetReleaseSpec,
  FleetReleaseFacts,
  thinStorageReleaseGuardPinned,
} from "@pgcf/contracts/releases";
import {
  BOOTSTRAP_PORTS,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  signBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope, bearer } from "../middleware/auth.ts";
import {
  effectiveFleetRegionJoin,
  fleetPatchPreparedAuthority,
} from "./fleet-region-authority.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { bootstrapTransportSigningKey } from "./bootstrap-relay.ts";
import { readBootstrapRelayIdentity } from "./node-inspection.ts";
import { mismatches } from "./fleet-releases.ts";
import { bootstrapJobInput, readBootstrapJob } from "./bootstrap-jobs.ts";
import {
  prepareNodePostjoinRuntime,
  readNodePostjoinRelease,
} from "./node-postjoin-release.ts";
import {
  ComputePoolPolicyState,
  ComputePoolObservation,
} from "@pgcf/contracts/compute-pool";
import { NodeBootstrapAdmissionBinding } from "@pgcf/contracts/node-bootstrap";
import { retainedThickStorageAssignments } from "./storage-capacity.ts";
import { installationHash } from "./node-installation.ts";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
import {
  ensureNodeHostConfiguration,
  loadNodeHostConfiguration,
} from "./node-host-configuration.ts";

interface PatchRow {
  operation_id: string;
  finalization_of: string | null;
  bootstrap_operation_id: string | null;
  bootstrap_joined_reference: string | null;
  node_id: string;
  region_id: string;
  node_uid: string;
  cluster_uid: string;
  release_id: string;
  spec_sha256: string;
  assignment_revision: number;
  region_revision: number;
  material_revision: number;
  address: string;
  cluster_nodes_json: string;
  revision: number;
  stage: FleetPatchStatus["stage"];
  state: FleetPatchStatus["state"];
  baseline_json: string | null;
  observed_json: string | null;
  talos_upgrade_receipt_json: string | null;
  postgres_progress_json: string | null;
  host_configuration_revision: number | null;
  host_configuration_sha256: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  deadline_at: string;
}
const closed = (): never => {
  throw new ApiError("conflict", "Fleet patch identity or authority changed");
};
function status(row: PatchRow): FleetPatchStatus {
  return FleetPatchStatus.strip().parse({
    ...row,
    baseline: row.baseline_json ? JSON.parse(row.baseline_json) : null,
    observed: row.observed_json ? JSON.parse(row.observed_json) : null,
    talos_upgrade_receipt: row.talos_upgrade_receipt_json
      ? JSON.parse(row.talos_upgrade_receipt_json)
      : null,
    postgres_progress: row.postgres_progress_json
      ? JSON.parse(row.postgres_progress_json)
      : null,
  });
}
export async function readFleetPatch(env: Env, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM fleet_patch_operations WHERE operation_id=?",
  )
    .bind(id)
    .first<PatchRow>();
  if (!row) throw new ApiError("not_found", "Fleet patch not found");
  return row;
}
export async function readFleetPatchStatus(
  env: Env,
  id: string,
): Promise<FleetPatchStatus> {
  return status(await readFleetPatch(env, id));
}
const baseFleetPatchAuthoritySql = `EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id
  JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id
  JOIN fleet_releases s ON s.id=a.release_id
  WHERE n.id=fleet_patch_operations.node_id AND n.region_id=fleet_patch_operations.region_id
    AND n.node_uid=fleet_patch_operations.node_uid AND n.lost_at IS NULL
    AND a.node_uid=n.node_uid AND a.revision=fleet_patch_operations.assignment_revision
    AND a.release_id=fleet_patch_operations.release_id AND f.release_id=a.release_id
    AND f.revision=fleet_patch_operations.region_revision AND s.spec_sha256=fleet_patch_operations.spec_sha256
    AND r.bootstrap_material_revision=fleet_patch_operations.material_revision)
  AND NOT EXISTS(SELECT 1 FROM json_each(fleet_patch_operations.cluster_nodes_json) j LEFT JOIN nodes n ON n.id=json_extract(j.value,'$.node_id') LEFT JOIN fleet_node_releases a ON a.node_id=n.id
    WHERE n.id IS NULL OR a.node_id IS NULL OR n.region_id<>fleet_patch_operations.region_id OR n.node_uid<>json_extract(j.value,'$.node_uid') OR n.lost_at IS NOT NULL OR a.node_uid<>n.node_uid OR a.release_id<>fleet_patch_operations.release_id OR a.revision<>json_extract(j.value,'$.assignment_revision') OR (fleet_patch_operations.bootstrap_operation_id IS NULL AND n.database_placement_closed_at IS NOT COALESCE(json_extract(j.value,'$.previous_placement_closed_at'),fleet_patch_operations.created_at)))
  AND (SELECT count(*) FROM nodes WHERE region_id=fleet_patch_operations.region_id AND lost_at IS NULL) = json_array_length(fleet_patch_operations.cluster_nodes_json) AND (fleet_patch_operations.host_configuration_revision IS NULL OR EXISTS(SELECT 1 FROM node_host_configurations h WHERE h.node_id=fleet_patch_operations.node_id AND h.node_uid=fleet_patch_operations.node_uid AND h.cluster_uid=fleet_patch_operations.cluster_uid AND h.material_revision=fleet_patch_operations.material_revision AND h.release_id=fleet_patch_operations.release_id AND h.revision=fleet_patch_operations.host_configuration_revision AND h.sha256=fleet_patch_operations.host_configuration_sha256))`;
const parentAuthoritySql = ` AND (fleet_patch_operations.bootstrap_operation_id IS NULL OR EXISTS(SELECT 1 FROM node_bootstrap_jobs j JOIN node_additions a ON a.operation_id=j.operation_id JOIN nodes n ON n.id=j.node_id WHERE j.operation_id=fleet_patch_operations.bootstrap_operation_id AND j.node_id=fleet_patch_operations.node_id AND j.region_id=fleet_patch_operations.region_id AND j.authorized=1 AND j.admitted=0 AND j.cancelled=0 AND j.admission_authorized=1 AND a.status='bootstrapping' AND n.provider_instance_id=a.provider_instance_id AND json_extract(j.admission_binding_json,'$.node_uid')=fleet_patch_operations.node_uid AND json_extract(j.admission_binding_json,'$.kube_system_uid')=fleet_patch_operations.cluster_uid AND json_extract(a.checkpoint_json,'$.stage')='joined' AND json_extract(a.checkpoint_json,'$.reference')=fleet_patch_operations.bootstrap_joined_reference AND json_extract(a.network_json,'$.checkpoint_reference')=fleet_patch_operations.bootstrap_joined_reference AND json_extract(a.capacity_json,'$.checkpoint_reference')=fleet_patch_operations.bootstrap_joined_reference AND j.input_hash||':'||json_extract(j.admission_binding_json,'$.checkpoint_revision')=fleet_patch_operations.bootstrap_joined_reference))`;
export const fleetPatchAuthoritySql =
  baseFleetPatchAuthoritySql + parentAuthoritySql;
const authoritySql = fleetPatchAuthoritySql;
/** Platform writes affect the regional cluster, including retained thin members. */
async function retainedThinPatchRequiresHost(
  env: Env,
  regionId: string,
  releaseId: string,
): Promise<boolean> {
  const selected = await env.DB.prepare(
    "SELECT 1 present FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id AND n.node_uid=t.node_uid WHERE n.region_id=? AND n.lost_at IS NULL LIMIT 1",
  )
    .bind(regionId)
    .first();
  if (!selected) return false;
  const release = await env.DB.prepare(
    "SELECT spec_json FROM fleet_releases WHERE id=?",
  )
    .bind(releaseId)
    .first<{ spec_json: string }>();
  const spec = FleetReleaseSpec.safeParse(
    release ? JSON.parse(release.spec_json) : null,
  );
  if (
    !spec.success ||
    !thinStorageReleaseGuardPinned(spec.data) ||
    spec.data.storage_authority_keys_sha256 !==
      (await storageAuthorityPublicKeys(env)).sha256
  )
    return closed();
  return true;
}
/** Fresh metadata fencing for a request whose private input has already been verified. */
export async function assertFleetPatchCurrent(
  env: Env,
  row: PatchRow,
  allowExpired = false,
  poolRevision?: number,
) {
  if (
    row.state === "halted" ||
    ["complete", "host_ready"].includes(row.stage) ||
    (!allowExpired && Date.parse(row.deadline_at) <= Date.now())
  )
    return closed();
  const valid = await env.DB.prepare(
    `SELECT 1 valid FROM fleet_patch_operations WHERE operation_id=? AND revision=? AND node_id=? AND region_id=? AND node_uid=? AND cluster_uid=? AND release_id=? AND spec_sha256=? AND assignment_revision=? AND region_revision=? AND material_revision=? AND address=? AND cluster_nodes_json=? AND stage=? AND state=? AND deadline_at=? AND host_configuration_revision IS ? AND host_configuration_sha256 IS ? AND ${authoritySql}
    AND (? IS NULL OR EXISTS(SELECT 1 FROM node_compute_pool_policies p WHERE p.node_id=fleet_patch_operations.node_id AND p.node_uid=fleet_patch_operations.node_uid AND p.release_id=fleet_patch_operations.release_id AND p.revision=?))`,
  )
    .bind(
      row.operation_id,
      row.revision,
      row.node_id,
      row.region_id,
      row.node_uid,
      row.cluster_uid,
      row.release_id,
      row.spec_sha256,
      row.assignment_revision,
      row.region_revision,
      row.material_revision,
      row.address,
      row.cluster_nodes_json,
      row.stage,
      row.state,
      row.deadline_at,
      row.host_configuration_revision,
      row.host_configuration_sha256,
      poolRevision ?? null,
      poolRevision ?? null,
    )
    .first();
  if (!valid) return closed();
}
export async function assertFleetPatchAuthority(
  env: Env,
  row: PatchRow,
  allowExpired = false,
) {
  await assertFleetPatchCurrent(env, row, allowExpired);
  if (await retainedThinPatchRequiresHost(env, row.region_id, row.release_id)) {
    if (!row.host_configuration_revision || !row.host_configuration_sha256)
      return closed();
  }
  if (row.bootstrap_operation_id) await assertBootstrapFleetParent(env, row);
  if (row.host_configuration_revision && row.host_configuration_sha256)
    await loadNodeHostConfiguration(env, {
      node_id: row.node_id,
      node_uid: row.node_uid,
      cluster_uid: row.cluster_uid,
      material_revision: row.material_revision,
      revision: row.host_configuration_revision,
      sha256: row.host_configuration_sha256,
    });
}
async function assertBootstrapFleetParent(env: Env, row: PatchRow) {
  if (!row.bootstrap_operation_id) return;
  if (
    !(await env.DB.prepare(
      `SELECT 1 valid FROM fleet_patch_operations WHERE operation_id=? AND ${fleetPatchAuthoritySql}`,
    )
      .bind(row.operation_id)
      .first())
  )
    return closed();
  const job = await readBootstrapJob(env.DB, row.bootstrap_operation_id);
  if (
    job.admitted ||
    job.cancelled ||
    !job.authorized ||
    !job.admission_authorized ||
    job.node_id !== row.node_id ||
    job.region_id !== row.region_id
  )
    return closed();
  const input = await bootstrapJobInput(env, job),
    expected = input.spec.postjoin_release;
  if (
    !expected ||
    expected.release_id !== row.release_id ||
    expected.spec_sha256 !== row.spec_sha256 ||
    expected.region_revision !== row.region_revision ||
    input.spec.hardware.ipv4 !== row.address
  )
    return closed();
  const binding = NodeBootstrapAdmissionBinding.parse(
    JSON.parse(job.admission_binding_json ?? "null"),
  );
  if (
    binding.node_uid !== row.node_uid ||
    binding.kube_system_uid !== row.cluster_uid ||
    `${job.input_hash}:${binding.checkpoint_revision}` !==
      row.bootstrap_joined_reference
  )
    return closed();
  await readNodePostjoinRelease(env, row.region_id, expected, row.node_id);
}
async function patchBearer(env: Env, row: PatchRow) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.API_KEY_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          `pgcf-fleet-patch/v1\n${row.operation_id}\n${row.node_uid}\n${row.cluster_uid}\n${row.spec_sha256}\n${row.assignment_revision}\n${row.material_revision}`,
        ),
      ),
    ),
  );
}
/** Authenticate before parsing a callback body; no private-input reconstruction here. */
export async function authenticateFleetPatchRow(c: ApiContext, id: string) {
  const row = await readFleetPatch(c.env, id);
  if (!timingSafeEqual(bearer(c), await patchBearer(c.env, row)))
    throw new ApiError("unauthorized", "Fleet patch credentials required");
  await assertFleetPatchCurrent(c.env, row);
  return row;
}
export async function authenticateFleetPatch(c: ApiContext, id: string) {
  const row = await authenticateFleetPatchRow(c, id);
  await assertFleetPatchAuthority(c.env, row);
  return row;
}
/** One request owns one full private-input validation; later checks use fresh fenced metadata. */
export async function authenticateFleetPatchContext(
  c: ApiContext,
  id: string,
  authenticatedRow?: PatchRow,
) {
  const row = authenticatedRow ?? (await authenticateFleetPatchRow(c, id));
  if (row.operation_id !== id) return closed();
  const input = await fleetPatchInput(c.env, id, row);
  return { row, input };
}
export async function fleetPatchInput(
  env: Env,
  id: string,
  verifiedRow?: PatchRow,
): Promise<FleetPatchInput> {
  const row = verifiedRow ?? (await readFleetPatch(env, id));
  if (row.operation_id !== id) return closed();
  await assertFleetPatchCurrent(env, row);
  if (
    (await retainedThinPatchRequiresHost(env, row.region_id, row.release_id)) &&
    (!row.host_configuration_revision || !row.host_configuration_sha256)
  )
    return closed();
  if (row.bootstrap_operation_id) await assertBootstrapFleetParent(env, row);
  const selected = await env.DB.prepare(
    "SELECT a.role,n.k8s_node_name,s.spec_json FROM fleet_node_releases a JOIN nodes n ON n.id=a.node_id JOIN fleet_releases s ON s.id=a.release_id WHERE a.node_id=?",
  )
    .bind(row.node_id)
    .first<{
      role: "control_relay" | "customer";
      k8s_node_name: string;
      spec_json: string;
    }>();
  if (!selected) return closed();
  const ref = await loadCurrentRegionMaterialReference(
    env.DB,
    row.region_id,
    "join_bundle",
  );
  if (ref.revision !== row.material_revision) return closed();
  const bundle = await effectiveFleetRegionJoin(
    env,
    row.region_id,
    ref.revision,
    await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref),
  );
  if (bundle.kube_system_uid !== row.cluster_uid) return closed();
  const spec = FleetReleaseSpec.parse(JSON.parse(selected.spec_json));
  const storageAuthority = spec.storage_authority_keys_sha256
    ? await storageAuthorityPublicKeys(env)
    : undefined;
  if (
    storageAuthority &&
    storageAuthority.sha256 !== spec.storage_authority_keys_sha256
  )
    return closed();
  const bootstrapOwner =
    row.bootstrap_operation_id === null
      ? await env.DB.prepare(
          `SELECT j.input_hash FROM node_bootstrap_jobs j
          JOIN node_additions a ON a.operation_id=j.operation_id AND a.node_id=j.node_id AND a.region_id=j.region_id
          JOIN nodes n ON n.id=j.node_id AND n.region_id=j.region_id AND n.provider_instance_id=a.provider_instance_id
          WHERE j.node_id=? AND j.region_id=? AND n.node_uid=? AND j.admitted=1 AND j.cancelled=0
          AND json_extract(j.checkpoint_json,'$.stage')='quarantine_released'
          AND json_extract(j.checkpoint_json,'$.status')='released'
          AND json_extract(j.checkpoint_json,'$.admission_receipt.operation_id')=j.operation_id
          AND json_extract(j.checkpoint_json,'$.admission_receipt.node_id')=j.node_id
          AND json_extract(j.checkpoint_json,'$.admission_receipt.region_id')=j.region_id
          AND json_extract(j.checkpoint_json,'$.admission_receipt.input_hash')=j.input_hash
          AND json_extract(j.checkpoint_json,'$.admission_receipt.node_uid')=n.node_uid
          AND json_extract(j.checkpoint_json,'$.admission_receipt.kube_system_uid')=?
          AND json_extract(j.checkpoint_json,'$.admission_receipt.quarantine_removed')=1
          ORDER BY j.created_at DESC LIMIT 1`,
        )
          .bind(row.node_id, row.region_id, row.node_uid, row.cluster_uid)
          .first<{ input_hash: string }>()
      : null;
  const prior = await env.DB.prepare(
    `SELECT p.talos_upgrade_receipt_json,p.observed_json FROM fleet_patch_operations p JOIN fleet_node_release_observations o ON o.node_id=p.node_id JOIN regions r ON r.id=p.region_id WHERE p.node_id=? AND p.node_uid=? AND p.cluster_uid=? AND p.stage IN('complete','host_ready') AND p.talos_upgrade_receipt_json IS NOT NULL AND o.node_uid=p.node_uid AND o.agent_key_hash=r.agent_key_hash ORDER BY p.updated_at DESC LIMIT 1`,
  )
    .bind(row.node_id, row.node_uid, row.cluster_uid)
    .first<{ talos_upgrade_receipt_json: string; observed_json: string }>();
  let retainedTalos: FleetPatchInput["retained_talos_installation"];
  if (prior) {
    const receipt = FleetTalosUpgradeReceipt.parse(
        JSON.parse(prior.talos_upgrade_receipt_json),
      ),
      observed = FleetPatchFacts.parse(JSON.parse(prior.observed_json));
    // Historical proof authorizes reading boot-loaded STATE before a different image is
    // installed. The executor separately requires exact target-installer equality to skip it.
    retainedTalos = {
      receipt,
      boot_id: observed.boot_id,
      talos_version: observed.talos_version,
      talos_schematic_sha256: observed.talos_schematic_sha256,
      ...(observed.release_facts?.kubernetes_image_provenance
        ? {
            kubernetes_image_provenance:
              observed.release_facts.kubernetes_image_provenance,
          }
        : {}),
    };
  }
  const hostConfiguration =
    row.host_configuration_revision && row.host_configuration_sha256
      ? await loadNodeHostConfiguration(env, {
          node_id: row.node_id,
          node_uid: row.node_uid,
          cluster_uid: row.cluster_uid,
          material_revision: row.material_revision,
          revision: row.host_configuration_revision,
          sha256: row.host_configuration_sha256,
        })
      : undefined;
  if (
    spec.roles[selected.role].host_configuration_required &&
    !hostConfiguration
  )
    return closed();
  const poolRow = hostConfiguration
    ? await env.DB.prepare(
        "SELECT p.*,n.region_id FROM node_compute_pool_policies p JOIN nodes n ON n.id=p.node_id WHERE p.node_id=? AND p.node_uid=? AND p.release_id=?",
      )
        .bind(row.node_id, row.node_uid, row.release_id)
        .first<{
          node_id: string;
          node_uid: string;
          region_id: string;
          revision: number;
          policy_json: string;
          updated_at: string;
        }>()
    : null;
  const computePool = poolRow
    ? ComputePoolPolicyState.strip().parse({
        ...poolRow,
        policy: JSON.parse(poolRow.policy_json),
      })
    : undefined;
  if (
    hostConfiguration &&
    (!computePool ||
      (await installationHash(computePool.policy.profile)) !==
        hostConfiguration.status.profile_sha256)
  )
    return closed();
  const observation = computePool
    ? await env.DB.prepare(
        "SELECT observation_json FROM node_compute_pool_observations WHERE node_id=? AND node_uid=? AND policy_revision=? AND material_revision=?",
      )
        .bind(
          row.node_id,
          row.node_uid,
          computePool.revision,
          row.material_revision,
        )
        .first<{ observation_json: string }>()
    : null;
  const poolObservation = observation
    ? ComputePoolObservation.parse(JSON.parse(observation.observation_json))
    : undefined;
  const url = new URL(
    `/internal/v1/fleet-patches/${id}`,
    env.NODE_BOOTSTRAP_CALLBACK_URL,
  );
  if (url.protocol !== "https:") return closed();
  await assertFleetPatchCurrent(env, row, false, computePool?.revision);
  return FleetPatchInput.parse({
    status: status(row),
    host_configuration_only:
      !!row.finalization_of &&
      !!spec.roles[selected.role].host_configuration_required &&
      (await readFleetPatch(env, row.finalization_of)).material_revision !==
        row.material_revision,
    regional_hosts_ready: await regionalFleetHostsReady(env, row, spec),
    role: selected.role,
    spec,
    address: row.address,
    k8s_node_name: selected.k8s_node_name,
    cluster_endpoint: bundle.cluster_endpoint,
    cluster_nodes: JSON.parse(row.cluster_nodes_json).map((value: unknown) =>
      FleetPatchInput.shape.cluster_nodes.element.strip().parse(value),
    ),
    talos_admin_config: bundle.talos_admin_config,
    kubeconfig: bundle.kubeconfig,
    ...(storageAuthority ? { storage_authority: storageAuthority } : {}),
    ...(hostConfiguration ? { host_configuration: hostConfiguration } : {}),
    ...(computePool ? { compute_pool: computePool } : {}),
    ...(poolObservation ? { compute_pool_observation: poolObservation } : {}),
    retained_thick_storage: await retainedThickStorageAssignments(
      env,
      row.region_id,
    ),
    ...(bootstrapOwner
      ? { initial_bootstrap_input_sha256: bootstrapOwner.input_hash }
      : {}),
    ...(retainedTalos ? { retained_talos_installation: retainedTalos } : {}),
    ...(await fleetPatchPreparedAuthority(env, row.region_id, row.node_id).then(
      (value) => (value ? { authority_rotation: value } : {}),
    )),
    callback: { url: url.href, bearer: await patchBearer(env, row) },
  });
}
/** Existing host receipts plus fresh physical identity and pool observations qualify the regional activation boundary. */
async function regionalFleetHostsReady(
  env: Env,
  row: PatchRow,
  spec: FleetReleaseSpec,
  includeSelf = false,
): Promise<boolean> {
  const selectedPool = await env.DB.prepare(
      "SELECT policy_json FROM node_compute_pool_policies WHERE node_id=? AND node_uid=? AND release_id=?",
    )
      .bind(row.node_id, row.node_uid, row.release_id)
      .first<{ policy_json: string }>(),
    targetPool = selectedPool ? JSON.parse(selectedPool.policy_json) : null;
  const members = await env.DB.prepare(
    `SELECT n.id,n.node_uid,n.ready,n.last_observed_at,a.role,a.revision,o.facts_json,o.observed_at,o.assignment_revision,o.agent_key_hash,r.agent_key_hash current_key,h.revision host_revision,h.sha256 host_sha,h.profile_sha256,p.revision pool_revision,p.policy_json,c.observation_json,
    (SELECT x.observed_json FROM fleet_patch_operations x WHERE x.node_id=n.id AND x.node_uid=n.node_uid AND x.release_id=? AND x.spec_sha256=? AND x.assignment_revision=a.revision AND x.region_revision=? AND x.material_revision=? AND x.state='confirmed' AND x.stage IN('host_ready','complete') AND x.host_configuration_revision IS h.revision AND x.host_configuration_sha256 IS h.sha256 ORDER BY x.updated_at DESC LIMIT 1) host_facts
    FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id LEFT JOIN fleet_node_release_observations o ON o.node_id=n.id LEFT JOIN node_host_configurations h ON h.node_id=n.id AND h.node_uid=n.node_uid AND h.release_id=a.release_id AND h.material_revision=r.bootstrap_material_revision LEFT JOIN node_compute_pool_policies p ON p.node_id=n.id AND p.node_uid=n.node_uid AND p.release_id=a.release_id LEFT JOIN node_compute_pool_observations c ON c.node_id=n.id AND c.node_uid=n.node_uid AND c.policy_revision=p.revision AND c.material_revision=r.bootstrap_material_revision WHERE n.region_id=? AND n.lost_at IS NULL AND (?=1 OR n.id<>?)`,
  )
    .bind(
      row.release_id,
      row.spec_sha256,
      row.region_revision,
      row.material_revision,
      row.region_id,
      includeSelf ? 1 : 0,
      row.node_id,
    )
    .all<{
      id: string;
      node_uid: string;
      ready: number;
      last_observed_at: string | null;
      role: "control_relay" | "customer";
      revision: number;
      facts_json: string | null;
      observed_at: string | null;
      assignment_revision: number | null;
      agent_key_hash: string | null;
      current_key: string;
      host_revision: number | null;
      host_sha: string | null;
      profile_sha256: string | null;
      pool_revision: number | null;
      policy_json: string | null;
      observation_json: string | null;
      host_facts: string | null;
    }>();
  const fresh = (at: string | null, age = 180000) =>
    at !== null &&
    Date.parse(at) >= Date.now() - age &&
    Date.parse(at) <= Date.now() + 5000;
  for (const member of members.results) {
    if (
      !member.ready ||
      !fresh(member.last_observed_at) ||
      !fresh(member.observed_at) ||
      member.assignment_revision !== member.revision ||
      member.agent_key_hash !== member.current_key ||
      !member.facts_json ||
      !member.host_facts
    )
      return false;
    const old = FleetPatchFacts.parse(JSON.parse(member.host_facts)),
      actual = JSON.parse(member.facts_json),
      target = spec.roles[member.role];
    if (
      old.node_uid !== member.node_uid ||
      old.cluster_uid !== row.cluster_uid ||
      old.boot_id !== actual.boot_id ||
      String(actual.talos_version).replace(/^v/, "") !==
        target.talos_version.replace(/^v/, "") ||
      String(actual.kubernetes_version).replace(/^v/, "") !==
        target.kubernetes_version.replace(/^v/, "") ||
      old.release_facts?.talos_installer !== target.talos_installer ||
      old.release_facts.talos_schematic_sha256 !== target.talos_schematic_sha256
    )
      return false;
    if (target.host_configuration_required) {
      if (
        !member.host_revision ||
        !member.pool_revision ||
        !member.policy_json ||
        !member.observation_json ||
        old.host_configuration_sha256 !== member.host_sha
      )
        return false;
      const policy = JSON.parse(member.policy_json),
        observed = ComputePoolObservation.parse(
          JSON.parse(member.observation_json),
        );
      if (
        !targetPool ||
        (await installationHash(policy.profile)) !==
          (await installationHash(targetPool.profile)) ||
        policy.per_slot_cpu_millicores !== targetPool.per_slot_cpu_millicores ||
        policy.per_slot_memory_mib !== targetPool.per_slot_memory_mib ||
        (await installationHash(policy.profile)) !== member.profile_sha256 ||
        observed.node_uid !== member.node_uid ||
        observed.policy_revision !== member.pool_revision ||
        observed.material_revision !== row.material_revision ||
        !fresh(observed.observed_at, 120000) ||
        (await installationHash(observed.profile)) !==
          (await installationHash(policy.profile)) ||
        observed.slots.filter((slot) => slot.live && slot.sandbox_id === null)
          .length < policy.target_slots
      )
        return false;
    }
  }
  return true;
}
/** A completed programmed rotation may refresh immutable pre-activation host receipts without another OS write. */
async function verifiedRotationHostRefresh(
  env: Env,
  row: PatchRow,
  currentMaterial: number,
): Promise<boolean> {
  const state = await env.DB.prepare(
    "SELECT f.rollout_json,r.bootstrap_material_revision,r.bootstrap_material_provenance_sha256 FROM fleet_region_releases f JOIN regions r ON r.id=f.region_id WHERE f.region_id=?",
  )
    .bind(row.region_id)
    .first<{
      rollout_json: string | null;
      bootstrap_material_revision: number;
      bootstrap_material_provenance_sha256: string | null;
    }>();
  if (!state?.rollout_json) return false;
  const { FleetRolloutIntent } = await import("@pgcf/contracts/fleet-rollouts");
  const parsed = FleetRolloutIntent.safeParse(JSON.parse(state.rollout_json));
  if (!parsed.success) return false;
  const intent = parsed.data,
    region = intent.regions.find(
      (region) => region.region_id === row.region_id,
    ),
    node = region?.nodes.find((node) => node.node_id === row.node_id),
    proof = region?.rotation?.verified;
  if (
    !region ||
    !node ||
    !proof ||
    proof.source !== "trusted_native" ||
    intent.release_id !== row.release_id ||
    region.revision !== row.region_revision ||
    region.cluster_uid !== row.cluster_uid ||
    region.material_revision !== row.material_revision ||
    region.staged_material_revision !== currentMaterial ||
    region.current_material_revision !== currentMaterial ||
    state.bootstrap_material_revision !== currentMaterial ||
    region.rotation?.phase !== "complete" ||
    region.rotation.state !== "confirmed" ||
    node.node_uid !== row.node_uid ||
    node.assignment_revision !== row.assignment_revision ||
    (await installationHash(proof)) !==
      state.bootstrap_material_provenance_sha256
  )
    return false;
  const { fleetRolloutAuthoritySql } = await import("./fleet-rollouts.ts"),
    authority = fleetRolloutAuthoritySql(intent);
  return Boolean(
    await env.DB.prepare(`SELECT 1 valid WHERE ${authority.sql}`)
      .bind(...authority.bindings)
      .first(),
  );
}
/** A host_ready operation remains immutable. Its one finalization reloads current custody and revalidates identities. */
export async function ensureFleetPatchFinalization(
  env: Env,
  hostOperationId: string,
): Promise<FleetPatchStatus | null> {
  const source = await readFleetPatch(env, hostOperationId);
  if (
    !["host_ready", "complete"].includes(source.stage) ||
    source.state !== "confirmed" ||
    source.bootstrap_operation_id
  )
    return closed();
  const existing = await env.DB.prepare(
    "SELECT * FROM fleet_patch_operations WHERE finalization_of=?",
  )
    .bind(hostOperationId)
    .first<PatchRow>();
  if (existing) {
    const currentMaterial = await env.DB.prepare(
      "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
    )
      .bind(source.region_id)
      .first<{ revision: number }>();
    if (
      existing.stage === "host_ready" ||
      (existing.stage === "complete" &&
        currentMaterial &&
        existing.material_revision < currentMaterial.revision)
    )
      return ensureFleetPatchFinalization(env, existing.operation_id);
    if (existing.stage !== "complete") {
      await assertFleetPatchAuthority(env, existing, true);
      if (Date.parse(existing.deadline_at) <= Date.now()) {
        const renewed = await env.DB.prepare(
          `UPDATE fleet_patch_operations SET deadline_at=? WHERE operation_id=? AND revision=? AND ${authoritySql}`,
        )
          .bind(
            new Date(Date.now() + 3600000).toISOString(),
            existing.operation_id,
            existing.revision,
          )
          .run();
        if (renewed.meta.changes !== 1) return closed();
      }
      await startFleetPatch(env, existing.operation_id);
    }
    return status(existing);
  }
  const revision = await env.DB.prepare(
    "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
  )
    .bind(source.region_id)
    .first<{ revision: number }>();
  const refresh =
    revision &&
    revision.revision > source.material_revision &&
    (source.stage === "complete" ||
      (await verifiedRotationHostRefresh(env, source, revision.revision)));
  if (refresh) {
    const current = await env.DB.prepare(
      `SELECT 1 valid FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id JOIN fleet_node_release_observations o ON o.node_id=n.id JOIN regions r ON r.id=n.region_id WHERE n.id=? AND n.node_uid=? AND n.lost_at IS NULL AND a.node_uid=n.node_uid AND a.release_id=? AND a.revision=? AND f.release_id=a.release_id AND f.revision=? AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash AND json_extract(o.facts_json,'$.boot_id')=? AND julianday(o.observed_at)>=julianday('now','-180 seconds')`,
    )
      .bind(
        source.node_id,
        source.node_uid,
        source.release_id,
        source.assignment_revision,
        source.region_revision,
        JSON.parse(source.observed_json ?? "null")?.boot_id,
      )
      .first();
    if (!current) return closed();
  } else if (
    source.stage !== "host_ready" ||
    !(await env.DB.prepare(
      `SELECT 1 valid FROM fleet_patch_operations WHERE operation_id=? AND ${authoritySql}`,
    )
      .bind(hostOperationId)
      .first())
  )
    return closed();
  const release = await env.DB.prepare(
    "SELECT spec_json FROM fleet_releases WHERE id=?",
  )
    .bind(source.release_id)
    .first<{ spec_json: string }>();
  if (
    !release ||
    (!refresh &&
      !(await regionalFleetHostsReady(
        env,
        source,
        FleetReleaseSpec.parse(JSON.parse(release.spec_json)),
        true,
      )))
  )
    return null;
  const creation = await prepareFleetPatchInsert(
    env,
    source.node_id,
    {
      node_uid: source.node_uid,
      assignment_revision: source.assignment_revision,
      release_id: source.release_id,
      address: source.address,
      maintenance_acknowledged: true,
    },
    undefined,
    source,
  );
  try {
    const result = await creation.insert.run();
    if (result.meta.changes !== 1) return closed();
  } catch (error) {
    const committed = await env.DB.prepare(
      "SELECT operation_id FROM fleet_patch_operations WHERE finalization_of=?",
    )
      .bind(hostOperationId)
      .first<{ operation_id: string }>();
    if (!committed) throw error;
    await startFleetPatch(env, committed.operation_id);
    return status(await readFleetPatch(env, committed.operation_id));
  }
  await startFleetPatch(env, creation.id);
  return status(await readFleetPatch(env, creation.id));
}
/** The last host-qualified member starts one pending final pass; repeated Workflow turns select the same row. */
export async function continueFleetPatchRegion(
  env: Env,
  id: string,
): Promise<FleetPatchStatus | null> {
  const row = await readFleetPatch(env, id);
  if (
    !["complete", "host_ready"].includes(row.stage) ||
    row.state !== "confirmed"
  )
    return closed();
  const active = await env.DB.prepare(
    "SELECT * FROM fleet_patch_operations WHERE region_id=? AND stage NOT IN('complete','host_ready')",
  )
    .bind(row.region_id)
    .first<PatchRow>();
  if (active) {
    await startFleetPatch(env, active.operation_id);
    return status(active);
  }
  const priorMaterial = await env.DB.prepare(
    `SELECT h.operation_id FROM fleet_patch_operations h JOIN regions r ON r.id=h.region_id JOIN nodes n ON n.id=h.node_id JOIN fleet_node_releases a ON a.node_id=n.id WHERE h.region_id=? AND h.release_id=? AND h.spec_sha256=? AND h.region_revision=? AND h.stage IN('host_ready','complete') AND h.state='confirmed' AND h.material_revision<r.bootstrap_material_revision AND h.node_uid=n.node_uid AND n.lost_at IS NULL AND a.node_uid=n.node_uid AND a.release_id=h.release_id AND a.revision=h.assignment_revision AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.node_id=h.node_id AND f.node_uid=h.node_uid AND f.release_id=h.release_id AND f.assignment_revision=h.assignment_revision AND f.region_revision=h.region_revision AND f.material_revision=r.bootstrap_material_revision) ORDER BY h.updated_at DESC,h.rowid DESC LIMIT 1`,
  )
    .bind(row.region_id, row.release_id, row.spec_sha256, row.region_revision)
    .first<{ operation_id: string }>();
  if (priorMaterial) {
    const refresh = await ensureFleetPatchFinalization(
      env,
      priorMaterial.operation_id,
    );
    if (refresh) return refresh;
  }
  const pending = await env.DB.prepare(
    `SELECT h.operation_id FROM fleet_patch_operations h JOIN regions r ON r.id=h.region_id WHERE h.region_id=? AND h.release_id=? AND h.spec_sha256=? AND h.region_revision=? AND h.material_revision=r.bootstrap_material_revision AND h.stage='host_ready' AND h.state='confirmed' AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.node_id=h.node_id AND f.node_uid=h.node_uid AND f.release_id=h.release_id AND f.assignment_revision=h.assignment_revision AND f.region_revision=h.region_revision AND f.material_revision=r.bootstrap_material_revision AND f.stage='complete' AND f.state='confirmed') ORDER BY h.created_at LIMIT 1`,
  )
    .bind(row.region_id, row.release_id, row.spec_sha256, row.region_revision)
    .first<{ operation_id: string }>();
  if (pending) {
    const next = await ensureFleetPatchFinalization(env, pending.operation_id);
    if (next) return next;
  }
  const stale = await env.DB.prepare(
    `SELECT p.operation_id FROM fleet_patch_operations p JOIN regions r ON r.id=p.region_id JOIN nodes n ON n.id=p.node_id JOIN fleet_node_releases a ON a.node_id=n.id WHERE p.region_id=? AND p.release_id=? AND p.spec_sha256=? AND p.region_revision=? AND p.stage='complete' AND p.state='confirmed' AND p.material_revision<r.bootstrap_material_revision AND p.node_uid=n.node_uid AND a.node_uid=n.node_uid AND a.revision=p.assignment_revision AND a.release_id=p.release_id AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.node_id=p.node_id AND f.node_uid=p.node_uid AND f.release_id=p.release_id AND f.assignment_revision=p.assignment_revision AND f.material_revision=r.bootstrap_material_revision) ORDER BY p.updated_at DESC LIMIT 1`,
  )
    .bind(row.region_id, row.release_id, row.spec_sha256, row.region_revision)
    .first<{ operation_id: string }>();
  return stale ? ensureFleetPatchFinalization(env, stale.operation_id) : null;
}
/** After current-material host completion, refresh only already-selected physical storage; no pool/class creation. */
export async function refreshFleetPatchRegionStorage(
  env: Env,
  id: string,
): Promise<boolean> {
  const row = await readFleetPatch(env, id);
  if (row.stage !== "complete" || row.state !== "confirmed") return closed();
  const selected = await env.DB.prepare(
    `SELECT s.spec_json FROM fleet_region_releases f JOIN fleet_releases s ON s.id=f.release_id WHERE f.region_id=? AND f.release_id=? AND f.revision=? AND s.spec_sha256=?`,
  )
    .bind(row.region_id, row.release_id, row.region_revision, row.spec_sha256)
    .first<{ spec_json: string }>();
  if (!selected) return closed();
  const spec = FleetReleaseSpec.parse(JSON.parse(selected.spec_json)),
    members = await env.DB.prepare(
      "SELECT n.id,EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=n.id) selected FROM nodes n WHERE n.region_id=? AND n.lost_at IS NULL",
    )
      .bind(row.region_id)
      .all<{ id: string; selected: number }>();
  const { refreshNodeThinStorageMaterial } =
    await import("./node-thin-storage-material.ts");
  let qualified = true;
  for (const member of members.results) {
    if (!member.selected) {
      if (spec.thin_storage_qualification) qualified = false;
      continue;
    }
    const current = await refreshNodeThinStorageMaterial(env, member.id);
    qualified = qualified && current.qualified;
  }
  return qualified;
}
/** Reopen only original patch-owned closures, and only after every physical member has final runtime/DB acceptance. */
export async function restoreFleetPatchPlacements(
  env: Env,
  id: string,
): Promise<boolean> {
  const row = await readFleetPatch(env, id);
  if (row.stage !== "complete" || row.state !== "confirmed") return closed();
  const current = await env.DB.prepare(
    `SELECT s.spec_json,r.bootstrap_material_revision material_revision FROM fleet_region_releases f JOIN fleet_releases s ON s.id=f.release_id JOIN regions r ON r.id=f.region_id WHERE f.region_id=? AND f.release_id=? AND f.revision=? AND s.spec_sha256=?`,
  )
    .bind(row.region_id, row.release_id, row.region_revision, row.spec_sha256)
    .first<{ spec_json: string; material_revision: number }>();
  if (!current) return closed();
  const incomplete = await env.DB.prepare(
    `SELECT 1 missing FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.region_id=? AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.release_id=? AND p.spec_sha256=? AND p.assignment_revision=a.revision AND p.region_revision=? AND p.material_revision=(SELECT bootstrap_material_revision FROM regions WHERE id=n.region_id) AND p.stage='complete' AND p.state='confirmed') LIMIT 1`,
  )
    .bind(row.region_id, row.release_id, row.spec_sha256, row.region_revision)
    .first();
  if (incomplete) return false;
  const spec = FleetReleaseSpec.parse(JSON.parse(current.spec_json));
  if (
    Object.values(spec.roles).some(
      (role) => role.host_configuration_required,
    ) &&
    !(await regionalFleetHostsReady(
      env,
      { ...row, material_revision: current.material_revision },
      spec,
      true,
    ))
  )
    return false;
  const { readCurrentNodeThinStorage } = await import("./node-thin-storage.ts");
  const storageMembers = await env.DB.prepare(
    "SELECT id FROM nodes WHERE region_id=? AND lost_at IS NULL",
  )
    .bind(row.region_id)
    .all<{ id: string }>();
  for (const member of storageMembers.results) {
    const storage = await readCurrentNodeThinStorage(env, member.id);
    if (
      (spec.thin_storage_qualification || storage) &&
      !storage?.authority?.write_allowed
    )
      return false;
  }
  await env.DB.prepare(
    `UPDATE nodes SET database_placement_closed_at=NULL,updated_at=? WHERE region_id=? AND EXISTS(SELECT 1 FROM fleet_patch_operations p,json_each(p.cluster_nodes_json) j WHERE p.region_id=nodes.region_id AND p.release_id=? AND p.spec_sha256=? AND p.region_revision=? AND p.bootstrap_operation_id IS NULL AND p.stage IN('host_ready','complete') AND json_extract(j.value,'$.node_id')=nodes.id AND json_extract(j.value,'$.node_uid')=nodes.node_uid AND json_extract(j.value,'$.previous_placement_closed_at') IS NULL AND nodes.database_placement_closed_at=p.created_at)
    AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations WHERE region_id=? AND stage NOT IN('complete','host_ready'))`,
  )
    .bind(
      new Date().toISOString(),
      row.region_id,
      row.release_id,
      row.spec_sha256,
      row.region_revision,
      row.region_id,
    )
    .run();
  return true;
}
async function prepareFleetPatchInsert(
  env: Env,
  nodeId: string,
  input: FleetPatchRequest,
  parent?: { operation_id: string; joined_reference: string },
  finalization?: PatchRow,
) {
  const selected = await env.DB.prepare(
    `SELECT n.region_id,n.node_uid,n.ready,n.lost_at,n.last_observed_at,a.revision,a.release_id,f.revision region_revision,s.spec_sha256,s.spec_json,a.role
    FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id JOIN fleet_releases s ON s.id=a.release_id
    WHERE n.id=? AND a.node_uid=n.node_uid AND f.release_id=a.release_id`,
  )
    .bind(nodeId)
    .first<{
      region_id: string;
      node_uid: string;
      ready: number;
      lost_at: string | null;
      last_observed_at: string | null;
      revision: number;
      release_id: string;
      region_revision: number;
      spec_sha256: string;
      spec_json: string;
      role: "control_relay" | "customer";
    }>();
  if (
    !selected ||
    selected.node_uid !== input.node_uid ||
    selected.revision !== input.assignment_revision ||
    selected.release_id !== input.release_id ||
    selected.lost_at ||
    !selected.ready ||
    !selected.last_observed_at ||
    !Number.isFinite(Date.parse(selected.last_observed_at)) ||
    Date.parse(selected.last_observed_at) < Date.now() - 180_000 ||
    Date.parse(selected.last_observed_at) > Date.now() + 5000
  )
    return closed();
  const ref = await loadCurrentRegionMaterialReference(
      env.DB,
      selected.region_id,
      "join_bundle",
    ),
    bundle = await effectiveFleetRegionJoin(
      env,
      selected.region_id,
      ref.revision,
      await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref),
    );
  const clusterNodes = await env.DB.prepare(
    `SELECT n.id node_id,n.node_uid,n.k8s_node_name,a.revision assignment_revision,n.database_placement_closed_at previous_placement_closed_at FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.region_id=? AND n.lost_at IS NULL AND a.node_uid=n.node_uid AND a.release_id=? ORDER BY n.id`,
  )
    .bind(selected.region_id, input.release_id)
    .all();
  const count = await env.DB.prepare(
    "SELECT count(*) count FROM nodes WHERE region_id=? AND lost_at IS NULL",
  )
    .bind(selected.region_id)
    .first<{ count: number }>();
  if (!count || count.count !== clusterNodes.results.length || !count.count)
    return closed();
  const selectedSpec = FleetReleaseSpec.parse(JSON.parse(selected.spec_json));
  await retainedThinPatchRequiresHost(
    env,
    selected.region_id,
    input.release_id,
  );
  const host = selectedSpec.roles[selected.role].host_configuration_required
    ? await ensureNodeHostConfiguration(env, {
        node_id: nodeId,
        node_uid: input.node_uid,
      })
    : undefined;
  const id = newOperationId(),
    now = new Date().toISOString();

  const insert = env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,bootstrap_operation_id,bootstrap_joined_reference,host_configuration_revision,host_configuration_sha256,finalization_of,baseline_json,observed_json,talos_upgrade_receipt_json,revision,stage,state,created_at,updated_at,deadline_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'pending',?,?,? WHERE EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id
        WHERE n.id=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds') AND a.node_uid=n.node_uid AND a.revision=? AND a.release_id=? AND f.release_id=a.release_id AND f.revision=? AND r.bootstrap_material_revision=?)
      AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations WHERE region_id=? AND stage NOT IN('complete','host_ready'))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN nodes n ON n.id=json_extract(j.value,'$.node_id') LEFT JOIN fleet_node_releases a ON a.node_id=n.id
        WHERE n.id IS NULL OR a.node_id IS NULL OR n.region_id<>? OR n.node_uid<>json_extract(j.value,'$.node_uid') OR n.lost_at IS NOT NULL OR a.node_uid<>n.node_uid OR a.release_id<>? OR a.revision<>json_extract(j.value,'$.assignment_revision') OR n.database_placement_closed_at IS NOT json_extract(j.value,'$.previous_placement_closed_at'))
      AND (SELECT count(*) FROM nodes WHERE region_id=? AND lost_at IS NULL)=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM node_bootstrap_jobs j JOIN node_additions a ON a.operation_id=j.operation_id JOIN nodes n ON n.id=j.node_id WHERE j.operation_id=? AND j.node_id=? AND j.region_id=? AND j.authorized=1 AND j.admitted=0 AND j.cancelled=0 AND j.admission_authorized=1 AND a.status='bootstrapping' AND n.provider_instance_id=a.provider_instance_id AND json_extract(j.admission_binding_json,'$.node_uid')=? AND json_extract(j.admission_binding_json,'$.kube_system_uid')=? AND json_extract(a.checkpoint_json,'$.stage')='joined' AND json_extract(a.checkpoint_json,'$.reference')=? AND json_extract(a.network_json,'$.checkpoint_reference')=? AND json_extract(a.capacity_json,'$.checkpoint_reference')=? AND j.input_hash||':'||json_extract(j.admission_binding_json,'$.checkpoint_revision')=?))`,
  ).bind(
    id,
    nodeId,
    selected.region_id,
    input.node_uid,
    bundle.kube_system_uid,
    input.release_id,
    selected.spec_sha256,
    input.assignment_revision,
    selected.region_revision,
    ref.revision,
    input.address,
    JSON.stringify(clusterNodes.results),
    parent?.operation_id ?? null,
    parent?.joined_reference ?? null,
    host?.revision ?? null,
    host?.sha256 ?? null,
    finalization?.operation_id ?? null,
    finalization?.observed_json ?? null,
    finalization?.observed_json ?? null,
    finalization?.talos_upgrade_receipt_json ?? null,
    finalization
      ? finalization.material_revision !== ref.revision &&
        selectedSpec.roles[selected.role].host_configuration_required
        ? "host_config"
        : "runtime_admission"
      : "preflight",
    now,
    now,
    new Date(Date.now() + 3_600_000).toISOString(),
    nodeId,
    input.node_uid,
    input.assignment_revision,
    input.release_id,
    selected.region_revision,
    ref.revision,
    selected.region_id,
    JSON.stringify(clusterNodes.results),
    selected.region_id,
    input.release_id,
    selected.region_id,
    count.count,
    parent?.operation_id ?? null,
    parent?.operation_id ?? null,
    nodeId,
    selected.region_id,
    input.node_uid,
    bundle.kube_system_uid,
    parent?.joined_reference ?? null,
    parent?.joined_reference ?? null,
    parent?.joined_reference ?? null,
    parent?.joined_reference ?? null,
  );
  const closePlacements = env.DB.prepare(
    `UPDATE nodes SET database_placement_closed_at=COALESCE(database_placement_closed_at,?),updated_at=? WHERE region_id=? AND EXISTS(SELECT 1 FROM fleet_patch_operations p,json_each(p.cluster_nodes_json) j WHERE p.operation_id=? AND p.bootstrap_operation_id IS NULL AND json_extract(j.value,'$.node_id')=nodes.id AND json_extract(j.value,'$.node_uid')=nodes.node_uid AND nodes.database_placement_closed_at IS json_extract(j.value,'$.previous_placement_closed_at'))`,
  ).bind(now, now, selected.region_id, id);
  return {
    id,
    now,
    region_id: selected.region_id,
    count: count.count,
    insert,
    closePlacements,
  };
}
export async function createFleetPatch(
  c: ApiContext,
  nodeId: string,
  input: FleetPatchRequest,
) {
  await requireScope(c, "admin");
  if (!c.req.header("Idempotency-Key"))
    throw new ApiError(
      "invalid_request",
      "Idempotency-Key is required for fleet patches",
    );
  const output = async (id: string) => {
    const row = await readFleetPatch(c.env, id);
    if (
      !["complete", "host_ready"].includes(row.stage) &&
      row.state !== "halted"
    )
      await startFleetPatch(c.env, id);
    return c.json(status(row), 202);
  };
  return withIdempotency(c, {
    replay: output,
    execute: async (lease) => {
      const creation = await prepareFleetPatchInsert(c.env, nodeId, input);
      const results = await c.env.DB.batch([
        creation.insert,
        lease.completeStatement(creation.id, 202, {
          sql: "changes()=1",
          bindings: [],
        }),
        creation.closePlacements,
      ]);
      if (
        results[0]!.meta.changes !== 1 ||
        results[2]!.meta.changes !== creation.count
      )
        return closed();
      return output(creation.id);
    },
  });
}
/** Fleet desired-state reconciliation reuses the exact persisted patch, including an uncertain dispatch. */
export async function ensureRetainedFleetPatch(
  env: Env,
  nodeId: string,
  input: FleetPatchRequest,
): Promise<FleetPatchStatus> {
  const read = () =>
    env.DB.prepare(
      "SELECT * FROM fleet_patch_operations WHERE node_id=? AND node_uid=? AND release_id=? AND assignment_revision=? AND bootstrap_operation_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
      .bind(nodeId, input.node_uid, input.release_id, input.assignment_revision)
      .first<PatchRow>();
  const existing = await read();
  if (existing) {
    if (
      !["complete", "host_ready"].includes(existing.stage) &&
      existing.state !== "halted"
    ) {
      await assertFleetPatchAuthority(env, existing, true);
      if (Date.parse(existing.deadline_at) <= Date.now()) {
        const changed = await env.DB.prepare(
          `UPDATE fleet_patch_operations SET deadline_at=?,updated_at=? WHERE operation_id=? AND revision=? AND ${authoritySql}`,
        )
          .bind(
            new Date(Date.now() + 3600000).toISOString(),
            new Date().toISOString(),
            existing.operation_id,
            existing.revision,
          )
          .run();
        if (changed.meta.changes !== 1) return closed();
      }
      await startFleetPatch(env, existing.operation_id);
    }
    return status(await readFleetPatch(env, existing.operation_id));
  }
  const creation = await prepareFleetPatchInsert(env, nodeId, input);
  try {
    const result = await env.DB.batch([
      creation.insert,
      creation.closePlacements,
    ]);
    if (
      result[0]!.meta.changes !== 1 ||
      result[1]!.meta.changes !== creation.count
    )
      return closed();
  } catch (error) {
    // A committed row is the only authority to recover a lost D1 response; never insert blindly again.
    const committed = await read();
    if (!committed) throw error;
    await startFleetPatch(env, committed.operation_id);
    return status(await readFleetPatch(env, committed.operation_id));
  }
  await startFleetPatch(env, creation.id);
  return status(await readFleetPatch(env, creation.id));
}
/** Future AddNode only. This never reopens an admitted job and never closes existing capacity. */
export async function ensureBootstrapFleetPatch(
  env: Env,
  parentOperationId: string,
): Promise<FleetPatchStatus> {
  const job = await readBootstrapJob(env.DB, parentOperationId);
  if (
    job.admitted ||
    job.cancelled ||
    !job.authorized ||
    !job.admission_authorized
  )
    return closed();
  const previous = await env.DB.prepare(
    "SELECT * FROM fleet_patch_operations WHERE bootstrap_operation_id=?",
  )
    .bind(parentOperationId)
    .first<PatchRow>();
  if (previous) {
    await assertBootstrapFleetParent(env, previous);
    if (previous.stage !== "complete") {
      await assertFleetPatchAuthority(env, previous, true);
      if (Date.parse(previous.deadline_at) <= Date.now()) {
        const renewed = await env.DB.prepare(
          `UPDATE fleet_patch_operations SET deadline_at=?,updated_at=? WHERE operation_id=? AND revision=? AND ${authoritySql}`,
        )
          .bind(
            new Date(Date.now() + 3600000).toISOString(),
            new Date().toISOString(),
            previous.operation_id,
            previous.revision,
          )
          .run();
        if (renewed.meta.changes !== 1) return closed();
      }
      await startFleetPatch(env, previous.operation_id);
    }
    return status(await readFleetPatch(env, previous.operation_id));
  }
  await prepareNodePostjoinRuntime(env, parentOperationId);
  const current = await readBootstrapJob(env.DB, parentOperationId),
    sealed = await bootstrapJobInput(env, current),
    reference = sealed.spec.postjoin_release,
    binding = NodeBootstrapAdmissionBinding.parse(
      JSON.parse(current.admission_binding_json ?? "null"),
    );
  if (!reference) return closed();
  const assignment = await env.DB.prepare(
    "SELECT revision FROM fleet_node_releases WHERE node_id=? AND node_uid=? AND release_id=?",
  )
    .bind(job.node_id, binding.node_uid, reference.release_id)
    .first<{ revision: number }>();
  if (!assignment) return closed();
  const creation = await prepareFleetPatchInsert(
    env,
    job.node_id,
    {
      node_uid: binding.node_uid,
      assignment_revision: assignment.revision,
      release_id: reference.release_id,
      address: sealed.spec.hardware.ipv4,
      maintenance_acknowledged: true,
    },
    {
      operation_id: parentOperationId,
      joined_reference: `${current.input_hash}:${binding.checkpoint_revision}`,
    },
  );
  try {
    const result = await creation.insert.run();
    if (result.meta.changes !== 1) return closed();
  } catch (error) {
    const committed = await env.DB.prepare(
      "SELECT * FROM fleet_patch_operations WHERE bootstrap_operation_id=?",
    )
      .bind(parentOperationId)
      .first<PatchRow>();
    if (!committed) throw error;
    await assertBootstrapFleetParent(env, committed);
    if (committed.stage !== "complete")
      await startFleetPatch(env, committed.operation_id);
    return status(committed);
  }
  const created = await readFleetPatch(env, creation.id);
  await assertBootstrapFleetParent(env, created);
  await startFleetPatch(env, creation.id);
  return status(created);
}
export async function getFleetPatch(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  return c.json(status(await readFleetPatch(c.env, id)), 200);
}
export async function resumeFleetPatch(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  const row = await readFleetPatch(c.env, id);
  await assertFleetPatchAuthority(c.env, row, true);
  const updated = await c.env.DB.prepare(
    `UPDATE fleet_patch_operations SET deadline_at=?,updated_at=? WHERE operation_id=? AND revision=? AND ${authoritySql}`,
  )
    .bind(
      new Date(Date.now() + 3_600_000).toISOString(),
      new Date().toISOString(),
      id,
      row.revision,
    )
    .run();
  if (updated.meta.changes !== 1) return closed();
  await startFleetPatch(c.env, id);
  return c.json(status(await readFleetPatch(c.env, id)), 200);
}
export async function startFleetPatch(env: Env, id: string) {
  const row = await readFleetPatch(env, id);
  await assertFleetPatchAuthority(env, row);
  try {
    await env.PATCH_NODE.create({ id, params: { operation_id: id } });
  } catch {
    const instance = await env.PATCH_NODE.get(id),
      state = await instance.status();
    if (["errored", "terminated", "complete"].includes(state.status))
      await instance.restart();
    else if (state.status === "paused") await instance.resume();
  }
}
export async function recordFleetPatchFailure(
  env: Env,
  id: string,
  code: string,
) {
  const safe = /^patch_[a-z0-9_]{1,80}$/.test(code)
    ? code
    : "patch_execution_failed";
  await env.DB.prepare(
    `UPDATE fleet_patch_operations SET error_code=COALESCE(error_code,?),updated_at=? WHERE operation_id=? AND stage NOT IN('complete','host_ready') AND ${authoritySql}`,
  )
    .bind(safe, new Date().toISOString(), id)
    .run();
}
export async function recordFleetPatchCheckpoint(
  env: Env,
  id: string,
  input: FleetPatchCheckpoint,
) {
  const row = await readFleetPatch(env, id);
  await assertFleetPatchAuthority(env, row);
  if (
    input.facts.node_uid !== row.node_uid ||
    input.facts.cluster_uid !== row.cluster_uid ||
    Date.parse(input.facts.observed_at) <
      Date.now() - FLEET_PATCH_PROOF_MAX_AGE_MS ||
    Date.parse(input.facts.observed_at) > Date.now() + 5000 ||
    (row.baseline_json &&
      JSON.parse(row.baseline_json).system_uuid !== input.facts.system_uuid)
  )
    return closed();
  const selected = await fleetPatchInput(env, id);
  if (!fleetPatchCheckpointAllowed(selected, input)) return closed();
  if (
    input.stage === "runtime_admission" &&
    input.state !== "pending" &&
    !selected.regional_hosts_ready
  )
    return closed();
  let postgresProgress = input.postgres_progress;
  if (input.stage === "postgres" && input.state === "confirmed") {
    const { reconcileFleetPostgresRelease } =
      await import("./fleet-postgres.ts");
    postgresProgress = FleetPostgresPatchProgress.parse(
      await reconcileFleetPostgresRelease(
        env,
        row.region_id,
        row.release_id,
        id,
      ),
    );
    if (postgresProgress.pending !== 0 || postgresProgress.errors.length !== 0)
      return closed();
  }
  if (["complete", "host_ready"].includes(input.stage)) {
    if (selected.spec.roles[selected.role].host_configuration_required) {
      const pool = selected.compute_pool,
        observed = selected.compute_pool_observation,
        host = selected.host_configuration?.status;
      if (
        !pool ||
        !observed ||
        !host ||
        input.facts.host_configuration_sha256 !== host.sha256 ||
        (input.stage === "complete" &&
          (!selected.regional_hosts_ready ||
            input.facts.runtime_admission_sha256 !== host.profile_sha256 ||
            input.facts.runtime_admission_policy_revision !== pool.revision)) ||
        observed.node_uid !== row.node_uid ||
        observed.policy_revision !== pool.revision ||
        observed.material_revision !== row.material_revision ||
        Date.parse(observed.observed_at) < Date.now() - 120000 ||
        Date.parse(observed.observed_at) > Date.now() + 5000 ||
        JSON.stringify(observed.profile) !==
          JSON.stringify(pool.policy.profile) ||
        observed.slots.filter((slot) => slot.live && slot.sandbox_id === null)
          .length < pool.policy.target_slots
      )
        return closed();
    }
    const facts = input.facts.release_facts,
      receipt = selected.status.talos_upgrade_receipt;
    if (
      !facts ||
      !fleetPatchKubernetesImagesMatch(selected, input.facts) ||
      (selected.spec.roles[selected.role].kubernetes_images &&
        facts.kubernetes_image_provenance?.observed_at !==
          input.facts.observed_at) ||
      !receipt ||
      facts.boot_id !== input.facts.boot_id ||
      facts.talos_provenance?.installer !== receipt.installer ||
      facts.talos_provenance.boot_id !== input.facts.boot_id ||
      facts.talos_provenance.node_uid !== row.node_uid ||
      facts.talos_provenance.cluster_uid !== row.cluster_uid ||
      mismatches(selected.spec, selected.role, facts).length
    )
      return closed();
    if (
      input.stage === "complete" &&
      (!selected.status.postgres_progress ||
        selected.status.postgres_progress.pending !== 0 ||
        selected.status.postgres_progress.errors.length)
    )
      return closed();
  }
  if (
    input.talos_upgrade_receipt &&
    ((Date.parse(input.talos_upgrade_receipt.completed_at) <
      Date.parse(row.created_at) - 5000 &&
      !(
        retainedTalosInstallationMatches(selected, input.facts) &&
        JSON.stringify(input.talos_upgrade_receipt) ===
          JSON.stringify(selected.retained_talos_installation?.receipt)
      )) ||
      Date.parse(input.talos_upgrade_receipt.completed_at) >
        Date.now() + 5000 ||
      (row.talos_upgrade_receipt_json &&
        JSON.stringify(JSON.parse(row.talos_upgrade_receipt_json)) !==
          JSON.stringify(input.talos_upgrade_receipt)))
  )
    return closed();
  let observationFence = "1=1",
    observationBindings: unknown[] = [],
    inventoryObservedAt = input.facts.observed_at;
  if (input.stage === "complete") {
    const previous = await env.DB.prepare(
      `SELECT o.node_uid,o.assignment_revision,o.agent_key_hash,o.facts_json,o.observed_at,r.agent_key_hash current_key
      FROM fleet_node_release_observations o JOIN nodes n ON n.id=o.node_id JOIN regions r ON r.id=n.region_id WHERE o.node_id=?`,
    )
      .bind(row.node_id)
      .first<{
        node_uid: string;
        assignment_revision: number;
        agent_key_hash: string;
        facts_json: string;
        observed_at: string;
        current_key: string;
      }>();
    if (previous) {
      if (
        Date.parse(previous.observed_at) > Date.parse(input.facts.observed_at)
      ) {
        const actual = FleetReleaseFacts.safeParse(
            JSON.parse(previous.facts_json),
          ),
          facts = input.facts.release_facts!,
          version = (value: string | undefined) => value?.replace(/^v/, "");
        if (
          !actual.success ||
          previous.node_uid !== row.node_uid ||
          previous.assignment_revision !== row.assignment_revision ||
          previous.agent_key_hash !== previous.current_key ||
          actual.data.boot_id !== facts.boot_id ||
          version(actual.data.talos_version) !== version(facts.talos_version) ||
          version(actual.data.kubernetes_version) !==
            version(facts.kubernetes_version) ||
          (
            [
              "talos_installer",
              "talos_schematic_sha256",
              "platform_source_commit",
              "configuration_schema_revision",
              "kubernetes_control_plane",
            ] as const
          ).some(
            (key) =>
              actual.data[key] !== undefined && actual.data[key] !== facts[key],
          ) ||
          (actual.data.kubelet_version !== undefined &&
            version(actual.data.kubelet_version) !==
              version(facts.kubelet_version)) ||
          actual.data.components.some((component) => {
            const proof = facts.components.find(
              (value) => value.name === component.name,
            );
            return (
              !proof ||
              (component.version !== undefined &&
                component.version !== proof.version) ||
              (component.sha256 !== undefined &&
                component.sha256 !== proof.sha256)
            );
          })
        )
          return closed();
        // The inventory remains monotonic; the independently qualified provenance keeps its original times.
        inventoryObservedAt = previous.observed_at;
      }
      // Fence the exact prior row, as agent observation merges do. A concurrent identity/report wins.
      observationFence = `EXISTS(SELECT 1 FROM fleet_node_release_observations o JOIN nodes n ON n.id=o.node_id JOIN regions r ON r.id=n.region_id WHERE o.node_id=? AND o.node_uid=? AND o.assignment_revision=? AND o.agent_key_hash=? AND o.observed_at=? AND o.facts_json=? AND r.agent_key_hash=?)`;
      observationBindings = [
        row.node_id,
        previous.node_uid,
        previous.assignment_revision,
        previous.agent_key_hash,
        previous.observed_at,
        previous.facts_json,
        previous.current_key,
      ];
    } else {
      observationFence =
        "NOT EXISTS(SELECT 1 FROM fleet_node_release_observations o WHERE o.node_id=?)";
      observationBindings = [row.node_id];
    }
  }
  const update = env.DB.prepare(
    `UPDATE fleet_patch_operations SET revision=revision+1,stage=?,state=?,baseline_json=COALESCE(baseline_json,?),observed_json=?,talos_upgrade_receipt_json=COALESCE(talos_upgrade_receipt_json,?),postgres_progress_json=COALESCE(?,postgres_progress_json),error_code=?,updated_at=? WHERE operation_id=? AND revision=? AND ${authoritySql} AND julianday(deadline_at)>julianday('now') AND (${observationFence})`,
  ).bind(
    input.stage,
    input.state,
    JSON.stringify(input.facts),
    JSON.stringify(input.facts),
    input.talos_upgrade_receipt
      ? JSON.stringify(input.talos_upgrade_receipt)
      : null,
    postgresProgress ? JSON.stringify(postgresProgress) : null,
    input.error_code,
    new Date().toISOString(),
    id,
    row.revision,
    ...observationBindings,
  );
  const updates = [update];
  if (["complete", "host_ready"].includes(input.stage)) {
    updates.push(
      env.DB.prepare(
        `INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at)
      SELECT p.node_id,p.node_uid,p.assignment_revision,r.agent_key_hash,?,?,? FROM fleet_patch_operations p JOIN regions r ON r.id=p.region_id WHERE p.operation_id=? AND p.stage IN('complete','host_ready') AND p.revision=?
      ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,assignment_revision=excluded.assignment_revision,agent_key_hash=excluded.agent_key_hash,facts_json=excluded.facts_json,observed_at=excluded.observed_at,received_at=excluded.received_at WHERE excluded.observed_at>=fleet_node_release_observations.observed_at`,
      ).bind(
        JSON.stringify(input.facts.release_facts),
        inventoryObservedAt,
        new Date().toISOString(),
        id,
        row.revision + 1,
      ),
    );
  }
  const result = await env.DB.batch(updates);
  if (result[0]!.meta.changes !== 1) return closed();
  if (
    input.stage === "complete" &&
    !selected.spec.roles[selected.role].host_configuration_required
  )
    await restoreFleetPatchPlacements(env, id);
  return status(await readFleetPatch(env, id));
}
export async function issueFleetPatchTransport(
  env: Env,
  id: string,
  capability: "talos_api" | "kubernetes_api",
  target: "node" | "control" = "node",
  verified?: Awaited<ReturnType<typeof authenticateFleetPatchContext>>,
) {
  const row = verified?.row ?? (await readFleetPatch(env, id)),
    input = verified?.input ?? (await fleetPatchInput(env, id, row)),
    service = env.BOOTSTRAP_RELAY_SERVICE;
  if (!service) return closed();
  if (
    target === "control" &&
    (capability !== "talos_api" || row.stage !== "kubernetes")
  )
    return closed();
  const endpoint = new URL(env.BOOTSTRAP_RELAY_URL);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.pathname !== BOOTSTRAP_RELAY_PATH ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    return closed();
  const signal = AbortSignal.timeout(10_000);
  const response = await service.fetch(
    new Request(new URL(BOOTSTRAP_RELAY_IDENTITY_PATH, endpoint), {
      signal,
      redirect: "manual",
    }),
  );
  if (response.status !== 200) return closed();
  const identity = await readBootstrapRelayIdentity(response, signal);
  if (
    identity.region !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    identity.issuer_region !== identity.region ||
    !identity.allowed_target_regions.includes(row.region_id) ||
    !identity.capabilities.includes(capability)
  )
    return closed();
  const address =
    capability === "talos_api"
      ? target === "control"
        ? new URL(input.cluster_endpoint).hostname
        : input.address
      : new URL(input.cluster_endpoint).hostname;
  const key = await bootstrapTransportSigningKey(
    env.BOOTSTRAP_RELAY_SIGNING_KEYS,
  );
  const token = await signBootstrapRelay({
    ...key,
    operation: id,
    node: row.node_id,
    region: row.region_id,
    issuer_region: identity.region,
    relay_epoch: identity.relay_epoch,
    revision: row.assignment_revision,
    capability,
    address,
  });
  await assertFleetPatchCurrent(env, row, false, input.compute_pool?.revision);
  return {
    websocket_url: input.callback.url.replace(/^https:/, "wss:") + "/relay",
    token,
    expectedTarget: { ip: address, port: BOOTSTRAP_PORTS[capability] },
  };
}

/** The final regional member's qualified readbacks synchronize metadata; this never patches an OS. */
export async function synchronizeFleetPatchRegionMaterial(
  env: Env,
  id: string,
): Promise<"synchronized" | "waiting_members"> {
  const row = await readFleetPatch(env, id);
  if (row.stage !== "complete" || row.state !== "confirmed") return closed();
  // A staged replacement owns current+1. Version-only synchronization must not occupy that
  // immutable envelope or publish old keys while the programmed rotation is still running.
  const rotating = await env.DB.prepare(
    `SELECT 1 pending FROM fleet_region_releases f JOIN regions r ON r.id=f.region_id,json_each(f.rollout_json,'$.regions') target WHERE f.region_id=? AND json_extract(target.value,'$.region_id')=f.region_id AND json_extract(target.value,'$.staged_material_revision') IS NOT NULL AND COALESCE(json_extract(target.value,'$.rotation.phase')='complete' AND json_extract(target.value,'$.rotation.state')='confirmed' AND r.bootstrap_material_revision>=json_extract(target.value,'$.staged_material_revision'),0)=0 LIMIT 1`,
  )
    .bind(row.region_id)
    .first();
  if (rotating) return "waiting_members";
  const unfinished = await env.DB.prepare(
    `SELECT 1 missing FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.region_id=? AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.release_id=? AND p.spec_sha256=? AND p.assignment_revision=a.revision AND p.region_revision=? AND p.stage='complete' AND p.state='confirmed') LIMIT 1`,
  )
    .bind(row.region_id, row.release_id, row.spec_sha256, row.region_revision)
    .first();
  if (unfinished) return "waiting_members";
  const selected = await env.DB.prepare(
    `SELECT s.spec_json FROM fleet_region_releases f JOIN fleet_releases s ON s.id=f.release_id JOIN fleet_node_releases a ON a.node_id=? JOIN nodes n ON n.id=a.node_id WHERE f.region_id=? AND f.release_id=? AND f.revision=? AND a.release_id=f.release_id AND a.revision=? AND a.node_uid=? AND n.node_uid=a.node_uid AND n.lost_at IS NULL`,
  )
    .bind(
      row.node_id,
      row.region_id,
      row.release_id,
      row.region_revision,
      row.assignment_revision,
      row.node_uid,
    )
    .first<{ spec_json: string }>();
  if (!selected) return closed();
  const spec = FleetReleaseSpec.parse(JSON.parse(selected.spec_json));
  const members = await env.DB.prepare(
    `SELECT n.id node_id,n.node_uid,n.k8s_node_name,n.provider_instance_id,a.role,a.release_id,a.revision assignment_revision,o.node_uid observed_node_uid,o.assignment_revision observed_assignment_revision,o.agent_key_hash observed_agent_key_hash,r.agent_key_hash,o.facts_json,o.observed_at FROM nodes n JOIN regions r ON r.id=n.region_id LEFT JOIN fleet_node_releases a ON a.node_id=n.id LEFT JOIN fleet_node_release_observations o ON o.node_id=n.id WHERE n.region_id=? AND n.lost_at IS NULL ORDER BY n.id`,
  )
    .bind(row.region_id)
    .all<{
      node_id: string;
      node_uid: string;
      k8s_node_name: string;
      provider_instance_id: string;
      role: "control_relay" | "customer";
      release_id: string;
      assignment_revision: number;
      observed_node_uid: string;
      observed_assignment_revision: number;
      observed_agent_key_hash: string;
      agent_key_hash: string;
      facts_json: string | null;
      observed_at: string | null;
    }>();
  if (!members.results.length) return closed();
  for (const member of members.results) {
    if (
      member.release_id !== row.release_id ||
      member.observed_node_uid !== member.node_uid ||
      member.observed_assignment_revision !== member.assignment_revision ||
      member.observed_agent_key_hash !== member.agent_key_hash ||
      !member.facts_json ||
      !member.observed_at ||
      Date.parse(member.observed_at) < Date.now() - 180000 ||
      Date.parse(member.observed_at) > Date.now() + 5000
    )
      return "waiting_members";
    const { FleetReleaseFacts } = await import("@pgcf/contracts/releases");
    if (
      mismatches(
        spec,
        member.role,
        FleetReleaseFacts.parse(JSON.parse(member.facts_json)),
      ).length
    )
      return "waiting_members";
  }
  const { readRegionBootstrapMaterial, synchronizeRegionBootstrapMaterial } =
    await import("./region-material-revisions.ts");
  const { loadRegionSeed, regionSeedReference } =
    await import("../crypto/bootstrap-credentials.ts");
  const { installationHash } = await import("./node-installation.ts");
  const current = await readRegionBootstrapMaterial(env, row.region_id),
    ref = await loadCurrentRegionMaterialReference(
      env.DB,
      row.region_id,
      "join_bundle",
    ),
    seed = await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(row.region_id, ref.revision),
    ),
    join = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref),
    target = spec.roles.customer;
  if (
    join.kube_system_uid !== row.cluster_uid ||
    spec.roles.control_relay.kubernetes_version !== target.kubernetes_version ||
    spec.roles.control_relay.talos_version !== target.talos_version
  )
    return closed();
  if (
    seed.kubernetes_version.replace(/^v/, "") ===
      target.kubernetes_version.replace(/^v/, "") &&
    seed.talos_version.replace(/^v/, "") ===
      target.talos_version.replace(/^v/, "")
  )
    return "synchronized";
  const nextSeed = {
      ...seed,
      kubernetes_version: target.kubernetes_version,
      talos_version: target.talos_version,
    },
    nextJoin = {
      ...join,
      kubernetes_version: target.kubernetes_version,
      talos_version: target.talos_version,
    },
    observed = {
      talos_version: target.talos_version,
      observed_at: new Date().toISOString(),
      kube_system_uid: row.cluster_uid,
      kubernetes_version: target.kubernetes_version,
      nodes: members.results.map(
        ({ node_id, node_uid, k8s_node_name, provider_instance_id }) => ({
          node_id,
          node_uid,
          k8s_node_name,
          provider_instance_id,
        }),
      ),
    };
  if (
    await env.DB.prepare(
      "SELECT 1 busy FROM node_thin_storage WHERE action_json IS NOT NULL LIMIT 1",
    ).first()
  )
    return "waiting_members";
  await synchronizeRegionBootstrapMaterial(
    env,
    row.region_id,
    RegionBootstrapMaterialUpdate.parse({
      expected_revision: current.revision,
      kubernetes_version: target.kubernetes_version,
      talos_version: target.talos_version,
      expected_seed_sha256: current.seed_sha256,
      expected_join_sha256: current.join_sha256,
      seed_sha256: await installationHash(nextSeed),
      join_sha256: await installationHash(nextJoin),
      provenance_sha256: await installationHash(observed),
      observed,
    }),
  );
  return "synchronized";
}
