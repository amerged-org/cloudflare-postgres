// SPDX-License-Identifier: Apache-2.0
import { Client } from "pg";
import type { ClientConfig } from "pg";
import { DesiredDatabase } from "@pgcf/contracts";
import { databaseNamespace } from "./builders/index.ts";

export type AuthenticationProbe = (
  database: DesiredDatabase,
  ca: string,
  signal: AbortSignal,
) => Promise<boolean>;
export type ReadinessClientFactory = (config: ClientConfig) => Client;

export async function probeRoles(
  database: DesiredDatabase,
  ca: string,
  signal: AbortSignal,
  createClient: ReadinessClientFactory = (config) => new Client(config),
): Promise<boolean> {
  const parsed = DesiredDatabase.safeParse(database);
  if (!parsed.success || parsed.data.desired_state !== "running") return false;
  const db = parsed.data;
  const host = `database-rw.${databaseNamespace(db.id)}.svc`;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  for (const role of db.roles) {
    if (bounded.aborted) return false;
    const client = createClient({
      host,
      port: 5432,
      database: db.id,
      user: role.name,
      password: role.password,
      application_name: "pgcf-readiness",
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
      ssl: { ca, servername: host, rejectUnauthorized: true },
    });
    client.on("error", () => {});
    const abort = () =>
      client.connection.stream.destroy(new Error("readiness_probe_aborted"));
    bounded.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      const result = await client.query<{ pgcf_ready: number }>(
        "SELECT 1 AS pgcf_ready",
      );
      if (result.rows.length !== 1 || result.rows[0]?.pgcf_ready !== 1)
        return false;
    } catch {
      return false;
    } finally {
      const endTimeout = setTimeout(
        () => client.connection.stream.destroy(),
        1_000,
      );
      try {
        await client.end();
      } finally {
        clearTimeout(endTimeout);
        bounded.removeEventListener("abort", abort);
      }
    }
  }
  return true;
}
