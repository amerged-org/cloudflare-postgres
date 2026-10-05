// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  classifyReviewed,
  readPackageProvenance,
  reviewedFiles,
  reviewedBase,
  reviewedManifestPaths,
  imageProfile,
  verifyNativeArtifacts,
} from "./reviewed-findings.ts";
import type { CanonicalFinding } from "./scanner.ts";

function finding(file = reviewedFiles[0]!, index = 0): CanonicalFinding {
  const span = file.findings[index]!;
  assert.ok(file.boundDigest && file.layer !== null && file.tarEntry !== null);
  return {
    File: file.path,
    RuleID: span.rule,
    StartLine: span.startLine,
    EndLine: span.endLine,
    StartColumn: span.startColumn,
    EndColumn: span.endColumn,
    Match: "REDACTED",
    Secret: "REDACTED",
    Tags: [],
    input: {
      kind: "layer-file",
      layer: file.layer,
      tarEntry: file.tarEntry,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      boundDigest: file.boundDigest,
      sourcePath: "unused",
    },
    span: span.span,
  };
}
async function provenance() {
  const packages = readPackageProvenance(
    await readFile("pnpm-lock.yaml", "utf8"),
    [
      { name: "@types/node", version: "24.19.0" },
      { name: "@types/node", version: "26.6.3" },
    ],
  );
  return {
    baseImage: reviewedBase.image,
    baseDiffIDs: reviewedBase.diffIDs,
    imageDiffIDs: [
      ...reviewedBase.diffIDs,
      "sha256:" + "a".repeat(64),
      reviewedFiles.find((file) => !file.officialBaseMembership)!.boundDigest!,
    ],
    packages,
  };
}
test("resolves only the 26 independently reviewed spans across eight exact files", async () => {
  const legacy = reviewedFiles.filter((file) => !file.nativeArtifact);
  const values = legacy.flatMap((file) =>
    file.findings.map((_span, index) => finding(file, index)),
  );
  assert.equal(legacy.length, 8);
  assert.equal(classifyReviewed(values, await provenance()).resolved, 26);
  assert.equal(classifyReviewed(values, await provenance()).unresolved, 0);
});
test("a changed whole-file hash or size remains fatal", async () => {
  const value = finding();
  const proof = await provenance();
  assert.equal(
    classifyReviewed(
      [{ ...value, input: { ...value.input, sha256: "0".repeat(64) } }],
      proof,
    ).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [{ ...value, input: { ...value.input, size: value.input.size + 1 } }],
      proof,
    ).unresolved,
    1,
  );
});
test("a changed path or metadata kind remains fatal", async () => {
  const value = finding();
  const proof = await provenance();
  assert.equal(
    classifyReviewed(
      [{ ...value, input: { ...value.input, path: "app/value" } }],
      proof,
    ).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [{ ...value, input: { ...value.input, kind: "tar-metadata" } }],
      proof,
    ).unresolved,
    1,
  );
});
test("a changed rule, coordinate or decoded tag remains fatal", async () => {
  const value = finding();
  const proof = await provenance();
  assert.equal(
    classifyReviewed([{ ...value, RuleID: "other" }], proof).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed([{ ...value, EndColumn: value.EndColumn + 1 }], proof)
      .unresolved,
    1,
  );
  assert.equal(
    classifyReviewed([{ ...value, Tags: ["decoded:base64"] }], proof)
      .unresolved,
    1,
  );
});
test("a changed context byte hash or offset remains fatal", async () => {
  const value = finding();
  const proof = await provenance();
  assert.equal(
    classifyReviewed(
      [{ ...value, span: { ...value.span!, sha256: "0".repeat(64) } }],
      proof,
    ).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [
        {
          ...value,
          span: { ...value.span!, byteStart: value.span!.byteStart + 1 },
        },
      ],
      proof,
    ).unresolved,
    1,
  );
});
test("base classifications require the exact official prefix and entry binding", async () => {
  const value = finding();
  const proof = await provenance();
  assert.equal(
    classifyReviewed([value], { ...proof, baseImage: "node:changed" })
      .unresolved,
    1,
  );
  assert.equal(
    classifyReviewed([value], {
      ...proof,
      baseDiffIDs: [...proof.baseDiffIDs].reverse(),
    }).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [
        {
          ...value,
          input: { ...value.input, tarEntry: value.input.tarEntry! + 1 },
        },
      ],
      proof,
    ).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [
        {
          ...value,
          input: { ...value.input, boundDigest: "sha256:" + "0".repeat(64) },
        },
      ],
      proof,
    ).unresolved,
    1,
  );
});
test("application classifications require exact package identity and lock integrity", async () => {
  const value = finding(
    reviewedFiles.find((file) => !file.officialBaseMembership)!,
  );
  const proof = await provenance();
  assert.equal(
    classifyReviewed([value], { ...proof, packages: [] }).unresolved,
    1,
  );
  const lock = await readFile("pnpm-lock.yaml", "utf8");
  assert.throws(() =>
    readPackageProvenance(lock.replace("sha512-zY+", "sha512-XX+"), [
      { name: "@types/node", version: "24.19.0" },
      { name: "@types/node", version: "26.6.3" },
    ]),
  );
  assert.throws(() =>
    readPackageProvenance(lock, [{ name: "@types/node", version: "changed" }]),
  );
});
test("an additional finding in a reviewed file remains fatal", async () => {
  const value = finding();
  const proof = await provenance();
  const result = classifyReviewed(
    [value, { ...value, StartLine: value.StartLine + 1 }],
    proof,
  );
  assert.deepEqual(result, { resolved: 1, unresolved: 1 });
});

test("repacked application layers retain only the six exact package-proven spans", async () => {
  const proof = await provenance();
  const digest = "sha256:" + "e".repeat(64);
  const values = reviewedFiles
    .filter((file) => file.package)
    .flatMap((file) =>
      file.findings.map((_span, index) => {
        const value = finding(file, index);
        return {
          ...value,
          input: {
            ...value.input,
            layer: 7,
            tarEntry: value.input.tarEntry! + 19,
            boundDigest: digest,
          },
        };
      }),
    );
  const repacked = { ...proof, imageDiffIDs: [...proof.imageDiffIDs, digest] };
  assert.deepEqual(classifyReviewed(values, repacked), {
    resolved: 6,
    unresolved: 0,
  });
  assert.deepEqual(
    classifyReviewed(
      [...values, { ...values[0]!, StartLine: values[0]!.StartLine + 1 }],
      repacked,
    ),
    { resolved: 6, unresolved: 1 },
  );
  assert.equal(
    classifyReviewed(
      [
        {
          ...values[0]!,
          input: {
            ...values[0]!.input,
            boundDigest: "sha256:" + "f".repeat(64),
          },
        },
      ],
      repacked,
    ).unresolved,
    1,
  );
});

test("bootstrap resolves exactly the thirty-one source-reviewed native spans and rejects an additional finding", async () => {
  const native = reviewedFiles.filter((file) => file.nativeArtifact);
  assert.equal(native.length, 3);
  const values = native.flatMap((file) =>
    file.findings.map((_span, index) => {
      const value = finding(file, index);
      return {
        ...value,
        input: { ...value.input, boundDigest: native[0]!.boundDigest! },
      };
    }),
  );
  assert.equal(values.length, 31);
  const proof = {
    ...(await provenance()),
    profile: "node-bootstrap" as const,
    imageDiffIDs: [
      ...reviewedBase.diffIDs,
      "sha256:" + "a".repeat(64),
      "sha256:" + "b".repeat(64),
      native[0]!.boundDigest!,
    ],
    nativeArtifacts: native.map((file) => ({
      path: file.path,
      ...file.nativeArtifact!,
    })),
  };
  assert.deepEqual(classifyReviewed(values, proof), {
    resolved: 31,
    unresolved: 0,
  });
  assert.deepEqual(
    classifyReviewed(
      [...values, { ...values[0]!, RuleID: "unreviewed-native" }],
      proof,
    ),
    { resolved: 31, unresolved: 1 },
  );
});

test("Helm resolves only twelve exact pinned public Go checksum spans and rejects changed bytes or another finding", async () => {
  const helm = reviewedFiles.find(
    (file) => file.path === "usr/local/bin/helm",
  )!;
  assert.equal(helm.findings.length, 12);
  const values = helm.findings.map((_span, index) => finding(helm, index));
  const native = reviewedFiles.filter((file) => file.nativeArtifact);
  const proof = {
    ...(await provenance()),
    profile: "node-bootstrap" as const,
    imageDiffIDs: [
      ...reviewedBase.diffIDs,
      "sha256:" + "a".repeat(64),
      "sha256:" + "b".repeat(64),
      helm.boundDigest!,
    ],
    nativeArtifacts: verifyNativeArtifacts(native, "node-bootstrap"),
  };
  assert.deepEqual(classifyReviewed(values, proof), {
    resolved: 12,
    unresolved: 0,
  });
  assert.equal(
    classifyReviewed(
      [
        {
          ...values[0]!,
          span: { ...values[0]!.span!, sha256: "0".repeat(64) },
        },
      ],
      proof,
    ).unresolved,
    1,
  );
  assert.deepEqual(
    classifyReviewed(
      [...values, { ...values[0]!, StartLine: values[0]!.StartLine + 1 }],
      proof,
    ),
    { resolved: 12, unresolved: 1 },
  );
  for (const value of helm.findings) {
    assert.equal(
      value.classification,
      "go_dependency_artifact_checksum_metadata",
    );
    assert.ok("sourceProof" in value);
    const source = value.sourceProof;
    assert.ok(
      source &&
        "sourceUrl" in source &&
        "sourceSha256" in source &&
        "compilerMetadataDuplicateVerified" in source,
    );
    assert.equal(
      source.sourceUrl,
      "https://raw.githubusercontent.com/helm/helm/bec5b06ed841fe5269972d864d5177944fd5970f/go.sum",
    );
    assert.equal(
      source.sourceSha256,
      "e7105c82ef112e8ebb0fa2e02295b814ab6b85d404a947908c3dd999bd0b9909",
    );
    assert.equal(source.compilerMetadataDuplicateVerified, true);
  }
});

test("native spans require the bootstrap profile and exact public-artifact provenance", async () => {
  const native = reviewedFiles.filter((file) => file.nativeArtifact),
    value = finding(native[0]!);
  const artifacts = verifyNativeArtifacts(native, "node-bootstrap"),
    proof = {
      ...(await provenance()),
      profile: "node-bootstrap" as const,
      imageDiffIDs: [
        ...reviewedBase.diffIDs,
        "sha256:" + "a".repeat(64),
        "sha256:" + "b".repeat(64),
        native[0]!.boundDigest!,
      ],
      nativeArtifacts: artifacts,
    };
  assert.equal(
    classifyReviewed([value], { ...proof, profile: "regional" }).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed([value], { ...proof, nativeArtifacts: [] }).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed([value], {
      ...proof,
      nativeArtifacts: artifacts.map((item) => ({
        ...item,
        releaseUrl: "https://github.com/public/changed",
      })),
    }).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed([value], {
      ...proof,
      baseDiffIDs: [...proof.baseDiffIDs].reverse(),
    }).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [{ ...value, input: { ...value.input, sha256: "0".repeat(64) } }],
      proof,
    ).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [{ ...value, span: { ...value.span!, sha256: "0".repeat(64) } }],
      proof,
    ).unresolved,
    1,
  );
  assert.equal(
    classifyReviewed(
      [
        {
          ...value,
          span: { ...value.span!, byteStart: value.span!.byteStart + 1 },
        },
      ],
      proof,
    ).unresolved,
    1,
  );
});

test("all three native whole-file identities are mandatory even without scanner findings", () => {
  const native = reviewedFiles.filter((file) => file.nativeArtifact);
  assert.equal(verifyNativeArtifacts(native, "node-bootstrap").length, 3);
  assert.ok(native.some((file) => file.path === "usr/local/bin/helm"));
  assert.throws(() =>
    verifyNativeArtifacts(
      native.filter((file) => file.path !== "usr/local/bin/helm"),
      "node-bootstrap",
    ),
  );
  assert.throws(() =>
    verifyNativeArtifacts(native.slice(0, 1), "node-bootstrap"),
  );
  assert.throws(() =>
    verifyNativeArtifacts(
      native.map((file) => ({ ...file, sha256: "0".repeat(64) })),
      "node-bootstrap",
    ),
  );
  assert.throws(() =>
    verifyNativeArtifacts(
      native.map((file) => ({ ...file, size: file.size + 1 })),
      "node-bootstrap",
    ),
  );
  assert.throws(() =>
    verifyNativeArtifacts(
      [...native, { ...native[0]!, sha256: "0".repeat(64) }],
      "node-bootstrap",
    ),
  );
  assert.deepEqual(verifyNativeArtifacts(native, "regional"), []);
});

test("only the explicit bootstrap profile permits proven absent reviewed runtime packages", async () => {
  assert.equal(imageProfile(), "regional");
  assert.throws(() => imageProfile("other"));
  assert.throws(() => imageProfile(null));
  assert.deepEqual(reviewedManifestPaths([], "node-bootstrap"), []);
  assert.throws(() =>
    reviewedManifestPaths(
      ["app/node_modules/@kubernetes/client-node/package.json"],
      "node-bootstrap",
    ),
  );
  assert.throws(() => reviewedManifestPaths([], "regional"));
  const file = reviewedFiles.find((file) => file.package)!,
    manifest = file.path.replace(/https\.d\.ts$/, "package.json");
  assert.throws(() => reviewedManifestPaths([file.path], "node-bootstrap"));
  assert.deepEqual(
    reviewedManifestPaths([file.path, manifest], "node-bootstrap"),
    [manifest],
  );
  const lock = await readFile("pnpm-lock.yaml", "utf8");
  assert.deepEqual(readPackageProvenance(lock, [], "node-bootstrap"), []);
  assert.throws(() =>
    readPackageProvenance(
      lock,
      [{ name: file.package!.name, version: "changed" }],
      "node-bootstrap",
    ),
  );
  assert.throws(() => readPackageProvenance(lock, [], "regional"));
  assert.throws(() =>
    readPackageProvenance(
      lock.replace(file.package!.integrity, "changed"),
      [{ name: file.package!.name, version: file.package!.version }],
      "node-bootstrap",
    ),
  );
});

test("bootstrap subset provenance never waives a shipped package or a new finding", async () => {
  const file = reviewedFiles.find((file) => file.package)!,
    value = finding(file),
    proof = await provenance();
  assert.deepEqual(classifyReviewed([value], { ...proof, packages: [] }), {
    resolved: 0,
    unresolved: 1,
  });
  const lock = await readFile("pnpm-lock.yaml", "utf8"),
    packages = readPackageProvenance(
      lock,
      [{ name: file.package!.name, version: file.package!.version }],
      "node-bootstrap",
    );
  assert.deepEqual(classifyReviewed([value], { ...proof, packages }), {
    resolved: 1,
    unresolved: 0,
  });
  assert.deepEqual(
    classifyReviewed([{ ...value, RuleID: "new-unreviewed" }], {
      ...proof,
      packages,
    }),
    { resolved: 0, unresolved: 1 },
  );
});
