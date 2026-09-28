// SPDX-License-Identifier: Apache-2.0
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { AllowanceClient } from "./allowance-client.ts";
import {
  AllowanceJournal,
  validAllowanceUnits,
  validRuntimeBinding,
} from "./allowance-journal.ts";
import { allowanceKubernetesFromConfig } from "./allowance-kubernetes.ts";
import {
  acquireAllowance,
  reconcileAllowance,
} from "./allowance-supervisor.ts";
import type { RuntimeBinding } from "./allowance-types.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("allowance_configuration_missing");
  return value;
}
export async function runAllowanceSupervision(
  arguments_: string[],
): Promise<number> {
  let journal: AllowanceJournal | null = null;
  try {
    const once = arguments_.length === 3 && arguments_[2] === "--once";
    if (
      (arguments_.length !== 2 && !once) ||
      arguments_[0] !== "--config" ||
      !arguments_[1] ||
      !isAbsolute(arguments_[1])
    )
      throw new Error("allowance_arguments_invalid");
    const info = await stat(arguments_[1]);
    if (!info.isFile() || info.size > 65_536)
      throw new Error("allowance_configuration_bound");
    const value: unknown = JSON.parse(await readFile(arguments_[1], "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("allowance_configuration_invalid");
    const config = value as Record<string, unknown>,
      binding = config.binding as RuntimeBinding;
    if (
      config.schemaVersion !== 1 ||
      !binding ||
      !validRuntimeBinding(binding) ||
      !["kubeconfigFile", "kubeconfigContext", "journalPath"].every(
        (key) =>
          typeof config[key] === "string" && String(config[key]).length > 0,
      ) ||
      !isAbsolute(String(config.kubeconfigFile)) ||
      !isAbsolute(String(config.journalPath)) ||
      !Number.isSafeInteger(config.leaseSeconds) ||
      Number(config.leaseSeconds) < 30 ||
      Number(config.leaseSeconds) > 300 ||
      !validAllowanceUnits(config.units)
    )
      throw new Error("allowance_configuration_invalid");
    const tokenFile = required("PGCF_REGION_TOKEN_FILE");
    const client = new AllowanceClient(
      required("PGCF_CONTROL_ORIGIN"),
      binding.regionId,
      async () => (await readFile(tokenFile, "utf8")).trim(),
    );
    const runtime = allowanceKubernetesFromConfig(
      String(config.kubeconfigFile),
      String(config.kubeconfigContext),
      binding,
    );
    journal = new AllowanceJournal(String(config.journalPath), binding);
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      while (!shutdown.signal.aborted) {
        try {
          await acquireAllowance(
            journal,
            client,
            Number(config.leaseSeconds),
            config.units,
          );
        } catch {
          /* Same durable request, never a new grant after an unsettled receipt. */
        }
        const result = await reconcileAllowance(
          journal,
          client,
          runtime,
          Date.now(),
          Date.now,
        );
        process.stdout.write(
          `${JSON.stringify({ mode: "allowance-supervision", once, ...result, runtimeEnforced: false, enforcementStatus: "pending_runtime" })}\n`,
        );
        if (once) return result.state === "stopping" ? 1 : 0;
        try {
          await pause(5000, undefined, { signal: shutdown.signal });
        } catch {
          if (!shutdown.signal.aborted)
            throw new Error("allowance_poll_failed");
        }
      }
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch {
    process.stdout.write(
      `${JSON.stringify({ mode: "allowance-supervision", state: "stopping", growthAllowed: false, validUntil: null, error: { code: "allowance_supervision_failed" }, runtimeEnforced: false, enforcementStatus: "pending_runtime" })}\n`,
    );
    return 2;
  } finally {
    journal?.close();
  }
}
