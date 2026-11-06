// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("builder repository bootstrap establishes pinned CA trust before HTTPS APT and fails on missing indexes", () => {
  const dockerfile = readFileSync(new URL("builder/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /URIs: https:\/\/snapshot\.debian\.org\/archive\/debian\/\$PGCF_DEBIAN_SNAPSHOT/);
  assert.match(dockerfile, /URIs: https:\/\/snapshot\.debian\.org\/archive\/debian-security\/\$PGCF_DEBIAN_SNAPSHOT/);
  assert.doesNotMatch(dockerfile, /http:\/\/snapshot/);
  const verify = dockerfile.indexOf("sha256sum /tmp/bootstrap-ca-certificates.deb"), extract = dockerfile.indexOf("dpkg-deb --extract"), apt = dockerfile.indexOf("APT::Update::Error-Mode=any");
  assert.ok(verify > 0 && verify < extract && extract < apt);
  assert.match(dockerfile, /Acquire::Retries=3/);
  const trustConfig = dockerfile.indexOf('Acquire::https::CaInfo "/etc/ssl/certs/ca-certificates.crt";');
  assert.ok(trustConfig > extract && trustConfig < apt, "APT must use the bootstrapped CA file before its usual OpenSSL trust paths exist");
  assert.match(dockerfile, /Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring.gpg/);
  assert.match(dockerfile, /Check-Valid-Until: no/);
  assert.doesNotMatch(dockerfile, /AllowUnauthenticated|Verify-Peer=false|trusted=yes/);
});

import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_CA_FILE, builderTag, lockedCaCertificates, withBuilderContext } from "./builder-bootstrap.ts";
import { debFileName, type PackageLock } from "./lock.ts";

const committed = JSON.parse(readFileSync(new URL("packages.lock.json", import.meta.url), "utf8")) as PackageLock;

test("builder contexts contain only explicit inputs and verified 0600 trust bytes, and are removed after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-builder-context-"));
  const source = join(root, "source"), work = join(root, "work");
  const payload = Buffer.from("verified CA package fixture");
  const ca = { ...lockedCaCertificates(committed), size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const lock = { ...committed, packages: [ca] };
  try {
    await mkdir(source); await mkdir(work);
    for (const name of ["Dockerfile", "build.sh", "normalize-modes.sh", "cache-packages.sh", "unrelated.txt"]) await writeFile(join(source, name), name);
    let built = false;
    await assert.rejects(withBuilderContext(lock, source, work, async (entry, directory) => {
      await writeFile(join(directory, debFileName(entry)), payload);
      await chmod(join(directory, debFileName(entry)), 0o644);
    }, async (context, entry) => {
      built = true;
      assert.equal(entry.sha256, ca.sha256);
      assert.equal((await stat(context)).mode & 0o777, 0o700);
      assert.deepEqual((await readdir(context)).sort(), [BOOTSTRAP_CA_FILE, "Dockerfile", "build.sh", "normalize-modes.sh", "cache-packages.sh"].sort());
      for (const name of await readdir(context)) assert.equal((await stat(join(context, name))).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(join(context, BOOTSTRAP_CA_FILE)), payload);
      throw new Error("builder failed");
    }), /builder failed/);
    assert.equal(built, true);
    assert.deepEqual(await readdir(work), []);
    built = false;
    await assert.rejects(withBuilderContext(lock, source, work, async (entry, directory) => {
      await writeFile(join(directory, debFileName(entry)), Buffer.alloc(payload.length));
    }, () => { built = true; }), /sha256 mismatch/);
    assert.equal(built, false);
    assert.deepEqual(await readdir(work), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an old lock must still pin CA trust and the builder tag includes that pin", () => {
  const ca = lockedCaCertificates(committed);
  assert.throws(() => lockedCaCertificates({ ...committed, packages: [] }), /locked ca-certificates/);
  assert.notEqual(builderTag(committed), builderTag({ ...committed, packages: committed.packages.map((entry) => entry === ca ? { ...entry, sha256: "0".repeat(64) } : entry) }));
});
