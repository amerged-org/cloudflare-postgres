// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { ControlClient } from "./control-client.ts";
import { kubernetesFromConfig } from "./kubernetes.ts";
import { runController } from "./run.ts";
import { UsageClient } from "./usage-client.ts";
import { UsageJournal } from "./usage-journal.ts";
import { runMetering } from "./metering.ts";
import type { UsageIdentity } from "./metering-types.ts";
import type { RegionalConfig } from "./types.ts";
import { RoleClient } from "./role-client.ts";
import { roleKubernetesFromConfig } from "./role-kubernetes.ts";
import { runRoleController } from "./role-controller.ts";
import { postgresRoleVerifier } from "./role-postgres.ts";
import { validRoleConfig } from "./role-reconcile.ts";
import type { RoleConfig } from "./role-types.ts";
import { DatabaseClient } from "./database-client.ts";
import { databaseKubernetesFromConfig } from "./database-kubernetes.ts";
import { runDatabaseController } from "./database-controller.ts";
import { postgresDatabaseVerifier } from "./database-postgres.ts";
import { validNativeClientProfiles } from "./native-access.ts";
import { BackupClient } from "./backup-client.ts";
import { backupKubernetesFromConfig } from "./backup-kubernetes.ts";
import { runBackupController } from "./backup-controller.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing_controller_configuration");
  return value;
}
function milliseconds(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("invalid_controller_configuration");
  return value;
}

async function main(): Promise<void> {
  if (process.argv[2] === "verify-usage-snapshot") {
    const { runUsageSnapshotVerification } =
      await import("./usage-snapshot-verification-cli.ts");
    process.exitCode = await runUsageSnapshotVerification(
      process.argv.slice(3),
    );
    return;
  }
  if (process.argv[2] === "snapshot-usage") {
    const { runUsageJournalSnapshot } =
      await import("./usage-journal-snapshot-cli.ts");
    process.exitCode = await runUsageJournalSnapshot(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "inspect-fleet") {
    const { runFleetInspection } = await import("./fleet-inspection-cli.ts");
    process.exitCode = await runFleetInspection(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "recover-control") {
    const { runControlRecovery } = await import("./control-recovery-cli.ts");
    process.exitCode = await runControlRecovery(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "inspect-node-runtime") {
    const { inspectNodeRuntime } =
      await import("./inspect-node-runtime-cli.ts");
    process.exitCode = await inspectNodeRuntime(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "archive-accepted-usage") {
    const { archiveAcceptedUsage } = await import("./accepted-usage-cli.ts");
    process.exitCode = await archiveAcceptedUsage(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "run-suspend") {
    const { runSuspend } = await import("./suspend-cli.ts");
    process.exitCode = await runSuspend(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "serve-suspend") {
    const { runSuspendWorker } = await import("./suspend-worker.ts");
    process.exitCode = await runSuspendWorker(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "supervise-allowance") {
    const { runAllowanceSupervision } = await import("./allowance-cli.ts");
    process.exitCode = await runAllowanceSupervision(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "prepare-maintenance") {
    const { runMaintenancePreparation } = await import("./maintenance-cli.ts");
    process.exitCode = await runMaintenancePreparation(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "inspect-platform") {
    const { runPlatformInspection } = await import("./platform-inspection.ts");
    process.exitCode = await runPlatformInspection(process.argv.slice(3));
    return;
  }
  const config = JSON.parse(
    await readFile(required("PGCF_REGIONAL_CONFIG_FILE"), "utf8"),
  ) as RegionalConfig & { roleVerifier: RoleConfig };
  if (
    !config ||
    typeof config !== "object" ||
    typeof config.operatorNamespace !== "string" ||
    !config.operatorPodLabels ||
    typeof config.operatorPodLabels !== "object" ||
    !Array.isArray(config.allowedBackupSecrets) ||
    !validRoleConfig(config.roleVerifier) ||
    !validNativeClientProfiles(config.nativeClientProfiles)
  ) {
    throw new Error("invalid_regional_configuration");
  }
  const tokenFile = process.env.PGCF_REGION_TOKEN_FILE;
  const manualBackups = process.env.PGCF_MANUAL_BACKUPS_ENABLED;
  if (
    manualBackups !== undefined &&
    manualBackups !== "false" &&
    manualBackups !== "true"
  )
    throw new Error("invalid_regional_configuration");
  const token = tokenFile
    ? (await readFile(tokenFile, "utf8")).trim()
    : required("PGCF_REGION_TOKEN").trim();
  const client = new ControlClient(
    required("PGCF_CONTROL_ORIGIN"),
    required("PGCF_REGION_ID"),
    token,
  );
  const roleTokenFile = required("PGCF_REGION_TOKEN_FILE");
  const roleClient = new RoleClient(
    required("PGCF_CONTROL_ORIGIN"),
    required("PGCF_REGION_ID"),
    async () => (await readFile(roleTokenFile, "utf8")).trim(),
  );
  const roleApi = roleKubernetesFromConfig(process.env.PGCF_KUBECONFIG_FILE);
  const roleVerifier = postgresRoleVerifier();
  const databaseClient = new DatabaseClient(
    required("PGCF_CONTROL_ORIGIN"),
    required("PGCF_REGION_ID"),
    async () => (await readFile(roleTokenFile, "utf8")).trim(),
  );
  const databaseApi = databaseKubernetesFromConfig(
    process.env.PGCF_KUBECONFIG_FILE,
  );
  const databaseVerifier = postgresDatabaseVerifier();
  // Validate the optional lane before metering journals or controller work start.
  const backupLane =
    manualBackups === "true"
      ? {
          client: new BackupClient(
            required("PGCF_CONTROL_ORIGIN"),
            required("PGCF_REGION_ID"),
            async () => (await readFile(roleTokenFile, "utf8")).trim(),
          ),
          runtime: backupKubernetesFromConfig(process.env.PGCF_KUBECONFIG_FILE),
        }
      : null;
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  const api = kubernetesFromConfig(process.env.PGCF_KUBECONFIG_FILE);
  const log = (event: string) =>
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), event })}\n`,
    );
  // Validate all service configuration before any lane creates durable state or starts work.
  const controllerOptions = {
    leaseSeconds: milliseconds("PGCF_LEASE_SECONDS", 90, 30, 300),
    pollMilliseconds: milliseconds(
      "PGCF_POLL_MILLISECONDS",
      5_000,
      1_000,
      60_000,
    ),
    readinessMilliseconds: milliseconds(
      "PGCF_READINESS_MILLISECONDS",
      300_000,
      30_000,
      600_000,
    ),
    signal: shutdown.signal,
    log,
  };
  const journalPath = process.env.PGCF_USAGE_JOURNAL_PATH;
  let metering: {
    identity: UsageIdentity;
    client: UsageClient;
    sampleMilliseconds: number;
    deliveryMilliseconds: number;
  } | null = null;
  let journal: UsageJournal | null = null;
  const tasks: Promise<void>[] = [];
  if (journalPath) {
    const sourceEpoch = Number(required("PGCF_USAGE_SOURCE_EPOCH"));
    if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 1)
      throw new Error("invalid_metering_identity");
    const identity = {
      regionId: required("PGCF_REGION_ID"),
      sourceId: required("PGCF_USAGE_SOURCE_ID"),
      sourceEpoch,
    };
    const meterTokenFile = required("PGCF_METER_TOKEN_FILE");
    metering = {
      identity,
      client: new UsageClient(
        required("PGCF_CONTROL_ORIGIN"),
        identity,
        async () => (await readFile(meterTokenFile, "utf8")).trim(),
      ),
      sampleMilliseconds: milliseconds(
        "PGCF_USAGE_SAMPLE_MILLISECONDS",
        5000,
        1000,
        30000,
      ),
      deliveryMilliseconds: milliseconds(
        "PGCF_USAGE_DELIVERY_MILLISECONDS",
        5000,
        1000,
        60000,
      ),
    };
  } else if (
    [
      "PGCF_USAGE_SOURCE_ID",
      "PGCF_USAGE_SOURCE_EPOCH",
      "PGCF_METER_TOKEN_FILE",
    ].some((name) => process.env[name])
  ) {
    throw new Error("incomplete_metering_configuration");
  }
  try {
    if (journalPath && metering) {
      journal = new UsageJournal(journalPath, metering.identity);
      tasks.push(
        runMetering(api, metering.client, journal, {
          regionId: metering.identity.regionId,
          sampleMilliseconds: metering.sampleMilliseconds,
          deliveryMilliseconds: metering.deliveryMilliseconds,
          signal: shutdown.signal,
          log,
        }),
      );
    }
    tasks.push(runController(api, client, config, controllerOptions));
    if (backupLane) {
      tasks.push(
        runBackupController(
          backupLane.runtime,
          backupLane.client,
          controllerOptions,
        ),
      );
    }
    tasks.push(
      runRoleController(
        roleApi,
        roleClient,
        config.roleVerifier,
        roleVerifier,
        controllerOptions,
      ),
    );
    tasks.push(
      runDatabaseController(
        databaseApi,
        databaseClient,
        config.roleVerifier,
        databaseVerifier,
        controllerOptions,
      ),
    );
    await Promise.all(tasks);
  } finally {
    shutdown.abort();
    await Promise.allSettled(tasks);
    journal?.close();
  }
}
main().catch(() => {
  process.stderr.write("regional_controller_failed\n");
  process.exitCode = 1;
});
