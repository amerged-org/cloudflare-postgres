// SPDX-License-Identifier: Apache-2.0
import { dirname, isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";
import { readRecoveryPrivate } from "./control-recovery.ts";
import { UsageArchiveRecoveryClient } from "./usage-archive-client.ts";
import { recoverUsageArchive } from "./usage-archive.ts";
export async function runUsageArchiveRecovery(args: string[]): Promise<number> {
  const abort = new AbortController(),
    cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (
      args.length !== 2 ||
      args[0] !== "--config" ||
      !args[1] ||
      !isAbsolute(args[1])
    )
      throw new Error();
    const parent = await lstat(dirname(args[1]));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Error();
    const v = JSON.parse(
      (await readRecoveryPrivate(args[1], 65536)).toString("utf8"),
    ) as Record<string, unknown>;
    const fields = [
      "version",
      "origin",
      "regionId",
      "sourceId",
      "sourceEpoch",
      "descriptorId",
      "expectedReceiptSha256",
      "installerTokenFile",
      "targetDirectory",
    ];
    if (
      !v ||
      Object.keys(v).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(v, key)) ||
      v.version !== 1 ||
      typeof v.origin !== "string" ||
      typeof v.regionId !== "string" ||
      typeof v.sourceId !== "string" ||
      !Number.isSafeInteger(v.sourceEpoch) ||
      typeof v.descriptorId !== "string" ||
      typeof v.expectedReceiptSha256 !== "string" ||
      typeof v.installerTokenFile !== "string" ||
      !isAbsolute(v.installerTokenFile) ||
      typeof v.targetDirectory !== "string" ||
      !isAbsolute(v.targetDirectory)
    )
      throw new Error();
    const identity = {
      regionId: v.regionId,
      sourceId: v.sourceId,
      sourceEpoch: Number(v.sourceEpoch),
    };
    const client = new UsageArchiveRecoveryClient(
      v.origin,
      identity,
      async () =>
        (await readRecoveryPrivate(String(v.installerTokenFile), 4096))
          .toString("utf8")
          .trim(),
    );
    const result = await recoverUsageArchive({
      identity,
      descriptorId: v.descriptorId,
      expectedReceiptSha256: v.expectedReceiptSha256,
      targetDirectory: v.targetDirectory,
      transport: client,
      signal: abort.signal,
    });
    process.stdout.write(
      JSON.stringify({
        status: result.status,
        activationSupported: false,
        pendingFacts: result.pendingFacts,
        acceptedArchives: result.acceptedArchives,
      }) + "\n",
    );
    return 0;
  } catch {
    process.stdout.write(
      JSON.stringify({
        status: "failed",
        activationSupported: false,
        error: { code: "usage_archive_recovery_failed" },
      }) + "\n",
    );
    return 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
