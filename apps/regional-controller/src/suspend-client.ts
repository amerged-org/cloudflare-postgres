// SPDX-License-Identifier: Apache-2.0
import { validSuspendClaim } from "./suspend-types.ts";
import type { SuspendClaim, SuspendObservation } from "./suspend-types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const observationKeys = [
  "namespaceUid",
  "clusterUid",
  "quotaUid",
  "volumesHash",
  "pooler",
  "computeAbsent",
  "quotaPodsZero",
  "clusterHibernated",
  "poolerStopped",
] as const;

function fields(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validObservation(
  value: unknown,
  claim: SuspendClaim,
): value is SuspendObservation {
  if (
    !fields(
      value,
      claim.runEpoch === undefined
        ? observationKeys
        : [...observationKeys, "runEpoch"],
    )
  )
    return false;
  return (
    value.runEpoch === claim.runEpoch &&
    ["namespaceUid", "clusterUid", "quotaUid"].every(
      (key) => typeof value[key] === "string" && uuid.test(value[key]),
    ) &&
    value.clusterUid === claim.clusterUid &&
    typeof value.volumesHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.volumesHash) &&
    value.computeAbsent === true &&
    value.quotaPodsZero === true &&
    value.clusterHibernated === true &&
    value.poolerStopped === true &&
    (claim.pooler === null
      ? value.pooler === null
      : fields(value.pooler, ["uid", "deploymentUid"]) &&
        value.pooler.uid === claim.pooler.uid &&
        value.pooler.deploymentUid === claim.pooler.deploymentUid)
  );
}

function leaseSecondsValid(value: number): void {
  if (!Number.isSafeInteger(value) || value < 30 || value > 300)
    throw new Error("suspend_lease_duration_invalid");
}

export class SuspendClient {
  private readonly origin: string;
  private readonly regionId: string;
  private readonly readToken: () => Promise<string>;
  private readonly signal: AbortSignal | undefined;

  constructor(
    origin: string,
    regionId: string,
    readToken: () => Promise<string>,
    signal?: AbortSignal,
  ) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("suspend_client_configuration_invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      origin.includes("?") ||
      origin.includes("#") ||
      url.pathname !== "/" ||
      !uuid.test(regionId) ||
      typeof readToken !== "function"
    )
      throw new Error("suspend_client_configuration_invalid");
    this.origin = url.origin;
    this.regionId = regionId;
    this.readToken = readToken;
    this.signal = signal;
  }

  private assertClaim(claim: SuspendClaim): void {
    if (
      !validSuspendClaim(claim) ||
      claim.regionId !== this.regionId ||
      Date.parse(claim.leaseExpiresAt) <= Date.now() + 5_000
    )
      throw new Error("suspend_claim_invalid");
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const signal = this.signal
      ? AbortSignal.any([this.signal, controller.signal])
      : controller.signal;
    const expired = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("suspend_control_request_failed")),
        { once: true },
      );
      if (signal.aborted) reject(new Error("suspend_control_request_failed"));
    });
    const bounded = <T>(pending: Promise<T>): Promise<T> =>
      Promise.race([pending, expired]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const token = (
        await bounded(
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return this.readToken();
          }),
        )
      ).trim();
      signal.throwIfAborted();
      if (!/^cprgn_[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error("suspend_token_invalid");
      const response = await bounded(
        fetch(
          `${this.origin}/v1/regions/${encodeURIComponent(this.regionId)}/suspend-operations${path}`,
          {
            method: "POST",
            redirect: "error",
            cache: "no-store",
            signal,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
        ),
      );
      if (!response.ok) {
        await bounded(response.body?.cancel() ?? Promise.resolve());
        throw new Error("suspend_control_request_failed");
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("suspend_control_response_missing");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await bounded(reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) throw new Error("suspend_control_response_bound");
        chunks.push(chunk.value);
      }
      const payload: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      signal.throwIfAborted();
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("suspend_control_response_invalid");
      return payload as Record<string, unknown>;
    } catch {
      try {
        void reader?.cancel().catch(() => {});
      } catch {
        /* Preserve the original request failure if cancellation also fails. */
      }
      throw new Error("suspend_control_request_failed");
    } finally {
      clearTimeout(timer);
      try {
        reader?.releaseLock();
      } catch {
        /* The request result is already known; cleanup adds no authority. */
      }
    }
  }

  async claim(leaseSeconds: number): Promise<SuspendClaim | null> {
    leaseSecondsValid(leaseSeconds);
    const response = await this.post("/claim", { leaseSeconds });
    if (response.claim === null) return null;
    if (!validSuspendClaim(response.claim))
      throw new Error("suspend_claim_invalid");
    this.assertClaim(response.claim);
    return response.claim;
  }

  async renew(claim: SuspendClaim, leaseSeconds: number): Promise<string> {
    leaseSecondsValid(leaseSeconds);
    this.assertClaim(claim);
    const response = await this.post(
      `/${encodeURIComponent(claim.operationId)}/renew`,
      {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        leaseSeconds,
      },
    );
    const expiresAt =
      typeof response.leaseExpiresAt === "string"
        ? Date.parse(response.leaseExpiresAt)
        : Number.NaN;
    const now = Date.now();
    if (
      typeof response.leaseExpiresAt !== "string" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now + 5_000 ||
      expiresAt > now + leaseSeconds * 1_000
    )
      throw new Error("suspend_lease_response_invalid");
    return response.leaseExpiresAt;
  }

  async result(
    claim: SuspendClaim,
    observation: SuspendObservation,
  ): Promise<void> {
    this.assertClaim(claim);
    if (!validObservation(observation, claim))
      throw new Error("suspend_observation_invalid");
    await this.post(`/${encodeURIComponent(claim.operationId)}/result`, {
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      status: "suspended",
      resultCode: "compute_suspended",
      observation,
    });
  }
}
