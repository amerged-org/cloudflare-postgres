// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, NodeId, base64urlToBytes } from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  DatabaseRuntimeAttestation,
  NodeWarmReclaimQualification,
  WarmReclaimPolicy,
  ReclaimIntentSnapshot,
  ReclaimObservations,
  RECLAIM_LIMITS,
  ReclaimClaims,
  reclaimClaimsValidAt,
} from "@pgcf/contracts/reclaim";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { databaseForRequest, type DatabaseRow } from "./rows.ts";
import { agentRegion } from "./agent-auth.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { installationHash } from "./node-installation.ts";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
const Safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WarmReclaimPolicyState = z.strictObject({
  database_id: DatabaseId,
  revision: Safe,
  policy: WarmReclaimPolicy.nullable(),
});
export const WarmReclaimPolicyUpdate = z.strictObject({
  expected_revision: Safe,
  expected_generation: Safe.positive(),
  policy: WarmReclaimPolicy.nullable(),
});
export const WarmReclaimQualificationState = z.strictObject({
  node_id: NodeId,
  revision: Safe,
  qualification: NodeWarmReclaimQualification.nullable(),
});
export const WarmReclaimQualificationUpdate = z.strictObject({
  expected_revision: Safe,
  node_uid: z.uuid(),
  qualification: NodeWarmReclaimQualification.nullable(),
});
const policyDocument = z.strictObject({
  revision: Safe.positive(),
  policy: WarmReclaimPolicy.nullable(),
});
const qualificationDocument = z.strictObject({
  revision: Safe.positive(),
  qualification: NodeWarmReclaimQualification.nullable(),
});
const closed = (): never => {
  throw new ApiError(
    "conflict",
    "Current qualified isolated worker authority is unavailable or changed",
  );
};
interface WarmNodeRow {
  region_id: string;
  node_uid: string;
  warm_reclaim_qualification_json: string | null;
  material_revision: number;
  release_id: string;
  assignment_revision: number;
  region_revision: number;
  spec_json: string;
  spec_sha256: string;
  facts_json: string;
  host_sha256: string;
  boot_id: string;
  cluster_uid: string;
}
/** Every lease uses the current assignment, current regional key and accepted same-boot host receipt. */
async function nodeSource(
  env: Pick<Env, "DB">,
  nodeId: string,
  regionId?: string,
): Promise<WarmNodeRow | null> {
  return env.DB.prepare(
    `SELECT n.region_id,n.node_uid,n.warm_reclaim_qualification_json,r.bootstrap_material_revision material_revision,a.release_id,a.revision assignment_revision,f.revision region_revision,s.spec_json,s.spec_sha256,o.facts_json,h.sha256 host_sha256,json_extract(o.facts_json,'$.boot_id') boot_id,h.cluster_uid
  FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
  JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=a.release_id JOIN fleet_releases s ON s.id=a.release_id
  JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash
  JOIN node_host_configurations h ON h.node_id=n.id AND h.node_uid=n.node_uid AND h.release_id=a.release_id AND h.material_revision=r.bootstrap_material_revision
  WHERE n.id=? AND (? IS NULL OR n.region_id=?) AND n.ready=1 AND n.lost_at IS NULL AND n.schedulable=1
    AND (julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds'))
    AND (julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds'))
    AND json_extract(o.facts_json,'$.kubernetes_control_plane')=0
    AND EXISTS(SELECT 1 FROM fleet_patch_operations p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.release_id=a.release_id
      AND (p.assignment_revision=a.revision AND p.region_revision=f.revision AND p.material_revision=r.bootstrap_material_revision AND p.cluster_uid=h.cluster_uid)
      AND (p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL AND p.host_configuration_revision=h.revision AND p.host_configuration_sha256=h.sha256)
      AND (json_extract(p.observed_json,'$.boot_id')=json_extract(o.facts_json,'$.boot_id') AND json_extract(p.observed_json,'$.kubernetes_control_plane')=0)
      AND json_extract(p.observed_json,'$.host_configuration_sha256')=h.sha256 AND json_extract(p.observed_json,'$.runtime_admission_sha256')=h.profile_sha256)`,
  )
    .bind(nodeId, regionId ?? null, regionId ?? null)
    .first<WarmNodeRow>();
}
async function approvedNode(env: Env, nodeId: string, regionId?: string) {
  const row = await nodeSource(env, nodeId, regionId);
  if (!row) return null;
  const doc = qualificationDocument.safeParse(
    row.warm_reclaim_qualification_json
      ? JSON.parse(row.warm_reclaim_qualification_json)
      : null,
  );
  if (!doc.success || !doc.data.qualification) return null;
  const qualification = doc.data.qualification,
    spec = FleetReleaseSpec.parse(JSON.parse(row.spec_json));
  if (
    qualification.revision !== doc.data.revision ||
    qualification.node_uid !== row.node_uid ||
    qualification.boot_id !== row.boot_id ||
    qualification.cluster_uid !== row.cluster_uid ||
    qualification.material_revision !== row.material_revision ||
    qualification.release_id !== row.release_id ||
    qualification.qualified_at > Date.now() + 1000 ||
    (await installationHash(spec)) !== row.spec_sha256
  )
    return null;
  const reclaimer = spec.components.find(
      (value) => value.name === "node-reclaimer" && value.kind === "image",
    ),
    host = spec.components.find(
      (value) =>
        value.name === "pgcf-sandbox-controller" && value.kind === "image",
    );
  if (
    !reclaimer ||
    !host ||
    !spec.roles.customer.host_configuration_required ||
    !spec.roles.customer.components.includes(reclaimer.name) ||
    !spec.roles.customer.talos_extensions.includes(host.name) ||
    spec.storage_authority_keys_sha256 !==
      (await storageAuthorityPublicKeys(env)).sha256
  )
    return null;
  return { row, qualification, spec };
}
export async function warmReclaimCandidate(env: Env, databaseId: string) {
  const row = await env.DB.prepare(
    `SELECT d.*,s.memory_mib,CASE WHEN p.placement_mode='actual_ram' THEN p.postgres_memory_request_mib ELSE s.memory_mib END memory_request_mib
 FROM databases d JOIN projects pr ON pr.id=d.project_id AND pr.deleted_at IS NULL JOIN size_classes s ON s.id=d.size_class_id
 LEFT JOIN node_region_policies p ON p.region_id=d.region_id WHERE d.id=? AND d.deleted_at IS NULL AND d.desired_state='running' AND d.observed_state='ready' AND d.observed_power='awake' AND d.observed_generation=d.generation AND d.storage_protected_at IS NULL`,
  )
    .bind(databaseId)
    .first<DatabaseRow & { memory_mib: number; memory_request_mib: number }>();
  if (!row?.node_id) return null;
  const selected = policyDocument.safeParse(
      row.warm_reclaim_policy_json
        ? JSON.parse(row.warm_reclaim_policy_json)
        : null,
    ),
    attested = DatabaseRuntimeAttestation.safeParse(
      row.runtime_attestation_json
        ? JSON.parse(row.runtime_attestation_json)
        : null,
    );
  if (!selected.success || !selected.data.policy || !attested.success)
    return null;
  const node = await approvedNode(env, row.node_id, row.region_id);
  if (!node) return null;
  const runtime = attested.data,
    postgres = node.spec.components.find(
      (value) => value.name === "postgres" && value.kind === "image",
    );
  if (
    runtime.database_id !== row.id ||
    runtime.generation !== row.generation ||
    runtime.storage_generation !== (row.storage_generation ?? 1) ||
    runtime.node_uid !== node.qualification.node_uid ||
    runtime.boot_id !== node.qualification.boot_id ||
    runtime.cluster_uid !== node.qualification.cluster_uid ||
    runtime.observed_at < Date.now() - 30000 ||
    runtime.observed_at > Date.now() + 1000 ||
    runtime.memory_limit_bytes !== row.memory_mib * 1024 ** 2 ||
    runtime.memory_request_bytes !== row.memory_request_mib * 1024 ** 2 ||
    runtime.memory_request_bytes >= runtime.memory_limit_bytes ||
    !postgres ||
    runtime.postgres_image_sha256 !== postgres.sha256 ||
    (row.desired_postgres_image &&
      row.desired_postgres_image !== postgres.reference)
  )
    return null;
  if (row.storage_volume_json) {
    const receipt = JSON.parse(row.storage_volume_json) as Record<
      string,
      unknown
    >;
    for (const key of [
      "node_uid",
      "namespace_uid",
      "cluster_uid",
      "storage_uid",
      "pvc_uid",
      "pv_uid",
    ]) {
      const actual =
        key === "cluster_uid"
          ? runtime.cnpg_cluster_uid
          : runtime[key as keyof DatabaseRuntimeAttestation];
      if (receipt[key] !== actual) return null;
    }
  }
  return { policy: selected.data.policy, runtime };
}
async function policyState(env: Pick<Env, "DB">, id: string) {
  const row = await env.DB.prepare(
    "SELECT warm_reclaim_policy_json FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ warm_reclaim_policy_json: string | null }>();
  if (!row) throw new ApiError("not_found", "Database not found");
  const doc = row.warm_reclaim_policy_json
    ? policyDocument.parse(JSON.parse(row.warm_reclaim_policy_json))
    : { revision: 0, policy: null };
  return WarmReclaimPolicyState.parse({ database_id: id, ...doc });
}
export async function getWarmReclaimPolicy(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  await databaseForRequest(c, id);
  return c.json(await policyState(c.env, id), 200);
}
export async function setWarmReclaimPolicy(
  c: ApiContext,
  id: string,
  body: z.infer<typeof WarmReclaimPolicyUpdate>,
) {
  await requireScope(c, "admin");
  const database = await databaseForRequest(c, id),
    previous = await policyState(c.env, id);
  return withIdempotency(c, {
    replay: () => getWarmReclaimPolicy(c, id),
    execute: async (lease) => {
      if (
        previous.revision !== body.expected_revision ||
        database.generation !== body.expected_generation
      )
        throw new ApiError(
          "conflict",
          "Database or warm policy revision changed",
        );
      await c.env.DATABASE_ACTOR.get(
        c.env.DATABASE_ACTOR.idFromName(id),
      ).revokeWarmReclaim(id);
      const doc = JSON.stringify({
        revision: body.expected_revision + 1,
        policy: body.policy,
      });
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE databases SET warm_reclaim_policy_json=? WHERE id=? AND generation=? AND warm_reclaim_policy_json IS ? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)`,
        ).bind(
          doc,
          id,
          body.expected_generation,
          database.warm_reclaim_policy_json ?? null,
        ),
        lease.completeStatement(id, 200, {
          sql: "EXISTS(SELECT 1 FROM databases WHERE id=? AND warm_reclaim_policy_json=?)",
          bindings: [id, doc],
        }),
      ]);
      if (result[0]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database changed before warm policy commit",
        );
      return getWarmReclaimPolicy(c, id);
    },
  });
}
async function qualificationState(env: Pick<Env, "DB">, id: string) {
  const row = await env.DB.prepare(
    "SELECT warm_reclaim_qualification_json FROM nodes WHERE id=?",
  )
    .bind(id)
    .first<{ warm_reclaim_qualification_json: string | null }>();
  if (!row) throw new ApiError("not_found", "Node not found");
  const doc = row.warm_reclaim_qualification_json
    ? qualificationDocument.parse(
        JSON.parse(row.warm_reclaim_qualification_json),
      )
    : { revision: 0, qualification: null };
  return WarmReclaimQualificationState.parse({ node_id: id, ...doc });
}
export async function getWarmReclaimQualification(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  return c.json(await qualificationState(c.env, id), 200);
}
export async function setWarmReclaimQualification(
  c: ApiContext,
  id: string,
  body: z.infer<typeof WarmReclaimQualificationUpdate>,
) {
  await requireScope(c, "admin");
  NodeId.parse(id);
  const old = await qualificationState(c.env, id);

  const source = await nodeSource(c.env, id);
  if (body.qualification) {
    if (!source) return closed();
    const q = body.qualification;
    if (
      !source ||
      q.revision !== body.expected_revision + 1 ||
      q.node_uid !== body.node_uid ||
      q.node_uid !== source.node_uid ||
      q.boot_id !== source.boot_id ||
      q.cluster_uid !== source.cluster_uid ||
      q.material_revision !== source.material_revision ||
      q.release_id !== source.release_id ||
      q.qualified_at > Date.now() + 1000
    )
      closed();
    const ref = await loadCurrentRegionMaterialReference(
        c.env.DB,
        source.region_id,
        "join_bundle",
      ),
      join = await loadRegionJoinBundle(c.env.DB, c.env.CREDENTIAL_KEYS, ref);
    if (
      ref.revision !== q.material_revision ||
      join.kube_system_uid !== q.cluster_uid
    )
      closed();
    const spec = FleetReleaseSpec.parse(JSON.parse(source.spec_json));
    if (
      (await installationHash(spec)) !== source.spec_sha256 ||
      !spec.components.some(
        (v) => v.name === "node-reclaimer" && v.kind === "image",
      ) ||
      spec.storage_authority_keys_sha256 !==
        (await storageAuthorityPublicKeys(c.env)).sha256
    )
      closed();
  }
  return withIdempotency(c, {
    replay: () => getWarmReclaimQualification(c, id),
    execute: async (lease) => {
      if (old.revision !== body.expected_revision) closed();
      const assigned = await c.env.DB.prepare(
        "SELECT id FROM databases WHERE node_id=? AND deleted_at IS NULL LIMIT ?",
      )
        .bind(id, RECLAIM_LIMITS.max_tasks + 1)
        .all<{ id: string }>();
      if (assigned.results.length > RECLAIM_LIMITS.max_tasks) closed();
      for (const db of assigned.results)
        await c.env.DATABASE_ACTOR.get(
          c.env.DATABASE_ACTOR.idFromName(db.id),
        ).revokeWarmReclaim(db.id);
      const doc = JSON.stringify({
          revision: body.expected_revision + 1,
          qualification: body.qualification,
        }),
        oldDoc =
          old.revision === 0
            ? null
            : JSON.stringify({
                revision: old.revision,
                qualification: old.qualification,
              });
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE nodes SET warm_reclaim_qualification_json=? WHERE id=? AND node_uid=? AND warm_reclaim_qualification_json IS ? AND lost_at IS NULL ${body.qualification ? "AND EXISTS(SELECT 1 FROM regions r JOIN fleet_node_releases a ON a.node_id=nodes.id AND a.node_uid=nodes.node_uid JOIN fleet_region_releases f ON f.region_id=r.id AND f.release_id=a.release_id WHERE r.id=nodes.region_id AND r.bootstrap_material_revision=? AND a.release_id=? AND a.revision=? AND f.revision=? AND EXISTS(SELECT 1 FROM fleet_node_release_observations o JOIN node_host_configurations h ON h.node_id=o.node_id AND h.node_uid=o.node_uid WHERE o.node_id=nodes.id AND o.node_uid=nodes.node_uid AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash AND json_extract(o.facts_json,'$.boot_id')=? AND h.sha256=? AND julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')))" : ""}`,
        ).bind(
          doc,
          id,
          body.node_uid,
          oldDoc,
          ...(body.qualification
            ? [
                source!.material_revision,
                source!.release_id,
                source!.assignment_revision,
                source!.region_revision,
                source!.boot_id,
                source!.host_sha256,
              ]
            : []),
        ),
        lease.completeStatement(id, 200, {
          sql: "EXISTS(SELECT 1 FROM nodes WHERE id=? AND node_uid=? AND warm_reclaim_qualification_json=?)",
          bindings: [id, body.node_uid, doc],
        }),
      ]);
      if (result[0]!.meta.changes !== 1) closed();
      return getWarmReclaimQualification(c, id);
    },
  });
}
export async function authenticateReclaimRequest(c: ApiContext, id: string) {
  const region = await agentRegion(c),
    node = await approvedNode(c.env, id, region.id);
  if (!node)
    throw new ApiError(
      "not_found",
      "Current warm reclaimer qualification unavailable",
    );
  return { region, node };
}
export async function getReclaimIntents(c: ApiContext, id: string) {
  const { region, node } = await authenticateReclaimRequest(c, id);
  const issued = Date.now(),
    rows = await c.env.DB.prepare(
      "SELECT id FROM databases WHERE node_id=? AND region_id=? AND deleted_at IS NULL AND warm_reclaim_policy_json IS NOT NULL ORDER BY id LIMIT ?",
    )
      .bind(id, region.id, RECLAIM_LIMITS.max_tasks + 1)
      .all<{ id: string }>();
  if (rows.results.length > RECLAIM_LIMITS.max_tasks) closed();
  const tokens: string[] = [];
  for (const row of rows.results) {
    const token = await c.env.DATABASE_ACTOR.get(
      c.env.DATABASE_ACTOR.idFromName(row.id),
    ).reclaimIntent(row.id);
    if (token) {
      const bytes = base64urlToBytes(token.split(".")[1] ?? "");
      const claims = bytes
        ? ReclaimClaims.safeParse(
            JSON.parse(
              new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(bytes),
            ),
          )
        : null;
      if (
        claims?.success &&
        reclaimClaimsValidAt(claims.data, Date.now()) &&
        claims.data.node_uid === node.qualification.node_uid &&
        claims.data.boot_id === node.qualification.boot_id &&
        claims.data.cluster_uid === node.qualification.cluster_uid
      )
        tokens.push(token);
    }
  }
  if (Date.now() >= issued + RECLAIM_LIMITS.snapshot_ms) closed();
  const snapshot = ReclaimIntentSnapshot.parse({
    purpose: "pgcf-reclaim-intents/v1",
    node_uid: node.qualification.node_uid,
    boot_id: node.qualification.boot_id,
    material_revision: node.qualification.material_revision,
    issued_at: issued,
    expires_at: issued + RECLAIM_LIMITS.snapshot_ms,
    tokens,
  });
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    RECLAIM_LIMITS.max_envelope_bytes
  )
    closed();
  return c.json(snapshot, 200);
}
export async function observeReclaim(c: ApiContext, id: string, raw: unknown) {
  const region = await agentRegion(c),
    body = ReclaimObservations.parse(raw),
    node = await approvedNode(c.env, id, region.id),
    now = Date.now();
  if (
    !node ||
    body.node_uid !== node.qualification.node_uid ||
    body.boot_id !== node.qualification.boot_id ||
    body.material_revision !== node.qualification.material_revision ||
    body.observed_at < now - RECLAIM_LIMITS.snapshot_ms ||
    body.observed_at > now + RECLAIM_LIMITS.clock_skew_ms
  )
    closed();
  let accepted = 0;
  const seen = new Set<string>();
  for (const result of body.results) {
    if (
      seen.has(result.database_id) ||
      result.observed_at > body.observed_at ||
      result.observed_at < now - RECLAIM_LIMITS.snapshot_ms
    )
      closed();
    seen.add(result.database_id);
    const row = await c.env.DB.prepare(
      "SELECT 1 FROM databases WHERE id=? AND node_id=? AND region_id=?",
    )
      .bind(result.database_id, id, region.id)
      .first();
    if (!row) closed();
    if (
      await c.env.DATABASE_ACTOR.get(
        c.env.DATABASE_ACTOR.idFromName(result.database_id),
      ).recordReclaimObservation(result.database_id, result)
    )
      accepted++;
  }
  return c.json({ accepted }, 200);
}
