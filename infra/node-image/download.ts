// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LockedPackage } from "./lock.ts";

/** Only the two official Debian snapshot archives have a corresponding official live mirror. */
export function officialDebianFallbackUrl(source: string): string | null {
  const match = /^https:\/\/snapshot\.debian\.org\/archive\/(debian-security|debian)\/[0-9]{8}T[0-9]{6}Z\/(pool\/[A-Za-z0-9_+./%~-]+\.deb)$/.exec(source);
  if (!match || match[2]!.split("/").some((part) => part === "." || part === "..") || /%(?:2f|5c|00|2e)/i.test(match[2]!)) return null;
  const mirror = match[1] === "debian-security" ? "https://security.debian.org/debian-security" : "https://deb.debian.org/debian";
  return `${mirror}/${match[2]}`;
}

/** Debian's official Cloudflare frontend keeps the exact snapshot timestamp and package path. */
export function officialDebianSnapshotFallbackUrl(source: string): string | null {
  return officialDebianFallbackUrl(source) === null ? null : source.replace("https://snapshot.debian.org/", "https://snapshot-cloudflare.debian.org/");
}

class DownloadUnavailable extends Error {}
async function httpsResponse(source: string, signal: AbortSignal): Promise<Response> {
  let current = source;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (new URL(current).protocol !== "https:") throw new Error("redirected off HTTPS");
    let response: Response;
    try { response = await fetch(current, { signal, redirect: "manual" }); }
    catch { throw new DownloadUnavailable("package download unavailable"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new DownloadUnavailable("redirect has no location");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new DownloadUnavailable(`HTTP ${response.status}`);
    }
    if (new URL(response.url || current).protocol !== "https:") throw new Error("redirected off HTTPS");
    return response;
  }
  throw new DownloadUnavailable("too many package redirects");
}

/** Try official snapshot frontends before the live mirror, which may have pruned old versions.
 * Only availability failures advance to another source; locked bytes and HTTPS remain mandatory.
 */
export async function fetchLockedPackage(entry: LockedPackage, target: string): Promise<void> {
  const partial = `${target}.partial`;
  const signal = AbortSignal.timeout(300_000);
  try {
    let response: Response | undefined;
    const unavailable: string[] = [];
    const candidates = [entry.url, officialDebianSnapshotFallbackUrl(entry.url), officialDebianFallbackUrl(entry.url)].filter((url): url is string => url !== null);
    for (const url of candidates) {
      try { response = await httpsResponse(url, signal); break; }
      catch (error) {
        if (!(error instanceof DownloadUnavailable)) throw error;
        unavailable.push(`${new URL(url).hostname}: ${error.message}`);
      }
    }
    if (!response) throw new DownloadUnavailable(unavailable.join("; "));
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial, { mode: 0o644 }));
    const size = (await stat(partial)).size;
    if (size !== entry.size) throw new Error(`size ${size} instead of ${entry.size}`);
    const hash = createHash("sha256");
    await pipeline(createReadStream(partial), hash);
    if (hash.digest("hex") !== entry.sha256) throw new Error("sha256 mismatch");
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
