// SPDX-License-Identifier: Apache-2.0
import { REFUSAL_BYTES, refusalCode } from "@pgcf/contracts/edge-policy";
import { ROUTE_TOKEN_HEADER } from "@pgcf/contracts/route-token";
import type { Env } from "./env.ts";

export interface GatewayRegion {
  readonly id: string;
  readonly gateway_url: string;
  readonly gateway_binding: string | null;
}

/** Reads the refusal's head, cancels the rest of its body and returns its error code, if any. */
export async function readRefusal(
  response: Response,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const head: number[] = [];
  try {
    while (head.length < REFUSAL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      head.push(...value.subarray(0, REFUSAL_BYTES - head.length));
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return refusalCode(new TextDecoder().decode(new Uint8Array(head)));
}

/** A gateway that answered the upgrade with a refusal: its status and error code, nothing else. */
export class GatewayRefusal extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super("gateway upgrade failed");
    this.status = status;
    this.code = code;
  }
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
  if (response.status !== 101 || response.webSocket === null)
    throw new GatewayRefusal(response.status, await readRefusal(response));
  return response.webSocket;
}
