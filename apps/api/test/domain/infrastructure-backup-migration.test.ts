// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
const attempts = migrations.find((migration) =>
  migration.name.startsWith("0043"),
)!;
afterEach(async () => {
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  await cleanupFixtures();
});

it("numbers existing daily runs attempt 1 and keeps every artifact, its cascade and the health index", async () => {
  const f = await fixture(),
    complete = crypto.randomUUID(),
    failed = crypto.randomUUID(),
    cluster = crypto.randomUUID();
  // The setup hook applied every migration; recreate the populated 0039 tables, then upgrade them.
  await env.DB.batch([
    env.DB.prepare("DROP TABLE infrastructure_backup_artifacts"),
    env.DB.prepare("DROP TABLE infrastructure_backup_runs"),
    ...migrations
      .find((migration) => migration.name.startsWith("0039"))!
      .queries.filter((query) =>
        /CREATE (?:TABLE|INDEX) infrastructure_backup_(?:runs|artifacts|health_idx)\b/.test(
          query,
        ),
      )
      .map((query) => env.DB.prepare(query)),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,config_revision,status,created_at,completed_at,expires_at,error_code) VALUES(?,'2026-10-09',3,'complete','2026-10-09T00:00:00.000Z','2026-10-09T00:30:00.000Z','2026-10-09T02:00:00.000Z',NULL),(?,'2026-10-10',3,'failed','2026-10-10T00:00:00.000Z','2026-10-10T00:05:00.000Z','2026-10-10T02:00:00.000Z','infrastructure_backup_snapshot_source_unavailable')",
    ).bind(complete, failed),
    env.DB.prepare(
      `INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,node_id,node_uid,cluster_uid,material_revision,status,completed_at,error_code,object_key,kid,plaintext_sha256,plaintext_bytes,encrypted_sha256,encrypted_bytes)
      VALUES(?1,'d1-control','d1','2026-10-09',?3,'control-d1',NULL,NULL,NULL,NULL,'complete','2026-10-09T00:10:00.000Z',NULL,'infrastructure/v1/2026-10-09/'||?1||'/d1-control.pgcfenc','v1',?5,42,?6,80),
      (?1,'etcd-'||?3,'etcd','2026-10-09',?3,?4,?7,?8,?4,1,'complete','2026-10-09T00:20:00.000Z',NULL,'infrastructure/v1/2026-10-09/'||?1||'/etcd.pgcfenc','v1',?6,7,?5,9),
      (?2,'d1-control','d1','2026-10-10',?3,'control-d1',NULL,NULL,NULL,NULL,'failed',NULL,'infrastructure_backup_snapshot_source_unavailable','infrastructure/v1/2026-10-10/'||?2||'/d1-control.pgcfenc',NULL,NULL,NULL,NULL,NULL)`,
    ).bind(
      complete,
      failed,
      f.region,
      cluster,
      "a".repeat(64),
      "b".repeat(64),
      f.node,
      crypto.randomUUID(),
    ),
  ]);
  const rows = (table: string) =>
    env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1,2`)
      .all()
      .then((result) => result.results);
  const runs = await rows("infrastructure_backup_runs"),
    artifacts = await rows("infrastructure_backup_artifacts");
  await env.DB.prepare("DELETE FROM d1_migrations WHERE name=?")
    .bind(attempts.name)
    .run();
  await applyD1Migrations(env.DB, [attempts]);

  expect(await rows("infrastructure_backup_runs")).toEqual(
    runs.map((run) => ({ ...run, attempt: 1 })),
  );
  expect(await rows("infrastructure_backup_artifacts")).toEqual(artifacts);
  expect(
    (
      await env.DB.prepare(
        "SELECT type,name,tbl_name FROM sqlite_master WHERE name LIKE 'infrastructure_backup_%' AND name NOT LIKE 'infrastructure_backup_config%' ORDER BY name",
      ).all()
    ).results,
  ).toEqual([
    {
      type: "table",
      name: "infrastructure_backup_artifacts",
      tbl_name: "infrastructure_backup_artifacts",
    },
    {
      type: "table",
      name: "infrastructure_backup_deferrals",
      tbl_name: "infrastructure_backup_deferrals",
    },
    {
      type: "index",
      name: "infrastructure_backup_health_idx",
      tbl_name: "infrastructure_backup_artifacts",
    },
    {
      type: "table",
      name: "infrastructure_backup_runs",
      tbl_name: "infrastructure_backup_runs",
    },
  ]);
  // A failed day takes a second attempt; each attempt number stays unique.
  const retry = (id: string) =>
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,'2026-10-10',2,3,'pending','2026-10-10T00:15:00.000Z','2026-10-10T02:15:00.000Z')",
    )
      .bind(id)
      .run();
  await retry(crypto.randomUUID());
  await expect(retry(crypto.randomUUID())).rejects.toThrow(
    "UNIQUE constraint failed",
  );
  // Artifacts reference the rebuilt runs and still cascade with them.
  await expect(
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,object_key) VALUES(?,'d1-control','d1','2026-10-10',?,'control-d1','pending',?)",
    )
      .bind(crypto.randomUUID(), f.region, crypto.randomUUID())
      .run(),
  ).rejects.toThrow("FOREIGN KEY constraint failed");
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs WHERE id=?")
    .bind(complete)
    .run();
  expect(
    (
      await env.DB.prepare(
        "SELECT run_id,id FROM infrastructure_backup_artifacts ORDER BY run_id,id",
      ).all()
    ).results,
  ).toEqual([{ run_id: failed, id: "d1-control" }]);
});
