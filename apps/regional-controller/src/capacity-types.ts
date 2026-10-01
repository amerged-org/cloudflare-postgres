// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";
import type { PodRetirementBinding } from "./pod-retirement.ts";

export const CAPACITY_OPERATION = "pgcf.io/capacity-operation-id";
export const CAPACITY_SLOT = "pgcf.io/capacity-slot";
export const CAPACITY_NAMESPACE_UID = "pgcf.io/capacity-namespace-uid";
export const CAPACITY_ATTEMPT = "pgcf.io/capacity-admission-attempt";
export const CAPACITY_NODE_UID =
  "pgcf.io.node-restriction.kubernetes.io/capacity-node-uid";
export const RESERVATION_AFFINITY =
  "scheduling.koordinator.sh/reservation-affinity";
export const RESERVATION_ALLOCATED =
  "scheduling.koordinator.sh/reservation-allocated";
export const RESERVATION_IGNORED =
  "scheduling.koordinator.sh/reservation-ignored";
export const RESERVATION_RESTRICTED_OPTIONS =
  "scheduling.koordinator.sh/reservation-restricted-options";

export interface CapacityBinding {
  installationId: string;
  regionId: string;
  operationId: string;
  environmentId: string;
  specRevision: 1;
  specHash: string;
  runEpoch: string | null;
}
export interface CapacityRef {
  name: string;
  namespace: string;
  uid: string;
  resourceVersion: string;
}
export interface CapacityNode {
  name: string;
  uid: string;
  bootId: string;
  topologyKey: "openebs.io/nodename";
  topologyValue: string;
  vgUuid: string | null;
}
export interface CapacitySlotPlan {
  id: string;
  kind: "database" | "pooler";
  maintenance: boolean;
  reservationName: string;
  holdPvcName: string | null;
  cpuMilli: number;
  memoryBytes: string;
  cpuLimitMilli: number;
  memoryLimitBytes: string;
  volumeBytes: string | null;
}
export interface CapacityPlan {
  version: 1;
  binding: CapacityBinding;
  namespace: string;
  customerStorageClass: string;
  holdNamespace: string;
  holdStorageClassPrefix: string;
  instances: number;
  slots: CapacitySlotPlan[];
}
export interface CapacityStorage {
  holdPvc: CapacityRef;
  pv: CapacityRef;
  lvmVolume: CapacityRef;
  csiHandle: string;
  bytes: string;
  storageClassName: string;
}
export interface CapacityConsumer {
  uid: string;
  name: string;
  namespace: string;
  nodeUid: string;
  specHash: string;
  ownerChain?: { kind: string; name: string; uid: string }[];
}
export interface CapacityAdmissionAttempt {
  id: string;
  slotId: string;
  name: string;
  namespace: string;
  podUid: string | null;
}
export interface CapacityHandoff {
  operator: string;
  targetPvc: CapacityRef;
  oldClaimRef: Record<string, unknown>;
  newClaimRef: Record<string, unknown>;
}
export interface CapacitySlotState {
  plan: CapacitySlotPlan;
  reservation: CapacityRef | null;
  holdPvc: CapacityRef | null;
  pv: CapacityRef | null;
  lvmVolume: CapacityRef | null;
  node: CapacityNode | null;
  storage: CapacityStorage | null;
  targetPvc: CapacityRef | null;
  handoff: CapacityHandoff | null;
  handoffPhase: "none" | "intent" | "hold_released" | "rebound";
  consumers: CapacityConsumer[];
  retirements: {
    podUid: string;
    proofHash: string;
    scopeHash: string;
    ownerKind: string;
    ownerUid: string;
    successorAttemptId: string | null;
  }[];
  computeReleased: boolean;
}
export interface CapacityPodQuotaGate {
  binding: CapacityBinding;
  namespaceUid: string;
  clusterUid: string;
  quota: CapacityRef;
  closedSpec: Record<string, unknown>;
  openSpec: Record<string, unknown>;
  phase: "opening" | "applied" | "open";
  appliedResourceVersion: string | null;
  confirmedResourceVersion: string | null;
}
export interface CapacitySnapshot {
  version: 2;
  revision: number;
  plan: CapacityPlan;
  phase:
    | "pending"
    | "available"
    | "materializing"
    | "active"
    | "releasing"
    | "released";
  namespaceUid: string | null;
  clusterUid: string | null;
  poolerUid: string | null;
  quotaUid: string | null;
  podQuotaGate: CapacityPodQuotaGate | null;
  nodeCohort: { uid: string; hash: string } | null;
  poolerDeploymentUid: string | null;
  retirementBindings: { podUid: string; binding: PodRetirementBinding }[];
  projectId: string | null;
  organizationId: string | null;
  slots: CapacitySlotState[];
  attempts: CapacityAdmissionAttempt[];
}
export interface CapacityConfiguration {
  version: 1;
  installationId: string;
  namespace: string;
  journalDirectory: string;
  schedulerName: "koord-scheduler";
  holdStorageClassPrefix: string;
  allowedNodes: { name: string; uid: string }[];
  storageNamespace: string;
  // Installation-owned permanent headroom, sealed by exact UID. Customer
  // acquisition never creates, consumes or releases these reservations.
  platformReservations: {
    nodeName: string;
    nodeUid: string;
    name: string;
    uid: string;
  }[];
  platformMargin: { cpuMilli: number; memoryMiB: number; podSlots: number };
  admission: {
    apiServerIdentity: string;
    jobUsername: string;
    replicaSetUsername: string;
    approvedImages: string[];
    mutatingConfiguration: string;
    validatingConfiguration: string;
    serviceNamespace: string;
    serviceName: string;
    operatorUsername: string;
    schedulerUsername: string;
    cnpgUsername: string;
  };
  schedulerDeployment: { namespace: string; name: string; image: string };
}
export interface CapacityPatch {
  op: "test" | "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}
export interface CapacityRuntime {
  read(kind: string, namespace: string, name: string): Promise<Resource | null>;
  list(kind: string, namespace?: string): Promise<Resource[]>;
  create(
    resource: Resource,
    dispatchAuthority?: { check: () => void; expiresAt: () => number },
  ): Promise<Resource>;
  patch(
    kind: string,
    namespace: string,
    name: string,
    operations: CapacityPatch[],
    dispatchAuthority?: { check: () => void; expiresAt: () => number },
  ): Promise<Resource>;
  remove(
    kind: string,
    namespace: string,
    name: string,
    uid: string,
    resourceVersion: string,
    dispatchAuthority?: { check: () => void; expiresAt: () => number },
  ): Promise<void>;
}
