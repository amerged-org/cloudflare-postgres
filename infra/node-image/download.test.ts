// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchLockedPackage, officialDebianFallbackUrl } from "./download.ts";
import type { LockedPackage } from "./lock.ts";

const snapshot = "https://snapshot.debian.org/archive/debian-security/20261024T011300Z/pool/updates/main/u/util-linux/bsdutils_2.41.5-0+deb13u1_amd64.deb";
const mirror = "https://security.debian.org/debian-security/pool/updates/main/u/util-linux/bsdutils_2.41.5-0+deb13u1_amd64.deb";
const payload = Buffer.from("the exact locked package bytes");
const entry: LockedPackage = { name: "bsdutils", version: "1:2.41.5-0+deb13u1", architecture: "amd64", url: snapshot, size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
const response = (url: string, body: ConstructorParameters<typeof Response>[0], status = 200, headers?: NonNullable<ConstructorParameters<typeof Response>[1]>["headers"]) => {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, "url", { value: url });
  return result;
};

test("a Debian snapshot outage falls back to the official mirror with the exact locked bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pgcf-package-download-"));
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    return url === snapshot ? response(url, null, 503) : response(url, payload);
  });
  try {
    const target = join(dir, "package.deb");
    await fetchLockedPackage(entry, target);
    assert.deepEqual(calls, [snapshot, mirror]);
    assert.deepEqual(await readFile(target), payload);
    assert.deepEqual(await readdir(dir), ["package.deb"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a mirror cannot replace a pinned package with different bytes or an HTTP redirect", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pgcf-package-download-"));
  let redirect = false;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url === snapshot) return response(url, null, 503);
    return redirect ? response(url, null, 302, { location: "http://security.debian.org/untrusted.deb" }) : response(url, Buffer.alloc(payload.length));
  });
  try {
    const target = join(dir, "package.deb");
    await assert.rejects(fetchLockedPackage(entry, target), /sha256 mismatch/);
    assert.deepEqual(await readdir(dir), []);
    redirect = true; calls.length = 0;
    await assert.rejects(fetchLockedPackage(entry, target), /HTTPS/);
    assert.deepEqual(calls, [snapshot, mirror]);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fallback mappings preserve the pool path and exclude unrelated hosts and archive paths", () => {
  assert.equal(officialDebianFallbackUrl("https://snapshot.debian.org/archive/debian/20261024T011300Z/pool/main/z/zlib/zlib1g_1.3.1_amd64.deb"), "https://deb.debian.org/debian/pool/main/z/zlib/zlib1g_1.3.1_amd64.deb");
  assert.equal(officialDebianFallbackUrl(snapshot.replace("snapshot.debian.org", "packages.example.org")), null);
  assert.equal(officialDebianFallbackUrl(snapshot.replace("https:", "http:")), null);
  assert.equal(officialDebianFallbackUrl(snapshot.replace("/pool/", "/unrelated/")), null);
});
