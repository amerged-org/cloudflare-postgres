// SPDX-License-Identifier: Apache-2.0
// What a fleet rollout commits for a thin node, as controlled D1 metadata: the next release, the
// next region and assignment revision and the next pool policy in one batch (createFleetRollout),
// and later the patch of that assignment rewriting the node's host custody. No live evidence.
import { env } from "cloudflare:workers";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import type { Fixture } from "./thin-renewal-fixture.ts";

type Change = (spec: FleetReleaseSpec) => FleetReleaseSpec;
const digest = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
const repin = (reference: string, sha: string) =>
  reference.replace(/@sha256:[0-9a-f]{64}$/, `@sha256:${sha}`);
/** New digests for the named components, nothing else. */
function repinned(spec: FleetReleaseSpec, names: string[]) {
  const sha = digest();
  return {
    ...spec,
    components: spec.components.map((component) =>
      names.includes(component.name)
        ? {
            ...component,
            reference: repin(component.reference, sha),
            sha256: sha,
          }
        : component,
    ),
  };
}
/** A release of the controller, the gateway and the API only: no pinned thin fact moves. */
export const software: Change = (spec) =>
  FleetReleaseSpec.parse(
    repinned(spec, ["native-controller", "native-gateway", "api"]),
  );
/** The same release with its components listed in the opposite order. */
export const reordered: Change = (spec) => {
  const next = software(spec);
  return FleetReleaseSpec.parse({
    ...next,
    components: [...next.components].reverse(),
  });
};
/** Another sandbox runtime image: the host custody of the node names it. */
export const runtime: Change = (spec) =>
  FleetReleaseSpec.parse(repinned(spec, ["sandbox-controller"]));
/** Another Kubernetes version for both roles. */
export const kubernetes: Change = (spec) =>
  FleetReleaseSpec.parse({
    ...spec,
    roles: Object.fromEntries(
      Object.entries(spec.roles).map(([name, role]) => [
        name,
        { ...role, kubernetes_version: "1.36.6" },
      ]),
    ),
  });
/** Another host extension: the receipt of the release names it too. */
export const extension: Change = (spec) => {
  const next = repinned(spec, ["pgcf-sandbox-controller"]),
    image = next.components.find(
      (component) => component.name === "pgcf-sandbox-controller",
    )!.reference;
  return FleetReleaseSpec.parse({
    ...next,
    thin_storage_qualification: {
      ...spec.thin_storage_qualification!,
      host_extension_image: image,
    },
  });
};
/** Another Talos installer for both roles; the receipt is the same. */
export const installer: Change = (spec) =>
  FleetReleaseSpec.parse({
    ...spec,
    roles: Object.fromEntries(
      Object.entries(spec.roles).map(([name, role]) => [
        name,
        {
          ...role,
          talos_installer: repin(role.talos_installer, digest()),
        },
      ]),
    ),
  });
/** Another PostgreSQL version of the same image. */
export const postgres: Change = (spec) =>
  FleetReleaseSpec.parse({
    ...spec,
    components: spec.components.map((component) =>
      component.name === "postgres"
        ? { ...component, version: "18.7" }
        : component,
    ),
  });

/** Inserts a release the fixture deletes after the test. */
export async function insertRelease(
  releases: string[],
  spec: FleetReleaseSpec,
  id = `rollout-${crypto.randomUUID()}`,
) {
  const sha = await installationHash(spec);
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
  )
    .bind(id, JSON.stringify(spec), sha, new Date().toISOString())
    .run();
  releases.push(id);
  return { id, sha };
}

export type Assigned = {
  id: string;
  sha: string;
  assignment: number;
  region: number;
};
export interface PatchState {
  stage: string;
  state: "pending" | "halted" | "confirmed";
  error?: string;
}
/** The node's own patch of its current assignment, as `createFleetPatch` and the pipeline leave it. */
export async function startPatch(
  f: Fixture,
  assigned: Assigned,
  { stage, state, error }: PatchState,
) {
  const host = await ensureNodeHostConfiguration(f.local, {
      node_id: f.node,
      node_uid: f.uid,
    }),
    now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,observed_json,host_configuration_revision,host_configuration_sha256,error_code,created_at,updated_at,deadline_at)
    SELECT ?,node_id,region_id,node_uid,cluster_uid,?,?,?,?,material_revision,address,cluster_nodes_json,1,?,?,
      CASE WHEN ?='complete' THEN json_set(observed_json,'$.host_configuration_sha256',?,'$.runtime_admission_sha256',?) END,
      ?,?,?,?,?,? FROM fleet_patch_operations WHERE node_id=? AND stage='complete' AND state='confirmed' ORDER BY updated_at DESC,rowid DESC LIMIT 1`,
  )
    .bind(
      newOperationId(),
      assigned.id,
      assigned.sha,
      assigned.assignment,
      assigned.region,
      stage,
      state,
      stage,
      host.sha256,
      host.profile_sha256,
      host.revision,
      host.sha256,
      error ?? null,
      now,
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
      f.node,
    )
    .run();
  return host;
}

/**
 * The region's release, the node's assignment and its pool policy move to one release in one
 * batch, as `createFleetRollout` commits them. `patch` adds the node's own patch of that
 * assignment, which rewrites the node's host custody the way patch creation does.
 */
export async function assignRelease(
  f: Fixture,
  releases: string[],
  options: {
    change?: Change;
    /** An existing release: a rollback. */
    release?: string;
    /** The pool policy of the release names its sandbox runtime image, as the rollout request does. */
    runtime?: boolean;
    patch?: PatchState;
  } = {},
): Promise<Assigned> {
  const release = options.release
    ? (await env.DB.prepare(
        "SELECT id,spec_sha256 sha,spec_json FROM fleet_releases WHERE id=?",
      )
        .bind(options.release)
        .first<{ id: string; sha: string; spec_json: string }>())!
    : await insertRelease(
        releases,
        (options.change ?? software)(f.qualified.spec),
      );
  const policy = ComputePoolPolicy.parse(
      JSON.parse(
        (await env.DB.prepare(
          "SELECT policy_json FROM node_compute_pool_policies WHERE node_id=?",
        )
          .bind(f.node)
          .first<string>("policy_json"))!,
      ),
    ),
    image = options.runtime
      ? (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
          .bind(release.id)
          .first<string>("spec_json"))!
      : null,
    at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=?,revision=revision+1,updated_at=? WHERE region_id=?",
    ).bind(release.id, at, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=?,revision=revision+1,updated_at=? WHERE node_id IN(SELECT id FROM nodes WHERE region_id=? AND lost_at IS NULL)",
    ).bind(release.id, at, f.region),
    env.DB.prepare(
      "UPDATE node_compute_pool_policies SET release_id=?,revision=revision+1,policy_json=?,updated_at=? WHERE node_id=?",
    ).bind(
      release.id,
      JSON.stringify({
        ...policy,
        profile: {
          ...policy.profile,
          release_id: release.id,
          ...(image
            ? {
                image: FleetReleaseSpec.parse(
                  JSON.parse(image),
                ).components.find(
                  (component) => component.name === "sandbox-controller",
                )!.reference,
              }
            : {}),
        },
      }),
      at,
      f.node,
    ),
  ]);
  const assigned = {
    id: release.id,
    sha: release.sha,
    assignment: (await env.DB.prepare(
      "SELECT revision FROM fleet_node_releases WHERE node_id=?",
    )
      .bind(f.node)
      .first<number>("revision"))!,
    region: (await env.DB.prepare(
      "SELECT revision FROM fleet_region_releases WHERE region_id=?",
    )
      .bind(f.region)
      .first<number>("revision"))!,
  };
  if (options.patch) await startPatch(f, assigned, options.patch);
  return assigned;
}

/** The controller pulled the assignment and reported it: the node's observation names its revision. */
export async function observeAssignment(f: Fixture) {
  const at = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET assignment_revision=(SELECT revision FROM fleet_node_releases WHERE node_id=?1),observed_at=?2,received_at=?2 WHERE node_id=?1",
  )
    .bind(f.node, at)
    .run();
}

/** Another physical member of the node's region, patched to `release` as a whole. */
export async function addMember(
  f: Fixture,
  release: { id: string; sha: string },
) {
  const id = newNodeId(),
    uid = crypto.randomUUID(),
    at = new Date().toISOString(),
    revision = (await env.DB.prepare(
      "SELECT revision FROM fleet_region_releases WHERE region_id=?",
    )
      .bind(f.region)
      .first<number>("revision"))!;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid) VALUES (?,?,?,1,4096,2000,30,128,100,?,?,?,?)",
    ).bind(id, f.region, `member-${id.replaceAll("_", "-")}`, at, at, at, uid),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'control_relay',1,?)",
    ).bind(
      id,
      uid,
      await env.DB.prepare(
        "SELECT release_id FROM fleet_region_releases WHERE region_id=?",
      )
        .bind(f.region)
        .first<string>("release_id"),
      at,
    ),
  ]);
  await completePatch(f, id, uid, release, 1, revision);
  return { id, uid };
}

/** A patch of `release` for any member, later than every earlier one: confirmed `complete` unless said. */
export async function completePatch(
  f: Fixture,
  nodeId: string,
  nodeUid: string,
  release: { id: string; sha: string },
  assignment: number,
  region: number,
  { stage, state, error }: PatchState = {
    stage: "complete",
    state: "confirmed",
  },
) {
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,error_code,created_at,updated_at,deadline_at)
    SELECT ?,?,region_id,?,cluster_uid,?,?,?,?,material_revision,address,cluster_nodes_json,1,?,?,?,?,?,? FROM fleet_patch_operations WHERE node_id=? LIMIT 1`,
  )
    .bind(
      newOperationId(),
      nodeId,
      nodeUid,
      release.id,
      release.sha,
      assignment,
      region,
      stage,
      state,
      error ?? null,
      at,
      at,
      new Date(Date.now() + 3_600_000).toISOString(),
      f.node,
    )
    .run();
}
