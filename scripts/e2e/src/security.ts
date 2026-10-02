// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  items,
  objectName,
  objectNamespace,
  record,
} from "./core.ts";

/** Cilium and Kubernetes control-plane host networking is platform infrastructure. */
export function networkingAudit(
  workloads: readonly unknown[],
  services: unknown,
  regionalNamespace: string,
): Record<string, number> {
  let checked = 0,
    platformExceptions = 0;
  for (const value of workloads) {
    for (const object of items(value)) {
      const namespace = objectNamespace(object);
      const topSpec = record(object.spec);
      const spec = topSpec.template
        ? record(record(topSpec.template).spec)
        : topSpec;
      const trustedSystem =
        namespace === "kube-system" &&
        (/^cilium(?:-|$)/.test(objectName(object)) ||
          /^kube-(?:apiserver|controller-manager|scheduler)-/.test(
            objectName(object),
          ));
      if (trustedSystem && spec.hostNetwork === true) platformExceptions++;
      if (!namespace.startsWith("pgcf-db-") && namespace !== regionalNamespace)
        continue;
      checked++;
      if (spec.hostNetwork === true)
        throw new HarnessError("pgcf_host_network");
      for (const field of [
        "containers",
        "initContainers",
        "ephemeralContainers",
      ]) {
        if (!Array.isArray(spec[field])) continue;
        for (const container of (spec[field] as unknown[]).map(record)) {
          if (
            Array.isArray(container.ports) &&
            container.ports
              .map(record)
              .some((port) => Number(port.hostPort ?? 0) !== 0)
          )
            throw new HarnessError("pgcf_host_port");
        }
      }
    }
  }
  for (const service of items(services)) {
    const namespace = objectNamespace(service);
    if (!namespace.startsWith("pgcf-db-") && namespace !== regionalNamespace)
      continue;
    const spec = record(service.spec);
    if (
      ["NodePort", "LoadBalancer"].includes(String(spec.type)) ||
      (Array.isArray(spec.externalIPs) && spec.externalIPs.length > 0)
    )
      throw new HarnessError("pgcf_public_service");
  }
  return {
    workload_count: checked,
    trusted_platform_exceptions: platformExceptions,
  };
}
