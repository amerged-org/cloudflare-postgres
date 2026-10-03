// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";
import { tailSocket, TRACE_SEND_OPTIONS } from "../src/trace-transport.ts";

test("real ws transport sends the CLI protocol, derived version and unmasked text initialization", async () => {
  const server = createServer();
  let peer: Duplex | undefined;
  let resolveFrame: ((value: Buffer) => void) | undefined;
  const frame = new Promise<Buffer>((resolve) => {
    resolveFrame = resolve;
  });
  server.on("upgrade", (request, socket) => {
    peer = socket;
    assert.equal(request.headers["sec-websocket-protocol"], "trace-v1");
    assert.match(
      request.headers["user-agent"] ?? "",
      /^wrangler\/\d+\.\d+\.\d+/,
    );
    const accept = createHash("sha1")
      .update(
        String(request.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: trace-v1\r\n\r\n`,
    );
    let bytes = Buffer.alloc(0);
    socket.on("data", (value: Buffer) => {
      bytes = Buffer.concat([bytes, value]);
      if (bytes.length >= 2 && bytes.length >= 2 + (bytes[1]! & 127))
        resolveFrame!(bytes);
    });
    socket.on("error", () => {});
  });
  server.listen(0, [127, 0, 0, 1].join("."));
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const socket = tailSocket(`ws://${[127, 0, 0, 1].join(".")}:${address.port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("local_transport_failed")),
        { once: true },
      );
    });
    await new Promise<void>((resolve, reject) =>
      socket.send(
        JSON.stringify({ debug: true }),
        TRACE_SEND_OPTIONS,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    const bytes = await frame;
    assert.equal(bytes[0], 0x81);
    assert.equal(bytes[1]! & 0x80, 0);
    assert.deepEqual(JSON.parse(bytes.subarray(2).toString("utf8")), {
      debug: true,
    });
  } finally {
    socket.terminate();
    peer?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
