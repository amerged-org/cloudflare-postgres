// SPDX-License-Identifier: Apache-2.0
import type { DatabaseAdmission } from "@pgcf/contracts";
export type { DatabaseAdmission } from "@pgcf/contracts";

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
