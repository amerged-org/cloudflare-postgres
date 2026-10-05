// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import WebSocket, { createWebSocketStream } from "ws";
import { z } from "zod";
import {
  BootstrapCapability,
  NodeBootstrapInput,
  NodeBootstrapTransport,
  type NodeBootstrapCallback,
} from "@pgcf/contracts/node-bootstrap";

export const LOOPBACK = [127, 0, 0, 1].join(".");
export const ProxyConfig = z.strictObject({
  spec: NodeBootstrapInput.shape.spec,
  input_hash: NodeBootstrapInput.shape.input_hash,
  callback: NodeBootstrapInput.shape.callback,
});
export type ProxyConfig = z.infer<typeof ProxyConfig>;

export function capabilityTarget(
  config: ProxyConfig,
  capability: BootstrapCapability,
) {
  return {
    ip:
      capability === "kubernetes_api"
        ? new URL(config.spec.cluster_endpoint).hostname
        : config.spec.hardware.ipv4,
    port:
      capability === "rescue_ssh"
        ? 22
        : capability === "talos_api"
          ? 50000
          : 6443,
  };
}

export async function openCapability(
  config: ProxyConfig,
  capability: BootstrapCapability,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Duplex> {
  if (config.spec.transport.mode !== "relay") throw new Error("relay_required");
  signal.throwIfAborted();
  const envelope: NodeBootstrapCallback = {
    version: 1,
    kind: "transport",
    operation_id: config.spec.operation_id,
    node_id: config.spec.node_id,
    region_id: config.spec.region_id,
    input_hash: config.input_hash,
    request_id: randomUUID(),
    payload: { capability, relay_epoch: config.spec.transport.relay_epoch },
  };
  const response = await request(config.callback.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.callback.bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
  });
  if (!response.ok) throw new Error("transport_authority_refused");
  const body = await response.text();
  if (Buffer.byteLength(body) > 16_384)
    throw new Error("transport_response_limit");
  const transport = NodeBootstrapTransport.parse(JSON.parse(body));
  const expected = capabilityTarget(config, capability);
  if (
    transport.expectedTarget.ip !== expected.ip ||
    transport.expectedTarget.port !== expected.port
  ) {
    throw new Error("transport_target_mismatch");
  }
  const socket = new WebSocket(transport.websocket_url, {
    headers: { authorization: `Bearer ${transport.token}` },
    handshakeTimeout: 15_000,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });
  const abort = () => socket.terminate();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("relay_handshake_failed")));
      socket.once("close", () => reject(new Error("relay_closed")));
    });
  } catch {
    socket.terminate();
    throw new Error("relay_handshake_failed");
  }
  const stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  socket.on("message", (_data, binary) => {
    if (!binary) stream.destroy(new Error("relay_binary_required"));
  });
  const lifetime = setTimeout(abort, 600_000);
  lifetime.unref();
  stream.once("close", () => {
    clearTimeout(lifetime);
    socket.terminate();
  });
  return stream;
}

export async function startNativeProxy(
  config: ProxyConfig,
  signal: AbortSignal,
) {
  if (config.spec.transport.mode !== "relay") throw new Error("relay_required");
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.maxConnections = 8;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.on("connect", (request, socket, head) => {
    const capability = (["talos_api", "kubernetes_api"] as const).find(
      (candidate) => {
        const target = capabilityTarget(config, candidate);
        return request.url === `${target.ip}:${target.port}`;
      },
    );
    if (
      !capability ||
      head.length > 64 * 1024 ||
      sockets.size >= 8 ||
      signal.aborted
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.pause();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void openCapability(config, capability, signal)
      .then((bridge) => {
        sockets.add(bridge);
        bridge.once("close", () => sockets.delete(bridge));
        const close = () => {
          socket.destroy();
          bridge.destroy();
        };
        bridge.once("error", close);
        socket.once("error", close);
        bridge.once("close", () => socket.destroy());
        socket.once("close", () => bridge.destroy());
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) bridge.write(head);
        socket.pipe(bridge).pipe(socket);
        socket.resume();
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("proxy_listener_failed");
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  signal.addEventListener("abort", close, { once: true });
  return {
    url: `http://${LOOPBACK}:${address.port}`,
    close: async () => {
      signal.removeEventListener("abort", close);
      close();
      await new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.once("close", resolve);
      });
    },
  };
}

async function main() {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3)
    throw new Error("proxy_configuration_required");
  const config = ProxyConfig.parse(JSON.parse(await readFile(path, "utf8")));
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  const bridge = await openCapability(config, "rescue_ssh", abort.signal);
  await new Promise<void>((resolve, reject) => {
    const close = () => {
      process.stdin.unpipe(bridge);
      process.stdin.pause();
      resolve();
    };
    bridge.once("error", () => reject(new Error("relay_stream_failed")));
    bridge.once("close", close);
    bridge.once("end", close);
    process.stdin.pipe(bridge).pipe(process.stdout);
  }).finally(() => bridge.destroy());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write("bootstrap_proxy_failed\n");
    process.exitCode = 1;
  });
}
