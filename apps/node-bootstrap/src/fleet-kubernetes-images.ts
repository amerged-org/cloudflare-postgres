// SPDX-License-Identifier: Apache-2.0
import { stringify } from "yaml";
import type {
  FleetPatchInput,
  FleetPatchFacts,
} from "@pgcf/contracts/fleet-patches";
import { BootstrapError, canonical } from "./bootstrap.ts";
import { normalizeRuntimeImageManifest } from "../../../infra/platform/image-manifest.ts";
import {
  machineConfigurationDocuments,
  readMachineConfiguration,
  type HostConfigurationCommands,
} from "./fleet-host-configuration.ts";
import {
  patchObject as object,
  patchObjects as objects,
  patchSingleton as singleton,
  readFleetTalosServices,
} from "./fleet-patch-observations.ts";
const kinds = {
  kubelet: "KubeletConfig",
  apiServer: "KubeAPIServerConfig",
  controllerManager: "KubeControllerManagerConfig",
  scheduler: "KubeSchedulerConfig",
} as const;
type ImageName = keyof typeof kinds;
export function kubernetesConfigurationImages(
  raw: string,
  id: string,
  control: boolean,
) {
  const values = machineConfigurationDocuments(raw, id).values,
    result: Partial<Record<ImageName, string>> = {};
  for (const [name, kind] of Object.entries(kinds) as [ImageName, string][]) {
    const docs = values.filter(
      (doc) => doc.kind === kind && doc.apiVersion === "v1alpha1",
    );
    if (
      docs.length > 1 ||
      ((name === "kubelet" || control) && docs.length !== 1) ||
      (docs.length === 1 && typeof docs[0]!.image !== "string")
    )
      throw new BootstrapError("patch_kubernetes_image_configuration_invalid");
    if (docs[0]) result[name] = String(docs[0].image);
  }
  return { ...result, kubelet: result.kubelet! };
}
export function mergeKubernetesImages(
  raw: string,
  input: FleetPatchInput,
  control: boolean,
) {
  const expected = input.spec.roles[input.role].kubernetes_images;
  if (!expected)
    throw new BootstrapError("patch_kubernetes_image_pins_missing");
  kubernetesConfigurationImages(raw, "v1alpha1", control);
  const values = machineConfigurationDocuments(raw, "v1alpha1").values;
  for (const [name, kind] of Object.entries(kinds) as [ImageName, string][])
    for (const doc of values)
      if (doc.kind === kind && doc.apiVersion === "v1alpha1")
        doc.image = expected[name];
  return values.map((value) => stringify(value)).join("---\n");
}
const repository = (value: string) => {
  const raw = value.split("@")[0]!,
    colon = raw.lastIndexOf(":"),
    slash = raw.lastIndexOf("/");
  return colon > slash ? raw.slice(0, colon) : raw;
};
const digestOf = (value: unknown) =>
  typeof value === "string"
    ? /(?:@sha256:|^sha256:|:\/\/sha256:)([a-f0-9]{64})$/.exec(value)?.[1]
    : undefined;
type ImageObservationCommands = HostConfigurationCommands & {
  kube(args: string[]): Promise<string>;
  request?: typeof fetch;
  signal?: AbortSignal;
};
export { normalizeRuntimeImageManifest } from "../../../infra/platform/image-manifest.ts";
export async function observeKubernetesImages(
  input: FleetPatchInput,
  control: boolean,
  commands: ImageObservationCommands,
  configuration?: Awaited<ReturnType<typeof readMachineConfiguration>>,
  bootWitness?: Parameters<typeof readMachineConfiguration>[1],
): Promise<NonNullable<FleetPatchFacts["kubernetes_images"]> | undefined> {
  const expected = input.spec.roles[input.role].kubernetes_images;
  if (!expected) return undefined;
  const value =
      configuration ?? (await readMachineConfiguration(commands, bootWitness)),
    active = kubernetesConfigurationImages(value.active, "v1alpha1", control);
  if (value.persistent !== undefined) {
    const persistent = kubernetesConfigurationImages(
      value.persistent,
      "persistent",
      control,
    );
    if (canonical(active) !== canonical(persistent))
      throw new BootstrapError("patch_kubernetes_image_configuration_diverged");
  } else if (
    !bootWitness ||
    value.state_loaded?.boot_id !== bootWitness.boot_id ||
    value.state_loaded?.configuration_boot_id !==
      bootWitness.configuration_boot_id ||
    value.state_loaded?.configuration_sha256 !== value.sha256 ||
    bootWitness.boot_id === bootWitness.configuration_boot_id
  )
    throw new BootstrapError("patch_kubernetes_image_configuration_unproven");
  if (!bootWitness || bootWitness.boot_id === bootWitness.configuration_boot_id)
    return undefined;
  const [statusText, servicesText, podText] = await Promise.all([
    commands.talos(["get", "kubeletstatuses", "kubelet", "--output=json"]),
    commands.talos(["get", "services", "--output=json"]),
    control
      ? commands.kube([
          "get",
          "pods",
          "--namespace",
          "kube-system",
          "--output=json",
        ])
      : Promise.resolve('{"items":[]}'),
  ]);
  const status = singleton(
      statusText,
      "KubeletStatuses.kubernetes.talos.dev",
      "kubelet",
    ),
    service = readFleetTalosServices(servicesText).get("kubelet"),
    result: Partial<NonNullable<FleetPatchFacts["kubernetes_images"]>> = {};
  // Vendor startup resolves this exact pinned reference after the recorded configuration boot boundary.
  // This is boot-backed deployment provenance, not a fresh raw container hash.
  if (
    status.image === active.kubelet &&
    digestOf(status.image) &&
    service?.running === true &&
    service.healthy === true
  )
    result.kubelet = {
      configuration: active.kubelet!,
      runtime_sha256: digestOf(status.image)!,
    };
  if (control) {
    const pods = objects(object(JSON.parse(podText)).items),
      components = {
        apiServer: "kube-apiserver",
        controllerManager: "kube-controller-manager",
        scheduler: "kube-scheduler",
      } as const;
    let node: Promise<Record<string, unknown>> | undefined;
    for (const [name, component] of Object.entries(components) as [
      Exclude<ImageName, "kubelet">,
      string,
    ][]) {
      const selected = pods.filter(
        (pod) =>
          object(pod.spec).nodeName === input.k8s_node_name &&
          object(object(pod.metadata).labels).component === component &&
          !object(pod.metadata).deletionTimestamp &&
          !["Succeeded", "Failed"].includes(String(object(pod.status).phase)),
      );
      if (selected.length !== 1) continue;
      const pod = selected[0]!,
        owners = objects(object(pod.metadata).ownerReferences),
        containers = objects(object(pod.spec).containers),
        statuses = objects(object(pod.status).containerStatuses);
      if (
        !owners.some(
          (owner) =>
            owner.kind === "Node" && owner.uid === input.status.node_uid,
        ) ||
        containers.length !== 1 ||
        statuses.length !== 1
      )
        continue;
      const status = statuses[0]!,
        container = containers[0]!,
        sha = digestOf(status.imageID);
      if (
        typeof container.image === "string" &&
        repository(container.image) === repository(active[name]!) &&
        digestOf(container.image) === digestOf(active[name]) &&
        status.name === container.name &&
        status.ready === true &&
        object(object(status.state).running).startedAt &&
        sha
      ) {
        let observed = sha;
        if (sha !== digestOf(expected[name])) {
          node ??= commands
            .kube(["get", "node", input.k8s_node_name, "--output=json"])
            .then((text) => object(JSON.parse(text)));
          const actual = await node,
            metadata = object(actual.metadata),
            info = object(object(actual.status).nodeInfo);
          if (
            metadata.uid !== input.status.node_uid ||
            metadata.name !== input.k8s_node_name ||
            metadata.deletionTimestamp ||
            info.bootID !== bootWitness.boot_id
          )
            throw new BootstrapError(
              "patch_kubernetes_image_node_identity_changed",
            );
          if (info.architecture !== "amd64" || info.operatingSystem !== "linux")
            continue;
          const normalized = await normalizeRuntimeImageManifest(
            expected[name]!,
            digestOf(expected[name])!,
            sha,
            commands,
          );
          if (!normalized) continue;
          observed = normalized;
        }
        result[name] = {
          configuration: active[name]!,
          runtime_sha256: observed,
        };
      }
    }
  }
  return result.kubelet
    ? (result as NonNullable<FleetPatchFacts["kubernetes_images"]>)
    : undefined;
}
export async function applyKubernetesImages(
  input: FleetPatchInput,
  control: boolean,
  commands: HostConfigurationCommands,
  expected: Awaited<ReturnType<typeof readMachineConfiguration>>,
) {
  const latest = await readMachineConfiguration(
    commands,
    expected.state_loaded,
  );
  if (latest.sha256 !== expected.sha256)
    throw new BootstrapError(
      "patch_kubernetes_configuration_changed_before_write",
    );
  const merged = mergeKubernetesImages(latest.active, input, control);
  await commands
    .talos(["apply-config", "--mode=no-reboot", "--file=-"], merged)
    .catch(() => undefined);
}
