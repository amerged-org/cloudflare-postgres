// SPDX-License-Identifier: Apache-2.0
import type {
  AcceptedUsageReceipt,
  UsageFact,
  UsageIdentity,
} from "./metering-types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const quantity = /^(?:0|[1-9][0-9]{0,77})$/;
export const usageFactFields = [
  "factId",
  "environmentId",
  "sourceId",
  "sourceEpoch",
  "revision",
  "expectedPreviousRevision",
  "metric",
  "attribution",
  "start",
  "end",
  "quantity",
  "status",
  "evidenceHash",
] as const;
const receiptFields = [
  "fact",
  "regionId",
  "organizationId",
  "projectId",
  "acceptanceSequence",
  "acceptedAt",
] as const;

function fields(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function utcMilliseconds(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isSafeInteger(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

export function validUsageFact(
  value: unknown,
  identity?: UsageIdentity,
): value is UsageFact {
  if (!fields(value, usageFactFields)) return false;
  if (!utcMilliseconds(value.start) || !utcMilliseconds(value.end))
    return false;
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  return (
    ["factId", "environmentId", "sourceId"].every(
      (key) => typeof value[key] === "string" && uuid.test(value[key]),
    ) &&
    Number.isSafeInteger(value.sourceEpoch) &&
    Number(value.sourceEpoch) > 0 &&
    (!identity ||
      (value.sourceId === identity.sourceId &&
        value.sourceEpoch === identity.sourceEpoch)) &&
    value.revision === 1 &&
    value.expectedPreviousRevision === 0 &&
    typeof value.metric === "string" &&
    ["cpu_millicore_ms", "memory_byte_ms", "data_storage_byte_ms"].includes(
      value.metric,
    ) &&
    typeof value.attribution === "string" &&
    ["primary", "replica", "backup", "wal", "platform"].includes(
      value.attribution,
    ) &&
    end > start &&
    end - start <= 60_000 &&
    Math.floor(start / 60_000) === Math.floor((end - 1) / 60_000) &&
    typeof value.evidenceHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.evidenceHash) &&
    ((value.status === "gap" && value.quantity === null) ||
      (value.status === "provisional" &&
        typeof value.quantity === "string" &&
        quantity.test(value.quantity)))
  );
}

export function validAcceptedUsageReceipt(
  value: unknown,
  identity?: UsageIdentity,
): value is AcceptedUsageReceipt {
  return (
    fields(value, receiptFields) &&
    validUsageFact(value.fact, identity) &&
    ["regionId", "organizationId", "projectId"].every(
      (key) => typeof value[key] === "string" && uuid.test(value[key]),
    ) &&
    (!identity || value.regionId === identity.regionId) &&
    typeof value.acceptanceSequence === "string" &&
    /^[1-9][0-9]{0,18}$/.test(value.acceptanceSequence) &&
    utcMilliseconds(value.acceptedAt)
  );
}

export function normalizeAcceptedUsageReceipt(
  value: unknown,
  identity?: UsageIdentity,
): AcceptedUsageReceipt {
  if (!validAcceptedUsageReceipt(value, identity))
    throw new Error("invalid_accepted_usage_receipt");
  return {
    fact: Object.fromEntries(
      usageFactFields.map((field) => [field, value.fact[field]]),
    ) as unknown as UsageFact,
    regionId: value.regionId,
    organizationId: value.organizationId,
    projectId: value.projectId,
    acceptanceSequence: value.acceptanceSequence,
    acceptedAt: value.acceptedAt,
  };
}
