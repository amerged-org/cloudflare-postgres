// SPDX-License-Identifier: Apache-2.0
// Test-only request cancellation inside the actual Workers host. No admission logic.
import rust from "../build/worker/shim.mjs";
export default class RequestProbe extends rust {
  async fetch(request: Request) {
    const controller = new AbortController(),
      url = new URL(request.url);
    const immediate = url.searchParams.get("probe_abort") === "immediate";
    const timer = immediate
      ? undefined
      : setTimeout(() => controller.abort(), 100);
    if (immediate) controller.abort();
    const headers = new Headers(request.headers);
    // Miniflare supplies CF-Connecting-IP at ingress; remove it inside the host for this failure case.
    if (url.searchParams.get("probe_no_ip") === "true")
      headers.delete("CF-Connecting-IP");
    try {
      return await super.fetch(
        new Request(request, { headers, signal: controller.signal }),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
