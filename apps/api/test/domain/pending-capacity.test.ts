// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { placePendingDatabases } from "../../src/domain/node-capacity.ts";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  report,
  verdicts,
} from "./fixtures.ts";
import { reports } from "./node-samples.ts";

afterEach(cleanupFixtures);
describe("pending capacity on real D1", () => {
  it("places waiting databases together once the node reports room, with their effective resources", async () => {
    const f = await fixture(0);
    const first = DatabaseWithOperation.parse(
      await (await f.create("share-first")).json(),
    );
    const second = DatabaseWithOperation.parse(
      await (await f.create("share-second")).json(),
    );
    expect(first.database.node_id).toBeNull();
    await reports(f.node);
    await Promise.all([
      placePendingDatabases(env.DB, f.region),
      placePendingDatabases(env.DB, f.region),
    ]);
    const rows = await env.DB.prepare(
      "SELECT id,node_id,placed_at FROM databases WHERE id IN(?,?)",
    )
      .bind(first.database.id, second.database.id)
      .all<{ id: string; node_id: string | null; placed_at: string | null }>();
    expect(rows.results.filter((row) => row.node_id === f.node)).toHaveLength(
      2,
    );
    for (const row of rows.results) expect(row.placed_at).not.toBeNull();
    const events = await env.DB.prepare(
      "SELECT resource_snapshot FROM lifecycle_events WHERE database_id IN(?,?) AND kind='created'",
    )
      .bind(first.database.id, second.database.id)
      .all<{ resource_snapshot: string }>();
    expect(events.results).toHaveLength(2);
    for (const row of events.results)
      expect(JSON.parse(row.resource_snapshot)).toMatchObject({
        memory_mib: 512,
        cpu_millicores: 500,
        storage_allocated_bytes: 5 * 2 ** 30,
      });
  });

  it("rejects a captured pending placement when another placement lands on the node before the atomic write", async () => {
    const f = await fixture(0);
    const first = DatabaseWithOperation.parse(
      await (await f.create("captured")).json(),
    );
    const second = DatabaseWithOperation.parse(
      await (await f.create("racing")).json(),
    );
    await reports(f.node);
    let raced = false;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          // The racing database takes its place first; the captured decision no longer holds.
          await env.DB.prepare(
            "UPDATE databases SET node_id=?,placed_at=? WHERE id=?",
          )
            .bind(f.node, new Date().toISOString(), second.database.id)
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

  it("rejects a captured pending placement when storage became pending on the node before the atomic write", async () => {
    const f = await fixture(0);
    const first = DatabaseWithOperation.parse(
      await (await f.create("captured-storage")).json(),
    );
    const second = DatabaseWithOperation.parse(
      await (await f.create("racing-storage")).json(),
    );
    await reports(f.node);
    let raced = false;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          // The racing database lands on the node with its create still open, and no memory
          // pending: only its 5 GiB of storage differ from what the decision read.
          await env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
            .bind(f.node, second.database.id)
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
  });

  it("retains one pending create and its credentials without emitting unplaced desired state", async () => {
    const f = await fixture(0);
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
    expect((await desiredPage(f)).databases).toEqual([]);
    expect(await verdicts(await report(f, created.database.id, 1))).toEqual([
      "stale",
    ]);
    await reports(f.node);
    expect(await placePendingDatabases(env.DB, f.region)).toEqual([
      created.database.id,
    ]);
    expect(
      await env.DB.prepare("SELECT * FROM roles WHERE database_id=?")
        .bind(created.database.id)
        .first(),
    ).toEqual(before);
    const desired = await desiredPage(f);
    expect(desired.databases[0]?.id).toBe(created.database.id);
    expect(desired.databases[0]?.operation).toBe(created.operation.id);
    expect(desired.databases[0]?.origin).toEqual({ kind: "create" });
    expect(await placePendingDatabases(env.DB, f.region)).toEqual([]);
  });
  it("rechecks room atomically when pending placements compete", async () => {
    const f = await fixture(0);
    const first = DatabaseWithOperation.parse(
      await (await f.create("first")).json(),
    );
    const second = DatabaseWithOperation.parse(
      await (await f.create("second")).json(),
    );
    // 1,024 MiB hold one 512 MiB database under 80 %, not two.
    await reports(f.node, 1024);
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
