// SPDX-License-Identifier: Apache-2.0
import { bytesToHex } from "@pgcf/contracts";
import type { ApiContext } from "../env.ts";

export const FLEET_IMAGE_PREFIX = "fleet-images/v1/sha256/";
const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
type Kind = "manifest" | "blob" | "raw";
interface Descriptor {
  digest: string;
  size: number;
  mediaType: string;
}
function missing(): Response {
  return new Response(null, { status: 404 });
}
function metadata(object: R2Object, hash: string, kind: Kind): boolean {
  return (
    object.customMetadata?.artifact_kind === kind &&
    object.customMetadata.sha256 === hash &&
    object.customMetadata.bytes === String(object.size) &&
    Number.isSafeInteger(object.size) &&
    object.size > 0
  );
}
function headers(hash: string, contentType: string, size: number): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Docker-Content-Digest": `sha256:${hash}`,
    "Docker-Distribution-Api-Version": "registry/2.0",
    ETag: `"sha256:${hash}"`,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
}
function descriptor(value: unknown): Descriptor | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Descriptor;
  return /^sha256:[a-f0-9]{64}$/.test(entry.digest) &&
    Number.isSafeInteger(entry.size) &&
    entry.size > 0 &&
    typeof entry.mediaType === "string" &&
    /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(entry.mediaType)
    ? entry
    : null;
}
function byteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]),
    last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!match[1]) {
    if (last <= 0) return null;
    const offset = Math.max(0, size - last);
    return { offset, length: size - offset };
  }
  const end = match[2] ? Math.min(size - 1, last) : size - 1;
  return first < size && end >= first
    ? { offset: first, length: end - first + 1 }
    : null;
}
async function approvedInstaller(
  c: ApiContext,
  hash: string,
): Promise<boolean> {
  const reference = `${new URL(c.req.url).host}/pgcf-talos-installer@sha256:${hash}`;
  return Boolean(
    await c.env.DB.prepare(
      `SELECT 1 approved FROM fleet_releases r,json_each(r.spec_json,'$.roles') role
       WHERE r.approved_at IS NOT NULL AND json_extract(role.value,'$.talos_installer')=? LIMIT 1`,
    )
      .bind(reference)
      .first(),
  );
}
async function manifest(c: ApiContext, hash: string) {
  if (!HASH.test(hash) || !(await approvedInstaller(c, hash))) return null;
  const object = await c.env.ARCHIVE.get(FLEET_IMAGE_PREFIX + hash);
  if (
    !object ||
    !metadata(object, hash, "manifest") ||
    object.size > 512 * 1024 ||
    !MANIFEST_TYPES.has(object.httpMetadata?.contentType ?? "")
  ) {
    await object?.body.cancel();
    return null;
  }
  const bytes = await object.arrayBuffer();
  if (
    bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !==
    hash
  )
    return null;
  let document: {
    schemaVersion?: unknown;
    mediaType?: unknown;
    config?: unknown;
    layers?: unknown;
  };
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return null;
  }
  if (!document || typeof document !== "object" || Array.isArray(document))
    return null;
  const config = descriptor(document.config);
  if (
    document.schemaVersion !== 2 ||
    document.mediaType !== object.httpMetadata?.contentType ||
    !config ||
    !Array.isArray(document.layers) ||
    document.layers.length < 1 ||
    document.layers.length > 64
  )
    return null;
  const layers = document.layers.map(descriptor);
  if (layers.some((value) => value === null)) return null;
  return { bytes, object, descriptors: [config, ...(layers as Descriptor[])] };
}
async function approvedBlob(
  c: ApiContext,
  digest: string,
  object: R2Object,
): Promise<Descriptor | undefined> {
  const parent = object.customMetadata?.manifest_sha256;
  if (!parent || !HASH.test(parent)) return undefined;
  const matching = async (hash: string) =>
    (await manifest(c, hash))?.descriptors.find(
      (entry) =>
        entry.digest === digest &&
        entry.size === object.size &&
        entry.mediaType === object.httpMetadata?.contentType,
    );
  const owner = await matching(parent);
  if (owner) return owner;
  const prefix = `${new URL(c.req.url).host}/pgcf-talos-installer@sha256:`;
  // Current phase: inspect at most 32 newest distinct approved manifests; old owners retain the fast path.
  const candidates = await c.env.DB.prepare(
    `SELECT json_extract(role.value,'$.talos_installer') reference FROM fleet_releases r,json_each(r.spec_json,'$.roles') role
     WHERE r.approved_at IS NOT NULL AND substr(json_extract(role.value,'$.talos_installer'),1,?)=?
     GROUP BY reference ORDER BY max(r.approved_at) DESC,reference LIMIT 32`,
  )
    .bind(prefix.length, prefix)
    .all<{ reference: string }>();
  for (const { reference } of candidates.results) {
    const hash = reference.slice(prefix.length);
    if (hash === parent || !HASH.test(hash)) continue;
    const entry = await matching(hash);
    if (entry) return entry;
  }
  return undefined;
}

/** Public image bytes only: fixed bucket/prefix, immutable digests and approved release references. */
export async function serveFleetImage(
  c: ApiContext,
  kind: Kind,
  digest: string,
): Promise<Response> {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return missing();
  const hash = digest.slice(7);
  if (kind === "manifest") {
    const value = await manifest(c, hash);
    return value
      ? new Response(c.req.method === "HEAD" ? null : value.bytes, {
          headers: headers(
            hash,
            value.object.httpMetadata!.contentType!,
            value.object.size,
          ),
        })
      : missing();
  }
  const key = FLEET_IMAGE_PREFIX + hash;
  const object = await c.env.ARCHIVE.head(key);
  if (!object || !metadata(object, hash, kind)) return missing();
  let contentType: string;
  if (kind === "blob") {
    const entry = await approvedBlob(c, digest, object);
    if (!entry) return missing();
    contentType = entry.mediaType;
  } else {
    const approved = await c.env.DB.prepare(
      `SELECT json_extract(spec_json,'$.talos_raw_image.format') format FROM fleet_releases
       WHERE approved_at IS NOT NULL AND json_extract(spec_json,'$.talos_raw_image.url')=?
       AND json_extract(spec_json,'$.talos_raw_image.sha256')=?
       AND json_extract(spec_json,'$.talos_raw_image.bytes')=? LIMIT 1`,
    )
      .bind(
        new URL(c.req.url).origin + `/fleet-images/v1/raw/${digest}`,
        hash,
        object.size,
      )
      .first<{ format: string }>();
    if (!approved || !["raw.xz", "raw"].includes(approved.format))
      return missing();
    contentType =
      approved.format === "raw.xz"
        ? "application/x-xz"
        : "application/octet-stream";
    if (object.httpMetadata?.contentType !== contentType) return missing();
  }
  const responseHeaders = headers(hash, contentType, object.size);
  responseHeaders.set("Accept-Ranges", "bytes");
  if (c.req.method === "HEAD")
    return new Response(null, { headers: responseHeaders });
  const requested = c.req.header("Range"),
    range =
      requested === undefined ? undefined : byteRange(requested, object.size);
  if (range === null)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${object.size}` },
    });
  const value = await c.env.ARCHIVE.get(key, range ? { range } : undefined);
  if (!value) return missing();
  if (!metadata(value, hash, kind) || value.etag !== object.etag) {
    await value.body.cancel();
    return missing();
  }
  if (range) {
    responseHeaders.set("Content-Length", String(range.length));
    responseHeaders.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
  }
  return new Response(value.body, {
    status: range ? 206 : 200,
    headers: responseHeaders,
  });
}
