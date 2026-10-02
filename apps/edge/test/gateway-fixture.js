// SPDX-License-Identifier: Apache-2.0
/* global URL, Response, WebSocketPair, setTimeout */
// Only a test Worker: observations never stand in for live gateway acceptance.
let connections = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/release" || url.pathname === "/reset") {
      for (const connection of connections) connection.released = true;
      if (url.pathname === "/reset") connections = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/stats") return Response.json(connections);
    const connection = {
      token: request.headers.get("X-PGCF-Route"),
      headers: Object.fromEntries(request.headers),
      path: url.pathname,
      waiting: false,
      released: false,
      bytes: [],
      closes: [],
      byte_count: 0,
      text_frames: 0,
    };
    connections.push(connection);
    if (url.searchParams.get("mode") === "redirect") {
      const target = new URL("/redirect-target", request.url);
      target.hostname = ["redirect", "invalid"].join(".");
      return new Response(null, {
        status: 307,
        headers: { Location: target.toString() },
      });
    }
    if (url.searchParams.get("mode") === "held") {
      connection.waiting = true;
      const deadline = Date.now() + 60_000;
      while (!connection.released && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      connection.waiting = false;
    }
    if (url.searchParams.get("mode") === "reject")
      return new Response(null, { status: 503 });
    if (url.searchParams.get("mode") === "slow")
      await new Promise((resolve) => setTimeout(resolve, 25));
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.binaryType = "arraybuffer";
    socket.accept({ allowHalfOpen: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") connection.text_frames++;
      else {
        connection.byte_count += event.data.byteLength;
        if (url.searchParams.get("mode") !== "count")
          for (const byte of new Uint8Array(event.data))
            connection.bytes.push(byte);
      }
      if (url.searchParams.get("mode") === "count") {
        const count = new Uint8Array(4);
        new DataView(count.buffer).setUint32(0, connection.byte_count);
        socket.send(count);
        return;
      }
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
