// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  fixture,
  cleanupFixtures,
  request,
  observedBody,
  observation,
} from "./fixtures.ts";
afterEach(cleanupFixtures);
it("persists collection time monotonically and leaves cached backup health stale", async () => {
  const f = await fixture(),
    r = await f.create(),
    { database } = (await r.json()) as { database: { id: string } };
  const time = new Date(Date.now() - 120000).toISOString(),
    completed = new Date(Date.now() - 180000).toISOString();
  const sample = {
    health: "ok",
    observed_at: time,
    last_completed_at: completed,
    last_failed_at: null,
  };
  const send = (backup: unknown) =>
    request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([{ ...observation(database.id, 1), backup }]),
    );
  expect((await send(sample)).status).toBe(200);
  const read = () =>
    env.DB.prepare(
      "SELECT backup_observed_at,backup_health,backup_last_completed_at FROM databases WHERE id=?",
    )
      .bind(database.id)
      .first();
  expect(await read()).toEqual({
    backup_observed_at: time,
    backup_health: "ok",
    backup_last_completed_at: completed,
  });
  expect((await send({ ...sample, health: "failing" })).status).toBe(200);
  expect(await read()).toEqual({
    backup_observed_at: time,
    backup_health: "ok",
    backup_last_completed_at: completed,
  });
  expect(
    (
      await send({
        ...sample,
        health: "unknown",
        observed_at: new Date(Date.parse(time) - 1000).toISOString(),
      })
    ).status,
  ).toBe(200);
  expect(await read()).toEqual({
    backup_observed_at: time,
    backup_health: "ok",
    backup_last_completed_at: completed,
  });
  expect(
    (
      await send({
        ...sample,
        observed_at: new Date(Date.now() + 600000).toISOString(),
      })
    ).status,
  ).toBe(400);
  const health = await request(
    "/v1/operational-health?scope=databases",
    f.admin,
  );
  expect(health.status).toBe(200);
});
