// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("defaults existing memberships and normalizes retained credentials without changing their attributes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE roles(name TEXT PRIMARY KEY); CREATE TABLE retained_archives(roles_json TEXT NOT NULL)",
    );
    db.exec("INSERT INTO roles(name) VALUES('reader')");
    const retained = [
      {
        database_id: "source",
        name: "reader",
        updated_at: "old",
        member_of: ["base"],
        password_ciphertext: "retained-ciphertext",
        password_iv: "retained-iv",
        password_kid: "key1",
        password_revision: 5,
        bypass_rls: 0,
      },
      {
        database_id: "source",
        name: "legacy",
        updated_at: "old",
        password_ciphertext: "legacy-ciphertext",
      },
    ];
    db.prepare("INSERT INTO retained_archives VALUES(?)").run(
      JSON.stringify(retained),
    );
    db.exec(
      readFileSync(
        new URL(
          "../../../apps/api/migrations/0091_role_membership_options.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT membership_options FROM roles").get()).toEqual({
      membership_options: 3,
    });
    expect(
      JSON.parse(
        db.prepare("SELECT roles_json FROM retained_archives").get()!
          .roles_json as string,
      ),
    ).toEqual(
      retained.map((role) =>
        Object.fromEntries(
          Object.entries(role).filter(
            ([name]) => name !== "database_id" && name !== "updated_at",
          ),
        ),
      ),
    );
    for (const invalid of [-1, 4, 1.5, null])
      expect(() =>
        db.prepare("UPDATE roles SET membership_options=?").run(invalid),
      ).toThrow();
    db.prepare("UPDATE roles SET membership_options=?").run(2);
    expect(db.prepare("SELECT membership_options FROM roles").get()).toEqual({
      membership_options: 2,
    });
  } finally {
    db.close();
  }
});
