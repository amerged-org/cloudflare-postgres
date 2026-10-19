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
