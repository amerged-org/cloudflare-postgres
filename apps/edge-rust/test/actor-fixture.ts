// SPDX-License-Identifier: Apache-2.0
// Local acceptance setup only. The Worker under test has no D1 binding.
import { DatabaseActor as ActualDatabaseActor } from "../../api/src/database-actor.ts";
// Observe calls around the unchanged product Actor, rather than replacing its FSM.
export class DatabaseActor extends ActualDatabaseActor {
  private received: unknown[] = [];
  private cancellations = 0;
  override ensureAwake(
    database: unknown,
    user: unknown,
    options?: { deadline?: number; waiterId?: string },
  ) {
    if (this.received.length < 32)
      this.received.push({ database, user, options });
    return super.ensureAwake(database, user, options);
  }
  override cancelWakeWaiter(database: string, waiter: string) {
    this.cancellations++;
    return super.cancelWakeWaiter(database, waiter);
  }
  diagnostics() {
    return {
      received: this.received,
      cancellations: this.cancellations,
      waiters: (this as unknown as { waiters: Map<string, unknown> }).waiters
        .size,
    };
  }
}
export { RegionLink } from "../../api/src/region-link.ts";
import { readDatabasePresence } from "../../api/src/domain/database-actor-sync.ts";

export default {
  async fetch(
    request: Request,
    env: {
      DB: D1Database;
      DATABASE_ACTOR: DurableObjectNamespace;
    },
  ) {
    const database = new URL(request.url).searchParams.get("database");
    if (request.method !== "POST" || !database)
      return new Response(null, { status: 404 });
    if (new URL(request.url).pathname === "/diagnostics") {
      const stub = env.DATABASE_ACTOR.get(
        env.DATABASE_ACTOR.idFromName(database),
      ) as DurableObjectStub & { diagnostics(): Promise<unknown> };
      return Response.json(await stub.diagnostics());
    }
    const snapshot = await readDatabasePresence(env.DB, database);
    if (!snapshot) return new Response(null, { status: 404 });
    await (
      env.DATABASE_ACTOR.get(
        env.DATABASE_ACTOR.idFromName(database),
      ) as DurableObjectStub & { seed(value: unknown): Promise<void> }
    ).seed(snapshot);
    return new Response(null, { status: 204 });
  },
};
