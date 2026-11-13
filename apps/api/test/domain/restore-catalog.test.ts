// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  recordBackupDigest,
  recordedDigests,
} from "../../src/domain/archive-digests.ts";
import {
  parseBackupInfo,
  readRestoreCatalog,
  restoreBackup,
} from "../../src/domain/restore-catalog.ts";

it("ignores what a node uploaded after its fence when the catalog is read up to that time", async () => {
  const prefix = `catalog-fence/${crypto.randomUUID()}/`;
  const wal = (segment: number) =>
    `00000001${"0".repeat(8)}${segment.toString(16).toUpperCase().padStart(8, "0")}`;
  const backupInfo = (id: string, end: Date, endSegment: number) =>
    `status=DONE\nbegin_time=${new Date(end.getTime() - 60_000).toISOString()}\nend_time=${end.toISOString()}\nbegin_wal=${wal(1)}\nend_wal=${wal(endSegment)}\nxlog_segment_size=16777216\n`;
  const put = (key: string, body: string) =>
    env.ARCHIVE.put(`${prefix}${key}`, body);
  // The node's own complete backup and its WAL, written before the fence.
  const legit = "20260101T000000";
  await put(
    `base/${legit}/backup.info`,
    backupInfo(legit, new Date("2026-01-01T00:01:00Z"), 3),
  );
  await put(`base/${legit}/data.tar.gz`, "data");
  for (let n = 1; n <= 3; n++)
    await put(`wals/${wal(n).slice(0, 16)}/${wal(n)}`, "wal");
  // The Worker records the digest of the backup it was told about, before the fence.
  await recordBackupDigest(
    env.ARCHIVE,
    env.DB,
    `s3://${env.ARCHIVE_BUCKET_NAME}/${prefix}`,
    prefix,
    legit,
    Date.now(),
  );
  const recorded = await recordedDigests(
    env.DB,
    `s3://${env.ARCHIVE_BUCKET_NAME}/${prefix}`,
  );
  const fenced = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A compromised node keeps writing: a newer backup that ends later, junk descriptors past the
  // catalog's limit, and a later segment.
  const fake = "20260102T000000";
  await put(
    `base/${fake}/backup.info`,
    backupInfo(fake, new Date("2026-01-02T00:01:00Z"), 3),
  );
  await put(`base/${fake}/data.tar.gz`, "data");
  for (let i = 0; i < 65; i++)
    await put(
      `base/20250101T${String(i).padStart(6, "0")}/backup.info`,
      "junk",
    );
  await put(`wals/${wal(9).slice(0, 16)}/${wal(9)}`, "wal");

  const catalog = await readRestoreCatalog(
    env.ARCHIVE,
    prefix,
    fenced,
    recorded,
  );
  expect(catalog.backups.map((backup) => backup.id)).toEqual([legit]);
  expect(catalog.newestWalAt).not.toBeNull();
  expect(Date.parse(catalog.newestWalAt!)).toBeLessThanOrEqual(
    Date.parse(fenced),
  );
  await env.ARCHIVE.delete(
    (await env.ARCHIVE.list({ prefix })).objects.map((o) => o.key),
  );
});
it("reads actual Barman backup.info without a serialized backup ID", () => {
  const id = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15),
    time = new Date(Date.now() - 10000).toISOString(),
    wal = "00000001" + "0".repeat(15) + "1";
  const text = `status=DONE\nbegin_time=${time}\nend_time=${time}\nbegin_wal=${wal}\nend_wal=${wal}\nxlog_segment_size=16777216\n`;
  expect(parseBackupInfo(text, id)).not.toBeNull();
  expect(parseBackupInfo(text + "status=DONE\n", id)).toBeNull();
});

it("trusts a backup only while its objects match the digest the Worker recorded, and refuses one that changed", async () => {
  const prefix = `catalog-digest/${crypto.randomUUID()}/`;
  const archivePath = `s3://${env.ARCHIVE_BUCKET_NAME}/${prefix}`;
  const wal = (segment: number) =>
    `00000001${"0".repeat(8)}${segment.toString(16).toUpperCase().padStart(8, "0")}`;
  const put = (key: string, body: string) =>
    env.ARCHIVE.put(`${prefix}${key}`, body);
  const id = "20260101T000000";
  await put(
    `base/${id}/backup.info`,
    `status=DONE\nbegin_time=2026-01-01T00:00:00Z\nend_time=2026-01-01T00:01:00Z\nbegin_wal=${wal(1)}\nend_wal=${wal(3)}\nxlog_segment_size=16777216\n`,
  );
  await put(`base/${id}/data.tar.gz`, "data");
  for (let n = 1; n <= 3; n++)
    await put(`wals/${wal(n).slice(0, 16)}/${wal(n)}`, "wal");
  // Not recorded by the Worker: the backup is not trusted, whatever its descriptor says.
  expect(
    (await readRestoreCatalog(env.ARCHIVE, prefix, undefined, new Map()))
      .backups,
  ).toEqual([]);
  await recordBackupDigest(
    env.ARCHIVE,
    env.DB,
    archivePath,
    prefix,
    id,
    Date.now(),
  );
  const recorded = await recordedDigests(env.DB, archivePath);
  expect(
    (
      await readRestoreCatalog(env.ARCHIVE, prefix, undefined, recorded)
    ).backups.map((backup) => backup.id),
  ).toEqual([id]);
  // The data changed after the digest was recorded: the backup is left out, and with no trusted backup
  // left the restore refuses the archive.
  await put(`base/${id}/data.tar.gz`, "changed");
  expect(
    await readRestoreCatalog(env.ARCHIVE, prefix, undefined, recorded),
  ).toMatchObject({ backups: [], mismatched: [id] });
  await expect(
    restoreBackup(env.ARCHIVE, prefix, undefined, undefined, recorded),
  ).rejects.toMatchObject({ details: { reason: "archive_digest_mismatch" } });
  await env.ARCHIVE.delete(
    (await env.ARCHIVE.list({ prefix })).objects.map((o) => o.key),
  );
});

it("drops only the backup whose objects changed, and refuses the archive only when no trusted backup remains", async () => {
  const prefix = `catalog-drop/${crypto.randomUUID()}/`;
  const archivePath = `s3://${env.ARCHIVE_BUCKET_NAME}/${prefix}`;
  const wal = (segment: number) =>
    `00000001${"0".repeat(8)}${segment.toString(16).toUpperCase().padStart(8, "0")}`;
  const put = (key: string, body: string) =>
    env.ARCHIVE.put(`${prefix}${key}`, body);
  const older = "20260101T000000",
    newer = "20260102T000000";
  const complete = (id: string, day: string, begin: number, end: number) =>
    Promise.all([
      put(
        `base/${id}/backup.info`,
        `status=DONE\nbegin_time=${day}T00:00:00Z\nend_time=${day}T00:01:00Z\nbegin_wal=${wal(begin)}\nend_wal=${wal(end)}\nxlog_segment_size=16777216\n`,
      ),
      put(`base/${id}/data.tar.gz`, `data of ${id}`),
    ]);
  await complete(older, "2026-01-01", 1, 3);
  await complete(newer, "2026-01-02", 4, 6);
  for (let n = 1; n <= 6; n++)
    await put(`wals/${wal(n).slice(0, 16)}/${wal(n)}`, "wal");
  await recordBackupDigest(
    env.ARCHIVE,
    env.DB,
    archivePath,
    prefix,
    older,
    Date.now(),
  );
  await recordBackupDigest(
    env.ARCHIVE,
    env.DB,
    archivePath,
    prefix,
    newer,
    Date.now(),
  );
  const recorded = await recordedDigests(env.DB, archivePath);
  await put(`base/${newer}/data.tar.gz`, "changed");
  // The newer backup no longer matches: the older one is still offered, and is what a restore takes.
  const catalog = await readRestoreCatalog(
    env.ARCHIVE,
    prefix,
    undefined,
    recorded,
  );
  expect(catalog.backups.map((backup) => backup.id)).toEqual([older]);
  expect(catalog.mismatched).toEqual([newer]);
  expect(
    (await restoreBackup(env.ARCHIVE, prefix, undefined, undefined, recorded))
      .id,
  ).toBe(older);
  // Nothing is deleted: the changed backup is still in the archive.
  expect(
    await env.ARCHIVE.get(`${prefix}base/${newer}/backup.info`),
  ).not.toBeNull();
  // Both changed: no trusted backup remains, so the restore refuses the archive.
  await put(`base/${older}/data.tar.gz`, "changed too");
  await expect(
    restoreBackup(env.ARCHIVE, prefix, undefined, undefined, recorded),
  ).rejects.toMatchObject({ details: { reason: "archive_digest_mismatch" } });
  await env.ARCHIVE.delete(
    (await env.ARCHIVE.list({ prefix })).objects.map((o) => o.key),
  );
});
