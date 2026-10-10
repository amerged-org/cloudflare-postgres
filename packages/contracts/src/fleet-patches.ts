// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId, DatabaseId } from "./ids.ts";
import {
  ComputePoolPolicyState,
  ComputePoolObservation,
} from "./compute-pool.ts";
import { LegacyStorageBindings } from "./storage-write-authority.ts";
import { NodeHostConfigurationPrivate } from "./node-host-configuration.ts";
import { FleetRegionMaterialRotationInput } from "./region-material-rotation.ts";
import {
  FleetReleaseId,
  FleetReleaseSpec,
  FleetReleaseFacts,
  FleetKubernetesImageFacts,
} from "./releases.ts";

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
/** One bounded Native turn may collect a checkpoint proof; original observation times stay intact. */
export const FLEET_PATCH_PROOF_MAX_AGE_MS = 600_000;
export const FleetPatchRequest = z.strictObject({
  node_uid: z.uuid(),
  assignment_revision: z.number().int().positive(),
  release_id: FleetReleaseId,
  address: z.ipv4(),
  maintenance_acknowledged: z.literal(true),
});
export type FleetPatchRequest = z.infer<typeof FleetPatchRequest>;
export const FleetPatchFacts = z.strictObject({
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  system_uuid: z.uuid(),
  boot_id: z.uuid(),
  talos_version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  talos_schematic_sha256: Hash,
  kubelet_version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  kubernetes_version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  node_ready: z.boolean(),
  databases_ready: z.boolean(),
  cluster_nodes: z
    .array(
      z.strictObject({
        node_uid: z.uuid(),
        kubelet_version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
        node_ready: z.boolean(),
      }),
    )
    .min(1)
    .max(1000),
  observed_at: z.iso.datetime(),
  platform_resource_uids: z
    .record(z.string().min(1).max(512), z.uuid())
    .optional(),
  release_facts: FleetReleaseFacts.optional(),
  host_configuration_sha256: Hash.optional(),
  sandbox_service_running: z.boolean().optional(),
  kubernetes_control_plane: z.boolean().optional(),
  kubernetes_image_configuration: z
    .strictObject({
      kubelet: z.string().max(512),
      apiServer: z.string().max(512).optional(),
      controllerManager: z.string().max(512).optional(),
      scheduler: z.string().max(512).optional(),
    })
    .optional(),
  kubernetes_configuration_boot_id: z.uuid().optional(),
  kubernetes_configuration_observed_at: z.iso.datetime().optional(),
  kubernetes_images: FleetKubernetesImageFacts.optional(),
  legacy_storage_bindings: LegacyStorageBindings.optional(),
  runtime_admission_sha256: Hash.optional(),
  runtime_admission_policy_revision: z.number().int().positive().optional(),
});
export type FleetPatchFacts = z.infer<typeof FleetPatchFacts>;
export const FleetTalosUpgradeReceipt = z.strictObject({
  method: z.literal("deploymentreceipt"),
  installer: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  system_uuid: z.uuid(),
  pre_reboot_boot_id: z.uuid(),
  completed_at: z.iso.datetime(),
  source: z.enum(["cli_exit_0", "lifecycle_log_exit_0"]),
});
export type FleetTalosUpgradeReceipt = z.infer<typeof FleetTalosUpgradeReceipt>;
export const FLEET_PATCH_STAGES = [
  "preflight",
  "host_config",
  "host_service",
  "kubernetes",
  "kubernetes_images",
  "talos",
  "talos_reboot",
  "verify",
  "runtime_verified",
  "flux",
  "platform",
  "regional",
  "runtime_admission",
  "postgres",
  "release_verify",
  "complete",
] as const;
export const FleetPostgresPatchProgress = z.strictObject({
  total: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  deferred_cold: z.number().int().nonnegative(),
  queued_unassigned: z.number().int().nonnegative(),
  queued_pending: z.number().int().nonnegative(),
  errors: z
    .array(z.strictObject({ database_id: z.string(), code: z.string() }))
    .max(1000),
});
export const FleetPatchStatus = z.strictObject({
  operation_id: OperationId,
  bootstrap_operation_id: OperationId.nullable().default(null),
  finalization_of: OperationId.nullable().default(null),
  node_id: NodeId,
  region_id: RegionId,
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  release_id: FleetReleaseId,
  spec_sha256: Hash,
  assignment_revision: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  stage: z.enum([
    "preflight",
    "host_config",
    "host_service",
    "kubernetes",
    "kubernetes_images",
    "talos",
    "talos_reboot",
    "verify",
    "runtime_verified",
    "flux",
    "platform",
    "regional",
    "runtime_admission",
    "postgres",
    "release_verify",
    "complete",
    "host_ready",
  ]),
  state: z.enum(["pending", "dispatched", "confirmed", "halted"]),
  baseline: FleetPatchFacts.nullable(),
  observed: FleetPatchFacts.nullable(),
  talos_upgrade_receipt: FleetTalosUpgradeReceipt.nullable().default(null),
  postgres_progress: FleetPostgresPatchProgress.nullable().default(null),
  host_configuration_revision: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null),
  host_configuration_sha256: Hash.nullable().default(null),
  error_code: z
    .string()
    .regex(/^[a-z0-9_]{1,100}$/)
    .nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  deadline_at: z.iso.datetime(),
});
export type FleetPatchStatus = z.infer<typeof FleetPatchStatus>;
export const FleetPatchCheckpoint = z.strictObject({
  expected_revision: z.number().int().nonnegative(),
  stage: FleetPatchStatus.shape.stage,
  state: FleetPatchStatus.shape.state,
  facts: FleetPatchFacts,
  error_code: FleetPatchStatus.shape.error_code,
  talos_upgrade_receipt: FleetTalosUpgradeReceipt.nullable().optional(),
  postgres_progress: FleetPostgresPatchProgress.optional(),
});
export type FleetPatchCheckpoint = z.infer<typeof FleetPatchCheckpoint>;
export const FleetPatchInput = z.strictObject({
  status: FleetPatchStatus,
  role: z.enum(["control_relay", "customer"]),
  spec: FleetReleaseSpec,
  address: z.ipv4(),
  k8s_node_name: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
    .max(253),
  cluster_endpoint: z.url(),
  cluster_nodes: z
    .array(
      z.strictObject({
        node_id: NodeId,
        node_uid: z.uuid(),
        k8s_node_name: z.string().min(1).max(253),
        assignment_revision: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(1000),
  talos_admin_config: z
    .string()
    .min(1)
    .max(256 * 1024),
  kubeconfig: z
    .string()
    .min(1)
    .max(256 * 1024),
  authority_rotation: FleetRegionMaterialRotationInput.optional(),
  storage_authority: z
    .strictObject({
      keys: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)),
      sha256: Hash,
    })
    .optional(),
  host_configuration: NodeHostConfigurationPrivate.optional(),
  compute_pool: ComputePoolPolicyState.optional(),
  compute_pool_observation: ComputePoolObservation.optional(),
  regional_hosts_ready: z.boolean().default(false),
  host_configuration_only: z.boolean().default(false),
  initial_bootstrap_input_sha256: Hash.optional(),
  retained_thick_storage: z
    .array(
      z.strictObject({
        database_id: DatabaseId,
        node_id: NodeId,
        node_uid: z.uuid(),
        k8s_node_name: z.string().min(1).max(253),
        storage_generation: z.number().int().positive(),
        archive_path: z.string().min(1).max(1024),
      }),
    )
    .max(2000)
    .refine(
      (values) =>
        new Set(values.map((value) => value.database_id)).size ===
        values.length,
    )
    .optional(),
  retained_talos_installation: z
    .strictObject({
      receipt: FleetTalosUpgradeReceipt,
      boot_id: z.uuid(),
      talos_version: FleetPatchFacts.shape.talos_version,
      talos_schematic_sha256: Hash,
      kubernetes_image_provenance:
        FleetReleaseFacts.shape.kubernetes_image_provenance,
    })
    .optional(),
  callback: z.strictObject({
    url: z.url(),
    bearer: z.string().min(32).max(128),
  }),
});
export type FleetPatchInput = z.infer<typeof FleetPatchInput>;

/** Fresh CF pool observation proves the host service consumed the sealed current binding. */
export function fleetPatchHostServiceObserved(
  input: FleetPatchInput,
  now = Date.now(),
): boolean {
  const pool = input.compute_pool,
    seen = input.compute_pool_observation,
    host = input.host_configuration?.status;
  return (
    !!pool &&
    !!seen &&
    !!host &&
    seen.node_id === input.status.node_id &&
    seen.node_uid === input.status.node_uid &&
    seen.policy_revision === pool.revision &&
    seen.material_revision === host.material_revision &&
    JSON.stringify(seen.profile) === JSON.stringify(pool.policy.profile) &&
    Date.parse(seen.observed_at) >= Date.parse(host.created_at) &&
    Date.parse(seen.observed_at) >= now - 120000 &&
    Date.parse(seen.observed_at) <= now + 5000
  );
}
const version = (value: string) => value.replace(/^v/, "");
export function supportedFleetPatchVersion(
  current: string,
  target: string,
): boolean {
  const a = version(current).split(".").map(Number),
    b = version(target).split(".").map(Number);
  return (
    a.length === 3 &&
    b.length === 3 &&
    a.every(Number.isSafeInteger) &&
    b.every(Number.isSafeInteger) &&
    a[0] === b[0] &&
    a[1] === b[1] &&
    b[2]! >= a[2]!
  );
}
export function fleetPatchRuntimeMatches(
  input: Pick<FleetPatchInput, "spec" | "role" | "cluster_nodes">,
  facts: FleetPatchFacts,
): { talos: boolean; kubernetes: boolean } {
  const role = input.spec.roles[input.role];
  return {
    talos:
      version(facts.talos_version) === version(role.talos_version) &&
      facts.talos_schematic_sha256 === role.talos_schematic_sha256,
    kubernetes:
      version(facts.kubernetes_version) === version(role.kubernetes_version) &&
      version(facts.kubelet_version) === version(role.kubernetes_version) &&
      facts.cluster_nodes.length === input.cluster_nodes.length &&
      input.cluster_nodes.every((expected) =>
        facts.cluster_nodes.some(
          (actual) =>
            actual.node_uid === expected.node_uid &&
            version(actual.kubelet_version) ===
              version(role.kubernetes_version),
        ),
      ),
  };
}
/** Unknown dispatched writes have no transition back to pending and cannot be inferred absent from an unchanged boot/version. */
export function fleetPatchStageComponents(
  input: Pick<FleetPatchInput, "spec" | "role">,
  stage: string,
): string[] {
  const wanted = new Set(input.spec.roles[input.role].components);
  return input.spec.components
    .filter(
      (v) =>
        wanted.has(v.name) &&
        (stage === "flux"
          ? v.name.startsWith("flux-")
          : stage === "platform"
            ? v.kind === "chart" || v.name.startsWith("image/")
            : stage === "regional"
              ? [
                  "regional",
                  "native-controller",
                  "native-gateway",
                  "native-bootstrap-relay",
                  "node-reclaimer",
                  "cloudflared",
                  "bootstrap-relay",
                ].includes(v.name)
              : false),
    )
    .map((v) => v.name);
}
export function retainedTalosInstallationMatches(
  input: FleetPatchInput,
  facts: FleetPatchFacts,
): boolean {
  const retained = input.retained_talos_installation,
    role = input.spec.roles[input.role];
  return (
    !!retained &&
    retained.receipt.installer === role.talos_installer &&
    retained.receipt.node_uid === facts.node_uid &&
    retained.receipt.cluster_uid === facts.cluster_uid &&
    retained.receipt.system_uuid === facts.system_uuid &&
    retained.boot_id === facts.boot_id &&
    retained.receipt.pre_reboot_boot_id !== facts.boot_id &&
    version(retained.talos_version) === version(facts.talos_version) &&
    version(facts.talos_version) === version(role.talos_version) &&
    retained.talos_schematic_sha256 === facts.talos_schematic_sha256 &&
    facts.talos_schematic_sha256 === role.talos_schematic_sha256
  );
}
export function fleetPatchTalosRebootObserved(
  input: FleetPatchInput,
  facts: FleetPatchFacts,
): boolean {
  const target = input.spec.roles[input.role],
    receipt = input.status.talos_upgrade_receipt,
    authority = input.authority_rotation?.checkpoint;
  return (
    fleetPatchRuntimeMatches(input, facts).talos &&
    !!receipt &&
    facts.boot_id !==
      (target.kubernetes_images
        ? facts.kubernetes_configuration_boot_id
        : receipt.pre_reboot_boot_id) &&
    fleetPatchKubernetesImagesMatch(input, facts) &&
    (!target.host_configuration_required ||
      (!!input.host_configuration &&
        facts.host_configuration_sha256 ===
          input.host_configuration.status.sha256 &&
        facts.host_configuration_sha256 ===
          input.status.host_configuration_sha256)) &&
    (!authority ||
      (authority.phase === "etcd-ca" &&
        authority.state === "confirmed" &&
        !!authority.prior_boot_id &&
        facts.boot_id !== authority.prior_boot_id))
  );
}
export function fleetPatchKubernetesConfigurationMatches(
  input: Pick<FleetPatchInput, "spec" | "role">,
  facts: FleetPatchFacts,
) {
  const expected = input.spec.roles[input.role].kubernetes_images;
  if (!expected) return true;
  if (
    !facts.kubernetes_image_configuration ||
    facts.kubernetes_control_plane === undefined
  )
    return false;
  const keys = facts.kubernetes_control_plane
    ? (["kubelet", "apiServer", "controllerManager", "scheduler"] as const)
    : (["kubelet"] as const);
  return keys.every(
    (key) => facts.kubernetes_image_configuration?.[key] === expected[key],
  );
}
export function fleetPatchKubernetesImagesMatch(
  input: Pick<FleetPatchInput, "spec" | "role">,
  facts: FleetPatchFacts,
) {
  const expected = input.spec.roles[input.role].kubernetes_images;
  if (!expected) return true;
  if (!facts.kubernetes_images || facts.kubernetes_control_plane === undefined)
    return false;
  const keys = facts.kubernetes_control_plane
    ? (["kubelet", "apiServer", "controllerManager", "scheduler"] as const)
    : (["kubelet"] as const);
  return (
    Object.keys(facts.kubernetes_images).length === keys.length &&
    keys.every(
      (key) =>
        facts.kubernetes_images?.[key]?.configuration === expected[key] &&
        facts.kubernetes_images[key]?.runtime_sha256 ===
          expected[key].slice(-64),
    )
  );
}
export function fleetPatchCheckpointAllowed(
  input: FleetPatchInput,
  next: FleetPatchCheckpoint,
): boolean {
  const current = input.status,
    facts = next.facts,
    matches = fleetPatchRuntimeMatches(input, facts);
  if (
    next.expected_revision !== current.revision ||
    facts.node_uid !== current.node_uid ||
    facts.cluster_uid !== current.cluster_uid ||
    (current.baseline && current.baseline.system_uuid !== facts.system_uuid)
  )
    return false;
  if (
    facts.cluster_nodes.length !== input.cluster_nodes.length ||
    input.cluster_nodes.some(
      (v) => !facts.cluster_nodes.some((a) => a.node_uid === v.node_uid),
    )
  )
    return false;
  const healthy =
    facts.node_ready &&
    facts.cluster_nodes.every((v) => v.node_ready) &&
    facts.databases_ready;
  if (next.state === "halted")
    return next.stage === current.stage && current.state !== "dispatched";
  if (
    current.state === "dispatched" &&
    next.state === "pending" &&
    next.stage === current.stage &&
    ([
      "host_config",
      "talos",
      "talos_reboot",
      "kubernetes",
      "kubernetes_images",
    ].includes(current.stage) ||
      (current.stage === "host_service" && input.host_configuration_only)) &&
    next.error_code === "patch_write_not_attempted"
  )
    return true;
  if (current.stage === "host_ready" || current.stage === "complete")
    return false;
  if (
    current.stage === "flux" &&
    next.stage === "flux" &&
    current.state === "dispatched" &&
    next.state === "dispatched"
  ) {
    const prior = [
        ...Object.entries(current.baseline?.platform_resource_uids ?? {}),
        ...Object.entries(current.observed?.platform_resource_uids ?? {}),
      ],
      updated = facts.platform_resource_uids ?? {};
    return (
      healthy &&
      prior.every(([key, uid]) => updated[key] === uid) &&
      Object.keys(updated).some(
        (key) => !prior.some(([bound]) => bound === key),
      )
    );
  }
  if (next.stage === "host_ready")
    return (
      current.stage === "runtime_admission" &&
      current.state === "pending" &&
      next.state === "confirmed" &&
      !input.regional_hosts_ready &&
      matches.talos &&
      matches.kubernetes &&
      healthy
    );
  if (
    input.host_configuration_only &&
    ["talos", "talos_reboot", "kubernetes", "kubernetes_images"].includes(
      next.stage,
    )
  )
    return false;
  if (
    input.host_configuration_only &&
    current.stage === "host_service" &&
    current.state === "confirmed"
  )
    return next.stage === "runtime_admission" && next.state === "pending";
  if (current.state === "confirmed")
    return (
      next.state === "pending" &&
      FLEET_PATCH_STAGES.indexOf(next.stage) ===
        FLEET_PATCH_STAGES.indexOf(current.stage) + 1
    );
  if (
    next.stage === current.stage &&
    next.state === "dispatched" &&
    current.state === "pending"
  ) {
    if (!healthy) return false;
    if (current.stage === "host_config") return !!input.host_configuration;
    if (current.stage === "host_service")
      return (
        input.host_configuration_only &&
        !!input.host_configuration &&
        current.host_configuration_sha256 ===
          input.host_configuration.status.sha256 &&
        matches.talos &&
        matches.kubernetes
      );
    if (current.stage === "talos")
      return (
        supportedFleetPatchVersion(
          facts.talos_version,
          input.spec.roles[input.role].talos_version,
        ) &&
        (!input.spec.roles[input.role].kubernetes_images ||
          (matches.kubernetes &&
            fleetPatchKubernetesConfigurationMatches(input, facts)))
      );
    if (current.stage === "talos_reboot")
      return (
        !!current.talos_upgrade_receipt &&
        (!input.spec.roles[input.role].kubernetes_images ||
          (fleetPatchKubernetesConfigurationMatches(input, facts) &&
            !!facts.kubernetes_configuration_boot_id &&
            !!facts.kubernetes_configuration_observed_at))
      );
    if (current.stage === "runtime_admission")
      return (
        !!input.compute_pool &&
        facts.runtime_admission_policy_revision === input.compute_pool.revision
      );
    if (current.stage === "kubernetes_images")
      return (
        supportedFleetPatchVersion(
          facts.talos_version,
          input.spec.roles[input.role].talos_version,
        ) && matches.kubernetes
      );
    if (current.stage === "kubernetes")
      return (
        supportedFleetPatchVersion(
          facts.talos_version,
          input.spec.roles[input.role].talos_version,
        ) &&
        supportedFleetPatchVersion(
          facts.kubernetes_version,
          input.spec.roles[input.role].kubernetes_version,
        ) &&
        supportedFleetPatchVersion(
          facts.kubelet_version,
          input.spec.roles[input.role].kubernetes_version,
        )
      );
    return (
      [
        "host_config",
        "flux",
        "platform",
        "regional",
        "runtime_admission",
        "postgres",
      ].includes(current.stage) && !!input.spec.platform_source_commit
    );
  }
  if (next.stage === current.stage && next.state === "confirmed") {
    if (current.stage === "preflight") return healthy;
    if (current.stage === "host_config")
      return (
        !input.spec.roles[input.role].host_configuration_required ||
        (!!input.host_configuration &&
          facts.host_configuration_sha256 ===
            current.host_configuration_sha256 &&
          facts.host_configuration_sha256 ===
            input.host_configuration.status.sha256)
      );
    if (current.stage === "host_service")
      return (
        !input.host_configuration_only ||
        ((current.state === "pending" ||
          (current.state === "dispatched" &&
            !!current.observed &&
            facts.boot_id !== current.observed.boot_id)) &&
          healthy &&
          matches.talos &&
          matches.kubernetes &&
          facts.sandbox_service_running === true &&
          facts.host_configuration_sha256 ===
            current.host_configuration_sha256 &&
          facts.host_configuration_sha256 ===
            input.host_configuration?.status.sha256 &&
          fleetPatchHostServiceObserved(input))
      );
    if (current.stage === "talos") {
      const r = next.talos_upgrade_receipt;
      return (
        !!r &&
        r.installer === input.spec.roles[input.role].talos_installer &&
        r.node_uid === current.node_uid &&
        r.cluster_uid === current.cluster_uid &&
        r.system_uuid === facts.system_uuid &&
        (r.pre_reboot_boot_id === facts.boot_id ||
          (retainedTalosInstallationMatches(input, facts) &&
            JSON.stringify(r) ===
              JSON.stringify(input.retained_talos_installation!.receipt)))
      );
    }
    if (current.stage === "talos_reboot")
      return fleetPatchTalosRebootObserved(input, facts);
    if (current.stage === "kubernetes_images")
      return (
        supportedFleetPatchVersion(
          facts.talos_version,
          input.spec.roles[input.role].talos_version,
        ) &&
        matches.kubernetes &&
        fleetPatchKubernetesConfigurationMatches(input, facts) &&
        (!input.spec.roles[input.role].kubernetes_images ||
          (!!facts.kubernetes_configuration_boot_id &&
            !!facts.kubernetes_configuration_observed_at))
      );
    if (current.stage === "kubernetes")
      return (
        supportedFleetPatchVersion(
          facts.talos_version,
          input.spec.roles[input.role].talos_version,
        ) && matches.kubernetes
      );
    if (["flux", "platform", "regional"].includes(current.stage)) {
      const names = fleetPatchStageComponents(input, current.stage),
        observed = new Map(
          facts.release_facts?.components.map((v) => [v.name, v]) ?? [],
        );
      return names.every((name) => {
        const wanted = input.spec.components.find((v) => v.name === name)!,
          actual = observed.get(name);
        return (
          actual?.version === wanted.version && actual.sha256 === wanted.sha256
        );
      });
    }
    if (current.stage === "runtime_admission")
      return (
        !input.spec.roles[input.role].host_configuration_required ||
        (healthy &&
          facts.runtime_admission_sha256 ===
            input.host_configuration?.status.profile_sha256 &&
          facts.runtime_admission_policy_revision ===
            input.compute_pool?.revision)
      );
    if (current.stage === "postgres")
      return (
        !!next.postgres_progress &&
        next.postgres_progress.pending === 0 &&
        next.postgres_progress.errors.length === 0 &&
        healthy
      );
  }
  if (
    current.stage === "release_verify" &&
    current.state === "pending" &&
    next.stage === "complete" &&
    next.state === "confirmed"
  )
    return (
      !!facts.release_facts && matches.talos && matches.kubernetes && healthy
    );
  return (
    current.stage === "verify" &&
    current.state === "pending" &&
    next.stage === "runtime_verified" &&
    next.state === "confirmed" &&
    matches.talos &&
    matches.kubernetes &&
    healthy
  );
}
export function fleetPatchWritePreflightAllowed(
  input: FleetPatchInput,
  before: FleetPatchFacts,
  latest: FleetPatchFacts,
): boolean {
  const current = input.status;
  if (
    current.state !== "dispatched" ||
    !(
      [
        "host_config",
        "talos",
        "talos_reboot",
        "kubernetes",
        "kubernetes_images",
      ].includes(current.stage) ||
      (current.stage === "host_service" && input.host_configuration_only)
    )
  )
    return false;
  if (
    before.boot_id !== latest.boot_id ||
    before.talos_schematic_sha256 !== latest.talos_schematic_sha256 ||
    ["talos_version", "kubelet_version", "kubernetes_version"].some(
      (key) =>
        version(before[key as "talos_version"]) !==
        version(latest[key as "talos_version"]),
    )
  )
    return false;
  if (
    before.cluster_nodes.some(
      (node) =>
        !latest.cluster_nodes.some(
          (next) =>
            next.node_uid === node.node_uid &&
            version(next.kubelet_version) === version(node.kubelet_version),
        ),
    )
  )
    return false;
  return fleetPatchCheckpointAllowed(
    { ...input, status: { ...current, state: "pending" } },
    {
      expected_revision: current.revision,
      stage: current.stage,
      state: "dispatched",
      facts: latest,
      error_code: null,
    },
  );
}
