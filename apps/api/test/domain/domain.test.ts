// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  DesiredResponse,
  ConnectionUri,
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { keyring } from "../../src/crypto/keyring.ts";
import { runCron } from "../../src/cron.ts";
import { choosePlacement } from "../../src/domain/placement.ts";
import { truncateAgentText } from "../../src/domain/observations.ts";
import { databaseInsertStatement } from "../../src/domain/databases.ts";
import type { RoleRow, SizeRow, RegionRow } from "../../src/domain/rows.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

async function created(
  f: Awaited<ReturnType<typeof fixture>>,
  name = "database",
) {
  const response = await f.create(name);
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json());
}
describe("database domain on real Workers D1", () => {
  it("places by free memory, includes sidecar and rejects unknown storage", () => {
    const base = {
      region_id: "eu-1",
      ready: true,
      schedulable: true,
      allocatable_memory_mib: 1024,
      platform_reserved_memory_mib: 128,
      allocatable_cpu_millicores: 2000,
      platform_reserved_cpu_millicores: 100,
      reserved_cpu_millicores: 0,
      storage_gib_total: 10,
      reserved_memory_mib: 0,
      reserved_storage_gib: 0,
    };
    const nodes = [
      { ...base, id: "one", reserved_memory_mib: 300 },
      { ...base, id: "two" },
      {
        ...base,
        id: "unknown",
        allocatable_memory_mib: 9999,
        storage_gib_total: null,
      },
    ];
    expect(
      choosePlacement(nodes, "eu-1", {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 5,
      })?.id,
    ).toBe("two");
    expect(
      choosePlacement(nodes, "eu-1", {
        memory_mib: 800,
        cpu_millicores: 500,
        storage_gib: 5,
      }),
    ).toBeNull();
    expect(
      choosePlacement(nodes, "us-1", {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 5,
      }),
    ).toBeNull();
  });
  it("guards concurrent placement and retains complete pending creates", async () => {
    const f = await fixture(1408, 10); // 128 platform + exactly two (512 + 128) reservations.
    const results = await Promise.all([
      f.create("one"),
      f.create("two"),
      f.create("three"),
      f.create("four"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 202, 202, 202]);
    for (const table of [
      "databases",
      "roles",
      "operations",
      "lifecycle_events",
    ])
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) count FROM ${table} WHERE ${table === "roles" || table === "operations" || table === "lifecycle_events" ? "database_id IN(SELECT id FROM databases WHERE project_id=?)" : "project_id=?"}`,
        )
          .bind(f.project)
          .first("count"),
      ).toBe(table === "lifecycle_events" ? 2 : 4);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM databases WHERE project_id=? AND node_id IS NOT NULL",
      )
        .bind(f.project)
        .first("count"),
    ).toBe(2);
    const noStorage = await fixture(4096, null);
    expect((await noStorage.create()).status).toBe(202);
    expect(
      await env.DB.prepare("SELECT node_id FROM databases WHERE project_id=?")
        .bind(noStorage.project)
        .first("node_id"),
    ).toBeNull();
  });
  it("rejects a changed class snapshot before the first guarded insert", async () => {
    const f = await fixture();
    const size = (await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(f.size)
      .first<SizeRow>())!;
    const region = (await env.DB.prepare("SELECT * FROM regions WHERE id=?")
      .bind(f.region)
      .first<RegionRow>())!;
    const id = newDatabaseId(),
      now = new Date().toISOString();
    const snapshot = {
      body: {
        project_id: f.project,
        region_id: f.region,
        name: "guarded",
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
      now,
    };
    await env.DB.prepare(
      "UPDATE size_classes SET cpu_millicores=cpu_millicores+100 WHERE id=?",
    )
      .bind(f.size)
      .run();
    expect(
      (await databaseInsertStatement(env.DB, snapshot).run()).meta.changes,
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) count FROM databases WHERE id=?")
        .bind(id)
        .first("count"),
    ).toBe(0);
  });
  it("replays create once and preserves the fixed archive across role revisions", async () => {
    const f = await fixture(),
      key = crypto.randomUUID();
    const first = await f.create("once", f.integrator, key),
      body = DatabaseWithOperation.parse(await first.json());
    expect((await f.create("once", f.integrator, key)).status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM databases WHERE project_id=?",
      )
        .bind(f.project)
        .first("count"),
    ).toBe(1);
    const before = await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(body.database.id)
      .first("archive_path");
    const roleKey = crypto.randomUUID(),
      rolePath = `/v1/databases/${body.database.id}/roles`;
    expect(
      (
        await request(
          rolePath,
          f.integrator,
          "POST",
          { name: "reader" },
          roleKey,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          rolePath,
          f.integrator,
          "POST",
          { name: "reader" },
          roleKey,
        )
      ).status,
    ).toBe(201);
    expect(
      await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
        .bind(body.database.id)
        .first("generation"),
    ).toBe(2);
    expect(
      (
        await request(
          `${rolePath}/reader/reset-password`,
          f.integrator,
          "POST",
          undefined,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
        .bind(body.database.id)
        .first("generation"),
    ).toBe(3);
    expect(
      await env.DB.prepare("SELECT archive_path FROM databases WHERE id=?")
        .bind(body.database.id)
        .first("archive_path"),
    ).toBe(before);
  });
  it("pages desired state without omitting unapplied deletion tombstones", async () => {
    const f = await fixture();
    const first = await created(f, "one"),
      second = await created(f, "two");
    expect(
      (
        await request(
          `/v1/databases/${first.database.id}`,
          f.integrator,
          "DELETE",
        )
      ).status,
    ).toBe(202);
    const pageOne = DesiredResponse.parse(
      await (await request("/agent/v1/desired?limit=1", f.agent)).json(),
    );
    expect(pageOne.databases).toHaveLength(1);
    expect(pageOne.next).not.toBeNull();
    const pageTwo = DesiredResponse.parse(
      await (
        await request(
          `/agent/v1/desired?limit=1&after=${pageOne.next}`,
          f.agent,
        )
      ).json(),
    );
    expect(pageTwo.next).toBeNull();
    expect(
      [...pageOne.databases, ...pageTwo.databases].map((db) => db.id).sort(),
    ).toEqual([first.database.id, second.database.id].sort());
    expect(
      [...pageOne.databases, ...pageTwo.databases].find(
        (db) => db.id === first.database.id,
      )?.desired_state,
    ).toBe("deleted");
  });
  it("keeps credentials encrypted and exposes passwords only in integrator URIs and desired", async () => {
    const f = await fixture(),
      body = await created(f),
      id = body.database.id;
    const canary = crypto.getRandomValues(new Uint8Array(32));
    const password = btoa(String.fromCharCode(...canary))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const encrypted = await keyring(env.CREDENTIAL_KEYS).encrypt(
      id,
      "app",
      password,
    );
    await env.DB.prepare(
      "UPDATE roles SET password_ciphertext=?,password_iv=?,password_kid=? WHERE database_id=? AND name=?",
    )
      .bind(encrypted.ciphertext, encrypted.iv, encrypted.kid, id, "app")
      .run();
    const stored = await env.DB.prepare(
      "SELECT * FROM roles WHERE database_id=?",
    )
      .bind(id)
      .all<RoleRow>();
    expect(JSON.stringify(stored.results)).not.toContain(password);
    const admin = ConnectionUri.parse(
      await (
        await request(`/v1/databases/${id}/roles/app/connection-uri`, f.admin)
      ).json(),
    );
    expect(admin.includes_password).toBe(false);
    expect(admin.uri).not.toContain(password);
    const integrator = ConnectionUri.parse(
      await (
        await request(
          `/v1/databases/${id}/roles/app/connection-uri`,
          f.integrator,
        )
      ).json(),
    );
    expect(integrator.includes_password).toBe(true);
    expect(integrator.uri).toContain(password);
    const desired = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    );
    expect(desired.databases.find((d) => d.id === id)?.roles[0]?.password).toBe(
      password,
    );
    const roles = await (
      await request(`/v1/databases/${id}/roles`, f.admin)
    ).json();
    expect(JSON.stringify(roles)).not.toContain(password);
  });
  it("scopes every domain resource to its project", async () => {
    const f = await fixture(),
      body = await created(f),
      id = body.database.id;
    const paths = [
      `/v1/databases/${id}`,
      `/v1/databases/${id}/roles`,
      `/v1/databases/${id}/roles/app/connection-uri`,
      `/v1/databases/${id}/archive`,
      `/v1/operations/${body.operation.id}`,
    ];
    for (const path of paths)
      expect((await request(path, f.otherKey)).status).toBe(404);
    expect(
      (await request(`/v1/databases/${id}`, f.otherKey, "DELETE")).status,
    ).toBe(404);
    expect(
      (
        await request(`/v1/databases/${id}/roles`, f.otherKey, "POST", {
          name: "reader",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/v1/databases/${id}/roles/app/reset-password`,
          f.otherKey,
          "POST",
        )
      ).status,
    ).toBe(404);
    expect((await f.create("foreign", f.otherKey)).status).toBe(404);
    expect(await (await request("/v1/databases", f.otherKey)).json()).toEqual({
      data: [],
      next_cursor: null,
    });
  });
  it("ignores stale and foreign observations, retries errors and retains deletion tombstones", async () => {
    const f = await fixture(),
      body = await created(f),
      id = body.database.id;
    const post = (key: string, obs: unknown[]) =>
      request("/agent/v1/observations", key, "POST", observedBody(obs));
    expect(
      await (await post(f.foreignAgent, [observation(id, 1)])).json(),
    ).toEqual({ accepted: 0 });
    expect(
      (
        await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
          name: "reader",
        })
      ).status,
    ).toBe(201);
    expect(await (await post(f.agent, [observation(id, 1)])).json()).toEqual({
      accepted: 0,
    });
    expect(
      await (
        await post(f.agent, [observation(id, 2, "error", "transient")])
      ).json(),
    ).toEqual({ accepted: 1 });
    expect(await (await post(f.agent, [observation(id, 2)])).json()).toEqual({
      accepted: 1,
    });
    const ready = await env.DB.prepare(
      "SELECT observed_state,observed_generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first();
    expect(ready).toEqual({ observed_state: "ready", observed_generation: 2 });
    expect(
      (
        await (
          await request(`/v1/operations/${body.operation.id}`, f.integrator)
        ).json<{ status: string }>()
      ).status,
    ).toBe("succeeded");
    expect(
      await (await post(f.agent, [observation(id, 2, "provisioning")])).json(),
    ).toEqual({ accepted: 0 });
    const deleted = await request(
      `/v1/databases/${id}`,
      f.integrator,
      "DELETE",
    );
    expect(deleted.status).toBe(202);
    const deletion = DatabaseWithOperation.parse(await deleted.json());
    const desired = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    );
    expect(desired.databases.find((d) => d.id === id)).toMatchObject({
      desired_state: "deleted",
      roles: [],
    });
    expect(
      await (await post(f.agent, [observation(id, 3, "deleted")])).json(),
    ).toEqual({ accepted: 1 });
    expect(
      (
        await (
          await request(`/v1/operations/${deletion.operation.id}`, f.integrator)
        ).json<{ status: string }>()
      ).status,
    ).toBe("succeeded");
    expect(
      DesiredResponse.parse(
        await (await request("/agent/v1/desired", f.agent)).json(),
      ).databases.some((d) => d.id === id),
    ).toBe(false);
    expect(
      (
        await request(
          `/v1/databases/${id}/roles/app/connection-uri`,
          f.integrator,
        )
      ).status,
    ).toBe(404);
  });
  it("completes creates on matching ready revisions and never manufactures WAL health", async () => {
    const f = await fixture(),
      body = await created(f),
      id = body.database.id;
    const obs = observation(id, 1);
    const raw = {
      ...obs,
      archive: { continuous: true, ready_wal_files: null },
    };
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([raw]),
        )
      ).status,
    ).toBe(200);
    const database = await (
      await request(`/v1/databases/${id}`, f.integrator)
    ).json<{ health: { archiving: string }; observed_generation: number }>();
    expect(database.health.archiving).toBe("unknown");
    expect(database.observed_generation).toBe(1);
    expect(
      (
        await (
          await request(`/v1/operations/${body.operation.id}`, f.integrator)
        ).json<{ status: string }>()
      ).status,
    ).toBe("succeeded");
  });
  it("authenticates region agents and truncates messages to 4096 UTF-8 bytes", async () => {
    const f = await fixture(),
      body = await created(f),
      id = body.database.id;
    expect((await request("/agent/v1/desired", f.integrator)).status).toBe(401);
    expect(
      (
        await request(
          "/agent/v1/desired",
          f.agent.slice(0, -1) + (f.agent.endsWith("a") ? "b" : "a"),
        )
      ).status,
    ).toBe(401);
    const foreign = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.foreignAgent)).json(),
    );
    expect(foreign.databases).toEqual([]);
    const message = "é".repeat(3000);
    expect(new TextEncoder().encode(truncateAgentText(message)).length).toBe(
      4096,
    );
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(id, 1, "error", message)]),
        )
      ).status,
    ).toBe(200);
    const stored = await env.DB.prepare(
      "SELECT status_message FROM databases WHERE id=?",
    )
      .bind(id)
      .first<string>("status_message");
    expect(new TextEncoder().encode(stored!).length).toBe(4096);
  });
  it("lists real R2 backup catalogs and WAL and rejects a mismatched region binding", async () => {
    const f = await fixture(),
      body = await created(f),
      id = body.database.id;
    const archive = await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(id)
      .first<string>("archive_path");
    const prefix =
      archive!.slice("s3://".length + env.ARCHIVE_BUCKET_NAME.length + 1) +
      "/database/";
    const keys = [
      prefix + "base/run/backup.info",
      prefix + "base/run/data.tar.gz",
      prefix + "wals/0000000100000000/" + "000000010000000000000001",
    ];
    for (const key of keys) await env.ARCHIVE.put(key, new Uint8Array(7));
    try {
      expect(
        await (
          await request(`/v1/databases/${id}/archive`, f.integrator)
        ).json(),
      ).toEqual({
        database_id: id,
        base_backup_count: 1,
        wal_count: 1,
        bytes: 21,
      });
    } finally {
      await env.ARCHIVE.delete(keys);
    }
    await env.DB.prepare("UPDATE regions SET backup_bucket=? WHERE id=?")
      .bind("other-" + crypto.randomUUID().replaceAll("-", ""), f.region)
      .run();
    expect(
      (await request(`/v1/databases/${id}/archive`, f.integrator)).status,
    ).toBe(500);
  });
  it("sweeps stale operations without changing desired state", async () => {
    const f = await fixture(),
      body = await created(f),
      old = new Date(Date.now() - 21 * 60_000).toISOString();
    await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
      .bind(old, body.operation.id)
      .run();
    const result = await runCron(env);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(
      await env.DB.prepare(
        "SELECT status,error_code FROM operations WHERE id=?",
      )
        .bind(body.operation.id)
        .first(),
    ).toEqual({ status: "failed", error_code: "operation_timeout" });
    expect(
      await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
        .bind(body.database.id)
        .first("desired_state"),
    ).toBe("running");
  });
});
