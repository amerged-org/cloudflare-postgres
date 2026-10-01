// SPDX-License-Identifier: Apache-2.0
import { posix } from "node:path";
import {
  safeObserverPodSpec,
  validNodeObserverConfig,
} from "./node-observer.ts";
import type { NodeObserverConfiguration } from "./node-observer.ts";
import type { NodeDeliveryConfiguration } from "./node-delivery.ts";

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>) =>
  Object.keys(v).filter((k) => v[k] !== undefined);
const exact = (v: unknown, names: string[]): v is Record<string, unknown> =>
  object(v) &&
  keys(v).length === names.length &&
  names.every((k) => Object.hasOwn(v, k));
const encoded = (v: unknown) => JSON.stringify(v);
export function observerView(
  config: NodeDeliveryConfiguration,
): NodeObserverConfiguration {
  return {
    installationId: config.installationId,
    regionId: config.regionId,
    observerNamespace: config.deliveryNamespace,
    observerNamespaceUid: config.deliveryNamespaceUid,
    owner: config.owner,
    image: config.image,
    peers: config.peers,
  };
}
export function validDeliveryConfiguration(
  value: unknown,
): value is NodeDeliveryConfiguration {
  if (
    !exact(value, [
      "installationId",
      "regionId",
      "deliveryNamespace",
      "deliveryNamespaceUid",
      "owner",
      "image",
      "peers",
      "kubeletRoot",
    ]) ||
    typeof value.kubeletRoot !== "string" ||
    !posix.isAbsolute(value.kubeletRoot) ||
    value.kubeletRoot === "/" ||
    posix.normalize(value.kubeletRoot) !== value.kubeletRoot ||
    value.kubeletRoot.length > 256
  )
    return false;
  return validNodeObserverConfig(
    observerView(value as unknown as NodeDeliveryConfiguration),
  );
}

// Validate only the code-owned delivery differences, then inherit the existing
// observation constraints. No caller-provided writeEnabled/spec predicate.
export function deliveryPeerProfile(root: string) {
  return {
    component: "node-execution-delivery",
    containerName: "delivery",
    safeSpec(
      value: unknown,
      config: NodeObserverConfiguration,
      nodeName?: string,
    ): boolean {
      if (
        !object(value) ||
        !Array.isArray(value.containers) ||
        value.containers.length !== 1 ||
        !Array.isArray(value.volumes) ||
        value.volumes.length !== 2
      )
        return false;
      const c = value.containers[0];
      if (
        !object(c) ||
        c.name !== "delivery" ||
        encoded(c.command) !== encoded(["/node-execution-delivery"]) ||
        encoded(c.args) !== encoded(["agent"]) ||
        !object(c.securityContext) ||
        !object(c.securityContext.capabilities) ||
        encoded(c.securityContext.capabilities.add) !==
          encoded(["CHOWN", "DAC_OVERRIDE"]) ||
        !Array.isArray(c.volumeMounts) ||
        c.volumeMounts.length !== 2 ||
        !Array.isArray(c.env)
      )
        return false;
      const volume = value.volumes.find(
          (v) => object(v) && v.name === "kubelet",
        ),
        mount = c.volumeMounts.find((v) => object(v) && v.name === "kubelet");
      if (
        !exact(volume, ["name", "hostPath"]) ||
        !exact(volume.hostPath, ["path", "type"]) ||
        volume.hostPath.path !== root ||
        volume.hostPath.type !== "Directory" ||
        !object(mount) ||
        mount.mountPath !== root ||
        mount.readOnly === true ||
        mount.subPath !== undefined ||
        mount.subPathExpr !== undefined ||
        (mount.mountPropagation !== undefined &&
          mount.mountPropagation !== "None") ||
        keys(mount).some(
          (k) =>
            !["name", "mountPath", "readOnly", "mountPropagation"].includes(k),
        )
      )
        return false;
      if (
        !c.env.every(
          (v) =>
            object(v) &&
            typeof v.name === "string" &&
            v.name.startsWith("PGCF_DELIVERY_"),
        )
      )
        return false;
      const normalized = structuredClone(value);
      const container = (
        normalized.containers as Record<string, unknown>[]
      )[0]!;
      container.name = "observer";
      container.command = ["/node-runtime-observer"];
      const sec = container.securityContext as Record<string, unknown>;
      delete (sec.capabilities as Record<string, unknown>).add;
      container.volumeMounts = (
        container.volumeMounts as Record<string, unknown>[]
      ).filter((m) => m.name !== "kubelet");
      container.env = (container.env as Record<string, unknown>[]).map((v) => ({
        ...v,
        name: String(v.name).replace("PGCF_DELIVERY_", "PGCF_OBSERVER_"),
      }));
      normalized.volumes = (
        normalized.volumes as Record<string, unknown>[]
      ).filter((v) => v.name !== "kubelet");
      return safeObserverPodSpec(normalized, config, nodeName);
    },
  };
}
