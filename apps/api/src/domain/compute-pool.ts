// SPDX-License-Identifier: Apache-2.0
import {
  ComputePoolPolicy,
  ComputePoolPolicyState,
  ComputePoolLease,
  ComputePoolObservation,
  type ComputePoolPolicyUpdate,
} from "@pgcf/contracts/compute-pool";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { agentRegion } from "./agent-auth.ts";
import { hashApiKey } from "@pgcf/contracts";

interface PoolRow {
  node_id: string;
  node_uid: string;
  region_id: string;
  revision: number;
  release_id: string;
  policy_json: string;
  updated_at: string;
}
async function state(db: D1Database, id: string) {
  const row = await db
    .prepare(
      "SELECT p.*,n.region_id FROM node_compute_pool_policies p JOIN nodes n ON n.id=p.node_id WHERE p.node_id=?",
    )
    .bind(id)
    .first<PoolRow>();
  if (!row)
    throw new ApiError("not_found", "Compute pool policy not configured");
  return ComputePoolPolicyState.parse({
    node_id: row.node_id,
    node_uid: row.node_uid,
    region_id: row.region_id,
    revision: row.revision,
    policy: JSON.parse(row.policy_json),
    updated_at: row.updated_at,
  });
}
export async function getComputePoolPolicy(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  return c.json(await state(c.env.DB, id));
}
export async function setComputePoolPolicy(
  c: ApiContext,
  id: string,
  body: ComputePoolPolicyUpdate,
) {
  await requireScope(c, "admin");
  const policy = ComputePoolPolicy.parse(body.policy),
    release = await c.env.DB.prepare(
      "SELECT spec_json FROM fleet_releases WHERE id=?",
    )
      .bind(policy.profile.release_id)
      .first<{ spec_json: string }>();
  if (!release)
    throw new ApiError(
      "conflict",
      "Compute runtime requires an approved fleet release",
    );
  const spec = FleetReleaseSpec.parse(JSON.parse(release.spec_json)),
    component = spec.components.find(
      (value) => value.name === "sandbox-controller",
    );
  if (
    !component ||
    component.kind !== "image" ||
    component.reference !== policy.profile.image ||
    !policy.profile.image.endsWith("@sha256:" + component.sha256)
  )
    throw new ApiError(
      "conflict",
      "Compute runtime differs from the approved fleet component",
    );
  return withIdempotency(c, {
    replay: () => getComputePoolPolicy(c, id),
    execute: async (lease) => {
      const now = new Date().toISOString(),
        serialized = JSON.stringify(policy),
        next = body.expected_revision + 1;
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO node_compute_pool_policies(node_id,node_uid,revision,release_id,policy_json,updated_at)
          SELECT id,node_uid,?,?,?,? FROM nodes WHERE id=? AND node_uid=? AND ready=1 AND lost_at IS NULL
          AND julianday(last_observed_at)>=julianday('now','-180 seconds') AND julianday(last_observed_at)<=julianday('now','+5 seconds') AND ?=0
          ON CONFLICT(node_id) DO NOTHING`,
        ).bind(
          next,
          policy.profile.release_id,
          serialized,
          now,
          id,
          body.node_uid,
          body.expected_revision,
        ),
        c.env.DB.prepare(
          `UPDATE node_compute_pool_policies SET revision=?,release_id=?,policy_json=?,updated_at=? WHERE node_id=? AND node_uid=? AND revision=? AND ?>0
          AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=node_id AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds'))`,
        ).bind(
          next,
          policy.profile.release_id,
          serialized,
          now,
          id,
          body.node_uid,
          body.expected_revision,
          body.expected_revision,
          body.node_uid,
        ),
        lease.completeStatement(id, 200, {
          sql: "EXISTS(SELECT 1 FROM node_compute_pool_policies WHERE node_id=? AND node_uid=? AND revision=? AND policy_json=?)",
          bindings: [id, body.node_uid, next, serialized],
        }),
      ]);
      if (results[0]!.meta.changes + results[1]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Compute pool revision or current physical node changed",
        );
      return getComputePoolPolicy(c, id);
    },
  });
}
async function currentLease(c: ApiContext, id: string) {
  const region = await agentRegion(c),
    now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT p.*,n.region_id,n.last_observed_at,r.bootstrap_material_revision,
    a.revision assignment_revision,f.revision region_revision FROM node_compute_pool_policies p
    JOIN nodes n ON n.id=p.node_id AND n.node_uid=p.node_uid JOIN regions r ON r.id=n.region_id
    JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid AND a.release_id=p.release_id
    JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=p.release_id
    WHERE n.id=? AND n.region_id=? AND n.ready=1 AND n.lost_at IS NULL
    AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')`,
  )
    .bind(id, region.id)
    .first<
      PoolRow & {
        last_observed_at: string;
        bootstrap_material_revision: number;
        assignment_revision: number;
        region_revision: number;
      }
    >();
  if (!row)
    throw new ApiError(
      "not_found",
      "Current compute pool authority unavailable",
    );
  return ComputePoolLease.parse({
    purpose: "pgcf-compute-pool/v1",
    node_id: row.node_id,
    node_uid: row.node_uid,
    region_id: row.region_id,
    revision: row.revision,
    policy: JSON.parse(row.policy_json),
    updated_at: row.updated_at,
    material_revision: row.bootstrap_material_revision,
    assignment_revision: row.assignment_revision,
    region_revision: row.region_revision,
    node_observed_at: row.last_observed_at,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30000).toISOString(),
  });
}
export async function getComputePoolLease(c: ApiContext, id: string) {
  return c.json(await currentLease(c, id));
}
export async function reportComputePool(
  c: ApiContext,
  id: string,
  raw: ComputePoolObservation,
) {
  const observation = ComputePoolObservation.parse(raw),
    lease = await currentLease(c, id),
    now = Date.now();
  if (
    observation.node_id !== id ||
    observation.node_uid !== lease.node_uid ||
    observation.policy_revision !== lease.revision ||
    observation.material_revision !== lease.material_revision ||
    JSON.stringify(observation.profile) !==
      JSON.stringify(lease.policy.profile) ||
    Date.parse(observation.observed_at) < now - 120000 ||
    Date.parse(observation.observed_at) > now + 5000
  )
    throw new ApiError(
      "conflict",
      "Compute observation identity or authority changed",
    );
  const updated = await c.env.DB.prepare(
    `INSERT INTO node_compute_pool_observations(node_id,node_uid,policy_revision,material_revision,observation_json,observed_at,received_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN node_compute_pool_policies p ON p.node_id=n.id
      JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid AND a.release_id=p.release_id
      JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=p.release_id
      WHERE n.id=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND p.node_uid=n.node_uid AND p.revision=? AND r.bootstrap_material_revision=?
      AND a.revision=? AND f.revision=? AND r.agent_key_hash=?
      AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds'))
    ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,policy_revision=excluded.policy_revision,material_revision=excluded.material_revision,observation_json=excluded.observation_json,observed_at=excluded.observed_at,received_at=excluded.received_at
    WHERE excluded.observed_at>node_compute_pool_observations.observed_at`,
  )
    .bind(
      id,
      lease.node_uid,
      lease.revision,
      lease.material_revision,
      JSON.stringify(observation),
      observation.observed_at,
      new Date(now).toISOString(),
      id,
      lease.node_uid,
      lease.revision,
      lease.material_revision,
      lease.assignment_revision,
      lease.region_revision,
      await hashApiKey(
        c.env.API_KEY_PEPPER,
        c.req.header("Authorization")!.slice(7),
      ),
    )
    .run();
  if (updated.meta.changes !== 1)
    throw new ApiError("conflict", "Compute observation changed concurrently");
  return c.json({ accepted: true });
}
export async function getComputePoolObservations(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  const policy = await state(c.env.DB, id);
  const row = await c.env.DB.prepare(
    `SELECT o.observation_json,o.observed_at FROM node_compute_pool_observations o JOIN nodes n ON n.id=o.node_id AND n.node_uid=o.node_uid
    JOIN node_compute_pool_policies p ON p.node_id=n.id AND p.node_uid=n.node_uid AND p.revision=o.policy_revision
    JOIN regions r ON r.id=n.region_id AND r.bootstrap_material_revision=o.material_revision WHERE n.id=? AND n.lost_at IS NULL`,
  )
    .bind(id)
    .first<{ observation_json: string; observed_at: string }>();
  return c.json({
    policy,
    observation: row
      ? ComputePoolObservation.parse(JSON.parse(row.observation_json))
      : null,
    freshness: row
      ? Date.parse(row.observed_at) >= Date.now() - 120000
        ? "current"
        : "stale"
      : "missing",
  });
}
