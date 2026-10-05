// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

it("delivers and acknowledges deletion on the exact lost predecessor while its warm Actor remains closed", async () => {
  const f = await fixture();
  const uid = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(uid, f.node)
    .run();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  const post = (
    key: string,
    generation: number,
    state: "ready" | "deleting" | "deleted",
  ) =>
    request(
      "/agent/v1/observations",
      key,
      "POST",
      observedBody([observation(id, generation, state)]),
    );
  expect(await (await post(f.agent, 1, "ready")).json()).toEqual({
    accepted: 1,
  });
  const original = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).databases.find((db) => db.id === id)!;
  const placement = await env.DB.prepare(
    "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first();
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  expect((await actor.ensureAwake(id, "app")).ok).toBe(true);
  expect((await actor.admit(id, "app")).ok).toBe(true);
  const lost = await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
    expected_node_uid: uid,
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
  expect(
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).databases.some((db) => db.id === id),
  ).toBe(false);
  expect(await (await post(f.agent, 1, "ready")).json()).toEqual({
    accepted: 0,
  });

  const deletion = DatabaseWithOperation.parse(
    await (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).json(),
  );
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).databases.find((db) => db.id === id);
  expect(desired).toMatchObject({
    id,
    node: original.node,
    generation: deletion.database.generation,
    desired_state: "deleted",
    roles: [],
    archive: original.archive,
  });
  expect(
    await (
      await post(f.foreignAgent, deletion.database.generation, "deleted")
    ).json(),
  ).toEqual({ accepted: 0 });
  expect(await (await post(f.agent, 1, "deleted")).json()).toEqual({
    accepted: 0,
  });
  expect(
    await (await post(f.agent, deletion.database.generation, "ready")).json(),
  ).toEqual({ accepted: 0 });
  expect(
    await (
      await post(f.agent, deletion.database.generation, "deleting")
    ).json(),
  ).toEqual({ accepted: 1 });
  expect(
    await (await post(f.agent, deletion.database.generation, "deleted")).json(),
  ).toEqual({ accepted: 1 });
  expect(
    (
      await (
        await request(`/v1/operations/${deletion.operation.id}`, f.integrator)
      ).json<{ status: string }>()
    ).status,
  ).toBe("succeeded");
  expect(
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).databases.some((db) => db.id === id),
  ).toBe(false);
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
