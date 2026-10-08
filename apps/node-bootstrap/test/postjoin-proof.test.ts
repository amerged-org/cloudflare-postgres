// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  ciliumWireguardPeers,
  postjoinProofObjects,
  collectPostjoinProof,
  POSTJOIN_CAPTURE_IMAGE,
  postjoinCaptureScript,
  type PostjoinProofCommands,
  type PostjoinProofOwnership,
} from "../src/postjoin-proof.ts";
import { fixture } from "./fixture.ts";
import { canonical, digest } from "../src/bootstrap.ts";
import type { NodeJoinBundle } from "@pgcf/contracts/node-bootstrap";
import type { NetworkPlan } from "../../../scripts/e2e/src/node-network-proof.ts";

test("actual single-node Cilium Wireguard spelling preserves zero-peer validation", () => {
  const actual = debug([]);
  actual["cilium-status"].encryption.mode = "Wireguard";
  assert.deepEqual(
    ciliumWireguardPeers(actual, [], new Date().toISOString(), []),
    [],
  );
});

const key = () => randomBytes(32).toString("base64");
function debug(peers: unknown[], publicKey = key()) {
  return {
    "cilium-status": { encryption: { mode: "wireguard" } },
    encryption: {
      wireguard: {
        interfaces: [
          {
            name: "cilium_wg0",
            "listen-port": 51871,
            "public-key": publicKey,
            "peer-count": peers.length,
            peers,
          },
        ],
      },
    },
  };
}
test("Cilium peer proof uses actual debuginfo fields and retains its millisecond handshake", () => {
  const publicKey = key(),
    at = new Date().toISOString();
  const expected = [
    {
      node_id: fixture().spec.node_id,
      provider_instance_id: "91",
      address: "192.0.2.91",
    },
  ];
  const result = ciliumWireguardPeers(
    debug([
      {
        endpoint: "192.0.2.91:51871",
        "public-key": publicKey,
        "last-handshake-time": at,
      },
    ]),
    expected,
    at,
    [publicKey],
  );
  assert.equal(result[0]!.public_key, publicKey);
  assert.equal(result[0]!.last_handshake_at, at);
  assert.throws(
    () => ciliumWireguardPeers(debug([]), expected, at, [publicKey]),
    /peer_set/,
  );
  assert.throws(
    () =>
      ciliumWireguardPeers(
        debug([
          {
            endpoint: "192.0.2.91:51871",
            "public-key": key(),
            "last-handshake-time": at,
          },
        ]),
        expected,
        at,
        [publicKey],
      ),
    /public_key_binding/,
  );
});
test("missing peer arrays, epoch-number handshakes and zero Go time never become empty or fresh proof", () => {
  const at = new Date().toISOString(),
    empty = debug([]);
  delete (empty.encryption.wireguard.interfaces[0] as { peers?: unknown[] })
    .peers;
  assert.throws(() => ciliumWireguardPeers(empty, [], at, []), /readback/);
  for (const stamp of [Date.now(), "0001-01-01T00:00:00.000Z"]) {
    const publicKey = key(),
      peer = {
        node_id: fixture().spec.node_id,
        provider_instance_id: "92",
        address: "192.0.2.92",
      };
    assert.throws(
      () =>
        ciliumWireguardPeers(
          debug([
            {
              endpoint: "192.0.2.92:51871",
              "public-key": publicKey,
              "last-handshake-time": stamp,
            },
          ]),
          [peer],
          at,
          [publicKey],
        ),
      /handshake/,
    );
  }
});
function caseFixture() {
  const input = fixture(),
    clusterUid = randomUUID(),
    nodeUid = randomUUID();
  const bundle: NodeJoinBundle = {
    version: 1,
    cluster_name: input.spec.cluster_name,
    cluster_endpoint: input.spec.cluster_endpoint,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    talos_machine_secrets_yaml: "fixture material",
    talos_admin_config: "fixture material",
    kube_system_uid: clusterUid,
    kubeconfig: "fixture kubeconfig",
  };
  const member = {
    node_id: input.spec.node_id,
    provider_instance_id: input.spec.provider_instance_id,
    firewall_id: randomUUID(),
    addresses: { ipv4: [input.spec.hardware.ipv4], ipv6: [] },
    primary: { ipv4: [input.spec.hardware.ipv4], ipv6: [] },
    ownership_sha256: digest(randomUUID()),
    rules: { rules: { inbound: [] } },
    rules_sha256: digest(randomUUID()),
  };
  const plan: NetworkPlan = {
    version: 1,
    operation_id: input.spec.operation_id,
    node_id: input.spec.node_id,
    provider_instance_id: input.spec.provider_instance_id,
    region_id: input.spec.region_id,
    intent_hash: digest(randomUUID()),
    operators: { ipv4: [], ipv6: [] },
    relay: {
      provider_instance_id: "99",
      addresses: { ipv4: ["192.0.2.99"], ipv6: [] },
    },
    scan_control: { ipv4: "192.0.2.40", ipv6: "2001:db8::40", port: 443 },
    members: [member],
  };
  const node = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: input.spec.hostname,
      uid: nodeUid,
      resourceVersion: "19",
      labels: {
        "pgcf.io/node-id": input.spec.node_id,
        "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
        "pgcf.io/region": input.spec.region_id,
      },
      annotations: {
        "pgcf.io/storage-gib-total": "95",
        "pgcf.io/storage-proof": digest(randomUUID()),
      },
    },
    spec: {
      taints: [
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      addresses: [{ type: "InternalIP", address: input.spec.hardware.ipv4 }],
      allocatable: { cpu: "2", memory: "4Gi" },
    },
  };
  const ns = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system", uid: clusterUid, resourceVersion: "3" },
    status: { phase: "Active" },
  };
  const publicKey = key(),
    ciliumPodUid = randomUUID();
  const commandsSeen: string[][] = [];
  let targetReads = 0;
  const commands: PostjoinProofCommands = {
    authorize: async () => {},
    readOwnership: async () => null,
    saveOwnership: async () => {},
    capture: async () => {
      throw new Error("singleton capture forbidden");
    },
    kube: async (args) => {
      commandsSeen.push(args);
      let value: unknown;
      if (args[0] === "get" && args[1] === "namespace") value = ns;
      else if (args[0] === "get" && args[1] === "nodes")
        value = { items: [node] };
      else if (args[0] === "get" && args[1] === "node") {
        targetReads++;
        value = node;
      } else if (args[0] === "get" && args[1] === "ciliumnode")
        value = {
          metadata: {
            name: input.spec.hostname,
            uid: randomUUID(),
            resourceVersion: "1",
            annotations: { "network.cilium.io/wg-pub-key": publicKey },
            ownerReferences: [
              { kind: "Node", name: input.spec.hostname, uid: nodeUid },
            ],
          },
        };
      else if (args[0] === "get" && args[1] === "pods")
        value = {
          items: [
            {
              metadata: {
                name: "cilium-target",
                uid: ciliumPodUid,
                resourceVersion: "1",
                namespace: "kube-system",
                labels: { "k8s-app": "cilium" },
              },
              spec: { nodeName: input.spec.hostname },
              status: {
                phase: "Running",
                conditions: [{ type: "Ready", status: "True" }],
                containerStatuses: [{ name: "cilium-agent", ready: true }],
              },
            },
          ],
        };
      else if (args[0] === "exec") value = debug([], publicKey);
      else throw new Error(`Unexpected reviewed command ${args[0]} ${args[1]}`);
      return { exit_code: 0, stdout: JSON.stringify(value) };
    },
  };
  return {
    input,
    bundle,
    plan,
    node,
    ns,
    nodeUid,
    commands,
    commandsSeen,
    targetReads: () => targetReads,
  };
}
type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;
function captureBytes(source: string, destination: string, plaintext = false) {
  const frame = Buffer.alloc(14 + 20 + 8 + 32);
  frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45;
  frame.writeUInt16BE(frame.length - 14, 16);
  frame[23] = 17;
  Buffer.from(source.split(".").map(Number)).copy(frame, 26);
  Buffer.from(destination.split(".").map(Number)).copy(frame, 30);
  frame.writeUInt16BE(51871, 34);
  frame.writeUInt16BE(51871, 36);
  frame.writeUInt16BE(40, 38);
  frame.writeUInt32LE(4, 42);
  if (plaintext) Buffer.from([10, 42, 0, 1]).copy(frame, 26);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(1, 20);
  const record = Buffer.alloc(16);
  const at = Date.now();
  record.writeUInt32LE(Math.floor(at / 1000), 0);
  record.writeUInt32LE((at % 1000) * 1000, 4);
  record.writeUInt32LE(frame.length, 8);
  record.writeUInt32LE(frame.length, 12);
  return Buffer.concat([header, record, frame]);
}
function dualFixture(
  options: {
    plaintext?: boolean;
    dropped?: boolean;
    foreign?: boolean;
    loseCreateReply?: boolean;
    cancelOnTraffic?: boolean;
  } = {},
) {
  const f = caseFixture(),
    peerInput = fixture(),
    peerNode = structuredClone(f.node),
    peerUid = randomUUID(),
    peerKey = key(),
    targetKey = key();
  peerNode.metadata.name = peerInput.spec.hostname;
  peerNode.metadata.uid = peerUid;
  peerNode.metadata.labels["pgcf.io/node-id"] = peerInput.spec.node_id;
  peerNode.metadata.labels["pgcf.io/provider-instance-id"] =
    peerInput.spec.provider_instance_id;
  peerNode.status.addresses[0]!.address = "192.0.2.92";
  f.plan.members.push({
    ...structuredClone(f.plan.members[0]!),
    node_id: peerInput.spec.node_id,
    provider_instance_id: peerInput.spec.provider_instance_id,
    primary: { ipv4: ["192.0.2.92"], ipv6: [] },
    addresses: { ipv4: ["192.0.2.92"], ipv6: [] },
  });
  const objects = new Map<string, Json>(),
    saved: PostjoinProofOwnership[] = [],
    commandsSeen: string[][] = [],
    waits: number[] = [],
    abort = new AbortController();
  let state: PostjoinProofOwnership | null = null,
    exercises = 0,
    resolveCamera:
      ((v: { stdout: Uint8Array; stderr: string }) => void) | undefined,
    cameraStarted = false;
  const commands: PostjoinProofCommands = {
    signal: abort.signal,
    expectedNodeUid: f.nodeUid,
    authorize: async () => {},
    wait: async (ms) => {
      waits.push(ms);
    },
    readOwnership: async () => state,
    saveOwnership: async (next) => {
      state = structuredClone(next);
      saved.push(structuredClone(next));
    },
    capture: async (args, signal) => {
      commandsSeen.push(args);
      assert.equal(args.includes(postjoinCaptureScript), true);
      assert.equal(signal.aborted, false);
      cameraStarted = true;
      return new Promise((resolve) => {
        resolveCamera = resolve;
        signal.addEventListener(
          "abort",
          () => resolve({ stdout: new Uint8Array(), stderr: "" }),
          { once: true },
        );
      });
    },
    kube: async (args, permit, stdin) => {
      commandsSeen.push(args);
      assert.equal(permit, true);
      if (args[0] === "create") {
        const value = object(JSON.parse(stdin!)),
          m = object(value.metadata);
        assert.equal(
          state?.stage === "intent" || state?.stage === "running",
          true,
        );
        assert.equal(state?.namespace_create_attempted, true);
        m.uid = randomUUID();
        m.resourceVersion = "1";
        if (value.kind === "Pod") {
          assert.equal(
            state!.pods.find((p) => p.name === m.name)?.create_attempted,
            true,
          );
          value.status = {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
            podIPs: [
              { ip: m.name === "traffic-0" ? "10.42.0.1" : "10.42.1.1" },
            ],
          };
        }
        objects.set(`${value.kind}/${m.name}`, value);
        if (options.loseCreateReply)
          throw new Error("lost actual create reply");
        return { exit_code: 0, stdout: JSON.stringify(value) };
      }
      if (args[0] === "api-resources")
        return {
          exit_code: 0,
          stdout: "pods\nserviceaccounts\nconfigmaps\nevents\nsecrets\n",
        };
      if (args[0] === "delete") {
        const request = object(JSON.parse(stdin!)),
          pre = object(request.preconditions),
          path = args[1]!.slice("--raw=".length).split("/");
        assert.equal(request.gracePeriodSeconds, undefined);
        assert.equal(
          args.some((v) => /force|finalizer/.test(v)),
          false,
        );
        const name = path.at(-1)!,
          kind = path.includes("pods") ? "Pod" : "Namespace",
          current = objects.get(`${kind}/${name}`)!;
        assert.equal(object(current.metadata).uid, pre.uid);
        assert.equal(
          object(current.metadata).resourceVersion,
          pre.resourceVersion,
        );
        objects.delete(`${kind}/${name}`);
        return { exit_code: 0, stdout: "{}" };
      }
      if (args[0] === "exec" && args.includes("curl")) {
        assert.equal(cameraStarted, true);
        assert.deepEqual(waits.slice(0, 2), [2000, 2000]);
        exercises++;
        if (options.cancelOnTraffic) {
          abort.abort();
          throw new Error("cancelled actual exercise");
        }
        if (exercises === 2)
          resolveCamera!({
            stdout: captureBytes(
              f.input.spec.hardware.ipv4,
              "192.0.2.92",
              options.plaintext,
            ),
            stderr: `tcpdump: listening on eth0, link-type EN10MB (Ethernet)\n1 packet captured\n1 packet received by filter\n${options.dropped ? 1 : 0} packets dropped by kernel\n`,
          });
        return { exit_code: 0, stdout: state!.traffic_nonce };
      }
      if (args[0] === "exec" && args.includes("cat"))
        return { exit_code: 0, stdout: state!.traffic_nonce };
      if (args[0] === "exec" && args.includes("route"))
        return {
          exit_code: 0,
          stdout: JSON.stringify([
            { dev: "eth0", prefsrc: f.input.spec.hardware.ipv4 },
          ]),
        };
      if (args[0] === "exec" && args.includes("address"))
        return {
          exit_code: 0,
          stdout: JSON.stringify([
            {
              ifname: "eth0",
              addr_info: [{ local: f.input.spec.hardware.ipv4 }],
            },
          ]),
        };
      if (args[0] === "exec")
        return {
          exit_code: 0,
          stdout: JSON.stringify(
            debug(
              [
                {
                  endpoint: "192.0.2.92:51871",
                  "public-key": peerKey,
                  "last-handshake-time": new Date().toISOString(),
                },
              ],
              targetKey,
            ),
          ),
        };
      if (
        args[0] === "get" &&
        args[1] === "namespace" &&
        args[2] === "kube-system"
      )
        return { exit_code: 0, stdout: JSON.stringify(f.ns) };
      if (args[0] === "get" && args[1] === "nodes")
        return {
          exit_code: 0,
          stdout: JSON.stringify({ items: [f.node, peerNode] }),
        };
      if (args[0] === "get" && args[1] === "node")
        return {
          exit_code: 0,
          stdout: JSON.stringify(
            args[2] === f.input.spec.hostname ? f.node : peerNode,
          ),
        };
      if (args[0] === "get" && args[1] === "ciliumnode") {
        const target = args[2] === f.input.spec.hostname;
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            metadata: {
              name: args[2],
              uid: randomUUID(),
              resourceVersion: "1",
              annotations: {
                "network.cilium.io/wg-pub-key": target ? targetKey : peerKey,
              },
              ownerReferences: [
                {
                  kind: "Node",
                  name: args[2],
                  uid: target ? f.nodeUid : peerUid,
                },
              ],
            },
          }),
        };
      }
      if (
        args[0] === "get" &&
        args[1] === "pods" &&
        args.includes("--all-namespaces")
      )
        return {
          exit_code: 0,
          stdout: "false\t10.42.0.1\nfalse\t10.42.1.1\ntrue\t192.0.2.92\n",
        };
      if (
        args[0] === "get" &&
        args[1] === "pods" &&
        args.includes("kube-system")
      )
        return f.commands.kube(args, permit, stdin);
      if (args[0] === "get" && ["namespace", "pod"].includes(args[1]!)) {
        const value = objects.get(
          `${args[1] === "namespace" ? "Namespace" : "Pod"}/${args[2]}`,
        );
        return { exit_code: 0, stdout: value ? JSON.stringify(value) : "" };
      }
      if (args[0] === "get") {
        let items =
          args[1] === "pods"
            ? [...objects.values()].filter((o) => o.kind === "Pod")
            : [];
        if (args[1] === "secrets" && options.foreign)
          items = [
            {
              kind: "Secret",
              metadata: {
                namespace: state!.namespace_name,
                name: "unknown-customer",
                uid: randomUUID(),
                resourceVersion: "1",
              },
            },
          ];
        return { exit_code: 0, stdout: JSON.stringify({ items }) };
      }
      throw new Error(`Unexpected reviewed command ${args[0]} ${args[1]}`);
    },
  };
  return {
    ...f,
    commands,
    commandsSeen,
    objects,
    saved,
    state: () => state,
    exercises: () => exercises,
    abort,
  };
}
test("actual command flow exercises both Pod directions under a ready camera and cleans exact UIDs before returning", async () => {
  const f = dualFixture({ loseCreateReply: true });
  const proof = await collectPostjoinProof(
    f.input,
    f.bundle,
    f.plan,
    randomUUID(),
    new Date(Date.now() + 120000).toISOString(),
    f.commands,
  );
  assert.equal(f.exercises(), 2);
  assert.equal(proof.wireguard.peers.length, 1);
  assert.equal(proof.wireguard.packet_observations[0]!.encrypted_packets, 1);
  assert.equal(f.objects.size, 0);
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(
    f.saved.some(
      (s) => s.namespace_uid !== null && s.pods.some((p) => p.uid !== null),
    ),
    true,
  );
});
test("plaintext exercise and kernel loss never produce proof even when HTTP nonce exchanges succeed", async () => {
  const plaintext = dualFixture({ plaintext: true });
  await assert.rejects(
    collectPostjoinProof(
      plaintext.input,
      plaintext.bundle,
      plaintext.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      plaintext.commands,
    ),
    /plaintext_pod_traffic/,
  );
  assert.equal(plaintext.objects.size, 0);
  const dropped = dualFixture({ dropped: true });
  await assert.rejects(
    collectPostjoinProof(
      dropped.input,
      dropped.bundle,
      dropped.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      dropped.commands,
    ),
    /capture_loss/,
  );
});
test("foreign namespace children block deletion and retain the durable owned journal", async () => {
  const f = dualFixture({ foreign: true });
  await assert.rejects(
    collectPostjoinProof(
      f.input,
      f.bundle,
      f.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      f.commands,
    ),
    /foreign_namespace_child/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.notEqual(f.state()!.namespace_uid, null);
  assert.equal(
    f.commandsSeen.some((args) => args[0] === "delete"),
    false,
  );
});
test("interrupted traffic closes the camera and never returns a proof", async () => {
  const f = dualFixture({ cancelOnTraffic: true });
  await assert.rejects(
    collectPostjoinProof(
      f.input,
      f.bundle,
      f.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      f.commands,
    ),
    /traffic_failed|cancelled/,
  );
  assert.equal(f.objects.size, 0);
});
test("an actual singleton peer array allows only real stable Node and namespace readbacks, without creating traffic objects", async () => {
  const f = caseFixture();
  const proof = await collectPostjoinProof(
    f.input,
    f.bundle,
    f.plan,
    randomUUID(),
    new Date(Date.now() + 120000).toISOString(),
    f.commands,
  );
  assert.deepEqual(proof.wireguard.peers, []);
  assert.deepEqual(proof.wireguard.packet_observations, []);
  assert.equal(f.targetReads() >= 2, true);
  assert.equal(
    f.commandsSeen.some((args) =>
      ["create", "apply", "delete"].includes(args[0]!),
    ),
    false,
  );
});
test("changed storage proof or target UID prevents returning a postjoin proof", async () => {
  const f = caseFixture(),
    original = f.commands.kube;
  let reads = 0;
  f.commands.kube = async (...args) => {
    const result = await original(...args);
    if (args[0][0] === "get" && args[0][1] === "node" && ++reads === 2) {
      const value = JSON.parse(result.stdout);
      value.metadata.annotations["pgcf.io/storage-proof"] =
        digest(randomUUID());
      result.stdout = JSON.stringify(value);
    }
    return result;
  };
  await assert.rejects(
    collectPostjoinProof(
      f.input,
      f.bundle,
      f.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      f.commands,
    ),
    /capacity_changed/,
  );
});
test("operator grants bind only observed nodes, use pinned capture image, and mount no API token or host path", () => {
  const f = caseFixture(),
    nonce = randomBytes(32).toString("hex"),
    state: PostjoinProofOwnership = {
      version: 1,
      input_hash: f.input.input_hash,
      plan_sha256: digest(canonical(f.plan)),
      operation_id: f.input.spec.operation_id,
      session_id: randomUUID(),
      namespace_name: "pgcf-postjoin-" + randomBytes(10).toString("hex"),
      namespace_uid: null,
      traffic_nonce: nonce,
      stage: "intent",
      pods: [
        {
          name: "capture",
          node_name: f.input.spec.hostname,
          node_uid: f.nodeUid,
          uid: null,
          role: "capture",
        },
        {
          name: "traffic-0",
          node_name: f.input.spec.hostname,
          node_uid: f.nodeUid,
          uid: null,
          role: "traffic",
        },
      ],
    };
  const objects = postjoinProofObjects(f.input, state, nonce);
  const pods = objects.filter((value) => value.kind === "Pod");
  assert.equal(pods.length, 2);
  for (const pod of pods) {
    assert.equal(
      Object.values(object(object(pod.metadata).labels)).every(
        (v) => String(v).length <= 63,
      ),
      true,
    );
    const spec = pod.spec as Record<string, unknown>;
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.nodeName, f.input.spec.hostname);
    assert.equal(JSON.stringify(spec).includes('"hostPath"'), false);
    assert.equal(JSON.stringify(spec).includes('"privileged":true'), false);
    assert.equal(JSON.stringify(spec).includes(POSTJOIN_CAPTURE_IMAGE), true);
  }
});
test("the shipped Python traffic command serves the actual nonce over real local HTTP", async () => {
  const f = caseFixture(),
    nonce = randomBytes(32).toString("hex"),
    state: PostjoinProofOwnership = {
      version: 1,
      input_hash: f.input.input_hash,
      plan_sha256: digest(canonical(f.plan)),
      operation_id: f.input.spec.operation_id,
      session_id: randomUUID(),
      namespace_name: "pgcf-postjoin-" + randomBytes(10).toString("hex"),
      namespace_uid: null,
      traffic_nonce: nonce,
      stage: "intent",
      pods: [
        {
          name: "traffic-0",
          node_name: f.input.spec.hostname,
          node_uid: f.nodeUid,
          uid: null,
          role: "traffic",
        },
      ],
    };
  const pod = postjoinProofObjects(f.input, state, nonce).find(
      (o) => o.kind === "Pod",
    )!,
    command = object((object(pod.spec).containers as unknown[])[0])
      .command as string[];
  const child = spawn(command[0]!, command.slice(1), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const closed = once(child, "close");
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error("native traffic command exited before listening");
      try {
        response = await fetch("http://127.0.0.1:18080/proof", {
          signal: AbortSignal.timeout(1000),
        });
        break;
      } catch {
        await delay(20);
      }
    }
    assert.equal(response?.status, 200);
    assert.equal(await response!.text(), nonce);
    assert.equal((await fetch("http://127.0.0.1:18080/unknown")).status, 404);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
test("revoked cleanup authority retains exact dirty ownership for the next authorized resume", async () => {
  const f = dualFixture({ cancelOnTraffic: true });
  f.commands.authorize = async () => {
    if (f.abort.signal.aborted) throw new Error("authority revoked");
  };
  await assert.rejects(
    collectPostjoinProof(
      f.input,
      f.bundle,
      f.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      f.commands,
    ),
  );
  const original = structuredClone(f.state()!);
  assert.equal(original.stage, "running");
  assert.equal(
    original.pods.every((p) => p.uid !== null),
    true,
  );
  assert.equal(
    f.commandsSeen.some((args) => args[0] === "delete"),
    false,
  );
  const resume = dualFixture();
  resume.commands.readOwnership = async () => original;
  // A later operation may not silently discard another input's claimed journal.
  await assert.rejects(
    collectPostjoinProof(
      resume.input,
      resume.bundle,
      resume.plan,
      randomUUID(),
      new Date(Date.now() + 120000).toISOString(),
      resume.commands,
    ),
    /ownership_invalid/,
  );
  assert.equal(
    resume.commandsSeen.some(
      (args) => args[0] === "delete" || args[0] === "create",
    ),
    false,
  );
});
