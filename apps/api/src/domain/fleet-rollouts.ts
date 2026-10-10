// SPDX-License-Identifier: Apache-2.0
import { newOperationId } from "@pgcf/contracts";
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  FleetRolloutIntent,
  FleetRolloutStatus,
  type FleetRolloutRequest,
} from "@pgcf/contracts/fleet-rollouts";
import { runPreparedRegionAuthorityRotation } from "./fleet-region-authority.ts";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { MEMORY_SAMPLE_MAX_AGE_MS } from "./memory-capacity.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { readFleetNodeRelease } from "./fleet-releases.ts";
import {
  continueFleetPatchRegion,
  ensureRetainedFleetPatch,
  readFleetPatch,
  readFleetPatchStatus,
  synchronizeFleetPatchRegionMaterial,
  refreshFleetPatchRegionStorage,
  restoreFleetPatchPlacements,
} from "./fleet-patches.ts";

const changed = (): never => {
  throw new ApiError("conflict", "Fleet rollout identity or authority changed");
};
type RegionIntent = FleetRolloutIntent["regions"][number];
export async function readFleetRolloutIntent(
  db: D1Database,
  id: string,
): Promise<FleetRolloutIntent> {
  const row = await db
    .prepare(
      "SELECT rollout_json FROM fleet_region_releases WHERE json_extract(rollout_json,'$.rollout_id')=? LIMIT 1",
    )
    .bind(id)
    .first<{ rollout_json: string }>();
  if (!row) throw new ApiError("not_found", "Fleet rollout not found");
  return FleetRolloutIntent.parse(JSON.parse(row.rollout_json));
}
/** Shared atomic authority for the existing intent, custody activation and issued capabilities. */
export function fleetRolloutAuthoritySql(input: FleetRolloutIntent): {
  sql: string;
  bindings: (string | number)[];
} {
  const intent = FleetRolloutIntent.parse(input),
    regions = JSON.stringify(intent.regions),
    raw = JSON.stringify(intent);
  return {
    sql: `NOT EXISTS(SELECT 1 FROM json_each(?) target LEFT JOIN regions r ON r.id=json_extract(target.value,'$.region_id') LEFT JOIN fleet_region_releases f ON f.region_id=r.id WHERE r.id IS NULL OR f.region_id IS NULL OR f.release_id<>? OR f.revision<>json_extract(target.value,'$.revision') OR f.rollout_json IS NOT ? OR (SELECT count(*) FROM nodes WHERE region_id=r.id AND lost_at IS NULL)<>json_array_length(target.value,'$.nodes')) AND NOT EXISTS(SELECT 1 FROM json_each(?) target,json_each(target.value,'$.nodes') member LEFT JOIN nodes n ON n.id=json_extract(member.value,'$.node_id') LEFT JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.id IS NULL OR n.region_id<>json_extract(target.value,'$.region_id') OR n.node_uid IS NOT json_extract(member.value,'$.node_uid') OR n.lost_at IS NOT NULL OR a.node_id IS NULL OR a.node_uid IS NOT n.node_uid OR a.release_id<>? OR a.revision<>json_extract(member.value,'$.assignment_revision') OR a.role IS NOT json_extract(member.value,'$.role'))`,
    bindings: [regions, intent.release_id, raw, regions, intent.release_id],
  };
}
/** Only programmed custody handoffs may update material metadata; selected identities/releases are immutable. */
export async function writeFleetRolloutIntent(
  env: Env,
  before: FleetRolloutIntent,
  after: FleetRolloutIntent,
) {
  const old = JSON.stringify(FleetRolloutIntent.parse(before)),
    next = JSON.stringify(FleetRolloutIntent.parse(after));
  const fixed = (value: FleetRolloutIntent) =>
    JSON.stringify({
      ...value,
      regions: value.regions.map(
        ({ current_material_revision, rotation, ...region }) => {
          void current_material_revision;
          void rotation;
          return region;
        },
      ),
    });
  if (fixed(before) !== fixed(after)) return changed();
  for (const region of after.regions) {
    const prior = before.regions.find(
      (row) => row.region_id === region.region_id,
    )!;
    if (
      region.current_material_revision !== prior.current_material_revision &&
      region.current_material_revision !== prior.current_material_revision + 1
    )
      return changed();
    if (JSON.stringify(region.rotation) !== JSON.stringify(prior.rotation)) {
      const expected = prior.rotation ? prior.rotation.revision + 1 : 0;
      if (!region.rotation || region.rotation.revision !== expected)
        return changed();
    }
    await assertCluster(env, region);
  }
  const authority = fleetRolloutAuthoritySql(before);
  const result = await env.DB.prepare(
    `UPDATE fleet_region_releases SET rollout_json=? WHERE rollout_json=? AND (SELECT count(*) FROM fleet_region_releases WHERE rollout_json=?)=? AND (${authority.sql})`,
  )
    .bind(next, old, old, before.regions.length, ...authority.bindings)
    .run();
  if (result.meta.changes !== before.regions.length) {
    const current = await readFleetRolloutIntent(env.DB, before.rollout_id);
    const replayAuthority = fleetRolloutAuthoritySql(after);
    if (
      JSON.stringify(current) !== next ||
      !(await env.DB.prepare(`SELECT 1 valid WHERE ${replayAuthority.sql}`)
        .bind(...replayAuthority.bindings)
        .first())
    )
      return changed();
  }
}
/** Recover a committed supported metadata synchronization from its existing qualified patch receipt. */
async function refreshFleetRolloutQualifiedMaterial(env: Env, id: string) {
  const intent = await readFleetRolloutIntent(env.DB, id),
    updated = structuredClone(intent);
  for (const region of updated.regions) {
    const current = await env.DB.prepare(
      "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
    )
      .bind(region.region_id)
      .first<{ revision: number }>();
    if (!current || current.revision === region.current_material_revision)
      continue;
    if (current.revision !== region.current_material_revision + 1)
      return changed();
    const qualified = await env.DB.prepare(
      "SELECT 1 valid FROM fleet_patch_operations p WHERE p.region_id=? AND p.release_id=? AND p.region_revision=? AND p.material_revision=? AND p.stage='complete' AND p.state='confirmed' AND p.cluster_uid=? AND NOT EXISTS(SELECT 1 FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.region_id=p.region_id AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.node_id=n.id AND f.node_uid=n.node_uid AND f.release_id=p.release_id AND f.assignment_revision=a.revision AND f.region_revision=p.region_revision AND f.stage='complete' AND f.state='confirmed')) LIMIT 1",
    )
      .bind(
        region.region_id,
        intent.release_id,
        region.revision,
        region.current_material_revision,
        region.cluster_uid,
      )
      .first();
    if (!qualified) return changed();
    region.current_material_revision = current.revision;
    const reference = await loadCurrentRegionMaterialReference(
        env.DB,
        region.region_id,
        "join_bundle",
      ),
      bundle = await loadRegionJoinBundle(
        env.DB,
        env.CREDENTIAL_KEYS,
        reference,
      ),
      release = await env.DB.prepare(
        "SELECT spec_json FROM fleet_releases WHERE id=?",
      )
        .bind(intent.release_id)
        .first<{ spec_json: string }>();
    const target = FleetReleaseSpec.parse(JSON.parse(release!.spec_json)).roles
      .customer;
    if (
      bundle.talos_version.replace(/^v/, "") !==
        target.talos_version.replace(/^v/, "") ||
      bundle.kubernetes_version.replace(/^v/, "") !==
        target.kubernetes_version.replace(/^v/, "")
    )
      return changed();
  }
  if (JSON.stringify(updated) !== JSON.stringify(intent))
    await writeFleetRolloutIntent(env, intent, updated);
}
async function assertIntent(env: Env, intent: FleetRolloutIntent) {
  const raw = JSON.stringify(intent);
  for (const region of intent.regions) {
    const row = await env.DB.prepare(
      "SELECT f.release_id,f.revision,f.rollout_json,r.bootstrap_material_revision FROM fleet_region_releases f JOIN regions r ON r.id=f.region_id WHERE f.region_id=?",
    )
      .bind(region.region_id)
      .first<{
        release_id: string;
        revision: number;
        rollout_json: string;
        bootstrap_material_revision: number;
      }>();
    if (
      !row ||
      row.release_id !== intent.release_id ||
      row.revision !== region.revision ||
      row.rollout_json !== raw ||
      row.bootstrap_material_revision !== region.current_material_revision
    )
      return changed();
    await assertCluster(env, region);
    const members = await env.DB.prepare(
      "SELECT n.id,n.node_uid,n.lost_at,a.node_uid assigned_uid,a.release_id,a.revision,a.role FROM nodes n LEFT JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.region_id=? AND n.lost_at IS NULL",
    )
      .bind(region.region_id)
      .all<{
        id: string;
        node_uid: string;
        lost_at: string | null;
        assigned_uid: string;
        release_id: string;
        revision: number;
        role: string;
      }>();
    if (members.results.length !== region.nodes.length) return changed();
    for (const node of region.nodes) {
      const current = members.results.find((row) => row.id === node.node_id);
      if (
        !current ||
        current.node_uid !== node.node_uid ||
        current.assigned_uid !== node.node_uid ||
        current.release_id !== intent.release_id ||
        current.revision !== node.assignment_revision ||
        current.role !== node.role
      )
        return changed();
    }
  }
}
async function assertCluster(env: Env, region: RegionIntent) {
  const reference = await loadCurrentRegionMaterialReference(
      env.DB,
      region.region_id,
      "join_bundle",
    ),
    bundle = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, reference);
  if (
    bundle.kube_system_uid !== region.cluster_uid ||
    reference.revision !== region.current_material_revision
  )
    return changed();
}
async function latestPatch(
  env: Env,
  intent: FleetRolloutIntent,
  node: RegionIntent["nodes"][number],
) {
  const row = await env.DB.prepare(
    "SELECT operation_id FROM fleet_patch_operations WHERE node_id=? AND node_uid=? AND release_id=? AND assignment_revision=? AND bootstrap_operation_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
  )
    .bind(
      node.node_id,
      node.node_uid,
      intent.release_id,
      node.assignment_revision,
    )
    .first<{ operation_id: string }>();
  return row ? readFleetPatchStatus(env, row.operation_id) : null;
}
async function freshFleetMemory(
  db: D1Database,
  node: RegionIntent["nodes"][number],
) {
  const now = Date.now();
  const sample = await db
    .prepare(
      `SELECT m.observed_at FROM nodes n JOIN node_memory_samples m ON m.node_id=n.id AND m.node_uid=n.node_uid WHERE n.id=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND m.observed_at=(SELECT MAX(observed_at) FROM node_memory_samples WHERE node_id=n.id AND node_uid=n.node_uid) AND m.observed_at>=? AND m.observed_at<=? AND typeof(m.capacity_memory_bytes)='integer' AND m.capacity_memory_bytes BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER} AND typeof(m.working_set_bytes)='integer' AND m.working_set_bytes BETWEEN 0 AND m.capacity_memory_bytes AND typeof(m.available_bytes)='integer' AND m.available_bytes BETWEEN 0 AND m.capacity_memory_bytes AND m.memory_pressure=0`,
    )
    .bind(
      node.node_id,
      node.node_uid,
      new Date(now - MEMORY_SAMPLE_MAX_AGE_MS).toISOString(),
      new Date(now + 5000).toISOString(),
    )
    .first<{ observed_at: string }>();
  return sample?.observed_at ?? null;
}
export async function readFleetRollout(
  env: Env,
  id: string,
): Promise<FleetRolloutStatus> {
  const intent = await readFleetRolloutIntent(env.DB, id);
  let reason: string | null = null,
    state: FleetRolloutStatus["state"] = "complete";
  try {
    await assertIntent(env, intent);
  } catch {
    reason = "identity_or_assignment_changed";
    state = "blocked";
  }
  const regions: FleetRolloutStatus["regions"] = [];
  for (const region of intent.regions) {
    const nodes: FleetRolloutStatus["regions"][number]["nodes"] = [];
    for (const node of region.nodes) {
      const observed = await readFleetNodeRelease(env.DB, node.node_id),
        patch = await latestPatch(env, intent, node);
      const ram_observed_at = await freshFleetMemory(env.DB, node);
      nodes.push({
        node_id: node.node_id,
        ram_observed_at,
        release: observed,
        patch,
      });
      if (
        observed.state === "converged" &&
        ram_observed_at === null &&
        state !== "blocked"
      ) {
        if (state !== "running") state = "pending";
        reason = "waiting_observations";
      }
      if (state !== "blocked") {
        if (patch?.state === "halted") {
          state = "blocked";
          reason = patch.error_code ?? "patch_halted";
        } else if (patch && !["complete", "host_ready"].includes(patch.stage))
          state = "running";
        else if (observed.state !== "converged" && state !== "running")
          state = "pending";
      }
    }
    const material = await env.DB.prepare(
      "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
    )
      .bind(region.region_id)
      .first<{ revision: number }>();
    if (
      region.staged_material_revision !== undefined &&
      (material?.revision ?? 0) < region.staged_material_revision &&
      state !== "blocked"
    ) {
      state = "pending";
      reason = "prepared_rotation_pending";
    }
    regions.push({
      region_id: region.region_id,
      current_material_revision: region.current_material_revision,
      staged_material_revision: region.staged_material_revision ?? null,
      rotation: region.rotation ?? null,
      nodes,
    });
  }
  return FleetRolloutStatus.parse({
    rollout_id: id,
    release_id: intent.release_id,
    created_at: intent.created_at,
    state,
    reason,
    regions,
  });
}
export async function getFleetRollout(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  return c.json(await readFleetRollout(c.env, id), 200);
}

/** One intent owns ordering. Existing PatchNode records own every mutation and uncertain dispatch. */
export async function advanceFleetRollout(
  env: Env,
  id: string,
): Promise<FleetRolloutStatus> {
  // Resolve an acknowledged verification/uncertain custody activation before ordinary material checks.
  const initial = await readFleetRolloutIntent(env.DB, id);
  for (const region of initial.regions) {
    if (
      region.staged_material_revision &&
      region.rotation?.phase === "verify" &&
      region.rotation.state === "confirmed" &&
      region.rotation.verified
    ) {
      const current = await env.DB.prepare(
        "SELECT bootstrap_material_revision revision FROM regions WHERE id=?",
      )
        .bind(region.region_id)
        .first<{ revision: number }>();
      if (
        current?.revision === region.staged_material_revision &&
        region.current_material_revision !== current.revision
      )
        await runPreparedRegionAuthorityRotation(env, {
          rollout_id: id,
          region_id: region.region_id,
        });
    }
  }
  await refreshFleetRolloutQualifiedMaterial(env, id);
  const intent = await readFleetRolloutIntent(env.DB, id);
  await assertIntent(env, intent);
  for (const region of intent.regions) {
    const observations = await Promise.all(
      region.nodes.map((node) => readFleetNodeRelease(env.DB, node.node_id)),
    );
    const active = await env.DB.prepare(
      "SELECT operation_id,node_id FROM fleet_patch_operations WHERE region_id=? AND stage NOT IN('complete','host_ready')",
    )
      .bind(region.region_id)
      .first<{ operation_id: string; node_id: string }>();
    if (active) {
      const row = await readFleetPatch(env, active.operation_id),
        target = region.nodes.find((node) => node.node_id === row.node_id);
      if (
        !target ||
        row.node_uid !== target.node_uid ||
        row.release_id !== intent.release_id ||
        row.assignment_revision !== target.assignment_revision ||
        row.region_revision !== region.revision ||
        row.bootstrap_operation_id
      )
        return changed();
      if (row.state !== "halted")
        await ensureRetainedFleetPatch(env, target.node_id, {
          node_uid: target.node_uid,
          assignment_revision: target.assignment_revision,
          release_id: intent.release_id,
          address: target.address,
          maintenance_acknowledged: true,
        });
      return readFleetRollout(env, id);
    }
    if (region.staged_material_revision !== undefined) {
      const rotation = await runPreparedRegionAuthorityRotation(env, {
        rollout_id: id,
        region_id: region.region_id,
      });
      if (rotation === "pending") return readFleetRollout(env, id);
    }
    // All members must be host-qualified before regional services activate. Do not finalize the first host early.
    for (const [index, node] of region.nodes.entries()) {
      const previous = await latestPatch(env, intent, node);
      if (previous?.state === "halted") return readFleetRollout(env, id);
      const rotationPending =
        region.staged_material_revision !== undefined &&
        region.rotation?.phase !== "complete";
      if (
        !previous &&
        (rotationPending || observations[index]!.state !== "converged")
      ) {
        await assertCluster(env, region);
        await ensureRetainedFleetPatch(env, node.node_id, {
          node_uid: node.node_uid,
          assignment_revision: node.assignment_revision,
          release_id: intent.release_id,
          address: node.address,
          maintenance_acknowledged: true,
        });
        return readFleetRollout(env, id);
      }
    }
    if (
      region.staged_material_revision !== undefined &&
      (await runPreparedRegionAuthorityRotation(env, {
        rollout_id: id,
        region_id: region.region_id,
      })) !== "complete"
    )
      return readFleetRollout(env, id);
    const patches = await Promise.all(
      region.nodes.map((node) => latestPatch(env, intent, node)),
    );
    const terminal =
      patches.find((patch) => patch?.stage === "host_ready") ??
      patches.find((patch) => patch?.stage === "complete");
    if (terminal) {
      const next = await continueFleetPatchRegion(env, terminal.operation_id);
      if (next) return readFleetRollout(env, id);
      if (terminal.stage === "host_ready") return readFleetRollout(env, id);
      const material = await synchronizeFleetPatchRegionMaterial(
        env,
        terminal.operation_id,
      );
      if (material !== "synchronized") return readFleetRollout(env, id);
      await refreshFleetRolloutQualifiedMaterial(env, id);
      const refresh = await continueFleetPatchRegion(
        env,
        terminal.operation_id,
      );
      if (refresh) return readFleetRollout(env, id);
      if (
        !(await refreshFleetPatchRegionStorage(env, terminal.operation_id)) ||
        !(await restoreFleetPatchPlacements(env, terminal.operation_id))
      )
        return readFleetRollout(env, id);
    }
    if (observations.some((observation) => observation.state !== "converged"))
      return readFleetRollout(env, id);
    if (
      (
        await Promise.all(
          region.nodes.map((node) => freshFleetMemory(env.DB, node)),
        )
      ).some((sample) => sample === null)
    )
      return readFleetRollout(env, id);
    // Only a fully converged predecessor region permits any successor-region write.
  }
  return readFleetRollout(env, id);
}
export async function continueFleetRolloutForRegion(
  env: Env,
  regionId: string,
) {
  const row = await env.DB.prepare(
    "SELECT rollout_json FROM fleet_region_releases WHERE region_id=? AND rollout_json IS NOT NULL",
  )
    .bind(regionId)
    .first<{ rollout_json: string }>();
  return row
    ? advanceFleetRollout(
        env,
        FleetRolloutIntent.parse(JSON.parse(row.rollout_json)).rollout_id,
      )
    : null;
}
export async function runFleetRollouts(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT json_extract(rollout_json,'$.rollout_id') id FROM fleet_region_releases WHERE rollout_json IS NOT NULL ORDER BY id LIMIT 10",
  ).all<{ id: string }>();
  for (const row of rows.results) {
    try {
      await advanceFleetRollout(env, row.id);
    } catch {
      /* Current intent remains readable; no journal or dispatch is reset. Next Cron reads it again. */
    }
  }
}
export async function createFleetRollout(
  c: ApiContext,
  input: FleetRolloutRequest,
) {
  await requireScope(c, "admin");
  if (!c.req.header("Idempotency-Key"))
    throw new ApiError(
      "invalid_request",
      "Idempotency-Key is required for fleet rollouts",
    );
  const output = async (id: string) => {
    // Failure to start leaves committed desired intent intact. Cron resumes this exact intent.
    try {
      await advanceFleetRollout(c.env, id);
    } catch {
      /* GET exposes current identity, inventory and persisted patch error. */
    }
    return c.json(await readFleetRollout(c.env, id), 202);
  };
  return withIdempotency(c, {
    replay: output,
    execute: async (lease) => {
      const selected = await c.env.DB.prepare(
        "SELECT spec_json FROM fleet_releases WHERE id=?",
      )
        .bind(input.release_id)
        .first<{ spec_json: string }>();
      if (!selected) throw new ApiError("not_found", "Fleet release not found");
      const spec = FleetReleaseSpec.parse(JSON.parse(selected.spec_json));
      const intent: FleetRolloutIntent = {
        ...input,
        rollout_id: newOperationId(),
        created_at: new Date().toISOString(),
        regions: [],
      };
      const snapshot: unknown[] = [];
      for (const target of input.regions) {
        const row = await c.env.DB.prepare(
          "SELECT r.id,r.bootstrap_material_revision,f.release_id,f.revision,f.rollout_json FROM regions r LEFT JOIN fleet_region_releases f ON f.region_id=r.id WHERE r.id=?",
        )
          .bind(target.region_id)
          .first<{
            id: string;
            bootstrap_material_revision: number;
            release_id: string | null;
            revision: number | null;
            rollout_json: string | null;
          }>();
        if (
          !row ||
          (row.revision ?? 0) !== target.expected_revision ||
          row.bootstrap_material_revision !== target.material_revision
        )
          return changed();
        if (
          row.rollout_json &&
          (
            await readFleetRollout(
              c.env,
              FleetRolloutIntent.parse(JSON.parse(row.rollout_json)).rollout_id,
            )
          ).state !== "complete"
        )
          return changed();
        const nodes = await c.env.DB.prepare(
          "SELECT n.id,n.node_uid,n.ready,n.last_observed_at,n.lost_at,a.node_uid assigned_uid,a.release_id,a.revision,a.role FROM nodes n LEFT JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.region_id=? AND n.lost_at IS NULL",
        )
          .bind(target.region_id)
          .all<{
            id: string;
            node_uid: string;
            ready: number;
            last_observed_at: string | null;
            lost_at: string | null;
            assigned_uid: string | null;
            release_id: string | null;
            revision: number | null;
            role: string | null;
          }>();
        if (nodes.results.length !== target.nodes.length) return changed();
        const revision =
          row.release_id === input.release_id
            ? target.expected_revision
            : target.expected_revision + 1;
        const members = target.nodes.map((node) => {
          const current = nodes.results.find(
              (member) => member.id === node.node_id,
            ),
            age = Date.parse(current?.last_observed_at ?? "");
          if (
            !current ||
            current.node_uid !== node.node_uid ||
            (current.revision ?? 0) !== node.expected_revision ||
            !current.ready ||
            !Number.isFinite(age) ||
            age < Date.now() - 180000 ||
            age > Date.now() + 5000
          )
            return changed();
          const same =
            current.assigned_uid === node.node_uid &&
            current.release_id === input.release_id &&
            current.role === node.role;
          return {
            ...node,
            assignment_revision:
              same && target.staged_material_revision === undefined
                ? node.expected_revision
                : node.expected_revision + 1,
          };
        });
        const region = {
          ...target,
          revision,
          current_material_revision: target.material_revision,
          nodes: members,
        };
        await assertCluster(c.env, region);
        for (const node of region.nodes) {
          const existing = await c.env.DB.prepare(
            "SELECT node_uid,revision,release_id,policy_json FROM node_compute_pool_policies WHERE node_id=?",
          )
            .bind(node.node_id)
            .first<{
              node_uid: string;
              revision: number;
              release_id: string;
              policy_json: string;
            }>();
          if (node.compute_pool) {
            const policy = ComputePoolPolicy.parse(node.compute_pool.policy),
              component = spec.components.find(
                (component) => component.name === "sandbox-controller",
              );
            if (
              (existing?.revision ?? 0) !==
                node.compute_pool.expected_revision ||
              (existing && existing.node_uid !== node.node_uid) ||
              !component ||
              component.kind !== "image" ||
              policy.profile.release_id !== intent.release_id ||
              policy.profile.image !== component.reference ||
              !policy.profile.image.endsWith("@sha256:" + component.sha256)
            )
              return changed();
          } else if (
            spec.roles[node.role].host_configuration_required &&
            (!existing ||
              existing.node_uid !== node.node_uid ||
              existing.release_id !== intent.release_id)
          )
            throw new ApiError(
              "conflict",
              "Target host configuration requires its release-pinned compute pool policy in the same request",
            );
        }
        snapshot.push({
          region_id: target.region_id,
          revision: row.revision ?? 0,
          rollout_json: row.rollout_json,
          material_revision: row.bootstrap_material_revision,
          nodes: target.nodes,
        });
        intent.regions.push(region);
      }
      const active = await c.env.DB.prepare(
        "SELECT 1 present FROM fleet_patch_operations WHERE region_id IN(SELECT json_extract(value,'$.region_id') FROM json_each(?)) AND stage<>'complete' AND NOT(stage='host_ready' AND state='confirmed') AND (release_id<>? OR NOT EXISTS(SELECT 1 FROM json_each(?) regions,json_each(regions.value,'$.nodes') members WHERE json_extract(members.value,'$.node_id')=fleet_patch_operations.node_id AND json_extract(members.value,'$.node_uid')=fleet_patch_operations.node_uid AND json_extract(members.value,'$.assignment_revision')=fleet_patch_operations.assignment_revision AND json_extract(regions.value,'$.revision')=fleet_patch_operations.region_revision)) LIMIT 1",
      )
        .bind(
          JSON.stringify(intent.regions),
          input.release_id,
          JSON.stringify(intent.regions),
        )
        .first();
      if (active) return changed();
      const raw = JSON.stringify(FleetRolloutIntent.parse(intent)),
        snapshotJson = JSON.stringify(snapshot),
        anchor = intent.regions[0]!;
      const guard = `NOT EXISTS(SELECT 1 FROM json_each(?) targets LEFT JOIN regions r ON r.id=json_extract(targets.value,'$.region_id') LEFT JOIN fleet_region_releases f ON f.region_id=r.id WHERE r.id IS NULL OR COALESCE(f.revision,0)<>json_extract(targets.value,'$.revision') OR f.rollout_json IS NOT json_extract(targets.value,'$.rollout_json') OR r.bootstrap_material_revision<>json_extract(targets.value,'$.material_revision') OR (SELECT count(*) FROM nodes WHERE region_id=r.id AND lost_at IS NULL)<>json_array_length(targets.value,'$.nodes')) AND NOT EXISTS(SELECT 1 FROM json_each(?) regions,json_each(regions.value,'$.nodes') members LEFT JOIN nodes n ON n.id=json_extract(members.value,'$.node_id') LEFT JOIN fleet_node_releases a ON a.node_id=n.id WHERE n.id IS NULL OR n.region_id<>json_extract(regions.value,'$.region_id') OR n.node_uid<>json_extract(members.value,'$.node_uid') OR n.lost_at IS NOT NULL OR n.ready<>1 OR julianday(n.last_observed_at)<julianday('now','-180 seconds') OR julianday(n.last_observed_at)>julianday('now','+5 seconds') OR n.last_observed_at IS NULL OR COALESCE(a.revision,0)<>json_extract(members.value,'$.expected_revision') OR (json_type(members.value,'$.compute_pool') IS NOT NULL AND COALESCE((SELECT revision FROM node_compute_pool_policies WHERE node_id=n.id),0)<>json_extract(members.value,'$.compute_pool.expected_revision'))) AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations p WHERE p.region_id IN(SELECT json_extract(value,'$.region_id') FROM json_each(?)) AND p.stage<>'complete' AND NOT(p.stage='host_ready' AND p.state='confirmed') AND (p.release_id<>? OR NOT EXISTS(SELECT 1 FROM json_each(?) regions,json_each(regions.value,'$.nodes') members WHERE json_extract(members.value,'$.node_id')=p.node_id AND json_extract(members.value,'$.node_uid')=p.node_uid AND json_extract(members.value,'$.assignment_revision')=p.assignment_revision AND json_extract(regions.value,'$.revision')=p.region_revision)))`;
      const owner =
        "EXISTS(SELECT 1 FROM fleet_region_releases WHERE region_id=? AND rollout_json=?)";
      const statements: D1PreparedStatement[] = [
        c.env.DB.prepare(
          `INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at,rollout_json) SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,revision=excluded.revision,updated_at=excluded.updated_at,rollout_json=excluded.rollout_json`,
        ).bind(
          anchor.region_id,
          intent.release_id,
          anchor.revision,
          intent.created_at,
          raw,
          snapshotJson,
          snapshotJson,
          JSON.stringify(intent.regions),
          intent.release_id,
          JSON.stringify(intent.regions),
        ),
      ];
      for (const region of intent.regions) {
        if (region !== anchor)
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at,rollout_json) SELECT ?,?,?,?,? WHERE ${owner} ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,revision=excluded.revision,updated_at=excluded.updated_at,rollout_json=excluded.rollout_json`,
            ).bind(
              region.region_id,
              intent.release_id,
              region.revision,
              intent.created_at,
              raw,
              anchor.region_id,
              raw,
            ),
          );
        for (const node of region.nodes) {
          if (node.compute_pool)
            statements.push(
              c.env.DB.prepare(
                `INSERT INTO node_compute_pool_policies(node_id,node_uid,revision,release_id,policy_json,updated_at) SELECT ?,?,?,?,?,? WHERE ${owner} ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,revision=excluded.revision,release_id=excluded.release_id,policy_json=excluded.policy_json,updated_at=excluded.updated_at`,
              ).bind(
                node.node_id,
                node.node_uid,
                node.compute_pool.expected_revision + 1,
                intent.release_id,
                JSON.stringify(
                  ComputePoolPolicy.parse(node.compute_pool.policy),
                ),
                intent.created_at,
                anchor.region_id,
                raw,
              ),
            );
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) SELECT ?,?,?,?,?,? WHERE ${owner} ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,release_id=excluded.release_id,role=excluded.role,revision=excluded.revision,updated_at=excluded.updated_at`,
            ).bind(
              node.node_id,
              node.node_uid,
              intent.release_id,
              node.role,
              node.assignment_revision,
              intent.created_at,
              anchor.region_id,
              raw,
            ),
          );
        }
      }
      statements.push(
        lease.completeStatement(intent.rollout_id, 202, {
          sql: owner,
          bindings: [anchor.region_id, raw],
        }),
      );
      const committed = await c.env.DB.batch(statements);
      if (committed[0]!.meta.changes !== 1) return changed();
      return output(intent.rollout_id);
    },
  });
}
