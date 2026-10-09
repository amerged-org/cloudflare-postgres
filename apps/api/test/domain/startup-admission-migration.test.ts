// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { newDatabaseId, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);

async function parents() {
  const f = await fixture(),
    database = newDatabaseId(),
    operation = newOperationId(),
    now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?,?)",
    ).bind(
      database,
      f.project,
      f.region,
      f.node,
      "startup-admission",
      f.size,
      "s3://startup-admission/g1",
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES(?,'database.create','pending',?,?,1,?,?)",
    ).bind(operation, f.project, database, now, now),
  ]);
  return { ...f, database, operation };
}

type Admission = {
  operation_id: string;
  database_id: string;
  generation: number;
  node_id: string;
  node_uid: string;
  budget_bytes: number;
  granted_at: string;
  grant_sample_observed_at: string;
  ready_at: string | null;
  ready_sample_observed_at: string | null;
};
function admission(f: Awaited<ReturnType<typeof parents>>): Admission {
  return {
    operation_id: f.operation,
    database_id: f.database,
    generation: 1,
    node_id: f.node,
    node_uid: crypto.randomUUID(),
    budget_bytes: 1024 * 1024 * 1024,
    granted_at: "2026-01-01T00:00:00.000Z",
    grant_sample_observed_at: "2025-12-31T23:59:59.000Z",
    ready_at: null,
    ready_sample_observed_at: null,
  };
}
function insert(
  row: Admission,
  table:
    | "database_start_admissions"
    | "migration_start_admissions" = "database_start_admissions",
) {
  return env.DB.prepare(
    `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(
      row,
    )
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(row))
    .run();
}

it("adds a ledger to populated D1 without rewriting parents and cascades it when the operation is removed", async () => {
  const f = await parents();
  const before = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(f.database)
    .first();
  const operation = await env.DB.prepare("SELECT * FROM operations WHERE id=?")
    .bind(f.operation)
    .first();
  const migration = (
    env as typeof env & { TEST_MIGRATIONS: D1Migration[] }
  ).TEST_MIGRATIONS.find((value) => value.name.startsWith("0019"))!;
  await env.DB.batch(
    migration.queries.map((query) =>
      env.DB.prepare(
        query
          .replaceAll("database_start_admissions", "migration_start_admissions")
          .replaceAll(
            "database_start_admission_immutable",
            "migration_start_admission_immutable",
          ),
      ),
    ),
  );
  expect(
    await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(f.database)
      .first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare("SELECT * FROM operations WHERE id=?")
      .bind(f.operation)
      .first(),
  ).toEqual(operation);
  const row = admission(f);
  await insert(row, "migration_start_admissions");
  // Old, uncertain starts keep their full hold regardless of operation status.
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='unknown',completed_at=updated_at WHERE id=?",
  )
    .bind(f.operation)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT * FROM migration_start_admissions WHERE operation_id=?",
    )
      .bind(f.operation)
      .first(),
  ).toEqual(row);
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  await env.DB.prepare("DELETE FROM operations WHERE id=?")
    .bind(f.operation)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT * FROM migration_start_admissions WHERE operation_id=?",
    )
      .bind(f.operation)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT id FROM databases WHERE id=?")
      .bind(f.database)
      .first("id"),
  ).toBe(f.database);
  await env.DB.prepare("DROP TABLE migration_start_admissions").run();
});

it("rejects a second hold for the same generation, unsafe byte budgets and incomplete readiness", async () => {
  const f = await parents(),
    row = admission(f);
  await expect(insert({ ...row, budget_bytes: 0 })).rejects.toThrow(
    "database_storage_drain_only",
  );
  await expect(
    insert({ ...row, budget_bytes: Number.MAX_SAFE_INTEGER + 1 }),
  ).rejects.toThrow("CHECK constraint failed");
  await expect(insert({ ...row, generation: 1.5 })).rejects.toThrow(
    "CHECK constraint failed",
  );
  await expect(
    insert({ ...row, granted_at: "2026-01-01T00:00:00.000X" }),
  ).rejects.toThrow("CHECK constraint failed");
  await expect(
    insert({ ...row, ready_at: "2026-01-01T00:00:01.000Z" }),
  ).rejects.toThrow("CHECK constraint failed");
  await insert(row);
  const other = newOperationId();
  await env.DB.prepare(
    "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,kind,status,project_id,database_id,generation,created_at,updated_at FROM operations WHERE id=?",
  )
    .bind(other, f.operation)
    .run();
  await expect(insert({ ...row, operation_id: other })).rejects.toThrow(
    "UNIQUE constraint failed",
  );
  expect(
    await env.DB.prepare(
      "SELECT * FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(f.operation)
      .first(),
  ).toEqual({ ...row, storage_budget_bytes: 0, storage_volume_json: null });
});

it("preserves the grant identity and sample while accepting only one complete readiness acknowledgement", async () => {
  const f = await parents(),
    row = admission(f),
    ready = "2026-01-01T00:00:01.000Z",
    sample = "2026-01-01T00:00:02.000Z";
  await insert(row);
  for (const [column, value] of Object.entries({
    operation_id: newOperationId(),
    database_id: newDatabaseId(),
    generation: 2,
    node_id: "nod_" + "x".repeat(20),
    node_uid: crypto.randomUUID(),
    budget_bytes: row.budget_bytes + 1,
    granted_at: ready,
    grant_sample_observed_at: sample,
  }))
    await expect(
      env.DB.prepare(
        `UPDATE database_start_admissions SET ${column}=? WHERE operation_id=?`,
      )
        .bind(value, f.operation)
        .run(),
    ).rejects.toThrow("database_start_admission_immutable");
  await env.DB.prepare(
    "UPDATE database_start_admissions SET ready_at=?,ready_sample_observed_at=? WHERE operation_id=?",
  )
    .bind(ready, sample, f.operation)
    .run();
  await env.DB.prepare(
    "UPDATE database_start_admissions SET ready_at=?,ready_sample_observed_at=? WHERE operation_id=?",
  )
    .bind(ready, sample, f.operation)
    .run();
  await expect(
    env.DB.prepare(
      "UPDATE database_start_admissions SET ready_at=NULL,ready_sample_observed_at=NULL WHERE operation_id=?",
    )
      .bind(f.operation)
      .run(),
  ).rejects.toThrow("database_start_admission_immutable");
  await expect(
    env.DB.prepare(
      "UPDATE database_start_admissions SET ready_sample_observed_at=? WHERE operation_id=?",
    )
      .bind("2026-01-01T00:00:03.000Z", f.operation)
      .run(),
  ).rejects.toThrow("database_start_admission_immutable");
  expect(
    await env.DB.prepare(
      "SELECT * FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(f.operation)
      .first(),
  ).toEqual({
    ...row,
    ready_at: ready,
    ready_sample_observed_at: sample,
    storage_budget_bytes: 0,
    storage_volume_json: null,
  });
});
