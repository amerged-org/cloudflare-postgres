// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";

export type MeterMetric =
  "cpu_millicore_ms" | "memory_byte_ms" | "data_storage_byte_ms";
export type Attribution = "primary" | "replica" | "backup" | "wal" | "platform";

export interface AllocationContinuity {
  version: 1;
  hash: string;
}

export interface Allocation {
  key: string;
  environmentId: string;
  specHash: string;
  resourceUid: string;
  metric: MeterMetric;
  attribution: Attribution;
  // Exact effective request/capacity units per millisecond, not utilization.
  rate: string;
  // Optional only when reading checkpoints written before continuity proofs.
  continuity?: AllocationContinuity;
  evidenceHash: string;
}
export interface ObservationIssue {
  key?: string;
  environmentId?: string;
  metric?: MeterMetric;
  attribution?: Attribution;
  code: string;
}
export interface RetainedVolumeBinding {
  environmentId: string;
  regionId: string;
  specHash: string;
  namespace: string;
  namespaceUid: string;
  clusterUid: string;
  pvcName: string;
  pvcUid: string;
  pvName: string;
  pvUid: string;
  storageClass: string;
  attribution: Attribution;
}
export interface MeteringInventory {
  namespaces: Resource[];
  clusters: Resource[];
  pods: Resource[];
  // Legacy journals/fixtures may omit these; the SDK always collects complete
  // namespace-bounded owner inventories before a Pooler allocation is proven.
  poolers?: Resource[];
  deployments?: Resource[];
  replicaSets?: Resource[];
  pvcs: Resource[];
  pvs: Resource[];
}
export interface ObservationResult {
  allocations: Allocation[];
  issues: ObservationIssue[];
  volumeBindings: RetainedVolumeBinding[];
}
export interface AllocationSnapshot extends ObservationResult {
  observedAt: number;
  complete: boolean;
}
export interface UsageIdentity {
  regionId: string;
  sourceId: string;
  sourceEpoch: number;
}
export interface UsageFact {
  factId: string;
  environmentId: string;
  sourceId: string;
  sourceEpoch: number;
  revision: 1;
  expectedPreviousRevision: 0;
  metric: MeterMetric;
  attribution: Attribution;
  start: string;
  end: string;
  quantity: string | null;
  status: "provisional" | "gap";
  evidenceHash: string;
}
