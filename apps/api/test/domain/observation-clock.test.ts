// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

async function create(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.create();
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json());
}

describe("observation ordering on real Workers D1", () => {
  it("completes a create with a slow agent clock while retaining its sample time", async () => {
    const f = await fixture(),
      created = await create(f),
      id = created.database.id,
      sampledAt = new Date(Date.now() - 10 * 60_000).toISOString(),
      receivedAfter = new Date().toISOString();
    const response = await request("/agent/v1/observations", f.agent, "POST", {
      ...observedBody(
        [
          {
            ...observation(id, 1),
            archive: { continuous: true, ready_wal_files: null },
          },
        ],
        [
          {
            name: f.nodeName,
            ready: true,
            allocatable_memory_mib: 4096,
            allocatable_cpu_millicores: 2000,
            storage_gib_total: null,
            platform_reserved_memory_mib: 128,
          },
        ],
      ),
      observed_at: sampledAt,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    const database = await env.DB.prepare(
      "SELECT observed_state,observed_generation,archiving_health,updated_at FROM databases WHERE id=?",
    )
      .bind(id)
      .first<{
        observed_state: string;
        observed_generation: number;
        archiving_health: string;
        updated_at: string;
      }>();
    expect(database).toMatchObject({
      observed_state: "ready",
      observed_generation: 1,
      archiving_health: "unknown",
    });
    expect(database!.updated_at >= receivedAfter).toBe(true);
    expect(database!.updated_at <= new Date().toISOString()).toBe(true);
    const node = await env.DB.prepare(
      "SELECT storage_gib_total,last_observed_at,updated_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{
        storage_gib_total: number | null;
        last_observed_at: string;
        updated_at: string;
      }>();
    expect(node).toMatchObject({
      storage_gib_total: null,
      last_observed_at: sampledAt,
    });
    expect(node!.updated_at >= receivedAfter).toBe(true);
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(created.operation.id)
        .first("status"),
    ).toBe("succeeded");
    expect(
      await env.DB.prepare(
        "SELECT occurred_at FROM lifecycle_events WHERE database_id=? AND kind='ready'",
      )
        .bind(id)
        .first("occurred_at"),
    ).toBe(sampledAt);
  });

  it("records slow-clock errors and cannot revive a terminal failed operation", async () => {
    const f = await fixture(),
      created = await create(f),
      id = created.database.id,
      sampledAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const error = await request("/agent/v1/observations", f.agent, "POST", {
      ...observedBody([observation(id, 1, "error", "retryable")]),
      observed_at: sampledAt,
    });
    expect(await error.json()).toEqual({ accepted: 1 });
    expect(
      await env.DB.prepare("SELECT observed_state FROM databases WHERE id=?")
        .bind(id)
        .first("observed_state"),
    ).toBe("error");
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(created.operation.id)
        .first("status"),
    ).toBe("running");
    await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
      .bind(
        new Date(Date.now() - 21 * 60_000).toISOString(),
        created.operation.id,
      )
      .run();
    await runCron(env);
    const ready = await request("/agent/v1/observations", f.agent, "POST", {
      ...observedBody([observation(id, 1)]),
      observed_at: sampledAt,
    });
    expect(await ready.json()).toEqual({ accepted: 1 });
    expect(
      await env.DB.prepare(
        "SELECT status,error_code FROM operations WHERE id=?",
      )
        .bind(created.operation.id)
        .first(),
    ).toEqual({ status: "failed", error_code: "operation_timeout" });
  });

  it("keeps newer configuration and delete operations fenced from stale readiness", async () => {
    const f = await fixture(),
      created = await create(f),
      id = created.database.id;
    expect(
      (
        await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
          name: "reader",
        })
      ).status,
    ).toBe(201);
    const post = (generation: number, state = "ready") =>
      request("/agent/v1/observations", f.agent, "POST", {
        ...observedBody([observation(id, generation, state)]),
        observed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
    expect(await (await post(1)).json()).toEqual({ accepted: 0 });
    expect(await (await post(2)).json()).toEqual({ accepted: 1 });
    const deletion = DatabaseWithOperation.parse(
      await (
        await request(`/v1/databases/${id}`, f.integrator, "DELETE")
      ).json(),
    );
    expect(await (await post(2)).json()).toEqual({ accepted: 0 });
    expect(await (await post(3)).json()).toEqual({ accepted: 0 });
    expect(
      await env.DB.prepare(
        "SELECT observed_state,observed_generation FROM databases WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ observed_state: "ready", observed_generation: 2 });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(deletion.operation.id)
        .first("status"),
    ).toBe("pending");
    expect(await (await post(3, "deleted")).json()).toEqual({ accepted: 1 });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(deletion.operation.id)
        .first("status"),
    ).toBe("succeeded");
  });

  it("rejects invalid samples without changing readiness or filling measurement gaps", async () => {
    const f = await fixture(),
      created = await create(f),
      id = created.database.id;
    const response = await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([
        {
          ...observation(id, 1),
          archive: { continuous: true, ready_wal_files: -1 },
        },
      ]),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT observed_state,observed_generation,archiving_health FROM databases WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      observed_state: "pending",
      observed_generation: 0,
      archiving_health: "unknown",
    });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(created.operation.id)
        .first("status"),
    ).toBe("pending");
  });
});
