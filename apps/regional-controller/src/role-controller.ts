// SPDX-License-Identifier: Apache-2.0
import { setTimeout as pause } from "node:timers/promises";
import { RoleClient } from "./role-client.ts";
import { reconcileRole } from "./role-reconcile.ts";
import type {
  RoleClaim,
  RoleConfig,
  RoleRuntime,
  RoleVerifier,
} from "./role-types.ts";

interface RoleControllerOptions {
  leaseSeconds: number;
  pollMilliseconds: number;
  readinessMilliseconds: number;
  signal: AbortSignal;
  log(event: string): void;
}
async function execute(
  runtime: RoleRuntime,
  client: RoleClient,
  claim: RoleClaim,
  config: RoleConfig,
  verifier: RoleVerifier,
  options: RoleControllerOptions,
): Promise<void> {
  const stopped = new AbortController(),
    signal = AbortSignal.any([options.signal, stopped.signal]);
  let leaseLost = false;
  const authorized = () => {
    if (
      leaseLost ||
      options.signal.aborted ||
      Date.now() >= Date.parse(claim.leaseExpiresAt) - 5000
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
        options.log("role_lease_lost");
      }
    }
  })();
  try {
    const deadline = Date.now() + options.readinessMilliseconds;
    while (Date.now() < deadline) {
      authorized();
      const result = await reconcileRole(
        runtime,
        claim,
        config,
        verifier,
        authorized,
      );
      if (result.applied && result.observation) {
        authorized();
        await client.result(claim, result.observation);
        options.log("role_applied");
        return;
      }
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    }
    options.log("role_application_deferred");
  } catch (error) {
    const failure =
      error instanceof Error && error.message === "role_ownership_mismatch"
        ? "ownership_mismatch"
        : error instanceof Error && error.message === "role_spec_conflict"
          ? "spec_conflict"
          : null;
    if (failure) {
      try {
        authorized();
        await client.result(claim, null, failure);
        options.log("role_application_failed");
      } catch {
        options.log("role_application_deferred");
      }
    } else options.log("role_application_deferred");
  } finally {
    stopped.abort();
    await heartbeat;
  }
}
export async function runRoleController(
  runtime: RoleRuntime,
  client: RoleClient,
  config: RoleConfig,
  verifier: RoleVerifier,
  options: RoleControllerOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const claim = await client.claim(options.leaseSeconds);
      if (claim)
        await execute(runtime, client, claim, config, verifier, options);
    } catch {
      options.log("role_control_deferred");
    }
    try {
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    } catch {
      if (!options.signal.aborted) throw new Error("role_poll_failed");
    }
  }
}
