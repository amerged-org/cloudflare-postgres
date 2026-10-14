// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface ToolchainPins {
  platform: string;
  architecture: string;
  node: string;
  pnpm: string;
  dockerClient: string;
  dockerServer: string;
  buildx: string;
  buildxBinary: { url: string; sha256: string; bytes: number };
  distribution: string;
  distributionVersion: string;
  rust: string;
  rustTargets: string[];
}
interface ActualToolchain extends Omit<
  ToolchainPins,
  "rust" | "rustTargets" | "buildxBinary"
> {
  dockerOs: string;
  dockerArchitecture: string;
  rust?: string;
  rustHost?: string;
  rustTargets?: string[];
}
// Dynamic URL import keeps this TypeScript test independent of JS declaration generation.
// Importing the module must not execute its CLI probes.
const { readToolchain, validateToolchain, installBuildxBytes } = (await import(
  new URL("./toolchain.mjs", import.meta.url).href
)) as {
  readToolchain(root?: string): ToolchainPins;
  installBuildxBytes(
    bytes: Uint8Array,
    pins: ToolchainPins,
    directory: string,
  ): string;
  validateToolchain(
    actual: ActualToolchain,
    pins: ToolchainPins,
    options?: { rust?: boolean },
  ): void;
};
const root = fileURLToPath(new URL("../../", import.meta.url));
const pins = readToolchain(root);
function actual(): ActualToolchain {
  return {
    platform: pins.platform,
    architecture: pins.architecture,
    node: pins.node,
    pnpm: pins.pnpm,
    dockerClient: pins.dockerClient,
    dockerServer: pins.dockerServer,
    buildx: pins.buildx,
    distribution: pins.distribution,
    distributionVersion: pins.distributionVersion,
    dockerOs: "linux",
    dockerArchitecture: "amd64",
  };
}
function rustActual(): ActualToolchain {
  return {
    ...actual(),
    rust: pins.rust,
    rustHost: "x86_64-unknown-linux-gnu",
    rustTargets: [...pins.rustTargets],
  };
}
const mismatch = (field: string) => ({
  name: "Error",
  message: `unsupported_ci_toolchain:${field}`,
});

test("reads the one CI lock and derives Rust and pnpm from their existing authorities", async () => {
  const lock = JSON.parse(
    await readFile(
      new URL("../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(pins, {
    ...lock.ciToolchain,
    rust: lock.nativeRuntime.rustVersion,
    pnpm: pkg.packageManager.slice("pnpm@".length),
  });
  assert.equal(pins.node, "24.21.0");
  assert.equal(pins.dockerClient, "28.0.4");
  assert.equal(pins.dockerServer, "28.0.4");
  assert.equal(pins.buildx, "0.37.2");
  assert.equal(pins.platform, "linux");
  assert.equal(pins.architecture, "x64");
});

test("accepts the exact Linux AMD64 toolchain without probing Docker or requiring Rust early", () => {
  assert.doesNotThrow(() => validateToolchain(actual(), pins));
  assert.doesNotThrow(() =>
    validateToolchain(rustActual(), pins, { rust: true }),
  );
});

test("rejects a Mac host even when it reports the pinned tool versions", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), platform: "darwin" }, pins),
    mismatch("platform"),
  );
});

test("rejects ARM host emulation and a Docker daemon on another architecture independently", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), architecture: "arm64" }, pins),
    mismatch("architecture"),
  );
  assert.throws(
    () => validateToolchain({ ...actual(), dockerArchitecture: "arm64" }, pins),
    mismatch("dockerArchitecture"),
  );
});

test("rejects a different Docker operating system on an otherwise matching host", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), dockerOs: "windows" }, pins),
    mismatch("dockerOs"),
  );
});

test("requires the exact Node patch release, including against a newer unqualified patch", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), node: "24.6.0" }, pins),
    mismatch("node"),
  );
  assert.throws(
    () => validateToolchain({ ...actual(), node: "24.21.1" }, pins),
    mismatch("node"),
  );
});

test("rejects a Docker client mismatch while the daemon still matches", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), dockerClient: "28.0.3" }, pins),
    mismatch("dockerClient"),
  );
});

test("rejects a Docker daemon mismatch while the client still matches", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), dockerServer: "28.0.3" }, pins),
    mismatch("dockerServer"),
  );
});

test("rejects a buildx mismatch independently of matching Docker versions", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), buildx: "0.37.1" }, pins),
    mismatch("buildx"),
  );
});

test("rejects pnpm that differs from the repository package manager", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), pnpm: "11.23.0" }, pins),
    mismatch("pnpm"),
  );
});

test("rejects another Linux distribution or release before accepting the build environment", () => {
  assert.throws(
    () => validateToolchain({ ...actual(), distribution: "alpine" }, pins),
    mismatch("distribution"),
  );
  assert.throws(
    () =>
      validateToolchain({ ...actual(), distributionVersion: "22.04" }, pins),
    mismatch("distributionVersion"),
  );
});

test("the Rust gate rejects a missing compiler and a compiler from another release", () => {
  assert.throws(
    () => validateToolchain(actual(), pins, { rust: true }),
    mismatch("rust"),
  );
  assert.throws(
    () =>
      validateToolchain({ ...rustActual(), rust: "1.98.0" }, pins, {
        rust: true,
      }),
    mismatch("rust"),
  );
});

test("the Rust gate refuses a non-AMD64 compiler host even with matching targets installed", () => {
  assert.throws(
    () =>
      validateToolchain(
        { ...rustActual(), rustHost: "aarch64-unknown-linux-gnu" },
        pins,
        { rust: true },
      ),
    mismatch("rustHost"),
  );
});

test("the Rust gate requires both native and Worker targets without depending on their listing order", () => {
  assert.throws(
    () =>
      validateToolchain(
        { ...rustActual(), rustTargets: ["x86_64-unknown-linux-gnu"] },
        pins,
        { rust: true },
      ),
    mismatch("rustTargets"),
  );
  assert.throws(
    () =>
      validateToolchain(
        { ...rustActual(), rustTargets: ["wasm32-unknown-unknown"] },
        pins,
        { rust: true },
      ),
    mismatch("rustTargets"),
  );
  assert.doesNotThrow(() =>
    validateToolchain(
      { ...rustActual(), rustTargets: [...pins.rustTargets].reverse() },
      pins,
      { rust: true },
    ),
  );
});

test("CI installs Node from the shared lock in every job and gates Rust checks after setup", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const nodeVersions = [
    ...workflow.matchAll(/^\s+node-version:\s*(.+)$/gm),
  ].map((match) => match[1]!);
  assert.ok(nodeVersions.length > 0);
  assert.ok(
    nodeVersions.every((value) =>
      /^\$\{\{ steps\.[A-Za-z0-9_-]+\.outputs\.node \}\}$/.test(value),
    ),
  );
  assert.equal(
    (workflow.match(/node scripts\/ci\/toolchain\.mjs github-output/g) ?? [])
      .length,
    nodeVersions.length,
  );
  assert.match(workflow, /node scripts\/ci\/toolchain\.mjs check-rust/);
  const rustSetup = workflow.indexOf("rustup toolchain install"),
    rustCheck = workflow.indexOf("node scripts/ci/toolchain.mjs check-rust"),
    rustTests = workflow.indexOf("cargo test --workspace");
  assert.ok(rustSetup >= 0 && rustCheck > rustSetup && rustTests > rustCheck);
});

test("every Linux build job validates the shared toolchain before dependencies and image builds", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const jobs = workflow
    .slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length)
    .split(/^ {2}(?=[a-z_]+:\s*$)/m)
    .filter((job) => job.includes("runs-on: ubuntu-24.04"));
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    const setup = job.indexOf("node-version:"),
      install = job.indexOf("node scripts/ci/toolchain.mjs install-buildx\n"),
      check = job.indexOf("node scripts/ci/toolchain.mjs check\n"),
      dependencies = job.indexOf("pnpm install"),
      build = job.indexOf("docker build");
    assert.ok(setup >= 0 && install > setup && check > install);
    assert.ok(dependencies > check);
    assert.ok(build > check);
  }
});

test("installs actual pinned Buildx bytes atomically and refuses corruption without replacing the existing plugin", async () => {
  assert.equal(typeof installBuildxBytes, "function");
  const asset = join(root, ".local/buildx/buildx-v0.37.2.linux-amd64"),
    installed = join(
      process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"),
      "cli-plugins/docker-buildx",
    );
  let bytes: Buffer;
  try {
    bytes = await readFile(process.platform === "linux" ? installed : asset);
  } catch {
    // Fresh local checkouts use the same real upstream asset as the CI installer.
    const response = await fetch(pins.buildxBinary.url, {
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.ok, true);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const directory = await mkdtemp(join(tmpdir(), "pgcf-buildx-test-"));
  try {
    const executable = installBuildxBytes(bytes, pins, directory);
    assert.equal(
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
      pins.buildxBinary.sha256,
    );
    assert.equal((await stat(executable)).mode & 0o777, 0o755);
    const changed = Buffer.from(bytes);
    changed[0] = changed[0]! ^ 1;
    assert.throws(
      () => installBuildxBytes(changed, pins, directory),
      /unsupported_ci_toolchain:buildxIntegrity/,
    );
    assert.throws(
      () => installBuildxBytes(bytes.subarray(1), pins, directory),
      /unsupported_ci_toolchain:buildxIntegrity/,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
      pins.buildxBinary.sha256,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
