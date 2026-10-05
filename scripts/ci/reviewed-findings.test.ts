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
} from "./reviewed-findings.ts";
import type { CanonicalFinding } from "./scanner.ts";

function finding(file = reviewedFiles[0]!, index = 0): CanonicalFinding {
  const span = file.findings[index]!;
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
      reviewedFiles.find((file) => !file.officialBaseMembership)!.boundDigest,
    ],
    packages,
  };
}
test("resolves only the 26 independently reviewed spans across eight exact files", async () => {
  const values = reviewedFiles.flatMap((file) =>
    file.findings.map((_span, index) => finding(file, index)),
  );
  assert.equal(reviewedFiles.length, 8);
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
    .filter((file) => !file.officialBaseMembership)
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
