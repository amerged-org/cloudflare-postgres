// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

async function create(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const response = await f.create(name);
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json());
}

describe("suspended rows in Phase 1 desired pages", () => {
  it("omits a suspended row without resuming, deleting or altering its stored state", async () => {
    const f = await fixture(),
      ordered = [await create(f, "first"), await create(f, "second")].sort(
        (a, b) => a.database.id.localeCompare(b.database.id),
      ),
      suspended = ordered[0]!,
      running = ordered[1]!;
    await env.DB.prepare(
      "UPDATE databases SET desired_state='suspended' WHERE id=?",
    )
      .bind(suspended.database.id)
      .run();
    // An unavailable suspended credential must not break a running neighbor's page.
    await env.DB.prepare("UPDATE roles SET password_kid=? WHERE database_id=?")
      .bind("retired", suspended.database.id)
      .run();
    const databaseBefore = await env.DB.prepare(
      "SELECT * FROM databases WHERE id=?",
    )
      .bind(suspended.database.id)
      .first();
    const rolesBefore = await env.DB.prepare(
      "SELECT * FROM roles WHERE database_id=?",
    )
      .bind(suspended.database.id)
      .all();
    const response = await request("/agent/v1/desired?limit=1", f.agent);
    expect(response.status).toBe(200);
    const desired = DesiredResponse.parse(await response.json());
    expect(desired.databases.map((db) => db.id)).toEqual([running.database.id]);
    expect(desired.databases[0]!.desired_state).toBe("running");
    expect(desired.next).toBeNull();
    expect(
      await env.DB.prepare("SELECT * FROM databases WHERE id=?")
        .bind(suspended.database.id)
        .first(),
    ).toEqual(databaseBefore);
    expect(
      (
        await env.DB.prepare("SELECT * FROM roles WHERE database_id=?")
          .bind(suspended.database.id)
          .all()
      ).results,
    ).toEqual(rolesBefore.results);
  });

  it("returns a terminal empty page when every database is suspended", async () => {
    const f = await fixture(),
      first = await create(f, "first"),
      second = await create(f, "second");
    await env.DB.prepare(
      "UPDATE databases SET desired_state='suspended' WHERE project_id=?",
    )
      .bind(f.project)
      .run();
    const response = await request("/agent/v1/desired?limit=1", f.agent);
    expect(response.status).toBe(200);
    const page = DesiredResponse.parse(await response.json()),
      ordered = [first.database.id, second.database.id].sort();
    expect(page.databases).toEqual([]);
    expect(page.next).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT id,desired_state,generation,observed_generation FROM databases WHERE project_id=? ORDER BY id",
        )
          .bind(f.project)
          .all()
      ).results,
    ).toEqual(
      ordered.map((id) => ({
        id,
        desired_state: "suspended",
        generation: 1,
        observed_generation: 0,
      })),
    );
  });
});
