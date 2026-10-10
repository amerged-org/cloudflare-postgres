// SPDX-License-Identifier: Apache-2.0
import {
  FleetNodeReleaseObservation,
  type FleetDesiredRelease,
  fleetChartObservation,
  fleetFluxReady,
} from "@pgcf/contracts/releases";
import { CONFIGURATION_SCHEMA_REVISION } from "@pgcf/contracts";
import { normalizeRuntimeImageManifest } from "../../../../infra/platform/image-manifest.ts";
import { record, string, type Kubernetes, type Resource } from "./types.ts";

export const FLEET_INVENTORY_INTERVAL_MS = 60_000;
function validBootId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  );
}
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
function activePod(pod: Resource): boolean {
  const phase = record(pod.status).phase;
  return (
    !pod.metadata.deletionTimestamp &&
    phase !== "Succeeded" &&
    phase !== "Failed"
  );
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
  request: typeof fetch = fetch,
): Promise<FleetNodeReleaseObservation[]> {
  const started = now();
  const stop = () => signal?.aborted || now() - started >= 20_000;
  if (stop()) return [];
  const pods = await k8s.list("Pod");
  const chartPins = desired.release.spec.components.filter(
      (v) => v.kind === "chart",
    ),
    charts: FleetNodeReleaseObservation["facts"]["components"] = [];
  let platformCommit: string | undefined;
  if (chartPins.length || desired.release.spec.platform_source_commit) {
    const namespace = await k8s.read("Namespace", undefined, "flux-system");
    if (
      namespace?.metadata.uid &&
      !namespace.metadata.deletionTimestamp &&
      !stop()
    ) {
      const reads = await Promise.allSettled([
        k8s.list("HelmRelease", "flux-system"),
        k8s.list("OCIRepository", "flux-system"),
        k8s.list("HelmChart", "flux-system"),
        k8s.read("GitRepository", "flux-system", "pgcf-platform"),
        k8s.read("Kustomization", "flux-system", "pgcf-platform"),
        k8s.read("Kustomization", "flux-system", "pgcf-regional"),
      ]);
      const after = await k8s.read("Namespace", undefined, "flux-system");
      if (
        reads.every((v) => v.status === "fulfilled") &&
        after?.metadata.uid === namespace.metadata.uid &&
        !after.metadata.deletionTimestamp &&
        !stop()
      ) {
        const values = reads.map(
            (v) =>
              (v as PromiseFulfilledResult<Resource[] | Resource | null>).value,
          ),
          releases = values[0] as Resource[],
          sources = values[1] as Resource[],
          artifacts = values[2] as Resource[];
        for (const pin of chartPins) {
          const name =
              pin.name === "chart/plugin-barman-cloud"
                ? "plugin-barman-cloud"
                : pin.name,
            release = releases.find((v) => v.metadata.name === name),
            sourceName = record(record(release?.spec).chartRef).name,
            chartRef = string(record(release?.status).helmChart);
          const observed = fleetChartObservation(
            pin,
            release,
            sources.find((v) => v.metadata.name === sourceName),
            artifacts.find(
              (v) => `${v.metadata.namespace}/${v.metadata.name}` === chartRef,
            ),
          );
          if (observed) charts.push(observed);
        }
        const source = values[3] as Resource | null,
          platform = values[4] as Resource | null,
          regional = values[5] as Resource | null,
          target = desired.release.spec.platform_source_commit;
        if (
          target &&
          fleetFluxReady(source) &&
          fleetFluxReady(platform) &&
          fleetFluxReady(regional) &&
          record(record(source?.spec).ref).commit === target &&
          [
            record(record(source?.status).artifact).revision,
            record(platform?.status).lastAppliedRevision,
            record(regional?.status).lastAppliedRevision,
          ].every((v) => typeof v === "string" && v.endsWith(`sha1:${target}`))
        )
          platformCommit = target;
      }
    }
  }
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
      bootId = string(information.bootID),
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
    components.push(...charts.filter((v) => wanted.has(v.name)));
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
            (ownership.scope === "cluster" ||
              record(pod.spec).nodeName === assignment.k8s_node_name) &&
            activePod(pod) &&
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
      const carriers = new Map<string, Resource>();
      const canonicalDigests = new Set<string>();
      let qualified = validBootId(bootId);
      for (const { pod, status } of candidates) {
        const reported = digest(status?.imageID)!;
        if (reported === component.sha256) {
          canonicalDigests.add(reported);
          continue;
        }
        const name = string(record(pod.spec).nodeName);
        let carrier = name ? carriers.get(name) : undefined;
        if (name && !carrier) {
          carrier =
            name === assignment.k8s_node_name
              ? node
              : ((await k8s.read("Node", undefined, name)) ?? undefined);
          if (carrier) carriers.set(name, carrier);
        }
        const info = record(record(carrier?.status).nodeInfo);
        const normalized =
          carrier?.metadata.uid &&
          !carrier.metadata.deletionTimestamp &&
          ready(carrier) &&
          info.operatingSystem === "linux" &&
          info.architecture === "amd64" &&
          validBootId(bootId) &&
          validBootId(info.bootID)
            ? await normalizeRuntimeImageManifest(
                component.reference,
                component.sha256,
                reported,
                { request, signal },
              )
            : undefined;
        if (normalized) canonicalDigests.add(normalized);
        else qualified = false;
      }
      const runtimeDigest =
        runtimeDigests.size === 1 ? [...runtimeDigests][0]! : undefined;
      if (!qualified && !runtimeDigest) continue;
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
          !activePod(fresh) ||
          controllerUid(fresh) !== controllerUid(pod) ||
          Object.entries(ownership.selector).some(
            ([key, value]) => fresh.metadata.labels?.[key] !== value,
          ) ||
          (ownership.scope !== "cluster" &&
            record(fresh.spec).nodeName !== assignment.k8s_node_name) ||
          record(fresh.spec).nodeName !== record(pod.spec).nodeName ||
          !Array.isArray(record(fresh.spec).containers) ||
          !(record(fresh.spec).containers as unknown[]).some(
            (value) =>
              record(value).name === container.name &&
              record(value).image === container.image,
          ) ||
          freshStatus?.ready !== true ||
          freshStatus.imageID !== status?.imageID ||
          freshStatus.restartCount !== status?.restartCount
        ) {
          stable = false;
          break;
        }
      }
      for (const [name, carrier] of carriers) {
        const fresh = await k8s.read("Node", undefined, name);
        if (
          !fresh ||
          fresh.metadata.uid !== carrier.metadata.uid ||
          fresh.metadata.deletionTimestamp ||
          !ready(fresh) ||
          ["bootID", "architecture", "operatingSystem"].some(
            (key) =>
              record(record(fresh.status).nodeInfo)[key] !==
              record(record(carrier.status).nodeInfo)[key],
          )
        )
          stable = false;
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
          ...(runtimeDigest ? { runtime_image_sha256: runtimeDigest } : {}),
          ...(qualified &&
          canonicalDigests.size === 1 &&
          canonicalDigests.has(component.sha256)
            ? { version: component.version, sha256: component.sha256 }
            : {}),
        });
    }
    const controlPlane = [
      "node-role.kubernetes.io/control-plane",
      "node-role.kubernetes.io/master",
    ].some((key) => Object.hasOwn(node.metadata.labels ?? {}, key));
    let staticImages: FleetNodeReleaseObservation["facts"]["kubernetes_static_images"];
    if (controlPlane) {
      staticImages = {};
      const ns = await k8s.read("Namespace", undefined, "kube-system");
      if (ns?.metadata.uid && !ns.metadata.deletionTimestamp)
        for (const [name, label] of Object.entries({
          apiServer: "kube-apiserver",
          controllerManager: "kube-controller-manager",
          scheduler: "kube-scheduler",
        }) as ["apiServer" | "controllerManager" | "scheduler", string][]) {
          if (stop()) return result;
          const candidates = pods.filter(
            (pod) =>
              pod.metadata.namespace === "kube-system" &&
              pod.metadata.labels?.component === label &&
              record(pod.spec).nodeName === assignment.k8s_node_name &&
              activePod(pod) &&
              controllerUid(pod) === assignment.node_uid,
          );
          if (candidates.length !== 1) continue;
          const original = candidates[0]!,
            fresh = await k8s.read(
              "Pod",
              "kube-system",
              original.metadata.name,
            ),
            statuses = record(fresh?.status).containerStatuses,
            oldStatuses = record(original.status).containerStatuses;
          if (
            !fresh ||
            fresh.metadata.uid !== original.metadata.uid ||
            !activePod(fresh) ||
            controllerUid(fresh) !== assignment.node_uid ||
            record(fresh.spec).nodeName !== assignment.k8s_node_name ||
            !Array.isArray(statuses) ||
            statuses.length !== 1 ||
            !Array.isArray(oldStatuses) ||
            oldStatuses.length !== 1
          )
            continue;
          const current = record(statuses[0]),
            oldStatus = record(oldStatuses[0]),
            sha = digest(current.imageID);
          if (
            current.ready === true &&
            record(record(current.state).running).startedAt &&
            sha &&
            current.imageID === oldStatus.imageID &&
            current.restartCount === oldStatus.restartCount
          ) {
            const expected =
              desired.release.spec.roles[assignment.role].kubernetes_images?.[
                name
              ];
            const normalized =
              expected &&
              validBootId(bootId) &&
              information.operatingSystem === "linux" &&
              information.architecture === "amd64"
                ? await normalizeRuntimeImageManifest(
                    expected,
                    expected.slice(-64),
                    sha,
                    { request, signal },
                  )
                : undefined;
            staticImages[name] = normalized ?? sha;
          }
        }
      const afterNamespace = await k8s.read(
        "Namespace",
        undefined,
        "kube-system",
      );
      if (
        !ns ||
        afterNamespace?.metadata.uid !== ns.metadata.uid ||
        afterNamespace?.metadata.deletionTimestamp
      )
        staticImages = {};
    }
    const after = await k8s.read("Node", undefined, assignment.k8s_node_name);
    if (
      !after ||
      after.metadata.uid !== assignment.node_uid ||
      after.metadata.deletionTimestamp ||
      !ready(after) ||
      [
        "node-role.kubernetes.io/control-plane",
        "node-role.kubernetes.io/master",
      ].some((key) => Object.hasOwn(after.metadata.labels ?? {}, key)) !==
        controlPlane ||
      [
        "kubeletVersion",
        "osImage",
        "bootID",
        "systemUUID",
        "machineID",
        "containerRuntimeVersion",
        "kernelVersion",
        "architecture",
        "operatingSystem",
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
          configuration_schema_revision: CONFIGURATION_SCHEMA_REVISION,
          ...(platformCommit ? { platform_source_commit: platformCommit } : {}),
          ...(validBootId(bootId) ? { boot_id: bootId } : {}),
          ...(kubeVersion
            ? { kubernetes_version: kubeVersion, kubelet_version: kubeVersion }
            : {}),
          kubernetes_control_plane: controlPlane,
          ...(staticImages ? { kubernetes_static_images: staticImages } : {}),
          ...(talosVersion ? { talos_version: talosVersion } : {}),
          components,
        },
      }),
    );
  }
  return result;
}
