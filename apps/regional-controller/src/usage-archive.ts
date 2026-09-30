// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { UsageIdentity } from "./metering-types.ts";
import {
  snapshotUsageJournal,
  verifyUsageSnapshot,
  inspectUsageSnapshot,
} from "./usage-journal-snapshot.ts";
import {
  prepareUsageArchiveFiles,
  verifyDownloadedUsageArchive,
} from "./usage-archive-dependencies.ts";
import type {
  ArchiveDescriptor,
  ArchiveFile,
  ArchiveReceipt,
  ArchiveRecoveryTransport,
  ArchiveTransport,
} from "./usage-archive-types.ts";

const CHUNK = 1048576,
  TOTAL = 256 * CHUNK;
const digestPattern = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => new Error("usage_archive_failed");
const cycles = new Set<string>();
export function archiveCanonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(archiveCanonical);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, archiveCanonical(x)]),
    );
  return v;
}
const json = (v: unknown) => JSON.stringify(archiveCanonical(v));
const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
function identity(v: UsageIdentity): UsageIdentity {
  if (
    !v ||
    !uuid.test(v.regionId) ||
    !uuid.test(v.sourceId) ||
    !Number.isSafeInteger(v.sourceEpoch) ||
    v.sourceEpoch < 1
  )
    throw fail();
  return {
    regionId: v.regionId,
    sourceId: v.sourceId,
    sourceEpoch: v.sourceEpoch,
  };
}
export function archiveIds(d: ArchiveDescriptor) {
  const raw = json(d);
  return {
    descriptorId: sha(
      "cloudflare-postgres/usage-archive/descriptor/v1\u0000" + raw,
    ),
    descriptorSha256: sha(raw),
  };
}
function filename(f: ArchiveFile) {
  return f.kind === "journal"
    ? "usage.sqlite"
    : f.kind === "manifest"
      ? "manifest.json"
      : "accepted-" + f.sha256 + ".json";
}
async function privateDir(path: string) {
  const s = await lstat(path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (s.mode & 0o777) !== 0o700 ||
    (process.getuid && s.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    throw fail();
}
async function privateFile(path: string) {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    (s.mode & 0o777) !== 0o600 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw fail();
  return s;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw fail();
  }
}
async function child(parent: string, part: string) {
  const path = join(parent, part);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw fail();
  }
  await privateDir(path);
  return path;
}
async function syncDir(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function readJson(path: string, max = 524288): Promise<unknown> {
  const before = await privateFile(path);
  if (before.size > max) throw fail();
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (s.dev !== before.dev || s.ino !== before.ino) throw fail();
    const bytes = await f.readFile();
    if (bytes.length !== before.size) throw fail();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await f.close();
  }
}
async function writeJson(path: string, value: unknown) {
  if (await exists(path)) await privateFile(path);
  const temp = path + "." + randomUUID() + ".tmp";
  const f = await open(
    temp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await f.writeFile(json(value) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, path);
  await syncDir(dirname(path));
}
export function validArchiveDescriptor(v: unknown): v is ArchiveDescriptor {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as ArchiveDescriptor;
  try {
    identity(d.identity);
    if (new Date(Date.parse(d.capturedAt)).toISOString() !== d.capturedAt)
      return false;
  } catch {
    return false;
  }
  if (
    d.version !== 1 ||
    !uuid.test(d.sessionId) ||
    !Array.isArray(d.files) ||
    d.files.length < 2 ||
    d.files.length > 66
  )
    return false;
  let bytes = 0,
    count = 0;
  const ids = new Set<string>();
  for (const [n, f] of d.files.entries()) {
    if (
      !f ||
      !digestPattern.test(f.sha256) ||
      f.id !== (n === 0 ? "journal" : n === 1 ? "manifest" : f.sha256) ||
      f.kind !== (n === 0 ? "journal" : n === 1 ? "manifest" : "accepted") ||
      ids.has(f.id) ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes < 1 ||
      f.bytes > (n === 0 ? 64 * CHUNK : n === 1 ? 16384 : 8 * CHUNK) ||
      !Array.isArray(f.chunks) ||
      !f.chunks.length
    )
      return false;
    ids.add(f.id);
    let size = 0;
    for (const c of f.chunks) {
      if (
        !c ||
        !Number.isSafeInteger(c.bytes) ||
        c.bytes < 1 ||
        c.bytes > CHUNK ||
        !digestPattern.test(c.sha256)
      )
        return false;
      size += c.bytes;
      if (++count > 256) return false;
    }
    if (size !== f.bytes) return false;
    bytes += size;
    if (bytes > TOTAL) return false;
  }
  return true;
}
function validReceipt(r: ArchiveReceipt, d: ArchiveDescriptor) {
  const ids = archiveIds(d);
  return (
    !!r &&
    r.version === 1 &&
    r.descriptorId === ids.descriptorId &&
    r.descriptorSha256 === ids.descriptorSha256 &&
    json(r.identity) === json(d.identity) &&
    r.sessionId === d.sessionId &&
    r.capturedAt === d.capturedAt &&
    json(r.files) ===
      json(
        d.files.map(({ kind, id, bytes, sha256 }) => ({
          kind,
          id,
          bytes,
          sha256,
        })),
      ) &&
    r.chunkCount === d.files.reduce((n, f) => n + f.chunks.length, 0) &&
    typeof r.keyId === "string" &&
    /^[A-Za-z0-9_.-]{1,32}$/.test(r.keyId) &&
    typeof r.completedAt === "string" &&
    Number.isFinite(Date.parse(r.completedAt)) &&
    new Date(Date.parse(r.completedAt)).toISOString() === r.completedAt
  );
}
interface Pending {
  version: 1;
  identity: UsageIdentity;
  phase: "preparing" | "uploading" | "completed";
  attemptId: string;
  capturedAt: string;
  descriptorId?: string;
  prepared?: boolean;
  uploadedChunks?: number;
  receiptSha256?: string;
}
export interface ArchiveCycleInput {
  sourcePath: string;
  directory: string;
  acceptedArchiveRoots: string[];
  identity: UsageIdentity;
  transport: ArchiveTransport;
  signal?: AbortSignal;
}
export interface ArchiveCycleResult {
  status: "completed" | "deferred";
  descriptorId?: string;
  receiptSha256?: string;
}
function bounded(signal?: AbortSignal) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 540000),
    deadline = performance.now() + 540000;
  const combined = signal
    ? AbortSignal.any([signal, abort.signal])
    : abort.signal;
  return {
    signal: combined,
    check: () => {
      if (combined.aborted || performance.now() >= deadline) throw fail();
    },
    finish: () => clearTimeout(timer),
  };
}
async function fileChunks(path: string, size: number, check: () => void) {
  const before = await privateFile(path);
  if (before.size !== size) throw fail();
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks = [];
  try {
    const s = await f.stat();
    if (s.dev !== before.dev || s.ino !== before.ino) throw fail();
    const buffer = Buffer.alloc(CHUNK);
    let at = 0;
    while (at < size) {
      check();
      const length = Math.min(CHUNK, size - at);
      let read = 0;
      while (read < length) {
        const part = await f.read(buffer, read, length - read, at + read);
        if (!part.bytesRead) throw fail();
        read += part.bytesRead;
      }
      chunks.push({ bytes: length, sha256: sha(buffer.subarray(0, length)) });
      at += length;
    }
    const after = await f.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw fail();
    return chunks;
  } finally {
    await f.close();
  }
}
interface Completed {
  descriptorId: string;
  receiptSha256: string;
}
async function retainCompleted(directory: string, entry: Completed) {
  const path = join(directory, "completed.json");
  const previous = (await exists(path)) ? await readJson(path) : [];
  if (
    !Array.isArray(previous) ||
    previous.length > 256 ||
    previous.some(
      (v: Completed) =>
        !v ||
        !digestPattern.test(v.descriptorId) ||
        !digestPattern.test(v.receiptSha256),
    )
  )
    throw fail();
  const list = [
    ...previous.filter((v: Completed) => v.descriptorId !== entry.descriptorId),
    entry,
  ] as Completed[];
  // Only generated, complete copies with matching durable remote proof are pruned.
  for (const old of list.slice(0, -2)) {
    const receiptPath = join(directory, "receipts", old.descriptorId + ".json"),
      descriptorPath = join(
        directory,
        "descriptors",
        old.descriptorId + ".json",
      );
    const stored = (await readJson(receiptPath)) as {
        receipt: ArchiveReceipt;
        receiptSha256: string;
      },
      d = (await readJson(descriptorPath)) as ArchiveDescriptor;
    if (
      !validArchiveDescriptor(d) ||
      !validReceipt(stored.receipt, d) ||
      sha(json(stored.receipt)) !== old.receiptSha256 ||
      stored.receiptSha256 !== old.receiptSha256
    )
      throw fail();
    const artifact = join(directory, "artifacts", old.descriptorId);
    if (await exists(artifact)) {
      await privateDir(artifact);
      await rm(artifact, { recursive: true });
    }
  }
  while (list.length > 256) {
    const old = list.shift()!;
    for (const kind of ["receipts", "descriptors"]) {
      const oldPath = join(directory, kind, old.descriptorId + ".json");
      await privateFile(oldPath);
      await rm(oldPath);
    }
  }
  await writeJson(path, list);
}
export async function runArchiveCycle(
  input: ArchiveCycleInput,
): Promise<ArchiveCycleResult> {
  if (cycles.has(input.directory)) return { status: "deferred" };
  cycles.add(input.directory);
  const bound = bounded(input.signal);
  try {
    const expected = identity(input.identity);
    await privateDir(input.directory);
    if (!relative(input.directory, input.sourcePath).startsWith(".."))
      throw fail();
    const artifacts = await child(input.directory, "artifacts"),
      work = await child(input.directory, "work"),
      descriptors = await child(input.directory, "descriptors"),
      receipts = await child(input.directory, "receipts"),
      statePath = join(input.directory, "pending.json");
    let state: Pending | undefined;
    if (await exists(statePath)) {
      const v = (await readJson(statePath)) as Pending;
      if (
        !v ||
        v.version !== 1 ||
        json(v.identity) !== json(expected) ||
        !uuid.test(v.attemptId) ||
        !["preparing", "uploading", "completed"].includes(v.phase)
      )
        throw fail();
      state = v;
    }
    if (!state || state.phase === "completed") {
      const fs = await statfs(input.directory);
      if (fs.bavail * fs.bsize < 384 * CHUNK) throw fail();
      state = {
        version: 1,
        identity: expected,
        phase: "preparing",
        attemptId: randomUUID(),
        capturedAt: new Date().toISOString(),
      };
      await writeJson(statePath, state);
    }
    if (state.phase === "preparing") {
      const prep = await child(work, state.attemptId),
        snapshot = join(prep, "snapshot"),
        files = join(prep, "files");
      if (!(await exists(snapshot)))
        await snapshotUsageJournal(
          {
            sourcePath: input.sourcePath,
            targetDirectory: snapshot,
            expectedIdentity: expected,
          },
          { signal: bound.signal },
        );
      const manifest = (await readJson(
        join(snapshot, "manifest.json"),
        16384,
      )) as { sha256: string };
      await verifyUsageSnapshot(
        {
          snapshotDirectory: snapshot,
          expectedIdentity: expected,
          expectedSha256: manifest.sha256,
        },
        { signal: bound.signal },
      );
      const readyPath = join(prep, "descriptor-ready.json");
      let descriptor: ArchiveDescriptor;
      if (await exists(readyPath))
        descriptor = (await readJson(readyPath)) as ArchiveDescriptor;
      else {
        if (!(await exists(files)))
          await prepareUsageArchiveFiles({
            snapshotDirectory: snapshot,
            identity: expected,
            expectedSha256: manifest.sha256,
            acceptedArchiveRoots: input.acceptedArchiveRoots,
            destinationDirectory: files,
            signal: bound.signal,
          });
        const inspected = await inspectUsageSnapshot(
          {
            snapshotDirectory: files,
            expectedIdentity: expected,
            expectedSha256: manifest.sha256,
          },
          { signal: bound.signal },
        );
        const entries = await readdir(files);
        if (entries.length < 2 || entries.length > 66) throw fail();
        const names = [
          "usage.sqlite",
          "manifest.json",
          ...entries
            .filter((n) => /^accepted-[a-f0-9]{64}\.json$/.test(n))
            .sort(),
        ];
        if (names.length !== entries.length) throw fail();
        descriptor = {
          version: 1,
          identity: expected,
          sessionId: inspected.sessionId,
          capturedAt: state.capturedAt,
          files: [],
        };
        for (const n of names) {
          bound.check();
          const path = join(files, n),
            info = await privateFile(path),
            kind =
              n === "usage.sqlite"
                ? "journal"
                : n === "manifest.json"
                  ? "manifest"
                  : "accepted";
          const fileHash = createHash("sha256");
          const fd = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const buffer = Buffer.alloc(CHUNK);
            let at = 0;
            while (at < info.size) {
              bound.check();
              const r = await fd.read(
                buffer,
                0,
                Math.min(CHUNK, info.size - at),
                at,
              );
              if (!r.bytesRead) throw fail();
              fileHash.update(buffer.subarray(0, r.bytesRead));
              at += r.bytesRead;
            }
          } finally {
            await fd.close();
          }
          const sha256 = fileHash.digest("hex");
          descriptor.files.push({
            kind,
            id: kind === "accepted" ? sha256 : kind,
            bytes: info.size,
            sha256,
            chunks: await fileChunks(path, info.size, bound.check),
          });
        }
        if (!validArchiveDescriptor(descriptor)) throw fail();
        await verifyDownloadedUsageArchive({
          directory: files,
          descriptor,
          identity: expected,
          expectedSqliteSha256: manifest.sha256,
          expectedSessionId: descriptor.sessionId,
          signal: bound.signal,
        });
        await writeJson(readyPath, descriptor);
      }
      if (
        !validArchiveDescriptor(descriptor) ||
        json(descriptor.identity) !== json(expected) ||
        descriptor.capturedAt !== state.capturedAt
      )
        throw fail();
      const ids = archiveIds(descriptor),
        target = join(artifacts, ids.descriptorId);
      const custodyFiles = (await exists(target)) ? target : files;
      await verifyDownloadedUsageArchive({
        directory: custodyFiles,
        descriptor,
        identity: expected,
        expectedSqliteSha256: manifest.sha256,
        expectedSessionId: descriptor.sessionId,
        signal: bound.signal,
      });
      if (await exists(target)) {
        await privateDir(target);
        for (const file of descriptor.files)
          if (
            json(
              await fileChunks(
                join(target, filename(file)),
                file.bytes,
                bound.check,
              ),
            ) !== json(file.chunks)
          )
            throw fail();
        if (await exists(files)) await rm(files, { recursive: true });
      } else {
        await rename(files, target);
        await syncDir(artifacts);
      }
      await writeJson(
        join(descriptors, ids.descriptorId + ".json"),
        descriptor,
      );
      state = {
        ...state,
        phase: "uploading",
        descriptorId: ids.descriptorId,
        prepared: false,
        uploadedChunks: 0,
      };
      await writeJson(statePath, state);
    }
    bound.check();
    if (!state.descriptorId || !digestPattern.test(state.descriptorId))
      throw fail();
    const d = (await readJson(
      join(descriptors, state.descriptorId + ".json"),
    )) as ArchiveDescriptor;
    if (
      !validArchiveDescriptor(d) ||
      archiveIds(d).descriptorId !== state.descriptorId ||
      json(d.identity) !== json(expected) ||
      !Number.isSafeInteger(state.uploadedChunks) ||
      Number(state.uploadedChunks) < 0 ||
      Number(state.uploadedChunks) >
        d.files.reduce((n, f) => n + f.chunks.length, 0)
    )
      throw fail();
    const ids = archiveIds(d),
      target = join(artifacts, ids.descriptorId);
    await privateDir(target);
    if (!state.prepared) {
      const reply = await input.transport.prepare(d, bound.signal);
      bound.check();
      if (
        reply.descriptorId !== ids.descriptorId ||
        reply.descriptorSha256 !== ids.descriptorSha256 ||
        json(reply.descriptor) !== json(d)
      )
        throw fail();
      state.prepared = true;
      await writeJson(statePath, state);
    }
    let ordinal = 0;
    for (const file of d.files) {
      const path = join(target, filename(file)),
        info = await privateFile(path);
      if (info.size !== file.bytes) throw fail();
      const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        let offset = 0;
        for (const chunk of file.chunks) {
          bound.check();
          if (ordinal >= Number(state.uploadedChunks)) {
            const bytes = Buffer.alloc(chunk.bytes);
            let at = 0;
            while (at < bytes.length) {
              const part = await f.read(
                bytes,
                at,
                bytes.length - at,
                offset + at,
              );
              if (!part.bytesRead) throw fail();
              at += part.bytesRead;
            }
            if (sha(bytes) !== chunk.sha256) throw fail();
            const reply = await input.transport.putChunk(
              ids.descriptorId,
              ordinal,
              bytes,
              bound.signal,
            );
            bound.check();
            if (
              reply.descriptorId !== ids.descriptorId ||
              reply.ordinal !== ordinal ||
              reply.bytes !== chunk.bytes ||
              reply.sha256 !== chunk.sha256
            )
              throw fail();
            state.uploadedChunks = ordinal + 1;
            await writeJson(statePath, state);
          }
          offset += chunk.bytes;
          ordinal++;
        }
      } finally {
        await f.close();
      }
    }
    const completed = await input.transport.finalize(
      ids.descriptorId,
      bound.signal,
    );
    bound.check();
    if (
      !validReceipt(completed.receipt, d) ||
      sha(json(completed.receipt)) !== completed.receiptSha256
    )
      throw fail();
    const receiptPath = join(receipts, ids.descriptorId + ".json");
    if (await exists(receiptPath)) {
      if (json(await readJson(receiptPath)) !== json(completed)) throw fail();
    } else await writeJson(receiptPath, completed);
    await retainCompleted(input.directory, {
      descriptorId: ids.descriptorId,
      receiptSha256: completed.receiptSha256,
    });
    state = {
      ...state,
      phase: "completed",
      receiptSha256: completed.receiptSha256,
    };
    await writeJson(statePath, state);
    await writeJson(join(input.directory, "latest.json"), {
      version: 1,
      status: "completed",
      descriptorId: ids.descriptorId,
      receiptSha256: completed.receiptSha256,
      sessionId: d.sessionId,
      costAttribution: "installation",
    });
    await rm(join(work, state.attemptId), { recursive: true, force: true });
    return {
      status: "completed",
      descriptorId: ids.descriptorId,
      receiptSha256: completed.receiptSha256,
    };
  } catch {
    return { status: "deferred" };
  } finally {
    bound.finish();
    cycles.delete(input.directory);
  }
}
export async function recoverUsageArchive(input: {
  identity: UsageIdentity;
  descriptorId: string;
  expectedReceiptSha256: string;
  targetDirectory: string;
  transport: ArchiveRecoveryTransport;
  signal?: AbortSignal;
}): Promise<{
  status: "verified_archive_custody";
  activationSupported: false;
  sessionId: string;
  acceptedArchives: number;
  pendingFacts: number;
}> {
  const bound = bounded(input.signal);
  try {
    const expected = identity(input.identity);
    if (
      !digestPattern.test(input.descriptorId) ||
      !digestPattern.test(input.expectedReceiptSha256)
    )
      throw fail();
    await privateDir(dirname(input.targetDirectory));
    if (await exists(input.targetDirectory)) throw fail();
    const result = await input.transport.recovery(
      input.descriptorId,
      input.expectedReceiptSha256,
      bound.signal,
    );
    bound.check();
    const d = result.descriptor;
    if (
      !validArchiveDescriptor(d) ||
      json(d.identity) !== json(expected) ||
      archiveIds(d).descriptorId !== input.descriptorId ||
      !validReceipt(result.receipt, d) ||
      sha(json(result.receipt)) !== input.expectedReceiptSha256 ||
      result.receiptSha256 !== input.expectedReceiptSha256
    )
      throw fail();
    await mkdir(input.targetDirectory, { mode: 0o700 });
    let ordinal = 0;
    for (const file of d.files) {
      bound.check();
      const f = await open(
          join(input.targetDirectory, filename(file)),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        ),
        whole = createHash("sha256");
      try {
        for (const chunk of file.chunks) {
          const stream = await input.transport.chunk(
              input.descriptorId,
              ordinal,
              input.expectedReceiptSha256,
              bound.signal,
            ),
            reader = stream.getReader(),
            part = createHash("sha256");
          let bytes = 0;
          try {
            while (true) {
              bound.check();
              const value = await reader.read();
              if (value.done) break;
              bytes += value.value.byteLength;
              if (bytes > chunk.bytes) throw fail();
              part.update(value.value);
              whole.update(value.value);
              let written = 0;
              while (written < value.value.byteLength) {
                bound.check();
                const r = await f.write(
                  value.value,
                  written,
                  value.value.byteLength - written,
                );
                if (!r.bytesWritten) throw fail();
                written += r.bytesWritten;
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          if (bytes !== chunk.bytes || part.digest("hex") !== chunk.sha256)
            throw fail();
          ordinal++;
        }
        if (whole.digest("hex") !== file.sha256) throw fail();
        await f.sync();
      } finally {
        await f.close();
      }
    }
    await syncDir(input.targetDirectory);
    await syncDir(dirname(input.targetDirectory));
    const v = await verifyDownloadedUsageArchive({
      directory: input.targetDirectory,
      descriptor: d,
      identity: expected,
      expectedSqliteSha256: d.files[0]!.sha256,
      expectedSessionId: d.sessionId,
      signal: bound.signal,
    });
    return {
      status: "verified_archive_custody",
      activationSupported: false,
      sessionId: v.sessionId,
      acceptedArchives: v.acceptedArchives,
      pendingFacts: v.pendingFacts,
    };
  } finally {
    bound.finish();
  }
}
export interface UsageArchiveConfiguration {
  version: 1;
  directory: string;
  acceptedArchiveRoots: string[];
  intervalMilliseconds: number;
  costAttribution: "installation";
}
export async function loadUsageArchiveConfiguration(
  path: string,
): Promise<UsageArchiveConfiguration> {
  const v = (await readJson(path, 65536)) as UsageArchiveConfiguration;
  if (
    !v ||
    Object.keys(v).length !== 5 ||
    v.version !== 1 ||
    v.costAttribution !== "installation" ||
    !Number.isSafeInteger(v.intervalMilliseconds) ||
    v.intervalMilliseconds < 60000 ||
    v.intervalMilliseconds > 86400000 ||
    !Array.isArray(v.acceptedArchiveRoots) ||
    v.acceptedArchiveRoots.length > 32
  )
    throw fail();
  await privateDir(v.directory);
  for (const root of v.acceptedArchiveRoots) {
    await privateDir(root);
    if (!relative(v.directory, root).startsWith("..")) throw fail();
  }
  return v;
}
export async function runUsageArchiveScheduler(
  input: ArchiveCycleInput & {
    intervalMilliseconds: number;
    log: (event: string) => void;
  },
): Promise<void> {
  while (!input.signal?.aborted) {
    const result = await runArchiveCycle(input);
    input.log(
      result.status === "completed"
        ? "usage_archive_completed"
        : "usage_archive_deferred",
    );
    try {
      await pause(input.intervalMilliseconds, undefined, {
        signal: input.signal,
      });
    } catch {
      if (!input.signal?.aborted) throw fail();
    }
  }
}
