// SPDX-License-Identifier: Apache-2.0
import { gatewayPodUidSchema } from "@pgcf/contracts/gateway-control";
import { REGION_ID_PATTERN } from "@pgcf/contracts";
import {
  parseRouteKeyring,
  type RouteKeyring,
} from "@pgcf/contracts/route-token";
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
} from "./frame-budget.ts";

export interface GatewayConfiguration {
  readonly region: string;
  readonly keyring: RouteKeyring;
  readonly port: number;
  readonly memoryLimitBytes: number;
  readonly databaseMemoryLimitBytes: number;
}

export function readGatewayConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfiguration {
  const region = env.PGCF_REGION_ID;
  if (region === undefined || !REGION_ID_PATTERN.test(region))
    throw new Error("PGCF_REGION_ID must be a valid region ID");
  if (env.PGCF_ROUTE_KEY === undefined)
    throw new Error(
      "PGCF_ROUTE_KEY must contain the derived region keyring JSON",
    );
  const keyring = parseRouteKeyring(env.PGCF_ROUTE_KEY);
  const value = env.PGCF_GATEWAY_PORT ?? "8080";
  if (!/^\d{1,5}$/.test(value))
    throw new Error("PGCF_GATEWAY_PORT must be an integer in 1..65535");
  const port = Number(value);
  if (port < 1 || port > 65535)
    throw new Error("PGCF_GATEWAY_PORT must be an integer in 1..65535");
  const memoryLimitBytes = memoryLimit(
    env.PGCF_GATEWAY_MEMORY_BYTES,
    DEFAULT_MEMORY_LIMIT_BYTES,
    "PGCF_GATEWAY_MEMORY_BYTES",
  );
  const databaseMemoryLimitBytes = memoryLimit(
    env.PGCF_GATEWAY_DATABASE_MEMORY_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
    "PGCF_GATEWAY_DATABASE_MEMORY_BYTES",
  );
  if (databaseMemoryLimitBytes > memoryLimitBytes)
    throw new Error(
      "PGCF_GATEWAY_DATABASE_MEMORY_BYTES must not exceed PGCF_GATEWAY_MEMORY_BYTES",
    );
  return { region, keyring, port, memoryLimitBytes, databaseMemoryLimitBytes };
}

function memoryLimit(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (
    !/^\d{1,16}$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error(`${name} must be a positive safe integer`);
  return Number(value);
}

/** Required by the production entry point; supplied from the Pod downward API. */
export function readGatewayPodUid(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = gatewayPodUidSchema.safeParse(env.PGCF_GATEWAY_POD_UID);
  if (!value.success)
    throw new Error("PGCF_GATEWAY_POD_UID must be a valid Pod UID");
  return value.data;
}
