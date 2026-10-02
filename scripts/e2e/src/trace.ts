// SPDX-License-Identifier: Apache-2.0
import { Cloudflare } from "./clients.ts";
import { HarnessError, assertOwned, record, string } from "./core.ts";

/** Trace bodies live only in memory until the deployed probe checks the canary. */
export async function captureTrace(
  cf: Cloudflare,
  worker: string,
  trigger: () => Promise<unknown>,
  owned: (id: string) => Promise<void>,
): Promise<string[]> {
  assertOwned(worker);
  if (!/(?:-dev|-test)$/.test(worker))
    throw new HarnessError("dev_worker_required");
  const tail = record(
    (await cf.request(`/workers/scripts/${worker}/tails`, "POST", {})).result,
  );
  const id = string(tail.id);
  await owned(id);
  const url = new URL(string(tail.url));
  if (url.protocol !== "wss:") throw new HarnessError("invalid_tail_url");
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(url.href, "trace-v1");
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
      const operation = (async () => {
        const data =
          typeof message.data === "string"
            ? message.data
            : message.data instanceof Blob
              ? await message.data.text()
              : new TextDecoder().decode(message.data as ArrayBuffer);
        size += data.length;
        if (size > 2_000_000) {
          failed?.();
          return;
        }
        messages.push(data);
        received?.();
      })();
      pending.push(operation);
    });
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
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    await cf.request(
      `/workers/scripts/${worker}/tails/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
}
