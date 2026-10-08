// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { placePendingDatabases } from "../../src/domain/node-capacity.ts";
import {
  cleanupFixtures,
  fixture,
  observedBody,
  observation,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);
describe("pending capacity on real D1", () => {
  it("atomically places low-request classes while preserving hard CPU limits and Barman overhead", async () => {
    const f = await fixture(128, 0);
    await env.DB.prepare(
      "UPDATE size_classes SET cpu_millicores=250,cpu_request_millicores=25 WHERE id=?",
    )
      .bind(f.size)
      .run();
    const first = DatabaseWithOperation.parse(
      await (await f.create("share-first")).json(),
    );
    const second = DatabaseWithOperation.parse(
      await (await f.create("share-second")).json(),
    );
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_memory_mib=4096,allocatable_cpu_millicores=350,storage_gib_total=30 WHERE id=?",
    )
      .bind(f.node)
      .run();
    await Promise.all([
      placePendingDatabases(env.DB, f.region),
      placePendingDatabases(env.DB, f.region),
    ]);
    const rows = await env.DB.prepare(
      "SELECT id,node_id FROM databases WHERE id IN(?,?)",
    )
      .bind(first.database.id, second.database.id)
      .all<{ id: string; node_id: string | null }>();
    expect(rows.results.filter((row) => row.node_id === f.node)).toHaveLength(
      2,
    );
    const events = await env.DB.prepare(
      "SELECT resource_snapshot FROM lifecycle_events WHERE database_id IN(?,?) AND kind='created'",
    )
      .bind(first.database.id, second.database.id)
      .all<{ resource_snapshot: string }>();
    expect(events.results).toHaveLength(2);
    for (const row of events.results)
      expect(JSON.parse(row.resource_snapshot)).toMatchObject({
        cpu_millicores: 250,
        reserved_cpu_millicores: 125,
      });
  });

  it("rejects a captured pending placement when its CPU scheduling request changes before the atomic write", async () => {
    const f = await fixture(128, 0);
    await env.DB.prepare(
      "UPDATE size_classes SET cpu_millicores=250,cpu_request_millicores=25 WHERE id=?",
    )
      .bind(f.size)
      .run();
    const first = DatabaseWithOperation.parse(
      await (await f.create("stale-share")).json(),
    );
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_memory_mib=4096,allocatable_cpu_millicores=350,storage_gib_total=30 WHERE id=?",
    )
      .bind(f.node)
      .run();
    let raced = false;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await env.DB.prepare(
            "UPDATE size_classes SET cpu_request_millicores=50 WHERE id=?",
          )
            .bind(f.size)
            .run();
        }
        return env.DB.batch(statements);
      },
    } as D1Database;
    expect(await placePendingDatabases(db, f.region)).toEqual([]);
    expect(raced).toBe(true);
    expect(
      await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
        .bind(first.database.id)
        .first("node_id"),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM lifecycle_events WHERE database_id=?",
      )
        .bind(first.database.id)
        .first("count"),
    ).toBe(0);
  });

  it("retains one pending create and its credentials without emitting unplaced desired state", async () => {
    const f = await fixture(128, 0);
    const first = await f.create("waiting", f.integrator, "pending-once");
    expect(first.status).toBe(202);
    const created = DatabaseWithOperation.parse(await first.json());
    expect(created.database.observed_state).toBe("pending");
    const before = await env.DB.prepare(
      "SELECT * FROM roles WHERE database_id=?",
    )
      .bind(created.database.id)
      .first();
    const replay = DatabaseWithOperation.parse(
      await (await f.create("waiting", f.integrator, "pending-once")).json(),
    );
    expect(replay).toEqual(created);
    expect(
      await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
        .bind(created.database.id)
        .first("node_id"),
    ).toBeNull();
    expect(
      DesiredResponse.parse(
        await (await request("/agent/v1/desired", f.agent)).json(),
      ).databases,
    ).toEqual([]);
    expect(
      await (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(created.database.id, 1)]),
        )
      ).json(),
    ).toEqual({ accepted: 0 });
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_memory_mib=4096,storage_gib_total=30 WHERE id=?",
    )
      .bind(f.node)
      .run();
    expect(await placePendingDatabases(env.DB, f.region)).toEqual([
      created.database.id,
    ]);
    expect(
      await env.DB.prepare("SELECT * FROM roles WHERE database_id=?")
        .bind(created.database.id)
        .first(),
    ).toEqual(before);
    const desired = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    );
    expect(desired.databases[0]?.id).toBe(created.database.id);
    expect(desired.databases[0]?.creation?.operation_id).toBe(
      created.operation.id,
    );
    expect(await placePendingDatabases(env.DB, f.region)).toEqual([]);
  });
  it("rechecks headroom atomically when pending placements compete", async () => {
    const f = await fixture(128, 0);
    const first = DatabaseWithOperation.parse(
      await (await f.create("first")).json(),
    );
    const second = DatabaseWithOperation.parse(
      await (await f.create("second")).json(),
    );
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_memory_mib=4096,allocatable_cpu_millicores=700,storage_gib_total=30 WHERE id=?",
    )
      .bind(f.node)
      .run();
    await Promise.all([
      placePendingDatabases(env.DB, f.region),
      placePendingDatabases(env.DB, f.region),
    ]);
    const rows = await env.DB.prepare(
      "SELECT id,node_id FROM databases WHERE id IN(?,?)",
    )
      .bind(first.database.id, second.database.id)
      .all<{ id: string; node_id: string | null }>();
    expect(rows.results.filter((row) => row.node_id !== null)).toHaveLength(1);
    expect(rows.results.filter((row) => row.node_id === null)).toHaveLength(1);
  });
});
