// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { debFileName, type LockedPackage } from "./lock.ts";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

// The lock still pins the snapshot's exact bytes when its path resolver is unavailable.
// Debian's live archive may no longer hold an old file; that refusal returns to Snapshot.
function archiveMirror(url: string): string | undefined {
  let source: URL;
  try {
    source = new URL(url);
  } catch {
    return undefined;
  }
  if (source.origin !== "https://snapshot.debian.org" || source.username || source.password || source.search || source.hash) return undefined;
  const path = source.pathname.match(/^\/archive\/(debian|debian-security)\/\d{8}T\d{6}Z\/(pool\/.+\.deb)$/);
  return path === null ? undefined : `https://deb.debian.org/${path[1]}/${path[2]}`;
}

// Download one locked file and keep it only if its size and sha256 match.
export async function download(entry: LockedPackage, directory: string): Promise<void> {
  const target = join(directory, debFileName(entry));
  if (existsSync(target)) {
    const present = await stat(target);
    if (present.size === entry.size && (await sha256File(target)) === entry.sha256) return;
    await rm(target);
  }
  const partial = `${target}.partial`;
  const mirror = archiveMirror(entry.url);
  let url = entry.url;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let transportFailure = false;
    try {
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      } catch (error) {
        transportFailure = true;
        throw error;
      }
      if (!response.ok || !response.body) {
        transportFailure = response.status >= 500;
        throw new Error(`HTTP ${response.status}`);
      }
      if (!new URL(response.url).protocol.startsWith("https")) throw new Error("redirected off HTTPS");
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial, { mode: 0o644 }));
      const size = (await stat(partial)).size;
      if (size !== entry.size) throw new Error(`size ${size} instead of ${entry.size}`);
      if ((await sha256File(partial)) !== entry.sha256) throw new Error("sha256 mismatch");
      await rename(partial, target);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      url = transportFailure && mirror !== undefined && url === entry.url ? mirror : entry.url;
      if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 5_000));
    }
  }
  throw new Error(`${entry.name} ${entry.version}: ${String(lastError)}`);
}
