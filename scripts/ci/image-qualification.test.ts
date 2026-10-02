// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import tar from "tar-stream";
import {
  safeArchivePath,
  extractLayer,
  validateBasePrefix,
  classifyFindings,
  assertScanResult,
  validateImageIdentity,
  validateManifestBinding,
} from "./image-qualification.ts";

test("rejects archive traversal, ambiguous paths and link writes", async () => {
  for (const name of [
    "/outside",
    "../outside",
    "a/../b",
    "a//b",
    "a\\b",
    "a\0b",
  ])
    assert.throws(() => safeArchivePath(name));
  assert.equal(
    safeArchivePath("./usr/local/include/node/v8-internal.h"),
    "usr/local/include/node/v8-internal.h",
  );
  const pack = tar.pack();
  pack.entry({ name: "link", type: "symlink", linkname: "../../outside" });
  pack.entry({ name: "link/value" }, "public");
  pack.finalize();
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    await assert.rejects(
      extractLayer(Readable.from(pack), directory, 0),
      /link/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains every regular entry even when later entries overwrite or whiteout it", async () => {
  const pack = tar.pack();
  pack.entry({ name: "./", type: "directory" });
  pack.entry({ name: "app/value" }, "first");
  pack.entry({ name: "app/value" }, "second");
  pack.entry({ name: "app/.wh.value" }, "");
  pack.finalize();
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    const files = await extractLayer(Readable.from(pack), directory, 0);
    assert.equal(files.length, 3);
    assert.equal(
      await readFile(join(directory, files[0]!.scanPath), "utf8"),
      "first",
    );
    assert.equal(
      await readFile(join(directory, files[1]!.scanPath), "utf8"),
      "second",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on malformed or truncated layer archives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    await assert.rejects(
      extractLayer(Readable.from([Buffer.alloc(10)]), directory, 0),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires the pinned official base diffIDs as an exact ordered prefix", () => {
  const base = ["sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)];
  assert.doesNotThrow(() =>
    validateBasePrefix([...base, "sha256:" + "c".repeat(64)], base),
  );
  assert.throws(() => validateBasePrefix([base[1]!, base[0]!], base));
  assert.throws(() => validateBasePrefix([base[0]!], base));
  assert.throws(() => validateBasePrefix(base, []));
});

test("binds config digest and source/revision labels to the exact built image", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: ["sha256:" + "a".repeat(64)] },
      config: {
        Labels: {
          "org.opencontainers.image.source":
            "https://github.com/public/product",
          "org.opencontainers.image.revision": "a".repeat(40),
        },
      },
    }),
  );
  const imageId = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() =>
    validateImageIdentity(
      bytes,
      imageId,
      "a".repeat(40),
      "https://github.com/public/product",
    ),
  );
  assert.throws(() =>
    validateImageIdentity(
      bytes,
      imageId,
      "b".repeat(40),
      "https://github.com/public/product",
    ),
  );
  assert.throws(() =>
    validateImageIdentity(
      bytes,
      imageId,
      "a".repeat(40),
      "https://github.com/public/other",
    ),
  );
  assert.throws(() =>
    validateImageIdentity(
      bytes,
      "sha256:" + "0".repeat(64),
      "a".repeat(40),
      "https://github.com/public/product",
    ),
  );
});

test("only resolves the exact verified official Node public integer finding", () => {
  const file = {
    scanPath: "0/0",
    path: "usr/local/include/node/v8-internal.h",
    layer: 0,
    sha256: "eb74fc0740b7f858a03e319e077c1698d2083325f3154c67771b120fb48f8520",
    size: 70804,
    publicLine: [
      "const int ",
      "kApiTaggedSize",
      " = ",
      "kApiInt32Size",
      ";",
    ].join(""),
  };
  const finding = {
    File: "0/0",
    RuleID: "generic-api-key",
    StartLine: 187,
    EndLine: 187,
    StartColumn: 12,
    EndColumn: 42,
    Match: ["kApiTaggedSize", " = ", "REDACTED", ";"].join(""),
    Secret: "REDACTED",
  };
  assert.equal(classifyFindings([finding], [file], 1).resolved, 1);
  for (const altered of [
    { ...file, layer: 1 },
    { ...file, sha256: "0".repeat(64) },
    { ...file, size: 1 },
    { ...file, publicLine: "private" },
    { ...file, path: "app/v8-internal.h" },
  ])
    assert.equal(classifyFindings([finding], [altered], 1).unresolved, 1);
  for (const altered of [
    { ...finding, StartLine: 186 },
    { ...finding, RuleID: "other" },
    { ...finding, Match: "other" },
    { ...finding, Secret: "other" },
  ])
    assert.equal(classifyFindings([altered], [file], 1).unresolved, 1);
});

test("scanner errors and inconsistent exit codes fail closed", () => {
  assert.doesNotThrow(() => assertScanResult(0, 0));
  assert.doesNotThrow(() => assertScanResult(2, 1));
  const cases: [number | null, number][] = [
    [2, 0],
    [1, 1],
    [null, 0],
    [0, 1],
    [1, 0],
  ];
  for (const [exit, count] of cases)
    assert.throws(() => assertScanResult(exit, count));
});

test("binds a containerd image manifest to the config and ordered saved blobs", () => {
  const configDigest = "sha256:" + "a".repeat(64);
  const layers = ["sha256:" + "b".repeat(64), "sha256:" + "c".repeat(64)];
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest },
      layers: layers.map((digest) => ({ digest })),
    }),
  );
  const imageId = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() =>
    validateManifestBinding(bytes, imageId, configDigest, layers),
  );
  assert.throws(() =>
    validateManifestBinding(
      bytes,
      "sha256:" + "0".repeat(64),
      configDigest,
      layers,
    ),
  );
  assert.throws(() =>
    validateManifestBinding(bytes, imageId, "sha256:" + "0".repeat(64), layers),
  );
  assert.throws(() =>
    validateManifestBinding(
      bytes,
      imageId,
      configDigest,
      [...layers].reverse(),
    ),
  );
});
