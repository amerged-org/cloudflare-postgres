// SPDX-License-Identifier: Apache-2.0
import {
  FleetNodeReleaseObservation,
  type FleetDesiredRelease,
} from "@pgcf/contracts/releases";
import { record, string, type Kubernetes, type Resource } from "./types.ts";

export const FLEET_INVENTORY_INTERVAL_MS = 60_000;
function digest(imageId: unknown): string | undefined {
  if (typeof imageId !== "string") return undefined;
  return /(?:@sha256:|^sha256:|^[a-z][a-z0-9+.-]*:\/\/sha256:)([0-9a-f]{64})$/.exec(
    imageId,
  )?.[1];
}
function repository(reference: string): string {
  const withoutDigest = reference.split("@")[0]!;
  const lastSlash = withoutDigest.lastIndexOf("/"),
    colon = withoutDigest.lastIndexOf(":");
  return colon > lastSlash ? withoutDigest.slice(0, colon) : withoutDigest;
}
function controllerUid(pod: Resource): string | undefined {
  const owners = record(pod.metadata).ownerReferences;
  if (!Array.isArray(owners)) return undefined;
  const controllers = owners
    .map(record)
    .filter((owner) => owner.controller === true);
  return controllers.length === 1 ? string(controllers[0]!.uid) : undefined;
}
function ready(node: Resource): boolean {
  const conditions = record(node.status).conditions;
  return (
    Array.isArray(conditions) &&
    conditions.some(
      (value) =>
        record(value).type === "Ready" && record(value).status === "True",
    )
  );
}
/** Kube-only inventory deliberately leaves Talos artifact/schematic and configuration revision unknown. */
export async function collectFleetInventory(
  k8s: Pick<Kubernetes, "read" | "list">,
  desired: FleetDesiredRelease,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<FleetNodeReleaseObservation[]> {
  const started = now();
  const stop = () => signal?.aborted || now() - started >= 20_000;
  if (stop()) return [];
  const pods = await k8s.list("Pod");
  const result: FleetNodeReleaseObservation[] = [];
  for (const assignment of desired.nodes) {
    if (stop()) return result;
    const node = await k8s.read("Node", undefined, assignment.k8s_node_name);
    if (
      !node ||
      node.metadata.uid !== assignment.node_uid ||
      node.metadata.deletionTimestamp ||
      !ready(node)
    )
      continue;
    const information = record(record(node.status).nodeInfo),
      kubelet = string(information.kubeletVersion);
    const kubeVersion =
      kubelet && /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(kubelet)
        ? kubelet.replace(/^v/, "")
        : undefined;
    const osImage = string(information.osImage),
      talosVersion =
        osImage &&
        /^Talos \(v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\)$/.exec(
          osImage,
        )?.[1];
    const wanted = new Set([
      ...desired.release.spec.roles[assignment.role].components,
      ...desired.release.spec.roles[assignment.role].talos_extensions,
    ]);
    const components: FleetNodeReleaseObservation["facts"]["components"] = [];
    for (const component of desired.release.spec.components) {
      if (stop()) return result;
      if (
        !wanted.has(component.name) ||
        component.kind !== "image" ||
        !component.workload
      )
        continue;
      const ownership = component.workload;
      const namespace = await k8s.read(
        "Namespace",
        undefined,
        ownership.namespace,
      );
      if (!namespace?.metadata.uid || namespace.metadata.deletionTimestamp)
        continue;
      const candidates = pods
        .filter(
          (pod) =>
            record(pod.spec).nodeName === assignment.k8s_node_name &&
            !pod.metadata.deletionTimestamp &&
            pod.metadata.namespace === ownership.namespace &&
            Object.entries(ownership.selector).every(
              ([key, value]) => pod.metadata.labels?.[key] === value,
            ) &&
            !!controllerUid(pod),
        )
        .flatMap((pod) => {
          const containers = record(pod.spec).containers,
            statuses = record(pod.status).containerStatuses;
          if (!Array.isArray(containers) || !Array.isArray(statuses)) return [];
          return containers
            .map(record)
            .filter(
              (container) =>
                typeof container.image === "string" &&
                repository(container.image) === repository(component.reference),
            )
            .map((container) => ({
              pod,
              container,
              status: statuses
                .map(record)
                .find((status) => status.name === container.name),
            }));
        });
      if (!candidates.length) continue;
      // A digest from the qualified release maps to its version. Tags and desired references alone never qualify a running image.
      if (
        candidates.some(
          ({ pod, status }) =>
            !pod.metadata.uid ||
            status?.ready !== true ||
            !record(record(status.state).running).startedAt ||
            !digest(status.imageID),
        )
      )
        continue;
      const runtimeDigests = new Set(
        candidates.map(({ status }) => digest(status?.imageID)!),
      );
      if (runtimeDigests.size !== 1) continue;
      const runtimeDigest = [...runtimeDigests][0]!;
      let stable = true;
      for (const { pod, container, status } of candidates) {
        if (stop()) return result;
        const fresh = await k8s.read(
            "Pod",
            pod.metadata.namespace,
            pod.metadata.name,
          ),
          freshStatuses = record(fresh?.status).containerStatuses;
        const freshStatus = Array.isArray(freshStatuses)
          ? freshStatuses
              .map(record)
              .find((value) => value.name === container.name)
          : undefined;
        if (
          !fresh ||
          fresh.metadata.uid !== pod.metadata.uid ||
          fresh.metadata.deletionTimestamp ||
          controllerUid(fresh) !== controllerUid(pod) ||
          Object.entries(ownership.selector).some(
            ([key, value]) => fresh.metadata.labels?.[key] !== value,
          ) ||
          record(fresh.spec).nodeName !== assignment.k8s_node_name ||
          freshStatus?.ready !== true ||
          freshStatus.imageID !== status?.imageID ||
          freshStatus.restartCount !== status?.restartCount
        ) {
          stable = false;
          break;
        }
      }
      const afterNamespace = await k8s.read(
        "Namespace",
        undefined,
        ownership.namespace,
      );
      if (
        !afterNamespace ||
        afterNamespace.metadata.uid !== namespace.metadata.uid ||
        afterNamespace.metadata.deletionTimestamp
      )
        stable = false;
      if (stable)
        components.push({
          name: component.name,
          runtime_image_sha256: runtimeDigest,
          ...(runtimeDigest === component.sha256
            ? { version: component.version, sha256: component.sha256 }
            : {}),
        });
    }
    const after = await k8s.read("Node", undefined, assignment.k8s_node_name);
    if (
      !after ||
      after.metadata.uid !== assignment.node_uid ||
      after.metadata.deletionTimestamp ||
      !ready(after) ||
      [
        "kubeletVersion",
        "osImage",
        "bootID",
        "systemUUID",
        "machineID",
        "containerRuntimeVersion",
        "kernelVersion",
      ].some(
        (key) =>
          record(record(after.status).nodeInfo)[key] !== information[key],
      )
    )
      continue;
    if (stop()) return result;
    result.push(
      FleetNodeReleaseObservation.parse({
        node_id: assignment.node_id,
        node_uid: assignment.node_uid,
        assignment_revision: assignment.revision,
        observed_at: new Date(now()).toISOString(),
        facts: {
          ...(kubeVersion ? { kubernetes_version: kubeVersion } : {}),
          ...(talosVersion ? { talos_version: talosVersion } : {}),
          components,
        },
      }),
    );
  }
  return result;
}
