// SPDX-License-Identifier: Apache-2.0
import { setTimeout as pause } from "node:timers/promises";
import { reconcileBackup } from "./backup-reconcile.ts";
import type {
  BackupAttempt,
  BackupClaim,
  BackupControl,
  BackupRuntime,
} from "./backup-types.ts";

export interface BackupControllerOptions {
  leaseSeconds: number;
  pollMilliseconds: number;
  readinessMilliseconds: number;
  signal: AbortSignal;
  log(event: string): void;
}
async function execute(
  runtime: BackupRuntime,
  client: BackupControl,
  claim: BackupClaim,
  options: BackupControllerOptions,
): Promise<void> {
  const stopped = new AbortController(),
    signal = AbortSignal.any([options.signal, stopped.signal]);
  const deadline = Date.now() + options.readinessMilliseconds;
  let leaseLost = false;
  const authorized = () => {
    if (
      leaseLost ||
      options.signal.aborted ||
      Date.now() >= Math.min(deadline, Date.parse(claim.leaseExpiresAt) - 5000)
    )
      throw new Error("backup_lease_not_authorized");
  };
  const heartbeat = (async () => {
    try {
      while (!signal.aborted) {
        await pause(Math.floor((options.leaseSeconds * 1000) / 3), undefined, {
          signal,
        });
        claim.leaseExpiresAt = await client.renew(claim, options.leaseSeconds);
      }
    } catch {
      if (!signal.aborted) {
        leaseLost = true;
        options.log("backup_lease_lost");
      }
    }
  })();
  const attempt: BackupAttempt = { createAttempted: false, resourceUid: null };
  try {
    while (Date.now() < deadline) {
      authorized();
      const result = await reconcileBackup(
        runtime,
        client,
        claim,
        attempt,
        authorized,
      );
      if (result.terminal && result.observation) {
        authorized();
        await client.result(claim, result.observation);
        options.log(
          result.observation.phase === "completed"
            ? "backup_operator_completed"
            : "backup_operator_failed",
        );
        return;
      }
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    }
    options.log("backup_observation_deferred");
  } catch {
    options.log("backup_observation_deferred");
  } finally {
    stopped.abort();
    await heartbeat;
  }
}
export async function runBackupController(
  runtime: BackupRuntime,
  client: BackupControl,
  options: BackupControllerOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const claim = await client.claim(options.leaseSeconds);
      if (claim) await execute(runtime, client, claim, options);
    } catch {
      options.log("backup_control_deferred");
    }
    try {
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    } catch {
      if (!options.signal.aborted) throw new Error("backup_poll_failed");
    }
  }
}
