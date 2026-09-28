// SPDX-License-Identifier: Apache-2.0
import type { Claim, Observation, ResultCode } from "./types.ts";

export class ControlError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("control_request_failed");
    this.status = status;
  }
}

export class ControlClient {
  private readonly origin: string;
  private readonly regionId: string;
  private readonly token: string;
  constructor(origin: string, regionId: string, token: string) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/" ||
      !token.trim()
    ) {
      throw new Error("invalid_control_configuration");
    }
    this.origin = parsed.origin;
    this.regionId = regionId;
    this.token = token;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(
      `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/operations${path}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ControlError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing_control_response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new Error("control_response_too_large");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  }

  async claim(leaseSeconds: number): Promise<Claim | null> {
    const response = await this.post<{ claim: Claim | null }>("/claim", {
      leaseSeconds,
    });
    const claim = response.claim;
    if (
      claim !== null &&
      (!claim ||
        claim.regionId !== this.regionId ||
        !claim.leaseToken ||
        !Number.isSafeInteger(claim.leaseEpoch) ||
        claim.leaseEpoch < 1 ||
        !Number.isFinite(Date.parse(claim.leaseExpiresAt)))
    ) {
      throw new Error("invalid_claim");
    }
    return claim;
  }

  renew(
    claim: Claim,
    leaseSeconds: number,
  ): Promise<{ leaseExpiresAt: string }> {
    return this.post(`/${encodeURIComponent(claim.operationId)}/renew`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      leaseSeconds,
    });
  }

  result(
    claim: Claim,
    observation: Observation | null,
    failure?: ResultCode,
  ): Promise<unknown> {
    return this.post(`/${encodeURIComponent(claim.operationId)}/result`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      status: failure ? "failed" : "ready",
      resultCode: failure ?? "cnpg_ready",
      observation,
    });
  }
}
