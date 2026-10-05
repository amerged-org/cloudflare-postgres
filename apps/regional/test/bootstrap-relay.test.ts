// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import {
  createBootstrapRelay,
  readBootstrapRelayConfiguration,
  BOOTSTRAP_RELAY_LIMITS,
} from "../src/bootstrap-relay.ts";
import {
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_HEADER,
  importBootstrapVerificationKeys,
  signBootstrapRelay,
  type BootstrapCryptoKey,
} from "../../../packages/contracts/src/bootstrap-relay.ts";
import {
  base64urlToBytes,
  bytesToBase64url,
} from "../../../packages/contracts/src/encoding.ts";
import {
  newNodeId,
  newOperationId,
} from "../../../packages/contracts/src/ids.ts";

const address = [127, 0, 0, 1].join(".");
async function fixture(
  t: TestContext,
  options: {
    allowedTargetRegions?: readonly string[];
    connections?: number;
    memoryBytes?: number;
    connectionMemoryBytes?: number;
    sessionMs?: number;
  } = {},
) {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as { privateKey: BootstrapCryptoKey; publicKey: BootstrapCryptoKey };
  const publicKeys = {
    current: bytesToBase64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
  const keys = await importBootstrapVerificationKeys(publicKeys);
  const backendSockets = new Set<Socket>();
  let dials = 0;
  const backend = net.createServer((socket) => {
    dials++;
    backendSockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => backendSockets.delete(socket));
    socket.pipe(socket);
  });
  backend.listen(50000, address);
  await once(backend, "listening");
  const relay = createBootstrapRelay({
    region: "eu-test",
    issuerRegion: "eu-test",
    host: address,
    port: 0,
    keys,
    allowedTargetRegions: ["eu-test"],
    ...options,
  });
  relay.server.listen(0, address);
  await once(relay.server, "listening");
  const port = (relay.server.address() as net.AddressInfo).port,
    base = `http://${address}:${port}`,
    url = `ws://${address}:${port}${BOOTSTRAP_RELAY_PATH}`;
  const clients = new Set<WebSocket>();
  t.after(async () => {
    for (const client of clients) client.terminate();
    await relay.close();
    for (const socket of backendSockets) socket.destroy();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
  const input = {
    privateKey: pair.privateKey,
    kid: "current",
    region: relay.identity.region,
    issuer_region: relay.identity.issuer_region,
    relay_epoch: relay.identity.relay_epoch,
    operation: newOperationId(),
    node: newNodeId(),
    revision: 1,
    capability: "talos_api" as const,
    address,
  };
  const token = () => signBootstrapRelay(input);
  const changedToken = async (
    change: (claims: Record<string, unknown>) => void,
  ) => {
    const value = await token();
    const claims = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(value.split(".")[1]!)!),
    );
    change(claims);
    const payload = bytesToBase64url(
      new TextEncoder().encode(JSON.stringify(claims)),
    );
    const signature = await crypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      new TextEncoder().encode("pgcf-bootstrap-relay/v1\n" + payload),
    );
    return `br1.${payload}.${bytesToBase64url(new Uint8Array(signature))}`;
  };
  const open = async (value?: string) => {
    value ??= await token();
    const client = new WebSocket(url, {
      headers: { [BOOTSTRAP_RELAY_HEADER]: value },
      perMessageDeflate: false,
    });
    clients.add(client);
    client.on("error", () => {});
    await once(client, "open");
    return client;
  };
  const rejected = (value: string) =>
    new Promise<number>((resolve, reject) => {
      const client = new WebSocket(url, {
        headers: { [BOOTSTRAP_RELAY_HEADER]: value },
      });
      clients.add(client);
      client.once("open", () => reject(new Error("unexpected_upgrade")));
      client.once("unexpected-response", (request, response) => {
        response.destroy();
        request.destroy();
        client.terminate();
        resolve(response.statusCode!);
      });
      client.on("error", () => {});
    });
  return {
    relay,
    backend,
    backendSockets,
    pair,
    publicKeys,
    keys,
    input,
    base,
    url,
    token,
    changedToken,
    open,
    rejected,
    dials: () => dials,
  };
}
async function echo(client: WebSocket, value: Buffer) {
  const response = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const clean = () => {
      client.off("message", message);
      client.off("close", close);
      client.off("error", error);
    };
    const error = () => {
      clean();
      reject(new Error("transport_failed"));
    };
    const close = () => {
      clean();
      reject(new Error("transport_truncated"));
    };
    const message = (bytes: Buffer, binary: boolean) => {
      try {
        assert.equal(binary, true);
        assert.ok(Buffer.isBuffer(bytes));
        received += bytes.length;
        assert.ok(received <= value.length);
        chunks.push(bytes);
        if (received === value.length) {
          clean();
          resolve(Buffer.concat(chunks));
        }
      } catch (failure) {
        clean();
        reject(failure);
      }
    };
    client.on("message", message);
    client.once("close", close);
    client.once("error", error);
  });
  await new Promise<void>((resolve, reject) =>
    client.send(value, { binary: true, compress: false }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  assert.deepEqual(await response, value);
}

async function closed(client: WebSocket) {
  if (client.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => client.once("close", () => resolve()));
}
async function drained(relay: ReturnType<typeof createBootstrapRelay>) {
  for (let turn = 0; turn < 30 && relay.snapshot().connections; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(relay.snapshot().connections, 0);
  assert.equal(relay.snapshot().memoryUsed, 0);
}

test("real binary WebSocket/TCP transport forwards exact bytes once and exposes only process identity", async (t) => {
  const f = await fixture(t),
    identity = await fetch(f.base + BOOTSTRAP_RELAY_IDENTITY_PATH).then(
      (value) => value.json(),
    );
  assert.deepEqual(identity, f.relay.identity);
  const client = await f.open();
  for (let chunk = 0; chunk < 16; chunk++)
    await echo(client, randomBytes(32 * 1024));
  assert.equal(f.dials(), 1);
  assert.ok(
    f.relay.snapshot().memoryPeak <= BOOTSTRAP_RELAY_LIMITS.memoryBytes,
  );
  client.terminate();
  await closed(client);
  await drained(f.relay);
  assert.equal(f.dials(), 1);
});
test("wrong signatures, foreign epochs and expired tokens contact no upstream", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.rejected(randomUUID()), 401);
  assert.equal(
    await f.rejected(
      await signBootstrapRelay({ ...f.input, relay_epoch: randomUUID() }),
    ),
    401,
  );
  assert.equal(
    await f.rejected(
      await signBootstrapRelay({ ...f.input, now: Date.now() - 120000 }),
    ),
    401,
  );
  assert.equal(
    await f.rejected(
      await f.changedToken((claims) => {
        claims.purpose = "route";
      }),
    ),
    401,
  );
  assert.equal(
    await f.rejected(
      await f.changedToken((claims) => {
        (claims.target as Record<string, unknown>).port = 5432;
      }),
    ),
    401,
  );
  assert.equal(f.dials(), 0);
  assert.equal(f.relay.snapshot().memoryUsed, 0);
});
test("a used token cannot reconnect after disconnect and a fresh server epoch rejects the old token", async (t) => {
  const f = await fixture(t),
    token = await f.token(),
    client = await f.open(token);
  await echo(client, randomBytes(200));
  client.terminate();
  await closed(client);
  await drained(f.relay);
  assert.equal(await f.rejected(token), 401);
  assert.equal(f.dials(), 1);
  const replacement = createBootstrapRelay({
    region: "eu-test",
    issuerRegion: "eu-test",
    host: address,
    port: 0,
    keys: f.keys,
    allowedTargetRegions: ["eu-test"],
  });
  t.after(() => replacement.close());
  replacement.server.listen(0, address);
  await once(replacement.server, "listening");
  assert.notEqual(
    replacement.identity.relay_epoch,
    f.relay.identity.relay_epoch,
  );
  const port = (replacement.server.address() as net.AddressInfo).port;
  const denied = await new Promise<number>((resolve) => {
    const next = new WebSocket(
      `ws://${address}:${port}${BOOTSTRAP_RELAY_PATH}`,
      { headers: { [BOOTSTRAP_RELAY_HEADER]: token } },
    );
    next.on("error", () => {});
    next.once("unexpected-response", (request, response) => {
      resolve(response.statusCode!);
      response.destroy();
      request.destroy();
      next.terminate();
    });
  });
  assert.equal(denied, 401);
  assert.equal(f.dials(), 1);
});
test("connection limits reject excess work before dialing", async (t) => {
  const f = await fixture(t, { connections: 1 }),
    client = await f.open();
  await echo(client, randomBytes(32));
  assert.equal(await f.rejected(await f.token()), 503);
  assert.equal(f.dials(), 1);
  client.terminate();
  await closed(client);
  await drained(f.relay);
});
test("text messages terminate an admitted stream without replay or memory retention", async (t) => {
  const f = await fixture(t),
    client = await f.open();
  await echo(client, randomBytes(32));
  client.send(randomUUID());
  await closed(client);
  await drained(f.relay);
  assert.equal(f.dials(), 1);
});
test("header-only oversized frames are rejected before assembly while a healthy stream survives", async (t) => {
  const f = await fixture(t, {
    connections: 2,
    memoryBytes: 256 * 1024,
    connectionMemoryBytes: 128 * 1024,
  });
  const offender = await f.open(),
    healthy = await f.open();
  await echo(offender, randomBytes(32));
  await echo(healthy, randomBytes(200));
  const header = Buffer.alloc(14);
  header[0] = 0x82;
  header[1] = 0xff;
  header.writeBigUInt64BE(BigInt(BOOTSTRAP_RELAY_LIMITS.frameBytes + 1), 2);
  randomBytes(4).copy(header, 10);
  (offender as unknown as { _socket: Socket })._socket.write(header);
  await closed(offender);
  await echo(healthy, randomBytes(200));
  assert.equal(f.dials(), 2);
  assert.ok(f.relay.snapshot().memoryPeak <= 256 * 1024);
  healthy.terminate();
  await closed(healthy);
  await drained(f.relay);
});
test("tiny and zero-byte fragmented frames cannot retain an unbounded metadata queue", async (t) => {
  const f = await fixture(t, {
      memoryBytes: 256 * 1024,
      connectionMemoryBytes: 128 * 1024,
    }),
    client = await f.open();
  await echo(client, randomBytes(32));
  const fragments = Buffer.alloc(6 * 1024);
  for (let index = 0; index < 1024; index++) {
    fragments[index * 6] = index === 0 ? 0x02 : 0;
    fragments[index * 6 + 1] = 0x80;
    randomBytes(4).copy(fragments, index * 6 + 2);
  }
  (client as unknown as { _socket: Socket })._socket.write(fragments);
  await closed(client);
  await drained(f.relay);
  assert.ok(f.relay.snapshot().memoryPeak <= 256 * 1024);
  assert.equal(f.dials(), 1);
});
test("slow receiver backpressure retains bounded relay memory and shutdown cancels the one upstream", async (t) => {
  const f = await fixture(t),
    client = await f.open();
  await echo(client, randomBytes(32));
  client.pause();
  const socket = [...f.backendSockets][0]!;
  for (let index = 0; index < 32; index++)
    if (!socket.write(randomBytes(32 * 1024))) await once(socket, "drain");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(
    f.relay.snapshot().memoryPeak <= BOOTSTRAP_RELAY_LIMITS.memoryBytes,
  );
  client.resume();
  await f.relay.close();
  await closed(client);
  await drained(f.relay);
  assert.equal(f.dials(), 1);
});
test("the absolute session deadline cancels the admitted socket without redial", async (t) => {
  const original = globalThis.setTimeout;
  let deadline: (() => void) | undefined;
  t.mock.method(
    globalThis,
    "setTimeout",
    (
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 50) {
        deadline = () => callback(...args);
        return original(() => {}, 600000).unref();
      }
      return original(callback, ms, ...args);
    },
  );
  const f = await fixture(t, { sessionMs: 50 }),
    client = await f.open();
  await echo(client, randomBytes(32));
  assert.ok(deadline);
  deadline();
  await closed(client);
  await drained(f.relay);
  assert.equal(f.dials(), 1);
});
test("configuration and CLI reject private keys, unknown options and missing inputs without echoing canaries", async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as { privateKey: BootstrapCryptoKey; publicKey: BootstrapCryptoKey };
  assert.throws(() =>
    createBootstrapRelay({
      region: "eu-test",
      issuerRegion: "eu-test",
      host: address,
      port: 0,
      keys: new Map([["current", pair.privateKey]]),
      allowedTargetRegions: ["eu-test"],
    }),
  );
  await assert.rejects(readBootstrapRelayConfiguration({}));
  const canary = randomBytes(32).toString("base64url");
  const result = execFileSync(
    process.execPath,
    ["src/bootstrap-relay-main.ts", "--help"],
    { cwd: new URL("..", import.meta.url), timeout: 10000, encoding: "utf8" },
  );
  assert.ok(result.includes("PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS"));
  assert.equal(result.includes(canary), false);
  const publicKeys = {
    current: bytesToBase64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
  const environment = {
    PGCF_BOOTSTRAP_RELAY_REGION: "eu-test",
    PGCF_BOOTSTRAP_RELAY_ISSUER_REGION: "eu-test",
    PGCF_BOOTSTRAP_RELAY_HOST: address,
    PGCF_BOOTSTRAP_RELAY_PORT: "50001",
    PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS: JSON.stringify(publicKeys),
    PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS: JSON.stringify(["eu-test"]),
  };
  const configuration = await readBootstrapRelayConfiguration(environment);
  assert.equal(configuration.keys.get("current")!.type, "public");
  await assert.rejects(
    readBootstrapRelayConfiguration({
      ...environment,
      PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS: "[]",
    }),
  );
  await assert.rejects(
    readBootstrapRelayConfiguration({
      ...environment,
      PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS: JSON.stringify(["*"]),
    }),
  );
  const missing = { ...environment };
  delete (missing as Partial<typeof missing>)
    .PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS;
  await assert.rejects(readBootstrapRelayConfiguration(missing));
  await assert.rejects(
    readBootstrapRelayConfiguration({
      ...environment,
      PGCF_BOOTSTRAP_RELAY_ISSUER_REGION: "us-test",
    }),
  );
  await assert.rejects(
    readBootstrapRelayConfiguration({
      ...environment,
      PGCF_BOOTSTRAP_RELAY_PRIVATE_KEY: canary,
    }),
  );
  const failed = spawnSync(process.execPath, ["src/bootstrap-relay-main.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...environment,
      PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS: JSON.stringify({
        current: canary + "?",
      }),
    },
    timeout: 10000,
    encoding: "utf8",
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.deepEqual(JSON.parse(failed.stderr), {
    event: "bootstrap_relay_invalid_configuration",
  });
  assert.equal((failed.stdout + failed.stderr).includes(canary), false);
  const argument = spawnSync(
    process.execPath,
    ["src/bootstrap-relay-main.ts", canary],
    { cwd: new URL("..", import.meta.url), timeout: 10000, encoding: "utf8" },
  );
  assert.equal(argument.status, 1);
  assert.deepEqual(JSON.parse(argument.stderr), {
    event: "bootstrap_relay_invalid_arguments",
  });
  assert.equal(argument.stderr.includes(canary), false);
});

test("control-frame floods close only their admitted offender within the same memory bound", async (t) => {
  const f = await fixture(t, { connections: 2 }),
    offender = await f.open(),
    healthy = await f.open();
  await echo(offender, randomBytes(32));
  await echo(healthy, randomBytes(32));
  for (let index = 0; index <= BOOTSTRAP_RELAY_LIMITS.controlFrames; index++)
    offender.ping(Buffer.alloc(0));
  await closed(offender);
  await echo(healthy, randomBytes(200));
  assert.equal(f.dials(), 2);
  assert.ok(
    f.relay.snapshot().memoryPeak <= BOOTSTRAP_RELAY_LIMITS.memoryBytes,
  );
  healthy.terminate();
  await closed(healthy);
  await drained(f.relay);
});

test("an EU relay advertises explicit US permission and forwards only that signed target scope", async (t) => {
  const f = await fixture(t, { allowedTargetRegions: ["eu-test", "us-test"] });
  const identity = (await fetch(f.base + BOOTSTRAP_RELAY_IDENTITY_PATH).then(
    (response) => response.json(),
  )) as typeof f.relay.identity;
  assert.equal(identity.region, "eu-test");
  assert.equal(identity.issuer_region, "eu-test");
  assert.deepEqual(identity.allowed_target_regions, ["eu-test", "us-test"]);
  assert.deepEqual(identity.capabilities, [
    "rescue_ssh",
    "talos_api",
    "kubernetes_api",
  ]);
  const client = await f.open(
    await signBootstrapRelay({ ...f.input, region: "us-test" }),
  );
  await echo(client, randomBytes(200));
  assert.equal(f.dials(), 1);
  client.terminate();
  await closed(client);
  await drained(f.relay);
  assert.equal(
    await f.rejected(
      await signBootstrapRelay({ ...f.input, region: "ap-test" }),
    ),
    401,
  );
  assert.equal(
    await f.rejected(
      await signBootstrapRelay({
        ...f.input,
        region: "us-test",
        issuer_region: "us-test",
      }),
    ),
    401,
  );
  assert.equal(
    await f.rejected(
      await signBootstrapRelay({
        ...f.input,
        region: "us-test",
        relay_epoch: randomUUID(),
      }),
    ),
    401,
  );
  assert.equal(f.dials(), 1);
});
test("an EU-only relay refuses an unconfigured US target without contacting upstream", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.rejected(
      await signBootstrapRelay({ ...f.input, region: "us-test" }),
    ),
    401,
  );
  assert.equal(f.dials(), 0);
});
