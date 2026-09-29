// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";
import type { NodeCohortPointer } from "./node-cohort.ts";
import type { NodeObserverResult } from "./node-observer.ts";
import type {
  PodRetirementProof,
  PodRetirementRecord,
} from "./pod-retirement.ts";

export type AllowanceUnits = Record<string, string>;
export interface RuntimeBinding {
  regionId: string;
  environmentId: string;
  projectId: string;
  specRevision: number;
  specHash: string;
  namespace: string;
  namespaceUid: string;
  clusterUid: string;
  quotaUid: string;
  runEpoch?: string;
  nodeCohort?: NodeCohortPointer;
  pooler?: { uid: string; deploymentUid: string };
}
export interface AllowanceRequest {
  requestId: string;
  environmentId: string;
  leaseSeconds: number;
  units: AllowanceUnits;
}
export interface AllowanceReceipt {
  id: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  epoch: string;
  revision: string;
  units: AllowanceUnits;
  issuedAt: string;
  expiresAt: string;
  status: "issued" | "settled";
  gapCount: string;
  stoppedAt: string | null;
  fenceToken: string;
  runtimeEnforced: false;
  enforcementStatus: "pending_runtime";
}
export interface RuntimeAuthority {
  schemaVersion: 1;
  reservationId: string;
  environmentId: string;
  regionId: string;
  projectId: string;
  specRevision: number;
  specHash: string;
  epoch: string;
  decision: "allow" | "stop";
  reason: string;
  observedAt: string;
  validUntil: string;
  units: AllowanceUnits;
  limitedMetrics: string[];
  bindings: {
    targetId: string;
    revision: string;
    executionEpoch: string;
    accountId: string;
    periodStart: string;
    periodEnd: string;
    requestedState: "running" | "paused";
  }[];
  evidenceHash: string;
  runtimeEnforced: false;
  enforcementStatus: "pending_runtime";
}
export interface AllowanceTransport {
  reserve(request: AllowanceRequest): Promise<AllowanceReceipt>;
  authority(receiptId: string): Promise<RuntimeAuthority>;
}
export interface RuntimeInventory {
  namespace: Resource;
  cluster: Resource;
  quota: Resource;
  pods: Resource[];
  pvcs: Resource[];
  pvs: Resource[];
  poolers?: Resource[];
  deployments?: Resource[];
  nodeCohort?: Resource | null;
  nodes?: Resource[];
  jobs?: Resource[];
  replicaSets?: Resource[];
}
export interface RuntimePatch {
  op: "test" | "add" | "replace";
  path: string;
  value: unknown;
}
export interface AllowanceRuntime {
  observeNode?(nodeName: string): Promise<NodeObserverResult>;
  retainPod?(record: PodRetirementRecord, finalizer: string): Promise<void>;
  releasePod?(
    record: PodRetirementRecord,
    finalizer: string,
    proof: PodRetirementProof,
  ): Promise<void>;
  inventory(): Promise<RuntimeInventory>;
  patch(
    kind: "Cluster" | "ResourceQuota" | "Pooler",
    name: string,
    operations: RuntimePatch[],
  ): Promise<void>;
}
