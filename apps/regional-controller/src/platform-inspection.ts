// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Observable,
} from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import { inventoryPages } from "./kubernetes.ts";
import type { InventoryBudget } from "./kubernetes.ts";
import type { Resource } from "./types.ts";

type ObjectValue = Record<string, unknown>;
type Status = "ready" | "not_ready" | "unknown";
interface ChartPin {
  name: string;
  chartVersion: string;
  appVersion: string;
  source: string;
  ociManifestDigest?: string;
}
interface Lock {
  target: { talosVersion: string; kubernetesVersion: string };
  charts: ChartPin[];
}
interface Arguments {
  kubeconfig: string;
  context: string;
  lock: string;
  commit: string;
  namespace: string;
  syncName: string;
}

const unverified = [
  "sql",
  "backup_restore",
  "replication",
  "etcd",
  "spare_capacity",
  "image_signatures",
  "tenant_isolation",
  "runtime_images",
  "effective_values",
  "flux_runtime",
  "node_heartbeat_freshness",
];
const versionPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const subdomain = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;

function object(value: unknown): ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function normalizedVersion(value: unknown): string | null {
  return typeof value === "string" && versionPattern.test(value)
    ? value.replace(/^v/, "")
    : null;
}

function argumentsFrom(values: string[]): Arguments {
  const allowed = new Set([
    "--kubeconfig",
    "--context",
    "--versions-lock",
    "--expected-source-commit",
    "--namespace",
    "--sync-name",
  ]);
  const options = new Map<string, string>();
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i];
    const value = values[i + 1];
    if (!key || !allowed.has(key) || !value || options.has(key))
      throw new Error("inspection_arguments_invalid");
    options.set(key, value);
  }
  const result = {
    kubeconfig: options.get("--kubeconfig") ?? "",
    context: options.get("--context") ?? "",
    lock: options.get("--versions-lock") ?? "",
    commit: options.get("--expected-source-commit") ?? "",
    namespace: options.get("--namespace") ?? "flux-system",
    syncName: options.get("--sync-name") ?? "pgcf-platform",
  };
  if (
    !result.kubeconfig ||
    !result.context ||
    !result.lock ||
    !/^[a-f0-9]{40}$/.test(result.commit) ||
    !label.test(result.namespace) ||
    !subdomain.test(result.syncName)
  )
    throw new Error("inspection_arguments_invalid");
  return result;
}

function lockFrom(value: unknown): Lock {
  const input = object(value);
  const target = object(input.target);
  const charts = array(input.charts).map((item) => {
    const chart = object(item);
    if (
      typeof chart.name !== "string" ||
      !label.test(chart.name) ||
      !normalizedVersion(chart.chartVersion) ||
      !normalizedVersion(chart.appVersion) ||
      typeof chart.source !== "string" ||
      !/^(?:https|oci):\/\//.test(chart.source) ||
      (chart.ociManifestDigest !== undefined &&
        (typeof chart.ociManifestDigest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(chart.ociManifestDigest)))
    )
      throw new Error("inspection_lock_invalid");
    return chart as unknown as ChartPin;
  });
  if (
    input.schemaVersion !== 1 ||
    !normalizedVersion(target.talosVersion) ||
    !normalizedVersion(target.kubernetesVersion) ||
    charts.length === 0 ||
    charts.length > 32 ||
    new Set(charts.map((chart) => chart.name)).size !== charts.length
  )
    throw new Error("inspection_lock_invalid");
  return { target: target as unknown as Lock["target"], charts };
}

function fluxStatus(resource: unknown): Status {
  const value = object(resource);
  const metadata = object(value.metadata);
  const spec = object(value.spec);
  const status = object(value.status);
  const conditions = array(status.conditions).map(object);
  if (
    metadata.deletionTimestamp ||
    spec.suspend === true ||
    conditions.some(
      (condition) =>
        ["Stalled", "Reconciling"].includes(String(condition.type)) &&
        condition.status === "True",
    )
  )
    return "not_ready";
  const ready = conditions.find((condition) => condition.type === "Ready");
  if (ready?.status === "False") return "not_ready";
  if (
    (ready?.observedGeneration !== undefined &&
      ready.observedGeneration !== metadata.generation) ||
    (status.observedGeneration !== undefined &&
      status.observedGeneration !== metadata.generation)
  )
    return "not_ready";
  if (
    ready?.status !== "True" ||
    !Number.isSafeInteger(metadata.generation) ||
    Number(metadata.generation) < 1 ||
    status.observedGeneration !== metadata.generation ||
    ready.observedGeneration !== metadata.generation
  )
    return "unknown";
  return "ready";
}

function nodesFrom(nodes: Resource[], lock: Lock) {
  const conditions = (node: Resource) =>
    array(object(node.status).conditions).map(object);
  const ready = nodes.filter(
    (node) =>
      !node.metadata.deletionTimestamp &&
      conditions(node).some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ),
  ).length;
  const pressures = ["MemoryPressure", "DiskPressure", "PIDPressure"];
  const pressureFree =
    nodes.length > 0 &&
    nodes.every((node) =>
      pressures.every((type) =>
        conditions(node).some(
          (condition) =>
            condition.type === type && condition.status === "False",
        ),
      ),
    );
  const versionMatch =
    nodes.length > 0 &&
    nodes.every((node) => {
      const info = object(object(node.status).nodeInfo);
      const talos =
        typeof info.osImage === "string"
          ? /^Talos \((v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)$/.exec(
              info.osImage,
            )?.[1]
          : null;
      return (
        normalizedVersion(talos) ===
          normalizedVersion(lock.target.talosVersion) &&
        normalizedVersion(info.kubeletVersion) ===
          normalizedVersion(lock.target.kubernetesVersion)
      );
    });
  const unknown =
    nodes.length === 0 ||
    nodes.some((node) =>
      ["Ready", ...pressures].some((type) => {
        const condition = conditions(node).find((item) => item.type === type);
        return (
          !condition || !["True", "False"].includes(String(condition.status))
        );
      }),
    );
  const status: Status = unknown
    ? "unknown"
    : ready === nodes.length && pressureFree && versionMatch
      ? "ready"
      : "not_ready";
  return { status, total: nodes.length, ready, versionMatch, pressureFree };
}

function chartVersionMatches(value: unknown, pin: ChartPin): boolean {
  if (typeof value !== "string") return false;
  const base = normalizedVersion(pin.chartVersion);
  const actual = value.replace(/^v/, "");
  return (
    actual === base ||
    (pin.ociManifestDigest !== undefined &&
      actual === `${base}+${pin.ociManifestDigest.slice(7, 19)}`)
  );
}

function releaseFrom(
  pin: ChartPin,
  releases: Resource[],
  oci: Resource[],
  repositories: Resource[],
  namespace: string,
) {
  const release = releases.find((item) => item.metadata.name === pin.name);
  const value = object(release);
  const spec = object(value.spec);
  const history = object(array(object(value.status).history)[0]);
  const deployed = history.status === "deployed";
  const chartMatches =
    deployed && chartVersionMatches(history.chartVersion, pin);
  const appMatches =
    deployed &&
    normalizedVersion(history.appVersion) === normalizedVersion(pin.appVersion);
  let sourcePinMatches = false;
  if (pin.ociManifestDigest) {
    const ref = object(spec.chartRef);
    const source = oci.find((item) => item.metadata.name === ref.name);
    const sourceSpec = object(object(source).spec);
    const artifact = object(object(object(source).status).artifact);
    sourcePinMatches =
      ref.kind === "OCIRepository" &&
      (ref.namespace === undefined || ref.namespace === namespace) &&
      fluxStatus(source) === "ready" &&
      sourceSpec.url === pin.source &&
      object(sourceSpec.ref).digest === pin.ociManifestDigest &&
      object(value.status).lastAttemptedRevisionDigest ===
        pin.ociManifestDigest &&
      typeof artifact.revision === "string" &&
      (artifact.revision === pin.ociManifestDigest ||
        artifact.revision.endsWith(`@${pin.ociManifestDigest}`));
  } else {
    const chart = object(object(spec.chart).spec);
    const ref = object(chart.sourceRef);
    const source = repositories.find((item) => item.metadata.name === ref.name);
    sourcePinMatches =
      ref.kind === "HelmRepository" &&
      (ref.namespace === undefined || ref.namespace === namespace) &&
      chart.chart === pin.name &&
      normalizedVersion(chart.version) ===
        normalizedVersion(pin.chartVersion) &&
      fluxStatus(source) === "ready" &&
      object(object(source).spec).url === pin.source;
  }
  const observed = fluxStatus(release);
  const status: Status | "suspended" =
    spec.suspend === true
      ? "suspended"
      : observed === "ready" &&
          !(chartMatches && appMatches && sourcePinMatches)
        ? "not_ready"
        : observed;
  return { name: pin.name, status, chartMatches, appMatches, sourcePinMatches };
}

async function inspect(options: Arguments, lock: Lock) {
  const config = new KubeConfig();
  config.loadFromFile(options.kubeconfig);
  if (!config.getContexts().some((item) => item.name === options.context))
    throw new Error("inspection_context_invalid");
  config.setCurrentContext(options.context);
  const core = config.makeApiClient(CoreV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const budget: InventoryBudget = {
    remainingRequests: 32,
    remainingResources: 4096,
    deadline: Date.now() + 30_000,
  };
  const requestOptions: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(context) {
          context.setSignal(
            AbortSignal.timeout(
              Math.max(1, Math.min(20_000, budget.deadline - Date.now())),
            ),
          );
          return new Observable(Promise.resolve(context));
        },
        post(context) {
          return new Observable(Promise.resolve(context));
        },
      },
    ],
  };
  const list = (group: string, version: string, plural: string, kind: string) =>
    inventoryPages(
      (_continue) =>
        custom.listNamespacedCustomObject(
          {
            group,
            version,
            plural,
            namespace: options.namespace,
            limit: 100,
            _continue,
          },
          requestOptions,
        ),
      kind,
      `${group}/${version}`,
      budget,
    );
  const named = async (group: string, plural: string) => {
    if (budget.remainingRequests <= 0 || Date.now() >= budget.deadline)
      throw new Error("inspection_observation_bound_exceeded");
    budget.remainingRequests -= 1;
    return object(
      await custom.getNamespacedCustomObject(
        {
          group,
          version: "v1",
          plural,
          namespace: options.namespace,
          name: options.syncName,
        },
        requestOptions,
      ),
    );
  };
  const [nodes, releases, oci, repositories, source, reconciliation] =
    await Promise.all([
      inventoryPages(
        (_continue) => core.listNode({ limit: 100, _continue }, requestOptions),
        "Node",
        "v1",
        budget,
      ),
      list("helm.toolkit.fluxcd.io", "v2", "helmreleases", "HelmRelease"),
      list(
        "source.toolkit.fluxcd.io",
        "v1",
        "ocirepositories",
        "OCIRepository",
      ),
      list(
        "source.toolkit.fluxcd.io",
        "v1",
        "helmrepositories",
        "HelmRepository",
      ),
      named("source.toolkit.fluxcd.io", "gitrepositories"),
      named("kustomize.toolkit.fluxcd.io", "kustomizations"),
    ]);
  const sourceRevision = object(object(source.status).artifact).revision;
  const commitMatches =
    object(object(source.spec).ref).commit === options.commit &&
    typeof sourceRevision === "string" &&
    (sourceRevision === `sha1:${options.commit}` ||
      sourceRevision.endsWith(`@sha1:${options.commit}`));
  const sourceStatus = fluxStatus(source);
  const ref = object(object(reconciliation.spec).sourceRef);
  const appliedMatches =
    commitMatches &&
    sourceStatus === "ready" &&
    ref.kind === "GitRepository" &&
    ref.name === options.syncName &&
    (ref.namespace === undefined || ref.namespace === options.namespace) &&
    object(reconciliation.status).lastAppliedRevision === sourceRevision;
  const reconciliationStatus = fluxStatus(reconciliation);
  const checks = {
    nodes: nodesFrom(nodes, lock),
    releases: lock.charts.map((pin) =>
      releaseFrom(pin, releases, oci, repositories, options.namespace),
    ),
    source: {
      status:
        sourceStatus === "ready" && !commitMatches ? "not_ready" : sourceStatus,
      commitMatches,
    },
    reconciliation: {
      status:
        reconciliationStatus === "ready" && !appliedMatches
          ? "not_ready"
          : reconciliationStatus,
      commitMatches: appliedMatches,
    },
  };
  const ready =
    checks.nodes.status === "ready" &&
    checks.releases.every((item) => item.status === "ready") &&
    checks.source.status === "ready" &&
    checks.reconciliation.status === "ready";
  return { ready, checks };
}

export async function runPlatformInspection(values: string[]): Promise<number> {
  const base = {
    schemaVersion: 1,
    mode: "platform-inspection",
    scope: "platform_components",
    observedAt: new Date().toISOString(),
    unverified,
  };
  try {
    const options = argumentsFrom(values);
    const lock = lockFrom(JSON.parse(await readFile(options.lock, "utf8")));
    const result = await inspect(options, lock);
    process.stdout.write(`${JSON.stringify({ ...base, ...result })}\n`);
    return result.ready ? 0 : 1;
  } catch {
    // Authentication, API and configuration errors can contain private data.
    process.stdout.write(
      `${JSON.stringify({ ...base, ready: false, error: { code: "platform_observation_failed" } })}\n`,
    );
    return 2;
  }
}
