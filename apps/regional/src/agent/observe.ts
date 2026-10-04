// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { DatabaseId } from "@pgcf/contracts";
import type { NodeObservation, Orphan } from "@pgcf/contracts";
import { boundedText } from "./api-client.ts";
import { record, string } from "./types.ts";
import type { Kubernetes, Resource } from "./types.ts";

export const DATABASE_LABEL = "pgcf.io/database-id";
export const GENERATION_ANNOTATION = "pgcf.io/generation";
export const ACCEPTED_GENERATION_ANNOTATION = "pgcf.io/accepted-generation";
export const ARCHIVE_FAILURE_MS = 10 * 60_000;
export const WAL_BACKLOG_LIMIT = 32;
export const ARCHIVE_OBSERVATION_ANNOTATION = "pgcf.io/archive-observation";

export interface ArchiveProgress {
  archivedCount: number;
  lastArchivedTime: number;
}

export function parseArchiveProgress(
  metrics: string,
  now: number,
): ArchiveProgress {
  const metric = (name: string, signed = false) => {
    const lines = metrics
      .split("\n")
      .filter((line) => new RegExp(`^${name}(?:\\{|\\s)`).test(line));
    if (lines.length !== 1) throw new Error("archive_progress_missing");
    const match = new RegExp(
      `^${name}(?:\\{[^}]*\\})?\\s+(${signed ? "-?" : ""}[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(?:\\s+[0-9]+)?\\s*$`,
    ).exec(lines[0]!);
    const value = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(value)) throw new Error("archive_progress_invalid");
    return value;
  };
  const archivedCount = metric("cnpg_pg_stat_archiver_archived_count");
  const lastArchivedTime = metric(
    "cnpg_pg_stat_archiver_last_archived_time",
    true,
  );
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(archivedCount) ||
    archivedCount < 0 ||
    (lastArchivedTime < 0 &&
      !(archivedCount === 0 && lastArchivedTime === -1)) ||
    lastArchivedTime > now / 1000 ||
    (archivedCount > 0 && lastArchivedTime === 0)
  )
    throw new Error("archive_progress_invalid");
  return { archivedCount, lastArchivedTime };
}

export function condition(
  resource: Resource,
  type: string,
): Record<string, unknown> | undefined {
  const conditions = record(resource.status).conditions;
  return Array.isArray(conditions)
    ? conditions.map(record).find((value) => value.type === type)
    : undefined;
}

export function appliedGeneration(resource: Resource | null): number {
  return annotationGeneration(resource, GENERATION_ANNOTATION);
}

export function acceptedGeneration(resource: Resource | null): number {
  return annotationGeneration(resource, ACCEPTED_GENERATION_ANNOTATION);
}

function annotationGeneration(
  resource: Resource | null,
  annotation: string,
): number {
  if (!resource) return 0;
  const value = resource.metadata.annotations?.[annotation];
  if (value === undefined) return 0;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("applied_generation_invalid");
  return Number(value);
}

export function quantity(value: unknown): number {
  if (typeof value !== "string") throw new Error("resource_quantity_invalid");
  const match = /^([0-9]+(?:\.[0-9]+)?)([eE][+-]?[0-9]+|[numkKMGTPE]i?)?$/.exec(
    value,
  );
  if (!match) throw new Error("resource_quantity_invalid");
  const suffix = match[2] ?? "";
  const factors: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    Pi: 2 ** 50,
    Ei: 2 ** 60,
  };
  const result =
    Number(match[1]) *
    (suffix
      ? /^[eE]/.test(suffix)
        ? 10 ** Number(suffix.slice(1))
        : factors[suffix]!
      : 1);
  if (
    !Number.isFinite(result) ||
    result < 0 ||
    result > Number.MAX_SAFE_INTEGER
  )
    throw new Error("resource_quantity_invalid");
  return result;
}

export function podMemoryRequest(pod: Resource): number {
  const spec = record(pod.spec);
  const memory = (container: unknown) => {
    const value = record(record(record(container).resources).requests).memory;
    return value === undefined ? 0 : quantity(value);
  };
  const containers = Array.isArray(spec.containers) ? spec.containers : [];
  const init = Array.isArray(spec.initContainers) ? spec.initContainers : [];
  let restartable = 0;
  let initMaximum = 0;
  for (const container of init) {
    if (record(container).restartPolicy === "Always")
      restartable += memory(container);
    initMaximum = Math.max(
      initMaximum,
      restartable +
        (record(container).restartPolicy === "Always" ? 0 : memory(container)),
    );
  }
  const apps =
    containers.reduce<number>((sum, container) => sum + memory(container), 0) +
    restartable;
  const overhead = record(spec.overhead).memory;
  return (
    Math.max(apps, initMaximum) +
    (overhead === undefined ? 0 : quantity(overhead))
  );
}

export function nodeObservations(
  nodes: Resource[],
  pods: Resource[],
  namespaces: Resource[],
): NodeObservation[] {
  const databaseNamespaces = new Set(
    namespaces
      .filter(
        (namespace) =>
          DatabaseId.safeParse(namespace.metadata.labels?.[DATABASE_LABEL])
            .success &&
          namespace.metadata.name ===
            `pgcf-db-${namespace.metadata.labels?.[DATABASE_LABEL]}`,
      )
      .map((namespace) => namespace.metadata.name),
  );
  return nodes.map((node) => {
    const allocatable = record(record(node.status).allocatable);
    const storage = node.metadata.annotations?.["pgcf.io/storage-gib-total"];
    const storageGiB =
      storage &&
      /^[1-9][0-9]*$/.test(storage) &&
      Number.isSafeInteger(Number(storage))
        ? Number(storage)
        : null;
    const reserved = pods
      .filter(
        (pod) =>
          record(pod.spec).nodeName === node.metadata.name &&
          !databaseNamespaces.has(pod.metadata.namespace ?? "") &&
          !["Succeeded", "Failed"].includes(
            string(record(pod.status).phase) ?? "",
          ),
      )
      .reduce((sum, pod) => sum + podMemoryRequest(pod), 0);
    return {
      name: node.metadata.name,
      ready:
        condition(node, "Ready")?.status === "True" &&
        record(node.spec).unschedulable !== true,
      allocatable_memory_mib: Math.floor(
        quantity(allocatable.memory) / 2 ** 20,
      ),
      allocatable_cpu_millicores: Math.floor(quantity(allocatable.cpu) * 1000),
      storage_gib_total: storageGiB,
      platform_reserved_memory_mib: Math.ceil(reserved / 2 ** 20),
    };
  });
}

export function orphanObservations(
  namespaces: Resource[],
  desiredIds: ReadonlySet<string>,
): Orphan[] {
  return namespaces
    .filter(
      (namespace) =>
        !desiredIds.has(namespace.metadata.labels?.[DATABASE_LABEL] ?? ""),
    )
    .map((namespace) => ({
      namespace: namespace.metadata.name,
      database_id: namespace.metadata.labels?.[DATABASE_LABEL] ?? null,
    }));
}

export function parseReadyWalFiles(metrics: string): number {
  const lines = metrics
    .split("\n")
    .filter(
      (line) =>
        /^cnpg_collector_pg_wal_archive_status\{/.test(line) &&
        /[{,]value="ready"[,}]/.test(line),
    );
  if (lines.length !== 1) throw new Error("archive_metric_missing");
  const match = /}\s+([0-9]+)(?:\s+[0-9]+)?\s*$/.exec(lines[0]!);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new Error("archive_metric_invalid");
  return Number(match[1]);
}

export async function readyWalFiles(
  k8s: Kubernetes,
  namespace: string,
  cluster: Resource,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  return parseReadyWalFiles(
    await primaryMetrics(k8s, namespace, cluster, signal, fetcher),
  );
}

export async function archiveMetrics(
  k8s: Kubernetes,
  namespace: string,
  cluster: Resource,
  signal: AbortSignal,
  now: () => number,
  fetcher: typeof fetch = fetch,
): Promise<{
  readyWalFiles: number;
  progress: ArchiveProgress | null;
  valid: boolean;
}> {
  const metrics = await primaryMetrics(
    k8s,
    namespace,
    cluster,
    signal,
    fetcher,
  );
  const readyWalFiles = parseReadyWalFiles(metrics);
  let progress: ArchiveProgress | null;
  try {
    progress = parseArchiveProgress(metrics, now());
  } catch (error) {
    progress = null;
    // A measured empty queue needs no progress baseline; partially supplied or invalid samples remain uncertain.
    const absent =
      !/^cnpg_pg_stat_archiver_(?:archived_count|last_archived_time)(?:\{|\s)/m.test(
        metrics,
      );
    const valid =
      readyWalFiles === 0 &&
      absent &&
      error instanceof Error &&
      error.message === "archive_progress_missing";
    return { readyWalFiles, progress, valid };
  }
  return { readyWalFiles, progress, valid: true };
}

async function primaryMetrics(
  k8s: Kubernetes,
  namespace: string,
  cluster: Resource,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<string> {
  const primary = string(record(cluster.status).currentPrimary);
  if (
    !primary ||
    !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(primary) ||
    primary.length > 63
  )
    throw new Error("archive_primary_unavailable");
  const pod = await k8s.read("Pod", namespace, primary);
  const address = string(record(pod?.status).podIP);
  if (
    !pod ||
    pod.metadata.namespace !== namespace ||
    pod.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
    !address ||
    !isIP(address) ||
    pod.metadata.deletionTimestamp
  )
    throw new Error("archive_primary_invalid");
  const response = await fetcher(
    `http://${isIP(address) === 6 ? `[${address}]` : address}:9187/metrics`,
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      redirect: "error",
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("archive_metrics_unavailable");
  }
  return boundedText(response, 1024 * 1024);
}
