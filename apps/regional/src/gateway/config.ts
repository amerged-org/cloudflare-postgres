// SPDX-License-Identifier: Apache-2.0
import { REGION_ID_PATTERN } from "@pgcf/contracts";
import {
  parseRouteKeyring,
  type RouteKeyring,
} from "@pgcf/contracts/route-token";

export interface GatewayConfiguration {
  readonly region: string;
  readonly keyring: RouteKeyring;
  readonly port: number;
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
  return { region, keyring, port };
}
