// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FleetReleaseComponent,
  FleetReleaseSpec,
} from "../../packages/contracts/src/releases.ts";
import { selectedOpenEbsDriverImage } from "./openebs-image.ts";
import { selectedImageManifestDigest } from "./image-manifest.ts";

type Component = FleetReleaseSpec["components"][number];
interface LockRecord {
  [key: string]: unknown;
}
function object(value: unknown): LockRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as LockRecord)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function hash(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && /^[0-9a-f]{64}$/.test(valueText) ? valueText : undefined;
}
function digest(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && /^sha256:[0-9a-f]{64}$/.test(valueText)
    ? valueText.slice(7)
    : undefined;
}
function image(value: string) {
  const reference = value.split("@")[0]!,
    lastSlash = reference.lastIndexOf("/"),
    lastColon = reference.lastIndexOf(":");
  return {
    repository:
      lastColon > lastSlash ? reference.slice(0, lastColon) : reference,
    version: lastColon > lastSlash ? reference.slice(lastColon + 1) : undefined,
    sha256: digest(value.split("@")[1]),
  };
}

export interface FleetReleaseCandidate {
  /** Candidate extraction is not CI qualification, release approval or runtime attestation. */
  candidate_only: true;
  versions_lock_sha256: string;
  target: { talos_version: string; kubernetes_version: string };
  components: Component[];
  unresolved: string[];
  spec: FleetReleaseSpec | null;
}

/**
 * All versions, digests and explicit role composition come from these exact lock bytes.
 * Optional fleetRelease.components supplies qualification results absent from the old lock,
 * using the public FleetReleaseComponent schema. Conflicting known lock facts are rejected.
 * Missing evidence stays unresolved; the generator never resolves mutable tags over the network.
 */
export function deriveFleetReleaseCandidate(
  lockBytes: Uint8Array | string,
  platformSourceCommit?:string,
): FleetReleaseCandidate {
  const bytes =
    typeof lockBytes === "string"
      ? Buffer.from(lockBytes, "utf8")
      : Buffer.from(lockBytes);
  const lock = object(JSON.parse(bytes.toString("utf8"))),
    target = object(lock.target),
    extra = object(lock.fleetRelease);
  if (
    lock.schemaVersion !== 1 ||
    !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      String(target.talosVersion),
    ) ||
    !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      String(target.kubernetesVersion),
    )
  )
    throw new Error("release_lock_shape_invalid");
  const versionsLockSha256 = createHash("sha256").update(bytes).digest("hex"),
    unresolved = new Set<string>(),
    components = new Map<string, Component>();
  const supplied = new Map<string, Component>();
  if (extra.components !== undefined && !Array.isArray(extra.components))
    throw new Error("release_lock_components_invalid");
  for (const raw of (extra.components as unknown[] | undefined) ?? []) {
    const component = FleetReleaseComponent.parse(raw);
    if (
      component.kind === "image" &&
      !component.reference.endsWith(`@sha256:${component.sha256}`)
    )
      throw new Error("release_lock_image_digest_invalid");
    if (supplied.has(component.name))
      throw new Error("release_lock_component_duplicate");
    supplied.set(component.name, component);
  }
  function add(
    name: string,
    kind: Component["kind"],
    version: string | undefined,
    reference: string | undefined,
    sha256: string | undefined,
  ) {
    const proof = supplied.get(name);
    if (
      proof &&
      (proof.kind !== kind ||
        (version !== undefined && proof.version !== version) ||
        (sha256 !== undefined && proof.sha256 !== sha256) ||
        (reference !== undefined &&
          (kind === "image"
            ? image(proof.reference).repository !== image(reference).repository
            : proof.reference !== reference)))
    )
      throw new Error(`release_lock_component_conflict:${name}`);
    if (!version && !proof) unresolved.add(`components/${name}/version`);
    if (!sha256 && !proof) unresolved.add(`components/${name}/sha256`);
    if (!reference && !proof) unresolved.add(`components/${name}/reference`);
    if (proof) {
      components.set(name, proof);
      supplied.delete(name);
      return;
    }
    if (!version || !reference || !sha256) return;
    components.set(
      name,
      FleetReleaseComponent.parse({
        name,
        kind,
        version,
        reference:
          kind === "image"
            ? `${reference.split("@")[0]}@sha256:${sha256}`
            : reference,
        sha256,
      }),
    );
  }
  function addImage(
    name: string,
    value: unknown,
    explicitVersion?: string,
    explicitDigest?: unknown,
  ) {
    const reference = text(value),
      parsed = reference ? image(reference) : undefined;
    add(
      name,
      "image",
      explicitVersion ?? parsed?.version,
      reference,
      digest(explicitDigest) ?? parsed?.sha256,
    );
  }
  const charts = lock.charts;
  if (!Array.isArray(charts)) throw new Error("release_lock_charts_invalid");
  const chartNames = new Set<string>();
  for (const raw of charts) {
    const chart = object(raw),
      name = text(chart.name);
    if (!name || chartNames.has(name))
      throw new Error("release_lock_chart_duplicate_or_invalid");
    chartNames.add(name);
    const alias =
      name === "plugin-barman-cloud" ? "chart/plugin-barman-cloud" : name;
    const manifest = digest(chart.ociManifestDigest),
      source = text(chart.source);
    const selectedDriver=name==="openebs"?selectedOpenEbsDriverImage(lock):undefined;
    add(
      alias,
      "chart",
      text(chart.chartVersion),
      manifest && source
        ? `${source}@sha256:${manifest}`
        : text(chart.archiveURL),
      manifest ?? hash(chart.archiveSha256),
    );
    if (!Array.isArray(chart.renderedImages))
      throw new Error("release_lock_workloads_invalid");
    for (const rawReference of chart.renderedImages) {
      const reference = text(rawReference);
      if (!reference) throw new Error("release_lock_workload_invalid");
      const repo = image(reference).repository,
        driver=name==="openebs"&&(repo.endsWith("/lvm-driver")||(selectedDriver&&repo===image(selectedDriver).repository)),
        workloadName = `image/${name}/${driver?"lvm-driver":repo.split("/").at(-1)}`;
      addImage(workloadName, driver&&selectedDriver?selectedDriver:reference,driver&&selectedDriver?text(object(chart.enabledEngine).appVersion):undefined);
    }
    if (chart.enabledEngine !== undefined) {
      const engine = object(chart.enabledEngine);
      const engineName = text(engine.name);
      if (!engineName) throw new Error("release_lock_engine_invalid");
      if(selectedDriver&&engineName==="lvm-localpv") addImage("openebs-lvm",selectedDriver,text(engine.appVersion));
      else add(
        engineName === "lvm-localpv" ? "openebs-lvm" : `chart/${engineName}`,
        "chart",
        text(engine.chartVersion),
        text(engine.archiveURL),
        hash(engine.archiveSha256),
      );
    }
    if (chart.runtimeSidecarImage !== undefined)
      addImage(
        name === "plugin-barman-cloud" ? "barman" : `sidecar/${name}`,
        chart.runtimeSidecarImage,
      );
  }
  const regional = object(lock.regional),
    postgres = object(regional.postgresImage);
  addImage("postgres", postgres.reference, text(postgres.version));
  if (!Array.isArray(regional.images))
    throw new Error("release_lock_regional_images_invalid");
  for (const raw of regional.images) {
    const entry = object(raw),
      name = text(entry.name);
    if (!name) throw new Error("release_lock_regional_image_invalid");
    addImage(
      name === "pgcf-regional" ? "regional" : name,
      entry.reference,
      text(entry.version),
      selectedImageManifestDigest(entry),
    );
  }
  for (const name of ["api", "edge"])
    add(name, "worker_bundle", undefined, undefined, undefined);
  add("node-bootstrap", "image", undefined, undefined, undefined);
  for (const name of [
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
  ])
    addImage(name, object(object(lock.flux).images)[`${name.slice("flux-".length)}-controller`]);
  // Additional pinned chart workloads, Talos extensions and explicitly selected Flux controllers.
  for (const component of supplied.values())
    components.set(component.name, component);
  if(components.has("native-controller")&&components.has("native-gateway")&&!Object.values(object(extra.roleComponents)).some(value=>Array.isArray(value)&&value.includes("regional"))) {
    components.delete("regional");for(const key of unresolved)if(key.startsWith("components/regional/"))unresolved.delete(key);
  }
  const componentList = [...components.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const roles = object(extra.talosRoles),
    roleComponents = object(extra.roleComponents),
    constructedRoles: Record<string, unknown> = {};
  for (const name of ["control_relay", "customer"]) {
    const role = object(roles[name]);
    if (!text(role.installerImage))
      unresolved.add(`roles/${name}/talos_installer`);
    if (!hash(role.schematicSha256))
      unresolved.add(`roles/${name}/talos_schematic_sha256`);
    if (!Array.isArray(role.extensions))
      unresolved.add(`roles/${name}/talos_extensions`);
    if (!Array.isArray(roleComponents[name]))
      unresolved.add(`roles/${name}/components`);
    constructedRoles[name] = {
      talos_version: target.talosVersion,
      kubernetes_version: target.kubernetesVersion,
      ...(target.kubernetesImages===undefined?{}:{kubernetes_images:target.kubernetesImages}),
      talos_installer: role.installerImage,
      talos_schematic_sha256: role.schematicSha256,
      talos_extensions: role.extensions,
      components: roleComponents[name],
      ...(role.hostConfigurationRequired===undefined?{}:{host_configuration_required:role.hostConfigurationRequired}),
    };
  }
  if (
    !Number.isSafeInteger(extra.configurationSchemaRevision) ||
    (extra.configurationSchemaRevision as number) < 1
  )
    unresolved.add("configuration_schema_revision");
  const parsed = FleetReleaseSpec.safeParse({
    version: 1,
    versions_lock_sha256: versionsLockSha256,
    configuration_schema_revision: extra.configurationSchemaRevision,
    ...(platformSourceCommit===undefined?{}:{platform_source_commit:platformSourceCommit}),
    ...(extra.storageAuthorityKeysSha256===undefined?{}:{storage_authority_keys_sha256:extra.storageAuthorityKeysSha256}),
    components: componentList,
    roles: constructedRoles,
  });
  if (!parsed.success && !unresolved.size)
    throw new Error("release_lock_release_spec_invalid");
  return {
    candidate_only: true,
    versions_lock_sha256: versionsLockSha256,
    target: {
      talos_version: String(target.talosVersion),
      kubernetes_version: String(target.kubernetesVersion),
    },
    components: componentList,
    unresolved: [...unresolved].sort(),
    spec: parsed.success && !unresolved.size ? parsed.data : null,
  };
}
export async function readFleetReleaseCandidate(
  path = new URL("./versions.lock.json", import.meta.url),
  platformSourceCommit?:string,
): Promise<FleetReleaseCandidate> {
  return deriveFleetReleaseCandidate(await readFile(path),platformSourceCommit);
}
if (import.meta.main)
  process.stdout.write(
    `${JSON.stringify(await readFleetReleaseCandidate(), null, 2)}\n`,
  );
