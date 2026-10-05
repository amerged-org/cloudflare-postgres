// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { nodeAdditionHostname } from "@pgcf/contracts/nodes";
import type { Resource } from "../../../apps/regional/src/agent/types.ts";
import {
  authenticated,
  canonical,
  completedScan,
  execute,
  hash,
  signed,
  sourceControl,
  tcp,
  writeArtifact,
} from "../src/node-network-native.ts";
import type {
  ControlObservation,
  PortCompletion,
} from "../src/node-network-native.ts";
import {
  boundCapacity,
  firewallEvidence,
  parsePlan,
  verifyMeasurements,
  PREPARATION_DOMAIN,
  VERIFICATION_DOMAIN,
} from "../src/node-network-proof.ts";
import type {
  CommonConfig,
  Measurement,
  NetworkPlan,
} from "../src/node-network-proof.ts";
import { packetEvidence, wireguardPeers } from "../src/node-network-packets.ts";

const loopback = [127, 0, 0, 1].join(".");
const address = (last: number) => [198, 51, 100, last].join(".");
const ipv6 = (last: number) => ["2001", "db8", "", String(last)].join(":");
const providerId = () =>
  String(BigInt("0x" + randomBytes(6).toString("hex")) + 1n);
function keyring() {
  const keys = generateKeyPairSync("ed25519"),
    kid = "measurement";
  return {
    ...keys,
    kid,
    trusted: {
      [kid]: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
    },
  };
}
function fixture() {
  const keys = keyring(),
    at = Date.now(),
    node_id = newNodeId(),
    target = address(2),
    relay = address(3),
    source = address(4),
    control = address(5);
  const rules = {
    rules: {
      inbound: [
        {
          protocol: "tcp" as const,
          destPorts: ["22", "50000", "6443"],
          srcCidr: { ipv4: [relay + "/32"] },
          action: "accept" as const,
          status: "active" as const,
          displayName: "PGCF approved management",
        },
      ],
    },
  };
  const normalized = [
    {
      protocol: "tcp",
      destPorts: ["22", "50000", "6443"].sort(),
      srcCidr: { ipv4: [relay + "/32"], ipv6: [] },
      action: "accept",
      status: "active",
    },
  ];
  const plan: NetworkPlan = {
    version: 1,
    operation_id: newOperationId(),
    node_id,
    region_id: "eu-test",
    provider_instance_id: providerId(),
    intent_hash: hash(randomBytes(32).toString("hex")),
    operators: { ipv4: [], ipv6: [] },
    relay: {
      provider_instance_id: providerId(),
      addresses: { ipv4: [relay], ipv6: [] },
    },
    scan_control: { ipv4: control, ipv6: ipv6(5), port: 443 },
    members: [],
  };
  plan.members.push({
    node_id,
    provider_instance_id: plan.provider_instance_id,
    firewall_id: randomUUID(),
    addresses: { ipv4: [target], ipv6: [] },
    primary: { ipv4: [target], ipv6: [] },
    ownership_sha256: hash([randomUUID(), randomUUID()]),
    rules,
    rules_sha256: hash(normalized),
  });
  const config: CommonConfig = {
    plan,
    binding: {
      plan_sha256: hash(plan),
      readback_at: new Date(at - 1000).toISOString(),
      verification: null,
    },
    kid: keys.kid,
    measurement_keys: keys.trusted,
    control_keys: keys.trusted,
  };
  const before: ControlObservation = {
    address: control,
    port: 443,
    source,
    observed_at: new Date(at - 500).toISOString(),
    nonce: randomBytes(32).toString("hex"),
  };
  const after = {
    ...before,
    observed_at: new Date(at).toISOString(),
    nonce: randomBytes(32).toString("hex"),
  };
  const payload: Measurement = {
    purpose: "pgcf-node-measurement/v1",
    kind: "scan",
    binding_sha256: hash(config.binding),
    observed_at: new Date(at).toISOString(),
    family: "ipv4",
    source,
    scans: [
      {
        provider_instance_id: plan.provider_instance_id,
        address: target,
        protocol: "tcp",
        first_port: 1,
        last_port: 65535,
        scanned_ports: 65535,
        open_ports: [],
        started_at: new Date(at - 250).toISOString(),
        observed_at: new Date(at).toISOString(),
        before,
        after,
      },
    ],
  };
  return { keys, plan, config, payload, at, before, after };
}

test("complete native port completions require unique full coverage and bound adjacent controls", () => {
  const f = fixture(),
    results: PortCompletion[] = Array.from({ length: 65535 }, (_, index) => ({
      port: index + 1,
      outcome: "timed_out",
    }));
  const controls = { before: f.before, after: f.after },
    started = f.payload.kind === "scan" ? f.payload.scans[0]!.started_at : "";
  assert.equal(
    completedScan(results, controls, address(2), started).scanned_ports,
    65535,
  );
  assert.throws(
    () => completedScan(results.slice(1), controls, address(2), started),
    /scan_incomplete/,
  );
  results[0] = { port: 2, outcome: "refused" };
  assert.throws(
    () => completedScan(results, controls, address(2), started),
    /scan_incomplete/,
  );
  results[0] = { port: 1, outcome: "inconclusive" };
  assert.throws(
    () => completedScan(results, controls, address(2), started),
    /scan_incomplete/,
  );
  assert.throws(
    () =>
      completedScan(
        [],
        { before: { ...f.before, address: ipv6(5) }, after: f.after },
        address(2),
        started,
      ),
    /control_binding/,
  );
});

test("signed measurements reject stale, changed-plan, source-family and partial claims", () => {
  const f = fixture(),
    receipt = () =>
      signed(
        "pgcf-node-measurement/v1\n",
        f.payload,
        f.keys.kid,
        f.keys.privateKey,
      );
  assert.equal(verifyMeasurements(f.config, [receipt()], f.at).length, 1);
  assert.throws(
    () => verifyMeasurements(f.config, [receipt()], f.at + 130000),
    /stale_measurement/,
  );
  f.config.binding.plan_sha256 = hash(randomBytes(32).toString("hex"));
  assert.throws(
    () => verifyMeasurements(f.config, [receipt()], f.at),
    /plan_binding/,
  );
  f.config.binding.plan_sha256 = hash(f.plan);
  if (f.payload.kind !== "scan") assert.fail();
  f.payload.source = ipv6(4);
  assert.throws(
    () => verifyMeasurements(f.config, [receipt()], f.at),
    /family_mismatch/,
  );
  f.payload.source = address(4);
  f.payload.scans[0]!.scanned_ports = 65534 as 65535;
  assert.throws(
    () => verifyMeasurements(f.config, [receipt()], f.at),
    /scan_coverage/,
  );
});

test("canonical signatures match consumer domains and cannot cross purpose or survive tampering", () => {
  const keys = keyring(),
    payload = { z: [3, { b: 2, a: 1 }], a: randomUUID() };
  const envelope = signed(
    PREPARATION_DOMAIN,
    payload,
    keys.kid,
    keys.privateKey,
  );
  assert.deepEqual(
    authenticated(PREPARATION_DOMAIN, envelope, keys.trusted),
    payload,
  );
  assert.throws(
    () => authenticated(VERIFICATION_DOMAIN, envelope, keys.trusted),
    /signature_invalid/,
  );
  envelope.payload.z[0] = 4;
  assert.throws(
    () => authenticated(PREPARATION_DOMAIN, envelope, keys.trusted),
    /signature_invalid/,
  );
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("operator plan binds exact canonical hash and unique current identities", () => {
  const f = fixture();
  assert.equal(parsePlan(f.plan, hash(f.plan)), f.plan);
  assert.throws(() => parsePlan(f.plan, hash(randomUUID())), /plan_binding/);
  f.plan.members.push(structuredClone(f.plan.members[0]!));
  assert.throws(() => parsePlan(f.plan, hash(f.plan)), /duplicate_member/);
});

test("firewall proof uses exact attached ownership and normalized current rules", () => {
  const f = fixture(),
    member = f.plan.members[0]!,
    tenantId = randomUUID(),
    customerId = randomUUID();
  member.ownership_sha256 = hash([tenantId, customerId]);
  const firewall = {
    firewallId: member.firewall_id,
    tenantId,
    customerId,
    status: "active",
    rules: {
      inbound: [
        ...member.rules.rules.inbound,
        {
          protocol: "",
          destPorts: [],
          srcCidr: { ipv4: [], ipv6: [] },
          action: "drop",
          status: "active",
        },
      ],
    },
    instances: [
      {
        instanceId: member.provider_instance_id,
        ipConfig: { v4: { ip: member.primary.ipv4[0]! }, v6: { ip: "" } },
      },
    ],
    instanceStatus: [{ instanceId: member.provider_instance_id, status: "ok" }],
  } as unknown as import("../../../apps/api/src/providers/contabo.ts").ContaboFirewall;
  assert.equal(
    firewallEvidence(f.plan, [firewall])[0]!.rules_sha256,
    member.rules_sha256,
  );
  firewall.rules.inbound[0]!.destPorts = ["5432"];
  assert.throws(
    () => firewallEvidence(f.plan, [firewall]),
    /firewall_readback_changed/,
  );
});

test("native sockets and source controls use actual same-family peer observations", async () => {
  const keys = keyring(),
    server = createServer((socket) => {
      let nonce = "";
      socket.on("data", (bytes) => {
        nonce += bytes.toString("utf8");
        if (!nonce.endsWith("\n")) return;
        const payload = {
          address: socket.localAddress!,
          port: socket.localPort!,
          source: socket.remoteAddress!,
          observed_at: new Date().toISOString(),
          nonce: nonce.trim(),
        };
        socket.end(
          canonical(
            signed(
              "pgcf-node-source-control/v1\n",
              payload,
              keys.kid,
              keys.privateKey,
            ),
          ) + "\n",
        );
      });
      socket.on("error", () => socket.destroy());
    });
  server.listen(0, loopback);
  await once(server, "listening");
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    assert.equal(
      (
        await sourceControl(
          loopback,
          port,
          loopback,
          keys.trusted,
          Date.now() + 10000,
        )
      ).source,
      loopback,
    );
    assert.equal(
      await tcp(loopback, port, loopback, 1000, Date.now() + 10000),
      "connected",
    );
    await assert.rejects(
      sourceControl(loopback, port, ipv6(4), keys.trusted, Date.now() + 10000),
      /family_mismatch/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reviewed process bytes are pinned and private artifact outputs are exclusive mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-network-test-"));
  try {
    const program = process.execPath,
      digest = createHash("sha256")
        .update(await readFile(program))
        .digest("hex");
    const command = {
      program,
      sha256: digest,
      args: ["-e", "process.stdout.write('measured')"],
    };
    assert.equal(
      (await execute(command, Date.now() + 10000)).stdout.toString(),
      "measured",
    );
    await assert.rejects(
      execute({ ...command, sha256: hash(randomUUID()) }, Date.now() + 10000),
      /command_digest_changed/,
    );
    const path = join(directory, "proof.json");
    await writeArtifact(path, { measured: true });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(writeArtifact(path, { measured: false }), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WireGuard binds actual peer keys/endpoints and recent handshakes, with honest singleton zero", () => {
  const at = new Date().toISOString(),
    device = "cilium_wg0",
    peer = {
      node_id: newNodeId(),
      provider_instance_id: providerId(),
      address: address(6),
    },
    key = randomBytes(32).toString("base64");
  const endpoints = `${device}\t${key}\t${peer.address}:51871\n`,
    recent = `${device}\t${key}\t${Math.floor(Date.now() / 1000)}\n`;
  assert.equal(
    wireguardPeers(device, endpoints, recent, device, [peer], at)[0]!
      .public_key,
    key,
  );
  assert.throws(
    () =>
      wireguardPeers(
        device,
        endpoints,
        `${device}\t${key}\t1\n`,
        device,
        [peer],
        at,
      ),
    /handshake_stale/,
  );
  assert.throws(
    () => wireguardPeers(device, endpoints, recent, device, [], at),
    /peer_set/,
  );
  assert.deepEqual(wireguardPeers(device, "", "", device, [], at), []);
});

function pcap(
  source: string,
  destination: string,
  at: number,
  plaintext = false,
) {
  const frame = Buffer.alloc(14 + 20 + 8 + 32);
  frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45;
  frame.writeUInt16BE(frame.length - 14, 16);
  frame[23] = 17;
  source
    .split(".")
    .map(Number)
    .forEach((byte, index) => (frame[26 + index] = byte));
  destination
    .split(".")
    .map(Number)
    .forEach((byte, index) => (frame[30 + index] = byte));
  frame.writeUInt16BE(plaintext ? 5432 : 51871, 34);
  frame.writeUInt16BE(plaintext ? 5432 : 51871, 36);
  frame.writeUInt16BE(40, 38);
  frame.writeUInt32LE(4, 42);
  const global = Buffer.alloc(24),
    record = Buffer.alloc(16);
  global.writeUInt32LE(0xa1b2c3d4);
  global.writeUInt16LE(2, 4);
  global.writeUInt16LE(4, 6);
  global.writeUInt32LE(65535, 16);
  global.writeUInt32LE(1, 20);
  record.writeUInt32LE(Math.floor(at / 1000));
  record.writeUInt32LE((at % 1000) * 1000, 4);
  record.writeUInt32LE(frame.length, 8);
  record.writeUInt32LE(frame.length, 12);
  return Buffer.concat([global, record, frame]);
}
test("packet evidence counts actual complete WireGuard records and refuses drops/plaintext/truncation", () => {
  const at = Date.now(),
    source = address(2),
    peer = {
      node_id: newNodeId(),
      provider_instance_id: providerId(),
      address: address(6),
    },
    pod = address(7),
    start = new Date(at - 1000).toISOString(),
    end = new Date(at + 1000).toISOString();
  const bytes = pcap(source, peer.address, at),
    stats =
      "1 packet captured\n1 packet received by filter\n0 packets dropped by kernel\n";
  assert.equal(
    packetEvidence(bytes, stats, source, [peer], [pod], start, end)[0]!
      .encrypted_packets,
    1,
  );
  assert.throws(
    () =>
      packetEvidence(
        bytes.subarray(0, -1),
        stats,
        source,
        [peer],
        [pod],
        start,
        end,
      ),
    /capture_truncated/,
  );
  assert.throws(
    () =>
      packetEvidence(
        bytes,
        stats.replace("0 packets", "1 packet"),
        source,
        [peer],
        [pod],
        start,
        end,
      ),
    /capture_loss/,
  );
  assert.throws(
    () =>
      packetEvidence(
        pcap(pod, peer.address, at, true),
        stats,
        source,
        [peer],
        [pod],
        start,
        end,
      ),
    /plaintext_pod_traffic/,
  );
});

test("unencrypted VXLAN Pod packets cannot hide inside a public-address capture", () => {
  const at = Date.now(),
    source = address(2),
    pod = address(7),
    peer = {
      node_id: newNodeId(),
      provider_instance_id: providerId(),
      address: address(6),
    };
  const encrypted = pcap(source, peer.address, at),
    inner = pcap(pod, address(8), at, true).subarray(40);
  const outer = Buffer.alloc(14 + 20 + 8 + 8 + inner.length);
  encrypted.subarray(40, 74).copy(outer);
  outer.writeUInt16BE(outer.length - 14, 16);
  outer.writeUInt16BE(8472, 34);
  outer.writeUInt16BE(8472, 36);
  outer.writeUInt16BE(outer.length - 34, 38);
  outer[42] = 8;
  inner.copy(outer, 50);
  const record = Buffer.from(encrypted.subarray(24, 40));
  record.writeUInt32LE(outer.length, 8);
  record.writeUInt32LE(outer.length, 12);
  const bytes = Buffer.concat([encrypted, record, outer]);
  assert.throws(
    () =>
      packetEvidence(
        bytes,
        "2 packets captured\n2 packets received by filter\n0 packets dropped by kernel\n",
        source,
        [peer],
        [pod],
        new Date(at - 1000).toISOString(),
        new Date(at + 1000).toISOString(),
      ),
    /plaintext_pod_traffic/,
  );
});

test("postjoin capacity requires bound cluster/node/revision, quarantine and real headroom", () => {
  const f = fixture(),
    binding = {
      input_hash: hash(randomUUID()),
      checkpoint_reference: randomUUID(),
      cluster_uid: randomUUID(),
      node_uid: randomUUID(),
      node_resource_version: "12",
      hostname: nodeAdditionHostname(f.plan.node_id),
    };
  f.config.binding.verification = binding;
  const namespace: Resource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system", uid: binding.cluster_uid },
  };
  const node: Resource = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: binding.hostname,
      uid: binding.node_uid,
      resourceVersion: binding.node_resource_version,
      labels: {
        "pgcf.io/node-id": f.plan.node_id,
        "pgcf.io/provider-instance-id": f.plan.provider_instance_id,
      },
      annotations: { "pgcf.io/storage-gib-total": "95" },
    },
    spec: {
      taints: [
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      allocatable: { cpu: "3", memory: "6Gi" },
    },
  };
  assert.equal(
    boundCapacity(f.config, namespace, node, [], []).allocatable_cpu_millicores,
    3000,
  );
  node.metadata.resourceVersion = "13";
  assert.throws(
    () => boundCapacity(f.config, namespace, node, [], []),
    /kubernetes_binding/,
  );
  node.metadata.resourceVersion = "12";
  node.metadata.annotations = {};
  assert.throws(
    () => boundCapacity(f.config, namespace, node, [], []),
    /capacity_unavailable/,
  );
});
