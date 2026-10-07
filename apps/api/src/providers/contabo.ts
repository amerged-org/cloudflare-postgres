// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { OperationId } from "@pgcf/contracts";

const ORIGIN = "https://api.contabo.com";
const OAUTH =
  "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
const MAX_INT64 = 9223372036854775807n;
const Id = z
  .union([
    z.number().int().safe().positive(),
    z.string().regex(/^[1-9][0-9]{0,18}$/),
  ])
  .transform((value) => String(value))
  .refine((value) => BigInt(value) <= MAX_INT64);
const Text = z.string().max(2048),
  Short = Text.min(1).max(128);
const DateTime = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Regions = z.enum([
  "EU",
  "US-central",
  "US-east",
  "US-west",
  "SIN",
  "UK",
  "AUS",
  "JPN",
  "IND",
]);
const Status = z.enum([
  "provisioning",
  "uninstalled",
  "running",
  "stopped",
  "error",
  "installing",
  "unknown",
  "manual_provisioning",
  "product_not_available",
  "verification_required",
  "rescue",
  "pending_payment",
  "other",
  "reset_password",
]);
const V4 = z.object({
  ip: z.union([z.ipv4(), z.literal("")]),
  gateway: z.union([z.ipv4(), z.literal("")]),
  netmaskCidr: Count.max(32),
});
const V6 = z.object({
  ip: z.union([z.ipv6(), z.literal("")]),
  gateway: z.union([z.ipv6(), z.literal("")]),
  netmaskCidr: Count.max(128),
});
const AddOn = z.object({ id: Id, quantity: Count });
const InstanceWire = z.object({
  tenantId: Short,
  customerId: Short,
  instanceId: Id,
  name: Text.nullable(),
  displayName: z.string().max(255),
  dataCenter: Short.nullable(),
  region: Regions,
  regionName: Short.nullable(),
  productId: Short,
  productName: Text.max(128),
  imageId: Text.nullable().optional(),
  defaultUser: z.enum(["root", "admin", "administrator"]).optional(),
  ipConfig: z.object({ v4: V4, v6: V6.optional() }).nullable(),
  ramMb: z.number().finite().nonnegative().nullable(),
  cpuCores: Count,
  diskMb: z.number().finite().nonnegative().nullable(),
  osType: Text,
  sshKeys: z.array(Id).max(100).optional(),
  createdDate: DateTime,
  cancelDate: z.union([z.iso.date(), z.literal("")]).nullable(),
  status: Status,
  additionalIps: z.array(z.object({ v4: V4 })).max(100),
  macAddress: Text.nullable(),
  vHostId: Id.nullable(),
  vHostNumber: Count.nullable(),
  vHostName: Text.nullable(),
  addOns: z.array(AddOn).max(100),
  productType: z.enum(["hdd", "ssd", "vds", "nvme", "performance", "gpu"]),
  applicationId: Text.nullable(),
});
export interface ContaboInstance {
  id: string;
  tenantId: string;
  customerId: string;
  name: string | null;
  displayName: string;
  dataCenter: string | null;
  region: z.infer<typeof Regions>;
  regionName: string | null;
  productId: string;
  productName: string;
  imageId?: string | null;
  defaultUser?: "root" | "admin" | "administrator";
  ipConfig: z.infer<typeof InstanceWire>["ipConfig"];
  additionalIps: z.infer<typeof InstanceWire>["additionalIps"];
  ramMb: number | null;
  cpuCores: number;
  diskMb: number | null;
  macAddress: string | null;
  osType: string;
  applicationId: string | null;
  sshKeys?: string[];
  createdDate: string;
  cancelDate: string | null;
  status: z.infer<typeof Status>;
  addOns: z.infer<typeof AddOn>[];
}
export type Instance = ContaboInstance;
/** An order may exist before Contabo allocates its hardware and network. */
export function hasAllocatedContaboHardware(
  instance: ContaboInstance,
): instance is ContaboInstance & {
  ipConfig: NonNullable<ContaboInstance["ipConfig"]>;
  macAddress: string;
  ramMb: number;
  diskMb: number;
} {
  return (
    instance.status !== "pending_payment" &&
    instance.ipConfig !== null &&
    typeof instance.macAddress === "string" &&
    typeof instance.ramMb === "number" &&
    Number.isFinite(instance.ramMb) &&
    instance.ramMb > 0 &&
    typeof instance.diskMb === "number" &&
    Number.isFinite(instance.diskMb) &&
    instance.diskMb > 0 &&
    instance.cpuCores > 0
  );
}
const toInstance = (value: z.infer<typeof InstanceWire>): Instance => ({
  id: value.instanceId,
  tenantId: value.tenantId,
  customerId: value.customerId,
  name: value.name,
  displayName: value.displayName,
  dataCenter: value.dataCenter,
  region: value.region,
  regionName: value.regionName,
  productId: value.productId,
  productName: value.productName,
  ...(value.imageId === undefined ? {} : { imageId: value.imageId }),
  ...(value.defaultUser === undefined
    ? {}
    : { defaultUser: value.defaultUser }),
  ipConfig: value.ipConfig,
  additionalIps: value.additionalIps,
  ramMb: value.ramMb,
  cpuCores: value.cpuCores,
  diskMb: value.diskMb,
  macAddress: value.macAddress,
  osType: value.osType,
  applicationId: value.applicationId,
  ...(value.sshKeys === undefined ? {} : { sshKeys: value.sshKeys }),
  createdDate: value.createdDate,
  cancelDate: value.cancelDate,
  status: value.status,
  addOns: value.addOns,
});
const AuditWire = z.object({
  id: Id,
  action: z.enum(["CREATED", "UPDATED", "DELETED"]),
  timestamp: DateTime,
  tenantId: Short,
  customerId: Short,
  changedBy: Short,
  username: Text,
  requestId: z.uuid(),
  traceId: Text.nullable(),
  instanceId: z.union([Id, z.literal(0).transform(() => "0")]),
  changes: z.unknown().optional(),
});
export interface ContaboAudit {
  id: string;
  action: "CREATED" | "UPDATED" | "DELETED";
  timestamp: string;
  tenantId: string;
  customerId: string;
  requestId: string;
  traceId: string | null;
  instanceId: string;
}
export type Audit = ContaboAudit;
const toAudit = (value: z.infer<typeof AuditWire>): Audit => ({
  id: value.id,
  action: value.action,
  timestamp: value.timestamp,
  tenantId: value.tenantId,
  customerId: value.customerId,
  requestId: value.requestId,
  traceId: value.traceId,
  instanceId: value.instanceId,
});
const Order = z
  .strictObject({
    productId: Short,
    region: Regions,
    imageId: Short,
    displayName: z.string().min(1).max(255),
    period: z.union([z.literal(1), z.literal(12), z.literal(24)]),
    defaultUser: z.enum(["root", "admin", "administrator"]),
    sshKeys: z.array(Id).min(1).max(100).optional(),
    rootPassword: Id.optional(),
    userData: z.string().max(32768).optional(),
    addOns: z
      .strictObject({
        addonsIds: z
          .array(AddOn.safeExtend({ quantity: Count.positive() }))
          .min(1)
          .max(100),
      })
      .optional(),
  })
  .refine(
    (input) => input.rootPassword !== undefined || input.sshKeys !== undefined,
  );
export interface ContaboOrderInput {
  productId: string;
  region: z.infer<typeof Regions>;
  imageId: string;
  displayName: string;
  period: 1 | 12 | 24;
  defaultUser: "root" | "admin" | "administrator";
  sshKeys?: readonly string[];
  rootPassword?: string;
  userData?: string;
  addOns?: { addonsIds: readonly { id: string; quantity: number }[] };
}
const Rescue = z
  .strictObject({
    sshKeys: z.array(Id).min(1).max(100).optional(),
    rootPassword: Id.optional(),
    userData: z.string().max(32768).optional(),
  })
  .refine(
    (input) => input.rootPassword !== undefined || input.sshKeys !== undefined,
  );
export interface ContaboRescueInput {
  sshKeys?: readonly string[];
  rootPassword?: string;
  userData?: string;
}
const OrderReceipt = z.object({
  tenantId: Short,
  customerId: Short,
  instanceId: Id,
  createdDate: DateTime,
  imageId: Short,
  productId: Short,
  region: Regions,
  addOns: z.array(AddOn).max(100),
  osType: Text,
  status: Status,
  sshKeys: z.array(Id).max(100),
});
export type ContaboOrderReceipt = z.infer<typeof OrderReceipt>;
const ActionReceipt = z.object({
  tenantId: Short,
  customerId: Short,
  instanceId: Id,
  action: z.enum(["rescue", "restart"]),
});
export type ContaboActionReceipt = z.infer<typeof ActionReceipt>;
const Port = z
  .string()
  .regex(/^[0-9]{1,5}(?:-[0-9]{1,5})?$/)
  .refine((value) => {
    const parts = value.split("-");
    const a = Number(parts[0]),
      b = Number(parts[1] ?? parts[0]);
    return a >= 1 && b >= a && b <= 65535;
  });
const Cidr = z
  .string()
  .max(64)
  .refine((value) => {
    const [address, prefix, ...rest] = value.split("/");
    if (rest.length || prefix === undefined || !/^\d{1,3}$/.test(prefix))
      return false;
    const count = Number(prefix);
    return z.ipv4().safeParse(address).success
      ? count >= 1 && count <= 32
      : z.ipv6().safeParse(address).success && count >= 1 && count <= 128;
  });
const Rule = z
  .strictObject({
    protocol: z.enum(["tcp", "udp", "icmp"]),
    destPorts: z.array(Port).max(15),
    srcCidr: z
      .strictObject({
        ipv4: z
          .array(
            Cidr.refine(
              (value) => z.ipv4().safeParse(value.split("/")[0]).success,
            ),
          )
          .max(64)
          .optional(),
        ipv6: z
          .array(
            Cidr.refine(
              (value) => z.ipv6().safeParse(value.split("/")[0]).success,
            ),
          )
          .max(64)
          .optional(),
      })
      .refine(
        (value) => (value.ipv4?.length ?? 0) + (value.ipv6?.length ?? 0) > 0,
      ),
    action: z.literal("accept"),
    status: z.literal("active"),
    displayName: z.string().min(1).max(255),
  })
  .refine((value) =>
    value.protocol === "icmp"
      ? value.destPorts.length === 0
      : value.destPorts.length > 0,
  );
export interface ContaboFirewallRulesInput {
  rules: { inbound: z.infer<typeof Rule>[] };
}
const CreateFirewall = z.strictObject({
  name: z.string().min(1).max(255),
  description: z.string().max(255).optional(),
  status: z.enum(["active", "inactive"]),
  rules: z.strictObject({ inbound: z.array(Rule).max(100) }).optional(),
});
export type ContaboFirewallCreateInput = z.infer<typeof CreateFirewall>;
const Rules = z.strictObject({
  rules: z.strictObject({ inbound: z.array(Rule).min(1).max(100) }),
});
const FirewallRuleWire = z.object({
  protocol: z.enum(["tcp", "udp", "icmp", ""]),
  destPorts: z.array(Text).max(100),
  srcCidr: z.object({
    ipv4: z.array(Text).max(100).optional(),
    ipv6: z.array(Text).max(100).optional(),
  }),
  action: z.enum(["accept", "drop"]),
  status: z.enum(["active", "inactive"]),
  displayName: Text,
});
const Firewall = z.object({
  tenantId: Short,
  customerId: Short,
  firewallId: Short,
  name: z.string().max(255),
  description: z.string().max(255),
  status: z.enum(["active", "inactive"]),
  instanceStatus: z
    .array(
      z.object({
        instanceId: Id,
        status: z.enum([
          "ok",
          "processing",
          "deleting",
          "error_processing",
          "error_deleting",
        ]),
      }),
    )
    .max(10000),
  instances: z
    .array(
      z.object({
        instanceId: Id,
        displayName: Text.nullable(),
        name: Text,
        productId: Short,
        ipConfig: z.object({ v4: V4, v6: V6 }),
        regionSlug: Short,
        regionName: Short,
        dataCenterSlug: Short,
        dataCenterName: Short,
      }),
    )
    .max(10000),
  rules: z.object({ inbound: z.array(FirewallRuleWire).max(100) }),
  createdDate: DateTime,
  updatedDate: DateTime,
});
export type ContaboFirewall = z.infer<typeof Firewall>;
const Links = z.object({
  self: Text.min(1),
  first: Text.min(1).optional(),
  last: Text.min(1).optional(),
  previous: Text.optional(),
  next: Text.optional(),
});
const Pagination = z.object({
  page: Count,
  size: Count.positive(),
  totalElements: Count,
  totalPages: Count,
});
export const CONTABO_ACCOUNTING_STAGES = [
  "inspection",
  "source_selection",
  "prewrite",
  "firewall",
  "rescue",
  "order",
  "resolution",
] as const;
export const ContaboAccountingStage = z.enum(CONTABO_ACCOUNTING_STAGES);
export type ContaboAccountingStage = z.infer<typeof ContaboAccountingStage>;
export const ContaboRequestAccounting = z.strictObject({
  operation_id: OperationId,
  stage: ContaboAccountingStage,
});
export type ContaboRequestAccounting = z.infer<typeof ContaboRequestAccounting>;
const ContaboWireEvent = z.strictObject({
  event: z.literal("contabo_wire_request"),
  operation_id: OperationId,
  stage: ContaboAccountingStage,
  kind: z.enum(["oauth", "resource"]),
  method: z.enum(["GET", "POST", "PUT"]),
  request_id: z.uuid(),
  wire_id: z.uuid(),
});
const requestSchema = z.strictObject({
  requestId: z.uuid(),
  traceId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/)
    .optional(),
  signal: z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional(),
  deadline: z.number().int().safe().optional(),
  accounting: ContaboRequestAccounting.optional(),
});
export interface ContaboRequest {
  requestId: string;
  traceId?: string;
  signal?: AbortSignal;
  deadline?: number;
  accounting?: ContaboRequestAccounting;
}
export type ContaboCode =
  | "invalid_input"
  | "aborted"
  | "timeout"
  | "network_error"
  | "body_limit"
  | "invalid_response"
  | "pagination_incomplete"
  | "provider_rejected"
  | "not_dispatched"
  | "unexpected_status"
  | "authorization_unavailable";
export class ContaboError extends Error {
  readonly code: ContaboCode;
  readonly status?: number;
  constructor(code: ContaboCode, status?: number) {
    super(code);
    this.name = "ContaboError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
export type ContaboMutationResult<T> =
  | {
      kind: "accepted";
      code: "accepted";
      requestId: string;
      status: number;
      dispatched: true;
      value: T;
    }
  | {
      kind: "rejected";
      code: "provider_rejected";
      requestId: string;
      status: number;
      dispatched: true;
    }
  | {
      kind: "rejected";
      code: "not_dispatched";
      requestId: string;
      status?: number;
      dispatched: false;
    }
  | {
      kind: "unknown";
      code: ContaboCode;
      requestId: string;
      status?: number;
      dispatched: true;
    };
export type MutationResult<T> = ContaboMutationResult<T>;
export interface ContaboClientOptions {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxPages?: number;
  pageSize?: number;
  now?: () => number;
}
const explicitRejection = new Set([400, 401, 402, 403, 404, 405, 415, 422]);
const invalid = (): never => {
  throw new ContaboError("invalid_input");
};
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new ContaboError("invalid_input");
  return value.data;
}
async function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new ContaboError("aborted");
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new ContaboError("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof ContaboError
            ? error
            : new ContaboError("network_error"),
        );
      },
    );
  });
}
function numericRefs(value: Record<string, unknown>): string {
  return (
    "{" +
    Object.entries(value)
      .filter(([, input]) => input !== undefined)
      .map(
        ([name, input]) =>
          JSON.stringify(name) +
          ":" +
          (name === "rootPassword"
            ? String(input)
            : name === "sshKeys"
              ? "[" + (input as string[]).join(",") + "]"
              : name === "addOns"
                ? '{"addonsIds":[' +
                  (
                    input as { addonsIds: { id: string; quantity: number }[] }
                  ).addonsIds
                    .map(
                      (addon) =>
                        '{"id":' +
                        addon.id +
                        ',"quantity":' +
                        addon.quantity +
                        "}",
                    )
                    .join(",") +
                  "]}"
                : JSON.stringify(input)),
      )
      .join(",") +
    "}"
  );
}

function exactJson(text: string): unknown {
  // JSON.parse can round a fractional or oversized ID into a different integer.
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === "\\") {
      i++;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted || (char !== "-" && !/[0-9]/.test(char ?? ""))) continue;
    number.lastIndex = i;
    const token = number.exec(text)?.[0];
    if (!token) throw new ContaboError("invalid_response");
    i += token.length - 1;
    const value = Number(token);
    if (!Number.isFinite(value)) throw new ContaboError("invalid_response");
    if (!Number.isInteger(value)) continue;
    if (!Number.isSafeInteger(value))
      throw new ContaboError("invalid_response");
    const parts = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
      token,
    )!;
    let digits = (parts[2]! + (parts[3] ?? "")).replace(/^0+/, "");
    if (!digits) continue;
    const scale = Number(parts[4] ?? 0) - (parts[3]?.length ?? 0);
    if (scale < 0) {
      const end = digits.length + scale;
      if (end <= 0 || /[1-9]/.test(digits.slice(end)))
        throw new ContaboError("invalid_response");
      digits = digits.slice(0, end);
    } else {
      if (digits.length + scale > 16)
        throw new ContaboError("invalid_response");
      digits += "0".repeat(scale);
    }
    if (parts[1] + digits !== String(value))
      throw new ContaboError("invalid_response");
  }
  return JSON.parse(text);
}

export class ContaboClient {
  readonly #options: ContaboClientOptions;
  private readonly timeout: number;
  private readonly bodyLimit: number;
  private readonly pages: number;
  private readonly size: number;
  #auth?: { value: string; expires: number };
  #authenticating?: Promise<string>;
  constructor(options: ContaboClientOptions) {
    for (const field of [
      options.clientId,
      options.clientSecret,
      options.username,
      options.password,
    ])
      if (
        typeof field !== "string" ||
        field.length < 1 ||
        field.length > 4096 ||
        field.includes("\0")
      )
        invalid();
    this.timeout = options.timeoutMs ?? 20_000;
    this.bodyLimit = options.maxBodyBytes ?? 1024 * 1024;
    this.pages = options.maxPages ?? 100;
    this.size = options.pageSize ?? 100;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60_000 ||
      !Number.isSafeInteger(this.bodyLimit) ||
      this.bodyLimit < 1 ||
      this.bodyLimit > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(this.pages) ||
      this.pages < 1 ||
      this.pages > 100 ||
      !Number.isSafeInteger(this.size) ||
      this.size < 1 ||
      this.size > 100
    )
      invalid();
    this.#options = { ...options };
  }
  private now() {
    return (this.#options.now ?? Date.now)();
  }
  private context(input: ContaboRequest): {
    request: ContaboRequest;
    signal: AbortSignal;
  } {
    const request = parsed(requestSchema, input),
      time = this.now(),
      remaining =
        request.deadline === undefined
          ? this.timeout
          : Math.min(this.timeout, request.deadline - time);
    if (!Number.isFinite(time) || remaining <= 0 || request.signal?.aborted)
      throw new ContaboError("aborted");
    return {
      request,
      signal: AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(remaining),
      ]),
    };
  }
  private async json(
    response: Response,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!response.body)
      throw new ContaboError("invalid_response", response.status);
    const length = response.headers.get("Content-Length");
    if (
      length !== null &&
      /^\d+$/.test(length) &&
      Number(length) > this.bodyLimit
    ) {
      void response.body.cancel().catch(() => {});
      throw new ContaboError("body_limit", response.status);
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await bounded(reader.read(), signal);
        if (part.done) break;
        total += part.value.byteLength;
        if (total > this.bodyLimit)
          throw new ContaboError("body_limit", response.status);
        chunks.push(part.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.length;
    }
    try {
      return exactJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      );
    } catch {
      throw new ContaboError("invalid_response", response.status);
    }
  }
  private wireFetch(
    url: string,
    init: RequestInit,
    request: ContaboRequest,
    kind: "oauth" | "resource",
  ): Promise<Response> {
    // Accounting belongs to this invocation, never the shared token or authentication promise.
    try {
      if (request.accounting) {
        const event = ContaboWireEvent.safeParse({
          event: "contabo_wire_request",
          ...request.accounting,
          kind,
          method: init.method,
          request_id: request.requestId,
          wire_id: crypto.randomUUID(),
        });
        if (event.success) console.log(JSON.stringify(event.data));
      }
    } catch {
      // An unavailable console must not change provider dispatch or its original outcome.
    }
    return (this.#options.fetcher ?? fetch)(url, init);
  }
  private async token(
    signal: AbortSignal,
    request: ContaboRequest,
  ): Promise<string> {
    if (this.#auth && this.#auth.expires > this.now()) return this.#auth.value;
    this.#authenticating ??= (async () => {
      const own = AbortSignal.timeout(this.timeout),
        o = this.#options;
      const response = await bounded(
        this.wireFetch(
          OAUTH,
          {
            method: "POST",
            redirect: "manual",
            signal: own,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "password",
              client_id: o.clientId,
              client_secret: o.clientSecret,
              username: o.username,
              password: o.password,
            }),
          },
          request,
          "oauth",
        ),
        own,
      );
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new ContaboError("authorization_unavailable", response.status);
      }
      const token = z
        .object({
          access_token: z
            .string()
            .min(1)
            .max(16384)
            .regex(/^[^\s]+$/),
          token_type: z.string().regex(/^bearer$/i),
          expires_in: Count.positive().max(86400),
        })
        .safeParse(await this.json(response, own));
      if (!token.success)
        throw new ContaboError("authorization_unavailable", response.status);
      this.#auth = {
        value: token.data.access_token,
        expires: this.now() + Math.max(0, token.data.expires_in * 1000 - 5000),
      };
      return token.data.access_token;
    })().finally(() => {
      this.#authenticating = undefined;
    });
    return bounded(this.#authenticating, signal);
  }
  private link(value: string, path: string | readonly string[]): void {
    let url: URL;
    try {
      url = new URL(value, ORIGIN);
    } catch {
      throw new ContaboError("invalid_response");
    }
    if (
      url.origin !== ORIGIN ||
      !(typeof path === "string" ? [path] : path).includes(url.pathname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new ContaboError("invalid_response");
  }
  private envelope(raw: unknown, path: string | readonly string[]): unknown[] {
    const envelope = z
      .object({ data: z.array(z.unknown()).max(10000), _links: Links })
      .safeParse(raw);
    if (!envelope.success) throw new ContaboError("invalid_response");
    for (const link of Object.values(envelope.data._links))
      if (link) this.link(link, path);
    return envelope.data.data;
  }
  private async response(
    path: string,
    method: string,
    request: ContaboRequest,
    signal: AbortSignal,
    token: string,
    body?: string,
  ): Promise<Response> {
    const url = new URL(path, ORIGIN);
    if (
      url.origin !== ORIGIN ||
      !url.pathname.startsWith("/v1/") ||
      url.username ||
      url.password ||
      url.hash
    )
      invalid();
    signal.throwIfAborted();
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "x-request-id": request.requestId,
      Accept: "application/json",
    });
    if (request.traceId) headers.set("x-trace-id", request.traceId);
    if (body !== undefined) {
      if (new TextEncoder().encode(body).length > 64 * 1024) invalid();
      headers.set("Content-Type", "application/json");
    }
    const result = await bounded(
      this.wireFetch(
        url.href,
        {
          method,
          redirect: "manual",
          headers,
          signal,
          ...(body === undefined ? {} : { body }),
        },
        request,
        "resource",
      ),
      signal,
    );
    if (result.status === 401) this.#auth = undefined;
    return result;
  }
  private async read(
    path: string,
    requestInput: ContaboRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const context = signal
      ? { request: parsed(requestSchema, requestInput), signal }
      : this.context(requestInput);
    try {
      const token = await this.token(context.signal, context.request),
        response = await this.response(
          path,
          "GET",
          context.request,
          context.signal,
          token,
        );
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new ContaboError("unexpected_status", response.status);
      }
      return await this.json(response, context.signal);
    } catch (error) {
      if (error instanceof ContaboError) throw error;
      throw new ContaboError("network_error");
    }
  }
  private async mutation<T>(
    path: string,
    method: "POST" | "PUT",
    body: string | undefined,
    input: ContaboRequest,
    status: number,
    validate: (raw: unknown) => T,
  ): Promise<MutationResult<T>> {
    const request = parsed(requestSchema, input);
    let signal: AbortSignal;
    try {
      signal = this.context(request).signal;
    } catch (error) {
      if (error instanceof ContaboError && error.code === "aborted")
        return {
          kind: "rejected",
          code: "not_dispatched",
          dispatched: false,
          requestId: request.requestId,
        };
      throw error;
    }
    let token: string;
    try {
      token = await this.token(signal, request);
    } catch (error) {
      return {
        kind: "rejected",
        code: "not_dispatched",
        requestId: request.requestId,
        dispatched: false,
        ...(error instanceof ContaboError && error.status !== undefined
          ? { status: error.status }
          : {}),
      };
    }
    let response: Response | undefined;
    try {
      response = await this.response(
        path,
        method,
        request,
        signal,
        token,
        body,
      );
      if (explicitRejection.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        return {
          kind: "rejected",
          code: "provider_rejected",
          status: response.status,
          requestId: request.requestId,
          dispatched: true,
        };
      }
      if (response.status !== status) {
        void response.body?.cancel().catch(() => {});
        return {
          kind: "unknown",
          code: "unexpected_status",
          status: response.status,
          requestId: request.requestId,
          dispatched: true,
        };
      }
      const raw = await this.json(response, signal);
      let value: T;
      try {
        value = validate(raw);
      } catch {
        throw new ContaboError("invalid_response", response.status);
      }
      return {
        kind: "accepted",
        code: "accepted",
        status: response.status,
        requestId: request.requestId,
        dispatched: true,
        value,
      };
    } catch (error) {
      return {
        kind: "unknown",
        code:
          error instanceof ContaboError
            ? error.code
            : signal.aborted
              ? "aborted"
              : "network_error",
        requestId: request.requestId,
        dispatched: true,
        ...(response ? { status: response.status } : {}),
      };
    }
  }
  async getInstance(idInput: string, input: ContaboRequest): Promise<Instance> {
    const id = parsed(Id, idInput),
      path = `/v1/compute/instances/${id}`;
    const rows = this.envelope(await this.read(path, input), path);
    const row = InstanceWire.safeParse(rows[0]);
    if (rows.length !== 1 || !row.success || row.data.instanceId !== id)
      throw new ContaboError("invalid_response");
    return toInstance(row.data);
  }
  private async page<T>(
    path: string,
    query: URLSearchParams,
    input: ContaboRequest,
    schema: z.ZodType<T>,
    identity: (value: T) => string,
  ): Promise<T[]> {
    const { signal, request } = this.context(input);
    query.set("size", String(this.size));
    let first: number | undefined,
      expected: number | undefined,
      total: number | undefined,
      lastPages: number | undefined,
      inventoryBytes = 0;
    const values: T[] = [],
      identities = new Set<string>();
    for (let count = 0; count < this.pages; count++) {
      if (expected !== undefined) query.set("page", String(expected));
      const raw = await this.read(`${path}?${query}`, request, signal),
        page = z
          .object({
            data: z.array(schema).max(this.size),
            _pagination: Pagination,
            _links: Links.extend({ first: Text.min(1), last: Text }),
          })
          .safeParse(raw);
      if (!page.success) throw new ContaboError("invalid_response");
      const { data, _pagination: meta, _links: links } = page.data;
      if (
        !links.last &&
        !(
          data.length === 0 &&
          meta.totalElements === 0 &&
          meta.totalPages === 0 &&
          !links.previous &&
          !links.next
        )
      )
        throw new ContaboError("invalid_response");
      inventoryBytes += new TextEncoder().encode(JSON.stringify(data)).length;
      if (inventoryBytes > this.bodyLimit)
        throw new ContaboError("pagination_incomplete");
      for (const link of Object.values(links)) if (link) this.link(link, path);
      if (
        meta.size !== this.size ||
        meta.totalElements > this.pages * this.size ||
        meta.totalPages > this.pages ||
        meta.totalPages !== Math.ceil(meta.totalElements / meta.size)
      )
        throw new ContaboError("pagination_incomplete");
      if (first === undefined) {
        if (meta.page !== 0 && meta.page !== 1)
          throw new ContaboError("pagination_incomplete");
        first = meta.page;
        total = meta.totalElements;
        lastPages = meta.totalPages;
      }
      if (
        meta.totalElements !== total ||
        meta.totalPages !== lastPages ||
        (expected !== undefined && meta.page !== expected)
      )
        throw new ContaboError("pagination_incomplete");
      for (const value of data) {
        const id = identity(value);
        if (identities.has(id)) throw new ContaboError("pagination_incomplete");
        identities.add(id);
        values.push(value);
      }
      if (meta.totalPages === 0 || meta.page === first + meta.totalPages - 1) {
        if (values.length !== meta.totalElements)
          throw new ContaboError("pagination_incomplete");
        return values;
      }
      if (data.length !== meta.size)
        throw new ContaboError("pagination_incomplete");
      expected = meta.page + 1;
    }
    throw new ContaboError("pagination_incomplete");
  }
  async listInstances(
    filters: {
      displayName?: string;
      region?: z.infer<typeof Regions>;
      productIds?: string;
      status?: z.infer<typeof Status>;
    },
    input: ContaboRequest,
  ): Promise<Instance[]> {
    const value = parsed(
      z.strictObject({
        displayName: z.string().min(1).max(255).optional(),
        region: Regions.optional(),
        productIds: Short.optional(),
        status: Status.optional(),
      }),
      filters,
    );
    return (
      await this.page(
        "/v1/compute/instances",
        new URLSearchParams(value),
        input,
        InstanceWire,
        (row) => row.instanceId,
      )
    ).map(toInstance);
  }
  async instanceAudits(
    filters: {
      requestId: string;
      instanceId?: string;
      startDate?: string;
      endDate?: string;
    },
    input: ContaboRequest,
  ): Promise<Audit[]> {
    return this.audits("/v1/compute/instances/audits", filters, input);
  }
  async actionAudits(
    filters: {
      requestId: string;
      instanceId?: string;
      startDate?: string;
      endDate?: string;
    },
    input: ContaboRequest,
  ): Promise<Audit[]> {
    return this.audits("/v1/compute/instances/actions/audits", filters, input);
  }
  private async audits(
    path: string,
    filters: {
      requestId: string;
      instanceId?: string;
      startDate?: string;
      endDate?: string;
    },
    input: ContaboRequest,
  ): Promise<Audit[]> {
    const value = parsed(
      z.strictObject({
        requestId: z.uuid(),
        instanceId: Id.optional(),
        startDate: z.iso.date().optional(),
        endDate: z.iso.date().optional(),
      }),
      filters,
    );
    const rows = await this.page(
      path,
      new URLSearchParams(value),
      input,
      AuditWire,
      (row) => row.id,
    );
    if (
      rows.some(
        (row) =>
          row.requestId !== value.requestId ||
          (value.instanceId !== undefined &&
            row.instanceId !== value.instanceId),
      )
    )
      throw new ContaboError("invalid_response");
    return rows.map(toAudit);
  }
  async order(
    input: ContaboOrderInput,
    request: ContaboRequest,
  ): Promise<MutationResult<ContaboOrderReceipt>> {
    const order = parsed(Order, input),
      body = numericRefs(order);
    if (new TextEncoder().encode(body).length > 64 * 1024) invalid();
    return this.mutation(
      "/v1/compute/instances",
      "POST",
      body,
      request,
      201,
      (raw) => {
        const preliminary = z
          .object({ data: z.array(OrderReceipt).length(1) })
          .parse(raw);
        const value = preliminary.data[0]!;
        const rows = this.envelope(raw, [
          "/v1/compute/instances",
          `/v1/compute/instances/${value.instanceId}`,
        ]);
        if (
          rows.length !== 1 ||
          value.productId !== order.productId ||
          value.region !== order.region ||
          value.imageId !== order.imageId
        )
          throw new ContaboError("invalid_response");
        return value;
      },
    );
  }
  async rescue(
    idInput: string,
    input: ContaboRescueInput,
    request: ContaboRequest,
  ): Promise<MutationResult<ContaboActionReceipt>> {
    const id = parsed(Id, idInput),
      body = parsed(Rescue, input);
    return this.action(id, "rescue", numericRefs(body), request);
  }
  async restart(
    idInput: string,
    request: ContaboRequest,
  ): Promise<MutationResult<ContaboActionReceipt>> {
    return this.action(parsed(Id, idInput), "restart", undefined, request);
  }
  private action(
    id: string,
    action: "rescue" | "restart",
    body: string | undefined,
    request: ContaboRequest,
  ): Promise<MutationResult<ContaboActionReceipt>> {
    return this.mutation(
      `/v1/compute/instances/${id}/actions/${action}`,
      "POST",
      body,
      request,
      201,
      (raw) => {
        const rows = this.envelope(raw, [
            `/v1/compute/instances/${id}`,
            `/v1/compute/instances/${id}/actions/${action}`,
          ]),
          value = ActionReceipt.parse(rows[0]);
        if (
          rows.length !== 1 ||
          value.instanceId !== id ||
          value.action !== action
        )
          throw new ContaboError("invalid_response");
        return value;
      },
    );
  }
  async getFirewall(
    idInput: string,
    input: ContaboRequest,
  ): Promise<ContaboFirewall> {
    const id = parsed(Short, idInput);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid();
    const path = `/v1/firewalls/${id}`,
      rows = this.envelope(await this.read(path, input), path),
      value = Firewall.safeParse(rows[0]);
    if (rows.length !== 1 || !value.success || value.data.firewallId !== id)
      throw new ContaboError("invalid_response");
    return value.data;
  }
  async listFirewalls(
    filters: { name?: string },
    input: ContaboRequest,
  ): Promise<ContaboFirewall[]> {
    const value = parsed(
      z.strictObject({ name: z.string().min(1).max(255).optional() }),
      filters,
    );
    return this.page(
      "/v1/firewalls",
      new URLSearchParams(value),
      input,
      Firewall,
      (row) => row.firewallId,
    );
  }
  /** Creates a definition only; this request cannot purchase instance add-ons. */
  async createFirewall(
    input: ContaboFirewallCreateInput,
    request: ContaboRequest,
  ): Promise<MutationResult<ContaboFirewall>> {
    const body = parsed(CreateFirewall, input);
    return this.mutation(
      "/v1/firewalls",
      "POST",
      JSON.stringify(body),
      request,
      201,
      (raw) => {
        const response = z
            .object({ data: z.array(Firewall).length(1), _links: Links })
            .parse(raw),
          value = response.data[0]!;
        z.uuid().parse(value.firewallId);
        this.envelope(raw, `/v1/firewalls/${value.firewallId}`);
        if (
          value.name !== body.name ||
          value.status !== body.status ||
          (body.description !== undefined &&
            value.description !== body.description)
        )
          throw new ContaboError("invalid_response");
        return value;
      },
    );
  }
  async putFirewallRules(
    idInput: string,
    input: ContaboFirewallRulesInput,
    request: ContaboRequest,
  ): Promise<MutationResult<ContaboFirewall>> {
    const id = parsed(Short, idInput),
      body = parsed(Rules, input);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid();
    return this.mutation(
      `/v1/firewalls/${id}`,
      "PUT",
      JSON.stringify(body),
      request,
      200,
      (raw) => {
        const rows = this.envelope(raw, `/v1/firewalls/${id}`),
          value = Firewall.parse(rows[0]);
        if (rows.length !== 1 || value.firewallId !== id)
          throw new ContaboError("invalid_response");
        return value;
      },
    );
  }
  async assignFirewall(
    idInput: string,
    instanceInput: string,
    request: ContaboRequest,
  ): Promise<MutationResult<{ firewallId: string; instanceId: string }>> {
    const id = parsed(Short, idInput),
      instanceId = parsed(Id, instanceInput);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid();
    const path = `/v1/firewalls/${id}/instances/${instanceId}`;
    return this.mutation(path, "POST", undefined, request, 201, (raw) => {
      const value = z.object({ _links: Links }).parse(raw);
      this.link(value._links.self, path);
      return { firewallId: id, instanceId };
    });
  }
}
