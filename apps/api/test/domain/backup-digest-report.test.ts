// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { recordedDigests } from "../../src/domain/archive-digests.ts";
import { BACKUP, cleanup, lifecycle } from "./lifecycle-fixture.ts";
import { report as nodeReport } from "./fixtures.ts";

it("records the digest of a backup the node reports done, from the archive as it stands when the report arrives", async () => {
  const f = await lifecycle(),
    row = await f.row();
  const prefix = `${row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "")}/database/`;
  // The first report came before the backup was in the archive: nothing is recorded yet, so the
  // archive is not enforced.
  expect((await recordedDigests(env.DB, row.archive_path)).enforced).toBe(
    false,
  );
  await env.ARCHIVE.put(
    `${prefix}base/${BACKUP.backup_id}/backup.info`,
    "status=DONE\nbegin_time=2026-10-18T09:00:00Z\nend_time=2026-10-18T09:30:00Z\nbegin_wal=000000010000000000000001\nend_wal=000000010000000000000002\nxlog_segment_size=16777216\n",
  );
  await env.ARCHIVE.put(
    `${prefix}base/${BACKUP.backup_id}/data.tar.gz`,
    "data",
  );
  // The node reports the same backup again: the Worker records what the archive holds now.
  expect(
    (await nodeReport(f, f.id, 1, "ready", { backup: BACKUP })).status,
  ).toBe(200);
  expect([
    ...(await recordedDigests(env.DB, row.archive_path)).recorded.keys(),
  ]).toEqual([BACKUP.backup_id]);
  await cleanup();
});
