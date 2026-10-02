// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
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
import { verifyRegistry, promotionArguments } from "./registry.ts";
import {
  classifyReviewed,
  readPackageProvenance,
  reviewedFiles,
} from "./reviewed-findings.ts";

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
const publicNodeLine = [
  "const int ",
  "kApiTaggedSize",
  " = ",
  "kApiInt32Size",
  ";",
].join("");

class QualificationFailure extends Error {}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new QualificationFailure(message);
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
  publicLine?: string;
  tarEntry?: number;
  bodyOffset?: number;
}

export async function extractLayer(
  input: AsyncIterable<Uint8Array>,
  directory: string,
  layer: number,
): Promise<LayerFile[]> {
  const files: LayerFile[] = [];
  const links = new Set<string>();
  let tarEntry = 0;
  await mkdir(join(directory, String(layer)), { mode: 0o700 });
  await readTar(input, async (header, stream) => {
    const entry = tarEntry++;
    const path = safeArchivePath(header.name);
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
    if (
      path === "usr/local/include/node/v8-internal.h" &&
      metadata.size === 70804
    )
      file.publicLine = (await readFile(join(directory, scanPath), "utf8"))
        .split("\n")[186]
        ?.trim();
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

export function classifyFindings(
  findings: Finding[],
  files: LayerFile[],
  baseLayerCount: number,
): { resolved: number; unresolved: number } {
  let resolved = 0;
  for (const finding of findings) {
    const file = files.find(
      (entry) => entry.scanPath === finding.File.replace(/^\.\//, ""),
    );
    if (
      file &&
      file.layer < baseLayerCount &&
      file.path === "usr/local/include/node/v8-internal.h" &&
      file.sha256 ===
        "eb74fc0740b7f858a03e319e077c1698d2083325f3154c67771b120fb48f8520" &&
      file.size === 70804 &&
      file.publicLine === publicNodeLine &&
      finding.RuleID === "generic-api-key" &&
      finding.StartLine === 187 &&
      finding.EndLine === 187 &&
      finding.StartColumn === 12 &&
      finding.EndColumn === 42 &&
      finding.Match === ["kApiTaggedSize", " = ", "REDACTED", ";"].join("") &&
      finding.Secret === "REDACTED"
    )
      resolved++;
  }
  return { resolved, unresolved: findings.length - resolved };
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

async function command(
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
      reject(new Error("Qualification tool could not start")),
    );
    child.on("close", (exit) => {
      if (overflow || !accepted.includes(exit ?? -1))
        reject(new Error("Qualification tool failed"));
      else fulfill({ stdout, stderr, exit });
    });
  });
}

export async function qualifyRuntime(image: string): Promise<void> {
  const args = [
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
    "node",
    image,
  ];
  await command("docker", [...args, "/app/agent.mjs", "--help"]);
  const agent = await command(
    "docker",
    [...args, "/app/agent.mjs"],
    undefined,
    process.env,
    [1],
  );
  requireCheck(
    agent.stdout.trim() === JSON.stringify({ event: "agent_startup_failed" }) &&
      !agent.stderr.trim(),
    "Agent runtime did not reject missing configuration cleanly",
  );
  const gateway = await command(
    "docker",
    [...args, "/app/gateway.mjs"],
    undefined,
    process.env,
    [1],
  );
  requireCheck(
    gateway.stderr.trim() ===
      JSON.stringify({ event: "gateway_invalid_configuration" }) &&
      !gateway.stdout.trim(),
    "Gateway runtime did not reject missing configuration cleanly",
  );
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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
    (await command(binary, ["version"], directory)).stdout.trim() ===
      scannerVersion,
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
    const files = await extractLayer(createReadStream(raw), directory, layer);
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
  baseImage: string;
  baseImageId: string;
  diffIDs: string[];
  layers: number;
  regularFiles: number;
  scanner: string;
  rawExit: number;
  resolved: number;
  unresolved: number;
}

async function inspectImage(image: string): Promise<{
  Id: string;
  Architecture: string;
  Os: string;
  RootFS: { Layers: string[] };
}> {
  const data = JSON.parse(
    (
      await command("docker", [
        "image",
        "inspect",
        "--platform",
        "linux/amd64",
        image,
      ])
    ).stdout,
  ) as {
    Id: string;
    Architecture: string;
    Os: string;
    RootFS: { Layers: string[] };
  }[];
  requireCheck(data.length === 1, "Unexpected Docker inspection result");
  return data[0]!;
}

export async function qualify(
  image: string,
  imageId: string,
  revision: string,
  source: string,
  reportPath: string,
): Promise<QualificationReport> {
  requireCheck(
    /^[a-f0-9]{40}$/.test(revision) &&
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source),
    "Invalid qualification identity",
  );
  const directory = await mkdtemp(join(tmpdir(), "pgcf-image-qualification-"));
  await chmod(directory, 0o700);
  try {
    requireCheck(
      (await inspectImage(image)).Id === imageId,
      "Tag does not refer to the built image",
    );
    const dockerfile = await readFile("apps/regional/Dockerfile", "utf8");
    const bases = [
      ...dockerfile.matchAll(
        /^FROM (node:[^\s]+@sha256:[a-f0-9]{64})(?: AS \w+)?$/gm,
      ),
    ].map((match) => match[1]!);
    requireCheck(
      bases.length === 2 && bases[0] === bases[1],
      "Dockerfile base is not an identical pinned official Node image",
    );
    const baseImage = bases[1]!;
    await command("docker", ["pull", "--platform", "linux/amd64", baseImage]);
    const base = await inspectImage(baseImage);
    requireCheck(
      base.Architecture === "amd64" &&
        base.Os === "linux" &&
        digestPattern.test(base.Id),
      "Unexpected official base platform",
    );
    const archive = join(directory, "image.tar");
    await writeFile(archive, "", { flag: "wx", mode: 0o600 });
    await command("docker", ["image", "save", "--output", archive, imageId]);
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
    validateBasePrefix(config.rootfs.diff_ids, base.RootFS.Layers);
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
      inputs.push(result.metadata);
      inputs.push(
        ...result.files.map((file): ScanInput => ({
          kind: "layer-file",
          layer: index,
          tarEntry: file.tarEntry!,
          path: file.path,
          sha256: file.sha256,
          size: file.size,
          sourcePath: join(scanDirectory, file.scanPath),
          boundDigest: config.rootfs.diff_ids[index],
        })),
      );
    }
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
    const manifests: { name: string; version: string }[] = [];
    for (const reviewed of reviewedFiles) {
      if (!reviewed.package) continue;
      const path = reviewed.path.replace(/https\.d\.ts$/, "package.json");
      const file = files.find(
        (file) => file.path === path && file.layer === reviewed.layer,
      );
      requireCheck(file, "Reviewed runtime package manifest missing");
      const manifest = JSON.parse(
        await readFile(join(scanDirectory, file.scanPath), "utf8"),
      ) as { name: string; version: string };
      manifests.push({ name: manifest.name, version: manifest.version });
    }
    const packages = readPackageProvenance(
      await readFile("pnpm-lock.yaml", "utf8"),
      manifests,
    );
    const classification = classifyReviewed(canonical, {
      baseImage,
      baseDiffIDs: base.RootFS.Layers,
      imageDiffIDs: config.rootfs.diff_ids,
      packages,
    });
    // Retain the already-reviewed V8 redacted-report consistency check as an additional guard.
    for (const finding of canonical.filter(
      (finding) =>
        finding.input.path === "usr/local/include/node/v8-internal.h",
    )) {
      const file = files.find(
        (file) =>
          file.layer === finding.input.layer &&
          file.tarEntry === finding.input.tarEntry,
      );
      requireCheck(
        file &&
          classifyFindings(
            [{ ...finding, File: file.scanPath }],
            [file],
            base.RootFS.Layers.length,
          ).resolved === 1,
        "Reviewed V8 report context changed",
      );
    }
    const report: QualificationReport = {
      version: 2,
      imageId,
      configDigest,
      archiveSha256,
      revision,
      source,
      baseImage,
      baseImageId: base.Id,
      diffIDs: config.rootfs.diff_ids,
      layers: descriptor.Layers.length,
      regularFiles: files.length,
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
          imageId,
          configDigest,
          archiveSha256,
          sourceUri: source,
          sourceRevision: revision,
          sourceUriSha256: createHash("sha256").update(source).digest("hex"),
          baseImage,
          baseImageId: base.Id,
          baseDiffIDs: base.RootFS.Layers,
          implementationSha256: createHash("sha256")
            .update(await readFile("scripts/ci/image-qualification.ts"))
            .update(await readFile("scripts/ci/scanner.ts"))
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
            finding.input.layer < base.RootFS.Layers.length,
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
  const [
    action,
    image,
    imageId,
    revision,
    source,
    reportPath,
    registryReportPath,
  ] = process.argv.slice(2);
  if (action === "runtime") {
    requireCheck(image, "Missing runtime image");
    await qualifyRuntime(image);
    return;
  }
  requireCheck(
    image && imageId && revision && source && reportPath,
    "Missing qualification arguments",
  );
  if (action === "qualify") {
    const report = await qualify(image, imageId, revision, source, reportPath);
    console.log(JSON.stringify(report));
  } else if (
    action === "verify" ||
    action === "registry" ||
    action === "promote"
  ) {
    const report = JSON.parse(
      await readFile(reportPath, "utf8"),
    ) as QualificationReport;
    requireCheck(
      report.version === 2 &&
        report.imageId === imageId &&
        report.revision === revision &&
        report.source === source &&
        report.unresolved === 0 &&
        (report.rawExit === 0 || report.rawExit === 2) &&
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
      await command("docker", promotionArguments(image, verified, report));
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
