// SPDX-License-Identifier: Apache-2.0
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { MaintenanceClient } from "./maintenance-client.ts";
import { maintenanceKubernetesFromConfig } from "./maintenance-kubernetes.ts";
import type { MaintenanceOperatorConfiguration } from "./maintenance-kubernetes.ts";
import { prepareMaintenance } from "./maintenance.ts";
import { applyFleetInspection } from "./fleet-inspection.ts";
import {
  collectFleet,
  fleetOperatorConfiguration,
} from "./fleet-inspection-cli.ts";
import type {
  MaintenanceEvidence,
  MaintenanceSnapshot,
} from "./maintenance-types.ts";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("maintenance_configuration_missing");
  return value;
}
function evidence(value: unknown): MaintenanceEvidence | null {
  const input = object(value);
  if (
    !["verified", "missing", "failed"].includes(String(input.status)) ||
    typeof input.planHash !== "string" ||
    !hash.test(input.planHash) ||
    typeof input.evidenceHash !== "string" ||
    !hash.test(input.evidenceHash) ||
    !Number.isSafeInteger(input.observedAt) ||
    !Number.isSafeInteger(input.expiresAt)
  )
    return null;
  return {
    status: input.status as MaintenanceEvidence["status"],
    planHash: input.planHash,
    evidenceHash: input.evidenceHash,
    observedAt: Number(input.observedAt),
    expiresAt: Number(input.expiresAt),
  };
}
function operatorConfiguration(
  value: unknown,
): MaintenanceOperatorConfiguration {
  const input = object(value),
    supplied = object(input.evidence);
  if (
    input.schemaVersion !== 1 ||
    ![
      "kubeconfigFile",
      "kubeconfigContext",
      "namespace",
      "talosconfigSecret",
      "targetNodeUid",
    ].every(
      (key) => typeof input[key] === "string" && String(input[key]).length > 0,
    ) ||
    !isAbsolute(String(input.kubeconfigFile)) ||
    !uuid.test(String(input.targetNodeUid)) ||
    !Array.isArray(input.endpoints) ||
    input.endpoints.length === 0 ||
    input.endpoints.length > 16 ||
    !input.endpoints.every((endpoint) => typeof endpoint === "string")
  )
    throw new Error("maintenance_operator_configuration_invalid");
  const certificate = object(supplied.etcd);
  const voters = Array.isArray(certificate.voters) ? certificate.voters : [];
  const etcd =
    typeof certificate.planHash === "string" &&
    hash.test(certificate.planHash) &&
    typeof certificate.evidenceHash === "string" &&
    hash.test(certificate.evidenceHash) &&
    Number.isSafeInteger(certificate.observedAt) &&
    Number.isSafeInteger(certificate.expiresAt) &&
    voters.length > 0 &&
    voters.length <= 256 &&
    voters.every((value) => {
      const voter = object(value);
      return (
        typeof voter.memberId === "string" &&
        typeof voter.nodeUid === "string" &&
        uuid.test(voter.nodeUid) &&
        typeof voter.healthy === "boolean"
      );
    })
      ? {
          planHash: certificate.planHash,
          evidenceHash: certificate.evidenceHash,
          observedAt: Number(certificate.observedAt),
          expiresAt: Number(certificate.expiresAt),
          voters: voters.map((value) => {
            const voter = object(value);
            return {
              memberId: String(voter.memberId),
              nodeUid: String(voter.nodeUid),
              healthy: voter.healthy === true,
            };
          }),
        }
      : null;
  const reservation = object(supplied.capacity),
    base = evidence(reservation);
  const capacity =
    base &&
    reservation.scope === "sequential-plan" &&
    typeof reservation.reservationId === "string" &&
    uuid.test(reservation.reservationId) &&
    Array.isArray(reservation.nodeUids) &&
    reservation.nodeUids.length > 0 &&
    reservation.nodeUids.length <= 256 &&
    reservation.nodeUids.every(
      (uid) => typeof uid === "string" && uuid.test(uid),
    )
      ? {
          ...base,
          scope: "sequential-plan" as const,
          reservationId: reservation.reservationId,
          nodeUids: reservation.nodeUids as string[],
        }
      : null;
  const databases = Array.isArray(supplied.databases) ? supplied.databases : [];
  if (
    databases.length > 256 ||
    !databases.every(
      (value) =>
        typeof object(value).uid === "string" &&
        uuid.test(String(object(value).uid)),
    )
  )
    throw new Error("maintenance_database_evidence_invalid");
  return {
    schemaVersion: 1,
    kubeconfigFile: String(input.kubeconfigFile),
    kubeconfigContext: String(input.kubeconfigContext),
    namespace: String(input.namespace),
    talosconfigSecret: String(input.talosconfigSecret),
    targetNodeUid: String(input.targetNodeUid),
    ...(input.fleetInventory === undefined
      ? {}
      : { fleetInventory: fleetOperatorConfiguration(input.fleetInventory) }),
    endpoints: input.endpoints as string[],
    evidence: {
      machineIdentity: evidence(supplied.machineIdentity),
      etcd,
      recovery: evidence(supplied.recovery),
      staging: evidence(supplied.staging),
      capacity,
      databases: databases.map((value) => {
        const database = object(value);
        return {
          uid: String(database.uid),
          switchover: evidence(database.switchover),
          volumes: evidence(database.volumes),
        };
      }),
    },
  };
}

export async function runMaintenancePreparation(
  arguments_: string[],
): Promise<number> {
  try {
    if (
      arguments_.length !== 2 ||
      arguments_[0] !== "--config" ||
      !arguments_[1] ||
      !isAbsolute(arguments_[1])
    )
      throw new Error("maintenance_arguments_invalid");
    const size = await stat(arguments_[1]);
    if (!size.isFile() || size.size > 262_144)
      throw new Error("maintenance_operator_configuration_bound");
    // Load explicit operator input before claiming work or starting the normal
    // environment controller and metering services.
    const operator = operatorConfiguration(
      JSON.parse(await readFile(arguments_[1], "utf8")),
    );
    const regionId = required("PGCF_REGION_ID");
    const tokenFile = required("PGCF_MAINTENANCE_TOKEN_FILE");
    const client = new MaintenanceClient(
      required("PGCF_CONTROL_ORIGIN"),
      regionId,
      async () => (await readFile(tokenFile, "utf8")).trim(),
    );
    const api = maintenanceKubernetesFromConfig(
      operator.kubeconfigFile,
      operator.kubeconfigContext,
      operator.namespace,
    );
    const claim = await client.claim(90);
    if (!claim) {
      process.stdout.write(
        `${JSON.stringify({ mode: "maintenance-preparation", status: "no_work", executionAuthorized: false })}\n`,
      );
      return 0;
    }
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await api.snapshot(claim, operator);
      if (operator.fleetInventory)
        snapshot = applyFleetInspection(
          snapshot,
          await collectFleet(operator.fleetInventory),
        );
    } catch {
      snapshot = {
        complete: false,
        observedAt: Date.now(),
        regionId,
        clusterUid: "",
        targetNodeUid: operator.targetNodeUid,
        machineIdentity: null,
        nodes: [],
        etcd: null,
        databases: [],
        recovery: null,
        staging: null,
        capacity: null,
      };
    }
    const result = await prepareMaintenance(
      claim,
      snapshot,
      {
        namespace: operator.namespace,
        talosconfigSecret: operator.talosconfigSecret,
        endpoints: operator.endpoints,
        now: Date.now,
        leaseValid: async () => {
          claim.leaseExpiresAt = await client.renew(claim, 90);
          return Date.parse(claim.leaseExpiresAt) > Date.now() + 5_000;
        },
      },
      api,
    );
    if (result.status !== "pending")
      await client.result(claim, result.assessment);
    process.stdout.write(
      `${JSON.stringify({ mode: "maintenance-preparation", status: result.status, assessment: result.assessment, executionSupported: false, executionAuthorized: false })}\n`,
    );
    return result.status === "eligible"
      ? 0
      : result.status === "pending"
        ? 0
        : 1;
  } catch {
    // No raw tool/API errors, resource inventory, endpoints or credentials.
    process.stdout.write(
      `${JSON.stringify({ mode: "maintenance-preparation", status: "deferred", error: { code: "maintenance_preparation_failed" }, executionSupported: false, executionAuthorized: false })}\n`,
    );
    return 2;
  }
}
