// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  enforceBackupRetention,
  expireSupersededArchives,
  retainBackups,
  runBackupRetention,
} from "../../src/domain/backup-retention.ts";
import { ensureArchiveCredential } from "../../src/domain/archive-credentials.ts";
import { readRestoreCatalog } from "../../src/domain/restore-catalog.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import {
  BACKUP,
  cleanup,
  lifecycle,
  observation,
  report,
} from "./lifecycle-fixture.ts";

const keys = new Set<string>();
afterEach(async () => {
  if (keys.size) await env.ARCHIVE.delete([...keys].slice(0, 1000));
  keys.clear();
  await cleanup();
});
const DAY = 86_400_000;
const wal = (segment: number, timeline = 1) =>
  `${timeline.toString(16).padStart(8, "0")}00000000${segment.toString(16).toUpperCase().padStart(8, "0")}`;
const put = async (key: string, body = "x") => {
  keys.add(key);
  await env.ARCHIVE.put(key, body);
};
async function list(prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix, cursor });
    found.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return found.sort();
}

/** A database whose archive the tests fill as Barman lays it out. */
async function archive(now = Date.now()) {
  const f = await lifecycle(),
    row = await f.row();
  const root = row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "");
  const prefix = `${root}/database/`;
  const ago = (days: number) => new Date(now - days * DAY);
  /** A base backup begun `from` and finished `to` days ago, spanning the WAL segments given. */
  const backup = async (
    from: number,
    to: number,
    beginSegment: number,
    endSegment: number,
    status = "DONE",
  ) => {
    const begin = ago(from),
      id = begin.toISOString().replace(/[-:]/g, "").slice(0, 15);
    await put(
      `${prefix}base/${id}/backup.info`,
      `status=${status}\nbegin_time=${begin.toISOString()}\nend_time=${ago(to).toISOString()}\nbegin_wal=${wal(beginSegment)}\nend_wal=${wal(endSegment)}\nxlog_segment_size=16777216\n`,
    );
    await put(`${prefix}base/${id}/data.tar.gz`, "data");
    await put(`${prefix}base/${id}/data_1.tar.gz`, "data");
    return id;
  };
  const segments = async (from: number, to: number, timeline = 1) => {
    for (let n = from; n <= to; n++)
      await put(
        `${prefix}wals/${wal(n, timeline).slice(0, 16)}/${wal(n, timeline)}.gz`,
      );
  };
  const names = async () =>
    (await list(prefix)).map((key) => key.slice(prefix.length));
  return { ...f, prefix, root, now, backup, segments, names, ago };
}
const wals = (names: string[]) =>
  names
    .filter((n) => n.startsWith("wals/") && !n.includes("history"))
    .map((n) => n.slice(n.lastIndexOf("/") + 1, -3));
const bases = (names: string[]) => [
  ...new Set(
    names.filter((n) => n.startsWith("base/")).map((n) => n.split("/")[1]!),
  ),
];

it("keeps what the recovery window needs: the newest backup at or before its start, and everything after", async () => {
  const a = await archive();
  const b1 = await a.backup(21, 20, 1, 3),
    b2 = await a.backup(11, 10, 4, 6),
    b3 = await a.backup(6, 5, 7, 9);
  await a.segments(1, 12);
  await put(`${a.prefix}wals/00000002.history`, "history");
  const history = "wals/00000002.history";
  const other = `${a.root.replace(/\/g1-/, "/g2-")}/database/base/${b1}/backup.info`;
  await put(other, "another generation");
  const result = await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY);
  expect(result).toEqual({ backups: 1, objects: 3 + 3, complete: true });
  const names = await a.names();
  expect(bases(names)).toEqual([b2, b3].sort());
  // The segments before the anchor's first one are gone; its own and every later one stay.
  expect(wals(names)).toEqual(Array.from({ length: 9 }, (_, i) => wal(i + 4)));
  expect(names).toContain(history);
  expect(await list(other)).toEqual([other]);
});

it("deletes the compressed backup labels and partial segments that lie before the anchor, like the segments", async () => {
  const a = await archive();
  await a.backup(21, 20, 1, 3);
  await a.backup(11, 10, 4, 6);
  await a.segments(1, 8);
  const extra = (n: number, suffix: string) =>
    `${a.prefix}wals/${wal(n).slice(0, 16)}/${wal(n)}${suffix}`;
  for (const [n, suffix] of [
    [2, ".00000028.backup.gz"],
    [3, ".partial.gz"],
    [3, ".partial"],
    [5, ".00000028.backup.gz"],
    [7, ".partial.gz"],
  ] as const)
    await put(extra(n, suffix));
  await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY);
  const names = await a.names();
  expect(names.filter((n) => /backup\.gz$|partial/.test(n))).toEqual(
    [
      `wals/${wal(5).slice(0, 16)}/${wal(5)}.00000028.backup.gz`,
      `wals/${wal(7).slice(0, 16)}/${wal(7)}.partial.gz`,
    ].sort(),
  );
});

it("never deletes the newest DONE backup, however old", async () => {
  const a = await archive();
  await a.backup(40, 39, 1, 2);
  const newest = await a.backup(30, 29, 3, 4);
  await a.segments(1, 6);
  const result = await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY);
  expect(result.backups).toBe(1);
  const names = await a.names();
  expect(bases(names)).toEqual([newest]);
  expect(wals(names)).toEqual([3, 4, 5, 6].map((n) => wal(n)));
});

it("deletes nothing while every backup is inside the window or none is complete", async () => {
  const a = await archive();
  await a.backup(5, 4, 1, 2);
  await a.backup(2, 1, 3, 4);
  await a.segments(1, 5);
  const before = await a.names();
  expect(await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY)).toEqual({
    backups: 0,
    objects: 0,
    complete: true,
  });
  expect(await a.names()).toEqual(before);
  // A backup older than the window whose WAL chain has a gap is no anchor.
  const b = await archive();
  await b.backup(20, 19, 1, 3);
  await b.segments(1, 1);
  await b.segments(3, 5);
  const gap = await b.names();
  expect(await retainBackups(env.ARCHIVE, b.prefix, b.now - 7 * DAY)).toEqual({
    backups: 0,
    objects: 0,
    complete: true,
  });
  expect(await b.names()).toEqual(gap);
});

it("removes unfinished backups older than the anchor and leaves a newer one that may still be running", async () => {
  const a = await archive();
  const failed = await a.backup(30, 29, 1, 2, "FAILED");
  await a.backup(20, 19, 3, 4);
  const running = await a.backup(0.01, 0.005, 9, 10, "STARTED");
  await a.segments(3, 12);
  await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY);
  const names = await a.names();
  expect(bases(names)).not.toContain(failed);
  expect(bases(names)).toContain(running);
  expect(bases(names)).toHaveLength(2);
});

it("follows the timeline: the segments of older timelines go, those of the anchor's timeline before it too", async () => {
  const a = await archive();
  // The anchor was taken on timeline 2, after a promotion that left timeline 1 behind.
  const begin = a.ago(11),
    id = begin.toISOString().replace(/[-:]/g, "").slice(0, 15);
  await put(
    `${a.prefix}base/${id}/backup.info`,
    `status=DONE\nbegin_time=${begin.toISOString()}\nend_time=${a.ago(10).toISOString()}\nbegin_wal=${wal(5, 2)}\nend_wal=${wal(6, 2)}\nxlog_segment_size=16777216\n`,
  );
  await put(`${a.prefix}base/${id}/data.tar.gz`);
  await put(`${a.prefix}wals/00000002.history`, "history");
  await a.segments(1, 8, 1);
  await a.segments(4, 8, 2);
  await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY);
  const names = await a.names();
  expect(wals(names)).toEqual([5, 6, 7, 8].map((n) => wal(n, 2)));
  expect(names).toContain("wals/00000002.history");
  expect(bases(names)).toEqual([id]);
});

it("leaves an archive alone when WAL of a later timeline makes its backups unusable", async () => {
  const a = await archive();
  await a.backup(21, 20, 1, 3);
  await a.backup(11, 10, 4, 6);
  await a.segments(1, 8, 1);
  await a.segments(7, 8, 2);
  const before = await a.names();
  expect(await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY)).toEqual({
    backups: 0,
    objects: 0,
    complete: true,
  });
  expect(await a.names()).toEqual(before);
});

it("deletes the descriptor of a backup before its data, in bounded calls", async () => {
  const a = await archive();
  const old = await a.backup(21, 20, 1, 3);
  await a.backup(11, 10, 4, 6);
  await a.segments(1, 8);
  const calls: string[][] = [];
  const recording = new Proxy(env.ARCHIVE, {
    get(target, property) {
      if (property === "delete")
        return async (keys: string | string[]) => {
          calls.push([keys].flat());
          return target.delete(keys);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await retainBackups(recording, a.prefix, a.now - 7 * DAY);
  expect(calls.flat()).toHaveLength(6);
  expect(calls[0]).toEqual([`${a.prefix}base/${old}/backup.info`]);
  expect(calls.every((call) => call.length <= 1000)).toBe(true);
});

it("stops at the limit it was given and reports that more remains", async () => {
  const a = await archive();
  await a.backup(21, 20, 1, 3);
  await a.backup(11, 10, 4, 6);
  await a.segments(1, 12);
  const first = await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY, 2);
  expect(first).toEqual({ backups: 1, objects: 2, complete: false });
  // The descriptor went first, so the old backup is already out of the catalog.
  const second = await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY);
  expect(second.complete).toBe(true);
  const names = await a.names();
  expect(bases(names)).toHaveLength(1);
  expect(wals(names)[0]).toBe(wal(4));
});

it("applies each database's own recovery window from its size class, once it has a new backup or after a while", async () => {
  const a = await archive();
  await a.backup(21, 20, 1, 3);
  await a.backup(11, 10, 4, 6);
  await a.segments(1, 8);
  const runs = () =>
    env.DB.prepare(
      "SELECT database_id,backups_deleted,objects_deleted FROM backup_retention_runs",
    ).all();
  // A 30 day window keeps all.
  await env.DB.prepare(
    "UPDATE size_classes SET backup_retention_days=30 WHERE id=?",
  )
    .bind(a.size)
    .run();
  expect(await enforceBackupRetention(env, a.now)).toMatchObject({
    checked: 1,
    backups: 0,
  });
  expect((await runs()).results).toEqual([
    { database_id: a.id, backups_deleted: 0, objects_deleted: 0 },
  ]);
  // Not due again for hours, whatever the window.
  await env.DB.prepare(
    "UPDATE size_classes SET backup_retention_days=7 WHERE id=?",
  )
    .bind(a.size)
    .run();
  expect(await enforceBackupRetention(env, a.now + 3600_000)).toMatchObject({
    checked: 0,
  });
  // A new DONE backup makes it due at once.
  await env.DB.prepare(
    "UPDATE databases SET backup_last_completed_at=? WHERE id=?",
  )
    .bind(new Date(a.now + 4000_000).toISOString(), a.id)
    .run();
  expect(await enforceBackupRetention(env, a.now + 4100_000)).toMatchObject({
    checked: 1,
    backups: 1,
  });
  expect(bases(await a.names())).toHaveLength(1);
  // The node's report of a base backup that finished after the check makes it due as well.
  expect(await enforceBackupRetention(env, a.now + 4400_000)).toMatchObject({
    checked: 0,
  });
  await applyLifecycleObservations(
    env,
    a.node,
    report([
      observation({
        id: a.id,
        generation: 1,
        operation: a.operation,
        state: "ready",
        backup: {
          ...BACKUP,
          completed_at: new Date(a.now + 4500_000).toISOString(),
        },
      }),
    ]),
    a.now + 4600_000,
  );
  expect(await enforceBackupRetention(env, a.now + 4700_000)).toMatchObject({
    checked: 1,
  });
  // And again after six hours without one.
  expect(
    await enforceBackupRetention(env, a.now + 7 * 3600_000 + 5000_000),
  ).toMatchObject({
    checked: 1,
    backups: 0,
  });
});

it("leaves a database alone while a restore from its archive runs, and applies the window after it", async () => {
  const a = await archive();
  await a.backup(21, 20, 1, 3);
  await a.backup(11, 10, 4, 6);
  await a.segments(1, 8);
  const target = DatabaseWithOperation.parse(
    await (await a.create("restored")).json(),
  );
  const operation = "op_" + "r".repeat(20),
    at = new Date(a.now).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO backup_retention_runs(database_id,archive_path,checked_at) SELECT id,archive_path,? FROM databases WHERE id=?",
    ).bind(at, target.database.id),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES (?,'database.restore','running',?,?,1,?,?)",
    ).bind(operation, a.project, target.database.id, at, at),
    env.DB.prepare(
      "INSERT INTO database_restores(target_database_id,operation_id,source_database_id,source_archive_path,source_storage_generation,backup_id,target_time,created_at) SELECT ?,?,id,archive_path,storage_generation,'20261018T093000',?,? FROM databases WHERE id=?",
    ).bind(target.database.id, operation, at, at, a.id),
  ]);
  const before = await a.names();
  expect(await enforceBackupRetention(env, a.now)).toMatchObject({
    checked: 0,
  });
  expect(await a.names()).toEqual(before);
  await env.DB.prepare(
    "UPDATE operations SET status='succeeded',completed_at=?,updated_at=? WHERE id=?",
  )
    .bind(at, at, operation)
    .run();
  expect(await enforceBackupRetention(env, a.now)).toMatchObject({
    checked: 1,
    backups: 1,
  });
});

it("trims an archive that is beyond the bounds of the restore catalog instead of leaving it to grow", async () => {
  const a = await archive();
  // Daily backups: the restore catalog refuses more than 64 of them.
  const ids: string[] = [];
  for (let i = 0; i < 65; i++)
    ids.push(await a.backup(65 - i, 65 - i - 0.01, 2 * i + 1, 2 * i + 2));
  await a.segments(1, 131);
  await expect(readRestoreCatalog(env.ARCHIVE, a.prefix)).rejects.toMatchObject(
    { details: { reason: "archive_unusable" } },
  );
  const run = await enforceBackupRetention(env, a.now);
  expect(run).toMatchObject({ checked: 1, backups: 57, failed: 0 });
  const names = await a.names();
  // The anchor is the newest backup that ended before the window; everything newer stays.
  expect(bases(names)).toEqual(ids.slice(57));
  expect(wals(names)).toEqual(
    Array.from({ length: 131 - 114 }, (_, i) => wal(115 + i)),
  );
  // The archive is within the catalog's bounds again.
  expect(
    (await readRestoreCatalog(env.ARCHIVE, a.prefix)).backups,
  ).toHaveLength(8);
});

it("deletes nothing from an oversized archive whose newest old backups cannot be restored", async () => {
  const a = await archive();
  for (let i = 0; i < 65; i++)
    await a.backup(65 - i, 65 - i - 0.01, 2 * i + 1, 2 * i + 2);
  // Not one segment is archived: no backup has its WAL.
  const before = await a.names();
  expect(await retainBackups(env.ARCHIVE, a.prefix, a.now - 7 * DAY)).toEqual({
    backups: 0,
    objects: 0,
    complete: true,
  });
  expect(await a.names()).toEqual(before);
});

it("takes the databases never checked first, a few per run, and leaves deleted databases to their own expiry", async () => {
  const a = await archive(),
    b = await archive();
  await env.DB.prepare(
    "INSERT INTO backup_retention_runs(database_id,archive_path,checked_at) SELECT id,archive_path,? FROM databases WHERE id=?",
  )
    .bind(new Date(a.now - 10 * 3600_000).toISOString(), b.id)
    .run();
  const first = await enforceBackupRetention(env, a.now, 1);
  expect(first.checked).toBe(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT database_id FROM backup_retention_runs WHERE checked_at>=? ORDER BY database_id",
      )
        .bind(new Date(a.now).toISOString())
        .all()
    ).results,
  ).toEqual([{ database_id: a.id }]);
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date(a.now).toISOString(), b.id)
    .run();
  expect(await enforceBackupRetention(env, a.now, 5)).toMatchObject({
    checked: 0,
  });
});

it("expires the archive a move left behind once the recovery window has passed, and never the current one", async () => {
  const a = await archive();
  await a.backup(2, 1, 1, 2);
  await a.segments(1, 3);
  const old = await a.names();
  const oldPath = (await a.row()).archive_path;
  // A completed move: the database lives on a newer generation of its own.
  const operation = "op_" + "m".repeat(20);
  const next = oldPath.replace(/\/g1-op_[a-z0-9]{20}$/, `/g2-${operation}`);
  await env.DB.exec(
    `UPDATE databases SET storage_generation=2 WHERE id='${a.id}'`,
  );
  await env.DB.prepare("UPDATE databases SET archive_path=? WHERE id=?")
    .bind(next, a.id)
    .run();
  const completed = new Date(a.now - DAY).toISOString();
  await env.DB.prepare(
    `INSERT INTO database_moves(operation,database_id,project_id,region_id,source_node_id,target_node_id,source_storage_generation,source_archive_path,status,target_generation,target_storage_generation,target_archive_path,backup_id,proven_sleep_json,created_at,updated_at,completed_at)
    SELECT ?,d.id,d.project_id,d.region_id,d.node_id,?,1,?,'done',2,2,?,'20261018T093000','{}',?,?,? FROM databases d WHERE d.id=?`,
  )
    .bind(
      operation,
      a.other,
      oldPath,
      next,
      completed,
      completed,
      completed,
      a.id,
    )
    .run();
  // Inside the window (7 days): kept.
  expect(await expireSupersededArchives(env, a.now)).toEqual({
    archives: 0,
    objects: 0,
  });
  expect(await a.names()).toEqual(old);
  // Past it: the whole generation goes, in bounded passes, and then the row says so.
  const later = a.now + 7 * DAY;
  let passes = 0;
  for (;;) {
    const result = await expireSupersededArchives(env, later, 3);
    passes++;
    if (result.archives === 1) break;
    expect(result.objects).toBeGreaterThan(0);
    expect(passes).toBeLessThan(10);
  }
  expect(passes).toBeGreaterThan(1);
  expect(await list(a.root + "/")).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT source_archive_deleted_at FROM database_moves WHERE operation=?",
    )
      .bind(operation)
      .first("source_archive_deleted_at"),
  ).not.toBeNull();
  expect(await expireSupersededArchives(env, later)).toEqual({
    archives: 0,
    objects: 0,
  });
});

it("expires the archive a failed move's target staged, once the recovery window has passed since the move ended", async () => {
  const a = await archive();
  const current = (await a.row()).archive_path;
  const operation = "op_" + "f".repeat(20);
  const staged = current.replace(/\/g1-op_[a-z0-9]{20}$/, `/g2-${operation}`);
  const root = staged.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "");
  for (const key of [
    `${root}/database/base/20261018T100000/backup.info`,
    `${root}/database/wals/0000000200000000/000000020000000000000001.gz`,
  ])
    await put(key);
  const failedAt = new Date(a.now - DAY).toISOString();
  await env.DB.prepare(
    `INSERT INTO database_moves(operation,database_id,project_id,region_id,source_node_id,target_node_id,source_storage_generation,source_archive_path,status,failure,target_generation,target_storage_generation,target_archive_path,backup_id,proven_sleep_json,created_at,updated_at,completed_at)
    SELECT ?,d.id,d.project_id,d.region_id,d.node_id,?,1,d.archive_path,'failed','build_failed',2,2,?,'20261018T093000','{}',?,?,? FROM databases d WHERE d.id=?`,
  )
    .bind(operation, a.other, staged, failedAt, failedAt, failedAt, a.id)
    .run();
  // Inside the window (7 days): kept, and the database's own archive is not touched.
  expect(await expireSupersededArchives(env, a.now)).toEqual({
    archives: 0,
    objects: 0,
  });
  expect(await list(root + "/")).toHaveLength(2);
  const later = a.now + 7 * DAY;
  let archives = 0;
  for (let pass = 0; archives === 0 && pass < 5; pass++)
    archives += (await expireSupersededArchives(env, later, 1)).archives;
  expect(archives).toBe(1);
  expect(await list(root + "/")).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT target_archive_deleted_at FROM database_moves WHERE operation=?",
    )
      .bind(operation)
      .first("target_archive_deleted_at"),
  ).not.toBeNull();
});

it("refuses to expire a path that is still the database's current archive", async () => {
  const a = await archive();
  await a.backup(2, 1, 1, 2);
  const path = (await a.row()).archive_path;
  const operation = "op_" + "n".repeat(20);
  const completed = new Date(a.now - 30 * DAY).toISOString();
  await env.DB.prepare(
    `INSERT INTO database_moves(operation,database_id,project_id,region_id,source_node_id,target_node_id,source_storage_generation,source_archive_path,status,target_generation,target_storage_generation,target_archive_path,backup_id,proven_sleep_json,created_at,updated_at,completed_at)
    SELECT ?,d.id,d.project_id,d.region_id,d.node_id,?,1,?,'done',2,2,?,'20261018T093000','{}',?,?,? FROM databases d WHERE d.id=?`,
  )
    .bind(
      operation,
      a.other,
      path,
      path.replace("/g1-", "/g2-"),
      completed,
      completed,
      completed,
      a.id,
    )
    .run();
  const before = await a.names();
  expect(await expireSupersededArchives(env, a.now)).toEqual({
    archives: 0,
    objects: 0,
  });
  expect(await a.names()).toEqual(before);
});

it("purges expired credentials in the same step, and fails the step after the other parts ran when one part failed", async () => {
  const a = await archive();
  const reference = await ensureArchiveCredential(
    env.DB,
    {
      nodeId: a.node,
      archivePath: (await a.row()).archive_path,
      access: "read_write",
    },
    a.now - 9 * DAY,
  );
  await runBackupRetention(env, a.now);
  expect(
    await env.DB.prepare("SELECT id FROM archive_credentials WHERE id=?")
      .bind(reference.id)
      .first(),
  ).toBeNull();
  // A region whose bucket is not bound here: the windows cannot be applied.
  const again = await ensureArchiveCredential(
    env.DB,
    {
      nodeId: a.node,
      archivePath: (await a.row()).archive_path,
      access: "read_write",
    },
    a.now - 9 * DAY,
  );
  await env.DB.prepare(
    "UPDATE regions SET backup_bucket='unbound-bucket' WHERE id=?",
  )
    .bind(a.region)
    .run();
  await expect(runBackupRetention(env, a.now + 7 * 3600_000)).rejects.toThrow(
    "backup_retention_failed",
  );
  expect(
    await env.DB.prepare("SELECT id FROM archive_credentials WHERE id=?")
      .bind(again.id)
      .first(),
  ).toBeNull();
});
