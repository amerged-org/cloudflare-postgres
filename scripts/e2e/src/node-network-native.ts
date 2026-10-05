// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  sign,
  verify,
  createPublicKey,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { createConnection, createServer, isIP } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import type { TLSSocket } from "node:tls";

export const MAX_COMMAND_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
export function blocked(code: string): never {
  throw new Error(`node_network_${code}`);
}
const scanWorkerReasons = new Set([
  "node_network_address_invalid",
  "node_network_control_binding",
  "node_network_control_invalid",
  "node_network_control_unproven",
  "node_network_deadline",
  "node_network_family_mismatch",
  "node_network_scan_bounds",
  "node_network_scan_incomplete",
  "node_network_scan_inconclusive",
  "node_network_signature_invalid",
  "node_network_source_changed",
  "node_network_source_inside_allowlist",
  "node_network_source_pool_unproven",
  "node_network_source_unproven",
  "node_network_stale_measurement",
  "node_network_tcp25_control_unproven",
]);
export function assertScanWorkers(
  workers: PromiseSettledResult<unknown>[],
): void {
  const rejected = workers.find((worker) => worker.status === "rejected");
  if (!rejected) return;
  if (
    rejected.reason instanceof Error &&
    scanWorkerReasons.has(rejected.reason.message)
  )
    throw new Error(rejected.reason.message);
  blocked("scan_incomplete");
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function ip(address: string): string {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes("%") || address.includes("."))
    blocked("address_invalid");
  return new URL(`https://[${address}]`).hostname.slice(1, -1);
}
export function fresh(
  at: string,
  notBefore: string,
  now: number,
  age = 120_000,
): void {
  const parsed = Date.parse(at),
    floor = Date.parse(notBefore);
  if (
    !Number.isFinite(parsed) ||
    !Number.isFinite(floor) ||
    parsed < floor ||
    parsed < now - age ||
    parsed > now + 5000
  )
    blocked("stale_measurement");
}
export interface Envelope<T> {
  kid: string;
  payload: T;
  signature: string;
}
export function signed<T>(
  domain: string,
  payload: T,
  kid: string,
  key: KeyObject,
): Envelope<T> {
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(kid)
  )
    blocked("signing_key_invalid");
  return {
    kid,
    payload,
    signature: sign(
      null,
      Buffer.from(domain + canonical(payload)),
      key,
    ).toString("base64url"),
  };
}
export function authenticated<T>(
  domain: string,
  envelope: Envelope<T>,
  keys: Record<string, string>,
): T {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(keys[envelope.kid] ?? "", "base64url"),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(envelope.signature, "base64url");
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      signature.length !== 64 ||
      signature.toString("base64url") !== envelope.signature ||
      !verify(
        null,
        Buffer.from(domain + canonical(envelope.payload)),
        publicKey,
        signature,
      )
    )
      blocked("signature_invalid");
    return envelope.payload;
  } catch {
    return blocked("signature_invalid");
  }
}
export interface ReviewedCommand {
  program: string;
  sha256: string;
  args: string[];
}
export async function execute(
  command: ReviewedCommand,
  deadline: number,
  options: { stopAfterMs?: number; maxBytes?: number } = {},
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (
    !isAbsolute(command.program) ||
    !/^[a-f0-9]{64}$/.test(command.sha256) ||
    !Array.isArray(command.args) ||
    command.args.length > 128 ||
    command.args.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"),
    )
  )
    blocked("command_invalid");
  const file = await open(command.program, "r");
  try {
    const identity = await file.stat();
    if (!identity.isFile() || identity.size > 256 * 1024 * 1024)
      blocked("command_invalid");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      if (Date.now() >= deadline) blocked("deadline");
      digest.update(chunk);
    }
    if (digest.digest("hex") !== command.sha256)
      blocked("command_digest_changed");
  } finally {
    await file.close();
  }
  const remaining = Math.min(deadline - Date.now(), 600_000);
  if (remaining <= 0) blocked("deadline");
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      failure: string | null = null;
    const signal = (value: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, value);
      } catch {
        child.kill(value);
      }
    };
    const stop = (reason: string) => {
      failure ??= reason;
      signal("SIGKILL");
    };
    const timer = setTimeout(() => stop("command_deadline"), remaining);
    const graceful =
      options.stopAfterMs === undefined
        ? undefined
        : setTimeout(
            () => signal("SIGINT"),
            Math.min(options.stopAfterMs, remaining),
          );
    const collect = (target: Buffer[], bytes: Buffer) => {
      size += bytes.length;
      if (size > (options.maxBytes ?? MAX_COMMAND_BYTES)) stop("command_bytes");
      else target.push(bytes);
    };
    child.stdout.on("data", (bytes) => collect(stdout, bytes));
    child.stderr.on("data", (bytes) => collect(stderr, bytes));
    child.once("error", () => {
      failure ??= "command_failed";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (graceful) clearTimeout(graceful);
      if (failure || code !== 0)
        reject(new Error(`node_network_${failure ?? "command_failed"}`));
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
    });
  });
}
export async function writeArtifact(
  path: string,
  artifact: unknown,
): Promise<string> {
  const bytes = Buffer.from(canonical(artifact));
  if (bytes.length > MAX_JSON_BYTES) blocked("artifact_bytes");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (((await stat(path)).mode & 0o777) !== 0o600)
    blocked("artifact_permissions");
  return createHash("sha256").update(bytes).digest("hex");
}
export type TcpOutcome = "connected" | "refused" | "timed_out" | "inconclusive";
export async function tcp(
  address: string,
  port: number,
  source: string,
  timeout: number,
  deadline: number,
): Promise<TcpOutcome> {
  if (
    isIP(address) !== isIP(source) ||
    isIP(source) === 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    blocked("family_mismatch");
  if (Date.now() >= deadline) blocked("deadline");
  return new Promise((resolve) => {
    const socket = createConnection({
      host: address,
      family: isIP(address),
      port,
      localAddress: source,
    });
    let done = false;
    const finish = (result: TcpOutcome) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Math.min(timeout, Math.max(1, deadline - Date.now())));
    socket.once("connect", () =>
      finish(
        ip(socket.localAddress ?? "") === ip(source)
          ? "connected"
          : "inconclusive",
      ),
    );
    socket.once("timeout", () => finish("timed_out"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "refused" : "inconclusive"),
    );
    socket.once("close", () => finish("inconclusive"));
  });
}
const CONTROL_DOMAIN = "pgcf-node-source-control/v1\n";
export const HTTPS_CONTROL_DOMAIN = "pgcf-node-https-source-control/v1\n";
export interface HttpsSourceObservation {
  nonce: string;
  source: string;
  observed_at: string;
  origin: string;
}
export interface HttpsControl {
  origin: string;
  bearer: string;
  expires_at: string;
}
export function sourceObservation(
  envelope: Envelope<HttpsSourceObservation>,
  expected: {
    nonce: string;
    origin: string;
    address: string;
    port: number;
    localSource: string;
    socketLocal: string;
    socketRemote: string;
    keys: Record<string, string>;
  },
): ControlObservation {
  const result = authenticated(HTTPS_CONTROL_DOMAIN, envelope, expected.keys);
  if (
    Object.keys(result).sort().join(",") !==
      "nonce,observed_at,origin,source" ||
    result.nonce !== expected.nonce ||
    result.origin !== expected.origin ||
    isIP(result.source) !== isIP(expected.localSource) ||
    isIP(expected.address) !== isIP(expected.localSource) ||
    ip(expected.socketLocal) !== ip(expected.localSource) ||
    ip(expected.socketRemote) !== ip(expected.address) ||
    // IPv6 here is direct, with no translated or inferred public source.
    (isIP(expected.localSource) === 6 &&
      ip(result.source) !== ip(expected.localSource))
  )
    blocked("source_unproven");
  fresh(
    result.observed_at,
    new Date(Date.now() - 10_000).toISOString(),
    Date.now(),
    10_000,
  );
  return {
    address: ip(expected.socketRemote),
    port: expected.port,
    source: ip(result.source),
    observed_at: result.observed_at,
    nonce: result.nonce,
  };
}
export async function httpsSourceControl(
  address: string,
  source: string,
  keys: Record<string, string>,
  control: HttpsControl,
  deadline: number,
): Promise<ControlObservation> {
  let origin: URL;
  try {
    origin = new URL(control.origin);
  } catch {
    return blocked("control_invalid");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== control.origin ||
    origin.username ||
    origin.password ||
    origin.port ||
    isIP(origin.hostname) ||
    !control.bearer ||
    control.bearer.length > 256 ||
    Date.parse(control.expires_at) <= Date.now() ||
    Date.parse(control.expires_at) > Date.now() + 600_000 ||
    !Number.isFinite(Date.parse(control.expires_at)) ||
    isIP(address) !== isIP(source) ||
    !isIP(source) ||
    Date.now() >= deadline
  )
    blocked("control_invalid");
  const nonce = randomBytes(32).toString("hex"),
    body = JSON.stringify({ nonce });
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: address,
      port: 443,
      family: isIP(source),
      localAddress: source,
      servername: origin.hostname,
      agent: false,
      method: "POST",
      path: "/source-control",
      checkServerIdentity: (_host, certificate) =>
        checkServerIdentity(origin.hostname, certificate),
      headers: {
        Host: origin.hostname,
        Authorization: `Bearer ${control.bearer}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    let settled = false;
    const timer = setTimeout(
      () => fail(),
      Math.max(1, Math.min(5000, deadline - Date.now())),
    );
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(new Error("node_network_control_unproven"));
    };
    request.once("error", fail);
    request.once("response", (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        return fail();
      }
      const socket = response.socket as TLSSocket,
        socketLocal = socket.localAddress ?? "",
        socketRemote = socket.remoteAddress ?? "";
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (bytes: Buffer) => {
        size += bytes.length;
        if (size > 4096) {
          response.destroy();
          fail();
        } else chunks.push(bytes);
      });
      response.once("error", fail);
      response.once("aborted", fail);
      response.once("end", () => {
        if (settled) return;
        try {
          const result = sourceObservation(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            {
              nonce,
              origin: control.origin,
              address,
              port: 443,
              localSource: source,
              socketLocal,
              socketRemote,
              keys,
            },
          );
          settled = true;
          clearTimeout(timer);
          request.destroy();
          resolve(result);
        } catch {
          fail();
        }
      });
    });
    request.end(body);
  });
}
export async function routeSource(
  address: string,
  port: number,
  deadline: number,
): Promise<string> {
  if (!isIP(address) || Date.now() >= deadline) blocked("control_invalid");
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: address,
      family: isIP(address),
      port,
    });
    const timer = setTimeout(
      () => fail(),
      Math.max(1, Math.min(5000, deadline - Date.now())),
    );
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("node_network_source_unavailable"));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      if (
        !socket.localAddress ||
        !socket.remoteAddress ||
        ip(socket.remoteAddress) !== ip(address)
      )
        return fail();
      const source = ip(socket.localAddress);
      socket.destroy();
      resolve(source);
    });
  });
}
export interface ControlObservation {
  address: string;
  port: number;
  source: string;
  observed_at: string;
  nonce: string;
}
export async function sourceControl(
  address: string,
  port: number,
  source: string,
  keys: Record<string, string>,
  deadline: number,
): Promise<ControlObservation> {
  if (isIP(address) !== isIP(source) || !isIP(source))
    blocked("family_mismatch");
  const nonce = randomBytes(32).toString("hex");
  const envelope = await new Promise<Envelope<ControlObservation>>(
    (resolve, reject) => {
      const socket = createConnection({
        host: address,
        port,
        family: isIP(source),
        localAddress: source,
      });
      let text = "",
        settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("node_network_control_unproven"));
      };
      socket.setTimeout(
        Math.max(1, Math.min(5000, deadline - Date.now())),
        fail,
      );
      socket.once("error", fail);
      socket.once("end", fail);
      socket.once("connect", () => {
        if (ip(socket.localAddress ?? "") !== ip(source)) fail();
        else socket.write(nonce + "\n");
      });
      socket.on("data", (bytes) => {
        text += bytes.toString("utf8");
        if (Buffer.byteLength(text) > 4096) return fail();
        if (!text.includes("\n")) return;
        try {
          const parsed = JSON.parse(
            text.trim(),
          ) as Envelope<ControlObservation>;
          settled = true;
          socket.destroy();
          resolve(parsed);
        } catch {
          fail();
        }
      });
    },
  );
  const result = authenticated(CONTROL_DOMAIN, envelope, keys);
  if (
    result.nonce !== nonce ||
    ip(result.address) !== ip(address) ||
    result.port !== port ||
    ip(result.source) !== ip(source)
  )
    blocked("source_unproven");
  fresh(
    result.observed_at,
    new Date(Date.now() - 10_000).toISOString(),
    Date.now(),
    10_000,
  );
  return result;
}
export async function serveSourceControl(
  address: string,
  port: number,
  kid: string,
  key: KeyObject,
  durationMs: number,
): Promise<void> {
  if (!isIP(address) || durationMs < 1 || durationMs > 600_000)
    blocked("control_invalid");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5000, () => socket.destroy());
    let input = "";
    socket.on("data", (bytes) => {
      input += bytes.toString("utf8");
      if (input.length > 65) return socket.destroy();
      if (!input.endsWith("\n")) return;
      if (!/^[a-f0-9]{64}\n$/.test(input)) return socket.destroy();
      const payload = {
        address: ip(socket.localAddress ?? ""),
        port: socket.localPort!,
        source: ip(socket.remoteAddress ?? ""),
        observed_at: new Date().toISOString(),
        nonce: input.trim(),
      };
      socket.end(canonical(signed(CONTROL_DOMAIN, payload, kid, key)) + "\n");
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { host: address, port, ipv6Only: isIP(address) === 6 },
      resolve,
    );
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export interface PortCompletion {
  port: number;
  outcome: TcpOutcome;
}
export function completedScan(
  results: PortCompletion[],
  controls: { before: ControlObservation; after: ControlObservation },
  address: string,
  startedAt: string,
): { scanned_ports: 65535; open_ports: number[] } {
  const family = isIP(address),
    seen = new Set<number>();
  if (
    !family ||
    isIP(controls.before.source) !== family ||
    isIP(controls.before.address) !== family ||
    ip(controls.before.address) !== ip(controls.after.address) ||
    controls.before.port !== controls.after.port ||
    controls.before.observed_at > startedAt ||
    controls.after.observed_at < startedAt
  )
    blocked("control_binding");
  if (ip(controls.before.source) !== ip(controls.after.source))
    blocked("source_changed");
  const open: number[] = [];
  let inconclusive = false;
  for (const result of results) {
    if (
      !Number.isInteger(result.port) ||
      result.port < 1 ||
      result.port > 65535 ||
      seen.has(result.port) ||
      !["connected", "refused", "timed_out", "inconclusive"].includes(
        result.outcome,
      )
    )
      blocked("scan_incomplete");
    seen.add(result.port);
    if (result.outcome === "inconclusive") inconclusive = true;
    if (result.outcome === "connected") open.push(result.port);
  }
  if (seen.size !== 65535) blocked("scan_incomplete");
  if (inconclusive) blocked("scan_inconclusive");
  return { scanned_ports: 65535, open_ports: open.sort((a, b) => a - b) };
}
export async function scanAllPorts(
  address: string,
  source: string,
  control: {
    address: string;
    port: number;
    keys: Record<string, string>;
    https?: HttpsControl;
  },
  deadline: number,
  options: {
    concurrency?: number;
    timeoutMs?: number;
    sourceCheck?: (source: string) => void;
    tcp25Control?: string;
  } = {},
) {
  const concurrency = options.concurrency ?? 512,
    timeout = options.timeoutMs ?? 500;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 1024 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000
  )
    blocked("scan_bounds");
  if (control.https && control.port !== 443) blocked("control_invalid");
  const observe = () =>
    control.https
      ? httpsSourceControl(
          control.address,
          source,
          control.keys,
          control.https,
          deadline,
        )
      : sourceControl(
          control.address,
          control.port,
          source,
          control.keys,
          deadline,
        );
  const before = await observe(),
    started_at = new Date().toISOString();
  options.sourceCheck?.(before.source);
  const results: PortCompletion[] = [];
  let next = 1;
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next <= 65535) {
        const port = next++;
        if (
          port === 25 &&
          options.tcp25Control &&
          (await tcp(options.tcp25Control, 25, source, 5000, deadline)) !==
            "connected"
        )
          blocked("tcp25_control_unproven");
        results.push({
          port,
          outcome: await tcp(address, port, source, timeout, deadline),
        });
        if (
          port === 25 &&
          options.tcp25Control &&
          (await tcp(options.tcp25Control, 25, source, 5000, deadline)) !==
            "connected"
        )
          blocked("tcp25_control_unproven");
      }
    }),
  );
  assertScanWorkers(workers);
  const after = await observe();
  options.sourceCheck?.(after.source);
  return {
    public_source: before.source,
    ...completedScan(results, { before, after }, address, started_at),
    started_at,
    observed_at: after.observed_at,
    before,
    after,
  };
}
