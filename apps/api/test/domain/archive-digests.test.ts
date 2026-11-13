// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  recordBackupDigest,
  recordedDigests,
  verifyBackupDigest,
} from "../../src/domain/archive-digests.ts";

const keys = new Set<string>();
afterEach(async () => {
  const all = [...keys];
  keys.clear();
  for (let i = 0; i < all.length; i += 1000)
    await env.ARCHIVE.delete(all.slice(i, i + 1000));
});

it("records the digest of a backup of any size, from every page of its listing", async () => {
  const prefix = `digest-pages/${crypto.randomUUID()}/`;
  const archivePath = `s3://${env.ARCHIVE_BUCKET_NAME}/${prefix}`;
  const id = "20260101T000000";
  const put = async (key: string, body: string) => {
    keys.add(key);
    await env.ARCHIVE.put(key, body);
  };
  await put(`${prefix}base/${id}/backup.info`, "status=DONE\n");
  const parts = Array.from(
    { length: 1200 },
    (_, i) => `${prefix}base/${id}/part-${i}.tar`,
  );
  for (let i = 0; i < parts.length; i += 100)
    await Promise.all(parts.slice(i, i + 100).map((key) => put(key, "x")));
  expect(
    await recordBackupDigest(
      env.ARCHIVE,
      env.DB,
      archivePath,
      prefix,
      id,
      Date.now(),
    ),
  ).toBe(true);
  const recorded = (await recordedDigests(env.DB, archivePath))!;
  // The recorded digest covers all 1201 objects: a verification over every page passes, and a
  // change to the last object of the last page is refused.
  await verifyBackupDigest(env.ARCHIVE, prefix, id, recorded.get(id)!);
  await put(parts[1199]!, "changed");
  await expect(
    verifyBackupDigest(env.ARCHIVE, prefix, id, recorded.get(id)!),
  ).rejects.toMatchObject({ details: { reason: "archive_digest_mismatch" } });
});

it("does not record a backup that an object was uploaded to after the fence time", async () => {
  const prefix = `digest-fence/${crypto.randomUUID()}/`;
  const archivePath = `s3://${env.ARCHIVE_BUCKET_NAME}/${prefix}`;
  const id = "20260101T000000";
  await env.ARCHIVE.put(`${prefix}base/${id}/backup.info`, "status=DONE\n");
  await env.ARCHIVE.put(`${prefix}base/${id}/data.tar.gz`, "data");
  keys.add(`${prefix}base/${id}/backup.info`);
  keys.add(`${prefix}base/${id}/data.tar.gz`);
  const fenced = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await env.ARCHIVE.put(`${prefix}base/${id}/late.tar`, "junk");
  keys.add(`${prefix}base/${id}/late.tar`);
  expect(
    await recordBackupDigest(
      env.ARCHIVE,
      env.DB,
      archivePath,
      prefix,
      id,
      Date.now(),
      fenced,
    ),
  ).toBe(false);
  expect(await recordedDigests(env.DB, archivePath)).toBeNull();
});
