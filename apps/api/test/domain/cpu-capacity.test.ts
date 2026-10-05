// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { choosePlacement, placementNodes } from "../../src/domain/placement.ts";
import { databaseInsertStatement } from "../../src/domain/databases.ts";
import type { RegionRow, SizeRow } from "../../src/domain/rows.ts";
import { cleanupFixtures, fixture, request, observedBody } from "./fixtures.ts";

afterEach(cleanupFixtures);
describe("measured CPU admission on real Workers D1", () => {
  it("does not place a CPU-exhausted node with spare memory and storage", () => {
    const node = {
      last_observed_at: new Date().toISOString(),
      id: "test-node",
      region_id: "eu-test",
      ready: true,
      schedulable: true,
      allocatable_memory_mib: 8192,
      platform_reserved_memory_mib: 128,
      reserved_memory_mib: 0,
      allocatable_cpu_millicores: 700,
      platform_reserved_cpu_millicores: 100,
      reserved_cpu_millicores: 600,
      storage_gib_total: 60,
      reserved_storage_gib: 5,
    };
    expect(
      choosePlacement([node], node.region_id, {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 5,
      }),
    ).toBeNull();
  });

  it("keeps creates pending when CPU is exhausted despite spare memory and storage", async () => {
    const f = await fixture(8192, 60);
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_cpu_millicores=599 WHERE id=?",
    )
      .bind(f.node)
      .run();
    expect((await f.create()).status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM databases WHERE project_id=? AND node_id IS NOT NULL",
      )
        .bind(f.project)
        .first("COUNT(*)"),
    ).toBe(0);
  });

  it("rechecks concurrent captured placement snapshots in each atomic SQL insert", async () => {
    const f = await fixture(8192, 60);
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_cpu_millicores=700 WHERE id=?",
    )
      .bind(f.node)
      .run();
    const size = (await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(f.size)
      .first<SizeRow>())!;
    const region = (await env.DB.prepare("SELECT * FROM regions WHERE id=?")
      .bind(f.region)
      .first<RegionRow>())!;
    expect(
      choosePlacement(await placementNodes(env.DB, f.region), f.region, size)
        ?.id,
    ).toBe(f.node);
    const statements = ["first", "second"].map((name) => {
      const id = newDatabaseId();
      return databaseInsertStatement(env.DB, {
        body: {
          project_id: f.project,
          region_id: f.region,
          name,
          size_class_id: f.size,
        },
        size,
        region,
        nodeId: f.node,
        id,
        now: new Date().toISOString(),
        archivePath: archiveDestinationPath(
          region.backup_bucket,
          region.id,
          id,
          1,
          newOperationId(),
        ),
      });
    });
    const results = await Promise.all(
      statements.map((statement) => statement.run()),
    );
    expect(results.map((result) => result.meta.changes).sort()).toEqual([0, 1]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) FROM databases WHERE project_id=?")
        .bind(f.project)
        .first("COUNT(*)"),
    ).toBe(1);
  });

  it("concurrent API creates consume one CPU reservation and retain both operations", async () => {
    const f = await fixture(8192, 60);
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_cpu_millicores=700 WHERE id=?",
    )
      .bind(f.node)
      .run();
    const results = await Promise.all([
      f.create("cpu-first"),
      f.create("cpu-second"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 202]);
    for (const table of ["roles", "operations", "lifecycle_events"])
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) count FROM ${table} WHERE database_id IN(SELECT id FROM databases WHERE project_id=?)`,
        )
          .bind(f.project)
          .first("count"),
      ).toBe(table === "lifecycle_events" ? 1 : 2);
    expect(
      (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
    ).toBe(600);
  });

  it("distinguishes unknown platform CPU from measured zero and keeps memory ordering among CPU-fitting nodes", () => {
    const base = {
      last_observed_at: new Date().toISOString(),
      region_id: "eu-test",
      ready: true,
      schedulable: true,
      allocatable_memory_mib: 8192,
      platform_reserved_memory_mib: 128,
      reserved_memory_mib: 0,
      allocatable_cpu_millicores: 600,
      reserved_cpu_millicores: 0,
      storage_gib_total: 60,
      reserved_storage_gib: 0,
    };
    const size = { memory_mib: 512, cpu_millicores: 500, storage_gib: 5 };
    expect(
      choosePlacement([{ ...base, id: "missing" }], base.region_id, size),
    ).toBeNull();
    expect(
      choosePlacement(
        [{ ...base, id: "unknown", platform_reserved_cpu_millicores: null }],
        base.region_id,
        size,
      ),
    ).toBeNull();
    expect(
      choosePlacement(
        [{ ...base, id: "zero", platform_reserved_cpu_millicores: 0 }],
        base.region_id,
        size,
      )?.id,
    ).toBe("zero");
    expect(
      choosePlacement(
        [
          { ...base, id: "cpu-full", platform_reserved_cpu_millicores: 1 },
          {
            ...base,
            id: "less-memory",
            allocatable_memory_mib: 2048,
            platform_reserved_cpu_millicores: 0,
          },
          {
            ...base,
            id: "most-memory",
            allocatable_memory_mib: 4096,
            platform_reserved_cpu_millicores: 0,
          },
        ],
        base.region_id,
        size,
      )?.id,
    ).toBe("most-memory");
  });

  it("refuses legacy unknown CPU in both placement and direct SQL until an actual measured observation arrives", async () => {
    const f = await fixture();
    await env.DB.prepare(
      "UPDATE nodes SET platform_reserved_cpu_millicores=NULL WHERE id=?",
    )
      .bind(f.node)
      .run();
    const nodes = await placementNodes(env.DB, f.region);
    expect(nodes[0]?.platform_reserved_cpu_millicores).toBeNull();
    expect((await f.create("unknown")).status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT node_id FROM databases WHERE project_id=? AND name=?",
      )
        .bind(f.project, "unknown")
        .first("node_id"),
    ).toBeNull();
    const size = (await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(f.size)
      .first<SizeRow>())!;
    const region = (await env.DB.prepare("SELECT * FROM regions WHERE id=?")
      .bind(f.region)
      .first<RegionRow>())!;
    const id = newDatabaseId();
    const insert = await databaseInsertStatement(env.DB, {
      body: {
        project_id: f.project,
        region_id: f.region,
        name: "guarded-unknown",
        size_class_id: f.size,
      },
      size,
      region,
      nodeId: f.node,
      id,
      archivePath: archiveDestinationPath(
        region.backup_bucket,
        region.id,
        id,
        1,
        newOperationId(),
      ),
      now: new Date().toISOString(),
    }).run();
    expect(insert.meta.changes).toBe(0);
    const node = {
      name: f.nodeName,
      ready: true,
      allocatable_memory_mib: 4096,
      allocatable_cpu_millicores: 2000,
      storage_gib_total: 30,
      platform_reserved_memory_mib: 128,
      platform_reserved_cpu_millicores: 0,
    };
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([], [node]),
        )
      ).status,
    ).toBe(200);
    expect((await f.create("measured")).status).toBe(202);
    const legacy = { ...node };
    delete (legacy as { platform_reserved_cpu_millicores?: number })
      .platform_reserved_cpu_millicores;
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([], [legacy]),
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT platform_reserved_cpu_millicores FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first("platform_reserved_cpu_millicores"),
    ).toBeNull();
    expect((await f.create("legacy-again")).status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT node_id FROM databases WHERE project_id=? AND name=?",
      )
        .bind(f.project, "legacy-again")
        .first("node_id"),
    ).toBeNull();
  });

  it("counts PostgreSQL plus sidecar CPU until a database is observed deleted", async () => {
    const f = await fixture(8192, 60);
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_cpu_millicores=700 WHERE id=?",
    )
      .bind(f.node)
      .run();
    const first = await f.create("reserved");
    expect(first.status).toBe(202);
    const body = await first.json<{ database: { id: string } }>();
    expect(
      (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
    ).toBe(600);
    await env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), body.database.id)
      .run();
    expect((await f.create("still-held")).status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT node_id FROM databases WHERE project_id=? AND name=?",
      )
        .bind(f.project, "still-held")
        .first("node_id"),
    ).toBeNull();
    await env.DB.prepare(
      "UPDATE databases SET observed_state='deleted' WHERE id=?",
    )
      .bind(body.database.id)
      .run();
    expect(
      (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
    ).toBe(0);
    expect((await f.create("released")).status).toBe(202);
  });

  it("does not overwrite CPU from a newer server receipt or a foreign region", async () => {
    const f = await fixture();
    const newer = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(
      "UPDATE nodes SET updated_at=?,platform_reserved_cpu_millicores=1000 WHERE id=?",
    )
      .bind(newer, f.node)
      .run();
    const node = {
      name: f.nodeName,
      ready: true,
      allocatable_memory_mib: 4096,
      allocatable_cpu_millicores: 2000,
      storage_gib_total: 30,
      platform_reserved_memory_mib: 128,
      platform_reserved_cpu_millicores: 0,
    };
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([], [node]),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.foreignAgent,
          "POST",
          observedBody([], [node]),
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT platform_reserved_cpu_millicores FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first("platform_reserved_cpu_millicores"),
    ).toBe(1000);
  });
});
