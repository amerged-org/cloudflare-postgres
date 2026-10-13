// SPDX-License-Identifier: Apache-2.0
import {
  type FleetPatchFacts,
  type FleetPatchInput,
  fleetPatchRuntimeMatches,
  fleetPatchKubernetesConfigurationMatches,
  type FleetPatchStatus,
} from "@pgcf/contracts/fleet-patches";
import { canonical } from "./bootstrap.ts";
import { hostConfigurationMatches } from "./fleet-host-configuration.ts";
import { kubernetesConfigurationImages } from "./fleet-kubernetes-images.ts";

/** An authenticated changed-boot snapshot may authorize only a declared persistence write. */
export function fleetStateReapplyEligible(
  input: FleetPatchInput,
  facts: FleetPatchFacts,
  active: string,
  admitted: boolean,
): boolean {
  const status = input.status,
    retained = input.retained_talos_installation,
    proof = retained?.kubernetes_image_provenance,
    target = input.spec.roles[input.role],
    matches = fleetPatchRuntimeMatches(input, facts);
  if (
    !input.host_configuration ||
    !target.host_configuration_required ||
    !target.kubernetes_images ||
    !retained ||
    !proof ||
    proof.method !== "pinned_configuration_boot" ||
    !proof.configuration_boot_id ||
    !proof.configuration_observed_at ||
    retained.boot_id === facts.boot_id ||
    retained.receipt.node_uid !== facts.node_uid ||
    retained.receipt.cluster_uid !== facts.cluster_uid ||
    retained.receipt.system_uuid !== facts.system_uuid ||
    retained.receipt.installer !== target.talos_installer ||
    retained.talos_version.replace(/^v/, "") !==
      facts.talos_version.replace(/^v/, "") ||
    retained.talos_schematic_sha256 !== facts.talos_schematic_sha256 ||
    proof.control_plane !== facts.kubernetes_control_plane ||
    proof.kubelet_version.replace(/^v/, "") !==
      facts.kubelet_version.replace(/^v/, "") ||
    !matches.talos ||
    !matches.kubernetes ||
    facts.node_uid !== status.node_uid ||
    facts.cluster_uid !== status.cluster_uid ||
    (status.baseline && status.baseline.system_uuid !== facts.system_uuid) ||
    !(status.stage === "preflight" || status.stage === "host_config") ||
    (status.stage === "preflight" && status.state === "dispatched") ||
    (status.stage === "host_config" && status.state === "confirmed")
  )
    return false;
  const configured = kubernetesConfigurationImages(
      active,
      "v1alpha1",
      proof.control_plane,
    ),
    previous = Object.fromEntries(
      Object.entries(proof.images).map(([name, image]) => [
        name,
        image.configuration,
      ]),
    );
  // A new material or image change cannot turn a historical partial proof into a persistence shortcut.
  return (
    canonical(configured) === canonical(previous) &&
    fleetPatchKubernetesConfigurationMatches(input, {
      ...facts,
      kubernetes_image_configuration: configured,
    }) &&
    (status.state === "dispatched" ||
      hostConfigurationMatches(
        active,
        "v1alpha1",
        input.host_configuration,
        admitted,
      ))
  );
}
/** This is evaluated at turn entry: a dispatched recovery has no write path. */
export function fleetStateReapplyDisposition(status: FleetPatchStatus) {
  if (status.stage !== "host_config") return undefined;
  if (
    status.state === "dispatched" &&
    status.observed?.talos_configuration_reapply
  )
    return "readback" as const;
  if (
    status.state === "pending" &&
    status.baseline?.talos_configuration?.persistence === "unproved"
  )
    return "prepare" as const;
  return undefined;
}
