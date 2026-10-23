// SPDX-License-Identifier: Apache-2.0

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * The three-letter colo this code runs in, from Cloudflare's trace for the request; nothing else of
 * the trace (it holds the caller's address) is read. Never throws: null when it is not known after
 * `timeoutMs`.
 */
export async function traceColo(timeoutMs: number): Promise<string | null> {
  return fetch(TRACE_URL, { signal: AbortSignal.timeout(timeoutMs) })
    .then((response) => response.text())
    .then((trace) => /^colo=([A-Z]{3})$/m.exec(trace)?.[1] ?? null)
    .catch(() => null);
}
