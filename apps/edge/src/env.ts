// SPDX-License-Identifier: Apache-2.0
export interface Env {
  readonly DB: D1Database;
  readonly CONNECTION_RATE_LIMITER: RateLimit;
  readonly DATABASE_CONNECTION_RATE_LIMITER: RateLimit;
  readonly ROUTE_MASTER_KEYS: string;
  readonly [binding: string]: unknown;
}
