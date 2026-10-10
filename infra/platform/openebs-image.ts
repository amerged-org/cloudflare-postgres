// SPDX-License-Identifier: Apache-2.0
// One release-selected driver reference, shared by installers and observations.
function openEbsChart(lock: unknown) {
  const charts = (lock as { charts?: unknown[] } | null)?.charts;
  const matches = Array.isArray(charts)
    ? charts.filter(
        (value) => (value as { name?: unknown })?.name === "openebs",
      )
    : [];
  if (matches.length !== 1)
    throw new Error("openebs_chart_missing_or_ambiguous");
  return matches[0] as {
    enabledEngine?: { driverImage?: unknown };
    renderedImages?: unknown[];
  };
}
export function openEbsDriverImage(lock: unknown): string {
  const chart = openEbsChart(lock);
  const selected = chart.enabledEngine?.driverImage;
  if (selected !== undefined) {
    if (
      typeof selected !== "string" ||
      !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(selected)
    )
      throw new Error("openebs_selected_driver_image_invalid");
    openEbsDriverValues(selected);
    return selected;
  }
  const legacy = chart?.renderedImages?.filter(
    (value): value is string =>
      typeof value === "string" && /(?:^|\/)lvm-driver:[^\s]+$/.test(value),
  );
  if (legacy?.length !== 1)
    throw new Error("openebs_driver_image_missing_or_ambiguous");
  return legacy[0]!;
}

export function selectedOpenEbsDriverImage(lock: unknown): string | undefined {
  const chart = openEbsChart(lock);
  return chart.enabledEngine?.driverImage === undefined
    ? undefined
    : openEbsDriverImage(lock);
}

export function openEbsDriverValues(reference: string) {
  const match = /^([^/]+)\/(.+):([^:@/]+@sha256:[a-f0-9]{64})$/.exec(reference);
  if (!match) throw new Error("openebs_selected_driver_image_invalid");
  return { registry: match[1]!, repository: match[2]!, tag: match[3]! };
}

/** Pinned VAC QoS writes the real Pod cgroup; the existing privileged driver needs the host view. */
export function openEbsCgroupPostRenderers() {
  return [
    {
      kustomize: {
        patches: [
          {
            target: {
              group: "apps",
              version: "v1",
              kind: "DaemonSet",
              name: "openebs-lvm-localpv-node",
            },
            patch: JSON.stringify({
              apiVersion: "apps/v1",
              kind: "DaemonSet",
              metadata: {
                name: "openebs-lvm-localpv-node",
              },
              spec: {
                template: {
                  spec: {
                    volumes: [
                      {
                        name: "pgcf-host-cgroup",
                        hostPath: { path: "/sys/fs/cgroup", type: "Directory" },
                      },
                    ],
                    containers: [
                      {
                        name: "openebs-lvm-plugin",
                        volumeMounts: [
                          {
                            name: "pgcf-host-cgroup",
                            mountPath: "/sys/fs/cgroup",
                            readOnly: false,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            }),
          },
        ],
      },
    },
  ];
}

export function openEbsCgroupReadback(raw: unknown): boolean {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const spec = object(object(object(object(raw).spec).template).spec),
    volumes = spec.volumes,
    containers = spec.containers;
  if (!Array.isArray(volumes) || !Array.isArray(containers)) return false;
  const volume = volumes
      .map(object)
      .find((volume) => volume.name === "pgcf-host-cgroup"),
    driver = containers
      .map(object)
      .find((container) => container.name === "openebs-lvm-plugin");
  if (
    !volume ||
    !driver ||
    object(volume.hostPath).path !== "/sys/fs/cgroup" ||
    object(volume.hostPath).type !== "Directory" ||
    object(driver.securityContext).privileged !== true ||
    !Array.isArray(driver.volumeMounts)
  )
    return false;
  return (
    driver.volumeMounts
      .map(object)
      .filter(
        (mount) =>
          mount.name === volume.name &&
          mount.mountPath === "/sys/fs/cgroup" &&
          mount.readOnly !== true,
      ).length === 1
  );
}
