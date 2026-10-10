// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import { createConnection, isIP, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import tls from "node:tls";
import { parse, parseAllDocuments, stringify } from "yaml";
import type { z } from "zod";
import { RegionMaterialRotationVerification } from "@pgcf/contracts/region-material-rotation";
import { jsonRecords, nativeTalosConfig } from "./bootstrap.ts";
import { startCapabilityProxy } from "./proxy-command.ts";
import { stopChild, type openTalosOperator } from "./talos-operator.ts";
import {
  parseAuthorityPEMEnvelope,
  type AuthorityDocuments,
} from "./region-authority-phases.ts";

type ObjectValue = Record<string, unknown>;
type Session = Awaited<ReturnType<typeof openTalosOperator>>;
type Verification = z.infer<typeof RegionMaterialRotationVerification>;
type Authority = Verification["retired_authorities"][number]["authority"];
type ProbeResult = {
  ok: boolean;
  status?: number;
  grpc_status?: number;
  tls_error_code?: string;
  error?: string;
  reply_sha256?: string;
  reply?: ObjectValue;
  range?: ReturnType<typeof decodeEncryptedSecretRange>;
};
const CAP = 4 * 1024 * 1024,
  PREFIX = Buffer.from("/registry/secrets/"),
  CIPHER = Buffer.from("k8s:enc:secretbox:v1:"),
  LIMIT = 256;
const CERT_RPC = "/securityapi.SecurityService/Certificate",
  STATUS_RPC = "/etcdserverpb.Maintenance/Status",
  RANGE_RPC = "/etcdserverpb.KV/Range";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hashValue = (value: unknown) => hash(JSON.stringify(value));
function fail(code: string): never {
  throw Error(`authority_probe_${code}`);
}
function must(value: unknown, code: string): asserts value {
  if (!value) fail(code);
}
function object(value: unknown): ObjectValue {
  must(value && typeof value === "object" && !Array.isArray(value), "shape");
  return value as ObjectValue;
}
function text(value: unknown): string {
  must(typeof value === "string" && value.length, "shape");
  return value;
}
function array(value: unknown): unknown[] {
  must(Array.isArray(value), "shape");
  return value;
}
function one(documents: AuthorityDocuments, kind: string) {
  const rows = documents.filter((doc) =>
    kind === "legacy"
      ? doc.version === "v1alpha1" && doc.machine && !doc.kind
      : doc.kind === kind,
  );
  must(rows.length === 1, "document_count");
  return rows[0]!;
}
function at(root: unknown, ...fields: string[]): unknown {
  let value = root;
  for (const field of fields) value = object(value)[field];
  return value;
}
function decoded(value: unknown): Buffer {
  const encoded = text(value),
    bytes = Buffer.from(encoded, "base64");
  must(
    bytes.length &&
      bytes.toString("base64").replace(/=+$/, "") ===
        encoded.replace(/=+$/, ""),
    "encoded_material",
  );
  return bytes;
}
function certificate(value: unknown) {
  try {
    return new X509Certificate(text(value));
  } catch {
    fail("certificate_invalid");
  }
}
function certificateID(value: unknown) {
  return hash(certificate(value).raw);
}
function privateKey(value: unknown) {
  try {
    const pem = text(value);
    const envelope = parseAuthorityPEMEnvelope(pem);
    if (envelope?.label === "ED25519 PRIVATE KEY") {
      const key = createPrivateKey({
        key: Buffer.from(envelope.body, "base64"),
        format: "der",
        type: "pkcs8",
      });
      must(key.asymmetricKeyType === "ed25519", "key_invalid");
      return key;
    }
    return createPrivateKey(pem);
  } catch {
    fail("key_invalid");
  }
}
function publicID(value: unknown) {
  try {
    return hash(
      createPublicKey(privateKey(value)).export({
        type: "spki",
        format: "der",
      }),
    );
  } catch {
    fail("key_invalid");
  }
}
function acceptedPublicID(value: unknown) {
  try {
    return hash(
      createPublicKey(text(value)).export({ type: "spki", format: "der" }),
    );
  } catch {
    fail("key_invalid");
  }
}
function secretbox(documents: AuthorityDocuments) {
  const resources = array(
      at(one(documents, "KubeEtcdEncryptionConfig"), "config", "resources"),
    ),
    slots = resources.flatMap((resource) =>
      array(object(resource).resources).includes("secrets")
        ? array(object(resource).providers).flatMap((provider) =>
            object(provider).secretbox
              ? [array(at(provider, "secretbox", "keys"))]
              : [],
          )
        : [],
    );
  must(
    slots.length === 1 && slots[0]!.length === 1,
    "canonical_secretbox_required",
  );
  const key = object(slots[0]![0]),
    secret = decoded(key.secret),
    name = text(key.name);
  must(
    secret.length === 32 && /^[a-zA-Z0-9_-]{1,64}$/.test(name),
    "secretbox_shape",
  );
  return { secret, name };
}
function fingerprints(
  documents: AuthorityDocuments,
): Record<Authority, string> {
  const legacy = one(documents, "legacy");
  return {
    talos_api_ca: certificateID(
      decoded(at(legacy, "machine", "ca", "crt")).toString(),
    ),
    kubernetes_api_ca: certificateID(
      at(one(documents, "KubeAPIServerCAConfig"), "issuingCA", "cert"),
    ),
    etcd_ca: certificateID(
      decoded(at(legacy, "cluster", "etcd", "ca", "crt")).toString(),
    ),
    aggregator_ca: certificateID(
      at(one(documents, "KubeAggregatorCAConfig"), "issuingCA", "cert"),
    ),
    service_account_signer: publicID(
      at(one(documents, "KubeServiceAccountConfig"), "issuer", "privateKey"),
    ),
    trustd_token: hash(text(at(legacy, "machine", "token"))),
    kubernetes_bootstrap_token: hash(text(at(legacy, "cluster", "token"))),
    discovery_secret: hash(
      decoded(one(documents, "DiscoveryIdentityConfig").clusterSecret),
    ),
    secret_at_rest_key: hash(secretbox(documents).secret),
  };
}
function validateFinal(
  documents: AuthorityDocuments,
  replacement: AuthorityDocuments,
  old: Record<Authority, string>,
  next: Record<Authority, string>,
) {
  const actual = fingerprints(documents);
  for (const authority of Object.keys(next) as Authority[])
    must(actual[authority] === next[authority], "current_authority_differs");
  for (const fields of [
    ["machine", "ca", "key"],
    ["cluster", "etcd", "ca", "key"],
  ])
    must(
      publicID(decoded(at(one(documents, "legacy"), ...fields)).toString()) ===
        publicID(decoded(at(one(replacement, "legacy"), ...fields)).toString()),
      "current_issuing_key_differs",
    );
  for (const [kind, authority] of [
    ["KubeAPIServerCAConfig", "kubernetes_api_ca"],
    ["KubeAggregatorCAConfig", "aggregator_ca"],
  ] as const) {
    must(
      publicID(at(one(documents, kind), "issuingCA", "key")) ===
        publicID(at(one(replacement, kind), "issuingCA", "key")),
      "current_issuing_key_differs",
    );
    for (const cert of (one(documents, kind).acceptedCAs ?? []) as unknown[])
      must(
        certificateID(cert) === next[authority] &&
          certificateID(cert) !== old[authority],
        "retired_trust_remains",
      );
  }
  const legacy = one(documents, "legacy");
  for (const ca of (object(legacy.machine).acceptedCAs ?? []) as unknown[])
    must(
      certificateID(decoded(object(ca).crt).toString()) === next.talos_api_ca &&
        certificateID(decoded(object(ca).crt).toString()) !== old.talos_api_ca,
      "retired_trust_remains",
    );
  const serviceAccount = one(documents, "KubeServiceAccountConfig");
  for (const key of (serviceAccount.accepted
    ? (object(serviceAccount.accepted).publicKeys ?? [])
    : []) as unknown[])
    must(
      acceptedPublicID(key) === next.service_account_signer &&
        acceptedPublicID(key) !== old.service_account_signer,
      "retired_signer_remains",
    );
  must(
    secretbox(documents).name === secretbox(replacement).name,
    "canonical_encryption_name_differs",
  );
}

/** A timeout, reset, local trust failure, 403, or generic RPC error is never retirement proof. */
export function isExplicitRetirementRefusal(
  result: Pick<ProbeResult, "status" | "grpc_status" | "tls_error_code">,
): boolean {
  return (
    result.status === 401 ||
    result.grpc_status === 16 ||
    /^ERR_SSL_.*ALERT_(?:BAD_CERTIFICATE|CERTIFICATE_REQUIRED|UNKNOWN_CA|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE)$/.test(
      result.tls_error_code ?? "",
    )
  );
}
function varint(value: number) {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
}
interface Field {
  field: number;
  wire: number;
  value?: bigint | Buffer;
}
function* protobufFields(message: Buffer): Generator<Field> {
  let offset = 0;
  function number() {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      must(offset < message.length, "protobuf_invalid");
      const byte = message[offset++]!;
      must(shift !== 63n || byte <= 1, "protobuf_invalid");
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return result;
    }
    fail("protobuf_invalid");
  }
  while (offset < message.length) {
    const tag = number(),
      field = Number(tag >> 3n),
      wire = Number(tag & 7n);
    must(field > 0 && field <= 536870911, "protobuf_invalid");
    if (wire === 0) {
      yield { field, wire, value: number() };
      continue;
    }
    if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      must(offset <= message.length, "protobuf_invalid");
      yield { field, wire };
      continue;
    }
    must(wire === 2, "protobuf_invalid");
    const length = number();
    must(
      length <= BigInt(CAP) && offset + Number(length) <= message.length,
      "protobuf_invalid",
    );
    const value = message.subarray(offset, offset + Number(length));
    offset += Number(length);
    yield { field, wire, value };
  }
}
/** Decode only the fixed /registry/secrets/ bounded range; expose hashes, never ciphertext. */
export function decodeEncryptedSecretRange(
  message: Buffer,
  expectedName: string,
) {
  const entries: { key_sha256: string; value_sha256: string }[] = [],
    seen = new Set<string>();
  let more = false,
    count = 0n,
    sawMore = false,
    sawCount = false;
  for (const item of protobufFields(message)) {
    if (item.field === 3) {
      must(
        !sawMore &&
          item.wire === 0 &&
          typeof item.value === "bigint" &&
          item.value <= 1n,
        "range_invalid",
      );
      sawMore = true;
      more = item.value === 1n;
    } else if (item.field === 4) {
      must(
        !sawCount &&
          item.wire === 0 &&
          typeof item.value === "bigint" &&
          item.value <= BigInt(LIMIT),
        "range_invalid",
      );
      sawCount = true;
      count = item.value;
    } else if (item.field === 2) {
      must(
        item.wire === 2 &&
          Buffer.isBuffer(item.value) &&
          entries.length < LIMIT,
        "range_invalid",
      );
      let key: Buffer | undefined, value: Buffer | undefined;
      for (const field of protobufFields(item.value)) {
        if (field.field === 1) {
          must(
            !key && field.wire === 2 && Buffer.isBuffer(field.value),
            "range_invalid",
          );
          key = field.value;
        }
        if (field.field === 5) {
          must(
            !value && field.wire === 2 && Buffer.isBuffer(field.value),
            "range_invalid",
          );
          value = field.value;
        }
      }
      must(
        key &&
          value &&
          key.length > PREFIX.length &&
          key.subarray(0, PREFIX.length).equals(PREFIX),
        "range_invalid",
      );
      const id = hash(key);
      must(!seen.has(id), "range_invalid");
      seen.add(id);
      const expected = Buffer.from(CIPHER.toString() + expectedName + ":");
      must(
        value.subarray(0, expected.length).equals(expected) &&
          value.length - expected.length >= 40,
        "ciphertext_key_differs",
      );
      entries.push({ key_sha256: id, value_sha256: hash(value) });
    }
  }
  must(!more, "range_truncated");
  must(
    sawCount && count === BigInt(entries.length) && entries.length > 0,
    "range_count_invalid",
  );
  return {
    count: entries.length,
    allCiphertextUsesExpectedKey: true as const,
    entries,
  };
}
function rangeRequest() {
  const end = Buffer.from(PREFIX);
  end[end.length - 1]!++;
  return Buffer.concat([
    Buffer.from([10]),
    varint(PREFIX.length),
    PREFIX,
    Buffer.from([18]),
    varint(end.length),
    end,
    Buffer.from([24]),
    varint(LIMIT),
  ]);
}
function certificateResponse(message: Buffer) {
  const fields = new Map<number, Buffer>();
  for (const item of protobufFields(message))
    if (item.field === 1 || item.field === 2) {
      must(
        item.wire === 2 &&
          Buffer.isBuffer(item.value) &&
          item.value.length &&
          !fields.has(item.field),
        "certificate_response_invalid",
      );
      fields.set(item.field, item.value);
    }
  must(fields.has(1) && fields.has(2), "certificate_response_invalid");
  return {
    ca_sha256: hash(fields.get(1)!),
    certificate_sha256: hash(fields.get(2)!),
  };
}
function boundedSignal(signal: AbortSignal | undefined, timeout: number) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
}
function tlsCode(error: unknown): string | undefined {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,96}$/.test(code)
    ? code
    : undefined;
}
async function grpc(options: {
  port: number;
  address: string;
  ca: string;
  cert?: string;
  key?: string;
  method: typeof CERT_RPC | typeof STATUS_RPC | typeof RANGE_RPC;
  token?: string;
  csr?: Buffer;
  expectedKeyName?: string;
  signal?: AbortSignal;
}): Promise<ProbeResult> {
  const signal = boundedSignal(
      options.signal,
      options.method === RANGE_RPC ? 25_000 : 9_000,
    ),
    chunks: Buffer[] = [];
  let socket: tls.TLSSocket | undefined,
    connection: http2.ClientHttp2Session | undefined,
    stream: http2.ClientHttp2Stream | undefined,
    bytes = 0;
  const result: ProbeResult = { ok: false };
  try {
    return await new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const finish = (value: ProbeResult) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", abort);
          resolve({ ...value, reply_sha256: hash(Buffer.concat(chunks)) });
        }
      };
      const abort = () => finish({ ok: false, error: "deadline_or_abort" });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      socket = tls.connect({
        host: "127.0.0.1",
        port: options.port,
        ca: options.ca,
        cert: options.cert,
        key: options.key,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ALPNProtocols: ["h2"],
        checkServerIdentity: (_host, peer) =>
          tls.checkServerIdentity(options.address, peer),
      });
      socket.once("error", (error) =>
        finish({
          ok: false,
          error: "tls_failed",
          tls_error_code: tlsCode(error),
        }),
      );
      socket.once("secureConnect", () => {
        if (!socket!.authorized || socket!.alpnProtocol !== "h2") {
          finish({ ok: false, error: "tls_identity_failed" });
          return;
        }
        connection = http2.connect(`https://127.0.0.1:${options.port}`, {
          createConnection: () => socket!,
          maxSessionMemory: 1,
          settings: {
            headerTableSize: 0,
            maxConcurrentStreams: 1,
            maxHeaderListSize: 4096,
          },
        });
        connection.once("error", () =>
          finish({ ok: false, error: "http2_failed" }),
        );
        let status: number | undefined;
        const capture = (headers: http2.IncomingHttpHeaders) => {
          if (headers["grpc-status"] === undefined) return;
          const value = String(headers["grpc-status"]);
          if (
            !/^(?:[0-9]|1[0-6])$/.test(value) ||
            (status !== undefined && status !== Number(value))
          ) {
            finish({ ok: false, error: "grpc_status_invalid" });
            return;
          }
          status = Number(value);
        };
        stream = connection.request({
          ":method": "POST",
          ":path": options.method,
          ":scheme": "https",
          ":authority":
            isIP(options.address) === 6
              ? `[${options.address}]`
              : options.address,
          "content-type": "application/grpc",
          te: "trailers",
          "grpc-timeout": options.method === RANGE_RPC ? "20S" : "8S",
          ...(options.token ? { token: options.token } : {}),
        });
        stream.once("error", () =>
          finish({ ok: false, error: "rpc_stream_failed" }),
        );
        stream.once("response", (headers) => {
          if (
            headers[":status"] !== 200 ||
            !/^application\/grpc(?:\+proto)?(?:;.*)?$/.test(
              String(headers["content-type"] ?? ""),
            )
          )
            finish({ ok: false, error: "grpc_headers_invalid" });
          else capture(headers);
        });
        stream.on("trailers", capture);
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > CAP + 5) {
            finish({ ok: false, error: "response_limit" });
            stream!.destroy();
          } else chunks.push(chunk);
        });
        stream.once("end", () => {
          if (status === 16) {
            finish({ ok: true, grpc_status: 16 });
            return;
          }
          if (status !== 0) {
            finish({
              ok: false,
              error: "grpc_status_unexpected",
              grpc_status: status,
            });
            return;
          }
          const raw = Buffer.concat(chunks);
          if (
            raw.length < 5 ||
            raw[0] !== 0 ||
            raw.readUInt32BE(1) !== raw.length - 5
          ) {
            finish({ ok: false, error: "grpc_frame_invalid" });
            return;
          }
          try {
            finish({
              ok: true,
              grpc_status: 0,
              ...(options.method === RANGE_RPC
                ? {
                    range: decodeEncryptedSecretRange(
                      raw.subarray(5),
                      text(options.expectedKeyName),
                    ),
                  }
                : options.method === CERT_RPC
                  ? { reply: certificateResponse(raw.subarray(5)) }
                  : {}),
            });
          } catch {
            finish({ ok: false, error: "protobuf_response_invalid" });
          }
        });
        const body =
            options.method === RANGE_RPC
              ? rangeRequest()
              : options.method === CERT_RPC
                ? Buffer.concat([
                    Buffer.from([10]),
                    varint(options.csr!.length),
                    options.csr!,
                  ])
                : Buffer.alloc(0),
          frame = Buffer.alloc(5 + body.length);
        frame.writeUInt32BE(body.length, 1);
        body.copy(frame, 5);
        stream.end(frame);
      });
    });
  } catch {
    return result;
  } finally {
    stream?.destroy();
    connection?.destroy();
    socket?.destroy();
  }
}
async function run(
  program: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = 20_000,
) {
  const bound = boundedSignal(signal, timeout),
    child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, LANG: "C" },
    }),
    stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let bytes = 0,
    excessive = false;
  const stop = () => {
      void stopChild(child);
    },
    capture = (target: Buffer[]) => (value: Buffer) => {
      bytes += value.length;
      if (bytes > CAP) {
        excessive = true;
        stop();
      } else target.push(value);
    };
  bound.addEventListener("abort", stop, { once: true });
  if (bound.aborted) stop();
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const exit = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  bound.removeEventListener("abort", stop);
  return {
    exit,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    boundedFailure: bound.aborted || excessive,
  };
}
async function forward(
  session: Session,
  kubectl: string,
  port: number,
  signal?: AbortSignal,
) {
  await session.verify();
  const child = spawn(
      kubectl,
      [
        "--kubeconfig",
        join(session.outputDir, "kubeconfig.private.json"),
        "--request-timeout=0",
        "-n",
        "kube-system",
        "port-forward",
        "--address=127.0.0.1",
        `pod/${session.carrier.pod.name}`,
        `:${port}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, LANG: "C" },
      },
    ),
    bound = boundedSignal(signal, 20_000);
  let data = "",
    closed = false;
  const stop = () => {
    void stopChild(child);
  };
  bound.addEventListener("abort", stop, { once: true });
  try {
    const localPort = await new Promise<number>((resolve, reject) => {
      const abort = () => reject(Error("authority_probe_forward_timeout"));
      bound.addEventListener("abort", abort, { once: true });
      const capture = (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 64 * 1024) {
          reject(Error("authority_probe_forward_limit"));
          stop();
          return;
        }
        const match = /Forwarding from 127\.0\.0\.1:(\d+) ->/.exec(data);
        if (match) {
          bound.removeEventListener("abort", abort);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", () =>
        reject(Error("authority_probe_forward_failed")),
      );
      child.once("close", () => {
        closed = true;
        reject(Error("authority_probe_forward_closed"));
      });
      if (bound.aborted) abort();
    });
    // The startup deadline must not terminate a successfully established forward.
    bound.removeEventListener("abort", stop);
    const abort = () => {
      void stopChild(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    return {
      port: localPort,
      close: async () => {
        signal?.removeEventListener("abort", abort);
        if (!closed) await stopChild(child);
      },
    };
  } catch {
    bound.removeEventListener("abort", stop);
    await stopChild(child);
    fail("forward_failed");
  }
}
function selectedTalos(raw: string) {
  const config = object(parse(raw)),
    context = object(object(config.contexts)[text(config.context)]);
  return { config, context };
}
function selectedKube(raw: string) {
  const config = object(parse(raw)),
    contexts = array(config.contexts),
    selected = contexts
      .map(object)
      .find((item) => item.name === config["current-context"]);
  must(selected, "kube_context");
  const context = object(selected.context),
    cluster = array(config.clusters)
      .map(object)
      .find((item) => item.name === context.cluster),
    user = array(config.users)
      .map(object)
      .find((item) => item.name === context.user);
  must(cluster && user, "kube_context");
  return { cluster: object(cluster.cluster), user: object(user.user) };
}
async function httpProbe(
  transport: ReturnType<typeof selectedKube>,
  credentials: { cert: string; key: string },
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<ProbeResult> {
  const signal = boundedSignal(options.signal, 15_000),
    endpoint = new URL(text(transport.cluster.server)),
    proxy = new URL(text(transport.cluster["proxy-url"]));
  must(
    endpoint.protocol === "https:" &&
      proxy.protocol === "http:" &&
      proxy.hostname === "127.0.0.1" &&
      !transport.cluster["insecure-skip-tls-verify"],
    "http_transport",
  );
  let tunnel: Socket | undefined,
    socket: tls.TLSSocket | undefined,
    request: http.ClientRequest | undefined;
  try {
    tunnel = await new Promise<Socket>((resolve, reject) => {
      const connect = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        method: "CONNECT",
        path: `${endpoint.hostname}:${endpoint.port || "443"}`,
        signal,
      });
      connect.once("connect", (response, value, head) => {
        if (response.statusCode !== 200 || head.length) {
          value.destroy();
          reject(Error("connect_refused"));
        } else resolve(value);
      });
      connect.once("error", () => reject(Error("connect_failed")));
      connect.end();
    });
    socket = tls.connect({
      socket: tunnel,
      ca: decoded(transport.cluster["certificate-authority-data"]),
      cert: credentials.cert,
      key: credentials.key,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: isIP(endpoint.hostname) ? undefined : endpoint.hostname,
      checkServerIdentity: (_name, peer) =>
        tls.checkServerIdentity(endpoint.hostname, peer),
    });
    return await new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const finish = (value: ProbeResult) => {
          if (!settled) {
            settled = true;
            signal.removeEventListener("abort", abort);
            resolve(value);
          }
        },
        abort = () => finish({ ok: false, error: "deadline_or_abort" });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      socket!.once("error", (error) =>
        finish({
          ok: false,
          error: "tls_failed",
          tls_error_code: tlsCode(error),
        }),
      );
      socket!.once("secureConnect", () => {
        if (!socket!.authorized) {
          finish({ ok: false, error: "tls_identity_failed" });
          return;
        }
        const body =
          options.body === undefined ? undefined : JSON.stringify(options.body);
        request = http.request(
          {
            hostname: endpoint.hostname,
            port: endpoint.port || "443",
            method: options.method ?? "GET",
            path:
              options.method === "POST"
                ? "/apis/authentication.k8s.io/v1/tokenreviews"
                : "/api/v1/namespaces/kube-system",
            agent: new (class extends http.Agent {
              override createConnection() {
                return socket!;
              }
            })(),
            headers: {
              host: endpoint.host,
              connection: "close",
              ...(body
                ? {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }
                : {}),
              ...options.headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > CAP) {
                finish({ ok: false, error: "response_limit" });
                response.destroy();
              } else chunks.push(chunk);
            });
            response.once("error", () =>
              finish({ ok: false, error: "response_failed" }),
            );
            response.once("end", () => {
              const raw = Buffer.concat(chunks);
              let reply: ObjectValue | undefined;
              try {
                reply = object(JSON.parse(raw.toString()));
              } catch {
                /* Body absence cannot satisfy a success verdict. */
              }
              finish({
                ok: true,
                status: response.statusCode,
                reply_sha256: hash(raw),
                reply,
              });
            });
          },
        );
        request.once("error", (error) =>
          finish({
            ok: false,
            error: "request_failed",
            tls_error_code: tlsCode(error),
          }),
        );
        request.end(body);
      });
    });
  } catch {
    return { ok: false, error: "transport_failed" };
  } finally {
    request?.destroy();
    socket?.destroy();
    tunnel?.destroy();
  }
}
function serviceAccountToken(
  key: string,
  issuer: string,
  serviceAccount: ObjectValue,
) {
  const signing = privateKey(key);
  must(signing.asymmetricKeyType === "rsa", "service_account_algorithm");
  const metadata = object(serviceAccount.metadata),
    issued = Math.floor(Date.now() / 1000),
    header = {
      alg: "RS256",
      kid: createHash("sha256")
        .update(
          createPublicKey(signing).export({ type: "spki", format: "der" }),
        )
        .digest("base64url"),
    },
    payload = {
      iss: issuer,
      sub: `system:serviceaccount:kube-system:${text(metadata.name)}`,
      aud: [issuer],
      iat: issued,
      nbf: issued - 10,
      exp: issued + 1200,
      "kubernetes.io": {
        namespace: "kube-system",
        serviceaccount: { name: metadata.name, uid: metadata.uid },
      },
    },
    body =
      Buffer.from(JSON.stringify(header)).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify(payload)).toString("base64url");
  return (
    body +
    "." +
    sign("RSA-SHA256", Buffer.from(body), signing).toString("base64url")
  );
}
function parseMachineRows(raw: Buffer, address: string) {
  return jsonRecords(raw.toString()).map((row) => {
    must(
      row.node === address && typeof row.spec === "string",
      "configuration_identity",
    );
    const docs = parseAllDocuments(row.spec, { uniqueKeys: true });
    must(
      docs.length && docs.every((doc) => !doc.errors.length),
      "configuration_parse",
    );
    return {
      id: object(row.metadata).id,
      documents: docs.map((doc) => object(doc.toJS({ maxAliasCount: 50 }))),
      sha256: hash(row.spec),
    };
  });
}
export interface RegionAuthorityRetirementOptions {
  session: Session;
  oldDocuments: AuthorityDocuments;
  newDocuments: AuthorityDocuments;
  oldTalosconfig: string;
  newTalosconfig: string;
  oldKubeconfig: string;
  newKubeconfig: string;
  talosctl: string;
  kubectl: string;
  outputDir: string;
  signal?: AbortSignal;
}

/** Read the actual etcd ciphertext while a decrypt overlap is still intentionally present. */
export async function verifyRotationSecretCiphertexts(options: {
  session: Session;
  newDocuments: AuthorityDocuments;
  newTalosconfig: string;
  kubectl: string;
  outputDir: string;
  expected_key_name: string;
  signal?: AbortSignal;
}) {
  must(
    isAbsolute(options.outputDir) && isAbsolute(options.kubectl),
    "private_paths",
  );
  const binding = options.session.binding;
  must(binding, "session_binding_missing");
  const encryption = secretbox(options.newDocuments),
    alias = `rotation-${hash(encryption.secret).slice(0, 16)}`;
  must(
    [encryption.name, alias].includes(options.expected_key_name),
    "encryption_name_unbound",
  );
  await options.session.verify();
  await mkdir(options.outputDir, { mode: 0o700 });
  const workspace = await mkdtemp(join(options.outputDir, "ciphertext-"));
  await chmod(workspace, 0o700);
  let transport: Awaited<ReturnType<typeof forward>> | undefined;
  const write = async (name: string, bytes: string | Buffer) => {
    const file = join(workspace, name);
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    return file;
  };
  try {
    const legacy = one(options.newDocuments, "legacy"),
      ca = decoded(at(legacy, "cluster", "etcd", "ca", "crt")).toString(),
      authorityKey = privateKey(
        decoded(at(legacy, "cluster", "etcd", "ca", "key")).toString(),
      ),
      admin = selectedTalos(options.newTalosconfig),
      clientKey = privateKey(decoded(admin.context.key).toString());
    must(certificate(ca).checkPrivateKey(authorityKey), "ca_key_mismatch");
    const currentRows = parseMachineRows(
        await options.session.run(["get", "machineconfig", "--output=json"]),
        options.session.carrier.physical.address,
      ),
      active = currentRows.find((row) => row.id === "v1alpha1");
    must(
      active &&
        certificateID(
          decoded(
            at(one(active.documents, "legacy"), "cluster", "etcd", "ca", "crt"),
          ).toString(),
        ) === certificateID(ca),
      "current_etcd_authority_differs",
    );
    const caFile = await write("ca.pem", ca),
      caKeyFile = await write(
        "ca.key",
        authorityKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
      keyFile = await write(
        "client.key",
        clientKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
      extension = await write(
        "client.ext",
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
      ),
      csr = await write("client.csr", ""),
      leaf = await write("client.crt", "");
    let operation = await run(
      "openssl",
      ["req", "-new", "-key", keyFile, "-subj", "/CN=talos", "-out", csr],
      options.signal,
    );
    must(operation.exit === 0 && !operation.boundedFailure, "leaf_csr_failed");
    operation = await run(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        caFile,
        "-CAkey",
        caKeyFile,
        "-set_serial",
        "0x" + randomBytes(16).toString("hex"),
        "-days",
        "1",
        "-extfile",
        extension,
        "-out",
        leaf,
      ],
      options.signal,
    );
    must(operation.exit === 0 && !operation.boundedFailure, "leaf_sign_failed");
    const cert = await readFile(leaf, "utf8");
    must(
      certificate(cert).verify(certificate(ca).publicKey) &&
        certificate(cert).checkPrivateKey(clientKey),
      "leaf_verification_failed",
    );
    await rm(caKeyFile);
    transport = await forward(
      options.session,
      options.kubectl,
      2379,
      options.signal,
    );
    const result = await grpc({
      port: transport.port,
      address: options.session.carrier.physical.address,
      ca,
      cert,
      key: clientKey.export({ type: "pkcs8", format: "pem" }).toString(),
      method: RANGE_RPC,
      expectedKeyName: options.expected_key_name,
      signal: options.signal,
    });
    must(
      result.ok &&
        result.grpc_status === 0 &&
        result.range?.allCiphertextUsesExpectedKey,
      "encrypted_range_verdict",
    );
    await options.session.verify();
    const finalRows = parseMachineRows(
        await options.session.run(["get", "machineconfig", "--output=json"]),
        options.session.carrier.physical.address,
      ),
      final = finalRows.find((row) => row.id === "v1alpha1");
    must(
      final && final.sha256 === active.sha256,
      "configuration_changed_during_probes",
    );
    return {
      secret_count: result.range.count,
      encrypted_range_sha256: hashValue({
        node_uid: binding.node_uid,
        cluster_uid: binding.cluster_uid,
        active_configuration_sha256: active.sha256,
        range: result.range,
      }),
      allCiphertextUsesExpectedKey: true as const,
      new_key_name: options.expected_key_name,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /^authority_probe_[a-z0-9_]+$/.test(error.message)
    )
      throw error;
    fail("verification_failed");
  } finally {
    await transport?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Works for either node role and does not require control-plane-only documents. */
export async function verifyTalosAdministrationPair(
  options: Pick<
    RegionAuthorityRetirementOptions,
    | "session"
    | "newDocuments"
    | "oldTalosconfig"
    | "newTalosconfig"
    | "talosctl"
    | "kubectl"
    | "outputDir"
    | "signal"
  >,
) {
  const binding = options.session.binding;
  must(
    binding &&
      isAbsolute(options.outputDir) &&
      isAbsolute(options.talosctl) &&
      isAbsolute(options.kubectl),
    "talos_options",
  );
  await options.session.verify();
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(options.outputDir, "talos-pair-"));
  await chmod(workspace, 0o700);
  const abort = new AbortController();
  let proxy: Awaited<ReturnType<typeof startCapabilityProxy>> | undefined;
  let talosForward: Awaited<ReturnType<typeof forward>> | undefined;
  try {
    const current = selectedTalos(options.newTalosconfig),
      prior = selectedTalos(options.oldTalosconfig),
      currentCA = at(
        one(options.newDocuments, "legacy"),
        "machine",
        "ca",
        "crt",
      );
    must(
      certificateID(decoded(currentCA).toString()) !==
        certificateID(decoded(prior.context.ca).toString()),
      "talos_authority_unchanged",
    );
    const outcomes: {
      exit: number | null;
      server_version: string | null;
      refused: boolean;
      reply_sha256: string;
    }[] = [];
    const forwardHandle = await forward(
      options.session,
      options.kubectl,
      50000,
      options.signal,
    );
    talosForward = forwardHandle;
    proxy = await startCapabilityProxy(
      (authority) =>
        authority === `${options.session.carrier.physical.address}:50000`
          ? "talos_api"
          : undefined,
      () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = createConnection({
            host: "127.0.0.1",
            port: forwardHandle.port,
          });
          socket.once("connect", () => resolve(socket));
          socket.once("error", () =>
            reject(Error("authority_probe_talos_transport")),
          );
        }),
      abort.signal,
    );
    for (const [label, context] of [
      ["new", current.context],
      ["old", prior.context],
    ] as const) {
      const config = structuredClone(current.config),
        target = object(object(config.contexts)[text(config.context)]);
      target.ca = currentCA;
      target.crt = context.crt;
      target.key = context.key;
      const file = join(workspace, `talos-${label}.yaml`);
      await writeFile(
        file,
        nativeTalosConfig(
          stringify(config),
          options.session.carrier.physical.address,
          proxy.url,
        ),
        { mode: 0o600, flag: "wx" },
      );
      const result = await run(
        options.talosctl,
        ["--talosconfig", file, "version", "--json"],
        options.signal,
      );
      let version: string | null = null;
      try {
        const value = object(JSON.parse(result.stdout.toString())),
          server = value.server ? object(value.server) : undefined,
          first =
            Array.isArray(value.servers) &&
            value.servers[0] &&
            object(value.servers[0]);
        const candidate =
          (value.version && object(value.version).tag) ||
          (server &&
            (typeof server.version === "string"
              ? server.version
              : server.version && object(server.version).tag)) ||
          (server && server.tag) ||
          (first && first.version && object(first.version).tag);
        if (typeof candidate === "string" && /^v?\d+\.\d+\.\d+/.test(candidate))
          version = candidate;
      } catch {
        /* Client-only output cannot prove server access. */
      }
      outcomes.push({
        exit: result.exit,
        server_version: version,
        refused:
          !result.boundedFailure &&
          result.exit !== 0 &&
          /(?:remote error: tls: (?:bad certificate|certificate required|unknown certificate authority)|code = Unauthenticated|unauthorized certificate)/i.test(
            result.stderr.toString(),
          ),
        reply_sha256: hash(result.stdout),
      });
    }
    must(
      outcomes[0]!.exit === 0 &&
        outcomes[0]!.server_version &&
        outcomes[1]!.refused,
      "talos_verdict",
    );
    await options.session.verify();
    return {
      node_uid: binding.node_uid,
      cluster_uid: binding.cluster_uid,
      new: outcomes[0]!,
      old: outcomes[1]!,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /^authority_probe_[a-z0-9_]+$/.test(error.message)
    )
      throw error;
    fail("verification_failed");
  } finally {
    abort.abort();
    await proxy?.close();
    await talosForward?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Real authentication and ciphertext readbacks; the caller owns durable phase/reboot proof. */
export async function verifyRegionAuthorityRetirement(
  options: RegionAuthorityRetirementOptions,
) {
  must(
    isAbsolute(options.outputDir) &&
      isAbsolute(options.talosctl) &&
      isAbsolute(options.kubectl),
    "private_paths",
  );
  options.signal?.throwIfAborted();
  await options.session.verify();
  const binding = options.session.binding;
  must(binding, "session_binding_missing");
  await mkdir(options.outputDir, { mode: 0o700 });
  const workspace = await mkdtemp(join(options.outputDir, "credentials-"));
  await chmod(workspace, 0o700);
  const old = fingerprints(options.oldDocuments),
    next = fingerprints(options.newDocuments),
    authorities = Object.keys(next) as Authority[],
    transcript: ObjectValue = {
      at: new Date().toISOString(),
      node_uid: binding.node_uid,
      cluster_uid: binding.cluster_uid,
      carrier_pod_uid: options.session.carrier.pod.uid,
      results: {},
    },
    results = object(transcript.results);
  const retired: Verification["retired_authorities"] = [];
  const write = async (name: string, bytes: string | Buffer) => {
    const file = join(workspace, name);
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    return file;
  };
  const record = (
    authority: Authority,
    current: unknown,
    prior: unknown,
    result: "rejected" | "retired_from_live_configuration" = "rejected",
  ) => {
    results[authority] = { new: current, old: prior };
    retired.push({
      authority,
      prior_sha256: old[authority],
      replacement_sha256: next[authority],
      new_access_sha256: hashValue({
        node_uid: binding.node_uid,
        cluster_uid: binding.cluster_uid,
        result: current,
      }),
      retired_access_sha256: hashValue({
        node_uid: binding.node_uid,
        cluster_uid: binding.cluster_uid,
        result: prior,
      }),
      result,
    });
  };
  try {
    for (const authority of authorities)
      must(old[authority] !== next[authority], "unchanged_material");
    for (const kind of ["DiscoveryIdentityConfig", "KubeClusterConfig"]) {
      const before = one(options.oldDocuments, kind),
        after = one(options.newDocuments, kind);
      for (const field of kind === "DiscoveryIdentityConfig"
        ? ["clusterID"]
        : ["endpoint", "clusterName"])
        must(before[field] === after[field], "cluster_identity_changed");
    }
    const activeRows = parseMachineRows(
        await options.session.run(["get", "machineconfig", "--output=json"]),
        options.session.carrier.physical.address,
      ),
      active = activeRows.find((row) => row.id === "v1alpha1"),
      persistent = activeRows.find((row) => row.id === "persistent");
    must(
      active &&
        activeRows.filter((row) => row.id === "v1alpha1").length === 1 &&
        activeRows.filter((row) => row.id === "persistent").length <= 1,
      "active_configuration_missing",
    );
    validateFinal(active.documents, options.newDocuments, old, next);
    if (persistent)
      validateFinal(persistent.documents, options.newDocuments, old, next);
    transcript.active_configuration_sha256 = active.sha256;
    if (persistent)
      transcript.persistent_configuration_sha256 = persistent.sha256;
    const currentTalos = selectedTalos(options.newTalosconfig),
      currentKube = selectedKube(options.newKubeconfig),
      priorKube = selectedKube(options.oldKubeconfig),
      transport = selectedKube(
        await readFile(
          join(options.session.outputDir, "kubeconfig.private.json"),
          "utf8",
        ),
      );
    must(
      text(currentKube.cluster.server) === text(priorKube.cluster.server) &&
        text(currentKube.cluster.server) === text(transport.cluster.server),
      "kube_endpoint_changed",
    );
    const currentAdmin = {
        cert: decoded(currentKube.user["client-certificate-data"]).toString(),
        key: decoded(currentKube.user["client-key-data"]).toString(),
      },
      priorAdmin = {
        cert: decoded(priorKube.user["client-certificate-data"]).toString(),
        key: decoded(priorKube.user["client-key-data"]).toString(),
      };
    const administratorKey = privateKey(
        decoded(currentTalos.context.key).toString(),
      ),
      reusableKey = await write(
        "client.key",
        administratorKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
      extension = await write(
        "client.ext",
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
      );
    const leaves: Record<string, { cert: string; key: string; ca: string }> =
      {};
    for (const [label, documents] of [
      ["old", options.oldDocuments],
      ["new", options.newDocuments],
    ] as const) {
      const legacy = one(documents, "legacy");
      for (const kind of ["etcd", "aggregator"] as const) {
        const authority =
            kind === "etcd"
              ? {
                  cert: decoded(
                    at(legacy, "cluster", "etcd", "ca", "crt"),
                  ).toString(),
                  key: decoded(
                    at(legacy, "cluster", "etcd", "ca", "key"),
                  ).toString(),
                }
              : object(one(documents, "KubeAggregatorCAConfig").issuingCA),
          cert = text(authority.cert),
          key = privateKey(authority.key),
          caFile = await write(`${label}-${kind}-ca.pem`, cert),
          keyFile = await write(
            `${label}-${kind}-ca.key`,
            key.export({ type: "pkcs8", format: "pem" }).toString(),
          ),
          csr = await write(`${label}-${kind}.csr`, ""),
          leaf = await write(`${label}-${kind}.crt`, "");
        must(certificate(cert).checkPrivateKey(key), "ca_key_mismatch");
        let operation = await run(
          "openssl",
          [
            "req",
            "-new",
            "-key",
            reusableKey,
            "-subj",
            kind === "aggregator" ? "/CN=front-proxy-client" : "/CN=talos",
            "-out",
            csr,
          ],
          options.signal,
        );
        must(
          operation.exit === 0 && !operation.boundedFailure,
          "leaf_csr_failed",
        );
        await chmod(csr, 0o600);
        operation = await run(
          "openssl",
          [
            "x509",
            "-req",
            "-in",
            csr,
            "-CA",
            caFile,
            "-CAkey",
            keyFile,
            "-set_serial",
            "0x" + randomBytes(16).toString("hex"),
            "-days",
            "1",
            "-extfile",
            extension,
            "-out",
            leaf,
          ],
          options.signal,
        );
        must(
          operation.exit === 0 && !operation.boundedFailure,
          "leaf_sign_failed",
        );
        await chmod(leaf, 0o600);
        const pem = await readFile(leaf, "utf8");
        must(
          certificate(pem).verify(certificate(cert).publicKey) &&
            certificate(pem).checkPrivateKey(administratorKey),
          "leaf_verification_failed",
        );
        leaves[`${label}-${kind}`] = {
          cert: pem,
          key: administratorKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
          ca: cert,
        };
        await rm(keyFile);
      }
    }
    const kubeNew = await httpProbe(transport, currentAdmin, {
        signal: options.signal,
      }),
      kubeOld = await httpProbe(transport, priorAdmin, {
        signal: options.signal,
      });
    must(
      kubeNew.ok &&
        kubeNew.status === 200 &&
        at(kubeNew.reply, "metadata", "uid") === binding.cluster_uid &&
        isExplicitRetirementRefusal(kubeOld),
      "kubernetes_verdict",
    );
    record(
      "kubernetes_api_ca",
      { status: kubeNew.status, reply_sha256: kubeNew.reply_sha256 },
      { status: kubeOld.status, tls_error_code: kubeOld.tls_error_code },
    );
    const aggregatorNew = await httpProbe(
        transport,
        leaves["new-aggregator"]!,
        {
          headers: {
            "X-Remote-User": "pgcf-authority-retirement-probe",
            "X-Remote-Group": "system:masters",
          },
          signal: options.signal,
        },
      ),
      aggregatorOld = await httpProbe(transport, leaves["old-aggregator"]!, {
        headers: {
          "X-Remote-User": "pgcf-authority-retirement-probe",
          "X-Remote-Group": "system:masters",
        },
        signal: options.signal,
      });
    must(
      aggregatorNew.ok &&
        aggregatorNew.status === 200 &&
        at(aggregatorNew.reply, "metadata", "uid") === binding.cluster_uid &&
        isExplicitRetirementRefusal(aggregatorOld),
      "aggregator_verdict",
    );
    record(
      "aggregator_ca",
      {
        status: aggregatorNew.status,
        reply_sha256: aggregatorNew.reply_sha256,
      },
      {
        status: aggregatorOld.status,
        tls_error_code: aggregatorOld.tls_error_code,
      },
    );
    const saRead = await run(
      options.kubectl,
      [
        "--kubeconfig",
        join(options.session.outputDir, "kubeconfig.private.json"),
        "--request-timeout=15s",
        "get",
        "--raw",
        "/api/v1/namespaces/kube-system/serviceaccounts/default",
      ],
      options.signal,
    );
    must(
      saRead.exit === 0 && !saRead.boundedFailure,
      "service_account_read_failed",
    );
    const sa = object(JSON.parse(saRead.stdout.toString())),
      metadata = object(sa.metadata);
    must(
      metadata.namespace === "kube-system" &&
        metadata.name === "default" &&
        metadata.uid,
      "service_account_identity",
    );
    for (const kind of [
      "service_account_signer",
      "kubernetes_bootstrap_token",
    ] as const) {
      const pair: ProbeResult[] = [];
      for (const documents of [options.newDocuments, options.oldDocuments]) {
        const issuer = object(
            one(documents, "KubeServiceAccountConfig").issuer,
          ),
          token =
            kind === "service_account_signer"
              ? serviceAccountToken(
                  text(issuer.privateKey),
                  text(issuer.issuerURL),
                  sa,
                )
              : text(at(one(documents, "legacy"), "cluster", "token"));
        pair.push(
          await httpProbe(transport, currentAdmin, {
            method: "POST",
            body: {
              apiVersion: "authentication.k8s.io/v1",
              kind: "TokenReview",
              spec: {
                token,
                ...(kind === "service_account_signer"
                  ? { audiences: [issuer.issuerURL] }
                  : {}),
              },
            },
            signal: options.signal,
          }),
        );
      }
      const [current, prior] = pair;
      must(
        current!.ok &&
          current!.status === 201 &&
          at(current!.reply, "status", "authenticated") === true &&
          prior!.ok &&
          prior!.status === 201 &&
          object(prior!.reply!.status).authenticated !== true &&
          typeof object(prior!.reply!.status).error === "string",
        "token_review_verdict",
      );
      const user = object(at(current!.reply, "status", "user"));
      must(
        kind === "service_account_signer"
          ? user.uid === metadata.uid &&
              user.username === "system:serviceaccount:kube-system:default"
          : typeof user.username === "string" &&
              user.username.startsWith("system:bootstrap:"),
        "token_review_identity",
      );
      record(
        kind,
        {
          status: current!.status,
          authenticated: true,
          reply_sha256: current!.reply_sha256,
        },
        {
          status: prior!.status,
          authenticated: false,
          reply_sha256: prior!.reply_sha256,
        },
      );
    }
    const talosPair = await verifyTalosAdministrationPair({
      ...options,
      outputDir: workspace,
    });
    record("talos_api_ca", talosPair.new, talosPair.old);
    const etcdForward = await forward(
      options.session,
      options.kubectl,
      2379,
      options.signal,
    );
    try {
      const common = {
          port: etcdForward.port,
          address: options.session.carrier.physical.address,
          ca: leaves["new-etcd"]!.ca,
          method: STATUS_RPC as typeof STATUS_RPC,
          signal: options.signal,
        },
        current = await grpc({
          ...common,
          ...leaves["new-etcd"]!,
          ca: common.ca,
        }),
        prior = await grpc({
          ...common,
          ...leaves["old-etcd"]!,
          ca: common.ca,
        });
      must(
        current.ok &&
          current.grpc_status === 0 &&
          isExplicitRetirementRefusal(prior),
        "etcd_verdict",
      );
      record("etcd_ca", current, prior);
      const range = await grpc({
        ...common,
        ...leaves["new-etcd"]!,
        method: RANGE_RPC,
        expectedKeyName: secretbox(options.newDocuments).name,
      });
      must(
        range.ok &&
          range.grpc_status === 0 &&
          range.range?.allCiphertextUsesExpectedKey,
        "encrypted_range_verdict",
      );
      transcript.encrypted_range = range.range;
    } finally {
      await etcdForward.close();
    }
    const csr = await write("trustd.csr", ""),
      csrRun = await run(
        "openssl",
        [
          "req",
          "-new",
          "-key",
          reusableKey,
          "-subj",
          `/CN=${binding.node_name}`,
          "-out",
          csr,
        ],
        options.signal,
      );
    must(csrRun.exit === 0 && !csrRun.boundedFailure, "trustd_csr_failed");
    await chmod(csr, 0o600);
    const trustdForward = await forward(
      options.session,
      options.kubectl,
      50001,
      options.signal,
    );
    try {
      const common = {
          port: trustdForward.port,
          address: options.session.carrier.physical.address,
          ca: decoded(
            at(one(options.newDocuments, "legacy"), "machine", "ca", "crt"),
          ).toString(),
          method: CERT_RPC as typeof CERT_RPC,
          csr: await readFile(csr),
          signal: options.signal,
        },
        current = await grpc({
          ...common,
          token: text(
            at(one(options.newDocuments, "legacy"), "machine", "token"),
          ),
        }),
        prior = await grpc({
          ...common,
          token: text(
            at(one(options.oldDocuments, "legacy"), "machine", "token"),
          ),
        });
      must(
        current.ok &&
          current.grpc_status === 0 &&
          current.reply &&
          isExplicitRetirementRefusal(prior),
        "trustd_verdict",
      );
      record("trustd_token", current, prior);
    } finally {
      await trustdForward.close();
    }
    await options.session.verify();
    const finalRows = parseMachineRows(
        await options.session.run(["get", "machineconfig", "--output=json"]),
        options.session.carrier.physical.address,
      ),
      finalActive = finalRows.find((row) => row.id === "v1alpha1");
    must(
      finalActive && finalActive.sha256 === active.sha256,
      "configuration_changed_during_probes",
    );
    validateFinal(finalActive.documents, options.newDocuments, old, next);
    const configEvidence = {
      active_configuration_sha256: active.sha256,
      ...(persistent
        ? { persistent_configuration_sha256: persistent.sha256 }
        : {}),
      final_readback_sha256: finalActive.sha256,
    };
    record(
      "discovery_secret",
      { ...configEvidence, present_sha256: next.discovery_secret },
      { ...configEvidence, absent_sha256: old.discovery_secret },
      "retired_from_live_configuration",
    );
    record(
      "secret_at_rest_key",
      {
        ...configEvidence,
        present_sha256: next.secret_at_rest_key,
        encrypted_range_sha256: hashValue(transcript.encrypted_range),
      },
      { ...configEvidence, absent_sha256: old.secret_at_rest_key },
      "retired_from_live_configuration",
    );
    must(
      retired.length === 9 &&
        new Set(retired.map((row) => row.authority)).size === 9,
      "nine_authorities_required",
    );
    await options.session.verify();
    const bytes = JSON.stringify(transcript) + "\n";
    await writeFile(
      join(options.outputDir, "retirement-transcript.private.json"),
      bytes,
      { mode: 0o600, flag: "wx" },
    );
    return { retired_authorities: retired, transcript_sha256: hash(bytes) };
  } catch (error) {
    if (
      error instanceof Error &&
      /^authority_probe_[a-z0-9_]+$/.test(error.message)
    )
      throw error;
    fail("verification_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
