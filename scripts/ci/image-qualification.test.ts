// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
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
  validateProfileProvenance,
  verifyRustAssembly,
  verifyTalosRecipeAssembly,
  inspectTalosInstallerArchive,
  type LayerFile,
} from "./image-qualification.ts";

test("imager installer archives bind every layer and upstream identity without fabricated PGCF labels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-installer-archive-"));
  const sha = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const archive = async (entries: Array<[string, Buffer]>) => {
    const pack = tar.pack();
    for (const [name, bytes] of entries) pack.entry({ name }, bytes);
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const base = await archive([
    ["bin/installer", Buffer.from("public installer fixture")],
  ]);
  const payload = await archive([
    [
      "usr/install/amd64/vmlinuz.efi",
      Buffer.from("public UKI fixture; nested parsing is a separate gate"),
    ],
  ]);
  const layers = [gzipSync(base), gzipSync(payload)],
    names = layers.map((layer) => sha(layer) + ".tar.gz"),
    diffIDs = [base, payload].map((layer) => "sha256:" + sha(layer));
  const make = async (
    name: string,
    version: string,
    extra = false,
    corrupt = false,
  ) => {
    const config = Buffer.from(
      JSON.stringify({
        architecture: "amd64",
        os: "linux",
        rootfs: { type: "layers", diff_ids: diffIDs },
        config: {
          Entrypoint: ["/bin/installer"],
          Env: ["VERSION=v" + version],
          Labels: {
            "alpha.talos.dev/version": "v" + version,
            "org.opencontainers.image.source":
              "https://github.com/siderolabs/talos",
          },
        },
      }),
    );
    const configName = "sha256:" + sha(config),
      manifest = Buffer.from(
        JSON.stringify([{ Config: configName, RepoTags: null, Layers: names }]),
      );
    const entries: Array<[string, Buffer]> = [
      [configName, config],
      [names[0]!, layers[0]!],
      [names[1]!, corrupt ? gzipSync(Buffer.from("corrupt")) : layers[1]!],
      ["manifest.json", manifest],
    ];
    if (extra)
      entries.push(["unlisted", Buffer.from("never ignore an extra payload")]);
    const path = join(directory, name + ".tar");
    await writeFile(path, await archive(entries));
    return path;
  };
  try {
    const expected = { talosVersion: "1.14.1", baseDiffIDs: [diffIDs[0]!] };
    const path = await make("valid", expected.talosVersion);
    const result = await inspectTalosInstallerArchive(
      path,
      join(directory, "valid"),
      expected,
    );
    assert.equal(result.archiveSha256, sha(await readFile(path)));
    assert.deepEqual(result.diffIDs, diffIDs);
    assert.deepEqual(
      result.layerDigests,
      layers.map((layer) => "sha256:" + sha(layer)),
    );
    assert.equal(result.files.length, 2);
    assert.ok(
      result.inputs.some(
        (input) => input.path === "usr/install/amd64/vmlinuz.efi",
      ),
    );
    await assert.rejects(
      inspectTalosInstallerArchive(
        await make("version", "1.14.2"),
        join(directory, "version"),
        expected,
      ),
      /identity/,
    );
    await assert.rejects(
      inspectTalosInstallerArchive(
        await make("extra", expected.talosVersion, true),
        join(directory, "extra"),
        expected,
      ),
      /entry/,
    );
    await assert.rejects(
      inspectTalosInstallerArchive(
        await make("corrupt", expected.talosVersion, false, true),
        join(directory, "corrupt"),
        expected,
      ),
      /digest/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
import {
  reviewedBase,
  postgresBase,
  storageBase,
  rustBuilder,
  rustVersion,
  reviewedFiles,
  reviewedManifestPaths,
  verifyNativeArtifacts,
} from "./reviewed-findings.ts";
import { sandboxImagePlan } from "../../infra/talos/sandbox/images.ts";
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };

test("bootstrap runtime checks follow changed lock versions without second constants", () => {
  const previous = [
    versions.target.talosVersion,
    versions.target.kubernetesVersion,
    versions.bootstrapClients.helm.version,
  ] as const;
  try {
    versions.target.talosVersion = "1.14.2";
    versions.target.kubernetesVersion = "1.36.6";
    versions.bootstrapClients.helm.version = "4.3.1";
    const checks = runtimeChecks("node-bootstrap");
    for (const [name, stdout] of [
      [
        "talosctl",
        `Client:\n\tTag: v${versions.target.talosVersion}\n\tOS/Arch: linux/amd64\n`,
      ],
      [
        "kubectl",
        JSON.stringify({
          clientVersion: {
            gitVersion: `v${versions.target.kubernetesVersion}`,
            platform: "linux/amd64",
          },
        }),
      ],
      ["helm", `v${versions.bootstrapClients.helm.version}`],
    ])
      assert.doesNotThrow(() =>
        validateRuntimeResult(
          checks.find((check) => check.entrypoint === name)!,
          { exit: 0, stderr: "", stdout: stdout! },
        ),
      );
  } finally {
    [
      versions.target.talosVersion,
      versions.target.kubernetesVersion,
      versions.bootstrapClients.helm.version,
    ] = previous;
  }
});

test("published PostgreSQL consumer pins retain the version tag required by CNPG admission", async () => {
  const sources = JSON.parse(
    await readFile("infra/postgres/sources.lock.json", "utf8"),
  ) as { postgresql: { version: string } };
  const platform = JSON.parse(
    await readFile("infra/platform/versions.lock.json", "utf8"),
  ) as { regional: { postgresImage: { reference: string } } };
  const config = await readFile("infra/platform/regional/config.yaml", "utf8");
  const reference = /PGCF_POSTGRES_IMAGE:\s*(\S+)/.exec(config)?.[1];
  assert.equal(reference, platform.regional.postgresImage.reference);
  assert.ok(reference);
  const tag = /:([^:@/]+)@sha256:[a-f0-9]{64}$/.exec(reference)?.[1];
  assert.ok(tag, "CNPG needs a version-bearing tag even for a digest pin");
  // CNPG 1.30.1 uses machinery v0.6.0 FromTag after stripping the digest.
  // Its actual prefix grammar is pinned at:
  // https://github.com/cloudnative-pg/machinery/blob/50976ec08e4f280c3bd89d42caf7a1cca887729c/pkg/postgres/version/version.go#L30
  const version = /^(\d\.?)+/.exec(tag)?.[0];
  assert.equal(version, sources.postgresql.version);
  assert.deepEqual(version?.split(".").map(Number), [18, 6]);
  const rejectedReference = reference.replace(
    /:[^:@/]+@/,
    ":postgres-sha-0cf76655e000@",
  );
  const rejectedTag = /:([^:@/]+)@sha256:[a-f0-9]{64}$/.exec(
    rejectedReference,
  )?.[1];
  assert.ok(rejectedTag);
  assert.equal(/^(\d\.?)+/.exec(rejectedTag), null);
  assert.equal(
    rejectedReference.split("@")[1],
    reference.split("@")[1],
    "the admission fix changes the tag, not the qualified content",
  );
  assert.ok(tag.startsWith(`${sources.postgresql.version}-pgcf-sha-`));
  assert.match(tag, /-pgcf-sha-[a-f0-9]{12}$/);
  assert.match(reference, /@sha256:[a-f0-9]{64}$/);
});

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
  const mirror = postgres.split(
    "- name: Copy the qualified PostgreSQL manifest to public runtime storage",
  )[1];
  assert.ok(
    mirror,
    "PostgreSQL runtime bytes need the existing public pull path",
  );
  assert.match(mirror, /postgresql\.version/);
  assert.match(mirror, /pgcf-regional:\$\{postgres_version\}-pgcf-sha-/);
  assert.match(mirror, /imagetools create --prefer-index=false/);
  assert.match(mirror, /--profile postgres registry/);
  assert.match(mirror, /public-postgres-sha\.json/);
  assert.doesNotMatch(
    mirror,
    /pgcf-regional:latest|--profile postgres promote/,
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
      stdout: `Client:\n\tTag: v${versions.target.talosVersion}\n\tOS/Arch: linux/amd64\n`,
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

test("storage and Rust profiles bind their own sources without a fictitious runtime base", async () => {
  const storage = await readFile("infra/storage/Dockerfile", "utf8");
  assert.equal(validateDockerfile(storage, "storage"), storageBase);
  for (const profile of [
    "rust-gateway",
    "native-controller",
    "sandbox-controller",
    "sandbox-extension",
  ] as const) {
    assert.equal(
      validateDockerfile(
        profile === "rust-gateway" || profile === "native-controller"
          ? "ARG RUST_BUILDER\nFROM ${RUST_BUILDER} AS build\nFROM scratch\n"
          : "ARG RUST_BUILDER\nFROM ${RUST_BUILDER} AS build\nFROM scratch AS talos-extension\nFROM scratch AS runtime\n",
        profile,
      ),
      rustBuilder,
    );
    assert.throws(() =>
      validateDockerfile(`FROM ${reviewedBase.image}\n`, profile),
    );
    assert.deepEqual(reviewedManifestPaths([], profile), []);
    assert.throws(() =>
      reviewedManifestPaths(["app/node_modules/x/package.json"], profile),
    );
  }
  const check = runtimeChecks("rust-gateway")[0]!;
  const identity = {
    sourceRevision: "a".repeat(40),
    versionsLockSha256: "b".repeat(64),
    cargoLockSha256: "c".repeat(64),
  };
  const version = {
    program: "pgcf-native-gateway",
    version: "0.1.0",
    rustVersion,
    ...identity,
  };
  assert.doesNotThrow(() =>
    validateRuntimeResult(
      check,
      { stdout: JSON.stringify(version), stderr: "", exit: 0 },
      identity,
    ),
  );
  assert.throws(() =>
    validateRuntimeResult(
      check,
      {
        stdout: JSON.stringify({ ...version, sourceRevision: "d".repeat(40) }),
        stderr: "",
        exit: 0,
      },
      identity,
    ),
  );
  assert.throws(() =>
    validateRuntimeResult(
      check,
      {
        stdout: JSON.stringify({ ...version, sourceRevision: null }),
        stderr: "",
        exit: 0,
      },
      identity,
    ),
  );
  assert.throws(() =>
    validateRuntimeResult(
      check,
      {
        stdout: JSON.stringify({ ...version, rustVersion: "0.0" }),
        stderr: "",
        exit: 0,
      },
      identity,
    ),
  );
  assert.equal(runtimeChecks("storage")[0]!.entrypoint, "/usr/sbin/thin_check");
  const controller = runtimeChecks("native-controller")[0]!;
  const protocol = await readFile(
    "packages/contracts/native/protocol.generated.json",
  );
  const contract = await readFile(
    "packages/contracts/native/controller.generated.json",
  );
  const controllerVersion = {
    ...version,
    program: "pgcf-native-controller",
    protocolSha256: createHash("sha256").update(protocol).digest("hex"),
    controllerContractSha256: createHash("sha256")
      .update(contract)
      .digest("hex"),
    configurationSchemaRevision: JSON.parse(contract.toString()).constants
      .CONFIGURATION_SCHEMA_REVISION,
  };
  const result = (value: unknown) => ({
    stdout: JSON.stringify(value),
    stderr: "",
    exit: 0,
  });
  assert.doesNotThrow(() =>
    validateRuntimeResult(controller, result(controllerVersion), identity),
  );
  assert.throws(
    () =>
      validateRuntimeResult(
        controller,
        result({
          ...controllerVersion,
          controllerContractSha256: "d".repeat(64),
        }),
        identity,
      ),
    /runtime_generated_input_invalid/,
  );
  assert.throws(
    () =>
      validateRuntimeResult(
        controller,
        result({ ...controllerVersion, configurationSchemaRevision: 0 }),
        identity,
      ),
    /runtime_generated_input_invalid/,
  );
});

test("relay and reclaimer qualification require their own compiled contracts and source identity", async () => {
  for (const [profile, packageName, contractName, field] of [
    [
      "rust-bootstrap-relay",
      "native-bootstrap-relay",
      "bootstrap",
      "bootstrapContractSha256",
    ],
    [
      "native-reclaimer",
      "native-reclaimer",
      "reclaim",
      "reclaimContractSha256",
    ],
  ] as const) {
    const check = runtimeChecks(profile)[0]!;
    assert.equal(check.entrypoint, `/pgcf-${packageName}`);
    assert.deepEqual(reviewedManifestPaths([], profile), []);
    assert.throws(() =>
      reviewedManifestPaths(["app/node_modules/pkg/package.json"], profile),
    );
    assert.equal(
      validateDockerfile(
        "ARG RUST_BUILDER\nFROM ${RUST_BUILDER} AS build\nFROM scratch\n",
        profile,
      ),
      rustBuilder,
    );
    const sha = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    const identity = {
      sourceRevision: "a".repeat(40),
      versionsLockSha256: "b".repeat(64),
      cargoLockSha256: "c".repeat(64),
    };
    const version = {
      program: `pgcf-${packageName}`,
      version: "0.1.0",
      rustVersion,
      ...identity,
      protocolSha256: await sha(
        "packages/contracts/native/protocol.generated.json",
      ),
      [field]: await sha(
        `packages/contracts/native/${contractName}.generated.json`,
      ),
    };
    const result = (value: unknown) => ({
      stdout: JSON.stringify(value),
      stderr: "",
      exit: 0,
    });
    assert.doesNotThrow(() =>
      validateRuntimeResult(check, result(version), identity),
    );
    assert.throws(
      () =>
        validateRuntimeResult(
          check,
          result({ ...version, [field]: "d".repeat(64) }),
          identity,
        ),
      /runtime_generated_input_invalid/,
    );
    assert.throws(
      () =>
        validateRuntimeResult(
          check,
          result({ ...version, protocolSha256: "d".repeat(64) }),
          identity,
        ),
      /runtime_generated_input_invalid/,
    );
    assert.throws(
      () =>
        validateRuntimeResult(
          check,
          result({ ...version, sourceRevision: "d".repeat(40) }),
          identity,
        ),
      /runtime_provenance_invalid/,
    );
  }
});

test("Rust publication requires real compiled artifact identities and no claimed shipped builder prefix", () => {
  const report = {
    baseImage: null,
    baseImageId: null,
    builderImage: rustBuilder,
    builderImageId: `sha256:${"a".repeat(64)}`,
    compiledArtifacts: [
      { path: "pgcf-native-gateway", sha256: "b".repeat(64), size: 1024 },
    ],
  };
  assert.doesNotThrow(() => validateProfileProvenance(report, "rust-gateway"));
  assert.throws(() =>
    validateProfileProvenance(
      { ...report, compiledArtifacts: [] },
      "rust-gateway",
    ),
  );
  assert.throws(() =>
    validateProfileProvenance(
      { ...report, baseImage: rustBuilder },
      "rust-gateway",
    ),
  );
  assert.throws(() => validateProfileProvenance(report, "sandbox-controller"));
});
test("Talos extension assembly admits only exact source-bound manifests, binaries and notices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-extension-assembly-")),
    files: LayerFile[] = [],
    revision = "a".repeat(40),
    root = "rootfs/usr/local/share/licenses/pgcf-sandbox";
  const add = async (path: string, bytes: Buffer | string) => {
    const body = Buffer.from(bytes),
      scanPath = String(files.length);
    await writeFile(join(directory, scanPath), body);
    files.push({
      path,
      scanPath,
      layer: 0,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
    });
  };
  try {
    const elf = Buffer.alloc(20);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    await add("rootfs/usr/local/bin/pgcf-sandbox-controller", elf);
    await add("rootfs/usr/local/bin/pgcf-node-runtime", elf);
    for (const [name, source] of [
      ["Cargo.lock", "Cargo.lock"],
      ["versions.lock.json", "infra/platform/versions.lock.json"],
      [
        "protocol.generated.json",
        "packages/contracts/native/protocol.generated.json",
      ],
      [
        "constants.generated.rs",
        "packages/native-protocol/src/constants.generated.rs",
      ],
      [
        "compute-pool.generated.json",
        "packages/contracts/native/compute-pool.generated.json",
      ],
      [
        "reclaim.generated.json",
        "packages/contracts/native/reclaim.generated.json",
      ],
    ])
      await add(`${root}/provenance/${name}`, await readFile(source!));
    await add(`${root}/pgcf/LICENSE`, await readFile("LICENSE"));
    // The real image must carry upstream notice files; these unit bytes exercise path/provenance isolation only.
    await add(`${root}/rust/LICENSE-MIT`, "Rust MIT notice");
    await add(`${root}/rust/LICENSE-APACHE`, "Rust Apache notice");
    await add(`${root}/crates/example/LICENSE`, "Upstream notice");
    for (const [path, source] of [
      ["manifest.yaml", "infra/talos/sandbox/manifest.yaml"],
      [
        "rootfs/usr/local/etc/containers/pgcf-sandbox-controller.yaml",
        "infra/talos/sandbox/service.yaml",
      ],
      [
        "rootfs/etc/cri/conf.d/20-pgcf-prestarted.part",
        "infra/talos/sandbox/20-pgcf-prestarted.part",
      ],
    ])
      await add(
        path!,
        (await readFile(source!, "utf8"))
          .replace("PGCF_EXTENSION_VERSION", "0.1.0-" + revision)
          .replace("PGCF_TALOS_VERSION", versions.target.talosVersion),
      );
    assert.equal(
      (
        await verifyRustAssembly(
          files,
          directory,
          "sandbox-extension",
          revision,
        )
      ).length,
      2,
    );
    await assert.rejects(
      verifyRustAssembly(files, directory, "sandbox-extension", "b".repeat(40)),
    );
    await assert.rejects(
      verifyRustAssembly(
        files.filter((file) => !file.path.endsWith("/reclaim.generated.json")),
        directory,
        "sandbox-extension",
        revision,
      ),
    );
    await add("rootfs/var/lib/pgcf-sandbox/agent-key", "forbidden");
    await assert.rejects(
      verifyRustAssembly(files, directory, "sandbox-extension", revision),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("public recipe profile verifies its canonical source inputs and cannot claim a shipped compiler or base", async () => {
  const revision = "d".repeat(40),
    plan = sandboxImagePlan({
      sourceCommit: revision,
      architecture: "amd64",
      sandboxExtension: "ghcr.io/example/sandbox@sha256:" + "a".repeat(64),
      otherExtensions: [],
    }),
    directory = await mkdtemp(join(tmpdir(), "pgcf-recipe-assembly-")),
    files: LayerFile[] = [];
  try {
    for (const [path, body] of [
      ["manifest.yaml", JSON.stringify(plan.schematicManifest, null, 2) + "\n"],
      [
        "rootfs/usr/local/share/pgcf/talos-recipe.json",
        JSON.stringify(plan.recipe, null, 2) + "\n",
      ],
      [
        "rootfs/usr/local/share/licenses/pgcf-recipe/LICENSE",
        await readFile("LICENSE", "utf8"),
      ],
    ]) {
      const scanPath = String(files.length);
      await writeFile(join(directory, scanPath), body!);
      files.push({
        path: path!,
        scanPath,
        layer: 0,
        sha256: createHash("sha256").update(body!).digest("hex"),
        size: Buffer.byteLength(body!),
      });
    }
    assert.equal(
      await verifyTalosRecipeAssembly(files, directory, revision),
      plan.recipeSha256,
    );
    await assert.rejects(
      verifyTalosRecipeAssembly(files, directory, "e".repeat(40)),
    );
    assert.equal(
      validateDockerfile(
        await readFile("infra/talos/sandbox/recipe.Dockerfile", "utf8"),
        "talos-recipe",
      ),
      "scratch",
    );
    assert.deepEqual(runtimeChecks("talos-recipe"), []);
    const report = {
      baseImage: null,
      baseImageId: null,
      recipeSha256: plan.recipeSha256,
    };
    assert.doesNotThrow(() =>
      validateProfileProvenance(report, "talos-recipe"),
    );
    assert.throws(() =>
      validateProfileProvenance(
        { ...report, baseImage: rustBuilder },
        "talos-recipe",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
