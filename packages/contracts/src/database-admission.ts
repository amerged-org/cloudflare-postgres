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
export const DatabaseAdmission = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), region: DatabaseRegionRoute }),
  z.strictObject({
    ok: z.literal(false),
    sqlstate: z.enum(["3D000", "28P01", "57P03", "08006", "53300"]),
  }),
]);
export type DatabaseAdmission = z.infer<typeof DatabaseAdmission>;
