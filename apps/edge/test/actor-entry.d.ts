// SPDX-License-Identifier: Apache-2.0
export function seedKnownDatabase(
  db: D1Database,
  namespace: object,
  id: string,
): Promise<void>;

export function publishPowerObservation(
  env: object,
  ctx: ExecutionContext,
  database: string,
  revision: number,
  operation: string,
  state: "awake" | "hibernated",
): Promise<Response>;
