// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { debFileName, type LockedPackage, type PackageLock } from "./lock.ts";

const BUILDER_FILES = ["Dockerfile", "build.sh", "normalize-modes.sh", "cache-packages.sh"] as const;
export const BOOTSTRAP_CA_FILE = "bootstrap-ca-certificates.deb";

/** Resolving an old lock may replace other packages, but trust never comes from an unpinned source. */
export function lockedCaCertificates(lock: PackageLock): LockedPackage {
  const candidates = lock.packages.filter((entry) => entry.name === "ca-certificates");
  const ca = candidates[0];
  if (candidates.length !== 1 || !ca || ca.architecture !== "all" ||
      !/^[A-Za-z0-9.+~:-]+$/.test(ca.version) || !ca.url.startsWith("https://") ||
      !/^[a-f0-9]{64}$/.test(ca.sha256) || !Number.isSafeInteger(ca.size) || ca.size <= 0) {
    throw new Error("builder requires one valid locked ca-certificates package");
  }
  return ca;
}

export function builderTag(lock: PackageLock): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ builder: lock.builder, snapshot: lock.debian.snapshot, ca: lockedCaCertificates(lock) }));
  return `pgcf-node-image-builder:${hash.digest("hex").slice(0, 16)}`;
}

/** A bounded, private context: only the tracked builder inputs and the verified trust package. */
export async function withBuilderContext<T>(
  lock: PackageLock,
  source: string,
  parent: string,
  download: (entry: LockedPackage, directory: string) => Promise<void>,
  build: (context: string, ca: LockedPackage) => T | Promise<T>,
): Promise<T> {
  const ca = lockedCaCertificates(lock);
  await mkdir(parent, { recursive: true });
  const context = await mkdtemp(join(parent, "builder-context-"));
  try {
    await chmod(context, 0o700);
    for (const name of BUILDER_FILES) {
      if (!(await lstat(join(source, name))).isFile()) throw new Error(`builder input ${name} is not a regular file`);
      await copyFile(join(source, name), join(context, name));
      await chmod(join(context, name), 0o600);
    }
    await download(ca, context);
    const downloaded = join(context, debFileName(ca)), details = await lstat(downloaded);
    if (!details.isFile() || details.size !== ca.size) throw new Error("builder CA package size mismatch");
    if (createHash("sha256").update(await readFile(downloaded)).digest("hex") !== ca.sha256) throw new Error("builder CA package sha256 mismatch");
    const payload = join(context, BOOTSTRAP_CA_FILE);
    await rename(downloaded, payload);
    await chmod(payload, 0o600);
    return await build(context, ca);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
