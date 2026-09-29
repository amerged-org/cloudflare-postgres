// SPDX-License-Identifier: Apache-2.0
import { backup, DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
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
    typeof config.destinationPath !== "string" ||
    !isAbsolute(config.destinationPath) ||
    !validIdentity(config.expectedIdentity) ||
    !object(config.sourceStat) ||
    typeof config.sourceStat.dev !== "string" ||
    typeof config.sourceStat.ino !== "string"
  )
    throw failed();
  check();
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
  const pageSize = Number(source.prepare("PRAGMA page_size").get()?.page_size),
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
    target.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
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
    JSON.stringify({ status: "verified", pendingFacts, bytes: complete.size }) +
      "\n",
  );
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
