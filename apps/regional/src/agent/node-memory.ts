// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from "node:timers/promises";
import {
  NodeMemoryObservation,
  NodeMemorySample,
  ObservationRequest,
} from "@pgcf/contracts";
import { condition, quantity } from "./observe.ts";
import { record, type Resource } from "./types.ts";
import type { VolumeStatsKubernetes } from "./kubernetes.ts";

export const NODE_MEMORY_INTERVAL_MS = 60_000;
export const NODE_MEMORY_FRESH_MS = 90_000;
const COLLECTION_DEADLINE_MS = 45_000;
const CONCURRENCY = 4;

/** statsSummary is authenticated by the kubelet client; its node name must also match. */
export function nodeMemorySample(
  node: Resource,
  summary: unknown,
  now: number,
): NodeMemorySample | null {
  try {
    if (
      node.kind !== "Node" ||
      node.metadata.deletionTimestamp ||
      condition(node, "Ready")?.status !== "True" ||
      !Number.isSafeInteger(now)
    )
      return null;
    const stats = record(record(summary).node);
    const memory = record(stats.memory);
    const sampledAt =
      typeof memory.time === "string" ? Date.parse(memory.time) : NaN;
    if (
      stats.nodeName !== node.metadata.name ||
      !Number.isSafeInteger(sampledAt) ||
      sampledAt < now - NODE_MEMORY_FRESH_MS ||
      sampledAt > now
    )
      return null;
    const pressure = condition(node, "MemoryPressure")?.status;
    const parsed = NodeMemorySample.safeParse({
      node_uid: node.metadata.uid,
      observed_at: new Date(sampledAt).toISOString(),
      working_set_bytes: memory.workingSetBytes,
      capacity_memory_bytes: quantity(
        record(record(node.status).capacity).memory,
      ),
      available_bytes: memory.availableBytes ?? null,
      memory_pressure:
        pressure === "True" ? true : pressure === "False" ? false : null,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface NodeMemoryOptions {
  k8s: VolumeStatsKubernetes | ((signal: AbortSignal) => VolumeStatsKubernetes);
  api: {
    observations(value: ObservationRequest, signal: AbortSignal): Promise<void>;
  };
  signal: AbortSignal;
  now?: () => number;
}

function identity(node: Resource): NodeMemoryObservation | null {
  if (node.kind !== "Node" || node.metadata.deletionTimestamp) return null;
  const parsed = NodeMemoryObservation.safeParse({
    node_id: node.metadata.labels?.["pgcf.io/node-id"],
    provider_instance_id:
      node.metadata.labels?.["pgcf.io/provider-instance-id"],
    node_uid: node.metadata.uid,
    memory: null,
  });
  return parsed.success ? parsed.data : null;
}

function binding(node: Resource): string {
  return JSON.stringify({
    identity: identity(node),
    name: node.metadata.name,
    addresses: record(node.status).addresses,
    capacity: record(node.status).capacity,
    ready: condition(node, "Ready")?.status,
  });
}

/** Whole-node sampling has no desired-database input and never joins the wake/reconcile path. */
export class RegionalNodeMemory {
  private options: NodeMemoryOptions;
  constructor(options: NodeMemoryOptions) {
    this.options = options;
  }
  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  async cycle(): Promise<void> {
    if (this.options.signal.aborted) return;
    const signal = AbortSignal.any([
      this.options.signal,
      AbortSignal.timeout(COLLECTION_DEADLINE_MS),
    ]);
    const k8s =
      typeof this.options.k8s === "function"
        ? this.options.k8s(signal)
        : this.options.k8s;
    const nodes = await k8s.list("Node");
    if (nodes.length > 1000) throw new Error("node_memory_inventory_bound");
    const subjects = nodes.flatMap((node) => {
      const sample = identity(node);
      return sample ? [{ node, sample, before: binding(node) }] : [];
    });
    let index = 0;
    const worker = async () => {
      while (index < subjects.length && !signal.aborted) {
        const work = subjects[index++]!;
        try {
          if (!k8s.statsSummary) continue;
          const summary = await k8s.statsSummary(work.node);
          const current = await k8s.read(
            "Node",
            undefined,
            work.node.metadata.name,
          );
          if (
            current &&
            !current.metadata.deletionTimestamp &&
            binding(current) === work.before
          )
            work.sample.memory = nodeMemorySample(current, summary, this.now);
        } catch {
          // Unknown includes failed TLS authentication, vanished nodes and incomplete gauges.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, subjects.length) }, worker),
    );
    if (!subjects.length || this.options.signal.aborted) return;
    await this.options.api.observations(
      ObservationRequest.parse({
        observed_at: new Date(this.now).toISOString(),
        nodes: [],
        databases: [],
        orphans: [],
        node_memory_samples: subjects.map((work) => work.sample),
      }),
      this.options.signal,
    );
  }

  async run(): Promise<void> {
    while (!this.options.signal.aborted) {
      const started = Date.now();
      try {
        await this.cycle();
      } catch {
        /* The API's freshness window treats an unavailable cycle as unknown. */
      }
      try {
        await delay(
          Math.max(1, NODE_MEMORY_INTERVAL_MS - (Date.now() - started)),
          undefined,
          { signal: this.options.signal },
        );
      } catch {
        return;
      }
    }
  }
}
