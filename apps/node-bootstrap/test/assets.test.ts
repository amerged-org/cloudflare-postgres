// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadBootstrapAssets } from "../src/build-assets.ts";
import { PLATFORM_ARTIFACTS } from "../src/platform-artifacts.ts";
import { parse, parseAllDocuments } from "yaml";

test("bootstrap asset download rejects checksum changes and bounds streamed bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-assets-test-"));
  try {
    const wrongChecksum: typeof fetch = async (url) => {
      const response = new Response(new Uint8Array(1));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    await assert.rejects(
      downloadBootstrapAssets(directory, wrongChecksum),
      /bootstrap_asset_checksum_mismatch/,
    );
    let cancelled = false;
    const oversized: typeof fetch = async (url) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    await assert.rejects(
      downloadBootstrapAssets(directory, oversized),
      /bootstrap_asset_too_large/,
    );
    assert.equal(cancelled, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Native Cilium handoff digest matches the reviewed platform OCI source pin", async () => {
  const sources = parseAllDocuments(
    await readFile(
      new URL("../../../infra/platform/base/sources.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJSON());
  const cilium = sources.find(
    (value) =>
      value.kind === "OCIRepository" && value.metadata.name === "cilium-chart",
  );
  assert.equal(PLATFORM_ARTIFACTS.cilium.oci_digest, cilium.spec.ref.digest);
});

test("Native regional readback pins the same cloudflared image as reviewed Kustomize and version lock", async () => {
  const kustomization = parse(
    await readFile(
      new URL(
        "../../../infra/platform/regional/kustomization.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const image = kustomization.images.find(
    (value: { name: string }) => value.name === "cloudflared",
  );
  const lock = JSON.parse(
    await readFile(
      new URL("../../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const lockedImage = lock.regional.images.find(
    (value: { name: string }) => value.name === "cloudflared",
  );
  assert.equal(
    PLATFORM_ARTIFACTS.cloudflared.image,
    `${image.newName}@${image.digest}`,
  );
  assert.equal(
    PLATFORM_ARTIFACTS.cloudflared.image,
    `${lockedImage.reference}@${lockedImage.indexDigest}`,
  );
});
