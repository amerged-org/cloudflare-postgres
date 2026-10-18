// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  report,
  request,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

it("keeps the warm Actor of a lost node's database closed and takes no report of its databases from the lost node", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(await verdicts(await report(f, id, 1))).toEqual(["accept"]);
  const placement = await env.DB.prepare(
    "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first();
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  expect((await actor.ensureAwake(id, "app")).ok).toBe(true);
  expect((await actor.admit(id, "app")).ok).toBe(true);
  const lost = await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
    expected_node_uid: f.nodeUid,
    reason: "confirmed source node loss",
  });
  expect(lost.status).toBe(200);
  const tombstone = await env.DB.prepare("SELECT * FROM nodes WHERE id=?")
    .bind(f.node)
    .first();

  // This Actor still holds its warm seeded presence; authority must override it.
  expect(await actor.ensureAwake(id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await actor.admit(id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  // The lost node's page holds its fence and no database, and its reports of databases are not taken.
  const page = await desiredPage(f);
  expect(page.databases).toEqual([]);
  expect(page.release).toBeNull();
  const deletion = DatabaseWithOperation.parse(
    await (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).json(),
  );
  expect((await desiredPage(f)).databases).toEqual([]);
  for (const [generation, state] of [
    [1, "ready"],
    [deletion.database.generation, "deleted"],
  ] as const) {
    const response = await report(f, id, generation, state);
    expect(response.status).toBe(200);
    expect(await verdicts(response)).toEqual([]);
  }
  expect(
    (
      await (
        await request(`/v1/operations/${deletion.operation.id}`, f.integrator)
      ).json<{ status: string }>()
    ).status,
  ).toBe("pending");
  expect(
    await env.DB.prepare(
      "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual(placement);
  expect(
    await env.DB.prepare("SELECT * FROM nodes WHERE id=?").bind(f.node).first(),
  ).toEqual(tombstone);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(id)
      .first("count"),
  ).toBe(0);
});
