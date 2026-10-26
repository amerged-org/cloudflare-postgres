// SPDX-License-Identifier: Apache-2.0
import type { Env } from "./env.ts";

/** A short operator-held schema cutover, never a tenant lifecycle or data-plane switch. */
export const CONTROL_MAINTENANCE_RETRY_MS = 60_000;
export function controlMaintenance(env: Env): boolean {
  return env.CONTROL_PLANE_MAINTENANCE === "on";
}

/** Evidence that a scheduled producer reached the paused version without evaluating its work. */
export function controlProducerPaused(env: Env, source: string): boolean {
  if (!controlMaintenance(env)) return false;
  console.log(
    JSON.stringify({
      event: "control_maintenance_hold",
      source,
      worker_version: env.CF_VERSION_METADATA?.id ?? null,
    }),
  );
  return true;
}

export function requireControlAvailable(env: Env): void {
  if (controlMaintenance(env)) throw new Error("control_plane_maintenance");
}

/** The paused version can run against either schema: no handler may access D1. */
export function maintenanceEnvironment(env: Env): Env {
  if (!controlMaintenance(env)) return env;
  return {
    ...env,
    DB: new Proxy({} as D1Database, {
      get() {
        throw new Error("control_plane_maintenance");
      },
    }),
  };
}

export function maintenanceResponse(request: Request, env: Env): Response {
  return new Response(
    request.method === "HEAD"
      ? null
      : JSON.stringify({
          error: { code: "unavailable", message: "Control plane maintenance" },
        }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": String(CONTROL_MAINTENANCE_RETRY_MS / 1000),
        "X-PGCF-Control-Maintenance": "on",
        "X-PGCF-Worker-Version": env.CF_VERSION_METADATA?.id ?? "unknown",
      },
    },
  );
}
