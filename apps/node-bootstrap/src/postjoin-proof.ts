// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  NodeBootstrapInput,
  NodeJoinBundle,
} from "@pgcf/contracts/node-bootstrap";
import { NodeProofPostjoin } from "@pgcf/contracts/node-proof";
import {
  wireguardPeers,
  packetEvidence,
  type PeerBinding,
} from "../../../scripts/e2e/src/node-network-packets.ts";
import { ip } from "../../../scripts/e2e/src/node-network-native.ts";
import type { NetworkPlan } from "../../../scripts/e2e/src/node-network-proof.ts";
import {
  BootstrapError,
  canonical,
  digest,
  inputHash,
  type CommandResult,
} from "./bootstrap.ts";

type Json = Record<string, unknown>;
export const POSTJOIN_CAPTURE_IMAGE =
  "docker.io/jonlabelle/network-tools:sha-6257a44@sha256:0c4de3370f8c19aa7c9577ea9ab9bb72063db807efe88a8a7bbead9482b89732";
const UID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const MAX_JSON = 16 * 1024 ** 2;
const fail = (code: string): never => {
  throw new BootstrapError(`postjoin_${code}`);
};
function obj(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("readback_invalid");
  return value as Json;
}
function rows(value: unknown, max = 32): Json[] {
  if (!Array.isArray(value) || value.length > max)
    return fail("readback_invalid");
  return value.map(obj);
}
function metadata(value: Json) {
  const m = obj(value.metadata);
  if (
    typeof m.uid !== "string" ||
    !UID.test(m.uid) ||
    typeof m.resourceVersion !== "string" ||
    !/^[0-9]+$/.test(m.resourceVersion)
  )
    return fail("resource_identity_invalid");
  return m as Json & { uid: string; resourceVersion: string; name: string };
}
function json(text: string): Json {
  if (Buffer.byteLength(text) > MAX_JSON) return fail("output_limit");
  try {
    return obj(JSON.parse(text));
  } catch {
    return fail("readback_invalid");
  }
}

function ciliumInterface(raw: unknown) {
  const value = obj(raw),
    mode = obj(obj(value["cilium-status"]).encryption);
  if (
    !(["wireguard", "Wireguard"] as unknown[]).includes(mode.mode) ||
    (mode.msg !== undefined && mode.msg !== "")
  )
    return fail("wireguard_mode");
  const interfaces = rows(obj(obj(value.encryption).wireguard).interfaces, 1);
  if (interfaces.length !== 1) return fail("wireguard_readback_invalid");
  const iface = interfaces[0]!;
  if (
    iface.name !== "cilium_wg0" ||
    iface["listen-port"] !== 51871 ||
    typeof iface["public-key"] !== "string" ||
    !KEY.test(iface["public-key"])
  )
    return fail("wireguard_readback_invalid");
  const peers = rows(iface.peers, 16);
  if (
    (iface["peer-count"] !== undefined &&
      iface["peer-count"] !== peers.length) ||
    (peers.length && iface["peer-count"] === undefined)
  )
    return fail("wireguard_readback_invalid");
  return { iface, peers };
}
/** The peer array is populated only by Cilium's debuginfo Status(true) path. */
export function ciliumWireguardPeers(
  raw: unknown,
  expected: PeerBinding[],
  observedAt: string,
  publicKeys: string[],
) {
  const { iface, peers } = ciliumInterface(raw);
  const stamps = new Map<string, string>();
  const endpoints: string[] = [],
    handshakes: string[] = [];
  for (const peer of peers) {
    const publicKey = peer["public-key"],
      endpoint = peer.endpoint,
      stamp = peer["last-handshake-time"];
    if (
      typeof publicKey !== "string" ||
      !KEY.test(publicKey) ||
      typeof endpoint !== "string" ||
      typeof stamp !== "string" ||
      !z.iso.datetime({ offset: true, precision: 3 }).safeParse(stamp)
        .success ||
      Date.parse(stamp) <= 0 ||
      stamps.has(publicKey)
    )
      return fail("wireguard_handshake_invalid");
    if (
      Date.parse(stamp) < Date.parse(observedAt) - 180000 ||
      Date.parse(stamp) > Date.parse(observedAt) + 5000
    )
      return fail("wireguard_handshake_stale");
    stamps.set(publicKey, new Date(stamp).toISOString());
    endpoints.push(`${iface.name} ${publicKey} ${endpoint}`);
    handshakes.push(
      `${iface.name} ${publicKey} ${Math.floor(Date.parse(stamp) / 1000)}`,
    );
  }
  const secondsObserved = new Date(
    Math.floor(Date.parse(observedAt) / 1000) * 1000,
  ).toISOString();
  const parsed = wireguardPeers(
    String(iface.name),
    endpoints.join("\n"),
    handshakes.join("\n"),
    String(iface.name),
    expected,
    secondsObserved,
  );
  if (
    publicKeys.length !== expected.length ||
    parsed.some((peer, index) => peer.public_key !== publicKeys[index])
  )
    return fail("wireguard_public_key_binding");
  return parsed.map((peer) => ({
    ...peer,
    last_handshake_at: stamps.get(peer.public_key)!,
  }));
}

export interface PostjoinProofOwnership {
  version: 1;
  input_hash: string;
  plan_sha256: string;
  operation_id: string;
  session_id: string;
  namespace_name: string;
  namespace_uid: string | null;
  traffic_nonce: string;
  namespace_create_attempted?: boolean;
  stage: "intent" | "running" | "cleanup" | "cleaned";
  pods: {
    name: string;
    node_name: string;
    node_uid: string;
    uid: string | null;
    role: "capture" | "traffic";
    create_attempted?: boolean;
  }[];
}
export interface PostjoinProofCommands {
  kube(
    args: string[],
    permitFailure?: boolean,
    stdin?: string,
  ): Promise<CommandResult>;
  capture(
    args: string[],
    signal: AbortSignal,
  ): Promise<{ stdout: Uint8Array; stderr: string }>;
  authorize(): Promise<void>;
  readOwnership(): Promise<PostjoinProofOwnership | null>;
  saveOwnership(state: PostjoinProofOwnership): Promise<void>;
  expectedNodeUid?: string;
  signal?: AbortSignal;
  wait?(milliseconds: number): Promise<void>;
}
const trafficScript = `import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
nonce=sys.argv[1].encode('ascii')
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path!='/proof':
   self.send_error(404); return
  self.send_response(200)
  self.send_header('Content-Length',str(len(nonce)))
  self.end_headers(); self.wfile.write(nonce)
 def log_message(self,*args): pass
ThreadingHTTPServer(('0.0.0.0',18080),Handler).serve_forever()
`;
/** Readiness is recorded only after the real tcpdump listening diagnostic. */
export const postjoinCaptureScript = `import os,signal,subprocess,sys,threading,time
device,nonce=sys.argv[1:3]
ready='/tmp/proof/capture-ready'
try: os.unlink(ready)
except FileNotFoundError: pass
p=subprocess.Popen(['tcpdump','-i',device,'-s','0','-U','-w','-','-n'],stdout=sys.stdout.buffer,stderr=subprocess.PIPE)
started=threading.Event()
def diagnostics():
 for line in p.stderr:
  sys.stderr.buffer.write(line); sys.stderr.buffer.flush()
  if line.startswith(('tcpdump: listening on '+device+',').encode()):
   with open(ready,'w') as f: f.write(nonce)
   started.set()
reader=threading.Thread(target=diagnostics);reader.start()
if not started.wait(5):
 p.send_signal(signal.SIGINT);p.wait(timeout=3);reader.join();sys.exit(2)
time.sleep(14)
if p.poll() is not None: reader.join();sys.exit(3)
p.send_signal(signal.SIGINT)
try: code=p.wait(timeout=3)
except subprocess.TimeoutExpired:
 p.kill();p.wait();reader.join();sys.exit(4)
reader.join()
sys.exit(0 if code==0 else 5)
`;
function labels(input: NodeBootstrapInput, state: PostjoinProofOwnership) {
  return {
    "pgcf.io/component": "node-postjoin-proof",
    "pgcf.io/operation-id": input.spec.operation_id,
    "pgcf.io/input-hash": input.input_hash.slice(0, 32),
    "pgcf.io/proof-session": state.session_id,
  };
}
export function postjoinProofObjects(
  input: NodeBootstrapInput,
  state: PostjoinProofOwnership,
  nonce: string,
): Json[] {
  if (!HASH.test(nonce) || nonce !== state.traffic_nonce)
    return fail("nonce_invalid");
  const l = labels(input, state);
  const annotations = {
    "pgcf.io/input-hash": input.input_hash,
    "pgcf.io/plan-sha256": state.plan_sha256,
    "pgcf.io/traffic-nonce": nonce,
  };
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: state.namespace_name,
        annotations,
        labels: {
          ...l,
          "pgcf.io/role": "operator",
          "pod-security.kubernetes.io/enforce": "privileged",
        },
      },
    },
    ...state.pods.map((pod) => {
      const capture = pod.role === "capture";
      return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: pod.name,
          namespace: state.namespace_name,
          labels: l,
          annotations: { ...annotations, "pgcf.io/node-uid": pod.node_uid },
        },
        spec: {
          nodeName: pod.node_name,
          automountServiceAccountToken: false,
          serviceAccountName: "default",
          restartPolicy: "Never",
          activeDeadlineSeconds: 300,
          terminationGracePeriodSeconds: 10,
          hostNetwork: capture,
          hostPID: false,
          hostIPC: false,
          dnsPolicy: capture ? "ClusterFirstWithHostNet" : "ClusterFirst",
          tolerations: [
            {
              key: "pgcf.io/quarantine",
              operator: "Equal",
              value: "bootstrap",
              effect: "NoSchedule",
            },
          ],
          securityContext: {
            runAsUser: capture ? 0 : 65534,
            runAsGroup: capture ? 0 : 65534,
            runAsNonRoot: !capture,
            seccompProfile: { type: "RuntimeDefault" },
          },
          ...(capture
            ? {
                volumes: [
                  {
                    name: "proof",
                    emptyDir: { medium: "Memory", sizeLimit: "1Mi" },
                  },
                ],
              }
            : {}),
          containers: [
            {
              name: "proof",
              image: POSTJOIN_CAPTURE_IMAGE,
              imagePullPolicy: "IfNotPresent",
              command: capture
                ? ["sleep", "300"]
                : ["python3", "-B", "-u", "-c", trafficScript, nonce],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: {
                  drop: ["ALL"],
                  ...(capture ? { add: ["NET_RAW", "NET_ADMIN"] } : {}),
                },
              },
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "256Mi" },
              },
              ...(!capture
                ? {
                    readinessProbe: {
                      tcpSocket: { port: 18080 },
                      periodSeconds: 1,
                      timeoutSeconds: 1,
                      failureThreshold: 10,
                      successThreshold: 1,
                    },
                  }
                : {}),
              ...(capture
                ? { volumeMounts: [{ name: "proof", mountPath: "/tmp/proof" }] }
                : {}),
            },
          ],
        },
      };
    }),
  ];
}
interface BoundNode {
  member: NetworkPlan["members"][number];
  node: Json;
  name: string;
  uid: string;
  publicKey: string;
}
function capacity(node: Json) {
  const m = metadata(node),
    s = obj(node.status),
    a = obj(s.allocatable),
    annotations = obj(m.annotations);
  if (
    typeof annotations["pgcf.io/storage-gib-total"] !== "string" ||
    !/^[1-9][0-9]{0,5}$/.test(annotations["pgcf.io/storage-gib-total"]) ||
    typeof annotations["pgcf.io/storage-proof"] !== "string" ||
    !HASH.test(annotations["pgcf.io/storage-proof"]) ||
    typeof a.cpu !== "string" ||
    !/^(?:[1-9][0-9]*(?:\.[0-9]+)?|[1-9][0-9]*m)$/.test(a.cpu) ||
    typeof a.memory !== "string" ||
    !/^[1-9][0-9]*(?:Ki|Mi|Gi|Ti|K|M|G|T)?$/.test(a.memory)
  )
    return fail("capacity_unavailable");
  return canonical({
    uid: m.uid,
    resourceVersion: m.resourceVersion,
    labels: m.labels,
    taints: obj(node.spec).taints,
    allocatable: a,
    storage: annotations["pgcf.io/storage-gib-total"],
    proof: annotations["pgcf.io/storage-proof"],
  });
}
class Collector {
  readonly input!: NodeBootstrapInput;
  readonly bundle!: NodeJoinBundle;
  readonly plan!: NetworkPlan;
  readonly end!: number;
  readonly session: string;
  readonly commands: PostjoinProofCommands;
  private state: PostjoinProofOwnership | null = null;
  private desired = new Map<string, Json>();
  constructor(
    input: NodeBootstrapInput,
    bundle: NodeJoinBundle,
    plan: NetworkPlan,
    session: string,
    deadline: string,
    commands: PostjoinProofCommands,
  ) {
    this.session = session;
    this.commands = commands;
    try {
      this.input = NodeBootstrapInput.parse(input);
      this.bundle = NodeJoinBundle.parse(bundle);
    } catch {
      return fail("input_invalid");
    }
    this.plan = structuredClone(plan);
    const spec = this.input.spec;
    if (
      inputHash(spec) !== input.input_hash ||
      !UID.test(session) ||
      !UID.test(bundle.kube_system_uid) ||
      bundle.cluster_name !== spec.cluster_name ||
      bundle.cluster_endpoint !== spec.cluster_endpoint ||
      (spec.cluster_uid !== null &&
        bundle.kube_system_uid !== spec.cluster_uid) ||
      (spec.join_bundle_sha256 !== null &&
        digest(canonical(bundle)) !== spec.join_bundle_sha256) ||
      plan.version !== 1 ||
      plan.operation_id !== spec.operation_id ||
      plan.node_id !== spec.node_id ||
      plan.provider_instance_id !== spec.provider_instance_id ||
      plan.region_id !== spec.region_id ||
      !Array.isArray(plan.members) ||
      !plan.members.length ||
      plan.members.length > 16 ||
      new Set(plan.members.map((m) => m.node_id)).size !==
        plan.members.length ||
      new Set(plan.members.map((m) => m.provider_instance_id)).size !==
        plan.members.length ||
      !plan.members.some(
        (m) =>
          m.node_id === spec.node_id &&
          m.primary.ipv4.includes(spec.hardware.ipv4),
      )
    )
      return fail("binding_invalid");
    for (const m of plan.members)
      if (
        !m.primary.ipv4.length ||
        m.primary.ipv4.length !== 1 ||
        m.primary.ipv6.length > 1 ||
        m.primary.ipv4.some((address) => isIP(address) !== 4)
      )
        return fail("peer_address_coverage");
    if (!commands.readOwnership || !commands.saveOwnership)
      return fail("journal_required");
    const remaining = Date.parse(deadline) - Date.now();
    if (
      !z.iso.datetime({ precision: 3 }).safeParse(deadline).success ||
      remaining <= 30000 ||
      remaining > 600000
    )
      return fail("deadline_invalid");
    this.end = performance.now() + remaining;
  }
  private check(cleanup = false) {
    if (!cleanup && this.commands.signal?.aborted) return fail("cancelled");
    if (this.end - performance.now() <= (cleanup ? 0 : 30000))
      return fail("deadline");
  }
  private async authorize(cleanup = false) {
    this.check(cleanup);
    await this.commands.authorize();
    this.check(cleanup);
  }
  private async kube(args: string[], stdin?: string, cleanup = false) {
    await this.authorize(cleanup);
    const result = await this.commands.kube(args, true, stdin);
    this.check(cleanup);
    if (Buffer.byteLength(result.stdout) > MAX_JSON)
      return fail("output_limit");
    if (result.exit_code !== 0) return fail("command_failed");
    return result.stdout;
  }
  private async get(
    kind: string,
    name: string,
    namespace?: string,
    cleanup = false,
  ) {
    const text = await this.kube(
      [
        "get",
        kind,
        name,
        ...(namespace ? ["-n", namespace] : []),
        "--ignore-not-found=true",
        "-o",
        "json",
      ],
      undefined,
      cleanup,
    );
    return text.trim() ? json(text) : null;
  }
  private async save(fields: Partial<PostjoinProofOwnership>, cleanup = false) {
    if (!this.state) return fail("ownership_missing");
    const next = structuredClone({ ...this.state, ...fields });
    await this.authorize(cleanup);
    try {
      await this.commands.saveOwnership(next);
    } catch {
      if (canonical(await this.commands.readOwnership()) !== canonical(next))
        return fail("ownership_unconfirmed");
    }
    this.state = next;
  }
  private async wait(milliseconds: number, cleanup = false) {
    this.check(cleanup);
    if (this.commands.wait) await this.commands.wait(milliseconds);
    else
      await delay(
        milliseconds,
        undefined,
        !cleanup && this.commands.signal
          ? { signal: this.commands.signal }
          : undefined,
      );
    this.check(cleanup);
  }
  private namespace(value: Json) {
    const state = this.state!,
      m = metadata(value),
      wanted = labels(this.input, state),
      actual = obj(m.labels);
    const annotations = obj(m.annotations);
    if (
      value.kind !== "Namespace" ||
      m.name !== state.namespace_name ||
      (state.namespace_uid !== null && m.uid !== state.namespace_uid) ||
      Object.entries(wanted).some(([k, v]) => actual[k] !== v) ||
      annotations["pgcf.io/input-hash"] !== state.input_hash ||
      annotations["pgcf.io/plan-sha256"] !== state.plan_sha256 ||
      annotations["pgcf.io/traffic-nonce"] !== state.traffic_nonce
    )
      return fail("namespace_identity_changed");
    return m;
  }
  private pod(
    value: Json,
    known: PostjoinProofOwnership["pods"][number],
    checkDesired = true,
  ) {
    const m = metadata(value),
      actual = obj(m.labels),
      wanted = labels(this.input, this.state!),
      spec = obj(value.spec);
    const annotations = obj(m.annotations);
    if (
      value.kind !== "Pod" ||
      m.name !== known.name ||
      m.namespace !== this.state!.namespace_name ||
      (known.uid !== null && m.uid !== known.uid) ||
      Object.entries(wanted).some(([k, v]) => actual[k] !== v) ||
      annotations["pgcf.io/input-hash"] !== this.state!.input_hash ||
      annotations["pgcf.io/plan-sha256"] !== this.state!.plan_sha256 ||
      annotations["pgcf.io/traffic-nonce"] !== this.state!.traffic_nonce ||
      annotations["pgcf.io/node-uid"] !== known.node_uid ||
      spec.nodeName !== known.node_name ||
      spec.automountServiceAccountToken !== false ||
      spec.serviceAccountName !== "default" ||
      (spec.hostPID !== undefined && spec.hostPID !== false) ||
      (spec.hostIPC !== undefined && spec.hostIPC !== false) ||
      (Array.isArray(spec.initContainers) && spec.initContainers.length) ||
      (Array.isArray(spec.ephemeralContainers) &&
        spec.ephemeralContainers.length)
    )
      return fail("pod_identity_changed");
    if (checkDesired) {
      const desired = this.desired.get(known.name);
      if (!desired) return fail("ownership_invalid");
      const expected = obj(desired.spec),
        container = rows(spec.containers, 1)[0],
        original = rows(expected.containers, 1)[0];
      if (
        !container ||
        !original ||
        [
          "image",
          "name",
          "command",
          "securityContext",
          "resources",
          "volumeMounts",
          "readinessProbe",
        ].some(
          (k) =>
            canonical(container[k] ?? null) !== canonical(original[k] ?? null),
        ) ||
        (Array.isArray(container.env) && container.env.length) ||
        (Array.isArray(container.envFrom) && container.envFrom.length) ||
        canonical(spec.volumes ?? []) !== canonical(expected.volumes ?? []) ||
        canonical(spec.securityContext) !==
          canonical(expected.securityContext) ||
        (spec.hostNetwork ?? false) !== expected.hostNetwork
      )
        return fail("pod_identity_changed");
    }
    return m;
  }
  private async node(
    member: NetworkPlan["members"][number],
    value: Json,
    target: boolean,
  ): Promise<BoundNode> {
    const m = metadata(value),
      labels = obj(m.labels),
      status = obj(value.status),
      addresses = rows(status.addresses, 32),
      ready = rows(status.conditions, 32).filter((c) => c.type === "Ready");
    if (
      value.kind !== "Node" ||
      m.deletionTimestamp ||
      labels["pgcf.io/node-id"] !== member.node_id ||
      labels["pgcf.io/provider-instance-id"] !== member.provider_instance_id ||
      labels["pgcf.io/region"] !== this.input.spec.region_id ||
      ready.length !== 1 ||
      ready[0]!.status !== "True" ||
      !addresses.some(
        (a) => a.type === "InternalIP" && a.address === member.primary.ipv4[0],
      ) ||
      typeof m.name !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(m.name)
    )
      return fail("node_identity_changed");
    if (target) {
      if (
        m.name !== this.input.spec.hostname ||
        (this.commands.expectedNodeUid &&
          m.uid !== this.commands.expectedNodeUid)
      )
        return fail("node_identity_changed");
      if (obj(value.spec).unschedulable === true)
        return fail("node_identity_changed");
      const quarantine = rows(obj(value.spec).taints, 32).filter(
        (t) => t.key === "pgcf.io/quarantine",
      );
      if (
        quarantine.length !== 1 ||
        quarantine[0]!.value !== "bootstrap" ||
        quarantine[0]!.effect !== "NoSchedule"
      )
        return fail("quarantine_missing");
      capacity(value);
    }
    const ciliumNode = await this.get("ciliumnode", m.name);
    if (!ciliumNode) return fail("cilium_node_missing");
    const cm = metadata(ciliumNode),
      publicKey = obj(cm.annotations)["network.cilium.io/wg-pub-key"];
    if (
      cm.name !== m.name ||
      cm.deletionTimestamp ||
      typeof publicKey !== "string" ||
      !KEY.test(publicKey) ||
      !rows(cm.ownerReferences, 8).some(
        (r) => r.kind === "Node" && r.name === m.name && r.uid === m.uid,
      )
    )
      return fail("cilium_public_key_binding");
    return { member, node: value, name: m.name, uid: m.uid, publicKey };
  }
  private async cluster() {
    const value = await this.get("namespace", "kube-system");
    if (
      !value ||
      metadata(value).uid !== this.bundle.kube_system_uid ||
      metadata(value).deletionTimestamp ||
      value.kind !== "Namespace"
    )
      return fail("cluster_identity_changed");
    return value;
  }
  private async cilium(target: BoundNode) {
    const list = json(
      await this.kube([
        "get",
        "pods",
        "-n",
        "kube-system",
        "-l",
        "k8s-app=cilium",
        "--field-selector",
        `spec.nodeName=${target.name}`,
        "-o",
        "json",
      ]),
    );
    const pods = rows(list.items, 10000).filter(
      (pod) => !["Succeeded", "Failed"].includes(String(obj(pod.status).phase)),
    );
    if (pods.length !== 1) return fail("cilium_agent_identity");
    const pod = pods[0]!,
      m = metadata(pod),
      s = obj(pod.status);
    if (
      m.deletionTimestamp ||
      m.namespace !== "kube-system" ||
      obj(pod.spec).nodeName !== target.name ||
      obj(m.labels)["k8s-app"] !== "cilium" ||
      s.phase !== "Running" ||
      !rows(s.containerStatuses, 8).some(
        (c) => c.name === "cilium-agent" && c.ready === true,
      )
    )
      return fail("cilium_agent_identity");
    const raw = json(
      await this.kube([
        "exec",
        "-n",
        "kube-system",
        m.name,
        "-c",
        "cilium-agent",
        "--",
        "cilium-dbg",
        "debuginfo",
        "--output",
        "json",
      ]),
    );
    const iface = rows(obj(obj(raw.encryption).wireguard).interfaces, 1)[0];
    if (!iface || iface["public-key"] !== target.publicKey)
      return fail("cilium_public_key_binding");
    return { raw, uid: m.uid };
  }
  private async podAddresses() {
    // Only addressing fields reach this collector or the proof; no Pod environment is retained.
    const text = await this.kube([
      "get",
      "pods",
      "--all-namespaces",
      "-o",
      'jsonpath={range .items[*]}{.spec.hostNetwork}{"\\t"}{.status.podIPs[*].ip}{"\\n"}{end}',
    ]);
    if (Buffer.byteLength(text) > 2 * 1024 ** 2)
      return fail("pod_address_limit");
    const addresses = new Set<string>(),
      lines = text.split("\n").filter(Boolean);
    if (lines.length > 10000) return fail("pod_address_limit");
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length !== 2 || !["", "false", "true"].includes(parts[0]!))
        return fail("pod_address_invalid");
      if (parts[0] === "true") continue;
      for (const address of parts[1]!.trim().split(/\s+/).filter(Boolean)) {
        if (!isIP(address)) return fail("pod_address_invalid");
        addresses.add(ip(address));
      }
    }
    return [...addresses];
  }
  private async ownedObjects(nodes: BoundNode[], nonce: string) {
    this.state = {
      version: 1,
      input_hash: this.input.input_hash,
      plan_sha256: digest(canonical(this.plan)),
      operation_id: this.input.spec.operation_id,
      session_id: this.session,
      namespace_name: `pgcf-postjoin-${digest(this.input.input_hash + this.session).slice(0, 20)}`,
      namespace_uid: null,
      traffic_nonce: nonce,
      namespace_create_attempted: false,
      stage: "intent",
      pods: [
        {
          name: "capture",
          node_name: nodes[0]!.name,
          node_uid: nodes[0]!.uid,
          uid: null,
          role: "capture",
          create_attempted: false,
        },
        ...nodes.map((node, index) => ({
          name: `traffic-${index}`,
          node_name: node.name,
          node_uid: node.uid,
          uid: null,
          role: "traffic" as const,
          create_attempted: false,
        })),
      ],
    };
    await this.save({});
    const objects = postjoinProofObjects(this.input, this.state, nonce);
    this.desired = new Map(
      objects
        .filter((o) => o.kind === "Pod")
        .map((o) => [String(obj(o.metadata).name), o]),
    );
    if (await this.get("namespace", this.state.namespace_name))
      return fail("namespace_already_present");
    await this.save({ namespace_create_attempted: true });
    try {
      await this.kube(
        ["create", "-f", "-", "-o", "json"],
        JSON.stringify(objects[0]),
      );
    } catch {
      /* Resolve only from actual owned identity, including a lost create reply. */
    }
    const namespace = await this.get("namespace", this.state.namespace_name);
    if (!namespace) return fail("namespace_create_unconfirmed");
    await this.save({ namespace_uid: this.namespace(namespace).uid });
    for (const pod of this.state.pods) {
      await this.save({
        pods: this.state.pods.map((p) =>
          p.name === pod.name ? { ...p, create_attempted: true } : p,
        ),
      });
      try {
        await this.kube(
          ["create", "-f", "-", "-o", "json"],
          JSON.stringify(this.desired.get(pod.name)),
        );
      } catch {
        /* The create intent and exact name were journalled first. */
      }
      const created = await this.get(
        "pod",
        pod.name,
        this.state.namespace_name,
      );
      if (!created) return fail("pod_create_unconfirmed");
      const uid = this.pod(created, pod).uid;
      await this.save({
        pods: this.state.pods.map((p) =>
          p.name === pod.name ? { ...p, uid } : p,
        ),
      });
    }
    await this.save({ stage: "running" });
    const active = new Map<string, Json>();
    for (const pod of this.state.pods)
      for (;;) {
        const actual = await this.get(
          "pod",
          pod.name,
          this.state.namespace_name,
        );
        if (!actual) return fail("pod_disappeared");
        this.pod(actual, pod);
        const status = obj(actual.status);
        if (["Failed", "Succeeded"].includes(String(status.phase)))
          return fail("traffic_pod_failed");
        if (
          status.phase === "Running" &&
          rows(status.conditions, 16).some(
            (c) => c.type === "Ready" && c.status === "True",
          )
        ) {
          active.set(pod.name, actual);
          break;
        }
        await this.wait(500);
      }
    return active;
  }
  private async inventory(namespace: Json) {
    const state = this.state!,
      ns = this.namespace(namespace);
    const text = await this.kube(
      ["api-resources", "--verbs=list", "--namespaced=true", "-o", "name"],
      undefined,
      true,
    );
    const kinds = [...new Set(text.trim().split(/\s+/))];
    if (
      !kinds.includes("pods") ||
      !kinds.includes("serviceaccounts") ||
      !kinds.includes("configmaps") ||
      kinds.length > 256 ||
      kinds.some((k) => !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(k))
    )
      return fail("cleanup_inventory_unproven");
    const known = new Set([
      ns.uid,
      ...state.pods.flatMap((p) => (p.uid ? [p.uid] : [])),
    ]);
    const rank = (k: string) =>
      ({
        pods: 0,
        serviceaccounts: 1,
        configmaps: 2,
        events: 3,
        "events.events.k8s.io": 3,
      })[k] ?? 4;
    kinds.sort((a, b) => rank(a) - rank(b));
    for (const kind of kinds) {
      const list = json(
        await this.kube(
          ["get", kind, "-n", state.namespace_name, "-o", "json"],
          undefined,
          true,
        ),
      );
      for (const item of rows(list.items, 32)) {
        const m = metadata(item);
        if (m.namespace !== state.namespace_name)
          return fail("foreign_namespace_child");
        if (kind === "pods") {
          const pod = state.pods.find((p) => p.name === m.name);
          if (!pod || pod.uid === null) return fail("foreign_namespace_child");
          this.pod(item, pod);
        } else if (
          kind === "serviceaccounts" &&
          m.name === "default" &&
          (!Array.isArray(item.secrets) || !item.secrets.length) &&
          (!Array.isArray(item.imagePullSecrets) ||
            !item.imagePullSecrets.length)
        )
          known.add(m.uid);
        else if (
          kind === "configmaps" &&
          m.name === "kube-root-ca.crt" &&
          Object.keys(obj(item.data)).join() === "ca.crt"
        ) {
          /* Kubernetes' standard namespace CA publication. */
        } else if (
          (kind === "events" || kind === "events.events.k8s.io") &&
          known.has(String(obj(item.involvedObject ?? item.regarding).uid))
        ) {
          /* Only lifecycle events bound to owned identities. */
        } else return fail("foreign_namespace_child");
      }
    }
  }
  private async cleanup() {
    if (!this.state || this.state.stage === "cleaned") return;
    await this.save({ stage: "cleanup" }, true);
    const namespace = await this.get(
      "namespace",
      this.state.namespace_name,
      undefined,
      true,
    );
    if (!namespace) {
      await this.save({ stage: "cleaned" }, true);
      return;
    }
    if (this.state.namespace_uid === null) {
      if (!this.state.namespace_create_attempted)
        return fail("ownership_unconfirmed");
      await this.save({ namespace_uid: this.namespace(namespace).uid }, true);
    }
    for (const pod of this.state.pods.filter((p) => p.uid === null)) {
      const actual = await this.get(
        "pod",
        pod.name,
        this.state.namespace_name,
        true,
      );
      if (!actual) continue;
      if (!pod.create_attempted) return fail("foreign_namespace_child");
      const uid = this.pod(actual, pod).uid;
      await this.save(
        {
          pods: this.state.pods.map((p) =>
            p.name === pod.name ? { ...p, uid } : p,
          ),
        },
        true,
      );
    }
    await this.inventory(namespace);
    for (const pod of this.state.pods) {
      const actual = await this.get(
        "pod",
        pod.name,
        this.state.namespace_name,
        true,
      );
      if (!actual) continue;
      const m = this.pod(actual, pod);
      await this.kube(
        [
          "delete",
          `--raw=/api/v1/namespaces/${this.state.namespace_name}/pods/${pod.name}`,
          "--filename=-",
        ],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: m.uid, resourceVersion: m.resourceVersion },
          propagationPolicy: "Foreground",
        }),
        true,
      );
    }
    for (;;) {
      const list = json(
        await this.kube(
          ["get", "pods", "-n", this.state.namespace_name, "-o", "json"],
          undefined,
          true,
        ),
      );
      if (!rows(list.items, 32).length) break;
      for (const actual of rows(list.items, 32)) {
        const pod = this.state.pods.find(
          (p) => p.name === metadata(actual).name,
        );
        if (!pod) return fail("foreign_namespace_child");
        this.pod(actual, pod);
      }
      await this.wait(250, true);
    }
    const current = await this.get(
      "namespace",
      this.state.namespace_name,
      undefined,
      true,
    );
    if (current) {
      await this.inventory(current);
      const m = this.namespace(current);
      await this.kube(
        [
          "delete",
          `--raw=/api/v1/namespaces/${this.state.namespace_name}`,
          "--filename=-",
        ],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: m.uid, resourceVersion: m.resourceVersion },
          propagationPolicy: "Foreground",
        }),
        true,
      );
      while (
        await this.get("namespace", this.state.namespace_name, undefined, true)
      )
        await this.wait(250, true);
    }
    await this.save({ stage: "cleaned" }, true);
  }
  private previous(value: PostjoinProofOwnership) {
    if (
      value.version !== 1 ||
      value.input_hash !== this.input.input_hash ||
      value.plan_sha256 !== digest(canonical(this.plan)) ||
      value.operation_id !== this.input.spec.operation_id ||
      !UID.test(value.session_id) ||
      !HASH.test(value.traffic_nonce) ||
      value.namespace_name !==
        `pgcf-postjoin-${digest(value.input_hash + value.session_id).slice(0, 20)}` ||
      (value.namespace_uid !== null && !UID.test(value.namespace_uid)) ||
      !["intent", "running", "cleanup", "cleaned"].includes(value.stage) ||
      !Array.isArray(value.pods) ||
      value.pods.length > 17 ||
      new Set(value.pods.map((p) => p.name)).size !== value.pods.length ||
      value.pods.some(
        (p) =>
          !/^(?:capture|traffic-[0-9]{1,2})$/.test(p.name) ||
          !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(p.node_name) ||
          !UID.test(p.node_uid) ||
          (p.uid !== null && !UID.test(p.uid)) ||
          !["capture", "traffic"].includes(p.role),
      )
    )
      return fail("ownership_invalid");
    this.desired = new Map(
      postjoinProofObjects(this.input, value, value.traffic_nonce)
        .filter((o) => o.kind === "Pod")
        .map((o) => [String(obj(o.metadata).name), o]),
    );
    return structuredClone(value);
  }
  async run() {
    await this.authorize();
    // Even retained cleanup remains bound to the actual protected cluster.
    const kubeSystem = await this.cluster();
    const previous = await this.commands.readOwnership();
    if (previous) {
      this.state = this.previous(previous);
      if (previous.stage !== "cleaned") await this.cleanup();
    }
    const list = json(await this.kube(["get", "nodes", "-o", "json"]));
    const all = rows(list.items, 64),
      ordered = [...this.plan.members].sort(
        (a, b) =>
          Number(b.node_id === this.plan.node_id) -
          Number(a.node_id === this.plan.node_id),
      );
    const nodes: BoundNode[] = [];
    for (const member of ordered) {
      const matches = all.filter(
        (n) => obj(metadata(n).labels)["pgcf.io/node-id"] === member.node_id,
      );
      if (matches.length !== 1) return fail("node_identity_changed");
      const value =
        member.node_id === this.plan.node_id
          ? await this.get("node", this.input.spec.hostname)
          : matches[0]!;
      if (!value) return fail("node_identity_changed");
      nodes.push(
        await this.node(member, value, member.node_id === this.plan.node_id),
      );
    }
    const target = nodes[0]!,
      beforeCapacity = capacity(target.node),
      expected = nodes.slice(1).map((n) => ({
        node_id: n.member.node_id,
        provider_instance_id: n.member.provider_instance_id,
        address: n.member.primary.ipv4[0]!,
      })),
      publicKeys = nodes.slice(1).map((n) => n.publicKey);
    const firstCilium = await this.cilium(target);
    // A newly configured peer may have no handshake until this actual exercise.
    // Do not fabricate a handshake or prevent the exercise from producing one.
    if (!expected.length)
      ciliumWireguardPeers(
        firstCilium.raw,
        expected,
        new Date().toISOString(),
        publicKeys,
      );
    else if (ciliumInterface(firstCilium.raw).peers.length !== expected.length)
      return fail("wireguard_peer_set");
    let packets: z.infer<
      typeof NodeProofPostjoin
    >["wireguard"]["packet_observations"] = [];
    try {
      if (expected.length) {
        const nonce = randomBytes(32).toString("hex"),
          active = await this.ownedObjects(nodes, nonce),
          state = this.state!;
        const routeDevices = new Set<string>();
        for (const peer of expected) {
          const routes = JSON.parse(
            await this.kube([
              "exec",
              "-n",
              state.namespace_name,
              "capture",
              "--",
              "ip",
              "-j",
              "route",
              "get",
              peer.address,
            ]),
          );
          const route = rows(routes, 1)[0];
          if (
            !route ||
            typeof route.dev !== "string" ||
            !/^[A-Za-z0-9_.-]{1,32}$/.test(route.dev) ||
            ip(String(route.prefsrc ?? route.src)) !==
              ip(this.input.spec.hardware.ipv4)
          )
            return fail("wan_route_unproven");
          routeDevices.add(route.dev);
        }
        if (routeDevices.size !== 1) return fail("wan_route_unproven");
        const device = [...routeDevices][0]!,
          addresses = JSON.parse(
            await this.kube([
              "exec",
              "-n",
              state.namespace_name,
              "capture",
              "--",
              "ip",
              "-j",
              "address",
              "show",
              "dev",
              device,
            ]),
          );
        if (
          !rows(addresses, 1).some(
            (a) =>
              a.ifname === device &&
              rows(a.addr_info, 32).some(
                (v) => v.local === this.input.spec.hardware.ipv4,
              ),
          )
        )
          return fail("wan_address_unproven");
        const trafficAddresses = nodes.map((_, index) => {
          const pod = active.get(`traffic-${index}`)!,
            addresses = rows(obj(pod.status).podIPs, 8),
            ipv4 = addresses.filter(
              (a) => typeof a.ip === "string" && isIP(a.ip) === 4,
            );
          if (ipv4.length !== 1) return fail("pod_address_invalid");
          return String(ipv4[0]!.ip);
        });
        const beforePodAddresses = await this.podAddresses();
        if (
          trafficAddresses.some(
            (address) => !beforePodAddresses.includes(ip(address)),
          )
        )
          return fail("pod_address_missing");
        await this.authorize();
        const startedAt = new Date().toISOString(),
          captureAbort = new AbortController();
        const signal = AbortSignal.any([
          captureAbort.signal,
          AbortSignal.timeout(
            Math.min(22000, Math.max(1, this.end - performance.now() - 30000)),
          ),
          ...(this.commands.signal ? [this.commands.signal] : []),
        ]);
        let ended = false;
        const camera = this.commands
          .capture(
            [
              "exec",
              "-n",
              state.namespace_name,
              "capture",
              "--",
              "python3",
              "-B",
              "-u",
              "-c",
              postjoinCaptureScript,
              device,
              nonce,
            ],
            signal,
          )
          .finally(() => {
            ended = true;
          });
        // Register rejection immediately while the separate readiness/traffic commands run.
        const observedCamera = camera.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await this.wait(2000);
          if (
            ended ||
            (
              await this.kube([
                "exec",
                "-n",
                state.namespace_name,
                "capture",
                "--",
                "cat",
                "/tmp/proof/capture-ready",
              ])
            ).trim() !== nonce
          )
            return fail("capture_not_ready");
          await this.wait(2000);
          const traffic = await Promise.allSettled(
            expected.map(async (_, index) => {
              for (const [source, destination] of [
                [0, index + 1],
                [index + 1, 0],
              ]) {
                if (ended) return fail("capture_ended_before_traffic");
                const text = await this.kube([
                  "exec",
                  "-n",
                  state.namespace_name,
                  `traffic-${source}`,
                  "--",
                  "curl",
                  "--fail",
                  "--silent",
                  "--show-error",
                  "--connect-timeout",
                  "2",
                  "--max-time",
                  "5",
                  `http://${trafficAddresses[destination!]}:18080/proof`,
                ]);
                if (text !== nonce) return fail("traffic_nonce_mismatch");
              }
            }),
          );
          if (traffic.some((v) => v.status !== "fulfilled"))
            return fail("traffic_failed");
          const result = await observedCamera;
          if (!("value" in result) || !result.value)
            return fail("capture_failed");
          const finishedAt = new Date().toISOString();
          if (Buffer.byteLength(result.value.stderr) > 65536)
            return fail("capture_output_limit");
          const podAddresses = [
            ...new Set([
              ...beforePodAddresses,
              ...(await this.podAddresses()),
              ...trafficAddresses,
            ]),
          ];
          packets = packetEvidence(
            Buffer.from(result.value.stdout),
            result.value.stderr,
            this.input.spec.hardware.ipv4,
            expected,
            podAddresses,
            startedAt,
            finishedAt,
          ).map((v) => ({
            source_node_id: this.plan.node_id,
            destination_node_id: v.peer.node_id,
            captured_at: v.captured_at,
            encrypted_packets: v.encrypted_packets,
            plaintext_pod_packets: v.plaintext_pod_packets,
          }));
        } finally {
          captureAbort.abort();
          await observedCamera;
        }
      }
      const finalCilium = await this.cilium(target);
      if (finalCilium.uid !== firstCilium.uid)
        return fail("cilium_agent_changed");
      const peers = ciliumWireguardPeers(
        finalCilium.raw,
        expected,
        new Date().toISOString(),
        publicKeys,
      );
      await this.cleanup();
      const kubeSystemAfter = await this.cluster(),
        nodeAfter = await this.get("node", target.name);
      if (!nodeAfter) return fail("node_identity_changed");
      for (const bound of nodes) {
        const current =
          bound === target ? nodeAfter : await this.get("node", bound.name);
        if (!current) return fail("node_identity_changed");
        const after = await this.node(bound.member, current, bound === target);
        if (after.uid !== bound.uid || after.publicKey !== bound.publicKey)
          return fail("node_identity_changed");
      }
      if (
        capacity(nodeAfter) !== beforeCapacity ||
        metadata(kubeSystemAfter).uid !== metadata(kubeSystem).uid
      )
        return fail("capacity_changed");
      return NodeProofPostjoin.parse({
        kube_system: kubeSystem,
        node: target.node,
        kube_system_after: kubeSystemAfter,
        node_after: nodeAfter,
        wireguard: { mode: "wireguard", peers, packet_observations: packets },
      });
    } catch (error) {
      if (this.state && this.state.stage !== "cleaned") {
        try {
          await this.cleanup();
        } catch {
          /* Retain the durable exact ownership for authorized cleanup on resume. */
        }
      }
      if (error instanceof BootstrapError) throw error;
      if (
        error instanceof Error &&
        /^node_network_[a-z0-9_]{1,100}$/.test(error.message)
      )
        return fail(error.message.slice("node_network_".length));
      return fail("observation_failed");
    }
  }
}

/** Real readbacks are returned only after all owned operator objects are confirmed absent. */
export async function collectPostjoinProof(
  input: NodeBootstrapInput,
  sealedBundle: NodeJoinBundle,
  plan: NetworkPlan,
  sessionId: string,
  deadlineAt: string,
  commands: PostjoinProofCommands,
): Promise<z.infer<typeof NodeProofPostjoin>> {
  return new Collector(
    input,
    sealedBundle,
    plan,
    sessionId,
    deadlineAt,
    commands,
  ).run();
}
