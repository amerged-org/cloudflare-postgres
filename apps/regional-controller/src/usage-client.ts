// SPDX-License-Identifier: Apache-2.0
import type {
  AcceptedUsageReceipt,
  UsageFact,
  UsageIdentity,
} from "./metering-types.ts";
import {
  normalizeAcceptedUsageReceipt,
  usageFactFields,
  validAcceptedUsageReceipt,
  validUsageFact,
} from "./accepted-usage.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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

  private async request(fact: UsageFact): Promise<{
    fact: UsageFact;
    accepted: Record<string, unknown>;
  }> {
    if (!validUsageFact(fact, this.identity))
      throw new Error("invalid_usage_fact");
    const submitted: UsageFact = { ...fact };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("usage_http_failure"));
      }, 20_000);
    });
    const bounded = <T>(pending: Promise<T>): Promise<T> =>
      Promise.race([pending, expired]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const credential = (await bounded(this.readToken())).trim();
      if (!/^cpmtr_[A-Za-z0-9_-]{43}$/.test(credential))
        throw new Error("invalid_usage_credential");
      const response = await bounded(
        this.transport(
          `${this.origin}/v1/regions/${encodeURIComponent(this.identity.regionId)}/usage-facts`,
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify(submitted),
          },
        ),
      );
      if (response.status !== 200 && response.status !== 201) {
        await bounded(response.body?.cancel() ?? Promise.resolve());
        throw new UsageDeliveryError(response.status);
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await bounded(response.body?.cancel() ?? Promise.resolve());
        throw new Error("invalid_usage_response");
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("invalid_usage_response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await bounded(reader.read());
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 65_536) {
          await bounded(reader.cancel());
          throw new Error("usage_response_too_large");
        }
        chunks.push(chunk.value);
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
        usageFactFields.some(
          (field) =>
            !Object.hasOwn(accepted, field) ||
            (accepted as Record<string, unknown>)[field] !== submitted[field],
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
      return { fact: submitted, accepted: accepted as Record<string, unknown> };
    } catch (failure) {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      throw failure;
    } finally {
      clearTimeout(timer!);
      reader?.releaseLock();
    }
  }

  async send(fact: UsageFact): Promise<boolean> {
    await this.request(fact);
    return true;
  }

  async sendReceipt(fact: UsageFact): Promise<AcceptedUsageReceipt> {
    const result = await this.request(fact);
    const receipt = {
      fact: result.fact,
      regionId: result.accepted.regionId,
      organizationId: result.accepted.organizationId,
      projectId: result.accepted.projectId,
      acceptanceSequence: result.accepted.acceptanceSequence,
      acceptedAt: result.accepted.acceptedAt,
    };
    if (!validAcceptedUsageReceipt(receipt, this.identity))
      throw new Error("usage_acknowledgement_conflict");
    return normalizeAcceptedUsageReceipt(receipt, this.identity);
  }
}
