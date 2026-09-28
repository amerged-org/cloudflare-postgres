// SPDX-License-Identifier: Apache-2.0
import type { UsageFact, UsageIdentity } from "./metering-types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const quantity = /^(?:0|[1-9][0-9]{0,77})$/;
const fields = [
  "factId",
  "environmentId",
  "sourceId",
  "sourceEpoch",
  "revision",
  "expectedPreviousRevision",
  "metric",
  "attribution",
  "start",
  "end",
  "quantity",
  "status",
  "evidenceHash",
] as const;

export class UsageDeliveryError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("usage_http_failure");
    this.status = status;
  }
}

export class UsageClient {
  private readonly origin: string;
  private readonly identity: UsageIdentity;
  private readonly readToken: () => Promise<string>;
  private readonly transport: typeof fetch;

  constructor(
    origin: string,
    identity: UsageIdentity,
    readToken: () => Promise<string>,
    transport: typeof fetch = fetch,
  ) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/" ||
      !uuid.test(identity.regionId) ||
      !uuid.test(identity.sourceId) ||
      !Number.isSafeInteger(identity.sourceEpoch) ||
      identity.sourceEpoch < 1
    )
      throw new Error("invalid_usage_configuration");
    this.origin = parsed.origin;
    this.identity = { ...identity };
    this.readToken = readToken;
    this.transport = transport;
  }

  async send(fact: UsageFact): Promise<boolean> {
    const start = Date.parse(fact.start),
      end = Date.parse(fact.end);
    if (
      !uuid.test(fact.factId) ||
      !uuid.test(fact.environmentId) ||
      fact.sourceId !== this.identity.sourceId ||
      fact.sourceEpoch !== this.identity.sourceEpoch ||
      fact.revision !== 1 ||
      fact.expectedPreviousRevision !== 0 ||
      !["cpu_millicore_ms", "memory_byte_ms", "data_storage_byte_ms"].includes(
        fact.metric,
      ) ||
      !["primary", "replica", "backup", "wal", "platform"].includes(
        fact.attribution,
      ) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end <= start ||
      end - start > 60_000 ||
      Math.floor(start / 60_000) !== Math.floor((end - 1) / 60_000) ||
      new Date(start).toISOString() !== fact.start ||
      new Date(end).toISOString() !== fact.end ||
      !/^[a-f0-9]{64}$/.test(fact.evidenceHash) ||
      !(
        (fact.status === "gap" && fact.quantity === null) ||
        (fact.status === "provisional" &&
          typeof fact.quantity === "string" &&
          quantity.test(fact.quantity))
      )
    )
      throw new Error("invalid_usage_fact");
    const credential = (await this.readToken()).trim();
    if (!/^cpmtr_[A-Za-z0-9_-]{43}$/.test(credential))
      throw new Error("invalid_usage_credential");
    const response = await this.transport(
      `${this.origin}/v1/regions/${encodeURIComponent(this.identity.regionId)}/usage-facts`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(fact),
      },
    );
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel();
      throw new UsageDeliveryError(response.status);
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      throw new Error("invalid_usage_response");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("invalid_usage_response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 65_536) {
          await reader.cancel();
          throw new Error("usage_response_too_large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const accepted =
      payload && typeof payload === "object" && "fact" in payload
        ? payload.fact
        : null;
    if (
      !accepted ||
      typeof accepted !== "object" ||
      Array.isArray(accepted) ||
      fields.some(
        (field) =>
          !(field in accepted) ||
          (accepted as Record<string, unknown>)[field] !== fact[field],
      ) ||
      (accepted as Record<string, unknown>).regionId !==
        this.identity.regionId ||
      typeof (accepted as Record<string, unknown>).acceptanceSequence !==
        "string" ||
      !/^[1-9][0-9]{0,18}$/.test(
        (accepted as Record<string, unknown>).acceptanceSequence as string,
      )
    )
      throw new Error("usage_acknowledgement_conflict");
    return true;
  }
}
