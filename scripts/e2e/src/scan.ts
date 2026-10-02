// SPDX-License-Identifier: Apache-2.0
import { createConnection, isIP } from "node:net";
import { HarnessError } from "./core.ts";

export interface ScanResult {
  open: number[];
  checked: number;
  timedOut: number;
}

export async function scanPorts(
  host: string,
  ports: readonly number[],
  options: {
    timeoutMs?: number;
    concurrency?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ScanResult> {
  const timeoutMs = options.timeoutMs ?? 400;
  const concurrency = options.concurrency ?? 128;
  if (
    !isIP(host) ||
    timeoutMs < 1 ||
    timeoutMs > 5000 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 256 ||
    ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) ||
    new Set(ports).size !== ports.length
  ) {
    throw new HarnessError("invalid_scan");
  }
  const result: ScanResult = { open: [], checked: 0, timedOut: 0 };
  let next = 0;
  async function scanOne(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new HarnessError("scan_aborted"));
        return;
      }
      const socket = createConnection({ host, port });
      let finished = false;
      const finish = (status: "open" | "closed" | "timeout" | "aborted") => {
        if (finished) return;
        finished = true;
        options.signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (status === "aborted") {
          reject(new HarnessError("scan_aborted"));
          return;
        }
        result.checked++;
        if (status === "open") result.open.push(port);
        if (status === "timeout") result.timedOut++;
        resolve();
      };
      const abort = () => finish("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish("open"));
      socket.once("timeout", () => finish("timeout"));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (
          [
            "ECONNREFUSED",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "ETIMEDOUT",
            "ECONNRESET",
          ].includes(error.code ?? "")
        )
          finish("closed");
        else {
          finish("aborted");
        }
      });
    });
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ports.length) }, async () => {
      while (next < ports.length) {
        const port = ports[next++]!;
        await scanOne(port);
      }
    }),
  );
  result.open.sort((a, b) => a - b);
  return result;
}

export function assertOpenSubset(
  open: readonly number[],
  allowed: readonly number[],
): void {
  if (open.some((port) => !allowed.includes(port)))
    throw new HarnessError("unexpected_open_port");
}
