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

/** Only official Debian snapshots map to an official live mirror; the exact locked bytes remain authoritative. */
export function officialDebianFallbackUrl(source: string): string | null {
  const match = /^https:\/\/snapshot\.debian\.org\/archive\/(debian-security|debian)\/[0-9]{8}T[0-9]{6}Z\/(pool\/[A-Za-z0-9_+./%~-]+\.deb)$/.exec(source);
  if (!match || match[2]!.split("/").some((part) => part === "." || part === "..") || /%(?:2f|5c|00|2e)/i.test(match[2]!)) return null;
  const mirror = match[1] === "debian-security" ? "https://security.debian.org/debian-security" : "https://deb.debian.org/debian";
  return mirror + "/" + match[2];
}

/** Debian's official Cloudflare frontend retains the exact snapshot timestamp and package path. */
export function officialDebianSnapshotFallbackUrl(source: string): string | null {
  return officialDebianFallbackUrl(source) === null ? null : source.replace("https://snapshot.debian.org/", "https://snapshot-cloudflare.debian.org/");
}

class DownloadUnavailable extends Error {}
function isTlsFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cause = error; cause !== null && typeof cause === "object" && !seen.has(cause); cause = Reflect.get(cause, "cause")) {
    seen.add(cause);
    const code: unknown = Reflect.get(cause, "code");
    if (typeof code === "string" && /CERT|TLS|SSL|ISSUER|SELF_SIGNED/i.test(code)) return true;
  }
  return false;
}

async function httpsResponse(source: string, signal: AbortSignal): Promise<Response> {
  let current = source;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (new URL(current).protocol !== "https:") throw new Error("redirected off HTTPS");
    let response: Response;
    try {
      response = await fetch(current, { signal, redirect: "manual" });
    } catch (error) {
      if (isTlsFailure(error)) throw new Error("package TLS verification failed", { cause: error });
      throw new DownloadUnavailable("package download unavailable", { cause: error });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("redirect has no location");
      current = new URL(location, current).href;
      continue;
    }
    if (new URL(response.url || current).protocol !== "https:") {
      await response.body?.cancel();
      throw new Error("redirected off HTTPS");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      const message = "HTTP " + response.status;
      if ([404, 408, 429].includes(response.status) || response.status >= 500) throw new DownloadUnavailable(message);
      throw new Error(message);
    }
    return response;
  }
  throw new Error("too many package redirects");
}

/** At most three package attempts, across official transports. Integrity, TLS and authorization
 * failures never select another source. Old versions may exist only on the snapshot frontends.
 */
export async function download(entry: LockedPackage, directory: string): Promise<void> {
  const target = join(directory, debFileName(entry));
  if (existsSync(target)) {
    const present = await stat(target);
    if (present.size === entry.size && (await sha256File(target)) === entry.sha256) return;
    await rm(target);
  }
  const partial = target + ".partial";
  const candidates = [entry.url, officialDebianSnapshotFallbackUrl(entry.url), officialDebianFallbackUrl(entry.url)].filter((url): url is string => url !== null);
  const failures: string[] = [];
  let candidate = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const url = candidates[candidate]!;
    try {
      const response = await httpsResponse(url, AbortSignal.timeout(300_000));
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial, { mode: 0o644 }));
      const size = (await stat(partial)).size;
      if (size !== entry.size) throw new Error("size " + size + " instead of " + entry.size);
      if ((await sha256File(partial)) !== entry.sha256) throw new Error("sha256 mismatch");
      await rename(partial, target);
      return;
    } catch (error) {
      await rm(partial, { force: true });
      failures.push(new URL(url).hostname + ": " + (error instanceof Error ? error.message : String(error)));
      if (!(error instanceof DownloadUnavailable)) break;
      candidate = Math.min(candidate + 1, candidates.length - 1);
      if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 5_000));
    }
  }
  throw new Error(entry.name + " " + entry.version + ": " + failures.join("; "));
}
