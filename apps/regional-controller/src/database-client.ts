// SPDX-License-Identifier: Apache-2.0
import { validDatabaseClaim } from "./database-reconcile.ts";
import type { DatabaseClaim, DatabaseObservation } from "./database-types.ts";

export type DatabaseFailure =
  "ownership_mismatch" | "spec_conflict" | "database_name_conflict";
export class DatabaseClient {
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
      throw new Error("database_client_configuration_invalid");
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
      throw new Error("database_token_invalid");
    const response = await fetch(
      `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/database-operations${path}`,
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
      throw new Error("database_control_request_failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("database_control_response_missing");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new Error("database_control_response_bound");
      }
      chunks.push(value.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("database_control_response_invalid");
    return result as Record<string, unknown>;
  }
  async claim(leaseSeconds: number): Promise<DatabaseClaim | null> {
    const value = await this.post("/claim", { leaseSeconds });
    if (value.claim === null) return null;
    if (
      !validDatabaseClaim(value.claim as DatabaseClaim) ||
      (value.claim as DatabaseClaim).regionId !== this.regionId ||
      Date.parse((value.claim as DatabaseClaim).leaseExpiresAt) <=
        Date.now() + 5000
    )
      throw new Error("database_claim_invalid");
    return value.claim as DatabaseClaim;
  }
  async renew(claim: DatabaseClaim, leaseSeconds: number): Promise<string> {
    const value = await this.post(
      `/${encodeURIComponent(claim.operationId)}/renew`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        leaseSeconds,
      },
    );
    if (
      typeof value.leaseExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.leaseExpiresAt)) ||
      Date.parse(value.leaseExpiresAt) <= Date.now() + 5000
    )
      throw new Error("database_lease_response_invalid");
    return value.leaseExpiresAt;
  }
  async result(
    claim: DatabaseClaim,
    observation: DatabaseObservation | null,
    failure?: DatabaseFailure,
  ): Promise<void> {
    await this.post(`/${encodeURIComponent(claim.operationId)}/result`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      status: failure ? "failed" : "applied",
      resultCode: failure ?? "database_verified",
      observation,
    });
  }
}
