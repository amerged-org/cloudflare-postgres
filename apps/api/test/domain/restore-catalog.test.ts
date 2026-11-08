// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  parseBackupInfo,
  readRestoreCatalog,
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

  const catalog = await readRestoreCatalog(env.ARCHIVE, prefix, fenced);
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
