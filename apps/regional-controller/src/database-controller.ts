// SPDX-License-Identifier: Apache-2.0
import { setTimeout as pause } from "node:timers/promises";
import { DatabaseClient } from "./database-client.ts";
import type { DatabaseFailure } from "./database-client.ts";
import { reconcileDatabase } from "./database-reconcile.ts";
import type {
  DatabaseClaim,
  DatabaseConfig,
  DatabaseRuntime,
  DatabaseVerifier,
} from "./database-types.ts";

interface DatabaseControllerOptions {
  leaseSeconds: number;
  pollMilliseconds: number;
  readinessMilliseconds: number;
  signal: AbortSignal;
  log(event: string): void;
}
async function execute(
  runtime: DatabaseRuntime,
  client: DatabaseClient,
  claim: DatabaseClaim,
  config: DatabaseConfig,
  verifier: DatabaseVerifier,
  options: DatabaseControllerOptions,
): Promise<void> {
  const stopped = new AbortController(),
    signal = AbortSignal.any([options.signal, stopped.signal]);
  let leaseLost = false;
  const deadline = Date.now() + options.readinessMilliseconds;
  const authorized = () => {
    if (
      leaseLost ||
      options.signal.aborted ||
      Date.now() >= Math.min(deadline, Date.parse(claim.leaseExpiresAt) - 5000)
    )
      throw new Error("lease_not_authorized");
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
        options.log("database_lease_lost");
      }
    }
  })();
  try {
    while (Date.now() < deadline) {
      authorized();
      const result = await reconcileDatabase(
        runtime,
        claim,
        config,
        verifier,
        authorized,
      );
      if (result.applied && result.observation) {
        authorized();
        await client.result(claim, result.observation);
        options.log("database_applied");
        return;
      }
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    }
    options.log("database_application_deferred");
  } catch (error) {
    const failures: Record<string, DatabaseFailure> = {
      database_ownership_mismatch: "ownership_mismatch",
      database_spec_conflict: "spec_conflict",
      database_name_conflict: "database_name_conflict",
    };
    const failure =
      error instanceof Error ? failures[error.message] : undefined;
    if (failure) {
      try {
        authorized();
        await client.result(claim, null, failure);
        options.log("database_application_failed");
      } catch {
        options.log("database_application_deferred");
      }
    } else options.log("database_application_deferred");
  } finally {
    stopped.abort();
    await heartbeat;
  }
}
export async function runDatabaseController(
  runtime: DatabaseRuntime,
  client: DatabaseClient,
  config: DatabaseConfig,
  verifier: DatabaseVerifier,
  options: DatabaseControllerOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const claim = await client.claim(options.leaseSeconds);
      if (claim)
        await execute(runtime, client, claim, config, verifier, options);
    } catch {
      options.log("database_control_deferred");
    }
    try {
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    } catch {
      if (!options.signal.aborted) throw new Error("database_poll_failed");
    }
  }
}
