// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { Client, type ClientConfig } from "pg";
import { DesiredDatabase } from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import { databaseNamespace } from "./builders/index.ts";
import {
  appliedGeneration,
  acceptedGeneration,
  DATABASE_LABEL,
  validateArchiveProgress,
  type ArchiveProgress,
} from "./observe.ts";
import { record, string, type Kubernetes, type Resource } from "./types.ts";

export interface ArchiveProbeOptions {
  databaseId: string;
  namespace: string;
  primaryAddress: string;
  credentials: { user: string; password: string };
  ca: string;
  signal: AbortSignal;
  deadline: number;
  now?: () => number;
  verifyBinding(): Promise<boolean>;
}
export type ArchiveProbeResult = {
  readyWalFiles: number;
  progress: ArchiveProgress;
  valid: true;
};
export type ArchiveClientFactory = (config: ClientConfig) => Client;
export const ARCHIVE_IDENTITY_QUERY = `SELECT pg_catalog.current_database() AS database,pg_catalog.current_setting('session_authorization') AS role,
 pg_catalog.pg_is_in_recovery() AS recovery,pg_catalog.inet_server_addr()::text AS server_address,
 (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS tls,
 r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid WHERE m.member=r.oid AND granted.rolname<>'pg_read_all_stats') AS only_stats,
 pg_catalog.pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats,
 pg_catalog.has_function_privilege(r.oid,'pg_catalog.pg_ls_archive_statusdir()','EXECUTE') AS archive_listing
 FROM pg_catalog.pg_roles r WHERE r.rolname=$1 AND r.rolname=pg_catalog.current_setting('session_authorization')`;
export const ARCHIVE_QUERY = `SELECT (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_ls_archive_statusdir() WHERE name LIKE '%.ready') AS ready_wal_files,
 archived_count::text,COALESCE(EXTRACT(EPOCH FROM last_archived_time)::text,'-1') AS last_archived_time,failed_count::text
 FROM pg_catalog.pg_stat_archiver`;
function unavailable(): never {
  throw new Error("archive_probe_unavailable");
}
function decodedCertificate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 180000) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return undefined;
  const ca = bytes.toString("utf8");
  try {
    if (new X509Certificate(ca).ca) return ca;
  } catch {
    /* Not an eligible certificate. */
  }
  return undefined;
}
function owned(
  value: Resource | null,
  kind: string,
  name: string,
  namespace: string | undefined,
  database: string,
): value is Resource {
  return (
    value !== null &&
    value.kind === kind &&
    value.metadata.name === name &&
    value.metadata.namespace === namespace &&
    value.metadata.labels?.[DATABASE_LABEL] === database &&
    !!value.metadata.uid &&
    !!value.metadata.resourceVersion &&
    !value.metadata.deletionTimestamp
  );
}
function clusterOwned(value: Resource, cluster: Resource): boolean {
  const owners = record(value.metadata).ownerReferences;
  return (
    Array.isArray(owners) &&
    owners.some(
      (item) =>
        record(item).kind === "Cluster" &&
        record(item).name === cluster.metadata.name &&
        record(item).uid === cluster.metadata.uid,
    )
  );
}
export async function archiveProbeOptions(
  db: DesiredDatabase,
  cluster: Resource,
  fence: Resource,
  k8s: Kubernetes,
  signal: AbortSignal,
  now = Date.now,
): Promise<ArchiveProbeOptions | null> {
  if (
    db.desired_state !== "running" ||
    db.power?.mode !== "running" ||
    !db.maintenance
  )
    return null;
  const namespace = databaseNamespace(db.id),
    primary = string(record(cluster.status).currentPrimary),
    caName = string(record(record(cluster.status).certificates).serverCASecret);
  if (
    !primary ||
    !caName ||
    ![primary, caName].every(
      (name) =>
        /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) && name.length <= 63,
    )
  )
    return null;
  const [ns, secret, caSecret, pod] = await Promise.all([
    k8s.read("Namespace", undefined, namespace),
    k8s.read("Secret", namespace, "maintenance-credentials"),
    k8s.read("Secret", namespace, caName),
    k8s.read("Pod", namespace, primary),
  ]);
  const state = record(JSON.parse(String(record(fence.data).state)));
  const roles = record(record(cluster.status).managedRolesStatus),
    reconciled = record(roles.byStatus).reconciled;
  const ca = decodedCertificate(record(caSecret?.data)["ca.crt"]);
  if (
    !owned(fence, "ConfigMap", `storage-${db.id}`, "pgcf-system", db.id) ||
    appliedGeneration(fence) !== db.generation ||
    state.node !== db.node ||
    state.archivePath !== db.archive.destination_path ||
    !owned(ns, "Namespace", namespace, undefined, db.id) ||
    ns.metadata.uid !== state.namespaceUid ||
    appliedGeneration(ns) !== db.generation ||
    acceptedGeneration(ns) > db.generation ||
    !owned(cluster, "Cluster", "database", namespace, db.id) ||
    cluster.metadata.uid !== state.clusterUid ||
    appliedGeneration(cluster) !== db.generation ||
    !owned(secret, "Secret", "maintenance-credentials", namespace, db.id) ||
    appliedGeneration(secret) !== db.generation ||
    record(secret.data).username !==
      Buffer.from(MAINTENANCE_ROLE).toString("base64") ||
    record(secret.data).password !==
      Buffer.from(db.maintenance.password).toString("base64") ||
    !Array.isArray(reconciled) ||
    !reconciled.includes(MAINTENANCE_ROLE) ||
    record(record(roles.passwordStatus)[MAINTENANCE_ROLE]).resourceVersion !==
      secret.metadata.resourceVersion ||
    !caSecret ||
    caSecret.metadata.namespace !== namespace ||
    !caSecret.metadata.uid ||
    !caSecret.metadata.resourceVersion ||
    caSecret.metadata.deletionTimestamp ||
    !clusterOwned(caSecret, cluster) ||
    !ca ||
    !pod ||
    pod.metadata.namespace !== namespace ||
    !pod.metadata.uid ||
    !pod.metadata.resourceVersion ||
    pod.metadata.deletionTimestamp ||
    pod.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
    !clusterOwned(pod, cluster) ||
    record(pod.spec).nodeName !== db.node ||
    !isIP(String(record(pod.status).podIP))
  )
    return null;
  const resources = [ns, cluster, secret, caSecret, pod, fence];
  const verifyBinding = async () => {
    const current = await Promise.all(
      resources.map((value) =>
        k8s.read(value.kind, value.metadata.namespace, value.metadata.name),
      ),
    );
    if (
      current.some(
        (value, index) =>
          !value ||
          value.metadata.uid !== resources[index]!.metadata.uid ||
          value.metadata.deletionTimestamp,
      )
    )
      return false;
    const [freshNs, freshCluster, freshSecret, freshCa, freshPod, freshFence] =
      current as Resource[];
    const roleStatus = record(record(freshCluster!.status).managedRolesStatus);
    return (
      owned(freshNs!, "Namespace", namespace, undefined, db.id) &&
      owned(freshCluster!, "Cluster", "database", namespace, db.id) &&
      owned(
        freshSecret!,
        "Secret",
        "maintenance-credentials",
        namespace,
        db.id,
      ) &&
      owned(
        freshFence!,
        "ConfigMap",
        `storage-${db.id}`,
        "pgcf-system",
        db.id,
      ) &&
      record(freshFence!.data).state === record(fence.data).state &&
      appliedGeneration(freshFence!) === db.generation &&
      clusterOwned(freshCa!, freshCluster!) &&
      clusterOwned(freshPod!, freshCluster!) &&
      appliedGeneration(freshNs!) === db.generation &&
      acceptedGeneration(freshNs!) <= db.generation &&
      string(
        record(record(freshCluster!.status).certificates).serverCASecret,
      ) === caName &&
      appliedGeneration(freshCluster!) === db.generation &&
      string(record(freshCluster!.status).currentPrimary) === primary &&
      freshSecret!.metadata.resourceVersion ===
        secret.metadata.resourceVersion &&
      freshCa!.metadata.resourceVersion === caSecret.metadata.resourceVersion &&
      record(record(roleStatus.passwordStatus)[MAINTENANCE_ROLE])
        .resourceVersion === secret.metadata.resourceVersion &&
      record(freshPod!.status).podIP === record(pod.status).podIP
    );
  };
  return {
    databaseId: db.id,
    namespace,
    primaryAddress: String(record(pod.status).podIP),
    credentials: { user: MAINTENANCE_ROLE, password: db.maintenance.password },
    ca,
    signal,
    deadline: Date.now() + 2000,
    now,
    verifyBinding,
  };
}
function numeric(value: unknown, signed = false): number {
  if (typeof value !== "string" && typeof value !== "number") unavailable();
  const text = String(value);
  if (
    text.length > 64 ||
    !(signed ? /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/ : /^[0-9]+$/).test(
      text,
    )
  )
    unavailable();
  const number = Number(text);
  if (!Number.isFinite(number)) unavailable();
  return number;
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("archive_probe_aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("archive_probe_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
async function close(client: Client): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      client.connection.stream.destroy();
      resolve();
    }, 1000);
    client.end().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        client.connection.stream.destroy();
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
export async function probeArchive(
  options: ArchiveProbeOptions,
  createClient: ArchiveClientFactory = (config) => new Client(config),
): Promise<ArchiveProbeResult> {
  const db = DesiredDatabase.shape.id.safeParse(options.databaseId),
    host = `database-rw.${options.namespace}.svc`;
  if (
    !db.success ||
    options.namespace !== databaseNamespace(options.databaseId) ||
    options.credentials.user !== MAINTENANCE_ROLE ||
    typeof options.credentials.password !== "string" ||
    !options.credentials.password ||
    options.credentials.password.length > 4096 ||
    options.credentials.password.includes("\0") ||
    !isIP(options.primaryAddress) ||
    !Number.isSafeInteger(options.deadline) ||
    options.deadline <= Date.now() ||
    options.deadline - Date.now() > 5000 ||
    !(options.signal instanceof AbortSignal) ||
    typeof options.ca !== "string" ||
    options.ca.length > 128 * 1024 ||
    typeof options.verifyBinding !== "function"
  )
    unavailable();
  try {
    if (!new X509Certificate(options.ca).ca) unavailable();
  } catch {
    unavailable();
  }
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(Math.max(1, options.deadline - Date.now())),
  ]);
  let client: Client | undefined;
  const abort = () => client?.connection.stream.destroy();
  try {
    if (signal.aborted) unavailable();
    client = createClient({
      host,
      port: 5432,
      database: options.databaseId,
      user: MAINTENANCE_ROLE,
      password: options.credentials.password,
      application_name: "pgcf-archive-probe",
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: "-c search_path=pg_catalog -c default_transaction_read_only=on",
      ssl: { ca: options.ca, servername: host, rejectUnauthorized: true },
    });
    client.on("error", () => {});
    signal.addEventListener("abort", abort, { once: true });
    await bounded(client.connect(), signal);
    const stream = client.connection.stream as unknown as {
      encrypted?: boolean;
      authorized?: boolean;
      getPeerCertificate?(): PeerCertificate;
    };
    if (
      stream.encrypted !== true ||
      stream.authorized !== true ||
      typeof stream.getPeerCertificate !== "function" ||
      checkServerIdentity(host, stream.getPeerCertificate())
    )
      unavailable();
    const identity = await bounded(
        client.query(ARCHIVE_IDENTITY_QUERY, [MAINTENANCE_ROLE]),
        signal,
      ),
      row = identity.rows[0];
    if (
      identity.rows.length !== 1 ||
      !row ||
      row.database !== options.databaseId ||
      row.role !== MAINTENANCE_ROLE ||
      row.recovery !== false ||
      row.tls !== true ||
      row.server_address !== options.primaryAddress ||
      row.stats !== true ||
      row.only_stats !== true ||
      row.archive_listing !== true ||
      [
        "rolsuper",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
        "rolbypassrls",
      ].some((key) => row[key] !== false)
    )
      unavailable();
    const sample = await bounded(client.query(ARCHIVE_QUERY), signal),
      values = sample.rows[0];
    if (sample.rows.length !== 1 || !values) unavailable();
    const readyWalFiles = numeric(values.ready_wal_files),
      failed = numeric(values.failed_count);
    if (
      !Number.isSafeInteger(readyWalFiles) ||
      readyWalFiles < 0 ||
      !Number.isSafeInteger(failed) ||
      failed < 0
    )
      unavailable();
    const progress = validateArchiveProgress(
      numeric(values.archived_count),
      numeric(values.last_archived_time, true),
      (options.now ?? Date.now)(),
    );
    if (
      signal.aborted ||
      Date.now() >= options.deadline ||
      !(await bounded(options.verifyBinding(), signal))
    )
      unavailable();
    return { readyWalFiles, progress, valid: true };
  } catch {
    return unavailable();
  } finally {
    signal.removeEventListener("abort", abort);
    if (client) await close(client);
  }
}
