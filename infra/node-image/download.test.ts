// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { download } from "./download.ts";
import { debFileName, type LockedPackage } from "./lock.ts";

const bytes = Buffer.from("the pinned package bytes");
const snapshot = "https://snapshot.debian.org/archive/debian/20261024T011300Z/pool/main/b/base-files/base-files_13.8+deb13u7_amd64.deb";
const mirror = "https://deb.debian.org/debian/pool/main/b/base-files/base-files_13.8+deb13u7_amd64.deb";
const entry: LockedPackage = {
  name: "base-files",
  version: "13.8+deb13u7",
  architecture: "amd64",
  url: snapshot,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

async function fixture(t: TestContext, respond: (url: string) => { status: number; bytes?: Uint8Array; finalUrl?: string }) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const answer = respond(url);
    const response = new Response(answer.bytes, { status: answer.status });
    Object.defineProperty(response, "url", { value: answer.finalUrl ?? url });
    return response;
  });
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => setImmediate(callback, ...args));
  return { directory, urls, target: join(directory, debFileName(entry)) };
}

test("a Snapshot outage downloads the identical pinned package from Debian's archive mirror", async (t) => {
  let httpFailure = true;
  const { directory, urls, target } = await fixture(t, (url) => {
    if (new URL(url).hostname === "snapshot.debian.org") {
      if (httpFailure) return { status: 504 };
      throw new TypeError("network failure");
    }
    return { status: 200, bytes };
  });
  await download(entry, directory);
  assert.deepEqual(urls, [snapshot, mirror]);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(existsSync(`${target}.partial`), false);
  assert.equal(entry.url, snapshot, "transport fallback must not rewrite the lock");
  await download(entry, directory);
  assert.equal(urls.length, 2, "a valid cached package must not be downloaded again");

  await rm(target);
  httpFailure = false;
  const security = snapshot.replace("/archive/debian/", "/archive/debian-security/");
  await download({ ...entry, url: security }, directory);
  assert.deepEqual(urls.slice(2), [security, mirror.replace("/debian/", "/debian-security/")]);
  assert.deepEqual(await readFile(target), bytes);
});

test("the alternate transport cannot accept a different size or checksum", async (t) => {
  let received = bytes.subarray(1);
  let primaryStatus = 503;
  const corrupt = Buffer.alloc(bytes.length, 0);
  const { directory, urls, target } = await fixture(t, (url) => url === snapshot ? { status: primaryStatus, bytes: corrupt } : { status: 200, bytes: received });
  await assert.rejects(download(entry, directory));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(`${target}.partial`), false);
  assert.ok(urls.includes(mirror), "the rejected bytes must have come from the alternate transport");
  assert.equal(urls.length, 3, "fallback must stay inside the existing three-attempt budget");

  received = corrupt;
  await assert.rejects(download(entry, directory));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(`${target}.partial`), false);
  assert.equal(urls.length, 6);

  primaryStatus = 200;
  received = bytes;
  await assert.rejects(download(entry, directory), /sha256 mismatch/);
  assert.deepEqual(urls.slice(6), [snapshot, snapshot, snapshot], "a checksum mismatch must not select an alternate source");
  assert.equal(existsSync(target), false);
});

test("other origins, unsupported archives and authorization failures never select a mirror", async (t) => {
  let status = 504;
  let finalUrl: string | undefined, body: Uint8Array | undefined;
  const { directory, urls } = await fixture(t, () => ({ status, bytes: body, finalUrl }));
  const other = snapshot.replace("snapshot.debian.org", "snapshot.debian.org.example.invalid");
  await assert.rejects(download({ ...entry, url: other }, directory));
  assert.deepEqual(urls.splice(0), [other, other, other]);

  const unsupported = snapshot.replace("/archive/debian/", "/archive/debian-ports/");
  await assert.rejects(download({ ...entry, url: unsupported }, directory));
  assert.deepEqual(urls.splice(0), [unsupported, unsupported, unsupported]);

  status = 401;
  await assert.rejects(download(entry, directory));
  assert.deepEqual(urls.splice(0), [snapshot, snapshot, snapshot]);

  status = 200;
  body = bytes;
  finalUrl = "http://deb.debian.org/debian/pool/package.deb";
  await assert.rejects(download(entry, directory), /redirected off HTTPS/);
  assert.deepEqual(urls, [snapshot, snapshot, snapshot]);
});
