// SPDX-License-Identifier: Apache-2.0
import {
  FleetReleaseVersion,
  RELEASE_IMAGE_FILE,
  ReleaseFileName,
  releaseObjectKey,
  type ReleaseFile,
} from "@pgcf/contracts/releases";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { openInstall } from "./node-install.ts";

/** Where in a file a range starts and how long it is. */
export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * The bytes a `Range` header asks of a file of `size` bytes (RFC 9110 14.2). Only one range of
 * the `bytes` unit is served: a header that is not that, or is not well formed, is ignored (`null`)
 * and the whole file is sent. A range that starts at or after the end of the file, or asks for the
 * last zero bytes, cannot be satisfied.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null) return null;
  const [first, last] = [match[1]!, match[2]!];
  if (first === "" && last === "") return null;
  const numbers = [first, last].map((digits) =>
    digits === "" ? undefined : Number(digits),
  );
  if (!numbers.every((n) => n === undefined || Number.isSafeInteger(n)))
    return null;
  const [start, end] = numbers;
  if (start === undefined) {
    // The last `end` bytes.
    return end === 0 || size === 0
      ? "unsatisfiable"
      : { offset: Math.max(size - end!, 0), length: Math.min(end!, size) };
  }
  if (end !== undefined && end < start) return null;
  if (start >= size) return "unsatisfiable";
  return {
    offset: start,
    length: Math.min(end ?? size - 1, size - 1) - start + 1,
  };
}

const notFound = () => new ApiError("not_found", "Release file not found");

/**
 * Streams one file of a registered release from the archive bucket (ULTRA plan 9.1, 9.2). It
 * answers HEAD with the size and a `Range` with 206, because the installer in the rescue system
 * and the agent pull from a URL. The bucket's key never leaves the Worker: no presigned URL and
 * no credential reaches a node.
 */
async function deliver(
  c: ApiContext,
  version: string,
  file: ReleaseFile,
): Promise<Response> {
  const key = releaseObjectKey(version, file);
  const stored = await c.env.ARCHIVE.head(key);
  if (stored === null) throw notFound();
  const range = parseByteRange(c.req.header("Range") ?? null, stored.size);
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    ETag: stored.httpEtag,
  };
  if (range === "unsatisfiable")
    return c.body(null, 416, {
      ...headers,
      "Content-Range": `bytes */${stored.size}`,
    });
  headers["Content-Length"] = String(range?.length ?? stored.size);
  if (range)
    headers["Content-Range"] =
      `bytes ${range.offset}-${range.offset + range.length - 1}/${stored.size}`;
  const status = range ? 206 : 200;
  if (c.req.method === "HEAD") return c.body(null, status, headers);
  const object = await c.env.ARCHIVE.get(key, range ? { range } : undefined);
  if (object === null) throw notFound();
  return c.body(object.body, status, headers);
}

/** A file of a release that is registered, by the names the release has. */
async function registeredFile(
  c: ApiContext,
  version: string,
  name: string,
): Promise<ReleaseFile> {
  const file = ReleaseFileName.safeParse(name),
    id = FleetReleaseVersion.safeParse(version);
  if (!file.success || !id.success) throw notFound();
  const registered = await c.env.DB.prepare(
    "SELECT 1 FROM fleet_releases WHERE id=?",
  )
    .bind(id.data)
    .first();
  if (registered === null) throw notFound();
  return file.data;
}

/**
 * A binary or the package lock. An agent reads these without a credential: they are open
 * artifacts, and the desired page, which it reads signed, pins each by size and sha256.
 */
export async function serveReleaseFile(
  c: ApiContext,
  version: string,
  name: string,
): Promise<Response> {
  const file = await registeredFile(c, version, name);
  if (file === RELEASE_IMAGE_FILE) throw notFound();
  return deliver(c, version, file);
}

/**
 * The image goes to the installer of one node: the token of its install, which is bound to that
 * node and to the version it was issued for and closes with the install, is the credential.
 */
export async function serveInstallerImage(
  c: ApiContext,
  version: string,
): Promise<Response> {
  const install = await openInstall(c);
  await registeredFile(c, version, RELEASE_IMAGE_FILE);
  if (install.image_version !== version)
    throw new ApiError("unauthorized", "Invalid installer credentials");
  return deliver(c, version, RELEASE_IMAGE_FILE);
}
