// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { setMaxListeners } from "node:events";
import net, { isIP, type Socket } from "node:net";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { checkServerIdentity } from "node:tls";
import { NodeId, OperationId, RegionId, Timestamp } from "@pgcf/contracts";
import { ProviderInstanceId } from "@pgcf/contracts/nodes";
import { NodeBootstrapMaintenanceBinding } from "@pgcf/contracts/node-bootstrap";
import { NodeProofSessionBearer } from "@pgcf/contracts/node-proof";
import {
  authenticated,
  completedScan,
  fresh,
  hash,
  ip,
  sourceObservation,
  type ControlObservation,
  type Envelope,
  type HttpsControl,
  type HttpsSourceObservation,
  type PortCompletion,
  type TcpOutcome,
} from "../../../scripts/e2e/src/node-network-native.ts";
import type {
  Measurement,
  MeasurementBinding,
  NetworkPlan,
} from "../../../scripts/e2e/src/node-network-proof.ts";
import { BootstrapError } from "./bootstrap-error.ts";

export interface OutsideScanInput {
  plan: NetworkPlan;
  binding: MeasurementBinding;
  family: "ipv4" | "ipv6";
  control_keys: Record<string, string>;
  https_control?: HttpsControl;
  source_pool?: string[];
  local_source?: string;
  direct_source?: string;
  deadline_at: string;
  tcp25_control?: string;
}
export interface OutsideScanOptions {
  signal?: AbortSignal;
  concurrency?: number;
  timeoutMs?: number;
}
export type OutsideScanMeasurement = Extract<Measurement, { kind: "scan" }>;
const sourceDomain = "pgcf-node-source-control/v1\n";
const socketCodes = new Set([
  "EAFNOSUPPORT",
  "EPROTONOSUPPORT",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EMFILE",
  "ENFILE",
  "ENOBUFS",
  "ENOMEM",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
]);
const fail = (code: string): never => {
  throw new BootstrapError(`outside_scan_${code}`);
};
function gap(error: unknown, family: number): BootstrapError {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    socketCodes.has(error.code)
      ? error.code.toLowerCase()
      : "socket_unproven";
  return new BootstrapError(`outside_scan_capability_gap_ipv${family}_${code}`);
}
function safeFailure(error: unknown): BootstrapError {
  if (
    error instanceof BootstrapError &&
    /^outside_scan_[a-z0-9_]{1,100}$/.test(error.code)
  )
    return error;
  if (
    error instanceof Error &&
    error.message === "node_network_source_unproven"
  )
    return new BootstrapError("outside_scan_source_unproven");
  return new BootstrapError("outside_scan_control_unproven");
}
class Budget {
  readonly end: number;
  readonly abort = new AbortController();
  readonly signal: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
  failure: BootstrapError | null = null;
  constructor(deadline: string, caller?: AbortSignal) {
    if (caller?.aborted) throw new BootstrapError("outside_scan_cancelled");
    const remaining = Date.parse(Timestamp.parse(deadline)) - Date.now();
    if (remaining <= 0 || remaining > 600_000)
      throw new BootstrapError("outside_scan_deadline_invalid");
    this.end = performance.now() + remaining;
    this.signal = AbortSignal.any([
      this.abort.signal,
      ...(caller ? [caller] : []),
    ]);
    setMaxListeners(4096, this.signal);
    this.timer = setTimeout(
      () => this.stop(new BootstrapError("outside_scan_deadline")),
      remaining,
    );
    this.timer.unref();
  }
  remaining() {
    return Math.floor(this.end - performance.now());
  }
  check() {
    if (this.failure) throw this.failure;
    if (this.signal.aborted) return fail("cancelled");
    if (this.remaining() <= 0) return fail("deadline");
  }
  stop(error: BootstrapError) {
    this.failure ??= error;
    this.abort.abort();
  }
  close() {
    clearTimeout(this.timer);
    this.abort.abort();
  }
}
function nativeSocket(
  address: string,
  port: number,
  source: string | undefined,
): Socket {
  return net.createConnection({
    host: address,
    port,
    family: isIP(address),
    ...(source ? { localAddress: source } : {}),
  });
}
function probe(
  address: string,
  port: number,
  source: string,
  timeout: number,
  budget: Budget,
): Promise<TcpOutcome> {
  budget.check();
  if (
    !isIP(address) ||
    isIP(address) !== isIP(source) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000
  )
    return fail("probe_invalid");
  // A shortened last probe would turn deadline exhaustion into a false closed-port claim.
  if (budget.remaining() <= timeout) return fail("deadline");
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = nativeSocket(address, port, source);
    } catch (error) {
      reject(gap(error, isIP(address)));
      return;
    }
    let settled = false;
    const finish = (value?: TcpOutcome, error?: BootstrapError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      budget.signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () =>
      finish(
        undefined,
        budget.failure ?? new BootstrapError("outside_scan_cancelled"),
      );
    const timer = setTimeout(() => {
      try {
        budget.check();
        finish("timed_out");
      } catch (error) {
        finish(undefined, safeFailure(error));
      }
    }, timeout);
    budget.signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      try {
        budget.check();
        if (
          ip(socket.localAddress ?? "") !== ip(source) ||
          ip(socket.remoteAddress ?? "") !== ip(address) ||
          socket.remotePort !== port
        )
          return finish(
            undefined,
            new BootstrapError("outside_scan_source_unproven"),
          );
        finish("connected");
      } catch (error) {
        finish(undefined, safeFailure(error));
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish("refused");
      else finish(undefined, gap(error, isIP(address)));
    });
    socket.once("close", () =>
      finish(undefined, new BootstrapError("outside_scan_probe_inconclusive")),
    );
    if (budget.signal.aborted) abort();
  });
}

/** Native primitive used by the owned-plan scanner; it never converts routing errors into closed ports. */
export async function probeOutsideTcp(
  input: {
    address: string;
    port: number;
    source: string;
    timeout_ms: number;
    deadline_at: string;
  },
  signal?: AbortSignal,
): Promise<TcpOutcome> {
  const budget = new Budget(input.deadline_at, signal);
  try {
    return await probe(
      ip(input.address),
      input.port,
      ip(input.source),
      input.timeout_ms,
      budget,
    );
  } finally {
    budget.close();
  }
}
async function routeSource(
  address: string,
  port: number,
  budget: Budget,
): Promise<string> {
  budget.check();
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = nativeSocket(address, port, undefined);
    } catch (error) {
      reject(gap(error, isIP(address)));
      return;
    }
    let settled = false;
    const finish = (source?: string, error?: BootstrapError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      budget.signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(source!);
    };
    const abort = () =>
      finish(
        undefined,
        budget.failure ?? new BootstrapError("outside_scan_cancelled"),
      );
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new BootstrapError(
            `outside_scan_capability_gap_ipv${isIP(address)}_control_timeout`,
          ),
        ),
      Math.min(5000, budget.remaining()),
    );
    budget.signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      try {
        if (
          !socket.localAddress ||
          !socket.remoteAddress ||
          ip(socket.remoteAddress) !== ip(address) ||
          socket.remotePort !== port
        )
          return finish(
            undefined,
            new BootstrapError("outside_scan_source_unproven"),
          );
        budget.check();
        finish(ip(socket.localAddress));
      } catch (error) {
        finish(undefined, safeFailure(error));
      }
    });
    socket.once("error", (error) =>
      finish(undefined, gap(error, isIP(address))),
    );
    socket.once("close", () =>
      finish(undefined, new BootstrapError("outside_scan_control_unproven")),
    );
    if (budget.signal.aborted) abort();
  });
}
function ipValue(address: string): { family: number; value: bigint } {
  const normalized = ip(address),
    family = isIP(normalized);
  if (family === 4)
    return {
      family,
      value: normalized
        .split(".")
        .reduce((value, octet) => value * 256n + BigInt(octet), 0n),
    };
  const [left = "", right = ""] = normalized.split("::"),
    first = left ? left.split(":") : [],
    last = right ? right.split(":") : [];
  const groups = normalized.includes("::")
    ? [...first, ...Array(8 - first.length - last.length).fill("0"), ...last]
    : first;
  return {
    family,
    value: groups.reduce(
      (value, group) => value * 65536n + BigInt(`0x${group}`),
      0n,
    ),
  };
}
function cidr(value: string) {
  const parts = value.split("/");
  if (parts.length !== 2 || !/^(?:0|[1-9][0-9]{0,2})$/.test(parts[1]!))
    return fail("source_pool_unproven");
  const address = ipValue(parts[0]!),
    width = address.family === 4 ? 32 : 128,
    prefix = Number(parts[1]);
  if (prefix > width) return fail("source_pool_unproven");
  const mask = (1n << BigInt(width - prefix)) - 1n;
  return {
    family: address.family,
    first: address.value & ~mask,
    last: address.value | mask,
  };
}
function contains(
  range: ReturnType<typeof cidr>,
  address: ReturnType<typeof ipValue>,
) {
  return (
    range.family === address.family &&
    range.first <= address.value &&
    address.value <= range.last
  );
}
function publicDirectSource(source: string): boolean {
  if (isIP(source) === 6) return ipValue(source).value >> 125n === 1n;
  const [first, second] = source.split(".").map(Number);
  return (
    first !== undefined &&
    second !== undefined &&
    first > 0 &&
    first < 224 &&
    first !== 10 &&
    first !== 127 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 168) &&
    !(first === 198 && [18, 19].includes(second))
  );
}
function outside(input: OutsideScanInput, source: string, local: string) {
  const family = input.family,
    address = ipValue(source),
    numeric = family === "ipv4" ? 4 : 6;
  if (address.family !== numeric || isIP(local) !== numeric)
    return fail("source_unproven");
  const rules = input.plan.members.flatMap((member) =>
    member.rules.rules.inbound.flatMap((rule) => rule.srcCidr[family] ?? []),
  );
  const allowlist = [
    ...input.plan.operators[family],
    ...rules,
    ...input.plan.relay.addresses[family].map(
      (value) => `${ip(value)}/${numeric === 4 ? 32 : 128}`,
    ),
    ...input.plan.members
      .flatMap((member) => member.addresses[family])
      .map((value) => `${ip(value)}/${numeric === 4 ? 32 : 128}`),
    `${ip(input.plan.scan_control[family])}/${numeric === 4 ? 32 : 128}`,
  ].map(cidr);
  if (allowlist.some((range) => contains(range, address)))
    return fail("source_inside_allowlist");
  if (input.direct_source) {
    if (
      ip(input.direct_source) !== ip(local) ||
      ip(source) !== ip(input.direct_source)
    )
      return fail("source_unproven");
    return;
  }
  if (numeric === 6 && ip(source) !== ip(local)) return fail("source_unproven");
  if (input.https_control && numeric === 4) {
    if (
      !input.source_pool?.length ||
      input.source_pool.length > 256 ||
      !rules.length
    )
      return fail("source_pool_unproven");
    const pool = input.source_pool.map(cidr);
    if (
      !pool.some((range) => contains(range, address)) ||
      pool.some((range) =>
        allowlist.some(
          (allowed) =>
            range.family === allowed.family &&
            !(range.last < allowed.first || allowed.last < range.first),
        ),
      )
    )
      return fail("source_pool_unproven");
  } else if (ip(source) !== ip(local)) return fail("source_unproven");
}
function validateInput(value: OutsideScanInput) {
  const input = structuredClone(value),
    plan = input.plan;
  const inputFields = new Set([
    "plan",
    "binding",
    "family",
    "control_keys",
    "https_control",
    "source_pool",
    "local_source",
    "direct_source",
    "deadline_at",
    "tcp25_control",
  ]);
  if (Object.keys(input).some((key) => !inputFields.has(key)))
    return fail("input_invalid");
  const bindingFields = [
    "plan_sha256",
    "readback_at",
    "verification",
    ...(input.binding.maintenance === undefined ? [] : ["maintenance"]),
  ];
  if (
    Object.keys(input.binding).sort().join(",") !==
    bindingFields.sort().join(",")
  )
    return fail("plan_binding");
  if (hash(plan) !== input.binding.plan_sha256 || plan.version !== 1)
    return fail("plan_binding");
  OperationId.parse(plan.operation_id);
  NodeId.parse(plan.node_id);
  RegionId.parse(plan.region_id);
  ProviderInstanceId.parse(plan.provider_instance_id);
  Timestamp.parse(input.binding.readback_at);
  if (Date.parse(input.binding.readback_at) > Date.now())
    return fail("plan_binding");
  if (
    input.binding.maintenance !== undefined &&
    (input.binding.verification !== null ||
      !NodeBootstrapMaintenanceBinding.safeParse(input.binding.maintenance)
        .success)
  )
    return fail("plan_binding");
  if (input.binding.verification !== null) {
    const binding = input.binding.verification;
    if (
      !binding ||
      Object.keys(binding).sort().join(",") !==
        "checkpoint_reference,cluster_uid,hostname,input_hash,node_resource_version,node_uid" ||
      !/^[a-f0-9]{64}$/.test(binding.input_hash) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
        binding.cluster_uid,
      ) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
        binding.node_uid,
      ) ||
      !/^[0-9]{1,128}$/.test(binding.node_resource_version) ||
      typeof binding.checkpoint_reference !== "string" ||
      binding.checkpoint_reference.length < 1 ||
      binding.checkpoint_reference.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(binding.hostname)
    )
      return fail("plan_binding");
  }
  if (
    !["ipv4", "ipv6"].includes(input.family) ||
    !Array.isArray(plan.members) ||
    !plan.members.length ||
    plan.members.length > 16 ||
    !Number.isInteger(plan.scan_control.port) ||
    plan.scan_control.port < 1 ||
    plan.scan_control.port > 65535
  )
    return fail("input_invalid");
  if (isIP(plan.scan_control.ipv4) !== 4 || isIP(plan.scan_control.ipv6) !== 6)
    return fail("control_invalid");
  if (input.https_control && plan.scan_control.port !== 443)
    return fail("control_invalid");
  for (const family of ["ipv4", "ipv6"] as const) {
    const numeric = family === "ipv4" ? 4 : 6;
    for (const values of [
      plan.relay.addresses[family],
      ...plan.members.map((member) => member.addresses[family]),
    ]) {
      if (
        !Array.isArray(values) ||
        values.length > 64 ||
        new Set(values.map(ip)).size !== values.length ||
        values.some((address) => isIP(address) !== numeric)
      )
        return fail("plan_binding");
    }
  }
  const names = new Set<string>(),
    providers = new Set<string>();
  for (const member of plan.members) {
    NodeId.parse(member.node_id);
    ProviderInstanceId.parse(member.provider_instance_id);
    if (names.has(member.node_id) || providers.has(member.provider_instance_id))
      return fail("plan_binding");
    names.add(member.node_id);
    providers.add(member.provider_instance_id);
  }
  if (
    !plan.members.some(
      (member) =>
        member.node_id === plan.node_id &&
        member.provider_instance_id === plan.provider_instance_id,
    )
  )
    return fail("plan_binding");
  if (input.direct_source && !publicDirectSource(ip(input.direct_source)))
    return fail("source_not_public");
  if (
    input.direct_source &&
    input.local_source &&
    ip(input.direct_source) !== ip(input.local_source)
  )
    return fail("source_unproven");
  return input;
}
class ControlSession {
  readonly input: OutsideScanInput;
  readonly source: string;
  readonly budget: Budget;
  readonly sourceCheck: (source: string) => void;
  readonly agent = new https.Agent({
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
    rejectUnauthorized: true,
  });
  private socket?: TLSSocket;
  private publicSource?: string;
  private heartbeat: Promise<void> | null = null;
  private interval?: ReturnType<typeof setInterval>;
  constructor(input: OutsideScanInput, source: string, budget: Budget) {
    this.input = input;
    this.source = source;
    this.budget = budget;
    this.sourceCheck = (actual) => {
      outside(input, actual, source);
      if (this.publicSource !== undefined && this.publicSource !== ip(actual))
        return fail("source_changed");
      this.publicSource = ip(actual);
    };
  }
  startHeartbeat() {
    this.interval = setInterval(() => {
      if (this.heartbeat || this.budget.signal.aborted) return;
      this.heartbeat = this.observe()
        .then(() => undefined)
        .catch((error: unknown) => this.budget.stop(safeFailure(error)))
        .finally(() => {
          this.heartbeat = null;
        });
    }, 20_000);
    this.interval.unref();
  }
  async observe(): Promise<ControlObservation> {
    this.budget.check();
    const observation = this.input.https_control
      ? await this.httpsControl()
      : await this.tcpControl();
    this.sourceCheck(observation.source);
    return observation;
  }
  private httpsControl(): Promise<ControlObservation> {
    const control = this.input.https_control!,
      origin = new URL(control.origin),
      address = ip(this.input.plan.scan_control[this.input.family]);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== control.origin ||
      origin.port ||
      origin.username ||
      origin.password ||
      isIP(origin.hostname) ||
      !control.bearer ||
      (control.bearer.length > 256 &&
        !NodeProofSessionBearer.safeParse(control.bearer).success) ||
      /[\r\n\0]/.test(control.bearer) ||
      !Number.isFinite(Date.parse(control.expires_at)) ||
      Date.parse(control.expires_at) <= Date.now() ||
      Date.parse(control.expires_at) > Date.now() + 600_000
    )
      return fail("control_invalid");
    const nonce = randomBytes(32).toString("hex"),
      body = JSON.stringify({ nonce });
    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: address,
        port: 443,
        family: isIP(this.source),
        localAddress: this.source,
        servername: origin.hostname,
        agent: this.agent,
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
      let response: net.Socket | { destroy(): void } | undefined,
        settled = false;
      const finish = (value?: ControlObservation, error?: BootstrapError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.budget.signal.removeEventListener("abort", abort);
        if (error) {
          response?.destroy();
          request.destroy();
          reject(error);
        } else resolve(value!);
      };
      const abort = () =>
        finish(
          undefined,
          this.budget.failure ?? new BootstrapError("outside_scan_cancelled"),
        );
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            new BootstrapError(
              `outside_scan_capability_gap_ipv${isIP(this.source)}_control_timeout`,
            ),
          ),
        Math.min(5000, this.budget.remaining()),
      );
      this.budget.signal.addEventListener("abort", abort, { once: true });
      request.once("error", (error) =>
        finish(undefined, gap(error, isIP(this.source))),
      );
      request.once("response", (incoming) => {
        response = incoming;
        if (incoming.statusCode !== 200)
          return finish(
            undefined,
            new BootstrapError("outside_scan_control_http_refused"),
          );
        const socket = incoming.socket as TLSSocket,
          local = socket.localAddress ?? "",
          remote = socket.remoteAddress ?? "";
        if (
          socket.authorized !== true ||
          socket.remotePort !== 443 ||
          (this.socket && this.socket !== socket)
        )
          return finish(
            undefined,
            new BootstrapError("outside_scan_control_session_changed"),
          );
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096)
            finish(
              undefined,
              new BootstrapError("outside_scan_control_response_limit"),
            );
          else chunks.push(chunk);
        });
        incoming.once("error", (error) =>
          finish(undefined, gap(error, isIP(this.source))),
        );
        incoming.once("aborted", () =>
          finish(
            undefined,
            new BootstrapError("outside_scan_control_response_aborted"),
          ),
        );
        incoming.once("end", () => {
          if (settled) return;
          try {
            this.budget.check();
            const envelope = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as Envelope<HttpsSourceObservation>;
            const observation = sourceObservation(envelope, {
              nonce,
              origin: control.origin,
              address,
              port: 443,
              localSource: this.source,
              socketLocal: local,
              socketRemote: remote,
              keys: this.input.control_keys,
            });
            this.socket = socket;
            finish(observation);
          } catch (error) {
            finish(undefined, safeFailure(error));
          }
        });
      });
      if (this.budget.signal.aborted) abort();
      else request.end(body);
    });
  }
  private tcpControl(): Promise<ControlObservation> {
    const address = ip(this.input.plan.scan_control[this.input.family]),
      port = this.input.plan.scan_control.port,
      nonce = randomBytes(32).toString("hex");
    return new Promise((resolve, reject) => {
      let socket: Socket;
      try {
        socket = nativeSocket(address, port, this.source);
      } catch (error) {
        reject(gap(error, isIP(this.source)));
        return;
      }
      let settled = false,
        bytes = 0;
      const chunks: Buffer[] = [];
      const finish = (value?: ControlObservation, error?: BootstrapError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.budget.signal.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () =>
        finish(
          undefined,
          this.budget.failure ?? new BootstrapError("outside_scan_cancelled"),
        );
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            new BootstrapError(
              `outside_scan_capability_gap_ipv${isIP(this.source)}_control_timeout`,
            ),
          ),
        Math.min(5000, this.budget.remaining()),
      );
      this.budget.signal.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        try {
          if (
            ip(socket.localAddress ?? "") !== ip(this.source) ||
            ip(socket.remoteAddress ?? "") !== address ||
            socket.remotePort !== port
          )
            return finish(
              undefined,
              new BootstrapError("outside_scan_source_unproven"),
            );
          socket.write(nonce + "\n");
        } catch (error) {
          finish(undefined, safeFailure(error));
        }
      });
      socket.once("error", (error) =>
        finish(undefined, gap(error, isIP(this.source))),
      );
      socket.once("close", () =>
        finish(
          undefined,
          new BootstrapError("outside_scan_control_peer_closed"),
        ),
      );
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096)
          return finish(
            undefined,
            new BootstrapError("outside_scan_control_response_limit"),
          );
        chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        if (!body.includes("\n")) return;
        try {
          this.budget.check();
          const envelope = JSON.parse(
              body.trim(),
            ) as Envelope<ControlObservation>,
            result = authenticated(
              sourceDomain,
              envelope,
              this.input.control_keys,
            ),
            now = Date.now();
          if (
            Object.keys(result).sort().join(",") !==
              "address,nonce,observed_at,port,source" ||
            result.nonce !== nonce ||
            ip(result.address) !== address ||
            result.port !== port ||
            ip(result.source) !== ip(this.source)
          )
            return finish(
              undefined,
              new BootstrapError("outside_scan_source_unproven"),
            );
          fresh(
            result.observed_at,
            new Date(now - 10_000).toISOString(),
            now,
            10_000,
          );
          finish({ ...result, observed_at: new Date(now).toISOString() });
        } catch (error) {
          finish(undefined, safeFailure(error));
        }
      });
      if (this.budget.signal.aborted) abort();
    });
  }
  async close() {
    if (this.interval) clearInterval(this.interval);
    this.agent.destroy();
    await this.heartbeat;
  }
}

/** Scan only the bound owned plan; an unavailable family or route never produces a partial closed report. */
export async function scanOutsideFamily(
  value: OutsideScanInput,
  options: OutsideScanOptions = {},
): Promise<OutsideScanMeasurement> {
  if (options.signal?.aborted) return fail("cancelled");
  const input = validateInput(value),
    concurrency = options.concurrency ?? 1024,
    timeout = options.timeoutMs ?? 500;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 1024 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000
  )
    return fail("bounds_invalid");
  const family = input.family === "ipv4" ? 4 : 6,
    members =
      input.binding.verification === null
        ? input.plan.members
        : input.plan.members.filter(
            (member) => member.node_id === input.plan.node_id,
          );
  const targets = members.flatMap((member) =>
    member.addresses[input.family].map((address) => ({
      provider: member.provider_instance_id,
      address: ip(address),
    })),
  );
  if (
    !targets.length ||
    targets.length > 64 ||
    new Set(targets.map((target) => target.address)).size !== targets.length
  )
    return fail("targets_unavailable");
  const budget = new Budget(input.deadline_at, options.signal);
  let control: ControlSession | undefined;
  try {
    const source = ip(
      input.direct_source ??
        input.local_source ??
        (await routeSource(
          ip(input.plan.scan_control[input.family]),
          input.plan.scan_control.port,
          budget,
        )),
    );
    if (isIP(source) !== family) return fail("source_unproven");
    control = new ControlSession(input, source, budget);
    const states: {
      before: ControlObservation;
      started_at: string;
      results: PortCompletion[];
      next: number;
    }[] = [];
    for (let index = 0; index < targets.length; index++) {
      const before = await control.observe();
      states.push({ before, started_at: "", results: [], next: 1 });
    }
    control.startHeartbeat();
    let cursor = 0;
    const take = () => {
      for (let count = 0; count < states.length; count++) {
        const index = cursor++ % states.length,
          state = states[index]!;
        if (state.next <= 65535) return { index, port: state.next++ };
      }
      return null;
    };
    const workers = await Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          budget.check();
          const task = take();
          if (!task) return;
          const state = states[task.index]!,
            target = targets[task.index]!;
          if (!state.started_at) state.started_at = new Date().toISOString();
          try {
            if (
              task.port === 25 &&
              input.tcp25_control &&
              (await probe(
                ip(input.tcp25_control),
                25,
                source,
                5000,
                budget,
              )) !== "connected"
            )
              return fail("tcp25_control_unproven");
            state.results.push({
              port: task.port,
              outcome: await probe(
                target.address,
                task.port,
                source,
                timeout,
                budget,
              ),
            });
            if (
              task.port === 25 &&
              input.tcp25_control &&
              (await probe(
                ip(input.tcp25_control),
                25,
                source,
                5000,
                budget,
              )) !== "connected"
            )
              return fail("tcp25_control_unproven");
          } catch (error) {
            budget.stop(safeFailure(error));
            throw budget.failure;
          }
        }
      }),
    );
    if (budget.failure) throw budget.failure;
    budget.check();
    if (workers.some((worker) => worker.status === "rejected"))
      return fail("incomplete");
    const scans: OutsideScanMeasurement["scans"] = [];
    for (let index = 0; index < targets.length; index++) {
      budget.check();
      const state = states[index]!,
        target = targets[index]!,
        after = await control.observe();
      const completed = completedScan(
        state.results,
        { before: state.before, after },
        target.address,
        state.started_at,
      );
      fresh(state.before.observed_at, input.binding.readback_at, Date.now());
      fresh(after.observed_at, state.started_at, Date.now());
      scans.push({
        provider_instance_id: target.provider,
        address: target.address,
        protocol: "tcp",
        first_port: 1,
        last_port: 65535,
        scanned_ports: completed.scanned_ports,
        open_ports: completed.open_ports,
        started_at: state.started_at,
        observed_at: after.observed_at,
        before: state.before,
        after,
      });
    }
    budget.check();
    return {
      purpose: "pgcf-node-measurement/v1",
      kind: "scan",
      binding_sha256: hash(input.binding),
      observed_at: new Date().toISOString(),
      family: input.family,
      source: states[0]!.before.source,
      scans,
    };
  } catch (error) {
    throw safeFailure(error);
  } finally {
    budget.close();
    await control?.close();
  }
}
