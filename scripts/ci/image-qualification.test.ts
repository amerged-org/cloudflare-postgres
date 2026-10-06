// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import tar from "tar-stream";
import {
  safeArchivePath,
  extractLayer,
  validateBasePrefix,
  classifyFindings,
  assertScanResult,
  validateImageIdentity,
  validateManifestBinding,
  parseQualificationArguments,
  validateDockerfile,
  runtimeChecks,
  validateRuntimeResult,
} from "./image-qualification.ts";
import {
  reviewedBase,
  postgresBase,
  reviewedFiles,
  reviewedManifestPaths,
  verifyNativeArtifacts,
} from "./reviewed-findings.ts";

test("PostgreSQL qualification binds its own upstream and cannot inherit Node reviews", () => {
  assert.deepEqual(
    parseQualificationArguments(["--profile", "postgres", "runtime", "image"]),
    {
      profile: "postgres",
      args: ["runtime", "image"],
    },
  );
  assert.equal(
    validateDockerfile(
      `FROM ${postgresBase} AS postgres\nFROM scratch\n`,
      "postgres",
    ),
    postgresBase,
  );
  assert.throws(() =>
    validateDockerfile(
      `FROM ${postgresBase} AS postgres\nFROM scratch\nFROM scratch\n`,
      "postgres",
    ),
  );
  assert.throws(() =>
    validateDockerfile(`FROM ${reviewedBase.image}\n`, "postgres"),
  );
  assert.deepEqual(reviewedManifestPaths([], "postgres"), []);
  assert.throws(() =>
    reviewedManifestPaths(["app/node_modules/package.json"], "postgres"),
  );
  const check = runtimeChecks("postgres")[0]!;
  assert.equal(check.entrypoint, "/usr/lib/postgresql/18/bin/postgres");
  assert.doesNotThrow(() =>
    validateRuntimeResult(check, {
      exit: 0,
      stdout: "postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)",
      stderr: "",
    }),
  );
  assert.throws(() =>
    validateRuntimeResult(check, {
      exit: 0,
      stdout: "postgres (PostgreSQL) 18.4",
      stderr: "",
    }),
  );
});

test("qualification profiles default to regional and reject ambiguous or malformed options", () => {
  assert.deepEqual(
    parseQualificationArguments(["runtime", "fixture:qualified"]),
    { profile: "regional", args: ["runtime", "fixture:qualified"] },
  );
  assert.deepEqual(
    parseQualificationArguments([
      "runtime",
      "fixture:qualified",
      "--profile",
      "node-bootstrap",
    ]),
    { profile: "node-bootstrap", args: ["runtime", "fixture:qualified"] },
  );
  assert.throws(() => parseQualificationArguments(["runtime", "--profile"]));
  assert.throws(() =>
    parseQualificationArguments(["runtime", "--profile", "other"]),
  );
  assert.throws(() =>
    parseQualificationArguments([
      "--profile",
      "regional",
      "--profile",
      "node-bootstrap",
    ]),
  );
  assert.throws(() =>
    parseQualificationArguments(["runtime", "--profile=node-bootstrap"]),
  );
});

test("the single CI workflow qualifies all three image profiles before independent publication", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8"),
    regional = workflow
      .split("\n  image:\n")[1]!
      .split("\n  node_bootstrap_image:\n")[0]!,
    bootstrap = workflow
      .split("\n  node_bootstrap_image:\n")[1]!
      .split("\n  postgres_image:\n")[0]!,
    postgres = workflow
      .split("\n  postgres_image:\n")[1]!
      .split("\n  external_probe:\n")[0]!;
  assert.match(regional, /IMAGE: ghcr\.io\/amerged-org\/pgcf-regional/);
  assert.match(bootstrap, /IMAGE: ghcr\.io\/amerged-org\/pgcf-node-bootstrap/);
  assert.match(bootstrap, /--file apps\/node-bootstrap\/Dockerfile/);
  assert.match(bootstrap, /needs: check/);
  assert.doesNotMatch(bootstrap, /matrix:/);
  const actions = [
    ...bootstrap.matchAll(
      /image-qualification\.ts --profile node-bootstrap (\w+)/g,
    ),
  ].map((match) => match[1]!);
  assert.deepEqual([...new Set(actions)].sort(), [
    "promote",
    "qualify",
    "registry",
    "runtime",
    "verify",
  ]);
  assert.ok(
    bootstrap.indexOf("--profile node-bootstrap qualify") <
      bootstrap.indexOf("docker push"),
  );
  assert.ok(
    bootstrap.indexOf("--profile node-bootstrap verify") <
      bootstrap.indexOf("docker push"),
  );
  assert.ok(
    bootstrap.indexOf("--profile node-bootstrap registry") <
      bootstrap.indexOf("--profile node-bootstrap promote"),
  );
  assert.match(regional, /--profile regional runtime/);
  assert.match(postgres, /IMAGE: ghcr\.io\/amerged-org\/pgcf-postgres/);
  assert.match(postgres, /--file infra\/postgres\/Dockerfile/);
  assert.match(postgres, /node --test infra\/postgres\/image\.test\.mjs/);
  assert.match(postgres, /needs: check/);
  assert.doesNotMatch(postgres, /matrix:/);
  const postgresActions = [
    ...postgres.matchAll(/image-qualification\.ts --profile postgres (\w+)/g),
  ].map((match) => match[1]!);
  assert.deepEqual([...new Set(postgresActions)].sort(), [
    "promote",
    "qualify",
    "registry",
    "runtime",
    "verify",
  ]);
  assert.ok(
    postgres.indexOf("--profile postgres qualify") <
      postgres.indexOf("docker push"),
  );
  assert.ok(
    postgres.indexOf("--profile postgres verify") <
      postgres.indexOf("docker push"),
  );
  assert.ok(
    postgres.indexOf("--profile postgres registry") <
      postgres.indexOf("--profile postgres promote"),
  );
});

test("Dockerfile profiles bind every FROM and the exact pinned stage topology", () => {
  const regional = `FROM ${reviewedBase.image} AS build\nFROM ${reviewedBase.image}\n`,
    bootstrap = `FROM ${reviewedBase.image} AS build\nFROM ${reviewedBase.image} AS clients\nFROM ${reviewedBase.image}\n`;
  assert.equal(validateDockerfile(regional, "regional"), reviewedBase.image);
  assert.equal(
    validateDockerfile(bootstrap, "node-bootstrap"),
    reviewedBase.image,
  );
  assert.throws(() => validateDockerfile(regional, "node-bootstrap"));
  assert.throws(() => validateDockerfile(bootstrap, "regional"));
  assert.throws(() =>
    validateDockerfile(regional + "FROM scratch\n", "regional"),
  );
  assert.throws(() =>
    validateDockerfile(
      bootstrap.replace("AS clients", "AS other"),
      "node-bootstrap",
    ),
  );
  assert.throws(() =>
    validateDockerfile(
      regional.replace(reviewedBase.image, "node:24-slim"),
      "regional",
    ),
  );
});

test("runtime profiles invoke every shipped entry and exact native client version checks", () => {
  const regional = runtimeChecks("regional"),
    bootstrap = runtimeChecks("node-bootstrap");
  assert.ok(
    regional.some((check) => check.args[0] === "/app/bootstrap-relay.mjs"),
  );
  assert.ok(bootstrap.some((check) => check.args[0] === "/app/server.mjs"));
  assert.ok(
    bootstrap.some((check) => check.args[0] === "/app/proxy-command.mjs"),
  );
  assert.ok(
    bootstrap.some(
      (check) =>
        check.stage === "runtime_bootstrap_modules" &&
        check.args.join(" ").includes("import('/app/server.mjs')") &&
        check.args.join(" ").includes("import('/app/proxy-command.mjs')"),
    ),
  );
  const talos = bootstrap.find((check) => check.entrypoint === "talosctl")!;
  assert.deepEqual(talos.args, ["version", "--client"]);
  assert.doesNotThrow(() =>
    validateRuntimeResult(talos, {
      exit: 0,
      stdout: "Client:\n\tTag: v1.14.1\n\tOS/Arch: linux/amd64\n",
      stderr: "",
    }),
  );
  assert.throws(() =>
    validateRuntimeResult(talos, {
      exit: 0,
      stdout: "Client:\n\tTag: v1.14.0\n\tOS/Arch: linux/amd64\n",
      stderr: "",
    }),
  );
  const kube = bootstrap.find((check) => check.entrypoint === "kubectl")!;
  assert.deepEqual(kube.args, ["version", "--client=true", "-o=json"]);
  const helm = bootstrap.find((check) => check.entrypoint === "helm")!;
  assert.ok(helm, "The shipped installer Helm client must be qualified");
  assert.doesNotThrow(() =>
    validateRuntimeResult(helm, { exit: 0, stdout: "v4.3.0", stderr: "" }),
  );
  assert.throws(() =>
    validateRuntimeResult(helm, { exit: 0, stdout: "v4.2.0", stderr: "" }),
  );
  assert.doesNotThrow(() =>
    validateRuntimeResult(kube, {
      exit: 0,
      stdout: JSON.stringify({
        clientVersion: { gitVersion: "v1.36.5", platform: "linux/amd64" },
      }),
      stderr: "",
    }),
  );
  assert.throws(() =>
    validateRuntimeResult(kube, {
      exit: 0,
      stdout: JSON.stringify({
        clientVersion: { gitVersion: "v1.36.5", platform: "linux/arm64" },
      }),
      stderr: "",
    }),
  );
  assert.ok(
    bootstrap.some(
      (check) => check.entrypoint === "ssh" && check.args[0] === "-V",
    ),
  );
  const server = bootstrap.find(
    (check) => check.stage === "runtime_bootstrap_server",
  )!;
  assert.doesNotThrow(() =>
    validateRuntimeResult(server, {
      exit: 1,
      stdout: "",
      stderr:
        JSON.stringify({ event: "bootstrap_invalid_configuration" }) + "\n",
    }),
  );
  assert.throws(() =>
    validateRuntimeResult(server, {
      exit: 1,
      stdout: "",
      stderr: "uncaught exception stack",
    }),
  );
});

test("rejects archive traversal, ambiguous paths and link writes", async () => {
  for (const name of [
    "/outside",
    "../outside",
    "a/../b",
    "a//b",
    "a\\b",
    "a\0b",
  ])
    assert.throws(() => safeArchivePath(name));
  assert.equal(
    safeArchivePath("./usr/local/include/node/v8-internal.h"),
    "usr/local/include/node/v8-internal.h",
  );
  const pack = tar.pack();
  pack.entry({ name: "link", type: "symlink", linkname: "../../outside" });
  pack.entry({ name: "link/value" }, "public");
  pack.finalize();
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    await assert.rejects(
      extractLayer(Readable.from(pack), directory, 0),
      /link/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains every regular entry even when later entries overwrite or whiteout it", async () => {
  const pack = tar.pack();
  pack.entry({ name: "./", type: "directory" });
  pack.entry({ name: "app/value" }, "first");
  pack.entry({ name: "app/value" }, "second");
  pack.entry({ name: "app/.wh.value" }, "");
  pack.finalize();
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    const files = await extractLayer(Readable.from(pack), directory, 0);
    assert.equal(files.length, 3);
    assert.equal(
      await readFile(join(directory, files[0]!.scanPath), "utf8"),
      "first",
    );
    assert.equal(
      await readFile(join(directory, files[1]!.scanPath), "utf8"),
      "second",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on malformed or truncated layer archives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    await assert.rejects(
      extractLayer(Readable.from([Buffer.alloc(10)]), directory, 0),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap package absence cannot be inferred from link-only package roots", async () => {
  const file = reviewedFiles.find((file) => file.package)!,
    root = file.path.slice(0, file.path.lastIndexOf("/")),
    pack = tar.pack(),
    paths: string[] = [];
  pack.entry({ name: root, type: "symlink", linkname: "elsewhere" });
  pack.finalize();
  const directory = await mkdtemp(join(tmpdir(), "pgcf-layer-test-"));
  try {
    await extractLayer(Readable.from(pack), directory, 0, paths);
    assert.throws(() => reviewedManifestPaths(paths, "node-bootstrap"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires the pinned official base diffIDs as an exact ordered prefix", () => {
  const base = ["sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)];
  assert.doesNotThrow(() =>
    validateBasePrefix([...base, "sha256:" + "c".repeat(64)], base),
  );
  assert.throws(() => validateBasePrefix([base[1]!, base[0]!], base));
  assert.throws(() => validateBasePrefix([base[0]!], base));
  assert.throws(() => validateBasePrefix(base, []));
});

test("binds config digest and source/revision labels to the exact built image", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: ["sha256:" + "a".repeat(64)] },
      config: {
        Labels: {
          "org.opencontainers.image.source":
            "https://github.com/public/product",
          "org.opencontainers.image.revision": "a".repeat(40),
        },
      },
    }),
  );
  const imageId = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() =>
    validateImageIdentity(
      bytes,
      imageId,
      "a".repeat(40),
      "https://github.com/public/product",
    ),
  );
  assert.throws(() =>
    validateImageIdentity(
      bytes,
      imageId,
      "b".repeat(40),
      "https://github.com/public/product",
    ),
  );
  assert.throws(() =>
    validateImageIdentity(
      bytes,
      imageId,
      "a".repeat(40),
      "https://github.com/public/other",
    ),
  );
  assert.throws(() =>
    validateImageIdentity(
      bytes,
      "sha256:" + "0".repeat(64),
      "a".repeat(40),
      "https://github.com/public/product",
    ),
  );
});

test("only resolves the exact verified official Node public integer finding", () => {
  const file = {
    scanPath: "0/0",
    path: "usr/local/include/node/v8-internal.h",
    layer: 0,
    sha256: "eb74fc0740b7f858a03e319e077c1698d2083325f3154c67771b120fb48f8520",
    size: 70804,
    publicLine: [
      "const int ",
      "kApiTaggedSize",
      " = ",
      "kApiInt32Size",
      ";",
    ].join(""),
  };
  const finding = {
    File: "0/0",
    RuleID: "generic-api-key",
    StartLine: 187,
    EndLine: 187,
    StartColumn: 12,
    EndColumn: 42,
    Match: ["kApiTaggedSize", " = ", "REDACTED", ";"].join(""),
    Secret: "REDACTED",
  };
  assert.equal(classifyFindings([finding], [file], 1).resolved, 1);
  for (const altered of [
    { ...file, layer: 1 },
    { ...file, sha256: "0".repeat(64) },
    { ...file, size: 1 },
    { ...file, publicLine: "private" },
    { ...file, path: "app/v8-internal.h" },
  ])
    assert.equal(classifyFindings([finding], [altered], 1).unresolved, 1);
  for (const altered of [
    { ...finding, StartLine: 186 },
    { ...finding, RuleID: "other" },
    { ...finding, Match: "other" },
    { ...finding, Secret: "other" },
  ])
    assert.equal(classifyFindings([altered], [file], 1).unresolved, 1);
});

test("scanner errors and inconsistent exit codes fail closed", () => {
  assert.doesNotThrow(() => assertScanResult(0, 0));
  assert.doesNotThrow(() => assertScanResult(2, 1));
  const cases: [number | null, number][] = [
    [2, 0],
    [1, 1],
    [null, 0],
    [0, 1],
    [1, 0],
  ];
  for (const [exit, count] of cases)
    assert.throws(() => assertScanResult(exit, count));
});

test("binds a containerd image manifest to the config and ordered saved blobs", () => {
  const configDigest = "sha256:" + "a".repeat(64);
  const layers = ["sha256:" + "b".repeat(64), "sha256:" + "c".repeat(64)];
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest },
      layers: layers.map((digest) => ({ digest })),
    }),
  );
  const imageId = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() =>
    validateManifestBinding(bytes, imageId, configDigest, layers),
  );
  assert.throws(() =>
    validateManifestBinding(
      bytes,
      "sha256:" + "0".repeat(64),
      configDigest,
      layers,
    ),
  );
  assert.throws(() =>
    validateManifestBinding(bytes, imageId, "sha256:" + "0".repeat(64), layers),
  );
  assert.throws(() =>
    validateManifestBinding(
      bytes,
      imageId,
      configDigest,
      [...layers].reverse(),
    ),
  );
});

async function inspectionProbe(
  inspection: unknown,
  options: {
    platformFlag?: boolean;
    apiVersion?: string;
    nativeInspection?: unknown;
    toolFailure?: boolean;
    capabilityFailure?: boolean;
    toolOverflow?: boolean;
    invalidJson?: boolean;
    profile?: string;
    reportProfile?: string;
    nativeArtifacts?: unknown;
  } = {},
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[][];
}> {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-inspect-test-"));
  const imageId = "sha256:" + "a".repeat(64);
  const revision = "a".repeat(40);
  const source = "https://github.com/public/product";
  const credentialShaped = ["gh", "p_", "s".repeat(36)].join("");
  try {
    const executable = join(directory, "docker");
    const calls = join(directory, "calls.jsonl");
    // Runner image 20260927.320.1 pins Docker 28.0.4; its inspect parser has no platform flag.
    // https://github.com/actions/runner-images/blob/1275e33f5019b02660b81ecc5622fe196211fa89/images/ubuntu/Ubuntu2404-Readme.md
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        `const {appendFileSync} = require("node:fs"); const args = process.argv.slice(2);`,
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
        `if (args.includes("--help") && ${options.capabilityFailure ?? false}) { process.stderr.write(${JSON.stringify(credentialShaped)}); process.exit(1); }`,
        `if (args[0] === "version") { process.stdout.write(${JSON.stringify(options.apiVersion ?? "1.48")}); process.exit(0); }`,
        `if (args.includes("--help")) { process.stdout.write(${JSON.stringify(options.platformFlag ? "Options:\n      --platform string Inspect a specific platform\n" : "Options:\n  -f, --format string Format output\n")}); process.exit(0); }`,
        `if (args.includes("--platform") && !${options.platformFlag ?? false}) { process.stderr.write("unknown flag: --platform"); process.exit(125); }`,
        options.toolFailure
          ? `process.stderr.write(${JSON.stringify(credentialShaped)}); process.exit(1);`
          : options.toolOverflow
            ? `process.stderr.write(${JSON.stringify(credentialShaped)} + "x".repeat(1_000_001));`
            : options.invalidJson
              ? `process.stdout.write("invalid JSON");`
              : `process.stdout.write(args.includes("--platform") ? ${JSON.stringify(JSON.stringify(inspection))} : ${JSON.stringify(JSON.stringify(options.nativeInspection ?? inspection))});`,
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const report = join(directory, "report.json");
    await writeFile(
      report,
      JSON.stringify({
        version: 2,
        ...(options.reportProfile ? { profile: options.reportProfile } : {}),
        ...(options.reportProfile === "node-bootstrap"
          ? {
              nativeArtifacts:
                options.nativeArtifacts ??
                verifyNativeArtifacts(
                  reviewedFiles.filter((file) => file.nativeArtifact),
                  "node-bootstrap",
                ),
            }
          : {}),
        imageId,
        revision,
        source,
        unresolved: 0,
        rawExit: 0,
        opaqueExpectedBytes: 0,
        opaqueDetectorBytes: 0,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/ci/image-qualification.ts",
        "verify",
        "fixture:qualified",
        imageId,
        revision,
        source,
        report,
        ...(options.profile ? ["--profile", options.profile] : []),
      ],
      {
        env: { ...process.env, PATH: directory },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.ok(!result.stdout.includes(credentialShaped));
    assert.ok(!result.stderr.includes(credentialShaped));
    return {
      ...result,
      calls: (await readFile(calls, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const inspectedImage = {
  Id: "sha256:" + "a".repeat(64),
  Os: "linux",
  Architecture: "amd64",
  RootFS: { Type: "layers", Layers: ["sha256:" + "b".repeat(64)] },
};

test("verification supports the Ubuntu Docker 28.0.4 inspect flags", async () => {
  const result = await inspectionProbe([inspectedImage]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.every((args) => !args.includes("--platform")));
});

test("publication verification cannot reuse a report from another image profile", async () => {
  const wrong = await inspectionProbe([inspectedImage], {
    profile: "node-bootstrap",
    reportProfile: "regional",
  });
  assert.equal(wrong.status, 1);
  assert.deepEqual(wrong.calls, []);
  const correct = await inspectionProbe([inspectedImage], {
    profile: "node-bootstrap",
    reportProfile: "node-bootstrap",
  });
  assert.equal(correct.status, 0, correct.stderr);
});

test("bootstrap publication refuses missing or changed artifact proofs even with zero findings", async () => {
  const missing = await inspectionProbe([inspectedImage], {
    profile: "node-bootstrap",
    reportProfile: "node-bootstrap",
    nativeArtifacts: [],
  });
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.calls, []);
  const native = verifyNativeArtifacts(
    reviewedFiles.filter((file) => file.nativeArtifact),
    "node-bootstrap",
  );
  const changed = await inspectionProbe([inspectedImage], {
    profile: "node-bootstrap",
    reportProfile: "node-bootstrap",
    nativeArtifacts: native.map((item) => ({
      ...item,
      sha256: "0".repeat(64),
    })),
  });
  assert.equal(changed.status, 1);
  assert.deepEqual(changed.calls, []);
  const wrongSource = await inspectionProbe([inspectedImage], {
    profile: "node-bootstrap",
    reportProfile: "node-bootstrap",
    nativeArtifacts: native.map((item) => ({
      ...item,
      releaseUrl: "https://github.com/public/changed",
    })),
  });
  assert.equal(wrongSource.status, 1);
  assert.deepEqual(wrongSource.calls, []);
});

test("plain inspection rejects wrong platforms, ambiguous data and invalid diffIDs", async () => {
  for (const inspection of [
    [{ ...inspectedImage, Os: "windows" }],
    [{ ...inspectedImage, Architecture: "arm64" }],
    [{ ...inspectedImage, Id: "sha256:" + "c".repeat(64) }],
    [inspectedImage, inspectedImage],
    [],
    { image: inspectedImage },
    [null],
    [{ ...inspectedImage, RootFS: { Type: "layers", Layers: ["invalid"] } }],
    [{ ...inspectedImage, RootFS: { Type: "layers", Layers: [] } }],
    [
      {
        ...inspectedImage,
        RootFS: { Type: "other", Layers: inspectedImage.RootFS.Layers },
      },
    ],
  ]) {
    const result = await inspectionProbe(inspection);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes("Archive or tool error"));
  }
});

test("inspection tool failures expose only a fixed safe stage code", async () => {
  const result = await inspectionProbe([inspectedImage], { toolFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool_failed:image_inspect/);
  assert.ok(!result.stderr.includes("unknown flag"));
  assert.ok(!result.stderr.includes("fixture:qualified"));
});

test("modern inspection selects AMD64 from a mixed native-platform cache", async () => {
  const result = await inspectionProbe([inspectedImage], {
    platformFlag: true,
    apiVersion: "1.56",
    nativeInspection: [{ ...inspectedImage, Architecture: "arm64" }],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.at(-1), [
    "image",
    "inspect",
    "--platform",
    "linux/amd64",
    "fixture:qualified",
  ]);
});

test("an older negotiated API never receives the newer inspect platform flag", async () => {
  const result = await inspectionProbe([inspectedImage], {
    platformFlag: true,
    apiVersion: "1.48",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.at(-1), [
    "image",
    "inspect",
    "fixture:qualified",
  ]);
  assert.ok(result.calls.every((args) => !args.includes("--platform")));
});

test("modern platform selection cannot authorize a different image or retry a failed inspect", async () => {
  const wrongImage = await inspectionProbe(
    [{ ...inspectedImage, Id: "sha256:" + "c".repeat(64) }],
    {
      platformFlag: true,
      apiVersion: "1.56",
    },
  );
  assert.equal(wrongImage.status, 1);
  assert.match(wrongImage.stderr, /Image tag differs from the qualified image/);
  const failedInspect = await inspectionProbe([inspectedImage], {
    platformFlag: true,
    apiVersion: "1.56",
    toolFailure: true,
  });
  assert.equal(failedInspect.status, 1);
  assert.match(failedInspect.stderr, /tool_failed:image_inspect/);
  assert.equal(
    failedInspect.calls.filter(
      (args) =>
        args[0] === "image" &&
        args[1] === "inspect" &&
        !args.includes("--help"),
    ).length,
    1,
  );
  assert.ok(failedInspect.calls.at(-1)?.includes("--platform"));
});

test("invalid capability metadata fails closed before an image inspection", async () => {
  const invalidApi = await inspectionProbe([inspectedImage], {
    platformFlag: true,
    apiVersion: "invalid",
  });
  assert.equal(invalidApi.status, 1);
  assert.match(invalidApi.stderr, /Invalid negotiated Docker API version/);
  assert.equal(
    invalidApi.calls.filter(
      (args) => args[0] === "image" && !args.includes("--help"),
    ).length,
    0,
  );
  const failedHelp = await inspectionProbe([inspectedImage], {
    capabilityFailure: true,
  });
  assert.equal(failedHelp.status, 1);
  assert.match(failedHelp.stderr, /tool_failed:inspect_help/);
  assert.equal(failedHelp.calls.length, 1);
});

test("inspection parsing and output-limit errors return fixed safe reasons", async () => {
  const invalidJson = await inspectionProbe([inspectedImage], {
    invalidJson: true,
  });
  assert.equal(invalidJson.status, 1);
  assert.match(invalidJson.stderr, /inspection_invalid_json/);
  const overflow = await inspectionProbe([inspectedImage], {
    toolOverflow: true,
  });
  assert.equal(overflow.status, 1);
  assert.match(overflow.stderr, /tool_output_limit:image_inspect/);
});
