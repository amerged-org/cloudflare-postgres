// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, parseAllDocuments } from "yaml";
import {
  NodeBootstrapCallback,
  type NodeBootstrapStage,
} from "@pgcf/contracts/node-bootstrap";
import { BootstrapError, BootstrapJob } from "../src/bootstrap.ts";
import {
  PlatformInstaller,
  platformSyncObjects,
  regionalObjects,
  type PlatformAssets,
} from "../src/platform.ts";
import { authority, fixture, platformFixture } from "./fixture.ts";

type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;
const key = (value: Json) =>
  `${value.kind}/${object(value.metadata).namespace ?? ""}/${object(value.metadata).name}`;
const kinds: Record<string, string> = {
  namespaces: "Namespace",
  resourcequotas: "ResourceQuota",
  services: "Service",
  ocirepositories: "OCIRepository",
  deployments: "Deployment",
  daemonsets: "DaemonSet",
  nodes: "Node",
  configmaps: "ConfigMap",
  secrets: "Secret",
  gitrepositories: "GitRepository",
  kustomizations: "Kustomization",
  helmreleases: "HelmRelease",
  storageclasses: "StorageClass",
  csinodes: "CSINode",
};

function clusterFixture(
  initialStage: NodeBootstrapStage = "kubernetes_joined",
  strictHelm4 = false,
  recovery = false,
) {
  const input = platformFixture();
  let stage = initialStage;
  let release = initialStage !== "kubernetes_joined";
  let observedHelmVersion: string | undefined;
  const ociDigest =
    "sha256:a7c12d330dd96bfcda3bf057b24be8f36566c34868265f930f776dff6f42d838";
  const pinnedCiliumValues = readFileSync(
    new URL("../../../infra/platform/base/values/cilium.yaml", import.meta.url),
    "utf8",
  );
  const fluxLabels = {
    "kustomize.toolkit.fluxcd.io/name": "pgcf-platform",
    "kustomize.toolkit.fluxcd.io/namespace": "flux-system",
  };
  let lose_response = false;
  let refuse_authority = false;
  const checkpoints: NodeBootstrapStage[] = [];
  const mutations: string[][] = [];
  const resources = new Map<string, Json>();
  let recoveryJournal:
    | import("@pgcf/contracts/node-bootstrap").NodeCiliumInstallJournal
    | undefined;
  let lostRecoveryAck = false;
  let fluxRepairJournal:
    import("@pgcf/contracts/node-bootstrap").NodeFluxRepairJournal | undefined;
  let lostFluxRepairAck = false;
  let partialFluxCreate = false;
  let revokeFluxNamespaceAtDispatch = false;
  let fluxNamespaceReads = 0;
  let replaceCurrentValuesDuringProof = false;
  let currentValuesReads = 0;
  let rendered =
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cilium-bootstrap\n  namespace: kube-system\n";
  let chartCrds = "";
  let failInventory = false;
  let changeClusterAfterInventory = false;
  let renderWait = () => {};
  let partialRawInventory = false;
  const assets: PlatformAssets = {
    chart_path: "/verified/cilium.tgz",
    values_path: "/verified/cilium.yaml",
    values: parse(pinnedCiliumValues),
    flux: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: "flux-system",
          annotations: { "pgcf.io/bootstrap-input": input.input_hash },
        },
      },
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "source-controller",
          namespace: "flux-system",
          annotations: { "pgcf.io/bootstrap-input": input.input_hash },
        },
        spec: {
          replicas: 1,
          template: {
            spec: { containers: [{ name: "manager", image: "flux" }] },
          },
        },
      },
    ],
  };
  const observed = (value: Json): Json => {
    const next = structuredClone(value);
    next.metadata = {
      ...object(next.metadata),
      uid: randomUUID(),
      resourceVersion: "1",
      generation: 1,
    };
    if (next.kind === "Deployment") {
      const replicas = object(next.spec).replicas;
      next.status = {
        observedGeneration: 1,
        replicas,
        updatedReplicas: replicas,
        readyReplicas: replicas,
        availableReplicas: replicas,
      };
    }
    if (
      ["GitRepository", "Kustomization", "HelmRelease"].includes(
        String(next.kind),
      )
    )
      next.status = {
        observedGeneration: 1,
        conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
        artifact: {
          revision: `main@sha1:${input.spec.platform.reviewed_commit}`,
        },
        lastAppliedRevision: `main@sha1:${input.spec.platform.reviewed_commit}`,
      };
    if (next.kind === "Kustomization")
      object(next.status).inventory = {
        entries: [
          {
            id: "flux-system_cilium-chart_source.toolkit.fluxcd.io_OCIRepository",
            v: "v1",
          },
          {
            id: "flux-system_cilium_helm.toolkit.fluxcd.io_HelmRelease",
            v: "v2",
          },
          { id: "flux-system_pgcf-cilium-values__ConfigMap", v: "v1" },
        ],
      };
    return next;
  };
  const store = (value: Json) => {
    const next = observed(value);
    resources.set(key(next), next);
  };
  for (const name of ["cilium-operator", "coredns"])
    store({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace: "kube-system" },
      spec: { replicas: 1 },
    });
  store({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: "cilium", namespace: "kube-system" },
    spec: {},
    status: {
      observedGeneration: 1,
      desiredNumberScheduled: 1,
      currentNumberScheduled: 1,
      updatedNumberScheduled: 1,
      numberReady: 1,
      numberAvailable: 1,
    },
  });
  store({
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: input.spec.hostname,
      labels: {
        "pgcf.io/node-id": input.spec.node_id,
        "pgcf.io/region": input.spec.region_id,
        "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
      },
    },
    spec: {
      taints: [
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      nodeInfo: { kubeletVersion: "v1.36.5" },
      addresses: [{ type: "InternalIP", address: input.spec.hardware.ipv4 }],
    },
  });
  for (const name of [
    "cilium",
    "openebs",
    "cert-manager",
    "cloudnative-pg",
    "plugin-barman-cloud",
  ])
    store({
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      metadata: { name, namespace: "flux-system", labels: fluxLabels },
      ...(name === "cilium"
        ? {
            spec: {
              releaseName: "cilium",
              targetNamespace: "kube-system",
              storageNamespace: "kube-system",
              chartRef: {
                kind: "OCIRepository",
                name: "cilium-chart",
                namespace: "flux-system",
              },
              valuesFrom: [
                {
                  kind: "ConfigMap",
                  name: "pgcf-cilium-values",
                  valuesKey: "values.yaml",
                },
              ],
            },
          }
        : {}),
    });
  store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  store({
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "OCIRepository",
    metadata: {
      name: "cilium-chart",
      namespace: "flux-system",
      labels: fluxLabels,
    },
    spec: {
      url: "oci://quay.io/cilium/charts/cilium",
      ref: { digest: ociDigest },
      layerSelector: {
        mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
        operation: "copy",
      },
    },
    status: {
      observedGeneration: 1,
      artifact: {
        revision: ociDigest,
        digest:
          "sha256:b2afd87b7f75f875f92a14559f14f59b7babbb479d968e3fd625a20bf30ec20e",
      },
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
    },
  });
  store({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "pgcf-cilium-values",
      namespace: "flux-system",
      labels: fluxLabels,
    },
    data: { "values.yaml": pinnedCiliumValues },
  });
  store({
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: { name: "pgcf-lvm" },
    provisioner: "local.csi.openebs.io",
    parameters: {
      storage: "lvm",
      vgpattern: "^pgcf$",
      thinProvision: "no",
      fsType: "ext4",
    },
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
    reclaimPolicy: "Retain",
  });
  store({
    apiVersion: "storage.k8s.io/v1",
    kind: "CSINode",
    metadata: { name: input.spec.hostname },
    spec: {
      drivers: [{ name: "local.csi.openebs.io", nodeID: input.spec.hostname }],
    },
  });
  const populateRegional = () => {
    store({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "pgcf-regional", namespace: "pgcf-system" },
      data: {
        PGCF_REGION_ID: input.platform.region_id,
        PGCF_API_URL: `https://${input.platform.api_host}`,
      },
    });
    for (const [name, container] of [
      ["pgcf-agent", "agent"],
      ["pgcf-gateway", "gateway"],
      ["pgcf-cloudflared", "cloudflared"],
    ])
      store({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name, namespace: "pgcf-system" },
        spec: {
          replicas: container === "agent" ? 1 : 2,
          template: {
            spec: {
              tolerations: [
                {
                  key: "pgcf.io/quarantine",
                  operator: "Exists",
                  effect: "NoSchedule",
                },
              ],
              containers: [
                {
                  name: container,
                  image:
                    container === "cloudflared"
                      ? "docker.io/cloudflare/cloudflared@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c"
                      : input.spec.platform.regional_image,
                },
              ],
            },
          },
        },
      });
  };
  const installer = new PlatformInstaller(input, assets, {
    priorCommandClosed: () => recovery,
    ciliumJournal: async () => recoveryJournal,
    fluxJournal: async () => fluxRepairJournal,
    claimFluxRepair: async (journal) => {
      fluxRepairJournal = journal;
      if (lostFluxRepairAck)
        throw new BootstrapError("checkpoint_acknowledgement_uncertain");
    },
    claimCiliumRetry: async (journal) => {
      recoveryJournal = journal;
      if (lostRecoveryAck)
        throw new BootstrapError("checkpoint_acknowledgement_uncertain");
    },
    authorize: async () => {
      if (refuse_authority) throw new BootstrapError("job_cancelled");
      return stage;
    },
    checkpoint: async (next) => {
      checkpoints.push(next);
      stage = next;
    },
    helm: async (args) => {
      if (args[0] === "show" && args[1] === "crds")
        return { exit_code: 0, stdout: chartCrds };
      if (args[0] === "template") {
        renderWait();
        return {
          exit_code: 0,
          stdout: rendered,
        };
      }
      if (strictHelm4 && args.includes("--all"))
        throw new BootstrapError("native_command_failed_helm_1");
      if (args.includes("list"))
        return {
          exit_code: 0,
          stdout: JSON.stringify(
            release
              ? [
                  {
                    name: "cilium",
                    status: strictHelm4 ? "pending-install" : "deployed",
                  },
                ]
              : [],
          ),
        };
      if (args.includes("install")) {
        mutations.push(args);
        release = true;
        if (lose_response) throw new Error("lost native response");
        return { exit_code: 0, stdout: "" };
      }
      if (!release) throw new BootstrapError("native_command_failed");
      return {
        exit_code: 0,
        stdout: JSON.stringify(
          args.includes("metadata")
            ? {
                name: "cilium",
                namespace: "kube-system",
                chart: "cilium",
                version:
                  observedHelmVersion ??
                  ([
                    "platform_sync_intent",
                    "platform_ready",
                    "regional_install_intent",
                    "regional_ready",
                  ].includes(stage)
                    ? "1.20.2+a7c12d330dd9"
                    : "1.20.2"),
                appVersion: "1.20.2",
                status: "deployed",
                labels: {
                  "pgcf.io/bootstrap-operation": input.spec.operation_id,
                },
              }
            : assets.values,
        ),
      };
    },
    kube: async (args, _permit_failure, stdin) => {
      const raw = args.find((arg) => arg.startsWith("--raw="));
      if (raw) {
        const url = new URL(raw.slice(6), "https://fixture.invalid"),
          segments = url.pathname.split("/").filter(Boolean);
        if (
          segments[0] === "api" &&
          segments.length === 4 &&
          ["nodes", "namespaces"].includes(segments[2]!)
        ) {
          const kind = segments[2] === "nodes" ? "Node" : "Namespace",
            value = resources.get(`${kind}//${segments[3]}`);
          if (kind === "Namespace" && segments[3] === "flux-system") {
            fluxNamespaceReads++;
            if (
              revokeFluxNamespaceAtDispatch &&
              fluxNamespaceReads === 2 &&
              value
            )
              object(value.metadata).annotations = {};
          }
          return {
            exit_code: value ? 0 : 1,
            stdout: value ? JSON.stringify(value) : "",
          };
        }
        if (
          failInventory &&
          url.searchParams.get("fieldSelector") ===
            "metadata.name=cilium-bootstrap"
        )
          return { exit_code: 1, stdout: "" };
        const plural = segments.at(-1)!,
          kind = kinds[plural]!;
        assert.ok(kind, "known_typed_raw_collection_required");
        const apiVersion =
            segments[0] === "api" ? "v1" : `${segments[1]}/${segments[2]}`,
          nsAt = segments.indexOf("namespaces"),
          namespace =
            nsAt >= 0 && nsAt < segments.length - 1
              ? segments[nsAt + 1]
              : undefined,
          selector = url.searchParams.get("fieldSelector"),
          name = selector?.slice("metadata.name=".length);
        if (changeClusterAfterInventory && plural === "secrets" && !selector)
          store({
            apiVersion: "v1",
            kind: "Namespace",
            metadata: { name: "kube-system" },
          });
        const items = [...resources.values()].filter(
          (value) =>
            value.kind === kind &&
            (namespace === undefined ||
              object(value.metadata).namespace === namespace) &&
            (name === undefined || object(value.metadata).name === name),
        );
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            apiVersion,
            kind: `${kind}List`,
            items,
            ...(partialRawInventory && selector
              ? { metadata: { continue: "unread-page" } }
              : {}),
          }),
        };
      }
      if (failInventory && args.includes("cilium-bootstrap"))
        return { exit_code: 1, stdout: "" };
      if (args.includes("get") && args.includes("secrets,configmaps")) {
        if (changeClusterAfterInventory)
          store({
            apiVersion: "v1",
            kind: "Namespace",
            metadata: { name: "kube-system" },
          });
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            apiVersion: "v1",
            kind: "List",
            items: [...resources.values()].filter(
              (value) =>
                ["Secret", "ConfigMap"].includes(String(value.kind)) &&
                object(value.metadata).namespace === "kube-system",
            ),
          }),
        };
      }
      if (args.includes("apply") || args.includes("create")) {
        mutations.push(args);
        const documents = parseAllDocuments(stdin!);
        for (const document of args.includes("create") && partialFluxCreate
          ? documents.slice(0, 1)
          : documents) {
          const value = object(document.toJSON());
          store(value);
          if (
            value.kind === "Kustomization" &&
            object(value.metadata).name === "pgcf-regional"
          )
            populateRegional();
        }
        if (lose_response || (args.includes("create") && partialFluxCreate))
          throw new Error("lost native response");
        return { exit_code: 0, stdout: "" };
      }
      const kind = kinds[args[args.indexOf("get") + 1]!.split(".")[0]!]!;
      const name = args[args.indexOf("get") + 2]!;
      const namespace = args.includes("--namespace")
        ? args[args.indexOf("--namespace") + 1]
        : "";
      const value = resources.get(`${kind}/${namespace}/${name}`);
      if (kind === "ConfigMap" && name === "pgcf-cilium-values" && value) {
        currentValuesReads++;
        if (replaceCurrentValuesDuringProof && currentValuesReads === 2)
          object(value.metadata).uid = randomUUID();
      }
      return { exit_code: 0, stdout: value ? JSON.stringify(value) : "" };
    },
  });
  return {
    input,
    assets,
    resources,
    mutations,
    checkpoints,
    store,
    populateRegional,
    installer,
    journal: () => recoveryJournal,
    fluxJournal: () => fluxRepairJournal,
    setLostFluxRepairAck: () => {
      lostFluxRepairAck = true;
    },
    setPartialFluxCreate: () => {
      partialFluxCreate = true;
    },
    revokeFluxNamespaceAtDispatch: () => {
      revokeFluxNamespaceAtDispatch = true;
    },
    setLostRecoveryAck: () => {
      lostRecoveryAck = true;
    },
    setRendered: (value: string) => {
      rendered = value;
    },
    setChartCrds: (value: string) => {
      chartCrds = value;
    },
    setInventoryFailure: () => {
      failInventory = true;
    },
    setClusterReplacement: () => {
      changeClusterAfterInventory = true;
    },
    setRenderWait: (run: () => void) => {
      renderWait = run;
    },
    setPartialRawInventory: () => {
      partialRawInventory = true;
    },
    stage: () => stage,
    setLostResponse: () => {
      lose_response = true;
    },
    setCancelled: () => {
      refuse_authority = true;
    },
    replaceCurrentValuesDuringProof: () => {
      replaceCurrentValuesDuringProof = true;
    },
    setHelmVersion: (value: string) => {
      observedHelmVersion = value;
    },
    setRelease: (value: boolean) => {
      release = value;
    },
  };
}

test("new-region installation records each intent and resolves lost native responses from owned resource readback", async () => {
  const state = clusterFixture();
  state.setLostResponse();
  await state.installer.install();
  assert.equal(state.stage(), "regional_ready");
  assert.deepEqual(state.checkpoints, [
    "cilium_install_intent",
    "cilium_installed",
    "flux_install_intent",
    "flux_installed",
    "platform_sync_intent",
    "platform_ready",
    "regional_install_intent",
    "regional_ready",
  ]);
  assert.equal(state.mutations.length, 4);
  assert.ok(
    state.mutations
      .filter((args) => args.includes("apply"))
      .every((args) => args.includes("--filename=-")),
  );
  const before = state.mutations.length;
  await state.installer.install();
  assert.equal(state.mutations.length, before);
  assert.deepEqual(
    object(state.resources.get(`Node//${state.input.spec.hostname}`)!.spec)
      .taints,
    [{ key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" }],
  );
});

test("an existing Cilium release is never overwritten by a first-region bootstrap job", async () => {
  const state = clusterFixture();
  state.setRelease(true);
  await assert.rejects(
    state.installer.install(),
    /cilium_release_already_exists/,
  );
  assert.equal(state.mutations.length, 0);
  assert.equal(state.checkpoints.length, 0);
});

function ciliumHandoffFixture() {
  const state = clusterFixture("platform_sync_intent");
  for (const value of [
    ...state.assets.flux,
    ...platformSyncObjects(state.input),
  ])
    state.store(value);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  const release = state.resources.get("HelmRelease/flux-system/cilium")!;
  object(release.metadata).labels = {
    "kustomize.toolkit.fluxcd.io/name": "pgcf-platform",
    "kustomize.toolkit.fluxcd.io/namespace": "flux-system",
  };
  release.spec = {
    releaseName: "cilium",
    targetNamespace: "kube-system",
    storageNamespace: "kube-system",
    chartRef: {
      kind: "OCIRepository",
      name: "cilium-chart",
      namespace: "flux-system",
    },
    valuesFrom: [
      {
        kind: "ConfigMap",
        name: "pgcf-cilium-values",
        valuesKey: "values.yaml",
      },
    ],
  };
  state.store({
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "OCIRepository",
    metadata: {
      name: "cilium-chart",
      namespace: "flux-system",
      labels: object(release.metadata).labels,
    },
    spec: {
      url: "oci://quay.io/cilium/charts/cilium",
      ref: {
        digest:
          "sha256:a7c12d330dd96bfcda3bf057b24be8f36566c34868265f930f776dff6f42d838",
      },
      layerSelector: {
        mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
        operation: "copy",
      },
    },
    status: {
      observedGeneration: 1,
      artifact: {
        revision:
          "sha256:a7c12d330dd96bfcda3bf057b24be8f36566c34868265f930f776dff6f42d838",
        digest:
          "sha256:b2afd87b7f75f875f92a14559f14f59b7babbb479d968e3fd625a20bf30ec20e",
      },
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
    },
  });
  state.setHelmVersion("1.20.2+a7c12d330dd9");
  return state;
}

const verifyCiliumReadback = (state: ReturnType<typeof clusterFixture>) =>
  (
    state.installer as unknown as { verifyCilium(): Promise<void> }
  ).verifyCilium();

test("reviewed Flux handoff accepts only the exact pinned OCI chart suffix", async () => {
  const state = ciliumHandoffFixture();
  await verifyCiliumReadback(state);
  assert.equal(state.mutations.length, 0);
});

test("a digest suffix before Flux handoff and an unreviewed suffix after it are rejected", async () => {
  const before = clusterFixture("cilium_installed");
  before.setHelmVersion("1.20.2+a7c12d330dd9");
  await assert.rejects(
    verifyCiliumReadback(before),
    /cilium_release_unconfirmed/,
  );
  assert.equal(before.mutations.length, 0);
  const after = ciliumHandoffFixture();
  after.setHelmVersion("1.20.2+000000000000");
  await assert.rejects(
    verifyCiliumReadback(after),
    /cilium_release_unconfirmed/,
  );
  assert.equal(after.mutations.length, 0);
});

test("a changed OCI chart byte digest cannot authorize the Flux version suffix", async () => {
  const state = ciliumHandoffFixture();
  const source = state.resources.get("OCIRepository/flux-system/cilium-chart")!;
  object(object(source.status).artifact).digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    verifyCiliumReadback(state),
    /cilium_release_unconfirmed/,
  );
  assert.equal(state.mutations.length, 0);
});

test("a Ready HelmRelease missing reviewed Flux inventory ownership cannot authorize handoff", async () => {
  const state = ciliumHandoffFixture();
  const kustomization = state.resources.get(
    "Kustomization/flux-system/pgcf-platform",
  )!;
  object(kustomization.status).inventory = { entries: [] };
  await assert.rejects(
    verifyCiliumReadback(state),
    /cilium_release_unconfirmed/,
  );
  assert.equal(state.mutations.length, 0);
});

test("changed current Flux values cannot use last-deployed Helm values to authorize handoff", async () => {
  const state = ciliumHandoffFixture();
  const values = state.resources.get(
    "ConfigMap/flux-system/pgcf-cilium-values",
  )!;
  object(values.data)["values.yaml"] += "\n# altered current source\n";
  await assert.rejects(verifyCiliumReadback(state), /cilium_values_mismatch/);
  assert.equal(state.mutations.length, 0);
});

test("a replacement current Flux values UID during the proof blocks chart handoff", async () => {
  const state = ciliumHandoffFixture();
  state.replaceCurrentValuesDuringProof();
  await assert.rejects(verifyCiliumReadback(state), /cilium_values_mismatch/);
  assert.equal(state.mutations.length, 0);
});

test("Helm 4 preflight includes every release state without its removed all flag", async () => {
  const state = clusterFixture("kubernetes_joined", true);
  state.setRelease(true);
  await assert.rejects(
    state.installer.install(),
    /cilium_release_already_exists/,
  );
  assert.equal(state.mutations.length, 0);
  assert.equal(state.checkpoints.length, 0);
});

test("resuming an uncertain Helm install never sends another install when its release is still missing", async () => {
  const state = clusterFixture("cilium_install_intent");
  state.setRelease(false);
  await assert.rejects(state.installer.install(), /native_command_failed/);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.stage(), "cilium_install_intent");
});

test("a closed first Cilium attempt with complete fresh absence consumes one retry before installing", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  await state.installer.install();
  assert.equal(state.journal()!.attempt, 2);
  assert.equal(state.journal()!.recovery_receipt.resource_count, 1);
  assert.equal(state.journal()!.recovery_receipt.absent_resource_count, 1);
  assert.equal(
    state.mutations.filter((args) => args[0] === "install").length,
    1,
  );
});

test("a committed retry with a lost checkpoint acknowledgement never dispatches or retries Helm", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.setLostRecoveryAck();
  await assert.rejects(
    state.installer.install(),
    /checkpoint_acknowledgement_uncertain/,
  );
  assert.equal(state.journal()!.attempt, 2);
  assert.equal(state.mutations.length, 0);
  await assert.rejects(state.installer.install(), /native_command_failed/);
  assert.equal(state.mutations.length, 0);
});

test("a deployed first Cilium attempt resolves from its owned release without claiming or dispatching recovery", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  await state.installer.install();
  assert.equal(state.journal(), undefined);
  assert.equal(
    state.mutations.filter((args) => args[0] === "install").length,
    0,
  );
  assert.ok(state.checkpoints.includes("cilium_installed"));
});

test("a remaining chart object or failed inventory read keeps Cilium recovery unclaimed", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.store({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "cilium-bootstrap", namespace: "kube-system" },
  });
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_effect_present/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
  state.resources.delete("ConfigMap/kube-system/cilium-bootstrap");
  state.setInventoryFailure();
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_inventory_unknown/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
});

test("rendered hooks and chart CRDs block recovery before any claim or install", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.setRendered(
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cilium-bootstrap\n  annotations:\n    helm.sh/hook: pre-install\n",
  );
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_chart_effects_unknown/,
  );
  state.setChartCrds(
    "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n",
  );
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_chart_effects_unknown/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
});

test("the pinned Cilium secrets Namespace and its resources require complete absence before recovery", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  const rendered =
    "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: cilium-secrets\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cilium-bootstrap\n  namespace: cilium-secrets\n";
  state.setRendered(rendered);
  await state.installer.install();
  assert.equal(state.journal()!.recovery_receipt.resource_count, 2);
  assert.equal(
    state.mutations.filter((args) => args[0] === "install").length,
    1,
  );
  const occupied = clusterFixture("cilium_install_intent", false, true);
  occupied.setRelease(false);
  occupied.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  occupied.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "cilium-secrets" },
  });
  occupied.setRendered(rendered);
  await assert.rejects(
    occupied.installer.install(),
    /cilium_recovery_effect_present/,
  );
  assert.equal(occupied.journal(), undefined);
  assert.equal(occupied.mutations.length, 0);
});

test("slow chart preparation does not age the subsequent physical absence receipt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.setRenderWait(() => t.mock.timers.tick(130_000));
  await state.installer.install();
  const receipt = state.journal()!.recovery_receipt;
  assert.ok(
    Date.parse(receipt.completed_at) - Date.parse(receipt.observed_at) <
      120_000,
  );
});

test("an empty but continued raw collection never establishes complete Cilium absence", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.setPartialRawInventory();
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_inventory_unknown/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
});

test("a replaced cluster UID after the complete inventory blocks the recovery CAS", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.setClusterReplacement();
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_identity_changed/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
});

test("changed node scope or address prevents a Cilium recovery claim", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  const node = state.resources.get(`Node//${state.input.spec.hostname}`)!;
  object(object(node.metadata).labels)["pgcf.io/node-id"] = "foreign";
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_identity_changed/,
  );
  object(object(node.metadata).labels)["pgcf.io/node-id"] =
    state.input.spec.node_id;
  object(node.status).addresses = [
    { type: "InternalIP", address: "192.0.2.199" },
  ];
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_identity_changed/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
});

test("mismatched Helm storage TypeMeta cannot prove zero release effects", async () => {
  const state = clusterFixture("cilium_install_intent", false, true);
  state.setRelease(false);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  state.store({
    apiVersion: "apps/v1",
    kind: "Secret",
    metadata: { name: "unrelated", namespace: "kube-system" },
  });
  await assert.rejects(
    state.installer.install(),
    /cilium_recovery_storage_unknown/,
  );
  assert.equal(state.journal(), undefined);
  assert.equal(state.mutations.length, 0);
});

function partialFluxFixture() {
  const state = clusterFixture("flux_install_intent", false, true);
  const owned = (kind: string, name: string): Json => ({
    apiVersion: kind === "Deployment" ? "apps/v1" : "v1",
    kind,
    metadata: {
      name,
      namespace: "flux-system",
      annotations: { "pgcf.io/bootstrap-input": state.input.input_hash },
    },
    ...(kind === "Deployment"
      ? {
          spec: {
            replicas: 1,
            template: {
              spec: { containers: [{ name: "manager", image: "flux" }] },
            },
          },
        }
      : {}),
  });
  state.assets.flux.push(
    owned("Service", "source-watcher"),
    owned("Service", "webhook-receiver"),
    owned("Deployment", "helm-controller"),
  );
  while (state.assets.flux.length < 43)
    state.assets.flux.push(
      owned("ConfigMap", `fixture-${state.assets.flux.length}`),
    );
  for (const value of state.assets.flux)
    if (
      !["source-watcher", "webhook-receiver", "helm-controller"].includes(
        String(object(value.metadata).name),
      )
    )
      state.store(value);
  state.store({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  return state;
}

test("a complete owned Flux inspection claims one repair and creates only the three absent pinned objects", async () => {
  const state = partialFluxFixture();
  await state.installer.install();
  assert.equal(state.stage(), "regional_ready");
  assert.equal(state.fluxJournal()!.attempt, 1);
  assert.equal(state.fluxJournal()!.receipt.resource_count, 43);
  assert.equal(state.fluxJournal()!.receipt.present_resource_count, 40);
  assert.equal(state.fluxJournal()!.receipt.missing.length, 3);
  assert.equal(
    state.mutations.filter((args) => args.includes("create")).length,
    1,
  );
  assert.equal(
    state.mutations.filter((args) => args.includes("apply")).length,
    2,
  );
  assert.ok(!state.checkpoints.includes("flux_install_intent"));
});

test("a lost Flux repair acknowledgement consumes the intent without dispatching or retrying creation", async () => {
  const state = partialFluxFixture();
  state.setLostFluxRepairAck();
  await assert.rejects(
    state.installer.install(),
    /checkpoint_acknowledgement_uncertain/,
  );
  assert.equal(state.fluxJournal()!.attempt, 1);
  assert.equal(state.mutations.length, 0);
  await assert.rejects(
    state.installer.install(),
    /platform_resource_unconfirmed/,
  );
  assert.equal(state.mutations.length, 0);
});

test("partial uncertain Flux creation is resolved by readback and never created again", async () => {
  const state = partialFluxFixture();
  state.setPartialFluxCreate();
  await assert.rejects(
    state.installer.install(),
    /platform_resource_unconfirmed/,
  );
  assert.equal(state.fluxJournal()!.attempt, 1);
  assert.equal(
    state.mutations.filter((args) => args.includes("create")).length,
    1,
  );
  await assert.rejects(
    state.installer.install(),
    /platform_resource_unconfirmed/,
  );
  assert.equal(
    state.mutations.filter((args) => args.includes("create")).length,
    1,
  );
});

test("unowned present Flux resources and incomplete raw inventory prevent repair consumption", async () => {
  const unowned = partialFluxFixture();
  object(
    unowned.resources.get("ConfigMap/flux-system/fixture-5")!.metadata,
  ).annotations = {};
  await assert.rejects(
    unowned.installer.install(),
    /platform_resource_mismatch/,
  );
  assert.equal(unowned.fluxJournal(), undefined);
  assert.equal(unowned.mutations.length, 0);
  const incomplete = partialFluxFixture();
  incomplete.setPartialRawInventory();
  await assert.rejects(
    incomplete.installer.install(),
    /cilium_recovery_inventory_unknown/,
  );
  assert.equal(incomplete.fluxJournal(), undefined);
  assert.equal(incomplete.mutations.length, 0);
});

test("same-UID Flux Namespace ownership revocation before dispatch blocks repair creation", async () => {
  const state = partialFluxFixture();
  state.revokeFluxNamespaceAtDispatch();
  await assert.rejects(state.installer.install(), /platform_resource_mismatch/);
  assert.equal(state.fluxJournal()!.attempt, 1);
  assert.equal(state.mutations.length, 0);
});

test("replacement of a present Flux object after consumed repair blocks readback authority", async () => {
  const state = partialFluxFixture();
  state.setLostFluxRepairAck();
  await assert.rejects(
    state.installer.install(),
    /checkpoint_acknowledgement_uncertain/,
  );
  const namespace = state.resources.get("Namespace//flux-system")!;
  object(namespace.metadata).uid = randomUUID();
  await assert.rejects(state.installer.install(), /platform_resource_mismatch/);
  assert.equal(state.mutations.length, 0);
});

test("canonical Flux quota readback completes its existing intent without reapplying Flux", async () => {
  const state = clusterFixture("flux_install_intent");
  state.assets.flux.splice(1, 0, {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "critical-pods",
      namespace: "flux-system",
      annotations: { "pgcf.io/bootstrap-input": state.input.input_hash },
    },
    spec: { hard: { pods: "1000" } },
  });
  for (const value of state.assets.flux) state.store(value);
  const quota = state.resources.get("ResourceQuota/flux-system/critical-pods")!;
  object(object(quota.spec).hard).pods = "1k";
  await state.installer.install();
  assert.equal(state.stage(), "regional_ready");
  assert.equal(state.checkpoints[0], "flux_installed");
  assert.ok(!state.checkpoints.includes("flux_install_intent"));
  assert.equal(state.mutations.length, 2);
});

test("partly applied Flux intent refuses missing objects without applying them again", async () => {
  const state = clusterFixture("flux_install_intent");
  state.store(state.assets.flux[0]!);
  await assert.rejects(
    state.installer.install(),
    /platform_resource_unconfirmed/,
  );
  assert.equal(state.mutations.length, 0);
  assert.equal(state.stage(), "flux_install_intent");
});

test("stale release readiness and unregistered LVM storage cannot reach regional installation", async () => {
  const state = clusterFixture("platform_sync_intent");
  for (const value of [
    ...state.assets.flux,
    ...platformSyncObjects(state.input),
  ])
    state.store(value);
  const release = state.resources.get("HelmRelease/flux-system/openebs")!;
  object(release.status).observedGeneration = 0;
  await assert.rejects(state.installer.install(), /platform_flux_not_ready/);
  object(release.status).observedGeneration = 1;
  state.resources.delete(`CSINode//${state.input.spec.hostname}`);
  await assert.rejects(
    state.installer.install(),
    /platform_resource_unconfirmed/,
  );
  assert.equal(state.mutations.length, 0);
  assert.equal(state.stage(), "platform_sync_intent");
});

test("regional image mismatch and stale Deployment status prevent platform completion", async () => {
  const state = clusterFixture("regional_install_intent");
  for (const value of [
    ...state.assets.flux,
    ...platformSyncObjects(state.input),
    ...regionalObjects(state.input),
  ])
    state.store(value);
  state.populateRegional();
  const gateway = state.resources.get("Deployment/pgcf-system/pgcf-gateway")!;
  object(gateway.status).readyReplicas = 1;
  await assert.rejects(
    state.installer.install(),
    /platform_workload_not_ready/,
  );
  object(gateway.status).readyReplicas = 2;
  const containers = object(object(object(gateway.spec).template).spec)
    .containers as Json[];
  containers[0]!.image = "unreviewed";
  await assert.rejects(
    state.installer.install(),
    /regional_deployment_mismatch/,
  );
  assert.equal(state.mutations.length, 0);
  assert.equal(state.stage(), "regional_install_intent");
});

test("cancellation refuses native mutation and missing private first-region input stops before rescue or disk access", async () => {
  const state = clusterFixture();
  state.setCancelled();
  await assert.rejects(state.installer.install(), /job_cancelled/);
  assert.equal(state.mutations.length, 0);
  const input = fixture();
  let current = authority(input);
  let commands = 0;
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint")
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      return Response.json(current);
    },
    run: async () => {
      commands++;
      throw new Error("missing input allowed a native command");
    },
  });
  await assert.rejects(job.start(), /platform_installation_missing/);
  assert.equal(commands, 0);
  assert.equal(current.checkpoint.stage, "created");
  assert.equal(current.checkpoint.status, "waiting");
});
