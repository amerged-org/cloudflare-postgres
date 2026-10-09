// SPDX-License-Identifier: Apache-2.0
import {
  NodeHostConfigurationPrivate,
  NodeHostConfigurationStatus,
  type NodeHostConfigurationStatus as HostStatus,
} from "@pgcf/contracts/node-host-configuration";
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import {
  encryptCustodyDocument,
  decryptCustodyDocument,
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
  loadRegionAgentKey,
  agentKeyReference,
} from "../crypto/bootstrap-credentials.ts";
import {
  installationHash,
  canonicalInstallation,
} from "./node-installation.ts";
import { sandboxHostFiles } from "../../../../infra/talos/sandbox/configuration.ts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { readBootstrapJob, admissionAuthority } from "./bootstrap-jobs.ts";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
import { retainedThickStorageAssignments } from "./storage-capacity.ts";
import { DatabaseId } from "@pgcf/contracts";

interface Row extends HostStatus {
  kid: string;
  iv: string;
  ciphertext: string;
}
const closed = (): never => {
  throw new ApiError(
    "conflict",
    "Current node host configuration authority changed",
  );
};
const scope = (row: HostStatus) =>
  [
    "pgcf-node-host-config/v1",
    row.node_id,
    row.node_uid,
    row.region_id,
    row.cluster_uid,
    row.material_revision,
    row.revision,
    row.sha256,
  ] as const;
async function row(env: Env, nodeId: string) {
  return env.DB.prepare(
    "SELECT 1 version,* FROM node_host_configurations WHERE node_id=?",
  )
    .bind(nodeId)
    .first<Row>();
}
export async function readNodeHostConfiguration(env: Env, nodeId: string) {
  const value = await row(env, nodeId);
  if (!value)
    throw new ApiError("not_found", "Node host configuration unavailable");
  return NodeHostConfigurationStatus.strip().parse(value);
}
async function authority(
  env: Env,
  nodeId: string,
  nodeUid: string,
  requireFresh = true,
) {
  const source = await env.DB.prepare(
    `SELECT n.region_id,n.node_uid,p.revision pool_policy_revision,p.release_id,p.policy_json,s.spec_json,r.bootstrap_material_revision material_revision FROM nodes n JOIN regions r ON r.id=n.region_id JOIN node_compute_pool_policies p ON p.node_id=n.id AND p.node_uid=n.node_uid JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid AND a.release_id=p.release_id JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=p.release_id JOIN fleet_releases s ON s.id=p.release_id WHERE n.id=? AND n.node_uid=? AND n.lost_at IS NULL AND (?=0 OR(n.ready=1 AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')))`,
  )
    .bind(nodeId, nodeUid, Number(requireFresh))
    .first<{
      region_id: string;
      node_uid: string;
      pool_policy_revision: number;
      release_id: string;
      policy_json: string;
      material_revision: number;
      spec_json: string;
    }>();
  if (!source) return closed();
  const policy = ComputePoolPolicy.parse(JSON.parse(source.policy_json)),
    ref = await loadCurrentRegionMaterialReference(
      env.DB,
      source.region_id,
      "join_bundle",
    );
  if (ref.revision !== source.material_revision) return closed();
  const material = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref);
  const pinned = (
      JSON.parse(source.spec_json) as { storage_authority_keys_sha256?: string }
    ).storage_authority_keys_sha256,
    storageAuthority = pinned
      ? {
          ...(await storageAuthorityPublicKeys(env)),
          legacy_database_ids: (
            await retainedThickStorageAssignments(env, source.region_id)
          )
            .filter(
              (value) => value.node_id === nodeId && value.node_uid === nodeUid,
            )
            .map((value) => value.database_id)
            .sort(),
        }
      : undefined;
  if (storageAuthority && storageAuthority.sha256 !== pinned) return closed();
  return {
    ...source,
    profile: policy.profile,
    profile_sha256: await installationHash(policy.profile),
    cluster_uid: material.kube_system_uid,
    storageAuthority,
  };
}
function same(
  source: Awaited<ReturnType<typeof authority>>,
  stored: HostStatus,
) {
  return (
    source.node_uid === stored.node_uid &&
    source.region_id === stored.region_id &&
    source.cluster_uid === stored.cluster_uid &&
    source.material_revision === stored.material_revision &&
    source.release_id === stored.release_id &&
    source.profile_sha256 === stored.profile_sha256
  );
}
/** Internal patch caller may omit expected_revision; administration always supplies its reviewed CAS. */
export async function ensureNodeHostConfiguration(
  env: Env,
  input: { node_id: string; node_uid: string; expected_revision?: number },
): Promise<HostStatus> {
  const source = await authority(env, input.node_id, input.node_uid),
    previous = await row(env, input.node_id);
  if (
    input.expected_revision !== undefined &&
    input.expected_revision !== (previous?.revision ?? 0)
  )
    return closed();
  const next = (previous?.revision ?? 0) + 1,
    base = {
      version: 1 as const,
      node_id: input.node_id,
      node_uid: source.node_uid,
      region_id: source.region_id,
      cluster_uid: source.cluster_uid,
      material_revision: source.material_revision,
      revision: next,
      release_id: source.release_id,
      pool_policy_revision: source.pool_policy_revision,
      profile_sha256: source.profile_sha256,
    };
  const api = new URL(env.NODE_BOOTSTRAP_CALLBACK_URL).origin,
    agent = await loadRegionAgentKey(
      env.DB,
      env,
      agentKeyReference(source.region_id),
    ),
    files = sandboxHostFiles(
      base,
      api + "/",
      agent,
      source.profile.image,
      source.storageAuthority,
    ),
    sha256 = await installationHash(files);
  if (previous && same(source, previous) && previous.sha256 === sha256)
    return NodeHostConfigurationStatus.strip().parse(previous);
  const status = NodeHostConfigurationStatus.parse({
      ...base,
      sha256,
      created_at: new Date().toISOString(),
    }),
    payload = NodeHostConfigurationPrivate.parse({ status, files });
  const encrypted = await encryptCustodyDocument(
    env.CREDENTIAL_KEYS,
    scope(status),
    canonicalInstallation(payload),
  );
  const stored = await env.DB.prepare(
    `INSERT INTO node_host_configurations(node_id,node_uid,region_id,cluster_uid,material_revision,revision,sha256,release_id,pool_policy_revision,profile_sha256,kid,iv,ciphertext,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN node_compute_pool_policies p ON p.node_id=n.id AND p.node_uid=n.node_uid JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid AND a.release_id=p.release_id JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=p.release_id WHERE n.id=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND r.bootstrap_material_revision=? AND p.release_id=? AND p.revision=? AND p.policy_json=? AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds'))
 ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,region_id=excluded.region_id,cluster_uid=excluded.cluster_uid,material_revision=excluded.material_revision,revision=excluded.revision,sha256=excluded.sha256,release_id=excluded.release_id,pool_policy_revision=excluded.pool_policy_revision,profile_sha256=excluded.profile_sha256,kid=excluded.kid,iv=excluded.iv,ciphertext=excluded.ciphertext,created_at=excluded.created_at WHERE node_host_configurations.revision=?`,
  )
    .bind(
      status.node_id,
      status.node_uid,
      status.region_id,
      status.cluster_uid,
      status.material_revision,
      status.revision,
      status.sha256,
      status.release_id,
      status.pool_policy_revision,
      status.profile_sha256,
      encrypted.kid,
      encrypted.iv,
      encrypted.ciphertext,
      status.created_at,
      status.node_id,
      status.node_uid,
      status.material_revision,
      status.release_id,
      status.pool_policy_revision,
      source.policy_json,
      previous?.revision ?? 0,
    )
    .run();
  if (stored.meta.changes !== 1) return closed();
  return readNodeHostConfiguration(env, status.node_id);
}
/** Private leaf, callable only after the fleet patch's independent operation authority check. */
export async function loadNodeHostConfiguration(
  env: Env,
  binding: Pick<
    HostStatus,
    | "node_id"
    | "node_uid"
    | "cluster_uid"
    | "material_revision"
    | "revision"
    | "sha256"
  >,
) {
  const stored = await row(env, binding.node_id);
  if (
    !stored ||
    Object.entries(binding).some(
      ([key, value]) => stored[key as keyof Row] !== value,
    )
  )
    return closed();
  const source = await authority(env, stored.node_id, stored.node_uid, false);
  if (!same(source, stored)) return closed();
  const payload = NodeHostConfigurationPrivate.parse(
    JSON.parse(
      await decryptCustodyDocument(env.CREDENTIAL_KEYS, scope(stored), {
        kid: stored.kid,
        iv: stored.iv,
        ciphertext: stored.ciphertext,
      }),
    ),
  );
  const currentAgent = await loadRegionAgentKey(
    env.DB,
    env,
    agentKeyReference(stored.region_id),
  );
  if (payload.files[1].content !== currentAgent + "\n") return closed();
  const current = await authority(env, stored.node_id, stored.node_uid, false);
  // An AEAD-sealed historical thick ID is never reused or converted in place. Deletion does not revoke its harmless restart exemption.
  const settings = JSON.parse(payload.files[0].content) as {
    cloudflare: { storage_authority?: { legacy_database_ids?: unknown } };
  };
  const sealedLegacy = DatabaseId.array()
    .max(4096)
    .parse(settings.cloudflare.storage_authority?.legacy_database_ids ?? []);
  const expectedFiles = sandboxHostFiles(
    stored,
    new URL(env.NODE_BOOTSTRAP_CALLBACK_URL).origin + "/",
    currentAgent,
    current.profile.image,
    current.storageAuthority
      ? { ...current.storageAuthority, legacy_database_ids: sealedLegacy }
      : undefined,
  );
  if (
    canonicalInstallation(payload.files) !==
    canonicalInstallation(expectedFiles)
  )
    return closed();
  if (
    canonicalInstallation(payload.status) !==
      canonicalInstallation(
        NodeHostConfigurationStatus.strip().parse(stored),
      ) ||
    (await installationHash(payload.files)) !== stored.sha256
  )
    return closed();
  if (
    !same(await authority(env, stored.node_id, stored.node_uid, false), stored)
  )
    return closed();
  return payload;
}

/** Future postjoin path: only a current verified pending admission may prepare host custody. */
export async function ensurePendingNodeHostConfiguration(
  env: Env,
  operationId: string,
) {
  const job = await readBootstrapJob(env.DB, operationId),
    pending = await admissionAuthority(env, job, {
      requirePostjoinRelease: false,
    });
  if (!pending.admission_authorized || !pending.admission_binding)
    return closed();
  const source = await authority(
    env,
    job.node_id,
    pending.admission_binding.node_uid,
  );
  if (source.cluster_uid !== pending.admission_binding.kube_system_uid)
    return closed();
  const status = await ensureNodeHostConfiguration(env, {
    node_id: job.node_id,
    node_uid: pending.admission_binding.node_uid,
  });
  if (
    !(
      await admissionAuthority(
        env,
        await readBootstrapJob(env.DB, operationId),
        { requirePostjoinRelease: false },
      )
    ).admission_authorized
  )
    return closed();
  return status;
}
