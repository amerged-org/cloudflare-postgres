// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { UsageJournal } from "./usage-journal.ts";
import type { UsageIdentity } from "./metering-types.ts";

export async function archiveAcceptedUsage(
  arguments_: string[],
): Promise<number> {
  let journal: UsageJournal | null = null;
  let exitCode = 2;
  try {
    if (
      arguments_.length !== 2 ||
      arguments_[0] !== "--config" ||
      !arguments_[1] ||
      !isAbsolute(arguments_[1])
    )
      throw new Error("accepted_archive_arguments_invalid");
    const info = await lstat(arguments_[1]);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 65_536 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("accepted_archive_config_not_private");
    const contents = await readFile(arguments_[1]);
    if (contents.byteLength > 65_536)
      throw new Error("accepted_archive_config_bound");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contents),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("accepted_archive_config_invalid");
    const config = value as Record<string, unknown>;
    const keys = [
      "schemaVersion",
      "journalPath",
      "identity",
      "archivePath",
      "limit",
    ];
    if (
      Object.keys(config).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(config, key)) ||
      config.schemaVersion !== 1 ||
      typeof config.journalPath !== "string" ||
      !isAbsolute(config.journalPath) ||
      typeof config.archivePath !== "string" ||
      !isAbsolute(config.archivePath) ||
      !Number.isSafeInteger(config.limit) ||
      Number(config.limit) < 1 ||
      Number(config.limit) > 256
    )
      throw new Error("accepted_archive_config_invalid");
    const existing = await lstat(config.journalPath);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error("accepted_archive_journal_missing");
    journal = new UsageJournal(
      config.journalPath,
      config.identity as UsageIdentity,
    );
    const result = journal.archiveAccepted(
      config.archivePath,
      Number(config.limit),
    );
    process.stdout.write(
      `${JSON.stringify({ mode: "accepted-usage-archive", status: "archived", archiveId: result.archiveId, records: result.records, sha256: result.sha256 })}\n`,
    );
    exitCode = 0;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ mode: "accepted-usage-archive", status: "deferred", error: { code: "accepted_usage_archive_failed" } })}\n`,
    );
  }
  try {
    journal?.close();
  } catch {
    process.stdout.write(
      `${JSON.stringify({ mode: "accepted-usage-archive", status: "deferred", error: { code: "accepted_usage_archive_close_failed" } })}\n`,
    );
    exitCode = 2;
  }
  return exitCode;
}
