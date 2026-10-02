// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newProjectId } from "@pgcf/contracts";
import { expect, it } from "vitest";

it("accepts canonical timestamps and rejects non-digit timestamp positions in real D1", async () => {
  const now = new Date().toISOString();
  const valid = await env.DB.prepare(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(newProjectId(), "valid timestamp", now, now)
    .run();
  expect(valid.meta.changes).toBe(1);
  const nondigit = `x${now.slice(1)}`;
  await expect(
    env.DB.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(newProjectId(), "invalid timestamp", nondigit, now)
      .run(),
  ).rejects.toThrow("CHECK constraint failed");
  await expect(
    env.DB.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(newProjectId(), "invalid timestamp", now, nondigit)
      .run(),
  ).rejects.toThrow("CHECK constraint failed");
});
