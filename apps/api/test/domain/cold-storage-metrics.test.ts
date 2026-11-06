// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  DatabaseWithOperation,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  readColdStorageMetrics,
  emitColdStorageMetrics,
} from "../../src/domain/cold-storage-metrics.ts";
import { measureBackupUsage } from "../../src/domain/backup-usage.ts";
import { cleanup, lifecycle, PROOF } from "./lifecycle-fixture.ts";

const keys: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanup();
});
async function operation(
  f: Awaited<ReturnType<typeof lifecycle>>,
  kind: "database.archive" | "database.rehydrate",
  status: "running" | "succeeded" | "failed",
  start: number,
  finish: number | null,
) {
  const id = newOperationId();
  await env.DB.prepare(
    `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,error_code,created_at,updated_at,completed_at)
    VALUES(?,?,?,?,?,1,?,?,?,?)`,
  )
    .bind(
      id,
      kind,
      status,
      f.project,
      f.id,
      status === "failed" ? "build_failed" : null,
      new Date(start).toISOString(),
      new Date(finish ?? start).toISOString(),
      finish === null ? null : new Date(finish).toISOString(),
    )
    .run();
  return id;
}

it("emits one bounded metric record and distinguishes no archives from unmeasured reclaimed bytes", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const now = Date.now();
  await emitColdStorageMetrics(env, now);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
    event: "cold_storage_metrics",
    observed_at: new Date(now).toISOString(),
    databases: { local: 0, archiving: 0, archived: 0, restoring: 0 },
    archives_removed: 0,
    restores_24h: {
      succeeded: 0,
      failed: 0,
      duration_avg_ms: null,
      duration_max_ms: null,
    },
    oldest_pending_age_ms: null,
    archived_backup_bytes: 0,
    archived_backup_measured: 0,
    archived_backup_unknown: 0,
    archived_backup_oldest_observed_at: null,
    archived_backup_newest_observed_at: null,
    released_physical_bytes: null,
  });
});

it("counts residency, acknowledged removals, restore outcomes and durations without inferring physical bytes", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  for (const residency of ["local", "archiving", "restoring"]) {
    const created = DatabaseWithOperation.parse(
      await (await f.create(`metric-${residency}`)).json(),
    );
    await env.DB.prepare("UPDATE databases SET storage_residency=? WHERE id=?")
      .bind(residency, created.database.id)
      .run();
  }
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archived',node_id=NULL WHERE id=?",
  )
    .bind(f.id)
    .run();
  const archive = await operation(
    f,
    "database.archive",
    "succeeded",
    now - 700_000,
    now - 600_000,
  );
  const at = new Date(now - 600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,phase,source_node_id,source_generation,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,verification_receipt_json,source_removed_at,created_at,updated_at,completed_at)
    VALUES(?,'archive',?,?,?,'archived',?,1,1,?,'20261018T093000',?,'{}',?,?,?,?)`,
  )
    .bind(
      archive,
      f.id,
      f.project,
      f.region,
      f.node,
      row.archive_path,
      JSON.stringify(PROOF),
      at,
      at,
      at,
      at,
    )
    .run();
  await operation(
    f,
    "database.rehydrate",
    "succeeded",
    now - 60_000,
    now - 40_000,
  );
  await operation(
    f,
    "database.rehydrate",
    "succeeded",
    now - 50_000,
    now - 10_000,
  );
  await operation(
    f,
    "database.rehydrate",
    "failed",
    now - 200_000,
    now - 100_000,
  );
  await operation(
    f,
    "database.rehydrate",
    "succeeded",
    now - 90_000_000,
    now - 89_000_000,
  );
  await operation(f, "database.rehydrate", "running", now - 300_000, null);
  const measured = await readColdStorageMetrics(env, now);
  expect(measured.databases).toEqual({
    local: 1,
    archiving: 1,
    archived: 1,
    restoring: 1,
  });
  expect(measured.archives_removed).toBe(1);
  expect(measured.restores_24h).toEqual({
    succeeded: 2,
    failed: 1,
    duration_avg_ms: 30_000,
    duration_max_ms: 40_000,
  });
  expect(measured.oldest_pending_age_ms).toBe(300_000);
  expect(measured.archived_backup_bytes).toBeNull();
  expect(measured.archived_backup_unknown).toBe(1);
  expect(measured.released_physical_bytes).toBeNull();
});

it("uses the latest complete backup measurement only for its matching current archive generation", async () => {
  const f = await lifecycle(),
    row = await f.row();
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archived',node_id=NULL WHERE id=?",
  )
    .bind(f.id)
    .run();
  const key =
    row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/metric-data";
  keys.push(key);
  await env.ARCHIVE.put(key, new Uint8Array(17));
  const sample = await measureBackupUsage(env, f.id);
  expect(sample.status).toBe("measured");
  const first = await readColdStorageMetrics(env);
  expect(first.archived_backup_bytes).toBe(17);
  expect(first.archived_backup_measured).toBe(1);
  expect(first.archived_backup_oldest_observed_at).toBe(
    sample.sample!.observed_at,
  );
  // The old producer's identity must not describe a later generation even with the same ID.
  await env.DB.prepare(
    "UPDATE databases SET archive_path=?,storage_generation=2 WHERE id=?",
  )
    .bind(
      archiveDestinationPath(
        env.ARCHIVE_BUCKET_NAME,
        f.region,
        f.id,
        2,
        newOperationId(),
      ),
      f.id,
    )
    .run();
  expect((await readColdStorageMetrics(env)).archived_backup_bytes).toBeNull();
  expect((await readColdStorageMetrics(env)).archived_backup_unknown).toBe(1);
  // A complete measurement of an actually empty prefix is a real zero.
  expect((await measureBackupUsage(env, f.id)).sample?.backup_bytes).toBe(0);
  expect((await readColdStorageMetrics(env)).archived_backup_bytes).toBe(0);
  // An unavailable latest measurement overrides the preceding known size, never becomes zero.
  expect(
    (
      await measureBackupUsage(
        { ...env, ARCHIVE_BUCKET_NAME: "unbound-bucket" },
        f.id,
      )
    ).status,
  ).toBe("unavailable");
  expect((await readColdStorageMetrics(env)).archived_backup_bytes).toBeNull();
});
