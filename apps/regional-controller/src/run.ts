// SPDX-License-Identifier: Apache-2.0
import { setTimeout as pause } from "node:timers/promises";
import { ControlClient } from "./control-client.ts";
import { reconcileEnvironment } from "./reconcile.ts";
import { ReconcileError } from "./types.ts";
import { prepareProvisioningCapacity } from "./capacity-provisioning.ts";
import { initializeCapacityCustody } from "./capacity-reconcile.ts";
import type { CapacityProvisioningConfiguration } from "./capacity-provisioning.ts";
import type { Claim, Kubernetes, RegionalConfig } from "./types.ts";
import {
  ProvisioningFundingBarrier,
  ProvisioningFundingJournal,
} from "./provisioning-funding.ts";

interface RunOptions {
  leaseSeconds: number;
  pollMilliseconds: number;
  readinessMilliseconds: number;
  signal: AbortSignal;
  log: (event: string) => void;
  provisioningJournalDirectory?: string;
  capacity?: CapacityProvisioningConfiguration;
}

async function execute(
  api: Kubernetes,
  client: ControlClient,
  claim: Claim,
  config: RegionalConfig,
  options: RunOptions,
): Promise<void> {
  let leaseUntil = Date.parse(claim.leaseExpiresAt);
  const stopped = new AbortController();
  const heartbeatSignal = AbortSignal.any([options.signal, stopped.signal]);
  let leaseLost = false;
  const leaseAuthorized = () => {
    if (leaseLost || options.signal.aborted || Date.now() >= leaseUntil - 5_000)
      throw new Error("lease_not_authorized");
  };
  let journal: ProvisioningFundingJournal | null = null;
  let funding: ProvisioningFundingBarrier | null = null;
  const authorized = () => {
    leaseAuthorized();
    funding?.assert();
  };
  const heartbeat = (async () => {
    try {
      while (!heartbeatSignal.aborted) {
        await pause(Math.floor((options.leaseSeconds * 1_000) / 3), undefined, {
          signal: heartbeatSignal,
        });
        const renewed = await client.renew(claim, options.leaseSeconds);
        const next = Date.parse(renewed.leaseExpiresAt);
        if (!Number.isFinite(next) || next <= Date.now() + 5_000)
          throw new Error("invalid_lease_renewal");
        leaseUntil = next;
      }
    } catch {
      if (!heartbeatSignal.aborted) {
        leaseLost = true;
        options.log("lease_lost");
      }
    }
  })();
  try {
    // Empty queues preserve startup compatibility. Claimed creation cannot
    // proceed without installation-owned durable bootstrap custody.
    if (!options.provisioningJournalDirectory)
      throw new Error("provisioning_funding_configuration_unavailable");
    if (
      !options.capacity ||
      options.capacity.configuration.journalDirectory ===
        options.provisioningJournalDirectory
    )
      throw new Error("provisioning_capacity_configuration_unavailable");
    initializeCapacityCustody(
      claim,
      options.capacity.configuration,
      leaseAuthorized,
    );
    journal = new ProvisioningFundingJournal(
      options.provisioningJournalDirectory,
      claim,
    );
    funding = new ProvisioningFundingBarrier(
      journal,
      client,
      leaseAuthorized,
      () => leaseUntil - 5_000,
    );
    await funding.acquire(claim);
    const deadline = Date.now() + options.readinessMilliseconds;
    while (Date.now() < deadline) {
      await funding.refresh();
      authorized();
      const capacity = await prepareProvisioningCapacity({
        api,
        claim: { ...claim, leaseExpiresAt: new Date(leaseUntil).toISOString() },
        lane: options.capacity,
        funding,
        fundingIdentity: journal.funding!,
      });
      if (!capacity) {
        options.log("capacity_pending");
        await pause(options.pollMilliseconds, undefined, {
          signal: options.signal,
        });
        continue;
      }
      let state: Awaited<ReturnType<typeof reconcileEnvironment>>;
      try {
        state = await reconcileEnvironment(
          capacity.api,
          claim,
          config,
          authorized,
          (category) => options.log(`native_readback_deferred_${category}`),
          capacity.stages,
        );
      } finally {
        capacity.close();
      }
      if (state.ready && state.observation) {
        await funding.refresh();
        authorized();
        await client.result(claim, state.observation);
        options.log("environment_ready");
        return;
      }
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    }
    // Keep the durable operation applying: a fresh claim will inspect existing
    // resources. A slow Pod is not proof that provisioning failed or is absent.
    options.log("readiness_deferred");
  } catch (error) {
    if (error instanceof ReconcileError) {
      if (funding) await funding.refresh();
      authorized();
      await client.result(claim, null, error.code);
      options.log(error.code);
    } else {
      // Do not log exception bodies: Kubernetes errors may contain Secrets.
      // Leave uncertain work for lease expiry and deterministic reclaim.
      options.log("operation_deferred");
    }
  } finally {
    stopped.abort();
    await heartbeat;
    journal?.close();
  }
}

export async function runController(
  api: Kubernetes,
  client: ControlClient,
  config: RegionalConfig,
  options: RunOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const claim = await client.claim(options.leaseSeconds);
      if (claim) await execute(api, client, claim, config, options);
    } catch {
      options.log("control_unavailable");
    }
    try {
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    } catch {
      if (!options.signal.aborted) throw new Error("controller_poll_failed");
    }
  }
}
