// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
import { test } from "node:test";
import {
  FleetPatchCheckpoint,
  FleetPatchStatus,
  type FleetPatchFacts,
  fleetPatchCheckpointAllowed,
  fleetPatchTalosRebootObserved,
} from "@pgcf/contracts/fleet-patches";
import { runFleetPatch, validateFleetPatchInput } from "../src/fleet-patch.ts";
import {
  canonical,
  digest,
  type Command,
  type CommandRunner,
} from "../src/bootstrap.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { NodeHostConfigurationPrivate } from "@pgcf/contracts/node-host-configuration";

function runtime(
  checkConfig = false,
  afterDispatch?: (facts: FleetPatchFacts) => FleetPatchFacts,
  lostDispatchReply = false,
  failedLateRead = false,
  successfulInstall = false,
) {
  const fixture = patchFixture();
  let current = fixture.input.status,
    facts = fixture.facts;
  const writes: Command[] = [],
    checkpoints: FleetPatchCheckpoint[] = [];
  let lifecycleLogs = "";
  let machineConfiguration: string | undefined;
  let stateLoadedConfiguration = false;
  let applyProbe: CommandRunner | undefined;
  let kubeProbe:
    ((command: Command) => ReturnType<CommandRunner> | undefined) | undefined;
  let assetRequest: typeof fetch | undefined;
  let servingCertificate: string | undefined;
  let physicalHostFiles: Map<string, string> | undefined;
  const resource = (type: string, id: string, spec: unknown) =>
    JSON.stringify({ metadata: { type, id }, spec });
  const node = () => ({
    metadata: {
      name: "test-node",
      uid: facts.node_uid,
      labels: { "node-role.kubernetes.io/control-plane": "" },
    },
    status: {
      nodeInfo: {
        systemUUID: facts.system_uuid,
        bootID: facts.boot_id,
        kubeletVersion: facts.kubelet_version,
      },
      addresses: [{ type: "InternalIP", address: fixture.input.address }],
      conditions: [
        { type: "Ready", status: facts.node_ready ? "True" : "False" },
      ],
    },
  });
  return {
    fixture,
    writes,
    checkpoints,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    get facts() {
      return facts;
    },
    set facts(value: FleetPatchFacts) {
      facts = value;
    },
    set lifecycleLogs(value: string) {
      lifecycleLogs = value;
    },
    set machineConfiguration(value: string) {
      machineConfiguration = value;
    },
    set stateLoadedConfiguration(value: boolean) {
      stateLoadedConfiguration = value;
    },
    set applyProbe(value: CommandRunner) {
      applyProbe = value;
    },
    set kubeProbe(value: NonNullable<typeof kubeProbe>) {
      kubeProbe = value;
    },
    set assetRequest(value: typeof fetch) {
      assetRequest = value;
    },
    set servingCertificate(value: string) {
      servingCertificate = value;
    },
    set physicalHostFiles(value: Map<string, string>) {
      physicalHostFiles = value;
    },
    turn: () =>
      runFleetPatch(
        { ...fixture.input, status: current },
        {
          proxy: async () => ({
            url: "http://127.0.0.1:1",
            close: async () => {},
          }),
          request: async (_url, options) => {
            if (assetRequest && String(_url) !== fixture.input.callback.url)
              return assetRequest(_url, options);
            const body = JSON.parse(String(options?.body));
            if (body.kind === "status") return Response.json(current);
            if (body.kind !== "checkpoint")
              throw new Error("unexpected_network_action");
            const value = { ...body };
            delete value.kind;
            const checkpoint = FleetPatchCheckpoint.parse(value);
            assert.ok(
              fleetPatchCheckpointAllowed(
                { ...fixture.input, status: current },
                checkpoint,
              ),
            );
            checkpoints.push(checkpoint);
            current = FleetPatchStatus.parse({
              ...current,
              revision: current.revision + 1,
              stage: checkpoint.stage,
              state: checkpoint.state,
              baseline: current.baseline ?? checkpoint.facts,
              observed: checkpoint.facts,
              error_code: checkpoint.error_code,
              talos_upgrade_receipt:
                current.talos_upgrade_receipt ??
                checkpoint.talos_upgrade_receipt ??
                null,
            });
            if (checkpoint.state === "dispatched") {
              if (afterDispatch) facts = afterDispatch(facts);
              if (lostDispatchReply) {
                lostDispatchReply = false;
                throw new Error("lost_checkpoint_reply");
              }
            }
            return Response.json(current);
          },
          run: async (command) => {
            const args = command.args;
            if (command.executable === "kubectl" && kubeProbe) {
              const result = kubeProbe(command);
              if (result) return result;
            }
            if (
              servingCertificate &&
              command.executable === "talosctl" &&
              args.includes("/var/lib/kubelet/pki/kubelet.crt")
            )
              return { exit_code: 0, stdout: servingCertificate };
            if (
              args.includes("apply-config") &&
              machineConfiguration !== undefined
            ) {
              writes.push(command);
              assert.equal(current.state, "dispatched");
              if (applyProbe) return applyProbe(command);
              const file = args.find((arg) => arg.startsWith("--file="));
              machineConfiguration =
                file && file !== "--file=-"
                  ? await readFile(file.slice("--file=".length), "utf8")
                  : command.stdin;
              return { exit_code: 0, stdout: "" };
            }
            if (
              failedLateRead &&
              current.state === "dispatched" &&
              command.executable === "kubectl" &&
              args.includes("node")
            ) {
              failedLateRead = false;
              throw new Error("temporary_read_failure");
            }
            if (checkConfig) {
              const flag =
                  command.executable === "kubectl"
                    ? "--kubeconfig"
                    : "--talosconfig",
                value = parse(
                  await readFile(args[args.indexOf(flag) + 1]!, "utf8"),
                );
              const proxy =
                command.executable === "kubectl"
                  ? value.clusters[0].cluster["proxy-url"]
                  : value.contexts[value.context]["proxy-url"];
              assert.equal(
                proxy,
                command.env.HTTPS_PROXY,
                "current bridge must replace the old custody proxy",
              );
            }
            if (
              args.includes("upgrade") ||
              args.includes("upgrade-k8s") ||
              args.includes("reboot")
            ) {
              writes.push(command);
              assert.equal(current.state, "dispatched");
              if (successfulInstall && args.includes("upgrade"))
                return {
                  exit_code: 0,
                  stdout: `${fixture.input.address}: upgrade completed\n`,
                };
              throw new Error("lost_write_response");
            }
            let stdout: string;
            if (command.executable === "kubectl") {
              if (args.includes("namespace"))
                stdout = JSON.stringify({
                  metadata: { uid: facts.cluster_uid },
                });
              else if (args.includes("node")) stdout = JSON.stringify(node());
              else if (args.includes("nodes"))
                stdout = JSON.stringify({ items: [node()] });
              else if (args.includes("--raw=/version"))
                stdout = JSON.stringify({
                  gitVersion: facts.kubernetes_version,
                });
              else
                stdout = JSON.stringify({
                  items: [
                    {
                      status: {
                        conditions: [
                          {
                            type: "Ready",
                            status: facts.databases_ready ? "True" : "False",
                          },
                        ],
                      },
                    },
                  ],
                });
            } else if (args.includes("machineconfig")) {
              assert.ok(machineConfiguration);
              const ids = args.includes("v1alpha1")
                ? ["v1alpha1"]
                : args.includes("persistent")
                  ? ["persistent"]
                  : stateLoadedConfiguration
                    ? ["v1alpha1"]
                    : ["v1alpha1", "persistent"];
              stdout = ids
                .map((id) =>
                  resource(
                    "MachineConfigs.config.talos.dev",
                    id,
                    machineConfiguration,
                  ),
                )
                .join("\n");
            } else if (args.includes("logs")) stdout = lifecycleLogs;
            else if (physicalHostFiles && args.includes("read")) {
              const at = args.indexOf("read");
              const value = physicalHostFiles.get(args[at + 1]!);
              if (value === undefined) return { exit_code: 1, stdout: "" };
              stdout = value;
            } else if (args.includes("version"))
              stdout = JSON.stringify({
                version: { tag: facts.talos_version },
              });
            else if (args.includes("bootid"))
              stdout = resource("BootIDs.runtime.talos.dev", "boot-id", {
                bootID: facts.boot_id,
              });
            else if (args.includes("systeminformation"))
              stdout = resource(
                "SystemInformations.hardware.talos.dev",
                "systeminformation",
                { uuid: facts.system_uuid },
              );
            else
              stdout = resource(
                "ImageFactorySchematics.runtime.talos.dev",
                "image-factory-schematic",
                { schematicId: facts.talos_schematic_sha256 },
              );
            return { exit_code: 0, stdout };
          },
        },
      ),
  };
}
test("an uncertain Talos upgrade is sent once and unchanged boot/version never authorizes repetition", async () => {
  const r = runtime();
  await r.turn();
  await r.turn();
  assert.equal(r.current.stage, "host_config");
  await r.turn();
  await r.turn();
  assert.equal(r.current.stage, "host_service");
  await r.turn();
  await r.turn();
  assert.equal(r.current.stage, "kubernetes");
  r.current = { ...r.current, stage: "talos", baseline: r.fixture.facts };
  await r.turn();
  assert.equal(r.writes.length, 1);
  assert.equal(r.current.state, "dispatched");
  assert.ok(r.writes[0]!.args.includes("--no-reboot"));
  await r.turn();
  assert.equal(r.writes.length, 1);
  assert.equal(r.current.state, "dispatched");
  r.facts = { ...r.fixture.facts, talos_version: "v1.14.1" };
  await r.turn();
  assert.equal(r.current.state, "dispatched");
  assert.equal(r.writes.length, 1);
  r.facts = {
    ...r.fixture.facts,
    talos_version: "v1.14.1",
    boot_id: randomUUID(),
  };
  await r.turn();
  assert.equal(r.current.state, "dispatched");
  assert.equal(r.writes.length, 1);
});
test("a bounded Cloudflare management read can use measured transport headroom without starting a write", async () => {
  const r = runtime();
  let checked = 0;
  r.kubeProbe = (command) => {
    if (command.args.includes("get")) {
      // The observed compound Flux GET exceeded the former 30 s outer timer
      // after sequential authorized WebSocket setup.
      const measuredReadMs = 35_000;
      const requestSeconds = Number(
        command.args
          .find((arg) => arg.startsWith("--request-timeout="))
          ?.slice("--request-timeout=".length, -1),
      );
      if (
        command.timeout_ms <= measuredReadMs ||
        requestSeconds * 1000 <= measuredReadMs
      )
        throw new Error("command_timeout");
      assert.ok(command.timeout_ms <= 60_000);
      checked++;
    }
    return undefined;
  };
  await r.turn();
  assert.ok(checked > 0);
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 0);
});

test("sealed configurations use the current authorized bridge rather than an obsolete bootstrap proxy", async () => {
  const r = runtime(true);
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 0);
});
test("the same invocation resolves a committed dispatch checkpoint response before its first and only write", async () => {
  const r = runtime(false, undefined, true);
  r.current = { ...r.current, stage: "talos", baseline: r.fixture.facts };
  await r.turn();
  assert.equal(r.writes.length, 1);
  assert.equal(r.current.state, "dispatched");
  await r.turn();
  assert.equal(r.writes.length, 1);
});
test("late unhealthy or changed-runtime preflight facts prevent Talos and Kubernetes writes", async () => {
  const talos = runtime(false, (facts) => ({
    ...facts,
    node_ready: false,
    boot_id: randomUUID(),
  }));
  talos.current = {
    ...talos.current,
    stage: "talos",
    baseline: talos.fixture.facts,
  };
  await talos.turn();
  assert.equal(talos.writes.length, 0);
  assert.equal(talos.current.state, "pending");
  assert.equal(talos.current.error_code, "patch_write_not_attempted");
  const kube = runtime(false, (facts) => ({
      ...facts,
      databases_ready: false,
    })),
    facts = { ...kube.fixture.facts, talos_version: "v1.14.1" };
  kube.facts = facts;
  kube.current = { ...kube.current, stage: "kubernetes", baseline: facts };
  await kube.turn();
  assert.equal(kube.writes.length, 0);
  assert.equal(kube.current.state, "pending");
});
test("a failed same-execution late read records no attempted write instead of stranding a false uncertainty", async () => {
  const r = runtime(false, undefined, false, true);
  r.current = { ...r.current, stage: "talos", baseline: r.fixture.facts };
  await r.turn();
  assert.equal(r.writes.length, 0);
  assert.equal(r.current.state, "pending");
  assert.equal(r.current.error_code, "patch_write_not_attempted");
});
test("Kubernetes unknown outcomes only advance after both API and kubelet report the target", async () => {
  const r = runtime(),
    facts = { ...r.fixture.facts, talos_version: "v1.14.1" };
  r.facts = facts;
  r.current = { ...r.current, stage: "kubernetes", baseline: facts };
  await r.turn();
  assert.equal(r.writes.length, 1);
  assert.equal(r.current.state, "dispatched");
  r.facts = { ...facts, kubernetes_version: "v1.36.5" };
  await r.turn();
  assert.equal(r.current.state, "dispatched");
  assert.equal(r.writes.length, 1);
  r.facts = {
    ...facts,
    kubernetes_version: "v1.36.5",
    kubelet_version: "v1.36.5",
  };
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 1);
});
test("fresh cluster/node identity changes and unhealthy databases prevent a write", async () => {
  const r = runtime();
  r.current = { ...r.current, stage: "talos", baseline: r.fixture.facts };
  r.facts = { ...r.fixture.facts, node_uid: randomUUID() };
  await assert.rejects(r.turn(), /patch_cluster_membership_changed/);
  assert.equal(r.writes.length, 0);
  r.facts = { ...r.fixture.facts, databases_ready: false };
  await assert.rejects(r.turn(), /patch_checkpoint_invalid/);
  assert.equal(r.writes.length, 0);
});
test("a modified desired spec and off-origin callback are rejected before access", () => {
  const { input } = patchFixture();
  const changed = structuredClone(input);
  changed.spec.roles.customer.talos_version = "1.14.2";
  changed.spec.roles.control_relay.talos_version = "1.14.2";
  assert.throws(
    () => validateFleetPatchInput(changed),
    /patch_release_hash_mismatch/,
  );
  assert.throws(
    () =>
      validateFleetPatchInput({
        ...input,
        callback: {
          ...input.callback,
          url: "https://api.invalid/internal/v1/node-bootstrap/op_abcdefghijklmnopqrst",
        },
      }),
    /patch_endpoint_invalid/,
  );
});
async function servingPinFixture(r: ReturnType<typeof runtime>) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-patch-pin-test-"));
  const certificate = join(directory, "public.fixture.pem");
  try {
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ed25519",
        "-nodes",
        "-keyout",
        join(directory, "generated-fixture-material"),
        "-out",
        certificate,
        "-subj",
        "/CN=test-node",
        "-addext",
        "subjectAltName=DNS:test-node",
        "-days",
        "2",
      ],
      { timeout: 15_000 },
    );
    assert.equal(generated.status, 0);
    const pem = await readFile(certificate, "utf8");
    r.servingCertificate = pem;
    r.fixture.input.initial_bootstrap_input_sha256 =
      digest("initial-bootstrap");
    const namespaceUid = randomUUID();
    let pinWrites = 0,
      replacementStage = r.current.stage;
    let map = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: `kubelet-${r.fixture.facts.node_uid}`,
        namespace: "pgcf-system",
        uid: randomUUID(),
        resourceVersion: "3",
        labels: {
          "pgcf.io/kubelet-node-uid": r.fixture.facts.node_uid,
          "pgcf.io/kubelet-cluster-uid": r.fixture.facts.cluster_uid,
          "pgcf.io/node-id": r.fixture.input.status.node_id,
          "pgcf.io/region": r.fixture.input.status.region_id,
        },
        annotations: {
          "pgcf.io/bootstrap-input":
            r.fixture.input.initial_bootstrap_input_sha256,
        },
      },
      data: {
        node_name: "test-node",
        node_uid: r.fixture.facts.node_uid,
        cluster_uid: r.fixture.facts.cluster_uid,
        certificate_pem: "retired-public-fixture",
        certificate_sha256: digest("retired-public-fixture"),
      },
    };
    r.kubeProbe = (command) => {
      const args = command.args;
      if (args.includes("replace")) {
        assert.equal(
          r.current.stage,
          replacementStage,
          "the pin refresh precedes stage acceptance",
        );
        pinWrites++;
        const updated = JSON.parse(command.stdin!) as typeof map;
        assert.equal(updated.metadata.uid, map.metadata.uid);
        assert.equal(
          updated.metadata.resourceVersion,
          map.metadata.resourceVersion,
        );
        map = updated;
        map.metadata.resourceVersion = "4";
        return Promise.resolve({ exit_code: 0, stdout: JSON.stringify(map) });
      }
      if (args.includes("configmap"))
        return Promise.resolve({ exit_code: 0, stdout: JSON.stringify(map) });
      if (args.includes("namespace")) {
        const name = args[args.indexOf("namespace") + 1];
        return Promise.resolve({
          exit_code: 0,
          stdout: JSON.stringify({
            apiVersion: "v1",
            kind: "Namespace",
            metadata: {
              name,
              uid:
                name === "kube-system"
                  ? r.fixture.facts.cluster_uid
                  : namespaceUid,
              resourceVersion: "1",
            },
          }),
        });
      }
      if (args.includes("node"))
        return Promise.resolve({
          exit_code: 0,
          stdout: JSON.stringify({
            apiVersion: "v1",
            kind: "Node",
            metadata: {
              name: "test-node",
              uid: r.fixture.facts.node_uid,
              resourceVersion: "12",
              labels: {
                "pgcf.io/node-id": r.fixture.input.status.node_id,
                "pgcf.io/region": r.fixture.input.status.region_id,
                "pgcf.io/provider-instance-id": "provider-fixture",
                "node-role.kubernetes.io/control-plane": "",
              },
            },
            status: {
              nodeInfo: {
                systemUUID: r.facts.system_uuid,
                bootID: r.facts.boot_id,
                kubeletVersion: "v1.36.5",
              },
              addresses: [
                { type: "InternalIP", address: r.fixture.input.address },
              ],
              conditions: [{ type: "Ready", status: "True" }],
            },
          }),
        });
      return undefined;
    };
    return {
      writes: () => pinWrites,
      current: () => map,
      pem,
      retire: () => {
        replacementStage = r.current.stage;
        map.data.certificate_pem = "retired-public-fixture";
        map.data.certificate_sha256 = digest(map.data.certificate_pem);
      },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
test("runtime verification and a host-only confirmed successor refresh the serving pin before acceptance", async () => {
  const r = runtime();
  r.current = { ...r.current, stage: "verify", baseline: r.fixture.facts };
  const facts = {
    ...r.fixture.facts,
    talos_version: "v1.14.1",
    kubernetes_version: "v1.36.5",
    kubelet_version: "v1.36.5",
  };
  r.facts = facts;
  const pin = await servingPinFixture(r);
  try {
    await r.turn();
    assert.equal(r.current.stage, "runtime_verified");
    assert.equal(r.writes.length, 0);
    assert.equal(pin.writes(), 1);
    assert.equal(pin.current().data.certificate_pem, pin.pem);

    const boot = randomUUID();
    r.fixture.input.host_configuration_only = true;
    r.facts = { ...facts, boot_id: boot };
    r.current = {
      ...r.current,
      stage: "host_service",
      state: "confirmed",
      observed: { ...facts, boot_id: boot },
    };
    pin.retire();
    await r.turn();
    assert.equal(
      pin.writes(),
      2,
      "a host-only successor cannot bypass the current serving pin",
    );
    assert.equal(pin.current().data.certificate_pem, pin.pem);
    assert.equal(r.current.stage, "runtime_admission");
    assert.equal(r.current.state, "pending");
    assert.equal(r.writes.length, 0);
  } finally {
    await pin.close();
  }
});
test("cluster upgrade confirmation rejects a second member that still runs the old kubelet", () => {
  const { input, facts } = patchFixture(),
    uid = randomUUID();
  input.status = {
    ...input.status,
    stage: "kubernetes",
    state: "dispatched",
    baseline: facts,
  };
  input.cluster_nodes.push({
    ...input.cluster_nodes[0]!,
    node_id: "nod_zzzzzzzzzzzzzzzzzzzz",
    node_uid: uid,
    k8s_node_name: "second-node",
  });
  const value = {
    expected_revision: 0,
    stage: "kubernetes" as const,
    state: "confirmed" as const,
    error_code: null,
    facts: {
      ...facts,
      talos_version: "v1.14.1",
      kubernetes_version: "v1.36.5",
      kubelet_version: "v1.36.5",
      cluster_nodes: [
        {
          node_uid: facts.node_uid,
          kubelet_version: "v1.36.5",
          node_ready: true,
        },
        { node_uid: uid, kubelet_version: "v1.36.3", node_ready: true },
      ],
    },
  };
  assert.equal(fleetPatchCheckpointAllowed(input, value), false);
  value.facts.cluster_nodes[1]!.kubelet_version = "v1.36.5";
  assert.equal(fleetPatchCheckpointAllowed(input, value), true);
});

test("positive no-reboot installation is durably received before one separately fenced reboot", async () => {
  const r = runtime(false, undefined, false, false, true);
  r.current = { ...r.current, stage: "talos", baseline: r.fixture.facts };
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.current.talos_upgrade_receipt?.source, "cli_exit_0");
  assert.equal(r.writes.length, 1);
  await r.turn();
  assert.equal(r.current.stage, "talos_reboot");
  await r.turn();
  assert.equal(r.writes.length, 2);
  assert.ok(r.writes[1]!.args.includes("reboot"));
  await r.turn();
  assert.equal(r.writes.length, 2);
  assert.equal(r.current.state, "dispatched");
  r.facts = {
    ...r.fixture.facts,
    talos_version: "v1.14.1",
    boot_id: randomUUID(),
  };
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 2);
});

test("the qualified Native rebinds a previous exact deployment receipt only on the same physical boot, avoiding an unchanged OS write", async () => {
  const r = runtime();
  const facts = { ...r.fixture.facts, talos_version: "v1.14.1" };
  r.facts = facts;
  r.current = { ...r.current, stage: "talos", baseline: facts };
  r.fixture.input.retained_talos_installation = {
    receipt: {
      method: "deploymentreceipt",
      installer: r.fixture.input.spec.roles.customer.talos_installer,
      node_uid: facts.node_uid,
      cluster_uid: facts.cluster_uid,
      system_uuid: facts.system_uuid,
      pre_reboot_boot_id: randomUUID(),
      completed_at: new Date(Date.now() - 86400000).toISOString(),
      source: "cli_exit_0",
    },
    boot_id: facts.boot_id,
    talos_version: facts.talos_version,
    talos_schematic_sha256: facts.talos_schematic_sha256,
  };
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 0);
  await r.turn();
  await r.turn();
  assert.equal(r.current.stage, "talos_reboot");
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 0);
});
test("a retained current image cannot satisfy the separate prepared-authority reboot until that dispatch's boot changes", () => {
  const { input, facts: original } = patchFixture(),
    facts = { ...original, talos_version: "v1.14.1" },
    receipt = {
      method: "deploymentreceipt" as const,
      installer: input.spec.roles.customer.talos_installer,
      node_uid: facts.node_uid,
      cluster_uid: facts.cluster_uid,
      system_uuid: facts.system_uuid,
      pre_reboot_boot_id: randomUUID(),
      completed_at: new Date().toISOString(),
      source: "cli_exit_0" as const,
    };
  input.status = {
    ...input.status,
    stage: "talos_reboot",
    state: "pending",
    talos_upgrade_receipt: receipt,
  };
  assert.equal(fleetPatchTalosRebootObserved(input, facts), true);
  input.authority_rotation = {
    checkpoint: {
      revision: 15,
      phase: "discovery-secret",
      node_index: 0,
      state: "confirmed",
    },
  } as NonNullable<typeof input.authority_rotation>;
  assert.equal(fleetPatchTalosRebootObserved(input, facts), false);
  input.authority_rotation.checkpoint = {
    revision: 16,
    phase: "etcd-ca",
    node_index: 0,
    state: "confirmed",
    prior_boot_id: facts.boot_id,
  };
  assert.equal(fleetPatchTalosRebootObserved(input, facts), false);
  assert.equal(
    fleetPatchTalosRebootObserved(input, { ...facts, boot_id: randomUUID() }),
    true,
  );
});

test("deployment-pinned storage authority keys cannot be replaced in private patch input", () => {
  const { input } = patchFixture(),
    keys = { test: "A".repeat(43) },
    sha256 = digest(canonical(keys));
  input.spec.storage_authority_keys_sha256 = sha256;
  input.storage_authority = { keys, sha256 };
  input.status.spec_sha256 = digest(canonical(input.spec));
  assert.doesNotThrow(() => validateFleetPatchInput(input));
  assert.throws(
    () =>
      validateFleetPatchInput({
        ...input,
        storage_authority: {
          ...input.storage_authority,
          keys: { test: "B".repeat(43) },
        },
      }),
    /patch_storage_authority_binding_invalid|storage_authority_keys_invalid/,
  );
  assert.throws(
    () => validateFleetPatchInput({ ...input, storage_authority: undefined }),
    /patch_storage_authority_missing/,
  );
});

test("Talos loaded-extension/service parsers preserve vendor running and health-unknown facts without inventing an image digest", async () => {
  const { readFleetTalosExtensions, readFleetTalosServices } =
    await import("../src/fleet-patch-observations.ts");
  const extension = JSON.stringify({
    metadata: { type: "ExtensionStatuses.runtime.talos.dev", id: "0" },
    spec: {
      metadata: {
        name: "pgcf-sandbox-controller",
        version: "0.1.0-" + "a".repeat(40),
      },
    },
  });
  assert.equal(
    readFleetTalosExtensions(extension).get("pgcf-sandbox-controller"),
    "0.1.0-" + "a".repeat(40),
  );
  assert.throws(
    () => readFleetTalosExtensions(extension + "\n" + extension),
    /patch_extension_resource_invalid/,
  );
  const service = {
    metadata: {
      type: "Services.v1alpha1.talos.dev",
      id: "ext-pgcf-sandbox-controller",
    },
    spec: { running: true, healthy: false, unknown: true },
  };
  assert.deepEqual(
    readFleetTalosServices(JSON.stringify(service)).get(service.metadata.id),
    service.spec,
  );
  assert.throws(
    () =>
      readFleetTalosServices(
        JSON.stringify({ ...service, spec: { running: true, healthy: false } }),
      ),
    /patch_service_resource_invalid/,
  );
});

test("a current-custody host-only finalization skips every OS and Kubernetes write stage", async () => {
  const r = runtime();
  r.fixture.input.host_configuration_only = true;
  r.current = {
    ...r.current,
    stage: "host_service",
    state: "confirmed",
    baseline: r.fixture.facts,
  };
  const pin = await servingPinFixture(r);
  try {
    await r.turn();
    assert.equal(r.current.stage, "runtime_admission");
    assert.equal(r.current.state, "pending");
    assert.equal(r.writes.length, 0);
    assert.equal(pin.writes(), 1);
  } finally {
    await pin.close();
  }
});

test("host-only file activation dispatches one normal reboot and resolves an unknown result without repeating it", async () => {
  const { r, pins } = pinnedKubernetesRuntime(),
    files = NodeHostConfigurationPrivate.shape.files.parse([
      {
        path: "/var/lib/pgcf-sandbox/settings.json",
        permissions: 384,
        content: "new-settings",
      },
      {
        path: "/var/lib/pgcf-sandbox/agent-key",
        permissions: 384,
        content: "retained-key",
      },
    ]),
    target = r.fixture.input.spec.roles.customer,
    facts = {
      ...r.fixture.facts,
      talos_version: "v" + target.talos_version,
      kubernetes_version: "v" + target.kubernetes_version,
      kubelet_version: "v" + target.kubernetes_version,
      cluster_nodes: [
        {
          node_uid: r.current.node_uid,
          kubelet_version: "v" + target.kubernetes_version,
          node_ready: true,
        },
      ],
    };
  target.host_configuration_required = true;
  r.fixture.input.host_configuration_only = true;
  r.fixture.input.host_configuration = NodeHostConfigurationPrivate.parse({
    files,
    status: {
      version: 1,
      node_id: r.current.node_id,
      node_uid: facts.node_uid,
      region_id: r.current.region_id,
      cluster_uid: facts.cluster_uid,
      material_revision: 3,
      revision: 2,
      release_id: r.current.release_id,
      pool_policy_revision: 1,
      profile_sha256: "f".repeat(64),
      sha256: digest(canonical(files)),
      created_at: new Date().toISOString(),
    },
  });
  const host = r.fixture.input.host_configuration;
  r.current = {
    ...r.current,
    stage: "host_service",
    state: "pending",
    baseline: facts,
    observed: { ...facts, host_configuration_sha256: host.status.sha256 },
    host_configuration_revision: host.status.revision,
    host_configuration_sha256: host.status.sha256,
    spec_sha256: digest(canonical(r.fixture.input.spec)),
  };
  r.facts = facts;
  r.machineConfiguration = [
    {
      version: "v1alpha1",
      machine: {
        type: "controlplane",
        files: files.map((file) => ({ ...file, op: "create" })),
      },
    },
    ...Object.entries({
      kubelet: "KubeletConfig",
      apiServer: "KubeAPIServerConfig",
      controllerManager: "KubeControllerManagerConfig",
      scheduler: "KubeSchedulerConfig",
    }).map(([name, kind]) => ({
      apiVersion: "v1alpha1",
      kind,
      image: pins[name as keyof typeof pins],
    })),
  ]
    .map((value) => stringify(value))
    .join("---\n");
  r.physicalHostFiles = new Map(
    files.map((file) => [
      file.path,
      file.path.endsWith("settings.json") ? "old-settings" : file.content,
    ]),
  );
  await r.turn();
  assert.equal(r.current.state, "dispatched");
  assert.equal(r.current.observed?.boot_id, facts.boot_id);
  assert.equal(r.current.observed?.host_configuration_sha256, undefined);
  assert.equal(r.writes.length, 1);
  assert.ok(r.writes[0]!.args.includes("reboot"));
  assert.ok(!r.writes[0]!.args.includes("upgrade"));
  await r.turn();
  assert.equal(r.writes.length, 1);
  assert.equal(r.current.state, "dispatched");
  r.facts = { ...facts, boot_id: randomUUID() };
  r.stateLoadedConfiguration = true;
  r.physicalHostFiles = new Map(files.map((file) => [file.path, file.content]));
  await r.turn();
  assert.equal(r.writes.length, 1);
  assert.equal(
    r.current.state,
    "dispatched",
    "fresh service/pool evidence is still required",
  );
  const activatedBoot = randomUUID();
  r.facts = { ...facts, boot_id: activatedBoot };
  r.current = {
    ...r.current,
    state: "confirmed",
    observed: {
      ...facts,
      boot_id: activatedBoot,
      kubernetes_control_plane: true,
      kubernetes_image_configuration: pins,
      kubernetes_configuration_boot_id: facts.boot_id,
      kubernetes_configuration_observed_at: new Date().toISOString(),
      host_configuration_sha256: host.status.sha256,
      sandbox_service_running: true,
    },
  };
  const pin = await servingPinFixture(r);
  try {
    await r.turn();
    assert.equal(r.current.stage, "runtime_admission");
    assert.equal(r.current.state, "pending");
    assert.equal(r.writes.length, 1);
    assert.equal(pin.writes(), 1);
  } finally {
    await pin.close();
  }
});

test("Flux records a new resource UID while dispatched without replacing prior identity", () => {
  const { input, facts } = patchFixture(),
    prior = { "Namespace//flux-system": randomUUID() };
  input.status.stage = "flux";
  input.status.state = "dispatched";
  input.status.observed = { ...facts, platform_resource_uids: prior };
  const next = {
    expected_revision: input.status.revision,
    stage: "flux" as const,
    state: "dispatched" as const,
    facts: {
      ...facts,
      platform_resource_uids: {
        ...prior,
        "ResourceQuota/flux-system/critical-pods": randomUUID(),
      },
    },
    error_code: null,
  };
  assert.equal(fleetPatchCheckpointAllowed(input, next), true);
  next.facts.platform_resource_uids["Namespace//flux-system"] = randomUUID();
  assert.equal(fleetPatchCheckpointAllowed(input, next), false);
  input.status.stage = "talos";
  assert.equal(
    fleetPatchCheckpointAllowed(input, { ...next, stage: "talos" }),
    false,
  );
});

test("the existing callback accepts a bounded status larger than 32 KiB without changing patch authority", async () => {
  const f = runtime(),
    facts = {
      ...f.fixture.facts,
      platform_resource_uids: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `Deployment/flux-system/retained-resource-${i}`,
          randomUUID(),
        ]),
      ),
    };
  f.current = { ...f.current, baseline: facts, observed: facts };
  const bytes = Buffer.byteLength(JSON.stringify(f.current));
  assert.ok(bytes > 32 * 1024 && bytes < 128 * 1024);
  const before = f.current.operation_id;
  await f.turn();
  assert.equal(f.current.operation_id, before);
  assert.equal(f.current.stage, "preflight");
  assert.equal(f.current.state, "confirmed");
  assert.equal(f.writes.length, 0);
});

function pinnedKubernetesRuntime() {
  const r = runtime(),
    pins = {
      kubelet: `registry.example/kubelet:v1.36.5@sha256:${"1".repeat(64)}`,
      apiServer: `registry.example/kube-apiserver:v1.36.5@sha256:${"2".repeat(64)}`,
      controllerManager: `registry.example/kube-controller-manager:v1.36.5@sha256:${"3".repeat(64)}`,
      scheduler: `registry.example/kube-scheduler:v1.36.5@sha256:${"4".repeat(64)}`,
    };
  r.fixture.input.spec.roles.customer.kubernetes_images = pins;
  r.current.spec_sha256 = digest(canonical(r.fixture.input.spec));
  r.current.stage = "kubernetes_images";
  r.facts = {
    ...r.fixture.facts,
    kubernetes_version: "v1.36.5",
    kubelet_version: "v1.36.5",
    cluster_nodes: [
      {
        node_uid: r.fixture.facts.node_uid,
        kubelet_version: "v1.36.5",
        node_ready: true,
      },
    ],
  };
  r.machineConfiguration = [
    { version: "v1alpha1", machine: { type: "controlplane" } },
    { apiVersion: "v1alpha1", kind: "KubeProxyConfig", disabled: true },
    ...Object.entries({
      kubelet: "KubeletConfig",
      apiServer: "KubeAPIServerConfig",
      controllerManager: "KubeControllerManagerConfig",
      scheduler: "KubeSchedulerConfig",
    }).map(([key, kind]) => ({
      apiVersion: "v1alpha1",
      kind,
      image: pins[key as keyof typeof pins].split("@")[0],
    })),
  ]
    .map((value) => stringify(value))
    .join("---\n");
  return { r, pins };
}
test("a later host-required preflight uses retained installed boot/configuration proof without accepting a new target as already installed", async () => {
  const { r, pins } = pinnedKubernetesRuntime(),
    priorBoot = randomUUID(),
    boot = randomUUID(),
    facts = {
      ...r.fixture.facts,
      boot_id: boot,
      talos_version: "v1.14.1",
      kubelet_version: "v1.36.5",
      kubernetes_version: "v1.36.5",
    };
  const oldInstaller = r.fixture.input.spec.roles.customer.talos_installer;
  r.fixture.input.spec.roles.customer.host_configuration_required = true;
  r.fixture.input.spec.roles.customer.talos_version = "1.14.2";
  r.fixture.input.spec.roles.control_relay.talos_version = "1.14.2";
  r.fixture.input.spec.roles.customer.talos_installer = `registry.example/new-target@sha256:${"e".repeat(64)}`;
  const files = NodeHostConfigurationPrivate.shape.files.parse([
    {
      path: "/var/lib/pgcf-sandbox/settings.json",
      permissions: 384,
      content: "test-only-settings",
    },
    {
      path: "/var/lib/pgcf-sandbox/agent-key",
      permissions: 384,
      content: "test-only-key",
    },
  ]);
  r.fixture.input.host_configuration = NodeHostConfigurationPrivate.parse({
    files,
    status: {
      version: 1,
      node_id: r.current.node_id,
      node_uid: facts.node_uid,
      region_id: r.current.region_id,
      cluster_uid: facts.cluster_uid,
      material_revision: 1,
      revision: 1,
      release_id: r.current.release_id,
      pool_policy_revision: 1,
      profile_sha256: "f".repeat(64),
      sha256: digest(canonical(files)),
      created_at: new Date().toISOString(),
    },
  });
  r.fixture.input.retained_talos_installation = {
    receipt: {
      method: "deploymentreceipt",
      installer: oldInstaller,
      node_uid: facts.node_uid,
      cluster_uid: facts.cluster_uid,
      system_uuid: facts.system_uuid,
      pre_reboot_boot_id: priorBoot,
      completed_at: new Date().toISOString(),
      source: "cli_exit_0",
    },
    boot_id: boot,
    talos_version: "v1.14.1",
    talos_schematic_sha256: facts.talos_schematic_sha256,
    kubernetes_image_provenance: {
      method: "pinned_configuration_boot",
      configuration_boot_id: priorBoot,
      configuration_observed_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      kubelet_version: "v1.36.5",
      control_plane: true,
      images: Object.fromEntries(
        Object.entries(pins).map(([name, configuration]) => [
          name,
          { configuration, runtime_sha256: configuration.slice(-64) },
        ]),
      ) as NonNullable<FleetPatchFacts["kubernetes_images"]>,
    },
  };
  r.current = {
    ...r.current,
    stage: "preflight",
    host_configuration_revision: 1,
    host_configuration_sha256: r.fixture.input.host_configuration.status.sha256,
    spec_sha256: digest(canonical(r.fixture.input.spec)),
  };
  r.facts = facts;
  r.machineConfiguration = [
    { version: "v1alpha1", machine: { type: "controlplane" } },
    ...Object.entries({
      kubelet: "KubeletConfig",
      apiServer: "KubeAPIServerConfig",
      controllerManager: "KubeControllerManagerConfig",
      scheduler: "KubeSchedulerConfig",
    }).map(([name, kind]) => ({
      apiVersion: "v1alpha1",
      kind,
      image: pins[name as keyof typeof pins],
    })),
  ]
    .map((value) => stringify(value))
    .join("---\n");
  r.stateLoadedConfiguration = true;
  await r.turn();
  assert.equal(r.current.stage, "preflight");
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.current.talos_upgrade_receipt, null);
  assert.equal(r.writes.length, 0);
  r.current = { ...r.current, state: "pending" };
  r.fixture.input.retained_talos_installation.kubernetes_image_provenance!.images.kubelet.configuration = `registry.example/unproved@sha256:${"a".repeat(64)}`;
  await assert.rejects(r.turn(), /persistence_unproved/);
  assert.equal(r.writes.length, 0);
  r.fixture.input.retained_talos_installation.kubernetes_image_provenance!.images.kubelet.configuration =
    pins.kubelet;
  r.current = { ...r.current, stage: "host_config" };
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 1);
});
test("checkpoint echoes compare the JSON wire facts when pre-boot image evidence is undefined", async () => {
  const { r, pins } = pinnedKubernetesRuntime();
  await r.turn();
  assert.equal(r.current.stage, "kubernetes_images");
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 1);
  assert.ok(r.writes[0]!.args.includes("apply-config"));
  assert.equal(Object.hasOwn(r.current.observed!, "kubernetes_images"), false);
  assert.deepEqual(r.current.observed!.kubernetes_image_configuration, pins);
});

test("Flux CAS patches pass private real files to the pinned native kubectl and clean up every payload", async () => {
  const client = process.env.PGCF_TEST_KUBECTL;
  assert.ok(client, "PGCF_TEST_KUBECTL must select the verified native client");
  const r = runtime();
  const deployments = [
    "helm-controller",
    "kustomize-controller",
    "notification-controller",
    "source-controller",
  ].map((name) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: "flux-system" },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: "manager",
              image: `registry.example/flux-${name.split("-")[0]}:old`,
            },
          ],
        },
      },
    },
  }));
  const text = deployments.map((value) => stringify(value)).join("---\n"),
    relay = stringify({
      kind: "Deployment",
      metadata: { name: "pgcf-bootstrap-relay" },
    }),
    lock = JSON.stringify({
      target: {
        talosVersion: r.fixture.input.spec.roles.customer.talos_version,
        kubernetesVersion:
          r.fixture.input.spec.roles.customer.kubernetes_version,
      },
      flux: {
        installManifestURL:
          "https://github.com/fluxcd/flux2/releases/download/v2.8.0/install.yaml",
        installManifestSha256: digest(text),
      },
    });
  r.fixture.input.spec.platform_source_commit = "e".repeat(40);
  r.fixture.input.spec.versions_lock_sha256 = digest(lock);
  const current = new Map(
    deployments.map((value) => [
      value.metadata.name,
      {
        ...structuredClone(value),
        metadata: { ...value.metadata, uid: randomUUID() },
      },
    ]),
  );
  const sources = [
    {
      apiVersion: "source.toolkit.fluxcd.io/v1",
      kind: "GitRepository",
      metadata: {
        name: "pgcf-platform",
        namespace: "flux-system",
        uid: randomUUID(),
      },
      spec: { ref: { commit: "a".repeat(40) } },
      status: { artifact: { revision: `main@sha1:${"a".repeat(40)}` } },
    },
    ...["pgcf-platform", "pgcf-regional"].map((name) => ({
      apiVersion: "kustomize.toolkit.fluxcd.io/v1",
      kind: "Kustomization",
      metadata: { name, namespace: "flux-system", uid: randomUUID() },
      spec: { path: "./infra/platform" },
      status: {},
    })),
  ];
  r.current = {
    ...r.current,
    stage: "flux",
    baseline: {
      ...r.fixture.facts,
      platform_resource_uids: Object.fromEntries(
        [...current.values(), ...sources].map((value) => [
          `${value.kind}/flux-system/${value.metadata.name}`,
          value.metadata.uid,
        ]),
      ),
    },
    spec_sha256: digest(canonical(r.fixture.input.spec)),
  };
  r.assetRequest = async (url) =>
    new Response(
      String(url).endsWith("versions.lock.json")
        ? lock
        : String(url).endsWith("relay.yaml")
          ? relay
          : text,
    );
  const paths: string[] = [];
  r.kubeProbe = (command) => {
    if (command.args.includes("deployments.apps,daemonsets.apps"))
      return Promise.resolve({
        exit_code: 0,
        stdout: JSON.stringify({ items: [...current.values()] }),
      });
    if (
      command.args.some((value) =>
        [
          "gitrepositories",
          "kustomizations",
          "helmreleases",
          "ocirepositories",
          "helmcharts",
        ].some((kind) => value.startsWith(kind + ".")),
      )
    )
      return Promise.resolve({
        exit_code: 0,
        stdout: JSON.stringify({
          items: sources.filter((value) => {
            const kinds: Record<string, string> = {
              gitrepositories: "GitRepository",
              kustomizations: "Kustomization",
              helmreleases: "HelmRelease",
              ocirepositories: "OCIRepository",
              helmcharts: "HelmChart",
            };
            return (
              value.kind ===
              kinds[
                command.args[command.args.indexOf("get") + 1]!.split(".")[0]!
              ]
            );
          }),
        }),
      });
    if (command.args.includes("pods"))
      return Promise.resolve({
        exit_code: 0,
        stdout: JSON.stringify({ items: [] }),
      });
    if (!command.args.includes("Deployment")) return undefined;
    const name = command.args[command.args.indexOf("Deployment") + 1]!;
    if (command.args.includes("get"))
      return Promise.resolve({
        exit_code: 0,
        stdout: JSON.stringify(current.get(name)),
      });
    return (async () => {
      assert.ok(command.args.includes("patch"));
      const file = command.args
        .find((value) => value.startsWith("--patch-file="))!
        .slice("--patch-file=".length);
      assert.notEqual(file, "/dev/stdin");
      assert.equal(command.stdin, undefined);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
      paths.push(file);
      const patch = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(patch[0], {
        op: "test",
        path: "/metadata/uid",
        value: current.get(name)!.metadata.uid,
      });
      const source = join(
        dirname(file),
        `native-kubectl-source-${paths.length}.json`,
      );
      await writeFile(source, JSON.stringify(current.get(name)), {
        mode: 0o600,
        flag: "wx",
      });
      const result = spawnSync(
        client,
        [
          "patch",
          "--local=true",
          "--filename",
          source,
          "--type=json",
          `--patch-file=${file}`,
          "--dry-run=client",
          "--output=json",
        ],
        {
          encoding: "utf8",
          timeout: 15000,
          env: { PATH: process.env.PATH, LANG: "C" },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      current.set(name, JSON.parse(result.stdout));
      return { exit_code: 0, stdout: result.stdout };
    })();
  };
  await r.turn();
  assert.equal(paths.length, 4);
  assert.equal(new Set(paths).size, 4);
  for (const path of paths)
    await assert.rejects(stat(path), { code: "ENOENT" });
});

test("fleet apply gives the actual pinned native client a private configuration file and retains uncertain outcomes", async () => {
  const client = process.env.PGCF_TEST_TALOSCTL;
  assert.ok(
    client,
    "PGCF_TEST_TALOSCTL must select the verified native client",
  );
  const { r, pins } = pinnedKubernetesRuntime();
  let appliedFile: string | undefined;
  let nativeDiagnostic: string | undefined;
  let observed:
    | {
        exit: number | null;
        signal: NodeJS.Signals | null;
        error: Error | undefined;
        configDirectory: string;
        stdin: string | undefined;
        mode: number;
        directoryMode: number;
        imageReferences: string[];
      }
    | undefined;
  r.applyProbe = async (command) => {
    const config = command.args[command.args.indexOf("--talosconfig") + 1]!;
    const invalidConfig = join(dirname(config), "native-test-invalid-config");
    await writeFile(invalidConfig, "[unclosed\n", { mode: 0o600, flag: "wx" });
    const args = command.args.map((arg) =>
      arg === config ? invalidConfig : arg,
    );
    const result = spawnSync(client, args, {
      cwd: dirname(config),
      input: command.stdin,
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH, LANG: "C" },
    });
    nativeDiagnostic = result.stderr;
    const file = args.find((arg) => arg.startsWith("--file="))!;
    appliedFile = file.slice("--file=".length);
    observed = {
      exit: result.status,
      signal: result.signal,
      error: result.error,
      configDirectory: dirname(config),
      stdin: command.stdin,
      mode: (await stat(appliedFile)).mode & 0o777,
      directoryMode: (await stat(dirname(appliedFile))).mode & 0o777,
      imageReferences: parseAllDocuments(await readFile(appliedFile, "utf8"))
        .map((doc) => doc.toJSON())
        .filter((doc) => typeof doc.image === "string")
        .map((doc) => doc.image),
    };
    return { exit_code: result.status ?? 255, stdout: result.stdout };
  };
  await r.turn();
  // Invalid local custody stops the real vendor command before its client or RPC.
  // Reaching that parser proves the existing apply configuration was read first.
  assert.match(
    nativeDiagnostic ?? "",
    /failed to open config file.*go-yaml load error/,
  );
  assert.ok(observed);
  assert.equal(observed.exit, 1);
  assert.equal(observed.signal, null);
  assert.equal(observed.error, undefined);
  assert.equal(observed.stdin, undefined);
  assert.equal(observed.mode, 0o600);
  assert.equal(observed.directoryMode, 0o700);
  assert.deepEqual(observed.imageReferences, Object.values(pins));
  assert.equal(r.writes.length, 1);
  assert.equal(r.current.state, "dispatched");
  assert.equal(r.current.error_code, null);
  assert.notDeepEqual(r.current.observed!.kubernetes_image_configuration, pins);
  assert.ok(appliedFile);
  assert.equal(dirname(appliedFile), observed.configDirectory);
  await assert.rejects(stat(appliedFile), { code: "ENOENT" });
  await r.turn();
  assert.equal(r.writes.length, 1, "an uncertain outcome never replays apply");
});

test("the measured 178-second checkpoint collection preserves the configured witness and its original time", async (t) => {
  const originalNow = Date.now();
  t.mock.method(Date, "now", () => originalNow + 178_000);
  const { r, pins } = pinnedKubernetesRuntime();
  await r.turn();
  assert.equal(r.current.state, "confirmed");
  assert.deepEqual(r.current.observed!.kubernetes_image_configuration, pins);
  assert.equal(
    r.current.observed!.kubernetes_configuration_boot_id,
    r.fixture.facts.boot_id,
  );
  assert.ok(Date.parse(r.current.observed!.observed_at) < Date.now() - 170_000);
  assert.equal(
    r.current.observed!.kubernetes_configuration_observed_at,
    r.current.observed!.observed_at,
  );
});

test("a checkpoint collection older than600 seconds cannot dispatch a native write", async (t) => {
  const originalNow = Date.now();
  t.mock.method(Date, "now", () => originalNow + 601_000);
  const { r } = pinnedKubernetesRuntime();
  await assert.rejects(r.turn(), /patch_input_stale/);
  assert.equal(r.writes.length, 0);
  assert.equal(r.checkpoints.length, 0);
});

test("future-dated checkpoint facts cannot dispatch a native write", async (t) => {
  const originalNow = Date.now();
  t.mock.method(Date, "now", () => originalNow - 10_000);
  const { r } = pinnedKubernetesRuntime();
  await assert.rejects(r.turn(), /patch_input_stale/);
  assert.equal(r.writes.length, 0);
  assert.equal(r.checkpoints.length, 0);
});
