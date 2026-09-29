// SPDX-License-Identifier: Apache-2.0
import type { RuntimeBinding } from "./allowance-types.ts";

export interface SuspendClaim {
  schemaVersion: 1;
  kind: "environment.suspend";
  operationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  runtimeRevision: number;
  clusterUid: string;
  pooler: { uid: string; deploymentUid: string } | null;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
}
export interface SuspendObservation {
  namespaceUid: string;
  clusterUid: string;
  quotaUid: string;
  volumesHash: string;
  pooler: { uid: string; deploymentUid: string } | null;
  computeAbsent: true;
  quotaPodsZero: true;
  clusterHibernated: true;
  poolerStopped: true;
}
export interface SuspendSeal {
  binding: RuntimeBinding;
  volumesHash: string;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function validSuspendClaim(value: unknown): value is SuspendClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const claim = value as Record<string, unknown>;
  return (
    claim.schemaVersion === 1 &&
    claim.kind === "environment.suspend" &&
    [
      "operationId",
      "organizationId",
      "projectId",
      "environmentId",
      "regionId",
      "clusterUid",
    ].every((key) => typeof claim[key] === "string" && uuid.test(claim[key])) &&
    Number.isSafeInteger(claim.specRevision) &&
    Number(claim.specRevision) > 0 &&
    typeof claim.specHash === "string" &&
    /^[a-f0-9]{64}$/.test(claim.specHash) &&
    Number.isSafeInteger(claim.runtimeRevision) &&
    Number(claim.runtimeRevision) > 0 &&
    (claim.pooler === null ||
      (claim.pooler !== null &&
        typeof claim.pooler === "object" &&
        !Array.isArray(claim.pooler) &&
        Object.keys(claim.pooler).length === 2 &&
        typeof (claim.pooler as Record<string, unknown>).uid === "string" &&
        uuid.test((claim.pooler as Record<string, unknown>).uid as string) &&
        typeof (claim.pooler as Record<string, unknown>).deploymentUid ===
          "string" &&
        uuid.test(
          (claim.pooler as Record<string, unknown>).deploymentUid as string,
        ))) &&
    typeof claim.leaseToken === "string" &&
    /^cplease_[A-Za-z0-9_-]{43}$/.test(claim.leaseToken) &&
    Number.isSafeInteger(claim.leaseEpoch) &&
    Number(claim.leaseEpoch) > 0 &&
    typeof claim.leaseExpiresAt === "string" &&
    Number.isFinite(Date.parse(claim.leaseExpiresAt))
  );
}
