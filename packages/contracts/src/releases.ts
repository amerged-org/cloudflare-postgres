// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, RegionId } from "./ids.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Version = z.string().regex(/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
export const FleetReleaseId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/);
export const FleetNodeRole = z.enum(["control_relay", "customer"]);
export const FleetComponentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/);
export const FleetReleaseComponent = z.strictObject({
  name: FleetComponentName,
  kind: z.enum(["image", "chart", "worker_bundle"]),
  version: z.string().min(1).max(128),
  reference: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\s\p{C}]+$/u),
  sha256: Sha256,
  workload: z
    .strictObject({
      namespace: z
        .string()
        .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
        .max(63),
      selector: z
        .record(z.string().min(1).max(253), z.string().max(63))
        .refine((value) => Object.keys(value).length > 0),
      scope: z.enum(["node", "cluster"]).optional(),
    })
    .optional(),
});
export type FleetReleaseComponent = z.infer<typeof FleetReleaseComponent>;
export const FleetKubernetesImages = z.strictObject({
  kubelet: z.string().regex(/^[^\s@]+:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/),
  apiServer: z.string().regex(/^[^\s@]+:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/),
  controllerManager: z
    .string()
    .regex(/^[^\s@]+:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/),
  scheduler: z.string().regex(/^[^\s@]+:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/),
});
export const FleetKubernetesImageFacts = z.strictObject({
  kubelet: z.strictObject({
    configuration: z.string().max(512),
    runtime_sha256: Sha256,
  }),
  apiServer: z
    .strictObject({
      configuration: z.string().max(512),
      runtime_sha256: Sha256,
    })
    .optional(),
  controllerManager: z
    .strictObject({
      configuration: z.string().max(512),
      runtime_sha256: Sha256,
    })
    .optional(),
  scheduler: z
    .strictObject({
      configuration: z.string().max(512),
      runtime_sha256: Sha256,
    })
    .optional(),
});
const Role = z.strictObject({
  host_configuration_required: z.boolean().optional(),
  kubernetes_images: FleetKubernetesImages.optional(),
  talos_version: Version,
  talos_installer: z
    .string()
    .max(512)
    .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
  talos_schematic_sha256: Sha256,
  talos_extensions: z.array(FleetComponentName).max(32),
  kubernetes_version: Version,
  components: z.array(FleetComponentName).min(1).max(128),
});
/** Root records actual backend acceptance once for this complete finite profile and software. */
export const ThinStorageQualification = z.strictObject({
  /** Full canonical ThinStorageProfile hash; the PVC class uses a separate volume-settings hash. */
  profile_sha256: Sha256,
  driver_image: z
    .string()
    .max(512)
    .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
  host_extension_image: z
    .string()
    .max(512)
    .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
  kernel_version: z
    .string()
    .max(128)
    .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  receipt_sha256: Sha256,
  qualified_at: z.iso.datetime(),
  gates: z.strictObject({
    data_full: z.literal(true),
    metadata_full: z.literal(true),
    noflush_quiescence: z.literal(true),
    resume_marker: z.literal(true),
    startup_bound: z.literal(true),
    trim_delete_recreate: z.literal(true),
    retained_thick_preservation: z.literal(true),
  }),
});
export type ThinStorageQualification = z.infer<typeof ThinStorageQualification>;
export const FleetReleaseSpec = z
  .strictObject({
    version: z.literal(1),
    versions_lock_sha256: Sha256,
    configuration_schema_revision: z.number().int().min(1).max(2147483647),
    platform_source_commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    storage_authority_keys_sha256: Sha256.optional(),
    thin_storage_qualification: ThinStorageQualification.optional(),
    components: z.array(FleetReleaseComponent).min(1).max(128),
    roles: z.strictObject({ control_relay: Role, customer: Role }),
  })
  .superRefine((spec, context) => {
    if (
      spec.roles.control_relay.talos_version.replace(/^v/, "") !==
        spec.roles.customer.talos_version.replace(/^v/, "") ||
      spec.roles.control_relay.kubernetes_version.replace(/^v/, "") !==
        spec.roles.customer.kubernetes_version.replace(/^v/, "")
    )
      context.addIssue({
        code: "custom",
        message: "Shared runtime versions must match across roles",
      });
    for (const component of spec.components) {
      if (
        component.kind === "image" &&
        !component.reference.endsWith(`@sha256:${component.sha256}`)
      )
        context.addIssue({
          code: "custom",
          message: "Image reference must pin its declared digest",
        });
    }
    if (spec.thin_storage_qualification) {
      if (!thinStorageReleaseGuardPinned(spec))
        context.addIssue({
          code: "custom",
          message:
            "Thin storage requires the pinned verifier and native gateway on every role",
        });
      const q = spec.thin_storage_qualification;
      for (const [name, reference] of [
        ["openebs-lvm", q.driver_image],
        ["pgcf-sandbox-controller", q.host_extension_image],
      ]) {
        const component = spec.components.find((value) => value.name === name);
        if (
          !component ||
          component.kind !== "image" ||
          component.reference !== reference ||
          !reference.endsWith("@sha256:" + component.sha256)
        )
          context.addIssue({
            code: "custom",
            message:
              "Physical storage qualification must bind the same release images",
          });
      }
      if (
        Object.values(spec.roles).some(
          (role) =>
            !role.host_configuration_required ||
            !role.talos_extensions.includes("pgcf-sandbox-controller") ||
            !role.components.includes("openebs-lvm"),
        )
      )
        context.addIssue({
          code: "custom",
          message:
            "Qualified physical storage requires the pinned host guard on every role",
        });
    }
    const names = new Set(spec.components.map((component) => component.name));
    if (names.size !== spec.components.length)
      context.addIssue({
        code: "custom",
        message: "Duplicate release component",
      });
    for (const role of Object.values(spec.roles)) {
      if (
        role.kubernetes_images &&
        Object.values(role.kubernetes_images).some(
          (reference) =>
            /:v([0-9]+\.[0-9]+\.[0-9]+)@sha256:/.exec(reference)?.[1] !==
            role.kubernetes_version.replace(/^v/, ""),
        )
      )
        context.addIssue({
          code: "custom",
          message:
            "Kubernetes image pins must match the declared runtime version",
        });
      if (
        new Set(role.components).size !== role.components.length ||
        new Set(role.talos_extensions).size !== role.talos_extensions.length
      )
        context.addIssue({
          code: "custom",
          message: "Duplicate role component",
        });
      for (const name of [...role.components, ...role.talos_extensions])
        if (!names.has(name))
          context.addIssue({
            code: "custom",
            message: "Unknown role component",
          });
    }
    // A release must describe each product layer, not just a matching Regional tag.
    for (const required of [
      "api",
      "edge",
      "node-bootstrap",
      ...(names.has("native-controller") && names.has("native-gateway")
        ? []
        : ["regional"]),
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
    ])
      if (!names.has(required))
        context.addIssue({
          code: "custom",
          message: `Missing release component: ${required}`,
        });
    const used = new Set(
      Object.values(spec.roles).flatMap((role) => [
        ...role.components,
        ...role.talos_extensions,
      ]),
    );
    for (const name of names)
      if (
        !used.has(name) &&
        ![
          "api",
          "edge",
          "node-bootstrap",
          "postgres",
          "barman",
          "sandbox-controller",
          "image/cert-manager/cert-manager-startupapicheck",
        ].includes(name)
      )
        context.addIssue({
          code: "custom",
          message: "Unassigned release component",
        });
  });
export type FleetReleaseSpec = z.infer<typeof FleetReleaseSpec>;
/** Thin qualification and retained requalification share the same mandatory runtime boundary. */
export function thinStorageReleaseGuardPinned(spec: FleetReleaseSpec): boolean {
  return Boolean(
    spec.storage_authority_keys_sha256 &&
    ["native-gateway", "pgcf-sandbox-controller", "openebs-lvm"].every((name) =>
      spec.components.some(
        (c) =>
          c.name === name &&
          c.kind === "image" &&
          c.reference.endsWith("@sha256:" + c.sha256),
      ),
    ) &&
    Object.values(spec.roles).every(
      (role) =>
        role.host_configuration_required &&
        role.talos_extensions.includes("pgcf-sandbox-controller") &&
        role.components.includes("native-gateway") &&
        role.components.includes("openebs-lvm"),
    ),
  );
}
export const FleetRelease = z.strictObject({
  id: FleetReleaseId,
  spec: FleetReleaseSpec,
  spec_sha256: Sha256,
  approved_at: z.iso.datetime(),
});
export type FleetRelease = z.infer<typeof FleetRelease>;
export const FleetRegionReleaseUpdate = z.strictObject({
  expected_revision: z.number().int().min(0).max(2147483646),
  release_id: FleetReleaseId,
});
export type FleetRegionReleaseUpdate = z.infer<typeof FleetRegionReleaseUpdate>;
export const FleetNodeReleaseUpdate = FleetRegionReleaseUpdate.extend({
  node_uid: z.uuid(),
  role: FleetNodeRole,
});
export type FleetNodeReleaseUpdate = z.infer<typeof FleetNodeReleaseUpdate>;
export const FleetReleaseFacts = z
  .strictObject({
    boot_id: z.uuid().optional(),
    platform_source_commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    talos_provenance: z
      .strictObject({
        method: z.literal("deploymentreceipt"),
        installer: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
        node_uid: z.uuid(),
        cluster_uid: z.uuid(),
        boot_id: z.uuid(),
      })
      .optional(),
    configuration_schema_revision: z
      .number()
      .int()
      .min(1)
      .max(2147483647)
      .optional(),
    talos_version: Version.optional(),
    talos_installer: z
      .string()
      .max(512)
      .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/)
      .optional(),
    talos_schematic_sha256: Sha256.optional(),
    runtime_image_sha256: Sha256.optional(),
    kubernetes_version: Version.optional(),
    kubelet_version: Version.optional(),
    kubernetes_control_plane: z.boolean().optional(),
    kubernetes_static_images: z
      .strictObject({
        apiServer: Sha256.optional(),
        controllerManager: Sha256.optional(),
        scheduler: Sha256.optional(),
      })
      .optional(),
    kubernetes_image_provenance: z
      .strictObject({
        method: z.enum([
          "native_runtime_readback",
          "pinned_configuration_boot",
        ]),
        configuration_boot_id: z.uuid().optional(),
        configuration_observed_at: z.iso.datetime().optional(),
        observed_at: z.iso.datetime(),
        kubelet_version: Version,
        control_plane: z.boolean(),
        images: FleetKubernetesImageFacts,
      })
      .optional(),
    components: z
      .array(
        z.strictObject({
          name: FleetComponentName,
          version: z.string().min(1).max(128).optional(),
          sha256: Sha256.optional(),
          runtime_image_sha256: Sha256.optional(),
        }),
      )
      .max(128),
  })
  .superRefine((value, context) => {
    const proof = value.kubernetes_image_provenance;
    if (
      proof?.method === "pinned_configuration_boot" &&
      (!proof.configuration_boot_id ||
        !proof.configuration_observed_at ||
        proof.configuration_boot_id === value.boot_id)
    )
      context.addIssue({
        code: "custom",
        message:
          "Pinned Kubernetes image provenance requires the earlier actual configuration boot boundary",
      });
    if (
      new Set(value.components.map((component) => component.name)).size !==
      value.components.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate observed component",
      });
  });
export type FleetReleaseFacts = z.infer<typeof FleetReleaseFacts>;
function fleetRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function fleetFluxReady(value: unknown): boolean {
  const metadata = fleetRecord(fleetRecord(value).metadata),
    status = fleetRecord(fleetRecord(value).status),
    conditions = status.conditions;
  return (
    Number.isInteger(metadata.generation) &&
    Number(metadata.generation) > 0 &&
    status.observedGeneration === metadata.generation &&
    Array.isArray(conditions) &&
    conditions.some((v) => {
      const c = fleetRecord(v);
      return (
        c.type === "Ready" &&
        c.status === "True" &&
        c.observedGeneration === metadata.generation
      );
    }) &&
    !conditions.some((v) => {
      const c = fleetRecord(v);
      return (
        ["Stalled", "Reconciling"].includes(String(c.type)) &&
        c.status === "True"
      );
    })
  );
}
/** Flux adds OCI build metadata to chart versions; the applied source digest is checked independently. */
export function fleetChartVersionMatches(
  actual: unknown,
  wanted: string,
): boolean {
  if (typeof actual !== "string") return false;
  const a = actual.replace(/^v/, ""),
    w = wanted.replace(/^v/, "");
  return a === w || a.startsWith(`${w}+`) || a.startsWith(`${w}@sha256:`);
}
export function fleetChartObservation(
  pin: FleetReleaseComponent,
  release: unknown,
  source: unknown,
  chart: unknown,
): FleetReleaseFacts["components"][number] | null {
  if (pin.kind !== "chart" || !fleetFluxReady(release)) return null;
  const value = fleetRecord(release),
    status = fleetRecord(value.status),
    history = status.history;
  if (
    !Array.isArray(history) ||
    !history.length ||
    !fleetChartVersionMatches(fleetRecord(history[0]).chartVersion, pin.version)
  )
    return null;
  if (pin.reference.startsWith("oci://")) {
    const s = fleetRecord(source),
      spec = fleetRecord(s.spec),
      artifact = fleetRecord(fleetRecord(s.status).artifact);
    if (
      !fleetFluxReady(source) ||
      spec.url !== pin.reference.split("@")[0] ||
      fleetRecord(spec.ref).digest !== `sha256:${pin.sha256}` ||
      !String(artifact.revision ?? "").endsWith(`sha256:${pin.sha256}`) ||
      fleetRecord(history[0]).ociDigest !== `sha256:${pin.sha256}` ||
      fleetRecord(history[0]).status !== "deployed"
    )
      return null;
  } else if (
    !fleetFluxReady(chart) ||
    fleetRecord(fleetRecord(fleetRecord(chart).status).artifact).digest !==
      `sha256:${pin.sha256}`
  )
    return null;
  return { name: pin.name, version: pin.version, sha256: pin.sha256 };
}
export const FleetNodeReleaseObservation = z.strictObject({
  node_id: NodeId,
  node_uid: z.uuid(),
  assignment_revision: z.number().int().min(1).max(2147483647),
  observed_at: z.iso.datetime(),
  facts: FleetReleaseFacts,
});
export type FleetNodeReleaseObservation = z.infer<
  typeof FleetNodeReleaseObservation
>;
export const FleetRegionReleaseStatus = z.strictObject({
  region_id: RegionId,
  revision: z.number().int().min(0),
  desired_release_id: FleetReleaseId.nullable(),
  updated_at: z.iso.datetime().nullable(),
});
export const FleetNodeReleaseStatus = z.strictObject({
  node_id: NodeId,
  region_id: RegionId,
  node_uid: z.uuid().nullable(),
  revision: z.number().int().min(0),
  role: FleetNodeRole.nullable(),
  desired_release_id: FleetReleaseId.nullable(),
  desired_spec_sha256: Sha256.nullable(),
  state: z.enum([
    "unassigned",
    "pending",
    "stale",
    "identity_changed",
    "drifted",
    "converged",
  ]),
  observed_at: z.iso.datetime().nullable(),
  observed_facts: FleetReleaseFacts.nullable(),
  mismatches: z.array(z.string().max(256)),
});
export type FleetNodeReleaseStatus = z.infer<typeof FleetNodeReleaseStatus>;

export const FleetDesiredRelease = z.strictObject({
  region_id: RegionId,
  region_revision: z.number().int().min(1).max(2147483647),
  release: FleetRelease,
  nodes: z
    .array(
      z.strictObject({
        node_id: NodeId,
        node_uid: z.uuid(),
        k8s_node_name: z.string().min(1).max(253),
        role: FleetNodeRole,
        revision: z.number().int().min(1).max(2147483647),
      }),
    )
    .max(1000),
});
export type FleetDesiredRelease = z.infer<typeof FleetDesiredRelease>;
