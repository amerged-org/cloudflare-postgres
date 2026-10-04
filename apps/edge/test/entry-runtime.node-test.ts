// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { createTestHarness } from "wrangler";

test("the complete production entry loads in workerd and serves health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-edge-entry-"));
  const server = createTestHarness({
    root: directory,
    workers: [
      {
        config: {
          name: "pgcf-edge-entry-test",
          main: resolve(import.meta.dirname, "../src/index.ts"),
          compatibility_date: "2026-10-02",
        },
      },
    ],
  });
  try {
    await server.listen();
    const response = await server.getWorker().fetch("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the actual pg default SCRAM client receives wrong-password failure from an unknown route in workerd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-decoy-entry-"));
  const database = "d" + randomUUID().replaceAll("-", "").slice(0, 19);
  const server = createTestHarness({
    root: directory,
    workers: [
      {
        config: {
          name: "pgcf-decoy-entry-test",
          main: resolve(import.meta.dirname, "actor-entry.js"),
          compatibility_date: "2026-10-02",
          vars: {
            ROUTE_MASTER_KEYS: JSON.stringify({
              active: "v1",
              keys: { v1: randomBytes(32).toString("base64url") },
            }),
          },
          durable_objects: {
            bindings: [{ name: "DATABASE_ACTOR", class_name: "DatabaseActor" }],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["DatabaseActor"] }],
          ratelimits: [
            {
              name: "CONNECTION_RATE_LIMITER",
              namespace_id: "1",
              simple: { limit: 1000, period: 60 },
            },
          ],
        },
      },
    ],
  });
  try {
    await server.listen();
    const response = await server
      .getWorker()
      .fetch(`/v2?${new URLSearchParams({ database, user: "app" })}`, {
        headers: {
          Upgrade: "websocket",
          "CF-Connecting-IP": [192, 0, 2, 1].join("."),
        },
      });
    assert.equal(response.status, 101);
    const socket = response.webSocket!;
    socket.accept();
    const backend: Uint8Array[] = [];
    class WireStream extends Duplex {
      connect() {
        queueMicrotask(() => this.emit("connect"));
        return this;
      }
      setNoDelay() {
        return this;
      }
      setKeepAlive() {
        return this;
      }
      override _read() {}
      override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        try {
          socket.send(new Uint8Array(chunk));
          callback();
        } catch (error) {
          callback(error as Error);
        }
      }
      override _destroy(
        error: Error | null,
        callback: (error: Error | null) => void,
      ) {
        try {
          socket.close();
        } catch {
          /* Already closed. */
        }
        callback(error);
      }
    }
    const stream = new WireStream();
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        backend.push(bytes);
        stream.push(Buffer.from(bytes));
      }
    });
    socket.addEventListener("close", () => {
      stream.push(null);
      try {
        socket.close();
      } catch {
        /* Already closed. */
      }
    });
    const load = createRequire(import.meta.url);
    // Reuse the repository's declared regional pg dependency; this is a test client, not Edge code.
    const { Client } = load(
      load.resolve("pg", {
        paths: [resolve(import.meta.dirname, "../../regional")],
      }),
    ) as {
      Client: new (options: object) => {
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new Client({
      user: "app",
      database,
      password: randomUUID(),
      ssl: false,
      stream,
      connectionTimeoutMillis: 5000,
    });
    try {
      await assert.rejects(
        client.connect(),
        (error: unknown) => (error as { code?: string }).code === "28P01",
      );
    } finally {
      await client.end();
      stream.destroy();
    }
    assert.deepEqual(
      backend.map((bytes) =>
        bytes[0] === 0x52 ? new DataView(bytes.buffer).getUint32(5) : bytes[0],
      ),
      [10, 11, 0x45],
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
