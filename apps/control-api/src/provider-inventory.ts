// SPDX-License-Identifier: Apache-2.0
import { error, installation, json, sha256 } from "./accounting";
interface ProviderEnv extends Cloudflare.Env {
  CONTABO_CLIENT_ID?: string;
  CONTABO_CLIENT_SECRET?: string;
  CONTABO_API_USERNAME?: string;
  CONTABO_API_PASSWORD?: string;
}
interface Instance {
  instanceId: string;
  region: string;
  dataCenter: string;
  status: string;
  cpuCores: number;
  ramMb: string;
  diskMb: string;
  ipv4: string | null;
  ipv6: string | null;
}
interface Pagination {
  size: number;
  totalElements: number;
  totalPages: number;
  page: number;
}
const route = "/v1/installation/providers/contabo/instances";
const authURL =
  "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
const instancesURL = "https://api.contabo.com/v1/compute/instances";
const failed = () => new Error("provider_inventory_unavailable");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function decimal(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
      throw failed();
    return String(value);
  }
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw failed();
  return value;
}
function count(value: unknown, minimum: number, maximum: number): number {
  const text = decimal(value),
    number = Number(text);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw failed();
  return number;
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw failed();
  return value;
}
function ip(value: unknown, version: 4 | 6): string | null {
  if (value === undefined || value === null) return null;
  if (!object(value)) throw failed();
  const address = value.ip;
  if (address === undefined || address === null) return null;
  if (typeof address !== "string" || address.length > 45) throw failed();
  if (version === 4) {
    const pieces = address.split(".");
    if (
      pieces.length !== 4 ||
      pieces.some(
        (part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255,
      )
    )
      throw failed();
  } else {
    if (!address.includes(":") || !/^[a-fA-F0-9:.]+$/.test(address))
      throw failed();
    try {
      const parsed = new URL(`https://[${address}]/`);
      if (
        !parsed.hostname.startsWith("[") ||
        parsed.port ||
        parsed.username ||
        parsed.password
      )
        throw failed();
    } catch {
      throw failed();
    }
  }
  return address;
}
function instance(value: unknown): Instance {
  if (!object(value)) throw failed();
  const instanceId = decimal(value.instanceId);
  if (instanceId === "0") throw failed();
  const ips = value.ipConfig;
  if (ips !== undefined && ips !== null && !object(ips)) throw failed();
  return {
    instanceId,
    region: text(value.region, 128),
    dataCenter: text(value.dataCenter, 256),
    status: text(value.status, 64),
    cpuCores: count(value.cpuCores, 0, Number.MAX_SAFE_INTEGER),
    ramMb: decimal(value.ramMb),
    diskMb: decimal(value.diskMb),
    ipv4: ip(object(ips) ? ips.v4 : undefined, 4),
    ipv6: ip(object(ips) ? ips.v6 : undefined, 6),
  };
}
class Observation {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly input: AbortSignal;
  private readonly cancelled: () => void;
  private readonly abort: Promise<never>;
  constructor(signal: AbortSignal) {
    this.input = signal;
    this.cancelled = () => this.controller.abort();
    this.input.addEventListener("abort", this.cancelled, { once: true });
    this.abort = new Promise((_, reject) =>
      this.controller.signal.addEventListener("abort", () => reject(failed()), {
        once: true,
      }),
    );
    // All fetch dispatches and every stream read share one whole-operation cap.
    this.timer = setTimeout(() => this.controller.abort(), 20000);
    if (signal.aborted) this.controller.abort();
    void this.abort.catch(() => {});
  }
  check(): void {
    if (this.controller.signal.aborted) throw failed();
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    return await Promise.race([promise, this.abort]);
  }
  async request(
    url: string,
    init: RequestInit,
    maximum: number,
  ): Promise<unknown> {
    this.check();
    const response = await this.wait(
      fetch(url, {
        ...init,
        redirect: "manual",
        signal: this.controller.signal,
      }),
    );
    if (response.status !== 200 || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw failed();
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      void response.body?.cancel().catch(() => {});
      throw failed();
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum)
    ) {
      void response.body?.cancel().catch(() => {});
      throw failed();
    }
    if (!response.body) throw failed();
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let bytes = 0,
      contents = "";
    try {
      while (true) {
        const chunk = await this.wait(reader.read());
        if (chunk.done) {
          this.check();
          return JSON.parse(contents + decoder.decode()) as unknown;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maximum) throw failed();
        contents += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      void reader.cancel().catch(() => {});
      throw failed();
    } finally {
      reader.releaseLock();
    }
  }
  close(): void {
    clearTimeout(this.timer);
    this.input.removeEventListener("abort", this.cancelled);
    this.controller.abort();
  }
}
async function observe(env: ProviderEnv, observation: Observation) {
  const credentialNames = [
    "CONTABO_CLIENT_ID",
    "CONTABO_CLIENT_SECRET",
    "CONTABO_API_USERNAME",
    "CONTABO_API_PASSWORD",
  ] as const;
  if (
    credentialNames.some(
      (name) =>
        typeof env[name] !== "string" ||
        env[name]!.length < 1 ||
        env[name]!.length > 8192,
    )
  )
    throw failed();
  const startedAt = new Date(Date.now()).toISOString();
  const form = new URLSearchParams({
    grant_type: "password",
    client_id: env.CONTABO_CLIENT_ID!,
    client_secret: env.CONTABO_CLIENT_SECRET!,
    username: env.CONTABO_API_USERNAME!,
    password: env.CONTABO_API_PASSWORD!,
  });
  const authorization = await observation.request(
    authURL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    },
    16384,
  );
  if (
    !object(authorization) ||
    typeof authorization.access_token !== "string" ||
    authorization.access_token.length > 8192 ||
    !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(authorization.access_token) ||
    (authorization.token_type !== undefined &&
      (typeof authorization.token_type !== "string" ||
        authorization.token_type.toLowerCase() !== "bearer"))
  )
    throw failed();
  const instances: Instance[] = [],
    seen = new Set<string>();
  let baseline: Pagination | null = null;
  for (let page = 1; page <= 10; page++) {
    const result = await observation.request(
      `${instancesURL}?page=${page}&size=100`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${authorization.access_token}`,
          accept: "application/json",
          "x-request-id": crypto.randomUUID(),
        },
      },
      1048576,
    );
    if (
      !object(result) ||
      !object(result._pagination) ||
      !Array.isArray(result.data)
    )
      throw failed();
    const metadata: Pagination = {
      size: count(result._pagination.size, 1, 100),
      totalElements: count(result._pagination.totalElements, 0, 1000),
      totalPages: count(result._pagination.totalPages, 0, 10),
      page: count(result._pagination.page, 1, 10),
    };
    if (metadata.page !== page) throw failed();
    if (metadata.totalElements === 0) {
      if (result.data.length !== 0 || page !== 1 || metadata.totalPages > 1)
        throw failed();
    } else if (
      metadata.totalPages !== Math.ceil(metadata.totalElements / metadata.size)
    )
      throw failed();
    if (
      baseline &&
      (metadata.size !== baseline.size ||
        metadata.totalElements !== baseline.totalElements ||
        metadata.totalPages !== baseline.totalPages)
    )
      throw failed();
    baseline ??= metadata;
    const expected =
      metadata.totalElements === 0
        ? 0
        : Math.min(
            metadata.size,
            metadata.totalElements - (page - 1) * metadata.size,
          );
    if (expected < 0 || result.data.length !== expected) throw failed();
    for (const value of result.data) {
      const selected = instance(value);
      if (seen.has(selected.instanceId)) throw failed();
      seen.add(selected.instanceId);
      instances.push(selected);
      if (instances.length > 1000) throw failed();
    }
    if (metadata.totalElements === 0 || page === metadata.totalPages) break;
    if (page === 10) throw failed();
  }
  if (!baseline || instances.length !== baseline.totalElements) throw failed();
  instances.sort(
    (a, b) =>
      a.instanceId.length - b.instanceId.length ||
      (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0),
  );
  const observedAt = new Date(Date.now()).toISOString(),
    body = {
      provider: "contabo" as const,
      instances,
      observation: {
        startedAt,
        observedAt,
        consistency: "observed-scan" as const,
        enumerationComplete: true as const,
      },
      actionsEnabled: false as const,
      machineIdentityVerified: false as const,
    };
  const evidenceHash = await observation.wait(
    sha256(JSON.stringify({ version: 1, ...body })),
  );
  observation.check();
  return json({ ...body, observation: { ...body.observation, evidenceHash } });
}
export async function providerInventoryRoute(
  request: Request,
  env: ProviderEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== route) return null;
  const observation = new Observation(request.signal);
  try {
    if (!(await observation.wait(installation(request, env))))
      return error(401, "unauthorized");
    if (request.method !== "GET") {
      const response = error(405, "method_not_allowed");
      response.headers.set("allow", "GET");
      return response;
    }
    if (
      url.search !== "" ||
      request.body !== null ||
      Number(request.headers.get("content-length") ?? "0") > 0
    )
      return error(400, "invalid_request");
    return await observe(env, observation);
  } catch {
    return error(503, "provider_inventory_unavailable");
  } finally {
    observation.close();
  }
}
