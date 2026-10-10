// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.match(selected.tag, /^talos-r2-sandbox-a{12}-c{12}$/);
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
