// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";

export interface MaintenancePlan {
  schemaVersion: 1;
  kind: "kubernetes.upgrade";
  clusterUid: string;
  nodeUids: string[];
  fromVersion: string;
  toVersion: string;
  talosVersion: string;
  toolImage: string;
  targetArtifactsHash: string;
}
export interface MaintenanceClaim {
  operationId: string;
  regionId: string;
  plan: MaintenancePlan;
  planHash: string;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
}
export interface MaintenanceEvidence {
  status: "verified" | "missing" | "failed";
  planHash: string;
  observedAt: number;
  expiresAt: number;
  evidenceHash: string;
}
export interface MaintenanceSnapshot {
  complete: boolean;
  observedAt: number;
  regionId: string;
  clusterUid: string;
  targetNodeUid: string;
  machineIdentity: MaintenanceEvidence | null;
  nodes: { uid: string; ready: boolean; kubernetesVersion: string }[];
  etcd: {
    observedAt: number;
    expiresAt: number;
    evidenceHash: string;
    voters: { memberId: string; nodeUid: string; healthy: boolean }[];
  } | null;
  databases: {
    uid: string;
    primaryNodeUid: string;
    readyInstanceNodeUids: string[];
    switchoverVerified: boolean;
    pdbAllowsDisruption: boolean;
    volumeBindingsStable: boolean;
  }[];
  recovery: MaintenanceEvidence | null;
  staging: MaintenanceEvidence | null;
  capacity:
    | (MaintenanceEvidence & {
        scope: "sequential-plan";
        reservationId: string;
        nodeUids: string[];
      })
    | null;
}
export const maintenanceBlockers = [
  "inventory_incomplete",
  "identity_changed",
  "quorum_unproven",
  "database_availability_unproven",
  "recovery_unproven",
  "capacity_unreserved",
  "staging_unqualified",
  "evidence_stale",
  "dry_run_failed",
  "dry_run_unproven",
] as const;
export type MaintenanceBlocker = (typeof maintenanceBlockers)[number];
export interface MaintenanceAssessment {
  observedAt: string;
  expiresAt: string;
  evidenceHash: string;
  blockers: MaintenanceBlocker[];
  dryRun: { status: "not_run" | "succeeded" | "failed"; jobUid: string | null };
}
export interface MaintenancePreparationResult {
  status: "blocked" | "eligible" | "pending";
  assessment: MaintenanceAssessment;
}
export interface MaintenanceContext {
  namespace: string;
  talosconfigSecret: string;
  endpoints: string[];
  now(): number;
  leaseValid(): Promise<boolean>;
}
export interface MaintenanceJobs {
  readJob(name: string): Promise<Resource | null>;
  createJob(job: Resource): Promise<Resource>;
}
