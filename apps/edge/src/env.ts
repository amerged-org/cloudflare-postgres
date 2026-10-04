// SPDX-License-Identifier: Apache-2.0
import type { GatewayRegion } from "./gateway.ts";

export type DatabaseAdmission =
  | { ok: true; region: GatewayRegion }
  | { ok: false; sqlstate: "3D000" | "28P01" | "57P03" | "08006" };

export interface DatabaseActorNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    ensureAwake(
      databaseId: string,
      user: string,
      options: { deadline: number; waiterId: string },
    ): Promise<DatabaseAdmission>;
    cancelWakeWaiter(databaseId: string, waiterId: string): Promise<boolean>;
  };
}

export interface Env {
  readonly DATABASE_ACTOR: DatabaseActorNamespace;
  readonly CONNECTION_RATE_LIMITER: RateLimit;
  readonly DATABASE_CONNECTION_RATE_LIMITER: RateLimit;
  readonly ROUTE_MASTER_KEYS: string;
  readonly [binding: string]: unknown;
}
