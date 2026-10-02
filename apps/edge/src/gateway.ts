// SPDX-License-Identifier: Apache-2.0
import { ROUTE_TOKEN_HEADER } from "@pgcf/contracts/route-token";
import type { Env } from "./env.ts";

export interface GatewayRegion {
  readonly id: string;
  readonly gateway_url: string;
  readonly gateway_binding: string | null;
}

/** The transport seam, selected by the live edge-to-region transport spike. */
export async function connectGateway(
  region: GatewayRegion,
  token: string,
  env: Env,
  signal: AbortSignal,
): Promise<WebSocket> {
  const url = new URL(region.gateway_url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (region.gateway_binding === null && url.protocol !== "https:") ||
    url.username ||
    url.password
  )
    throw new Error("invalid gateway configuration");
  const request = new Request(url, {
    headers: { Upgrade: "websocket", [ROUTE_TOKEN_HEADER]: token },
    redirect: "manual",
    signal,
  });
  let response: Response;
  if (region.gateway_binding !== null) {
    // Only an explicit configured service binding may bypass global fetch.
    const binding = env[region.gateway_binding];
    if (
      typeof binding !== "object" ||
      binding === null ||
      !("fetch" in binding) ||
      typeof binding.fetch !== "function"
    )
      throw new Error("missing gateway service binding");
    response = await (binding as Fetcher).fetch(request);
  } else {
    response = await fetch(request);
  }
  if (response.status !== 101 || response.webSocket === null) {
    await response.body?.cancel();
    throw new Error("gateway upgrade failed");
  }
  return response.webSocket;
}
