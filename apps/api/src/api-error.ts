// SPDX-License-Identifier: Apache-2.0
import type { ErrorCode, ErrorDetails } from "@pgcf/contracts";

/** In its own module so that code which only throws it does not evaluate the router (app.ts). */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

/** The platform's own words for the conditions that make a request fail without a defect of ours. Only these
 * exact phrases are ever named; any other exception text may carry request data and stays out of the logs. */
const PLATFORM_FAILURES = [
  "D1 DB is overloaded. Requests queued for too long.",
  "D1 DB storage operation exceeded timeout which caused object to be reset.",
  "Network connection lost.",
  "Durable Object reset because its code was updated.",
  "Durable Object storage operation exceeded timeout which caused object to be reset.",
  "Cannot resolve Durable Object due to transient issue on remote node.",
  "Worker exceeded CPU time limit.",
  "Worker exceeded memory limit.",
] as const;

export function failureCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return PLATFORM_FAILURES.find((phrase) => error.message.includes(phrase));
}
