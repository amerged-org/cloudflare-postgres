// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { UsageIdentity } from "./metering-types.ts";
import {
  parseAcceptedArchiveBundle,
  validAcceptedArchive,
} from "./usage-accepted-ledger.ts";
import type { AcceptedArchive } from "./usage-accepted-ledger.ts";
import {
  inspectUsageSnapshot,
  verifyUsageSnapshot,
} from "./usage-journal-snapshot.ts";
import type { UsageSnapshotVerificationResult } from "./usage-journal-snapshot.ts";

export interface UsageArchiveFileDescriptor {
  kind: "journal" | "manifest" | "accepted";
  id: string;
  bytes: number;
  sha256: string;
}
export interface PreparedUsageArchiveFile extends UsageArchiveFileDescriptor {
  path: string;
}
export interface PrepareUsageArchiveFilesInput {
  snapshotDirectory: string;
  identity: UsageIdentity;
  expectedSha256: string;
  acceptedArchiveRoots: string[];
  destinationDirectory: string;
  signal?: AbortSignal;
}
export interface VerifyDownloadedUsageArchiveInput {
  directory: string;
  descriptor: { files: UsageArchiveFileDescriptor[] };
  identity: UsageIdentity;
  expectedSqliteSha256: string;
  expectedSessionId: string;
  signal?: AbortSignal;
}
export interface DownloadedUsageArchiveVerification extends UsageSnapshotVerificationResult {
  sessionId: string;
  acceptedArchives: number;
}
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bounds = {
  journal: 64 * 1024 * 1024,
  manifest: 16 * 1024,
  accepted: 8 * 1024 * 1024,
};
const maximumTotal = 256 * 1024 * 1024;
const failed = () => new Error("usage_archive_dependencies_failed");
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function canonical(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    isAbsolute(path) &&
    path === resolve(path) &&
    !Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function normalizedIdentity(value: UsageIdentity): UsageIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.regionId !== "string" ||
    !uuid.test(value.regionId) ||
    typeof value.sourceId !== "string" ||
    !uuid.test(value.sourceId) ||
    !Number.isSafeInteger(value.sourceEpoch) ||
    value.sourceEpoch < 1
  )
    throw failed();
  return {
    regionId: value.regionId,
    sourceId: value.sourceId,
    sourceEpoch: value.sourceEpoch,
  };
}
function privateStat(stat: Stats, directory: boolean): void {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (!directory && stat.nlink !== 1)
  )
    throw failed();
}
function unchanged(before: Stats, after: Stats): void {
  for (const field of [
    "dev",
    "ino",
    "mode",
    "uid",
    "nlink",
    "size",
    "mtimeMs",
    "ctimeMs",
  ] as const)
    if (before[field] !== after[field]) throw failed();
}
async function privateDirectory(path: string): Promise<void> {
  if (!canonical(path) || (await realpath(path)) !== path) throw failed();
  const before = await lstat(path);
  privateStat(before, true);
  if ((await realpath(path)) !== path) throw failed();
  unchanged(before, await lstat(path));
}
function under(path: string, root: string): boolean {
  const part = relative(root, path);
  return (
    part !== "" &&
    !part.startsWith(".." + sep) &&
    part !== ".." &&
    !isAbsolute(part)
  );
}
async function privatePath(path: string, roots: string[]): Promise<void> {
  if (!canonical(path)) throw failed();
  const root = roots.find((candidate) => under(path, candidate));
  if (!root) throw failed();
  await privateDirectory(root);
  const part = relative(root, dirname(path));
  let directory = root;
  for (const component of part ? part.split(sep) : []) {
    directory = join(directory, component);
    await privateDirectory(directory);
  }
  if ((await realpath(path)) !== path) throw failed();
}
async function readPrivate(
  path: string,
  roots: string[],
  maximum: number,
  check: () => void,
): Promise<Buffer> {
  check();
  await privatePath(path, roots);
  const before = await lstat(path);
  privateStat(before, false);
  if (before.size < 1 || before.size > maximum) throw failed();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    unchanged(before, await file.stat());
    const bytes = Buffer.alloc(before.size);
    let at = 0;
    while (at < bytes.length) {
      check();
      const result = await file.read(
        bytes,
        at,
        Math.min(65536, bytes.length - at),
        at,
      );
      if (!result.bytesRead) throw failed();
      at += result.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, at)).bytesRead) throw failed();
    unchanged(before, await file.stat());
    await privatePath(path, roots);
    const after = await lstat(path);
    privateStat(after, false);
    unchanged(before, after);
    check();
    return bytes;
  } finally {
    await file.close();
  }
}
async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
    privateStat(await file.stat(), false);
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
function filename(file: UsageArchiveFileDescriptor): string {
  if (file.kind === "journal") return "usage.sqlite";
  if (file.kind === "manifest") return "manifest.json";
  return "accepted-" + file.sha256 + ".json";
}
function operation(signal?: AbortSignal) {
  const deadline = performance.now() + 59000;
  const abort = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, abort.signal])
    : abort.signal;
  const timer = setTimeout(() => abort.abort(), 57500);
  return {
    signal: combined,
    check: () => {
      if (combined.aborted || performance.now() >= deadline) throw failed();
    },
    finish: () => clearTimeout(timer),
  };
}
function verifyArchive(
  bytes: Buffer,
  expected: AcceptedArchive,
  identity: UsageIdentity,
): AcceptedArchive | null {
  if (!validAcceptedArchive(expected) || digest(bytes) !== expected.sha256)
    throw failed();
  const bundle = parseAcceptedArchiveBundle(bytes, identity);
  if (
    bundle.manifest.archiveId !== expected.archiveId ||
    bundle.records.length !== expected.records ||
    bundle.manifest.throughSequence !== expected.throughSequence
  )
    throw failed();
  return bundle.previousArchive;
}

// Copies verified bytes only. Every accepted checkpoint predecessor remains part
// of the custody bundle; neither source retirement nor source rewriting occurs.
export async function prepareUsageArchiveFiles(
  input: PrepareUsageArchiveFilesInput,
): Promise<{ sessionId: string; files: PreparedUsageArchiveFile[] }> {
  const bounded = operation(input.signal);
  let created = false;
  try {
    const identity = normalizedIdentity(input.identity);
    if (
      !canonical(input.snapshotDirectory) ||
      !canonical(input.destinationDirectory) ||
      !hash.test(input.expectedSha256) ||
      !Array.isArray(input.acceptedArchiveRoots) ||
      input.acceptedArchiveRoots.length > 32 ||
      new Set(input.acceptedArchiveRoots).size !==
        input.acceptedArchiveRoots.length ||
      input.destinationDirectory === input.snapshotDirectory ||
      under(input.destinationDirectory, input.snapshotDirectory)
    )
      throw failed();
    await privateDirectory(input.snapshotDirectory);
    await privateDirectory(dirname(input.destinationDirectory));
    for (const root of input.acceptedArchiveRoots) {
      bounded.check();
      await privateDirectory(root);
    }
    const inspection = await inspectUsageSnapshot(
      {
        snapshotDirectory: input.snapshotDirectory,
        expectedIdentity: identity,
        expectedSha256: input.expectedSha256,
      },
      { signal: bounded.signal },
    );
    bounded.check();
    await mkdir(input.destinationDirectory, { mode: 0o700 });
    created = true;
    await privateDirectory(input.destinationDirectory);
    const files: PreparedUsageArchiveFile[] = [];
    let total = 0;
    const stage = async (
      kind: UsageArchiveFileDescriptor["kind"],
      bytes: Buffer,
    ) => {
      bounded.check();
      const sha256 = digest(bytes),
        id = kind === "accepted" ? sha256 : kind,
        descriptor = { kind, id, bytes: bytes.length, sha256 };
      total += bytes.length;
      if (total > maximumTotal) throw failed();
      const path = join(input.destinationDirectory, filename(descriptor));
      await writeExclusive(path, bytes);
      files.push({ ...descriptor, path });
    };
    const journal = await readPrivate(
      join(input.snapshotDirectory, "usage.sqlite"),
      [input.snapshotDirectory],
      bounds.journal,
      bounded.check,
    );
    if (digest(journal) !== input.expectedSha256) throw failed();
    await stage("journal", journal);
    await stage(
      "manifest",
      await readPrivate(
        join(input.snapshotDirectory, "manifest.json"),
        [input.snapshotDirectory],
        bounds.manifest,
        bounded.check,
      ),
    );
    const seen = new Set<string>(),
      archiveIds = new Set<string>();
    let reference = inspection.acceptedLastArchive;
    while (reference !== null) {
      bounded.check();
      if (
        seen.has(reference.sha256) ||
        archiveIds.has(reference.archiveId) ||
        seen.size >= 64
      )
        throw failed();
      seen.add(reference.sha256);
      archiveIds.add(reference.archiveId);
      const bytes = await readPrivate(
        reference.path,
        input.acceptedArchiveRoots,
        bounds.accepted,
        bounded.check,
      );
      const previous = verifyArchive(bytes, reference, identity);
      await stage("accepted", bytes);
      reference = previous;
    }
    const accepted = files
      .filter((file) => file.kind === "accepted")
      .sort((left, right) => left.id.localeCompare(right.id));
    const deterministic = [
      ...files.filter((file) => file.kind !== "accepted"),
      ...accepted,
    ];
    await syncDirectory(input.destinationDirectory);
    await syncDirectory(dirname(input.destinationDirectory));
    bounded.check();
    // Independent verification of the staged SQL/manifest binds the returned
    // session and predecessor head to exactly the bytes that will be uploaded.
    const staged = await inspectUsageSnapshot(
      {
        snapshotDirectory: input.destinationDirectory,
        expectedIdentity: identity,
        expectedSha256: input.expectedSha256,
      },
      { signal: bounded.signal },
    );
    if (
      staged.sessionId !== inspection.sessionId ||
      JSON.stringify(staged.acceptedLastArchive) !==
        JSON.stringify(inspection.acceptedLastArchive)
    )
      throw failed();
    bounded.check();
    return { sessionId: inspection.sessionId, files: deterministic };
  } catch {
    if (created)
      await rm(input.destinationDirectory, {
        recursive: true,
        force: true,
      }).catch(() => {
        /* Failed private staging is never activated. */
      });
    throw failed();
  } finally {
    bounded.finish();
  }
}

export async function verifyDownloadedUsageArchive(
  input: VerifyDownloadedUsageArchiveInput,
): Promise<DownloadedUsageArchiveVerification> {
  const bounded = operation(input.signal);
  try {
    const identity = normalizedIdentity(input.identity);
    if (
      !canonical(input.directory) ||
      !hash.test(input.expectedSqliteSha256) ||
      !uuid.test(input.expectedSessionId) ||
      !input.descriptor ||
      !Array.isArray(input.descriptor.files) ||
      input.descriptor.files.length < 2 ||
      input.descriptor.files.length > 66
    )
      throw failed();
    await privateDirectory(input.directory);
    const byId = new Map<string, UsageArchiveFileDescriptor>();
    let total = 0;
    for (const file of input.descriptor.files) {
      bounded.check();
      if (
        !file ||
        !["journal", "manifest", "accepted"].includes(file.kind) ||
        !hash.test(file.sha256) ||
        file.id !== (file.kind === "accepted" ? file.sha256 : file.kind) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > bounds[file.kind] ||
        byId.has(file.id)
      )
        throw failed();
      total += file.bytes;
      if (total > maximumTotal) throw failed();
      byId.set(file.id, file);
      const bytes = await readPrivate(
        join(input.directory, filename(file)),
        [input.directory],
        bounds[file.kind],
        bounded.check,
      );
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
        throw failed();
    }
    if (
      byId.get("journal")?.kind !== "journal" ||
      byId.get("journal")?.sha256 !== input.expectedSqliteSha256 ||
      byId.get("manifest")?.kind !== "manifest" ||
      [...byId.values()].filter((file) => file.kind === "accepted").length > 64
    )
      throw failed();
    const names = new Set(input.descriptor.files.map(filename));
    const contents = await readdir(input.directory);
    if (
      contents.length !== names.size ||
      contents.some((name) => !names.has(name))
    )
      throw failed();
    const receipt = await verifyUsageSnapshot(
      {
        snapshotDirectory: input.directory,
        expectedIdentity: identity,
        expectedSha256: input.expectedSqliteSha256,
      },
      { signal: bounded.signal },
    );
    const inspection = await inspectUsageSnapshot(
      {
        snapshotDirectory: input.directory,
        expectedIdentity: identity,
        expectedSha256: input.expectedSqliteSha256,
      },
      { signal: bounded.signal },
    );
    if (inspection.sessionId !== input.expectedSessionId) throw failed();
    const seen = new Set<string>(),
      archiveIds = new Set<string>();
    let reference = inspection.acceptedLastArchive;
    while (reference !== null) {
      bounded.check();
      if (
        seen.has(reference.sha256) ||
        archiveIds.has(reference.archiveId) ||
        seen.size >= 64
      )
        throw failed();
      const file = byId.get(reference.sha256);
      if (!file || file.kind !== "accepted") throw failed();
      seen.add(reference.sha256);
      archiveIds.add(reference.archiveId);
      const bytes = await readPrivate(
        join(input.directory, filename(file)),
        [input.directory],
        bounds.accepted,
        bounded.check,
      );
      if (bytes.length !== file.bytes) throw failed();
      reference = verifyArchive(bytes, reference, identity);
    }
    if (seen.size !== input.descriptor.files.length - 2) throw failed();
    const after = await readdir(input.directory);
    if (after.length !== names.size || after.some((name) => !names.has(name)))
      throw failed();
    bounded.check();
    return {
      ...receipt,
      sessionId: inspection.sessionId,
      acceptedArchives: seen.size,
      activationSupported: false,
    };
  } catch {
    throw new Error("usage_archive_download_verification_failed");
  } finally {
    bounded.finish();
  }
}
