// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createZstdDecompress } from "node:zlib";
import { validateImageIdentity } from "./image-qualification.ts";

interface QualifiedImage {
  imageId: string;
  configDigest: string;
  revision: string;
  source: string;
  diffIDs: string[];
  registryLayerDigests?: string[];
}
export interface TalosInstallerRegistryBinding {
  configDigest: string;
  diffIDs: string[];
  layerDigests: string[];
}
export interface RegistryVerificationReceipt {
  digest: string;
  manifestDigest: string;
  configDigest: string;
  layersVerified: number;
  compressedBytes: number;
  uncompressedBytes: number;
  getRequests: number;
  elapsedMs: number;
  limits: typeof REGISTRY_READBACK_LIMITS;
}
type ContentBinding = Pick<
  QualifiedImage,
  "imageId" | "configDigest" | "diffIDs" | "registryLayerDigests"
>;
function check(value: unknown): asserts value {
  if (!value) throw new Error("Registry manifest/config binding failed");
}
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const digest = (bytes: Buffer) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

const GiB = 1024 ** 3;
export const REGISTRY_READBACK_LIMITS = {
  layers: 128,
  metadata_bytes: 1_000_000,
  compressed_layer_bytes: 4 * GiB,
  compressed_total_bytes: 16 * GiB,
  uncompressed_layer_bytes: 8 * GiB,
  uncompressed_total_bytes: 32 * GiB,
  request_ms: 120_000,
  total_ms: 15 * 60_000,
} as const;
interface LayerDescriptor {
  digest: string;
  size: number;
  mediaType: string;
}
const layerEncodings = new Map([
  ["application/vnd.oci.image.layer.v1.tar", "raw"],
  ["application/vnd.oci.image.layer.v1.tar+gzip", "gzip"],
  ["application/vnd.oci.image.layer.v1.tar+zstd", "zstd"],
  ["application/vnd.docker.image.rootfs.diff.tar", "raw"],
  ["application/vnd.docker.image.rootfs.diff.tar.gzip", "gzip"],
]);
function validateLayers(value: unknown): asserts value is LayerDescriptor[] {
  check(
    Array.isArray(value) && value.length <= REGISTRY_READBACK_LIMITS.layers,
  );
  let total = 0;
  for (const layer of value) {
    check(
      layer &&
        digestPattern.test(layer.digest) &&
        Number.isSafeInteger(layer.size) &&
        layer.size >= 0 &&
        layer.size <= REGISTRY_READBACK_LIMITS.compressed_layer_bytes &&
        layerEncodings.has(layer.mediaType),
    );
    total += layer.size;
    check(total <= REGISTRY_READBACK_LIMITS.compressed_total_bytes);
  }
}

/** Independent downloads may take different time/routes; their content must match. */
export function assertEquivalentRegistryReadbacks(
  first: unknown,
  second: unknown,
): void {
  check(
    first &&
      second &&
      typeof first === "object" &&
      typeof second === "object" &&
      !Array.isArray(first) &&
      !Array.isArray(second),
  );
  const a = first as Record<string, unknown>,
    b = second as Record<string, unknown>;
  for (const field of ["digest", "manifestDigest", "configDigest"]) {
    check(
      typeof a[field] === "string" &&
        digestPattern.test(a[field]) &&
        a[field] === b[field],
    );
  }
  for (const [field, maximum] of [
    ["layersVerified", REGISTRY_READBACK_LIMITS.layers],
    ["compressedBytes", REGISTRY_READBACK_LIMITS.compressed_total_bytes],
    ["uncompressedBytes", REGISTRY_READBACK_LIMITS.uncompressed_total_bytes],
  ] as const) {
    check(
      typeof a[field] === "number" &&
        Number.isSafeInteger(a[field]) &&
        a[field] >= 0 &&
        a[field] <= maximum &&
        a[field] === b[field],
    );
  }
}

export function promotionArguments(
  repository: string,
  verified: { digest: string; manifestDigest: string; configDigest: string },
  qualification: QualifiedImage,
): string[] {
  check(
    /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(repository) &&
      digestPattern.test(verified.digest) &&
      digestPattern.test(verified.manifestDigest),
  );
  check(
    verified.configDigest === qualification.configDigest &&
      (qualification.imageId === qualification.configDigest ||
        verified.manifestDigest === qualification.imageId),
  );
  return [
    "buildx",
    "imagetools",
    "create",
    "--prefer-index=false",
    "--tag",
    `${repository}:latest`,
    `${repository}@${verified.digest}`,
  ];
}

export function validateRegistryBinding(
  manifestBytes: Buffer,
  manifestDigest: string,
  configBytes: Buffer,
  image: QualifiedImage,
): void {
  validateContentBinding(manifestBytes, manifestDigest, configBytes, image);
  validateImageIdentity(
    configBytes,
    image.configDigest,
    image.revision,
    image.source,
  );
}

function validateContentBinding(
  manifestBytes: Buffer,
  manifestDigest: string,
  configBytes: Buffer,
  image: ContentBinding,
): void {
  check(
    digestPattern.test(manifestDigest) &&
      digest(manifestBytes) === manifestDigest,
  );
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion: number;
    config: { digest: string };
    layers: { digest: string }[];
  };
  check(
    manifest.schemaVersion === 2 &&
      manifest.config?.digest === image.configDigest &&
      digest(configBytes) === image.configDigest,
  );
  check(
    image.imageId === image.configDigest || image.imageId === manifestDigest,
  );
  const config = JSON.parse(configBytes.toString()) as {
    rootfs?: { type?: string; diff_ids?: unknown };
  };
  check(
    config.rootfs?.type === "layers" &&
      Array.isArray(config.rootfs.diff_ids) &&
      JSON.stringify(config.rootfs.diff_ids) === JSON.stringify(image.diffIDs),
  );
  check(
    Array.isArray(manifest.layers) &&
      manifest.layers.length === image.diffIDs.length &&
      manifest.layers.every((layer) => digestPattern.test(layer.digest)),
  );
  if (image.registryLayerDigests)
    check(
      JSON.stringify(manifest.layers.map((layer) => layer.digest)) ===
        JSON.stringify(image.registryLayerDigests),
    );
}

function validateTalosInstallerIdentity(
  bytes: Buffer,
  talosVersion: string,
): void {
  const config = JSON.parse(bytes.toString()) as {
    os?: string;
    architecture?: string;
    config?: {
      Entrypoint?: unknown;
      Env?: unknown;
      Labels?: Record<string, string>;
    };
  };
  const settings = config.config;
  check(
    config.os === "linux" &&
      config.architecture === "amd64" &&
      settings &&
      JSON.stringify(settings.Entrypoint) ===
        JSON.stringify(["/bin/installer"]) &&
      Array.isArray(settings.Env) &&
      settings.Env.filter(
        (value) => typeof value === "string" && value.startsWith("VERSION="),
      ).join() === `VERSION=v${talosVersion}` &&
      settings.Labels?.["alpha.talos.dev/version"] === `v${talosVersion}` &&
      settings.Labels?.["org.opencontainers.image.source"] ===
        "https://github.com/siderolabs/talos",
  );
}

async function responseBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Buffer> {
  check(response.ok && response.body);
  const chunks: Buffer[] = [];
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > REGISTRY_READBACK_LIMITS.metadata_bytes)
          callback(new Error("Registry metadata exceeds byte limit"));
        else {
          chunks.push(Buffer.from(chunk));
          callback();
        }
      },
    }),
    { signal },
  );
  return Buffer.concat(chunks);
}

async function verifyLayer(
  response: Response,
  layer: LayerDescriptor,
  diffID: string,
  totals: { compressedBytes: number; uncompressedBytes: number },
  signal: AbortSignal,
): Promise<void> {
  if (!(response.ok && response.body && digestPattern.test(diffID))) {
    await response.body?.cancel();
    check(false);
  }
  const encoding = response.headers.get("content-encoding");
  const contentDigest = response.headers.get("docker-content-digest");
  const length = response.headers.get("content-length");
  if (!(
    (!encoding || encoding === "identity") &&
    (!contentDigest || contentDigest === layer.digest) &&
    (length === null ||
      (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) === layer.size))
  )) {
    await response.body.cancel();
    throw new Error("Registry layer response binding failed");
  }
  const compressedHash = createHash("sha256"),
    rawHash = createHash("sha256");
  let compressedBytes = 0,
    uncompressedBytes = 0;
  const compressed = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      totals.compressedBytes += chunk.length;
      if (
        compressedBytes > layer.size ||
        compressedBytes > REGISTRY_READBACK_LIMITS.compressed_layer_bytes ||
        totals.compressedBytes > REGISTRY_READBACK_LIMITS.compressed_total_bytes
      )
        return callback(
          new Error("Registry layer exceeds compressed byte limit"),
        );
      compressedHash.update(chunk);
      callback(null, chunk);
    },
  });
  const raw = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      uncompressedBytes += chunk.length;
      totals.uncompressedBytes += chunk.length;
      if (
        uncompressedBytes > REGISTRY_READBACK_LIMITS.uncompressed_layer_bytes ||
        totals.uncompressedBytes >
          REGISTRY_READBACK_LIMITS.uncompressed_total_bytes
      )
        return callback(
          new Error("Registry layer exceeds uncompressed byte limit"),
        );
      rawHash.update(chunk);
      callback();
    },
  });
  const source = Readable.fromWeb(response.body);
  const mode = layerEncodings.get(layer.mediaType);
  if (mode === "gzip")
    await pipeline(source, compressed, createGunzip(), raw, { signal });
  else if (mode === "zstd")
    await pipeline(source, compressed, createZstdDecompress(), raw, { signal });
  else {
    check(mode === "raw");
    await pipeline(source, compressed, raw, { signal });
  }
  check(
    compressedBytes === layer.size &&
      "sha256:" + compressedHash.digest("hex") === layer.digest,
  );
  check("sha256:" + rawHash.digest("hex") === diffID);
}

export async function verifyRegistry(
  image: string,
  qualification: QualifiedImage,
  reportPath: string,
): Promise<void> {
  await verifyRegistryContent(
    image,
    { kind: "pgcf", image: qualification },
    reportPath,
  );
}

/** Bind registry bytes to the exact separately inspected imager archive. */
export async function verifyTalosInstallerRegistry(
  image: string,
  inspected: TalosInstallerRegistryBinding,
  expectedTalosVersion: string,
  reportPath: string,
): Promise<RegistryVerificationReceipt> {
  check(
    /^\d+\.\d+\.\d+$/.test(expectedTalosVersion) &&
      digestPattern.test(inspected.configDigest) &&
      Array.isArray(inspected.diffIDs) &&
      inspected.diffIDs.length > 0 &&
      inspected.diffIDs.length <= 32 &&
      inspected.diffIDs.every((value) => digestPattern.test(value)) &&
      Array.isArray(inspected.layerDigests) &&
      inspected.layerDigests.length === inspected.diffIDs.length &&
      inspected.layerDigests.every((value) => digestPattern.test(value)),
  );
  return verifyRegistryContent(
    image,
    {
      kind: "talos-installer",
      image: inspected,
      talosVersion: expectedTalosVersion,
    },
    reportPath,
  );
}

async function verifyRegistryContent(
  image: string,
  qualification:
    | { kind: "pgcf"; image: QualifiedImage }
    | {
        kind: "talos-installer";
        image: TalosInstallerRegistryBinding;
        talosVersion: string;
      },
  reportPath: string,
): Promise<RegistryVerificationReceipt> {
  const binding: ContentBinding =
    qualification.kind === "pgcf"
      ? qualification.image
      : {
          imageId: qualification.image.configDigest,
          configDigest: qualification.image.configDigest,
          diffIDs: qualification.image.diffIDs,
          registryLayerDigests: qualification.image.layerDigests,
        };
  const started = performance.now();
  let getRequests = 0;
  const reference = image.match(
    /^ghcr\.io\/([a-z0-9._-]+\/[a-z0-9._-]+):([A-Za-z0-9_.-]+)$/,
  );
  check(reference);
  const deadline = AbortSignal.timeout(REGISTRY_READBACK_LIMITS.total_ms);
  const requestSignal = () =>
    AbortSignal.any([
      deadline,
      AbortSignal.timeout(REGISTRY_READBACK_LIMITS.request_ms),
    ]);
  const repository = reference[1]!;
  const actor = process.env.GITHUB_ACTOR;
  const credential = process.env.GH_TOKEN;
  check(actor && credential);
  const tokenSignal = requestSignal();
  getRequests++;
  const tokenResponse = await fetch(
    "https://ghcr.io/token?" +
      new URLSearchParams({
        service: "ghcr.io",
        scope: `repository:${repository}:pull`,
      }),
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${actor}:${credential}`).toString("base64"),
      },
      signal: tokenSignal,
    },
  );
  const tokenData = JSON.parse(
    (await responseBytes(tokenResponse, tokenSignal)).toString(),
  ) as { token?: string; access_token?: string };
  const token = tokenData.token ?? tokenData.access_token;
  check(token && token.length < 100_000);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
  };
  async function get(path: string, expectedDigest?: string) {
    const signal = requestSignal();
    getRequests++;
    const response = await fetch(`https://ghcr.io/v2/${repository}/${path}`, {
      headers,
      signal,
    });
    const bytes = await responseBytes(response, signal);
    const contentDigest =
      response.headers.get("docker-content-digest") ?? expectedDigest;
    check(contentDigest && digest(bytes) === contentDigest);
    if (expectedDigest) check(contentDigest === expectedDigest);
    return { bytes, contentDigest };
  }
  const root = await get(`manifests/${reference[2]}`);
  let selected = root;
  const index = JSON.parse(root.bytes.toString()) as {
    manifests?: {
      digest: string;
      platform: { os: string; architecture: string };
    }[];
  };
  if (index.manifests) {
    check(
      index.manifests.length === 1 &&
        index.manifests[0]?.platform?.os === "linux" &&
        index.manifests[0].platform.architecture === "amd64" &&
        digestPattern.test(index.manifests[0].digest),
    );
    selected = await get(`manifests/${index.manifests[0].digest}`);
    check(selected.contentDigest === index.manifests[0].digest);
  }
  const manifest = JSON.parse(selected.bytes.toString()) as {
    config: { digest: string };
    layers: unknown;
  };
  check(digestPattern.test(manifest.config?.digest));
  const config = await get(
    `blobs/${manifest.config.digest}`,
    manifest.config.digest,
  );
  check(config.contentDigest === manifest.config.digest);
  if (qualification.kind === "pgcf")
    validateRegistryBinding(
      selected.bytes,
      selected.contentDigest,
      config.bytes,
      qualification.image,
    );
  else {
    validateContentBinding(
      selected.bytes,
      selected.contentDigest,
      config.bytes,
      binding,
    );
    validateTalosInstallerIdentity(config.bytes, qualification.talosVersion);
  }
  validateLayers(manifest.layers);
  const totals = { compressedBytes: 0, uncompressedBytes: 0 };
  for (const [index, layer] of manifest.layers.entries()) {
    const signal = requestSignal();
    getRequests++;
    const response = await fetch(
      `https://ghcr.io/v2/${repository}/blobs/${layer.digest}`,
      {
        headers,
        signal,
      },
    );
    await verifyLayer(response, layer, binding.diffIDs[index]!, totals, signal);
  }
  deadline.throwIfAborted();
  const receipt: RegistryVerificationReceipt = {
    digest: root.contentDigest,
    manifestDigest: selected.contentDigest,
    configDigest: config.contentDigest,
    layersVerified: manifest.layers.length,
    compressedBytes: totals.compressedBytes,
    uncompressedBytes: totals.uncompressedBytes,
    getRequests,
    elapsedMs: Math.ceil(performance.now() - started),
    limits: REGISTRY_READBACK_LIMITS,
  };
  await writeFile(reportPath, JSON.stringify(receipt) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return receipt;
}
