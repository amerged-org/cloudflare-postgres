// SPDX-License-Identifier: Apache-2.0
export function seedKnownDatabase(env: object, id: string): Promise<void>;

export function createUnrelatedRole(
  env: object,
  ctx: ExecutionContext,
  database: string,
): Promise<Response>;

export function publishPowerObservation(
  env: object,
  ctx: ExecutionContext,
  node: { id: string; uid: string; key: CryptoKey },
  database: string,
  revision: number,
  operation: string,
  state: "awake" | "hibernated",
): Promise<Response>;
