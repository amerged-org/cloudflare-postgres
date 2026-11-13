// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { CRON_STEPS } from "../../src/domain/cron-health.ts";
import { recordBackupDigest } from "../../src/domain/archive-digests.ts";
import { declareNodeLost } from "../../src/domain/node-loss.ts";
import { cleanup, lifecycle } from "./lifecycle-fixture.ts";

const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanup();
});

it("carries the fence of a lost node on and applies the recovery windows, each in its own step", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    // The objects below are uploaded now, and a backup is an anchor only once R2 dates its upload
    // before the window's start: the clock runs ahead of the uploads, so the windows start after them.
    now = Date.now() + 30 * 86_400_000;
  const uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid"))!;
  await declareNodeLost(env, f.node, {
    expected_node_uid: uid,
    reason: "gone",
  });
  // An archive with a base backup older than the window and a newer one.
  const prefix = `${row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "")}/database/`;
  const wal = (n: number) =>
    `0000000100000000${n.toString(16).toUpperCase().padStart(8, "0")}`;
  const put = async (key: string) => {
    keys.push(key);
    await env.ARCHIVE.put(key, "x");
  };
  const backup = async (
    from: number,
    to: number,
    begin: number,
    end: number,
  ) => {
    const start = new Date(now - from * 86_400_000),
      id = start.toISOString().replace(/[-:]/g, "").slice(0, 15);
    await put(`${prefix}base/${id}/data.tar.gz`);
    keys.push(`${prefix}base/${id}/backup.info`);
    await env.ARCHIVE.put(
      `${prefix}base/${id}/backup.info`,
      `status=DONE\nbegin_time=${start.toISOString()}\nend_time=${new Date(now - to * 86_400_000).toISOString()}\nbegin_wal=${wal(begin)}\nend_wal=${wal(end)}\nxlog_segment_size=16777216\n`,
    );
    // The Worker records the digest of each backup when the node reports it done.
    await recordBackupDigest(
      env.ARCHIVE,
      env.DB,
      row.archive_path,
      prefix,
      id,
      now,
    );
    return id;
  };
  const old = await backup(21, 20, 1, 2);
  await backup(11, 10, 3, 4);
  for (let n = 1; n <= 6; n++)
    await put(`${prefix}wals/${wal(n).slice(0, 16)}/${wal(n)}.gz`);

  const result = await runCron(env, now);
  // No Cloudflare token in this environment: the fence cannot go on, and the step says so.
  expect(result.step_failures).toEqual([
    { step: "node_fencing", error_code: "fence_unconfigured" },
  ]);
  expect(CRON_STEPS).toContain("node_fencing");
  expect(CRON_STEPS).toContain("backup_retention");
  expect(
    await env.DB.prepare(
      "SELECT fencing_error FROM node_losses WHERE node_id=?",
    )
      .bind(f.node)
      .first("fencing_error"),
  ).toBe("fence_unconfigured");
  // The node is not fenced yet, so it can still write: its archive is left alone, nothing is deleted.
  expect(
    (await env.ARCHIVE.list({ prefix: `${prefix}base/${old}/` })).objects,
  ).toHaveLength(2);
  expect(
    (await env.ARCHIVE.list({ prefix: `${prefix}wals/` })).objects,
  ).toHaveLength(6);

  // Once the fence has completed, the same pass applies the recovery window to what the node wrote before it.
  const fenced = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
  )
    .bind(fenced, fenced, fenced, f.node)
    .run();
  await runCron(env, now + 120_000);
  expect(
    (await env.ARCHIVE.list({ prefix: `${prefix}base/${old}/` })).objects,
  ).toEqual([]);
  expect(
    (await env.ARCHIVE.list({ prefix: `${prefix}wals/` })).objects.map(
      (o) => o.key,
    ),
  ).toHaveLength(4);
});
