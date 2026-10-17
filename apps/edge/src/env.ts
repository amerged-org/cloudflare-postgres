// SPDX-License-Identifier: Apache-2.0
import type { DatabaseWakeAdmission } from "@pgcf/contracts/database-admission";
export type { DatabaseWakeAdmission } from "@pgcf/contracts/database-admission";

export interface DatabaseActorNamespace {
  idFromName(name: string): DurableObjectId;
  get(
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ): {
    admitWake(
      databaseId: string,
      user: string,
      options: { deadline: number; waiterId: string },
    ): Promise<DatabaseWakeAdmission>;
    cancelWakeWaiter(databaseId: string, waiterId: string): Promise<boolean>;
  };
}

export interface Env {
  readonly DATABASE_ACTOR: DatabaseActorNamespace;
  readonly CONNECTION_RATE_LIMITER: RateLimit;
  /** Callers on a service binding (no CF-Connecting-IP), per database and role. */
  readonly BINDING_CONNECTION_RATE_LIMITER: RateLimit;
  readonly DATABASE_CONNECTION_RATE_LIMITER: RateLimit;
  readonly ROUTE_MASTER_KEYS: string;
  /** Where the API creates DatabaseActor objects, e.g. "weur"; the Edge passes the same hint. */
  readonly DATABASE_ACTOR_LOCATION_HINT?: string;
  readonly [binding: string]: unknown;
}
