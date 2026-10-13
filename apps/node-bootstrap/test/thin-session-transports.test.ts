// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { WebSocketServer } from "ws";
import { stringify } from "yaml";
import { RelayGrantCount } from "@pgcf/contracts/node-bootstrap";
import {
  BOOTSTRAP_RELAY_HEADER,
  signBootstrapRelay,
  verifyBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { BootstrapError } from "../src/bootstrap.ts";
import { LOOPBACK } from "../src/proxy-command.ts";
import { openThinSession, type ThinSession } from "../src/thin-storage.ts";

// A real child sends bytes only after a real CONNECT succeeds. A closed opened stream is never retried.
const child = `
const net = require('node:net');
const proxy = new URL(process.env.HTTPS_PROXY);
const socket = net.connect(Number(proxy.port), proxy.hostname);
const target = process.argv[1], payload = process.argv[2], cut = process.argv[3] === 'cut';
let bytes = '', opened = false, done = false;
socket.on('connect', () => socket.write('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n'));
socket.on('data', data => {
  bytes += data.toString();
  if (!opened) {
    const boundary = bytes.indexOf('\\r\\n\\r\\n');
    if (boundary < 0) return;
    if (!bytes.startsWith('HTTP/1.1 200 ')) process.exit(2);
    bytes = bytes.slice(boundary+4); opened = true; socket.write(payload);
  }
  if (!cut && bytes.includes(payload)) { done = true; console.log('echo'); socket.end(); }
});
socket.on('close', () => { if (cut && opened) { done = true; console.log('closed'); } process.exit(done ? 0 : 3); });
socket.on('error', () => process.exit(4));
setTimeout(() => process.exit(5), 3000).unref();
`;

async function fixture(
  options: { legacy?: boolean; wrongTarget?: boolean; cut?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-thin-relay-sockets-"));
  await chmod(directory, 0o700);
  const keyFile = join(directory, "server-key.pem"),
    certificate = join(directory, "server.pem");
  const originalCa = getCACertificates("default");
  let liveServer: ReturnType<typeof createServer> | undefined;
  let liveSockets: WebSocketServer | undefined;
  try {
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certificate,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-days",
        "1",
      ],
      { timeout: 15000, stdio: "pipe" },
    );
    assert.equal(
      generated.status,
      0,
      "real local TLS generation failed; private output withheld",
    );
    await chmod(keyFile, 0o600);
    await chmod(certificate, 0o600);
    const cert = await readFile(certificate, "utf8"),
      oldCa = originalCa;
    setDefaultCACertificates([...oldCa, cert]);
    const signing = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    assert.ok("privateKey" in signing && "publicKey" in signing);
    const epoch = randomUUID(),
      bearer = randomUUID() + randomUUID();
    const counts: number[] = [],
      consumed = new Set<string>();
    let opened = 0,
      transferred = 0,
      origin = "";
    const server = createServer(
      { key: await readFile(keyFile), cert },
      (request, response) => {
        void (async () => {
          assert.equal(
            request.headers.authorization === `Bearer ${bearer}`,
            true,
          );
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            capability: "talos_api" | "kubernetes_api";
            count?: number;
          };
          const count = options.legacy
            ? 1
            : RelayGrantCount.parse(body.count ?? 1);
          counts.push(count);
          const tokens = await Promise.all(
            Array.from({ length: count }, () =>
              signBootstrapRelay({
                privateKey: signing.privateKey,
                kid: "local",
                operation: "op_abcdefghijklmnopqrst",
                node: "nod_abcdefghijklmnopqrst",
                region: "eu-dev",
                issuer_region: "eu-dev",
                relay_epoch: epoch,
                revision: 1,
                capability: body.capability,
                address: LOOPBACK,
              }),
            ),
          );
          const value = {
            websocket_url: origin.replace("https:", "wss:") + "/storage/relay",
            expectedTarget: {
              ip: LOOPBACK,
              port: options.wrongTarget
                ? 50000
                : body.capability === "talos_api"
                  ? 50000
                  : 6443,
            },
          };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              count === 1
                ? { ...value, token: tokens[0] }
                : { ...value, tokens },
            ),
          );
        })().catch(() => response.destroy());
      },
    );
    const sockets = new WebSocketServer({ noServer: true });
    liveServer = server;
    liveSockets = sockets;
    server.on("upgrade", (request, socket, head) => {
      void (async () => {
        assert.equal(
          request.headers.authorization === `Bearer ${bearer}`,
          true,
        );
        const verified = await verifyBootstrapRelay(
          request.headers[BOOTSTRAP_RELAY_HEADER.toLowerCase()],
          {
            keys: new Map([["local", signing.publicKey]]),
            region: "eu-dev",
            issuer_region: "eu-dev",
            relay_epoch: epoch,
            allowedTargetRegions: ["eu-dev"],
          },
        );
        if (!verified.ok || consumed.has(verified.claims.nonce)) {
          socket.destroy();
          return;
        }
        consumed.add(verified.claims.nonce);
        sockets.handleUpgrade(request, socket, head, (ws) => {
          opened++;
          ws.on("message", (data) => {
            transferred++;
            if (options.cut) ws.close();
            else ws.send(data, { binary: true });
          });
        });
      })().catch(() => socket.destroy());
    });
    server.listen(0, LOOPBACK);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `https://localhost:${address.port}`;
    const scope = {
      callback: { url: origin + "/storage", bearer },
      cluster_endpoint: `https://${LOOPBACK}:6443`,
      address: LOOPBACK,
      budget_ms: 8000,
      deadline_code: "thin_storage_turn_timeout" as const,
      prefix: "pgcf-thin-relay-session-",
      talos_admin_config: stringify({
        context: "test",
        contexts: {
          test: { ca: "test-only", crt: "test-only", key: "test-only" },
        },
      }),
      kubeconfig: stringify({
        clusters: [
          {
            cluster: {
              server: `https://${LOOPBACK}:6443`,
              "certificate-authority-data": "test-only",
            },
          },
        ],
        users: [
          {
            user: {
              "client-certificate-data": "test-only",
              "client-key-data": "test-only",
            },
          },
        ],
      }),
    };
    const run = (
      session: ThinSession,
      payload: string,
      capability = "kubernetes_api",
    ) =>
      session.command(
        process.execPath,
        [
          "-e",
          child,
          `${LOOPBACK}:${capability === "talos_api" ? 50000 : 6443}`,
          payload,
          options.cut ? "cut" : "echo",
        ],
        undefined,
        false,
        5000,
      );
    return {
      scope,
      run,
      counts,
      observed: () => ({ opened, transferred, used: consumed.size }),
      close: async () => {
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        setDefaultCACertificates(oldCa);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const ws of liveSockets?.clients ?? []) ws.terminate();
    liveSockets?.close();
    liveServer?.closeAllConnections();
    if (liveServer?.listening)
      await new Promise<void>((resolve) => liveServer!.close(() => resolve()));
    setDefaultCACertificates(originalCa);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("thin session requests one bounded grant batch for concurrent real proxy children", async () => {
  const live = await fixture();
  try {
    await openThinSession(live.scope, {}, async (session) => {
      const reads = await Promise.all([
        live.run(session, "first"),
        live.run(session, "second"),
      ]);
      assert.equal(
        reads.every((result) => result.stdout.trim() === "echo"),
        true,
      );
      assert.equal(
        (await live.run(session, "separate-talos", "talos_api")).stdout.trim(),
        "echo",
      );
    });
    assert.deepEqual(live.counts, [8, 8]);
    assert.deepEqual(live.observed(), { opened: 3, transferred: 3, used: 3 });
  } finally {
    await live.close();
  }
});

test("thin session accepts real legacy singleton grants and refuses a different declared target", async () => {
  const legacy = await fixture({ legacy: true });
  try {
    await openThinSession(legacy.scope, {}, async (session) => {
      assert.equal((await legacy.run(session, "legacy")).stdout.trim(), "echo");
    });
    assert.equal(legacy.observed().opened, 1);
  } finally {
    await legacy.close();
  }
  const wrong = await fixture({ wrongTarget: true });
  try {
    await assert.rejects(
      openThinSession(wrong.scope, {}, (session) =>
        wrong.run(session, "wrong"),
      ),
      (error: unknown) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_command_failed",
    );
    assert.equal(
      wrong.observed().opened,
      0,
      "a target mismatch cannot open a relay",
    );
  } finally {
    await wrong.close();
  }
});

test("thin session does not reopen a real relay after client bytes reached it", async () => {
  const live = await fixture({ cut: true });
  try {
    await openThinSession(live.scope, {}, async (session) => {
      assert.equal(
        (await live.run(session, "one-effect")).stdout.trim(),
        "closed",
      );
    });
    assert.deepEqual(live.observed(), { opened: 1, transferred: 1, used: 1 });
  } finally {
    await live.close();
  }
});
