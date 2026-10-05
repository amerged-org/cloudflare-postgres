// SPDX-License-Identifier: Apache-2.0
import review from "./reviewed-findings.json" with { type: "json" };
import type { CanonicalFinding } from "./scanner.ts";

export const reviewedFiles = review.files;
export const reviewedBase = review.base;
export type ImageProfile = "regional" | "node-bootstrap";
export function imageProfile(value: unknown = "regional"): ImageProfile {
  if (value !== "regional" && value !== "node-bootstrap")
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
  if (native.length !== 2) throw new Error("Native artifact review incomplete");
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
  baseImage: string;
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
