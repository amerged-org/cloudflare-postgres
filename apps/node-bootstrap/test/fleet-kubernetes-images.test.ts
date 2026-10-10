// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
  applyKubernetesImages,
  mergeKubernetesImages,
  normalizeRuntimeImageManifest,
  observeKubernetesImages,
} from "../src/fleet-kubernetes-images.ts";
import {
  fleetPatchKubernetesImagesMatch,
  fleetPatchKubernetesConfigurationMatches,
} from "@pgcf/contracts/fleet-patches";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { readMachineConfiguration } from "../src/fleet-host-configuration.ts";
import { randomUUID, createHash } from "node:crypto";
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
      kube: async (args: string[]) =>
        JSON.stringify(
          args[1] === "node"
            ? {
                metadata: {
                  name: f.input.k8s_node_name,
                  uid: f.input.status.node_uid,
                },
                status: {
                  nodeInfo: {
                    architecture: "amd64",
                    operatingSystem: "linux",
                    bootID: boot,
                  },
                },
              }
            : { items: pods },
        ),
      request: (async () =>
        new Response("{}", { status: 404 })) as typeof fetch,
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

// Public vendor index metadata, retained byte-for-byte for the observed mirror Pod regression.
const apiServerRuntimeIndex =
  '{\n   "schemaVersion": 2,\n   "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json",\n   "manifests": [\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:78487f7b4b1a588d9630f758f6677895eabe00d93c4cbbea3d6b06e5f476a371",\n         "platform": {\n            "architecture": "amd64",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:fd2aeee57db21e3e988ae7845dd549f8fdc036a3de985dc70aad4a69ad8ceb5a",\n         "platform": {\n            "architecture": "arm64",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:a932de6bf497f09570130c750b97eee9c5e3306a32ad598f31933074a12258d2",\n         "platform": {\n            "architecture": "ppc64le",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:c7c14e0cee7edf77296ca3df0b9379a4e2159d87050372e1cf055b26160180e2",\n         "platform": {\n            "architecture": "s390x",\n            "os": "linux"\n         }\n      }\n   ]\n}';
const apiServerRuntimeDigest = createHash("sha256")
  .update(apiServerRuntimeIndex)
  .digest("hex");
const apiServerManifestDigest = JSON.parse(apiServerRuntimeIndex)
  .manifests.find(
    (entry: { platform: { architecture: string; os: string } }) =>
      entry.platform.architecture === "amd64" && entry.platform.os === "linux",
  )
  .digest.replace("sha256:", "");
const controllerManagerRuntimeIndex =
  '{\n   "schemaVersion": 2,\n   "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json",\n   "manifests": [\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:a7b63e85c7914ff6d49d97004a09b8a469efa6fe41f58d2c1faa2606ed8cb742",\n         "platform": {\n            "architecture": "amd64",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:15f8587dc75f4f473bcff3c514193f192924e1e087936556bec94b5c087a32c3",\n         "platform": {\n            "architecture": "arm64",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:93c3026f53458fdc771f4f883614d9d909642f20106b76f540ef9ffbea4a4181",\n         "platform": {\n            "architecture": "ppc64le",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:bbde5545454d89d2ace9ab1d242e07ca5038c92b212618ab6cdcb11f000a204e",\n         "platform": {\n            "architecture": "s390x",\n            "os": "linux"\n         }\n      }\n   ]\n}';
const controllerManagerRuntimeDigest =
  "2d717af134451db77ea053c3426bc82edc0e55415eb36e1260313c636ebe9a4d";
const controllerManagerManifestDigest =
  "a7b63e85c7914ff6d49d97004a09b8a469efa6fe41f58d2c1faa2606ed8cb742";

function indexRuntimeFixture() {
  const f = fixture(true);
  f.pins.apiServer = `registry.k8s.io/kube-apiserver:v1.36.5@sha256:${apiServerManifestDigest}`;
  f.pins.controllerManager = `registry.k8s.io/kube-controller-manager:v1.36.5@sha256:${controllerManagerManifestDigest}`;
  const values = parseAllDocuments(
    mergeKubernetesImages(f.raw("v1alpha1"), f.input, true),
  ).map((doc) => doc.toJSON());
  const configuration = {
    active: f.raw("v1alpha1", values),
    persistent: f.raw("persistent", values),
    sha256: "a".repeat(64),
  };
  const names = {
    apiServer: "kube-apiserver",
    controllerManager: "kube-controller-manager",
    scheduler: "kube-scheduler",
  } as const;
  const pods = Object.entries(names).map(([key, name]) => ({
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
          imageID: `containerd://sha256:${key === "apiServer" ? apiServerRuntimeDigest : key === "controllerManager" ? controllerManagerRuntimeDigest : f.pins.scheduler.slice(-64)}`,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  }));
  const node = {
    metadata: { name: f.input.k8s_node_name, uid: f.input.status.node_uid },
    status: {
      nodeInfo: { architecture: "amd64", operatingSystem: "linux", bootID: "" },
    },
  };
  const resource = (type: string, id: string, spec: object) =>
    JSON.stringify({ metadata: { type, id }, spec });
  let requests = 0;
  const commands = {
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
    kube: async (args: string[]) =>
      JSON.stringify(args[1] === "node" ? node : { items: pods }),
    request: (async (url: string | URL | Request) => {
      requests++;
      const digest = String(url).split("sha256:").at(-1);
      const body =
        digest === apiServerRuntimeDigest
          ? apiServerRuntimeIndex
          : digest === controllerManagerRuntimeDigest
            ? controllerManagerRuntimeIndex
            : "{}";
      return new Response(body, {
        headers: { "docker-content-digest": `sha256:${digest}` },
      });
    }) as typeof fetch,
  };
  const witness = {
    boot_id: randomUUID(),
    configuration_boot_id: randomUUID(),
  };
  node.status.nodeInfo.bootID = witness.boot_id;
  return {
    ...f,
    configuration,
    pods,
    node,
    commands,
    witness,
    requests: () => requests,
  };
}
test("official immutable runtime indexes normalize only their unique Linux AMD64 child to the pinned manifest", async () => {
  const f = indexRuntimeFixture();
  assert.equal(
    createHash("sha256").update(apiServerRuntimeIndex).digest("hex"),
    apiServerRuntimeDigest,
  );
  assert.equal(
    createHash("sha256").update(controllerManagerRuntimeIndex).digest("hex"),
    controllerManagerRuntimeDigest,
  );
  const images = await observeKubernetesImages(
    f.input,
    true,
    f.commands,
    f.configuration,
    f.witness,
  );
  assert.equal(images?.apiServer?.runtime_sha256, apiServerManifestDigest);
  assert.equal(
    images?.controllerManager?.runtime_sha256,
    controllerManagerManifestDigest,
  );
  assert.equal(images?.scheduler?.runtime_sha256, f.pins.scheduler.slice(-64));
  assert.equal(f.requests(), 2);
  await observeKubernetesImages(
    f.input,
    true,
    f.commands,
    f.configuration,
    f.witness,
  );
  assert.equal(f.requests(), 2);
});

test("runtime index proof rejects another architecture, wrong child, ambiguous child and changed immutable bytes", async () => {
  const f = indexRuntimeFixture();
  f.node.status.nodeInfo.architecture = "arm64";
  assert.equal(
    (
      await observeKubernetesImages(
        f.input,
        true,
        f.commands,
        f.configuration,
        f.witness,
      )
    )?.apiServer,
    undefined,
  );
  f.node.status.nodeInfo.architecture = "amd64";
  const setIndex = (
    body: string,
    reported = createHash("sha256").update(body).digest("hex"),
  ) => {
    f.pods[0]!.status.containerStatuses[0]!.imageID = `containerd://sha256:${reported}`;
    f.commands.request = (async (url: string | URL | Request) => {
      const requested = String(url).split("sha256:").at(-1);
      return new Response(
        requested === reported ? body : controllerManagerRuntimeIndex,
        { headers: { "docker-content-digest": `sha256:${requested}` } },
      );
    }) as typeof fetch;
  };
  const index = JSON.parse(apiServerRuntimeIndex),
    child = index.manifests.find(
      (entry: { platform: { architecture: string; os: string } }) =>
        entry.platform.architecture === "amd64" &&
        entry.platform.os === "linux",
    );
  const wrongChild = structuredClone(index);
  wrongChild.manifests = [{ ...child, digest: `sha256:${"e".repeat(64)}` }];
  setIndex(JSON.stringify(wrongChild));
  assert.equal(
    (
      await observeKubernetesImages(
        f.input,
        true,
        f.commands,
        f.configuration,
        f.witness,
      )
    )?.apiServer,
    undefined,
  );
  const otherArchitecture = structuredClone(index);
  otherArchitecture.manifests = [
    { ...child, platform: { architecture: "arm64", os: "linux" } },
  ];
  setIndex(JSON.stringify(otherArchitecture));
  assert.equal(
    (
      await observeKubernetesImages(
        f.input,
        true,
        f.commands,
        f.configuration,
        f.witness,
      )
    )?.apiServer,
    undefined,
  );
  const ambiguous = structuredClone(index);
  ambiguous.manifests = [child, child];
  setIndex(JSON.stringify(ambiguous));
  assert.equal(
    (
      await observeKubernetesImages(
        f.input,
        true,
        f.commands,
        f.configuration,
        f.witness,
      )
    )?.apiServer,
    undefined,
  );
  setIndex(apiServerRuntimeIndex, "f".repeat(64));
  assert.equal(
    (
      await observeKubernetesImages(
        f.input,
        true,
        f.commands,
        f.configuration,
        f.witness,
      )
    )?.apiServer,
    undefined,
  );
});
test("runtime index normalization binds the actual Node UID and observed boot", async () => {
  const f = indexRuntimeFixture();
  f.node.status.nodeInfo.bootID = randomUUID();
  await assert.rejects(
    observeKubernetesImages(
      f.input,
      true,
      f.commands,
      f.configuration,
      f.witness,
    ),
    /patch_kubernetes_image_node_identity_changed/,
  );
  f.node.status.nodeInfo.bootID = f.witness.boot_id;
  f.node.metadata.uid = randomUUID();
  await assert.rejects(
    observeKubernetesImages(
      f.input,
      true,
      f.commands,
      f.configuration,
      f.witness,
    ),
    /patch_kubernetes_image_node_identity_changed/,
  );
});
test("missing persistent config needs the matching explicit changed-boot state proof", async () => {
  const f = indexRuntimeFixture(),
    active = { ...f.configuration, persistent: undefined };
  await assert.rejects(
    observeKubernetesImages(f.input, true, f.commands, active, f.witness),
    /patch_kubernetes_image_configuration_unproven/,
  );
  await assert.rejects(
    observeKubernetesImages(
      f.input,
      true,
      f.commands,
      {
        ...active,
        state_loaded: {
          boot_id: randomUUID(),
          configuration_boot_id: f.witness.configuration_boot_id,
          configuration_sha256: f.configuration.sha256,
        },
      },
      f.witness,
    ),
    /patch_kubernetes_image_configuration_unproven/,
  );
  const images = await observeKubernetesImages(
    f.input,
    true,
    f.commands,
    {
      ...active,
      state_loaded: {
        boot_id: f.witness.boot_id,
        configuration_boot_id: f.witness.configuration_boot_id,
        configuration_sha256: f.configuration.sha256,
      },
    },
    f.witness,
  );
  assert.equal(images?.apiServer?.runtime_sha256, apiServerManifestDigest);
});

test("image apply rechecks state-loaded config against the same explicit boot proof", async () => {
  const f = fixture(false),
    values = parseAllDocuments(
      mergeKubernetesImages(f.raw("v1alpha1"), f.input, false),
    ).map((doc) => doc.toJSON());
  let writes = 0;
  const commands = {
    talos: async (args: string[]) => {
      if (args[0] === "apply-config") {
        writes++;
        return "";
      }
      return f.raw("v1alpha1", values);
    },
  };
  const expected = await readMachineConfiguration(commands, {
    boot_id: randomUUID(),
    configuration_boot_id: randomUUID(),
  });
  assert.equal(expected.persistent, undefined);
  await applyKubernetesImages(f.input, false, commands, expected);
  assert.equal(writes, 1);
});

test("runtime index resolution supports a scoped anonymous GHCR challenge", async () => {
  const f = indexRuntimeFixture();
  f.pins.apiServer = `ghcr.io/example/kube-apiserver:v1.36.5@sha256:${apiServerManifestDigest}`;
  f.pods[0]!.spec.containers[0]!.image = f.pins.apiServer;
  const values = parseAllDocuments(
    mergeKubernetesImages(f.raw("v1alpha1"), f.input, true),
  ).map((doc) => doc.toJSON());
  f.configuration.active = f.raw("v1alpha1", values);
  f.configuration.persistent = f.raw("persistent", values);
  let tokenRequests = 0;
  f.commands.request = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (url.hostname === "ghcr.io" && url.pathname === "/token") {
      tokenRequests++;
      assert.equal(url.searchParams.get("service"), "ghcr.io");
      assert.equal(
        url.searchParams.get("scope"),
        "repository:example/kube-apiserver:pull",
      );
      return new Response(
        JSON.stringify({ token: "test-only-anonymous-token" }),
      );
    }
    const sha = url.href.split("sha256:").at(-1);
    if (
      url.hostname === "ghcr.io" &&
      !new Headers(init?.headers).has("authorization")
    )
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/kube-apiserver:pull"',
        },
      });
    if (url.hostname === "ghcr.io")
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer test-only-anonymous-token",
      );
    return new Response(
      sha === apiServerRuntimeDigest
        ? apiServerRuntimeIndex
        : controllerManagerRuntimeIndex,
      { headers: { "docker-content-digest": `sha256:${sha}` } },
    );
  }) as typeof fetch;
  const images = await observeKubernetesImages(
    f.input,
    true,
    f.commands,
    f.configuration,
    f.witness,
  );
  assert.equal(images?.apiServer?.runtime_sha256, apiServerManifestDigest);
  assert.equal(tokenRequests, 1);
});
test("a different request implementation cannot reuse another reader's immutable index cache", async () => {
  const f = indexRuntimeFixture();
  f.commands.request = (async (url: string | URL | Request) => {
    const sha = String(url).split("sha256:").at(-1);
    return new Response(
      sha === apiServerRuntimeDigest
        ? apiServerRuntimeIndex + "\n"
        : controllerManagerRuntimeIndex,
      { headers: { "docker-content-digest": `sha256:${sha}` } },
    );
  }) as typeof fetch;
  assert.equal(
    (
      await observeKubernetesImages(
        f.input,
        true,
        f.commands,
        f.configuration,
        f.witness,
      )
    )?.apiServer,
    undefined,
  );
});

test("anonymous GHCR proof rejects a different repository scope and invalid token bytes", async () => {
  const reference = `ghcr.io/example/kube-apiserver:v1.36.5@sha256:${apiServerManifestDigest}`;
  let requests = 0;
  const wrongScope = (async () => {
    requests++;
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/other:pull"',
      },
    });
  }) as typeof fetch;
  assert.equal(
    await normalizeRuntimeImageManifest(
      reference,
      apiServerManifestDigest,
      apiServerRuntimeDigest,
      { request: wrongScope },
    ),
    undefined,
  );
  assert.equal(requests, 1);
  const invalidToken = (async (input: string | URL | Request) =>
    new URL(String(input)).pathname === "/token"
      ? new Response(JSON.stringify({ token: "invalid token" }))
      : new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/kube-apiserver:pull"',
          },
        })) as typeof fetch;
  assert.equal(
    await normalizeRuntimeImageManifest(
      reference,
      apiServerManifestDigest,
      apiServerRuntimeDigest,
      { request: invalidToken },
    ),
    undefined,
  );
});
