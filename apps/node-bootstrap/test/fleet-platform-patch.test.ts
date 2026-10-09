// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { fleetResourcePatch } from "../src/fleet-platform-patch.ts";

function applyTests(
  value: Record<string, unknown>,
  patch: { op: string; path: string; value: unknown }[],
) {
  for (const item of patch.filter((v) => v.op === "test")) {
    let current: unknown = value;
    for (const key of item.path.slice(1).split("/"))
      current = (current as Record<string, unknown>)[
        key.replaceAll("~1", "/").replaceAll("~0", "~")
      ];
    assert.deepEqual(current, item.value);
  }
}
test("Flux controller status-only resourceVersion changes do not invalidate the exact prior-spec CAS", () => {
  const actual = {
    metadata: {
      uid: "5d29558c-2616-40f6-8e11-57ddab4713c1",
      resourceVersion: "288438",
    },
    spec: {
      images: [{ name: "regional", digest: "sha256:old" }],
      postBuild: { substitute: { REGION: "us" } },
    },
  };
  const patch = fleetResourcePatch(actual, actual.metadata.uid, {
    ...actual.spec,
    images: [{ name: "regional", digest: "sha256:new" }],
  });
  actual.metadata.resourceVersion = "292755";
  applyTests(actual, patch);
  assert.equal(
    patch.some((v) => v.path.includes("resourceVersion")),
    false,
  );
  assert.deepEqual(patch.at(-1)!.value, {
    images: [{ name: "regional", digest: "sha256:new" }],
    postBuild: { substitute: { REGION: "us" } },
  });
});
test("a concurrent desired-spec or immutable UID change fails the same CAS", () => {
  const actual = {
    metadata: {
      uid: "5d29558c-2616-40f6-8e11-57ddab4713c1",
      resourceVersion: "1",
    },
    spec: {
      images: [{ name: "regional", digest: "sha256:old" }],
      postBuild: { substitute: { REGION: "us" } },
    },
  };
  const patch = fleetResourcePatch(actual, actual.metadata.uid, {
    ...actual.spec,
    images: [{ name: "regional", digest: "sha256:new" }],
  });
  actual.spec.postBuild.substitute.REGION = "eu";
  assert.throws(() => applyTests(actual, patch));
  actual.spec.postBuild.substitute.REGION = "us";
  actual.metadata.uid = "6d29558c-2616-40f6-8e11-57ddab4713c1";
  assert.throws(() => applyTests(actual, patch));
});

import { selectFluxObjects } from "../src/platform.ts";
test("the verified vendor Flux artifact declares seven Deployments while the selected common composition runs four", () => {
  // Metadata boundary from the pinned upstream composition; no fabricated ready/runtime proof.
  const names = [
    "helm-controller",
    "image-automation-controller",
    "image-reflector-controller",
    "kustomize-controller",
    "notification-controller",
    "source-controller",
    "source-watcher",
  ];
  const values = names.map((name) => ({
    kind: "Deployment",
    metadata: { name },
  }));
  const shared = { kind: "ClusterRole", metadata: { name: "crd-controller" } };
  assert.equal(
    selectFluxObjects([...values, shared]).filter(
      (v) => v.kind === "Deployment",
    ).length,
    4,
  );
  assert.ok(selectFluxObjects([...values, shared]).includes(shared));
  assert.throws(() => selectFluxObjects(values, ["unknown"]));
});

import { pruneDeprecatedFlux } from "../src/fleet-platform-patch.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";
test("optional Flux cleanup binds original owner and exact current spec, resolves unknown deletion by reads and never deletes a replacement", async () => {
  const { input } = patchFixture();
  input.initial_bootstrap_input_sha256 = "a".repeat(64);
  const expected = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "image-reflector-controller", namespace: "flux-system" },
    spec: {
      selector: { matchLabels: { app: "image-reflector-controller" } },
      template: {
        spec: {
          containers: [
            { name: "manager", image: "vendor@sha256:" + "a".repeat(64) },
          ],
        },
      },
    },
  };
  const uid = "5d29558c-2616-40f6-8e11-57ddab4713c1",
    key = "Deployment/flux-system/image-reflector-controller",
    assets = { lock: {}, flux: [], flux_deprecated: [expected], relay: {} };
  let actual: Record<string, unknown> | undefined = {
    ...structuredClone(expected),
    metadata: {
      ...expected.metadata,
      uid,
      resourceVersion: "41",
      annotations: {
        "pgcf.io/bootstrap-input": input.initial_bootstrap_input_sha256,
      },
    },
  };
  const pod = (actual.spec as typeof expected.spec).template.spec as Record<
    string,
    unknown
  >;
  pod.tolerations = [
    {
      key: "pgcf.io/quarantine",
      operator: "Equal",
      value: "bootstrap",
      effect: "NoSchedule",
    },
  ];
  let writes = 0;
  const commands = {
    authorize: async () => {},
    kube: async (args: string[], stdin?: string) => {
      if (args[0] === "get")
        return JSON.stringify({ items: actual ? [actual] : [] });
      writes++;
      assert.deepEqual(JSON.parse(stdin!).preconditions, {
        uid,
        resourceVersion: "41",
      });
      actual = undefined;
      throw Error("lost_delete_reply");
    },
  };
  await pruneDeprecatedFlux(input, assets, { [key]: uid }, commands);
  await pruneDeprecatedFlux(input, assets, { [key]: uid }, commands);
  assert.equal(writes, 1);
  actual = {
    ...expected,
    metadata: {
      ...expected.metadata,
      uid: "6d29558c-2616-40f6-8e11-57ddab4713c1",
      resourceVersion: "42",
    },
  };
  await assert.rejects(
    pruneDeprecatedFlux(input, assets, { [key]: uid }, commands),
    /patch_flux_prune_identity_changed/,
  );
  assert.equal(writes, 1);
});

import {
  fleetPlatformReadback,
  reconcileFleetRegional,
  type FleetPlatformState,
} from "../src/fleet-platform-patch.ts";
import { FleetPatchInput } from "@pgcf/contracts/fleet-patches";
import { randomUUID, createHash } from "node:crypto";
test("separate native controller/gateway pins reconcile through distinct logical images and prove actual selected runtime digests", async () => {
  const fixture = patchFixture(),
    commit = "f".repeat(40),
    controller = {
      name: "native-controller",
      kind: "image" as const,
      version: "1.0.0",
      reference: "registry.example/pgcf-regional@sha256:" + "1".repeat(64),
      sha256: "1".repeat(64),
      workload: {
        namespace: "pgcf-system",
        selector: { app: "agent" },
        scope: "cluster" as const,
      },
    },
    gateway = {
      ...controller,
      name: "native-gateway",
      reference: "registry.example/pgcf-regional@sha256:" + "2".repeat(64),
      sha256: "2".repeat(64),
      workload: {
        namespace: "pgcf-system",
        selector: { app: "gateway" },
        scope: "cluster" as const,
      },
    };
  const input = FleetPatchInput.parse({
    ...fixture.input,
    spec: {
      ...fixture.input.spec,
      platform_source_commit: commit,
      components: [...fixture.input.spec.components, controller, gateway],
      roles: {
        ...fixture.input.spec.roles,
        customer: {
          ...fixture.input.spec.roles.customer,
          components: [controller.name, gateway.name, "cloudflared"],
        },
      },
    },
  });
  const resource = (
    kind: string,
    name: string,
    spec: object,
    status: object = {},
  ) => ({
    apiVersion: "test/v1",
    kind,
    metadata: {
      uid: randomUUID(),
      name,
      namespace: "flux-system",
      generation: 1,
    },
    spec,
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      ...status,
    },
  });
  const source = resource(
      "GitRepository",
      "pgcf-platform",
      { ref: { commit } },
      { artifact: { revision: `sha1:${commit}` } },
    ),
    platform = resource(
      "Kustomization",
      "pgcf-platform",
      {},
      { lastAppliedRevision: `sha1:${commit}` },
    ),
    regional = resource(
      "Kustomization",
      "pgcf-regional",
      {
        path: "./infra/platform/regional",
        sourceRef: { name: "pgcf-platform" },
        images: [
          { name: "unrelated", newName: "retained", digest: "sha256:old" },
        ],
      },
      { lastAppliedRevision: `sha1:${commit}` },
    );
  const keys = { test: "A".repeat(43) },
    keyText = JSON.stringify(keys),
    sha256 = createHash("sha256").update(keyText).digest("hex");
  input.storage_authority = { keys, sha256 };
  input.spec.storage_authority_keys_sha256 = sha256;
  input.retained_thick_storage = [];
  const workload = (app: string) => {
    const value = resource(
      "Deployment",
      app === "agent" ? "pgcf-agent" : "pgcf-gateway",
      {
        replicas: 1,
        selector: { matchLabels: { app } },
        template: {
          spec: {
            containers: [
              {
                name: app,
                image:
                  app === "agent" ? controller.reference : gateway.reference,
                command: [
                  app === "agent"
                    ? "/pgcf-native-controller"
                    : "/pgcf-native-gateway",
                ],
                ...(app === "gateway"
                  ? {
                      ports: [{ name: "http", containerPort: 8080 }],
                      livenessProbe: {
                        httpGet: { path: "/healthz", port: "http" },
                      },
                      readinessProbe: {
                        httpGet: { path: "/readyz", port: "http" },
                      },
                    }
                  : {}),
                env:
                  app === "gateway"
                    ? [
                        { name: "PGCF_STORAGE_AUTHORITY_KEYS", value: keyText },
                        {
                          name: "PGCF_STORAGE_AUTHORITY_KEYS_SHA256",
                          value: sha256,
                        },
                        {
                          name: "PGCF_GATEWAY_LEGACY_BINDINGS_JSON",
                          value: "[]",
                        },
                      ]
                    : [
                        {
                          name: "PGCF_CLUSTER_UID",
                          value: input.status.cluster_uid,
                        },
                      ],
              },
            ],
          },
        },
      },
      {
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
      },
    );
    value.metadata.namespace = "pgcf-system";
    return value;
  };
  const resources = new Map(
    [source, platform, regional].map((value) => [
      `${value.kind}/flux-system/${value.metadata.name}`,
      value,
    ]),
  );
  const pins = [
    controller,
    gateway,
    input.spec.components.find((v) => v.name === "cloudflared")!,
  ];
  const pods = pins.map((pin) => ({
    metadata: {
      uid: randomUUID(),
      namespace: pin.workload?.namespace ?? "other",
      labels: pin.workload?.selector ?? {},
      ownerReferences: [{ controller: true, uid: randomUUID() }],
    },
    spec: {
      nodeName:
        pin.workload?.scope === "cluster"
          ? "control-node"
          : input.k8s_node_name,
      containers: [{ name: "run", image: pin.reference }],
    },
    status: {
      containerStatuses: [
        {
          name: "run",
          ready: true,
          imageID: `containerd://${pin.reference}`,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  }));
  const state: FleetPlatformState = {
      resources,
      pods,
      uids: Object.fromEntries(
        [...resources].map(([key, value]) => [key, value.metadata.uid]),
      ),
    },
    assets = { lock: {}, flux: [], flux_deprecated: [], relay: {} };
  for (const app of ["agent", "gateway"]) {
    const value = workload(app);
    resources.set(`Deployment/pgcf-system/${value.metadata.name}`, value);
    state.uids[`Deployment/pgcf-system/${value.metadata.name}`] =
      value.metadata.uid;
  }
  let mutations = 0;
  await reconcileFleetRegional(
    input,
    state,
    assets,
    state.uids,
    {
      authorize: async () => {},
      kube: async (args, stdin) => {
        if (args[0] === "get") return JSON.stringify(regional);
        mutations++;
        const patch = JSON.parse(stdin!) as {
          op: string;
          path: string;
          value: unknown;
        }[];
        applyTests(regional, patch);
        regional.spec = patch.find(
          (v) => v.op === "replace" && v.path === "/spec",
        )!.value as typeof regional.spec;
        return JSON.stringify(regional);
      },
    },
    [],
  );
  assert.equal(mutations, 1);
  assert.equal(
    (regional.spec as { path: string }).path,
    "./infra/platform/regional-native",
  );
  const images = (
    regional.spec as {
      images: { name: string; newName: string; digest: string }[];
    }
  ).images;
  assert.equal(
    images.find((v) => v.name === "pgcf-native-controller")?.digest,
    `sha256:${controller.sha256}`,
  );
  assert.equal(
    images.find((v) => v.name === "pgcf-native-gateway")?.digest,
    `sha256:${gateway.sha256}`,
  );
  assert.equal(images.find((v) => v.name === "unrelated")?.newName, "retained");
  assert.equal(
    fleetPlatformReadback(input, state, assets, []).regional_ready,
    true,
  );
  const agent = resources.get("Deployment/pgcf-system/pgcf-agent")!,
    agentContainer = (
      agent.spec as {
        template: { spec: { containers: { command: string[] }[] } };
      }
    ).template.spec.containers[0]!;
  agentContainer.command = ["node", "/app/agent.mjs"];
  assert.ok(
    fleetPlatformReadback(input, state, assets, []).issues.includes(
      "unobserved/runtime-wiring/native-controller",
    ),
  );
  assert.equal(
    fleetPlatformReadback(input, state, assets, []).regional_ready,
    false,
  );
  agentContainer.command = ["/pgcf-native-controller"];
  pods[1]!.status.containerStatuses[0]!.imageID = `containerd://registry.example/pgcf-regional@sha256:${"3".repeat(64)}`;
  assert.equal(
    fleetPlatformReadback(input, state, assets, []).regional_ready,
    false,
  );
});

import {
  fleetPlatformSourceObjects,
  fleetOpenEbsDriverImage,
} from "../src/fleet-platform-patch.ts";
test("the approved OpenEBS image reaches the platform without a post-build lock pin or lost overrides", () => {
  const { input } = patchFixture();
  input.spec.platform_source_commit = "a".repeat(40);
  const driver = "ghcr.io/example/openebs-wrapper:v1@sha256:" + "b".repeat(64),
    other = {
      target: { kind: "ConfigMap", name: "retained" },
      patch: "retained",
    };
  const selectedDriver = input.spec.components.find(
    (pin) => pin.name === "openebs-lvm",
  )!;
  selectedDriver.reference = driver;
  selectedDriver.sha256 = "b".repeat(64);
  const source = {
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "GitRepository",
    metadata: {
      name: "pgcf-platform",
      namespace: "flux-system",
      uid: "source",
    },
    spec: {
      url: "https://github.com/amerged-org/cloudflare-postgres",
      ref: { branch: "main" },
    },
  };
  const platform = {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: {
      name: "pgcf-platform",
      namespace: "flux-system",
      uid: "platform",
    },
    spec: {
      path: "./infra/platform",
      sourceRef: { kind: "GitRepository", name: "pgcf-platform" },
      patches: [other],
      postBuild: { substitute: { KEEP: "yes" } },
    },
  };
  const values = fleetPlatformSourceObjects(
    input,
    {
      resources: new Map<string, Record<string, unknown>>([
        ["GitRepository/flux-system/pgcf-platform", source],
        ["Kustomization/flux-system/pgcf-platform", platform],
      ]),
      pods: [],
      uids: {},
    },
    {
      lock: {
        charts: [
          {
            name: "openebs",
            enabledEngine: { name: "lvm-localpv", appVersion: "1.10.1" },
          },
        ],
      },
      flux: [],
      flux_deprecated: [],
      relay: {},
    },
  );
  const spec = values[1]!.spec as {
    patches: (typeof other)[];
    postBuild: unknown;
  };
  assert.deepEqual(spec.postBuild, platform.spec.postBuild);
  assert.deepEqual(spec.patches[0], other);
  const selected = JSON.parse(spec.patches[1]!.patch);
  assert.equal(
    selected.spec.values["lvm-localpv"].lvmPlugin.image.tag,
    "v1@sha256:" + "b".repeat(64),
  );
  assert.equal(
    selected.spec.postRenderers[0].kustomize.patches[0].target.name,
    "openebs-lvm-localpv-node",
  );
});

test("OpenEBS selection keeps legacy locked pins and refuses malformed approved image authority", () => {
  const { input } = patchFixture(),
    driver = "ghcr.io/example/openebs-wrapper:v1@sha256:" + "b".repeat(64);
  const pin = input.spec.components.find(
    (value) => value.name === "openebs-lvm",
  )!;
  const assets = {
    lock: {
      charts: [{ name: "openebs", enabledEngine: { driverImage: driver } }],
    },
    flux: [],
    flux_deprecated: [],
    relay: {},
  };
  pin.kind = "chart";
  assert.equal(fleetOpenEbsDriverImage(input, assets), driver);
  pin.kind = "image";
  pin.reference = driver;
  pin.sha256 = "b".repeat(64);
  assert.equal(
    fleetOpenEbsDriverImage(input, {
      ...assets,
      lock: { charts: [{ name: "openebs", enabledEngine: {} }] },
    }),
    driver,
  );
  pin.sha256 = "a".repeat(64);
  assert.throws(
    () => fleetOpenEbsDriverImage(input, assets),
    /patch_platform_target_mismatch/,
  );
  pin.reference = "ghcr.io/example/openebs-wrapper:latest";
  assert.throws(
    () => fleetOpenEbsDriverImage(input, assets),
    /patch_platform_target_mismatch/,
  );
});

test("OpenEBS readiness requires both the spec-selected actual image and its host cgroup view", () => {
  const { input } = patchFixture(),
    commit = "a".repeat(40),
    driver = "ghcr.io/example/driver:v1@sha256:" + "b".repeat(64);
  input.spec.platform_source_commit = commit;
  input.spec.roles.customer.components = ["openebs-lvm"];
  const pin = input.spec.components.find(
    (value) => value.name === "openebs-lvm",
  )!;
  pin.reference = driver;
  pin.sha256 = "b".repeat(64);
  const resource = (
    kind: string,
    name: string,
    spec: object,
    status: object = {},
  ) => ({
    kind,
    metadata: { name, namespace: "flux-system", generation: 1 },
    spec,
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      ...status,
    },
  });
  const daemon = {
    kind: "DaemonSet",
    metadata: { name: "openebs-lvm-localpv-node", namespace: "openebs" },
    spec: {
      template: {
        spec: {
          volumes: [
            {
              name: "pgcf-host-cgroup",
              hostPath: { path: "/sys/fs/cgroup", type: "Directory" },
            },
          ],
          containers: [
            {
              name: "openebs-lvm-plugin",
              image: driver,
              securityContext: { privileged: true },
              volumeMounts: [
                {
                  name: "pgcf-host-cgroup",
                  mountPath: "/sys/fs/cgroup",
                  readOnly: false,
                },
              ],
            },
          ],
        },
      },
    },
  };
  const state: FleetPlatformState = {
    resources: new Map<string, Record<string, unknown>>([
      [
        "GitRepository/flux-system/pgcf-platform",
        resource(
          "GitRepository",
          "pgcf-platform",
          { ref: { commit } },
          { artifact: { revision: `main@sha1:${commit}` } },
        ),
      ],
      [
        "Kustomization/flux-system/pgcf-platform",
        resource(
          "Kustomization",
          "pgcf-platform",
          {},
          { lastAppliedRevision: `main@sha1:${commit}` },
        ),
      ],
      [
        "Kustomization/flux-system/pgcf-regional",
        resource(
          "Kustomization",
          "pgcf-regional",
          { path: "./infra/platform/regional" },
          { lastAppliedRevision: `main@sha1:${commit}` },
        ),
      ],
      ["DaemonSet/openebs/openebs-lvm-localpv-node", daemon],
    ]),
    pods: [],
    uids: {},
  };
  const assets = {
    lock: { charts: [{ name: "openebs", enabledEngine: {} }] },
    flux: [],
    flux_deprecated: [],
    relay: {},
  };
  assert.equal(
    fleetPlatformReadback(input, state, assets).platform_ready,
    false,
  );
  state.pods.push({
    metadata: { uid: randomUUID(), ownerReferences: [{ controller: true }] },
    spec: {
      nodeName: input.k8s_node_name,
      containers: [{ name: "driver", image: driver }],
    },
    status: {
      containerStatuses: [
        {
          name: "driver",
          ready: true,
          imageID: `containerd://sha256:${pin.sha256}`,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  });
  assert.equal(
    fleetPlatformReadback(input, state, assets).platform_ready,
    true,
  );
  daemon.spec.template.spec.containers[0]!.volumeMounts = [];
  assert.equal(
    fleetPlatformReadback(input, state, assets).platform_ready,
    false,
  );
});

import {
  readFleetFluxIdentities,
  reconcileFleetFlux,
} from "../src/fleet-platform-patch.ts";
test("retained Flux upgrades create absent qualified objects, resolve a lost create reply and retain their actual UID", async () => {
  const { input } = patchFixture();
  const expected = [
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "critical-pods", namespace: "flux-system" },
      spec: { hard: { pods: "1000" } },
    },
    {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: "artifactgenerators.source.extensions.fluxcd.io" },
      spec: {
        group: "source.extensions.fluxcd.io",
        names: { kind: "ArtifactGenerator", plural: "artifactgenerators" },
        scope: "Namespaced",
        versions: [{ name: "v1beta1", served: true, storage: true }],
      },
    },
  ];
  const assets = { lock: {}, flux: expected, flux_deprecated: [], relay: {} },
    present = new Map<string, Record<string, unknown>>(),
    committed: Record<string, string> = {};
  let creates = 0;
  const commands = {
    authorize: async () => {},
    kube: async (args: string[], stdin?: string) => {
      if (args[0] === "get") {
        assert.ok(args.includes("--ignore-not-found"));
        const value = present.get(args[2]!);
        return value ? JSON.stringify(value) : "";
      }
      assert.equal(args[0], "create");
      creates++;
      assert.equal(Object.keys(committed).length, creates - 1);
      const value = JSON.parse(stdin!) as Record<string, unknown>,
        metadata = value.metadata as Record<string, unknown>;
      assert.equal(
        (metadata.annotations as Record<string, unknown>)[
          "pgcf.io/fleet-patch-operation"
        ],
        input.status.operation_id,
      );
      metadata.uid = randomUUID();
      metadata.resourceVersion = "1";
      present.set(String(metadata.name), value);
      // The API committed the fixed-name creation but the command reply was lost.
      if (creates === 1) throw Error("lost_create_reply");
      return JSON.stringify(value);
    },
  };
  assert.deepEqual(await readFleetFluxIdentities(assets, commands), {});
  await reconcileFleetFlux(input, assets, {}, commands, async (bindings) => {
    Object.assign(committed, bindings);
  });
  const bindings = await readFleetFluxIdentities(assets, commands, {
    operation_id: input.status.operation_id,
    bound_uids: {},
  });
  assert.equal(Object.keys(bindings).length, 2);
  assert.equal(creates, 2);
  const recovered: Record<string, string> = {};
  await reconcileFleetFlux(input, assets, {}, commands, async (current) => {
    Object.assign(recovered, current);
  });
  assert.deepEqual(recovered, bindings);
  assert.equal(creates, 2);
  await reconcileFleetFlux(input, assets, bindings, commands);
  assert.equal(creates, 2);
  const quota = present.get("critical-pods")!;
  (quota.metadata as Record<string, unknown>).uid = randomUUID();
  await assert.rejects(
    readFleetFluxIdentities(assets, commands, {
      operation_id: input.status.operation_id,
      bound_uids: bindings,
    }),
    /patch_platform_identity_changed/,
  );
  present.delete("critical-pods");
  await assert.rejects(
    readFleetFluxIdentities(assets, commands, {
      operation_id: input.status.operation_id,
      bound_uids: bindings,
    }),
    /patch_platform_identity_changed/,
  );
  assert.equal(creates, 2);
});

test("a denied Flux read or an unowned fixed-name collision cannot authorize creation", async () => {
  const { input } = patchFixture(),
    quota = {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "critical-pods", namespace: "flux-system" },
      spec: { hard: { pods: "1000" } },
    },
    assets = { lock: {}, flux: [quota], flux_deprecated: [], relay: {} };
  let writes = 0,
    denial: string | undefined = "Forbidden";
  const commands = {
    authorize: async () => {},
    kube: async (args: string[]) => {
      if (args[0] !== "get") writes++;
      if (denial) throw Error(denial);
      return JSON.stringify({
        ...quota,
        metadata: { ...quota.metadata, uid: randomUUID() },
      });
    },
  };
  await assert.rejects(readFleetFluxIdentities(assets, commands), /Forbidden/);
  await assert.rejects(
    reconcileFleetFlux(input, assets, {}, commands, async () => {}),
    /Forbidden/,
  );
  denial = "transport_failed";
  await assert.rejects(
    reconcileFleetFlux(input, assets, {}, commands, async () => {}),
    /transport_failed/,
  );
  denial = undefined;
  await assert.rejects(
    readFleetFluxIdentities(assets, commands, {
      operation_id: input.status.operation_id,
      bound_uids: {},
    }),
    /patch_platform_identity_unbound/,
  );
  await assert.rejects(
    reconcileFleetFlux(input, assets, {}, commands, async () => {}),
    /patch_platform_identity_unbound/,
  );
  assert.equal(writes, 0);
});

test("release image observations ignore terminal rollout Pods but still require an active Ready pinned Pod", () => {
  const { input } = patchFixture(),
    commit = "f".repeat(40),
    pin = input.spec.components.find((value) => value.name === "regional")!;
  input.spec.platform_source_commit = commit;
  pin.workload = {
    namespace: "pgcf-system",
    selector: { "app.kubernetes.io/name": "pgcf-agent" },
    scope: "cluster",
  };
  input.spec.roles.customer.components = [pin.name];
  const resource = (
    kind: string,
    name: string,
    spec: object,
    status: object,
  ) => ({
    kind,
    metadata: {
      name,
      namespace: "flux-system",
      uid: randomUUID(),
      generation: 1,
    },
    spec,
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      ...status,
    },
  });
  const source = resource(
      "GitRepository",
      "pgcf-platform",
      { ref: { commit } },
      { artifact: { revision: `sha1:${commit}` } },
    ),
    platform = resource(
      "Kustomization",
      "pgcf-platform",
      {},
      { lastAppliedRevision: `sha1:${commit}` },
    ),
    regional = resource(
      "Kustomization",
      "pgcf-regional",
      { path: "./infra/platform/regional" },
      { lastAppliedRevision: `sha1:${commit}` },
    ),
    workload = resource(
      "Deployment",
      "pgcf-agent",
      {
        replicas: 1,
        selector: { matchLabels: pin.workload.selector },
        template: {
          spec: { containers: [{ name: "agent", image: pin.reference }] },
        },
      },
      {
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
      },
    );
  workload.metadata.namespace = "pgcf-system";
  const active = {
      metadata: {
        uid: randomUUID(),
        namespace: "pgcf-system",
        labels: pin.workload.selector,
        ownerReferences: [{ controller: true, uid: randomUUID() }],
      },
      spec: {
        nodeName: input.k8s_node_name,
        containers: [{ name: "agent", image: pin.reference }],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "agent",
            ready: true,
            imageID: pin.reference,
            state: { running: { startedAt: new Date().toISOString() } },
          },
        ],
      },
    },
    succeeded = structuredClone(active),
    failed = structuredClone(active);
  succeeded.metadata.uid = randomUUID();
  succeeded.status.phase = "Succeeded";
  succeeded.status.containerStatuses[0]!.ready = false;
  succeeded.spec.containers[0]!.image =
    "registry.example/regional@sha256:" + "e".repeat(64);
  failed.metadata.uid = randomUUID();
  failed.status.phase = "Failed";
  failed.status.containerStatuses[0]!.ready = false;
  const values = [source, platform, regional, workload],
    state: FleetPlatformState = {
      resources: new Map(
        values.map((value) => [
          `${value.kind}/${value.metadata.namespace}/${value.metadata.name}`,
          value,
        ]),
      ),
      pods: [succeeded, failed, active],
      uids: {},
    },
    assets = { lock: {}, flux: [], flux_deprecated: [], relay: {} };
  assert.equal(
    fleetPlatformReadback(input, state, assets).regional_ready,
    true,
  );
  succeeded.status.phase = "Pending";
  assert.equal(
    fleetPlatformReadback(input, state, assets).regional_ready,
    false,
  );
  succeeded.status.phase = "Succeeded";
  active.status.containerStatuses[0]!.ready = false;
  assert.equal(
    fleetPlatformReadback(input, state, assets).regional_ready,
    false,
  );
  state.pods = [succeeded, failed];
  assert.equal(
    fleetPlatformReadback(input, state, assets).regional_ready,
    false,
  );
});
