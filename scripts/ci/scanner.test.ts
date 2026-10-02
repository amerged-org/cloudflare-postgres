// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import tar from "tar-stream";
import {
  opaquePrefix,
  prepareInputs,
  runPass,
  mapFindings,
  metadataInputs,
  validateCompletion,
  type ScanInput,
} from "./scanner.ts";
import { installScanner, readLayerArchive } from "./image-qualification.ts";

let directory: string;
let scanner: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pgcf-scanner-test-"));
  scanner = await installScanner(directory);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const credential = () =>
  String.fromCharCode(103, 104, 112, 95) +
  createHash("sha256").update("fixture").digest("hex").slice(0, 36);
let serial = 0;
async function input(
  bytes: Buffer,
  path = "app/value",
  kind: ScanInput["kind"] = "layer-file",
): Promise<ScanInput> {
  const sourcePath = join(directory, `source-${serial++}`);
  await writeFile(sourcePath, bytes, { mode: 0o600, flag: "wx" });
  return {
    kind,
    layer: 0,
    tarEntry: serial,
    path,
    sourcePath,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
async function scan(value: ScanInput, pass: "opaque" | "family" = "opaque") {
  const work = await mkdtemp(join(directory, "pass-"));
  const prepared = await prepareInputs([value], work);
  return {
    prepared,
    result: await runPass(scanner, prepared[pass], work, pass),
  };
}

test("opaque aliases retain bytes from excluded dependency paths", async () => {
  const value = await input(
    Buffer.from(credential()),
    "node_modules/package/package-lock.json",
  );
  const { result } = await scan(value);
  assert.equal(result.findings.length, 1);
  assert.equal(result.detectorBytes, value.size + 32775);
});
test("opaque aliases force ELF bytes into the unchanged detector", async () => {
  const bytes = Buffer.concat([
    Buffer.from([127, 69, 76, 70]),
    Buffer.from("\n" + credential()),
  ]);
  const { result } = await scan(await input(bytes, "app/module.bin"));
  assert.equal(result.findings.length, 1);
  assert.equal(result.detectorBytes, bytes.length + 32775);
});
test("opaque aliases force PDF bytes into the unchanged detector", async () => {
  const bytes = Buffer.from("%PDF-1.7\n" + credential());
  const { result } = await scan(await input(bytes, "app/value.pdf"));
  assert.equal(result.findings.length, 1);
  assert.equal(result.detectorBytes, bytes.length + 32775);
});
test("opaque aliases force ZIP magic bytes into the unchanged detector", async () => {
  const bytes = Buffer.concat([
    Buffer.from([80, 75, 3, 4]),
    Buffer.from("\n" + credential()),
  ]);
  const { result } = await scan(await input(bytes, "app/value.zip"));
  assert.equal(result.findings.length, 1);
  assert.equal(result.detectorBytes, bytes.length + 32775);
});
test("PHP aliases retain Freemius filename detection", async () => {
  const value = await input(
    Buffer.from(
      "<?php 'secret_key' => '" +
        String.fromCharCode(115, 107, 95) +
        createHash("sha256").update("fixture").digest("hex").slice(0, 29) +
        "';",
    ),
    "vendor/value.php",
  );
  const { result } = await scan(value, "family");
  assert.ok(
    result.findings.some((finding) => finding.RuleID === "freemius-secret-key"),
  );
});
test("HCL aliases retain Terraform password detection", async () => {
  const value = await input(
    Buffer.from(
      'password = "' +
        createHash("sha256").update("fixture").digest("hex").slice(0, 16) +
        '"',
    ),
    "vendor/value.hcl",
  );
  const { result } = await scan(value, "family");
  assert.ok(
    result.findings.some(
      (finding) => finding.RuleID === "hashicorp-tf-password",
    ),
  );
});
test("YAML aliases retain Kubernetes secret detection", async () => {
  const value = await input(
    Buffer.from(
      "kind: Secret\ndata:\n  password: " +
        Buffer.from(credential()).toString("base64") +
        "\n",
    ),
    "vendor/value.yaml",
  );
  const { result } = await scan(value, "family");
  assert.ok(
    result.findings.some(
      (finding) => finding.RuleID === "kubernetes-secret-yaml",
    ),
  );
});
test("NuGet aliases retain password detection", async () => {
  const value = await input(
    Buffer.from(
      '<add key="ClearTextPassword" value="' +
        createHash("sha256").update("fixture").digest("hex") +
        '" />',
    ),
    "vendor/nuget.config",
  );
  const { result } = await scan(value, "family");
  assert.ok(
    result.findings.some(
      (finding) => finding.RuleID === "nuget-config-password",
    ),
  );
});
test("PKCS12 aliases retain filename-only detection", async () => {
  const { result } = await scan(
    await input(Buffer.from("public"), "vendor/value.p12"),
    "family",
  );
  assert.ok(
    result.findings.some((finding) => finding.RuleID === "pkcs12-file"),
  );
});
test("inline suppression cannot hide shipped credentials", async () => {
  const { result } = await scan(
    await input(Buffer.from(credential() + " // gitleaks:allow")),
  );
  assert.equal(result.findings.length, 1);
});
test("bound config Env, Labels and history strings are scanned after JSON decoding", async () => {
  const bytes = Buffer.from(
    JSON.stringify({
      config: { Env: [credential()], Labels: { value: credential() } },
      history: [{ created_by: credential() }],
    }).replaceAll("g", "\\u0067"),
  );
  const values = await metadataInputs(
    bytes,
    "image-config",
    directory,
    "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(
    values.filter(
      (value) =>
        value.kind === "metadata-string" && !value.path.endsWith("#key"),
    ).length,
    3,
  );
  const work = await mkdtemp(join(directory, "metadata-"));
  const prepared = await prepareInputs(values, work);
  const result = await runPass(scanner, prepared.opaque, work, "metadata");
  assert.ok(result.findings.length >= 3);
});
test("missing alias files and unreadable diagnostics fail closed", async () => {
  const value = await input(Buffer.from(credential()));
  const work = await mkdtemp(join(directory, "missing-"));
  const prepared = await prepareInputs([value], work);
  await rm(prepared.opaque.aliases[0]!.diskPath);
  await assert.rejects(runPass(scanner, prepared.opaque, work, "missing"));
  assert.throws(() =>
    validateCompletion(
      "1:00PM WRN permission denied\n1:00PM INF scanned ~0 bytes (0) in 1ms\n1:00PM INF no leaks found\n",
      56,
      0,
      0,
    ),
  );
});
test("an unreadable opaque file cannot produce a successful qualification", async () => {
  const value = await input(Buffer.from(credential()));
  const work = await mkdtemp(join(directory, "unreadable-"));
  const prepared = await prepareInputs([value], work);
  const path = prepared.opaque.aliases[0]!.diskPath;
  await chmod(path, 0);
  try {
    await assert.rejects(runPass(scanner, prepared.opaque, work, "unreadable"));
  } finally {
    await chmod(path, 0o600);
  }
});
test("partial completion and mismatched detector bytes fail closed", () => {
  assert.throws(() =>
    validateCompletion("1:00PM WRN partial scan completed in 1ms\n", 10, 0, 0),
  );
  assert.throws(() =>
    validateCompletion(
      "1:00PM INF scanned ~9 bytes (9 bytes) in 1ms\n1:00PM INF no leaks found\n",
      10,
      0,
      0,
    ),
  );
});
test("empty and duplicate entries each receive a separate lossless opaque alias", async () => {
  const value = await input(Buffer.alloc(0));
  const other = { ...value, tarEntry: value.tarEntry! + 1 };
  const work = await mkdtemp(join(directory, "empty-"));
  const prepared = await prepareInputs([value, other], work);
  assert.equal(prepared.opaque.expectedBytes, 2 * 32775);
  assert.equal(prepared.opaque.aliases.length, 2);
  assert.deepEqual(
    await readFile(prepared.opaque.aliases[0]!.diskPath),
    opaquePrefix,
  );
  const result = await runPass(scanner, prepared.opaque, work, "empty");
  assert.equal(result.detectorBytes, 2 * 32775);
});
test("truncated gzip errors reject normally and remove decompression scratch", async () => {
  const work = await mkdtemp(join(directory, "gzip-"));
  const path = join(work, "input.gz");
  await writeFile(path, gzipSync(Buffer.alloc(1024)).subarray(0, 12), {
    mode: 0o600,
  });
  await assert.rejects(
    readLayerArchive(path, work, 0, "sha256:" + "0".repeat(64)),
  );
  assert.deepEqual(await readdir(work), ["input.gz"]);
});
test("shipped tar header, PAX and link text bytes are scanned and bound to their layer", async () => {
  const work = await mkdtemp(join(directory, "tar-text-"));
  const pack = tar.pack();
  pack.entry({
    name: "link",
    type: "symlink",
    linkname: credential(),
    pax: { comment: credential() },
  });
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(pack))
    chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const path = join(work, "layer.tar");
  await writeFile(path, bytes, { mode: 0o600 });
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const extracted = await readLayerArchive(path, work, 0, digest);
  assert.equal(extracted.files.length, 0);
  assert.equal(extracted.metadata.size, bytes.length);
  assert.equal(extracted.metadata.boundDigest, digest);
  const { result } = await scan(extracted.metadata);
  assert.ok(result.findings.length >= 2);
});
test("raw redacted Match context never appears in the safe scan result", async () => {
  const { result } = await scan(
    await input(Buffer.from(credential() + " " + credential())),
  );
  assert.ok(result.findings.length > 0);
  assert.ok(!JSON.stringify(result.safe).includes(credential()));
  assert.ok(!JSON.stringify(result.safe).includes("Match"));
});
test("canonical mapping rejects prefix, out-of-bounds and unknown aliases and deduplicates decoded tags", async () => {
  const value = await input(Buffer.from(credential()));
  const { prepared, result } = await scan(value);
  const finding = result.findings[0]!;
  assert.equal(
    finding.StartLine,
    2,
    JSON.stringify([
      finding.StartLine,
      finding.EndLine,
      finding.StartColumn,
      finding.EndColumn,
    ]),
  );
  const mapped = await mapFindings([finding, finding], prepared.opaque.aliases);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]!.StartColumn, 1);
  assert.equal(mapped[0]!.EndColumn, value.size);
  await assert.rejects(
    mapFindings([{ ...finding, StartLine: 1 }], prepared.opaque.aliases),
  );
  await assert.rejects(
    mapFindings(
      [{ ...finding, EndColumn: finding.EndColumn + 1 }],
      prepared.opaque.aliases,
    ),
  );
  await assert.rejects(
    mapFindings([{ ...finding, File: "unknown" }], prepared.opaque.aliases),
  );
  const tagged = await mapFindings(
    [{ ...finding, Tags: ["decoded:base64"] }],
    prepared.opaque.aliases,
  );
  assert.deepEqual(tagged[0]!.Tags, ["decoded:base64"]);
});
