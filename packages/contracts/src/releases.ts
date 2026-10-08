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
    })
    .optional(),
});
const Role = z.strictObject({
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
export const FleetReleaseSpec = z
  .strictObject({
    version: z.literal(1),
    versions_lock_sha256: Sha256,
    configuration_schema_revision: z.number().int().min(1).max(2147483647),
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
    const names = new Set(spec.components.map((component) => component.name));
    if (names.size !== spec.components.length)
      context.addIssue({
        code: "custom",
        message: "Duplicate release component",
      });
    for (const role of Object.values(spec.roles)) {
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
      if (!used.has(name) && !["api", "edge", "node-bootstrap"].includes(name))
        context.addIssue({
          code: "custom",
          message: "Unassigned release component",
        });
  });
export type FleetReleaseSpec = z.infer<typeof FleetReleaseSpec>;
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
    if (
      new Set(value.components.map((component) => component.name)).size !==
      value.components.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate observed component",
      });
  });
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
