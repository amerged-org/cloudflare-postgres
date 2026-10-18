// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  aptListName,
  behindLock,
  compareDebianVersions,
  compareInstalled,
  debianRepositories,
  liveRepositories,
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

test("the advisories read the lists apt writes for the live suites", () => {
  assert.deepEqual(liveRepositories().map(aptListName), [
    "deb.debian.org_debian-security_dists_trixie-security_main_binary-amd64_Packages",
    "deb.debian.org_debian_dists_trixie-updates_main_binary-amd64_Packages",
    "apt.postgresql.org_pub_repos_apt_dists_trixie-pgdg_main_binary-amd64_Packages",
  ]);
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

test("the lock pins no pre-release version", () => {
  const prerelease = /~(alpha|beta|rc)\d*/i;
  for (const entry of [...lock.packages, ...lock.extra]) {
    assert.doesNotMatch(entry.version, prerelease, `${entry.name} ${entry.version} is a pre-release`);
  }
  const candidate = { ...lock.packages.find((entry) => entry.name === "libpq5")!, version: "19~rc1-1.pgdg13+1" };
  const withCandidate = (field: "packages" | "extra") => ({
    ...lock,
    [field]: [...lock[field].filter((entry) => entry.name !== "libpq5"), candidate],
  });
  assert.throws(() => validateLock(withCandidate("packages")), /libpq5.*pre-release/);
  assert.throws(() => validateLock(withCandidate("extra")), /libpq5.*pre-release/);
  for (const version of ["2~ALPHA", "2~beta3", "19~RC1-1"]) {
    assert.throws(() => validateLock({ ...lock, extra: [{ ...candidate, version }] }), /pre-release/);
  }
});

// Stanzas cut from the trixie-security Packages file of snapshot 20261016T133910Z.
const securityIndex = `Package: libexpat1
Source: expat
Version: 2.9.0-1~deb13u1
Installed-Size: 427
Maintainer: Laszlo Boszormenyi (GCS) <gcs@debian.org>
Architecture: amd64
Description: XML parsing C library - runtime library
Homepage: https://libexpat.github.io/
Description-md5: 969a775adb36dbfb73b9d7ef67f13bd6
Multi-Arch: same
Pre-Depends: libc6 (>= 2.36)
Section: libs
Priority: optional
Filename: pool/updates/main/e/expat/libexpat1_2.9.0-1~deb13u1_amd64.deb
Size: 125744
SHA256: feff874772cae904ae4d24e917b35664952bec4b4ae9100a4edda5a7fa746832

Package: libexpat1-dev
Source: expat
Version: 2.9.0-1~deb13u1
Installed-Size: 964
Maintainer: Laszlo Boszormenyi (GCS) <gcs@debian.org>
Architecture: amd64
Provides: libexpat-dev
Depends: libexpat1 (= 2.9.0-1~deb13u1), libc6-dev | libc-dev
Conflicts: libexpat-dev
Description: XML parsing C library - development kit
Homepage: https://libexpat.github.io/
Description-md5: 0b45073661cf63b9161c598405a4e62d
Multi-Arch: same
Section: libdevel
Priority: optional
Filename: pool/updates/main/e/expat/libexpat1-dev_2.9.0-1~deb13u1_amd64.deb
Size: 184304
SHA256: f1fb8aa3165e8c8f20d9e37e1d421fe17eaeb647fcf8fe3305acf3afb315c677

Package: linux-image-amd64
Source: linux-signed-amd64 (6.12.113+1)
Version: 6.12.113-1
Installed-Size: 13
Maintainer: Debian Kernel Team <debian-kernel@lists.debian.org>
Architecture: amd64
Provides: linux-image-generic, linux-latest-modules-6.12.113+deb13-amd64, virtualbox-guest-modules, wireguard-modules (= 1.0.0)
Depends: linux-image-6.12.113+deb13-amd64 (= 6.12.113-1)
Description: Linux for 64-bit PCs (meta-package)
Homepage: https://www.kernel.org/
Description-md5: 6a25122b463a5515998ee600e16b3daf
Section: kernel
Priority: optional
Filename: pool/updates/main/l/linux-signed-amd64/linux-image-amd64_6.12.113-1_amd64.deb
Size: 1480
SHA256: e6b5a5e6dbe6f2d07bd694139b758666d14351d6ba3a9a97de31096c30aff0f0

Package: openssl
Version: 3.5.7-1~deb13u3
Installed-Size: 2510
Maintainer: Debian OpenSSL Team <pkg-openssl-devel@alioth-lists.debian.net>
Architecture: amd64
Depends: libc6 (>= 2.34), libssl3t64 (>= 3.5.0)
Suggests: ca-certificates
Description: Secure Sockets Layer toolkit - cryptographic utility
Homepage: https://openssl-library.org
Description-md5: 9b6de2bb6e1d9016aeb0f00bcf6617bd
Multi-Arch: foreign
Section: utils
Priority: optional
Filename: pool/updates/main/o/openssl/openssl_3.5.7-1~deb13u3_amd64.deb
Size: 1508068
SHA256: 43a9cbcf2a8a0e1f0a1c3f5a33ee1f56b269690e7a2129f2b2d0582e789589d7
`;

test("Debian versions order by epoch, upstream version and revision", () => {
  const ascending = [
    ["6.12.111-1", "6.12.113-1"],
    ["6.12.9-1", "6.12.10-1"],
    ["2.8.3-1~deb13u1", "2.9.0-1~deb13u1"],
    ["19~rc1-1.pgdg13+1", "19-1"],
    ["1.0~", "1.0"],
    ["1.0a", "1.0+"],
    ["2.0", "1:1.0"],
    ["18.6-1.pgdg13+1", "18.6-1.pgdg13+2"],
  ] as const;
  for (const [lower, higher] of ascending) {
    assert.equal(compareDebianVersions(lower, higher), -1, `${lower} < ${higher}`);
    assert.equal(compareDebianVersions(higher, lower), 1, `${higher} > ${lower}`);
  }
  assert.equal(compareDebianVersions("18.6-1.pgdg13+2", "18.6-1.pgdg13+2"), 0);
  assert.equal(compareDebianVersions("1.0", "0:1.0-0"), 0);
});

test("the packages behind the lock are the same-name records with a newer version", () => {
  const held = (name: string, version: string): LockedPackage => ({
    name,
    version,
    architecture: "amd64",
    url: "https://example.org/a.deb",
    sha256: "a".repeat(64),
    size: 1,
  });
  const old: PackageLock = {
    ...lock,
    packages: [held("libexpat1", "2.8.3-1~deb13u1"), held("linux-image-amd64", "6.12.111-1"), held("openssl", "3.5.7-1~deb13u3")],
    extra: [held("cloudflared", "2026.10.0")],
  };
  const records = parsePackagesIndex(securityIndex);
  assert.deepEqual(
    behindLock(old, records).map((record) => [record.name, record.version]),
    [["libexpat1", "2.9.0-1~deb13u1"], ["linux-image-amd64", "6.12.113-1"]],
  );
  const current: PackageLock = {
    ...old,
    packages: [held("libexpat1", "2.9.0-1~deb13u1"), held("linux-image-amd64", "6.12.113-1"), held("openssl", "3.6.0-1")],
  };
  assert.deepEqual(behindLock(current, records), []);
});
