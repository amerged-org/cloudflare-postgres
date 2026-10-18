// SPDX-License-Identifier: Apache-2.0
// Local acceptance setup only. The Worker under test has no D1 binding.
import { DatabaseActor as ActualDatabaseActor } from "../../api/src/database-actor.ts";
import { publishDatabaseAdmission } from "../../api/src/domain/database-admission-snapshot.ts";
// Observe calls around the unchanged product Actor, rather than replacing its FSM. A test can hold
// the admissions of one database, which is how it keeps a connect pending while it aborts it.
export class DatabaseActor extends ActualDatabaseActor {
  private received: unknown[] = [];
  private cancellations = 0;
  private held: Promise<void> | undefined;
  private releaseHeld: (() => void) | undefined;
  override async admitWake(
    database: unknown,
    user: unknown,
    options?: { deadline?: number; waiterId?: string },
  ) {
    if (this.received.length < 32)
      this.received.push({ database, user, options });
    await this.held;
    return super.admitWake(database, user, options);
  }
  override cancelWakeWaiter(database: string, waiter: string) {
    this.cancellations++;
    return super.cancelWakeWaiter(database, waiter);
  }
  hold() {
    this.held = new Promise<void>((resolve) => (this.releaseHeld = resolve));
  }
  release() {
    this.releaseHeld?.();
    this.held = undefined;
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
export { NodeActor } from "../../api/src/node-actor.ts";

type Stub = DurableObjectStub & {
  diagnostics(): Promise<unknown>;
  hold(): Promise<void>;
  release(): Promise<void>;
};

export default {
  async fetch(
    request: Request,
    env: {
      DB: D1Database;
      DATABASE_ACTOR: DurableObjectNamespace;
    },
  ) {
    const url = new URL(request.url),
      database = url.searchParams.get("database");
    if (request.method !== "POST" || !database)
      return new Response(null, { status: 404 });
    const stub = env.DATABASE_ACTOR.get(
      env.DATABASE_ACTOR.idFromName(database),
    ) as Stub;
    if (url.pathname === "/diagnostics")
      return Response.json(await stub.diagnostics());
    if (url.pathname === "/hold") {
      await stub.hold();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/release") {
      await stub.release();
      return new Response(null, { status: 204 });
    }
    // The API's own publisher seeds the Actor's presence and its admission snapshot from D1.
    if (!(await publishDatabaseAdmission(env as never, database)))
      return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  },
};
