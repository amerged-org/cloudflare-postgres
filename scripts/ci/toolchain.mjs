// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { spawnSync } from "node:child_process";

const repository = fileURLToPath(new URL("../../", import.meta.url));

export function readToolchain(root = repository) {
  const lock = JSON.parse(
    readFileSync(join(root, "infra/platform/versions.lock.json"), "utf8"),
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pins = {
    ...lock.ciToolchain,
    rust: lock.nativeRuntime.rustVersion,
    pnpm: /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)?.[1],
  };
  for (const name of [
    "node",
    "pnpm",
    "rust",
    "dockerClient",
    "dockerServer",
    "buildx",
  ])
    if (!/^\d+\.\d+\.\d+$/.test(pins[name] ?? ""))
      throw new Error(`invalid_ci_toolchain:${name}`);
  const channel = /channel\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(root, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (channel !== pins.rust)
    throw new Error("invalid_ci_toolchain:rust_config");
  if (
    !Array.isArray(pins.rustTargets) ||
    !pins.rustTargets.includes("x86_64-unknown-linux-gnu") ||
    !pins.rustTargets.includes("wasm32-unknown-unknown")
  )
    throw new Error("invalid_ci_toolchain:rustTargets");
  return pins;
}

function equal(actual, expected, field) {
  if (actual !== expected) throw new Error(`unsupported_ci_toolchain:${field}`);
}

export function validateToolchain(actual, pins, { rust = false } = {}) {
  for (const name of [
    "platform",
    "architecture",
    "node",
    "pnpm",
    "distribution",
    "distributionVersion",
    "dockerClient",
    "dockerServer",
    "buildx",
  ])
    equal(actual[name], pins[name], name);
  equal(actual.dockerOs, "linux", "dockerOs");
  equal(actual.dockerArchitecture, "amd64", "dockerArchitecture");
  if (rust) {
    equal(actual.rust, pins.rust, "rust");
    equal(actual.rustHost, "x86_64-unknown-linux-gnu", "rustHost");
    if (
      !Array.isArray(actual.rustTargets) ||
      pins.rustTargets.some((target) => !actual.rustTargets.includes(target))
    )
      throw new Error("unsupported_ci_toolchain:rustTargets");
  }
}

function command(program, args, stage) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error(`unsupported_ci_toolchain:${stage}`);
  return result.stdout.trim();
}

function check(pins, rust) {
  // Fail before contacting Docker when invoked on a different host or Node runtime.
  equal(process.platform, pins.platform, "platform");
  equal(process.arch, pins.architecture, "architecture");
  equal(process.versions.node, pins.node, "node");
  const os = readFileSync("/etc/os-release", "utf8");
  const field = (name) =>
    new RegExp(`^${name}=["']?([^"'\\n]+)["']?$`, "m").exec(os)?.[1];
  const actual = {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    distribution: field("ID"),
    distributionVersion: field("VERSION_ID"),
    pnpm: command("pnpm", ["--version"], "pnpm"),
  };
  let docker;
  try {
    docker = JSON.parse(
      command("docker", ["version", "--format", "{{json .}}"], "docker"),
    );
  } catch {
    throw new Error("unsupported_ci_toolchain:docker");
  }
  Object.assign(actual, {
    dockerClient: docker.Client?.Version,
    dockerServer: docker.Server?.Version,
    dockerOs: docker.Server?.Os,
    dockerArchitecture: docker.Server?.Arch,
    buildx: /^github\.com\/docker\/buildx v(\d+\.\d+\.\d+)(?:\s|$)/.exec(
      command("docker", ["buildx", "version"], "buildx"),
    )?.[1],
  });
  if (rust) {
    const version = command("rustc", ["--version", "--verbose"], "rust");
    Object.assign(actual, {
      rust: /^release: (.+)$/m.exec(version)?.[1],
      rustHost: /^host: (.+)$/m.exec(version)?.[1],
      rustTargets: command(
        "rustup",
        ["target", "list", "--installed"],
        "rustTargets",
      ).split("\n"),
    });
  }
  validateToolchain(actual, pins, { rust });
  return actual;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const pins = readToolchain(),
      action = process.argv[2];
    if (process.argv.length !== 3)
      throw new Error("unsupported_ci_toolchain:arguments");
    if (action === "github-output") process.stdout.write(`node=${pins.node}\n`);
    else if (action === "node-version") process.stdout.write(`${pins.node}\n`);
    else if (action === "check" || action === "check-rust")
      process.stdout.write(
        JSON.stringify(check(pins, action === "check-rust")) + "\n",
      );
    else throw new Error("unsupported_ci_toolchain:arguments");
  } catch (error) {
    const reason =
      /^(?:unsupported|invalid)_ci_toolchain:[A-Za-z]+(?:_[A-Za-z]+)*$/.test(
        error?.message,
      )
        ? error.message
        : "unsupported_ci_toolchain:environment";
    process.stderr.write(`${reason}; no checks or builds are authorized.\n`);
    process.exitCode = 1;
  }
}
