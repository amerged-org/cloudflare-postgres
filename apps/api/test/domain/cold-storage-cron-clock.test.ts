// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runCron } from "../../src/cron.ts";
import { cleanupColdFixture, sleeping } from "./cold-storage-fixture.ts";

afterEach(cleanupColdFixture);

it("admits a current node after earlier cron steps have outlived its clock-skew allowance", async () => {
  const f = await sleeping();
  // The report is current. The overall run began before the work that precedes cold storage.
  const runStartedAt = f.current - 30_000;
  await runCron(f.configured, runStartedAt);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_cold_storage WHERE database_id=? AND phase='capturing'",
    )
      .bind(f.id)
      .first<number>("n"),
  ).toBe(1);
}, 60000);
