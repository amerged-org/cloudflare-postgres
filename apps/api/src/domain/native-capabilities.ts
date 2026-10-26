// SPDX-License-Identifier: Apache-2.0
import { NODE_STALE_MS } from "@pgcf/contracts";
import { FleetReleaseId } from "@pgcf/contracts/releases";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";

type CapabilityEnv = Pick<Env, "DB" | "NATIVE_EXTENDED_RESOURCES_RELEASE_IDS">;
export interface NativeGuard {
  sql: string;
  bindings: (string | number | null)[];
}
const unrestricted = (): NativeGuard => ({ sql: "1=1", bindings: [] });

/** Operator-qualified release IDs, never an inferred version ordering or a node-provided capability. */
export function extendedNativeReleaseIds(env: CapabilityEnv): string[] {
  try {
    const value: unknown = JSON.parse(
      env.NATIVE_EXTENDED_RESOURCES_RELEASE_IDS ?? "[]",
    );
    return Array.isArray(value) &&
      value.length <= 256 &&
      value.every((id) => FleetReleaseId.safeParse(id).success)
      ? [...new Set(value as string[])]
      : [];
  } catch {
    return [];
  }
}

export const needsExtendedStorage = (storageMib: number) =>
  storageMib % 1024 !== 0;

/** The effective values are what the node consumes, including a class's inherited storage. */
export function databaseNeedsExtendedSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_native_database_alias");
  return `(EXISTS(SELECT 1 FROM database_resources er WHERE er.database_id=${alias}.id AND er.storage_mib%1024<>0)
    OR EXISTS(SELECT 1 FROM roles er WHERE er.database_id=${alias}.id AND er.deleted_at IS NULL AND er.membership_options<>3))`;
}

export async function databaseNeedsExtended(
  env: CapabilityEnv,
  databaseId: string,
): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM databases d WHERE d.id=? AND ${databaseNeedsExtendedSql("d")}`,
  )
    .bind(databaseId)
    .first());
}

/** Admission uses the signed-hello, freshness and OS facts of fleet status against the immutable
 * signed release. Delivery requires qualified current/assigned binaries but does not require OS
 * convergence: binaries restart before OS maintenance, which itself needs the desired page.
 */
export function extendedNativeGuard(
  env: CapabilityEnv,
  scope: { regionId?: string; nodeId?: string },
  required: boolean,
  now = Date.now(),
  delivery = false,
): NativeGuard {
  if (!required) return unrestricted();
  if ((scope.regionId === undefined) === (scope.nodeId === undefined))
    throw new Error("invalid_native_capability_scope");
  const releases = JSON.stringify(extendedNativeReleaseIds(env));
  const live =
    "n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM node_losses nl WHERE nl.node_id=n.id)";
  // Include every possible placement candidate, even a malformed ready row without enrollment.
  // A never-enrolled, not-ready installation has no serving process to qualify yet.
  const serving = `${live} AND (n.node_uid IS NOT NULL OR n.ready=1)`;
  const capable = `(${live} AND n.node_uid IS NOT NULL AND n.public_key IS NOT NULL AND n.os_boot_id IS NOT NULL
    ${delivery ? "AND EXISTS(SELECT 1 FROM fleet_region_releases f WHERE f.region_id=n.region_id AND f.release_id IN(SELECT value FROM json_each(?)))" : "AND n.ready=1 AND n.last_observed_at>=? AND n.last_observed_at<=? AND EXISTS(SELECT 1 FROM fleet_region_releases f WHERE f.region_id=n.region_id AND f.release_id=n.reported_release_id)"}
    AND EXISTS(SELECT 1 FROM fleet_releases r WHERE r.id=n.reported_release_id AND r.id IN(SELECT value FROM json_each(?))
      ${
        delivery
          ? ""
          : `AND n.os_kernel_release=json_extract(r.spec_json,'$.os.kernel_release')
      AND n.os_packages_sha256=json_extract(r.spec_json,'$.os.packages_sha256')
      AND n.os_host_files_sha256=json_extract(r.spec_json,'$.os.host_files_sha256')`
      }))`;
  const bindings = [
    ...(delivery
      ? [releases]
      : [
          new Date(now - NODE_STALE_MS).toISOString(),
          new Date(now + 5000).toISOString(),
        ]),
    releases,
  ];
  if (scope.nodeId !== undefined)
    return {
      sql: `EXISTS(SELECT 1 FROM nodes n WHERE n.id=? AND ${capable})`,
      bindings: [scope.nodeId, ...bindings],
    };
  return {
    sql: `EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=? AND ${serving})
      AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=? AND ${serving} AND NOT COALESCE(${capable},0))`,
    bindings: [scope.regionId!, scope.regionId!, ...bindings],
  };
}

export async function requireExtendedNative(
  env: CapabilityEnv,
  scope: { regionId?: string; nodeId?: string },
  required: boolean,
  now = Date.now(),
  delivery = false,
): Promise<NativeGuard> {
  const guard = extendedNativeGuard(env, scope, required, now, delivery);
  if (
    required &&
    !(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`)
      .bind(...guard.bindings)
      .first())
  )
    throw new ApiError(
      "conflict",
      "Extended storage and membership options require a qualified native release with verified current OS state",
      { reason: "not_ready" },
    );
  return guard;
}

export function combineNativeGuard(
  authority: NativeGuard,
  capability: NativeGuard,
): NativeGuard {
  return {
    sql: `(${authority.sql}) AND (${capability.sql})`,
    bindings: [...authority.bindings, ...capability.bindings],
  };
}

/** The persisted floor is raised in the feature mutation's transaction and never decreases,
 * even after a resize, role deletion or database deletion no longer exposes that format. */
export function extendedReleaseAssignmentGuard(
  env: CapabilityEnv,
  regionId: string,
  releaseId: string,
): NativeGuard {
  if (extendedNativeReleaseIds(env).includes(releaseId)) return unrestricted();
  return {
    sql: "EXISTS(SELECT 1 FROM regions WHERE id=? AND native_extended_resources_required=0)",
    bindings: [regionId],
  };
}
