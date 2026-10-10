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
import { openEbsCgroupPostRenderers } from "../../../infra/platform/openebs-image.ts";
import { randomUUID, createHash } from "node:crypto";
test("disabled storage authority supplies both empty Regional substitutions without replacing operator configuration", async () => {
  const { input } = patchFixture();
  input.spec.roles.customer.host_configuration_required = false;
  const key = "Kustomization/flux-system/pgcf-regional",
    uid = randomUUID(),
    refs = [{ kind: "ConfigMap", name: "pgcf-regional-vars", optional: false }];
  const regional: Record<string, unknown> = {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: { name: "pgcf-regional", namespace: "flux-system", uid },
    spec: {
      path: "./infra/platform/regional",
      sourceRef: { name: "pgcf-platform" },
      postBuild: {
        substituteFrom: refs,
        substitute: { RETAINED: "unchanged" },
      },
    },
  };
  const state: FleetPlatformState = {
    resources: new Map([[key, regional]]),
    pods: [],
    uids: { [key]: uid },
  };
  let writes = 0;
  await reconcileFleetRegional(
    input,
    state,
    { lock: {}, flux: [], flux_deprecated: [], relay: {} },
    state.uids,
    {
      authorize: async () => {},
      kube: async (args, stdin) => {
        if (args[0] === "get") return JSON.stringify(regional);
        writes++;
        const patch = JSON.parse(stdin!);
        applyTests(regional, patch);
        regional.spec = patch.find(
          (p: { op: string; path: string }) =>
            p.op === "replace" && p.path === "/spec",
        ).value;
        return JSON.stringify(regional);
      },
    },
    [],
  );
  const build = (
    regional.spec as {
      postBuild: {
        substituteFrom: unknown[];
        substitute: Record<string, string>;
      };
    }
  ).postBuild;
  assert.equal(build.substitute.PGCF_STORAGE_AUTHORITY_KEYS, "");
  assert.equal(build.substitute.PGCF_STORAGE_AUTHORITY_KEYS_SHA256, "");
  assert.equal(build.substitute.RETAINED, "unchanged");
  assert.deepEqual(build.substituteFrom, refs);
  assert.equal(writes, 1);
});

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
  const substitute = (
    regional.spec as { postBuild: { substitute: Record<string, string> } }
  ).postBuild.substitute;
  assert.equal(substitute.PGCF_STORAGE_AUTHORITY_KEYS, keyText);
  assert.equal(substitute.PGCF_STORAGE_AUTHORITY_KEYS_SHA256, sha256);
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

test("OpenEBS replaces its obsolete namespace-targeted cgroup renderer while preserving unrelated renderers", () => {
  const { input } = patchFixture();
  input.spec.platform_source_commit = "a".repeat(40);
  const expected = openEbsCgroupPostRenderers(),
    obsolete = structuredClone(expected);
  const oldPatch = obsolete[0]!.kustomize.patches[0]!;
  Object.assign(oldPatch.target, { namespace: "openebs" });
  const oldBody = JSON.parse(oldPatch.patch);
  oldBody.metadata.namespace = "openebs";
  oldPatch.patch = JSON.stringify(oldBody);
  const unrelated = {
      kustomize: { images: [{ name: "retained", newTag: "keep" }] },
    },
    target = {
      group: "helm.toolkit.fluxcd.io",
      version: "v2",
      kind: "HelmRelease",
      name: "openebs",
      namespace: "flux-system",
    };
  const prior = {
    apiVersion: "helm.toolkit.fluxcd.io/v2",
    kind: "HelmRelease",
    metadata: { name: "openebs", namespace: "flux-system" },
    spec: { postRenderers: [unrelated, ...obsolete], values: { KEEP: "yes" } },
  };
  const resources = new Map<string, Record<string, unknown>>([
    [
      "GitRepository/flux-system/pgcf-platform",
      {
        apiVersion: "source.toolkit.fluxcd.io/v1",
        kind: "GitRepository",
        metadata: { name: "pgcf-platform", namespace: "flux-system" },
        spec: {
          url: "https://github.com/amerged-org/cloudflare-postgres",
          ref: { branch: "main" },
        },
      },
    ],
    [
      "Kustomization/flux-system/pgcf-platform",
      {
        apiVersion: "kustomize.toolkit.fluxcd.io/v1",
        kind: "Kustomization",
        metadata: { name: "pgcf-platform", namespace: "flux-system" },
        spec: {
          path: "./infra/platform",
          sourceRef: { name: "pgcf-platform" },
          patches: [{ target, patch: JSON.stringify(prior) }],
        },
      },
    ],
  ]);
  const values = fleetPlatformSourceObjects(
    input,
    { resources, pods: [], uids: {} },
    {
      lock: { charts: [{ name: "openebs", enabledEngine: {} }] },
      flux: [],
      flux_deprecated: [],
      relay: {},
    },
  );
  const patch = (values[1]!.spec as { patches: { patch: string }[] })
    .patches[0]!;
  const actual = JSON.parse(patch.patch);
  assert.deepEqual(actual.spec.postRenderers, [unrelated, ...expected]);
  assert.equal(actual.spec.values.KEEP, "yes");
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

import { readFileSync } from "node:fs";
import { readFleetPlatformState } from "../src/fleet-platform-patch.ts";

// Actual immutable Cilium/Flux index bytes; the expected AMD64 pins come from the lock.
const platformIndexBodies = [
  '{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.index.v1+json",\n  "manifests": [\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:9d308e3f7f05972b0b0604c40d2b0f08fa2f6a55084fef1e1aaadb469e430639",\n      "size": 1247,\n      "platform": {\n        "architecture": "amd64",\n        "os": "linux"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:02dd062a1f48a6ef52f50e7396117f9e7c82fbe9e6408dcaebe212257414bbeb",\n      "size": 1247,\n      "platform": {\n        "architecture": "arm64",\n        "os": "linux"\n      }\n    }\n  ]\n}',
  '{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.index.v1+json",\n  "manifests": [\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:d10ea2ebeb475de80a6d3caf792578b1eaaa0366c55442d20d7e5f6f78fad3ec",\n      "size": 865,\n      "platform": {\n        "architecture": "amd64",\n        "os": "linux"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:abda1053b630d5258b04dbd5090029e4c7f68cb1ab6ba26d46764912f81ddcec",\n      "size": 865,\n      "platform": {\n        "architecture": "arm",\n        "os": "linux",\n        "variant": "v7"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:5f2e5cd101b7b5e22afa9d555ba58afb54c5bbc099ac814deb993ee2e982592f",\n      "size": 865,\n      "platform": {\n        "architecture": "arm64",\n        "os": "linux"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:20057b4589fdd01b3d09ed33a75c51fd40e3d2f99007ddc0b3f10f0ad762cf4a",\n      "size": 1110,\n      "annotations": {\n        "vnd.docker.reference.digest": "sha256:d10ea2ebeb475de80a6d3caf792578b1eaaa0366c55442d20d7e5f6f78fad3ec",\n        "vnd.docker.reference.type": "attestation-manifest"\n      },\n      "platform": {\n        "architecture": "unknown",\n        "os": "unknown"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:3e698ddbfe73c13c2478b36513ca2907d62bb0ccd1c5a886ec73df5205badb90",\n      "size": 1110,\n      "annotations": {\n        "vnd.docker.reference.digest": "sha256:abda1053b630d5258b04dbd5090029e4c7f68cb1ab6ba26d46764912f81ddcec",\n        "vnd.docker.reference.type": "attestation-manifest"\n      },\n      "platform": {\n        "architecture": "unknown",\n        "os": "unknown"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:de87d42abc0237190ef5f33b7a56141736fd6104dd67bd5fd722718e67c606b0",\n      "size": 1110,\n      "annotations": {\n        "vnd.docker.reference.digest": "sha256:5f2e5cd101b7b5e22afa9d555ba58afb54c5bbc099ac814deb993ee2e982592f",\n        "vnd.docker.reference.type": "attestation-manifest"\n      },\n      "platform": {\n        "architecture": "unknown",\n        "os": "unknown"\n      }\n    }\n  ]\n}',
];
function platformIndexFixture() {
  const { input } = patchFixture();
  const lock = JSON.parse(
    readFileSync(
      new URL("../../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const cilium = lock.charts.find(
    (value: { name: string }) => value.name === "cilium",
  );
  const references = [
    cilium.renderedImages.find((value: string) =>
      value.startsWith("quay.io/cilium/cilium:"),
    ),
    lock.flux.images["source-controller"],
  ];
  const names = ["image/cilium/cilium", "flux-source"];
  input.spec.platform_source_commit = "f".repeat(40);
  const pins = references.map((reference: string, index: number) => ({
    name: names[index]!,
    kind: "image" as const,
    version: reference.split("@")[0]!.split(":").at(-1)!,
    reference,
    sha256: reference.split("@sha256:")[1]!,
    workload: {
      namespace: index === 0 ? "kube-system" : "flux-system",
      selector: { app: names[index]! },
      scope: "cluster" as const,
    },
  }));
  input.spec.components = [
    ...input.spec.components.filter((v) => !names.includes(v.name)),
    ...pins,
  ];
  input.spec.roles.customer.components = names;
  const resource = (
    kind: string,
    name: string,
    spec: object,
    status: object,
  ) => ({
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
  const commit = input.spec.platform_source_commit;
  const flux = [
    resource(
      "GitRepository",
      "pgcf-platform",
      { ref: { commit } },
      { artifact: { revision: `sha1:${commit}` } },
    ),
    resource(
      "Kustomization",
      "pgcf-platform",
      {},
      { lastAppliedRevision: `sha1:${commit}` },
    ),
    resource(
      "Kustomization",
      "pgcf-regional",
      { path: "./infra/platform/regional" },
      { lastAppliedRevision: `sha1:${commit}` },
    ),
  ];
  const workloads = pins.map((pin, index) => {
    const value = resource(
      "Deployment",
      "workload-" + index,
      { replicas: 1, selector: { matchLabels: pin.workload.selector } },
      {
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
      },
    );
    value.metadata.namespace = pin.workload.namespace;
    return value;
  });
  const pods = pins.map((pin, index) => ({
    kind: "Pod",
    metadata: {
      uid: randomUUID(),
      namespace: pin.workload.namespace,
      labels: pin.workload.selector,
      ownerReferences: [
        { controller: true, uid: workloads[index]!.metadata.uid },
      ],
    },
    spec: {
      nodeName: input.k8s_node_name,
      containers: [{ name: "main", image: pin.reference }],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "main",
          ready: true,
          imageID:
            pin.reference.split("@")[0] +
            "@sha256:" +
            createHash("sha256")
              .update(platformIndexBodies[index]!)
              .digest("hex"),
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  }));
  const bootID = randomUUID();
  const nodes = [
    {
      kind: "Node",
      metadata: { name: input.k8s_node_name, uid: input.status.node_uid },
      status: {
        nodeInfo: { architecture: "amd64", operatingSystem: "linux", bootID },
      },
    },
  ];
  const request = async (url: string | URL | Request) => {
    const address = String(url);
    if (address.startsWith("https://ghcr.io/token?"))
      return new Response(JSON.stringify({ token: "unit-test-only" }));
    const index = address.includes("quay.io") ? 0 : 1;
    return new Response(platformIndexBodies[index]!, {
      headers: {
        "docker-content-digest":
          "sha256:" +
          createHash("sha256")
            .update(platformIndexBodies[index]!)
            .digest("hex"),
      },
    });
  };
  const commands = {
    request: request as typeof fetch,
    kube: async (args: string[]) => {
      if (args[1] === "deployments.apps,daemonsets.apps")
        return JSON.stringify({ items: workloads });
      if (args[1] === "pods") return JSON.stringify({ items: pods });
      if (args[1] === "nodes") return JSON.stringify({ items: nodes });
      const kinds: Record<string, string> = {
        gitrepositories: "GitRepository",
        kustomizations: "Kustomization",
        helmreleases: "HelmRelease",
        ocirepositories: "OCIRepository",
        helmcharts: "HelmChart",
      };
      return JSON.stringify({
        items: flux.filter(
          (value) => value.kind === kinds[args[1]!.split(".")[0]!],
        ),
      });
    },
  };
  return {
    input,
    pins,
    pods,
    nodes,
    bootID,
    commands,
    assets: { lock: {}, flux: [], flux_deprecated: [], relay: {} },
  };
}

test("platform runtime parent indexes prove the locked AMD64 child without rewriting raw Pods", async () => {
  const fixture = platformIndexFixture();
  const state = await readFleetPlatformState(fixture.commands, fixture.input);
  const seen = fleetPlatformReadback(
    fixture.input,
    state,
    fixture.assets,
  ).components;
  for (const pin of fixture.pins)
    assert.ok(
      seen.some(
        (value) => value.name === pin.name && value.sha256 === pin.sha256,
      ),
    );
  assert.deepEqual(state.pods, fixture.pods);
  (
    state.nodes![0]!.status as { nodeInfo: { bootID: string } }
  ).nodeInfo.bootID = randomUUID();
  assert.equal(
    fleetPlatformReadback(fixture.input, state, fixture.assets).components
      .length,
    0,
  );
});

test("platform aliases retain immutable configuration pins and exact member identity", async () => {
  const fixture = platformIndexFixture();
  fixture.pods[0]!.spec.containers[0]!.image =
    fixture.pins[0]!.reference.split("@")[0] +
    "@sha256:" +
    createHash("sha256").update(platformIndexBodies[0]!).digest("hex");
  fixture.pods[1]!.spec.containers[0]!.image =
    fixture.pins[1]!.reference.split("@")[0]!;
  const state = await readFleetPlatformState(fixture.commands, fixture.input, {
    nodes: fixture.nodes,
    boot_id: fixture.bootID,
  });
  const seen = fleetPlatformReadback(
    fixture.input,
    state,
    fixture.assets,
  ).components;
  assert.ok(seen.some((value) => value.name === fixture.pins[0]!.name));
  assert.equal(
    seen.some((value) => value.name === fixture.pins[1]!.name),
    false,
  );
  fixture.pods[0]!.metadata.uid = randomUUID();
  state.pods = fixture.pods;
  assert.equal(
    fleetPlatformReadback(fixture.input, state, fixture.assets).components
      .length,
    0,
  );

  const changedMember = platformIndexFixture();
  changedMember.nodes[0]!.metadata.uid = randomUUID();
  await assert.rejects(
    readFleetPlatformState(changedMember.commands, changedMember.input),
    /patch_platform_identity_invalid/,
  );
  const changedBoot = platformIndexFixture();
  await assert.rejects(
    readFleetPlatformState(changedBoot.commands, changedBoot.input, {
      nodes: changedBoot.nodes,
      boot_id: randomUUID(),
    }),
    /patch_platform_identity_invalid/,
  );
});

test("platform aliases reject tampered metadata, another AMD64 child and a non-AMD64 member", async () => {
  const tampered = platformIndexFixture();
  const originalRequest = tampered.commands.request;
  tampered.commands.request = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalRequest(...args);
    if (String(args[0]).includes("/token?")) return response;
    return new Response((await response.text()) + " ", {
      headers: response.headers,
    });
  }) as typeof fetch;
  const invalid = await readFleetPlatformState(
    tampered.commands,
    tampered.input,
  );
  assert.equal(
    fleetPlatformReadback(tampered.input, invalid, tampered.assets).components
      .length,
    0,
  );

  const wrongChild = platformIndexFixture();
  wrongChild.pins[0]!.sha256 = "a".repeat(64);
  wrongChild.pins[0]!.reference =
    wrongChild.pins[0]!.reference.split("@")[0] +
    "@sha256:" +
    wrongChild.pins[0]!.sha256;
  wrongChild.pods[0]!.spec.containers[0]!.image = wrongChild.pins[0]!.reference;
  const mismatched = await readFleetPlatformState(
    wrongChild.commands,
    wrongChild.input,
  );
  assert.equal(
    fleetPlatformReadback(
      wrongChild.input,
      mismatched,
      wrongChild.assets,
    ).components.some((value) => value.name === wrongChild.pins[0]!.name),
    false,
  );

  const wrongArchitecture = platformIndexFixture();
  wrongArchitecture.nodes[0]!.status.nodeInfo.architecture = "arm64";
  const incompatible = await readFleetPlatformState(
    wrongArchitecture.commands,
    wrongArchitecture.input,
  );
  assert.equal(
    fleetPlatformReadback(
      wrongArchitecture.input,
      incompatible,
      wrongArchitecture.assets,
    ).components.length,
    0,
  );
});

test("Flux kind readbacks run concurrently without a serialized multi-kind kubectl transport", async () => {
  const kinds = new Map([
    ["gitrepositories.source.toolkit.fluxcd.io", "GitRepository"],
    ["kustomizations.kustomize.toolkit.fluxcd.io", "Kustomization"],
    ["helmreleases.helm.toolkit.fluxcd.io", "HelmRelease"],
    ["ocirepositories.source.toolkit.fluxcd.io", "OCIRepository"],
    ["helmcharts.source.toolkit.fluxcd.io", "HelmChart"],
  ]);
  let active = 0,
    peak = 0;
  const seen: string[] = [];
  const state = await readFleetPlatformState({
    kube: async (args) => {
      const resource = args[1]!;
      seen.push(resource);
      if (resource.includes("gitrepositories") && resource.includes(","))
        throw new Error("compound_flux_read_serializes_transports");
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return JSON.stringify({
        items: kinds.has(resource)
          ? [
              {
                kind: kinds.get(resource),
                metadata: {
                  name: "fixture",
                  namespace: "flux-system",
                  uid: randomUUID(),
                },
              },
            ]
          : [],
      });
    },
  });
  assert.deepEqual(
    seen.filter((resource) => kinds.has(resource)),
    [...kinds.keys()],
  );
  assert.ok(peak >= kinds.size);
  assert.equal(state.resources.size, kinds.size);
});
