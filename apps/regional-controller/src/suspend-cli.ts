// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { SuspendClient } from "./suspend-client.ts";
import { suspendKubernetesFromConfig } from "./suspend-kubernetes.ts";
import { SuspendJournal, reconcileSuspend } from "./suspend-reconcile.ts";
import type { AllowanceRuntime } from "./allowance-types.ts";
import { PodRetirementJournal } from "./pod-retirement.ts";
import type { SuspendSeal } from "./suspend-types.ts";
import { validNodeObserverConfig } from "./node-observer.ts";
import type { NodeObserverConfiguration } from "./node-observer.ts";

export interface SuspendConfiguration {
  schemaVersion: 1;
  kubeconfigFile: string;
  kubeconfigContext: string;
  journalDirectory: string;
  nodeObserver?: NodeObserverConfiguration;
  podRetirement?: { version: 1 };
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("suspend_configuration_missing");
  return value;
}
export async function readSuspendConfiguration(
  path: string,
): Promise<SuspendConfiguration> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 65_536 ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("suspend_configuration_not_private");
  const contents = await readFile(path);
  if (contents.byteLength > 65_536)
    throw new Error("suspend_configuration_bound");
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(contents),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("suspend_configuration_invalid");
  const input = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "kubeconfigFile",
    "kubeconfigContext",
    "journalDirectory",
  ];
  if (
    Object.keys(input).length !==
      keys.length +
        (Object.hasOwn(input, "nodeObserver") ? 1 : 0) +
        (Object.hasOwn(input, "podRetirement") ? 1 : 0) ||
    !keys.every((key) => Object.hasOwn(input, key)) ||
    input.schemaVersion !== 1 ||
    typeof input.kubeconfigFile !== "string" ||
    !isAbsolute(input.kubeconfigFile) ||
    typeof input.kubeconfigContext !== "string" ||
    !input.kubeconfigContext.trim() ||
    typeof input.journalDirectory !== "string" ||
    !isAbsolute(input.journalDirectory) ||
    (Object.hasOwn(input, "nodeObserver") &&
      !validNodeObserverConfig(input.nodeObserver)) ||
    (Object.hasOwn(input, "podRetirement") &&
      (!validNodeObserverConfig(input.nodeObserver) ||
        input.podRetirement === null ||
        typeof input.podRetirement !== "object" ||
        Array.isArray(input.podRetirement) ||
        Object.keys(input.podRetirement).length !== 1 ||
        (input.podRetirement as { version?: unknown }).version !== 1))
  )
    throw new Error("suspend_configuration_invalid");
  return input as unknown as SuspendConfiguration;
}

export async function runSuspend(arguments_: string[]): Promise<number> {
  let journal: SuspendJournal | null = null;
  let retirementJournal: PodRetirementJournal | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let claimed = false;
  const shutdown = new AbortController();
  const deadline = performance.now() + 300_000;
  const stop = () => shutdown.abort();
  const deadlineTimer = setTimeout(stop, 300_000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // Aborting an await leaves an already submitted mutation uncertain. The
  // sealed journal is retained, and no subsequent effect/result is authorized.
  const active = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (shutdown.signal.aborted) throw new Error("suspend_interrupted");
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("suspend_interrupted"));
      shutdown.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation(), interrupted]);
    } finally {
      if (abort) shutdown.signal.removeEventListener("abort", abort);
    }
  };
  let exitCode = 2;
  const closeJournal = () => {
    retirementJournal?.close();
    journal?.close();
  };
  try {
    const execute = async (): Promise<number> => {
      if (
        arguments_.length !== 2 ||
        arguments_[0] !== "--config" ||
        !arguments_[1] ||
        !isAbsolute(arguments_[1])
      )
        throw new Error("suspend_arguments_invalid");
      const operator = await active(() =>
        readSuspendConfiguration(arguments_[1]!),
      );
      const regionId = required("PGCF_REGION_ID");
      const tokenFile = required("PGCF_REGION_TOKEN_FILE");
      const client = new SuspendClient(
        required("PGCF_CONTROL_ORIGIN"),
        regionId,
        async () => (await readFile(tokenFile, "utf8")).trim(),
        shutdown.signal,
      );
      const claim = await active(() => client.claim(90));
      if (!claim) {
        process.stdout.write(
          `${JSON.stringify({ mode: "environment-suspend", status: "no_work" })}\n`,
        );
        return 0;
      }
      claimed = true;
      let leaseLost = false;
      let renewing: Promise<void> | null = null;
      const leaseLimit = (expiresAt: string): number =>
        performance.now() +
        Math.min(90_000, Date.parse(expiresAt) - Date.now()) -
        5_000;
      let leaseDeadline = leaseLimit(claim.leaseExpiresAt);
      const authorized = () => {
        if (
          shutdown.signal.aborted ||
          leaseLost ||
          performance.now() >= deadline ||
          performance.now() >= leaseDeadline ||
          Date.parse(claim.leaseExpiresAt) <= Date.now() + 5_000
        )
          throw new Error("suspend_authority_lost");
      };
      heartbeatTimer = setInterval(() => {
        if (renewing || shutdown.signal.aborted || leaseLost) return;
        try {
          authorized();
        } catch {
          leaseLost = true;
          stop();
          return;
        }
        renewing = client
          .renew(claim, 90)
          .then((expiresAt) => {
            if (shutdown.signal.aborted || leaseLost) return;
            claim.leaseExpiresAt = expiresAt;
            leaseDeadline = leaseLimit(expiresAt);
          })
          .catch(() => {
            leaseLost = true;
            stop();
          })
          .finally(() => {
            renewing = null;
          });
      }, 30_000);
      authorized();
      journal = new SuspendJournal(
        join(operator.journalDirectory, `${claim.operationId}.sqlite`),
        claim,
      );
      authorized();
      const sealedBinding = journal.seal?.binding;
      const baseRuntime = await active(() =>
        suspendKubernetesFromConfig(
          operator.kubeconfigFile,
          operator.kubeconfigContext,
          claim,
          sealedBinding,
          authorized,
          operator.nodeObserver,
          shutdown.signal,
          operator.podRetirement !== undefined,
        ),
      );
      authorized();
      const runtime: AllowanceRuntime = {
        ...(baseRuntime.retainPod
          ? {
              retainPod: (record, finalizer) =>
                active(() => baseRuntime.retainPod!(record, finalizer)),
            }
          : {}),
        ...(baseRuntime.releasePod
          ? {
              releasePod: (record, finalizer, proof) =>
                active(() => baseRuntime.releasePod!(record, finalizer, proof)),
            }
          : {}),
        ...(baseRuntime.observeNode
          ? {
              observeNode: (name: string) =>
                active(() => baseRuntime.observeNode!(name)),
            }
          : {}),
        async inventory() {
          authorized();
          const inventory = await active(() => baseRuntime.inventory());
          authorized();
          return inventory;
        },
        async patch(kind, name, operations) {
          authorized();
          await active(() => baseRuntime.patch(kind, name, operations));
          authorized();
        },
      };
      const retire =
        operator.podRetirement && operator.nodeObserver
          ? (seal: SuspendSeal) => {
              authorized();
              retirementJournal ??= new PodRetirementJournal(
                join(
                  operator.journalDirectory,
                  `${claim.operationId}.retirement.sqlite`,
                ),
                {
                  ...seal.binding,
                  operationId: claim.operationId,
                  installationId: operator.nodeObserver!.installationId,
                },
                claim.leaseEpoch,
              );
              return retirementJournal;
            }
          : undefined;
      while (true) {
        authorized();
        const result = await reconcileSuspend(
          journal,
          runtime,
          authorized,
          retire,
        );
        authorized();
        if (result.reason === "physical_verification_pending") {
          process.stdout.write(
            `${JSON.stringify({ mode: "environment-suspend", status: "deferred", error: { code: "physical_verification_pending" } })}\n`,
          );
          return 1;
        }
        if (result.suspended && result.observation) {
          const observation = result.observation;
          await active(() => client.result(claim, observation));
          authorized();
          process.stdout.write(
            `${JSON.stringify({ mode: "environment-suspend", status: "suspended" })}\n`,
          );
          return 0;
        }
        await pause(
          Math.min(5_000, Math.max(1, deadline - performance.now())),
          undefined,
          { signal: shutdown.signal },
        );
      }
    };
    exitCode = await execute();
  } catch {
    // No raw errors, credentials, identifiers, inventory or uncertain result replay.
    process.stdout.write(
      `${JSON.stringify({ mode: "environment-suspend", status: "deferred", error: { code: "suspend_execution_deferred" } })}\n`,
    );
    exitCode = claimed ? 1 : 2;
  } finally {
    shutdown.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      closeJournal();
    } catch {
      process.stdout.write(
        `${JSON.stringify({ mode: "environment-suspend", status: "deferred", error: { code: "suspend_journal_close_failed" } })}\n`,
      );
      exitCode = 2;
    }
  }
  return exitCode;
}
