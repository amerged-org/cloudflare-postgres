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
 * The verified connection target: the route revision whose readiness the regional controller
 * verified and Cloudflare committed, and that revision's primary Pod. The Edge signs both into
 * the route token; the gateway dials only that Pod while its fence is that revision.
 */
export const DatabaseTarget = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pod_uid: z.uuid(),
});
export type DatabaseTarget = z.infer<typeof DatabaseTarget>;
export const DatabaseAdmission = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    region: DatabaseRegionRoute,
    /** Temporary rollout compatibility (route-token.ts): absent without a verified target. */
    target: DatabaseTarget.optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    sqlstate: z.enum(["3D000", "28P01", "57P03", "08006", "53300"]),
  }),
]);
export type DatabaseAdmission = z.infer<typeof DatabaseAdmission>;
