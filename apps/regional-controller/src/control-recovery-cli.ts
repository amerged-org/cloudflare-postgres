// SPDX-License-Identifier: Apache-2.0
import {
  createRecoveryBundle,
  readRecoveryPrivate,
  restoreRecoveryBundle,
  publishControlSnapshot,
} from "./control-recovery.ts";
import { captureD1 } from "./control-recovery-d1.ts";
import type { ControlRecoveryD1Config } from "./control-recovery-d1.ts";
import type { RecoveryKeyrings } from "./control-recovery.ts";
import type { ControlSnapshot } from "./control-snapshot.ts";
export async function runControlRecovery(args: string[]): Promise<number> {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (args.length !== 2 || args[0] !== "--config" || !args[1])
      throw new Error();
    const c: unknown = JSON.parse(
      (await readRecoveryPrivate(args[1], 65536)).toString("utf8"),
    );
    if (c === null || typeof c !== "object" || Array.isArray(c))
      throw new Error();
    const value = c as Record<string, unknown>;
    if (value.schemaVersion !== 1 || typeof value.action !== "string")
      throw new Error();
    let result: unknown;
    if (value.action === "capture") {
      const keys = [
        "schemaVersion",
        "action",
        "wranglerExecutable",
        "wranglerConfigFile",
        "emptyEnvFile",
        "accountId",
        "databaseName",
        "migrationDirectory",
        "source",
        "snapshotPath",
      ];
      if (
        Object.keys(value).length !== keys.length ||
        !keys.every((key) => Object.hasOwn(value, key)) ||
        typeof value.snapshotPath !== "string"
      )
        throw new Error();
      const config = Object.fromEntries(
        keys.slice(2, -1).map((key) => [key, value[key]]),
      ) as unknown as ControlRecoveryD1Config;
      const snapshot = await captureD1(config, cancellation.signal);
      if (cancellation.signal.aborted) throw new Error();
      await publishControlSnapshot(snapshot, value.snapshotPath);
      result = {
        status: "captured",
        sha256: snapshot.sha256,
        tables: snapshot.tables.length,
        rows: snapshot.tables.reduce(
          (sum, table) => sum + table.rows.length,
          0,
        ),
        activationSupported: false,
      };
    } else if (value.action === "restore") {
      const keys = [
        "schemaVersion",
        "action",
        "archivePath",
        "recoveryKeyFile",
        "targetDirectory",
        "migrationDirectory",
        "expectedSource",
      ];
      if (
        Object.keys(value).length !== keys.length ||
        !keys.every((k) => Object.hasOwn(value, k)) ||
        ![
          "archivePath",
          "recoveryKeyFile",
          "targetDirectory",
          "migrationDirectory",
        ].every((k) => typeof value[k] === "string")
      )
        throw new Error();
      result = await restoreRecoveryBundle(
        value as unknown as Parameters<typeof restoreRecoveryBundle>[0],
      );
    } else if (value.action === "seal") {
      const keys = [
        "schemaVersion",
        "action",
        "snapshotFile",
        "keyringsFile",
        "recoveryKeyFile",
        "archivePath",
        "migrationDirectory",
      ];
      if (
        Object.keys(value).length !== keys.length ||
        !keys.every((k) => Object.hasOwn(value, k)) ||
        !keys.slice(2).every((k) => typeof value[k] === "string")
      )
        throw new Error();
      const snapshot = JSON.parse(
          (await readRecoveryPrivate(value.snapshotFile as string)).toString(
            "utf8",
          ),
        ) as ControlSnapshot,
        keyrings = JSON.parse(
          (
            await readRecoveryPrivate(value.keyringsFile as string, 65536)
          ).toString("utf8"),
        ) as RecoveryKeyrings;
      result = await createRecoveryBundle({
        snapshot,
        keyrings,
        recoveryKeyFile: value.recoveryKeyFile as string,
        archivePath: value.archivePath as string,
        migrationDirectory: value.migrationDirectory as string,
      });
    } else throw new Error();
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch {
    process.stdout.write(
      JSON.stringify({
        status: "failed",
        error: { code: "control_recovery_failed" },
      }) + "\n",
    );
    return 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
