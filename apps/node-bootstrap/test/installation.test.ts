// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";
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
  let lose_response = false;
  let refuse_authority = false;
  const checkpoints: NodeBootstrapStage[] = [];
  const mutations: string[][] = [];
  const resources = new Map<string, Json>();
  let recoveryJournal:
    | import("@pgcf/contracts/node-bootstrap").NodeCiliumInstallJournal
    | undefined;
  let lostRecoveryAck = false;
  let rendered =
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cilium-bootstrap\n  namespace: kube-system\n";
  let chartCrds = "";
  let failInventory = false;
  let changeClusterAfterInventory = false;
  const assets: PlatformAssets = {
    chart_path: "/verified/cilium.tgz",
    values_path: "/verified/cilium.yaml",
    values: { ipam: { mode: "kubernetes" } },
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
      metadata: { name, namespace: "flux-system" },
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
      if (args[0] === "template")
        return {
          exit_code: 0,
          stdout: rendered,
        };
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
                version: "1.20.2",
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
      if (args.includes("apply")) {
        mutations.push(args);
        for (const document of parseAllDocuments(stdin!)) {
          const value = object(document.toJSON());
          store(value);
          if (
            value.kind === "Kustomization" &&
            object(value.metadata).name === "pgcf-regional"
          )
            populateRegional();
        }
        if (lose_response) throw new Error("lost native response");
        return { exit_code: 0, stdout: "" };
      }
      const kind = kinds[args[args.indexOf("get") + 1]!.split(".")[0]!]!;
      const name = args[args.indexOf("get") + 2]!;
      const namespace = args.includes("--namespace")
        ? args[args.indexOf("--namespace") + 1]
        : "";
      const value = resources.get(`${kind}/${namespace}/${name}`);
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
    stage: () => stage,
    setLostResponse: () => {
      lose_response = true;
    },
    setCancelled: () => {
      refuse_authority = true;
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
  await assert.rejects(state.installer.install(), /platform_readback_invalid/);
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
