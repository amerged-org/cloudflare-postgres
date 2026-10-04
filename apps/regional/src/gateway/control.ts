// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GATEWAY_CONTROL_HEADER,
  GATEWAY_CONTROL_MAX_LENGTH,
  GATEWAY_CONTROL_PATH_PREFIX,
  gatewayControlActionSchema,
  gatewayControlReportSchema,
  gatewayPodUidSchema,
  verifyGatewayControl,
  type GatewayControlClaims,
} from "@pgcf/contracts/gateway-control";
import type { RouteKeyring } from "@pgcf/contracts/route-token";
import type { Gateway } from "./server.ts";
import type { GatewayFenceStore } from "./fences.ts";

export function createGatewayControl(options: {
  gateway: Gateway;
  store: GatewayFenceStore;
  pod: string;
  region: string;
  keyring: RouteKeyring;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  gatewayPodUidSchema.parse(options.pod);
  let active = 0;
  const matches = (claims: GatewayControlClaims) => {
    const intent = options.store.get(claims.database);
    return intent?.operation === claims.operation &&
      intent.revision === claims.revision
      ? intent
      : undefined;
  };
  const reply = (response: ServerResponse, status: number, value: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(JSON.stringify(value));
  };
  return (request, response) => {
    if (!request.url?.startsWith(GATEWAY_CONTROL_PATH_PREFIX)) return false;
    const action = gatewayControlActionSchema.safeParse(
      request.url.slice(GATEWAY_CONTROL_PATH_PREFIX.length),
    );
    if (!action.success) {
      reply(response, 404, { error: "control_not_found" });
      return true;
    }
    if (request.method !== "POST") {
      reply(response, 405, { error: "control_method" });
      return true;
    }
    if (
      request.headers["transfer-encoding"] !== undefined ||
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0")
    ) {
      reply(response, 400, { error: "control_body_forbidden" });
      return true;
    }
    const name = GATEWAY_CONTROL_HEADER.toLowerCase(),
      token = request.headers[name];
    let headers = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      if (request.rawHeaders[index]?.toLowerCase() === name) headers++;
    if (
      headers !== 1 ||
      typeof token !== "string" ||
      token.length > GATEWAY_CONTROL_MAX_LENGTH
    ) {
      reply(response, 401, { error: "control_denied" });
      return true;
    }
    if (active >= 32) {
      reply(response, 503, { error: "control_unavailable" });
      return true;
    }
    active++;
    request.resume();
    void (async () => {
      const verified = await verifyGatewayControl(token, {
        keys: options.keyring.keys,
        region: options.region,
        pod: options.pod,
        action: action.data,
      });
      if (!verified.ok || Date.now() > verified.claims.exp * 1000) {
        reply(response, 401, { error: "control_denied" });
        return;
      }
      if (!options.store.ready) {
        reply(response, 503, { error: "fences_unsynchronized" });
        return;
      }
      const intent = matches(verified.claims);
      if (
        !intent ||
        (action.data === "release"
          ? intent.mode !== "running"
          : action.data !== "status" && intent.mode !== "quiesce")
      ) {
        reply(response, 409, { error: "control_intent_mismatch" });
        return;
      }
      const report =
        action.data === "close"
          ? await options.gateway.closeQuiesced(
              intent.database,
              intent.operation,
            )
          : action.data === "begin"
            ? options.gateway.beginQuiesce(intent.database, intent.operation)
            : options.gateway.quiesceStatus(intent.database, intent.operation);
      if (!options.store.ready) {
        reply(response, 503, { error: "fences_unsynchronized" });
        return;
      }
      if (!matches(verified.claims)) {
        reply(response, 409, { error: "control_intent_mismatch" });
        return;
      }
      const output = gatewayControlReportSchema.parse({
        ...intent,
        pod: options.pod,
        status: intent.mode === "running" ? "running" : report.status,
        connections: report.connections,
        busyConnections: report.busyConnections,
        pendingDials: report.pendingDials,
      });
      reply(response, 200, output);
    })()
      .catch(() => reply(response, 503, { error: "control_unavailable" }))
      .finally(() => {
        active--;
      });
    return true;
  };
}
