// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, newOperationId } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";
import type { D1Migration } from "cloudflare:test";
import { databaseResizeStatement } from "../../src/domain/databases.ts";
import type { DatabaseRow, SizeRow } from "../../src/domain/rows.ts";

const classes: string[] = [];
const historySQL = (query: string) =>
  query.replace(
    /\boperations(?:_[a-z_]+)?\b/g,
    (name) => "resize_history_" + name,
  );
const history = {
  prepare: (query: string) => env.DB.prepare(historySQL(query)),
};
afterEach(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS resize_history_operations").run();
  await env.DB.prepare(
    "DROP TABLE IF EXISTS resize_history_operations_resize",
  ).run();
  await cleanupFixtures();
  for (const id of classes.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});
async function ready() {
  const f = await fixture();
  const first = await f.create();
  expect(first.status).toBe(202);
  const created = DatabaseWithOperation.parse(await first.json());
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([observation(created.database.id, 1)]),
      )
    ).status,
  ).toBe(200);
  return { ...f, id: created.database.id, createOp: created.operation.id };
}
async function size(
  f: Awaited<ReturnType<typeof ready>>,
  overrides: {
    memory?: number;
    cpu?: number;
    storage?: number;
    connections?: number;
  } = {},
) {
  const id = "r" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  classes.push(id);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
    SELECT ?,?,?,?, ?,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(
      id,
      overrides.memory ?? 1024,
      overrides.cpu ?? 750,
      overrides.storage ?? 5,
      overrides.connections ?? 80,
      f.size,
    )
    .run();
  return id;
}
function resize(
  f: Awaited<ReturnType<typeof ready>>,
  target: string,
  key?: string,
  auth = f.integrator,
) {
  return request(
    `/v1/databases/${f.id}`,
    auth,
    "PATCH",
    { size_class_id: target },
    key,
  );
}

describe("manual in-place resize on real Workers D1", () => {
  it("resizes an assigned database after new placement is closed while refusing a new allocation", async () => {
    const f = await ready();
    const uid = crypto.randomUUID();
    await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
      .bind(uid, f.node)
      .run();
    const closed = await request(
      `/v1/nodes/${f.node}/database-placement`,
      f.admin,
      "PUT",
      { expected_node_uid: uid, database_placement_enabled: false },
    );
    expect(closed.status).toBe(200);
    const pending = DatabaseWithOperation.parse(
      await (await f.create("closed-placement-new-database")).json(),
    );
    expect(pending.database.observed_state).toBe("pending");
    expect(
      await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
        .bind(pending.database.id)
        .first("node_id"),
    ).toBeNull();
    const before = await env.DB.prepare(
      "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first();
    const target = await size(f);
    const resized = await resize(f, target, "existing-on-control-node");
    expect(resized.status).toBe(202);
    const result = DatabaseWithOperation.parse(await resized.json());
    expect(result.database.size_class_id).toBe(target);
    expect(result.database.generation).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT ready,schedulable,database_placement_enabled FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first(),
    ).toEqual({ ready: 1, schedulable: 1, database_placement_enabled: 0 });
  });

  it("preserves historical operations, errors, timestamps, indexes and foreign keys through the actual migration", async () => {
    const f = await ready();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at) VALUES(?,'database.delete','failed',?,?,1,'test_error','historical error',?,?,?)",
    )
      .bind(newOperationId(), f.project, f.id, now, now, now)
      .run();
    const before = (
      await env.DB.prepare("SELECT * FROM operations ORDER BY id").all()
    ).results;
    const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS;
    const initial = migrations.find((migration) =>
      migration.name.startsWith("0001"),
    )!;
    for (const query of initial.queries.filter((query) =>
      /CREATE TABLE operations\s*\(|CREATE INDEX operations_/.test(query),
    ))
      await history.prepare(query).run();
    for (const row of before) {
      const columns = Object.keys(row);
      await history
        .prepare(
          `INSERT INTO operations(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        )
        .bind(...Object.values(row))
        .run();
    }
    const oldIndexes = (
      await history
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='operations' AND sql IS NOT NULL ORDER BY name",
        )
        .all()
    ).results;
    const oldKeys = (
      await history.prepare("PRAGMA foreign_key_list(operations)").all()
    ).results;
    const migration = migrations.find((value) =>
      value.name.startsWith("0006"),
    )!;
    await env.DB.batch(
      migration.queries.map((query) => history.prepare(query)),
    );
    expect(
      (await history.prepare("SELECT * FROM operations ORDER BY id").all())
        .results,
    ).toEqual(before);
    for (const index of oldIndexes)
      expect(
        await env.DB.prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='index' AND name=?",
        )
          .bind(index.name)
          .first(),
      ).toEqual(index);
    expect(
      (await history.prepare("PRAGMA foreign_key_list(operations)").all())
        .results,
    ).toEqual(oldKeys);
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
  it("changes the class in place, keeps storage identity and returns one idempotent operation", async () => {
    const f = await ready();
    const target = await size(f);
    const before = await env.DB.prepare(
      "SELECT node_id,archive_path FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first();
    const first = await resize(f, target, "resize-once");
    expect(first.status).toBe(202);
    const result = DatabaseWithOperation.parse(await first.json());
    expect(result.operation.kind).toBe("database.resize");
    expect(result.database.generation).toBe(2);
    expect(result.database.size_class_id).toBe(target);
    expect(result.database.observed_state).toBe("provisioning");
    expect(
      await env.DB.prepare(
        "SELECT node_id,archive_path FROM databases WHERE id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual(before);
    const replay = await resize(f, target, "resize-once");
    expect(replay.status).toBe(202);
    expect(DatabaseWithOperation.parse(await replay.json()).operation.id).toBe(
      result.operation.id,
    );
    const same = await resize(f, target);
    expect(same.status).toBe(202);
    expect(DatabaseWithOperation.parse(await same.json()).operation.id).toBe(
      result.operation.id,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
      )
        .bind(f.id)
        .first("n"),
    ).toBe(1);
  });

  it("keeps initial same-class calls as completed no-ops without a generation change or resize event", async () => {
    const f = await ready();
    const first = await resize(f, f.size, "noop");
    expect(first.status).toBe(202);
    const op = DatabaseWithOperation.parse(await first.json());
    expect(op.operation.kind).toBe("database.resize");
    expect(op.operation.status).toBe("succeeded");
    expect(op.database.generation).toBe(1);
    const again = await resize(f, f.size, "noop-again");
    expect(again.status).toBe(202);
    expect(DatabaseWithOperation.parse(await again.json()).operation.id).toBe(
      op.operation.id,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM lifecycle_events WHERE database_id=? AND kind='resized'",
      )
        .bind(f.id)
        .first("n"),
    ).toBe(0);
  });

  it("rejects cross-project authorization, storage shrink and unsupported storage growth", async () => {
    const f = await ready();
    const target = await size(f);
    expect((await resize(f, target, undefined, f.otherKey)).status).toBe(404);
    expect((await resize(f, await size(f, { storage: 4 }))).status).toBe(400);
    expect((await resize(f, await size(f, { storage: 6 }))).status).toBe(400);
    expect(
      await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
        .bind(f.id)
        .first("generation"),
    ).toBe(1);
  });

  it("rejects unknown CPU and insufficient current-node capacity without changing the class", async () => {
    const f = await ready();
    const target = await size(f, { memory: 4096, cpu: 1000 });
    expect((await resize(f, target, "no-room")).status).toBe(503);
    await env.DB.prepare(
      "UPDATE nodes SET platform_reserved_cpu_millicores=NULL WHERE id=?",
    )
      .bind(f.node)
      .run();
    expect((await resize(f, await size(f), "unknown-cpu")).status).toBe(503);
    expect(
      await env.DB.prepare(
        "SELECT generation,size_class_id FROM databases WHERE id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({ generation: 1, size_class_id: f.size });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
      )
        .bind(f.id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM idempotency_keys WHERE key IN('no-room','unknown-cpu')",
      ).first("n"),
    ).toBe(0);
  });

  it("serializes resize and another create against the same CPU reservation without partial operations", async () => {
    const f = await ready();
    const target = await size(f, { cpu: 800 });
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_cpu_millicores=1300 WHERE id=?",
    )
      .bind(f.node)
      .run();
    const responses = await Promise.all([
      resize(f, target, "race-resize"),
      f.create("race-create", f.integrator, "race-create"),
    ]);
    expect(responses[1]!.status).toBe(202);
    expect([202, 503]).toContain(responses[0]!.status);
    const created = DatabaseWithOperation.parse(await responses[1]!.json());
    const placed = await env.DB.prepare(
      "SELECT node_id FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first("node_id");
    expect(placed).toBe(responses[0]!.status === 202 ? null : f.node);
    const reserved = await env.DB.prepare(
      "SELECT SUM(s.cpu_millicores+100) n FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.node_id=? AND d.observed_state<>'deleted'",
    )
      .bind(f.node)
      .first<number>("n");
    expect(reserved).toBeLessThanOrEqual(1200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM operations WHERE project_id=? AND status='pending'",
      )
        .bind(f.project)
        .first("n"),
    ).toBe(responses[0]!.status === 202 ? 2 : 1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM idempotency_keys WHERE state='in_progress'",
      ).first("n"),
    ).toBe(0);
  });

  it("concurrent different resizes accept one revision and cannot leave a second operation or lease", async () => {
    const f = await ready();
    const first = await size(f);
    const second = await size(f, { cpu: 1000 });
    const results = await Promise.all([
      resize(f, first, "resize-first"),
      resize(f, second, "resize-second"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
      )
        .bind(f.id)
        .first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
        .bind(f.id)
        .first("generation"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM idempotency_keys WHERE state='in_progress'",
      ).first("n"),
    ).toBe(0);
  });

  it("requires the current configuration proof after a concurrent role revision", async () => {
    const f = await ready();
    const target = await size(f);
    const resized = DatabaseWithOperation.parse(
      await (await resize(f, target)).json(),
    );
    expect(
      (
        await request(`/v1/databases/${f.id}/roles`, f.integrator, "POST", {
          name: "reader",
        })
      ).status,
    ).toBe(201);
    expect(
      await (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(f.id, 2)]),
        )
      ).json(),
    ).toEqual({ accepted: 0 });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(resized.operation.id)
        .first("status"),
    ).toBe("pending");
    expect(
      await (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(f.id, 3)]),
        )
      ).json(),
    ).toEqual({ accepted: 1 });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(resized.operation.id)
        .first("status"),
    ).toBe("succeeded");
  });

  it("CAS refuses a stale generation or deletion before a captured resize update", async () => {
    const f = await ready();
    const target = await size(f);
    const row = (await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(f.id)
      .first<DatabaseRow>())!;
    const selected = (await env.DB.prepare(
      "SELECT * FROM size_classes WHERE id=?",
    )
      .bind(target)
      .first<SizeRow>())!;
    await env.DB.prepare(
      "UPDATE databases SET generation=generation+1 WHERE id=?",
    )
      .bind(f.id)
      .run();
    expect(
      (
        await databaseResizeStatement(
          env.DB,
          row,
          selected,
          new Date().toISOString(),
        ).run()
      ).meta.changes,
    ).toBe(0);
    await env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), f.id)
      .run();
    expect(
      (
        await databaseResizeStatement(
          env.DB,
          row,
          selected,
          new Date().toISOString(),
        ).run()
      ).meta.changes,
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT size_class_id FROM databases WHERE id=?")
        .bind(f.id)
        .first("size_class_id"),
    ).toBe(f.size);
  });

  it("completes only exact accepted readiness and records one immutable resource snapshot", async () => {
    const f = await ready();
    const target = await size(f);
    const changed = DatabaseWithOperation.parse(
      await (await resize(f, target)).json(),
    );
    const report = (generation: number, state = "ready") =>
      request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([observation(f.id, generation, state)]),
      );
    expect(await (await report(1)).json()).toEqual({ accepted: 0 });
    expect(await (await report(3)).json()).toEqual({ accepted: 0 });
    expect(await (await report(2, "provisioning")).json()).toEqual({
      accepted: 1,
    });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(changed.operation.id)
        .first("status"),
    ).toBe("running");
    expect(await (await report(2)).json()).toEqual({ accepted: 1 });
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(changed.operation.id)
        .first("status"),
    ).toBe("succeeded");
    const events = (
      await env.DB.prepare(
        "SELECT * FROM lifecycle_events WHERE database_id=? AND kind='resized'",
      )
        .bind(f.id)
        .all<{ resource_snapshot: string }>()
    ).results;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.resource_snapshot)).toEqual({
      memory_mib: 1024,
      cpu_millicores: 750,
      reserved_memory_mib: 1152,
      reserved_cpu_millicores: 850,
      storage_allocated_bytes: 5 * 2 ** 30,
    });
    await report(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT * FROM lifecycle_events WHERE database_id=? AND kind='resized'",
        )
          .bind(f.id)
          .all()
      ).results,
    ).toEqual(events);
    await expect(
      env.DB.prepare(
        "UPDATE lifecycle_events SET resource_snapshot='{}' WHERE database_id=? AND kind='resized'",
      )
        .bind(f.id)
        .run(),
    ).rejects.toThrow("immutable");
    expect(
      (
        await request(`/v1/size-classes/${target}`, f.admin, "PUT", {
          memory_mib: 2048,
          cpu_millicores: 750,
          storage_gib: 5,
          max_connections: 80,
          sleep_after_seconds: null,
          archive_timeout_seconds: 60,
          backup_retention_days: 7,
          enabled: true,
        })
      ).status,
    ).toBe(409);
  });
});
