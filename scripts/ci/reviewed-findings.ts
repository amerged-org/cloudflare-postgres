// SPDX-License-Identifier: Apache-2.0
import review from "./reviewed-findings.json" with { type: "json" };
import type { CanonicalFinding } from "./scanner.ts";

export const reviewedFiles = review.files;
export const reviewedBase = review.base;
interface PackageProvenance {
  name: string;
  version: string;
  integrity: string;
}
interface Provenance {
  baseImage: string;
  baseDiffIDs: string[];
  imageDiffIDs: string[];
  packages: PackageProvenance[];
}

export function readPackageProvenance(
  lock: string,
  manifests: { name: string; version: string }[],
): PackageProvenance[] {
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
    )
      throw new Error("Reviewed package manifest provenance changed");
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
    const file = reviewedFiles.find(
      (file) =>
        input.kind === "layer-file" &&
        input.path === file.path &&
        input.layer === file.layer &&
        input.tarEntry === file.tarEntry &&
        input.boundDigest === file.boundDigest &&
        input.sha256 === file.sha256 &&
        input.size === file.size,
    );
    if (
      !file ||
      finding.File !== file.path ||
      finding.Tags.length ||
      finding.Secret !== "REDACTED" ||
      provenance.imageDiffIDs[file.layer] !== file.boundDigest
    )
      continue;
    if (file.officialBaseMembership) {
      if (!exactBase || file.layer >= reviewedBase.diffIDs.length) continue;
    } else if (
      !file.package ||
      file.layer < provenance.baseDiffIDs.length ||
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
