// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  ConnectionUri,
  TEXT_MAX_LENGTH,
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
  presentRoles,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { keyring } from "../../src/crypto/keyring.ts";
import { runCron } from "../../src/cron.ts";
import { databaseInsertStatement } from "../../src/domain/databases.ts";
import type { RoleRow, SizeRow } from "../../src/domain/rows.ts";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  nodeRequest,
  observationOf,
  report,
  reportBody,
  request,
  verdicts,
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
  it("guards concurrent placement and retains complete pending creates", async () => {
    const f = await fixture(1536, 10); // Two 512 MiB databases are 67 % of the node, three would be 100 %.
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
      nodeId: f.node,
      id,
      archivePath: archiveDestinationPath(
        env.ARCHIVE_BUCKET_NAME,
        f.region,
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
    const pageOne = await desiredPage(f, "?limit=1");
    expect(pageOne.databases).toHaveLength(1);
    expect(pageOne.next).not.toBeNull();
    const pageTwo = await desiredPage(f, `?limit=1&after=${pageOne.next}`);
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
  it("keeps credentials encrypted and exposes passwords only in integrator URIs and the node page", async () => {
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
    const desired = await desiredPage(f);
    expect(
      presentRoles(desired.databases.find((d) => d.id === id)!)[0]?.password,
    ).toBe(password);
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
        await request(
          `/v1/databases/${id}/roles`,
          f.otherKey,
          "POST",
          {
            name: "reader",
          },
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/v1/databases/${id}/roles/app/reset-password`,
          f.otherKey,
          "POST",
          undefined,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(404);
    expect((await f.create("foreign", f.otherKey)).status).toBe(404);
    expect(await (await request("/v1/databases", f.otherKey)).json()).toEqual({
      data: [],
      next_cursor: null,
    });
  });
  it("ignores stale and foreign observations, ends an operation on a node error for good and retains deletion tombstones", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      body = await created(f),
      id = body.database.id;
    expect(await verdicts(await report(foreign, id, 1))).toEqual(["stale"]);
    expect(
      (
        await request(
          `/v1/databases/${id}/roles`,
          f.integrator,
          "POST",
          {
            name: "reader",
          },
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(201);
    expect(await verdicts(await report(f, id, 1))).toEqual(["stale"]);
    expect(
      await verdicts(
        await report(f, id, 2, "error", {
          error: "start_failed",
          message: "transient",
        }),
      ),
    ).toEqual(["accept"]);
    expect(await verdicts(await report(f, id, 2))).toEqual(["accept"]);
    const ready = await env.DB.prepare(
      "SELECT observed_state,observed_generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first();
    expect(ready).toEqual({ observed_state: "ready", observed_generation: 2 });
    // The node's error ended the create; the database that became ready later does not revive it.
    expect(
      await (
        await request(`/v1/operations/${body.operation.id}`, f.integrator)
      ).json<{ status: string; error: { code: string } }>(),
    ).toMatchObject({ status: "failed", error: { code: "start_failed" } });
    const deleted = await request(
      `/v1/databases/${id}`,
      f.integrator,
      "DELETE",
    );
    expect(deleted.status).toBe(202);
    const deletion = DatabaseWithOperation.parse(await deleted.json());
    const desired = await desiredPage(f);
    expect(desired.databases.find((d) => d.id === id)).toMatchObject({
      desired_state: "deleted",
      roles: [],
    });
    expect(await verdicts(await report(f, id, 3, "deleted"))).toEqual([
      "accept",
    ]);
    expect(
      (
        await (
          await request(`/v1/operations/${deletion.operation.id}`, f.integrator)
        ).json<{ status: string }>()
      ).status,
    ).toBe("succeeded");
    expect((await desiredPage(f)).databases.some((d) => d.id === id)).toBe(
      false,
    );
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
    expect(
      (
        await report(f, id, 1, "ready", {
          archive: {
            last_segment: null,
            ready_files: null,
            failing_since: null,
          },
        })
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
  it("shows only its own databases to a node and bounds the message of an observation", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      body = await created(f),
      id = body.database.id;
    expect((await desiredPage(f)).databases.map((d) => d.id)).toEqual([id]);
    expect((await desiredPage(foreign)).databases).toEqual([]);
    const send = async (message: string) =>
      nodeRequest(f, "/node/v1/observations", {
        method: "POST",
        body: reportBody([
          await observationOf(id, 1, "error", {
            error: "start_failed",
            message,
          }),
        ]),
      });
    expect((await send("é".repeat(TEXT_MAX_LENGTH + 1))).status).toBe(400);
    const bounded = "é".repeat(TEXT_MAX_LENGTH);
    expect((await send(bounded)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT status_message FROM databases WHERE id=?")
        .bind(id)
        .first<string>("status_message"),
    ).toBe(Array.from(`start_failed: ${bounded}`).slice(0, 4096).join(""));
  });
  it("lists real R2 backup catalogs and WAL and rejects a path that names another bucket", async () => {
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
    await env.DB.prepare("UPDATE databases SET archive_path=? WHERE id=?")
      .bind(
        archive!.replace(
          `s3://${env.ARCHIVE_BUCKET_NAME}/`,
          "s3://an-older-bucket/",
        ),
        id,
      )
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
