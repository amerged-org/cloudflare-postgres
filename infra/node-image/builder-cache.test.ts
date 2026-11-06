// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("builder/cache-packages.sh", import.meta.url));
const snapshot = "20261024T011300Z";
const uri = `http://snapshot.debian.org/archive/debian/${snapshot}/pool/main/libe/liberror-perl/liberror-perl_0.17030-1_all.deb`;
const mirror = "http://deb.debian.org/debian/pool/main/libe/liberror-perl/liberror-perl_0.17030-1_all.deb";
const filename = "liberror-perl_0.17030-1_all.deb";
const bytes = Buffer.from("signed-index fixture package bytes");
const digest = "SHA256:" + createHash("sha256").update(bytes).digest("hex");
const row = (url = uri, name = filename, size = String(bytes.length), hash = digest) => `'${url}' ${name} ${size} ${hash}\n`;

async function fixture(t: TestContext, planText = row()) {
  const dir = await mkdtemp(join(tmpdir(), "pgcf-builder-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = join(dir, "cache"), plan = join(dir, "plan"), data = join(dir, "data"), log = join(dir, "calls");
  await mkdir(cache); await writeFile(plan, "APT selected package summary\n" + planText); await writeFile(data, bytes); await writeFile(log, "");
  await writeFile(join(dir, ".FAILED"), bytes);
  const run = (behavior: string) => execFileSync("bash", ["-c", `source "$1"; fetch_package() { printf '%s\\n' "$1" >> "$TEST_LOG"; ${behavior}; }; cache_packages "$2" "$3" "$4"`, "test", helper, snapshot, plan, cache], {
    encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH, TEST_LOG: log, TEST_DATA: data, TEST_MIRROR: mirror, TEST_DIGEST: digest }, stdio: "pipe",
  });
  return { cache, plan, data, log, run, marker: join(dir, ".FAILED"), target: join(cache, filename) };
}

test("the builder caches APT's identical selected package when the Snapshot transport fails", async (t) => {
  const f = await fixture(t);
  const response = '[[ "$1" == "$TEST_MIRROR" && "$3" == "$TEST_DIGEST" ]] || return 100; cp "$TEST_DATA" "$2"';
  f.run(response);
  assert.deepEqual(await readFile(f.target), bytes);
  assert.equal(await readFile(f.log, "utf8"), mirror + "\n");
  assert.deepEqual(await readdir(join(f.cache, "partial")), []);
  f.run('return 1');
  assert.equal(await readFile(f.log, "utf8"), mirror + "\n", "a cached package must be checked before skipping its download");
  await writeFile(f.target, Buffer.alloc(bytes.length, 0));
  f.run(response);
  assert.deepEqual(await readFile(f.target), bytes, "an invalid existing cache entry must be replaced by checked bytes");
});

test("an unavailable CDN returns to the exact original selected URI within two attempts", async (t) => {
  const f = await fixture(t);
  f.run('if [[ "$1" == "$TEST_MIRROR" ]]; then printf invalid > "$2.FAILED"; return 100; fi; cp "$TEST_DATA" "$2"');
  assert.deepEqual(await readFile(f.target), bytes);
  assert.equal(await readFile(f.log, "utf8"), mirror + "\n" + uri + "\n");
  assert.deepEqual(await readdir(join(f.cache, "partial")), [], "apt-helper's rejected .FAILED file must be removed");
});

test("the security archive and HTTPS scheme retain the selected pool path", () => {
  const security = uri.replace("http:", "https:").replace("/archive/debian/", "/archive/debian-security/");
  const selected = execFileSync("bash", ["-c", 'source "$1"; selected_mirror "$2" "$3"', "test", helper, security, snapshot], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(selected, mirror.replace("http:", "https:").replace("/debian/", "/debian-security/") + "\n");
});

test("a helper success cannot publish bytes with another size or checksum", async (t) => {
  const f = await fixture(t);
  await writeFile(f.data, bytes.subarray(1));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(await readdir(join(f.cache, "partial")), []);
  await writeFile(f.data, Buffer.alloc(bytes.length, 0));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(await readdir(join(f.cache, "partial")), []);
});

test("the whole APT plan rejects another origin before any package fetch", async (t) => {
  const f = await fixture(t, row() + row(uri.replace("snapshot.debian.org", "snapshot.debian.org.example.invalid")));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  assert.equal(await readFile(f.log, "utf8"), "");
  assert.deepEqual(await readFile(f.marker), bytes, "an invalid plan must not remove an unrelated .FAILED file");
});

test("weak hashes, another timestamp and unsafe filenames cannot enter the APT cache", async (t) => {
  const f = await fixture(t, row(uri, filename, String(bytes.length), "MD5Sum:" + "0".repeat(32)));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  await writeFile(f.plan, row(uri.replace(snapshot, "20261023T011300Z")));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  await writeFile(f.plan, row(uri, "../escape.deb"));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  await writeFile(f.plan, row(uri, filename, "0"));
  assert.throws(() => f.run('cp "$TEST_DATA" "$2"'));
  assert.equal(await readFile(f.log, "utf8"), "");
});
