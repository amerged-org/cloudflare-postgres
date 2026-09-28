// SPDX-License-Identifier: Apache-2.0
import { validRoleClaim } from "./role-reconcile.ts";
import type { RoleClaim, RoleObservation } from "./role-types.ts";

export class RoleClient {
  private readonly origin: string;
  private readonly regionId: string;
  private readonly readToken: () => Promise<string>;
  constructor(
    origin: string,
    regionId: string,
    readToken: () => Promise<string>,
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
      throw new Error("role_client_configuration_invalid");
    this.origin = url.origin;
    this.regionId = regionId;
    this.readToken = readToken;
  }
  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const token = (await this.readToken()).trim();
    if (!/^cprgn_[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("role_token_invalid");
    const response = await fetch(
      `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/role-operations${path}`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("role_control_request_failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("role_control_response_missing");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new Error("role_control_response_bound");
      }
      chunks.push(value.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("role_control_response_invalid");
    return result as Record<string, unknown>;
  }
  async claim(leaseSeconds: number): Promise<RoleClaim | null> {
    const result = await this.post("/claim", { leaseSeconds });
    if (result.claim === null) return null;
    if (
      !validRoleClaim(result.claim as RoleClaim) ||
      (result.claim as RoleClaim).regionId !== this.regionId ||
      Date.parse((result.claim as RoleClaim).leaseExpiresAt) <=
        Date.now() + 5000
    )
      throw new Error("role_claim_invalid");
    return result.claim as RoleClaim;
  }
  async renew(claim: RoleClaim, leaseSeconds: number): Promise<string> {
    const response = await this.post(
      `/${encodeURIComponent(claim.operationId)}/renew`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        leaseSeconds,
      },
    );
    if (
      typeof response.leaseExpiresAt !== "string" ||
      Date.parse(response.leaseExpiresAt) <= Date.now() + 5000 ||
      !Number.isFinite(Date.parse(response.leaseExpiresAt))
    )
      throw new Error("role_lease_response_invalid");
    return response.leaseExpiresAt;
  }
  async result(
    claim: RoleClaim,
    observation: RoleObservation | null,
    failure?:
      "ownership_mismatch" | "spec_conflict" | "credential_verification_failed",
  ): Promise<void> {
    await this.post(`/${encodeURIComponent(claim.operationId)}/result`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      status: failure ? "failed" : "applied",
      resultCode: failure ?? "role_verified",
      observation,
    });
  }
}
