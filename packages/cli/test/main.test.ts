// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, connect } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { newDatabaseId } from "@pgcf/contracts";

const loopback = [127, 0, 0, 1].join(".");
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("CLI help and invalid flags reveal no supplied credential text", async () => {
  const secret = randomBytes(32).toString("base64url");
  const child = spawn(
    process.execPath,
    [entry, "connect", "--password", secret],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.equal(output.includes(secret), false);
  assert.match(output, /invalid_arguments/);
});

async function stopped(signal: "SIGINT" | "SIGTERM") {
  const upstream = createServer((socket) => {
    socket.on("error", () => {});
  });
  upstream.listen(0, loopback);
  await once(upstream, "listening");
  const child = spawn(
    process.execPath,
    [
      entry,
      "connect",
      "--endpoint",
      `wss://${loopback}:${(upstream.address() as AddressInfo).port}`,
      "--database",
      newDatabaseId(),
      "--user",
      "app",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let ready: ((port: number) => void) | undefined;
  const listening = new Promise<number>((resolve) => {
    ready = resolve;
  });
  child.stdout.on("data", (value: Buffer) => {
    output += value.toString();
    const match = /Listening on 127\.0\.0\.1:([0-9]+)/.exec(output);
    if (match) ready!(Number(match[1]));
  });
  let errors = "";
  child.stderr.on("data", (value: Buffer) => {
    errors += value.toString();
  });
  const accepted: import("node:net").Socket[] = [];
  upstream.on("connection", (socket) => accepted.push(socket));
  let socket: import("node:net").Socket | undefined;
  try {
    const port = await listening;
    socket = connect({ host: loopback, port });
    socket.on("error", () => {});
    await once(socket, "connect");
    const ended = once(child, "close");
    const closed = once(socket, "close");
    child.kill(signal);
    const [exitCode, exitSignal] = await ended;
    await closed;
    assert.equal(exitCode, 0);
    assert.equal(exitSignal, null);
    assert.equal(errors, "");
    assert.match(output, /sslmode=disable/);
    const refused = connect({ host: loopback, port });
    await once(refused, "error");
    refused.destroy();
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
    accepted.forEach((connection) => connection.destroy());
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

test("SIGINT closes listener and owned pending TLS connection", async () => {
  await stopped("SIGINT");
});
test("SIGTERM closes listener and owned pending TLS connection", async () => {
  await stopped("SIGTERM");
});
