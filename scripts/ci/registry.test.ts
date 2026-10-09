// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { test } from "node:test";
import * as registry from "./registry.ts";
import {
  validateRegistryBinding,
  promotionArguments,
  verifyRegistry,
  REGISTRY_READBACK_LIMITS,
} from "./registry.ts";

const sha256 = (bytes: Buffer) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

test("registry readback equality binds content while permitting independent measurements", () => {
  const first = {
    digest: "sha256:" + "a".repeat(64),
    manifestDigest: "sha256:" + "b".repeat(64),
    configDigest: "sha256:" + "c".repeat(64),
    layersVerified: 3,
    compressedBytes: 1234,
    uncompressedBytes: 5678,
    getRequests: 6,
    elapsedMs: 120,
    limits: REGISTRY_READBACK_LIMITS,
  };
  const second = { ...first, getRequests: 7, elapsedMs: 180 };
  assert.doesNotThrow(() =>
    registry.assertEquivalentRegistryReadbacks(first, second),
  );
  for (const field of ["digest", "manifestDigest", "configDigest"] as const)
    assert.throws(() =>
      registry.assertEquivalentRegistryReadbacks(first, {
        ...second,
        [field]: "sha256:" + "d".repeat(64),
      }),
    );
  for (const field of [
    "layersVerified",
    "compressedBytes",
    "uncompressedBytes",
  ] as const) {
    assert.throws(() =>
      registry.assertEquivalentRegistryReadbacks(first, {
        ...second,
        [field]: first[field] + 1,
      }),
    );
    assert.throws(() =>
      registry.assertEquivalentRegistryReadbacks(
        { ...first, [field]: -1 },
        { ...second, [field]: -1 },
      ),
    );
  }
  assert.throws(() =>
    registry.assertEquivalentRegistryReadbacks(
      { ...first, compressedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...second, compressedBytes: Number.MAX_SAFE_INTEGER + 1 },
    ),
  );
});

test("inspected upstream Talos installer uses an explicit bound registry path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-talos-registry-"));
  const raws = [
    Buffer.from("upstream installer layer"),
    Buffer.from("qualified recipe payload layer"),
  ];
  const blobs = raws.map((raw) => gzipSync(raw));
  const layers = blobs.map((blob) => ({
    digest: sha256(blob),
    size: blob.length,
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
  }));
  let source = "https://github.com/siderolabs/talos";
  const configBytes = () =>
    Buffer.from(
      JSON.stringify({
        architecture: "amd64",
        os: "linux",
        rootfs: { type: "layers", diff_ids: raws.map(sha256) },
        config: {
          Entrypoint: ["/bin/installer"],
          Env: ["VERSION=v1.14.1"],
          Labels: {
            "alpha.talos.dev/version": "v1.14.1",
            "org.opencontainers.image.source": source,
          },
        },
      }),
    );
  const inspected = () => ({
    configDigest: sha256(configBytes()),
    diffIDs: raws.map(sha256),
    layerDigests: layers.map((layer) => layer.digest),
  });
  let layerReads = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://ghcr.io/token?"))
      return new Response(JSON.stringify({ token: "unit-token" }));
    const config = configBytes();
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        config: { digest: sha256(config) },
        layers,
      }),
    );
    if (url.includes("/manifests/"))
      return new Response(manifest, {
        headers: { "docker-content-digest": sha256(manifest) },
      });
    if (url.endsWith(sha256(config))) return new Response(config);
    const index = layers.findIndex((layer) => url.endsWith(layer.digest));
    assert.ok(index >= 0);
    layerReads++;
    return new Response(blobs[index]!);
  });
  const oldActor = process.env.GITHUB_ACTOR,
    oldToken = process.env.GH_TOKEN;
  process.env.GITHUB_ACTOR = "unit-actor";
  process.env.GH_TOKEN = "unit-credential";
  try {
    const current = inspected();
    await assert.rejects(
      verifyRegistry(
        "ghcr.io/public/installer:qualified",
        {
          ...current,
          imageId: current.configDigest,
          revision: "a".repeat(40),
          source,
          registryLayerDigests: current.layerDigests,
        },
        join(directory, "ordinary.json"),
      ),
      /revision label mismatch/,
    );
    assert.equal(
      layerReads,
      0,
      "ordinary path still requires PGCF revision labels",
    );
    const receipt = await registry.verifyTalosInstallerRegistry(
      "ghcr.io/public/installer:qualified",
      current,
      "1.14.1",
      join(directory, "installer.json"),
    );
    assert.equal(layerReads, 2);
    assert.equal(receipt.configDigest, current.configDigest);
    assert.equal(receipt.layersVerified, 2);
    layerReads = 0;
    await assert.rejects(
      registry.verifyTalosInstallerRegistry(
        "ghcr.io/public/installer:qualified",
        current,
        "1.14.2",
        join(directory, "version.json"),
      ),
    );
    await assert.rejects(
      registry.verifyTalosInstallerRegistry(
        "ghcr.io/public/installer:qualified",
        { ...current, layerDigests: [...current.layerDigests].reverse() },
        "1.14.1",
        join(directory, "order.json"),
      ),
    );
    source = "https://github.com/other/talos";
    await assert.rejects(
      registry.verifyTalosInstallerRegistry(
        "ghcr.io/public/installer:qualified",
        inspected(),
        "1.14.1",
        join(directory, "source.json"),
      ),
    );
    assert.equal(
      layerReads,
      0,
      "upstream version/source and exact compressed layer order precede downloads",
    );
  } finally {
    if (oldActor === undefined) delete process.env.GITHUB_ACTOR;
    else process.env.GITHUB_ACTOR = oldActor;
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ["corruption", "truncation", "diffID"] as const) {
  test(`registry receipt refuses actual layer ${failure}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pgcf-registry-"));
    const report = join(directory, "verified.json");
    const raw = Buffer.from("actual public layer fixture".repeat(100));
    const compressed = gzipSync(raw);
    const layerDigest = sha256(compressed);
    const diffID =
      failure === "diffID"
        ? sha256(Buffer.from("other uncompressed layer"))
        : sha256(raw);
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
        rootfs: { type: "layers", diff_ids: [diffID] },
      }),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        config: { digest: sha256(config), size: config.length },
        layers: [
          {
            digest: layerDigest,
            size: compressed.length,
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          },
        ],
      }),
    );
    const requested: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url.startsWith("https://ghcr.io/token?"))
          return new Response(JSON.stringify({ token: "unit-pull-token" }));
        let bytes: Buffer;
        if (url.includes("/manifests/")) bytes = manifest;
        else if (url.endsWith(sha256(config))) bytes = config;
        else {
          assert.ok(url.endsWith(layerDigest));
          bytes = Buffer.from(compressed);
          // Changing gzip's timestamp keeps decompression and diffID valid, but
          // must still fail the compressed registry digest.
          if (failure === "corruption") bytes[4] = bytes[4]! ^ 1;
          if (failure === "truncation")
            bytes = bytes.subarray(0, bytes.length - 8);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 7)
                controller.enqueue(bytes.subarray(i, i + 7));
              controller.close();
            },
          }),
          {
            headers: {
              "docker-content-digest": url.includes("/manifests/")
                ? sha256(manifest)
                : url.split("/").at(-1)!,
            },
          },
        );
      },
    );
    const oldActor = process.env.GITHUB_ACTOR,
      oldToken = process.env.GH_TOKEN;
    process.env.GITHUB_ACTOR = "unit-actor";
    process.env.GH_TOKEN = "unit-credential";
    try {
      await assert.rejects(
        verifyRegistry(
          "ghcr.io/public/product:qualified",
          {
            imageId: sha256(config),
            configDigest: sha256(config),
            revision: "a".repeat(40),
            source: "https://github.com/public/product",
            diffIDs: [diffID],
            registryLayerDigests: [layerDigest],
          },
          report,
        ),
      );
      assert.ok(
        requested.some((url) => url.endsWith(layerDigest)),
        "actual layer was read",
      );
      await assert.rejects(access(report), { code: "ENOENT" });
    } finally {
      if (oldActor === undefined) delete process.env.GITHUB_ACTOR;
      else process.env.GITHUB_ACTOR = oldActor;
      if (oldToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = oldToken;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("registry reads every gzip, zstd and raw layer and records measured counts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-registry-"));
  const report = join(directory, "verified.json");
  const raws = [
    Buffer.from("gzip layer fixture".repeat(100)),
    Buffer.from("zstd layer fixture".repeat(100)),
    Buffer.from("raw layer fixture"),
  ];
  const blobs = [gzipSync(raws[0]!), zstdCompressSync(raws[1]!), raws[2]!];
  const layers = blobs.map((blob, index) => ({
    digest: sha256(blob),
    size: blob.length,
    mediaType: [
      "application/vnd.oci.image.layer.v1.tar+gzip",
      "application/vnd.oci.image.layer.v1.tar+zstd",
      "application/vnd.oci.image.layer.v1.tar",
    ][index],
  }));
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
      rootfs: { type: "layers", diff_ids: raws.map(sha256) },
    }),
  );
  const qualification = {
    imageId: sha256(config),
    configDigest: sha256(config),
    revision: "a".repeat(40),
    source: "https://github.com/public/product",
    diffIDs: raws.map(sha256),
  };
  let selectedLayers = layers;
  const layerReads: string[] = [];
  let stall: AbortController | undefined;
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      assert.equal(options?.method ?? "GET", "GET");
      assert.ok(options?.signal instanceof AbortSignal);
      if (url.startsWith("https://ghcr.io/token?")) {
        assert.ok(
          new Headers(options?.headers)
            .get("Authorization")
            ?.startsWith("Basic "),
        );
        return new Response(
          JSON.stringify({ access_token: "unit-pull-token" }),
        );
      }
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        "Bearer unit-pull-token",
      );
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          config: { digest: sha256(config) },
          layers: selectedLayers,
        }),
      );
      if (url.includes("/manifests/"))
        return new Response(manifest, {
          headers: { "docker-content-digest": sha256(manifest) },
        });
      if (url.endsWith(sha256(config))) return new Response(config);
      const index = layers.findIndex((layer) => url.endsWith(layer.digest));
      assert.ok(index >= 0);
      layerReads.push(layers[index]!.digest);
      if (stall)
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              queueMicrotask(() => stall!.abort());
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = blobs[index]!;
            for (let i = 0; i < bytes.length; i += 5)
              controller.enqueue(bytes.subarray(i, i + 5));
            controller.close();
          },
        }),
        { headers: { "content-length": String(blobs[index]!.length) } },
      );
    },
  );
  const oldActor = process.env.GITHUB_ACTOR,
    oldToken = process.env.GH_TOKEN;
  process.env.GITHUB_ACTOR = "unit-actor";
  process.env.GH_TOKEN = "unit-credential";
  try {
    await verifyRegistry(
      "ghcr.io/public/product:qualified",
      qualification,
      report,
    );
    const receipt = JSON.parse(await readFile(report, "utf8"));
    assert.deepEqual(
      layerReads,
      layers.map((layer) => layer.digest),
    );
    assert.equal(receipt.layersVerified, 3);
    assert.equal(receipt.getRequests, 6);
    assert.ok(
      Number.isSafeInteger(receipt.elapsedMs) && receipt.elapsedMs >= 0,
    );
    assert.deepEqual(receipt.limits, REGISTRY_READBACK_LIMITS);
    assert.equal(
      receipt.compressedBytes,
      blobs.reduce((sum, blob) => sum + blob.length, 0),
    );
    assert.equal(
      receipt.uncompressedBytes,
      raws.reduce((sum, raw) => sum + raw.length, 0),
    );
    layerReads.length = 0;
    selectedLayers = layers.map((layer, index) =>
      index === 0
        ? {
            ...layer,
            size: REGISTRY_READBACK_LIMITS.compressed_layer_bytes + 1,
          }
        : layer,
    );
    await assert.rejects(
      verifyRegistry(
        "ghcr.io/public/product:qualified",
        qualification,
        join(directory, "too-large.json"),
      ),
    );
    assert.equal(
      layerReads.length,
      0,
      "oversized descriptor rejects before blob download",
    );
    selectedLayers = layers.map((layer, index) =>
      index === 0 ? { ...layer, mediaType: "application/unknown" } : layer,
    );
    await assert.rejects(
      verifyRegistry(
        "ghcr.io/public/product:qualified",
        qualification,
        join(directory, "unknown.json"),
      ),
    );
    assert.equal(
      layerReads.length,
      0,
      "unsupported compression cannot bypass diffID validation",
    );
    selectedLayers = layers;
    stall = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.ok(
        ms === REGISTRY_READBACK_LIMITS.total_ms ||
          ms === REGISTRY_READBACK_LIMITS.request_ms,
      );
      return stall!.signal;
    });
    const abortedReport = join(directory, "aborted.json");
    await assert.rejects(
      verifyRegistry(
        "ghcr.io/public/product:qualified",
        qualification,
        abortedReport,
      ),
      { name: "AbortError" },
    );
    assert.equal(cancelled, true, "deadline cancels a stalled layer body");
    await assert.rejects(access(abortedReport), { code: "ENOENT" });
  } finally {
    if (oldActor === undefined) delete process.env.GITHUB_ACTOR;
    else process.env.GITHUB_ACTOR = oldActor;
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
    await rm(directory, { recursive: true, force: true });
  }
});

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
