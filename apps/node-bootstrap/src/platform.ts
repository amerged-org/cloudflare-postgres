// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
import type {
  NodeBootstrapInput,
  NodeBootstrapStage,
} from "@pgcf/contracts/node-bootstrap";
import {
  NodeCiliumInstallJournal,
  NodeFluxRepairJournal,
} from "@pgcf/contracts/node-bootstrap";
import {
  BootstrapError,
  canonical,
  digest,
  KUBERNETES_VERSION,
} from "./bootstrap.ts";
import { PLATFORM_ARTIFACTS } from "./platform-artifacts.ts";
import { parseQuantityBytes } from "../../../infra/talos/publish-storage-capacity.ts";

type Json = Record<string, unknown>;
const RESOURCES: Record<string, string> = {
  Namespace: "namespaces",
  ResourceQuota: "resourcequotas",
  CustomResourceDefinition: "customresourcedefinitions.apiextensions.k8s.io",
  ServiceAccount: "serviceaccounts",
  ClusterRole: "clusterroles.rbac.authorization.k8s.io",
  ClusterRoleBinding: "clusterrolebindings.rbac.authorization.k8s.io",
  Role: "roles.rbac.authorization.k8s.io",
  RoleBinding: "rolebindings.rbac.authorization.k8s.io",
  PodDisruptionBudget: "poddisruptionbudgets.policy",
  Service: "services",
  Deployment: "deployments.apps",
  NetworkPolicy: "networkpolicies.networking.k8s.io",
  Secret: "secrets",
  Pod: "pods",
  Endpoints: "endpoints",
  ConfigMap: "configmaps",
  GitRepository: "gitrepositories.source.toolkit.fluxcd.io",
  OCIRepository: "ocirepositories.source.toolkit.fluxcd.io",
  Kustomization: "kustomizations.kustomize.toolkit.fluxcd.io",
};
const QUARANTINE = {
  key: "pgcf.io/quarantine",
  operator: "Equal",
  value: "bootstrap",
  effect: "NoSchedule",
};
const RELEASES = [
  "cilium",
  "openebs",
  "cert-manager",
  "cloudnative-pg",
  "plugin-barman-cloud",
];
const CILIUM_RESOURCE_VERSIONS: Record<string, string> = {
  Namespace: "v1",
  ConfigMap: "v1",
  Secret: "v1",
  ServiceAccount: "v1",
  Service: "v1",
  Pod: "v1",
  Endpoints: "v1",
  DaemonSet: "apps/v1",
  Deployment: "apps/v1",
  ClusterRole: "rbac.authorization.k8s.io/v1",
  ClusterRoleBinding: "rbac.authorization.k8s.io/v1",
  Role: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
  PodDisruptionBudget: "policy/v1",
};
const STAGES: NodeBootstrapStage[] = [
  "kubernetes_joined",
  "cilium_install_intent",
  "cilium_installed",
  "flux_install_intent",
  "flux_installed",
  "platform_sync_intent",
  "platform_ready",
  "regional_install_intent",
  "regional_ready",
];

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BootstrapError("platform_readback_invalid");
  return value as Json;
}
function list(value: unknown): Json[] {
  if (!Array.isArray(value))
    throw new BootstrapError("platform_readback_invalid");
  return value.map(record);
}
function owned(value: Json, input: NodeBootstrapInput): Json {
  const metadata = record(value.metadata);
  return {
    ...value,
    metadata: {
      ...metadata,
      annotations: {
        ...(metadata.annotations ? record(metadata.annotations) : {}),
        "pgcf.io/bootstrap-input": input.input_hash,
      },
    },
  };
}
function manifestObject(
  kind: string,
  name: string,
  namespace: string,
  body: Json,
  input: NodeBootstrapInput,
): Json {
  const apiVersion =
    kind === "GitRepository"
      ? "source.toolkit.fluxcd.io/v1"
      : kind === "Kustomization"
        ? "kustomize.toolkit.fluxcd.io/v1"
        : "v1";
  return owned(
    { apiVersion, kind, metadata: { name, namespace }, ...body },
    input,
  );
}

export function renderFluxObjects(
  text: string,
  input: NodeBootstrapInput,
): Json[] {
  const documents = parseAllDocuments(text);
  if (!documents.length || documents.some((document) => document.errors.length))
    throw new BootstrapError("platform_manifest_invalid");
  return documents.map((document) => {
    const value = record(document.toJSON());
    const metadata = record(value.metadata);
    if (
      typeof value.kind !== "string" ||
      !RESOURCES[value.kind] ||
      typeof metadata.name !== "string" ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(metadata.name)
    )
      throw new BootstrapError("platform_manifest_invalid");
    if (value.kind === "Deployment") {
      const spec = record(record(record(value.spec).template).spec);
      const tolerations =
        spec.tolerations === undefined ? [] : list(spec.tolerations);
      if (
        tolerations.some(
          (item) =>
            item.key === QUARANTINE.key &&
            canonical(item) !== canonical(QUARANTINE),
        )
      )
        throw new BootstrapError("flux_toleration_mismatch");
      if (!tolerations.some((item) => item.key === QUARANTINE.key))
        spec.tolerations = [...tolerations, QUARANTINE];
    }
    return owned(value, input);
  });
}

export function platformSyncObjects(input: NodeBootstrapInput): Json[] {
  if (!input.spec.platform)
    throw new BootstrapError("platform_installation_missing");
  return [
    manifestObject(
      "GitRepository",
      "pgcf-platform",
      "flux-system",
      {
        spec: {
          interval: "30m",
          url: "https://github.com/amerged-org/cloudflare-postgres",
          ref: { commit: input.spec.platform.reviewed_commit },
        },
      },
      input,
    ),
    manifestObject(
      "Kustomization",
      "pgcf-platform",
      "flux-system",
      {
        spec: {
          interval: "30m",
          retryInterval: "2m",
          timeout: "30m",
          path: "./infra/platform",
          prune: true,
          sourceRef: { kind: "GitRepository", name: "pgcf-platform" },
          healthChecks: RELEASES.map((name) => ({
            apiVersion: "helm.toolkit.fluxcd.io/v2",
            kind: "HelmRelease",
            name,
            namespace: "flux-system",
          })),
        },
      },
      input,
    ),
  ];
}

export function regionalObjects(input: NodeBootstrapInput): Json[] {
  const spec = input.spec.platform,
    configuration = input.platform;
  if (!spec || !configuration)
    throw new BootstrapError("platform_installation_missing");
  const [image, imageDigest] = spec.regional_image.split("@");
  const secret = (name: string, values: Record<string, string>) =>
    manifestObject(
      "Secret",
      name,
      "pgcf-system",
      {
        type: "Opaque",
        data: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            Buffer.from(value).toString("base64"),
          ]),
        ),
      },
      input,
    );
  return [
    secret("pgcf-agent", { PGCF_AGENT_KEY: configuration.agent_key }),
    secret("pgcf-gateway", { PGCF_ROUTE_KEY: configuration.route_keyring }),
    secret("pgcf-cloudflared", { token: configuration.tunnel_token }),
    secret("pgcf-backup-s3", {
      AWS_ACCESS_KEY_ID: configuration.backup_s3.access_key_id,
      AWS_SECRET_ACCESS_KEY: configuration.backup_s3.secret_access_key,
    }),
    manifestObject(
      "ConfigMap",
      "pgcf-regional-vars",
      "flux-system",
      {
        data: {
          PGCF_REGION_ID: configuration.region_id,
          PGCF_API_HOST: configuration.api_host,
        },
      },
      input,
    ),
    manifestObject(
      "Kustomization",
      "pgcf-regional",
      "flux-system",
      {
        spec: {
          interval: "30m",
          retryInterval: "2m",
          timeout: "10m",
          path: "./infra/platform/regional",
          prune: true,
          wait: true,
          sourceRef: { kind: "GitRepository", name: "pgcf-platform" },
          dependsOn: [{ name: "pgcf-platform" }],
          postBuild: {
            substituteFrom: [{ kind: "ConfigMap", name: "pgcf-regional-vars" }],
          },
          images: [
            {
              name: "ghcr.io/amerged-org/pgcf-regional",
              newName: image,
              digest: imageDigest,
            },
          ],
        },
      },
      input,
    ),
  ];
}

function contains(
  expected: unknown,
  actual: unknown,
  path = "",
  quantityKind?: "ResourceQuota" | "Deployment",
): boolean {
  if (
    (quantityKind === "ResourceQuota" && path === "spec.hard.pods") ||
    (quantityKind === "Deployment" &&
      /^spec\.template\.spec\.containers\[\d+\]\.resources\.limits\.cpu$/.test(
        path,
      ))
  ) {
    if (quantityKind === "Deployment" && expected === actual) return true;
    try {
      return parseQuantityBytes(expected) === parseQuantityBytes(actual);
    } catch {
      return false;
    }
  }
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) =>
        contains(item, actual[index], `${path}[${index}]`, quantityKind),
      )
    );
  if (expected && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) =>
        contains(
          value,
          (actual as Json)[key],
          path ? `${path}.${key}` : key,
          quantityKind,
        ),
      )
    );
  return expected === actual;
}
export function assertOwnedResource(expected: Json, actual: Json) {
  if (
    !contains(
      expected,
      actual,
      "",
      expected.apiVersion === "v1" && expected.kind === "ResourceQuota"
        ? "ResourceQuota"
        : expected.apiVersion === "apps/v1" && expected.kind === "Deployment"
          ? "Deployment"
          : undefined,
    ) ||
    record(actual.metadata).deletionTimestamp ||
    typeof record(actual.metadata).uid !== "string" ||
    !record(actual.metadata).uid
  )
    throw new BootstrapError("platform_resource_mismatch");
}
export function assertWorkloadReady(
  kind: "Deployment" | "DaemonSet",
  value: Json,
) {
  const metadata = record(value.metadata),
    status = record(value.status);
  if (
    !Number.isInteger(metadata.generation) ||
    Number(metadata.generation) < 1 ||
    status.observedGeneration !== metadata.generation
  )
    throw new BootstrapError("platform_workload_not_ready");
  if (kind === "Deployment") {
    const replicas = record(value.spec).replicas;
    if (
      !Number.isInteger(replicas) ||
      Number(replicas) < 1 ||
      [
        status.replicas,
        status.updatedReplicas,
        status.readyReplicas,
        status.availableReplicas,
      ].some((observed) => observed !== replicas)
    )
      throw new BootstrapError("platform_workload_not_ready");
  } else {
    const desired = status.desiredNumberScheduled;
    if (
      !Number.isInteger(desired) ||
      Number(desired) < 1 ||
      [
        status.currentNumberScheduled,
        status.updatedNumberScheduled,
        status.numberReady,
        status.numberAvailable,
      ].some((observed) => observed !== desired) ||
      Number(status.numberMisscheduled ?? 0) !== 0
    )
      throw new BootstrapError("platform_workload_not_ready");
  }
}
function assertFluxReady(value: Json) {
  const metadata = record(value.metadata),
    status = record(value.status);
  const conditions = list(status.conditions);
  if (
    !Number.isInteger(metadata.generation) ||
    Number(metadata.generation) < 1 ||
    status.observedGeneration !== metadata.generation ||
    !conditions.some(
      (condition) =>
        condition.type === "Ready" &&
        condition.status === "True" &&
        condition.observedGeneration === metadata.generation,
    ) ||
    conditions.some(
      (condition) =>
        ["Stalled", "Reconciling"].includes(String(condition.type)) &&
        condition.status === "True",
    )
  )
    throw new BootstrapError("platform_flux_not_ready");
}

export interface PlatformAssets {
  chart_path: string;
  values_path: string;
  values: Json;
  flux: Json[];
}
export async function readPlatformAssets(
  directory: string,
  input: NodeBootstrapInput,
): Promise<PlatformAssets> {
  const chart_path = join(directory, "cilium-1.20.2.tgz"),
    values_path = join(directory, "cilium-values.yaml");
  const [chart, values, flux] = await Promise.all([
    readFile(chart_path),
    readFile(values_path),
    readFile(join(directory, "flux-install.yaml")),
  ]);
  if (
    digest(chart) !== PLATFORM_ARTIFACTS.cilium.sha256 ||
    digest(values) !== PLATFORM_ARTIFACTS.cilium_values.sha256 ||
    digest(flux) !== PLATFORM_ARTIFACTS.flux.sha256
  )
    throw new BootstrapError("platform_artifact_checksum_mismatch");
  return {
    chart_path,
    values_path,
    values: record(parse(values.toString("utf8"))),
    flux: renderFluxObjects(flux.toString("utf8"), input),
  };
}
export interface PlatformCommands {
  kube(
    args: string[],
    permit_failure?: boolean,
    stdin?: string,
  ): Promise<{ exit_code: number; stdout: string }>;
  helm(
    args: string[],
    permit_failure?: boolean,
  ): Promise<{ exit_code: number; stdout: string }>;
  authorize(): Promise<NodeBootstrapStage>;
  checkpoint(stage: NodeBootstrapStage): Promise<void>;
  priorCommandClosed?(): boolean;
  ciliumJournal?(): Promise<NodeCiliumInstallJournal | undefined>;
  claimCiliumRetry?(journal: NodeCiliumInstallJournal): Promise<void>;
  fluxJournal?(): Promise<NodeFluxRepairJournal | undefined>;
  claimFluxRepair?(journal: NodeFluxRepairJournal): Promise<void>;
}

export class PlatformInstaller {
  readonly input: NodeBootstrapInput;
  readonly assets: PlatformAssets;
  readonly commands: PlatformCommands;
  constructor(
    input: NodeBootstrapInput,
    assets: PlatformAssets,
    commands: PlatformCommands,
  ) {
    this.input = input;
    this.assets = assets;
    this.commands = commands;
  }
  private async read(
    kind: string,
    name: string,
    namespace?: string,
  ): Promise<Json | null> {
    const resource =
      RESOURCES[kind] ??
      (kind === "HelmRelease"
        ? "helmreleases.helm.toolkit.fluxcd.io"
        : kind === "DaemonSet"
          ? "daemonsets.apps"
          : kind === "Node"
            ? "nodes"
            : kind === "CSINode"
              ? "csinodes.storage.k8s.io"
              : kind === "StorageClass"
                ? "storageclasses.storage.k8s.io"
                : null);
    if (
      !resource ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(name) ||
      (namespace && !/^[a-z0-9][a-z0-9-]*$/.test(namespace))
    )
      throw new BootstrapError("platform_resource_invalid");
    const result = await this.commands.kube([
      ...(namespace ? ["--namespace", namespace] : []),
      "get",
      resource,
      name,
      "--ignore-not-found",
      "--output=json",
    ]);
    if (result.exit_code !== 0)
      throw new BootstrapError("platform_readback_invalid");
    return result.stdout.trim() ? record(JSON.parse(result.stdout)) : null;
  }
  private async required(
    kind: string,
    name: string,
    namespace?: string,
  ): Promise<Json> {
    const value = await this.read(kind, name, namespace);
    if (!value) throw new BootstrapError("platform_resource_unconfirmed");
    const metadata = record(value.metadata);
    if (
      value.kind !== kind ||
      metadata.name !== name ||
      metadata.deletionTimestamp ||
      (namespace && metadata.namespace !== namespace) ||
      typeof metadata.uid !== "string" ||
      !metadata.uid
    )
      throw new BootstrapError("platform_resource_mismatch");
    return value;
  }
  private async absent(objects: Json[]) {
    for (const value of objects) {
      const metadata = record(value.metadata);
      if (
        await this.read(
          String(value.kind),
          String(metadata.name),
          metadata.namespace === undefined
            ? undefined
            : String(metadata.namespace),
        )
      )
        throw new BootstrapError("platform_resource_already_exists");
    }
  }
  private async readObjects(objects: Json[]) {
    for (const expected of objects) {
      const metadata = record(expected.metadata);
      const actual = await this.required(
        String(expected.kind),
        String(metadata.name),
        metadata.namespace === undefined
          ? undefined
          : String(metadata.namespace),
      );
      assertOwnedResource(expected, actual);
      if (actual.kind === "Deployment")
        assertWorkloadReady("Deployment", actual);
    }
  }
  private async apply(objects: Json[]) {
    try {
      await this.commands.kube(
        [
          "apply",
          "--server-side",
          "--field-manager=pgcf-node-bootstrap",
          "--filename=-",
        ],
        false,
        objects.map((value) => stringify(value)).join("---\n"),
      );
    } catch {
      // The checkpointed command is never replayed; exact authenticated readback resolves it.
    }
    await this.readObjects(objects);
  }
  private async phase(
    intent: NodeBootstrapStage,
    complete: NodeBootstrapStage,
    objects: Json[],
    verify?: () => Promise<void>,
  ) {
    const stage = await this.commands.authorize();
    if (STAGES.indexOf(stage) < STAGES.indexOf(intent)) {
      await this.absent(objects);
      await this.commands.checkpoint(intent);
      await this.commands.authorize();
      await this.apply(objects);
    } else if (
      stage === "flux_install_intent" &&
      intent === "flux_install_intent" &&
      this.commands.fluxJournal &&
      this.commands.claimFluxRepair &&
      this.commands.priorCommandClosed?.() === true
    )
      await this.repairFlux();
    else await this.readObjects(objects);
    if (verify) await verify();
    if (STAGES.indexOf(stage) < STAGES.indexOf(complete))
      await this.commands.checkpoint(complete);
  }
  private async verifyCilium() {
    const metadata = record(
      JSON.parse(
        (
          await this.commands.helm([
            "get",
            "metadata",
            "cilium",
            "--namespace",
            "kube-system",
            "--output=json",
          ])
        ).stdout,
      ),
    );
    const stage = await this.commands.authorize();
    const handoff =
      STAGES.indexOf(stage) >= STAGES.indexOf("platform_sync_intent");
    const version = handoff
      ? `${PLATFORM_ARTIFACTS.cilium.version}+${PLATFORM_ARTIFACTS.cilium.oci_digest.slice("sha256:".length, "sha256:".length + 12)}`
      : PLATFORM_ARTIFACTS.cilium.version;
    if (
      metadata.name !== "cilium" ||
      metadata.namespace !== "kube-system" ||
      metadata.chart !== "cilium" ||
      metadata.version !== version ||
      metadata.appVersion !== PLATFORM_ARTIFACTS.cilium.version ||
      metadata.status !== "deployed" ||
      record(metadata.labels)["pgcf.io/bootstrap-operation"] !==
        this.input.spec.operation_id
    )
      throw new BootstrapError("cilium_release_unconfirmed");
    if (handoff) await this.verifyCiliumFluxHandoff();
    const values = JSON.parse(
      (
        await this.commands.helm([
          "get",
          "values",
          "cilium",
          "--namespace",
          "kube-system",
          "--output=json",
        ])
      ).stdout,
    );
    if (canonical(values) !== canonical(this.assets.values))
      throw new BootstrapError("cilium_values_mismatch");
    assertWorkloadReady(
      "DaemonSet",
      await this.required("DaemonSet", "cilium", "kube-system"),
    );
    assertWorkloadReady(
      "Deployment",
      await this.required("Deployment", "cilium-operator", "kube-system"),
    );
    assertWorkloadReady(
      "Deployment",
      await this.required("Deployment", "coredns", "kube-system"),
    );
    const node = await this.required("Node", this.input.spec.hostname);
    if (
      !list(record(node.status).conditions).some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ) ||
      !list(record(node.spec).taints).some(
        (taint) =>
          taint.key === QUARANTINE.key &&
          taint.value === QUARANTINE.value &&
          taint.effect === QUARANTINE.effect,
      )
    )
      throw new BootstrapError("platform_node_not_ready");
  }
  private async verifyCiliumFluxHandoff() {
    const before = await this.ciliumRecoveryIdentity();
    const cilium = await this.commands.ciliumJournal?.();
    if (
      cilium &&
      (cilium.recovery_receipt.node_uid !== before.node_uid ||
        cilium.recovery_receipt.kube_system_uid !== before.kube_system_uid)
    )
      throw new BootstrapError("cilium_release_unconfirmed");
    const namespaceExpected = this.assets.flux.find(
      (value) =>
        value.kind === "Namespace" &&
        record(value.metadata).name === "flux-system",
    );
    if (!namespaceExpected)
      throw new BootstrapError("cilium_release_unconfirmed");
    const namespaceBefore = await this.required("Namespace", "flux-system");
    assertOwnedResource(namespaceExpected, namespaceBefore);
    const sync = platformSyncObjects(this.input);
    const repository = await this.required(
        "GitRepository",
        "pgcf-platform",
        "flux-system",
      ),
      kustomization = await this.required(
        "Kustomization",
        "pgcf-platform",
        "flux-system",
      ),
      source = await this.required(
        "OCIRepository",
        "cilium-chart",
        "flux-system",
      ),
      release = await this.required("HelmRelease", "cilium", "flux-system");
    const valuesBefore = await this.required(
      "ConfigMap",
      "pgcf-cilium-values",
      "flux-system",
    );
    const pinnedValues = (value: Json) => {
      const labels = record(record(value.metadata).labels ?? {}),
        data = record(value.data ?? {}),
        text = data["values.yaml"];
      if (
        labels["kustomize.toolkit.fluxcd.io/name"] !== "pgcf-platform" ||
        labels["kustomize.toolkit.fluxcd.io/namespace"] !== "flux-system"
      )
        throw new BootstrapError("cilium_release_unconfirmed");
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > 256 * 1024 ||
        digest(text) !== PLATFORM_ARTIFACTS.cilium_values.sha256 ||
        canonical(parse(text)) !== canonical(this.assets.values)
      )
        throw new BootstrapError("cilium_values_mismatch");
      return { uid: record(value.metadata).uid, values_sha256: digest(text) };
    };
    const valuesIdentity = pinnedValues(valuesBefore);
    assertOwnedResource(
      sync.find((value) => value.kind === "GitRepository")!,
      repository,
    );
    assertOwnedResource(
      sync.find((value) => value.kind === "Kustomization")!,
      kustomization,
    );
    for (const value of [repository, kustomization, source, release])
      assertFluxReady(value);
    const revision = record(record(repository.status).artifact).revision;
    if (
      typeof revision !== "string" ||
      !revision.endsWith(`sha1:${this.input.spec.platform!.reviewed_commit}`) ||
      record(kustomization.status).lastAppliedRevision !== revision
    )
      throw new BootstrapError("platform_source_revision_mismatch");
    const entries = list(
      record(record(kustomization.status).inventory).entries,
    );
    for (const [id, version] of [
      ["flux-system_cilium-chart_source.toolkit.fluxcd.io_OCIRepository", "v1"],
      ["flux-system_cilium_helm.toolkit.fluxcd.io_HelmRelease", "v2"],
      ["flux-system_pgcf-cilium-values__ConfigMap", "v1"],
    ])
      if (
        entries.filter((entry) => entry.id === id && entry.v === version)
          .length !== 1
      )
        throw new BootstrapError("cilium_release_unconfirmed");
    for (const value of [source, release]) {
      const labels = record(record(value.metadata).labels ?? {});
      if (
        labels["kustomize.toolkit.fluxcd.io/name"] !== "pgcf-platform" ||
        labels["kustomize.toolkit.fluxcd.io/namespace"] !== "flux-system"
      )
        throw new BootstrapError("cilium_release_unconfirmed");
    }
    if (
      !contains(
        {
          apiVersion: "source.toolkit.fluxcd.io/v1",
          spec: {
            url: "oci://quay.io/cilium/charts/cilium",
            ref: { digest: PLATFORM_ARTIFACTS.cilium.oci_digest },
            layerSelector: {
              mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
              operation: "copy",
            },
          },
        },
        source,
      ) ||
      record(record(source.status).artifact).revision !==
        PLATFORM_ARTIFACTS.cilium.oci_digest ||
      record(record(source.status).artifact).digest !==
        `sha256:${PLATFORM_ARTIFACTS.cilium.sha256}`
    )
      throw new BootstrapError("cilium_release_unconfirmed");
    if (
      !contains(
        {
          apiVersion: "helm.toolkit.fluxcd.io/v2",
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
        },
        release,
      )
    )
      throw new BootstrapError("cilium_release_unconfirmed");
    const valuesAfter = await this.required(
      "ConfigMap",
      "pgcf-cilium-values",
      "flux-system",
    );
    if (canonical(pinnedValues(valuesAfter)) !== canonical(valuesIdentity))
      throw new BootstrapError("cilium_values_mismatch");
    const namespaceAfter = await this.required("Namespace", "flux-system");
    assertOwnedResource(namespaceExpected, namespaceAfter);
    const after = await this.ciliumRecoveryIdentity();
    if (
      canonical(after) !== canonical(before) ||
      record(namespaceAfter.metadata).uid !==
        record(namespaceBefore.metadata).uid
    )
      throw new BootstrapError("cilium_release_unconfirmed");
  }
  private async installCilium() {
    const stage = await this.commands.authorize();
    let recovery =
      stage === "cilium_install_intent" &&
      (await this.commands.ciliumJournal?.()) === undefined &&
      this.commands.priorCommandClosed?.() === true;
    if (recovery) {
      const existing = await this.commands.helm([
        "list",
        "--namespace",
        "kube-system",
        "--filter=^cilium$",
        "--output=json",
      ]);
      const releases = JSON.parse(existing.stdout);
      if (
        existing.exit_code !== 0 ||
        !Array.isArray(releases) ||
        releases.length > 1
      )
        throw new BootstrapError("cilium_recovery_storage_unknown");
      if (releases.length) recovery = false;
    }
    if (recovery) {
      const crds = await this.commands.helm([
        "show",
        "crds",
        this.assets.chart_path,
      ]);
      if (crds.exit_code !== 0 || crds.stdout.trim())
        throw new BootstrapError("cilium_recovery_chart_effects_unknown");
      const rendered = await this.commands.helm([
        "template",
        "cilium",
        this.assets.chart_path,
        "--namespace",
        "kube-system",
        "--values",
        this.assets.values_path,
        "--include-crds",
        "--dry-run=server",
      ]);
      if (
        rendered.exit_code !== 0 ||
        Buffer.byteLength(rendered.stdout) > 1024 * 1024
      )
        throw new BootstrapError("cilium_recovery_inventory_unknown");
      const documents = parseAllDocuments(rendered.stdout).filter(
        (document) => document.toJSON() !== null,
      );
      const declaredNamespaces = new Set(
        documents.flatMap((document) => {
          const value = record(document.toJSON());
          return value.kind === "Namespace"
            ? [String(record(value.metadata).name)]
            : [];
        }),
      );
      const objects = documents.map((document) => {
        if (document.errors.length)
          throw new BootstrapError("cilium_recovery_inventory_unknown");
        const value = record(document.toJSON()),
          metadata = record(value.metadata);
        if (
          typeof value.apiVersion !== "string" ||
          typeof value.kind !== "string" ||
          CILIUM_RESOURCE_VERSIONS[value.kind] !== value.apiVersion ||
          value.kind === "CustomResourceDefinition" ||
          (value.kind === "Namespace" && metadata.name !== "cilium-secrets") ||
          record(metadata.annotations ?? {})["helm.sh/hook"] !== undefined ||
          typeof metadata.name !== "string"
        )
          throw new BootstrapError("cilium_recovery_chart_effects_unknown");
        const namespace = [
          "Namespace",
          "ClusterRole",
          "ClusterRoleBinding",
        ].includes(value.kind)
          ? undefined
          : String(metadata.namespace ?? "kube-system");
        if (
          namespace !== undefined &&
          namespace !== "kube-system" &&
          !declaredNamespaces.has(namespace)
        )
          throw new BootstrapError("cilium_recovery_inventory_unknown");
        return {
          apiVersion: value.apiVersion,
          kind: value.kind,
          name: metadata.name,
          ...(namespace === undefined ? {} : { namespace }),
        };
      });
      const inventory = objects.sort((a, b) =>
        canonical(a).localeCompare(canonical(b)),
      );
      if (
        !inventory.length ||
        inventory.length > 128 ||
        new Set(inventory.map(canonical)).size !== inventory.length
      )
        throw new BootstrapError("cilium_recovery_inventory_unknown");
      const observed_at = new Date().toISOString();
      const before = await this.ciliumRecoveryIdentity();
      for (let offset = 0; offset < inventory.length; offset += 4) {
        const results = await Promise.allSettled(
          inventory
            .slice(offset, offset + 4)
            .map(async (value) =>
              (
                await this.ciliumCollection(
                  value.kind,
                  value.namespace,
                  value.name,
                )
              ).length
                ? {}
                : null,
            ),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (
          results.some(
            (result) => result.status === "fulfilled" && result.value !== null,
          )
        )
          throw new BootstrapError("cilium_recovery_effect_present");
      }
      const stores = await Promise.allSettled([
        this.ciliumCollection("Secret", "kube-system"),
        this.ciliumCollection("ConfigMap", "kube-system"),
      ]);
      const unknown = stores.find((store) => store.status === "rejected");
      if (unknown?.status === "rejected") throw unknown.reason;
      const stored = stores.flatMap((store) =>
        store.status === "fulfilled" ? store.value : [],
      );
      for (const value of stored) {
        const metadata = record(value.metadata),
          labels = record(metadata.labels ?? {});
        if (
          value.apiVersion !== "v1" ||
          !["Secret", "ConfigMap"].includes(String(value.kind)) ||
          metadata.namespace !== "kube-system" ||
          typeof metadata.name !== "string"
        )
          throw new BootstrapError("cilium_recovery_storage_unknown");
        if (
          metadata.name.startsWith("sh.helm.release.v1.cilium.") ||
          labels.name === "cilium" ||
          labels.NAME === "cilium"
        )
          throw new BootstrapError("cilium_recovery_release_present");
      }
      await this.commands.authorize();
      const after = await this.ciliumRecoveryIdentity();
      if (
        canonical(after) !== canonical(before) ||
        this.commands.priorCommandClosed?.() !== true ||
        !this.commands.claimCiliumRetry
      )
        throw new BootstrapError("cilium_recovery_identity_changed");
      await this.commands.claimCiliumRetry(
        NodeCiliumInstallJournal.parse({
          attempt: 2,
          state: "intent",
          recovery_receipt: {
            version: 1,
            operation_id: this.input.spec.operation_id,
            node_id: this.input.spec.node_id,
            region_id: this.input.spec.region_id,
            input_hash: this.input.input_hash,
            ...before,
            chart_sha256: PLATFORM_ARTIFACTS.cilium.sha256,
            values_sha256: PLATFORM_ARTIFACTS.cilium_values.sha256,
            effective_values_sha256: digest(canonical(this.assets.values)),
            inventory_sha256: digest(canonical(inventory)),
            resource_count: inventory.length,
            absent_resource_count: inventory.length,
            release_storage_count: 0,
            prior_command_closed: true,
            observed_at,
            completed_at: new Date().toISOString(),
          },
        }),
      );
    }
    if (
      STAGES.indexOf(stage) < STAGES.indexOf("cilium_install_intent") ||
      recovery
    ) {
      if (!recovery) {
        const existing = JSON.parse(
          (
            await this.commands.helm([
              "list",
              "--namespace",
              "kube-system",
              "--filter=^cilium$",
              "--output=json",
            ])
          ).stdout,
        );
        if (!Array.isArray(existing) || existing.length)
          throw new BootstrapError("cilium_release_already_exists");
        await this.commands.checkpoint("cilium_install_intent");
      }
      await this.commands.authorize();
      try {
        await this.commands.helm([
          "install",
          "cilium",
          this.assets.chart_path,
          "--namespace",
          "kube-system",
          "--values",
          this.assets.values_path,
          "--labels",
          `pgcf.io/bootstrap-operation=${this.input.spec.operation_id}`,
          "--timeout=8m",
          "--wait=watcher",
        ]);
      } catch {
        // An uncertain Helm install is resolved from the release and workloads, never reinstalled.
      }
    }
    await this.verifyCilium();
    if (STAGES.indexOf(stage) < STAGES.indexOf("cilium_installed"))
      await this.commands.checkpoint("cilium_installed");
  }
  private async ciliumRecoveryIdentity() {
    await this.commands.authorize();
    const system = await this.ciliumCoreIdentity("Namespace", "kube-system"),
      node = await this.ciliumCoreIdentity("Node", this.input.spec.hostname);
    const labels = record(record(node.metadata).labels ?? {}),
      status = record(node.status);
    if (
      labels["pgcf.io/node-id"] !== this.input.spec.node_id ||
      labels["pgcf.io/region"] !== this.input.spec.region_id ||
      labels["pgcf.io/provider-instance-id"] !==
        this.input.spec.provider_instance_id ||
      record(status.nodeInfo).kubeletVersion !== `v${KUBERNETES_VERSION}` ||
      !list(status.addresses).some(
        (address) =>
          address.type === "InternalIP" &&
          address.address === this.input.spec.hardware.ipv4,
      )
    )
      throw new BootstrapError("cilium_recovery_identity_changed");
    if (
      !list(record(node.spec).taints).some(
        (taint) =>
          taint.key === QUARANTINE.key &&
          taint.value === QUARANTINE.value &&
          taint.effect === QUARANTINE.effect,
      )
    )
      throw new BootstrapError("cilium_recovery_identity_changed");
    return {
      kube_system_uid: String(record(system.metadata).uid),
      node_uid: String(record(node.metadata).uid),
      node_name: this.input.spec.hostname,
    };
  }
  private async ciliumCollection(
    kind: string,
    namespace?: string,
    name?: string,
    apiVersion = CILIUM_RESOURCE_VERSIONS[kind],
  ): Promise<Json[]> {
    const resource = (
      RESOURCES[kind] ?? (kind === "DaemonSet" ? "daemonsets" : "")
    ).split(".")[0];
    if (
      !apiVersion ||
      !resource ||
      (namespace && !/^[a-z0-9][a-z0-9-]*$/.test(namespace)) ||
      (name && !/^[a-z0-9][a-z0-9.-]*$/.test(name))
    )
      throw new BootstrapError("cilium_recovery_inventory_unknown");
    const prefix = apiVersion === "v1" ? "/api/v1" : `/apis/${apiVersion}`,
      path = `${prefix}${namespace ? `/namespaces/${namespace}` : ""}/${resource}${name ? `?fieldSelector=${encodeURIComponent(`metadata.name=${name}`)}` : ""}`;
    const result = await this.commands.kube(["get", `--raw=${path}`]);
    if (
      result.exit_code !== 0 ||
      Buffer.byteLength(result.stdout) > 1024 * 1024
    )
      throw new BootstrapError("cilium_recovery_inventory_unknown");
    const value = record(JSON.parse(result.stdout)),
      metadata = record(value.metadata ?? {});
    if (
      value.apiVersion !== apiVersion ||
      value.kind !== `${kind}List` ||
      (metadata.continue !== undefined && metadata.continue !== "") ||
      (metadata.remainingItemCount !== undefined &&
        metadata.remainingItemCount !== 0)
    )
      throw new BootstrapError("cilium_recovery_inventory_unknown");
    return list(value.items).map((item) => {
      const typed =
        item.apiVersion === undefined && item.kind === undefined
          ? { ...item, apiVersion, kind }
          : item;
      if (typed.apiVersion !== apiVersion || typed.kind !== kind)
        throw new BootstrapError("cilium_recovery_storage_unknown");
      return typed;
    });
  }
  private async ciliumCoreIdentity(kind: "Namespace" | "Node", name: string) {
    const result = await this.commands.kube([
      "get",
      `--raw=/api/v1/${kind === "Node" ? "nodes" : "namespaces"}/${name}`,
    ]);
    if (
      result.exit_code !== 0 ||
      Buffer.byteLength(result.stdout) > 1024 * 1024
    )
      throw new BootstrapError("cilium_recovery_identity_changed");
    const value = record(JSON.parse(result.stdout)),
      metadata = record(value.metadata);
    if (
      value.apiVersion !== "v1" ||
      value.kind !== kind ||
      metadata.name !== name ||
      typeof metadata.uid !== "string" ||
      !metadata.uid ||
      metadata.deletionTimestamp
    )
      throw new BootstrapError("cilium_recovery_identity_changed");
    return value;
  }
  private async inspectFlux() {
    const present: { expected: Json; actual: Json }[] = [],
      missing: Json[] = [];
    for (let offset = 0; offset < this.assets.flux.length; offset += 4) {
      const results = await Promise.allSettled(
        this.assets.flux.slice(offset, offset + 4).map(async (expected) => {
          const metadata = record(expected.metadata);
          const found = await this.ciliumCollection(
            String(expected.kind),
            metadata.namespace as string | undefined,
            String(metadata.name),
            String(expected.apiVersion),
          );
          if (found.length > 1)
            throw new BootstrapError("platform_resource_mismatch");
          if (!found.length) return { expected, actual: null };
          const actual = found[0]!,
            observed = record(actual.metadata);
          if (
            observed.name !== metadata.name ||
            observed.namespace !== metadata.namespace
          )
            throw new BootstrapError("platform_resource_mismatch");
          assertOwnedResource(expected, actual);
          return { expected, actual };
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const result of results)
        if (result.status === "fulfilled") {
          if (result.value.actual)
            present.push({
              expected: result.value.expected,
              actual: result.value.actual,
            });
          else missing.push(result.value.expected);
        }
    }
    return { present, missing };
  }
  private async repairFlux() {
    if (this.assets.flux.length !== 43)
      throw new BootstrapError("platform_resource_unconfirmed");
    const inventory = this.assets.flux
      .map((value) => {
        const metadata = record(value.metadata),
          kind = String(value.kind),
          apiVersion = String(value.apiVersion);
        const versions: Record<string, string> = {
          ...CILIUM_RESOURCE_VERSIONS,
          ResourceQuota: "v1",
          CustomResourceDefinition: "apiextensions.k8s.io/v1",
        };
        if (
          versions[kind] !== apiVersion ||
          !/^[a-z0-9][a-z0-9.-]*$/.test(String(metadata.name)) ||
          (metadata.namespace !== undefined &&
            metadata.namespace !== "flux-system")
        )
          throw new BootstrapError("platform_resource_invalid");
        return {
          kind,
          name: String(metadata.name),
          ...(metadata.namespace === undefined
            ? {}
            : { namespace: String(metadata.namespace) }),
          spec_sha256: digest(canonical(value)),
        };
      })
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (
      new Set(
        inventory.map(
          (value) => `${value.kind}/${value.namespace ?? ""}/${value.name}`,
        ),
      ).size !== 43
    )
      throw new BootstrapError("platform_resource_invalid");
    const inventory_sha256 = digest(canonical(inventory));
    const journal = await this.commands.fluxJournal!();
    const observed_at = new Date().toISOString(),
      before = await this.ciliumRecoveryIdentity();
    const cilium = await this.commands.ciliumJournal?.();
    if (
      cilium &&
      (cilium.recovery_receipt.node_uid !== before.node_uid ||
        cilium.recovery_receipt.kube_system_uid !== before.kube_system_uid)
    )
      throw new BootstrapError("platform_resource_mismatch");
    if (
      journal &&
      (journal.receipt.input_hash !== this.input.input_hash ||
        journal.receipt.operation_id !== this.input.spec.operation_id ||
        journal.receipt.node_id !== this.input.spec.node_id ||
        journal.receipt.region_id !== this.input.spec.region_id ||
        journal.receipt.inventory_sha256 !== inventory_sha256 ||
        journal.receipt.node_uid !== before.node_uid ||
        journal.receipt.kube_system_uid !== before.kube_system_uid ||
        journal.receipt.node_name !== before.node_name ||
        journal.receipt.manifest_sha256 !== PLATFORM_ARTIFACTS.flux.sha256)
    )
      throw new BootstrapError("platform_resource_mismatch");
    const presentSetDigest = (
      present: { expected: Json; actual: Json }[],
      excluded: NodeFluxRepairJournal["receipt"]["missing"],
    ) =>
      digest(
        canonical(
          present
            .filter(
              ({ expected }) =>
                !excluded.some(
                  (value) =>
                    value.kind === expected.kind &&
                    value.name === record(expected.metadata).name &&
                    value.namespace === record(expected.metadata).namespace,
                ),
            )
            .map(({ expected, actual }) => ({
              spec_sha256: digest(canonical(expected)),
              uid: record(actual.metadata).uid,
            }))
            .sort((a, b) => canonical(a).localeCompare(canonical(b))),
        ),
      );
    let observed = await this.inspectFlux();
    if (
      journal &&
      presentSetDigest(observed.present, journal.receipt.missing) !==
        journal.receipt.present_set_sha256
    )
      throw new BootstrapError("platform_resource_mismatch");
    const namespace = observed.present.find(
      ({ expected }) =>
        expected.kind === "Namespace" &&
        record(expected.metadata).name === "flux-system",
    );
    if (!namespace) throw new BootstrapError("platform_resource_unconfirmed");
    const namespaceUid = record(namespace.actual.metadata).uid;
    const currentNamespace = await this.ciliumCoreIdentity(
      "Namespace",
      "flux-system",
    );
    const after = await this.ciliumRecoveryIdentity();
    assertOwnedResource(namespace.expected, currentNamespace);
    if (
      canonical(after) !== canonical(before) ||
      record(currentNamespace.metadata).uid !== namespaceUid ||
      this.commands.priorCommandClosed?.() !== true
    )
      throw new BootstrapError("platform_resource_mismatch");
    if (observed.missing.length) {
      if (journal || observed.missing.length > 3)
        throw new BootstrapError("platform_resource_unconfirmed");
      const missing = observed.missing.map((value) => {
        const metadata = record(value.metadata);
        return {
          kind: value.kind,
          name: metadata.name,
          namespace: metadata.namespace,
          spec_sha256: digest(canonical(value)),
        };
      });
      const repair = NodeFluxRepairJournal.parse({
        attempt: 1,
        state: "intent",
        receipt: {
          version: 1,
          operation_id: this.input.spec.operation_id,
          node_id: this.input.spec.node_id,
          region_id: this.input.spec.region_id,
          input_hash: this.input.input_hash,
          ...before,
          manifest_sha256: PLATFORM_ARTIFACTS.flux.sha256,
          inventory_sha256,
          resource_count: 43,
          present_resource_count: observed.present.length,
          missing,
          present_set_sha256: presentSetDigest(observed.present, []),
          prior_command_closed: true,
          observed_at,
          completed_at: new Date().toISOString(),
        },
      });
      await this.commands.claimFluxRepair!(repair);
      const persisted = await this.commands.fluxJournal!();
      if (canonical(persisted) !== canonical(repair))
        throw new BootstrapError("checkpoint_not_committed");
      await this.commands.authorize();
      const dispatchIdentity = await this.ciliumRecoveryIdentity(),
        dispatchNamespace = await this.ciliumCoreIdentity(
          "Namespace",
          "flux-system",
        );
      assertOwnedResource(namespace.expected, dispatchNamespace);
      if (
        canonical(dispatchIdentity) !== canonical(before) ||
        record(dispatchNamespace.metadata).uid !== namespaceUid ||
        this.commands.priorCommandClosed?.() !== true
      )
        throw new BootstrapError("platform_resource_mismatch");
      try {
        await this.commands.kube(
          ["create", "--validate=false", "--filename=-"],
          true,
          observed.missing.map((value) => stringify(value)).join("---\n"),
        );
      } catch {
        // The persisted repair intent is consumed; only owned readback can resolve this outcome.
      }
      observed = await this.inspectFlux();
      if (observed.missing.length)
        throw new BootstrapError("platform_resource_unconfirmed");
      if (
        presentSetDigest(observed.present, repair.receipt.missing) !==
        repair.receipt.present_set_sha256
      )
        throw new BootstrapError("platform_resource_mismatch");
      const completedIdentity = await this.ciliumRecoveryIdentity(),
        completedNamespace = await this.ciliumCoreIdentity(
          "Namespace",
          "flux-system",
        );
      assertOwnedResource(namespace.expected, completedNamespace);
      if (
        canonical(completedIdentity) !== canonical(before) ||
        record(completedNamespace.metadata).uid !== namespaceUid
      )
        throw new BootstrapError("platform_resource_mismatch");
    }
    for (const { actual } of observed.present)
      if (actual.kind === "Deployment")
        assertWorkloadReady("Deployment", actual);
  }
  private async verifyPlatform() {
    const repository = await this.required(
      "GitRepository",
      "pgcf-platform",
      "flux-system",
    );
    assertFluxReady(repository);
    const revision = record(record(repository.status).artifact).revision;
    if (
      typeof revision !== "string" ||
      !revision.endsWith(`sha1:${this.input.spec.platform!.reviewed_commit}`)
    )
      throw new BootstrapError("platform_source_revision_mismatch");
    const kustomization = await this.required(
      "Kustomization",
      "pgcf-platform",
      "flux-system",
    );
    assertFluxReady(kustomization);
    if (record(kustomization.status).lastAppliedRevision !== revision)
      throw new BootstrapError("platform_source_revision_mismatch");
    for (const name of RELEASES)
      assertFluxReady(await this.required("HelmRelease", name, "flux-system"));
    const storage = await this.required("StorageClass", "pgcf-lvm");
    if (
      storage.provisioner !== "local.csi.openebs.io" ||
      record(storage.parameters).storage !== "lvm" ||
      record(storage.parameters).vgpattern !== "^pgcf$" ||
      record(storage.parameters).thinProvision !== "no" ||
      record(storage.parameters).fsType !== "ext4" ||
      storage.volumeBindingMode !== "WaitForFirstConsumer" ||
      storage.allowVolumeExpansion !== true ||
      storage.reclaimPolicy !== "Retain"
    )
      throw new BootstrapError("platform_storage_mismatch");
    const csi = await this.required("CSINode", this.input.spec.hostname);
    if (
      list(record(csi.spec).drivers).filter(
        (driver) =>
          driver.name === "local.csi.openebs.io" &&
          driver.nodeID === this.input.spec.hostname,
      ).length !== 1
    )
      throw new BootstrapError("platform_storage_driver_unconfirmed");
  }
  private async verifyRegional() {
    const kustomization = await this.required(
      "Kustomization",
      "pgcf-regional",
      "flux-system",
    );
    assertFluxReady(kustomization);
    const repository = await this.required(
      "GitRepository",
      "pgcf-platform",
      "flux-system",
    );
    if (
      record(kustomization.status).lastAppliedRevision !==
      record(record(repository.status).artifact).revision
    )
      throw new BootstrapError("platform_source_revision_mismatch");
    const configuration = this.input.platform!;
    const configMap = await this.required(
      "ConfigMap",
      "pgcf-regional",
      "pgcf-system",
    );
    if (
      record(configMap.data).PGCF_REGION_ID !== configuration.region_id ||
      record(configMap.data).PGCF_API_URL !==
        `https://${configuration.api_host}`
    )
      throw new BootstrapError("regional_configuration_mismatch");
    for (const [name, container] of [
      ["pgcf-agent", "agent"],
      ["pgcf-gateway", "gateway"],
      ["pgcf-cloudflared", "cloudflared"],
    ]) {
      const deployment = await this.required(
        "Deployment",
        name!,
        "pgcf-system",
      );
      assertWorkloadReady("Deployment", deployment);
      const spec = record(record(record(deployment.spec).template).spec);
      const containers = list(spec.containers);
      const image = containers.find((item) => item.name === container)?.image;
      if (
        !list(spec.tolerations).some(
          (toleration) =>
            toleration.key === QUARANTINE.key &&
            toleration.effect === QUARANTINE.effect &&
            (toleration.operator === "Exists" ||
              (toleration.operator === "Equal" &&
                toleration.value === QUARANTINE.value)),
        ) ||
        image !==
          (container === "cloudflared"
            ? PLATFORM_ARTIFACTS.cloudflared.image
            : this.input.spec.platform!.regional_image) ||
        record(deployment.spec).replicas !== (container === "agent" ? 1 : 2)
      )
        throw new BootstrapError("regional_deployment_mismatch");
    }
  }
  async install() {
    if (this.input.spec.role !== "controlplane") return;
    if (!this.input.spec.platform || !this.input.platform)
      throw new BootstrapError("platform_installation_missing");
    if (!STAGES.includes(await this.commands.authorize()))
      throw new BootstrapError("platform_checkpoint_invalid");
    await this.installCilium();
    await this.phase("flux_install_intent", "flux_installed", this.assets.flux);
    await this.phase(
      "platform_sync_intent",
      "platform_ready",
      platformSyncObjects(this.input),
      () => this.verifyPlatform(),
    );
    await this.phase(
      "regional_install_intent",
      "regional_ready",
      regionalObjects(this.input),
      () => this.verifyRegional(),
    );
    await this.verifyCilium();
    await this.verifyPlatform();
    await this.verifyRegional();
  }
}
