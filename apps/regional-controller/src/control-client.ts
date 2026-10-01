// SPDX-License-Identifier: Apache-2.0
import type { Claim, Observation, ResultCode } from "./types.ts";
import { AllowanceClient } from "./allowance-client.ts";
import type { RuntimeAuthority } from "./allowance-types.ts";
import type { ProvisioningFunding } from "./provisioning-funding.ts";
import type {
  ExecutionPermitChallenge,
  ExecutionPermitResponse,
} from "./execution-permit-types.ts";

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

  private async post<T>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMilliseconds?: number } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMilliseconds ?? 20_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    signal.throwIfAborted();
    const response = await fetch(
      `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/operations${path}`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (signal.aborted) {
      await response.body?.cancel();
      signal.throwIfAborted();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ControlError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing_control_response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        signal.throwIfAborted();
      }
      const chunk = await reader.read();
      if (signal.aborted) {
        await reader.cancel();
        signal.throwIfAborted();
      }
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

  async funding(
    claim: Claim,
    fundingSeconds: number,
  ): Promise<ProvisioningFunding> {
    const response = await this.post<{ funding: ProvisioningFunding }>(
      `/${encodeURIComponent(claim.operationId)}/funding`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        fundingSeconds,
      },
    );
    if (
      !response.funding ||
      typeof response.funding !== "object" ||
      Array.isArray(response.funding)
    )
      throw new Error("invalid_provisioning_funding_response");
    return response.funding;
  }

  async executionPermit(
    claim: Claim,
    reservationId: string,
    challenge: ExecutionPermitChallenge,
    signal?: AbortSignal,
  ): Promise<ExecutionPermitResponse> {
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    const hash = /^[a-f0-9]{64}$/;
    const exact = (
      value: unknown,
      keys: string[],
    ): value is Record<string, unknown> =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key));
    const binary = (
      value: unknown,
      maximum: number,
      length?: number,
    ): value is string => {
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value) ||
        value.length > maximum * 2
      )
        return false;
      const decoded = Buffer.from(value, "base64url");
      return (
        decoded.length <= maximum &&
        (length === undefined || decoded.length === length) &&
        decoded.toString("base64url") === value
      );
    };
    if (
      claim.kind !== "environment.create" ||
      claim.regionId !== this.regionId ||
      !uuid.test(claim.operationId) ||
      !uuid.test(reservationId) ||
      claim.specRevision !== 1 ||
      claim.runEpoch !== "1" ||
      !claim.leaseToken ||
      !Number.isSafeInteger(claim.leaseEpoch) ||
      claim.leaseEpoch < 1 ||
      !exact(challenge, ["version", "nonce", "binding"]) ||
      challenge.version !== 2 ||
      !binary(challenge.nonce, 32, 32) ||
      !exact(challenge.binding, [
        "installationId",
        "namespaceUid",
        "podUid",
        "containerName",
        "nodeName",
        "nodeUid",
        "bootId",
        "imageHash",
        "commandHash",
      ])
    )
      throw new Error("invalid_execution_permit_request");
    const binding = challenge.binding;
    if (
      binding.containerName !== "postgres" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.installationId) ||
      ![
        binding.namespaceUid,
        binding.podUid,
        binding.nodeUid,
        binding.bootId,
      ].every((id) => typeof id === "string" && uuid.test(id)) ||
      typeof binding.nodeName !== "string" ||
      binding.nodeName.length > 253 ||
      !binding.nodeName
        .split(".")
        .every((label) =>
          /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(label),
        ) ||
      !hash.test(binding.imageHash) ||
      !hash.test(binding.commandHash) ||
      claim.spec.profile.postgresImage.split("@sha256:")[1] !==
        binding.imageHash
    )
      throw new Error("invalid_execution_permit_request");
    const response = await this.post<ExecutionPermitResponse>(
      `/${encodeURIComponent(claim.operationId)}/execution-permits`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        reservationId,
        challenge,
      },
      { signal, timeoutMilliseconds: 10_000 },
    );
    if (
      !exact(response, ["permit", "runtimeEnforced", "enforcementStatus"]) ||
      response.runtimeEnforced !== false ||
      response.enforcementStatus !== "pending_runtime" ||
      !exact(response.permit, ["version", "keyId", "payload", "signature"])
    )
      throw new Error("invalid_execution_permit_response");
    const permit = response.permit;
    if (
      permit.version !== 2 ||
      typeof permit.keyId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(permit.keyId) ||
      !binary(permit.payload, 16_384) ||
      !binary(permit.signature, 64, 64) ||
      Buffer.byteLength(JSON.stringify(permit)) > 16_384
    )
      throw new Error("invalid_execution_permit_response");
    // Transport validation is not cryptographic authorization. The protected
    // Linux guard verifies the key pin, signature, nonce, binding and deadline.
    return response;
  }

  authority(reservationId: string): Promise<RuntimeAuthority> {
    return new AllowanceClient(
      this.origin,
      this.regionId,
      async () => this.token,
    ).authority(reservationId);
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
