// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "capacity_exhausted",
  "rate_limited",
  "internal",
] as const;

export const ErrorCode = z.enum(ERROR_CODES).meta({ id: "ErrorCode" });
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ERROR_HTTP_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  capacity_exhausted: 503,
  rate_limited: 429,
  internal: 500,
} as const satisfies Record<ErrorCode, number>;

export const ERROR_MESSAGE_MAX_LENGTH = 4096;

export const ErrorBody = z
  .strictObject({
    error: z.strictObject({
      code: ErrorCode,
      message: z.string().max(ERROR_MESSAGE_MAX_LENGTH),
      request_id: z.string().min(1).max(128),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .meta({ id: "Error" });
export type ErrorBody = z.infer<typeof ErrorBody>;

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorBody {
  const error: ErrorBody["error"] = {
    code,
    message: message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
    request_id: requestId,
  };
  if (details !== undefined) error.details = details;
  return { error };
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}
