// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupRetainedArchives } from "../../src/domain/retained-archives.ts";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  refusal,
  report,
  request,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

it("keeps the warm Actor of a lost node's database closed and takes no report of its databases from the lost node", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(await verdicts(await report(f, id, 1))).toEqual(["accept"]);
  const placement = await env.DB.prepare(
    "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first();
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  expect((await actor.ensureAwake(id, "app")).ok).toBe(true);
  expect((await actor.admit(id, "app")).ok).toBe(true);
  const lost = await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
    expected_node_uid: f.nodeUid,
    reason: "confirmed source node loss",
  });
  expect(lost.status).toBe(200);
  const tombstone = await env.DB.prepare("SELECT * FROM nodes WHERE id=?")
    .bind(f.node)
    .first();

  // This Actor still holds its warm seeded presence; authority must override it.
  expect(await actor.ensureAwake(id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await actor.admit(id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  // The lost node's page holds its fence and no database, and its reports of databases are not taken.
  const page = await desiredPage(f);
  expect(page.databases).toEqual([]);
  expect(page.release).toBeNull();
  const deletion = DatabaseWithOperation.parse(
    await (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).json(),
  );
  expect((await desiredPage(f)).databases).toEqual([]);
  for (const [generation, state] of [
    [1, "ready"],
    [deletion.database.generation, "deleted"],
  ] as const) {
    const response = await report(f, id, generation, state);
    expect(response.status).toBe(200);
    expect(await verdicts(response)).toEqual([]);
  }
  expect(
    (
      await (
        await request(`/v1/operations/${deletion.operation.id}`, f.integrator)
      ).json<{ status: string }>()
    ).status,
  ).toBe("pending");
  expect(
    await env.DB.prepare(
      "SELECT node_id,archive_path,storage_generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual(placement);
  expect(
    await env.DB.prepare("SELECT * FROM nodes WHERE id=?").bind(f.node).first(),
  ).toEqual(tombstone);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(id)
      .first("count"),
  ).toBe(0);
});

it("purges a database deleted on a lost node once its node is fenced and its archive has expired", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(await verdicts(await report(f, id, 1))).toEqual(["accept"]);
  const archivePath = await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ archive_path: string }>();
  const prefix =
    archivePath!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  expect(
    (
      await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
        expected_node_uid: f.nodeUid,
        reason: "confirmed source node loss",
      })
    ).status,
  ).toBe(200);
  // The fence completes: the Tunnel is gone and the instance is powered off.
  const fenced = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
  )
    .bind(fenced, fenced, fenced, f.node)
    .run();
  expect(
    (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  const expiry = await env.DB.prepare(
    "SELECT expires_at FROM retained_archives WHERE source_database_id=?",
  )
    .bind(id)
    .first<{ expires_at: string }>();
  const now = Date.parse(expiry!.expires_at);
  await env.ARCHIVE.put(`${prefix}base/20260101T000000/data.tar.gz`, "payload");
  await env.ARCHIVE.put(
    `${prefix}wals/0000000100000000/000000010000000000000001.gz`,
    "wal",
  );
  // The archive's recorded digests and backfill marker go with the archive.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO archive_backup_digests(archive_path,backup_id,digest,recorded_at) VALUES(?,?,?,?)",
    ).bind(
      archivePath!.archive_path,
      "20260101T000000",
      "0".repeat(64),
      fenced,
    ),
    env.DB.prepare(
      "INSERT INTO archive_digest_backfill(archive_path,done_at) VALUES(?,?)",
    ).bind(archivePath!.archive_path, fenced),
  ]);
  expect(await cleanupRetainedArchives(env, now)).toEqual({
    purged: 0,
    objects: 2,
  });
  expect(await cleanupRetainedArchives(env, now)).toEqual({
    purged: 1,
    objects: 0,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM retained_archives WHERE source_database_id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) count FROM roles WHERE database_id=?")
      .bind(id)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM archive_backup_digests WHERE archive_path=?) AS digests, (SELECT COUNT(*) FROM archive_digest_backfill WHERE archive_path=?) AS backfills",
    )
      .bind(archivePath!.archive_path, archivePath!.archive_path)
      .first(),
  ).toEqual({ digests: 0, backfills: 0 });
  // The node never reports the deletion, so the purge closes the delete operation.
  expect(
    await env.DB.prepare(
      "SELECT status,error_code FROM operations WHERE database_id=? AND kind='database.delete'",
    )
      .bind(id)
      .first(),
  ).toEqual({ status: "succeeded", error_code: null });
});

it("shows a delete on a lost node as failed while its archive is overdue for purge, and closes it once the purge completes", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(await verdicts(await report(f, id, 1))).toEqual(["accept"]);
  const archivePath = await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ archive_path: string }>();
  const prefix =
    archivePath!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
    expected_node_uid: f.nodeUid,
    reason: "confirmed source node loss",
  });
  const fenced = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
  )
    .bind(fenced, fenced, fenced, f.node)
    .run();
  expect(
    (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  const expiry = await env.DB.prepare(
    "SELECT expires_at FROM retained_archives WHERE source_database_id=?",
  )
    .bind(id)
    .first<{ expires_at: string }>();
  const expired = Date.parse(expiry!.expires_at);
  await env.ARCHIVE.put(`${prefix}base/20260101T000000/data.tar.gz`, "payload");
  const operation = () =>
    env.DB.prepare(
      "SELECT status,error_code FROM operations WHERE database_id=? AND kind='database.delete'",
    )
      .bind(id)
      .first();
  // Before the expiry nothing is purged, and the operation stays open.
  await cleanupRetainedArchives(env, expired - 60_000);
  expect(await operation()).toEqual({ status: "pending", error_code: null });
  // Two hours past expiry the archive is still there (its objects go first): the operation says so.
  const late = expired + 2 * 3_600_000;
  expect((await cleanupRetainedArchives(env, late)).purged).toBe(0);
  expect(await operation()).toEqual({
    status: "failed",
    error_code: "archive_purge_incomplete",
  });
  // The next run purges the row, and the operation closes with it.
  expect((await cleanupRetainedArchives(env, late)).purged).toBe(1);
  expect(await operation()).toEqual({ status: "succeeded", error_code: null });
});

it("refuses to restore from a lost node's database until the node is fenced", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(await verdicts(await report(f, id, 1))).toEqual(["accept"]);
  expect(
    (
      await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
        expected_node_uid: f.nodeUid,
        reason: "confirmed source node loss",
      })
    ).status,
  ).toBe(200);
  const restore = () =>
    request(`/v1/databases/${id}/restore`, f.integrator, "POST", {
      name: "from-lost",
      mode: "full",
    });
  // Lost but not fenced: the node can still write, so its archive is not read.
  expect(await refusal(await restore())).toMatchObject({
    status: 409,
    reason: "not_ready",
  });
  const fenced = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
  )
    .bind(fenced, fenced, fenced, f.node)
    .run();
  // Fenced: the archive is read, and this one holds no recovery point.
  expect(await refusal(await restore())).toMatchObject({
    reason: "no_recovery_point",
  });
});
