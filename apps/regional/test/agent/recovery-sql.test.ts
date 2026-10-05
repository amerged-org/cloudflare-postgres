// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Client, ClientConfig } from "pg";
import { administerRecovery } from "../../src/agent/recovery.ts";
import { recoveryFixture } from "./recovery-fixture.ts";
class DatabaseClient {
  readonly connection = { stream: { destroy: () => {} } };
  readonly statements: string[] = [];
  readonly names = new Map<string, { oid: string; owner: string }>();
  lostAck = false;
  connectError?: string;
  recovering = false;
  on() {}
  async connect() {
    if (this.connectError)
      throw Object.assign(new Error("connection_refused"), {
        code: this.connectError,
      });
  }
  async end() {}
  async query(sql: string, parameters?: unknown[]) {
    this.statements.push(sql);
    if (sql === "SELECT pg_is_in_recovery() AS recovering")
      return { rows: [{ recovering: this.recovering }] };
    if (sql.startsWith("SELECT oid::text")) {
      const names = parameters![0] as string[];
      return {
        rows: names.flatMap((datname) => {
          const v = this.names.get(datname);
          return v ? [{ ...v, datname }] : [];
        }),
      };
    }
    const rename =
      /^ALTER DATABASE "([a-z0-9]+)" RENAME TO "([a-z0-9]+)"$/.exec(sql);
    if (rename) {
      this.names.set(rename[2]!, this.names.get(rename[1]!)!);
      this.names.delete(rename[1]!);
    }
    if (sql === "COMMIT" && this.lostAck) {
      this.lostAck = false;
      throw new Error("ack_lost");
    }
    return { rows: [] };
  }
}
test("lost commit acknowledgement resumes a mapped physical database without creating another one", async () => {
  const { db, ctx } = recoveryFixture(),
    client = new DatabaseClient();
  client.names.set(db.recovery!.source_database_id, {
    oid: String(parseInt(randomUUID().replaceAll("-", "").slice(0, 7), 16)),
    owner: "app",
  });
  client.lostAck = true;
  let config: ClientConfig | undefined;
  const factory = (c: ClientConfig) => {
    config = c;
    return client as unknown as Client;
  };
  const run = () =>
    administerRecovery(
      db,
      ctx,
      "public-ca",
      new AbortController().signal,
      "map_database",
      factory,
    );
  assert.equal(await run(), false);
  assert.equal(await run(), true);
  assert.equal(client.names.size, 1);
  assert.equal(client.names.has(db.id), true);
  assert.equal(
    client.statements.filter((s) => s.startsWith("ALTER DATABASE")).length,
    1,
  );
  assert.equal(
    client.statements.some((s) => s.includes("CREATE DATABASE")),
    false,
  );
  assert.equal(typeof config?.ssl, "object");
  assert.equal(
    (config!.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized,
    true,
  );
});
test("cannot map an unexpected second database or a PostgreSQL instance still replaying WAL", async () => {
  const { db, ctx } = recoveryFixture(),
    client = new DatabaseClient(),
    factory = () => client as unknown as Client;
  client.names.set(db.id, { oid: "1", owner: "app" });
  client.names.set(db.recovery!.source_database_id, { oid: "2", owner: "app" });
  assert.equal(
    await administerRecovery(
      db,
      ctx,
      "public-ca",
      new AbortController().signal,
      "map_database",
      factory,
    ),
    false,
  );
  assert.equal(
    client.statements.some((s) => s.startsWith("ALTER")),
    false,
  );
  client.names.delete(db.id);
  client.recovering = true;
  assert.equal(
    await administerRecovery(
      db,
      ctx,
      "public-ca",
      new AbortController().signal,
      "map_database",
      factory,
    ),
    false,
  );
});
test("privileged auth refusal proves revocation but transport failure cannot publish readiness", async () => {
  const { db, ctx } = recoveryFixture(),
    client = new DatabaseClient(),
    factory = () => client as unknown as Client;
  client.connectError = "28P01";
  assert.equal(
    await administerRecovery(
      db,
      ctx,
      "public-ca",
      new AbortController().signal,
      "verify_admin_disabled",
      factory,
    ),
    true,
  );
  client.connectError = "ECONNRESET";
  assert.equal(
    await administerRecovery(
      db,
      ctx,
      "public-ca",
      new AbortController().signal,
      "verify_admin_disabled",
      factory,
    ),
    false,
  );
  client.connectError = undefined;
  assert.equal(
    await administerRecovery(
      db,
      ctx,
      "public-ca",
      new AbortController().signal,
      "verify_admin_disabled",
      factory,
    ),
    false,
  );
});
