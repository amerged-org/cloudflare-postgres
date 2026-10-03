// SPDX-License-Identifier: Apache-2.0
import type { Cloudflare } from "./clients.ts";
import { HarnessError, assertOwned, record, string } from "./core.ts";
import {
  tailSocket,
  TRACE_BYTES_MAX,
  TRACE_SEND_OPTIONS,
} from "./trace-transport.ts";
import type { TailSocket, TailSocketFactory } from "./trace-transport.ts";

export interface TraceOptions {
  socketFactory?: TailSocketFactory;
  settleMs?: number;
  openTimeoutMs?: number;
  eventTimeoutMs?: number;
}

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
  options: TraceOptions = {},
): Promise<string[]> {
  assertOwned(worker);
  if (!/(?:-dev|-test)$/.test(worker))
    throw new HarnessError("dev_worker_required");
  if (typeof marker !== "string" || marker.length < 16 || marker.length > 128)
    throw new HarnessError("invalid_trace_marker");
  const settleMs = options.settleMs ?? 7_000;
  const openTimeoutMs = options.openTimeoutMs ?? 15_000;
  const eventTimeoutMs = options.eventTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(settleMs) ||
    settleMs < 0 ||
    settleMs > 7_000 ||
    !Number.isSafeInteger(openTimeoutMs) ||
    openTimeoutMs < 1 ||
    openTimeoutMs > 15_000 ||
    !Number.isSafeInteger(eventTimeoutMs) ||
    eventTimeoutMs < 1 ||
    eventTimeoutMs > 30_000
  )
    throw new HarnessError("invalid_trace_timeout");
  let socket: TailSocket | undefined;
  let accepting = true;
  const tail = record(
    (
      await cf.request(`/workers/scripts/${worker}/tails`, "POST", {
        filters: [],
      })
    ).result,
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
      socket = (options.socketFactory ?? tailSocket)(url.href);
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
    socket.addEventListener("message", (message) => {
      if (!accepting) return;
      const operation = (async () => {
        const data =
          typeof message.data === "string"
            ? message.data
            : message.data instanceof Blob
              ? await message.data.text()
              : new TextDecoder().decode(message.data as ArrayBuffer);
        if (!accepting) return;
        size += Buffer.byteLength(data, "utf8");
        if (size > TRACE_BYTES_MAX) {
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
    const openDeadline = Math.min(Date.now() + openTimeoutMs, expiry);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HarnessError("trace_open_timeout")),
        Math.max(0, openDeadline - Date.now()),
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
      socket!.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new HarnessError("trace_failed"));
        },
        { once: true },
      );
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HarnessError("trace_failed")),
        Math.max(0, openDeadline - Date.now()),
      );
      try {
        socket!.send(
          JSON.stringify({ debug: true }),
          TRACE_SEND_OPTIONS,
          (error) => {
            clearTimeout(timer);
            if (error) reject(new HarnessError("trace_failed"));
            else resolve();
          },
        );
      } catch {
        clearTimeout(timer);
        reject(new HarnessError("trace_failed"));
      }
    });
    if (Date.now() + settleMs >= expiry)
      throw new HarnessError("invalid_tail_expiry");
    if (settleMs) {
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            settleTimer = setTimeout(resolve, settleMs);
          }),
          event,
        ]);
      } finally {
        if (settleTimer) clearTimeout(settleTimer);
      }
    }
    if (socket.readyState !== 1) throw new HarnessError("trace_failed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const eventDeadline = Math.min(Date.now() + eventTimeoutMs, expiry);
    try {
      await Promise.race([
        (async () => {
          const dispatchedAt = Date.now();
          if (dispatchedAt >= expiry)
            throw new HarnessError("invalid_tail_expiry");
          if (dispatchedAt >= eventDeadline)
            throw new HarnessError("trace_event_missing");
          await trigger();
          await event;
        })(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new HarnessError("trace_event_missing")),
            Math.max(0, eventDeadline - Date.now()),
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
      socket?.terminate();
    } finally {
      await cf.request(
        `/workers/scripts/${worker}/tails/${encodeURIComponent(id)}`,
        "DELETE",
      );
    }
  }
}
