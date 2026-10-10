// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { gzipSync, gunzipSync } from "node:zlib";
import { pack } from "tar-stream";
import * as publisher from "./publish-talos-installer.mjs";
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };
import {
  installerPublicationBinding,
  verifyInstallerSourceCi,
} from "./publish-talos-installer.mjs";

test("a supplemental-only green run cannot qualify installer source", () => {
  const input = { source_commit: "a".repeat(40) };
  const run = {
    head_sha: input.source_commit,
    status: "completed",
    conclusion: "success",
  };
  assert.throws(() =>
    verifyInstallerSourceCi(input, run, {
      jobs: [
        { name: "external_probe", status: "completed", conclusion: "success" },
      ],
    }),
  );
  assert.throws(() =>
    verifyInstallerSourceCi(input, run, {
      jobs: [
        { name: "check", status: "completed", conclusion: "skipped" },
        {
          name: "native_runtime_images",
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
  );
  assert.doesNotThrow(() =>
    verifyInstallerSourceCi(input, run, {
      jobs: ["check", "native_runtime_images"].map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
      })),
    }),
  );
});

test("publication binds the assembled installer to its exact successful source release", () => {
  const input = {
    version: 1,
    assembly_verified: true,
    source_commit: "a".repeat(40),
    source_ci: 1,
    recipe_sha256: "b".repeat(64),
    manifest_digest: "sha256:" + "c".repeat(64),
    archive_sha256: "d".repeat(64),
    archive_bytes: 4096,
    talos_version: versions.target.talosVersion,
    installer: {
      configDigest: "sha256:" + "e".repeat(64),
      diffIDs: [],
      layerDigests: [],
    },
  };
  const release = { targetCommitish: input.source_commit, isDraft: false };
  const selected = installerPublicationBinding(input, release);
  assert.equal(selected.transportReport.source_commit, input.source_commit);
  assert.equal(selected.transportReport.installer, input.installer);
  assert.match(selected.tag, /^talos-r2-sandbox-a{12}-c{12}-oci$/);
  assert.throws(() =>
    installerPublicationBinding(input, {
      ...release,
      targetCommitish: "f".repeat(40),
    }),
  );
  assert.throws(() =>
    installerPublicationBinding(
      { ...input, assembly_verified: false },
      release,
    ),
  );
  assert.throws(() =>
    installerPublicationBinding(input, { ...release, isDraft: true }),
  );
});

test("publication failures retain their safe stage without payload contents", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pgcf-installer-failure-")),
    dir = join(parent, "publish");
  const secret = "invalid-release-secret-canary";
  try {
    await assert.rejects(publisher.publishSelectedInstaller("!" + secret, dir));
    const bytes = await readFile(join(dir, "failure.json"), "utf8"),
      report = JSON.parse(bytes);
    assert.equal(report.stage, "input");
    assert.equal(report.copy_attempted, false);
    assert.equal(bytes.includes(secret), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function archiveFiles(files) {
  const stream = pack(),
    chunks = [];
  const collecting = (async () => {
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  for (const [name, bytes] of Object.entries(files))
    stream.entry({ name, size: bytes.length, mtime: new Date(0) }, bytes);
  stream.finalize();
  return collecting;
}
test(
  "actual OCI archive transfer preserves manifest and compressed bytes instead of Docker recompression",
  { skip: process.env.PGCF_TEST_SKOPEO !== "1" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgcf-preserve-installer-")),
      digest = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
    try {
      const raw = await archiveFiles({
          "bin/installer": Buffer.from(
            "installer transfer fixture\n".repeat(100),
          ),
        }),
        gzip = gzipSync(raw, { level: 9 });
      const alternate = gzipSync(raw, { level: 1 });
      assert.notEqual(digest(gzip), digest(alternate));
      assert.equal(digest(gunzipSync(gzip)), digest(gunzipSync(alternate)));
      const config = Buffer.from(
        JSON.stringify({
          architecture: "amd64",
          os: "linux",
          config: { Entrypoint: ["/bin/installer"] },
          rootfs: { type: "layers", diff_ids: [digest(raw)] },
        }),
      );
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          config: {
            mediaType: "application/vnd.docker.container.image.v1+json",
            digest: digest(config),
            size: config.length,
          },
          layers: [
            {
              mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
              digest: digest(gzip),
              size: gzip.length,
            },
          ],
        }),
      );
      const index = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          manifests: [
            {
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              digest: digest(manifest),
              size: manifest.length,
            },
          ],
        }),
      );
      const archive = join(dir, "installer.tar");
      await writeFile(
        archive,
        await archiveFiles({
          "oci-layout": Buffer.from('{"imageLayoutVersion":"1.0.0"}'),
          "index.json": index,
          ["blobs/sha256/" + digest(config).slice(7)]: config,
          ["blobs/sha256/" + digest(manifest).slice(7)]: manifest,
          ["blobs/sha256/" + digest(gzip).slice(7)]: gzip,
        }),
        { mode: 0o600 },
      );
      const copied = await publisher.copyInstallerArchive(
        archive,
        "dir:" + join(dir, "copied"),
        dir,
      );
      assert.equal(
        copied.code,
        0,
        await readFile(join(dir, "archive-copy.log"), "utf8"),
      );
      assert.equal(copied.digest, digest(manifest));
      assert.deepEqual(
        await readFile(join(dir, "copied/manifest.json")),
        manifest,
      );
      assert.deepEqual(
        await readFile(join(dir, "copied", digest(config).slice(7))),
        config,
      );
      assert.deepEqual(
        await readFile(join(dir, "copied", digest(gzip).slice(7))),
        gzip,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
