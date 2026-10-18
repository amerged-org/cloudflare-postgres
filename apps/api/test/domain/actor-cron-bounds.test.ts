// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM reconciliation_cursors").run();
  await cleanupFixtures();
});

// This runs 202 real Durable Objects. The page bound is asserted below; shared CI
// load must not turn Vitest's default five-second deadline into a paging failure.
it(
  "bounds actor reconciliation to one page per cron invocation",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    const ids = Array.from({ length: 202 }, () => newDatabaseId()).sort();
    await env.DB.batch(
      ids.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,observed_generation,archive_path,created_at,updated_at) VALUES(?,?,?,?,?,?,'running','ready',1,1,?,?,?)",
        ).bind(
          id,
          f.project,
          f.region,
          f.node,
          id,
          f.size,
          archiveDestinationPath(
            "test-backups",
            f.region,
            id,
            1,
            newOperationId(),
          ),
          now,
          now,
        ),
        env.DB.prepare(
          "INSERT INTO database_admission_epochs(database_id) VALUES(?)",
        ).bind(id),
      ]),
    );
    const spy = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
    await runCron(env);
    const reads = spy.mock.calls.filter(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("p.deleted_at project_deleted_at"),
    );
    expect(reads).toHaveLength(200);
    expect(
      await env.DB.prepare(
        "SELECT cursor FROM reconciliation_cursors WHERE name='database_actors'",
      ).first(),
    ).toEqual({ cursor: ids[199] });
    spy.mockClear();
    await runCron(env);
    expect(
      spy.mock.calls.filter(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("p.deleted_at project_deleted_at"),
      ),
    ).toHaveLength(2);
    expect(
      await env.DB.prepare(
        "SELECT cursor FROM reconciliation_cursors WHERE name='database_actors'",
      ).first(),
    ).toEqual({ cursor: null });
  },
);
