// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import type { DatabaseVerifier } from "./database-types.ts";

interface ConnectionInput {
  host: string;
  database: string;
  username: string;
  password: string;
  ca: string;
  deadline: number;
}
async function connection<T>(
  input: ConnectionInput,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  if (
    !/^database-rw\.pgcf-[a-f0-9]{32}\.svc$/.test(input.host) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(input.database) ||
    !input.username ||
    !input.password ||
    !input.ca ||
    !Number.isSafeInteger(input.deadline) ||
    input.deadline <= Date.now()
  )
    throw new Error("database_probe_deferred");
  const timeout = Math.max(1, Math.min(15_000, input.deadline - Date.now()));
  const configuration: ClientConfig & { replication: "false" } = {
    host: input.host,
    port: 5432,
    database: input.database,
    user: input.username,
    password: input.password,
    ssl: {
      ca: input.ca,
      rejectUnauthorized: true,
      servername: input.host,
      checkServerIdentity,
      minVersion: "TLSv1.2",
    },
    sslnegotiation: "postgres",
    replication: "false",
    client_encoding: "UTF8",
    options: "-c search_path=pg_catalog",
    application_name: "cloudflare-postgres-database-verifier",
    connectionTimeoutMillis: timeout,
    statement_timeout: timeout,
    query_timeout: timeout,
    lock_timeout: timeout,
    idle_in_transaction_session_timeout: timeout,
    keepAlive: false,
    pipeline: false,
  };
  const client = new Client(configuration);
  client.on("error", () => {
    /* No SQL bodies, credentials or connection details enter logs. */
  });
  const timer = setTimeout(() => client.connection.stream.destroy(), timeout);
  try {
    await client.connect();
    const result = await action(client);
    if (Date.now() >= input.deadline)
      throw new Error("database_probe_deferred");
    return result;
  } catch {
    throw new Error("database_probe_deferred");
  } finally {
    try {
      await client.end();
    } finally {
      clearTimeout(timer);
      client.connection.stream.destroy();
    }
  }
}
interface SqlProof {
  oid: string;
  username: string;
  database: string;
  owned: boolean;
  writable: boolean;
  restricted: boolean;
}
const attributes =
  "NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND NOT r.rolinherit AND r.rolcanlogin AND r.rolconnlimit BETWEEN 1 AND 1000 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid)";
async function restricted(client: Client, username: string): Promise<void> {
  const result = await client.query<{ restricted: boolean; writable: boolean }>(
    `SELECT (${attributes}) AS restricted, (NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off') AS writable FROM pg_catalog.pg_roles r WHERE r.rolname = $1 AND r.rolname = current_user AND r.rolname = session_user`,
    [username],
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0]?.restricted !== true ||
    result.rows[0].writable !== true
  )
    throw new Error("database_probe_deferred");
}
export function postgresDatabaseVerifier(): DatabaseVerifier {
  return {
    async absent(input) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.targetDatabase))
        throw new Error("database_probe_deferred");
      return connection(input, async (client) => {
        await restricted(client, input.username);
        const result = await client.query<{ absent: boolean }>(
          "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS absent",
          [input.targetDatabase],
        );
        if (
          result.rows.length !== 1 ||
          typeof result.rows[0]?.absent !== "boolean"
        )
          throw new Error("database_probe_deferred");
        return result.rows[0].absent;
      });
    },
    async verify(input) {
      return connection(input, async (client) => {
        const result = await client.query<SqlProof>(
          `SELECT d.oid::text AS oid, current_user::text AS username, current_database()::text AS database, (d.datdba = r.oid AND d.datallowconn AND NOT d.datistemplate) AS owned, (NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off') AS writable, (${attributes}) AS restricted FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname = current_user AND r.rolname = session_user WHERE d.datname = current_database() AND r.rolname = $1`,
          [input.username],
        );
        const proof = result.rows[0];
        if (
          result.rows.length !== 1 ||
          !proof ||
          !/^[1-9][0-9]{0,9}$/.test(proof.oid) ||
          proof.username !== input.username ||
          proof.database !== input.database ||
          proof.owned !== true ||
          proof.writable !== true ||
          proof.restricted !== true
        )
          throw new Error("database_probe_deferred");
        const schema = "pgcf_probe_" + randomUUID().replaceAll("-", "");
        let transaction = false;
        try {
          await client.query("BEGIN");
          transaction = true;
          await client.query(
            `CREATE SCHEMA "${schema}" AUTHORIZATION CURRENT_USER`,
          );
          await client.query(
            `CREATE TABLE "${schema}"."probe" (value integer NOT NULL)`,
          );
          await client.query(
            `INSERT INTO "${schema}"."probe" (value) VALUES ($1)`,
            [1],
          );
          const roundtrip = await client.query<{ value: number }>(
            `SELECT value FROM "${schema}"."probe"`,
          );
          if (roundtrip.rows.length !== 1 || roundtrip.rows[0]?.value !== 1)
            throw new Error("database_probe_deferred");
          const rollback = await client.query("ROLLBACK");
          if (
            rollback.command !== "ROLLBACK" ||
            client.getTransactionStatus() !== "I"
          )
            throw new Error("database_probe_deferred");
          transaction = false;
          const removed = await client.query<{ removed: boolean }>(
            "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS removed",
            [schema],
          );
          if (removed.rows.length !== 1 || removed.rows[0]?.removed !== true)
            throw new Error("database_probe_deferred");
        } finally {
          if (transaction) {
            try {
              await client.query("ROLLBACK");
            } catch {
              /* Closing the fresh socket aborts uncertain probe work. */
            }
          }
        }
        return {
          databaseOid: proof.oid,
          authenticatedUser: input.username,
          authenticatedDatabase: input.database,
          writablePrimary: true,
          databaseOwned: true,
          schemaCreateVerified: true,
          probeRolledBack: true,
        };
      });
    },
  };
}
