// SPDX-License-Identifier: Apache-2.0
import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { validAcceptedArchive } from "./usage-accepted-ledger.ts";
import type { AcceptedArchive } from "./usage-accepted-ledger.ts";
const maximum = 64 * 1024 * 1024,
  deadline = performance.now() + 57000;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failed = () => new Error("usage_snapshot_failed");
const check = () => {
  if (performance.now() >= deadline) throw failed();
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function validIdentity(
  value: unknown,
): value is { regionId: string; sourceId: string; sourceEpoch: number } {
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
async function fileInfo(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw failed();
    return info;
  } finally {
    await file.close();
  }
}
function verify(
  db: DatabaseSync,
  expected: { regionId: string; sourceId: string; sourceEpoch: number },
): number {
  const meta = db
    .prepare(
      "SELECT name,value FROM journal_meta WHERE name IN ('identity','schema_version')",
    )
    .all() as unknown as { name: string; value: string }[];
  if (
    meta.length !== 2 ||
    meta.find((row) => row.name === "schema_version")?.value !== "2"
  )
    throw failed();
  const identity: unknown = JSON.parse(
    meta.find((row) => row.name === "identity")!.value,
  );
  if (
    !validIdentity(identity) ||
    identity.regionId !== expected.regionId ||
    identity.sourceId !== expected.sourceId ||
    identity.sourceEpoch !== expected.sourceEpoch
  )
    throw failed();
  const count = db
    .prepare("SELECT COUNT(*) AS total FROM usage_outbox")
    .get()?.total;
  if (!Number.isSafeInteger(count) || Number(count) < 0) throw failed();
  return Number(count);
}
async function noAuxiliary(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw failed();
    }
    throw failed();
  }
}
async function hashFile(file: FileHandle, bytes: number): Promise<string> {
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  let at = 0;
  while (at < bytes) {
    check();
    const read = await file.read(
      buffer,
      0,
      Math.min(buffer.length, bytes - at),
      at,
    );
    if (read.bytesRead === 0) throw failed();
    hash.update(buffer.subarray(0, read.bytesRead));
    at += read.bytesRead;
  }
  if ((await file.read(buffer, 0, 1, at)).bytesRead) throw failed();
  return hash.digest("hex");
}
async function verifyCompleted(config: Record<string, unknown>): Promise<{
  pendingFacts: number;
  bytes: number;
  sessionId?: string;
  acceptedLastArchive?: AcceptedArchive | null;
}> {
  const sourcePath = config.sourcePath as string,
    expected = config.expectedIdentity as Parameters<typeof verify>[1],
    sourceStat = config.sourceStat as { dev: string; ino: string },
    v = config.verification;
  if (
    !object(v) ||
    Object.keys(v).length !== (v.inspectMetadata === true ? 4 : 3) ||
    (Object.hasOwn(v, "inspectMetadata") && v.inspectMetadata !== true) ||
    v.manifestPath !== join(dirname(sourcePath), "manifest.json") ||
    typeof v.expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.expectedSha256) ||
    !object(v.manifestStat) ||
    typeof v.manifestStat.dev !== "string" ||
    typeof v.manifestStat.ino !== "string"
  )
    throw failed();
  const directory = dirname(sourcePath),
    directoryBefore = await lstat(directory),
    before = await fileInfo(sourcePath),
    manifestBefore = await fileInfo(v.manifestPath);
  if (
    !directoryBefore.isDirectory() ||
    directoryBefore.isSymbolicLink() ||
    (directoryBefore.mode & 0o777) !== 0o700 ||
    (process.getuid && directoryBefore.uid !== process.getuid()) ||
    String(before.dev) !== sourceStat.dev ||
    String(before.ino) !== sourceStat.ino ||
    String(manifestBefore.dev) !== v.manifestStat.dev ||
    String(manifestBefore.ino) !== v.manifestStat.ino ||
    before.nlink !== 1 ||
    manifestBefore.nlink !== 1 ||
    before.size < 100 ||
    before.size > maximum ||
    manifestBefore.size < 1 ||
    manifestBefore.size > 65536
  )
    throw failed();
  await noAuxiliary(sourcePath);
  const file = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let manifestFile: FileHandle | null = null;
  let db: DatabaseSync | null = null;
  try {
    manifestFile = await open(
      v.manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const sourceInfo = await file.stat(),
      manifestInfo = await manifestFile.stat();
    if (
      sourceInfo.dev !== before.dev ||
      sourceInfo.ino !== before.ino ||
      manifestInfo.dev !== manifestBefore.dev ||
      manifestInfo.ino !== manifestBefore.ino
    )
      throw failed();
    const header = Buffer.alloc(100);
    if (
      (await file.read(header, 0, header.length, 0)).bytesRead !== 100 ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw failed();
    const manifestBytes = Buffer.alloc(manifestBefore.size);
    let at = 0;
    while (at < manifestBytes.length) {
      check();
      const read = await manifestFile.read(
        manifestBytes,
        at,
        manifestBytes.length - at,
        at,
      );
      if (read.bytesRead === 0) throw failed();
      at += read.bytesRead;
    }
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (
      !object(manifest) ||
      Object.keys(manifest).length !== 6 ||
      manifest.schemaVersion !== 2 ||
      !validIdentity(manifest.identity) ||
      manifest.identity.regionId !== expected.regionId ||
      manifest.identity.sourceId !== expected.sourceId ||
      manifest.identity.sourceEpoch !== expected.sourceEpoch ||
      manifest.sha256 !== v.expectedSha256 ||
      manifest.bytes !== before.size ||
      !Number.isSafeInteger(manifest.pendingFacts) ||
      Number(manifest.pendingFacts) < 0 ||
      manifest.activationSupported !== false ||
      (await hashFile(file, before.size)) !== v.expectedSha256
    )
      throw failed();
    check();
    // This is exclusively a closed DELETE-mode custody artifact, never a live
    // journal. The encoded string retains immutable URI parameters in Node.
    db = new DatabaseSync(
      pathToFileURL(sourcePath).href + "?mode=ro&immutable=1",
      {
        readOnly: true,
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        timeout: 1000,
      },
    );
    db.exec(
      "PRAGMA trusted_schema=OFF;PRAGMA query_only=ON;PRAGMA temp_store=MEMORY;",
    );
    const pendingFacts = verify(db, expected);
    if (
      pendingFacts !== manifest.pendingFacts ||
      Object.values(db.prepare("PRAGMA integrity_check(1)").get() ?? {})[0] !==
        "ok" ||
      !db.prepare("PRAGMA foreign_key_check").iterate().next().done
    )
      throw failed();
    let metadata:
      | { sessionId: string; acceptedLastArchive: AcceptedArchive | null }
      | undefined;
    if (v.inspectMetadata === true) {
      const state = db
          .prepare("SELECT id,session_id FROM journal_state LIMIT 2")
          .all(),
        archiveRow = db
          .prepare(
            "SELECT value FROM journal_meta WHERE name='accepted_last_archive'",
          )
          .get();
      if (
        state.length !== 1 ||
        state[0]?.id !== 1 ||
        typeof state[0]?.session_id !== "string" ||
        !uuid.test(state[0].session_id) ||
        (archiveRow &&
          (typeof archiveRow.value !== "string" ||
            Buffer.byteLength(archiveRow.value) > 8192))
      )
        throw failed();
      const acceptedLastArchive: unknown = archiveRow
        ? JSON.parse(archiveRow.value as string)
        : null;
      if (
        acceptedLastArchive !== null &&
        !validAcceptedArchive(acceptedLastArchive)
      )
        throw failed();
      metadata = { sessionId: state[0].session_id, acceptedLastArchive };
    }
    db.close();
    db = null;
    const directoryAfter = await lstat(directory),
      sourceAfter = await fileInfo(sourcePath),
      manifestAfter = await fileInfo(v.manifestPath);
    for (const [previous, current] of [
      [directoryBefore, directoryAfter],
      [before, sourceAfter],
      [manifestBefore, manifestAfter],
      [before, await file.stat()],
      [manifestBefore, await manifestFile.stat()],
    ]) {
      if (
        !previous ||
        !current ||
        previous.dev !== current.dev ||
        previous.ino !== current.ino ||
        previous.size !== current.size ||
        previous.mode !== current.mode ||
        previous.uid !== current.uid ||
        previous.nlink !== current.nlink ||
        previous.mtimeMs !== current.mtimeMs ||
        previous.ctimeMs !== current.ctimeMs
      )
        throw failed();
    }
    await noAuxiliary(sourcePath);
    if (
      (await hashFile(file, before.size)) !== v.expectedSha256 ||
      (await hashFile(manifestFile, manifestBefore.size)) !==
        createHash("sha256").update(manifestBytes).digest("hex")
    )
      throw failed();
    check();
    return { pendingFacts, bytes: before.size, ...metadata };
  } finally {
    try {
      db?.close();
    } finally {
      await file.close();
      await manifestFile?.close();
    }
  }
}
let source: DatabaseSync | null = null,
  target: DatabaseSync | null = null;
try {
  let text = "",
    bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16384) throw failed();
    text += chunk.toString("utf8");
  }
  const config: unknown = JSON.parse(text);
  if (
    !object(config) ||
    Object.keys(config).length !== 4 ||
    typeof config.sourcePath !== "string" ||
    !isAbsolute(config.sourcePath) ||
    !validIdentity(config.expectedIdentity) ||
    !object(config.sourceStat) ||
    typeof config.sourceStat.dev !== "string" ||
    typeof config.sourceStat.ino !== "string"
  )
    throw failed();
  check();
  if (Object.hasOwn(config, "verification")) {
    const result = await verifyCompleted(config);
    process.stdout.write(
      JSON.stringify({ status: "verified", ...result }) + "\n",
    );
    process.exitCode = 0;
  } else {
    if (
      typeof config.destinationPath !== "string" ||
      !isAbsolute(config.destinationPath)
    )
      throw failed();
    for (const path of [
      dirname(config.sourcePath),
      dirname(config.destinationPath),
    ]) {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o777) !== 0o700 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw failed();
    }
    const before = await fileInfo(config.sourcePath),
      destination = await fileInfo(config.destinationPath);
    if (
      String(before.dev) !== config.sourceStat.dev ||
      String(before.ino) !== config.sourceStat.ino ||
      destination.size !== 0 ||
      (before.dev === destination.dev && before.ino === destination.ino)
    )
      throw failed();
    source = new DatabaseSync(config.sourcePath, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 1000,
    });
    source.exec("PRAGMA query_only=ON;PRAGMA temp_store=MEMORY;");
    verify(source, config.expectedIdentity);
    const pageSize = Number(
        source.prepare("PRAGMA page_size").get()?.page_size,
      ),
      pages = Number(source.prepare("PRAGMA page_count").get()?.page_count);
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 512 ||
      pageSize > 65536 ||
      !Number.isSafeInteger(pages) ||
      pages < 1 ||
      pages * pageSize > maximum
    )
      throw failed();
    await backup(source, config.destinationPath, {
      source: "main",
      target: "main",
      rate: 16,
      progress: ({ totalPages }) => {
        check();
        if (
          !Number.isSafeInteger(totalPages) ||
          totalPages < 1 ||
          totalPages * pageSize > maximum
        )
          throw failed();
      },
    });
    check();
    verify(source, config.expectedIdentity);
    const after = await fileInfo(config.sourcePath);
    if (after.dev !== before.dev || after.ino !== before.ino) throw failed();
    source.close();
    source = null;
    // WAL mode is normalized only on the finished custody copy, so this artifact
    // is independently usable without sibling files. The live source is untouched.
    target = new DatabaseSync(config.destinationPath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 1000,
    });
    target.exec(
      "PRAGMA temp_store=MEMORY;PRAGMA journal_mode=DELETE;PRAGMA query_only=ON;",
    );
    const pendingFacts = verify(target, config.expectedIdentity);
    if (
      target.prepare("PRAGMA integrity_check").get()?.integrity_check !==
        "ok" ||
      target.prepare("PRAGMA foreign_key_check").all().length !== 0
    )
      throw failed();
    check();
    target.close();
    target = null;
    const complete = await fileInfo(config.destinationPath);
    if (
      complete.dev !== destination.dev ||
      complete.ino !== destination.ino ||
      complete.size < 1 ||
      complete.size > maximum
    )
      throw failed();
    const output = await open(
      config.destinationPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await output.sync();
    } finally {
      await output.close();
    }
    check();
    process.stdout.write(
      JSON.stringify({
        status: "verified",
        pendingFacts,
        bytes: complete.size,
      }) + "\n",
    );
  }
} catch {
  process.stdout.write(
    JSON.stringify({ error: { code: "usage_snapshot_failed" } }) + "\n",
  );
  process.exitCode = 2;
} finally {
  try {
    target?.close();
  } catch {
    /* Redacted failure already reported. */
  }
  try {
    source?.close();
  } catch {
    /* Never migrate or checkpoint the live journal. */
  }
}
