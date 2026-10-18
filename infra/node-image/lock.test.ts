// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  aptListName,
  compareInstalled,
  debianRepositories,
  lockPackages,
  parsePackagesIndex,
  snapshotEpoch,
  validateLock,
  type LockedPackage,
  type PackageLock,
} from "./lock.ts";

const lock = JSON.parse(readFileSync(new URL("packages.lock.json", import.meta.url), "utf8")) as PackageLock;

const index = `Package: zstd
Version: 1.5.7+dfsg-1
Architecture: amd64
Depends: libc6 (>= 2.34)
Description: fast lossless compression algorithm
 -- command line tool
Filename: pool/main/libz/libzstd/zstd_1.5.7+dfsg-1_amd64.deb
Size: 603000
SHA256: ${"a".repeat(64)}

Package: tzdata
Version: 2025b-4+deb13u1
Architecture: all
Filename: pool/main/t/tzdata/tzdata_2025b-4+deb13u1_all.deb
Size: 260000
SHA256: ${"b".repeat(64)}
`;

test("the committed lock is complete and pinned", () => {
  validateLock(lock);
  assert.ok(lock.packages.length > 100, "the lock must list the whole image, not only the requested packages");
  for (const name of ["linux-image-amd64", "postgresql-18", "postgresql-18-pgvector", "barman-cli-cloud", "cloudflared"]) {
    assert.ok(lock.packages.some((entry) => entry.name === name), `${name} is locked`);
  }
});

test("the lock pins the plan's component versions", () => {
  const version = (name: string) => lock.packages.find((entry) => entry.name === name)?.version;
  assert.equal(version("postgresql-18"), "18.6-1.pgdg13+2");
  assert.equal(version("postgresql-18-pgvector"), "0.8.7-1.pgdg13+1");
  assert.equal(version("barman-cli-cloud"), "3.20.1-1.pgdg13+1");
  assert.equal(version("cloudflared"), "2026.10.0");
});

test("index stanzas parse into checksummed records, ignoring continuation lines", () => {
  const records = parsePackagesIndex(index);
  assert.deepEqual(
    records.map((record) => [record.name, record.version, record.architecture, record.size]),
    [
      ["zstd", "1.5.7+dfsg-1", "amd64", 603000],
      ["tzdata", "2025b-4+deb13u1", "all", 260000],
    ],
  );
  assert.throws(() => parsePackagesIndex("Package: broken\nVersion: 1\n"), /incomplete index stanza/);
});

test("list names follow apt's URI-to-file-name rule", () => {
  const [security, updates, main, pgdg] = debianRepositories({ ...lock, debian: { snapshot: "20261016T000000Z" } });
  assert.equal(
    aptListName(main!),
    "snapshot.debian.org_archive_debian_20261016T000000Z_dists_trixie_main_binary-amd64_Packages",
  );
  assert.equal(
    aptListName(security!),
    "snapshot.debian.org_archive_debian-security_20261016T000000Z_dists_trixie-security_main_binary-amd64_Packages",
  );
  assert.match(aptListName(updates!), /_dists_trixie-updates_main_binary-amd64_Packages$/);
  assert.equal(
    aptListName(pgdg!),
    "apt-archive.postgresql.org_pub_repos_apt_dists_trixie-pgdg-archive_main_binary-amd64_Packages",
  );
  assert.equal(aptListName({ base: "https://example.org/a_b~c", suite: "s" }), "example.org_a%5fb%7ec_dists_s_main_binary-amd64_Packages");
});

test("every installed package maps to one signed record; anything unlisted fails", () => {
  const repository = { base: "https://snapshot.debian.org/archive/debian/20261016T000000Z", suite: "trixie" };
  const extra: LockedPackage = {
    name: "cloudflared",
    version: "2026.10.0",
    architecture: "amd64",
    url: "https://example.org/cloudflared.deb",
    sha256: "c".repeat(64),
    size: 10,
  };
  const locked = lockPackages(
    [
      { name: "zstd", version: "1.5.7+dfsg-1", architecture: "amd64" },
      { name: "cloudflared", version: "2026.10.0", architecture: "amd64" },
    ],
    [{ repository, records: parsePackagesIndex(index) }],
    [extra],
  );
  assert.deepEqual(
    locked.map((entry) => entry.url),
    ["https://example.org/cloudflared.deb", `${repository.base}/pool/main/libz/libzstd/zstd_1.5.7+dfsg-1_amd64.deb`],
  );
  assert.throws(
    () => lockPackages([{ name: "zstd", version: "9", architecture: "amd64" }], [{ repository, records: parsePackagesIndex(index) }], []),
    /no signed index lists: zstd 9 amd64/,
  );
});

test("the same package version with two different files is refused", () => {
  const repository = { base: "https://a.example", suite: "trixie" };
  const other = { base: "https://b.example", suite: "trixie" };
  const changed = index.replace("a".repeat(64), "d".repeat(64));
  assert.throws(
    () =>
      lockPackages([{ name: "zstd", version: "1.5.7+dfsg-1", architecture: "amd64" }], [
        { repository, records: parsePackagesIndex(index) },
        { repository: other, records: parsePackagesIndex(changed) },
      ], []),
    /differs between/,
  );
});

test("the built image must hold exactly the locked set", () => {
  const small: PackageLock = {
    ...lock,
    packages: [
      { name: "zstd", version: "1", architecture: "amd64", url: "https://x", sha256: "a".repeat(64), size: 1 },
      { name: "tzdata", version: "2", architecture: "all", url: "https://x", sha256: "b".repeat(64), size: 1 },
    ],
  };
  assert.deepEqual(
    compareInstalled(small, [
      { name: "zstd", version: "1", architecture: "amd64" },
      { name: "tzdata", version: "2", architecture: "all" },
    ]),
    [],
  );
  assert.deepEqual(
    compareInstalled(small, [
      { name: "zstd", version: "1.1", architecture: "amd64" },
      { name: "nano", version: "8", architecture: "amd64" },
    ]),
    ["missing tzdata 2 all", "missing zstd 1 amd64", "unlocked nano 8 amd64", "unlocked zstd 1.1 amd64"],
  );
});

test("SOURCE_DATE_EPOCH is the snapshot time", () => {
  assert.equal(snapshotEpoch("20261016T000000Z"), Date.UTC(2026, 9, 16) / 1000);
  assert.throws(() => snapshotEpoch("2026-10-16"), /invalid snapshot/);
});

test("a lock with floating inputs is refused", () => {
  assert.throws(() => validateLock({ ...lock, builder: { ...lock.builder, base: "debian:trixie" } }), /digest/);
  assert.throws(
    () => validateLock({ ...lock, packages: [{ ...lock.packages[0]!, url: "http://example.org/a.deb" }] }),
    /HTTPS/,
  );
});
