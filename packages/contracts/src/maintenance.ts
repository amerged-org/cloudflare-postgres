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

// Function privileges are database-local; run this only in the fresh application bootstrap.
export const MAINTENANCE_BOOTSTRAP_SQL = Object.freeze([
  `CREATE ROLE ${MAINTENANCE_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  `GRANT pg_read_all_stats TO ${MAINTENANCE_ROLE}`,
  `GRANT EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() TO ${MAINTENANCE_ROLE}`,
  `GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_archive_statusdir() TO ${MAINTENANCE_ROLE}`,
]);
