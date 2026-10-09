// SPDX-License-Identifier: Apache-2.0
import postgresSources from "../../infra/postgres/sources.lock.json" with { type: "json" };
import storageSources from "../../infra/storage/sources.lock.json" with { type: "json" };
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };

export const nodeBase =
  "node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20";
export const postgresBase = `${postgresSources.postgresql.upstream_image}@${postgresSources.postgresql.image_index_digest}`;
export const storageBase = `${storageSources.driver.upstream_image}@${storageSources.driver.image_index_digest}`;
export const rustBuilder = versions.nativeRuntime.testBuilderImage;
export const rustVersion = versions.nativeRuntime.rustVersion;
const profiles = [
  "regional",
  "node-bootstrap",
  "postgres",
  "storage",
  "rust-gateway",
  "native-controller",
  "rust-bootstrap-relay",
  "native-reclaimer",
  "sandbox-controller",
  "sandbox-extension",
  "talos-recipe",
] as const;
export type ImageProfile = (typeof profiles)[number];
export function imageProfile(value: unknown = "regional"): ImageProfile {
  if (typeof value !== "string" || !profiles.includes(value as ImageProfile))
    throw new Error("Invalid image qualification profile");
  return value as ImageProfile;
}
export const isRustProfile = (profile: ImageProfile) =>
  profile === "rust-gateway" ||
  profile === "native-controller" ||
  profile === "rust-bootstrap-relay" ||
  profile === "native-reclaimer" ||
  profile === "sandbox-controller" ||
  profile === "sandbox-extension";

export interface NativeArtifactProvenance {
  path: string;
  name: string;
  version: string;
  architecture: string;
  releaseUrl: string;
  checksumUrl: string;
  sha256: string;
  size: number;
}
/** Immutable upstream release identities, independent of scanner findings. */
export function nativeArtifactPins(): NativeArtifactProvenance[] {
  return (["talos", "kubectl", "helm"] as const).map((name) => {
    const archives = versions.bootstrapClients[name].archives.filter(
        (value) => value.os === "linux" && value.architecture === "amd64",
      ),
      archive = archives[0];
    if (
      archives.length !== 1 ||
      !archive ||
      !("binarySha256" in archive) ||
      !("binaryBytes" in archive) ||
      typeof archive.binarySha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(archive.binarySha256) ||
      typeof archive.binaryBytes !== "number" ||
      !Number.isSafeInteger(archive.binaryBytes) ||
      archive.binaryBytes <= 0
    )
      throw new Error("Native artifact pin incomplete");
    if (name !== "helm" && archive.binarySha256 !== archive.sha256)
      throw new Error(
        "Native artifact release checksum differs from binary pin",
      );
    const filename = name === "talos" ? "talosctl" : name;
    return {
      path: `usr/local/bin/${filename}`,
      name: filename,
      version:
        name === "talos"
          ? versions.target.talosVersion
          : name === "kubectl"
            ? versions.target.kubernetesVersion
            : versions.bootstrapClients.helm.version,
      architecture: "linux/amd64",
      releaseUrl: archive.url,
      checksumUrl:
        name === "talos"
          ? new URL("sha256sum.txt", archive.url).href
          : archive.url + (name === "helm" ? ".sha256sum" : ".sha256"),
      sha256: archive.binarySha256,
      size: archive.binaryBytes,
    };
  });
}
export function verifyNativeArtifacts(
  files: readonly { path: string; sha256: string; size: number }[],
  profileInput: ImageProfile = "regional",
): NativeArtifactProvenance[] {
  if (imageProfile(profileInput) !== "node-bootstrap") return [];
  const pins = nativeArtifactPins();
  for (const pin of pins) {
    const matches = files.filter((file) => file.path === pin.path);
    if (
      !matches.length ||
      matches.some(
        (file) => file.sha256 !== pin.sha256 || file.size !== pin.size,
      )
    )
      throw new Error("Native artifact checksum or size mismatch");
  }
  return pins;
}
export function validateNativeProvenance(
  values: readonly NativeArtifactProvenance[],
  profile: ImageProfile,
): void {
  const expected = verifyNativeArtifacts(values, profile);
  if (
    values.length !== expected.length ||
    expected.some(
      (pin) =>
        !values.some(
          (value) =>
            value.path === pin.path &&
            value.name === pin.name &&
            value.version === pin.version &&
            value.architecture === pin.architecture &&
            value.releaseUrl === pin.releaseUrl &&
            value.checksumUrl === pin.checksumUrl &&
            value.sha256 === pin.sha256 &&
            value.size === pin.size,
        ),
    )
  )
    throw new Error("Native artifact provenance mismatch");
}

function requiredOwnedPaths(profile: ImageProfile): string[] {
  if (profile === "regional")
    return [
      "app/agent.mjs",
      "app/gateway.mjs",
      "app/bootstrap-relay.mjs",
      "app/package.json",
      "app/LICENSE",
    ];
  if (profile === "node-bootstrap")
    return [
      "app/server.mjs",
      "app/proxy-command.mjs",
      "app/inspection-proxy-command.mjs",
      "app/outside-scan-command.mjs",
      "app/proof-proxy-command.mjs",
      "app/package.json",
      "app/LICENSE",
      "app/assets/cilium-values.yaml",
    ];
  if (profile === "postgres")
    return [
      "usr/share/pgcf/postgres-sources.lock.json",
      "usr/share/pgcf/postgres-engine.sha256",
    ];
  if (profile === "storage")
    return ["usr/share/pgcf/storage-sources.lock.json"];
  if (profile === "talos-recipe")
    return [
      "manifest.yaml",
      "rootfs/usr/local/share/pgcf/talos-recipe.json",
      "rootfs/usr/local/share/licenses/pgcf-recipe/LICENSE",
    ];
  if (profile === "sandbox-controller" || profile === "sandbox-extension") {
    const prefix = profile === "sandbox-extension" ? "rootfs/" : "";
    return [
      `${prefix}usr/local/bin/pgcf-sandbox-controller`,
      `${prefix}usr/local/bin/pgcf-node-runtime`,
      ...(profile === "sandbox-extension"
        ? [
            "rootfs/usr/local/share/licenses/pgcf-sandbox/pgcf/LICENSE",
            "manifest.yaml",
            "rootfs/usr/local/etc/containers/pgcf-sandbox-controller.yaml",
            "rootfs/etc/cri/conf.d/20-pgcf-prestarted.part",
          ]
        : ["licenses/pgcf/LICENSE"]),
    ];
  }
  const binary =
    profile === "rust-gateway"
      ? "pgcf-native-gateway"
      : profile === "native-controller"
        ? "pgcf-native-controller"
        : profile === "rust-bootstrap-relay"
          ? "pgcf-native-bootstrap-relay"
          : "pgcf-native-reclaimer";
  return [binary, "licenses/pgcf/LICENSE"];
}

/** Select scan scope, not trust: upstream digest and assembly verification still cover the complete image. */
export function selectOwnedFiles<T extends { path: string }>(
  files: readonly T[],
  profileInput: ImageProfile,
): T[] {
  const profile = imageProfile(profileInput),
    paths = new Set(files.map((file) => file.path));
  for (const path of requiredOwnedPaths(profile))
    if (!paths.has(path))
      throw new Error(`First-party image output missing: ${path}`);
  // A scratch image contains only the output assembled by this repository; even unexpected files are scanned.
  if (isRustProfile(profile) || profile === "talos-recipe") return [...files];
  if (profile === "regional" || profile === "node-bootstrap") {
    const upstreamAssets = new Set<string>();
    if (profile === "node-bootstrap") {
      const cilium = versions.charts.find((chart) => chart.name === "cilium");
      if (!cilium) throw new Error("Pinned Cilium archive missing");
      upstreamAssets.add("app/assets/flux-install.yaml");
      upstreamAssets.add(`app/assets/cilium-${cilium.chartVersion}.tgz`);
    }
    return files.filter(
      ({ path }) =>
        path.startsWith("app/") &&
        !path.startsWith("app/node_modules/") &&
        !path.startsWith("app/licenses/") &&
        !upstreamAssets.has(path),
    );
  }
  const upstreamSource = `usr/share/pgcf/${new URL(storageSources.thin_tools.source_archive_url).pathname.split("/").at(-1)}`;
  // PostgreSQL is flattened: layer membership cannot distinguish the upstream engine from our metadata.
  return files.filter(
    ({ path }) =>
      path.startsWith("usr/share/pgcf/") &&
      (profile !== "storage" || path !== upstreamSource),
  );
}
