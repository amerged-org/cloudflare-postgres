// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import type { NodeProofExecutionInput } from "@pgcf/contracts/node-proof";
import { hash } from "../../../scripts/e2e/src/node-network-native.ts";
import { proofExecutionFixture } from "./node-proof.fixture.ts";
import {
  authorizeProofTransport,
  proofCapabilityTarget,
  startProofProxy,
  validateProofExecution,
} from "../src/proof-proxy-command.ts";
import {
  publicProofSource,
  runNodeProof,
  runProofCapture,
  type NodeProofOptions,
} from "../src/node-proof-runner.ts";

type Json = Record<string, unknown>;
const obj = (value: unknown) => value as Json;

function commands(mode: "preparation" | "postjoin" = "preparation") {
  const f = proofExecutionFixture(mode),
    objects = new Map<string, Json>(),
    receipts = new Map<string, Json>(),
    journals = new Map<string, Json>(),
    seen: string[] = [],
    configPaths = new Set<string>();
  let reports = 0,
    uncertain = false,
    wrongTarget = false,
    cancelledFamily = false;
  const abort = new AbortController();
  const source = f.input.source;
  const ciliumKey = randomBytes(32).toString("base64"),
    ciliumUid = randomUUID();
  const targetNode = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: f.input.bootstrap.spec.hostname,
      uid: randomUUID(),
      resourceVersion: "7",
      labels: {
        "pgcf.io/node-id": f.input.claims.node_id,
        "pgcf.io/region": f.input.claims.region_id,
        "pgcf.io/provider-instance-id": f.input.claims.provider_instance_id,
      },
      annotations: {
        "pgcf.io/storage-gib-total": "95",
        "pgcf.io/storage-proof": hash(randomUUID()),
      },
    },
    spec: {
      taints: [
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      addresses: [
        { type: "InternalIP", address: f.input.bootstrap.spec.hardware.ipv4 },
      ],
      allocatable: { cpu: "2", memory: "4Gi" },
    },
  };
  const sourceNode = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: source.kind === "pod" ? source.node_name : "",
      uid: source.kind === "pod" ? source.node_uid : randomUUID(),
      resourceVersion: "2",
      labels: {
        "pgcf.io/node-id": source.node_id,
        "pgcf.io/region": source.region_id,
        "pgcf.io/provider-instance-id": source.provider_instance_id,
      },
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      addresses: [{ type: "InternalIP", address: source.ipv4 }],
    },
  };
  const namespace = (uid: string) => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system", uid, resourceVersion: "1" },
    status: { phase: "Active" },
  });
  const options: NodeProofOptions = {
    signal: abort.signal,
    request: async (url, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${f.input.session_bearer}`,
      );
      assert.equal(init?.redirect, "error");
      const name = new URL(String(url)).pathname.split("/").pop()!,
        body = JSON.parse(String(init?.body)) as Json;
      seen.push(`http:${name}`);
      if (name === "transport") {
        const target = proofCapabilityTarget(
          { input: f.input, direction: body.direction as "source" | "target" },
          body.capability as "rescue_ssh" | "talos_api" | "kubernetes_api",
        );
        return Response.json({
          websocket_url: `${f.input.api_base_url.replace("https:", "wss:")}/internal/v1/node-proof/${f.input.claims.operation_id}/relay`,
          token: randomBytes(32).toString("base64url"),
          expectedTarget: target,
        });
      }
      if (name === "ownership") {
        const key = String(body.key);
        if (body.action === "read")
          return Response.json({ entry: journals.get(key) ?? null });
        if (body.action === "expired") return Response.json({ entries: [] });
        journals.set(key, {
          state: body.state,
          originalInput: body.originalInput,
          publicSource: body.publicSource,
        });
        return Response.json({ saved: true });
      }
      if (name === "access") {
        assert.equal(receipts.size, 2);
        assert.equal(objects.size, 0);
        return Response.json({
          purpose: "pgcf-node-measurement/v1",
          kind: "access",
          binding_sha256: hash(body.binding),
          observed_at: new Date().toISOString(),
          access: [
            {
              provider_instance_id: f.input.claims.provider_instance_id,
              address: f.input.bootstrap.spec.hardware.ipv4,
              relay_source: f.input.plan.relay.addresses.ipv4[0],
              observed_at: new Date().toISOString(),
              checks: [
                { port: 22, outcome: "connected" },
                { port: 50000, outcome: "refused" },
                { port: 6443, outcome: "refused" },
              ],
            },
          ],
        });
      }
      if (name === "report") {
        reports++;
        assert.equal(objects.size, 0);
        for (const path of configPaths)
          await assert.rejects(stat(path), { code: "ENOENT" });
        if (uncertain) throw new Error("report_acknowledgement_lost");
        return Response.json({ accepted: true });
      }
      throw new Error("unexpected_proof_route");
    },
    run: async (command) => {
      command.signal.throwIfAborted();
      assert.ok(command.timeout_ms > 0 && command.timeout_ms <= 540_000);
      assert.equal(command.executable, "kubectl");
      const config = command.args[command.args.indexOf("--kubeconfig") + 1]!,
        direction = config.includes("source-kubeconfig") ? "source" : "target";
      configPaths.add(config);
      assert.equal((await stat(config)).mode & 0o077, 0);
      const yaml = obj(parse(await readFile(config, "utf8"))),
        cluster = obj(obj((yaml.clusters as Json[])[0]).cluster);
      assert.ok(String(cluster["proxy-url"]).startsWith("http://127.0.0.1:"));
      assert.equal(cluster["insecure-skip-tls-verify"], undefined);
      const index = command.args.findIndex((arg) =>
          ["get", "create", "exec", "logs", "delete"].includes(arg),
        ),
        args = command.args.slice(index),
        nsIndex = args.findIndex(
          (arg) => arg === "--namespace" || arg === "-n",
        ),
        ns = nsIndex >= 0 ? args[nsIndex + 1]! : "",
        key = (kind: string, name: string) => `${kind}/${ns}/${name}`;
      seen.push(`${direction}:${args[0]}:${args[1]}`);
      if (args[0] === "get") {
        if (direction === "source" && args[1] === "namespace/kube-system") {
          assert.equal(source.kind, "pod");
          if (source.kind !== "pod") throw new Error("pod_source_required");
          assert.deepEqual(args, [
            "get",
            "namespace/kube-system",
            `node/${source.node_name}`,
            "--ignore-not-found",
            "--output=json",
          ]);
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: "v1",
              kind: "List",
              items: [namespace(source.cluster_uid), sourceNode],
            }),
          };
        }
        if (direction === "target" && args[1] === "nodes")
          return {
            exit_code: 0,
            stdout: JSON.stringify({ items: [targetNode] }),
          };
        if (direction === "target" && args[1] === "ciliumnode")
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              metadata: {
                name: f.input.bootstrap.spec.hostname,
                uid: randomUUID(),
                resourceVersion: "1",
                annotations: { "network.cilium.io/wg-pub-key": ciliumKey },
                ownerReferences: [
                  {
                    kind: "Node",
                    name: f.input.bootstrap.spec.hostname,
                    uid: targetNode.metadata.uid,
                  },
                ],
              },
            }),
          };
        if (direction === "target" && args[1] === "pods")
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              items: [
                {
                  metadata: {
                    name: "cilium-target",
                    uid: ciliumUid,
                    resourceVersion: "1",
                    namespace: "kube-system",
                    labels: { "k8s-app": "cilium" },
                  },
                  spec: { nodeName: f.input.bootstrap.spec.hostname },
                  status: {
                    phase: "Running",
                    containerStatuses: [{ name: "cilium-agent", ready: true }],
                  },
                },
              ],
            }),
          };
        if (args[1] === "namespace" && args[2] === "kube-system")
          return {
            exit_code: 0,
            stdout: JSON.stringify(
              namespace(
                direction === "source"
                  ? source.kind === "pod"
                    ? source.cluster_uid
                    : ""
                  : wrongTarget
                    ? randomUUID()
                    : f.material.kube_system_uid,
              ),
            ),
          };
        if (args[1] === "node")
          return {
            exit_code: 0,
            stdout: JSON.stringify(
              direction === "source" ? sourceNode : targetNode,
            ),
          };
        if (args[1]!.startsWith("--raw=")) {
          const match = args[1]!.match(
            /^--raw=\/(api\/v1|apis\/(?:apps|batch)\/v1)\/namespaces\/([^/]+)\/([^/]+)$/,
          );
          assert.ok(match, "exact_inventory_collection_required");
          const kinds: Record<string, string> = {
              pods: "Pod",
              persistentvolumeclaims: "PersistentVolumeClaim",
              secrets: "Secret",
              configmaps: "ConfigMap",
              services: "Service",
              serviceaccounts: "ServiceAccount",
              replicationcontrollers: "ReplicationController",
              deployments: "Deployment",
              statefulsets: "StatefulSet",
              daemonsets: "DaemonSet",
              replicasets: "ReplicaSet",
              jobs: "Job",
              cronjobs: "CronJob",
            },
            kind = kinds[match[3]!]!;
          assert.ok(kind);
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: match[1] === "api/v1" ? "v1" : match[1]!.slice(5),
              kind: kind + "List",
              items: [...objects.values()].filter(
                (value) =>
                  obj(value.metadata).namespace === match[2] &&
                  value.kind === kind,
              ),
            }),
          };
        }
        const value = objects.get(key(args[1]!, args[2]!));
        return { exit_code: 0, stdout: value ? JSON.stringify(value) : "" };
      }
      if (args[0] === "create") {
        const value = JSON.parse(command.stdin!) as Json,
          m = obj(value.metadata);
        m.uid = randomUUID();
        m.resourceVersion = "1";
        if (value.kind === "Pod")
          value.status = {
            phase: "Running",
            containerStatuses: [
              {
                name: "scan",
                imageID:
                  source.kind === "pod"
                    ? `docker-pullable://${source.image}`
                    : "",
              },
            ],
          };
        objects.set(
          `${String(value.kind).toLowerCase()}/${m.namespace ?? ""}/${m.name}`,
          value,
        );
        return { exit_code: 0, stdout: JSON.stringify(value) };
      }
      if (args[0] === "exec") {
        if (direction === "target") {
          assert.equal(receipts.size, 2);
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              "cilium-status": { encryption: { mode: "wireguard" } },
              encryption: {
                wireguard: {
                  interfaces: [
                    {
                      name: "cilium_wg0",
                      "listen-port": 51871,
                      "public-key": ciliumKey,
                      "peer-count": 0,
                      peers: [],
                    },
                  ],
                },
              },
            }),
          };
        }
        const bytes = command.stdin!.match(
            /<<'PGCF_PROOF_INPUT'\n([^\n]+)\nPGCF_PROOF_INPUT/,
          )![1]!,
          original = obj(JSON.parse(Buffer.from(bytes, "base64").toString()))
            .input as NodeProofExecutionInput & {
            family: "ipv4" | "ipv6";
            direct_source: string;
          };
        const at = new Date().toISOString(),
          control = () => ({
            address: original.plan.scan_control[original.family],
            port: 443,
            source: original.direct_source,
            observed_at: at,
            nonce: randomBytes(32).toString("hex"),
          });
        const measurement = {
          purpose: "pgcf-node-measurement/v1",
          kind: "scan",
          family: original.family,
          source: original.direct_source,
          binding_sha256: hash(original.binding),
          observed_at: at,
          scans: original.plan.members.flatMap((member) =>
            member.addresses[original.family].map((address) => ({
              provider_instance_id: member.provider_instance_id,
              address,
              protocol: "tcp",
              first_port: 1,
              last_port: 65535,
              scanned_ports: 65535,
              open_ports: [],
              started_at: at,
              observed_at: at,
              before: control(),
              after: control(),
            })),
          ),
        };
        receipts.set(ns, measurement);
        if (mode === "postjoin" && receipts.size === 2)
          targetNode.metadata.resourceVersion = "9";
        objects.get(key("pod", "outside-scan"))!.status = {
          phase: "Succeeded",
          containerStatuses: [
            { name: "scan", state: { terminated: { exitCode: 0 } } },
          ],
        };
        if (cancelledFamily && original.family === "ipv4") abort.abort();
        return { exit_code: 0, stdout: "pgcf_proof_input_ready\n" };
      }
      if (args[0] === "logs")
        return { exit_code: 0, stdout: JSON.stringify(receipts.get(ns)) };
      if (args[0] === "delete") {
        const path = args.find((arg) => arg.startsWith("--raw="))!.slice(6),
          parts = path.split("/"),
          isPod = path.includes("/pods/"),
          name = parts.at(-1)!,
          target = isPod ? `pod/${parts[4]}/${name}` : `namespace//${name}`,
          actual = objects.get(target)!;
        const preconditions = obj(JSON.parse(command.stdin!).preconditions);
        assert.equal(preconditions.uid, obj(actual.metadata).uid);
        assert.equal(
          preconditions.resourceVersion,
          obj(actual.metadata).resourceVersion,
        );
        objects.delete(target);
        return { exit_code: 0, stdout: "" };
      }
      throw new Error("unexpected_bound_command");
    },
  };
  return {
    ...f,
    options,
    objects,
    journals,
    seen,
    configPaths,
    targetNode,
    reports: () => reports,
    uncertain: () => {
      uncertain = true;
    },
    wrongTarget: () => {
      wrongTarget = true;
    },
    cancelFamily: () => {
      cancelledFamily = true;
    },
  };
}
test("signed execution binds every identity before HTTP, commands or private material", async () => {
  const f = commands();
  f.input.claims.plan_sha256 = hash(randomUUID());
  await assert.rejects(runNodeProof(f.input, f.options), /node_proof_/);
  assert.equal(f.seen.length, 0);
  assert.equal(f.configPaths.size, 0);
  const origin = proofExecutionFixture();
  assert.throws(
    () =>
      validateProofExecution({
        ...origin.input,
        api_base_url: "https://foreign.invalid",
      }),
    /node_proof_input_invalid/,
  );
  assert.equal(
    JSON.stringify(publicProofSource(origin.input.source)).includes("access"),
    false,
  );
});
test("a proof capability can authorize only the exact selected endpoint and direction", async () => {
  const f = proofExecutionFixture();
  let calls = 0;
  await assert.rejects(
    authorizeProofTransport(
      { input: f.input, direction: "source" },
      "kubernetes_api",
      AbortSignal.timeout(1000),
      async (_url, init) => {
        calls++;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          capability: "kubernetes_api",
          direction: "source",
        });
        return Response.json({
          websocket_url: `${f.input.api_base_url.replace("https:", "wss:")}/internal/v1/node-proof/${f.input.claims.operation_id}/relay`,
          token: randomBytes(32).toString("base64url"),
          expectedTarget: {
            ip: f.input.bootstrap.spec.hardware.ipv4,
            port: 6443,
          },
        });
      },
    ),
    /node_proof_transport_target_changed/,
  );
  assert.equal(calls, 1);
});
test("loopback proxy rejects an unbound CONNECT target before authority HTTP", async () => {
  const f = proofExecutionFixture();
  let calls = 0;
  const proxy = await startProofProxy(
    { input: f.input, direction: "source" },
    AbortSignal.timeout(5000),
    async () => {
      calls++;
      throw new Error("no authority request permitted");
    },
  );
  try {
    const address = new URL(proxy.url);
    const text = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(address.port), address.hostname);
      let value = "";
      socket.on("connect", () =>
        socket.end(
          "CONNECT 192.0.2.17:6443 HTTP/1.1\r\nHost: 192.0.2.17:6443\r\n\r\n",
        ),
      );
      socket.on("data", (bytes) => (value += bytes.toString()));
      socket.once("end", () => resolve(value));
      socket.once("error", reject);
    });
    assert.match(text, /^HTTP\/1.1 403/);
    assert.equal(calls, 0);
  } finally {
    await proxy.close();
  }
});
test("preparation runs both complete outside families, cleans exact source resources and reports once after fresh access", async () => {
  const f = commands(),
    report = await runNodeProof(f.input, f.options);
  assert.deepEqual(report.binding, f.input.binding);
  assert.equal(report.postjoin, null);
  assert.equal(report.measurements.length, 3);
  assert.deepEqual(
    report.measurements
      .filter((value) => value.kind === "scan")
      .map((value) => value.family),
    ["ipv4", "ipv6"],
  );
  assert.equal(f.reports(), 1);
  assert.equal(f.objects.size, 0);
  assert.ok(
    [...f.journals.values()].every(
      (entry) => obj(entry.state).stage === "cleaned",
    ),
  );
  assert.equal(f.seen.at(-1), "http:report");
});
test("a sealed default kubeconfig namespace is removed only from the derived private proof config", async () => {
  const f = commands();
  assert.equal(f.input.source.kind, "pod");
  if (f.input.source.kind !== "pod") throw new Error("fixture_source_required");
  const bundle = f.input.source.access.join_bundle,
    config = obj(parse(bundle.kubeconfig)),
    context = obj(obj((config.contexts as Json[])[0]).context);
  context.namespace = "default";
  bundle.kubeconfig = stringify(config);
  const sealed = bundle.kubeconfig,
    originalRun = f.options.run!;
  f.options.run = async (command) => {
    const path = command.args[command.args.indexOf("--kubeconfig") + 1]!,
      derived = obj(parse(await readFile(path, "utf8"))),
      derivedContext = obj(obj((derived.contexts as Json[])[0]).context);
    assert.equal(derivedContext.namespace, undefined);
    assert.deepEqual(derived.users, config.users);
    assert.equal(derived["current-context"], config["current-context"]);
    const cluster = obj(obj((derived.clusters as Json[])[0]).cluster),
      original = obj(obj((config.clusters as Json[])[0]).cluster);
    assert.equal(cluster.server, original.server);
    assert.equal(
      cluster["certificate-authority-data"],
      original["certificate-authority-data"],
    );
    return originalRun(command);
  };
  await runNodeProof(f.input, f.options);
  assert.equal(bundle.kubeconfig, sealed);
  assert.equal(f.reports(), 1);
  assert.equal(f.objects.size, 0);
});
test("a non-default kubeconfig namespace still fails before any Kubernetes command or scan", async () => {
  const f = commands();
  if (f.input.source.kind !== "pod") throw new Error("fixture_source_required");
  const bundle = f.input.source.access.join_bundle,
    config = obj(parse(bundle.kubeconfig));
  obj(obj((config.contexts as Json[])[0]).context).namespace = "foreign";
  bundle.kubeconfig = stringify(config);
  await assert.rejects(
    runNodeProof(f.input, f.options),
    /node_proof_kubeconfig_identity_changed/,
  );
  assert.equal(f.configPaths.size, 0);
  assert.equal(f.objects.size, 0);
  assert.equal(f.reports(), 0);
});
test("an installed-image anchor is reported only after actual scoped Talos version and disk reads", async () => {
  const f = commands(),
    input = f.input.bootstrap;
  f.input.binding.maintenance = {
    input_hash: input.input_hash,
    checkpoint_revision: 1,
    checkpoint_stage: "rescue_reboot_intent",
    raw_bytes: input.spec.image.raw_bytes,
    install_disk: input.spec.hardware.install_disk,
    disk_bytes: input.spec.hardware.disk_bytes,
    talos_version: "1.14.1",
  };
  const originalRun = f.options.run!,
    originalRequest = f.options.request!,
    reads: string[][] = [];
  f.options.run = async (command) => {
    if (command.executable !== "talosctl") return originalRun(command);
    assert.ok(command.args.includes("--insecure"));
    assert.equal(
      command.args[command.args.indexOf("--nodes") + 1],
      input.spec.hardware.ipv4,
    );
    assert.ok(command.env.HTTPS_PROXY?.startsWith("http://127.0.0.1:"));
    reads.push(command.args);
    return {
      exit_code: 0,
      stdout: JSON.stringify(
        command.args.includes("version")
          ? { version: { tag: "v1.14.1" } }
          : {
              node: input.spec.hardware.ipv4,
              metadata: { id: "vda" },
              spec: {
                dev_path: input.spec.hardware.install_disk,
                size: input.spec.hardware.disk_bytes,
              },
            },
      ),
    };
  };
  f.options.request = async (url, init) => {
    if (String(url).endsWith("/access")) {
      assert.equal(reads.length, 2);
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(
        { ...body.maintenance_observation, observed_at: undefined },
        { ...f.input.binding.maintenance, observed_at: undefined },
      );
    }
    return originalRequest(url, init);
  };
  await runNodeProof(f.input, f.options);
  assert.equal(f.reports(), 1);
});
test("configured Talos anchors require pinned private TLS custody and never fall back to insecure reads", async () => {
  const f = commands(),
    input = f.input.bootstrap;
  f.input.binding.maintenance = {
    input_hash: input.input_hash,
    checkpoint_revision: 2,
    checkpoint_stage: "config_applied",
    raw_bytes: input.spec.image.raw_bytes,
    install_disk: input.spec.hardware.install_disk,
    disk_bytes: input.spec.hardware.disk_bytes,
    talos_version: "1.14.1",
  };
  f.input.talos_admin_config = stringify({
    context: "sealed",
    contexts: {
      sealed: {
        endpoints: ["192.0.2.250"],
        nodes: ["192.0.2.250"],
        ca: "unit CA",
        crt: "unit certificate",
        key: "unit key",
        "proxy-url": "http://foreign.invalid",
      },
    },
  });
  const original = f.options.run!;
  let reads = 0;
  f.options.run = async (command) => {
    if (command.executable !== "talosctl") return original(command);
    assert.equal(command.args.includes("--insecure"), false);
    const path = command.args[command.args.indexOf("--talosconfig") + 1]!;
    assert.equal((await stat(path)).mode & 0o077, 0);
    const yaml = obj(parse(await readFile(path, "utf8"))),
      context = obj(obj(yaml.contexts).sealed);
    assert.deepEqual(context.endpoints, [input.spec.hardware.ipv4]);
    assert.deepEqual(context.nodes, [input.spec.hardware.ipv4]);
    assert.ok(String(context["proxy-url"]).startsWith("http://127.0.0.1:"));
    reads++;
    return { exit_code: 1, stdout: "private authentication failure" };
  };
  await assert.rejects(
    runNodeProof(f.input, f.options),
    /node_proof_maintenance_authentication_failed/,
  );
  assert.equal(reads, 1);
  assert.equal(f.reports(), 0);
  assert.equal(f.objects.size, 0);
});
test("an uncertain report acknowledgement is never replayed and cancellation still cleans both source families", async () => {
  const uncertain = commands();
  uncertain.uncertain();
  await assert.rejects(
    runNodeProof(uncertain.input, uncertain.options),
    /report_acknowledgement_lost/,
  );
  assert.equal(uncertain.reports(), 1);
  assert.equal(uncertain.objects.size, 0);
  const cancelled = commands();
  cancelled.cancelFamily();
  await assert.rejects(runNodeProof(cancelled.input, cancelled.options));
  assert.equal(cancelled.reports(), 0);
  assert.equal(cancelled.objects.size, 0);
});
test("changed actual target cluster identity blocks postjoin outside scans and reporting", async () => {
  const f = commands("postjoin");
  f.wrongTarget();
  await assert.rejects(
    runNodeProof(f.input, f.options),
    /node_proof_target_identity_changed/,
  );
  assert.equal(
    f.seen.some((value) => value.startsWith("source:create")),
    false,
  );
  assert.equal(f.reports(), 0);
});
test("postjoin retains the original outside binding while the real collector uses the later stable Node revision", async () => {
  const f = commands("postjoin"),
    report = await runNodeProof(f.input, f.options);
  assert.equal(report.binding.verification!.node_resource_version, "7");
  assert.equal(obj(report.postjoin!.node.metadata).resourceVersion, "9");
  assert.equal(obj(report.postjoin!.node_after.metadata).resourceVersion, "9");
  assert.equal(report.measurements.length, 2);
  assert.equal(
    report.measurements.some((value) => value.kind === "access"),
    false,
  );
  for (const measurement of report.measurements)
    assert.equal(measurement.binding_sha256, hash(report.binding));
  assert.equal(f.reports(), 1);
  assert.equal(f.objects.size, 0);
});
test("native capture retains real binary bytes and kills a blocked command on cancellation", async () => {
  const bytes = await runProofCapture({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0,255,128,1]))"],
    env: { PATH: process.env.PATH, LANG: "C" },
    timeout_ms: 5000,
    signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(Buffer.from(bytes.stdout), Buffer.from([0, 255, 128, 1]));
  const abort = new AbortController(),
    blocked = runProofCapture({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: { PATH: process.env.PATH, LANG: "C" },
      timeout_ms: 5000,
      signal: abort.signal,
    });
  abort.abort();
  await assert.rejects(blocked, /node_proof_capture_cancelled/);
});
