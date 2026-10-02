// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

export class HarnessError extends Error {
  readonly code: string;
  readonly names: string[];
  constructor(code: string, names: string[] = []) {
    super(code);
    this.code = code;
    this.names = names;
  }
}

export function requireEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): Record<string, string> {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new HarnessError("missing_environment", missing);
  return Object.fromEntries(names.map((name) => [name, env[name]!]));
}

export function assertOwned(name: string, exact?: string): void {
  if (
    !/^pgcf-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ||
    (exact !== undefined && name !== exact)
  ) {
    throw new HarnessError("ownership_refused");
  }
}

export function assertRunId(value: string): void {
  if (!/^[0-9]{14}-[a-z0-9]{6}$/.test(value))
    throw new HarnessError("invalid_run_id");
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function httpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessError("invalid_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HarnessError("invalid_url");
  }
  return url;
}

export function percentile(values: readonly number[], percent: number): number {
  if (
    !values.length ||
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    percent < 0 ||
    percent > 100
  ) {
    throw new HarnessError("invalid_timings");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]!;
}

export function timingSummary(
  values: readonly number[],
): Record<string, number> {
  return {
    count: values.length,
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    max_ms: Math.max(...values),
  };
}

export interface ArchiveObject {
  key: string;
  size: number;
}

export function parseArchiveObjects(
  value: unknown,
  prefix: string,
): ArchiveObject[] {
  if (!Array.isArray(value)) throw new HarnessError("invalid_archive_listing");
  return value.map((item: unknown) => {
    const row = record(item);
    if (
      typeof row.key !== "string" ||
      !row.key.startsWith(prefix) ||
      typeof row.size !== "number" ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0
    ) {
      throw new HarnessError("invalid_archive_listing");
    }
    return { key: row.key, size: row.size };
  });
}

export function archiveCounts(
  objects: readonly ArchiveObject[],
): Record<string, number> {
  return {
    object_count: objects.length,
    base_backup_count: objects.filter(
      (o) => o.key.includes("/base/") && o.key.endsWith("/backup.info"),
    ).length,
    wal_count: objects.filter(
      (o) =>
        o.key.includes("/wals/") &&
        /^[0-9A-F]{24}(?:\.(?:gz|bz2|lz4|zst))?$/.test(
          o.key.slice(o.key.lastIndexOf("/") + 1),
        ),
    ).length,
    bytes: objects.reduce((sum, object) => sum + object.size, 0),
  };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError("invalid_response");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new HarnessError("invalid_response");
  return value;
}

export function items(value: unknown): Record<string, unknown>[] {
  const rows = record(value).items;
  if (!Array.isArray(rows)) throw new HarnessError("invalid_response");
  return rows.map(record);
}

export function objectName(value: unknown): string {
  return string(record(record(value).metadata).name);
}
export function objectNamespace(value: unknown): string {
  return string(record(record(value).metadata).namespace);
}

const EVENTS = new Set([
  "phase0",
  "E0",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
  "cleanup",
  "archive_failure_start",
  "archive_failure_check",
  "error",
]);

/** Evidence uses a positive schema; unknown fields and free text never cross this boundary. */
export function evidence(
  value: unknown,
  allowedNames: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const row = record(value);
  const result: Record<string, unknown> = {};
  if (typeof row.event === "string" && EVENTS.has(row.event))
    result.event = row.event;
  if (typeof row.pass === "boolean") result.pass = row.pass;
  if (
    typeof row.at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at)
  )
    result.at = row.at;
  if (Array.isArray(row.names))
    result.names = row.names.filter(
      (n) => typeof n === "string" && allowedNames.has(n),
    );
  for (const field of ["counts", "timings"] as const) {
    if (
      !row[field] ||
      typeof row[field] !== "object" ||
      Array.isArray(row[field])
    )
      continue;
    result[field] = Object.fromEntries(
      Object.entries(record(row[field])).filter(
        ([key, v]) =>
          /^[a-z][a-z0-9_]{0,50}$/.test(key) &&
          typeof v === "number" &&
          Number.isFinite(v) &&
          v >= 0,
      ),
    );
  }
  return result;
}

export async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T> {
  if (timeoutMs <= 0 || timeoutMs > 540_000)
    throw new HarnessError("invalid_timeout");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new HarnessError("poll_timeout");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())),
    );
  }
}
