// SPDX-License-Identifier: Apache-2.0
// A local transport peer; never included in the published Worker.
import gateway from "../../edge/test/gateway-fixture.js";
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.searchParams.get("mode") !== "stalled-cancel")
      return gateway.fetch(request);
    url.searchParams.set("mode", "reject");
    await gateway.fetch(new Request(url, request));
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0]));
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
      { status: 503 },
    );
  },
};
