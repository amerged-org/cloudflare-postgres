// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request as rawRequest } from "./fixtures.ts";

const request = (path: string, key: string, method: string, body?: unknown) =>
  rawRequest(path, key, method, body, crypto.randomUUID());

afterEach(cleanupFixtures);

it("keeps credentials stable during archive verification and restore, then accepts changes while archived", async () => {
  const f = await fixture();
  const created = await f.create();
  const id = DatabaseWithOperation.parse(await created.json()).database.id;
  expect(
    (
      await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
        name: "reader",
      })
    ).status,
  ).toBe(201);
  const before = await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first("generation");
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archiving' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(
    (
      await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
        name: "blocked",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/v1/databases/${id}/roles/reader/reset-password`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='restoring' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(
    (await request(`/v1/databases/${id}/roles/reader`, f.integrator, "DELETE"))
      .status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(id)
      .first("generation"),
  ).toBe(before);
  expect(
    await env.DB.prepare(
      "SELECT password_revision FROM roles WHERE database_id=? AND name='reader'",
    )
      .bind(id)
      .first("password_revision"),
  ).toBe(1);
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archived',node_id=NULL,desired_state='suspended',observed_power='hibernated' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(
    (
      await request(
        `/v1/databases/${id}/roles/reader/reset-password`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(200);
  expect(
    (await request(`/v1/databases/${id}/roles/reader`, f.integrator, "DELETE"))
      .status,
  ).toBe(202);
});
