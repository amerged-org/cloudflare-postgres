// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { ControlClient } from "./control-client.ts";
import { kubernetesFromConfig } from "./kubernetes.ts";
import { runController } from "./run.ts";
import type { RegionalConfig } from "./types.ts";

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
  const config = JSON.parse(
    await readFile(required("PGCF_REGIONAL_CONFIG_FILE"), "utf8"),
  ) as RegionalConfig;
  if (
    !config ||
    typeof config !== "object" ||
    typeof config.operatorNamespace !== "string" ||
    !config.operatorPodLabels ||
    typeof config.operatorPodLabels !== "object" ||
    !Array.isArray(config.allowedBackupSecrets)
  ) {
    throw new Error("invalid_regional_configuration");
  }
  const tokenFile = process.env.PGCF_REGION_TOKEN_FILE;
  const token = tokenFile
    ? (await readFile(tokenFile, "utf8")).trim()
    : required("PGCF_REGION_TOKEN").trim();
  const client = new ControlClient(
    required("PGCF_CONTROL_ORIGIN"),
    required("PGCF_REGION_ID"),
    token,
  );
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  await runController(
    kubernetesFromConfig(process.env.PGCF_KUBECONFIG_FILE),
    client,
    config,
    {
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
      log: (event) =>
        process.stdout.write(
          `${JSON.stringify({ time: new Date().toISOString(), event })}\n`,
        ),
    },
  );
}
main().catch(() => {
  process.stderr.write("regional_controller_failed\n");
  process.exitCode = 1;
});
