// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { RolePassword } from "./auth.ts";

export const MAINTENANCE_ROLE = "pgcf_maintenance";
export const MaintenanceCredential = z.strictObject({
  role: z.literal(MAINTENANCE_ROLE),
  password: RolePassword,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type MaintenanceCredential = z.infer<typeof MaintenanceCredential>;
