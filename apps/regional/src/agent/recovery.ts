// SPDX-License-Identifier: Apache-2.0
import { Client, type ClientConfig } from "pg";
import { DesiredDatabase, RecoverySourceCredentialsMap } from "@pgcf/contracts";
import { record } from "./types.ts";
import type { Kubernetes } from "./types.ts";
import {
  databaseNamespace,
  restoreAdministrationPassword,
  type BuildContext,
} from "./builders/index.ts";
export type RecoveryAction = "map_database" | "verify_admin_disabled";
export type RecoveryAdministrator = (
  db: DesiredDatabase,
  ctx: BuildContext,
  ca: string,
  signal: AbortSignal,
  action: RecoveryAction,
) => Promise<boolean>;
export type RecoveryClientFactory = (config: ClientConfig) => Client;
export async function recoveryBuildContext(
  db: DesiredDatabase,
  ctx: BuildContext,
  k8s: Kubernetes,
  recoverySources?: RecoverySourceCredentialsMap,
): Promise<BuildContext> {
  const source = db.recovery?.source_archive;
  if (!source) return ctx;
  const unavailable = () =>
    new Error("recovery_source_credentials_unavailable");
  let sources: unknown = recoverySources;
  if (recoverySources === undefined) {
    const secret = await k8s.read(
      "Secret",
      "pgcf-system",
      "pgcf-restore-source-s3",
    );
    if (
      !secret ||
      secret.kind !== "Secret" ||
      secret.metadata.name !== "pgcf-restore-source-s3" ||
      secret.metadata.namespace !== "pgcf-system" ||
      secret.metadata.deletionTimestamp
    )
      throw unavailable();
    const encoded = record(secret.data)["sources.json"];
    if (
      typeof encoded !== "string" ||
      !encoded ||
      encoded.length > 128 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw unavailable();
    try {
      sources = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw unavailable();
    }
  }
  const parsed = RecoverySourceCredentialsMap.safeParse(sources);
  if (!parsed.success) throw unavailable();
  const selected = parsed.data[source.region_id];
  if (
    !selected ||
    selected.bucket !== source.bucket ||
    selected.endpoint_url !== source.endpoint_url
  )
    throw unavailable();
  return {
    ...ctx,
    recoverySource: {
      bucket: source.bucket,
      endpointUrl: source.endpoint_url,
      region: source.region,
      credentials: {
        accessKeyId: selected.access_key_id,
        secretAccessKey: selected.secret_access_key,
      },
    },
  };
}
export async function administerRecovery(
  db: DesiredDatabase,
  ctx: BuildContext,
  ca: string,
  signal: AbortSignal,
  action: RecoveryAction,
  createClient: RecoveryClientFactory = (config) => new Client(config),
): Promise<boolean> {
  const parsed = DesiredDatabase.safeParse(db);
  if (
    !parsed.success ||
    parsed.data.desired_state !== "running" ||
    !parsed.data.recovery
  )
    return false;
  const recovery = parsed.data.recovery;
  db = parsed.data;
  const host = `database-rw.${databaseNamespace(db.id)}.svc`,
    bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const client = createClient({
    host,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: restoreAdministrationPassword(db, ctx),
    application_name: "pgcf-recovery",
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
    ssl: { ca, servername: host, rejectUnauthorized: true },
  });
  client.on("error", () => {});
  const abort = () =>
    client.connection.stream.destroy(new Error("recovery_aborted"));
  bounded.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    if (action === "verify_admin_disabled") return false;
    const status = await client.query<{ recovering: boolean }>(
      "SELECT pg_is_in_recovery() AS recovering",
    );
    if (status.rows.length !== 1 || status.rows[0]?.recovering !== false)
      return false;
    await client.query("BEGIN");
    const names = [recovery.source_database_id, db.id];
    const result = await client.query<{
      oid: string;
      datname: string;
      owner: string;
    }>(
      "SELECT oid::text AS oid,datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=ANY($1::text[])",
      [names],
    );
    const source = result.rows.find((r) => r.datname === names[0]),
      target = result.rows.find((r) => r.datname === db.id);
    if (
      (source && target) ||
      (!source && !target) ||
      (source ?? target)?.owner !== "app"
    )
      return false;
    const oid = (source ?? target)!.oid;
    // Both identifiers are validated DatabaseIds, and this transaction never creates a database.
    if (source)
      await client.query(`ALTER DATABASE "${names[0]}" RENAME TO "${db.id}"`);
    const verified = await client.query<{
      oid: string;
      datname: string;
      owner: string;
    }>(
      "SELECT oid::text AS oid,datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=ANY($1::text[])",
      [names],
    );
    if (
      verified.rows.length !== 1 ||
      verified.rows[0]?.oid !== oid ||
      verified.rows[0]?.datname !== db.id ||
      verified.rows[0]?.owner !== "app"
    )
      return false;
    await client.query("COMMIT");
    return true;
  } catch (error) {
    // A transport failure cannot establish that privileged access has been removed.
    return (
      action === "verify_admin_disabled" &&
      !bounded.aborted &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["28P01", "28000"].includes(String(error.code))
    );
  } finally {
    const timer = setTimeout(() => client.connection.stream.destroy(), 1000);
    try {
      await client.end();
    } finally {
      clearTimeout(timer);
      bounded.removeEventListener("abort", abort);
    }
  }
}
