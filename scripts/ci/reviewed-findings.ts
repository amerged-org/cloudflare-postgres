// SPDX-License-Identifier: Apache-2.0
import review from "./reviewed-findings.json" with { type: "json" };
import postgresSources from "../../infra/postgres/sources.lock.json" with { type: "json" };
import postgresReview from "./postgres-reviewed-findings.json" with { type: "json" };
import storageReview from "./storage-reviewed-findings.json" with { type: "json" };
import storageSources from "../../infra/storage/sources.lock.json" with { type: "json" };
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };
import talosReview from "./talos-reviewed-findings.json" with { type: "json" };
import type { CanonicalFinding } from "./scanner.ts";

/** The boot gate supplies measured parent bindings; no other image profile inherits this review. */
export function classifyReviewedTalosBoot(
  findings: CanonicalFinding[],
  provenance: {
    talosVersion: string;
    baseInstaller: string;
    baseDiffIDs: string[];
  },
): { resolved: number; unresolved: number } {
  if (
    provenance.talosVersion !== talosReview.talosVersion ||
    provenance.baseInstaller !== talosReview.baseInstaller ||
    JSON.stringify(provenance.baseDiffIDs) !==
      JSON.stringify(talosReview.baseDiffIDs)
  )
    return { resolved: 0, unresolved: findings.length };
  let resolved = 0;
  for (const finding of findings) {
    const input = finding.input;
    if (
      input.kind !== "layer-file" ||
      finding.File !== input.path ||
      finding.Tags.length !== 0 ||
      finding.Secret !== "REDACTED"
    )
      continue;
    const artifact =
      input.path === "usr/bin/installer"
        ? "installer"
        : /^(?:installer-uki|raw-uki)\/rootfs\.sqsh\/usr\/bin\/init$/.test(
              input.path,
            )
          ? "rootfs-init"
          : /^(?:installer-uki|raw-uki)\/squash-(?:0|[1-9][0-9]{0,5})\.pseudo$/.test(
                input.path,
              )
            ? "rootfs-pseudo"
            : null;
    const file = talosReview.files.find(
      (file) =>
        file.artifact === artifact &&
        file.sha256 === input.sha256 &&
        file.size === input.size &&
        file.boundDigest === input.boundDigest,
    );
    if (!file) continue;
    if (artifact === "installer") {
      if (
        input.layer === null ||
        !Number.isSafeInteger(input.layer) ||
        input.layer < 0 ||
        provenance.baseDiffIDs[input.layer] !== input.boundDigest ||
        input.tarEntry === null ||
        !Number.isSafeInteger(input.tarEntry) ||
        input.tarEntry < 0
      )
        continue;
    } else if (input.layer !== null || input.tarEntry !== null) continue;
    if (
      file.findings.some(
        (span) =>
          span.RuleID === finding.RuleID &&
          span.StartLine === finding.StartLine &&
          span.EndLine === finding.EndLine &&
          span.StartColumn === finding.StartColumn &&
          span.EndColumn === finding.EndColumn &&
          span.span.byteStart === finding.span?.byteStart &&
          span.span.byteEndExclusive === finding.span?.byteEndExclusive &&
          span.span.size === finding.span?.size &&
          span.span.sha256 === finding.span?.sha256,
      )
    )
      resolved++;
  }
  return { resolved, unresolved: findings.length - resolved };
}

export const reviewedFiles = review.files;
export const reviewedBase = review.base;
export const postgresBase = `${postgresSources.postgresql.upstream_image}@${postgresSources.postgresql.image_index_digest}`;
export const storageBase = `${storageSources.driver.upstream_image}@${storageSources.driver.image_index_digest}`;
export const rustBuilder = versions.nativeRuntime.testBuilderImage;
export const rustVersion = versions.nativeRuntime.rustVersion;
export type ImageProfile =
  | "regional"
  | "node-bootstrap"
  | "postgres"
  | "storage"
  | "rust-gateway"
  | "native-controller"
  | "rust-bootstrap-relay"
  | "native-reclaimer"
  | "sandbox-controller"
  | "sandbox-extension"
  | "talos-recipe";
export const isRustProfile = (profile: ImageProfile) =>
  profile === "rust-gateway" ||
  profile === "native-controller" ||
  profile === "rust-bootstrap-relay" ||
  profile === "native-reclaimer" ||
  profile === "sandbox-controller" ||
  profile === "sandbox-extension";
export function imageProfile(value: unknown = "regional"): ImageProfile {
  if (
    value !== "regional" &&
    value !== "node-bootstrap" &&
    value !== "postgres" &&
    value !== "storage" &&
    value !== "rust-gateway" &&
    value !== "native-controller" &&
    value !== "rust-bootstrap-relay" &&
    value !== "native-reclaimer" &&
    value !== "sandbox-controller" &&
    value !== "sandbox-extension" &&
    value !== "talos-recipe"
  )
    throw new Error("Invalid image qualification profile");
  return value;
}

export function reviewedManifestPaths(
  paths: readonly string[],
  profileInput: ImageProfile = "regional",
): string[] {
  const profile = imageProfile(profileInput),
    manifests: string[] = [];
  if (
    profile === "postgres" ||
    profile === "storage" ||
    isRustProfile(profile) ||
    profile === "talos-recipe"
  ) {
    if (paths.some((path) => /^app\/node_modules(?:\/|$)/.test(path)))
      throw new Error("Unexpected Node runtime package in non-Node profile");
    return [];
  }
  if (
    profile === "node-bootstrap" &&
    paths.some((path) =>
      /^app\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@kubernetes\/client-node(?:\/|$)/.test(
        path,
      ),
    )
  )
    throw new Error(
      "Unexpected Kubernetes runtime package in bootstrap profile",
    );
  for (const file of reviewedFiles) {
    if (!file.package) continue;
    const path = file.path.replace(/https\.d\.ts$/, "package.json"),
      root = path.slice(0, -"package.json".length);
    if (paths.includes(path)) manifests.push(path);
    else if (
      profile !== "node-bootstrap" ||
      paths.some((path) => path === root.slice(0, -1) || path.startsWith(root))
    )
      throw new Error("Reviewed runtime package manifest missing");
  }
  return manifests;
}
interface PackageProvenance {
  name: string;
  version: string;
  integrity: string;
}
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
export function verifyNativeArtifacts(
  files: readonly { path: string; sha256: string; size: number }[],
  profileInput: ImageProfile = "regional",
): NativeArtifactProvenance[] {
  if (imageProfile(profileInput) !== "node-bootstrap") return [];
  const native = reviewedFiles.filter((file) => file.nativeArtifact);
  if (native.length !== 3) throw new Error("Native artifact review incomplete");
  return native.map((file) => {
    const artifact = file.nativeArtifact!,
      matches = files.filter((value) => value.path === file.path);
    if (
      artifact.architecture !== "linux/amd64" ||
      artifact.sha256 !== file.sha256 ||
      artifact.size !== file.size ||
      !matches.length ||
      matches.some(
        (value) =>
          value.sha256 !== artifact.sha256 || value.size !== artifact.size,
      )
    )
      throw new Error("Native artifact checksum or size mismatch");
    return { path: file.path, ...artifact };
  });
}
function sameNativeArtifact(
  item: NativeArtifactProvenance,
  expected: NativeArtifactProvenance,
): boolean {
  return (
    item.path === expected.path &&
    item.name === expected.name &&
    item.version === expected.version &&
    item.architecture === expected.architecture &&
    item.releaseUrl === expected.releaseUrl &&
    item.checksumUrl === expected.checksumUrl &&
    item.sha256 === expected.sha256 &&
    item.size === expected.size
  );
}
export function validateNativeProvenance(
  values: readonly NativeArtifactProvenance[],
  profile: ImageProfile,
): void {
  const expected = verifyNativeArtifacts(values, profile);
  if (
    values.length !== expected.length ||
    expected.some(
      (item) => !values.some((value) => sameNativeArtifact(value, item)),
    )
  )
    throw new Error("Native artifact provenance mismatch");
}
interface Provenance {
  baseImage: string | null;
  baseDiffIDs: string[];
  imageDiffIDs: string[];
  packages: PackageProvenance[];
  profile?: ImageProfile;
  nativeArtifacts?: NativeArtifactProvenance[];
}

export function readPackageProvenance(
  lock: string,
  manifests: { name: string; version: string }[],
  profileInput: ImageProfile = "regional",
): PackageProvenance[] {
  const profile = imageProfile(profileInput);
  if (
    profile === "postgres" ||
    profile === "storage" ||
    isRustProfile(profile) ||
    profile === "talos-recipe"
  ) {
    if (manifests.length)
      throw new Error("Unexpected PostgreSQL package review");
    return [];
  }
  if (
    manifests.some(
      (manifest) =>
        !reviewedFiles.some(
          (file) =>
            file.package?.name === manifest.name &&
            file.package.version === manifest.version,
        ),
    )
  )
    throw new Error("Reviewed package manifest provenance changed");
  const packages: PackageProvenance[] = [];
  for (const file of reviewedFiles) {
    if (!file.package) continue;
    const expected = file.package;
    if (
      !manifests.some(
        (manifest) =>
          manifest.name === expected.name &&
          manifest.version === expected.version,
      )
    ) {
      if (profile === "node-bootstrap") continue;
      throw new Error("Reviewed package manifest provenance changed");
    }
    const key = `${expected.name}@${expected.version}`.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const matches = [
      ...lock.matchAll(
        new RegExp(
          `^  '${key}':\\n    resolution: \\{integrity: ([A-Za-z0-9+/=-]+)\\}`,
          "gm",
        ),
      ),
    ];
    if (matches.length !== 1 || matches[0]![1] !== expected.integrity)
      throw new Error("Reviewed package lock artifact integrity changed");
    packages.push({ ...expected });
  }
  return packages;
}

export function classifyReviewed(
  findings: CanonicalFinding[],
  provenance: Provenance,
): { resolved: number; unresolved: number } {
  let resolved = 0;
  // These independent artifacts inherit no Node/PostgreSQL finding exceptions.
  // An observed finding requires a separate exact source/span review before publication.
  if (
    provenance.profile &&
    (isRustProfile(provenance.profile) || provenance.profile === "talos-recipe")
  )
    return { resolved: 0, unresolved: findings.length };
  // The flattened PostgreSQL assembly has its own independent source-bound review.
  // Node and native-client exceptions never authorize PostgreSQL bytes.
  if (provenance.profile === "postgres" || provenance.profile === "storage") {
    const profileReview =
      provenance.profile === "storage" ? storageReview : postgresReview;
    const expectedBase =
      provenance.profile === "storage" ? storageBase : postgresBase;
    if (
      provenance.baseImage !== expectedBase ||
      profileReview.base.image !== expectedBase ||
      (provenance.profile === "storage" &&
        (JSON.stringify(provenance.baseDiffIDs) !==
          JSON.stringify(storageReview.base.diffIDs) ||
          storageReview.base.diffIDs.some(
            (digest, index) => provenance.imageDiffIDs[index] !== digest,
          )))
    )
      return { resolved, unresolved: findings.length };
    for (const finding of findings) {
      const input = finding.input;
      if (
        !Number.isSafeInteger(input.layer) ||
        input.layer === null ||
        input.layer < 0 ||
        input.layer >= provenance.imageDiffIDs.length ||
        !Number.isSafeInteger(input.tarEntry) ||
        input.tarEntry === null ||
        input.tarEntry < 0 ||
        typeof input.boundDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(input.boundDigest) ||
        provenance.imageDiffIDs[input.layer] !== input.boundDigest
      )
        continue;
      const file = profileReview.files.find(
        (file) =>
          input.kind === "layer-file" &&
          input.path === file.path &&
          input.sha256 === file.sha256 &&
          input.size === file.size,
      );
      if (
        !file ||
        finding.File !== file.path ||
        finding.Tags.length ||
        finding.Secret !== "REDACTED"
      )
        continue;
      if (
        provenance.profile === "storage" &&
        (input.layer !== storageReview.files[0]!.layer ||
          input.tarEntry !== storageReview.files[0]!.tarEntry ||
          input.boundDigest !== storageReview.files[0]!.boundDigest)
      )
        continue;
      if (
        file.findings.some(
          (entry) =>
            entry.rule === finding.RuleID &&
            entry.startLine === finding.StartLine &&
            entry.endLine === finding.EndLine &&
            entry.startColumn === finding.StartColumn &&
            entry.endColumn === finding.EndColumn &&
            entry.span.byteStart === finding.span?.byteStart &&
            entry.span.byteEndExclusive === finding.span.byteEndExclusive &&
            entry.span.size === finding.span.size &&
            entry.span.sha256 === finding.span.sha256,
        )
      )
        resolved++;
    }
    return { resolved, unresolved: findings.length - resolved };
  }
  const exactBase =
    provenance.baseImage === reviewedBase.image &&
    JSON.stringify(provenance.baseDiffIDs) ===
      JSON.stringify(reviewedBase.diffIDs) &&
    reviewedBase.diffIDs.every(
      (digest, index) => provenance.imageDiffIDs[index] === digest,
    );
  for (const finding of findings) {
    const input = finding.input;
    if (
      !Number.isSafeInteger(input.layer) ||
      input.layer === null ||
      input.layer < 0 ||
      input.layer >= provenance.imageDiffIDs.length ||
      !Number.isSafeInteger(input.tarEntry) ||
      input.tarEntry === null ||
      input.tarEntry < 0 ||
      typeof input.boundDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(input.boundDigest) ||
      provenance.imageDiffIDs[input.layer] !== input.boundDigest
    )
      continue;
    const file = reviewedFiles.find(
      (file) =>
        input.kind === "layer-file" &&
        input.path === file.path &&
        input.sha256 === file.sha256 &&
        input.size === file.size,
    );
    if (
      !file ||
      finding.File !== file.path ||
      finding.Tags.length ||
      finding.Secret !== "REDACTED"
    )
      continue;
    if (file.officialBaseMembership) {
      if (
        !exactBase ||
        file.layer === null ||
        input.layer !== file.layer ||
        input.tarEntry !== file.tarEntry ||
        input.boundDigest !== file.boundDigest ||
        file.layer >= reviewedBase.diffIDs.length
      )
        continue;
    } else if (file.nativeArtifact) {
      const expected = file.nativeArtifact;
      if (
        provenance.profile !== "node-bootstrap" ||
        !exactBase ||
        input.layer < provenance.baseDiffIDs.length ||
        !provenance.nativeArtifacts?.some((item) =>
          sameNativeArtifact(item, { path: file.path, ...expected }),
        )
      )
        continue;
    } else if (
      !file.package ||
      input.layer < provenance.baseDiffIDs.length ||
      !provenance.packages.some(
        (item) =>
          item.name === file.package!.name &&
          item.version === file.package!.version &&
          item.integrity === file.package!.integrity,
      )
    )
      continue;
    const matched = file.findings.some(
      (entry) =>
        entry.rule === finding.RuleID &&
        entry.startLine === finding.StartLine &&
        entry.endLine === finding.EndLine &&
        entry.startColumn === finding.StartColumn &&
        entry.endColumn === finding.EndColumn &&
        finding.span?.byteStart === entry.span.byteStart &&
        finding.span.byteEndExclusive === entry.span.byteEndExclusive &&
        finding.span.size === entry.span.size &&
        finding.span.sha256 === entry.span.sha256,
    );
    if (matched) resolved++;
  }
  return { resolved, unresolved: findings.length - resolved };
}
