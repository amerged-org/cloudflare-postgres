#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Prepare original qualified bytes, then publish immutable objects to the existing R2 bucket.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";
import { extract, pack } from "tar-stream";
import {
  fileIdentity,
  verifyInstallerTransport,
} from "../../infra/talos/sandbox/publish-artifacts.ts";
import { verifyInstallerSourceCi } from "./publish-talos-installer.mjs";

const { fetch, AbortSignal } = globalThis;
const hex = /^[a-f0-9]{64}$/;
const run = promisify(execFile);
/** Anonymous readback of approved Golden bytes; the shared runtime qualifier is unchanged. */
export async function verifyPublicFleetImages(
  plan,
  reportPath,
  request = fetch,
) {
  assert.equal(plan.version, 1);
  assert.match(plan.source_commit, /^[a-f0-9]{40}$/);
  const raw = plan.talos_raw_image;
  const origin = new URL(raw.url);
  assert.equal(origin.protocol, "https:");
  assert.ok(
    !origin.username &&
      !origin.password &&
      !origin.port &&
      !origin.search &&
      !origin.hash,
  );
  assert.match(raw.sha256, hex);
  assert.ok(
    Number.isSafeInteger(raw.bytes) &&
      raw.bytes > 0 &&
      raw.bytes <= 2 * 1024 ** 3 - 1,
  );
  assert.equal(raw.format, "raw.xz");
  assert.equal(
    raw.url,
    origin.origin + "/fleet-images/v1/raw/sha256:" + raw.sha256,
  );
  const expected = plan.installer;
  assert.match(expected.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    plan.installer_ref,
    origin.hostname + "/pgcf-talos-installer@" + expected.manifestDigest,
  );
  const directory = await mkdtemp(
    join(tmpdir(), "pgcf-golden-public-readback-"),
  );
  const deadline = AbortSignal.timeout(15 * 60000);
  let requests = 0;
  const get = async (path, sha256, maximum, contentType, bytes) => {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(120000)]);
    requests++;
    const response = await request(origin.origin + path, {
      redirect: "error",
      credentials: "omit",
      headers: { "Accept-Encoding": "identity" },
      signal,
    });
    try {
      assert.equal(response.status, 200);
      assert.ok(response.body);
      assert.equal(
        response.headers.get("docker-content-digest"),
        "sha256:" + sha256,
      );
      const encoding = response.headers.get("content-encoding");
      assert.ok(!encoding || encoding === "identity");
      if (contentType)
        assert.equal(response.headers.get("content-type"), contentType);
      const length = response.headers.get("content-length");
      assert.ok(
        length && /^[1-9][0-9]*$/.test(length) && Number(length) <= maximum,
      );
      if (bytes !== undefined) assert.equal(Number(length), bytes);
      const hash = createHash("sha256");
      let size = 0;
      const counted = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          if (size > maximum || size > Number(length))
            return done(Error("golden_readback_size_limit"));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      const file = join(directory, sha256);
      await pipeline(
        response.body,
        counted,
        createWriteStream(file, { mode: 0o600, flags: "wx" }),
        { signal },
      );
      assert.equal(size, Number(length));
      assert.equal(hash.digest("hex"), sha256);
      return { file, size, contentType: response.headers.get("content-type") };
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  };
  try {
    const manifestFile = await get(
      "/v2/pgcf-talos-installer/manifests/" + expected.manifestDigest,
      expected.manifestDigest.slice(7),
      1024 ** 2,
    );
    const manifestBytes = await readFile(manifestFile.file);
    const manifest = JSON.parse(manifestBytes.toString());
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(
      [
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(manifest.mediaType),
    );
    assert.equal(manifestFile.contentType, manifest.mediaType);
    assert.equal(manifest.config?.digest, expected.configDigest);
    assert.ok(
      Array.isArray(manifest.layers) &&
        manifest.layers.length > 0 &&
        manifest.layers.length <= 32,
    );
    assert.deepEqual(
      manifest.layers.map((layer) => layer.digest),
      expected.layerDigests,
    );
    const blobs = [];
    for (const descriptor of [manifest.config, ...manifest.layers]) {
      assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(
        Number.isSafeInteger(descriptor.size) &&
          descriptor.size > 0 &&
          descriptor.size <= 2 * 1024 ** 3 - 1 &&
          !descriptor.urls,
      );
      assert.ok(
        typeof descriptor.mediaType === "string" &&
          /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(descriptor.mediaType),
      );
      const selected = await get(
        "/v2/pgcf-talos-installer/blobs/" + descriptor.digest,
        descriptor.digest.slice(7),
        descriptor.size,
        descriptor.mediaType,
        descriptor.size,
      );
      blobs.push({
        name: "blobs/sha256/" + descriptor.digest.slice(7),
        ...selected,
      });
    }
    for (const [index, layer] of manifest.layers.entries()) {
      assert.ok(
        [
          "application/vnd.oci.image.layer.v1.tar+gzip",
          "application/vnd.docker.image.rootfs.diff.tar.gzip",
        ].includes(layer.mediaType),
      );
      const hash = createHash("sha256");
      let bytes = 0;
      const sink = new Writable({
        write(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 ** 3)
            return done(Error("golden_diffid_size_limit"));
          hash.update(chunk);
          done();
        },
      });
      await pipeline(
        createReadStream(blobs[index + 1].file),
        createGunzip(),
        sink,
        { signal: deadline },
      );
      assert.equal("sha256:" + hash.digest("hex"), expected.diffIDs[index]);
    }
    const archive = join(directory, "installer.transport.tar"),
      packed = pack();
    const output = pipeline(
      packed,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );
    // Capture errors immediately while entries are streamed, then await final completion below.
    output.catch(() => undefined);
    const metadata = {
      "oci-layout": { imageLayoutVersion: "1.0.0" },
      "index.json": {
        schemaVersion: 2,
        manifests: [
          {
            digest: expected.manifestDigest,
            mediaType: manifest.mediaType,
            size: manifestBytes.length,
          },
        ],
      },
      "manifest.json": [
        {
          Config: blobs[0].name,
          Layers: blobs.slice(1).map((blob) => blob.name),
        },
      ],
    };
    for (const [name, value] of Object.entries(metadata))
      packed.entry({ name }, JSON.stringify(value));
    for (const blob of [
      {
        name: "blobs/sha256/" + expected.manifestDigest.slice(7),
        ...manifestFile,
      },
      ...blobs,
    ])
      await pipeline(
        createReadStream(blob.file),
        packed.entry({ name: blob.name, size: blob.size, mode: 0o600 }),
      );
    packed.finalize();
    await output;
    const installer = await verifyInstallerTransport(
      archive,
      { passed: true, source_commit: plan.source_commit, installer: expected },
      plan.source_commit,
    );
    assert.equal(installer.manifestDigest, expected.manifestDigest);
    const disk = await get(
      "/fleet-images/v1/raw/sha256:" + raw.sha256,
      raw.sha256,
      raw.bytes,
      "application/x-xz",
      raw.bytes,
    );
    const receipt = {
      at: new Date().toISOString(),
      source_commit: plan.source_commit,
      installer_ref: plan.installer_ref,
      installer,
      layers_verified: manifest.layers.length,
      talos_raw_image: raw,
      raw_readback_bytes: disk.size,
      get_requests: requests,
      passed: true,
    };
    await writeFile(reportPath, JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export function objectDescriptor(
  file,
  sha256,
  bytes,
  kind,
  contentType,
  parent,
) {
  assert.match(sha256, hex);
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
  assert.ok(["manifest", "blob", "raw"].includes(kind));
  assert.ok(contentType && !/[\r\n]/.test(contentType));
  if (kind === "blob") assert.match(parent, hex);
  return {
    file: resolve(file),
    key: "fleet-images/v1/sha256/" + sha256,
    sha256,
    bytes,
    content_type: contentType,
    metadata: {
      artifact_kind: kind,
      sha256,
      bytes: String(bytes),
      ...(kind === "blob" ? { manifest_sha256: parent } : {}),
    },
  };
}
export function verifyObjectHead(head, object) {
  assert.equal(head.ContentLength, object.bytes, "fleet_image_length_conflict");
  assert.equal(
    head.ContentType,
    object.content_type,
    "fleet_image_type_conflict",
  );
  for (const key of ["artifact_kind", "sha256", "bytes"])
    assert.equal(
      head.Metadata?.[key],
      object.metadata[key],
      "fleet_image_metadata_conflict",
    );
  // A shared blob keeps its first approved manifest owner; never overwrite its metadata.
  if (object.metadata.artifact_kind === "blob")
    assert.match(head.Metadata?.manifest_sha256 ?? "", hex);
}
export async function stageFleetImages(
  qualificationPath,
  archive,
  raw,
  directory,
  publicOrigin,
) {
  const origin = new URL(publicOrigin);
  assert.equal(origin.protocol, "https:");
  assert.equal(origin.pathname, "/");
  assert.ok(
    !origin.username &&
      !origin.password &&
      !origin.port &&
      !origin.search &&
      !origin.hash,
  );
  const report = JSON.parse(await readFile(qualificationPath, "utf8"));
  assert.equal(report.passed, true);
  assert.equal(report.same_input_profiles_verified, true);
  assert.equal(report.imager_and_base_official_signatures_reused, true);
  assert.match(report.source_commit, /^[a-f0-9]{40}$/);
  assert.match(report.recipe_sha256, hex);
  assert.ok(
    Number.isSafeInteger(report.first_party_extension_qualification_CI),
  );
  assert.deepEqual(await fileIdentity(archive), {
    sha256: report.installer.archive_sha256,
    size: report.installer.archive_bytes,
  });
  assert.deepEqual(await fileIdentity(raw), report.raw.compressed);
  const transport = await verifyInstallerTransport(
    archive,
    report,
    report.source_commit,
  );
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 });
  const selected = new Set([
    transport.manifestDigest,
    transport.configDigest,
    ...transport.layerDigests,
  ]);
  const unpack = extract();
  unpack.on("entry", (header, stream, next) => {
    (async () => {
      const name = header.name;
      if (
        !/^blobs\/sha256\/[a-f0-9]{64}$/.test(name) ||
        !selected.has("sha256:" + name.slice(13))
      ) {
        stream.resume();
        next();
        return;
      }
      const destination = join(directory, name.slice(13));
      await pipeline(
        stream,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
      assert.deepEqual(await fileIdentity(destination), {
        sha256: name.slice(13),
        size: header.size,
      });
      next();
    })().catch((error) => unpack.destroy(error));
  });
  await pipeline(createReadStream(archive), unpack);
  const manifestHash = transport.manifestDigest.slice(7);
  const manifest = JSON.parse(
    await readFile(join(directory, manifestHash), "utf8"),
  );
  const descriptor = async (hash, kind, contentType, size) => {
    const file = join(directory, hash);
    const identity = await fileIdentity(file);
    if (size !== undefined) assert.equal(identity.size, size);
    return objectDescriptor(
      file,
      hash,
      identity.size,
      kind,
      contentType,
      manifestHash,
    );
  };
  const objects = [
    await descriptor(manifestHash, "manifest", manifest.mediaType),
  ];
  objects.push(
    await descriptor(
      manifest.config.digest.slice(7),
      "blob",
      manifest.config.mediaType,
      manifest.config.size,
    ),
  );
  for (const layer of manifest.layers)
    objects.push(
      await descriptor(
        layer.digest.slice(7),
        "blob",
        layer.mediaType,
        layer.size,
      ),
    );
  objects.push(
    objectDescriptor(
      raw,
      report.raw.compressed.sha256,
      report.raw.compressed.size,
      "raw",
      "application/x-xz",
    ),
  );
  const plan = {
    version: 1,
    source_commit: report.source_commit,
    source_ci: report.first_party_extension_qualification_CI,
    recipe_sha256: report.recipe_sha256,
    installer_ref:
      origin.hostname + "/pgcf-talos-installer@" + transport.manifestDigest,
    talos_raw_image: {
      url:
        origin.origin +
        "/fleet-images/v1/raw/sha256:" +
        report.raw.compressed.sha256,
      sha256: report.raw.compressed.sha256,
      format: "raw.xz",
      bytes: report.raw.compressed.size,
      raw_sha256: report.raw.decompressed.sha256,
      raw_bytes: report.raw.decompressed.size,
    },
    installer: transport,
    objects,
  };
  await writeFile(
    join(directory, "objects.json"),
    JSON.stringify(plan, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return plan;
}
export async function publishImmutableObject(object, operations) {
  assert.equal(object.key, "fleet-images/v1/sha256/" + object.sha256);
  assert.deepEqual(await fileIdentity(object.file), {
    sha256: object.sha256,
    size: object.bytes,
  });
  let existing = await operations.head(object);
  let attempted = false;
  if (!existing) {
    attempted = true;
    // A timeout/conflict may already have committed. Resolve by readback, never repeat the write.
    await operations.put(object).catch(() => undefined);
    existing = await operations.head(object);
  }
  assert.ok(existing, "fleet_image_write_unresolved");
  verifyObjectHead(existing, object);
  const download = await operations.get(object);
  try {
    assert.deepEqual(await fileIdentity(download.file), {
      sha256: object.sha256,
      size: object.bytes,
    });
    verifyObjectHead(download.head, object);
  } finally {
    await download.cleanup();
  }
  return {
    key: object.key,
    sha256: object.sha256,
    bytes: object.bytes,
    write_attempted: attempted,
    readback_verified: true,
  };
}
export function r2Endpoint(endpoint) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, "https:");
  assert.match(
    url.hostname,
    /^[a-f0-9]{32}(?:\.eu)?\.r2\.cloudflarestorage\.com$/,
  );
  assert.ok(
    !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
  );
  return url.origin;
}
export async function uploadFleetImages(
  plan,
  bucket,
  endpoint,
  region,
  receiptPath,
) {
  assert.equal(plan.version, 1);
  assert.match(
    process.env.GITHUB_REPOSITORY ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  const request = async (program, args) =>
    (
      await run(program, args, {
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          AWS_MAX_ATTEMPTS: "1",
          AWS_RETRY_MODE: "standard",
          AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
          AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
          AWS_PAGER: "",
        },
      })
    ).stdout;
  const sourcePath =
    "repos/" +
    process.env.GITHUB_REPOSITORY +
    "/actions/runs/" +
    plan.source_ci;
  verifyInstallerSourceCi(
    plan,
    JSON.parse(await request("gh", ["api", sourcePath])),
    JSON.parse(
      await request("gh", [
        "api",
        sourcePath + "/jobs?filter=latest&per_page=100",
      ]),
    ),
  );
  const selectedEndpoint = r2Endpoint(endpoint);
  assert.match(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  assert.ok(
    region &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY,
  );
  const args = (action, object) => [
    "s3api",
    action,
    "--endpoint-url",
    selectedEndpoint,
    "--region",
    region,
    "--bucket",
    bucket,
    "--key",
    object.key,
    "--no-cli-pager",
    "--cli-connect-timeout",
    "20",
    "--cli-read-timeout",
    "120",
  ];
  const directory = await mkdtemp(join(tmpdir(), "pgcf-fleet-image-readback-"));
  const objects = [];
  try {
    for (const object of plan.objects) {
      objects.push(
        await publishImmutableObject(object, {
          head: async (selected) => {
            try {
              return JSON.parse(
                await request("aws", args("head-object", selected)),
              );
            } catch (error) {
              if (/\(404\)|\(NoSuchKey\)|\(NotFound\)/.test(error.stderr ?? ""))
                return null;
              throw Error("fleet_image_head_unresolved");
            }
          },
          put: async (selected) =>
            request("aws", [
              ...args("put-object", selected),
              "--body",
              selected.file,
              "--if-none-match",
              "*",
              "--content-type",
              selected.content_type,
              "--metadata",
              JSON.stringify(selected.metadata),
            ]),
          get: async (selected) => {
            const file = join(directory, selected.sha256);
            const head = JSON.parse(
              await request("aws", [...args("get-object", selected), file]),
            );
            return { file, head, cleanup: () => rm(file, { force: true }) };
          },
        }),
      );
    }
    const receipt = {
      at: new Date().toISOString(),
      source_commit: plan.source_commit,
      source_ci: plan.source_ci,
      recipe_sha256: plan.recipe_sha256,
      installer_ref: plan.installer_ref,
      talos_raw_image: plan.talos_raw_image,
      bucket,
      objects,
      public_readback_verified: false,
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "stage" && args.length === 5) await stageFleetImages(...args);
    else if (mode === "upload" && args.length === 5)
      await uploadFleetImages(
        JSON.parse(await readFile(args[0], "utf8")),
        ...args.slice(1),
      );
    else
      throw Error(
        "usage: publish-fleet-images.mjs stage <qualification> <archive> <raw> <directory> <api-origin> | upload <objects.json> <bucket> <endpoint> <region> <receipt>",
      );
  } catch {
    process.stderr.write(
      "fleet_image_publication_failed; no automatic write retry\n",
    );
    process.exitCode = 1;
  }
}
