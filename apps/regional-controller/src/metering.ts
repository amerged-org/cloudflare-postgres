// SPDX-License-Identifier: Apache-2.0
import { setTimeout as pause } from "node:timers/promises";
import { observeUsage } from "./usage-observer.ts";
import { UsageClient } from "./usage-client.ts";
import { UsageJournal } from "./usage-journal.ts";
import { usageFailureDescriptor } from "./usage-delivery-status.ts";
import type { Kubernetes } from "./types.ts";
import type {
  AcceptedUsageReceipt,
  ObservationResult,
} from "./metering-types.ts";

export interface MeteringOptions {
  regionId: string;
  sampleMilliseconds: number;
  deliveryMilliseconds: number;
  signal: AbortSignal;
  log: (event: string) => void;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await pause(milliseconds, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export async function sampleUsage(
  api: Kubernetes,
  journal: UsageJournal,
  regionId: string,
  log: (event: string) => void,
): Promise<void> {
  // Corrupt or inaccessible journal state is fatal, not a discovery outage.
  const knownVolumes = journal.knownVolumes();
  let result: ObservationResult;
  try {
    if (!api.meteringInventory)
      throw new Error("metering_inventory_unavailable");
    const inventory = await api.meteringInventory(regionId);
    result = observeUsage(inventory, regionId, knownVolumes);
  } catch {
    // Partial or inaccessible inventory is not evidence that allocations ended.
    journal.observe({
      observedAt: Date.now(),
      complete: false,
      allocations: [],
      issues: [{ code: "inventory_unavailable" }],
      volumeBindings: [],
    });
    log("metering_inventory_deferred");
    return;
  }
  journal.observe({ observedAt: Date.now(), complete: true, ...result });
  if (result.issues.length > 0 || journal.status().hasCoverageGaps)
    log("metering_coverage_incomplete");
}

export async function deliverUsage(
  client: UsageClient,
  journal: UsageJournal,
  signal: AbortSignal,
  log: (event: string) => void,
): Promise<void> {
  for (const fact of journal.pending(32)) {
    if (signal.aborted) return;
    let accepted: AcceptedUsageReceipt;
    try {
      accepted = await client.sendReceipt(fact);
    } catch (failure) {
      const descriptor = usageFailureDescriptor(failure);
      if (!descriptor) throw failure;
      journal.recordDeliveryFailure(fact, descriptor);
      // Preserve the same durable fact identity after uncertain HTTP outcomes.
      // Never log exception bodies, credentials, raw resource or tenant data.
      log("metering_delivery_deferred");
      return;
    }
    try {
      if (!journal.acknowledgeAccepted(accepted))
        throw new Error("usage_acknowledgement_lost");
    } catch (failure) {
      if (
        failure instanceof Error &&
        failure.message === "accepted_capacity_exceeded"
      ) {
        journal.recordDeliveryFailure(fact, {
          kind: "local_capacity",
          httpStatus: null,
          code: "accepted_capacity_exceeded",
        });
        log("metering_delivery_deferred");
        return;
      }
      throw failure;
    }
  }
}

export async function runMetering(
  api: Kubernetes,
  client: UsageClient,
  journal: UsageJournal,
  options: MeteringOptions,
): Promise<void> {
  if (
    !api.meteringInventory ||
    !Number.isSafeInteger(options.sampleMilliseconds) ||
    options.sampleMilliseconds < 1000 ||
    options.sampleMilliseconds > 30000 ||
    !Number.isSafeInteger(options.deliveryMilliseconds) ||
    options.deliveryMilliseconds < 1000 ||
    options.deliveryMilliseconds > 60000
  )
    throw new Error("invalid_metering_configuration");
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal]);
  journal.beginSession(Date.now());
  const sampler = (async () => {
    while (!signal.aborted) {
      await sampleUsage(api, journal, options.regionId, options.log);
      await wait(options.sampleMilliseconds, signal);
    }
  })();
  const sender = (async () => {
    while (!signal.aborted) {
      await deliverUsage(client, journal, signal, options.log);
      await wait(options.deliveryMilliseconds, signal);
    }
  })();
  try {
    await Promise.all([sampler, sender]);
  } finally {
    stopped.abort();
    await Promise.allSettled([sampler, sender]);
  }
}
