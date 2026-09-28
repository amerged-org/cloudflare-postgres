// SPDX-License-Identifier: Apache-2.0
import { checkServerIdentity } from "node:tls";
import { Client, DatabaseError } from "pg";
import type { ClientConfig } from "pg";
import type { RoleVerifier } from "./role-types.ts";

export function postgresRoleVerifier(): RoleVerifier {
  return {
    async verify(input) {
      if (
        !/^database-rw\.pgcf-[a-f0-9]{32}\.svc$/.test(input.host) ||
        input.database !== "app" ||
        !input.username ||
        !input.password ||
        !input.ca ||
        !Number.isSafeInteger(input.deadline) ||
        input.deadline <= Date.now()
      )
        throw new Error("role_probe_deferred");
      const connect = async (password: string, old: boolean) => {
        const timeout = Math.max(
          1,
          Math.min(15_000, input.deadline - Date.now()),
        );
        if (input.deadline <= Date.now())
          throw new Error("role_probe_deferred");
        const configuration: ClientConfig & { replication: "false" } = {
          host: input.host,
          port: 5432,
          database: "app",
          user: input.username,
          password,
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
          // pg's empty options still imports PGOPTIONS. This fixed nonempty value
          // prevents ambient settings without supplying a DSN or privileged SQL.
          options: "-c search_path=pg_catalog",
          application_name: "cloudflare-postgres-role-verifier",
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
          /* Connection details never enter logs. */
        });
        const timer = setTimeout(
          () => client.connection.stream.destroy(),
          timeout,
        );
        try {
          await client.connect();
          if (old) throw new Error("role_previous_credential_still_valid");
          const result = await client.query<{
            username: string;
            database: string;
            writable: boolean;
            restricted: boolean;
          }>(
            "SELECT current_user::text AS username, current_database()::text AS database, NOT pg_is_in_recovery() AS writable, (NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolcanlogin AND rolconnlimit BETWEEN 1 AND 1000 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = pg_roles.oid)) AS restricted FROM pg_catalog.pg_roles WHERE rolname = $1 AND rolname = current_user",
            [input.username],
          );
          const row = result.rows[0];
          if (
            result.rows.length !== 1 ||
            !row ||
            row.username !== input.username ||
            row.database !== "app" ||
            row.writable !== true ||
            row.restricted !== true ||
            Date.now() >= input.deadline
          )
            throw new Error("role_credential_verification_failed");
          return row;
        } catch (error) {
          if (old && error instanceof DatabaseError && error.code === "28P01")
            return null;
          throw new Error("role_probe_deferred");
        } finally {
          // The absolute timer remains armed during cleanup. Every fresh socket is
          // closed, including authentication failures and old-password success.
          try {
            await client.end();
          } finally {
            clearTimeout(timer);
            client.connection.stream.destroy();
          }
        }
      };
      try {
        await connect(input.password, false);
        if (input.previousPassword !== null)
          await connect(input.previousPassword, true);
        return {
          authenticatedUser: input.username,
          authenticatedDatabase: "app",
          writablePrimary: true,
          previousCredentialRejected:
            input.previousPassword === null ? null : true,
        };
      } catch {
        throw new Error("role_probe_deferred");
      }
    },
  };
}
