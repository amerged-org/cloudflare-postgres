// SPDX-License-Identifier: Apache-2.0
import {
  RegionId,
  RegionBootstrapMaterialStatus,
  RegionBootstrapMaterialUpdate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  joinBundleReference,
  regionSeedReference,
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
  loadRegionSeed,
  storeRegionJoinBundle,
  storeRegionSeed,
  type EncryptedBootstrapCredential,
} from "../crypto/bootstrap-credentials.ts";
import { installationHash } from "./node-installation.ts";

const refuse = (): never => {
  throw new ApiError(
    "conflict",
    "Cluster material synchronization authority changed",
  );
};
const idleSql = `NOT EXISTS(SELECT 1 FROM node_additions WHERE slot_held=1 AND status NOT IN('ready','cancelled'))
  AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs WHERE authorized=1 AND admitted=0 AND cancelled=0)`;
async function regionState(db: D1Database, regionId: string) {
  const row = await db
    .prepare(
      "SELECT bootstrap_material_revision revision,bootstrap_material_provenance_sha256 provenance FROM regions WHERE id=?",
    )
    .bind(regionId)
    .first<{ revision: number; provenance: string | null }>();
  if (!row) throw new ApiError("not_found", "Region not found");
  return row;
}
async function envelopes(db: D1Database, regionId: string, revision: number) {
  const rows = await db
    .prepare(
      "SELECT region_id,purpose,revision,version,kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND revision=? AND purpose IN('region_seed','join_bundle') ORDER BY purpose",
    )
    .bind(regionId, revision)
    .all<EncryptedBootstrapCredential>();
  if (rows.results.length !== 2) return refuse();
  return rows.results;
}
export async function readRegionBootstrapMaterial(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  id: string,
): Promise<RegionBootstrapMaterialStatus> {
  const regionId = RegionId.parse(id),
    before = await regionState(env.DB, regionId);
  const seedRef = await loadCurrentRegionMaterialReference(
    env.DB,
    regionId,
    "region_seed",
  );
  const seed = await loadRegionSeed(env.DB, env.CREDENTIAL_KEYS, seedRef);
  const join = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(regionId, seedRef.revision),
  );
  const after = await regionState(env.DB, regionId);
  if (
    before.revision !== seedRef.revision ||
    after.revision !== before.revision ||
    after.provenance !== before.provenance ||
    seed.kubernetes_version !== join.kubernetes_version
  )
    return refuse();
  return RegionBootstrapMaterialStatus.parse({
    region_id: regionId,
    revision: after.revision,
    kubernetes_version: seed.kubernetes_version,
    seed_sha256: await installationHash(seed),
    join_sha256: await installationHash(join),
    provenance_sha256: after.provenance,
  });
}

/** Only an administrator's verified readback may change version metadata; key material is copied. */
export async function synchronizeRegionBootstrapMaterial(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  id: string,
  input: RegionBootstrapMaterialUpdate,
): Promise<RegionBootstrapMaterialStatus> {
  const regionId = RegionId.parse(id),
    value = RegionBootstrapMaterialUpdate.parse(input),
    before = await regionState(env.DB, regionId),
    nextRevision = value.expected_revision + 1;
  if (
    value.observed.kubernetes_version !== value.kubernetes_version ||
    (await installationHash(value.observed)) !== value.provenance_sha256
  )
    return refuse();
  if (before.revision === nextRevision) {
    const originalSeed = await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(regionId, value.expected_revision),
    );
    const originalJoin = await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(regionId, value.expected_revision),
    );
    if (
      (await installationHash(originalSeed)) !== value.expected_seed_sha256 ||
      (await installationHash(originalJoin)) !== value.expected_join_sha256
    )
      return refuse();
    const current = await readRegionBootstrapMaterial(env, regionId);
    if (
      current.revision !== nextRevision ||
      current.provenance_sha256 !== value.provenance_sha256 ||
      current.seed_sha256 !== value.seed_sha256 ||
      current.join_sha256 !== value.join_sha256 ||
      current.kubernetes_version !== value.kubernetes_version
    )
      return refuse();
    return current;
  }
  if (
    before.revision !== value.expected_revision ||
    value.observed.kubernetes_version !== value.kubernetes_version ||
    (await installationHash(value.observed)) !== value.provenance_sha256
  )
    return refuse();
  const observedAt = Date.parse(value.observed.observed_at),
    now = Date.now();
  if (
    observedAt < now - 120000 ||
    observedAt > now + 5000 ||
    new Set(value.observed.nodes.map((n) => n.node_id)).size !==
      value.observed.nodes.length ||
    new Set(value.observed.nodes.map((n) => n.node_uid)).size !==
      value.observed.nodes.length
  )
    return refuse();
  if (!(await env.DB.prepare(`SELECT 1 idle WHERE ${idleSql}`).first()))
    return refuse();
  const oldRows = await envelopes(env.DB, regionId, before.revision);
  const seed = await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(regionId, before.revision),
    ),
    join = await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(regionId, before.revision),
    );
  if (
    seed.kubernetes_version !== join.kubernetes_version ||
    seed.kubernetes_version === value.kubernetes_version ||
    join.kube_system_uid !== value.observed.kube_system_uid ||
    seed.cluster_name !== join.cluster_name ||
    seed.cluster_endpoint !== join.cluster_endpoint ||
    seed.talos_version !== join.talos_version ||
    seed.talos_machine_secrets_yaml !== join.talos_machine_secrets_yaml ||
    seed.talos_admin_config !== join.talos_admin_config ||
    (await installationHash(seed)) !== value.expected_seed_sha256 ||
    (await installationHash(join)) !== value.expected_join_sha256
  )
    return refuse();
  const candidateSeed = {
      ...seed,
      kubernetes_version: value.kubernetes_version,
    },
    candidateJoin = { ...join, kubernetes_version: value.kubernetes_version };
  if (
    (await installationHash(candidateSeed)) !== value.seed_sha256 ||
    (await installationHash(candidateJoin)) !== value.join_sha256
  )
    return refuse();
  // Immutable inserts can be resumed after an unknown result. They never move the active pointer.
  try {
    await storeRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(regionId, nextRevision),
      candidateSeed,
    );
    await storeRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(regionId, nextRevision),
      candidateJoin,
    );
  } catch {
    return refuse();
  }
  const candidates = await envelopes(env.DB, regionId, nextRevision),
    allRows = [...oldRows, ...candidates];
  const sameEnvelope =
    () => `EXISTS(SELECT 1 FROM region_bootstrap_credentials c
    WHERE c.region_id=regions.id AND c.purpose=? AND c.revision=? AND c.version=? AND c.kid=? AND c.iv=? AND c.ciphertext=?)`;
  const nodes = JSON.stringify(value.observed.nodes);
  const result = await env.DB.prepare(
    `UPDATE regions SET bootstrap_material_revision=?,bootstrap_material_provenance_sha256=?,updated_at=?
     WHERE id=? AND bootstrap_material_revision=? AND bootstrap_material_provenance_sha256 IS ? AND ${idleSql}
       AND julianday(?)>=julianday('now','-120 seconds') AND julianday(?)<=julianday('now','+5 seconds')
       AND (SELECT COUNT(*) FROM nodes n WHERE n.region_id=regions.id AND n.lost_at IS NULL)=?
       AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM nodes n
         WHERE n.region_id=regions.id AND n.id=json_extract(expected.value,'$.node_id')
           AND n.node_uid=json_extract(expected.value,'$.node_uid') AND n.k8s_node_name=json_extract(expected.value,'$.k8s_node_name')
           AND n.provider_instance_id=json_extract(expected.value,'$.provider_instance_id')
           AND n.lost_at IS NULL AND n.ready=1 AND julianday(n.last_observed_at)>=julianday('now','-180 seconds')
           AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')))
       AND ${allRows.map(sameEnvelope).join(" AND ")}`,
  )
    .bind(
      nextRevision,
      value.provenance_sha256,
      new Date().toISOString(),
      regionId,
      before.revision,
      before.provenance,
      value.observed.observed_at,
      value.observed.observed_at,
      value.observed.nodes.length,
      nodes,
      ...allRows.flatMap((row) => [
        row.purpose,
        row.revision,
        row.version,
        row.kid,
        row.iv,
        row.ciphertext,
      ]),
    )
    .run();
  if (result.meta.changes !== 1) return refuse();
  const active = await readRegionBootstrapMaterial(env, regionId);
  if (
    active.revision !== nextRevision ||
    active.provenance_sha256 !== value.provenance_sha256 ||
    active.seed_sha256 !== value.seed_sha256 ||
    active.join_sha256 !== value.join_sha256
  )
    return refuse();
  return active;
}
