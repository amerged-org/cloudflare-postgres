// SPDX-License-Identifier: Apache-2.0
import type { Cloudflare } from "./clients.ts";
import { HarnessError, assertOwned, record, string } from "./core.ts";

function requestMatches(value: unknown, marker: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = (value as Record<string, unknown>).event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const request = (event as Record<string, unknown>).request;
  if (!request || typeof request !== "object" || Array.isArray(request))
    return false;
  const row = request as Record<string, unknown>;
  if (typeof row.url === "string") {
    try {
      const url = new URL(row.url);
      if (
        [...url.searchParams.values()].includes(marker) ||
        url.pathname
          .split("/")
          .some((part) => decodeURIComponent(part) === marker)
      )
        return true;
    } catch {
      // Other events and malformed request URLs cannot establish correlation.
    }
  }
  if (row.headers && typeof row.headers === "object") {
    const values = Array.isArray(row.headers)
      ? row.headers.map((pair: unknown) =>
          Array.isArray(pair) && pair.length === 2 ? pair[1] : undefined,
        )
      : Object.values(row.headers);
    return values.some(
      (value) =>
        value === marker || (Array.isArray(value) && value.includes(marker)),
    );
  }
  return false;
}

function correlated(data: string, marker: string): boolean {
  try {
    const value: unknown = JSON.parse(data);
    return Array.isArray(value)
      ? value.some((event: unknown) => requestMatches(event, marker))
      : requestMatches(value, marker);
  } catch {
    return false;
  }
}

/** Trace bodies live only in memory until the deployed probe checks the canary. */
export async function captureTrace(
  cf: Cloudflare,
  worker: string,
  marker: string,
  trigger: () => Promise<unknown>,
  owned: (tail: { id: string; expires_at: string }) => Promise<void>,
): Promise<string[]> {
  assertOwned(worker);
  if (!/(?:-dev|-test)$/.test(worker))
    throw new HarnessError("dev_worker_required");
  if (typeof marker !== "string" || marker.length < 16 || marker.length > 128)
    throw new HarnessError("invalid_trace_marker");
  let socket: WebSocket | undefined;
  let accepting = true;
  const tail = record(
    (await cf.request(`/workers/scripts/${worker}/tails`, "POST", {})).result,
  );
  const id = string(tail.id);
  try {
    const expiresAt = tail.expires_at;
    const normalizedExpiresAt =
      typeof expiresAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt)
        ? expiresAt.slice(0, -1) + ".000Z"
        : expiresAt;
    const expiry =
      typeof normalizedExpiresAt === "string"
        ? Date.parse(normalizedExpiresAt)
        : NaN;
    if (
      typeof normalizedExpiresAt !== "string" ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      new Date(expiry).toISOString() !== normalizedExpiresAt
    )
      throw new HarnessError("invalid_tail_expiry");
    await owned({ id, expires_at: normalizedExpiresAt });
    let url: URL;
    try {
      url = new URL(string(tail.url));
    } catch {
      throw new HarnessError("invalid_tail_url");
    }
    if (url.protocol !== "wss:" || url.username || url.password || url.hash)
      throw new HarnessError("invalid_tail_url");
    try {
      socket = new WebSocket(url.href, "trace-v1");
    } catch {
      throw new HarnessError("trace_failed");
    }
    const messages: string[] = [];
    let size = 0;
    let received: (() => void) | undefined, failed: (() => void) | undefined;
    const event = new Promise<void>((resolve, reject) => {
      received = resolve;
      failed = () => reject(new HarnessError("trace_failed"));
    });
    void event.catch(() => undefined);
    const pending: Promise<void>[] = [];
    socket.addEventListener("message", (message: MessageEvent) => {
      if (!accepting) return;
      const operation = (async () => {
        const data =
          typeof message.data === "string"
            ? message.data
            : message.data instanceof Blob
              ? await message.data.text()
              : new TextDecoder().decode(message.data as ArrayBuffer);
        if (!accepting) return;
        size += data.length;
        if (size > 2_000_000) {
          failed?.();
          return;
        }
        messages.push(data);
        if (correlated(data, marker)) received?.();
      })().catch(() => failed?.());
      pending.push(operation);
    });
    socket.addEventListener("error", () => failed?.(), { once: true });
    socket.addEventListener("close", () => failed?.(), { once: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HarnessError("trace_open_timeout")),
        15_000,
      );
      socket!.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket!.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new HarnessError("trace_failed"));
        },
        { once: true },
      );
    });
    socket.send(JSON.stringify({ debug: false }));
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        event,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new HarnessError("trace_event_missing")),
            30_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    await Promise.all(pending);
    if (!messages.length) throw new HarnessError("trace_event_missing");
    return messages;
  } finally {
    accepting = false;
    try {
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    } finally {
      await cf.request(
        `/workers/scripts/${worker}/tails/${encodeURIComponent(id)}`,
        "DELETE",
      );
    }
  }
}
