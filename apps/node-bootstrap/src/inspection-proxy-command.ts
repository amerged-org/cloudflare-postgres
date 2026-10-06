// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import WebSocket, { createWebSocketStream } from "ws";
import { z } from "zod";
import { BOOTSTRAP_RELAY_HEADER } from "@pgcf/contracts/bootstrap-relay";
import { NodeBootstrapTransport } from "@pgcf/contracts/node-bootstrap";
import { NodeInspectionInput } from "@pgcf/contracts/node-installation";

export const InspectionProxyConfig = z.strictObject({
  operation_id: NodeInspectionInput.shape.operation_id,
  expected_generation: NodeInspectionInput.shape.expected_generation,
  deadline_at: NodeInspectionInput.shape.deadline_at,
  expected_network: NodeInspectionInput.shape.expected_network,
  callback: NodeInspectionInput.shape.callback,
  transport_url: NodeInspectionInput.shape.transport_url,
  relay_url: NodeInspectionInput.shape.relay_url,
});
export type InspectionProxyConfig = z.infer<typeof InspectionProxyConfig>;

export function validateInspectionProxyConfig(value: unknown) {
  const config = InspectionProxyConfig.parse(value);
  const base = `/internal/v1/node-installation/${config.operation_id}`;
  const callback = new URL(config.callback.url);
  for (const [value, protocol, path] of [
    [config.callback.url, "https:", `${base}/inspection`],
    [config.transport_url, "https:", `${base}/transport`],
    [config.relay_url, "wss:", `${base}/relay`],
  ] as const) {
    const url = new URL(value);
    if (
      url.protocol !== protocol ||
      url.host !== callback.host ||
      url.pathname !== path ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("inspection_transport_endpoint_mismatch");
  }
  return config;
}

/** Count bytes as they arrive; never buffer an unbounded authority response. */
export async function inspectionResponseBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > limit) throw new Error("inspection_response_limit");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function openInspectionTransport(
  value: InspectionProxyConfig,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Duplex> {
  const config = validateInspectionProxyConfig(value);
  signal.throwIfAborted();
  const remaining = Date.parse(config.deadline_at) - Date.now();
  if (remaining <= 0 || remaining > 600_000)
    throw new Error("inspection_deadline_invalid");
  const deadline = performance.now() + remaining;
  const lifetime = AbortSignal.timeout(remaining);
  const bounded = AbortSignal.any([signal, lifetime]);
  // Both endpoints recheck current provider/firewall authority before responding.
  const authority = AbortSignal.any([
    bounded,
    AbortSignal.timeout(Math.min(60_000, remaining)),
  ]);
  const response = await request(config.transport_url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.callback.bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expected_generation: config.expected_generation }),
    redirect: "error",
    signal: authority,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("inspection_transport_refused");
  }
  const body = await inspectionResponseBody(response, 16_384, authority);
  const transport = NodeBootstrapTransport.parse(JSON.parse(body));
  if (
    transport.expectedTarget.ip !== config.expected_network.ipv4 ||
    transport.expectedTarget.port !== 22
  )
    throw new Error("inspection_transport_target_mismatch");
  if (transport.websocket_url !== config.relay_url)
    throw new Error("inspection_transport_endpoint_mismatch");
  bounded.throwIfAborted();
  const websocketRemaining = Math.floor(deadline - performance.now());
  if (websocketRemaining <= 0) throw new Error("inspection_deadline_expired");
  const socket = new WebSocket(transport.websocket_url, {
    headers: {
      authorization: `Bearer ${config.callback.bearer}`,
      [BOOTSTRAP_RELAY_HEADER]: transport.token,
    },
    handshakeTimeout: Math.min(60_000, websocketRemaining),
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });
  const abort = () => socket.terminate();
  bounded.addEventListener("abort", abort, { once: true });
  socket.once("close", () => bounded.removeEventListener("abort", abort));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("inspection_relay_failed")));
      socket.once("close", () => reject(new Error("inspection_relay_closed")));
    });
  } catch {
    socket.terminate();
    throw new Error("inspection_relay_failed");
  }
  const stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  socket.on("message", (_data, binary) => {
    if (!binary) stream.destroy(new Error("inspection_relay_binary_required"));
  });
  stream.once("close", () => socket.terminate());
  return stream;
}

async function main() {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3)
    throw new Error("inspection_proxy_configuration_required");
  const bytes = await readFile(path);
  if (bytes.length > 16_384)
    throw new Error("inspection_proxy_configuration_limit");
  const config = validateInspectionProxyConfig(
    JSON.parse(bytes.toString("utf8")),
  );
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  const bridge = await openInspectionTransport(config, abort.signal);
  await new Promise<void>((resolve, reject) => {
    const close = () => {
      process.stdin.unpipe(bridge);
      process.stdin.pause();
      resolve();
    };
    bridge.once("error", () =>
      reject(new Error("inspection_relay_stream_failed")),
    );
    bridge.once("close", close);
    bridge.once("end", close);
    process.stdin.pipe(bridge).pipe(process.stdout);
  }).finally(() => bridge.destroy());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /\/inspection-proxy-command\.(?:ts|mjs)$/.test(
    new URL(import.meta.url).pathname,
  )
) {
  main().catch(() => {
    process.stderr.write("inspection_proxy_failed\n");
    process.exitCode = 1;
  });
}
