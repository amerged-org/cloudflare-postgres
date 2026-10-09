// SPDX-License-Identifier: Apache-2.0
import {
  NodeBootstrapCheckpoint,
  NodeBootstrapAdmissionBinding,
} from "@pgcf/contracts/node-bootstrap";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { bootstrapJobInput, readBootstrapJob } from "./bootstrap-jobs.ts";
import { readNodePostjoinRelease } from "./node-postjoin-release.ts";
import {
  configureNodeThinStorage,
  thinVolumeProfile,
} from "./node-thin-storage-selection.ts";
import { readCurrentNodeThinStorage } from "./node-thin-storage.ts";
import { processNodeThinStorage } from "./node-thin-storage-execution.ts";
import { installationHash } from "./node-installation.ts";
const refused = (): never => {
  throw new ApiError(
    "conflict",
    "Original pending bootstrap thin-storage authority changed",
  );
};
/** Future original jobs only. Retained admitted installations cannot enter this path. */
export async function ensureBootstrapThinStorage(
  env: Env,
  parentOperationId: string,
): Promise<{ qualified: boolean }> {
  const job = await readBootstrapJob(env.DB, parentOperationId);
  if (job.admitted || job.cancelled || !job.authorized) return refused();
  const input = await bootstrapJobInput(env, job),
    expected = input.spec.postjoin_release;
  if (!expected) return refused();
  const selected = await readNodePostjoinRelease(
    env,
    job.region_id,
    expected,
    job.node_id,
  );
  if (!job.admission_authorized || !job.admission_binding_json)
    return refused();
  const binding = NodeBootstrapAdmissionBinding.parse(
    JSON.parse(job.admission_binding_json),
  );
  const checkpoint = NodeBootstrapCheckpoint.parse(
      JSON.parse(job.checkpoint_json),
    ),
    trial = checkpoint.storage_trial,
    last = trial?.runs.at(-1);
  if (
    !trial ||
    trial.node_uid !== binding.node_uid ||
    trial.cluster_uid !== binding.kube_system_uid ||
    !last ||
    last.stage !== "published" ||
    last.after?.vg_uuid !== trial.vg_uuid ||
    last.after.node_uid !== binding.node_uid
  )
    return refused();
  const patched = await env.DB.prepare(
    `SELECT 1 FROM fleet_patch_operations p JOIN node_bootstrap_jobs j ON j.operation_id=p.bootstrap_operation_id JOIN node_additions a ON a.operation_id=j.operation_id WHERE p.bootstrap_operation_id=? AND p.node_id=j.node_id AND p.node_uid=? AND p.cluster_uid=? AND p.release_id=? AND p.spec_sha256=? AND p.region_revision=? AND p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL AND j.authorized=1 AND j.admitted=0 AND j.cancelled=0 AND j.input_hash=? AND a.status='bootstrapping' AND json_extract(a.checkpoint_json,'$.stage')='joined' AND json_extract(a.checkpoint_json,'$.reference')=? AND json_extract(a.network_json,'$.checkpoint_reference')=json_extract(a.checkpoint_json,'$.reference') AND json_extract(a.capacity_json,'$.checkpoint_reference')=json_extract(a.checkpoint_json,'$.reference')`,
  )
    .bind(
      parentOperationId,
      binding.node_uid,
      binding.kube_system_uid,
      selected.reference.release_id,
      selected.reference.spec_sha256,
      selected.reference.region_revision,
      job.input_hash,
      `${job.input_hash}:${binding.checkpoint_revision}`,
    )
    .first();
  if (!patched) return refused();
  let current = await readCurrentNodeThinStorage(env, job.node_id);
  const profileHash = await installationHash(
    thinVolumeProfile(selected.storage),
  );
  if (
    current &&
    (current.row.node_uid !== binding.node_uid ||
      current.row.cluster_uid !== binding.kube_system_uid ||
      current.row.volume_group_uuid !== trial.vg_uuid ||
      current.row.profile_sha256 !== profileHash ||
      JSON.stringify(current.profile) !== JSON.stringify(selected.storage))
  )
    return refused();
  if (!current) {
    await configureNodeThinStorage(env, job.node_id, {
      expected_revision: 0,
      node_uid: binding.node_uid,
      address: input.spec.hardware.ipv4,
      volume_group_uuid: trial.vg_uuid,
      profile: selected.storage,
      allow_new_databases: false,
    });
  }
  await processNodeThinStorage(env, job.node_id);
  current = await readCurrentNodeThinStorage(env, job.node_id);
  if (
    current?.row.status === "ready" &&
    current.authority?.write_allowed &&
    current.row.allow_new_databases === 0
  ) {
    await configureNodeThinStorage(env, job.node_id, {
      expected_revision: current.row.profile_revision,
      node_uid: binding.node_uid,
      address: input.spec.hardware.ipv4,
      volume_group_uuid: trial.vg_uuid,
      profile: selected.storage,
      allow_new_databases: true,
    });
    await processNodeThinStorage(env, job.node_id);
  }
  return {
    qualified: await bootstrapThinStorageQualified(env, parentOperationId),
  };
}

/** Central admission uses the same sealed standing template and actual current physical receipt. */
export async function bootstrapThinStorageQualified(
  env: Env,
  parentOperationId: string,
): Promise<boolean> {
  const job = await readBootstrapJob(env.DB, parentOperationId);
  if (
    job.admitted ||
    job.cancelled ||
    !job.authorized ||
    !job.admission_authorized ||
    !job.admission_binding_json
  )
    return false;
  const input = await bootstrapJobInput(env, job);
  if (!input.spec.postjoin_release) return false;
  const selected = await readNodePostjoinRelease(
    env,
    job.region_id,
    input.spec.postjoin_release,
    job.node_id,
  );
  const binding = JSON.parse(job.admission_binding_json) as {
    node_uid: string;
    kube_system_uid: string;
  };
  const current = await readCurrentNodeThinStorage(env, job.node_id);
  return Boolean(
    current &&
    current.row.allow_new_databases === 1 &&
    current.row.node_uid === binding.node_uid &&
    current.row.cluster_uid === binding.kube_system_uid &&
    current.row.profile_sha256 ===
      (await installationHash(thinVolumeProfile(selected.storage))) &&
    JSON.stringify(current.profile) === JSON.stringify(selected.storage) &&
    current.row.status === "ready" &&
    current.authority?.write_allowed &&
    current.authority.data_accounting_complete &&
    current.authority.pool_uuid,
  );
}
