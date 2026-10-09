// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, stringify } from "yaml";
import {
  fleetRegionalImages,
  fleetRegionalRuntime,
  fleetRelayImages,
  readFleetPlatformAssets,
  fleetPlatformReadback,
} from "../src/fleet-platform-patch.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { canonical, digest } from "../src/bootstrap.ts";

type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;
const root = fileURLToPath(new URL("../../../", import.meta.url));
function nativeInput() {
  const { input } = patchFixture();
  for (const [index, name] of [
    "native-controller",
    "native-gateway",
    "native-bootstrap-relay",
  ].entries())
    input.spec.components.push({
      name,
      kind: "image",
      version: "0.1.0",
      reference: `registry.example/pgcf-regional:native-${index}@sha256:${String(index + 1).repeat(64)}`,
      sha256: String(index + 1).repeat(64),
    });
  input.spec.platform_source_commit = "f".repeat(40);
  return input;
}
async function render(directory: string, path: string, images: unknown[]) {
  const overlay = join(directory, "render-" + path.replaceAll("/", "-"));
  await mkdir(overlay);
  await writeFile(
    join(overlay, "kustomization.yaml"),
    stringify({
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
      resources: [`../${path}`],
      images,
    }),
  );
  const text = execFileSync(
    process.env.PGCF_TEST_KUBECTL ?? "kubectl",
    ["kustomize", overlay],
    {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH },
    },
  ).toString();
  return parseAllDocuments(text).map((document) => {
    assert.equal(document.errors.length, 0);
    return document.toJSON() as Json;
  });
}
const deployment = (values: Json[], name: string) =>
  values.find(
    (value) =>
      value.kind === "Deployment" && object(value.metadata).name === name,
  )!;
const pod = (value: Json) => object(object(object(value.spec).template).spec);
const container = (value: Json, name: string) =>
  (pod(value).containers as Json[]).find((entry) => entry.name === name)!;
test("real Kustomize composition selects all three native entrypoints and exact release pins while legacy resources remain Node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-runtime-resources-"));
  try {
    for (const path of [
      "regional",
      "regional-gateway-native",
      "regional-native",
      "bootstrap-relay",
      "bootstrap-relay-native",
    ])
      await cp(join(root, "infra/platform", path), join(directory, path), {
        recursive: true,
        filter: (path) => !path.includes(".env"),
      });
    const input = nativeInput(),
      native = await render(
        directory,
        "regional-native",
        fleetRegionalImages(input),
      ),
      relay = await render(
        directory,
        "bootstrap-relay-native",
        fleetRelayImages(input),
      );
    for (const [name, values, deploymentName, containerName] of [
      ["native-controller", native, "pgcf-agent", "agent"],
      ["native-gateway", native, "pgcf-gateway", "gateway"],
      ["native-bootstrap-relay", relay, "pgcf-bootstrap-relay", "relay"],
    ] as const) {
      const selected = container(
          deployment(values, deploymentName),
          containerName,
        ),
        pin = input.spec.components.find((value) => value.name === name)!;
      assert.equal(
        selected.image,
        `registry.example/pgcf-regional@sha256:${pin.sha256}`,
      );
      const docker = await readFile(
        join(
          root,
          `apps/${name === "native-bootstrap-relay" ? "native-bootstrap-relay" : name}/Dockerfile`,
        ),
        "utf8",
      );
      const entrypoint = JSON.parse(
        /ENTRYPOINT (\[[^\n]+\])/.exec(docker)![1]!,
      ) as string[];
      assert.deepEqual(selected.command, entrypoint);
      assert.ok(
        selected.args === undefined || canonical(selected.args) === "[]",
      );
      assert.equal(
        object(pod(deployment(values, deploymentName)).securityContext)
          .runAsUser,
        65532,
      );
    }
    const agent = container(deployment(native, "pgcf-agent"), "agent"),
      gateway = container(deployment(native, "pgcf-gateway"), "gateway"),
      transport = container(deployment(relay, "pgcf-bootstrap-relay"), "relay");
    assert.ok(
      (agent.env as Json[]).some(
        (entry) =>
          entry.name === "PGCF_CLUSTER_UID" &&
          entry.value === "${PGCF_CLUSTER_UID}",
      ),
    );
    assert.ok(
      (gateway.env as Json[]).some(
        (entry) => entry.name === "PGCF_GATEWAY_LEGACY_BINDINGS_JSON",
      ),
    );
    assert.equal(
      object(object(gateway.readinessProbe).httpGet).path,
      "/readyz",
    );
    assert.equal(
      object(object(gateway.livenessProbe).httpGet).path,
      "/healthz",
    );
    for (const probe of [transport.readinessProbe, transport.livenessProbe]) {
      assert.equal(object(probe).exec, undefined);
      assert.deepEqual(object(probe).httpGet, {
        host: "127.0.0.1",
        path: "/_pgcf/bootstrap-relay/identity",
        port: "http",
      });
    }
    assert.equal(
      pod(deployment(relay, "pgcf-bootstrap-relay")).hostNetwork,
      true,
    );
    const config = native.find(
      (value) =>
        value.kind === "ConfigMap" &&
        object(value.metadata).name === "pgcf-regional",
    )!;
    assert.equal(
      object(config.data).PGCF_POSTGRES_IMAGE,
      "${PGCF_POSTGRES_IMAGE}",
    );
    const legacy = patchFixture().input,
      oldRegional = await render(
        directory,
        "regional",
        fleetRegionalImages(legacy),
      ),
      oldRelay = await render(
        directory,
        "bootstrap-relay",
        fleetRelayImages(legacy),
      );
    assert.equal(
      fleetRegionalRuntime(legacy).path,
      "./infra/platform/regional",
    );
    assert.deepEqual(
      container(deployment(oldRegional, "pgcf-agent"), "agent").command,
      ["node", "/app/agent.mjs"],
    );
    assert.deepEqual(
      container(deployment(oldRegional, "pgcf-gateway"), "gateway").command,
      ["node", "/app/gateway.mjs"],
    );
    assert.deepEqual(
      container(deployment(oldRelay, "pgcf-bootstrap-relay"), "relay").command,
      ["node", "/app/bootstrap-relay.mjs"],
    );
    const gatewayFirst = nativeInput();
    gatewayFirst.spec.components = gatewayFirst.spec.components.filter(
      (value) => value.name !== "native-controller",
    );
    const mixed = await render(
      directory,
      "regional-gateway-native",
      fleetRegionalImages(gatewayFirst),
    );
    assert.deepEqual(
      deployment(mixed, "pgcf-agent").spec,
      deployment(oldRegional, "pgcf-agent").spec,
    );
    const selectedGateway = container(
      deployment(mixed, "pgcf-gateway"),
      "gateway",
    );
    assert.deepEqual(selectedGateway.command, ["/pgcf-native-gateway"]);
    assert.equal(
      selectedGateway.image,
      "registry.example/pgcf-regional@sha256:" + "2".repeat(64),
    );
    assert.equal(
      object(object(selectedGateway.readinessProbe).httpGet).path,
      "/readyz",
    );
    assert.equal(
      object(object(selectedGateway.livenessProbe).httpGet).path,
      "/healthz",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("source-bound native relay overlay removes Node probes without dropping the tunnel or retained placement", async () => {
  const input = nativeInput(),
    lock = JSON.parse(
      await readFile(join(root, "infra/platform/versions.lock.json"), "utf8"),
    ) as Json;
  const target = object(lock.target);
  for (const role of Object.values(input.spec.roles)) {
    role.talos_version = String(target.talosVersion).replace(/^v/, "");
    role.kubernetes_version = String(target.kubernetesVersion).replace(
      /^v/,
      "",
    );
  }
  // The fixture serializes separate documents, matching the verified upstream artifact parser.
  const fluxText = input.spec.components
    .filter((value) => value.name.startsWith("flux-"))
    .map((value) =>
      stringify({
        kind: "Deployment",
        metadata: {
          name:
            value.name === "flux-kustomize"
              ? "kustomize-controller"
              : value.name.replace("flux-", "") + "-controller",
        },
        spec: {
          template: { spec: { containers: [{ image: value.reference }] } },
        },
      }),
    )
    .join("---\n");
  object(lock.flux).installManifestSha256 = digest(fluxText);
  const lockText = JSON.stringify(lock);
  input.spec.versions_lock_sha256 = digest(lockText);
  const requested: string[] = [];
  const assets = await readFleetPlatformAssets(
    input,
    new AbortController().signal,
    async (url) => {
      const path = String(url);
      requested.push(path);
      if (path.endsWith("versions.lock.json")) return new Response(lockText);
      if (path === object(lock.flux).installManifestURL)
        return new Response(fluxText);
      const match =
        /\/infra\/platform\/(bootstrap-relay(?:-native)?)\/relay.yaml$/.exec(
          path,
        );
      assert.ok(match);
      return new Response(
        await readFile(
          join(root, "infra/platform", match[1]!, "relay.yaml"),
          "utf8",
        ),
      );
    },
  );
  assert.ok(
    requested.every(
      (url) =>
        url.includes(input.spec.platform_source_commit!) ||
        url === object(lock.flux).installManifestURL,
    ),
  );
  const transport = container(assets.relay, "relay");
  assert.deepEqual(transport.command, ["/pgcf-native-bootstrap-relay"]);
  assert.equal(object(transport.readinessProbe).exec, undefined);
  assert.equal(object(transport.readinessProbe).$patch, undefined);
  assert.equal((pod(assets.relay).containers as Json[]).length, 2);
  assert.deepEqual(pod(assets.relay).nodeSelector, {
    "kubernetes.io/hostname": "${PGCF_BOOTSTRAP_RELAY_NODE_NAME}",
  });
  const relayPin = input.spec.components.find(
    (value) => value.name === "native-bootstrap-relay",
  )!;
  input.spec.components = input.spec.components.filter(
    (value) => !["native-controller", "native-gateway"].includes(value.name),
  );
  input.spec.roles.customer.components = [relayPin.name];
  const resource = (
    kind: string,
    name: string,
    spec: Json,
    status: Json = {},
  ) => ({
    apiVersion: "test/v1",
    kind,
    metadata: { name, namespace: "flux-system", uid: name, generation: 1 },
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
      { ref: { commit: input.spec.platform_source_commit } },
      { artifact: { revision: `sha1:${input.spec.platform_source_commit}` } },
    ),
    platform = resource(
      "Kustomization",
      "pgcf-platform",
      {},
      { lastAppliedRevision: `sha1:${input.spec.platform_source_commit}` },
    ),
    regional = resource(
      "Kustomization",
      "pgcf-regional",
      { path: fleetRegionalRuntime(input).path },
      { lastAppliedRevision: `sha1:${input.spec.platform_source_commit}` },
    );
  object(assets.relay.metadata).uid = "relay-owner";
  object(assets.relay.metadata).generation = 1;
  assets.relay.status = {
    observedGeneration: 1,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
  };
  transport.image = relayPin.reference;
  const state = {
    resources: new Map<string, Json>([
      ["GitRepository/flux-system/pgcf-platform", source],
      ["Kustomization/flux-system/pgcf-platform", platform],
      ["Kustomization/flux-system/pgcf-regional", regional],
      [
        "Deployment/pgcf-bootstrap-transport/pgcf-bootstrap-relay",
        assets.relay,
      ],
    ]),
    uids: {},
    pods: [
      {
        metadata: {
          uid: "relay-pod",
          namespace: "pgcf-bootstrap-transport",
          labels: { "app.kubernetes.io/name": "pgcf-bootstrap-relay" },
          ownerReferences: [{ controller: true, uid: "relay-owner" }],
        },
        spec: {
          nodeName: input.k8s_node_name,
          containers: [{ name: "relay", image: relayPin.reference }],
        },
        status: {
          containerStatuses: [
            {
              name: "relay",
              ready: true,
              imageID: `containerd://${relayPin.reference}`,
              state: { running: { startedAt: new Date().toISOString() } },
            },
          ],
        },
      },
    ],
  };
  assert.equal(
    fleetPlatformReadback(input, state, assets).regional_ready,
    true,
  );
  transport.readinessProbe = { exec: { command: ["node", "probe.mjs"] } };
  const stale = fleetPlatformReadback(input, state, assets);
  assert.equal(stale.regional_ready, false);
  assert.ok(
    stale.issues.includes("unobserved/runtime-wiring/native-bootstrap-relay"),
  );
});
test("the controller migration cannot omit its preceding native gateway stage", () => {
  const input = nativeInput();
  input.spec.components = input.spec.components.filter(
    (value) => value.name !== "native-gateway",
  );
  assert.throws(
    () => fleetRegionalImages(input),
    /patch_regional_composition_incomplete/,
  );
});
test("a qualified gateway-first release selects the Rust gateway without replacing its legacy regional controller", () => {
  const input = nativeInput();
  input.spec.components = input.spec.components.filter(
    (value) => value.name !== "native-controller",
  );
  assert.equal(
    fleetRegionalRuntime(input).path,
    "./infra/platform/regional-gateway-native",
  );
  const images = fleetRegionalImages(input);
  assert.ok(images.some((value) => value.name === "pgcf-regional"));
  assert.ok(images.some((value) => value.name === "pgcf-native-gateway"));
  assert.equal(
    images.some((value) => value.name === "pgcf-native-controller"),
    false,
  );
});
test("mixed gateway-first readback distinguishes legacy controller and native gateway digests in the same published repository", () => {
  const input = nativeInput();
  input.spec.components = input.spec.components.filter(
    (value) =>
      !["native-controller", "native-bootstrap-relay"].includes(value.name),
  );
  input.spec.roles.customer.components = ["regional", "native-gateway"];
  const legacy = input.spec.components.find(
      (value) => value.name === "regional",
    )!,
    gateway = input.spec.components.find(
      (value) => value.name === "native-gateway",
    )!;
  legacy.reference = `registry.example/pgcf-regional@sha256:${legacy.sha256}`;
  const keys = { test: "A".repeat(43) },
    keyText = canonical(keys),
    sha256 = digest(keyText);
  input.storage_authority = { keys, sha256 };
  input.retained_thick_storage = [];
  const observed = (
    kind: string,
    name: string,
    spec: Json,
    namespace = "flux-system",
  ) => ({
    kind,
    metadata: { name, namespace, uid: name, generation: 1 },
    spec,
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      lastAppliedRevision: `sha1:${input.spec.platform_source_commit}`,
      artifact: { revision: `sha1:${input.spec.platform_source_commit}` },
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    },
  });
  const agent = observed(
      "Deployment",
      "pgcf-agent",
      {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "pgcf-agent" } },
        template: {
          spec: {
            containers: [
              {
                name: "agent",
                image: legacy.reference,
                command: ["node", "/app/agent.mjs"],
              },
            ],
          },
        },
      },
      "pgcf-system",
    ),
    proxy = observed(
      "Deployment",
      "pgcf-gateway",
      {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "pgcf-gateway" } },
        template: {
          spec: {
            containers: [
              {
                name: "gateway",
                image: gateway.reference,
                command: ["/pgcf-native-gateway"],
                ports: [{ name: "http", containerPort: 8080 }],
                livenessProbe: { httpGet: { port: "http", path: "/healthz" } },
                readinessProbe: { httpGet: { port: "http", path: "/readyz" } },
                env: [
                  { name: "PGCF_STORAGE_AUTHORITY_KEYS", value: keyText },
                  { name: "PGCF_STORAGE_AUTHORITY_KEYS_SHA256", value: sha256 },
                  { name: "PGCF_GATEWAY_LEGACY_BINDINGS_JSON", value: "[]" },
                ],
              },
            ],
          },
        },
      },
      "pgcf-system",
    );
  const resources = [
    observed("GitRepository", "pgcf-platform", {
      ref: { commit: input.spec.platform_source_commit },
    }),
    observed("Kustomization", "pgcf-platform", {}),
    observed("Kustomization", "pgcf-regional", {
      path: fleetRegionalRuntime(input).path,
    }),
    agent,
    proxy,
  ];
  const pods = [legacy, gateway].map((pin, index) => ({
    metadata: {
      uid: `pod-${index}`,
      namespace: "pgcf-system",
      labels: {
        "app.kubernetes.io/name": index ? "pgcf-gateway" : "pgcf-agent",
      },
      ownerReferences: [
        { controller: true, uid: index ? "pgcf-gateway" : "pgcf-agent" },
      ],
    },
    spec: {
      nodeName: input.k8s_node_name,
      containers: [{ name: index ? "gateway" : "agent", image: pin.reference }],
    },
    status: {
      containerStatuses: [
        {
          name: index ? "gateway" : "agent",
          imageID: `containerd://${pin.reference}`,
          ready: true,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  }));
  const state = {
      resources: new Map<string, Json>(
        resources.map((value) => [
          `${value.kind}/${value.metadata.namespace}/${value.metadata.name}`,
          value,
        ]),
      ),
      pods,
      uids: {},
    },
    assets = { lock: {}, flux: [], flux_deprecated: [], relay: {} };
  assert.equal(
    fleetPlatformReadback(input, state, assets, []).regional_ready,
    true,
  );
  pods[0]!.status.containerStatuses[0]!.imageID = `containerd://${gateway.reference}`;
  assert.equal(
    fleetPlatformReadback(input, state, assets, []).regional_ready,
    false,
  );
});
