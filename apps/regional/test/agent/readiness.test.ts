// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSecureContext, TLSSocket } from "node:tls";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import {
  probeRoles,
  READINESS_SETTINGS_QUERY,
} from "../../src/agent/readiness.ts";
import { fixture } from "./fixtures.ts";

const int32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const int16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};
const frame = (type: string, body: Buffer) =>
  Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);

async function postgresFixture(
  database: ReturnType<typeof fixture>["db"],
  certificateHost: string,
  abortOnQuery?: () => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-readiness-test-"));
  const keyPath = join(directory, "generated-key");
  const certificatePath = join(directory, "generated-certificate");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=pgcf-test",
      "-addext",
      `subjectAltName=DNS:${certificateHost}`,
    ],
    { stdio: "ignore", timeout: 20_000 },
  );
  const ca = readFileSync(certificatePath, "utf8");
  const context = createSecureContext({ key: readFileSync(keyPath), cert: ca });
  rmSync(directory, { recursive: true });
  const connections = new Set<Socket | TLSSocket>();
  const authenticated: string[] = [];
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    socket.once("data", (request) => {
      assert.equal(request.readInt32BE(0), 8);
      assert.equal(request.readInt32BE(4), 80877103);
      socket.write("S");
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: context,
      });
      connections.add(secure);
      secure.on("error", () => {});
      secure.once("close", () => connections.delete(secure));
      let startup = true;
      let username = "";
      let pending = Buffer.alloc(0);
      secure.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= (startup ? 4 : 5)) {
          const offset = startup ? 0 : 1;
          const length = pending.readInt32BE(offset) + offset;
          if (pending.length < length) return;
          const packet = pending.subarray(0, length);
          pending = pending.subarray(length);
          if (startup) {
            const values = packet.subarray(8).toString().split("\0");
            for (let i = 0; i + 1 < values.length; i += 2) {
              if (values[i] === "user") username = values[i + 1]!;
              if (values[i] === "database")
                assert.equal(values[i + 1], database.id);
            }
            startup = false;
            secure.write(frame("R", int32(3)));
            continue;
          }
          const type = packet.subarray(0, 1).toString();
          if (type === "p") {
            const password = packet.subarray(5, -1).toString();
            if (
              database.roles.find((role) => role.name === username)
                ?.password !== password
            ) {
              secure.end(
                frame(
                  "E",
                  Buffer.from("SFATAL\0C28P01\0Mcredential rejected\0\0"),
                ),
              );
              return;
            }
            authenticated.push(username);
            secure.write(
              Buffer.concat([
                frame("R", int32(0)),
                frame("Z", Buffer.from("I")),
              ]),
            );
          } else if (type === "Q") {
            const query = packet.subarray(5, -1).toString();
            if (query !== "SELECT 1 AS pgcf_ready")
              assert.equal(query, READINESS_SETTINGS_QUERY);
            if (abortOnQuery) {
              abortOnQuery();
              return;
            }
            const values: [string, string, number][] =
              query === "SELECT 1 AS pgcf_ready"
                ? [["pgcf_ready", "1", 23]]
                : [
                    [
                      "max_connections",
                      String(database.size.max_connections),
                      23,
                    ],
                    [
                      "shared_buffers_bytes",
                      String(
                        Math.floor(database.size.memory_mib / 4) * 2 ** 20,
                      ),
                      25,
                    ],
                    [
                      "effective_cache_size_bytes",
                      String(
                        Math.floor(database.size.memory_mib / 2) * 2 ** 20,
                      ),
                      25,
                    ],
                    [
                      "archive_timeout_seconds",
                      String(database.size.archive_timeout_seconds),
                      23,
                    ],
                  ];
            secure.write(
              Buffer.concat([
                frame(
                  "T",
                  Buffer.concat([
                    int16(values.length),
                    ...values.flatMap(([name, , type]) => [
                      Buffer.from(name + "\0"),
                      int32(0),
                      int16(0),
                      int32(type),
                      int16(type === 23 ? 4 : -1),
                      int32(-1),
                      int16(0),
                    ]),
                  ]),
                ),
                frame(
                  "D",
                  Buffer.concat([
                    int16(values.length),
                    ...values.flatMap(([, value]) => [
                      int32(Buffer.byteLength(value)),
                      Buffer.from(value),
                    ]),
                  ]),
                ),
                frame("C", Buffer.from("SELECT 1\0")),
                frame("Z", Buffer.from("I")),
              ]),
            );
          } else if (type === "X") secure.end();
          else assert.fail("unexpected PostgreSQL readiness message");
        }
      });
    });
  });
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const factory = (config: ClientConfig) => {
    assert.equal(config.host, `database-rw.pgcf-db-${database.id}.svc`);
    assert.equal(config.port, 5432);
    assert.equal(
      typeof config.ssl === "object" && config.ssl.rejectUnauthorized,
      true,
    );
    return new Client({ ...config, host: address.address, port: address.port });
  };
  return {
    ca,
    authenticated,
    factory,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("readiness authenticates every desired role over verified TLS and rejects a stale password", async () => {
  const { db } = fixture();
  db.roles.push({
    name: "reader",
    owner: false,
    password: fixture().db.roles[0]!.password,
    revision: 1,
  });
  const server = await postgresFixture(db, `database-rw.pgcf-db-${db.id}.svc`);
  try {
    assert.equal(
      await probeRoles(
        db,
        server.ca,
        new AbortController().signal,
        server.factory,
      ),
      true,
    );
    assert.deepEqual(server.authenticated, ["app", "reader"]);
    const changed = structuredClone(db);
    changed.roles[0]!.password = fixture().db.roles[0]!.password;
    assert.equal(
      await probeRoles(
        changed,
        server.ca,
        new AbortController().signal,
        server.factory,
      ),
      false,
    );
  } finally {
    await server.close();
  }
});

test("authenticated old PostgreSQL settings cannot acknowledge a resized desired generation", async () => {
  const { db } = fixture();
  const server = await postgresFixture(db, `database-rw.pgcf-db-${db.id}.svc`);
  const resized = structuredClone(db);
  resized.generation++;
  resized.size.memory_mib *= 2;
  resized.size.max_connections += 50;
  try {
    assert.equal(
      await probeRoles(
        resized,
        server.ca,
        new AbortController().signal,
        server.factory,
      ),
      false,
    );
  } finally {
    await server.close();
  }
});

test("readiness rejects an untrusted CA, a wrong certificate hostname and an aborted query", async () => {
  const { db } = fixture();
  const correct = await postgresFixture(db, `database-rw.pgcf-db-${db.id}.svc`);
  const wrong = await postgresFixture(
    db,
    `database-rw.pgcf-db-${fixture().db.id}.svc`,
  );
  try {
    assert.equal(
      await probeRoles(
        db,
        wrong.ca,
        new AbortController().signal,
        correct.factory,
      ),
      false,
    );
    assert.equal(
      await probeRoles(
        db,
        wrong.ca,
        new AbortController().signal,
        wrong.factory,
      ),
      false,
    );
  } finally {
    await correct.close();
    await wrong.close();
  }
  const controller = new AbortController();
  const stalled = await postgresFixture(
    db,
    `database-rw.pgcf-db-${db.id}.svc`,
    () => controller.abort(),
  );
  try {
    assert.equal(
      await probeRoles(db, stalled.ca, controller.signal, stalled.factory),
      false,
    );
  } finally {
    await stalled.close();
  }
});
