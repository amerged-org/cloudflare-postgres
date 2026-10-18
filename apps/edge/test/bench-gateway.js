// SPDX-License-Identifier: Apache-2.0
/* global URL, Request, Response, WebSocketPair, fetch */
// Only the relay benchmark's gateway Worker (`bench/relay.ts`). A WebSocket upgrade becomes a
// pump between the socket and the benchmark's PostgreSQL (no authentication: a trust-mode server
// of the benchmark); any other request goes to the benchmark's loopback HTTP runner.
import { connect } from "cloudflare:sockets";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return fetch(
        new Request(`http://${env.SHIM}${url.pathname}${url.search}`, request),
      );
    const { 0: client, 1: server } = new WebSocketPair();
    server.binaryType = "arraybuffer";
    server.accept();
    const postgres = connect(env.PG);
    const writer = postgres.writable.getWriter();
    server.addEventListener("message", (event) => {
      void writer.write(new Uint8Array(event.data));
    });
    server.addEventListener("close", () => void postgres.close());
    void (async () => {
      for await (const chunk of postgres.readable) server.send(chunk);
      server.close();
    })();
    return new Response(null, { status: 101, webSocket: client });
  },
};
