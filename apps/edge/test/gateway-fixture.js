// SPDX-License-Identifier: Apache-2.0
/* global URL, Response, WebSocketPair, setTimeout */
// Only a test Worker: observations never stand in for live gateway acceptance.
let connections = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/reset") {
      connections = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/stats") return Response.json(connections);
    const connection = {
      token: request.headers.get("X-PGCF-Route"),
      bytes: [],
      closes: [],
    };
    connections.push(connection);
    if (url.searchParams.get("mode") === "reject")
      return new Response(null, { status: 503 });
    if (url.searchParams.get("mode") === "slow")
      await new Promise((resolve) => setTimeout(resolve, 25));
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.binaryType = "arraybuffer";
    socket.accept({ allowHalfOpen: true });
    socket.addEventListener("message", (event) => {
      connection.bytes.push(...new Uint8Array(event.data));
      if (url.searchParams.get("mode") === "text") socket.send("unsupported");
      else {
        socket.send(event.data);
        if (url.searchParams.get("mode") === "close")
          socket.close(1012, "test drain");
      }
    });
    socket.addEventListener("close", (event) => {
      connection.closes.push(event.code);
      socket.close(
        event.code === 1005 ? 1000 : event.code === 1006 ? 1011 : event.code,
      );
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};
