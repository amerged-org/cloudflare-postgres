// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_ROLE,
  MAINTENANCE_BOOTSTRAP_SQL,
  MaintenanceCredential,
} from "../src/maintenance.ts";
import { newRolePassword } from "../src/auth.ts";

describe("internal maintenance contracts", () => {
  it("requires the exact role, a valid generated password and a revision", () => {
    const credential = {
      role: MAINTENANCE_ROLE,
      password: newRolePassword(),
      revision: 1,
    };
    expect(MaintenanceCredential.parse(credential)).toEqual(credential);
    expect(
      MaintenanceCredential.safeParse({ ...credential, role: "app" }).success,
    ).toBe(false);
    expect(
      MaintenanceCredential.safeParse({ ...credential, revision: 0 }).success,
    ).toBe(false);
    expect(
      MaintenanceCredential.safeParse({ ...credential, superuser: true })
        .success,
    ).toBe(false);
  });
  it("grants only the proven stats membership and two catalog functions without a password", () => {
    expect(MAINTENANCE_BOOTSTRAP_SQL).toEqual([
      `CREATE ROLE ${MAINTENANCE_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      `GRANT pg_read_all_stats TO ${MAINTENANCE_ROLE}`,
      `GRANT EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() TO ${MAINTENANCE_ROLE}`,
      `GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_archive_statusdir() TO ${MAINTENANCE_ROLE}`,
    ]);
    expect(MAINTENANCE_BOOTSTRAP_SQL.join(";")).not.toMatch(
      /PASSWORD|pg_monitor|pg_read_server_files|CHECKPOINT|TO app/,
    );
  });
});
