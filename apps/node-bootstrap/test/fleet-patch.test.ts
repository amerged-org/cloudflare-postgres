// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { test } from "node:test";
import {
  FleetPatchCheckpoint,
  FleetPatchStatus,
  type FleetPatchFacts,
  fleetPatchCheckpointAllowed,
} from "@pgcf/contracts/fleet-patches";
import { runFleetPatch, validateFleetPatchInput } from "../src/fleet-patch.ts";
import { canonical, digest, type Command } from "../src/bootstrap.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";

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
    set facts(value: FleetPatchFacts) {
      facts = value;
    },
    set lifecycleLogs(value: string) {
      lifecycleLogs = value;
    },
    set machineConfiguration(value: string) {
      machineConfiguration = value;
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
            if (
              args.includes("apply-config") &&
              machineConfiguration !== undefined
            ) {
              writes.push(command);
              assert.equal(current.state, "dispatched");
              machineConfiguration = command.stdin;
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
              stdout = resource(
                "MachineConfigs.config.talos.dev",
                args.includes("persistent") ? "persistent" : "v1alpha1",
                machineConfiguration,
              );
            } else if (args.includes("logs")) stdout = lifecycleLogs;
            else if (args.includes("version"))
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
test("runtime verification is conditional and does not claim platform component convergence", async () => {
  const r = runtime();
  r.current = { ...r.current, stage: "verify", baseline: r.fixture.facts };
  r.facts = {
    ...r.fixture.facts,
    talos_version: "v1.14.1",
    kubernetes_version: "v1.36.5",
    kubelet_version: "v1.36.5",
  };
  await r.turn();
  assert.equal(r.current.stage, "runtime_verified");
  assert.equal(r.writes.length, 0);
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
  await r.turn();
  assert.equal(r.current.stage, "runtime_admission");
  assert.equal(r.current.state, "pending");
  assert.equal(r.writes.length, 0);
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

test("checkpoint echoes compare the JSON wire facts when pre-boot image evidence is undefined", async () => {
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
  await r.turn();
  assert.equal(r.current.stage, "kubernetes_images");
  assert.equal(r.current.state, "confirmed");
  assert.equal(r.writes.length, 1);
  assert.ok(r.writes[0]!.args.includes("apply-config"));
  assert.equal(Object.hasOwn(r.current.observed!, "kubernetes_images"), false);
  assert.deepEqual(r.current.observed!.kubernetes_image_configuration, pins);
});
