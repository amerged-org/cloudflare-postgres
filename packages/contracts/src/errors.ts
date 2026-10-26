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
  "service_unavailable",
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
  service_unavailable: 503,
  rate_limited: 429,
  internal: 500,
} as const satisfies Record<ErrorCode, number>;

export const ERROR_MESSAGE_MAX_LENGTH = 4096;

/**
 * Why a request was refused where one code stands for several causes. A reason is stable across
 * releases and is what a client switches on; the message is for people and may change.
 *
 * Reasons that clear without any change to the request. The value is the seconds the `Retry-After`
 * header advises: a hint to wait, not a promise that the next attempt succeeds.
 */
export const RETRYABLE_ERROR_REASONS = {
  /** Another change to the same database holds it for the moment. */
  mutation_in_progress: 1,
  /** The database, or what a create or restore was based on, changed under the request. */
  generation_changed: 1,
  /** The database still applies an earlier change or has not started. */
  not_ready: 5,
  /** The node lacks memory, CPU or storage for the change or the start now. */
  node_capacity: 30,
} as const;
/** Repeating the same request cannot clear these: the request or the resource has to change. */
export const TERMINAL_ERROR_REASONS = [
  "name_in_use",
  "database_deleted",
  "project_not_empty",
  "role_exists",
  "role_limit",
  "role_being_deleted",
  "role_has_members",
  "archive_expired",
  "archive_unusable",
  "no_recovery_point",
  "source_unavailable",
  "region_unavailable",
] as const;
export type RetryableErrorReason = keyof typeof RETRYABLE_ERROR_REASONS;
export const ERROR_REASONS = [
  "mutation_in_progress",
  "generation_changed",
  "not_ready",
  "node_capacity",
  ...TERMINAL_ERROR_REASONS,
] as const satisfies readonly (
  RetryableErrorReason | (typeof TERMINAL_ERROR_REASONS)[number]
)[];
export const ErrorReason = z.enum(ERROR_REASONS).meta({
  id: "ErrorReason",
  description:
    "Stable cause of a refusal. Retryable: mutation_in_progress, generation_changed, not_ready, node_capacity; these answers carry a Retry-After header. Terminal: name_in_use, database_deleted, project_not_empty, role_exists, role_limit, role_being_deleted, role_has_members, archive_expired, archive_unusable, no_recovery_point, source_unavailable, region_unavailable.",
});
export type ErrorReason = z.infer<typeof ErrorReason>;

/** `reason` is the stable cause; any other key is context of the one route that sets it. */
export const ErrorDetails = z
  .looseObject({ reason: ErrorReason.optional() })
  .meta({ id: "ErrorDetails" });
export type ErrorDetails = z.infer<typeof ErrorDetails>;

/**
 * Seconds a client should wait before it repeats a refused request, or undefined when repeating the
 * same request cannot succeed. A `conflict` without a reason carries no advice.
 */
export function retryAfterSeconds(
  code: ErrorCode,
  reason?: ErrorReason,
): number | undefined {
  if (reason !== undefined && reason in RETRYABLE_ERROR_REASONS)
    return RETRYABLE_ERROR_REASONS[reason as RetryableErrorReason];
  if (code === "capacity_exhausted")
    return RETRYABLE_ERROR_REASONS.node_capacity;
  if (code === "service_unavailable") return 60;
  if (code === "idempotency_in_progress") return 1;
  return undefined;
}

export const ErrorBody = z
  .strictObject({
    error: z.strictObject({
      code: ErrorCode,
      message: z.string().max(ERROR_MESSAGE_MAX_LENGTH),
      request_id: z.string().min(1).max(128),
      details: ErrorDetails.optional(),
    }),
  })
  .meta({
    id: "Error",
    examples: [
      {
        error: {
          code: "conflict",
          message: "Database admission mutation is in progress",
          request_id: "5b0c1c0e-6a4b-4f5b-9a55-3f2b7c3b9f10",
          details: { reason: "mutation_in_progress" },
        },
      },
    ],
  });
export type ErrorBody = z.infer<typeof ErrorBody>;

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetails,
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
