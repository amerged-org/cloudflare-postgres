// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { hash } from "../../../scripts/e2e/src/node-network-native.ts";
import { runCommand } from "../src/bootstrap.ts";
import { BootstrapError } from "../src/bootstrap-error.ts";
import {
  readProofSourceAssets,
  proofSourceScratchScript,
  proofSourceChunkScript,
  proofSourceCleanupScript,
  proofSourceExecutionScript,
  proofSourcePodObjects,
  runOwnedOutsideScan,
  cleanupOwnedProofSource,
  type ProofSourceCommands,
  type ProofSourceDescriptor,
  type ProofSourceOwnership,
} from "../src/proof-source.ts";
import type {
  OutsideScanInput,
  OutsideScanMeasurement,
} from "../src/outside-scan.ts";

type Json = Record<string, unknown>;
const obj = (value: unknown) => value as Json;
function inventoryCollection(args: string[]) {
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
  };
  assert.ok(kinds[match[3]!]);
  return {
    apiVersion: match[1] === "api/v1" ? "v1" : match[1]!.slice(5),
    kind: kinds[match[3]!]! + "List",
    namespace: match[2]!,
  };
}
function inventoryOutput(args: string[], items: unknown[], padding?: string) {
  const { apiVersion, kind } = inventoryCollection(args);
  return {
    exit_code: 0,
    stdout: JSON.stringify({
      apiVersion,
      kind,
      items,
      ...(padding === undefined ? {} : { padding }),
    }),
  };
}
function assertSafeRescueScripts(script: string) {
  assert.ok(
    !/(?:^|[\s;&|()])(?:apt(?:-get)?|mkfs(?:\.[A-Za-z0-9_-]+)?|reboot)(?=$|[\s;&|()])|of=\/dev\//m.test(
      script,
    ),
  );
}
test("the rescue-script guard still refuses package, filesystem, reboot and install-disk write commands", () => {
  assert.throws(() => assertSafeRescueScripts("apt-get install nodejs"));
  assert.throws(() => assertSafeRescueScripts("sudo apt install nodejs"));
  assert.throws(() => assertSafeRescueScripts("mkfs.ext4 /dev/vda"));
  assert.throws(() => assertSafeRescueScripts("true; reboot"));
  assert.throws(() =>
    assertSafeRescueScripts("dd if=/tmp/image.raw of=/dev/vda"),
  );
});
function fixture() {
  const operation = newOperationId(),
    nodeId = newNodeId(),
    sourceNode = newNodeId();
  const addresses = { ipv4: ["192.0.2.2"], ipv6: ["2001:db8:3::2"] };
  const plan: OutsideScanInput["plan"] = {
    version: 1,
    operation_id: operation,
    node_id: nodeId,
    region_id: "eu-target",
    provider_instance_id: "17",
    intent_hash: hash(randomUUID()),
    operators: { ipv4: ["198.51.100.20/32"], ipv6: [] },
    relay: {
      provider_instance_id: "18",
      addresses: { ipv4: ["192.0.2.3"], ipv6: [] },
    },
    scan_control: { ipv4: "192.0.2.40", ipv6: "2001:db8:2::40", port: 443 },
    members: [
      {
        node_id: nodeId,
        provider_instance_id: "17",
        firewall_id: randomUUID(),
        addresses,
        primary: addresses,
        ownership_sha256: hash(randomUUID()),
        rules: { rules: { inbound: [] } },
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
    family: "ipv4",
    control_keys: {},
    direct_source: "203.0.113.99",
    deadline_at: new Date(Date.now() + 120_000).toISOString(),
  };
  const source: Extract<ProofSourceDescriptor, { kind: "pod" }> = {
    kind: "pod",
    cluster_uid: randomUUID(),
    node_uid: randomUUID(),
    node_name: "owned-source",
    node_id: sourceNode,
    region_id: "us-source",
    provider_instance_id: "99",
    ipv4: input.direct_source!,
    ipv6: "2001:db8:1::99",
    image: `fixture.invalid/native@sha256:${hash(randomUUID())}`,
  };
  const at = new Date().toISOString(),
    control = () => ({
      address: plan.scan_control.ipv4,
      port: 443,
      source: source.ipv4,
      observed_at: at,
      nonce: randomBytes(32).toString("hex"),
    });
  const measured: OutsideScanMeasurement = {
    purpose: "pgcf-node-measurement/v1",
    kind: "scan",
    family: "ipv4",
    source: source.ipv4,
    binding_sha256: hash(input.binding),
    observed_at: at,
    scans: [
      {
        provider_instance_id: "17",
        address: addresses.ipv4[0]!,
        protocol: "tcp",
        first_port: 1,
        last_port: 65535,
        scanned_ports: 65535,
        open_ports: [],
        started_at: at,
        observed_at: at,
        before: control(),
        after: control(),
      },
    ],
  };
  const objects = new Map<string, Json>(),
    saved: ProofSourceOwnership[] = [],
    mutations: string[][] = [],
    logReads: string[][] = [],
    actions: string[] = [];
  let authorizationCount = 0;
  let state: ProofSourceOwnership | null = null,
    loseCreate = false,
    replaceBeforeCleanup = false,
    unavailable = false,
    cancelOnExec = false,
    loseInputReply = false,
    changedPod = false,
    foreignChild = false,
    wrongImage = false,
    failedLogs: string | null = null,
    failBeforeInput = false,
    afterLogs: (() => void) | undefined,
    firstNamespaceInventoryFailure: (() => void) | undefined;
  const abort = new AbortController();
  const key = (kind: string, name: string) => `${kind}/${name}`;
  const cluster = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "kube-system",
      uid: source.cluster_uid,
      resourceVersion: "1",
    },
  };
  const node = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: source.node_name,
      uid: source.node_uid,
      resourceVersion: "1",
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
  const commands: ProofSourceCommands = {
    signal: abort.signal,
    authorizeSource: async () => {
      if (unavailable) throw new Error("source_authority_unavailable");
      authorizationCount++;
    },
    readOwnership: async () => (state ? structuredClone(state) : null),
    saveOwnership: async (next) => {
      if (state) {
        assert.equal(next.source_sha256, state.source_sha256);
        assert.equal(next.input_sha256, state.input_sha256);
        assert.equal(next.invocation_id, state.invocation_id);
      }
      state = structuredClone(next);
      saved.push(structuredClone(next));
      if (next.stage === "measured" && foreignChild)
        objects.set("persistentvolumeclaim/customer-data", {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: "customer-data",
            namespace: next.namespace_name,
            uid: randomUUID(),
            resourceVersion: "1",
          },
          spec: { resources: { requests: { storage: "1Gi" } } },
        });
      if (next.stage === "measured" && replaceBeforeCleanup)
        obj(objects.get(key("pod", "outside-scan"))!.metadata).uid =
          randomUUID();
      if (
        next.stage === "measured" &&
        unavailable === false &&
        cleanupUnavailable
      )
        unavailable = true;
    },
    wait: async () => {},
    kube: async (args, _permit, stdin, options) => {
      assert.ok(options && !options.signal.aborted);
      actions.push(args[0]!);
      if (args[0] === "get") {
        if (args[1] === "pod/outside-scan") {
          assert.deepEqual(args, [
            "get",
            "pod/outside-scan",
            `namespace/${args[4]!}`,
            "--namespace",
            args[4]!,
            "--ignore-not-found",
            "--output=json",
          ]);
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: "v1",
              kind: "List",
              items: [
                objects.get(key("pod", "outside-scan")),
                objects.get(key("namespace", args[4]!)),
              ].filter(Boolean),
            }),
          };
        }
        if (args[1] === "namespace/kube-system") {
          const readPod = args[3] === "pod/outside-scan",
            pod = objects.get(key("pod", "outside-scan"));
          assert.deepEqual(args, [
            "get",
            "namespace/kube-system",
            `node/${source.node_name}`,
            ...(readPod ? ["pod/outside-scan", "--namespace", args[5]!] : []),
            "--ignore-not-found",
            "--output=json",
          ]);
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: "v1",
              kind: "List",
              items: [cluster, node, ...(readPod && pod ? [pod] : [])],
            }),
          };
        }
        if (args[1]!.startsWith("--raw=")) {
          if (firstNamespaceInventoryFailure) {
            const onFailure = firstNamespaceInventoryFailure;
            firstNamespaceInventoryFailure = undefined;
            onFailure();
            return { exit_code: 1, stdout: "" };
          }
          const collection = inventoryCollection(args);
          return inventoryOutput(
            args,
            [...objects.values()]
              .filter(
                (value) =>
                  obj(value.metadata).namespace === collection.namespace &&
                  value.kind === collection.kind.slice(0, -4),
              )
              .map((value) => {
                const item = { ...value };
                delete item.apiVersion;
                delete item.kind;
                return item;
              }),
          );
        }
        if (args[1] === "node")
          return { exit_code: 0, stdout: JSON.stringify(node) };
        if (args[1] === "namespace" && args[2] === "kube-system")
          return {
            exit_code: 0,
            stdout: JSON.stringify(cluster),
          };
        const value = objects.get(key(args[1]!, args[2]!));
        return { exit_code: 0, stdout: value ? JSON.stringify(value) : "" };
      }
      if (args[0] === "logs") {
        logReads.push(args);
        afterLogs?.();
        return { exit_code: 0, stdout: failedLogs ?? JSON.stringify(measured) };
      }
      mutations.push(args);
      if (args[0] === "create") {
        assert.ok(state?.stage === "intent" || state?.stage === "ready");
        const value = JSON.parse(stdin!) as Json,
          m = obj(value.metadata);
        m.uid = randomUUID();
        m.resourceVersion = "1";
        if (value.kind === "Pod") {
          value.status = {
            phase: failBeforeInput ? "Failed" : "Running",
            containerStatuses: [
              {
                name: "scan",
                imageID: `docker-pullable://${wrongImage ? `fixture.invalid/foreign@sha256:${hash(randomUUID())}` : source.image}`,
              },
            ],
          };
          if (changedPod)
            obj((obj(value.spec).containers as Json[])[0]).env = [
              { name: "NODE_OPTIONS", value: "--inspect=0.0.0.0:9229" },
            ];
        }
        objects.set(
          key(String(value.kind).toLowerCase(), String(m.name)),
          value,
        );
        if (loseCreate) {
          loseCreate = false;
          throw new Error("create_reply_lost");
        }
        return { exit_code: 0, stdout: JSON.stringify(value) };
      }
      if (args[0] === "exec") {
        assert.equal(state!.stage, "running");
        assert.ok(stdin!.includes("tmpfs"));
        assert.ok(stdin!.includes("base64 --decode"));
        const encoded = stdin!.match(
          /<<'PGCF_PROOF_CLI'\n([^\n]+)\nPGCF_PROOF_CLI/,
        );
        assert.ok(
          encoded,
          "actual CLI bytes must be staged into memory before input",
        );
        assert.deepEqual(
          Buffer.from(encoded[1]!, "base64"),
          await readFile((await readProofSourceAssets(false)).cli_path),
        );
        const pod = objects.get(key("pod", "outside-scan"))!;
        pod.status = {
          phase: failedLogs === null ? "Succeeded" : "Failed",
          containerStatuses: [
            {
              name: "scan",
              imageID: `docker-pullable://${source.image}`,
              state: { terminated: { exitCode: failedLogs === null ? 0 : 1 } },
            },
          ],
        };
        if (cancelOnExec) abort.abort();
        if (loseInputReply) {
          loseInputReply = false;
          throw new Error("input_reply_lost");
        }
        return { exit_code: 0, stdout: "pgcf_proof_input_ready\n" };
      }
      if (args[0] === "delete") {
        const path = args.find((value) => value.startsWith("--raw="))!.slice(6),
          kind = path.includes("/pods/") ? "pod" : "namespace",
          name = kind === "pod" ? "outside-scan" : state!.namespace_name!;
        const value = objects.get(key(kind, name))!,
          m = obj(value.metadata),
          preconditions = obj(JSON.parse(stdin!).preconditions);
        assert.equal(preconditions.uid, m.uid);
        assert.equal(preconditions.resourceVersion, m.resourceVersion);
        objects.delete(key(kind, name));
        return {
          exit_code: 0,
          stdout: JSON.stringify({ kind: "Status", status: "Success" }),
        };
      }
      throw new Error("unexpected_source_command");
    },
  };
  let cleanupUnavailable = false;
  return {
    source,
    input,
    measured,
    commands,
    objects,
    saved,
    mutations,
    logReads,
    actions,
    abort,
    node,
    state: () => state,
    authorizationCount: () => authorizationCount,
    loseCreate: () => {
      loseCreate = true;
    },
    replaceBeforeCleanup: () => {
      replaceBeforeCleanup = true;
    },
    cancelOnExec: () => {
      cancelOnExec = true;
    },
    cleanupUnavailable: () => {
      cleanupUnavailable = true;
    },
    restoreAuthority: () => {
      unavailable = false;
      cleanupUnavailable = false;
    },
    revokeAuthority: () => {
      unavailable = true;
    },
    failFirstNamespaceInventory: (onFailure: () => void = () => {}) => {
      firstNamespaceInventoryFailure = onFailure;
    },
    loseInputReply: () => {
      loseInputReply = true;
    },
    changePod: () => {
      changedPod = true;
    },
    addForeignChild: () => {
      foreignChild = true;
    },
    wrongImage: () => {
      wrongImage = true;
    },
    failPod: (logs: string, beforeInput = false) => {
      failedLogs = logs;
      failBeforeInput = beforeInput;
    },
    afterLogs: (callback: () => void) => {
      afterLogs = callback;
    },
  };
}

test("an owned failed scanner exposes its finite error before exact cleanup", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_control_peer_closed"}\n');
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /outside_scan_control_peer_closed/,
  );
  assert.equal(f.logReads.length, 1);
  assert.ok(f.logReads[0]!.includes("--limit-bytes=2048"));
  assert.ok(f.actions.indexOf("logs") < f.actions.indexOf("delete"));
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.state()!.stage, "cleaned");
});

test("a qualified Pod that fails before input upload can report only the known bounded error", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_command_input_invalid"}\n', true);
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /outside_scan_command_input_invalid/,
  );
  assert.equal(f.logReads.length, 1);
  assert.equal(
    f.mutations.some((args) => args[0] === "exec"),
    false,
  );
  assert.equal(f.state()!.stage, "cleaned");
});

test("arbitrary scanner codes never expose private Pod output", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_private_secret_canary"}\n');
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    (error: unknown) => {
      assert(error instanceof BootstrapError);
      assert.equal(error.code, "proof_source_pod_failed");
      assert.equal(error.message.includes("private_secret_canary"), false);
      return true;
    },
  );
});

test("extra diagnostic fields cannot turn Pod output into a status error", async () => {
  const f = fixture();
  f.failPod(
    '{"error_code":"outside_scan_deadline","secret":"private-canary"}\n',
  );
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
});

test("multiple diagnostic records retain the generic Pod failure", async () => {
  const f = fixture();
  f.failPod(
    '{"error_code":"outside_scan_deadline"}\n{"error_code":"outside_scan_cancelled"}\n',
  );
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
});

test("duplicate error-code fields retain the generic Pod failure", async () => {
  const f = fixture();
  f.failPod(
    '{"error_code":"outside_scan_deadline","error_code":"outside_scan_cancelled"}\n',
  );
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
});

test("missing diagnostic output retains the generic Pod failure", async () => {
  const f = fixture();
  f.failPod("");
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
});

test("diagnostics exceeding two KiB retain the generic failure even with a valid code", async () => {
  const f = fixture();
  f.failPod(" ".repeat(2048) + '{"error_code":"outside_scan_deadline"}');
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
});

test("the failed container must have the qualified actual image before any logs are read", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_deadline"}\n', true);
  f.wrongImage();
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
  assert.equal(f.logReads.length, 0);
});

test("changed Namespace ownership after logs prevents diagnostic promotion and Namespace deletion", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_deadline"}\n');
  f.afterLogs(() => {
    obj(f.objects.get(`namespace/${f.state()!.namespace_name}`)!.metadata).uid =
      randomUUID();
  });
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
  assert.equal(
    f.mutations.some(
      (args) =>
        args[0] === "delete" &&
        args.some(
          (value) =>
            value.includes("/namespaces/") && !value.includes("/pods/"),
        ),
    ),
    false,
  );
  assert.equal(f.objects.has(`namespace/${f.state()!.namespace_name}`), true);
  assert.equal(f.state()!.stage, "cleanup");
});

test("changed source Node identity after logs prevents diagnostic promotion and deletion", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_deadline"}\n');
  f.afterLogs(() => {
    f.node.metadata.uid = randomUUID();
  });
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
  assert.equal(
    f.mutations.some((args) => args[0] === "delete"),
    false,
  );
  assert.equal(f.state()!.stage, "cleanup");
});

test("changed Pod UID after logs prevents diagnostic promotion and deletion", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_deadline"}\n');
  f.afterLogs(() => {
    obj(f.objects.get("pod/outside-scan")!.metadata).uid = randomUUID();
  });
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
  assert.equal(
    f.mutations.some((args) => args[0] === "delete"),
    false,
  );
  assert.equal(f.state()!.stage, "cleanup");
});

test("current CF authority refusal after logs prevents diagnostic promotion and cleanup dispatch", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_deadline"}\n');
  f.afterLogs(f.revokeAuthority);
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_failed/,
  );
  assert.equal(
    f.mutations.some((args) => args[0] === "delete"),
    false,
  );
  assert.notEqual(f.state()!.stage, "cleaned");
});

test("installed source executes the real CLI path with exact identity, bounded memory-only input and confirmed UID cleanup", async () => {
  const f = fixture();
  f.loseCreate();
  const result = await runOwnedOutsideScan(f.source, f.input, f.commands);
  assert.deepEqual(result, f.measured);
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
  assert.equal(f.mutations.filter((args) => args[0] === "create").length, 2);
  assert.ok(f.saved.some((state) => state.namespace_uid && state.pod_uid));
});

test("a validated measurement survives a transient inventory failure only after exact cleanup completes", async () => {
  const f = fixture();
  let authorityAtFailure = 0;
  f.failFirstNamespaceInventory(() => {
    authorityAtFailure = f.authorizationCount();
  });
  const result = await runOwnedOutsideScan(f.source, f.input, f.commands);
  assert.deepEqual(result, f.measured);
  assert.ok(f.authorizationCount() > authorityAtFailure);
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.logReads.length, 1);
  assert.equal(f.state()!.receipt_sha256, hash(f.measured));
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
  assert.equal(f.mutations.filter((args) => args[0] === "create").length, 2);
  assert.equal(f.mutations.filter((args) => args[0] === "delete").length, 2);
});

test("an original scanner failure stays rejected after confirmed owned cleanup", async () => {
  const f = fixture();
  f.failPod('{"error_code":"outside_scan_source_unproven"}\n');
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code === "outside_scan_source_unproven",
  );
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.logReads.length, 1);
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.state()!.receipt_sha256, null);
  assert.equal(f.objects.size, 0);
});

test("a validated measurement is not returned while repeated cleanup sees a foreign child", async () => {
  const f = fixture();
  f.addForeignChild();
  f.failFirstNamespaceInventory();
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_namespace_children_unknown/,
  );
  assert.equal(f.state()!.receipt_sha256, hash(f.measured));
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.objects.has("persistentvolumeclaim/customer-data"), true);
  assert.equal(f.objects.has(`namespace/${f.state()!.namespace_name}`), true);
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.logReads.length, 1);
});

test("a validated measurement is not returned after cleanup authority is revoked", async () => {
  const f = fixture();
  f.failFirstNamespaceInventory();
  const saveOwnership = f.commands.saveOwnership!;
  f.commands.saveOwnership = async (state) => {
    await saveOwnership(state);
    if (state.stage === "cleaned") f.revokeAuthority();
  };
  await assert.rejects(runOwnedOutsideScan(f.source, f.input, f.commands));
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.state()!.receipt_sha256, hash(f.measured));
  assert.equal(f.objects.size, 0);
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.logReads.length, 1);
});

test("changed source identity keeps a validated measurement pending during cleanup recovery", async () => {
  const f = fixture();
  f.failFirstNamespaceInventory(() => {
    f.node.metadata.uid = randomUUID();
  });
  await assert.rejects(runOwnedOutsideScan(f.source, f.input, f.commands));
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.state()!.receipt_sha256, hash(f.measured));
  assert.equal(f.objects.has(`namespace/${f.state()!.namespace_name}`), true);
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.logReads.length, 1);
  assert.equal(
    f.mutations.some((args) =>
      args.some(
        (value) => value.includes("/namespaces/") && !value.includes("/pods/"),
      ),
    ),
    false,
  );
});

test("actual pulled image identity is checked before uploading or running the scanner", async () => {
  const f = fixture();
  f.wrongImage();
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_image_changed/,
  );
  assert.equal(
    f.mutations.some((args) => args[0] === "exec"),
    false,
  );
  assert.equal(f.state()!.stage, "cleaned");
});

test("a lost input acknowledgement resolves the completed owned Pod without a second scan", async () => {
  const f = fixture();
  f.loseInputReply();
  assert.deepEqual(
    await runOwnedOutsideScan(f.source, f.input, f.commands),
    f.measured,
  );
  assert.equal(f.mutations.filter((args) => args[0] === "exec").length, 1);
  assert.equal(f.state()!.stage, "cleaned");
});

test("a changed same-UID Pod command environment cannot execute or delete namespace resources", async () => {
  const f = fixture();
  f.changePod();
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_pod_identity_changed/,
  );
  assert.equal(
    f.mutations.some((args) => args[0] === "exec" || args[0] === "delete"),
    false,
  );
  assert.equal(f.state()!.stage, "cleanup");
});

test("the measured CLI bundle executes in a clean directory without external packages", async () => {
  const assets = await readProofSourceAssets(false),
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "pgcf-proof-cli-")),
    );
  try {
    const cli = join(directory, "outside-scan-command.mjs"),
      input = join(directory, "input.json");
    await copyFile(assets.cli_path, cli);
    await writeFile(input, "{}", { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, input], {
      env: { PATH: process.env.PATH, LANG: "C" },
      timeout: 5000,
      maxBuffer: 4096,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      '{"error_code":"outside_scan_command_input_invalid"}\n',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replaced Pod is never deleted and dirty cleanup ownership remains recorded", async () => {
  const f = fixture();
  f.replaceBeforeCleanup();
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_resource_not_owned/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(
    f.mutations.some((args) => args[0] === "delete"),
    false,
  );
  assert.equal(f.objects.size, 2);
});

test("an unexpected foreign PVC retains the namespace and is never deleted during exact Pod cleanup", async () => {
  const f = fixture();
  f.addForeignChild();
  await assert.rejects(
    runOwnedOutsideScan(f.source, f.input, f.commands),
    /proof_source_namespace_children_unknown/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.objects.has("pod/outside-scan"), false);
  assert.equal(f.objects.has("persistentvolumeclaim/customer-data"), true);
  assert.equal(f.objects.has(`namespace/${f.state()!.namespace_name}`), true);
  assert.equal(f.mutations.filter((args) => args[0] === "delete").length, 1);
  assert.ok(
    f.mutations
      .find((args) => args[0] === "delete")!
      .some((arg) => arg.includes("/pods/outside-scan")),
  );
});

test("caller cancellation permits exact cleanup with a fresh signal while unavailable authority preserves the journal", async () => {
  const cancelled = fixture();
  cancelled.cancelOnExec();
  await assert.rejects(
    runOwnedOutsideScan(cancelled.source, cancelled.input, cancelled.commands),
    /proof_source_cancelled/,
  );
  assert.equal(cancelled.state()!.stage, "cleaned");
  assert.equal(cancelled.objects.size, 0);
  const unavailable = fixture();
  unavailable.cleanupUnavailable();
  await assert.rejects(
    runOwnedOutsideScan(
      unavailable.source,
      unavailable.input,
      unavailable.commands,
    ),
    /source_authority_unavailable/,
  );
  assert.equal(unavailable.state()!.stage, "measured");
  assert.equal(unavailable.objects.size, 2);
});

test("an expired interrupted journal permits only fresh exact cleanup and cannot renew a scan", async () => {
  const f = fixture(),
    original = structuredClone(f.input);
  original.deadline_at = new Date(Date.now() - 60_000).toISOString();
  // The durable record keeps the immutable expired input, separately from the
  // fresh authority to delete its saved exact UIDs.
  const loaded = await readProofSourceAssets(false),
    olderBytes = Buffer.concat([
      await readFile(loaded.cli_path),
      Buffer.from("\n// previous measured artifact\n"),
    ]),
    assets = {
      ...loaded,
      cli_bytes: olderBytes.length,
      cli_sha256: createHash("sha256").update(olderBytes).digest("hex"),
    },
    invocation = randomUUID();
  const ownership: ProofSourceOwnership = {
    version: 1,
    source_sha256: hash(f.source),
    input_sha256: hash(original),
    invocation_id: invocation,
    kind: "pod",
    stage: "measured",
    scratch_directory: null,
    mount_source: null,
    namespace_name: `pgcf-proof-${hash({ input: hash(original), source: hash(f.source), invocation }).slice(0, 32)}`,
    namespace_uid: randomUUID(),
    pod_uid: randomUUID(),
    node_sha256: null,
    node_bytes: null,
    node_received_bytes: 0,
    cli_sha256: assets.cli_sha256,
    cli_bytes: assets.cli_bytes,
    receipt_sha256: hash(f.measured),
  };
  for (const value of proofSourcePodObjects(f.source, ownership, assets, 120)) {
    const m = obj(value.metadata);
    m.uid = value.kind === "Pod" ? ownership.pod_uid : ownership.namespace_uid;
    m.resourceVersion = "1";
    f.objects.set(`${String(value.kind).toLowerCase()}/${m.name}`, value);
  }
  let state = structuredClone(ownership);
  const commands: ProofSourceCommands = {
    ...f.commands,
    readOwnership: async () => structuredClone(state),
    saveOwnership: async (next) => {
      state = structuredClone(next);
    },
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "delete") {
        assert.ok(
          options && !options.signal.aborted && options.timeout_ms <= 30_000,
        );
        const path = args.find((arg) => arg.startsWith("--raw="))!.slice(6),
          kind = path.includes("/pods/") ? "pod" : "namespace",
          name = kind === "pod" ? "outside-scan" : ownership.namespace_name!;
        assert.equal(
          obj(JSON.parse(stdin!).preconditions).uid,
          obj(f.objects.get(`${kind}/${name}`)!.metadata).uid,
        );
        f.objects.delete(`${kind}/${name}`);
        return { exit_code: 0, stdout: "" };
      }
      assert.equal(["create", "exec", "logs"].includes(args[0]!), false);
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  f.abort.abort();
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(Date.now() + 25_000).toISOString(),
  );
  assert.equal(state.stage, "cleaned");
  assert.equal(f.objects.size, 0);
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      { ...original, direct_source: "203.0.113.100" },
      commands,
      new Date(Date.now() + 25_000).toISOString(),
    ),
    /proof_source_direct_source_mismatch/,
  );
});

async function expiredCleanupFixture() {
  const f = fixture(),
    assets = await readProofSourceAssets(false),
    original = structuredClone(f.input),
    invocation = randomUUID();
  original.deadline_at = new Date(Date.now() - 60_000).toISOString();
  const ownership: ProofSourceOwnership = {
    version: 1,
    source_sha256: hash(f.source),
    input_sha256: hash(original),
    invocation_id: invocation,
    kind: "pod",
    stage: "cleanup",
    scratch_directory: null,
    mount_source: null,
    namespace_name: `pgcf-proof-${hash({ input: hash(original), source: hash(f.source), invocation }).slice(0, 32)}`,
    namespace_uid: randomUUID(),
    pod_uid: randomUUID(),
    node_sha256: null,
    node_bytes: null,
    node_received_bytes: 0,
    cli_sha256: assets.cli_sha256,
    cli_bytes: assets.cli_bytes,
    receipt_sha256: null,
  };
  await f.commands.saveOwnership!(ownership);
  for (const value of proofSourcePodObjects(f.source, ownership, assets, 120)) {
    const m = obj(value.metadata);
    m.uid = value.kind === "Pod" ? ownership.pod_uid : ownership.namespace_uid;
    m.resourceVersion = "1";
    f.objects.set(`${String(value.kind).toLowerCase()}/${m.name}`, value);
  }
  return { f, original, ownership };
}
test("expired cleanup identifies its namespace inventory command deadline without deleting the owned namespace", async (t) => {
  const { f, original, ownership } = await expiredCleanupFixture();
  const boundedTimers: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const timer = new AbortController();
    boundedTimers.push(timer);
    return timer.signal;
  });
  t.mock.method(
    AbortSignal,
    "any",
    (signals: Iterable<AbortSignal>) => [...signals][0]!,
  );
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.startsWith("--raw=")) {
        assert.equal(options!.timeout_ms, 30_000);
        boundedTimers
          .find((timer) => timer.signal === options!.signal)!
          .abort(new DOMException("bounded cleanup deadline", "TimeoutError"));
        assert.equal(options!.signal.aborted, true);
        throw new BootstrapError("job_cancelled");
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code ===
        "proof_source_cleanup_namespace_inventory_command_deadline",
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.state()!.namespace_uid, ownership.namespace_uid);
  assert.equal(f.state()!.input_sha256, hash(original));
  assert.equal(f.objects.size, 1);
  assert.equal(
    obj(f.objects.get(`namespace/${ownership.namespace_name}`)!.metadata).uid,
    ownership.namespace_uid,
  );
  assert.equal(
    f.mutations.some((args) =>
      args.includes(`--raw=/api/v1/namespaces/${ownership.namespace_name}`),
    ),
    false,
  );
});

test("expired cleanup identifies a reduced aggregate deadline in its namespace inventory", async (t) => {
  const { f, original, ownership } = await expiredCleanupFixture(),
    boundedTimers: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const timer = new AbortController();
    boundedTimers.push(timer);
    return timer.signal;
  });
  t.mock.method(
    AbortSignal,
    "any",
    (signals: Iterable<AbortSignal>) => [...signals][0]!,
  );
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.startsWith("--raw=")) {
        assert.ok(options!.timeout_ms > 0 && options!.timeout_ms < 30_000);
        boundedTimers
          .find((timer) => timer.signal === options!.signal)!
          .abort(
            new DOMException("remaining aggregate deadline", "TimeoutError"),
          );
        throw new BootstrapError("job_cancelled");
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 20_000).toISOString(),
    ),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code ===
        "proof_source_cleanup_namespace_inventory_aggregate_deadline",
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.state()!.namespace_uid, ownership.namespace_uid);
  assert.equal(f.objects.size, 1);
});

test("a new external abort takes precedence over a concurrent cleanup command deadline", async (t) => {
  const { f, original, ownership } = await expiredCleanupFixture(),
    boundedTimers: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const timer = new AbortController();
    boundedTimers.push(timer);
    return timer.signal;
  });
  t.mock.method(
    AbortSignal,
    "any",
    (signals: Iterable<AbortSignal>) => [...signals][0]!,
  );
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.startsWith("--raw=")) {
        assert.equal(options!.timeout_ms, 30_000);
        f.abort.abort(new DOMException("new external abort", "AbortError"));
        boundedTimers
          .find((timer) => timer.signal === options!.signal)!
          .abort(new DOMException("bounded cleanup deadline", "TimeoutError"));
        throw new BootstrapError("job_cancelled");
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code === "proof_source_cleanup_namespace_inventory_external_abort",
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.state()!.namespace_uid, ownership.namespace_uid);
  assert.equal(f.objects.size, 1);
});

test("expired cleanup retains aggregate and individual bounds with coalesced identity reads", async (t) => {
  const f = fixture(),
    assets = await readProofSourceAssets(false),
    original = structuredClone(f.input),
    invocation = randomUUID(),
    base = Date.now();
  original.deadline_at = new Date(base - 60_000).toISOString();
  const ownership: ProofSourceOwnership = {
    version: 1,
    source_sha256: hash(f.source),
    input_sha256: hash(original),
    invocation_id: invocation,
    kind: "pod",
    stage: "running",
    scratch_directory: null,
    mount_source: null,
    namespace_name: `pgcf-proof-${hash({ input: hash(original), source: hash(f.source), invocation }).slice(0, 32)}`,
    namespace_uid: randomUUID(),
    pod_uid: randomUUID(),
    node_sha256: null,
    node_bytes: null,
    node_received_bytes: 0,
    cli_sha256: assets.cli_sha256,
    cli_bytes: assets.cli_bytes,
    receipt_sha256: null,
  };
  await f.commands.saveOwnership!(ownership);
  for (const value of proofSourcePodObjects(f.source, ownership, assets, 120)) {
    const m = obj(value.metadata);
    m.uid = value.kind === "Pod" ? ownership.pod_uid : ownership.namespace_uid;
    m.resourceVersion = "1";
    f.objects.set(`${String(value.kind).toLowerCase()}/${m.name}`, value);
  }
  let elapsed = 0,
    grants = 0;
  t.mock.method(Date, "now", () => base + elapsed);
  t.mock.method(performance, "now", () => elapsed);
  const commands: ProofSourceCommands = {
    ...f.commands,
    authorizeSource: async () => {
      elapsed += 3700;
      grants++;
      await f.commands.authorizeSource();
    },
    readOwnership: async () => {
      elapsed += 380;
      return f.commands.readOwnership!();
    },
    saveOwnership: async (state) => {
      elapsed += 380;
      await f.commands.saveOwnership!(state);
    },
    kube: async (args, permit, stdin, options) => {
      assert.ok(
        options && options.timeout_ms > 0 && options.timeout_ms <= 30_000,
      );
      assert.equal(["create", "exec", "logs"].includes(args[0]!), false);
      // Each real kubectl process opens its own proxy CONNECT, requiring the
      // second grant measured in the successful live callback trace.
      if (options!.timeout_ms < 3700) {
        elapsed += options!.timeout_ms;
        throw new BootstrapError("command_timeout");
      }
      elapsed += 3700;
      grants++;
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(base + 30_000).toISOString(),
    ),
    /proof_source_deadline/,
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(f.objects.size, 2);
  assert.equal(f.state()!.stage, "cleanup");
  elapsed = 0;
  grants = 0;
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(base + 120_001).toISOString(),
    ),
    /proof_source_deadline_invalid/,
  );
  assert.equal(grants, 0);
  assert.equal(f.objects.size, 2);
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(base + 120_000).toISOString(),
    ),
    /proof_source_deadline/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.state()!.namespace_uid, ownership.namespace_uid);
  assert.ok(f.objects.has(`namespace/${ownership.namespace_name}`));
  assert.equal(
    f.mutations.some((args) =>
      args.includes(`--raw=/api/v1/namespaces/${ownership.namespace_name}`),
    ),
    false,
  );
  t.diagnostic(
    JSON.stringify({
      cleanup_model_elapsed_ms: elapsed,
      successful_grants: grants,
    }),
  );
});

test("coalesced source identities settle raw collection inventory within the measured current-grant cleanup budget", async (t) => {
  const { f, original } = await expiredCleanupFixture(),
    base = Date.now(),
    pending: { at: number; resolve: () => void }[] = [],
    inventory: string[] = [],
    identities: string[][] = [];
  let elapsed = 0,
    scheduled = false,
    active = 0,
    maximumActive = 0;
  const drain = () => {
    scheduled = false;
    const next = Math.min(...pending.map((entry) => entry.at));
    elapsed = next;
    for (let index = pending.length - 1; index >= 0; index--)
      if (pending[index]!.at === next) pending.splice(index, 1)[0]!.resolve();
    if (pending.length) {
      scheduled = true;
      setImmediate(drain);
    }
  };
  const latency = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      pending.push({ at: elapsed + milliseconds, resolve });
      if (!scheduled) {
        scheduled = true;
        setImmediate(drain);
      }
    });
  t.mock.method(Date, "now", () => base + elapsed);
  t.mock.method(performance, "now", () => elapsed);
  t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  t.mock.method(
    AbortSignal,
    "any",
    (signals: Iterable<AbortSignal>) => [...signals][0]!,
  );
  const commands: ProofSourceCommands = {
    ...f.commands,
    authorizeSource: async () => {
      await latency(1833);
      await f.commands.authorizeSource();
    },
    readOwnership: async () => {
      await latency(380);
      return f.commands.readOwnership!();
    },
    saveOwnership: async (state) => {
      await latency(380);
      await f.commands.saveOwnership!(state);
    },
    kube: async (args, permit, stdin, options) => {
      assert.ok(options!.timeout_ms > 0 && options!.timeout_ms <= 30_000);
      const isInventory = args[0] === "get" && args[1]!.startsWith("--raw=");
      if (
        args[0] === "get" &&
        (args[1] === "namespace/kube-system" ||
          args[1] === "node" ||
          (args[1] === "namespace" && args[2] === "kube-system"))
      )
        identities.push(args);
      if (isInventory) {
        inventory.push(args[1]!);
        active++;
        maximumActive = Math.max(maximumActive, active);
      }
      try {
        await latency(1833);
        return await f.commands.kube!(args, permit, stdin, options);
      } finally {
        if (isInventory) active--;
      }
    },
  };
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(base + 120_000).toISOString(),
  );
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
  assert.equal(inventory.length, 13);
  assert.equal(new Set(inventory).size, 13);
  assert.equal(identities.length, 3);
  for (const [index, args] of identities.entries())
    assert.deepEqual(args, [
      "get",
      "namespace/kube-system",
      `node/${f.source.node_name}`,
      ...(index === 0
        ? ["pod/outside-scan", "--namespace", f.state()!.namespace_name!]
        : []),
      "--ignore-not-found",
      "--output=json",
    ]);
  assert.ok(elapsed > 0 && elapsed < 120_000);
  t.diagnostic(JSON.stringify({ measured_grant_model_elapsed_ms: elapsed }));
});

async function refusesSourceIdentity(
  change: (value: Json) => void,
  atRead = 1,
) {
  const { f, original, ownership } = await expiredCleanupFixture();
  let identityReads = 0;
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      const result = await f.commands.kube!(args, permit, stdin, options);
      if (args[0] === "get" && args[1] === "namespace/kube-system") {
        identityReads++;
        if (identityReads === atRead) {
          const value = obj(JSON.parse(result.stdout));
          const pod = (value.items as Json[]).find(
            (item) => item.kind === "Pod",
          );
          if (pod)
            value.items = (value.items as Json[]).filter(
              (item) => item !== pod,
            );
          change(value);
          if (pod) (value.items as Json[]).push(pod);
          return { ...result, stdout: JSON.stringify(value) };
        }
      }
      return result;
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_source_identity_changed/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.state()!.namespace_uid, ownership.namespace_uid);
  assert.ok(f.objects.has(`namespace/${ownership.namespace_name}`));
  return { f, identityReads };
}

test("source identity requires exactly the two named core objects with their original UIDs", async () => {
  await refusesSourceIdentity((value) => {
    (value.items as Json[]).pop();
  });
  await refusesSourceIdentity((value) => {
    const items = value.items as Json[];
    items.push(structuredClone(items[1]!));
  });
  await refusesSourceIdentity((value) => {
    const items = value.items as Json[];
    items[1] = structuredClone(items[0]!);
  });
  await refusesSourceIdentity((value) => {
    (value.items as Json[])[1]!.kind = "Pod";
  });
  await refusesSourceIdentity((value) => {
    const items = value.items as Json[];
    obj(items[1]!.metadata).name = "foreign-source";
  });
  await refusesSourceIdentity((value) => {
    obj((value.items as Json[])[0]!.metadata).uid = randomUUID();
  });
});

test("cleanup refreshes the exact source Node UID before deleting its namespace", async () => {
  const { f, identityReads } = await refusesSourceIdentity((value) => {
    obj((value.items as Json[])[1]!.metadata).uid = randomUUID();
  }, 3);
  assert.equal(identityReads, 3);
  assert.equal(f.objects.size, 1);
  assert.equal(f.mutations.length, 1);
});

test("cleanup reads source identities and its initial owned Pod in one core List", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  let initial = true;
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (initial && args[0] === "get" && args[1] === "namespace/kube-system") {
        initial = false;
        assert.deepEqual(args, [
          "get",
          "namespace/kube-system",
          `node/${f.source.node_name}`,
          "pod/outside-scan",
          "--namespace",
          ownership.namespace_name!,
          "--ignore-not-found",
          "--output=json",
        ]);
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(initial, false);
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
});

test("the combined cleanup snapshot refuses missing, extra and foreign identities before deletion", async () => {
  async function refuses(change: (items: Json[]) => void) {
    const { f, original } = await expiredCleanupFixture();
    let first = true;
    const commands: ProofSourceCommands = {
      ...f.commands,
      kube: async (args, permit, stdin, options) => {
        const result = await f.commands.kube!(args, permit, stdin, options);
        if (first && args[0] === "get" && args[1] === "namespace/kube-system") {
          first = false;
          const list = obj(JSON.parse(result.stdout));
          change(list.items as Json[]);
          return { ...result, stdout: JSON.stringify(list) };
        }
        return result;
      },
    };
    await assert.rejects(
      cleanupOwnedProofSource(
        f.source,
        original,
        commands,
        new Date(Date.now() + 120_000).toISOString(),
      ),
      /proof_source_(?:source_identity_changed|uid_changed|resource_not_owned)/,
    );
    assert.equal(f.mutations.length, 0);
    assert.equal(f.objects.size, 2);
    assert.equal(f.state()!.stage, "cleanup");
  }
  await refuses((items) => {
    items.splice(1, 1);
  });
  await refuses((items) => {
    items.push(structuredClone(items[1]!));
  });
  await refuses((items) => {
    obj(items[2]!.metadata).namespace = "foreign-namespace";
  });
  await refuses((items) => {
    obj(items[1]!.metadata).uid = randomUUID();
  });
  await refuses((items) => {
    obj(items[2]!.metadata).uid = randomUUID();
  });
});

test("a missing already-deleted owned Pod retains the fresh source identities and cleans its namespace", async () => {
  const { f, original } = await expiredCleanupFixture();
  f.objects.delete("pod/outside-scan");
  await cleanupOwnedProofSource(
    f.source,
    original,
    f.commands,
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
  assert.equal(f.mutations.length, 1);
});

test("Pod absence confirmation also reads its exact namespace before inventory", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  let paired = 0,
    separateNamespace = 0;
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && ["pod", "pod/outside-scan"].includes(args[1]!)) {
        assert.deepEqual(args, [
          "get",
          "pod/outside-scan",
          `namespace/${ownership.namespace_name!}`,
          "--namespace",
          ownership.namespace_name!,
          "--ignore-not-found",
          "--output=json",
        ]);
        paired++;
      }
      if (
        args[0] === "get" &&
        args[1] === "namespace" &&
        args[2] === ownership.namespace_name
      )
        separateNamespace++;
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(paired, 1);
  assert.equal(separateNamespace, 1);
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
});

test("paired Pod absence readback rejects a replaced namespace before inventory or deletion", async () => {
  const { f, original } = await expiredCleanupFixture();
  let inventories = 0;
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.startsWith("--raw=")) inventories++;
      const result = await f.commands.kube!(args, permit, stdin, options);
      if (args[0] === "get" && args[1] === "pod/outside-scan") {
        const list = obj(JSON.parse(result.stdout));
        assert.equal((list.items as Json[]).length, 1);
        obj((list.items as Json[])[0]!.metadata).uid = randomUUID();
        return { ...result, stdout: JSON.stringify(list) };
      }
      return result;
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_resource_not_owned/,
  );
  assert.equal(inventories, 0);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.objects.size, 1);
  assert.equal(f.state()!.stage, "cleanup");
});

test("paired readback confirms cleanup when kubectl returns empty successful output for two absent objects", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      const result = await f.commands.kube!(args, permit, stdin, options);
      if (args[0] === "get" && args[1] === "pod/outside-scan") {
        assert.equal(f.objects.has("pod/outside-scan"), false);
        f.objects.delete(`namespace/${ownership.namespace_name}`);
        return { exit_code: 0, stdout: "" };
      }
      return result;
    },
  };
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(f.mutations.length, 1);
  assert.equal(f.objects.size, 0);
  assert.equal(f.state()!.stage, "cleaned");
});

test("an uncertain Pod delete followed by an unknown paired readback is never replayed", async () => {
  const { f, original } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      const result = await f.commands.kube!(args, permit, stdin, options);
      if (args[0] === "delete") throw new BootstrapError("command_timeout");
      if (args[0] === "get" && args[1] === "pod/outside-scan")
        return { exit_code: 1, stdout: "" };
      return result;
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_command_failed/,
  );
  assert.equal(f.mutations.length, 1);
  assert.equal(f.objects.size, 1);
  assert.equal(f.state()!.stage, "cleanup");
});

test("cleanup inventories every standard collection without Kubernetes discovery", async () => {
  const { f, original, ownership } = await expiredCleanupFixture(),
    paths: string[] = [];
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.includes(","))
        throw new Error("discovery_read_forbidden");
      if (args[0] === "get" && args[1]!.startsWith("--raw=")) {
        paths.push(args[1]!.slice(6));
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(paths.length, 13);
  assert.equal(new Set(paths).size, 13);
  assert.ok(
    paths.every((value) =>
      value.includes(`/namespaces/${ownership.namespace_name}/`),
    ),
  );
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
});

test("typed Kubernetes collections accept omitted item TypeMeta from the verified collection", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.endsWith("/serviceaccounts"))
        return inventoryOutput(args, [
          {
            metadata: {
              name: "default",
              namespace: ownership.namespace_name,
              uid: randomUUID(),
              resourceVersion: "1",
            },
          },
        ]);
      if (args[0] === "get" && args[1]!.endsWith("/configmaps"))
        return inventoryOutput(args, [
          {
            metadata: {
              name: "kube-root-ca.crt",
              namespace: ownership.namespace_name,
              uid: randomUUID(),
              resourceVersion: "1",
            },
            data: {
              "ca.crt":
                "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n",
            },
          },
        ]);
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
});

test("a typed collection cannot disguise an allowed system child of another kind", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.endsWith("/secrets"))
        return inventoryOutput(args, [
          {
            apiVersion: "v1",
            kind: "ServiceAccount",
            metadata: {
              name: "default",
              namespace: ownership.namespace_name,
              uid: randomUUID(),
              resourceVersion: "1",
            },
          },
        ]);
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_namespace_children_unknown/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.ok(f.objects.has(`namespace/${ownership.namespace_name}`));
});

test("a collection refuses partially present item TypeMeta rather than inferring a conflicting identity", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.endsWith("/serviceaccounts"))
        return inventoryOutput(args, [
          {
            kind: "ServiceAccount",
            metadata: {
              name: "default",
              namespace: ownership.namespace_name,
              uid: randomUUID(),
              resourceVersion: "1",
            },
          },
        ]);
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_namespace_children_unknown/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.ok(f.objects.has(`namespace/${ownership.namespace_name}`));
});

test("a continued collection cannot authorize namespace deletion from a partial inventory", async () => {
  const { f, original, ownership } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.endsWith("/secrets")) {
        const result = inventoryOutput(args, []),
          value = obj(JSON.parse(result.stdout));
        value.metadata = { continue: "next-page" };
        return { ...result, stdout: JSON.stringify(value) };
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_namespace_children_unknown/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.ok(f.objects.has(`namespace/${ownership.namespace_name}`));
});

test("a foreign child in the final inventory batch preserves the namespace", async () => {
  const { f, original, ownership } = await expiredCleanupFixture(),
    inventory: string[] = [];
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.startsWith("--raw=")) {
        inventory.push(args[1]!);
        if (args[1]!.endsWith("/cronjobs"))
          return inventoryOutput(args, [
            {
              apiVersion: "batch/v1",
              kind: "CronJob",
              metadata: {
                name: "foreign",
                namespace: ownership.namespace_name,
                uid: randomUUID(),
                resourceVersion: "1",
              },
            },
          ]);
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_namespace_children_unknown/,
  );
  assert.equal(inventory.length, 13);
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.objects.size, 1);
});

test("a failed inventory batch waits for its started sibling before refusing namespace deletion", async () => {
  const { f, original } = await expiredCleanupFixture();
  let siblingSettled = false;
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[1]!.endsWith("/deployments"))
        throw new Error("inventory_read_unavailable");
      if (args[1]!.endsWith("/serviceaccounts")) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        siblingSettled = true;
      }
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /inventory_read_unavailable/,
  );
  assert.equal(siblingSettled, true);
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.objects.size, 1);
});

test("inventory batches share the original total output budget", async () => {
  const { f, original } = await expiredCleanupFixture();
  const commands: ProofSourceCommands = {
    ...f.commands,
    kube: async (args, permit, stdin, options) => {
      if (args[0] === "get" && args[1]!.startsWith("--raw="))
        return inventoryOutput(args, [], "x".repeat(70_000));
      return f.commands.kube!(args, permit, stdin, options);
    },
  };
  await assert.rejects(
    cleanupOwnedProofSource(
      f.source,
      original,
      commands,
      new Date(Date.now() + 120_000).toISOString(),
    ),
    /proof_source_output_limit/,
  );
  assert.equal(f.state()!.stage, "cleanup");
  assert.equal(f.objects.size, 1);
});

test("Pod source never receives host paths, API tokens or a global signing key", async () => {
  const f = fixture(),
    assets = await readProofSourceAssets(false),
    invocation = randomUUID();
  const state: ProofSourceOwnership = {
    version: 1,
    source_sha256: hash(f.source),
    input_sha256: hash(f.input),
    invocation_id: invocation,
    kind: "pod",
    stage: "intent",
    scratch_directory: null,
    mount_source: null,
    namespace_name: `pgcf-proof-${hash(invocation).slice(0, 32)}`,
    namespace_uid: null,
    pod_uid: null,
    node_sha256: null,
    node_bytes: null,
    node_received_bytes: 0,
    cli_sha256: assets.cli_sha256,
    cli_bytes: assets.cli_bytes,
    receipt_sha256: null,
  };
  const objects = proofSourcePodObjects(f.source, state, assets, 120),
    pod = objects[1]!,
    spec = obj(pod.spec),
    container = obj((spec.containers as unknown[])[0]);
  assert.equal(spec.hostNetwork, true);
  assert.equal(spec.nodeName, f.source.node_name);
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.serviceAccountName, undefined);
  assert.equal(container.image, f.source.image);
  assert.equal(container.env, undefined);
  assert.ok(
    JSON.stringify(container.command).includes(
      "/run/pgcf-proof/outside-scan-command.mjs",
    ),
  );
  assert.ok(
    !JSON.stringify(container.command).includes(
      "/app/outside-scan-command.mjs",
    ),
  );
  assert.ok(JSON.stringify(container.command).includes("version[0]!==24"));
  assert.equal(JSON.stringify(spec).includes("hostPath"), false);
  assert.equal(JSON.stringify(spec).includes(f.input.direct_source!), false);
  assert.deepEqual(obj(container.resources).limits, {
    memory: "512Mi",
    cpu: "500m",
  });
  assert.deepEqual(obj((spec.volumes as unknown[])[0]).emptyDir, {
    medium: "Memory",
    sizeLimit: "8Mi",
  });
});

test("rescue staging chunks are bounded, verify actual compressed bytes and only touch owned RAM files", async () => {
  const f = fixture(),
    invocation = randomUUID(),
    assets = await readProofSourceAssets(false);
  const state: ProofSourceOwnership = {
    version: 1,
    source_sha256: hash(f.source),
    input_sha256: hash(f.input),
    invocation_id: invocation,
    kind: "rescue",
    stage: "intent",
    scratch_directory: `/run/pgcf-proof-source/${f.input.plan.operation_id}-${invocation}`,
    mount_source: `pgcf-proof-${invocation}-${hash(f.input)}`,
    namespace_name: null,
    namespace_uid: null,
    pod_uid: null,
    node_sha256: hash(randomUUID()),
    node_bytes: 4096,
    node_received_bytes: 0,
    cli_sha256: assets.cli_sha256,
    cli_bytes: assets.cli_bytes,
    receipt_sha256: null,
  };
  const bytes = Buffer.concat(
      Array.from({ length: 128 }, (_, i) =>
        createHash("sha256").update(`pgcf-staging-36-${i}`).digest(),
      ),
    ),
    script = proofSourceChunkScript(state, 0, bytes),
    encoded = script.match(
      /<<'PGCF_PROOF_CHUNK'\n([^\n]+)\nPGCF_PROOF_CHUNK/,
    )![1]!;
  assert.deepEqual(gunzipSync(Buffer.from(encoded, "base64")), bytes);
  assert.ok(encoded.includes("apt"));
  assert.ok(script.includes("proof_current"));
  assert.ok(script.includes("iflag=skip_bytes,count_bytes"));
  const scratch = proofSourceScratchScript(
      state,
      {
        ...assets,
        node_bytes: 4096,
        node_sha256: state.node_sha256,
        node_path: process.execPath,
        architecture: "x86_64",
      },
      100,
    ),
    cleanup = proofSourceCleanupScript(state),
    execution = proofSourceExecutionScript(state, 60_000);
  assert.ok(scratch.includes("source_disk_mounted"));
  assert.ok(scratch.includes("swapon --show"));
  assert.ok(scratch.includes("MemAvailable"));
  assertSafeRescueScripts(scratch + script + cleanup);
  assert.ok(!cleanup.includes("rm -rf"));
  assert.ok(execution.includes("outside-scan-command.mjs"));
  assert.ok(
    execution.includes("test ! -e") && execution.includes("scan.started"),
  );
  assert.throws(
    () => proofSourceChunkScript(state, 0, Buffer.alloc(4 * 1024 ** 2 + 1)),
    /proof_source_chunk_invalid/,
  );
  for (const value of [scratch, script, cleanup, execution])
    assert.equal(
      (
        await runCommand({
          executable: "bash",
          args: ["-n"],
          stdin: value,
          env: { PATH: process.env.PATH, LANG: "C" },
          signal: AbortSignal.timeout(5000),
          timeout_ms: 5000,
        })
      ).exit_code,
      0,
    );
  assert.equal(gzipSync(bytes).length > 0, true);
});

test("source family mismatches and Linux binary absence fail before remote mutations", async () => {
  const f = fixture();
  await assert.rejects(
    runOwnedOutsideScan(
      f.source,
      { ...f.input, direct_source: "203.0.113.100" },
      f.commands,
    ),
    /proof_source_direct_source_mismatch/,
  );
  assert.equal(f.mutations.length, 0);
  if (process.platform !== "linux")
    await assert.rejects(
      readProofSourceAssets(true),
      /proof_source_linux_runtime_required/,
    );
  else {
    const assets = await readProofSourceAssets(true);
    assert.ok(assets.node_bytes! > 64);
    assert.match(assets.node_sha256!, /^[a-f0-9]{64}$/);
  }
});
