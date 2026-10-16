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
    try {
      return await super.fetch(
        new Request(request, { signal: controller.signal }),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
