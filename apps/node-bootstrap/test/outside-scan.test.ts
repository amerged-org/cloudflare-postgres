// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import https from "node:https";
import { test, type TestContext } from "node:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import {
  hash,
  signed,
  HTTPS_CONTROL_DOMAIN,
} from "../../../scripts/e2e/src/node-network-native.ts";
import {
  scanOutsideFamily,
  probeOutsideTcp,
  type OutsideScanInput,
} from "../src/outside-scan.ts";
import { runOutsideScanCommand } from "../src/outside-scan-command.ts";
import { proofExecutionFixture } from "./node-proof.fixture.ts";
import { validateProofExecution } from "../src/proof-proxy-command.ts";

function fixture(family: "ipv4" | "ipv6" = "ipv4") {
  const keys = generateKeyPairSync("ed25519"),
    node = newNodeId(),
    operation = newOperationId();
  const addresses = { ipv4: ["192.0.2.2"], ipv6: ["2001:db8:3::2"] };
  const plan: OutsideScanInput["plan"] = {
    version: 1,
    operation_id: operation,
    node_id: node,
    region_id: "region-dev",
    provider_instance_id: "17",
    intent_hash: hash(randomUUID()),
    operators: { ipv4: ["198.51.100.20/32"], ipv6: ["2001:db8:2::20/128"] },
    relay: {
      provider_instance_id: "18",
      addresses: { ipv4: ["192.0.2.3"], ipv6: ["2001:db8:3::3"] },
    },
    scan_control: { ipv4: "192.0.2.40", ipv6: "2001:db8:2::40", port: 443 },
    members: [
      {
        node_id: node,
        provider_instance_id: "17",
        firewall_id: randomUUID(),
        addresses,
        primary: addresses,
        ownership_sha256: hash(randomUUID()),
        rules: {
          rules: {
            inbound: [
              {
                protocol: "tcp",
                destPorts: ["22", "50000", "6443"],
                srcCidr: {
                  ipv4: ["192.0.2.3/32"],
                  ipv6: ["2001:db8:3::3/128"],
                },
                action: "accept",
                status: "active",
                displayName: "fixture",
              },
            ],
          },
        },
        rules_sha256: hash(randomUUID()),
      },
    ],
  };
  const input: OutsideScanInput = {
    plan,
    binding: {
      plan_sha256: hash(plan),
      readback_at: new Date(Date.now() - 1000).toISOString(),
      verification: null,
    },
    family,
    control_keys: {
      control: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
    },
    https_control: {
      origin: "https://source-control.invalid",
      bearer: randomBytes(32).toString("base64url"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    local_source: family === "ipv4" ? "10.0.0.7" : "2001:db8:1::99",
    source_pool: family === "ipv4" ? ["203.0.113.0/24"] : undefined,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    input,
    keys,
    publicSource: family === "ipv4" ? "203.0.113.99" : input.local_source!,
  };
}
function nativeFixture(
  t: TestContext,
  f: ReturnType<typeof fixture>,
  options: {
    error?: string;
    openPort?: number;
    source?: string;
    afterChanged?: boolean;
    reconnectControl?: boolean;
    unauthorizedControl?: boolean;
    onProbe?: (count: number) => void;
  } = {},
) {
  let probes = 0,
    controls = 0,
    active = 0,
    maximum = 0;
  const ports = new Set<number>();
  const socket = {
    authorized: true,
    localAddress: f.input.direct_source ?? f.input.local_source,
    remoteAddress: f.input.plan.scan_control[f.input.family],
    remotePort: 443,
  };
  t.mock.method(
    https,
    "request",
    (...args: Parameters<typeof https.request>) => {
      const request = new EventEmitter();
      const headers = (
        args[0] as unknown as { headers: Record<string, string> }
      ).headers;
      assert.equal(
        headers.Authorization,
        `Bearer ${f.input.https_control!.bearer}`,
      );
      return Object.assign(request, {
        destroy: () => request,
        end: (body: string) => {
          const nonce = JSON.parse(body).nonce;
          queueMicrotask(() => {
            controls++;
            const response = Object.assign(new EventEmitter(), {
              statusCode: 200,
              socket: options.reconnectControl
                ? { ...socket, authorized: !options.unauthorizedControl }
                : socket,
              destroy: () => {},
            });
            const source =
              options.afterChanged && controls % 2 === 0
                ? "203.0.113.100"
                : (options.source ?? f.publicSource);
            const receipt = signed(
              HTTPS_CONTROL_DOMAIN,
              {
                nonce,
                source,
                origin: f.input.https_control!.origin,
                observed_at: new Date(Date.now() + 30).toISOString(),
              },
              "control",
              f.keys.privateKey,
            );
            request.emit("response", response);
            response.emit("data", Buffer.from(JSON.stringify(receipt)));
            response.emit("end");
          });
        },
      }) as unknown as ReturnType<typeof https.request>;
    },
  );
  t.mock.method(
    net,
    "createConnection",
    (...args: Parameters<typeof net.createConnection>) => {
      const target = args[0] as unknown as net.NetConnectOpts & {
        host: string;
        port: number;
        localAddress: string;
      };
      assert.equal(
        target.host,
        f.input.plan.members[0]!.addresses[f.input.family][0],
      );
      assert.equal(
        target.localAddress,
        f.input.direct_source ?? f.input.local_source,
      );
      probes++;
      ports.add(target.port);
      active++;
      maximum = Math.max(maximum, active);
      const peer = new EventEmitter();
      let closed = false;
      const result = Object.assign(peer, {
        localAddress: target.localAddress,
        remoteAddress: target.host,
        remotePort: target.port,
        destroy: () => {
          if (!closed) {
            closed = true;
            active--;
            queueMicrotask(() => peer.emit("close"));
          }
          return result;
        },
        setTimeout: () => result,
      });
      queueMicrotask(() => {
        if (target.port === options.openPort) peer.emit("connect");
        else
          peer.emit(
            "error",
            Object.assign(new Error("fixture_socket_error"), {
              code: options.error ?? "ECONNREFUSED",
            }),
          );
      });
      options.onProbe?.(probes);
      return result as unknown as net.Socket;
    },
  );
  return {
    ports,
    probes: () => probes,
    controls: () => controls,
    maximum: () => maximum,
    active: () => active,
  };
}

test("a real signed proof session can authorize the HTTPS source control before a complete scan", async (t) => {
  const f = fixture(),
    session = proofExecutionFixture();
  session.input.claims.origin = f.input.https_control!.origin;
  session.input.api_base_url = session.input.claims.origin;
  session.resign();
  const issued = validateProofExecution(session.input);
  assert.ok(issued.session_bearer.length > 256);
  assert.ok(issued.session_bearer.length <= 4096);
  f.input.https_control!.bearer = issued.session_bearer;
  f.input.https_control!.expires_at = issued.claims.expires_at;
  const state = nativeFixture(t, f);
  const result = await scanOutsideFamily(f.input, { concurrency: 32 });
  assert.equal(state.probes(), 65535);
  assert.equal(result.scans[0]!.scanned_ports, 65535);
  assert.equal(JSON.stringify(result).includes(issued.session_bearer), false);
});
test("oversized legacy bearers and malformed or oversized proof tokens still fail before any control request or target probe", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f);
  f.input.https_control!.bearer = "a".repeat(257);
  await assert.rejects(
    scanOutsideFamily(f.input),
    /outside_scan_control_invalid/,
  );
  f.input.https_control!.bearer = `np1.${"a".repeat(257)}!.signature`;
  await assert.rejects(
    scanOutsideFamily(f.input),
    /outside_scan_control_invalid/,
  );
  f.input.https_control!.bearer = `np1.${"a".repeat(4096)}.signature`;
  await assert.rejects(
    scanOutsideFamily(f.input),
    /outside_scan_control_invalid/,
  );
  assert.equal(state.controls(), 0);
  assert.equal(state.probes(), 0);
});

test("scans every TCP port exactly once from the bound source with verified fresh controls and bounded sockets", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f);
  const result = await scanOutsideFamily(f.input, {
    concurrency: 32,
    timeoutMs: 50,
  });
  assert.equal(state.probes(), 65535);
  assert.equal(state.ports.size, 65535);
  assert.ok(state.maximum() <= 32);
  assert.equal(state.active(), 0);
  assert.equal(result.binding_sha256, hash(f.input.binding));
  assert.equal(result.source, f.publicSource);
  assert.equal(result.scans[0]!.scanned_ports, 65535);
  assert.deepEqual(result.scans[0]!.open_ports, []);
  assert.ok(result.scans[0]!.before.observed_at <= result.scans[0]!.started_at);
  assert.notEqual(result.scans[0]!.before.nonce, result.scans[0]!.after.nonce);
  assert.ok(state.controls() >= 2);
});

test("peer-closed HTTPS controls may reconnect while preserving fresh signed source and TLS identity", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f, { reconnectControl: true });
  const result = await scanOutsideFamily(f.input, {
    concurrency: 32,
    timeoutMs: 50,
  });
  assert.equal(state.probes(), 65535);
  assert.ok(state.controls() >= 2);
  assert.equal(result.source, f.publicSource);
  assert.notEqual(result.scans[0]!.before.nonce, result.scans[0]!.after.nonce);
});

test("a reconnected control still rejects invalid TLS authorization", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f, {
      reconnectControl: true,
      unauthorizedControl: true,
    });
  await assert.rejects(
    scanOutsideFamily(f.input),
    /outside_scan_control_session_changed/,
  );
  assert.equal(state.probes(), 0);
});

test("a reconnected control cannot change its verified public source", async (t) => {
  const f = fixture();
  nativeFixture(t, f, { reconnectControl: true, afterChanged: true });
  await assert.rejects(
    scanOutsideFamily(f.input),
    /outside_scan_source_changed/,
  );
});

test("unsupported IPv6 is a capability gap, never 65,535 closed ports", async (t) => {
  const f = fixture("ipv6"),
    state = nativeFixture(t, f, { error: "ENETUNREACH" });
  await assert.rejects(
    scanOutsideFamily(f.input, { concurrency: 8 }),
    /outside_scan_capability_gap_ipv6_enetunreach/,
  );
  assert.ok(state.probes() < 65535);
  assert.equal(state.active(), 0);
});

test("an actual connected target port remains open evidence in the complete report", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f, { openPort: 5432 });
  const result = await scanOutsideFamily(f.input, { concurrency: 32 });
  assert.equal(state.probes(), 65535);
  assert.deepEqual(result.scans[0]!.open_ports, [5432]);
});

test("a direct public source requires matching native and signed control addresses, without inventing a NAT /32", async (t) => {
  const f = fixture();
  f.input.direct_source = "203.0.113.99";
  delete f.input.local_source;
  delete f.input.source_pool;
  const state = nativeFixture(t, f);
  assert.equal(
    (await scanOutsideFamily(f.input, { concurrency: 16 })).source,
    f.input.direct_source,
  );
  assert.equal(state.probes(), 65535);
  const mismatch = { ...f.input, direct_source: "203.0.113.100" };
  await assert.rejects(
    scanOutsideFamily(mismatch),
    /outside_scan_source_unproven/,
  );
});

test("missing NAT scope, an allowed source and a changed control cannot authorize a completed scan", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f, { afterChanged: true });
  await assert.rejects(
    scanOutsideFamily({ ...f.input, source_pool: undefined }),
    /outside_scan_source_pool_unproven/,
  );
  assert.equal(state.probes(), 0);
  await assert.rejects(
    scanOutsideFamily({
      ...f.input,
      source_pool: [...f.input.source_pool!, "192.0.2.0/24"],
    }),
    /outside_scan_source_pool_unproven/,
  );
  assert.equal(state.probes(), 0);
  await assert.rejects(
    scanOutsideFamily(f.input, { concurrency: 16 }),
    /outside_scan_source_changed/,
  );
  assert.equal(state.active(), 0);
});

test("cancellation and a changed plan stop before sending target probes", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f);
  await assert.rejects(
    scanOutsideFamily(f.input, { signal: AbortSignal.abort() }),
    /outside_scan_cancelled/,
  );
  const changed = structuredClone(f.input);
  changed.plan.members[0]!.addresses.ipv4 = ["192.0.2.200"];
  await assert.rejects(scanOutsideFamily(changed), /outside_scan_plan_binding/);
  const incomplete = structuredClone(f.input);
  delete (incomplete.binding as Partial<typeof incomplete.binding>)
    .verification;
  await assert.rejects(
    scanOutsideFamily(incomplete),
    /outside_scan_plan_binding/,
  );
  assert.equal(state.probes(), 0);
});

test("loss of the signed control heartbeat cancels active probes instead of returning closed ports", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(),
    state = nativeFixture(t, f, {
      afterChanged: true,
      onProbe: (count) => {
        if (count === 1024) t.mock.timers.tick(20_000);
      },
    });
  await assert.rejects(
    scanOutsideFamily(f.input, { concurrency: 32 }),
    /outside_scan_source_changed/,
  );
  assert.ok(state.probes() < 65535);
  assert.equal(state.active(), 0);
});

test("mid-scan caller cancellation closes every active socket and returns no partial report", async (t) => {
  const f = fixture(),
    abort = new AbortController(),
    state = nativeFixture(t, f, {
      onProbe: (count) => {
        if (count === 1024) abort.abort();
      },
    });
  await assert.rejects(
    scanOutsideFamily(f.input, { concurrency: 32, signal: abort.signal }),
    /outside_scan_cancelled/,
  );
  assert.ok(state.probes() < 65535);
  assert.equal(state.active(), 0);
});

test("private-file CLI returns only the unsigned measured receipt and rejects private-source or signing-key input", async (t) => {
  const f = fixture(),
    state = nativeFixture(t, f),
    directory = await mkdtemp(join(tmpdir(), "pgcf-outside-command-")),
    path = join(directory, "input.json");
  try {
    await writeFile(path, JSON.stringify({ input: f.input }), { mode: 0o600 });
    const result = await runOutsideScanCommand([path], { concurrency: 32 });
    assert.equal(result.kind, "scan");
    assert.equal(state.probes(), 65535);
    assert.equal(
      JSON.stringify(result).includes(f.input.https_control!.bearer),
      false,
    );
    assert.equal("signature" in result, false);
    await assert.rejects(
      scanOutsideFamily({
        ...f.input,
        direct_source: "10.0.0.7",
        source_pool: undefined,
      }),
      /outside_scan_source_not_public/,
    );
    await writeFile(
      path,
      JSON.stringify({ input: f.input, signing: { kid: "unneeded" } }),
      { mode: 0o600 },
    );
    await assert.rejects(
      runOutsideScanCommand([path]),
      /outside_scan_command_input_invalid/,
    );
    await chmod(path, 0o644);
    await assert.rejects(
      runOutsideScanCommand([path]),
      /outside_scan_command_input_invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the native TCP primitive measures actual local owned IPv4 and IPv6 listener connections", async () => {
  const ipv4 = net.createServer((socket) => socket.destroy());
  ipv4.listen(0, "127.0.0.1");
  await once(ipv4, "listening");
  const a4 = ipv4.address();
  assert.ok(a4 && typeof a4 !== "string");
  try {
    assert.equal(
      await probeOutsideTcp({
        address: "127.0.0.1",
        source: "127.0.0.1",
        port: a4.port,
        timeout_ms: 1000,
        deadline_at: new Date(Date.now() + 3000).toISOString(),
      }),
      "connected",
    );
  } finally {
    await new Promise<void>((resolve) => ipv4.close(() => resolve()));
  }
  const ipv6 = net.createServer((socket) => socket.destroy());
  ipv6.listen({ host: "::1", port: 0, ipv6Only: true });
  await once(ipv6, "listening");
  const a6 = ipv6.address();
  assert.ok(a6 && typeof a6 !== "string");
  try {
    assert.equal(
      await probeOutsideTcp({
        address: "::1",
        source: "::1",
        port: a6.port,
        timeout_ms: 1000,
        deadline_at: new Date(Date.now() + 3000).toISOString(),
      }),
      "connected",
    );
  } finally {
    await new Promise<void>((resolve) => ipv6.close(() => resolve()));
  }
});
