// SPDX-License-Identifier: Apache-2.0
import {
  FleetPatchFacts,
  type FleetPatchInput,
  type FleetPatchStatus,
} from "@pgcf/contracts/fleet-patches";
import { BootstrapError, jsonRecords } from "./bootstrap.ts";
export type ObjectValue = Record<string, unknown>;
export function patchObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BootstrapError("patch_readback_invalid");
  return value as ObjectValue;
}
export function patchObjects(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) throw new BootstrapError("patch_readback_invalid");
  return value.map(patchObject);
}
export function patchSingleton(
  stdout: string,
  type: string,
  id: string,
): ObjectValue {
  const values = jsonRecords(stdout);
  if (
    values.length !== 1 ||
    patchObject(values[0]!.metadata).type !== type ||
    patchObject(values[0]!.metadata).id !== id
  )
    throw new BootstrapError("patch_talos_resource_invalid");
  return patchObject(values[0]!.spec);
}
const object = patchObject,
  objects = patchObjects,
  singleton = patchSingleton;
/** Read-only runtime collector shared by the programmed executor and direct operator acceptance. */
export async function collectFleetPatchRuntime(
  input: Pick<
    FleetPatchInput,
    "address" | "cluster_endpoint" | "cluster_nodes" | "k8s_node_name"
  >,
  current: Pick<FleetPatchStatus, "node_uid" | "cluster_uid" | "baseline">,
  commands: {
    kube(args: string[]): Promise<string>;
    talos(args: string[]): Promise<string>;
  },
) {
  const { kube, talos } = commands,
    clusterAddress = new URL(input.cluster_endpoint).hostname;

  const [
    namespace,
    node,
    server,
    version,
    boot,
    system,
    schematic,
    clusters,
    allNodes,
  ] = await Promise.allSettled([
    kube(["get", "namespace", "kube-system", "-o", "json"]),
    kube(["get", "node", input.k8s_node_name, "-o", "json"]),
    kube(["get", "--raw=/version"]),
    talos(["version", "--json"]),
    talos(["get", "bootid", "--namespace", "runtime", "--output", "json"]),
    talos([
      "get",
      "systeminformation",
      "--namespace",
      "hardware",
      "--output",
      "json",
    ]),
    talos([
      "get",
      "imagefactoryschematic",
      "--namespace",
      "runtime",
      "--output",
      "json",
    ]),
    kube([
      "get",
      "clusters.postgresql.cnpg.io",
      "--all-namespaces",
      "-o",
      "json",
    ]),
    kube(["get", "nodes", "-o", "json"]),
  ]).then((results) => {
    const failure = results.find((v) => v.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return results.map((v) => (v as PromiseFulfilledResult<string>).value) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
  });
  const n = object(JSON.parse(node)),
    info = object(object(n.status).nodeInfo),
    addresses = objects(object(n.status).addresses);
  const clusterNodes = objects(object(JSON.parse(allNodes)).items);
  if (
    clusterNodes.length !== input.cluster_nodes.length ||
    input.cluster_nodes.some(
      (expected) =>
        !clusterNodes.some(
          (actual) =>
            object(actual.metadata).name === expected.k8s_node_name &&
            object(actual.metadata).uid === expected.node_uid,
        ),
    )
  )
    throw new BootstrapError("patch_cluster_membership_changed");
  const controlNode = clusterNodes.find((actual) =>
    objects(object(actual.status).addresses).some(
      (v) => v.type === "InternalIP" && v.address === clusterAddress,
    ),
  );
  if (
    !controlNode ||
    !Object.hasOwn(
      object(object(controlNode.metadata).labels),
      "node-role.kubernetes.io/control-plane",
    )
  )
    throw new BootstrapError("patch_control_identity_changed");
  const observed = FleetPatchFacts.parse({
    node_uid: object(n.metadata).uid,
    cluster_uid: object(object(JSON.parse(namespace)).metadata).uid,
    system_uuid: singleton(
      system,
      "SystemInformations.hardware.talos.dev",
      "systeminformation",
    ).uuid,
    boot_id: singleton(boot, "BootIDs.runtime.talos.dev", "boot-id").bootID,
    talos_version: object(object(JSON.parse(version)).version).tag,
    talos_schematic_sha256: singleton(
      schematic,
      "ImageFactorySchematics.runtime.talos.dev",
      "image-factory-schematic",
    ).schematicId,
    kubelet_version: info.kubeletVersion,
    kubernetes_version: object(JSON.parse(server)).gitVersion,
    node_ready: objects(object(n.status).conditions).some(
      (v) => v.type === "Ready" && v.status === "True",
    ),
    databases_ready: objects(object(JSON.parse(clusters)).items).every((v) => {
      const conditions = objects(object(v.status).conditions);
      return (
        conditions.some((c) => c.type === "Ready" && c.status === "True") ||
        conditions.some(
          (c) =>
            c.type === "cnpg.io/hibernation" &&
            c.status === "True" &&
            c.reason === "Hibernated",
        )
      );
    }),
    cluster_nodes: clusterNodes.map((v) => ({
      node_uid: object(v.metadata).uid,
      kubelet_version: object(object(v.status).nodeInfo).kubeletVersion,
      node_ready: objects(object(v.status).conditions).some(
        (c) => c.type === "Ready" && c.status === "True",
      ),
    })),
    observed_at: new Date().toISOString(),
  });
  if (
    observed.node_uid !== current.node_uid ||
    observed.cluster_uid !== current.cluster_uid ||
    String(info.systemUUID).toLowerCase() !==
      observed.system_uuid.toLowerCase() ||
    info.bootID !== observed.boot_id ||
    !addresses.some(
      (v) => v.type === "InternalIP" && v.address === input.address,
    ) ||
    (current.baseline && current.baseline.system_uuid !== observed.system_uuid)
  )
    throw new BootstrapError("patch_live_identity_changed");
  return { facts: observed, controlNode, nodes: clusterNodes };
}

/** Talos ExtensionStatus describes loaded metadata; it does not expose an OCI imageID. */
export function readFleetTalosExtensions(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of jsonRecords(stdout)) {
    if (object(value.metadata).type !== "ExtensionStatuses.runtime.talos.dev")
      throw new BootstrapError("patch_extension_resource_invalid");
    const metadata = object(object(value.spec).metadata);
    if (
      typeof metadata.name !== "string" ||
      typeof metadata.version !== "string" ||
      result.has(metadata.name)
    )
      throw new BootstrapError("patch_extension_resource_invalid");
    result.set(metadata.name, metadata.version);
  }
  return result;
}

export function readFleetTalosServices(stdout: string) {
  const result = new Map<
    string,
    { running: boolean; healthy: boolean; unknown: boolean }
  >();
  for (const value of jsonRecords(stdout)) {
    const metadata = object(value.metadata),
      spec = object(value.spec);
    if (
      metadata.type !== "Services.v1alpha1.talos.dev" ||
      typeof metadata.id !== "string" ||
      [spec.running, spec.healthy, spec.unknown].some(
        (field) => typeof field !== "boolean",
      ) ||
      result.has(metadata.id)
    )
      throw new BootstrapError("patch_service_resource_invalid");
    result.set(metadata.id, {
      running: spec.running as boolean,
      healthy: spec.healthy as boolean,
      unknown: spec.unknown as boolean,
    });
  }
  return result;
}
