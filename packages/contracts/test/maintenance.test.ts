// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MAINTENANCE_ROLE, MaintenanceCredential } from "../src/maintenance.ts";
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
});
