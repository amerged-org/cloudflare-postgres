// SPDX-License-Identifier: Apache-2.0
// A local transport peer; never included in the published Worker.
import gateway from "../../edge/test/gateway-fixture.js";
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    if (mode !== "stalled-cancel" && mode !== "uncoded-400")
      return gateway.fetch(request);
    // The shared fixture records the request; what it answers is replaced.
    url.searchParams.set("mode", "reject");
    await gateway.fetch(new Request(url, request));
    // A 400 of the gateway that is not an error of a statement: it has a code of its own.
    if (mode === "uncoded-400")
      return Response.json(
        { error: "bad_request", detail: "free text the Edge must not log" },
        { status: 400 },
      );
    // The next chunk is 30 s away: the stream is stalled but not hung, which workerd would end.
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0]));
        },
        pull() {
          return new Promise((resolve) => setTimeout(resolve, 30_000));
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
      { status: 503 },
    );
  },
};
