// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
  mergeKubernetesImages,
  observeKubernetesImages,
} from "../src/fleet-kubernetes-images.ts";
import {
  fleetPatchKubernetesImagesMatch,
  fleetPatchKubernetesConfigurationMatches,
} from "@pgcf/contracts/fleet-patches";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { randomUUID } from "node:crypto";
function fixture(control: boolean) {
  const { input, facts } = patchFixture(),
    names = {
      kubelet: "KubeletConfig",
      apiServer: "KubeAPIServerConfig",
      controllerManager: "KubeControllerManagerConfig",
      scheduler: "KubeSchedulerConfig",
    } as const;
  const pins = {
    kubelet: `registry.example/kubelet:v1.36.5@sha256:${"1".repeat(64)}`,
    apiServer: `registry.example/kube-apiserver:v1.36.5@sha256:${"2".repeat(64)}`,
    controllerManager: `registry.example/kube-controller-manager:v1.36.5@sha256:${"3".repeat(64)}`,
    scheduler: `registry.example/kube-scheduler:v1.36.5@sha256:${"4".repeat(64)}`,
  };
  input.spec.roles.customer.kubernetes_images = pins;
  const selected = control
    ? (Object.keys(names) as (keyof typeof names)[])
    : (["kubelet"] as const);
  const values = [
      {
        version: "v1alpha1",
        machine: {
          files: [
            {
              path: "/var/lib/retained",
              content: "test-only-retained",
              permissions: 384,
              op: "overwrite",
            },
          ],
        },
        cluster: { secret: "test-only-retained" },
      },
      ...selected.map((key) => ({
        apiVersion: "v1alpha1",
        kind: names[key],
        image: pins[key].split("@")[0],
        extraArgs: { retained: "yes" },
      })),
      { apiVersion: "v1alpha1", kind: "LinkConfig", name: "eth0", mtu: 1500 },
    ],
    raw = (id: string, docs = values) =>
      JSON.stringify({
        metadata: { type: "MachineConfigs.config.talos.dev", id },
        spec: docs.map((doc) => stringify(doc)).join("---\n"),
      });
  return { input, facts, pins, values, raw, control };
}
test("worker and control-plane fixed image documents preserve all private files/network/options and full tag@digest references", () => {
  for (const control of [false, true]) {
    const f = fixture(control),
      merged = parseAllDocuments(
        mergeKubernetesImages(f.raw("v1alpha1"), f.input, control),
      ).map((doc) => doc.toJSON());
    assert.equal(merged.length, f.values.length);
    assert.deepEqual(merged[0], f.values[0]);
    assert.deepEqual(merged.at(-1), f.values.at(-1));
    for (const doc of merged.filter((doc) => doc.kind?.startsWith("Kube"))) {
      assert.match(doc.image, /:v1\.36\.5@sha256:[a-f0-9]{64}$/);
      assert.deepEqual(doc.extraArgs, { retained: "yes" });
    }
  }
});
test("only a changed recorded configuration boot with healthy vendor kubelet and actual mirror Pod imageIDs proves pinned runtime", async () => {
  const f = fixture(true),
    values = parseAllDocuments(
      mergeKubernetesImages(f.raw("v1alpha1"), f.input, true),
    ).map((doc) => doc.toJSON()),
    configuration = {
      active: f.raw("v1alpha1", values),
      persistent: f.raw("persistent", values),
      sha256: "a".repeat(64),
    },
    boot = randomUUID(),
    oldBoot = randomUUID();
  const podNames = {
    apiServer: "kube-apiserver",
    controllerManager: "kube-controller-manager",
    scheduler: "kube-scheduler",
  } as const;
  const pods = Object.entries(podNames).map(([key, name]) => ({
    metadata: {
      uid: randomUUID(),
      labels: { component: name },
      ownerReferences: [{ kind: "Node", uid: f.input.status.node_uid }],
    },
    spec: {
      nodeName: f.input.k8s_node_name,
      containers: [{ name, image: f.pins[key as keyof typeof f.pins] }],
    },
    status: {
      containerStatuses: [
        {
          name,
          ready: true,
          imageID: `containerd://sha256:${f.pins[key as keyof typeof f.pins].slice(-64)}`,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  }));
  const terminal = structuredClone(pods[0]!);
  terminal.metadata.uid = randomUUID();
  (terminal.status as Record<string, unknown>).phase = "Succeeded";
  terminal.status.containerStatuses[0]!.ready = false;
  pods.push(terminal);
  const resource = (type: string, id: string, spec: object) =>
      JSON.stringify({ metadata: { type, id }, spec }),
    commands = {
      talos: async (args: string[]) =>
        args.includes("kubeletstatuses")
          ? resource("KubeletStatuses.kubernetes.talos.dev", "kubelet", {
              image: f.pins.kubelet,
            })
          : resource("Services.v1alpha1.talos.dev", "kubelet", {
              running: true,
              healthy: true,
              unknown: false,
            }),
      kube: async () => JSON.stringify({ items: pods }),
    };
  assert.equal(
    await observeKubernetesImages(f.input, true, commands, configuration, {
      boot_id: boot,
      configuration_boot_id: boot,
    }),
    undefined,
  );
  const images = await observeKubernetesImages(
      f.input,
      true,
      commands,
      configuration,
      { boot_id: boot, configuration_boot_id: oldBoot },
    ),
    facts = {
      ...f.facts,
      boot_id: boot,
      kubernetes_control_plane: true,
      kubernetes_images: images,
      kubernetes_image_configuration: f.pins,
    };
  assert.equal(fleetPatchKubernetesConfigurationMatches(f.input, facts), true);
  assert.equal(fleetPatchKubernetesImagesMatch(f.input, facts), true);
  pods[0]!.status.containerStatuses[0]!.imageID =
    "containerd://sha256:" + "f".repeat(64);
  assert.equal(
    fleetPatchKubernetesImagesMatch(f.input, {
      ...facts,
      kubernetes_images: await observeKubernetesImages(
        f.input,
        true,
        commands,
        configuration,
        { boot_id: boot, configuration_boot_id: oldBoot },
      ),
    }),
    false,
  );
});
