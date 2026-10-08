// SPDX-License-Identifier: Apache-2.0
import { Client } from "pg";
import type { ClientConfig } from "pg";
import { DesiredDatabase, postgresParameters } from "@pgcf/contracts";
import { databaseNamespace, roleSecretName } from "./builders/index.ts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import {
  appliedGeneration,
  acceptedGeneration,
  DATABASE_LABEL,
} from "./observe.ts";
import { record, type Resource } from "./types.ts";

export function credentialSecretMatches(
  db: DesiredDatabase,
  secret: Resource,
): boolean {
  const name = secret.metadata.name;
  const role = db.roles.find((value) => roleSecretName(value.name) === name);
  const credentials =
    role ??
    (db.maintenance && name === "maintenance-credentials"
      ? { name: MAINTENANCE_ROLE, password: db.maintenance.password }
      : undefined);
  if (!credentials) return false;
  const generation = appliedGeneration(secret),
    data = record(secret.data);
  return (
    secret.apiVersion === "v1" &&
    secret.kind === "Secret" &&
    secret.metadata.namespace === databaseNamespace(db.id) &&
    secret.metadata.labels?.[DATABASE_LABEL] === db.id &&
    secret.metadata.labels?.["cnpg.io/reload"] === "true" &&
    !!secret.metadata.uid &&
    !!secret.metadata.resourceVersion &&
    !secret.metadata.deletionTimestamp &&
    generation > 0 &&
    generation <= db.generation &&
    acceptedGeneration(secret) <= db.generation &&
    secret.type === "kubernetes.io/basic-auth" &&
    Object.keys(data).length === 2 &&
    data.username === Buffer.from(credentials.name).toString("base64") &&
    data.password === Buffer.from(credentials.password).toString("base64")
  );
}

export type AuthenticationProbe = (
  database: DesiredDatabase,
  ca: string,
  signal: AbortSignal,
) => Promise<boolean>;
export type ReadinessClientFactory = (config: ClientConfig) => Client;
export const READINESS_SETTINGS_QUERY = `SELECT current_setting('max_connections')::int AS max_connections,
  pg_size_bytes(current_setting('shared_buffers'))::text AS shared_buffers_bytes,
  pg_size_bytes(current_setting('effective_cache_size'))::text AS effective_cache_size_bytes,
  EXTRACT(EPOCH FROM current_setting('archive_timeout')::interval)::int AS archive_timeout_seconds`;

export async function probeRoles(
  database: DesiredDatabase,
  ca: string,
  signal: AbortSignal,
  createClient: ReadinessClientFactory = (config) => new Client(config),
): Promise<boolean> {
  const parsed = DesiredDatabase.safeParse(database);
  if (!parsed.success || parsed.data.desired_state !== "running") return false;
  const db = parsed.data;
  const sharedBuffersMib = Number.parseInt(
    postgresParameters(db.size).shared_buffers ?? "",
    10,
  );
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
      const settings = await client.query<{
        max_connections: number;
        shared_buffers_bytes: string;
        effective_cache_size_bytes: string;
        archive_timeout_seconds: number;
      }>(READINESS_SETTINGS_QUERY);
      const active = settings.rows[0];
      if (
        settings.rows.length !== 1 ||
        !active ||
        active.max_connections !== db.size.max_connections ||
        active.archive_timeout_seconds !== db.size.archive_timeout_seconds ||
        !/^[0-9]+$/.test(active.shared_buffers_bytes) ||
        !/^[0-9]+$/.test(active.effective_cache_size_bytes) ||
        Number(active.shared_buffers_bytes) !== sharedBuffersMib * 2 ** 20 ||
        Number(active.effective_cache_size_bytes) !==
          Math.floor(db.size.memory_mib / 2) * 2 ** 20
      )
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
