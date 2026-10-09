// SPDX-License-Identifier: Apache-2.0
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import { ThinStorageProfile } from "@pgcf/contracts/database-storage";
import { FleetRelease } from "@pgcf/contracts/releases";
import { NodePostjoinRelease } from "@pgcf/contracts/node-bootstrap";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  canonicalInstallation,
  installationHash,
} from "./node-installation.ts";
import {
  readFleetNodeRelease,
  readFleetRegionRelease,
} from "./fleet-releases.ts";
import {
  admissionAuthority,
  bootstrapJobInput,
  readBootstrapJob,
} from "./bootstrap-jobs.ts";
import { readRegionBootstrapMaterial } from "./region-material-revisions.ts";
import { ensurePendingNodeHostConfiguration } from "./node-host-configuration.ts";

const refuse = (): never => {
  throw new ApiError(
    "conflict",
    "Future node requires the selected approved common release and compute template",
  );
};
/** Public standing selection. The original Factory disk intent remains unchanged. */
export async function readNodePostjoinRelease(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  regionId: string,
  expected?: NodePostjoinRelease,
  pendingNodeId?: string,
) {
  const db = env.DB,
    region = await readFleetRegionRelease(db, regionId),
    row = await db
      .prepare(
        "SELECT compute_pool_json,thin_storage_json FROM node_region_policies WHERE region_id=?",
      )
      .bind(regionId)
      .first<{
        compute_pool_json: string | null;
        thin_storage_json: string | null;
      }>();
  if (
    !region.desired_release_id ||
    !row?.compute_pool_json ||
    !row.thin_storage_json
  )
    return refuse();
  const policy = ComputePoolPolicy.parse(JSON.parse(row.compute_pool_json)),
    storage = ThinStorageProfile.parse(JSON.parse(row.thin_storage_json)),
    source = await db
      .prepare(
        "SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE id=?",
      )
      .bind(region.desired_release_id)
      .first<{
        id: string;
        spec_json: string;
        spec_sha256: string;
        approved_at: string;
      }>();
  if (!source) return refuse();
  const release = FleetRelease.parse({
      id: source.id,
      spec_sha256: source.spec_sha256,
      approved_at: source.approved_at,
      spec: JSON.parse(source.spec_json),
    }),
    role = release.spec.roles.customer,
    component = release.spec.components.find(
      (value) => value.name === "sandbox-controller",
    ),
    extension = release.spec.components.find(
      (value) => value.name === "pgcf-sandbox-controller",
    ),
    recipe = release.spec.components.find(
      (value) => value.name === "schematic",
    ),
    driver = release.spec.components.find(
      (value) => value.name === "openebs-lvm",
    ),
    qualification = release.spec.thin_storage_qualification,
    storageHash = await installationHash(storage);
  if (
    (await installationHash(release.spec)) !== release.spec_sha256 ||
    policy.profile.release_id !== release.id ||
    !component ||
    component.kind !== "image" ||
    component.reference !== policy.profile.image ||
    !role.host_configuration_required ||
    !extension ||
    !recipe ||
    !role.talos_extensions.includes(extension.name) ||
    !role.talos_extensions.includes(recipe.name) ||
    recipe.version !== role.talos_schematic_sha256 ||
    extension.kind !== "image" ||
    recipe.kind !== "image" ||
    !driver ||
    driver.kind !== "image" ||
    driver.reference !== storage.driver_image ||
    !qualification ||
    qualification.profile_sha256 !== storageHash ||
    qualification.driver_image !== storage.driver_image ||
    qualification.host_extension_image !== extension.reference ||
    Date.parse(qualification.qualified_at) > Date.now() + 5000
  )
    return refuse();
  const members = await db
    .prepare(
      "SELECT id FROM nodes WHERE region_id=? AND lost_at IS NULL AND (? IS NULL OR id<>?)",
    )
    .bind(regionId, pendingNodeId ?? null, pendingNodeId ?? null)
    .all<{ id: string }>();
  if (members.results.length) {
    const material = await readRegionBootstrapMaterial(env, regionId);
    if (
      material.talos_version?.replace(/^v/, "") !==
        role.talos_version.replace(/^v/, "") ||
      material.kubernetes_version.replace(/^v/, "") !==
        role.kubernetes_version.replace(/^v/, "")
    )
      return refuse();
    for (const member of members.results) {
      const status = await readFleetNodeRelease(db, member.id);
      if (
        status.state !== "converged" ||
        status.desired_release_id !== release.id ||
        status.desired_spec_sha256 !== release.spec_sha256
      )
        return refuse();
    }
  }
  const reference = NodePostjoinRelease.parse({
    version: 1,
    release_id: release.id,
    spec_sha256: release.spec_sha256,
    region_revision: region.revision,
    recipe_sha256: role.talos_schematic_sha256,
    pool_template_sha256: await installationHash(policy),
    storage_template_sha256: storageHash,
  });
  if (
    expected &&
    canonicalInstallation(reference) !== canonicalInstallation(expected)
  )
    return refuse();
  return { reference, policy, storage, release };
}

/** New physical UID only: seed existing runtime authority after actual quarantined join. */
export async function prepareNodePostjoinRuntime(
  env: Env,
  operationId: string,
) {
  const job = await readBootstrapJob(env.DB, operationId),
    input = await bootstrapJobInput(env, job),
    expected = input.spec.postjoin_release;
  if (!expected) return refuse();
  const selected = await readNodePostjoinRelease(
      env,
      job.region_id,
      expected,
      job.node_id,
    ),
    pending = await admissionAuthority(env, job, {
      requirePostjoinRelease: false,
    }),
    binding = pending.admission_binding;
  if (!binding || !pending.admission_authorized) return refuse();
  const now = new Date().toISOString(),
    policyJson = JSON.stringify(selected.policy);
  const predicate = `EXISTS(SELECT 1 FROM node_bootstrap_jobs j JOIN node_additions a ON a.operation_id=j.operation_id
    JOIN nodes n ON n.id=j.node_id JOIN fleet_region_releases f ON f.region_id=j.region_id
    JOIN node_region_policies p ON p.region_id=j.region_id WHERE j.operation_id=? AND j.input_hash=? AND j.revision=?
    AND j.authorized=1 AND j.admitted=0 AND j.cancelled=0 AND j.admission_authorized=1
    AND a.status='bootstrapping' AND n.node_uid=? AND n.ready=1 AND n.schedulable=0 AND n.lost_at IS NULL
    AND f.release_id=? AND f.revision=? AND p.compute_pool_json=?)`;
  // Canonical policy bytes are the API-persisted template; a concurrent change defeats both inserts.
  const template = await env.DB.prepare(
    "SELECT compute_pool_json FROM node_region_policies WHERE region_id=?",
  )
    .bind(job.region_id)
    .first<{ compute_pool_json: string }>();
  if (
    !template ||
    (await installationHash(JSON.parse(template.compute_pool_json))) !==
      expected.pool_template_sha256
  )
    return refuse();
  const bindings = [
    operationId,
    job.input_hash,
    job.revision,
    binding.node_uid,
    expected.release_id,
    expected.region_revision,
    template.compute_pool_json,
  ];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at)
      SELECT ?,?,?,'customer',1,? WHERE ${predicate} ON CONFLICT(node_id) DO NOTHING`,
    ).bind(
      job.node_id,
      binding.node_uid,
      expected.release_id,
      now,
      ...bindings,
    ),
    env.DB.prepare(
      `INSERT INTO node_compute_pool_policies(node_id,node_uid,revision,release_id,policy_json,updated_at)
      SELECT ?,?,1,?,?,? WHERE ${predicate} ON CONFLICT(node_id) DO NOTHING`,
    ).bind(
      job.node_id,
      binding.node_uid,
      expected.release_id,
      policyJson,
      now,
      ...bindings,
    ),
  ]);
  const actual = await env.DB.prepare(
    `SELECT a.node_uid,a.release_id,a.role,p.policy_json FROM fleet_node_releases a
    JOIN node_compute_pool_policies p ON p.node_id=a.node_id AND p.node_uid=a.node_uid AND p.release_id=a.release_id WHERE a.node_id=?`,
  )
    .bind(job.node_id)
    .first<{
      node_uid: string;
      release_id: string;
      role: string;
      policy_json: string;
    }>();
  if (
    !actual ||
    actual.node_uid !== binding.node_uid ||
    actual.release_id !== expected.release_id ||
    actual.role !== "customer" ||
    (await installationHash(JSON.parse(actual.policy_json))) !==
      expected.pool_template_sha256
  )
    return refuse();
  await readNodePostjoinRelease(env, job.region_id, expected, job.node_id);
  return ensurePendingNodeHostConfiguration(env, operationId);
}
