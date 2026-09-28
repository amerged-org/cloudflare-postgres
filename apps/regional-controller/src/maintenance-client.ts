// SPDX-License-Identifier: Apache-2.0
import { validMaintenanceClaim } from "./maintenance.ts";
import type {
  MaintenanceAssessment,
  MaintenanceClaim,
} from "./maintenance-types.ts";

export class MaintenanceClient {
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
      throw new Error("maintenance_client_configuration_invalid");
    this.origin = url.origin;
  }
  private async post(path: string, body: unknown): Promise<unknown> {
    const token = (await this.readToken()).trim();
    if (!/^cpmtp_[A-Za-z0-9_-]{32,128}$/.test(token))
      throw new Error("maintenance_preparer_token_invalid");
    const response = await fetch(
      `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/maintenance/preparations${path}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("maintenance_control_request_failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("maintenance_control_response_missing");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const entry = await reader.read();
      if (entry.done) break;
      length += entry.value.byteLength;
      if (length > 131_072) {
        await reader.cancel();
        throw new Error("maintenance_control_response_bound");
      }
      chunks.push(entry.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  async claim(leaseSeconds = 90): Promise<MaintenanceClaim | null> {
    const response = await this.post("/claim", { leaseSeconds });
    if (!response || typeof response !== "object" || !("claim" in response))
      throw new Error("maintenance_claim_invalid");
    const claim = response.claim;
    if (claim === null) return null;
    if (
      !validMaintenanceClaim(claim) ||
      claim.regionId !== this.regionId ||
      Date.parse(claim.leaseExpiresAt) <= Date.now() + 5_000
    )
      throw new Error("maintenance_claim_invalid");
    return claim;
  }
  async renew(claim: MaintenanceClaim, leaseSeconds = 90): Promise<string> {
    const value = await this.post(
      `/${encodeURIComponent(claim.operationId)}/lease`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        leaseSeconds,
      },
    );
    const expiresAt =
      value && typeof value === "object" && "leaseExpiresAt" in value
        ? value.leaseExpiresAt
        : null;
    if (
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now() + 5_000
    )
      throw new Error("maintenance_lease_response_invalid");
    return expiresAt;
  }
  async result(
    claim: MaintenanceClaim,
    assessment: MaintenanceAssessment,
  ): Promise<void> {
    const response = await this.post(
      `/${encodeURIComponent(claim.operationId)}/result`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        planHash: claim.planHash,
        assessment,
      },
    );
    const preparation =
      response && typeof response === "object" && "preparation" in response
        ? response.preparation
        : null;
    if (
      !preparation ||
      typeof preparation !== "object" ||
      Array.isArray(preparation)
    )
      throw new Error("maintenance_result_receipt_invalid");
    const value = preparation as Record<string, unknown>;
    const accepted = value.assessment;
    if (
      value.id !== claim.operationId ||
      value.regionId !== this.regionId ||
      value.planHash !== claim.planHash ||
      value.status !== "assessed" ||
      value.executionSupported !== false ||
      value.executionAuthorized !== false ||
      value.eligibility !==
        (assessment.blockers.length === 0 &&
        assessment.dryRun.status === "succeeded"
          ? "eligible"
          : "blocked") ||
      !accepted ||
      typeof accepted !== "object" ||
      Array.isArray(accepted) ||
      !Object.entries(assessment).every(
        ([key, expected]) =>
          JSON.stringify((accepted as Record<string, unknown>)[key]) ===
          JSON.stringify(expected),
      )
    )
      throw new Error("maintenance_result_receipt_invalid");
  }
}
