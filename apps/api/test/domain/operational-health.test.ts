// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import {
  backupHealth,
  diskHealth,
  heartbeatHealth,
} from "../../src/domain/operational-health.ts";
import { registerOperationalHealth } from "../../src/routes/health.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const sampled: string[] = [];
afterEach(async () => {
  for (const id of sampled.splice(0))
    await env.DB.prepare("DELETE FROM usage_samples WHERE database_id=?")
      .bind(id)
      .run();
  await cleanupFixtures();
});

it("keeps unavailable health unknown and reports only fresh measured backup and disk state", () => {
  const now = Date.now(),
    observed_at = new Date(now).toISOString();
  expect(heartbeatHealth(null, null, now).status).toBe("unknown");
  expect(
    heartbeatHealth(new Date(now - 181000).toISOString(), null, now).status,
  ).toBe("stale");
  expect(backupHealth(null, now).status).toBe("unknown");
  const backup = {
    observed_at,
    health: "ok" as const,
    last_completed_at: new Date(now - 3600000).toISOString(),
    last_failed_at: null,
  };
  expect(backupHealth(backup, now).status).toBe("ok");
  expect(
    backupHealth(
      {
        ...backup,
        last_completed_at: new Date(now - 37 * 3600000).toISOString(),
      },
      now,
    ).status,
  ).toBe("stale");
  expect(
    backupHealth({ ...backup, last_failed_at: observed_at }, now).status,
  ).toBe("failing");
  expect(
    backupHealth(
      { ...backup, observed_at: new Date(now - 181000).toISOString() },
      now,
    ).status,
  ).toBe("unknown");
  expect(diskHealth(null, now).status).toBe("unknown");
  const sample = {
    source: "agent" as const,
    database_id: "a".repeat(20),
    producer_id: crypto.randomUUID(),
    sequence: 1,
    observed_at,
    storage_used_bytes: 90,
    storage_allocated_bytes: 100,
  };
  expect(diskHealth(sample, now)).toMatchObject({
    status: "warning",
    used_fraction: 0.9,
  });
  expect(
    diskHealth({ ...sample, storage_used_bytes: null }, now),
  ).toMatchObject({
    status: "unknown",
    storage_used_bytes: null,
    used_fraction: null,
  });
  expect(
    diskHealth(
      { ...sample, observed_at: new Date(now - 181000).toISOString() },
      now,
    ).status,
  ).toBe("unknown");
});

async function healthRequest(path: string, key: string) {
  const app = createApp();
  registerOperationalHealth(app);
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
      headers: { Authorization: `Bearer ${key}` },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

it("exposes bounded administrator health from real D1 samples and preserves missing metrics", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  sampled.push(created.database.id);
  expect(
    (await healthRequest("/v1/operational-health", f.integrator)).status,
  ).toBe(403);
  const initial = await (
    await healthRequest(
      "/v1/operational-health?scope=databases&limit=1",
      f.admin,
    )
  ).json<{
    data: {
      id: string;
      backup: { status: string };
      disk: { status: string };
    }[];
  }>();
  expect(initial.data).toHaveLength(1);
  expect(initial.data[0]).toMatchObject({
    id: created.database.id,
    backup: { status: "unknown" },
    disk: { status: "unknown" },
  });
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE databases SET backup_observed_at=?,backup_health='ok',backup_last_completed_at=? WHERE id=?",
  )
    .bind(now, now, created.database.id)
    .run();
  const producer = crypto.randomUUID();
  const sample = {
    database_id: created.database.id,
    producer_id: producer,
    source: "agent",
    sequence: 1,
    observed_at: now,
    storage_used_bytes: 95,
    storage_allocated_bytes: 100,
  };
  await env.DB.prepare(
    "INSERT INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload) VALUES(?,'agent',?,1,?,?,?,?)",
  )
    .bind(created.database.id, producer, now, now, now, JSON.stringify(sample))
    .run();
  const measured = await (
    await healthRequest("/v1/operational-health", f.admin)
  ).json<{
    data: { backup: { status: string }; disk: { status: string } }[];
  }>();
  expect(measured.data[0]).toMatchObject({
    backup: { status: "ok" },
    disk: { status: "warning" },
  });
  const nodes = await (
    await healthRequest("/v1/operational-health?scope=nodes", f.admin)
  ).json<{ data: { observation: { status: string } }[] }>();
  expect(nodes.data[0]!.observation.status).toBe("ok");
  const regions = await (
    await healthRequest("/v1/operational-health?scope=regions", f.admin)
  ).json<{ data: { agent: { status: string } }[] }>();
  expect(regions.data.every((row) => row.agent.status === "unknown")).toBe(
    true,
  );
  const second = DatabaseWithOperation.parse(
    await (await f.create("second")).json(),
  );
  const firstPage = await (
    await healthRequest("/v1/operational-health?limit=1", f.admin)
  ).json<{ data: { id: string }[]; next_cursor: string | null }>();
  expect(firstPage.data).toHaveLength(1);
  expect(firstPage.next_cursor).not.toBeNull();
  const nextPage = await (
    await healthRequest(
      `/v1/operational-health?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
      f.admin,
    )
  ).json<{ data: { id: string }[]; next_cursor: string | null }>();
  expect(nextPage.data).toHaveLength(1);
  expect(nextPage.next_cursor).toBeNull();
  expect(
    new Set([...firstPage.data, ...nextPage.data].map((row) => row.id)),
  ).toEqual(new Set([created.database.id, second.database.id]));
});
