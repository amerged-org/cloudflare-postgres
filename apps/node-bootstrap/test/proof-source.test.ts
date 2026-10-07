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
    mutations: string[][] = [];
  let state: ProofSourceOwnership | null = null,
    loseCreate = false,
    replaceBeforeCleanup = false,
    unavailable = false,
    cancelOnExec = false,
    loseInputReply = false,
    changedPod = false,
    foreignChild = false,
    wrongImage = false;
  const abort = new AbortController();
  const key = (kind: string, name: string) => `${kind}/${name}`;
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
      if (args[0] === "get") {
        if (args[1]!.includes(","))
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: "v1",
              kind: "List",
              items: [...objects.values()].filter(
                (value) => obj(value.metadata).namespace === args[3],
              ),
            }),
          };
        if (args[1] === "node")
          return { exit_code: 0, stdout: JSON.stringify(node) };
        if (args[1] === "namespace" && args[2] === "kube-system")
          return {
            exit_code: 0,
            stdout: JSON.stringify({ metadata: { uid: source.cluster_uid } }),
          };
        const value = objects.get(key(args[1]!, args[2]!));
        return { exit_code: 0, stdout: value ? JSON.stringify(value) : "" };
      }
      if (args[0] === "logs")
        return { exit_code: 0, stdout: JSON.stringify(measured) };
      mutations.push(args);
      if (args[0] === "create") {
        assert.ok(state?.stage === "intent" || state?.stage === "ready");
        const value = JSON.parse(stdin!) as Json,
          m = obj(value.metadata);
        m.uid = randomUUID();
        m.resourceVersion = "1";
        if (value.kind === "Pod") {
          value.status = {
            phase: "Running",
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
          phase: "Succeeded",
          containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
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
    abort,
    node,
    state: () => state,
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
  };
}

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

test("expired cleanup has an aggregate budget for measured grant latency while every command remains bounded to thirty seconds", async (t) => {
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
  await cleanupOwnedProofSource(
    f.source,
    original,
    commands,
    new Date(base + 120_000).toISOString(),
  );
  assert.equal(f.state()!.stage, "cleaned");
  assert.equal(f.objects.size, 0);
  assert.deepEqual(
    f.mutations.map((args) => args[0]),
    ["delete", "delete"],
  );
  assert.ok(grants >= 20 && elapsed > 30_000 && elapsed < 120_000);
  t.diagnostic(
    JSON.stringify({
      cleanup_model_elapsed_ms: elapsed,
      successful_grants: grants,
    }),
  );
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
