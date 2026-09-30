// SPDX-License-Identifier: Apache-2.0
import type { UsageIdentity } from "./metering-types.ts";
import type {
  ArchiveDescriptor,
  ArchiveReceipt,
  ArchiveTransport,
  ArchiveRecoveryTransport,
} from "./usage-archive-types.ts";

const maximumChunk = 1024 * 1024;
const maximumJson = 128 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const failed = () => new Error("usage_archive_transport_failed");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

class ArchiveHttp {
  readonly identity: UsageIdentity;
  readonly base: string;
  readonly readToken: () => Promise<string>;
  readonly kind: "meter" | "recovery";
  readonly transport: typeof fetch;
  constructor(
    origin: string,
    identity: UsageIdentity,
    readToken: () => Promise<string>,
    kind: "meter" | "recovery",
    transport: typeof fetch,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !uuid.test(identity.regionId) ||
      !uuid.test(identity.sourceId) ||
      !Number.isSafeInteger(identity.sourceEpoch) ||
      identity.sourceEpoch < 1
    )
      throw failed();
    this.identity = {
      regionId: identity.regionId,
      sourceId: identity.sourceId,
      sourceEpoch: identity.sourceEpoch,
    };
    this.base = `${url.origin}/v1/regions/${identity.regionId}/usage-archives`;
    this.readToken = readToken;
    this.kind = kind;
    this.transport = transport;
  }
  artifact(id: string): string {
    if (!hash.test(id)) throw failed();
    return `${this.base}/${this.identity.sourceId}/${this.identity.sourceEpoch}/${id}`;
  }
  async request(
    url: string,
    method: "GET" | "POST" | "PUT",
    body: string | Uint8Array | undefined,
    binary: boolean,
    milliseconds: number,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let rejectTimeout: (failure: Error) => void;
    const expired = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const cancel = () => {
      controller.abort();
      rejectTimeout(failed());
    };
    const timer = setTimeout(cancel, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    const bounded = <T>(value: Promise<T>) => Promise.race([value, expired]);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    try {
      if (combined.aborted) throw failed();
      const credential = (await bounded(this.readToken())).trim();
      if (
        this.kind === "meter"
          ? !/^cpmtr_[A-Za-z0-9_-]{43}$/.test(credential)
          : !credential || credential.length > 8192 || /\s/.test(credential)
      )
        throw failed();
      const response = await bounded(
        this.transport(url, {
          method,
          redirect: "error",
          signal: combined,
          headers: {
            authorization: `Bearer ${credential}`,
            ...(body !== undefined
              ? {
                  "content-type": binary
                    ? "application/octet-stream"
                    : "application/json",
                }
              : {}),
          },
          ...(body !== undefined
            ? {
                body: typeof body === "string" ? body : new Uint8Array(body),
              }
            : {}),
        }),
      );
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw failed();
      }
      return { response, bounded, finish };
    } catch {
      finish();
      throw failed();
    }
  }
  async json(
    url: string,
    method: "POST" | "PUT",
    body: string | Uint8Array,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const pending = await this.request(
      url,
      method,
      body,
      typeof body !== "string",
      milliseconds,
      signal,
    );
    const reader = pending.response.body!.getReader();
    let bytes = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          pending.response.headers.get("content-type") ?? "",
        )
      )
        throw failed();
      while (true) {
        const part = await pending.bounded(reader.read());
        if (part.done) return JSON.parse(text + decoder.decode()) as unknown;
        bytes += part.value.length;
        if (bytes > maximumJson) throw failed();
        text += decoder.decode(part.value, { stream: true });
      }
    } catch {
      throw failed();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      pending.finish();
    }
  }
}

export class UsageArchiveClient implements ArchiveTransport {
  private readonly http: ArchiveHttp;
  constructor(
    origin: string,
    identity: UsageIdentity,
    readToken: () => Promise<string>,
    transport: typeof fetch = fetch,
  ) {
    this.http = new ArchiveHttp(
      origin,
      identity,
      readToken,
      "meter",
      transport,
    );
  }
  async prepare(descriptor: ArchiveDescriptor, signal?: AbortSignal) {
    const body = JSON.stringify(descriptor);
    if (Buffer.byteLength(body) > maximumJson) throw failed();
    const value = await this.http.json(
      `${this.http.base}/prepare`,
      "POST",
      body,
      20_000,
      signal,
    );
    if (
      !object(value) ||
      typeof value.descriptorId !== "string" ||
      !hash.test(value.descriptorId) ||
      typeof value.descriptorSha256 !== "string" ||
      !hash.test(value.descriptorSha256) ||
      !object(value.descriptor)
    )
      throw failed();
    return value as unknown as Awaited<ReturnType<ArchiveTransport["prepare"]>>;
  }
  async putChunk(
    id: string,
    ordinal: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > 255 ||
      bytes.length < 1 ||
      bytes.length > maximumChunk
    )
      throw failed();
    const value = await this.http.json(
      `${this.http.artifact(id)}/chunks/${ordinal}`,
      "PUT",
      bytes,
      20_000,
      signal,
    );
    if (
      !object(value) ||
      value.descriptorId !== id ||
      value.ordinal !== ordinal ||
      value.bytes !== bytes.length ||
      typeof value.sha256 !== "string" ||
      !hash.test(value.sha256)
    )
      throw failed();
    return value as unknown as Awaited<
      ReturnType<ArchiveTransport["putChunk"]>
    >;
  }
  async finalize(id: string, signal?: AbortSignal) {
    const value = await this.http.json(
      `${this.http.artifact(id)}/finalize`,
      "POST",
      "{}",
      240_000,
      signal,
    );
    if (
      !object(value) ||
      !object(value.receipt) ||
      value.receipt.descriptorId !== id ||
      typeof value.receiptSha256 !== "string" ||
      !hash.test(value.receiptSha256)
    )
      throw failed();
    return value as unknown as {
      receipt: ArchiveReceipt;
      receiptSha256: string;
    };
  }
}

export class UsageArchiveRecoveryClient implements ArchiveRecoveryTransport {
  private readonly http: ArchiveHttp;
  constructor(
    origin: string,
    identity: UsageIdentity,
    readToken: () => Promise<string>,
    transport: typeof fetch = fetch,
  ) {
    this.http = new ArchiveHttp(
      origin,
      identity,
      readToken,
      "recovery",
      transport,
    );
  }
  async recovery(id: string, expected: string, signal?: AbortSignal) {
    if (!hash.test(expected)) throw failed();
    const value = await this.http.json(
      `${this.http.artifact(id)}/recovery`,
      "POST",
      JSON.stringify({ expectedReceiptSha256: expected }),
      20_000,
      signal,
    );
    if (
      !object(value) ||
      !object(value.descriptor) ||
      !object(value.receipt) ||
      value.receipt.descriptorId !== id ||
      value.receiptSha256 !== expected
    )
      throw failed();
    return value as unknown as Awaited<
      ReturnType<ArchiveRecoveryTransport["recovery"]>
    >;
  }
  async chunk(
    id: string,
    ordinal: number,
    expected: string,
    signal?: AbortSignal,
  ) {
    if (
      !hash.test(expected) ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > 255
    )
      throw failed();
    const pending = await this.http.request(
      `${this.http.artifact(id)}/chunks/${ordinal}?receiptSha256=${expected}`,
      "GET",
      undefined,
      true,
      20_000,
      signal,
    );
    const reader = pending.response.body!.getReader();
    let bytes = 0,
      done = false;
    const close = () => {
      if (done) return;
      done = true;
      pending.finish();
      reader.releaseLock();
    };
    if (
      pending.response.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/octet-stream"
    ) {
      void reader.cancel().catch(() => {});
      close();
      throw failed();
    }
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await pending.bounded(reader.read());
          if (part.done) {
            close();
            controller.close();
            return;
          }
          bytes += part.value.length;
          if (bytes > maximumChunk) throw failed();
          controller.enqueue(part.value);
        } catch {
          void reader.cancel().catch(() => {});
          close();
          controller.error(failed());
        }
      },
      cancel() {
        void reader.cancel().catch(() => {});
        close();
      },
    });
  }
}
