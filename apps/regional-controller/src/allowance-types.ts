// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";

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
}
export interface RuntimePatch {
  op: "test" | "add" | "replace";
  path: string;
  value: unknown;
}
export interface AllowanceRuntime {
  inventory(): Promise<RuntimeInventory>;
  patch(
    kind: "Cluster" | "ResourceQuota" | "Pooler",
    name: string,
    operations: RuntimePatch[],
  ): Promise<void>;
}
