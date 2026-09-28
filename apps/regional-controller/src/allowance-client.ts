// SPDX-License-Identifier: Apache-2.0
import type {
  AllowanceReceipt,
  AllowanceRequest,
  AllowanceTransport,
  RuntimeAuthority,
} from "./allowance-types.ts";

export class AllowanceProtocolError extends Error {
  constructor() {
    super("allowance_control_protocol_failed");
    this.name = "AllowanceProtocolError";
  }
}
export class AllowanceClient implements AllowanceTransport {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly regionId: string,
    private readonly readToken: () => Promise<string>,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(regionId)
    )
      throw new Error("allowance_client_configuration_invalid");
    this.origin = url.origin;
  }
  private async request(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const token = (await this.readToken()).trim();
    if (!/^cprgn_[A-Za-z0-9_-]{43}$/.test(token))
      throw new AllowanceProtocolError();
    const response = await fetch(
      `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/allowance-reservations${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status < 500) throw new AllowanceProtocolError();
      throw new Error("allowance_control_unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AllowanceProtocolError();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new AllowanceProtocolError();
      }
      chunks.push(next.value);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new AllowanceProtocolError();
      return value as Record<string, unknown>;
    } catch {
      throw new AllowanceProtocolError();
    }
  }
  async reserve(request: AllowanceRequest): Promise<AllowanceReceipt> {
    const response = await this.request("", request);
    if (
      !response.reservation ||
      typeof response.reservation !== "object" ||
      Array.isArray(response.reservation)
    )
      throw new AllowanceProtocolError();
    return response.reservation as AllowanceReceipt;
  }
  async authority(receiptId: string): Promise<RuntimeAuthority> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(receiptId))
      throw new AllowanceProtocolError();
    const response = await this.request(
      `/${encodeURIComponent(receiptId)}/authority`,
    );
    if (
      !response.authority ||
      typeof response.authority !== "object" ||
      Array.isArray(response.authority)
    )
      throw new AllowanceProtocolError();
    return response.authority as RuntimeAuthority;
  }
}
