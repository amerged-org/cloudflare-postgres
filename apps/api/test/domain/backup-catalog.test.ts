// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanupFixtures();
});

type Catalog = {
  database_id: string;
  earliest_restorable_time: string | null;
  latest_restorable_time: string | null;
  base_backups: { id: string; started_at: string; completed_at: string }[];
};
const wal = (segment: number) =>
  `00000001${"0".repeat(8)}${segment.toString(16).toUpperCase().padStart(8, "0")}`;
async function database() {
  const f = await fixture();
  const created = (await (await f.create()).json()) as {
    database: { id: string };
  };
  const id = created.database.id;
  const row = await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ archive_path: string }>();
  const prefix =
    row!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  const put = async (key: string, value: string) => {
    keys.push(key);
    await env.ARCHIVE.put(key, value);
  };
  /** A Barman base backup whose data and first and last WAL segment exist in the archive. */
  const backup = async (
    begin: Date,
    end: Date,
    beginSegment: number,
    endSegment: number,
  ) => {
    const id = begin.toISOString().replace(/[-:]/g, "").slice(0, 15);
    await put(
      `${prefix}base/${id}/backup.info`,
      `status=DONE\nbegin_time=${begin.toISOString()}\nend_time=${end.toISOString()}\nbegin_wal=${wal(beginSegment)}\nend_wal=${wal(endSegment)}\nxlog_segment_size=16777216\n`,
    );
    await put(`${prefix}base/${id}/data.tar.gz`, "payload");
    return id;
  };
  const segment = (n: number, extension = "gz") =>
    put(`${prefix}wals/${wal(n).slice(0, 16)}/${wal(n)}.${extension}`, "wal");
  const catalog = async (as = f.integrator, id = created.database.id) => {
    const response = await request(`/v1/databases/${id}/backups`, as);
    expect(response.status).toBe(200);
    return response.json<Catalog>();
  };
  return { ...f, id, prefix, backup, segment, catalog, put };
}

it("has no window while the archive holds no complete base backup", async () => {
  const f = await database();
  expect(await f.catalog()).toEqual({
    database_id: f.id,
    earliest_restorable_time: null,
    latest_restorable_time: null,
    base_backups: [],
  });
  // WAL alone restores nothing; a base backup whose WAL chain is missing does not count either.
  await f.segment(2);
  await f.backup(
    new Date(Date.now() - 7200_000),
    new Date(Date.now() - 7100_000),
    1,
    1,
  );
  expect((await f.catalog()).earliest_restorable_time).toBeNull();
});

it("reports the window and the complete base backups, newest first", async () => {
  const f = await database();
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60_000);
  const older = await f.backup(at(180), at(170), 1, 1);
  const newer = await f.backup(at(60), at(50), 3, 3);
  // The chain is gap free from the first backup to the newest segment.
  for (const n of [1, 2, 3, 4]) await f.segment(n);
  // A backup that points at a segment that was never archived is not restorable and is not listed.
  await f.backup(at(20), at(10), 9, 9);
  const body = await f.catalog();
  expect(body.database_id).toBe(f.id);
  expect(body.base_backups).toEqual([
    {
      id: newer,
      started_at: at(60).toISOString(),
      completed_at: at(50).toISOString(),
    },
    {
      id: older,
      started_at: at(180).toISOString(),
      completed_at: at(170).toISOString(),
    },
  ]);
  // The window opens when the oldest complete base backup finished ...
  expect(body.earliest_restorable_time).toBe(at(170).toISOString());
  // ... and the newest archived segment bounds its end.
  const newest = await env.ARCHIVE.head(
    `${f.prefix}wals/${wal(4).slice(0, 16)}/${wal(4)}.gz`,
  );
  expect(body.latest_restorable_time).toBe(newest!.uploaded.toISOString());
});

it("treats an archive it cannot read completely as unknown", async () => {
  const f = await database();
  await f.backup(
    new Date(Date.now() - 7200_000),
    new Date(Date.now() - 7100_000),
    1,
    1,
  );
  await f.segment(1);
  // One segment under two names: the listing is not trustworthy.
  await f.segment(1, "zst");
  expect(await f.catalog()).toMatchObject({
    earliest_restorable_time: null,
    latest_restorable_time: null,
    base_backups: [],
  });
});

it("answers only for the project of the key and keeps a deleted database's archive readable until retention ends", async () => {
  const f = await database();
  await f.backup(
    new Date(Date.now() - 7200_000),
    new Date(Date.now() - 7100_000),
    1,
    1,
  );
  await f.segment(1);
  expect(
    (await request(`/v1/databases/${f.id}/backups`, f.otherKey)).status,
  ).toBe(404);
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  expect((await f.catalog()).base_backups).toHaveLength(1);
  await env.DB.prepare(
    "UPDATE retained_archives SET deleted_at=?,expires_at=? WHERE source_database_id=?",
  )
    .bind(
      new Date(Date.now() - 8 * 86400000).toISOString(),
      new Date(Date.now() - 86400000).toISOString(),
      f.id,
    )
    .run();
  expect(await f.catalog()).toMatchObject({
    earliest_restorable_time: null,
    base_backups: [],
  });
});
