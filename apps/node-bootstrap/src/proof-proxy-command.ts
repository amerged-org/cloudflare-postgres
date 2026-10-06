// SPDX-License-Identifier: Apache-2.0
import { createPublicKey, verify, createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import WebSocket, { createWebSocketStream } from "ws";
import { z } from "zod";
import { BOOTSTRAP_RELAY_HEADER } from "@pgcf/contracts/bootstrap-relay";
import {
  BootstrapCapability,
  NodeBootstrapTransport,
} from "@pgcf/contracts/node-bootstrap";
import {
  NodeProofClaims,
  NodeProofExecutionInput,
  NODE_PROOF_SESSION_DOMAIN,
  canonicalNodeProof,
} from "@pgcf/contracts/node-proof";
import { inspectionResponseBody } from "./inspection-proxy-command.ts";
import { BootstrapError } from "./bootstrap-error.ts";

const fail = (code: string): never => {
  throw new BootstrapError(`node_proof_${code}`);
};
const sha = (value: unknown) =>
  createHash("sha256").update(canonicalNodeProof(value)).digest("hex");
export function validateProofExecution(
  value: unknown,
): NodeProofExecutionInput {
  let input: NodeProofExecutionInput;
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2)
      return fail("input_limit");
    input = NodeProofExecutionInput.parse(value);
    const [prefix, payload, signature] = input.session_bearer.split(".");
    if (prefix !== "np1" || !payload || !signature)
      return fail("session_invalid");
    const claims = NodeProofClaims.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (
      Buffer.from(canonicalNodeProof(claims)).toString("base64url") !==
        payload ||
      canonicalNodeProof(claims) !== canonicalNodeProof(input.claims)
    )
      return fail("session_invalid");
    const key = createPublicKey({
      key: Buffer.from(input.control_keys[claims.kid]!, "base64url"),
      format: "der",
      type: "spki",
    });
    const sig = Buffer.from(signature, "base64url");
    if (
      key.asymmetricKeyType !== "ed25519" ||
      sig.length !== 64 ||
      sig.toString("base64url") !== signature ||
      !verify(null, Buffer.from(NODE_PROOF_SESSION_DOMAIN + payload), key, sig)
    )
      return fail("session_invalid");
    const issued = Date.parse(claims.issued_at),
      expires = Date.parse(claims.expires_at),
      now = Date.now();
    if (
      issued > now + 5000 ||
      expires <= now ||
      expires <= issued ||
      expires - issued > 600_000 ||
      expires - now > 600_000
    )
      return fail("session_expired");
    if (
      sha(input.plan) !== claims.plan_sha256 ||
      sha(input.bootstrap.spec) !== input.bootstrap.input_hash
    )
      return fail("input_binding_changed");
    if (
      input.binding.maintenance &&
      (input.binding.maintenance.input_hash !== input.bootstrap.input_hash ||
        input.binding.maintenance.install_disk !==
          input.bootstrap.spec.hardware.install_disk ||
        input.binding.maintenance.disk_bytes !==
          input.bootstrap.spec.hardware.disk_bytes ||
        input.binding.maintenance.raw_bytes !==
          input.bootstrap.spec.image.raw_bytes)
    )
      return fail("maintenance_binding_changed");
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    return fail("input_invalid");
  }
  return input;
}
export const ProofProxyConfig = z.strictObject({
  input: NodeProofExecutionInput,
  direction: z.enum(["target", "source"]),
});
export type ProofProxyConfig = z.infer<typeof ProofProxyConfig>;
export function proofCapabilityTarget(
  config: ProofProxyConfig,
  capability: BootstrapCapability,
) {
  const input = config.input;
  if (
    config.direction === "source" &&
    ((input.source.kind === "rescue" && capability !== "rescue_ssh") ||
      (input.source.kind === "pod" && capability !== "kubernetes_api"))
  )
    return fail("capability_refused");
  const endpoint =
    config.direction === "source" && input.source.kind === "pod"
      ? input.source.access.join_bundle.cluster_endpoint
      : (input.cluster_bundle?.cluster_endpoint ??
        input.bootstrap.spec.cluster_endpoint);
  let ip =
    config.direction === "source"
      ? input.source.ipv4
      : input.bootstrap.spec.hardware.ipv4;
  if (capability === "kubernetes_api") {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.port !== "6443" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      isIP(url.hostname) !== 4
    )
      return fail("cluster_endpoint_invalid");
    ip = url.hostname;
  }
  return {
    ip,
    port:
      capability === "rescue_ssh"
        ? 22
        : capability === "talos_api"
          ? 50000
          : 6443,
  };
}
function parseConfig(value: unknown): ProofProxyConfig {
  const config = ProofProxyConfig.parse(value);
  config.input = validateProofExecution(config.input);
  return config;
}
export async function authorizeProofTransport(
  value: ProofProxyConfig,
  capability: BootstrapCapability,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const config = parseConfig(value),
    expected = proofCapabilityTarget(config, capability);
  signal.throwIfAborted();
  const remaining = Date.parse(config.input.claims.expires_at) - Date.now();
  if (remaining <= 0) return fail("session_expired");
  const authority = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.min(60_000, remaining)),
  ]);
  const base =
    config.input.api_base_url +
    `/internal/v1/node-proof/${config.input.claims.operation_id}`;
  const response = await request(base + "/transport", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.input.session_bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ capability, direction: config.direction }),
    signal: authority,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    return fail("transport_refused");
  }
  const body = await inspectionResponseBody(response, 16_384, authority);
  let transport: NodeBootstrapTransport;
  try {
    transport = NodeBootstrapTransport.parse(JSON.parse(body));
  } catch {
    return fail("transport_invalid");
  }
  const relay = new URL(base + "/relay");
  relay.protocol = "wss:";
  if (
    transport.expectedTarget.ip !== expected.ip ||
    transport.expectedTarget.port !== expected.port
  )
    return fail("transport_target_changed");
  if (transport.websocket_url !== relay.href)
    return fail("transport_endpoint_changed");
  authority.throwIfAborted();
  return transport;
}
export async function openProofTransport(
  config: ProofProxyConfig,
  capability: BootstrapCapability,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Duplex> {
  const value = parseConfig(config),
    remaining = Date.parse(value.input.claims.expires_at) - Date.now();
  if (remaining <= 0) return fail("session_expired");
  const end = performance.now() + remaining,
    bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
  const transport = await authorizeProofTransport(
    value,
    capability,
    bounded,
    request,
  );
  const left = Math.floor(end - performance.now());
  if (left <= 0) return fail("session_expired");
  const socket = new WebSocket(transport.websocket_url, {
    headers: {
      authorization: `Bearer ${value.input.session_bearer}`,
      [BOOTSTRAP_RELAY_HEADER]: transport.token,
    },
    handshakeTimeout: Math.min(60_000, left),
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
      socket.once("error", () => reject(new Error("proof_relay_failed")));
      socket.once("close", () => reject(new Error("proof_relay_closed")));
    });
  } catch {
    socket.terminate();
    return fail("relay_failed");
  }
  const stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  socket.on("message", (_data, binary) => {
    if (!binary)
      stream.destroy(new BootstrapError("node_proof_binary_required"));
  });
  stream.once("close", () => socket.terminate());
  return stream;
}
export async function startProofProxy(
  value: ProofProxyConfig,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const config = parseConfig(value),
    sockets = new Set<Duplex>();
  const local = new AbortController(),
    lifetime = AbortSignal.any([signal, local.signal]);
  const server = createServer((_request, response) =>
    response.writeHead(405).end(),
  );
  server.maxConnections = 16;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.on("connect", (incoming, socket, head) => {
    let capability: BootstrapCapability | undefined;
    for (const candidate of ["talos_api", "kubernetes_api"] as const) {
      try {
        const target = proofCapabilityTarget(config, candidate);
        if (incoming.url === `${target.ip}:${target.port}`)
          capability = candidate;
      } catch {
        /* This direction has no such capability. */
      }
    }
    if (
      !capability ||
      head.length > 64 * 1024 ||
      sockets.size >= 16 ||
      signal.aborted
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.pause();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void openProofTransport(config, capability, lifetime, request)
      .then((bridge) => {
        sockets.add(bridge);
        bridge.once("close", () => sockets.delete(bridge));
        const close = () => {
          socket.destroy();
          bridge.destroy();
        };
        socket.once("error", close);
        bridge.once("error", close);
        socket.once("close", () => bridge.destroy());
        bridge.once("close", () => socket.destroy());
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) bridge.write(head);
        socket.pipe(bridge).pipe(socket);
        socket.resume();
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") return fail("proxy_failed");
  const stop = () => {
    local.abort();
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      signal.removeEventListener("abort", stop);
      stop();
      if (server.listening)
        await new Promise<void>((resolve) => server.once("close", resolve));
    },
  };
}
async function main() {
  if (process.argv.length !== 3 || !process.argv[2])
    return fail("proxy_input_required");
  const file = await open(process.argv[2], "r");
  let config: ProofProxyConfig;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 ** 2 || stat.mode & 0o077)
      return fail("proxy_input_invalid");
    config = parseConfig(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const bridge = await openProofTransport(
    config,
    "rescue_ssh",
    controller.signal,
  );
  await new Promise<void>((resolve, reject) => {
    const close = () => {
      process.stdin.unpipe(bridge);
      process.stdin.pause();
      resolve();
    };
    bridge.once("error", () =>
      reject(new BootstrapError("node_proof_proxy_failed")),
    );
    bridge.once("close", close);
    bridge.once("end", close);
    process.stdin.pipe(bridge).pipe(process.stdout);
  }).finally(() => bridge.destroy());
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /\/proof-proxy-command\.(?:ts|mjs)$/.test(new URL(import.meta.url).pathname)
)
  main().catch(() => {
    process.stderr.write("node_proof_proxy_failed\n");
    process.exitCode = 1;
  });
