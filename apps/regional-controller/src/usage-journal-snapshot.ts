// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { UsageIdentity } from "./metering-types.ts";
import { validAcceptedArchive } from "./usage-accepted-ledger.ts";
import type { AcceptedArchive } from "./usage-accepted-ledger.ts";
export interface UsageSnapshotInput {
  sourcePath: string;
  targetDirectory: string;
  expectedIdentity: UsageIdentity;
}
export interface UsageSnapshotResult {
  status: "verified_snapshot";
  sha256: string;
  bytes: number;
  pendingFacts: number;
  activationSupported: false;
}
export interface UsageSnapshotVerificationInput {
  snapshotDirectory: string;
  expectedIdentity: UsageIdentity;
  expectedSha256: string;
}
export interface UsageSnapshotVerificationResult {
  status: "verified_snapshot_custody";
  sha256: string;
  bytes: number;
  pendingFacts: number;
  activationSupported: false;
}
export interface UsageSnapshotInspectionResult extends UsageSnapshotVerificationResult {
  sessionId: string;
  acceptedLastArchive: AcceptedArchive | null;
}
interface WorkerResult {
  pendingFacts: number;
  bytes: number;
  sessionId?: string;
  acceptedLastArchive?: AcceptedArchive | null;
}
const maximum = 64 * 1024 * 1024;
const failed = () => new Error("usage_snapshot_failed");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const controls = (value: string) =>
  Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    !controls(value)
  );
}
function identity(value: unknown): value is UsageIdentity {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    typeof value.regionId === "string" &&
    uuid.test(value.regionId) &&
    typeof value.sourceId === "string" &&
    uuid.test(value.sourceId) &&
    Number.isSafeInteger(value.sourceEpoch) &&
    Number(value.sourceEpoch) > 0
  );
}
async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw failed();
}
async function privateFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw failed();
    return { dev: String(info.dev), ino: String(info.ino) };
  } finally {
    await file.close();
  }
}
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw failed();
  }
  throw failed();
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function createFile(path: string, contents?: string): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    if (contents !== undefined) await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function worker(
  message: unknown,
  deadline: number,
  signal?: AbortSignal,
  inspectMetadata = false,
): Promise<WorkerResult> {
  if (signal?.aborted || performance.now() >= deadline) throw failed();
  const suffix = new URL(import.meta.url).pathname.endsWith(".ts")
      ? ".ts"
      : ".js",
    path = fileURLToPath(
      new URL("./usage-journal-snapshot-worker" + suffix, import.meta.url),
    );
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > 16384) throw failed();
  return await new Promise<WorkerResult>((resolve, reject) => {
    const child = spawn(process.execPath, [path], {
      env: {
        PATH: dirname(process.execPath),
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "",
      outputBytes = 0,
      errorBytes = 0,
      unavailable = false,
      escalation: ReturnType<typeof setTimeout> | null = null;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Closed group is already quiescent. */
        }
    };
    const stop = () => {
      if (unavailable) return;
      unavailable = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
    };
    const aborted = () => stop();
    signal?.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(
      stop,
      Math.max(1, deadline - performance.now() - 1500),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (inspectMetadata ? 8192 : 4096)) {
        stop();
        return;
      }
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 4096) stop();
    });
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", aborted);
      if (
        unavailable ||
        code !== 0 ||
        signal?.aborted ||
        performance.now() >= deadline
      ) {
        reject(failed());
        return;
      }
      try {
        const result: unknown = JSON.parse(output);
        if (
          !object(result) ||
          Object.keys(result).length !== (inspectMetadata ? 5 : 3) ||
          result.status !== "verified" ||
          !Number.isSafeInteger(result.pendingFacts) ||
          Number(result.pendingFacts) < 0 ||
          !Number.isSafeInteger(result.bytes) ||
          Number(result.bytes) < 1 ||
          Number(result.bytes) > maximum ||
          (inspectMetadata &&
            (typeof result.sessionId !== "string" ||
              !uuid.test(result.sessionId) ||
              (result.acceptedLastArchive !== null &&
                !validAcceptedArchive(result.acceptedLastArchive))))
        )
          throw failed();
        resolve({
          pendingFacts: Number(result.pendingFacts),
          bytes: Number(result.bytes),
          ...(inspectMetadata
            ? {
                sessionId: result.sessionId as string,
                acceptedLastArchive:
                  result.acceptedLastArchive as AcceptedArchive | null,
              }
            : {}),
        });
      } catch {
        reject(failed());
      }
    });
    child.stdin.end(encoded);
    if (signal?.aborted) stop();
    // The backup process is never abandoned by Promise.race. On cancellation or
    // timeout, publication waits for its actual close after TERM/KILL.
  });
}
async function verifyUsageSnapshotInternal(
  input: UsageSnapshotVerificationInput,
  options: { signal?: AbortSignal } = {},
  inspectMetadata = false,
): Promise<UsageSnapshotVerificationResult | UsageSnapshotInspectionResult> {
  const deadline = performance.now() + 59000;
  try {
    if (
      !object(input) ||
      Object.keys(input).length !== 3 ||
      !absolute(input.snapshotDirectory) ||
      !identity(input.expectedIdentity) ||
      typeof input.expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
      (process.platform !== "linux" && process.platform !== "darwin")
    )
      throw failed();
    await privateDirectory(input.snapshotDirectory);
    const initialDirectory = await lstat(input.snapshotDirectory);
    const directory = await realpath(input.snapshotDirectory),
      sourcePath = join(directory, "usage.sqlite"),
      manifestPath = join(directory, "manifest.json"),
      sourceStat = await privateFile(sourcePath),
      manifestStat = await privateFile(manifestPath),
      result = await worker(
        {
          sourcePath,
          sourceStat,
          expectedIdentity: input.expectedIdentity,
          verification: {
            manifestPath,
            manifestStat,
            expectedSha256: input.expectedSha256,
            ...(inspectMetadata ? { inspectMetadata: true } : {}),
          },
        },
        deadline,
        options.signal,
        inspectMetadata,
      );
    await privateDirectory(input.snapshotDirectory);
    const finalDirectory = await lstat(input.snapshotDirectory);
    if (
      finalDirectory.dev !== initialDirectory.dev ||
      finalDirectory.ino !== initialDirectory.ino ||
      finalDirectory.mtimeMs !== initialDirectory.mtimeMs ||
      finalDirectory.ctimeMs !== initialDirectory.ctimeMs ||
      options.signal?.aborted ||
      performance.now() >= deadline
    )
      throw failed();
    return {
      status: "verified_snapshot_custody",
      sha256: input.expectedSha256,
      bytes: result.bytes,
      pendingFacts: result.pendingFacts,
      activationSupported: false,
      ...(inspectMetadata
        ? {
            sessionId: result.sessionId!,
            acceptedLastArchive: result.acceptedLastArchive!,
          }
        : {}),
    };
  } catch {
    throw new Error("usage_snapshot_verification_failed");
  }
}
export async function verifyUsageSnapshot(
  input: UsageSnapshotVerificationInput,
  options: { signal?: AbortSignal } = {},
): Promise<UsageSnapshotVerificationResult> {
  return verifyUsageSnapshotInternal(input, options);
}
// The same bounded verification lane may expose only copied custody metadata.
// It never opens a live UsageJournal or modifies the copied SQL/manifest bytes.
export async function inspectUsageSnapshot(
  input: UsageSnapshotVerificationInput,
  options: { signal?: AbortSignal } = {},
): Promise<UsageSnapshotInspectionResult> {
  return (await verifyUsageSnapshotInternal(
    input,
    options,
    true,
  )) as UsageSnapshotInspectionResult;
}
export async function snapshotUsageJournal(
  input: UsageSnapshotInput,
  options: { signal?: AbortSignal } = {},
): Promise<UsageSnapshotResult> {
  const deadline = performance.now() + 59000,
    check = () => {
      if (options.signal?.aborted || performance.now() >= deadline)
        throw failed();
    };
  let work: string | null = null;
  try {
    check();
    if (
      !object(input) ||
      Object.keys(input).length !== 3 ||
      !absolute(input.sourcePath) ||
      !absolute(input.targetDirectory) ||
      !identity(input.expectedIdentity) ||
      (process.platform !== "linux" && process.platform !== "darwin")
    )
      throw failed();
    const sourceParent = await realpath(dirname(input.sourcePath)),
      targetParent = await realpath(dirname(input.targetDirectory));
    await privateDirectory(sourceParent);
    await privateDirectory(targetParent);
    const sourcePath = join(sourceParent, basename(input.sourcePath)),
      targetDirectory = join(targetParent, basename(input.targetDirectory));
    if (
      ["", "-wal", "-shm", "-journal"].some(
        (suffix) => targetDirectory === sourcePath + suffix,
      )
    )
      throw failed();
    await absent(targetDirectory);
    const sourceStat = await privateFile(sourcePath);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await lstat(sourcePath + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw failed();
      }
      await privateFile(sourcePath + suffix);
    }
    check();
    work = await mkdtemp(join(targetParent, ".pgcf-usage-snapshot-"));
    await chmod(work, 0o700);
    const destination = join(work, "usage.sqlite");
    await createFile(destination);
    const result = await worker(
      {
        sourcePath,
        destinationPath: destination,
        expectedIdentity: {
          regionId: input.expectedIdentity.regionId,
          sourceId: input.expectedIdentity.sourceId,
          sourceEpoch: input.expectedIdentity.sourceEpoch,
        },
        sourceStat,
      },
      deadline,
      options.signal,
    );
    check();
    const current = await privateFile(sourcePath);
    if (current.dev !== sourceStat.dev || current.ino !== sourceStat.ino)
      throw failed();
    const file = await open(
        destination,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
      hash = createHash("sha256");
    let bytes = 0;
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > maximum ||
        before.size !== result.bytes
      )
        throw failed();
      const buffer = Buffer.alloc(65536);
      while (true) {
        check();
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > maximum) throw failed();
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await file.stat();
      if (
        bytes !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw failed();
      await file.sync();
    } finally {
      await file.close();
    }
    const sha256 = hash.digest("hex"),
      manifest = {
        schemaVersion: 2,
        identity: {
          regionId: input.expectedIdentity.regionId,
          sourceId: input.expectedIdentity.sourceId,
          sourceEpoch: input.expectedIdentity.sourceEpoch,
        },
        sha256,
        bytes,
        pendingFacts: result.pendingFacts,
        activationSupported: false,
      };
    await createFile(join(work, "manifest.json"), JSON.stringify(manifest));
    await syncDirectory(work);
    check();
    await mkdir(targetDirectory, { mode: 0o700 });
    await link(destination, join(targetDirectory, "usage.sqlite"));
    await syncDirectory(targetDirectory);
    check();
    await link(
      join(work, "manifest.json"),
      join(targetDirectory, "manifest.json"),
    );
    await syncDirectory(targetDirectory);
    await syncDirectory(targetParent);
    check();
    return {
      status: "verified_snapshot",
      sha256,
      bytes,
      pendingFacts: result.pendingFacts,
      activationSupported: false,
    };
  } catch {
    throw failed();
  } finally {
    if (work)
      try {
        await rm(work, { recursive: true, force: true });
      } catch {
        /* An unverified private staging path is never activated. */
      }
  }
}
