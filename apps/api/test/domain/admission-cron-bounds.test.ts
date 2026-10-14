// SPDX-License-Identifier: Apache-2.0
// Controlled local D1 metadata measures cron work; it is not physical runtime or Dev acceptance.
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { reclaimConfigurationFingerprint } from "@pgcf/contracts/reclaim";
import { USAGE_HOUR_MS } from "@pgcf/contracts/usage";
import { afterEach, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { admissionSnapshotCapable } from "../../src/domain/fleet-releases.ts";
import { USAGE_CRON_STATEMENT_LIMIT } from "../../src/domain/usage-cron.ts";
import {
  admissionFixtureReleases,
  admissionSnapshotFixture,
} from "./admission-snapshot-fixture.ts";
import { cleanupFixtures } from "./fixtures.ts";

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage_cron_cursor"),
    env.DB.prepare("DELETE FROM region_hint_cursor"),
    env.DB.prepare("DELETE FROM reconciliation_cursors"),
    env.DB.prepare("DELETE FROM power_timeout_cursor"),
  ]);
  await cleanupFixtures();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

/** Count executed statements while forwarding every result to the real local D1 binding. */
function countStatements(input: D1Database) {
  let count = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(),
    queries = new Map<string, number>();
  const record = (sql: string) => {
    count++;
    queries.set(sql, (queries.get(sql) ?? 0) + 1);
  };
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (["first", "all", "run", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            record(sql);
            return Reflect.apply(Reflect.get(target, property), target, args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const db = new Proxy(input, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          count += batch.length;
          return target.batch(
            batch.map((statement) => originals.get(statement) ?? statement),
          );
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db,
    count: () => count,
    admissionReads: () =>
      [...queries].reduce(
        (sum, [sql, total]) =>
          sum + (sql.includes("p.deleted_at project_deleted_at") ? total : 0),
        0,
      ),
  };
}

it(
  "bounds a fully confirmed admission-capable 1000-database cron cohort and advances both 200-row pages fairly",
  { timeout: 30000 },
  async () => {
    const f = await admissionSnapshotFixture(),
      now = Date.now(),
      createdAt = new Date(now - 4 * USAGE_HOUR_MS).toISOString(),
      ids = [
        f.id,
        ...Array.from({ length: 999 }, () => newDatabaseId()),
      ].sort();
    expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(true);
    await env.DB.prepare(
      "UPDATE databases SET observed_generation=generation-1,created_at=? WHERE id=?",
    )
      .bind(createdAt, f.id)
      .run();
    const statements: D1PreparedStatement[] = [];
    for (const id of ids.filter((id) => id !== f.id)) {
      const archive = {
          ...f.desired.archive,
          destination_path: archiveDestinationPath(
            "fixture-archive",
            f.region,
            id,
            1,
            newOperationId(),
          ),
        },
        proof = {
          ...f.proof,
          database_id: id,
          admission_epoch: 1,
          route_revision: 1,
          applied_role_revisions: [],
          tls_server_name: `database-rw.pgcf-db-${id}.svc`,
          configuration_fingerprint: await reclaimConfigurationFingerprint(
            {
              ...f.desired,
              roles: [],
              maintenance: undefined,
              archive,
            },
            f.desired.postgres!.image,
          ),
        };
      statements.push(
        env.DB.prepare(
          `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,pg_major,desired_state,observed_state,observed_power,generation,observed_generation,storage_generation,archive_path,desired_postgres_release_id,desired_postgres_image,desired_postgres_version,desired_postgres_schema_revision,runtime_attestation_json,storage_volume_json,created_at,updated_at)
        SELECT ?,project_id,region_id,node_id,?,size_class_id,pg_major,'running','ready','awake',generation,generation-1,storage_generation,?,desired_postgres_release_id,desired_postgres_image,desired_postgres_version,desired_postgres_schema_revision,?,?,?,? FROM databases WHERE id=?`,
        ).bind(
          id,
          id,
          archive.destination_path,
          JSON.stringify(proof),
          JSON.stringify(f.volume),
          createdAt,
          createdAt,
          f.id,
        ),
        env.DB.prepare(
          "INSERT INTO database_admission_epochs(database_id) VALUES(?)",
        ).bind(id),
      );
    }
    for (let offset = 0; offset < statements.length; offset += 100)
      await env.DB.batch(statements.slice(offset, offset + 100));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM databases d JOIN database_admission_epochs e ON e.database_id=d.id WHERE d.project_id=?",
      )
        .bind(f.project)
        .first("n"),
    ).toBe(1000);

    const firstCount = countStatements(env.DB),
      first = await runCron({ ...env, DB: firstCount.db }, now);
    const firstActor = await env.DB.prepare(
        "SELECT cursor FROM reconciliation_cursors WHERE name='database_actors'",
      ).first<{ cursor: string | null }>(),
      firstHint = await env.DB.prepare(
        "SELECT database_id FROM region_hint_cursor WHERE singleton=1",
      ).first<{ database_id: string | null }>();
    const secondCount = countStatements(env.DB),
      second = await runCron({ ...env, DB: secondCount.db }, now);
    console.log(
      JSON.stringify({
        event: "capable_whole_cron_bound",
        cohort: ids.length,
        first_statements: firstCount.count(),
        second_statements: secondCount.count(),
        first_admission_reads: firstCount.admissionReads(),
        second_admission_reads: secondCount.admissionReads(),
        first_usage_statements: first.usage.statements,
        second_usage_statements: second.usage.statements,
      }),
    );
    expect.soft(firstCount.count()).toBeLessThanOrEqual(850);
    expect.soft(secondCount.count()).toBeLessThanOrEqual(850);
    expect(first.usage.statements).toBeLessThanOrEqual(
      USAGE_CRON_STATEMENT_LIMIT,
    );
    expect(second.usage.statements).toBeLessThanOrEqual(
      USAGE_CRON_STATEMENT_LIMIT,
    );
    expect(firstCount.admissionReads()).toBe(200);
    expect(secondCount.admissionReads()).toBe(200);
    expect(firstActor).toEqual({ cursor: ids[199] });
    expect(firstHint).toEqual({ database_id: ids[199] });
    expect(
      await env.DB.prepare(
        "SELECT cursor FROM reconciliation_cursors WHERE name='database_actors'",
      ).first(),
    ).toEqual({ cursor: ids[399] });
    expect(
      await env.DB.prepare(
        "SELECT database_id FROM region_hint_cursor WHERE singleton=1",
      ).first(),
    ).toEqual({ database_id: ids[399] });
  },
);
