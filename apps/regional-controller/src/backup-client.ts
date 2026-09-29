// SPDX-License-Identifier: Apache-2.0
import {
  backupCanonical,
  backupFields,
  validBackupClaim,
  validBackupDispatch,
} from "./backup-types.ts";
import type {
  BackupBinding,
  BackupClaim,
  BackupControl,
  BackupDispatch,
  BackupObservation,
} from "./backup-types.ts";

export class BackupClient implements BackupControl {
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
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(regionId)
    )
      throw new Error("backup_client_configuration_invalid");
    this.origin = url.origin;
    this.regionId = regionId;
    this.readToken = readToken;
  }
  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const token = (await this.readToken()).trim();
      if (controller.signal.aborted || !/^cprgn_[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error("backup_control_request_failed");
      const response = await fetch(
        `${this.origin}/v1/regions/${this.regionId}/backup-operations${path}`,
        {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("backup_control_request_failed");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("backup_control_request_failed");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65_536) {
            await reader.cancel();
            throw new Error("backup_control_request_failed");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (controller.signal.aborted)
        throw new Error("backup_control_request_failed");
      const result: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("backup_control_request_failed");
      return result as Record<string, unknown>;
    } catch {
      throw new Error("backup_control_request_failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async claim(leaseSeconds: number): Promise<BackupClaim | null> {
    if (
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 30 ||
      leaseSeconds > 300
    )
      throw new Error("backup_lease_duration_invalid");
    const result = await this.post("/claim", { leaseSeconds });
    if (!backupFields(result, ["claim"]))
      throw new Error("backup_claim_invalid");
    if (result.claim === null) return null;
    if (
      !validBackupClaim(result.claim) ||
      result.claim.regionId !== this.regionId ||
      Date.parse(result.claim.leaseExpiresAt) <= Date.now() + 5000
    )
      throw new Error("backup_claim_invalid");
    return result.claim;
  }
  async renew(claim: BackupClaim, leaseSeconds: number): Promise<string> {
    if (
      !validBackupClaim(claim) ||
      claim.regionId !== this.regionId ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 30 ||
      leaseSeconds > 300
    )
      throw new Error("backup_claim_invalid");
    const result = await this.post(`/${claim.operationId}/renew`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      leaseSeconds,
    });
    if (
      !backupFields(result, ["leaseExpiresAt"]) ||
      typeof result.leaseExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(result.leaseExpiresAt)) ||
      Date.parse(result.leaseExpiresAt) <= Date.now() + 5000
    )
      throw new Error("backup_lease_response_invalid");
    return result.leaseExpiresAt;
  }
  async dispatch(
    claim: BackupClaim,
    nonce: string,
    binding: BackupBinding,
  ): Promise<{ dispatch: BackupDispatch; created: boolean }> {
    if (!validBackupClaim(claim) || claim.regionId !== this.regionId)
      throw new Error("backup_claim_invalid");
    const result = await this.post(`/${claim.operationId}/dispatch`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      nonce,
      binding,
    });
    if (
      !backupFields(result, ["dispatch", "created"]) ||
      !validBackupDispatch(result.dispatch) ||
      typeof result.created !== "boolean" ||
      result.dispatch.nonce !== nonce ||
      result.dispatch.leaseEpoch !== claim.leaseEpoch ||
      backupCanonical(result.dispatch.binding) !== backupCanonical(binding)
    )
      throw new Error("backup_dispatch_invalid");
    return { dispatch: result.dispatch, created: result.created };
  }
  async result(
    claim: BackupClaim,
    observation: BackupObservation,
  ): Promise<void> {
    if (
      !validBackupClaim(claim) ||
      claim.regionId !== this.regionId ||
      observation.clusterUid !== claim.clusterUid ||
      !claim.dispatch ||
      observation.backupSpecHash !== claim.dispatch.binding.backupSpecHash
    )
      throw new Error("backup_observation_invalid");
    await this.post(`/${claim.operationId}/result`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      status: observation.phase,
      resultCode:
        observation.phase === "completed"
          ? "base_backup_completed"
          : "backup_failed",
      observation,
    });
  }
}
