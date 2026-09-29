// SPDX-License-Identifier: Apache-2.0
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { readRecoveryPrivate } from "./control-recovery.ts";
import { verifyUsageSnapshot } from "./usage-journal-snapshot.ts";

export async function runUsageSnapshotVerification(
  args: string[],
): Promise<number> {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (args.length !== 2 || args[0] !== "--config" || !args[1])
      throw new Error();
    const parent = await lstat(dirname(args[1]));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o777) !== 0o700 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      throw new Error();
    const value: unknown = JSON.parse(
      (await readRecoveryPrivate(args[1], 65536)).toString("utf8"),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const c = value as Record<string, unknown>;
    if (Object.keys(c).length !== 4 || c.schemaVersion !== 1) throw new Error();
    const result = await verifyUsageSnapshot(
      {
        snapshotDirectory: c.snapshotDirectory,
        expectedIdentity: c.expectedIdentity,
        expectedSha256: c.expectedSha256,
      } as Parameters<typeof verifyUsageSnapshot>[0],
      { signal: cancellation.signal },
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch {
    process.stdout.write(
      JSON.stringify({
        status: "failed",
        error: { code: "usage_snapshot_verification_failed" },
      }) + "\n",
    );
    return 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
