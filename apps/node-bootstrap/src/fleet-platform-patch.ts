// SPDX-License-Identifier: Apache-2.0
import {
  selectedOpenEbsDriverImage,
  openEbsDriverValues,
  openEbsCgroupPostRenderers,
  openEbsCgroupReadback,
} from "../../../infra/platform/openebs-image.ts";
import { BootstrapError } from "./bootstrap.ts";
import { patchObject as object } from "./fleet-patch-observations.ts";
import { patchObjects as objects } from "./fleet-patch-observations.ts";
import { parseAllDocuments } from "yaml";
import { canonical, digest } from "./bootstrap.ts";
import {
  assertWorkloadReady,
  assertOwnedResource,
  selectFluxObjects,
} from "./platform.ts";
import { inspectionResponseBody } from "./inspection-proxy-command.ts";
import type { LegacyStorageBinding } from "@pgcf/contracts/storage-write-authority";
import type { FleetPatchInput } from "@pgcf/contracts/fleet-patches";
import {
  fleetChartObservation,
  fleetFluxReady,
  type FleetReleaseFacts,
  type FleetReleaseComponent,
} from "@pgcf/contracts/releases";

export interface FleetPlatformCommands {
  kube(args: string[], stdin?: string): Promise<string>;
  authorize(): Promise<void>;
}
export interface FleetPlatformAssets {
  lock: Record<string, unknown>;
  flux: Record<string, unknown>[];
  flux_deprecated: Record<string, unknown>[];
  relay: Record<string, unknown>;
}
const repository = "https://github.com/amerged-org/cloudflare-postgres";
const resourceKey = (value: Record<string, unknown>) => {
  const metadata = object(value.metadata);
  return `${value.kind}/${metadata.namespace ?? ""}/${metadata.name}`;
};
function imageRepository(reference: string) {
  const raw = reference.split("@")[0]!,
    colon = raw.lastIndexOf(":"),
    slash = raw.lastIndexOf("/");
  return colon > slash ? raw.slice(0, colon) : raw;
}
function imageDigest(value: unknown): string | undefined {
  return typeof value === "string"
    ? /(?:@sha256:|^sha256:|^[a-z][a-z0-9+.-]*:\/\/sha256:)([0-9a-f]{64})$/.exec(
        value,
      )?.[1]
    : undefined;
}
function component(input: FleetPatchInput, name: string) {
  const value = input.spec.components.find(
    (v) => v.name === name && v.kind === "image",
  );
  if (!value) throw new BootstrapError("patch_component_pin_missing");
  return value;
}
export async function readFleetPlatformAssets(
  input: FleetPatchInput,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<FleetPlatformAssets> {
  const commit = input.spec.platform_source_commit;
  if (!commit) throw new BootstrapError("patch_platform_source_missing");
  const read = async (
    url: string,
    maximum: number,
    redirect: "error" | "follow" = "error",
  ) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      response = await request(url, { signal: bounded, redirect });
    if (!response.ok) {
      void response.body?.cancel();
      throw new BootstrapError("patch_platform_artifact_unavailable");
    }
    return inspectionResponseBody(response, maximum, bounded);
  };
  const prefix = `https://raw.githubusercontent.com/amerged-org/cloudflare-postgres/${commit}/`;
  const lockText = await read(
    prefix + "infra/platform/versions.lock.json",
    1024 * 1024,
  );
  if (digest(lockText) !== input.spec.versions_lock_sha256)
    throw new BootstrapError("patch_platform_lock_mismatch");
  const lock = object(JSON.parse(lockText)),
    target = object(lock.target),
    flux = object(lock.flux),
    role = input.spec.roles[input.role];
  if (
    String(target.talosVersion).replace(/^v/, "") !==
      role.talos_version.replace(/^v/, "") ||
    String(target.kubernetesVersion).replace(/^v/, "") !==
      role.kubernetes_version.replace(/^v/, "")
  )
    throw new BootstrapError("patch_platform_target_mismatch");
  const url = String(flux.installManifestURL);
  if (
    !/^https:\/\/github\.com\/fluxcd\/flux2\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/install\.yaml$/.test(
      url,
    )
  )
    throw new BootstrapError("patch_flux_artifact_invalid");
  const text = await read(url, 1024 * 1024, "follow");
  if (digest(text) !== flux.installManifestSha256)
    throw new BootstrapError("patch_flux_artifact_mismatch");
  const docs = parseAllDocuments(text);
  if (docs.some((v) => v.errors.length))
    throw new BootstrapError("patch_flux_artifact_invalid");
  const vendorFluxObjects = docs.map((v) => object(v.toJSON()));
  const fluxObjects = selectFluxObjects(
      vendorFluxObjects,
      Array.isArray(flux.components) ? flux.components.map(String) : undefined,
    ),
    names: Record<string, string> = {
      "source-controller": "flux-source",
      "kustomize-controller": "flux-kustomize",
      "helm-controller": "flux-helm",
      "notification-controller": "flux-notification",
    };
  for (const value of fluxObjects)
    if (value.kind === "Deployment") {
      const name = names[String(object(value.metadata).name)];
      if (!name) throw new BootstrapError("patch_flux_component_unknown");
      const containers = objects(
          object(object(object(value.spec).template).spec).containers,
        ),
        pin = component(input, name);
      if (
        containers.length !== 1 ||
        imageRepository(String(containers[0]!.image)) !==
          imageRepository(pin.reference)
      )
        throw new BootstrapError("patch_flux_component_mismatch");
      containers[0]!.image = pin.reference;
    }
  const relayText = await read(
      prefix + "infra/platform/bootstrap-relay/relay.yaml",
      128 * 1024,
    ),
    relayDocs = parseAllDocuments(relayText);
  if (relayDocs.some((v) => v.errors.length) || relayDocs.length !== 1)
    throw new BootstrapError("patch_relay_artifact_invalid");
  const relay = object(relayDocs[0]!.toJSON());
  if (
    relay.kind !== "Deployment" ||
    object(relay.metadata).name !== "pgcf-bootstrap-relay"
  )
    throw new BootstrapError("patch_relay_artifact_invalid");
  return {
    lock,
    flux: fluxObjects,
    flux_deprecated: vendorFluxObjects.filter(
      (value) => value.kind === "Deployment" && !fluxObjects.includes(value),
    ),
    relay,
  };
}
export interface FleetPlatformState {
  resources: Map<string, Record<string, unknown>>;
  pods: Record<string, unknown>[];
  uids: Record<string, string>;
}
/** All reads are also callable from the direct acceptance runner; this does not acquire grants or mutate. */
export async function readFleetPlatformState(
  commands: Pick<FleetPlatformCommands, "kube">,
): Promise<FleetPlatformState> {
  const reads = await Promise.allSettled([
    commands.kube([
      "get",
      "deployments.apps,daemonsets.apps",
      "--all-namespaces",
      "-o",
      "json",
    ]),
    commands.kube([
      "get",
      "gitrepositories.source.toolkit.fluxcd.io,kustomizations.kustomize.toolkit.fluxcd.io,helmreleases.helm.toolkit.fluxcd.io,ocirepositories.source.toolkit.fluxcd.io,helmcharts.source.toolkit.fluxcd.io",
      "--all-namespaces",
      "-o",
      "json",
    ]),
    commands.kube(["get", "pods", "--all-namespaces", "-o", "json"]),
  ]);
  const failed = reads.find((v) => v.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const data = reads.map((v) =>
      object(JSON.parse((v as PromiseFulfilledResult<string>).value)),
    ),
    resources = new Map<string, Record<string, unknown>>(),
    uids: Record<string, string> = {};
  for (const value of [
    ...objects(data[0]!.items),
    ...objects(data[1]!.items),
  ]) {
    const metadata = object(value.metadata),
      key = resourceKey(value);
    if (typeof metadata.uid !== "string" || metadata.deletionTimestamp)
      throw new BootstrapError("patch_platform_identity_invalid");
    if (resources.has(key))
      throw new BootstrapError("patch_platform_identity_ambiguous");
    resources.set(key, value);
    uids[key] = metadata.uid;
  }
  return { resources, pods: objects(data[2]!.items), uids };
}
function required(
  state: FleetPlatformState,
  kind: string,
  name: string,
  namespace = "flux-system",
) {
  const value = state.resources.get(`${kind}/${namespace}/${name}`);
  if (!value) throw new BootstrapError("patch_platform_resource_missing");
  return value;
}
function pinnedPods(
  state: FleetPlatformState,
  pin: FleetReleaseComponent,
  input: FleetPatchInput,
): boolean {
  const ownership = pin.workload;
  if (ownership) {
    const workloads = [...state.resources.values()].filter(
      (value) =>
        ["Deployment", "DaemonSet"].includes(String(value.kind)) &&
        object(value.metadata).namespace === ownership.namespace &&
        Object.entries(ownership.selector).every(
          ([key, wanted]) =>
            object(object(value.spec).selector).matchLabels &&
            object(object(object(value.spec).selector).matchLabels)[key] ===
              wanted,
        ),
    );
    if (!workloads.length) return false;
    try {
      for (const workload of workloads)
        assertWorkloadReady(
          workload.kind as "Deployment" | "DaemonSet",
          workload,
        );
    } catch {
      return false;
    }
  }
  const candidates = state.pods.filter((pod) => {
    const metadata = object(pod.metadata),
      spec = object(pod.spec);
    return (
      !metadata.deletionTimestamp &&
      (ownership === undefined ||
        (metadata.namespace === ownership.namespace &&
          Object.entries(ownership.selector).every(
            ([key, value]) => object(metadata.labels)[key] === value,
          ) &&
          true)) &&
      (ownership?.scope === "cluster" ||
        spec.nodeName === input.k8s_node_name) &&
      objects(spec.containers).some(
        (v) =>
          imageRepository(String(v.image)) === imageRepository(pin.reference),
      )
    );
  });
  if (!candidates.length) return false;
  return candidates.every((pod) => {
    const metadata = object(pod.metadata),
      statuses = objects(object(pod.status).containerStatuses),
      owners = objects(metadata.ownerReferences);
    if (
      !metadata.uid ||
      owners.filter((v) => v.controller === true).length !== 1
    )
      return false;
    return objects(object(pod.spec).containers)
      .filter(
        (v) =>
          imageRepository(String(v.image)) === imageRepository(pin.reference),
      )
      .every((container) => {
        const status = statuses.find((v) => v.name === container.name);
        return (
          status?.ready === true &&
          !!object(object(status.state).running).startedAt &&
          imageDigest(status.imageID) === pin.sha256 &&
          imageDigest(container.image) === pin.sha256
        );
      });
  });
}
const ready = fleetFluxReady;
function revision(value: unknown, target: string): boolean {
  return typeof value === "string" && value.endsWith(`sha1:${target}`);
}
export function fleetPlatformReadback(
  input: FleetPatchInput,
  state: FleetPlatformState,
  assets: FleetPlatformAssets,
  legacyBindings?: LegacyStorageBinding[],
): {
  components: FleetReleaseFacts["components"];
  flux_ready: boolean;
  platform_ready: boolean;
  regional_ready: boolean;
  issues: string[];
} {
  const components: FleetReleaseFacts["components"] = [],
    issues: string[] = [];
  const wanted = new Set(input.spec.roles[input.role].components);
  for (const pin of input.spec.components.filter((v) => wanted.has(v.name))) {
    if (pin.kind === "image") {
      if (pinnedPods(state, pin, input))
        components.push({
          name: pin.name,
          version: pin.version,
          sha256: pin.sha256,
          runtime_image_sha256: pin.sha256,
        });
      else issues.push(`unobserved/components/${pin.name}`);
      continue;
    }
    if (pin.kind !== "chart") continue;
    const releaseName =
      pin.name === "chart/plugin-barman-cloud"
        ? "plugin-barman-cloud"
        : pin.name;
    const release = state.resources.get(
        `HelmRelease/flux-system/${releaseName}`,
      ),
      sourceName = object(object(release?.spec ?? {}).chartRef ?? {}).name,
      chartRef = String(object(release?.status ?? {}).helmChart ?? "");
    const observed = fleetChartObservation(
      pin,
      release,
      state.resources.get(`OCIRepository/flux-system/${sourceName}`),
      state.resources.get(`HelmChart/${chartRef}`),
    );
    if (observed) components.push(observed);
    else issues.push(`unobserved/charts/${pin.name}`);
  }
  const source = required(state, "GitRepository", "pgcf-platform"),
    platform = required(state, "Kustomization", "pgcf-platform"),
    regional = required(state, "Kustomization", "pgcf-regional"),
    commit = input.spec.platform_source_commit;
  const sourceReady =
    !!commit &&
    object(object(source.spec).ref).commit === commit &&
    ready(source) &&
    revision(object(object(source.status).artifact).revision, commit);
  const sourceRevision = object(object(source.status).artifact).revision;
  const platformReady =
    sourceReady &&
    ready(platform) &&
    revision(object(platform.status).lastAppliedRevision, commit!) &&
    revision(sourceRevision, commit!);
  const regionalReady =
    platformReady &&
    ready(regional) &&
    revision(object(regional.status).lastAppliedRevision, commit!);
  let storageAuthorityReady = true;
  if (
    input.storage_authority ||
    input.spec.components.some((pin) => pin.name === "native-gateway")
  ) {
    const gateway = state.resources.get("Deployment/pgcf-system/pgcf-gateway"),
      containers = gateway
        ? objects(object(object(object(gateway.spec).template).spec).containers)
        : [],
      container = containers.find((value) => value.name === "gateway"),
      env = container?.env === undefined ? [] : objects(container.env);
    const literal = (name: string, value: string) =>
      env.filter((entry) => entry.name === name).length === 1 &&
      env.some(
        (entry) =>
          entry.name === name &&
          entry.value === value &&
          entry.valueFrom === undefined,
      );
    storageAuthorityReady =
      !!input.storage_authority &&
      literal(
        "PGCF_STORAGE_AUTHORITY_KEYS",
        canonical(input.storage_authority.keys),
      ) &&
      literal(
        "PGCF_STORAGE_AUTHORITY_KEYS_SHA256",
        input.storage_authority.sha256,
      ) &&
      (!input.spec.components.some((pin) => pin.name === "native-gateway") ||
        (legacyBindings !== undefined &&
          literal(
            "PGCF_GATEWAY_LEGACY_BINDINGS_JSON",
            canonical(legacyBindings),
          )));
    if (!storageAuthorityReady)
      issues.push("unobserved/gateway/storage-authority");
  }
  const has = (name: string) => components.some((v) => v.name === name);
  return {
    components,
    flux_ready:
      !assets.flux_deprecated.some(
        (value) =>
          state.resources.has(resourceKey(value)) ||
          state.pods.some((pod) => {
            const selector = object(object(value.spec).selector).matchLabels;
            return (
              selector &&
              Object.entries(object(selector)).every(
                ([key, value]) =>
                  object(object(pod.metadata).labels)[key] === value,
              )
            );
          }),
      ) &&
      ["flux-source", "flux-kustomize", "flux-helm", "flux-notification"].every(
        has,
      ),
    platform_ready:
      platformReady &&
      (!(
        Array.isArray(assets.lock.charts) &&
        selectedOpenEbsDriverImage(assets.lock)
      ) ||
        openEbsCgroupReadback(
          state.resources.get("DaemonSet/openebs/openebs-lvm-localpv-node"),
        )) &&
      input.spec.components
        .filter(
          (v) =>
            wanted.has(v.name) &&
            (v.kind === "chart" || v.name.startsWith("image/")),
        )
        .every((v) => has(v.name)),
    regional_ready:
      regionalReady &&
      storageAuthorityReady &&
      [
        "regional",
        "native-controller",
        "native-gateway",
        "native-bootstrap-relay",
        "node-reclaimer",
        "cloudflared",
      ]
        .filter((v) => wanted.has(v))
        .every(has),
    issues: issues.sort(),
  };
}

function argsFor(value: Record<string, unknown>) {
  const metadata = object(value.metadata),
    namespace = metadata.namespace;
  if (
    typeof value.kind !== "string" ||
    typeof metadata.name !== "string" ||
    !/^[-a-zA-Z0-9.]+$/.test(value.kind) ||
    !/^[-a-z0-9.]+$/.test(metadata.name) ||
    (namespace !== undefined &&
      (typeof namespace !== "string" || !/^[-a-z0-9.]+$/.test(namespace)))
  )
    throw new BootstrapError("patch_platform_resource_invalid");
  return [
    value.kind,
    metadata.name,
    ...(namespace ? ["--namespace", namespace] : []),
  ];
}
export async function readFleetFluxIdentities(
  assets: FleetPlatformAssets,
  commands: Pick<FleetPlatformCommands, "kube">,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let offset = 0; offset < assets.flux.length; offset += 8) {
    const reads = await Promise.allSettled(
      assets.flux.slice(offset, offset + 8).map(async (value) => {
        const text = await commands.kube([
          "get",
          ...argsFor(value),
          "--output=jsonpath={.metadata.uid}",
        ]);
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(text))
          throw new BootstrapError("patch_flux_identity_missing");
        return [resourceKey(value), text] as const;
      }),
    );
    const failed = reads.find((v) => v.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (const value of reads)
      if (value.status === "fulfilled") result[value.value[0]] = value.value[1];
  }
  return result;
}
function merge(current: unknown, wanted: unknown): unknown {
  if (!wanted || typeof wanted !== "object" || Array.isArray(wanted))
    return structuredClone(wanted);
  const next = {
    ...(current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}),
  };
  for (const [key, value] of Object.entries(wanted))
    next[key] = merge(next[key], value);
  return next;
}
async function reconcileDeclaredResource(
  expected: Record<string, unknown>,
  uid: string | undefined,
  commands: FleetPlatformCommands,
) {
  if (!uid) throw new BootstrapError("patch_platform_identity_unbound");
  const target = argsFor(expected),
    actual = object(
      JSON.parse(await commands.kube(["get", ...target, "--output=json"])),
    );
  if (
    object(actual.metadata).uid !== uid ||
    object(actual.metadata).deletionTimestamp
  )
    throw new BootstrapError("patch_platform_identity_changed");
  try {
    assertOwnedResource(
      {
        ...expected,
        metadata: {
          name: object(expected.metadata).name,
          ...(object(expected.metadata).namespace
            ? { namespace: object(expected.metadata).namespace }
            : {}),
        },
      },
      actual,
    );
    return;
  } catch {
    /* Only fixed approved fields are reconciled; current defaults/unrelated metadata remain. */
  }
  const patch: FleetJsonPatch[] = [
    { op: "test", path: "/metadata/uid", value: uid },
  ];
  for (const key of ["spec", "rules", "subjects", "roleRef"])
    if (expected[key] !== undefined) {
      if (actual[key] === undefined)
        throw new BootstrapError("patch_platform_field_missing");
      patch.push(
        { op: "test", path: `/${key}`, value: structuredClone(actual[key]) },
        {
          op: "replace",
          path: `/${key}`,
          value:
            key === "spec"
              ? merge(actual[key], expected[key])
              : structuredClone(expected[key]),
        },
      );
    }
  if (patch.length === 1) return;
  await commands.authorize();
  await commands
    .kube(
      [
        "patch",
        ...target,
        "--type=json",
        "--patch-file=/dev/stdin",
        "--output=json",
      ],
      JSON.stringify(patch),
    )
    .catch(() => undefined);
  const after = object(
    JSON.parse(await commands.kube(["get", ...target, "--output=json"])),
  );
  if (object(after.metadata).uid !== uid)
    throw new BootstrapError("patch_platform_identity_changed");
  assertOwnedResource(
    {
      ...expected,
      metadata: {
        name: object(expected.metadata).name,
        ...(object(expected.metadata).namespace
          ? { namespace: object(expected.metadata).namespace }
          : {}),
      },
    },
    after,
  );
}
/** Conditional deletion is scoped to the original admitted owner and this exact verified vendor resource. */
export async function pruneDeprecatedFlux(
  input: FleetPatchInput,
  assets: FleetPlatformAssets,
  baseline: Record<string, string>,
  commands: FleetPlatformCommands,
) {
  for (const expectedSource of assets.flux_deprecated) {
    const expected = structuredClone(expectedSource),
      metadata = object(expected.metadata),
      name = String(metadata.name),
      uid = baseline[resourceKey(expected)];
    const list = object(
        JSON.parse(
          await commands.kube([
            "get",
            "deployments.apps",
            "--namespace",
            "flux-system",
            "--field-selector",
            `metadata.name=${name}`,
            "--output=json",
          ]),
        ),
      ),
      present = objects(list.items);
    if (!present.length) continue; // Also resolves a previously unknown successful delete.
    if (
      present.length !== 1 ||
      !uid ||
      object(present[0]!.metadata).uid !== uid
    )
      throw new BootstrapError("patch_flux_prune_identity_changed");
    const actual = present[0]!,
      actualMeta = object(actual.metadata);
    if (actualMeta.deletionTimestamp) continue;
    if (
      !input.initial_bootstrap_input_sha256 ||
      object(actualMeta.annotations ?? {})["pgcf.io/bootstrap-input"] !==
        input.initial_bootstrap_input_sha256
    )
      throw new BootstrapError("patch_flux_prune_owner_unknown");
    const pod = object(object(object(expected.spec).template).spec),
      tolerations =
        pod.tolerations === undefined ? [] : objects(pod.tolerations),
      quarantine = {
        key: "pgcf.io/quarantine",
        operator: "Equal",
        value: "bootstrap",
        effect: "NoSchedule",
      };
    if (
      !tolerations.some((value) => canonical(value) === canonical(quarantine))
    )
      pod.tolerations = [...tolerations, quarantine];
    assertOwnedResource(expected, actual);
    if (typeof actualMeta.resourceVersion !== "string")
      throw new BootstrapError("patch_flux_prune_identity_changed");
    await commands.authorize();
    await commands
      .kube(
        [
          "delete",
          `--raw=/apis/apps/v1/namespaces/flux-system/deployments/${name}`,
          "--filename=-",
        ],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          propagationPolicy: "Foreground",
          preconditions: { uid, resourceVersion: actualMeta.resourceVersion },
        }),
      )
      .catch(() => undefined);
    // No blind replay: a later turn obtains a current exact UID/spec read before any conditional delete.
  }
}
export async function reconcileFleetFlux(
  input: FleetPatchInput,
  assets: FleetPlatformAssets,
  baseline: Record<string, string>,
  commands: FleetPlatformCommands,
) {
  await pruneDeprecatedFlux(input, assets, baseline, commands);
  for (const value of assets.flux)
    await reconcileDeclaredResource(
      value,
      baseline[resourceKey(value)],
      commands,
    );
}
export function fleetPlatformSourceObjects(
  input: FleetPatchInput,
  state: FleetPlatformState,
  assets: FleetPlatformAssets,
): Record<string, unknown>[] {
  const current = required(state, "GitRepository", "pgcf-platform"),
    spec = object(current.spec),
    metadata = object(current.metadata);
  if (
    spec.url !== repository ||
    spec.suspend === true ||
    !input.spec.platform_source_commit
  )
    throw new BootstrapError("patch_platform_source_invalid");
  const values: Record<string, unknown>[] = [
    {
      apiVersion: current.apiVersion,
      kind: "GitRepository",
      metadata: { name: metadata.name, namespace: metadata.namespace },
      spec: { ...spec, ref: { commit: input.spec.platform_source_commit } },
    },
  ];
  const driver = selectedOpenEbsDriverImage(assets.lock);
  if (driver) {
    const platform = required(state, "Kustomization", "pgcf-platform"),
      platformSpec = object(platform.spec),
      platformMeta = object(platform.metadata);
    if (
      platformSpec.path !== "./infra/platform" ||
      platformSpec.suspend === true ||
      object(platformSpec.sourceRef).name !== "pgcf-platform"
    )
      throw new BootstrapError("patch_platform_source_invalid");
    const prior =
      platformSpec.patches === undefined ? [] : objects(platformSpec.patches);
    // Preserve unrelated reviewed/user overrides; replace only the exact existing OpenEBS HelmRelease patch.
    const selected = {
      target: {
        group: "helm.toolkit.fluxcd.io",
        version: "v2",
        kind: "HelmRelease",
        name: "openebs",
        namespace: "flux-system",
      },
      patch: JSON.stringify({
        apiVersion: "helm.toolkit.fluxcd.io/v2",
        kind: "HelmRelease",
        metadata: { name: "openebs", namespace: "flux-system" },
        spec: {
          postRenderers: openEbsCgroupPostRenderers(),
          values: {
            "lvm-localpv": {
              lvmPlugin: { image: openEbsDriverValues(driver) },
            },
          },
        },
      }),
    };
    const sameTarget = (patch: Record<string, unknown>) =>
      canonical(patch.target) === canonical(selected.target);
    if (prior.filter(sameTarget).length > 1)
      throw new BootstrapError("patch_platform_source_invalid");
    const previous = prior.find(sameTarget);
    if (previous) {
      const docs = parseAllDocuments(String(previous.patch));
      if (docs.length !== 1 || docs[0]!.errors.length)
        throw new BootstrapError("patch_platform_source_invalid");
      const old = object(docs[0]!.toJSON()),
        oldSpec = object(old.spec),
        oldValues = object(oldSpec.values ?? {}),
        oldLvm = object(oldValues["lvm-localpv"] ?? {}),
        oldPlugin = object(oldLvm.lvmPlugin ?? {}),
        renderers =
          oldSpec.postRenderers === undefined
            ? []
            : objects(oldSpec.postRenderers),
        cgroup = openEbsCgroupPostRenderers();
      if (
        old.kind !== "HelmRelease" ||
        object(old.metadata).name !== "openebs" ||
        object(old.metadata).namespace !== "flux-system"
      )
        throw new BootstrapError("patch_platform_source_invalid");
      selected.patch = JSON.stringify({
        ...old,
        spec: {
          ...oldSpec,
          postRenderers: [
            ...renderers,
            ...cgroup.filter(
              (value) =>
                !renderers.some(
                  (prior) => canonical(prior) === canonical(value),
                ),
            ),
          ],
          values: {
            ...oldValues,
            "lvm-localpv": {
              ...oldLvm,
              lvmPlugin: {
                ...oldPlugin,
                image: {
                  ...object(oldPlugin.image ?? {}),
                  ...openEbsDriverValues(driver),
                },
              },
            },
          },
        },
      });
    }
    values.push({
      apiVersion: platform.apiVersion,
      kind: "Kustomization",
      metadata: { name: platformMeta.name, namespace: platformMeta.namespace },
      spec: {
        ...platformSpec,
        patches: [...prior.filter((patch) => !sameTarget(patch)), selected],
      },
    });
  }
  return values;
}
export async function reconcileFleetPlatformSource(
  input: FleetPatchInput,
  state: FleetPlatformState,
  assets: FleetPlatformAssets,
  baseline: Record<string, string>,
  commands: FleetPlatformCommands,
) {
  for (const value of fleetPlatformSourceObjects(input, state, assets))
    await reconcileDeclaredResource(
      value,
      baseline[resourceKey(value)],
      commands,
    );
}
export async function reconcileFleetRegional(
  input: FleetPatchInput,
  state: FleetPlatformState,
  assets: FleetPlatformAssets,
  baseline: Record<string, string>,
  commands: FleetPlatformCommands,
  legacyBindings?: LegacyStorageBinding[],
) {
  const current = required(state, "Kustomization", "pgcf-regional"),
    spec = object(current.spec),
    metadata = object(current.metadata),
    regional = input.spec.components.find((v) => v.name === "regional"),
    controller =
      input.spec.components.find((v) => v.name === "native-controller") ??
      regional,
    gateway =
      input.spec.components.find((v) => v.name === "native-gateway") ??
      regional,
    relayPin =
      input.spec.components.find((v) => v.name === "native-bootstrap-relay") ??
      input.spec.components.find((v) => v.name === "bootstrap-relay") ??
      regional,
    cloudflared = component(input, "cloudflared");
  if (
    spec.suspend === true ||
    spec.path !== "./infra/platform/regional" ||
    object(spec.sourceRef).name !== "pgcf-platform"
  )
    throw new BootstrapError("patch_regional_source_invalid");
  if (!controller || !gateway)
    throw new BootstrapError("patch_regional_component_missing");
  const images = spec.images === undefined ? [] : objects(spec.images),
    selected = [
      ...(regional ? [{ pin: regional, name: "pgcf-regional" }] : []),
      ...(controller.name === "native-controller"
        ? [{ pin: controller, name: "pgcf-native-controller" }]
        : []),
      ...(gateway.name === "native-gateway"
        ? [{ pin: gateway, name: "pgcf-native-gateway" }]
        : []),
      { pin: cloudflared, name: "cloudflared" },
    ],
    targets = selected.map(({ pin, name }) => ({
      name,
      newName: imageRepository(pin.reference),
      digest: `sha256:${pin.sha256}`,
    }));
  const retained = images.filter(
    (value) =>
      !targets.some(
        (target) => value.name === target.name || value.name === target.newName,
      ),
  );
  await reconcileDeclaredResource(
    {
      apiVersion: current.apiVersion,
      kind: "Kustomization",
      metadata: { name: metadata.name, namespace: metadata.namespace },
      spec: {
        ...spec,
        images: [...retained, ...targets],
        postBuild: {
          ...object(spec.postBuild ?? {}),
          substitute: {
            ...object(object(spec.postBuild ?? {}).substitute ?? {}),
            PGCF_CLUSTER_UID: input.status.cluster_uid,
            ...(legacyBindings === undefined
              ? {}
              : {
                  PGCF_GATEWAY_LEGACY_BINDINGS_JSON: canonical(legacyBindings),
                }),
            ...(input.storage_authority
              ? {
                  PGCF_STORAGE_AUTHORITY_KEYS: canonical(
                    input.storage_authority.keys,
                  ),
                  PGCF_STORAGE_AUTHORITY_KEYS_SHA256:
                    input.storage_authority.sha256,
                }
              : {}),
          },
        },
      },
    },
    baseline[resourceKey(current)],
    commands,
  );
  const relay = state.resources.get(
    "Deployment/pgcf-bootstrap-transport/pgcf-bootstrap-relay",
  );
  if (relay) {
    const wanted = structuredClone(assets.relay),
      expectedSpec = object(wanted.spec),
      expectedPod = object(object(expectedSpec.template).spec),
      actualPod = object(object(object(relay.spec).template).spec);
    // Network/credential/node placement are retained role parameters; the reviewed source selects executable/probes/security and exact image bytes.
    expectedPod.nodeSelector = actualPod.nodeSelector;
    for (const container of objects(expectedPod.containers)) {
      if (container.name === "relay") {
        if (!relayPin)
          throw new BootstrapError("patch_relay_component_missing");
        container.image = relayPin.reference;
      } else if (container.name === "tunnel")
        container.image = cloudflared.reference;
      else throw new BootstrapError("patch_relay_container_unknown");
    }
    await reconcileDeclaredResource(
      wanted,
      baseline[resourceKey(relay)],
      commands,
    );
    const after = object(
      JSON.parse(
        await commands.kube([
          "get",
          "deployment",
          "pgcf-bootstrap-relay",
          "--namespace",
          "pgcf-bootstrap-transport",
          "--output=json",
        ]),
      ),
    );
    assertWorkloadReady("Deployment", after);
  }
}

export interface FleetJsonPatch {
  op: "test" | "replace";
  path: string;
  value: unknown;
}
export function fleetResourcePatch(
  actual: Record<string, unknown>,
  expectedUid: string,
  desiredSpec: Record<string, unknown>,
): FleetJsonPatch[] {
  const metadata = object(actual.metadata),
    prior = object(actual.spec);
  if (metadata.uid !== expectedUid || metadata.deletionTimestamp)
    throw new BootstrapError("patch_platform_identity_changed");
  return [
    { op: "test", path: "/metadata/uid", value: expectedUid },
    { op: "test", path: "/spec", value: structuredClone(prior) },
    { op: "replace", path: "/spec", value: structuredClone(desiredSpec) },
  ];
}
