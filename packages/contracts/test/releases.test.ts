// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  FleetReleaseSpec,
  FleetNodeReleaseObservation,
  fleetChartObservation,
  thinStorageReleaseGuardPinned,
} from "../src/releases.ts";
import {
  FleetPatchInput,
  type FleetPatchFacts,
  fleetPatchCheckpointAllowed,
  fleetPatchTalosRebootObserved,
  fleetPatchWritePreflightAllowed,
} from "../src/fleet-patches.ts";

const names = [
  "api",
  "edge",
  "node-bootstrap",
  "regional",
  "postgres",
  "barman",
  "cloudflared",
  "cilium",
  "flux-source",
  "flux-kustomize",
  "flux-helm",
  "flux-notification",
  "cert-manager",
  "cloudnative-pg",
  "openebs-lvm",
];
function spec() {
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [] as string[],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  return {
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { control_relay: role, customer: structuredClone(role) },
  };
}
function hostActivation() {
  const now = new Date().toISOString(),
    node_uid = crypto.randomUUID(),
    cluster_uid = crypto.randomUUID(),
    node_id = "nod_abcdefghijklmnopqrst",
    hash = "e".repeat(64),
    profile = {
      release_id: "test-release",
      image: `registry.example/holder@sha256:${"d".repeat(64)}`,
      holder_sha256: "d".repeat(64),
      controller_sha256: "d".repeat(64),
      containerd_version: "2.3.6",
      runc_version: "1.5.2",
      architecture: "amd64",
    };
  const facts: FleetPatchFacts = {
    node_uid,
    cluster_uid,
    system_uuid: crypto.randomUUID(),
    boot_id: crypto.randomUUID(),
    talos_version: "1.14.1",
    talos_schematic_sha256: "b".repeat(64),
    kubelet_version: "1.36.5",
    kubernetes_version: "1.36.5",
    node_ready: true,
    databases_ready: true,
    cluster_nodes: [{ node_uid, kubelet_version: "1.36.5", node_ready: true }],
    observed_at: now,
    host_configuration_sha256: hash,
    sandbox_service_running: true,
  };
  const input = FleetPatchInput.parse({
    status: {
      operation_id: "op_abcdefghijklmnopqrst",
      node_id,
      region_id: "eu-test",
      node_uid,
      cluster_uid,
      release_id: "test-release",
      spec_sha256: "a".repeat(64),
      assignment_revision: 1,
      revision: 4,
      stage: "host_service",
      state: "pending",
      baseline: facts,
      observed: facts,
      host_configuration_sha256: hash,
      error_code: null,
      created_at: now,
      updated_at: now,
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    },
    role: "customer",
    spec: spec(),
    address: "192.0.2.18",
    k8s_node_name: "test-node",
    cluster_endpoint: "https://192.0.2.18:6443/",
    cluster_nodes: [
      { node_id, node_uid, k8s_node_name: "test-node", assignment_revision: 1 },
    ],
    talos_admin_config: "test-only-config",
    kubeconfig: "test-only-config",
    host_configuration_only: true,
    host_configuration: {
      status: {
        version: 1,
        node_id,
        node_uid,
        region_id: "eu-test",
        cluster_uid,
        material_revision: 3,
        revision: 2,
        sha256: hash,
        release_id: "test-release",
        pool_policy_revision: 2,
        profile_sha256: "f".repeat(64),
        created_at: now,
      },
      files: [
        {
          path: "/var/lib/pgcf-sandbox/settings.json",
          permissions: 384,
          content: "{}",
        },
        {
          path: "/var/lib/pgcf-sandbox/agent-key",
          permissions: 384,
          content: "test-only-key",
        },
      ],
    },
    compute_pool: {
      node_id,
      node_uid,
      region_id: "eu-test",
      revision: 2,
      updated_at: now,
      policy: {
        version: 1,
        target_slots: 1,
        max_idle_cpu_millicores: 100,
        max_idle_memory_mib: 64,
        per_slot_cpu_millicores: 100,
        per_slot_memory_mib: 64,
        max_age_seconds: 300,
        profile,
      },
    },
    compute_pool_observation: {
      node_id,
      node_uid,
      policy_revision: 2,
      material_revision: 3,
      observed_at: now,
      profile,
      idle_memory_current_bytes: 0,
      idle_cpu_usage_usec: 0,
      slots: [],
    },
    callback: {
      url: "https://api.invalid/internal/v1/fleet-patches/op_abcdefghijklmnopqrst",
      bearer: "t".repeat(43),
    },
  });
  const checkpoint = {
    expected_revision: input.status.revision,
    stage: "host_service" as const,
    state: "confirmed" as const,
    facts,
    error_code: null,
  };
  return { input, facts, checkpoint };
}
it("host-only activation durably dispatches once and requires the dispatch boot to change before confirmation", () => {
  const { input, facts, checkpoint } = hostActivation();
  expect(fleetPatchCheckpointAllowed(input, checkpoint)).toBe(true);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      facts: { ...facts, host_configuration_sha256: undefined },
    }),
  ).toBe(false);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      state: "dispatched",
      facts: { ...facts, host_configuration_sha256: undefined },
    }),
  ).toBe(true);
  input.status.state = "dispatched";
  input.status.baseline = { ...facts, boot_id: crypto.randomUUID() };
  expect(fleetPatchCheckpointAllowed(input, checkpoint)).toBe(false);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      facts: { ...facts, boot_id: crypto.randomUUID() },
    }),
  ).toBe(true);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      facts: { ...facts, boot_id: input.status.baseline.boot_id },
    }),
  ).toBe(true);
  input.status.observed = null;
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      facts: { ...facts, boot_id: crypto.randomUUID() },
    }),
  ).toBe(false);
});
it("host-only activation checks physical files, running service and current material after reboot", () => {
  const { input, facts, checkpoint } = hostActivation();
  input.status.state = "dispatched";
  checkpoint.facts = { ...facts, boot_id: crypto.randomUUID() };
  expect(fleetPatchCheckpointAllowed(input, checkpoint)).toBe(true);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      facts: { ...checkpoint.facts, host_configuration_sha256: "0".repeat(64) },
    }),
  ).toBe(false);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...checkpoint,
      facts: { ...checkpoint.facts, sandbox_service_running: false },
    }),
  ).toBe(false);
  input.compute_pool_observation!.material_revision = 2;
  expect(fleetPatchCheckpointAllowed(input, checkpoint)).toBe(false);
  input.compute_pool_observation!.material_revision = 3;
  input.compute_pool_observation!.observed_at = new Date(
    Date.now() - 180000,
  ).toISOString();
  expect(fleetPatchCheckpointAllowed(input, checkpoint)).toBe(false);
});
it("host-only activation clears dispatch only for the existing proven-before-attempt error", () => {
  const { input, checkpoint } = hostActivation();
  input.status.state = "dispatched";
  const pending = {
    ...checkpoint,
    state: "pending" as const,
    error_code: "patch_write_not_attempted",
  };
  expect(fleetPatchCheckpointAllowed(input, pending)).toBe(true);
  expect(
    fleetPatchCheckpointAllowed(input, { ...pending, error_code: null }),
  ).toBe(false);
  expect(
    fleetPatchCheckpointAllowed(input, {
      ...pending,
      error_code: "patch_command_timeout",
    }),
  ).toBe(false);
  input.host_configuration_only = false;
  expect(fleetPatchCheckpointAllowed(input, pending)).toBe(false);
});
it("the existing late identity check fences a host-only activation reboot and forbids OS stages", () => {
  const { input, facts, checkpoint } = hostActivation();
  input.status.state = "dispatched";
  expect(fleetPatchWritePreflightAllowed(input, facts, facts)).toBe(true);
  expect(
    fleetPatchWritePreflightAllowed(input, facts, {
      ...facts,
      boot_id: crypto.randomUUID(),
    }),
  ).toBe(false);
  input.host_configuration_only = false;
  expect(fleetPatchWritePreflightAllowed(input, facts, facts)).toBe(false);
  expect(
    fleetPatchCheckpointAllowed(input, { ...checkpoint, state: "dispatched" }),
  ).toBe(false);
  input.status.state = "pending";
  expect(fleetPatchCheckpointAllowed(input, checkpoint)).toBe(true);
  input.host_configuration_only = true;
  for (const stage of [
    "talos",
    "talos_reboot",
    "kubernetes",
    "kubernetes_images",
  ] as const)
    expect(fleetPatchCheckpointAllowed(input, { ...checkpoint, stage })).toBe(
      false,
    );
});
it("requires explicit digests, complete product layers and closed role references", () => {
  expect(FleetReleaseSpec.safeParse(spec()).success).toBe(true);
  const missing = spec();
  missing.components.pop();
  expect(FleetReleaseSpec.safeParse(missing).success).toBe(false);
  const unknown = spec();
  unknown.roles.customer.components.push("unknown");
  expect(FleetReleaseSpec.safeParse(unknown).success).toBe(false);
  const unpinned = spec();
  unpinned.components[0]!.sha256 = "latest";
  expect(FleetReleaseSpec.safeParse(unpinned).success).toBe(false);
  const duplicate = spec();
  duplicate.components.push(duplicate.components[0]!);
  expect(FleetReleaseSpec.safeParse(duplicate).success).toBe(false);
});
it("qualified thin releases require a pinned verifier and native gateway while thick-only releases remain valid", () => {
  const base = spec();
  for (const name of ["pgcf-sandbox-controller", "native-gateway"])
    base.components.push({
      name,
      kind: "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    });
  for (const role of Object.values(base.roles)) {
    Object.assign(role, { host_configuration_required: true });
    role.talos_extensions.push("pgcf-sandbox-controller");
    role.components.push("native-gateway");
  }
  const qualified = Object.assign(base, {
    storage_authority_keys_sha256: "a".repeat(64),
    thin_storage_qualification: {
      profile_sha256: "b".repeat(64),
      driver_image: `registry.example/openebs-lvm@sha256:${"d".repeat(64)}`,
      host_extension_image: `registry.example/pgcf-sandbox-controller@sha256:${"d".repeat(64)}`,
      kernel_version: "6.18.54",
      receipt_sha256: "c".repeat(64),
      qualified_at: "2026-10-09T00:00:00.000Z",
      gates: {
        data_full: true,
        metadata_full: true,
        noflush_quiescence: true,
        resume_marker: true,
        startup_bound: true,
        trim_delete_recreate: true,
        retained_thick_preservation: true,
      },
    },
  });
  expect(FleetReleaseSpec.safeParse(qualified).success).toBe(true);
  const missingPin = structuredClone(qualified) as Partial<typeof qualified>;
  delete missingPin.storage_authority_keys_sha256;
  expect(FleetReleaseSpec.safeParse(missingPin).success).toBe(false);
  const noGateway = structuredClone(qualified);
  noGateway.components = noGateway.components.filter(
    (c) => c.name !== "native-gateway",
  );
  for (const role of Object.values(noGateway.roles))
    role.components = role.components.filter((n) => n !== "native-gateway");
  expect(FleetReleaseSpec.safeParse(noGateway).success).toBe(false);
  const thickOnlySuccessor = structuredClone(noGateway) as Partial<
    typeof noGateway
  >;
  delete thickOnlySuccessor.thin_storage_qualification;
  const acceptedThickRelease = FleetReleaseSpec.parse(thickOnlySuccessor);
  expect(thinStorageReleaseGuardPinned(acceptedThickRelease)).toBe(false);
  expect(FleetReleaseSpec.safeParse(spec()).success).toBe(true);
});
it("does not treat a release-id claim or partial duplicate inventory as component observations", () => {
  expect(
    FleetNodeReleaseObservation.safeParse({
      release_id: "one",
      node_uid: crypto.randomUUID(),
    }).success,
  ).toBe(false);
});
it("a retained same-OS reboot receipt cannot confirm before required host files are physically active", () => {
  const { input, facts } = hostActivation();
  input.host_configuration_only = false;
  input.spec.roles.customer.host_configuration_required = true;
  input.status.talos_upgrade_receipt = {
    method: "deploymentreceipt",
    installer: input.spec.roles.customer.talos_installer,
    node_uid: facts.node_uid,
    cluster_uid: facts.cluster_uid,
    system_uuid: facts.system_uuid,
    pre_reboot_boot_id: crypto.randomUUID(),
    completed_at: facts.observed_at,
    source: "cli_exit_0",
  };
  expect(
    fleetPatchTalosRebootObserved(input, {
      ...facts,
      host_configuration_sha256: undefined,
    }),
  ).toBe(false);
  expect(
    fleetPatchTalosRebootObserved(input, {
      ...facts,
      host_configuration_sha256: "0".repeat(64),
    }),
  ).toBe(false);
  expect(fleetPatchTalosRebootObserved(input, facts)).toBe(true);
});
it("forbids a different shared runtime version and contradictory image digest in one release", () => {
  const different = structuredClone(spec());
  different.roles.customer.kubernetes_version = "1.36.3";
  expect(FleetReleaseSpec.safeParse(different).success).toBe(false);
  const wrong = spec();
  wrong.components[3]!.reference = `registry.example/regional@sha256:${"e".repeat(64)}`;
  expect(FleetReleaseSpec.safeParse(wrong).success).toBe(false);
});
it("checks OCI applied history by exact digest while normalizing chart build metadata", () => {
  const sha = "a".repeat(64),
    pin = {
      name: "cilium",
      kind: "chart" as const,
      version: "1.20.2",
      reference: `oci://quay.io/cilium/charts/cilium@sha256:${sha}`,
      sha256: sha,
    };
  const ready = {
    metadata: { generation: 1 },
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
    },
  };
  const release = {
      ...ready,
      status: {
        ...ready.status,
        history: [
          {
            chartVersion: "1.20.2+a7c12d330dd9",
            ociDigest: `sha256:${sha}`,
            status: "deployed",
          },
        ],
      },
    },
    source = {
      ...ready,
      spec: {
        url: "oci://quay.io/cilium/charts/cilium",
        ref: { digest: `sha256:${sha}` },
      },
      status: {
        ...ready.status,
        artifact: { revision: `1.20.2@sha256:${sha}` },
      },
    };
  expect(fleetChartObservation(pin, release, source, null)).toEqual({
    name: "cilium",
    version: "1.20.2",
    sha256: sha,
  });
  release.status.history[0]!.ociDigest = `sha256:${"b".repeat(64)}`;
  expect(fleetChartObservation(pin, release, source, null)).toBeNull();
});

it("keeps the pinned cert-manager installation hook qualified without requiring a permanent running Job on every node", () => {
  const value = spec();
  value.components.push({
    name: "image/cert-manager/cert-manager-startupapicheck",
    kind: "image",
    version: "1.21.2",
    reference:
      "quay.io/jetstack/cert-manager-startupapicheck:v1.21.2@sha256:" +
      "e".repeat(64),
    sha256: "e".repeat(64),
  });
  expect(FleetReleaseSpec.safeParse(value).success).toBe(true);
  value.components.push({
    name: "image/cert-manager/unqualified-hook",
    kind: "image",
    version: "1.21.2",
    reference: "quay.io/jetstack/unqualified:v1.21.2@sha256:" + "e".repeat(64),
    sha256: "e".repeat(64),
  });
  expect(FleetReleaseSpec.safeParse(value).success).toBe(false);
});
