// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { download, officialDebianFallbackUrl, officialDebianSnapshotFallbackUrl } from "./download.ts";
import { debFileName, type LockedPackage } from "./lock.ts";

const bytes = Buffer.from("the pinned package bytes");
const snapshot = "https://snapshot.debian.org/archive/debian/20261024T011300Z/pool/main/b/base-files/base-files_13.8+deb13u7_amd64.deb";
const snapshotMirror = snapshot.replace("snapshot.debian.org", "snapshot-cloudflare.debian.org");
const mirror = "https://deb.debian.org/debian/pool/main/b/base-files/base-files_13.8+deb13u7_amd64.deb";
const entry: LockedPackage = {
  name: "base-files", version: "13.8+deb13u7", architecture: "amd64",
  url: snapshot, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
};
type Answer = { status: number; bytes?: Uint8Array; finalUrl?: string; location?: string };
async function fixture(t: TestContext, respond: (url: string) => Answer) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    assert.equal(options?.redirect, "manual", "a downgrade must be refused before its network request");
    const answer = respond(url);
    const response = new Response(answer.bytes, { status: answer.status, headers: answer.location ? { location: answer.location } : undefined });
    Object.defineProperty(response, "url", { value: answer.finalUrl ?? url });
    return response;
  });
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => setImmediate(callback, ...args));
  return { directory, urls, target: join(directory, debFileName(entry)) };
}

test("a Snapshot outage uses the same timestamp on the official Cloudflare frontend and retains checked cache bytes", async (t) => {
  let httpFailure = true;
  const f = await fixture(t, (url) => {
    if (new URL(url).hostname === "snapshot.debian.org") {
      if (httpFailure) return { status: 504 };
      throw new TypeError("network failure");
    }
    return { status: 200, bytes };
  });
  await download(entry, f.directory);
  assert.deepEqual(f.urls, [snapshot, snapshotMirror]);
  assert.deepEqual(await readFile(f.target), bytes);
  assert.equal(existsSync(f.target + ".partial"), false);
  assert.equal(entry.url, snapshot, "fallback must not rewrite the lock");
  await download(entry, f.directory);
  assert.equal(f.urls.length, 2);
  await writeFile(f.target, Buffer.alloc(bytes.length));
  await download(entry, f.directory);
  assert.deepEqual(await readFile(f.target), bytes, "a corrupt cached entry is replaced only by checked bytes");
  await rm(f.target);
  httpFailure = false;
  const security = snapshot.replace("/archive/debian/", "/archive/debian-security/");
  await download({ ...entry, url: security }, f.directory);
  assert.deepEqual(f.urls.slice(4), [security, security.replace("snapshot.debian.org", "snapshot-cloudflare.debian.org")]);
});

test("live fallback stays within three attempts and failures retain every transport status", async (t) => {
  let liveMissing = false;
  const f = await fixture(t, (url) => {
    if (url === snapshot) return { status: 503 };
    if (url === snapshotMirror) return { status: 502 };
    return liveMissing ? { status: 404 } : { status: 200, bytes };
  });
  await download(entry, f.directory);
  assert.deepEqual(f.urls, [snapshot, snapshotMirror, mirror]);
  assert.deepEqual(await readFile(f.target), bytes);
  await rm(f.target);
  f.urls.length = 0; liveMissing = true;
  await assert.rejects(download(entry, f.directory), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /snapshot\.debian\.org: HTTP 503/);
    assert.match(error.message, /snapshot-cloudflare\.debian\.org: HTTP 502/);
    assert.match(error.message, /deb\.debian\.org: HTTP 404/);
    return true;
  });
  assert.deepEqual(f.urls, [snapshot, snapshotMirror, mirror]);
  assert.deepEqual(await readdir(f.directory), []);
});

test("size and checksum failures stop without selecting different bytes", async (t) => {
  let received = bytes.subarray(1), primaryStatus = 503;
  const f = await fixture(t, (url) => url === snapshot ? { status: primaryStatus, bytes: Buffer.alloc(bytes.length) } : { status: 200, bytes: received });
  await assert.rejects(download(entry, f.directory), /size/);
  assert.deepEqual(f.urls.splice(0), [snapshot, snapshotMirror]);
  assert.deepEqual(await readdir(f.directory), []);
  received = Buffer.alloc(bytes.length);
  await assert.rejects(download(entry, f.directory), /sha256 mismatch/);
  assert.deepEqual(f.urls.splice(0), [snapshot, snapshotMirror]);
  assert.deepEqual(await readdir(f.directory), []);
  primaryStatus = 200; received = bytes;
  await assert.rejects(download(entry, f.directory), /sha256 mismatch/);
  assert.deepEqual(f.urls, [snapshot], "a corrupted primary must not select a valid alternate");
  assert.deepEqual(await readdir(f.directory), []);
});

test("unrelated origins and archives never select a mirror and retry at most three times", async (t) => {
  const f = await fixture(t, () => ({ status: 504 }));
  const other = snapshot.replace("snapshot.debian.org", "snapshot.debian.org.example.invalid");
  await assert.rejects(download({ ...entry, url: other }, f.directory));
  assert.deepEqual(f.urls.splice(0), [other, other, other]);
  const unsupported = snapshot.replace("/archive/debian/", "/archive/debian-ports/");
  await assert.rejects(download({ ...entry, url: unsupported }, f.directory));
  assert.deepEqual(f.urls, [unsupported, unsupported, unsupported]);
  assert.deepEqual(await readdir(f.directory), []);
});

test("authorization, TLS and HTTP redirect refusals never choose another transport", async (t) => {
  let mode = "authorization";
  const f = await fixture(t, () => {
    if (mode === "authorization") return { status: 401 };
    if (mode === "tls") throw new TypeError("fetch failed", { cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }) });
    if (mode === "redirect") return { status: 302, location: "http://deb.debian.org/untrusted.deb" };
    return { status: 200, bytes, finalUrl: "http://deb.debian.org/untrusted.deb" };
  });
  await assert.rejects(download(entry, f.directory), /HTTP 401/);
  assert.deepEqual(f.urls.splice(0), [snapshot]);
  mode = "tls";
  await assert.rejects(download(entry, f.directory), /TLS verification/);
  assert.deepEqual(f.urls.splice(0), [snapshot]);
  mode = "redirect";
  await assert.rejects(download(entry, f.directory), /HTTPS/);
  assert.deepEqual(f.urls.splice(0), [snapshot], "the HTTP location is never fetched");
  mode = "final";
  await assert.rejects(download(entry, f.directory), /HTTPS/);
  assert.deepEqual(f.urls, [snapshot]);
  assert.deepEqual(await readdir(f.directory), []);
});

test("fallback mappings preserve the exact pool path and reject disguised hosts, traversal and non-HTTPS origins", () => {
  assert.equal(officialDebianFallbackUrl(snapshot), mirror);
  assert.equal(officialDebianSnapshotFallbackUrl(snapshot), snapshotMirror);
  const security = snapshot.replace("/archive/debian/", "/archive/debian-security/");
  assert.equal(officialDebianFallbackUrl(security), mirror.replace("deb.debian.org/debian/", "security.debian.org/debian-security/"));
  assert.equal(officialDebianFallbackUrl(snapshot.replace("snapshot.debian.org", "packages.example.org")), null);
  assert.equal(officialDebianSnapshotFallbackUrl(snapshot.replace("snapshot.debian.org", "packages.example.org")), null);
  assert.equal(officialDebianFallbackUrl(snapshot.replace("https:", "http:")), null);
  assert.equal(officialDebianFallbackUrl(snapshot.replace("/pool/", "/unrelated/")), null);
  assert.equal(officialDebianFallbackUrl(snapshot.replace("/pool/", "/pool/../")), null);
  assert.equal(officialDebianFallbackUrl(snapshot.replace("/pool/", "/pool/%2e%2e/")), null);
  assert.equal(officialDebianFallbackUrl(snapshot + "?new-version"), null);
});
