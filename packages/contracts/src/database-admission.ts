// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { RegionId } from "./ids.ts";

/** The existing DatabaseActor RPC response; Rust Edge consumes its generated schema. */
export const DatabaseRegionRoute = z.strictObject({
  id: RegionId,
  gateway_url: z.url({ protocol: /^https?$/ }).max(2048),
  gateway_binding: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
});
/**
 * The verified database generation and primary Pod, with a separate admission route revision.
 * The Edge signs these identities; the gateway compares them with its persisted running fence.
 */
export const CnpgDatabaseTarget = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pod_uid: z.uuid(),
  /** Independent admission route revision; present only after the v4 fleet gate. */
  route_revision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
export const PoolDatabaseTarget = z.strictObject({
  kind: z.literal("pool"),
  revision: CnpgDatabaseTarget.shape.revision,
  pod_uid: z.uuid(),
  route_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  binding_id: z.uuid(),
  node_uid: z.uuid(),
  pod_ip: z.union([z.ipv4(), z.ipv6()]),
  storage_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const DatabaseTarget = z.union([CnpgDatabaseTarget, PoolDatabaseTarget]);
export type DatabaseTarget = z.infer<typeof DatabaseTarget>;
export type PoolDatabaseTarget = z.infer<typeof PoolDatabaseTarget>;
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DatabaseAdmissionIntent = z.strictObject({
  v: z.literal(1),
  route_revision: Revision,
  admission_epoch: Revision,
});
export type DatabaseAdmissionIntent = z.infer<typeof DatabaseAdmissionIntent>;
/** Persisted beside the running fence only after verified runtime readiness. */
export const GatewayAdmissionTarget = z.strictObject({
  v: z.literal(1),
  generation: Revision,
  route_revision: Revision,
  admission_epoch: Revision,
  pod_uid: z.uuid(),
  container_id: z.string().regex(/^[a-f0-9]{64}$/),
  ca_secret_uid: z.uuid(),
  ca_secret_resource_version: z.string().min(1).max(128),
  ca_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  tls_server_name: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+$/),
});
export type GatewayAdmissionTarget = z.infer<typeof GatewayAdmissionTarget>;
export const DatabaseAdmission = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    region: DatabaseRegionRoute,
    /** Temporary rollout compatibility (route-token.ts): absent only outside a v3 region. */
    target: DatabaseTarget.optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    sqlstate: z.enum(["3D000", "28P01", "57P03", "08006", "53300"]),
  }),
]);
export type DatabaseAdmission = z.infer<typeof DatabaseAdmission>;
