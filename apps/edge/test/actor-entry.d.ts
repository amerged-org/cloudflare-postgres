// SPDX-License-Identifier: Apache-2.0
export function seedKnownDatabase(
  db: D1Database,
  namespace: object,
  id: string,
): Promise<void>;

export function seedFixtureDatabase(
  db: D1Database,
  namespace: object,
  fixture: {
    region: string;
    gatewayUrl: string;
    gatewayBinding: string | null;
  },
): Promise<string>;

export function createUnrelatedRole(
  env: object,
  ctx: ExecutionContext,
  database: string,
): Promise<Response>;

export function publishPowerObservation(
  env: object,
  ctx: ExecutionContext,
  database: string,
  revision: number,
  operation: string,
  state: "awake" | "hibernated",
): Promise<Response>;
