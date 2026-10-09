// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { extract, type Header } from "tar-stream";
import {
  metadataInputs,
  prepareInputs,
  runPass,
  mapFindings,
  dedupeFindings,
  safeFindingCounts,
  type ScanInput,
} from "./scanner.ts";
import storageSources from "../../infra/storage/sources.lock.json" with { type: "json" };
import sandboxSources from "../../apps/sandbox-controller/proto/sources.json" with { type: "json" };
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };
import { verifyRegistry, promotionArguments } from "./registry.ts";
import {
  nodeBase,
  selectOwnedFiles,
  postgresBase,
  storageBase,
  rustBuilder,
  rustVersion,
  isRustProfile,
  imageProfile,
  verifyNativeArtifacts,
  validateNativeProvenance,
  type NativeArtifactProvenance,
  type ImageProfile,
} from "./image-profiles.ts";

import { sandboxImagePlan } from "../../infra/talos/sandbox/images.ts";
const isScratchProfile = (profile: ImageProfile) =>
  isRustProfile(profile) || profile === "talos-recipe";
const scannerVersion = "8.30.1";
// SHA256 values from the official v8.30.1 release checksums, not a moving tag.
const scannerArchives: Record<string, string> = {
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  darwin_arm64:
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64:
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
};
const digestPattern = /^sha256:[a-f0-9]{64}$/;

class QualificationFailure extends Error {}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new QualificationFailure(message);
}

export function parseQualificationArguments(input: string[]): {
  profile: ImageProfile;
  args: string[];
} {
  const args = [...input],
    index = args.indexOf("--profile");
  let profile: ImageProfile = "regional";
  if (index !== -1) {
    requireCheck(
      index + 1 < args.length,
      "Missing image qualification profile",
    );
    profile = imageProfile(args[index + 1]);
    args.splice(index, 2);
  }
  requireCheck(
    !args.some((value) => value.startsWith("--")),
    "Invalid image qualification options",
  );
  return { profile, args };
}

export function validateDockerfile(
  source: string,
  profileInput: ImageProfile = "regional",
): string {
  const profile = imageProfile(profileInput),
    from = source
      .split(/\r?\n/)
      .filter((line) => /^\s*FROM\b/i.test(line))
      .map((line) => line.trim()),
    expected =
      profile === "talos-recipe"
        ? ["FROM scratch"]
        : profile === "storage"
          ? [`FROM ${storageBase}`]
          : profile === "sandbox-controller" || profile === "sandbox-extension"
            ? [
                "FROM ${RUST_BUILDER} AS build",
                "FROM scratch AS talos-extension",
                "FROM scratch AS runtime",
              ]
            : isRustProfile(profile)
              ? ["FROM ${RUST_BUILDER} AS build", "FROM scratch"]
              : profile === "postgres"
                ? [`FROM ${postgresBase} AS postgres`, "FROM scratch"]
                : [
                    `FROM ${nodeBase} AS build`,
                    ...(profile === "node-bootstrap"
                      ? [`FROM ${nodeBase} AS clients`]
                      : []),
                    `FROM ${nodeBase}`,
                  ];
  requireCheck(
    JSON.stringify(from) === JSON.stringify(expected),
    "Dockerfile base or stage topology differs from the pinned profile",
  );
  return profile === "talos-recipe"
    ? "scratch"
    : profile === "storage"
      ? storageBase
      : isRustProfile(profile)
        ? rustBuilder
        : profile === "postgres"
          ? postgresBase
          : nodeBase;
}

export function safeArchivePath(name: string): string {
  const path = name.replace(/^\.\//, "").replace(/\/$/, "");
  requireCheck(
    path && !path.startsWith("/") && !/[\\\0\r\n]/.test(path),
    "Unsafe archive path",
  );
  requireCheck(
    path.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe archive path",
  );
  return path;
}

async function readTar(
  input: AsyncIterable<Uint8Array>,
  visit: (header: Header, stream: AsyncIterable<Uint8Array>) => Promise<void>,
): Promise<void> {
  const parser = extract();
  parser.on("entry", (header, stream, next) => {
    // The parser also destroys its current entry on failure; pipeline handles the parser error.
    stream.on("error", () => {});
    const entry = async () => {
      if (
        header.type === "directory" &&
        (header.name === "." || header.name === "./")
      ) {
        requireCheck(
          header.size === 0,
          "Root directory archive entry has a body",
        );
        for await (const chunk of stream)
          requireCheck(
            (chunk as Uint8Array).length === 0,
            "Root directory archive entry has a body",
          );
      } else await visit(header, stream as AsyncIterable<Uint8Array>);
    };
    void entry().then(
      () => next(),
      (error: Error) => parser.destroy(error),
    );
  });
  await pipeline(Readable.from(input), parser as unknown as Writable);
}

async function copyFileStream(
  stream: AsyncIterable<Uint8Array>,
  path: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  await pipeline(
    Readable.from(stream),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }),
    output,
  );
  return { size, sha256: hash.digest("hex") };
}

export interface LayerFile {
  scanPath: string;
  path: string;
  layer: number;
  sha256: string;
  size: number;
  tarEntry?: number;
  bodyOffset?: number;
}

export async function extractLayer(
  input: AsyncIterable<Uint8Array>,
  directory: string,
  layer: number,
  paths?: string[],
): Promise<LayerFile[]> {
  const files: LayerFile[] = [];
  const links = new Set<string>();
  let tarEntry = 0;
  await mkdir(join(directory, String(layer)), { mode: 0o700 });
  await readTar(input, async (header, stream) => {
    const entry = tarEntry++;
    const path = safeArchivePath(header.name);
    paths?.push(path);
    const parts = path.split("/");
    requireCheck(
      !parts.some((_part, index) =>
        links.has(parts.slice(0, index + 1).join("/")),
      ),
      "Archive writes through a link",
    );
    if (header.type === "symlink" || header.type === "link") links.add(path);
    if (header.type !== "file" && header.type !== "contiguous-file") {
      // Links and device nodes are never materialized on the scanning host.
      for await (const chunk of stream)
        requireCheck(chunk.length === 0, "Non-file archive entry has a body");
      return;
    }
    const scanPath = `${layer}/${files.length}/${path}`;
    await mkdir(dirname(join(directory, scanPath)), {
      recursive: true,
      mode: 0o700,
    });
    const metadata = await copyFileStream(stream, join(directory, scanPath));
    requireCheck(metadata.size === header.size, "Layer entry size mismatch");
    const file: LayerFile = {
      path,
      scanPath,
      layer,
      ...metadata,
      tarEntry: entry,
      bodyOffset: (header as Header & { byteOffset: number }).byteOffset,
    };
    files.push(file);
  });
  return files;
}

export function validateBasePrefix(layers: string[], base: string[]): void {
  requireCheck(
    base.length > 0 &&
      layers.length >= base.length &&
      base.every(
        (digest, index) =>
          digestPattern.test(digest) && layers[index] === digest,
      ),
    "Image does not retain the pinned official base layer prefix",
  );
}

interface ImageConfig {
  architecture: string;
  os: string;
  config: { Labels: Record<string, string> };
  rootfs: { type: string; diff_ids: string[] };
}

export function validateImageIdentity(
  bytes: Buffer,
  imageId: string,
  revision: string,
  source: string,
): ImageConfig {
  requireCheck(
    digestPattern.test(imageId) &&
      "sha256:" + createHash("sha256").update(bytes).digest("hex") === imageId,
    "Saved config differs from the built image ID",
  );
  const config = JSON.parse(bytes.toString()) as ImageConfig;
  requireCheck(
    config.os === "linux" && config.architecture === "amd64",
    "Unexpected image platform",
  );
  requireCheck(
    config.config?.Labels?.["org.opencontainers.image.revision"] === revision &&
      config.config.Labels["org.opencontainers.image.source"] === source,
    "Image source or revision label mismatch",
  );
  requireCheck(
    config.rootfs?.type === "layers" &&
      Array.isArray(config.rootfs.diff_ids) &&
      config.rootfs.diff_ids.every((digest) => digestPattern.test(digest)),
    "Invalid image diffIDs",
  );
  return config;
}

export interface Finding {
  File: string;
  RuleID: string;
  StartLine: number;
  EndLine: number;
  StartColumn: number;
  EndColumn: number;
  Match: string;
  Secret: string;
  Tags?: string[];
}

export function validateManifestBinding(
  bytes: Buffer,
  imageId: string,
  configDigest: string,
  layerDigests: string[],
): void {
  requireCheck(
    "sha256:" + createHash("sha256").update(bytes).digest("hex") === imageId,
    "Saved manifest differs from built image ID",
  );
  const manifest = JSON.parse(bytes.toString()) as {
    schemaVersion: number;
    config: { digest: string };
    layers: { digest: string }[];
  };
  requireCheck(
    manifest.schemaVersion === 2 &&
      manifest.config?.digest === configDigest &&
      Array.isArray(manifest.layers) &&
      manifest.layers.length === layerDigests.length &&
      manifest.layers.every(
        (layer, index) =>
          digestPattern.test(layer.digest) &&
          layer.digest === layerDigests[index],
      ),
    "Saved manifest config or ordered layer blobs mismatch",
  );
}

export function assertScanResult(
  exit: number | null,
  findingCount: number,
): void {
  requireCheck(
    (exit === 0 && findingCount === 0) || (exit === 2 && findingCount > 0),
    "Scanner failed or returned an inconsistent report",
  );
}

type ToolStage =
  | "runtime_thin_check"
  | "runtime_thin_repair"
  | "runtime_rust_gateway"
  | "runtime_native_controller"
  | "runtime_rust_bootstrap_relay"
  | "runtime_native_reclaimer"
  | "runtime_sandbox_controller"
  | "runtime_sandbox_holder"
  | "runtime_postgres"
  | "runtime_help"
  | "runtime_agent"
  | "runtime_gateway"
  | "runtime_relay"
  | "runtime_bootstrap_modules"
  | "runtime_bootstrap_server"
  | "runtime_bootstrap_proxy"
  | "runtime_inspection_proxy"
  | "runtime_outside_scan"
  | "runtime_proof_proxy"
  | "runtime_talos"
  | "runtime_kubectl"
  | "runtime_helm"
  | "runtime_ssh"
  | "scanner_version"
  | "inspect_help"
  | "docker_api"
  | "image_inspect"
  | "base_pull"
  | "image_save"
  | "image_promote";

async function command(
  stage: ToolStage,
  program: string,
  args: string[],
  cwd?: string,
  env = process.env,
  accepted = [0],
): Promise<{ stdout: string; stderr: string; exit: number | null }> {
  return await new Promise((fulfill, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1_000_000) {
        overflow = true;
        child.kill("SIGKILL");
      } else stdout += chunk.toString();
    });
    // Tool diagnostics can contain file contents or credentials. Never forward them.
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 1_000_000) {
        overflow = true;
        child.kill("SIGKILL");
      } else stderr += chunk.toString();
    });
    child.on("error", () =>
      reject(new QualificationFailure(`tool_start_failed:${stage}`)),
    );
    child.on("close", (exit) => {
      if (overflow)
        reject(new QualificationFailure(`tool_output_limit:${stage}`));
      else if (!accepted.includes(exit ?? -1))
        reject(new QualificationFailure(`tool_failed:${stage}`));
      else fulfill({ stdout, stderr, exit });
    });
  });
}

export interface RuntimeCheck {
  stage: ToolStage;
  entrypoint: string;
  args: string[];
  exit: number;
  stdout?: string;
  stderr?: string;
  version?:
    | "talos"
    | "kubectl"
    | "helm"
    | "ssh"
    | "rust-gateway"
    | "native-controller"
    | "rust-bootstrap-relay"
    | "native-reclaimer"
    | "sandbox-controller"
    | "sandbox-holder";
}
export function runtimeChecks(
  profileInput: ImageProfile = "regional",
): RuntimeCheck[] {
  const profile = imageProfile(profileInput);
  if (profile === "talos-recipe") return [];
  if (profile === "storage")
    return [
      {
        stage: "runtime_thin_check",
        entrypoint: "/usr/sbin/thin_check",
        args: ["--version"],
        exit: 0,
        stdout: storageSources.thin_tools.version,
        stderr: "",
      },
      {
        stage: "runtime_thin_repair",
        entrypoint: "/usr/sbin/thin_repair",
        args: ["--version"],
        exit: 0,
        stdout: storageSources.thin_tools.version,
        stderr: "",
      },
    ];
  if (profile === "rust-gateway")
    return [
      {
        stage: "runtime_rust_gateway",
        entrypoint: "/pgcf-native-gateway",
        args: ["--version"],
        exit: 0,
        stderr: "",
        version: "rust-gateway",
      },
    ];
  if (profile === "native-controller")
    return [
      {
        stage: "runtime_native_controller",
        entrypoint: "/pgcf-native-controller",
        args: ["--version"],
        exit: 0,
        stderr: "",
        version: "native-controller",
      },
    ];
  if (profile === "rust-bootstrap-relay" || profile === "native-reclaimer")
    return [
      {
        stage:
          profile === "rust-bootstrap-relay"
            ? "runtime_rust_bootstrap_relay"
            : "runtime_native_reclaimer",
        entrypoint:
          profile === "rust-bootstrap-relay"
            ? "/pgcf-native-bootstrap-relay"
            : "/pgcf-native-reclaimer",
        args: ["--version"],
        exit: 0,
        stderr: "",
        version: profile,
      },
    ];
  if (profile === "sandbox-controller" || profile === "sandbox-extension")
    return [
      {
        stage: "runtime_sandbox_controller",
        entrypoint:
          (profile === "sandbox-extension" ? "/rootfs" : "") +
          "/usr/local/bin/pgcf-sandbox-controller",
        args: ["--version"],
        exit: 0,
        stderr: "",
        version: "sandbox-controller",
      },
      {
        stage: "runtime_sandbox_holder",
        entrypoint:
          (profile === "sandbox-extension" ? "/rootfs" : "") +
          "/usr/local/bin/pgcf-node-runtime",
        args: ["--version"],
        exit: 0,
        stderr: "",
        version: "sandbox-holder",
      },
    ];
  if (profile === "postgres")
    return [
      {
        stage: "runtime_postgres",
        entrypoint: "/usr/lib/postgresql/18/bin/postgres",
        args: ["--version"],
        exit: 0,
        stdout: "postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)",
        stderr: "",
      },
    ];
  if (profile === "regional")
    return [
      {
        stage: "runtime_help",
        entrypoint: "node",
        args: ["/app/agent.mjs", "--help"],
        exit: 0,
        stderr: "",
      },
      {
        stage: "runtime_agent",
        entrypoint: "node",
        args: ["/app/agent.mjs"],
        exit: 1,
        stdout: JSON.stringify({ event: "agent_startup_failed" }),
        stderr: "",
      },
      {
        stage: "runtime_gateway",
        entrypoint: "node",
        args: ["/app/gateway.mjs"],
        exit: 1,
        stdout: "",
        stderr: JSON.stringify({ event: "gateway_invalid_configuration" }),
      },
      {
        stage: "runtime_relay",
        entrypoint: "node",
        args: ["/app/bootstrap-relay.mjs"],
        exit: 1,
        stdout: "",
        stderr: JSON.stringify({
          event: "bootstrap_relay_invalid_configuration",
        }),
      },
    ];
  return [
    {
      stage: "runtime_bootstrap_modules",
      entrypoint: "node",
      args: [
        "--input-type=module",
        "-e",
        "await import('/app/server.mjs'); await import('/app/proxy-command.mjs'); await import('/app/inspection-proxy-command.mjs'); await import('/app/outside-scan-command.mjs'); await import('/app/proof-proxy-command.mjs');",
      ],
      exit: 0,
      stdout: "",
      stderr: "",
    },
    {
      stage: "runtime_bootstrap_server",
      entrypoint: "node",
      args: ["/app/server.mjs"],
      exit: 1,
      stdout: "",
      stderr: JSON.stringify({ event: "bootstrap_invalid_configuration" }),
    },
    {
      stage: "runtime_bootstrap_proxy",
      entrypoint: "node",
      args: ["/app/proxy-command.mjs"],
      exit: 1,
      stdout: "",
      stderr: "bootstrap_proxy_failed",
    },
    {
      stage: "runtime_inspection_proxy",
      entrypoint: "node",
      args: ["/app/inspection-proxy-command.mjs"],
      exit: 1,
      stdout: "",
      stderr: "inspection_proxy_failed",
    },
    {
      stage: "runtime_outside_scan",
      entrypoint: "node",
      args: ["/app/outside-scan-command.mjs"],
      exit: 1,
      stdout: "",
      stderr: JSON.stringify({
        error_code: "outside_scan_command_input_required",
      }),
    },
    {
      stage: "runtime_proof_proxy",
      entrypoint: "node",
      args: ["/app/proof-proxy-command.mjs"],
      exit: 1,
      stdout: "",
      stderr: "node_proof_proxy_failed",
    },
    {
      stage: "runtime_talos",
      entrypoint: "talosctl",
      args: ["version", "--client"],
      exit: 0,
      stderr: "",
      version: "talos",
    },
    {
      stage: "runtime_kubectl",
      entrypoint: "kubectl",
      args: ["version", "--client=true", "-o=json"],
      exit: 0,
      stderr: "",
      version: "kubectl",
    },
    {
      stage: "runtime_helm",
      entrypoint: "helm",
      args: ["version", "--template={{.Version}}"],
      exit: 0,
      stderr: "",
      version: "helm",
    },
    {
      stage: "runtime_ssh",
      entrypoint: "ssh",
      args: ["-V"],
      exit: 0,
      stdout: "",
      version: "ssh",
    },
  ];
}
export interface RuntimeBuildIdentity {
  sourceRevision: string;
  versionsLockSha256: string;
  cargoLockSha256: string;
}
export function validateRuntimeResult(
  check: RuntimeCheck,
  result: { stdout: string; stderr: string; exit: number | null },
  identity?: RuntimeBuildIdentity,
): void {
  requireCheck(
    result.exit === check.exit &&
      (check.stdout === undefined || result.stdout.trim() === check.stdout) &&
      (check.stderr === undefined || result.stderr.trim() === check.stderr),
    `runtime_result_invalid:${check.stage}`,
  );
  if (
    check.version === "rust-gateway" ||
    check.version === "native-controller" ||
    check.version === "rust-bootstrap-relay" ||
    check.version === "native-reclaimer" ||
    check.version === "sandbox-controller" ||
    check.version === "sandbox-holder"
  ) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new QualificationFailure(`runtime_version_invalid:${check.stage}`);
    }
    const program =
      check.version === "rust-gateway"
        ? "pgcf-native-gateway"
        : check.version === "native-controller"
          ? "pgcf-native-controller"
          : check.version === "rust-bootstrap-relay"
            ? "pgcf-native-bootstrap-relay"
            : check.version === "native-reclaimer"
              ? "pgcf-native-reclaimer"
              : check.version === "sandbox-controller"
                ? "pgcf-sandbox-controller"
                : "pgcf-node-runtime";
    const packagePath =
      check.version === "rust-gateway"
        ? "native-gateway"
        : check.version === "native-controller"
          ? "native-controller"
          : check.version === "rust-bootstrap-relay"
            ? "native-bootstrap-relay"
            : check.version === "native-reclaimer"
              ? "native-reclaimer"
              : check.version === "sandbox-controller"
                ? "sandbox-controller"
                : "node-runtime";
    const sourceVersion = /^version\s*=\s*"([^"\r\n]+)"\s*$/m.exec(
      readFileSync(`apps/${packagePath}/Cargo.toml`, "utf8"),
    )?.[1];
    requireCheck(
      value.program === program &&
        sourceVersion &&
        value.version === sourceVersion &&
        value.rustVersion === rustVersion &&
        typeof value.sourceRevision === "string" &&
        /^[a-f0-9]{40}$/.test(value.sourceRevision) &&
        typeof value.versionsLockSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.versionsLockSha256) &&
        typeof value.cargoLockSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.cargoLockSha256) &&
        (check.version !== "sandbox-controller" ||
          value.containerdApiVersion ===
            sandboxSources.versions.containerd.replace(/^v/, "")) &&
        (check.version !== "sandbox-holder" || value.protocol === 1),
      `runtime_version_invalid:${check.stage}`,
    );
    if (check.version === "native-controller") {
      const sha = (path: string) =>
        createHash("sha256").update(readFileSync(path)).digest("hex");
      requireCheck(
        value.protocolSha256 ===
          sha("packages/contracts/native/protocol.generated.json") &&
          value.controllerContractSha256 ===
            sha("packages/contracts/native/controller.generated.json") &&
          value.configurationSchemaRevision ===
            JSON.parse(
              readFileSync(
                "packages/contracts/native/controller.generated.json",
                "utf8",
              ),
            ).constants.CONFIGURATION_SCHEMA_REVISION,
        `runtime_generated_input_invalid:${check.stage}`,
      );
    }
    if (
      check.version === "rust-bootstrap-relay" ||
      check.version === "native-reclaimer"
    ) {
      const sha = (path: string) =>
        createHash("sha256").update(readFileSync(path)).digest("hex");
      const contract =
        check.version === "rust-bootstrap-relay" ? "bootstrap" : "reclaim";
      const field =
        check.version === "rust-bootstrap-relay"
          ? "bootstrapContractSha256"
          : "reclaimContractSha256";
      requireCheck(
        value.protocolSha256 ===
          sha("packages/contracts/native/protocol.generated.json") &&
          value[field] ===
            sha(`packages/contracts/native/${contract}.generated.json`),
        `runtime_generated_input_invalid:${check.stage}`,
      );
    }
    if (identity)
      requireCheck(
        value.sourceRevision === identity.sourceRevision &&
          value.versionsLockSha256 === identity.versionsLockSha256 &&
          value.cargoLockSha256 === identity.cargoLockSha256,
        `runtime_provenance_invalid:${check.stage}`,
      );
  }
  if (check.version === "talos")
    requireCheck(
      /^Client:\r?\n/.test(result.stdout) &&
        /(?:^|\n)\s*Tag:\s*v([^\s]+)\s*(?:\n|$)/.exec(result.stdout)?.[1] ===
          versions.target.talosVersion &&
        /(?:^|\n)\s*OS\/Arch:\s*linux\/amd64\s*(?:\n|$)/.test(result.stdout),
      "runtime_version_invalid:runtime_talos",
    );
  if (check.version === "kubectl") {
    let version: { clientVersion?: { gitVersion?: string; platform?: string } };
    try {
      version = JSON.parse(result.stdout) as typeof version;
    } catch {
      throw new QualificationFailure("runtime_version_invalid:runtime_kubectl");
    }
    requireCheck(
      version?.clientVersion?.gitVersion ===
        `v${versions.target.kubernetesVersion}` &&
        version.clientVersion.platform === "linux/amd64",
      "runtime_version_invalid:runtime_kubectl",
    );
  }
  if (check.version === "helm")
    requireCheck(
      result.stdout.trim() === `v${versions.bootstrapClients.helm.version}`,
      "runtime_version_invalid:runtime_helm",
    );
  if (check.version === "ssh")
    requireCheck(
      /^OpenSSH_[0-9][^\r\n]*$/.test(result.stderr.trim()),
      "runtime_version_invalid:runtime_ssh",
    );
}
export async function qualifyRuntime(
  image: string,
  profile: ImageProfile = "regional",
  identity?: RuntimeBuildIdentity,
): Promise<void> {
  for (const check of runtimeChecks(profile)) {
    const result = await command(
      check.stage,
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--cpus",
        "2",
        "--memory",
        "2g",
        "--network",
        "none",
        "--entrypoint",
        check.entrypoint,
        image,
        ...check.args,
      ],
      undefined,
      process.env,
      [check.exit],
    );
    validateRuntimeResult(check, result, identity);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requiredImageFile(
  files: readonly LayerFile[],
  path: string,
): LayerFile {
  const file = files.findLast((file) => file.path === path);
  requireCheck(file, `image_artifact_missing:${path}`);
  return file;
}

export async function verifyStorageAssembly(
  files: readonly LayerFile[],
  directory: string,
): Promise<void> {
  const expected = [
    ["usr/local/bin/lvm-driver", storageSources.driver.binary_sha256],
    ["sbin/lvm", storageSources.driver.lvm_binary_sha256],
    ["usr/sbin/pdata_tools", storageSources.thin_tools.binary_sha256],
    [
      "usr/share/licenses/pgcf-thin-tools/COPYING",
      storageSources.thin_tools.license_sha256,
    ],
    [
      "usr/share/pgcf/thin-provisioning-tools-1.1.0.tar.gz",
      storageSources.thin_tools.source_archive_sha256,
    ],
    [
      "usr/share/pgcf/storage-sources.lock.json",
      await hashFile("infra/storage/sources.lock.json"),
    ],
  ] as const;
  for (const [path, sha256] of expected) {
    const file = requiredImageFile(files, path);
    requireCheck(
      file.sha256 === sha256 &&
        (await hashFile(join(directory, file.scanPath))) === sha256,
      `storage_artifact_changed:${path}`,
    );
  }
}

export function rustArtifactPaths(profile: ImageProfile) {
  if (profile === "rust-gateway") return ["pgcf-native-gateway"];
  if (profile === "native-controller") return ["pgcf-native-controller"];
  if (profile === "rust-bootstrap-relay")
    return ["pgcf-native-bootstrap-relay"];
  if (profile === "native-reclaimer") return ["pgcf-native-reclaimer"];
  const prefix = profile === "sandbox-extension" ? "rootfs/" : "";
  return [
    prefix + "usr/local/bin/pgcf-sandbox-controller",
    prefix + "usr/local/bin/pgcf-node-runtime",
  ];
}

export async function verifyRustAssembly(
  files: readonly LayerFile[],
  directory: string,
  profile: ImageProfile,
  sourceRevision?: string,
): Promise<{ path: string; sha256: string; size: number }[]> {
  requireCheck(isRustProfile(profile), "Rust artifact profile required");
  const binaries = rustArtifactPaths(profile),
    licenseRoot =
      profile === "sandbox-extension"
        ? "rootfs/usr/local/share/licenses/pgcf-sandbox"
        : "licenses";
  const extensionFiles =
    profile === "sandbox-extension"
      ? [
          "manifest.yaml",
          "rootfs/usr/local/etc/containers/pgcf-sandbox-controller.yaml",
          "rootfs/etc/cri/conf.d/20-pgcf-prestarted.part",
        ]
      : [];
  requireCheck(
    files.every(
      (file) =>
        binaries.includes(file.path) ||
        extensionFiles.includes(file.path) ||
        file.path.startsWith(licenseRoot + "/"),
    ),
    "Unexpected scratch runtime file",
  );
  const artifacts = [];
  for (const path of binaries) {
    const file = requiredImageFile(files, path);
    const header = Buffer.alloc(20),
      handle = await open(join(directory, file.scanPath), "r");
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    requireCheck(
      header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === 62,
      "Rust artifact is not Linux/amd64 ELF",
    );
    artifacts.push({ path, sha256: file.sha256, size: file.size });
  }
  const inputs = [
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
    ...(profile === "rust-bootstrap-relay"
      ? [
          [
            "bootstrap.generated.json",
            "packages/contracts/native/bootstrap.generated.json",
          ],
        ]
      : []),
    ...(profile === "native-reclaimer"
      ? [
          [
            "reclaim.generated.json",
            "packages/contracts/native/reclaim.generated.json",
          ],
        ]
      : []),
    ...(profile === "native-controller"
      ? [
          [
            "controller.generated.json",
            "packages/contracts/native/controller.generated.json",
          ],
          [
            "power.generated.json",
            "packages/contracts/native/power.generated.json",
          ],
          [
            "measurements.generated.json",
            "packages/contracts/native/measurements.generated.json",
          ],
        ]
      : []),
    ...(profile === "sandbox-controller" || profile === "sandbox-extension"
      ? [
          [
            "compute-pool.generated.json",
            "packages/contracts/native/compute-pool.generated.json",
          ],
          [
            "reclaim.generated.json",
            "packages/contracts/native/reclaim.generated.json",
          ],
        ]
      : []),
  ];
  for (const [name, source] of inputs) {
    const file = requiredImageFile(files, `${licenseRoot}/provenance/${name}`);
    requireCheck(
      file.sha256 === (await hashFile(source!)),
      "Rust generated input provenance changed",
    );
  }
  const license = requiredImageFile(files, `${licenseRoot}/pgcf/LICENSE`);
  requireCheck(
    license.sha256 === (await hashFile("LICENSE")),
    "First-party license changed",
  );
  // Preserve the pinned toolchain's actual notice layout copied by license-bundle.sh.
  for (const notice of [
    "licenses/MIT.txt",
    "licenses/Apache-2.0.txt",
    "COPYRIGHT.html",
    "COPYRIGHT-library.html",
  ])
    requiredImageFile(files, `${licenseRoot}/rust/${notice}`);
  requireCheck(
    files.some((file) =>
      new RegExp("^" + licenseRoot + "/(?:crates|rust)/[^/]+/.+").test(
        file.path,
      ),
    ),
    "Compiled crate notices missing",
  );
  if (profile === "sandbox-extension") {
    requireCheck(
      sourceRevision && /^[a-f0-9]{40}$/.test(sourceRevision),
      "Extension source revision required",
    );
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
    ]) {
      const expected = (await readFile(source!, "utf8"))
        .replace("PGCF_EXTENSION_VERSION", "0.1.0-" + sourceRevision)
        .replace("PGCF_TALOS_VERSION", versions.target.talosVersion);
      const file = requiredImageFile(files, path!);
      requireCheck(
        file.sha256 === createHash("sha256").update(expected).digest("hex"),
        "Extension manifest/service/CRI bytes differ from source",
      );
    }
  }
  return artifacts;
}

export async function verifyTalosRecipeAssembly(
  files: readonly LayerFile[],
  directory: string,
  revision: string,
) {
  const recipePath = "rootfs/usr/local/share/pgcf/talos-recipe.json",
    licensePath = "rootfs/usr/local/share/licenses/pgcf-recipe/LICENSE";
  requireCheck(
    files.length === 3 &&
      files.every((file) =>
        [recipePath, licensePath, "manifest.yaml"].includes(file.path),
      ),
    "Unexpected recipe extension file",
  );
  const recipeFile = requiredImageFile(files, recipePath);
  requireCheck(recipeFile.size <= 65536, "Recipe extension too large");
  const text = await readFile(join(directory, recipeFile.scanPath), "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new QualificationFailure("Recipe extension JSON invalid");
  }
  requireCheck(
    value.source_commit === revision &&
      value.architecture === "amd64" &&
      Array.isArray(value.system_extensions),
    "Recipe source binding changed",
  );
  const plan = sandboxImagePlan({
    sourceCommit: revision,
    architecture: value.architecture,
    sandboxExtension: value.sandbox_extension,
    otherExtensions: value.system_extensions.filter(
      (entry: string) => entry !== value.sandbox_extension,
    ),
  });
  for (const [path, expected] of [
    [recipePath, JSON.stringify(plan.recipe, null, 2) + "\n"],
    ["manifest.yaml", JSON.stringify(plan.schematicManifest, null, 2) + "\n"],
    [licensePath, await readFile("LICENSE", "utf8")],
  ]) {
    const file = requiredImageFile(files, path!);
    requireCheck(
      file.sha256 === createHash("sha256").update(expected!).digest("hex"),
      "Recipe extension differs from canonical qualified inputs",
    );
  }
  return plan.recipeSha256;
}

export async function installScanner(directory: string): Promise<string> {
  const platform = `${process.platform}_${process.arch}`;
  const checksum = scannerArchives[platform];
  requireCheck(checksum, "Unsupported scanner host platform");
  const asset = `gitleaks_${scannerVersion}_${platform}.tar.gz`;
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v${scannerVersion}/${asset}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  requireCheck(
    response.ok && response.body,
    "Official scanner download failed",
  );
  const archive = join(directory, "scanner.tar.gz");
  const metadata = await copyFileStream(
    Readable.fromWeb(response.body),
    archive,
  );
  requireCheck(
    metadata.sha256 === checksum,
    "Scanner release checksum mismatch",
  );
  const binary = join(directory, "gitleaks");
  let found = false;
  const decompressed = join(directory, "scanner.tar");
  await pipeline(
    createReadStream(archive),
    createGunzip(),
    createWriteStream(decompressed, { flags: "wx", mode: 0o600 }),
  );
  await readTar(createReadStream(decompressed), async (header, stream) => {
    const path = safeArchivePath(header.name);
    requireCheck(header.type === "file", "Unexpected scanner archive entry");
    if (path === "gitleaks") {
      await copyFileStream(stream, binary);
      found = true;
    } else for await (const chunk of stream) void chunk;
  });
  requireCheck(found, "Scanner binary missing");
  await chmod(binary, 0o700);
  requireCheck(
    (
      await command("scanner_version", binary, ["version"], directory)
    ).stdout.trim() === scannerVersion,
    "Scanner version mismatch",
  );
  return binary;
}

async function extractImageArchive(
  path: string,
  directory: string,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  await mkdir(directory, { mode: 0o700 });
  await readTar(createReadStream(path), async (header, stream) => {
    const name = safeArchivePath(header.name);
    if (header.type === "directory") return;
    requireCheck(
      header.type === "file" && !entries.has(name),
      "Unexpected saved image archive entry",
    );
    const destination = join(directory, String(entries.size));
    const metadata = await copyFileStream(stream, destination);
    requireCheck(
      metadata.size === header.size,
      "Saved archive entry size mismatch",
    );
    entries.set(name, destination);
  });
  return entries;
}

export async function readLayerArchive(
  path: string,
  directory: string,
  layer: number,
  expectedDiffID: string,
  paths?: string[],
): Promise<{ files: LayerFile[]; metadata: ScanInput }> {
  const scratch = await mkdtemp(join(directory, "decompression-"));
  const raw = join(scratch, "layer.tar");
  const magic = Buffer.alloc(2);
  try {
    const handle = await open(path, "r");
    try {
      await handle.read(magic, 0, 2, 0);
    } finally {
      await handle.close();
    }
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const output = createWriteStream(raw, { flags: "wx", mode: 0o600 });
    if (magic.equals(Buffer.from([0x1f, 0x8b])))
      await pipeline(createReadStream(path), createGunzip(), hashing, output);
    else await pipeline(createReadStream(path), hashing, output);
    requireCheck(
      "sha256:" + hash.digest("hex") === expectedDiffID,
      "Saved layer digest differs from config diffID",
    );
    const files = await extractLayer(
      createReadStream(raw),
      directory,
      layer,
      paths,
    );
    const rawSize = (await stat(raw)).size;
    let offset = 0;
    async function* metadataBytes() {
      for (const file of files) {
        const start = file.bodyOffset!;
        requireCheck(
          Number.isSafeInteger(start) &&
            start >= offset &&
            start + file.size <= rawSize,
          "Invalid tar payload offsets",
        );
        if (start > offset)
          for await (const chunk of createReadStream(raw, {
            start: offset,
            end: start - 1,
          }))
            yield chunk;
        offset = start + file.size;
      }
      if (offset < rawSize)
        for await (const chunk of createReadStream(raw, {
          start: offset,
          end: rawSize - 1,
        }))
          yield chunk;
    }
    const sourcePath = join(directory, `layer-${layer}-tar-metadata`);
    const metadata = await copyFileStream(metadataBytes(), sourcePath);
    requireCheck(
      metadata.size + files.reduce((total, file) => total + file.size, 0) ===
        rawSize,
      "Tar metadata coverage mismatch",
    );
    return {
      files,
      metadata: {
        kind: "tar-metadata",
        layer,
        tarEntry: null,
        path: "tar-header-pax-link-padding",
        sourcePath,
        boundDigest: expectedDiffID,
        ...metadata,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface QualificationReport {
  version: 2;
  scanScope: "pgcf-built-files-and-image-metadata";
  profile?: ImageProfile;
  nativeArtifacts?: NativeArtifactProvenance[];
  recipeSha256?: string;
  canonicalFindings: number;
  opaqueExpectedBytes: number;
  opaqueDetectorBytes: number;
  rawPayloadBytes: number;
  scanInputs: number;
  passes: Record<
    string,
    { aliases: number; detectorBytes: number; findings: number; exit: number }
  >;
  findingCounts: Record<string, number>;
  registryLayerDigests?: string[];
  imageId: string;
  configDigest: string;
  archiveSha256: string;
  revision: string;
  source: string;
  baseImage: string | null;
  baseImageId: string | null;
  builderImage?: string;
  builderImageId?: string;
  compiledArtifacts?: { path: string; sha256: string; size: number }[];
  diffIDs: string[];
  layers: number;
  regularFiles: number;
  scanner: string;
  rawExit: number;
  resolved: number;
  unresolved: number;
}

export function validateProfileProvenance(
  report: Pick<
    QualificationReport,
    | "baseImage"
    | "baseImageId"
    | "builderImage"
    | "builderImageId"
    | "compiledArtifacts"
    | "recipeSha256"
  >,
  profile: ImageProfile,
): void {
  if (profile === "storage")
    requireCheck(
      report.baseImage === storageBase &&
        typeof report.baseImageId === "string" &&
        digestPattern.test(report.baseImageId),
      "Storage base provenance mismatch",
    );
  if (profile === "talos-recipe")
    requireCheck(
      report.baseImage === null &&
        report.baseImageId === null &&
        report.builderImage === undefined &&
        report.builderImageId === undefined &&
        report.compiledArtifacts === undefined &&
        typeof report.recipeSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(report.recipeSha256),
      "Talos recipe scratch provenance mismatch",
    );
  if (isRustProfile(profile)) {
    const paths = rustArtifactPaths(profile);
    requireCheck(
      report.baseImage === null &&
        report.baseImageId === null &&
        report.builderImage === rustBuilder &&
        typeof report.builderImageId === "string" &&
        digestPattern.test(report.builderImageId) &&
        Array.isArray(report.compiledArtifacts) &&
        report.compiledArtifacts.length === paths.length &&
        paths.every(
          (path) =>
            report.compiledArtifacts!.filter(
              (artifact) =>
                artifact.path === path &&
                /^[a-f0-9]{64}$/.test(artifact.sha256) &&
                Number.isSafeInteger(artifact.size) &&
                artifact.size > 0,
            ).length === 1,
        ),
      "Rust scratch provenance mismatch",
    );
  }
}

async function inspectImage(image: string): Promise<{
  Id: string;
  Architecture: string;
  Os: string;
  RootFS: { Type: string; Layers: string[] };
}> {
  // Check both parser and negotiated API before using the platform option introduced in 1.49.
  const help = await command("inspect_help", "docker", [
    "image",
    "inspect",
    "--help",
  ]);
  const version = await command("docker_api", "docker", [
    "version",
    "--format",
    "{{.Client.APIVersion}}",
  ]);
  const api = /^1\.(\d+)$/.exec(version.stdout.trim());
  requireCheck(api, "Invalid negotiated Docker API version");
  const platformFlag =
    /^\s+--platform\s/m.test(help.stdout) && Number(api[1]) >= 49;
  const result = await command("image_inspect", "docker", [
    "image",
    "inspect",
    ...(platformFlag ? ["--platform", "linux/amd64"] : []),
    image,
  ]);
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new QualificationFailure("inspection_invalid_json");
  }
  requireCheck(
    Array.isArray(data) &&
      data.length === 1 &&
      data[0] &&
      typeof data[0] === "object",
    "Unexpected Docker inspection result",
  );
  const inspected = data[0] as {
    Id: string;
    Architecture: string;
    Os: string;
    RootFS: { Type: string; Layers: string[] };
  };
  requireCheck(
    inspected.Os === "linux" && inspected.Architecture === "amd64",
    "Unexpected inspected image platform",
  );
  requireCheck(
    typeof inspected.Id === "string" &&
      digestPattern.test(inspected.Id) &&
      inspected.RootFS?.Type === "layers" &&
      Array.isArray(inspected.RootFS.Layers) &&
      inspected.RootFS.Layers.length > 0 &&
      inspected.RootFS.Layers.every(
        (digest) => typeof digest === "string" && digestPattern.test(digest),
      ),
    "Invalid inspected image identity or diffIDs",
  );
  return inspected;
}

export async function qualify(
  image: string,
  imageId: string,
  revision: string,
  source: string,
  reportPath: string,
  profileInput: ImageProfile = "regional",
): Promise<QualificationReport> {
  requireCheck(
    /^[a-f0-9]{40}$/.test(revision) &&
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source),
    "Invalid qualification identity",
  );
  const profile = imageProfile(profileInput);
  const directory = await mkdtemp(join(tmpdir(), "pgcf-image-qualification-"));
  await chmod(directory, 0o700);
  try {
    requireCheck(
      (await inspectImage(image)).Id === imageId,
      "Tag does not refer to the built image",
    );
    const dockerfile = await readFile(
      profile === "postgres"
        ? "infra/postgres/Dockerfile"
        : profile === "storage"
          ? "infra/storage/Dockerfile"
          : profile === "talos-recipe"
            ? "infra/talos/sandbox/recipe.Dockerfile"
            : `apps/${profile === "rust-gateway" ? "native-gateway" : profile === "rust-bootstrap-relay" ? "native-bootstrap-relay" : profile === "sandbox-extension" ? "sandbox-controller" : profile}/Dockerfile`,
      "utf8",
    );
    const sourceImage = validateDockerfile(dockerfile, profile);
    const baseImage = isScratchProfile(profile) ? null : sourceImage;
    let base: Awaited<ReturnType<typeof inspectImage>> | null = null;
    if (profile !== "talos-recipe") {
      await command("base_pull", "docker", [
        "pull",
        "--platform",
        "linux/amd64",
        sourceImage,
      ]);
      base = await inspectImage(sourceImage);
      requireCheck(
        base.Architecture === "amd64" &&
          base.Os === "linux" &&
          digestPattern.test(base.Id),
        "Unexpected official base platform",
      );
    }
    const baseDiffIDs = isScratchProfile(profile) ? [] : base!.RootFS.Layers;
    const archive = join(directory, "image.tar");
    await writeFile(archive, "", { flag: "wx", mode: 0o600 });
    await command("image_save", "docker", [
      "image",
      "save",
      "--output",
      archive,
      imageId,
    ]);
    const archiveSha256 = await hashFile(archive);
    const entries = await extractImageArchive(
      archive,
      join(directory, "archive"),
    );
    const manifestPath = entries.get("manifest.json");
    requireCheck(manifestPath, "Saved image manifest missing");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      Config: string;
      Layers: string[];
    }[];
    requireCheck(
      manifest.length === 1 && Array.isArray(manifest[0]?.Layers),
      "Saved archive does not contain exactly one image",
    );
    const descriptor = manifest[0]!;
    let registryLayerDigests: string[] | undefined;
    const configPath = entries.get(safeArchivePath(descriptor.Config));
    requireCheck(configPath, "Saved image config missing");
    const configBytes = await readFile(configPath);
    const configDigest =
      "sha256:" + createHash("sha256").update(configBytes).digest("hex");
    const config = validateImageIdentity(
      configBytes,
      configDigest,
      revision,
      source,
    );
    // Classic Docker IDs are config digests; containerd Docker IDs are manifest digests.
    if (imageId !== configDigest) {
      const manifestBlob = entries.get("blobs/sha256/" + imageId.slice(7));
      requireCheck(manifestBlob, "Saved built image manifest blob missing");
      const layerDigests = descriptor.Layers.map((layer) => {
        requireCheck(
          /^blobs\/sha256\/[a-f0-9]{64}$/.test(layer),
          "Unexpected content-addressed layer path",
        );
        return "sha256:" + layer.slice("blobs/sha256/".length);
      });
      registryLayerDigests = layerDigests;
      validateManifestBinding(
        await readFile(manifestBlob),
        imageId,
        configDigest,
        layerDigests,
      );
      for (const [index, layer] of descriptor.Layers.entries()) {
        const path = entries.get(layer);
        requireCheck(
          path && "sha256:" + (await hashFile(path)) === layerDigests[index],
          "Saved manifest layer blob checksum mismatch",
        );
      }
    }
    if (profile === "postgres") {
      // The key-free rootfs snapshot deliberately inherits no key-bearing upstream layer.
      // The exact official source image, engine hash and effective configuration are tested separately.
      requireCheck(
        config.rootfs.diff_ids.length === 1,
        "PostgreSQL assembly must contain exactly one flattened filesystem layer",
      );
    } else if (!isScratchProfile(profile))
      validateBasePrefix(config.rootfs.diff_ids, baseDiffIDs);
    requireCheck(
      config.rootfs.diff_ids.length === descriptor.Layers.length,
      "Saved layer count differs from config",
    );
    const scanDirectory = join(directory, "files");
    await mkdir(scanDirectory, { mode: 0o700 });
    const files: LayerFile[] = [];
    const inputs: ScanInput[] = await metadataInputs(
      configBytes,
      "image-config",
      directory,
      configDigest,
    );
    const savedManifestBytes = await readFile(manifestPath);
    inputs.push(
      ...(await metadataInputs(
        savedManifestBytes,
        "image-manifest",
        directory,
        "sha256:" +
          createHash("sha256").update(savedManifestBytes).digest("hex"),
      )),
    );
    if (imageId !== configDigest) {
      const manifestBytes = await readFile(
        entries.get("blobs/sha256/" + imageId.slice(7))!,
      );
      inputs.push(
        ...(await metadataInputs(
          manifestBytes,
          "image-manifest",
          join(directory, "archive"),
          imageId,
        )),
      );
    }
    for (const [index, layer] of descriptor.Layers.entries()) {
      const path = entries.get(safeArchivePath(layer));
      requireCheck(path, "Saved image layer missing");
      const result = await readLayerArchive(
        path,
        scanDirectory,
        index,
        config.rootfs.diff_ids[index]!,
      );
      files.push(...result.files);
      // Scratch artifacts contain only our assembled outputs, including their tar metadata.
      if (isScratchProfile(profile)) inputs.push(result.metadata);
    }
    // Upstream files are bound by immutable source/package checks and the full image digests.
    // Only PGCF-produced files enter the secret scanner; no upstream finding waivers exist.
    const ownedFiles = selectOwnedFiles(files, profile);
    inputs.push(
      ...ownedFiles.map((file): ScanInput => ({
        kind: "layer-file",
        layer: file.layer,
        tarEntry: file.tarEntry!,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        sourcePath: join(scanDirectory, file.scanPath),
        boundDigest: config.rootfs.diff_ids[file.layer],
      })),
    );
    const compiledArtifacts = isRustProfile(profile)
      ? await verifyRustAssembly(files, scanDirectory, profile, revision)
      : undefined;
    if (profile === "storage")
      await verifyStorageAssembly(files, scanDirectory);
    const recipeSha256 =
      profile === "talos-recipe"
        ? await verifyTalosRecipeAssembly(files, scanDirectory, revision)
        : undefined;
    if (isRustProfile(profile))
      await qualifyRuntime(image, profile, {
        sourceRevision: revision,
        versionsLockSha256: await hashFile("infra/platform/versions.lock.json"),
        cargoLockSha256: await hashFile("Cargo.lock"),
      });
    const scanner = await installScanner(directory);
    const prepared = await prepareInputs(inputs, directory);
    const original = await runPass(
      scanner,
      prepared.original,
      directory,
      "original",
    );
    const opaque = await runPass(scanner, prepared.opaque, directory, "opaque");
    const family = await runPass(scanner, prepared.family, directory, "family");
    const canonical = dedupeFindings([
      ...(await mapFindings(original.findings, prepared.original.aliases)),
      ...(await mapFindings(opaque.findings, prepared.opaque.aliases)),
      ...(await mapFindings(family.findings, prepared.family.aliases)),
    ]);
    const nativeArtifacts = verifyNativeArtifacts(files, profile);
    const classification = { resolved: 0, unresolved: canonical.length };
    const report: QualificationReport = {
      version: 2,
      scanScope: "pgcf-built-files-and-image-metadata",
      profile,
      nativeArtifacts,
      ...(recipeSha256 ? { recipeSha256 } : {}),
      imageId,
      configDigest,
      archiveSha256,
      revision,
      source,
      baseImage,
      baseImageId: isScratchProfile(profile) ? null : base!.Id,
      ...(isRustProfile(profile)
        ? {
            builderImage: sourceImage,
            builderImageId: base!.Id,
            compiledArtifacts,
          }
        : {}),
      diffIDs: config.rootfs.diff_ids,
      layers: descriptor.Layers.length,
      regularFiles: ownedFiles.length,
      scanner: `gitleaks ${scannerVersion}`,
      rawExit: canonical.length ? 2 : 0,
      canonicalFindings: canonical.length,
      opaqueExpectedBytes: prepared.opaque.expectedBytes,
      opaqueDetectorBytes: opaque.detectorBytes,
      rawPayloadBytes: inputs.reduce((total, input) => total + input.size, 0),
      scanInputs: inputs.length,
      passes: {
        original: original.safe,
        opaque: opaque.safe,
        family: family.safe,
      },
      findingCounts: safeFindingCounts(canonical),
      registryLayerDigests,
      ...classification,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    // Private provenance for independent review. No Match, Secret, diagnostics or raw payloads.
    const reportDirectory = await stat(dirname(reportPath));
    requireCheck(
      (reportDirectory.mode & 0o777) === 0o700,
      "Qualification report directory is not private",
    );
    await writeFile(
      reportPath + ".provenance.json",
      JSON.stringify({
        candidate: {
          profile,
          nativeArtifacts,
          ...(recipeSha256 ? { recipeSha256 } : {}),
          imageId,
          configDigest,
          archiveSha256,
          sourceUri: source,
          sourceRevision: revision,
          sourceUriSha256: createHash("sha256").update(source).digest("hex"),
          baseImage,
          baseImageId: isScratchProfile(profile) ? null : base!.Id,
          ...(isRustProfile(profile)
            ? {
                builderImage: sourceImage,
                builderImageId: base!.Id,
                compiledArtifacts,
              }
            : {}),
          baseDiffIDs,
          implementationSha256: createHash("sha256")
            .update(await readFile("scripts/ci/image-qualification.ts"))
            .update(await readFile("scripts/ci/scanner.ts"))
            .update(await readFile("scripts/ci/image-profiles.ts"))
            .digest("hex"),
        },
        findings: canonical.map((finding) => ({
          kind: finding.input.kind,
          layer: finding.input.layer,
          tarEntry: finding.input.tarEntry,
          path: finding.input.path,
          pathSha256: createHash("sha256")
            .update(finding.input.path)
            .digest("hex"),
          sha256: finding.input.sha256,
          size: finding.input.size,
          boundDigest: finding.input.boundDigest,
          officialBaseMembership:
            finding.input.layer !== null &&
            finding.input.layer < baseDiffIDs.length,
          tarBodyOffset:
            finding.input.kind === "layer-file"
              ? files.find(
                  (file) =>
                    file.layer === finding.input.layer &&
                    file.tarEntry === finding.input.tarEntry,
                )?.bodyOffset
              : undefined,
          rule: finding.RuleID,
          startLine: finding.StartLine,
          endLine: finding.EndLine,
          startColumn: finding.StartColumn,
          endColumn: finding.EndColumn,
          tags: finding.Tags,
        })),
      }),
      { flag: "wx", mode: 0o600 },
    );
    requireCheck(
      classification.unresolved === 0,
      "Image has unresolved scanner findings",
    );
    requireCheck(
      (await inspectImage(image)).Id === imageId,
      "Image tag changed during qualification",
    );
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { profile, args } = parseQualificationArguments(process.argv.slice(2));
  const [
    action,
    image,
    imageId,
    revision,
    source,
    reportPath,
    registryReportPath,
  ] = args;
  if (action === "runtime") {
    requireCheck(image, "Missing runtime image");
    await qualifyRuntime(image, profile);
    return;
  }
  requireCheck(
    image && imageId && revision && source && reportPath,
    "Missing qualification arguments",
  );
  if (action === "qualify") {
    const report = await qualify(
      image,
      imageId,
      revision,
      source,
      reportPath,
      profile,
    );
    console.log(JSON.stringify(report));
  } else if (
    action === "verify" ||
    action === "registry" ||
    action === "promote"
  ) {
    const report = JSON.parse(
      await readFile(reportPath, "utf8"),
    ) as QualificationReport;
    validateNativeProvenance(report.nativeArtifacts ?? [], profile);
    validateProfileProvenance(report, profile);
    requireCheck(
      imageProfile(report.profile) === profile &&
        report.version === 2 &&
        report.imageId === imageId &&
        report.revision === revision &&
        report.source === source &&
        report.scanScope === "pgcf-built-files-and-image-metadata" &&
        report.canonicalFindings === 0 &&
        report.resolved === 0 &&
        report.unresolved === 0 &&
        report.rawExit === 0 &&
        report.opaqueExpectedBytes === report.opaqueDetectorBytes,
      "Qualification report does not authorize this image",
    );
    if (action === "registry") {
      requireCheck(
        registryReportPath,
        "Missing registry verification report path",
      );
      await verifyRegistry(image, report, registryReportPath);
    } else if (action === "promote") {
      requireCheck(
        registryReportPath,
        "Missing verified SHA-tag registry report",
      );
      const verified = JSON.parse(
        await readFile(registryReportPath, "utf8"),
      ) as { digest: string; manifestDigest: string; configDigest: string };
      await command(
        "image_promote",
        "docker",
        promotionArguments(image, verified, report),
      );
    } else
      requireCheck(
        (await inspectImage(image)).Id === imageId,
        "Image tag differs from the qualified image",
      );
  } else throw new Error("Unknown qualification action");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    // Deliberately omit exception details: an archive/tool diagnostic may contain a secret.
    const reason =
      error instanceof QualificationFailure
        ? error.message
        : "Archive or tool error";
    console.error(
      `Image qualification failed: ${reason}; no image is authorized for publication.`,
    );
    process.exitCode = 1;
  });
}
