// SPDX-License-Identifier: Apache-2.0
import {
  RegionId,
  RegionBootstrapMaterialStatus,
  RegionBootstrapMaterialUpdate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  RegionMaterialRotationStage,
  RegionMaterialRotationActivate,
  RegionMaterialRotationStaged,
} from "@pgcf/contracts/region-material-rotation";
import {
  joinBundleReference,
  regionSeedReference,
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
  loadRegionSeed,
  storeRegionJoinBundle,
  storeRegionSeed,
  encryptRegionSeed,
  encryptJoinBundle,
  type RegionSeed,
  type RegionJoinBundle,
  type EncryptedBootstrapCredential,
} from "../crypto/bootstrap-credentials.ts";
import { installationHash } from "./node-installation.ts";
import { FleetRolloutIntent } from "@pgcf/contracts/fleet-rollouts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { fleetRolloutAuthoritySql } from "./fleet-rollouts.ts";

const refuse = (): never => {
  throw new ApiError(
    "conflict",
    "Cluster material synchronization authority changed",
  );
};
const idleSql = `NOT EXISTS(SELECT 1 FROM node_additions WHERE slot_held=1 AND status NOT IN('ready','cancelled'))
  AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs WHERE authorized=1 AND admitted=0 AND cancelled=0)
  AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations WHERE stage NOT IN('complete','host_ready'))
  AND NOT EXISTS(SELECT 1 FROM node_thin_storage WHERE action_json IS NOT NULL)`;
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

type RotationHashes = Pick<
  RegionMaterialRotationStage,
  | "expected_revision"
  | "expected_seed_sha256"
  | "expected_join_sha256"
  | "seed_sha256"
  | "join_sha256"
>;
type RotationTopology = RegionMaterialRotationStage["observed"];
const sameEnvelopeSql = `EXISTS(SELECT 1 FROM region_bootstrap_credentials c WHERE c.region_id=regions.id AND c.purpose=? AND c.revision=? AND c.version=? AND c.kid=? AND c.iv=? AND c.ciphertext=?)`;
function envelopeBindings(rows: EncryptedBootstrapCredential[]) {
  return rows.flatMap((row) => [
    row.purpose,
    row.revision,
    row.version,
    row.kid,
    row.iv,
    row.ciphertext,
  ]);
}
/** Fixed material/topology predicate, shared only by the two custody mutations. No provider actions. */
function rotationAuthority(
  regionId: string,
  before: { revision: number; provenance: string | null },
  observed: RotationTopology,
  rows: EncryptedBootstrapCredential[],
) {
  if (
    new Set(observed.nodes.map((node) => node.node_id)).size !==
      observed.nodes.length ||
    new Set(observed.nodes.map((node) => node.node_uid)).size !==
      observed.nodes.length
  )
    return refuse();
  return {
    sql: `regions.id=? AND regions.bootstrap_material_revision=? AND regions.bootstrap_material_provenance_sha256 IS ? AND ${idleSql}
    AND julianday(?)>=julianday('now','-120 seconds') AND julianday(?)<=julianday('now','+5 seconds')
    AND (SELECT count(*) FROM nodes n WHERE n.region_id=regions.id AND n.lost_at IS NULL)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=regions.id AND n.id=json_extract(expected.value,'$.node_id') AND n.node_uid=json_extract(expected.value,'$.node_uid') AND n.k8s_node_name=json_extract(expected.value,'$.k8s_node_name') AND n.provider_instance_id=json_extract(expected.value,'$.provider_instance_id') AND n.lost_at IS NULL AND n.ready=1 AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')))
    AND ${rows.map(() => sameEnvelopeSql).join(" AND ")}`,
    bindings: [
      regionId,
      before.revision,
      before.provenance,
      observed.observed_at,
      observed.observed_at,
      observed.nodes.length,
      JSON.stringify(observed.nodes),
      ...envelopeBindings(rows),
    ],
  };
}
async function rotationBase(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  regionId: string,
  value: RotationHashes,
) {
  const before = await regionState(env.DB, regionId);
  if (
    before.revision !== value.expected_revision &&
    before.revision !== value.expected_revision + 1
  )
    return refuse();
  const oldRows = await envelopes(env.DB, regionId, value.expected_revision);
  const seed = await loadRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(regionId, value.expected_revision),
  );
  const join = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(regionId, value.expected_revision),
  );
  if (
    (await installationHash(seed)) !== value.expected_seed_sha256 ||
    (await installationHash(join)) !== value.expected_join_sha256
  )
    return refuse();
  return { before, oldRows, seed, join };
}
async function matchingRotation(
  base: { seed: RegionSeed; join: RegionJoinBundle },
  seed: RegionSeed,
  join: RegionJoinBundle,
  value: RotationHashes,
) {
  const shared = (material: RegionSeed) => ({
    version: material.version,
    cluster_name: material.cluster_name,
    cluster_endpoint: material.cluster_endpoint,
    talos_version: material.talos_version,
    kubernetes_version: material.kubernetes_version,
    talos_machine_secrets_yaml: material.talos_machine_secrets_yaml,
    talos_admin_config: material.talos_admin_config,
  });
  if (
    (await installationHash(shared(base.seed))) !==
      (await installationHash(shared(base.join))) ||
    (await installationHash(shared(seed))) !==
      (await installationHash(shared(join))) ||
    seed.cluster_name !== base.seed.cluster_name ||
    seed.cluster_endpoint !== base.seed.cluster_endpoint ||
    seed.talos_version !== base.seed.talos_version ||
    seed.kubernetes_version !== base.seed.kubernetes_version ||
    join.kube_system_uid !== base.join.kube_system_uid ||
    seed.talos_machine_secrets_yaml === base.seed.talos_machine_secrets_yaml ||
    seed.talos_admin_config === base.seed.talos_admin_config ||
    join.kubeconfig === base.join.kubeconfig ||
    (await installationHash(seed)) !== value.seed_sha256 ||
    (await installationHash(join)) !== value.join_sha256
  )
    return refuse();
}
function matchingTopology(
  base: { seed: RegionSeed; join: RegionJoinBundle },
  observed: RotationTopology,
  versions: { talos_version: string; kubernetes_version: string } = base.seed,
) {
  const equalVersion = (a: string, b: string) =>
    a.replace(/^v/, "") === b.replace(/^v/, "");
  if (
    base.join.kube_system_uid !== observed.kube_system_uid ||
    !equalVersion(versions.talos_version, observed.talos_version) ||
    !equalVersion(versions.kubernetes_version, observed.kubernetes_version)
  )
    return refuse();
}
async function stagedRotation(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  regionId: string,
  value: RotationHashes,
) {
  const base = await rotationBase(env, regionId, value),
    next = value.expected_revision + 1;
  const rows = await envelopes(env.DB, regionId, next);
  const seed = await loadRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(regionId, next),
  );
  const join = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(regionId, next),
  );
  await matchingRotation(base, seed, join, value);
  const after = await regionState(env.DB, regionId);
  // An identical activation may finish during these reads. Resolve the same immutable pair;
  // callers still require their exact activation provenance before reporting success.
  if (after.revision !== value.expected_revision && after.revision !== next)
    return refuse();
  return {
    ...base,
    before: after,
    rows,
    seed,
    join,
    status: RegionMaterialRotationStaged.parse({
      region_id: regionId,
      active_revision: after.revision,
      staged_revision: next,
      seed_sha256: value.seed_sha256,
      join_sha256: value.join_sha256,
      active: after.revision === next,
    }),
  };
}
/** Private supplied material only. Staging does not execute rotation or authorize bootstrap. */
export async function stageRegionBootstrapRotation(
  c: ApiContext,
  id: string,
  input: RegionMaterialRotationStage,
): Promise<Response> {
  await requireScope(c, "admin");
  const regionId = RegionId.parse(id),
    value = RegionMaterialRotationStage.parse(input),
    next = value.expected_revision + 1;
  const read = async () =>
    c.json((await stagedRotation(c.env, regionId, value)).status);
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const base = await rotationBase(c.env, regionId, value);
      await matchingRotation(base, value.seed, value.join, value);
      matchingTopology(base, value.observed);
      const present = await c.env.DB.prepare(
        "SELECT region_id,purpose,revision,version,kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND revision=? AND purpose IN('region_seed','join_bundle') ORDER BY purpose",
      )
        .bind(regionId, next)
        .all<EncryptedBootstrapCredential>();
      for (const row of present.results) {
        const hash =
          row.purpose === "region_seed"
            ? await installationHash(
                await loadRegionSeed(
                  c.env.DB,
                  c.env.CREDENTIAL_KEYS,
                  regionSeedReference(regionId, next),
                ),
              )
            : await installationHash(
                await loadRegionJoinBundle(
                  c.env.DB,
                  c.env.CREDENTIAL_KEYS,
                  joinBundleReference(regionId, next),
                ),
              );
        if (
          hash !==
          (row.purpose === "region_seed"
            ? value.seed_sha256
            : value.join_sha256)
        )
          return refuse();
      }
      if (present.results.length !== 2) {
        if (base.before.revision !== value.expected_revision) return refuse();
        const encrypted = [
          await encryptRegionSeed(
            c.env.CREDENTIAL_KEYS,
            regionSeedReference(regionId, next),
            value.seed,
          ),
          await encryptJoinBundle(
            c.env.CREDENTIAL_KEYS,
            joinBundleReference(regionId, next),
            value.join,
          ),
        ];
        const guard = rotationAuthority(regionId, base.before, value.observed, [
          ...base.oldRows,
          ...present.results,
        ]);
        const statements = encrypted.map((row) =>
          c.env.DB.prepare(
            `INSERT INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) SELECT ?,?,?,?,?,?,?,? FROM regions WHERE ${guard.sql} ON CONFLICT(region_id,purpose,revision) DO NOTHING`,
          ).bind(
            row.region_id,
            row.purpose,
            row.revision,
            row.version,
            row.kid,
            row.iv,
            row.ciphertext,
            new Date().toISOString(),
            ...guard.bindings,
          ),
        );
        await c.env.DB.batch(statements);
      }
      const stored = await stagedRotation(c.env, regionId, value);
      await lease
        .completeStatement(`${regionId}:${next}`, 200, {
          sql: `EXISTS(SELECT 1 FROM regions WHERE id=? AND bootstrap_material_revision IN(?,?) AND ${[...stored.oldRows, ...stored.rows].map(() => sameEnvelopeSql).join(" AND ")})`,
          bindings: [
            regionId,
            value.expected_revision,
            next,
            ...envelopeBindings([...stored.oldRows, ...stored.rows]),
          ],
        })
        .run();
      return c.json(stored.status);
    },
  });
}
/** Trusted-admin verified readback, not attestation and not a CA/token mutation endpoint. */
export async function activateRegionBootstrapRotation(
  c: ApiContext,
  id: string,
  input: RegionMaterialRotationActivate,
): Promise<Response> {
  await requireScope(c, "admin");
  const regionId = RegionId.parse(id),
    value = RegionMaterialRotationActivate.parse(input),
    next = value.expected_revision + 1;
  if (
    (await installationHash(value.verified)) !== value.verification_sha256 ||
    value.verified.seed_sha256 !== value.seed_sha256 ||
    value.verified.join_sha256 !== value.join_sha256
  )
    return refuse();
  const read = async () => {
    const stored = await stagedRotation(c.env, regionId, value);
    matchingTopology(stored, value.verified);
    if (
      stored.before.revision !== next ||
      stored.before.provenance !== value.verification_sha256
    )
      return refuse();
    const active = await readRegionBootstrapMaterial(c.env, regionId);
    if (
      active.revision !== next ||
      active.provenance_sha256 !== value.verification_sha256 ||
      active.seed_sha256 !== value.seed_sha256 ||
      active.join_sha256 !== value.join_sha256
    )
      return refuse();
    return c.json(active);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const stored = await stagedRotation(c.env, regionId, value);
      matchingTopology(stored, value.verified);
      if (stored.before.revision === next) {
        const response = await read();
        await lease
          .completeStatement(`${regionId}:${next}`, 200, {
            sql: "EXISTS(SELECT 1 FROM regions WHERE id=? AND bootstrap_material_revision=? AND bootstrap_material_provenance_sha256=?)",
            bindings: [regionId, next, value.verification_sha256],
          })
          .run();
        return response;
      }
      const rows = [...stored.oldRows, ...stored.rows],
        guard = rotationAuthority(
          regionId,
          stored.before,
          value.verified,
          rows,
        );
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE regions SET bootstrap_material_revision=?,bootstrap_material_provenance_sha256=?,updated_at=? WHERE ${guard.sql}`,
        ).bind(
          next,
          value.verification_sha256,
          new Date().toISOString(),
          ...guard.bindings,
        ),
        lease.completeStatement(`${regionId}:${next}`, 200, {
          sql: `EXISTS(SELECT 1 FROM regions WHERE id=? AND bootstrap_material_revision=? AND bootstrap_material_provenance_sha256=? AND ${rows.map(() => sameEnvelopeSql).join(" AND ")})`,
          bindings: [
            regionId,
            next,
            value.verification_sha256,
            ...envelopeBindings(rows),
          ],
        }),
      ]);
      // No new mutation on a lost CAS: only the exact selected hashes/provenance can resolve it.
      return read();
    },
  });
}
/** The existing fleet intent supplies native evidence and target versions; prepared ciphertext stays immutable. */
export async function activateNativeRegionBootstrapRotation(
  env: Env,
  regionId: string,
  rolloutId: string,
  input: RegionMaterialRotationActivate,
) {
  const value = RegionMaterialRotationActivate.parse(input),
    row = await env.DB.prepare(
      "SELECT r.rollout_json,f.spec_json FROM fleet_region_releases r JOIN fleet_releases f ON f.id=r.release_id WHERE r.region_id=?",
    )
      .bind(regionId)
      .first<{ rollout_json: string | null; spec_json: string }>();
  if (!row?.rollout_json) return refuse();
  const intent = FleetRolloutIntent.parse(JSON.parse(row.rollout_json)),
    region = intent.regions.find((r) => r.region_id === regionId),
    spec = FleetReleaseSpec.parse(JSON.parse(row.spec_json));
  if (
    intent.rollout_id !== rolloutId ||
    !region ||
    region.material_revision !== value.expected_revision ||
    region.staged_material_revision !== value.expected_revision + 1 ||
    region.rotation?.phase !== "verify" ||
    region.rotation.state !== "confirmed" ||
    value.verified.source !== "trusted_native" ||
    (await installationHash(region.rotation.verified)) !==
      value.verification_sha256 ||
    (await installationHash(value.verified)) !== value.verification_sha256 ||
    value.verified.seed_sha256 !== value.seed_sha256 ||
    value.verified.join_sha256 !== value.join_sha256
  )
    return refuse();
  const stored = await stagedRotation(env, regionId, value);
  matchingTopology(stored, value.verified, spec.roles.control_relay);
  const hosts = await env.DB.prepare(
    `SELECT n.id,n.node_uid,n.k8s_node_name,n.provider_instance_id,p.stage,p.state
     FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
     JOIN fleet_patch_operations p ON p.node_id=n.id AND p.node_uid=n.node_uid AND p.release_id=a.release_id AND p.assignment_revision=a.revision
     WHERE n.region_id=? AND n.lost_at IS NULL AND a.release_id=? ORDER BY p.created_at DESC`,
  )
    .bind(regionId, intent.release_id)
    .all<{
      id: string;
      node_uid: string;
      k8s_node_name: string;
      provider_instance_id: string;
      stage: string;
      state: string;
    }>();
  for (const member of region.nodes) {
    const host = hosts.results.find((h) => h.id === member.node_id);
    if (
      !host ||
      host.node_uid !== member.node_uid ||
      !["complete", "host_ready"].includes(host.stage) ||
      host.state !== "confirmed" ||
      !value.verified.nodes.some(
        (n) =>
          n.node_id === host.id &&
          n.node_uid === host.node_uid &&
          n.k8s_node_name === host.k8s_node_name &&
          n.provider_instance_id === host.provider_instance_id,
      )
    )
      return refuse();
  }
  if (stored.before.revision === value.expected_revision + 1) {
    if (stored.before.provenance !== value.verification_sha256) return refuse();
    return readRegionBootstrapMaterial(env, regionId);
  }
  const guard = rotationAuthority(regionId, stored.before, value.verified, [
    ...stored.oldRows,
    ...stored.rows,
  ]);
  const fleet = fleetRolloutAuthoritySql(intent);
  await env.DB.prepare(
    `UPDATE regions SET bootstrap_material_revision=?,bootstrap_material_provenance_sha256=?,updated_at=? WHERE ${guard.sql} AND ${fleet.sql}
     AND NOT EXISTS(SELECT 1 FROM json_each(?) member WHERE NOT EXISTS(SELECT 1 FROM fleet_patch_operations p WHERE p.node_id=json_extract(member.value,'$.node_id') AND p.node_uid=json_extract(member.value,'$.node_uid') AND p.release_id=? AND p.assignment_revision=json_extract(member.value,'$.assignment_revision') AND p.region_revision=? AND p.cluster_uid=? AND p.stage IN('complete','host_ready') AND p.state='confirmed'))`,
  )
    .bind(
      value.expected_revision + 1,
      value.verification_sha256,
      new Date().toISOString(),
      ...guard.bindings,
      ...fleet.bindings,
      JSON.stringify(region.nodes),
      intent.release_id,
      region.revision,
      region.cluster_uid,
    )
    .run();
  const current = await readRegionBootstrapMaterial(env, regionId);
  if (
    current.revision !== value.expected_revision + 1 ||
    current.provenance_sha256 !== value.verification_sha256 ||
    current.seed_sha256 !== value.seed_sha256 ||
    current.join_sha256 !== value.join_sha256
  )
    return refuse();
  return current;
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
    seed.kubernetes_version !== join.kubernetes_version ||
    seed.talos_version !== join.talos_version
  )
    return refuse();
  return RegionBootstrapMaterialStatus.parse({
    region_id: regionId,
    revision: after.revision,
    kubernetes_version: seed.kubernetes_version,
    talos_version: seed.talos_version,
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
    (value.talos_version !== undefined &&
      value.observed.talos_version !== value.talos_version) ||
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
      current.kubernetes_version !== value.kubernetes_version ||
      (value.talos_version !== undefined &&
        current.talos_version !== value.talos_version)
    )
      return refuse();
    return current;
  }
  if (
    before.revision !== value.expected_revision ||
    value.observed.kubernetes_version !== value.kubernetes_version ||
    (value.talos_version !== undefined &&
      value.observed.talos_version !== value.talos_version) ||
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
    (seed.kubernetes_version === value.kubernetes_version &&
      (value.talos_version === undefined ||
        seed.talos_version === value.talos_version)) ||
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
      ...(value.talos_version ? { talos_version: value.talos_version } : {}),
    },
    candidateJoin = {
      ...join,
      kubernetes_version: value.kubernetes_version,
      ...(value.talos_version ? { talos_version: value.talos_version } : {}),
    };
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
