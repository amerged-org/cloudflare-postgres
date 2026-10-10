// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { URL, Headers, Response } = globalThis;
import {
  objectDescriptor,
  publishImmutableObject,
  verifyObjectHead,
} from "./publish-fleet-images.mjs";

test("immutable fleet objects resolve unknown PUT by readback without repeating or overwriting", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-image-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("original compressed image bytes");
  const file = join(directory, "image");
  await writeFile(file, bytes, { mode: 0o600 });
  const sha = createHash("sha256").update(bytes).digest("hex");
  const object = objectDescriptor(
    file,
    sha,
    bytes.length,
    "blob",
    "application/octet-stream",
    "a".repeat(64),
  );
  let exists = false,
    writes = 0,
    reads = 0;
  const head = () => ({
    ContentLength: bytes.length,
    ContentType: object.content_type,
    Metadata: { ...object.metadata, manifest_sha256: "b".repeat(64) },
  });
  const operations = {
    head: async () => (exists ? head() : null),
    put: async () => {
      writes++;
      exists = true;
      throw Error("timeout after committed PUT");
    },
    get: async () => {
      reads++;
      return { file, head: head(), cleanup: async () => {} };
    },
  };
  assert.equal(
    (await publishImmutableObject(object, operations)).readback_verified,
    true,
  );
  assert.equal(writes, 1);
  assert.equal(
    (await publishImmutableObject(object, operations)).write_attempted,
    false,
  );
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.throws(() =>
    verifyObjectHead({ ...head(), ContentLength: bytes.length + 1 }, object),
  );
  assert.throws(() =>
    verifyObjectHead(
      { ...head(), Metadata: { ...object.metadata, sha256: "f".repeat(64) } },
      object,
    ),
  );
  let wrongBodyGets = 0;
  await assert.rejects(
    publishImmutableObject(object, {
      ...operations,
      head: async () => ({ ...head(), ContentType: "text/plain" }),
      get: async () => {
        wrongBodyGets++;
        return null;
      },
    }),
  );
  assert.equal(wrongBodyGets, 0);
  assert.equal(writes, 1);
});

test("an unresolved immutable object write stops after one attempt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-image-unresolved-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "raw"),
    bytes = Buffer.from("raw compressed bytes");
  await writeFile(file, bytes);
  const object = objectDescriptor(
    file,
    createHash("sha256").update(bytes).digest("hex"),
    bytes.length,
    "raw",
    "application/x-xz",
  );
  let writes = 0;
  await assert.rejects(
    publishImmutableObject(object, {
      head: async () => null,
      put: async () => {
        writes++;
        throw Error("network uncertainty");
      },
      get: async () => assert.fail("not present"),
    }),
    /fleet_image_write_unresolved/,
  );
  assert.equal(writes, 1);
});

test("R2 EU jurisdiction endpoint uses the existing archive binding without credential URLs", async () => {
  const { r2Endpoint } = await import("./publish-fleet-images.mjs");
  const eu = "https://" + "a".repeat(32) + ".eu.r2.cloudflarestorage.com";
  assert.equal(r2Endpoint(eu), eu);
  assert.equal(
    r2Endpoint("https://" + "a".repeat(32) + ".r2.cloudflarestorage.com"),
    "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com",
  );
  for (const value of [
    "http://" + "a".repeat(32) + ".eu.r2.cloudflarestorage.com",
    eu + "/tenant",
    "https://user:pass@" + "a".repeat(32) + ".eu.r2.cloudflarestorage.com",
    eu + ".evil.example",
  ])
    assert.throws(() => r2Endpoint(value));
});

test("Golden public readback binds digest, actual gzip diffID and raw bytes without shared registry changes", async (t) => {
  const { verifyPublicFleetImages } =
    await import("./publish-fleet-images.mjs");
  const { gzipSync } = await import("node:zlib");
  const versions = (
    await import("../../infra/platform/versions.lock.json", {
      with: { type: "json" },
    })
  ).default;
  const digest = (bytes) =>
    "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const rawLayer = Buffer.from("actual first-party-free installer bytes");
  const blob = gzipSync(rawLayer),
    disk = Buffer.from("compressed raw fixture");
  const configuration = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      rootfs: { type: "layers", diff_ids: [digest(rawLayer)] },
      config: {
        Entrypoint: ["/bin/installer"],
        Env: ["VERSION=v" + versions.target.talosVersion],
        Labels: {
          "alpha.talos.dev/version": "v" + versions.target.talosVersion,
          "org.opencontainers.image.source":
            "https://github.com/siderolabs/talos",
        },
      },
    }),
  );
  const descriptor = (bytes, mediaType) => ({
    digest: digest(bytes),
    size: bytes.length,
    mediaType,
  });
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: descriptor(
        configuration,
        "application/vnd.docker.container.image.v1+json",
      ),
      layers: [
        descriptor(blob, "application/vnd.docker.image.rootfs.diff.tar.gzip"),
      ],
    }),
  );
  const origin = "https://api.example.com";
  const plan = {
    version: 1,
    source_commit: "a".repeat(40),
    installer_ref: "api.example.com/pgcf-talos-installer@" + digest(manifest),
    installer: {
      manifestDigest: digest(manifest),
      configDigest: digest(configuration),
      layerDigests: [digest(blob)],
      diffIDs: [digest(rawLayer)],
    },
    talos_raw_image: {
      url: origin + "/fleet-images/v1/raw/" + digest(disk),
      sha256: digest(disk).slice(7),
      bytes: disk.length,
      format: "raw.xz",
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "pgcf-public-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let fault = null,
    calls = 0;
  const request = async (input, init) => {
    calls++;
    assert.equal(new URL(input).origin, origin);
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), null);
    const value = String(input).includes("/manifests/")
      ? manifest
      : String(input).endsWith(digest(configuration))
        ? configuration
        : String(input).endsWith(digest(blob))
          ? blob
          : disk;
    const sent =
      fault === "tamper" && value === blob
        ? Buffer.from("changed gzip")
        : fault === "raw" && value === disk
          ? Buffer.from("bad raw")
          : value;
    return new Response(sent, {
      headers: {
        "Docker-Content-Digest":
          fault === "digest" ? "sha256:" + "f".repeat(64) : digest(value),
        "Content-Length": String(value.length),
        "Content-Type":
          value === manifest
            ? "application/vnd.docker.distribution.manifest.v2+json"
            : value === configuration
              ? "application/vnd.docker.container.image.v1+json"
              : value === blob
                ? "application/vnd.docker.image.rootfs.diff.tar.gzip"
                : "application/x-xz",
      },
    });
  };
  const result = await verifyPublicFleetImages(
    plan,
    join(directory, "readback.json"),
    request,
  );
  assert.equal(result.passed, true);
  assert.equal(result.installer.manifestDigest, digest(manifest));
  assert.equal(result.layers_verified, 1);
  assert.equal(result.raw_readback_bytes, disk.length);
  assert.equal(calls, 4);
  for (fault of ["digest", "tamper", "raw"])
    await assert.rejects(
      verifyPublicFleetImages(
        plan,
        join(directory, "failed-" + fault + ".json"),
        request,
      ),
    );
  await assert.rejects(
    verifyPublicFleetImages(
      {
        ...plan,
        talos_raw_image: {
          ...plan.talos_raw_image,
          url: "https://other.example.com/fleet-images/v1/raw/" + digest(disk),
        },
      },
      join(directory, "cross-origin.json"),
      request,
    ),
  );
});
