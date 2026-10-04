// SPDX-License-Identifier: Apache-2.0
import type { GatewayRegion } from "./gateway.ts";

export type DatabaseAdmission =
  | { ok: true; region: GatewayRegion }
  | { ok: false; sqlstate: "3D000" | "28P01" | "57P03" | "08006" };

export interface DatabaseActorNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    admit(databaseId: string, user: string): Promise<DatabaseAdmission>;
  };
}

export interface Env {
  readonly DATABASE_ACTOR: DatabaseActorNamespace;
  readonly CONNECTION_RATE_LIMITER: RateLimit;
  readonly DATABASE_CONNECTION_RATE_LIMITER: RateLimit;
  readonly ROUTE_MASTER_KEYS: string;
  readonly [binding: string]: unknown;
}
