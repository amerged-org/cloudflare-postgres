// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "@pgcf/contracts";
import {
  FleetRegionMaterialRotationCheckpoint,
  FleetRegionMaterialRotationInput,
  REGION_AUTHORITY_PHASES,
  regionAuthorityPhaseMembers,
} from "@pgcf/contracts/region-material-rotation";
import type { FleetRolloutIntent } from "@pgcf/contracts/fleet-rollouts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  joinBundleReference,
  regionSeedReference,
  loadRegionJoinBundle,
  loadRegionSeed,
  type RegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import {
  readFleetRolloutIntent,
  writeFleetRolloutIntent,
  fleetRolloutAuthoritySql,
} from "./fleet-rollouts.ts";
import { currentOperatorAuthority } from "./node-operator.ts";
import { NODE_OBSERVATION_MAX_AGE_MS } from "./placement.ts";
import { installationHash } from "./node-installation.ts";
import { activateNativeRegionBootstrapRotation } from "./region-material-revisions.ts";

type Region = FleetRolloutIntent["regions"][number];
const changed = (): never => {
  throw new ApiError(
    "conflict",
    "Prepared cluster authority or fleet intent changed",
  );
};
function selected(intent: FleetRolloutIntent, id: string) {
  const region = intent.regions.find((value) => value.region_id === id);
  if (
    !region?.staged_material_revision ||
    region.staged_material_revision !== region.material_revision + 1
  )
    return changed();
  return region;
}
async function saveCheckpoint(
  env: Env,
  intent: FleetRolloutIntent,
  region: Region,
  checkpoint: FleetRegionMaterialRotationCheckpoint,
) {
  const next = structuredClone(intent),
    target = selected(next, region.region_id);
  target.rotation = FleetRegionMaterialRotationCheckpoint.parse(checkpoint);
  await writeFleetRolloutIntent(env, intent, next);
  return target.rotation;
}
async function owningIntent(env: Env, regionId: string) {
  const row = await env.DB.prepare(
    "SELECT rollout_json FROM fleet_region_releases WHERE region_id=?",
  )
    .bind(regionId)
    .first<{ rollout_json: string | null }>();
  if (!row?.rollout_json) return undefined;
  const parsed = JSON.parse(row.rollout_json) as FleetRolloutIntent;
  return readFleetRolloutIntent(env.DB, parsed.rollout_id);
}
export function rotationHostsMayStart(region: Region) {
  return (
    !!region.rotation &&
    ((region.rotation.phase === "discovery-secret" &&
      region.rotation.state === "confirmed" &&
      region.rotation.node_index === region.nodes.length - 1) ||
      REGION_AUTHORITY_PHASES.indexOf(
        region.rotation.phase as (typeof REGION_AUTHORITY_PHASES)[number],
      ) >= 15 ||
      ["verify", "activate", "complete"].includes(region.rotation.phase)) &&
    region.rotation.state !== "halted"
  );
}

/** The active custody fence stays unchanged; only this owned transition uses its sealed successor. */
export async function effectiveFleetRegionJoin(
  env: Env,
  regionId: string,
  currentRevision: number,
  current: RegionJoinBundle,
): Promise<RegionJoinBundle> {
  const intent = await owningIntent(env, regionId),
    region = intent?.regions.find((value) => value.region_id === regionId);
  if (
    !region?.staged_material_revision ||
    currentRevision !== region.material_revision ||
    !rotationHostsMayStart(region)
  )
    return current;
  const next = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(regionId, region.staged_material_revision),
  );
  if (
    next.kube_system_uid !== region.cluster_uid ||
    current.kube_system_uid !== region.cluster_uid ||
    next.cluster_endpoint !== current.cluster_endpoint ||
    next.cluster_name !== current.cluster_name
  )
    return changed();
  return next;
}

async function capabilitySignature(
  env: Env,
  intent: FleetRolloutIntent,
  region: Region,
  expires: number,
  revision: number,
) {
  const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.BOOTSTRAP_TOKEN),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          JSON.stringify([
            "fleet-region-authority-v1",
            intent.rollout_id,
            intent.release_id,
            region.region_id,
            region.cluster_uid,
            region.material_revision,
            region.staged_material_revision,
            intent.created_at,
            expires,
            revision,
          ]),
        ),
      ),
    );
  return Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function authorizeFleetRegionRotation(
  env: Env,
  rolloutId: string,
  regionId: string,
  bearer: string | null,
) {
  const match = /^Bearer ([0-9]{10})\.([0-9]{1,10})\.([a-f0-9]{64})$/.exec(
    bearer ?? "",
  );
  if (!match)
    throw new ApiError("unauthorized", "Fleet rotation capability required");
  const intent = await readFleetRolloutIntent(env.DB, rolloutId),
    region = selected(intent, regionId),
    expires = Number(match[1]),
    revision = Number(match[2]),
    clock = Math.floor(Date.now() / 1000);
  if (
    expires <= clock ||
    expires > clock + 1800 ||
    !region.rotation ||
    region.rotation.revision < revision ||
    region.rotation.revision > revision + 2 ||
    region.rotation.state === "halted" ||
    region.rotation.phase === "complete" ||
    !timingSafeEqual(
      match[3]!,
      await capabilitySignature(env, intent, region, expires, revision),
    )
  )
    throw new ApiError(
      "unauthorized",
      "Fleet rotation capability expired or changed",
    );
  const active = await env.DB.prepare(
    "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
  )
    .bind(regionId)
    .first<{ revision: number }>();
  if (
    active?.revision !== region.material_revision &&
    active?.revision !== region.staged_material_revision
  )
    return changed();
  const authority = fleetRolloutAuthoritySql(intent);
  if (
    !(await env.DB.prepare(`SELECT 1 valid WHERE ${authority.sql}`)
      .bind(...authority.bindings)
      .first())
  )
    return changed();
  return { intent, region };
}

export async function preparedRegionRotationInput(
  env: Env,
  rolloutId: string,
  regionId: string,
): Promise<FleetRegionMaterialRotationInput> {
  const intent = await readFleetRolloutIntent(env.DB, rolloutId),
    region = selected(intent, regionId);
  if (!region.rotation || region.rotation.state === "halted") return changed();
  const active = await env.DB.prepare(
    "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
  )
    .bind(regionId)
    .first<{ revision: number }>();
  if (
    !active ||
    (active.revision !== region.material_revision &&
      !(
        active.revision === region.staged_material_revision &&
        region.rotation.phase === "verify" &&
        region.rotation.state === "confirmed" &&
        region.rotation.verified
      ))
  )
    return changed();
  const [currentSeed, currentJoin, targetSeed, targetJoin] = await Promise.all([
    loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(regionId, region.material_revision),
    ),
    loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(regionId, region.material_revision),
    ),
    loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(regionId, region.staged_material_revision!),
    ),
    loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(regionId, region.staged_material_revision!),
    ),
  ]);
  const nodes: FleetRegionMaterialRotationInput["nodes"] = [],
    now = Date.now();
  for (const target of region.nodes) {
    const row = await env.DB.prepare(
      `SELECT n.k8s_node_name,n.provider_instance_id,n.node_uid,n.ready,n.lost_at,n.last_observed_at,o.observed_at,o.facts_json,f.spec_json
       FROM nodes n JOIN regions r ON r.id=n.region_id
       JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
       JOIN fleet_releases f ON f.id=a.release_id
       JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash
       WHERE n.id=? AND n.region_id=? AND a.release_id=? AND a.revision=?`,
    )
      .bind(
        target.node_id,
        regionId,
        intent.release_id,
        target.assignment_revision,
      )
      .first<{
        k8s_node_name: string;
        provider_instance_id: string;
        node_uid: string;
        ready: number;
        lost_at: string | null;
        last_observed_at: string;
        observed_at: string;
        facts_json: string;
        spec_json: string;
      }>();
    if (
      !row ||
      row.node_uid !== target.node_uid ||
      row.ready !== 1 ||
      row.lost_at !== null ||
      [row.last_observed_at, row.observed_at].some(
        (at) =>
          !Number.isFinite(Date.parse(at)) ||
          Date.parse(at) < now - NODE_OBSERVATION_MAX_AGE_MS ||
          Date.parse(at) > now + 5000,
      )
    )
      return changed();
    const facts = JSON.parse(row.facts_json) as {
        kubernetes_control_plane?: boolean;
        components: { name: string; runtime_image_sha256?: string }[];
      },
      spec = JSON.parse(row.spec_json) as {
        components: { name: string; reference: string }[];
      },
      pin = spec.components.find((c) => c.name === "image/cilium/cilium"),
      live = facts.components.find((c) => c.name === "image/cilium/cilium");
    if (!pin || !live?.runtime_image_sha256) return changed();
    await currentOperatorAuthority(
      env,
      target.node_id,
      target.node_uid,
      active.revision,
    );
    nodes.push({
      node_id: target.node_id,
      node_uid: target.node_uid,
      node_name: row.k8s_node_name,
      provider_instance_id: row.provider_instance_id,
      address: target.address,
      role: facts.kubernetes_control_plane === true ? "controlplane" : "worker",
      cilium_image: pin.reference,
      cilium_image_id:
        pin.reference.split("@")[0] + "@sha256:" + live.runtime_image_sha256,
    });
  }
  const expires = Math.floor(Date.now() / 1000) + 900,
    revision = region.rotation.revision,
    signature = await capabilitySignature(
      env,
      intent,
      region,
      expires,
      revision,
    ),
    url = new URL(env.NODE_BOOTSTRAP_CALLBACK_URL);
  url.pathname = `/internal/v1/fleet-rollouts/${rolloutId}/regions/${regionId}/rotation`;
  return FleetRegionMaterialRotationInput.parse({
    rollout_id: rolloutId,
    region_id: regionId,
    cluster_uid: region.cluster_uid,
    current_revision: region.material_revision,
    target_revision: region.staged_material_revision,
    checkpoint: region.rotation,
    current_seed: currentSeed,
    current_join: currentJoin,
    target_seed: targetSeed,
    target_join: targetJoin,
    nodes,
    callback: {
      url: url.href,
      bearer: `${expires}.${revision}.${signature}`,
      expires_at: new Date(expires * 1000).toISOString(),
    },
  });
}

/** Reuse the accepted daily artifact; all mutation progress stays in the existing fleet intent. */
export async function runPreparedRegionAuthorityRotation(
  env: Env,
  selection: { rollout_id: string; region_id: string },
): Promise<"pending" | "hosts_ready" | "complete"> {
  const intent = await readFleetRolloutIntent(env.DB, selection.rollout_id),
    region = selected(intent, selection.region_id);
  if (!region.rotation) {
    await saveCheckpoint(env, intent, region, {
      revision: 0,
      phase: "snapshot",
      node_index: 0,
      state: "pending",
    });
    return "pending";
  }
  const checkpoint = region.rotation;
  if (checkpoint.state === "halted") return "pending";
  if (checkpoint.phase === "complete" && checkpoint.state === "confirmed")
    return "complete";
  if (
    checkpoint.phase === "verify" &&
    checkpoint.state === "confirmed" &&
    checkpoint.verified
  ) {
    const prepared = await preparedRegionRotationInput(
        env,
        intent.rollout_id,
        region.region_id,
      ),
      proof = checkpoint.verified,
      verificationSHA = await installationHash(proof);
    await activateNativeRegionBootstrapRotation(
      env,
      region.region_id,
      intent.rollout_id,
      {
        expected_revision: region.material_revision,
        expected_seed_sha256: await installationHash(prepared.current_seed),
        expected_join_sha256: await installationHash(prepared.current_join),
        seed_sha256: await installationHash(prepared.target_seed),
        join_sha256: await installationHash(prepared.target_join),
        verified: proof,
        verification_sha256: verificationSHA,
      },
    );
    const next = structuredClone(intent),
      target = selected(next, region.region_id);
    target.current_material_revision = region.staged_material_revision!;
    target.rotation = {
      ...checkpoint,
      revision: checkpoint.revision + 1,
      phase: "complete",
      state: "confirmed",
    };
    await writeFleetRolloutIntent(env, intent, next);
    return "complete";
  }
  if (checkpoint.phase === "snapshot") {
    const artifact = await env.DB.prepare(
      `SELECT a.* FROM infrastructure_backup_artifacts a JOIN infrastructure_backup_runs r ON r.id=a.run_id
       WHERE a.kind='etcd' AND a.region_id=? AND a.cluster_uid=? AND a.material_revision=? AND a.status='complete' AND r.status='complete'
       AND a.completed_at>=? ORDER BY a.completed_at DESC LIMIT 1`,
    )
      .bind(
        region.region_id,
        region.cluster_uid,
        region.material_revision,
        new Date(Date.now() - 36 * 3600000).toISOString(),
      )
      .first<{
        node_id: string;
        node_uid: string;
        object_key: string;
        kid: string;
        plaintext_sha256: string;
        encrypted_sha256: string;
        plaintext_bytes: number;
        encrypted_bytes: number;
      }>();
    if (
      !artifact ||
      !region.nodes.some(
        (n) =>
          n.node_id === artifact.node_id && n.node_uid === artifact.node_uid,
      )
    )
      return "pending";
    const {
      object_key,
      kid,
      plaintext_sha256,
      encrypted_sha256,
      plaintext_bytes,
      encrypted_bytes,
    } = artifact;
    await saveCheckpoint(env, intent, region, {
      revision: checkpoint.revision + 1,
      phase: REGION_AUTHORITY_PHASES[0],
      node_index: 0,
      state: "pending",
      artifact: {
        object_key,
        kid,
        plaintext_sha256,
        encrypted_sha256,
        plaintext_bytes,
        encrypted_bytes,
      },
    });
    return "pending";
  }
  if (
    checkpoint.phase === "discovery-secret" &&
    checkpoint.state === "confirmed" &&
    checkpoint.node_index === region.nodes.length - 1
  )
    return "hosts_ready";
  if (checkpoint.phase === "etcd-ca") {
    if (checkpoint.state !== "confirmed") return "hosts_ready";
    const unfinished = await env.DB.prepare(
      "SELECT operation_id FROM fleet_patch_operations WHERE region_id=? AND release_id=? AND stage NOT IN('complete','host_ready') LIMIT 1",
    )
      .bind(region.region_id, intent.release_id)
      .first();
    if (unfinished) return "hosts_ready";
  }
  let input = await preparedRegionRotationInput(
    env,
    intent.rollout_id,
    region.region_id,
  );
  if (
    checkpoint.state === "confirmed" &&
    REGION_AUTHORITY_PHASES.includes(
      checkpoint.phase as (typeof REGION_AUTHORITY_PHASES)[number],
    )
  ) {
    const phase = checkpoint.phase as (typeof REGION_AUTHORITY_PHASES)[number],
      members = regionAuthorityPhaseMembers(phase, input.nodes),
      index = REGION_AUTHORITY_PHASES.indexOf(phase),
      last = checkpoint.node_index === members.length - 1,
      nextPhase = last
        ? (REGION_AUTHORITY_PHASES[index + 1] ?? "verify")
        : phase;
    await saveCheckpoint(env, intent, region, {
      revision: checkpoint.revision + 1,
      phase: nextPhase,
      node_index: last ? 0 : checkpoint.node_index + 1,
      state: "pending",
      ...(checkpoint.artifact ? { artifact: checkpoint.artifact } : {}),
      ...(checkpoint.prior_boot_id
        ? { prior_boot_id: checkpoint.prior_boot_id }
        : {}),
    });
    input = await preparedRegionRotationInput(
      env,
      intent.rollout_id,
      region.region_id,
    );
  }
  const stub = env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(
      `fleet-rotation:${intent.rollout_id}:${region.region_id}`,
    ),
  );
  await stub.rotateRegionAuthority(input);
  return "pending";
}

export async function checkpointFleetRegionAuthority(
  env: Env,
  rolloutId: string,
  regionId: string,
  bearer: string | null,
  value: unknown,
) {
  const { intent, region } = await authorizeFleetRegionRotation(
      env,
      rolloutId,
      regionId,
      bearer,
    ),
    body = value as { expected_revision?: unknown; checkpoint?: unknown },
    previous = region.rotation!,
    next = FleetRegionMaterialRotationCheckpoint.parse(body.checkpoint);
  if (
    body.expected_revision !== previous.revision ||
    next.revision !== previous.revision + 1
  )
    return changed();
  const samePhase =
      next.phase === previous.phase && next.node_index === previous.node_index,
    etcdDispatch =
      previous.phase === "discovery-secret" &&
      previous.state === "confirmed" &&
      previous.node_index === region.nodes.length - 1 &&
      next.phase === "etcd-ca" &&
      next.node_index === 0 &&
      next.state === "dispatched";
  if (!samePhase && !etcdDispatch) return changed();
  if (etcdDispatch) {
    const patch = await env.DB.prepare(
      `SELECT p.stage,p.state FROM fleet_patch_operations p
       JOIN nodes n ON n.id=p.node_id AND n.node_uid=p.node_uid AND n.region_id=p.region_id
       JOIN regions r ON r.id=n.region_id
       JOIN fleet_node_releases a ON a.node_id=p.node_id AND a.node_uid=p.node_uid AND a.release_id=p.release_id AND a.revision=p.assignment_revision
       JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash
       WHERE p.region_id=? AND p.release_id=? AND p.region_revision=? AND p.cluster_uid=? AND p.material_revision=?
       AND json_extract(o.facts_json,'$.kubernetes_control_plane')=1 AND p.stage='talos_reboot' AND p.state='dispatched'
       AND p.bootstrap_operation_id IS NULL LIMIT 1`,
    )
      .bind(
        regionId,
        intent.release_id,
        region.revision,
        region.cluster_uid,
        region.material_revision,
      )
      .first();
    if (
      !patch ||
      !next.prior_boot_id ||
      !next.before_sha256 ||
      !next.target_sha256
    )
      return changed();
  }
  if (
    previous.artifact &&
    JSON.stringify(next.artifact) !== JSON.stringify(previous.artifact)
  )
    return changed();
  if (previous.prior_boot_id && next.prior_boot_id !== previous.prior_boot_id)
    return changed();
  if (
    previous.state === "dispatched" &&
    next.state === "dispatched" &&
    (next.before_sha256 !== previous.before_sha256 ||
      next.target_sha256 !== previous.target_sha256)
  )
    return changed();
  if (
    previous.state === "dispatched" &&
    next.state === "confirmed" &&
    next.target_sha256 !== previous.target_sha256
  )
    return changed();
  await saveCheckpoint(env, intent, region, next);
  const fresh = await readFleetRolloutIntent(env.DB, rolloutId),
    target = selected(fresh, regionId),
    expires = Math.floor(Date.now() / 1000) + 900,
    signature = await capabilitySignature(
      env,
      fresh,
      target,
      expires,
      next.revision,
    );
  return {
    checkpoint: next,
    bearer: `${expires}.${next.revision}.${signature}`,
  };
}

/** The control's existing PatchNode receives only the phase16 payload at its reboot boundary. */
export async function fleetPatchPreparedAuthority(
  env: Env,
  regionId: string,
  nodeId: string,
) {
  const intent = await owningIntent(env, regionId),
    region = intent?.regions.find((r) => r.region_id === regionId);
  if (
    !intent ||
    !region?.staged_material_revision ||
    !rotationHostsMayStart(region) ||
    region.rotation?.phase === "complete"
  )
    return undefined;
  const member = region.nodes.find((n) => n.node_id === nodeId);
  if (!member) return undefined;
  const prepared = await preparedRegionRotationInput(
    env,
    intent.rollout_id,
    regionId,
  );
  return prepared.nodes.some(
    (node) => node.node_id === nodeId && node.role === "controlplane",
  )
    ? prepared
    : undefined;
}
