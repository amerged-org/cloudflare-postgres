// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateRegistryBinding, promotionArguments } from "./registry.ts";

test("published manifest/config must bind the qualified image, labels and ordered layers", () => {
  const config = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Labels: {
          "org.opencontainers.image.source":
            "https://github.com/public/product",
          "org.opencontainers.image.revision": "a".repeat(40),
        },
      },
      rootfs: { type: "layers", diff_ids: ["sha256:" + "b".repeat(64)] },
    }),
  );
  const configDigest =
    "sha256:" + createHash("sha256").update(config).digest("hex");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest },
      layers: [{ digest: "sha256:" + "c".repeat(64) }],
    }),
  );
  const imageId =
    "sha256:" + createHash("sha256").update(manifest).digest("hex");
  const qualification = {
    imageId,
    configDigest,
    revision: "a".repeat(40),
    source: "https://github.com/public/product",
    diffIDs: ["sha256:" + "b".repeat(64)],
    registryLayerDigests: ["sha256:" + "c".repeat(64)],
  };
  assert.doesNotThrow(() =>
    validateRegistryBinding(manifest, imageId, config, qualification),
  );
  assert.throws(() =>
    validateRegistryBinding(
      manifest,
      "sha256:" + "0".repeat(64),
      config,
      qualification,
    ),
  );
  assert.throws(() =>
    validateRegistryBinding(
      manifest,
      imageId,
      Buffer.from("{}"),
      qualification,
    ),
  );
  assert.throws(() =>
    validateRegistryBinding(manifest, imageId, config, {
      ...qualification,
      revision: "d".repeat(40),
    }),
  );
  assert.throws(() =>
    validateRegistryBinding(manifest, imageId, config, {
      ...qualification,
      diffIDs: [],
    }),
  );
  assert.throws(() =>
    validateRegistryBinding(manifest, imageId, config, {
      ...qualification,
      registryLayerDigests: ["sha256:" + "0".repeat(64)],
    }),
  );
});

test("latest promotion only uses the verified immutable SHA-tag digest", () => {
  const manifestDigest = "sha256:" + "a".repeat(64);
  const configDigest = "sha256:" + "b".repeat(64);
  const image = {
    imageId: manifestDigest,
    configDigest,
    revision: "c".repeat(40),
    source: "https://github.com/public/product",
    diffIDs: [],
  };
  const verified = { digest: manifestDigest, manifestDigest, configDigest };
  assert.deepEqual(
    promotionArguments("ghcr.io/public/product", verified, image),
    [
      "buildx",
      "imagetools",
      "create",
      "--prefer-index=false",
      "--tag",
      "ghcr.io/public/product:latest",
      `ghcr.io/public/product@${manifestDigest}`,
    ],
  );
  assert.throws(() =>
    promotionArguments(
      "ghcr.io/public/product",
      { ...verified, digest: "latest" },
      image,
    ),
  );
  assert.throws(() =>
    promotionArguments(
      "ghcr.io/public/product",
      { ...verified, configDigest: "sha256:" + "0".repeat(64) },
      image,
    ),
  );
  assert.throws(() =>
    promotionArguments(
      "ghcr.io/public/product",
      { ...verified, manifestDigest: "sha256:" + "0".repeat(64) },
      image,
    ),
  );
});
