// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { runRegionAuthorityRotation } from "../src/region-authority-rotation.ts";
import type { FleetRegionMaterialRotationInput } from "@pgcf/contracts/region-material-rotation";
import type { CommandRunner } from "../src/bootstrap.ts";
import type { openTalosOperator } from "../src/talos-operator.ts";
function setup() {
  const old = [
      {
        version: "v1alpha1",
        machine: { type: "controlplane", token: "old-trustd" },
        cluster: { token: "aaaaaa.aaaaaaaaaaaaaaaa" },
      },
      { kind: "DiscoveryIdentityConfig", clusterID: "same-cluster" },
      {
        kind: "KubeClusterConfig",
        clusterName: "test-cluster",
        endpoint: "https://192.0.2.1:6443",
      },
    ],
    next = structuredClone(old);
  (next[0]!.machine as { type: string; token: string }).token = "new-trustd";
  const talos = stringify({
      context: "test",
      contexts: {
        test: {
          ca: Buffer.from("test-ca").toString("base64"),
          crt: "test-cert",
          key: "test-key",
        },
      },
    }),
    kube = JSON.stringify({
      "current-context": "test",
      contexts: [{ name: "test", context: { cluster: "test", user: "test" } }],
      clusters: [
        {
          name: "test",
          cluster: {
            server: "https://192.0.2.1:6443",
            "certificate-authority-data":
              Buffer.from("test-ca").toString("base64"),
          },
        },
      ],
      users: [
        {
          name: "test",
          user: {
            "client-certificate-data": "test-cert",
            "client-key-data": "test-key",
          },
        },
      ],
    }),
    seed = {
      version: 1 as const,
      cluster_name: "test-cluster",
      cluster_endpoint: "https://192.0.2.1:6443",
      talos_version: "1.14.1" as const,
      kubernetes_version: "1.36.3" as const,
      talos_machine_secrets_yaml: "private-test-secrets",
      talos_admin_config: talos,
    },
    cluster = "22222222-2222-4222-8222-222222222222",
    node = "11111111-1111-4111-8111-111111111111",
    input: FleetRegionMaterialRotationInput = {
      rollout_id: "op_abcdefghijklmnopqrst",
      region_id: "test",
      cluster_uid: cluster,
      current_revision: 1,
      target_revision: 2,
      checkpoint: {
        revision: 1,
        phase: "trustd-token",
        node_index: 0,
        state: "pending",
      },
      current_seed: seed,
      target_seed: {
        ...seed,
        talos_machine_secrets_yaml: "replacement-test-secrets",
      },
      current_join: { ...seed, kube_system_uid: cluster, kubeconfig: kube },
      target_join: {
        ...seed,
        talos_machine_secrets_yaml: "replacement-test-secrets",
        kube_system_uid: cluster,
        kubeconfig: kube,
      },
      callback: {
        url: "https://api.example.test/internal/v1/fleet-rollouts/op_abcdefghijklmnopqrst/regions/test/rotation",
        bearer: "x".repeat(32),
        expires_at: new Date(Date.now() + 600000).toISOString(),
      },
      nodes: [
        {
          node_id: "nod_abcdefghijklmnopqrst",
          node_uid: node,
          node_name: "node",
          provider_instance_id: "12345",
          address: "192.0.2.1",
          role: "controlplane",
          cilium_image: "quay.io/cilium/cilium@sha256:" + "a".repeat(64),
          cilium_image_id: "quay.io/cilium/cilium@sha256:" + "a".repeat(64),
        },
      ],
    },
    captured: FleetRegionMaterialRotationInput["checkpoint"][] = [];
  let live = old,
    apply = 0,
    invalid = false;
  const run: CommandRunner = async (command) => {
      if (command.args[0] === "gen") {
        const out = command.args[command.args.indexOf("--output") + 1]!;
        await writeFile(
          out,
          (out.includes("prior-") ? old : next)
            .map((d) => stringify(d))
            .join("---\n"),
          { mode: 0o600 },
        );
        return { exit_code: 0, stdout: "" };
      }
      if (command.args[0] === "validate")
        return { exit_code: invalid ? 1 : 0, stdout: "" };
      if (command.args.includes("apply-config")) {
        apply++;
        throw Error("command_timeout");
      }
      if (command.args.includes("machineconfig"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            node: "192.0.2.1",
            spec: live.map((d) => stringify(d)).join("---\n"),
          }),
        };
      throw Error("unexpected_command");
    },
    request: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      captured.push(body.checkpoint);
      return Response.json({
        checkpoint: body.checkpoint,
        bearer: "y".repeat(32),
      });
    },
    openOperator = (async (options) => ({
      talosPath: options.talosconfig,
      outputDir: options.outputDir,
      verify: async () => undefined,
      close: async () => undefined,
      binding: {
        node_uid: node,
        cluster_uid: cluster,
        node_name: "node",
        material_revision: 1,
      },
      carrier: { physical: { bootId: "33333333-3333-4333-8333-333333333333" } },
    })) as typeof openTalosOperator;
  return {
    input,
    captured,
    run,
    request,
    openOperator,
    apply: () => apply,
    invalid: () => {
      invalid = true;
    },
    commitLate: () => {
      live = next;
    },
  };
}
test("invalid candidates never consume a native apply dispatch", async () => {
  const f = setup();
  f.invalid();
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_candidate_validation_failed/,
  );
  assert.equal(f.apply(), 0);
  assert.equal(
    f.captured.some((c) => c.state === "dispatched"),
    false,
  );
});
test("an uncertain config apply is read-only on resume and a late target readback completes the same phase", async () => {
  const f = setup();
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_apply_unresolved_no_replay/,
  );
  assert.equal(f.apply(), 1);
  f.input.checkpoint = f.captured.at(-1)!;
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_apply_unresolved_no_replay/,
  );
  assert.equal(f.apply(), 1);
  f.input.checkpoint = f.captured.at(-1)!;
  f.commitLate();
  await runRegionAuthorityRotation(f.input, f);
  assert.equal(f.apply(), 1);
  assert.equal(f.captured.at(-1)!.state, "confirmed");
});
