// SPDX-License-Identifier: Apache-2.0
import type { UsageFact, UsageIdentity } from "./metering-types.ts";
export type UsageServerFailureCode =
  | "invalid_request"
  | "unauthorized"
  | "region_disabled"
  | "not_found"
  | "source_identity_conflict"
  | "usage_revision_conflict"
  | "correction_planner_unavailable"
  | "state_inconsistent";
export type UsageAcknowledgementCode =
  | "usage_acknowledgement_conflict"
  | "invalid_usage_response"
  | "usage_response_too_large";
export interface UsageFailureDescriptor {
  kind: "http" | "transport" | "acknowledgement" | "local_capacity";
  httpStatus: number | null;
  code:
    | UsageServerFailureCode
    | UsageAcknowledgementCode
    | "accepted_capacity_exceeded"
    | null;
}
export interface UsageDeliveryFailure extends UsageFailureDescriptor {
  at: string;
  factId: string;
  revision: 1;
  evidenceHash: string;
  identity: UsageIdentity;
  activationSupported: false;
}
const statuses: Record<UsageServerFailureCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  region_disabled: 403,
  not_found: 404,
  source_identity_conflict: 409,
  usage_revision_conflict: 409,
  correction_planner_unavailable: 503,
  state_inconsistent: 500,
};
const acknowledgementCodes: readonly UsageAcknowledgementCode[] = [
  "usage_acknowledgement_conflict",
  "invalid_usage_response",
  "usage_response_too_large",
];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const httpStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 100 &&
  value <= 599;
export function safeUsageServerCode(
  status: number,
  code: unknown,
): UsageServerFailureCode | null {
  return typeof code === "string" &&
    Object.hasOwn(statuses, code) &&
    statuses[code as UsageServerFailureCode] === status
    ? (code as UsageServerFailureCode)
    : null;
}
export function parseUsageErrorBody(
  status: number,
  body: string,
): UsageServerFailureCode | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!fields(value, ["error"]) || !fields(value.error, ["code"]))
      return null;
    const code = safeUsageServerCode(status, value.error.code);
    // Actual Worker error envelopes use these fixed ASCII names. Comparing the
    // complete envelope also refuses duplicate members or hidden extra fields.
    return code !== null &&
      body.replace(/[ \t\r\n]/g, "") === JSON.stringify({ error: { code } })
      ? code
      : null;
  } catch {
    return null;
  }
}
export class UsageDeliveryError extends Error {
  readonly status: number;
  readonly code: UsageServerFailureCode | null;
  constructor(status: number, code: unknown = null) {
    super("usage_http_failure");
    this.status = status;
    this.code = safeUsageServerCode(status, code);
  }
}
export class UsageTransportError extends Error {
  constructor() {
    super("usage_http_failure");
  }
}
export class UsageAcknowledgementError extends Error {
  readonly code: UsageAcknowledgementCode;
  readonly status: number | null;
  constructor(code: UsageAcknowledgementCode, status: number | null = null) {
    super(
      acknowledgementCodes.includes(code) ? code : "invalid_usage_response",
    );
    this.code = acknowledgementCodes.includes(code)
      ? code
      : "invalid_usage_response";
    this.status = status === 200 || status === 201 ? status : null;
  }
}
export function usageFailureDescriptor(
  failure: unknown,
): UsageFailureDescriptor | null {
  if (
    failure instanceof UsageDeliveryError &&
    httpStatus(failure.status) &&
    failure.status !== 200 &&
    failure.status !== 201
  )
    return {
      kind: "http",
      httpStatus: failure.status,
      code: safeUsageServerCode(failure.status, failure.code),
    };
  if (failure instanceof UsageAcknowledgementError)
    return {
      kind: "acknowledgement",
      httpStatus: failure.status,
      code: acknowledgementCodes.includes(failure.code)
        ? failure.code
        : "invalid_usage_response",
    };
  if (failure instanceof UsageTransportError)
    return { kind: "transport", httpStatus: null, code: null };
  return null;
}
function validDescriptor(value: unknown): value is UsageFailureDescriptor {
  if (!object(value)) return false;
  if (value.kind === "http")
    return (
      httpStatus(value.httpStatus) &&
      value.httpStatus !== 200 &&
      value.httpStatus !== 201 &&
      (value.code === null ||
        safeUsageServerCode(value.httpStatus, value.code) === value.code)
    );
  if (value.kind === "transport")
    return value.httpStatus === null && value.code === null;
  if (value.kind === "acknowledgement")
    return (
      (value.httpStatus === null ||
        value.httpStatus === 200 ||
        value.httpStatus === 201) &&
      acknowledgementCodes.includes(value.code as UsageAcknowledgementCode)
    );
  return (
    value.kind === "local_capacity" &&
    value.httpStatus === null &&
    value.code === "accepted_capacity_exceeded"
  );
}
export function validUsageDeliveryFailure(
  value: unknown,
  expected: UsageIdentity,
): value is UsageDeliveryFailure {
  if (
    !uuid.test(expected.regionId) ||
    !uuid.test(expected.sourceId) ||
    !Number.isSafeInteger(expected.sourceEpoch) ||
    expected.sourceEpoch < 1 ||
    !fields(value, [
      "kind",
      "httpStatus",
      "code",
      "at",
      "factId",
      "revision",
      "evidenceHash",
      "identity",
      "activationSupported",
    ]) ||
    !validDescriptor(value) ||
    typeof value.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) ||
    !Number.isFinite(Date.parse(value.at)) ||
    new Date(value.at).toISOString() !== value.at ||
    typeof value.factId !== "string" ||
    !uuid.test(value.factId) ||
    value.revision !== 1 ||
    typeof value.evidenceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.evidenceHash) ||
    value.activationSupported !== false ||
    !fields(value.identity, ["regionId", "sourceId", "sourceEpoch"])
  )
    return false;
  return (
    value.identity.regionId === expected.regionId &&
    value.identity.sourceId === expected.sourceId &&
    value.identity.sourceEpoch === expected.sourceEpoch
  );
}
export function deliveryFailureRecord(
  fact: UsageFact,
  descriptor: UsageFailureDescriptor,
  identity: UsageIdentity,
  at: string,
): UsageDeliveryFailure {
  if (
    !fields(descriptor, ["kind", "httpStatus", "code"]) ||
    !validDescriptor(descriptor)
  )
    throw new Error("invalid_delivery_failure");
  const result: UsageDeliveryFailure = {
    ...descriptor,
    at,
    factId: fact.factId,
    revision: 1,
    evidenceHash: fact.evidenceHash,
    identity: { ...identity },
    activationSupported: false,
  };
  if (!validUsageDeliveryFailure(result, identity))
    throw new Error("invalid_delivery_failure");
  return result;
}
