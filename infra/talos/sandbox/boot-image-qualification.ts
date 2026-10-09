// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  statfs,
  cp,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { pathToFileURL } from "node:url";
import {
  installScanner,
  inspectTalosInstallerArchive,
} from "../../../scripts/ci/image-qualification.ts";
import {
  prepareInputs,
  opaquePrefix,
  runPass,
  mapFindings,
  dedupeFindings,
  safeFindingCounts,
  type ScanInput,
} from "../../../scripts/ci/scanner.ts";
import { jsonRecords } from "../../../apps/node-bootstrap/src/bootstrap.ts";
import {
  sandboxImagePlan,
  bindSandboxImageProfiles,
  TALOS_SANDBOX_BUILD_INPUTS,
} from "./images.ts";
import {
  readBootGpt,
  ukiSections,
  cpioEntries,
  squashfsXattrs,
  safeBootPath,
} from "./boot-format.ts";
import versions from "../../platform/versions.lock.json" with { type: "json" };
import reviewed from "../../../scripts/ci/reviewed-findings.json" with { type: "json" };
import { classifyReviewedTalosBoot } from "../../../scripts/ci/reviewed-findings.ts";
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error(code);
}
const digest = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const canonical = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canonical).join(",") + "]"
      : "{" +
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
          .join(",") +
        "}";
async function json(path: string, max = 32 * 1024 ** 2) {
  const info = await stat(path);
  check(info.isFile() && info.size <= max, "boot_json_bounds");
  return JSON.parse(await readFile(path, "utf8"));
}
async function hash(path: string) {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
    size += chunk.length;
    check(size <= 32 * 1024 ** 3, "boot_artifact_size_limit");
  }
  return { sha256: h.digest("hex"), size };
}
interface CommandResult {
  code: number;
  stdout: string;
}
async function command(
  args: string[],
  log: string,
  timeout: number,
  stdin?: string,
): Promise<CommandResult> {
  const file = createWriteStream(log, { flags: "wx", mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", (b) => {
      stdout += b;
      if (stdout.length > 4 * 1024 ** 2) child.kill("SIGKILL");
      file.write(b);
    });
    child.stderr!.on("data", (b) => file.write(b));
    if (stdin !== undefined) child.stdin!.end(stdin);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", () => {
      clearTimeout(timer);
      file.end();
      reject(Error("boot_docker_command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      file.end();
      resolve({ code: code ?? 137, stdout });
    });
  });
}
/** Docker28 lacks this flag; newer containerd stores need it to select an indexed AMD64 base. */
export async function inspectBootBaseImage(
  image: string,
  directory: string,
): Promise<{
  Id: string;
  Os: string;
  Architecture: string;
  RootFS: { Type: string; Layers: string[] };
}> {
  const help = await command(
      ["image", "inspect", "--help"],
      join(directory, "base-inspect-help.private.log"),
      30000,
    ),
    version = await command(
      ["version", "--format", "{{.Client.APIVersion}}"],
      join(directory, "base-inspect-api.private.log"),
      30000,
    );
  const api = /^1\.(\d+)$/.exec(version.stdout.trim());
  check(
    help.code === 0 && version.code === 0 && api,
    "boot_base_inspection_capability_invalid",
  );
  const platformFlag =
    /^\s+--platform\s/m.test(help.stdout) && Number(api[1]) >= 49;
  const inspected = await command(
    [
      "image",
      "inspect",
      ...(platformFlag ? ["--platform", "linux/amd64"] : []),
      image,
    ],
    join(directory, "base-identity.private.log"),
    30000,
  );
  check(inspected.code === 0, "boot_base_identity_failed");
  let values: unknown;
  try {
    values = JSON.parse(inspected.stdout);
  } catch {
    throw Error("boot_base_identity_json_invalid");
  }
  check(
    Array.isArray(values) &&
      values.length === 1 &&
      values[0] &&
      typeof values[0] === "object",
    "boot_base_identity_ambiguous",
  );
  const actual = values[0] as {
    Id: string;
    Os: string;
    Architecture: string;
    RootFS: { Type: string; Layers: string[] };
  };
  check(
    actual.Os === "linux" && actual.Architecture === "amd64",
    "boot_base_platform_invalid",
  );
  check(
    /^sha256:[a-f0-9]{64}$/.test(actual.Id) &&
      actual.RootFS?.Type === "layers" &&
      Array.isArray(actual.RootFS.Layers) &&
      actual.RootFS.Layers.length > 0 &&
      actual.RootFS.Layers.every(
        (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v),
      ),
    "boot_base_layers_missing",
  );
  return actual;
}
export async function buildBootTools(directory: string) {
  const platform = await command(
    ["info", "--format", "{{.Architecture}}"],
    join(directory, "tool-platform.private.log"),
    30000,
  );
  check(platform.code === 0, "boot_docker_unavailable");
  const architecture =
    platform.stdout.trim() === "x86_64"
      ? "amd64"
      : platform.stdout.trim() === "aarch64"
        ? "arm64"
        : undefined;
  check(architecture, "boot_tool_architecture_invalid");
  const client = versions.bootstrapClients.talos.archives.find(
    (v) => v.os === "linux" && v.architecture === architecture,
  );
  check(client, "boot_talos_client_missing");
  check(
    client.url.endsWith(
      `/v${TALOS_SANDBOX_BUILD_INPUTS.talosVersion}/talosctl-linux-${architecture}`,
    ),
    "boot_talos_client_version_unbound",
  );
  const context = join(directory, "tool-context");
  await mkdir(context, { mode: 0o700 });
  for (const name of ["BootProof.Dockerfile", "boot-inspect-worker.ts"])
    await cp(new URL(name, import.meta.url), join(context, name));
  const image = "pgcf-talos-boot-tools:" + randomUUID();
  const built = await command(
    [
      "build",
      "--platform",
      "linux/" + architecture,
      "--provenance=false",
      "--sbom=false",
      "--build-arg",
      "NODE_IMAGE=" + reviewed.base.image,
      "--build-arg",
      "TALOS_ASSET=" + client.url,
      "--build-arg",
      "TALOS_SHA256=" + client.sha256,
      "--file",
      join(context, "BootProof.Dockerfile"),
      "--tag",
      image,
      context,
    ],
    join(directory, "tool-build.private.log"),
    600000,
  );
  check(built.code === 0, "boot_tool_build_failed");
  const identity = await command(
    ["image", "inspect", image, "--format", "{{.Id}}"],
    join(directory, "tool-identity.private.log"),
    30000,
  );
  check(
    identity.code === 0 && /^sha256:[a-f0-9]{64}$/.test(identity.stdout.trim()),
    "boot_tool_identity_invalid",
  );
  return { image, id: identity.stdout.trim(), architecture, client };
}
interface ToolFile {
  path: string;
  file: string;
  sha256: string;
  size: number;
}
export async function runBootTool(
  image: string,
  job: Record<string, unknown>,
  input: string,
  output: string,
  timeout: number,
  privileged = false,
) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const session = randomUUID(),
    name = "pgcf-boot-" + session,
    inputPath = "/input/" + session;
  const payload = {
    ...job,
    ...(job.mode === "filesystems" || job.mode === "boot"
      ? { raw: inputPath }
      : { path: inputPath }),
  };
  let removed = false;
  try {
    const run = await command(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        "pgcf.boot.session=" + session,
        "--network",
        "none",
        "--read-only",
        "--cpus",
        "2",
        "--memory",
        "3g",
        "--pids-limit",
        "256",
        "--security-opt",
        "no-new-privileges",
        ...(privileged
          ? ["--privileged"]
          : [
              "--cap-drop",
              "ALL",
              ...(job.mode === "squashfs"
                ? ["--cap-add", "DAC_READ_SEARCH"]
                : []),
            ]),
        "--tmpfs",
        "/work:rw,nosuid,nodev,size=2g",
        "--mount",
        `type=bind,src=${resolve(input)},dst=${inputPath},readonly`,
        "--mount",
        `type=bind,src=${resolve(output)},dst=/output`,
        "-i",
        image,
      ],
      join(output, "container.private.log"),
      timeout,
      JSON.stringify(payload),
    );
    check(run.code === 0, "boot_tool_execution_failed");
  } finally {
    await command(
      ["rm", "--force", name],
      join(output, "cleanup.private.log"),
      30000,
    );
    const state = await command(
      [
        "ps",
        "--all",
        "--filter",
        "label=pgcf.boot.session=" + session,
        "--format",
        "{{.Names}}",
      ],
      join(output, "cleanup-status.private.log"),
      30000,
    );
    removed = state.code === 0 && state.stdout.trim() === "";
    check(removed, "boot_container_cleanup_unconfirmed");
  }
  return { container_removed: removed };
}
export function validateBootFacts(
  result: unknown,
  expected: {
    talosVersion: string;
    recipeSha256: string;
    sourceCommit: string;
  },
) {
  const r = result as {
      elapsed_ms: number;
      facts: {
        version: {
          version: { tag: string; arch: string };
          platform: { name: string };
        };
        machine: CommandResult;
        extensions: CommandResult;
        schematic: CommandResult;
      };
    },
    v = r.facts.version;
  check(
    Number.isSafeInteger(r.elapsed_ms) &&
      r.elapsed_ms > 0 &&
      v.version.tag.replace(/^v/, "") === expected.talosVersion &&
      v.version.arch === "amd64" &&
      v.platform.name === "nocloud",
    "boot_version_mismatch",
  );
  for (const value of [r.facts.machine, r.facts.extensions, r.facts.schematic])
    check(value.code === 0, "boot_resource_read_failed");
  const machine = jsonRecords(r.facts.machine.stdout);
  check(machine.length === 1, "boot_machine_status_invalid");
  const state = machine[0]!.spec as {
    stage: string;
    status: { ready: boolean; unmetConditions: unknown[] };
  };
  check(
    state.stage === "maintenance" &&
      state.status.ready === true &&
      state.status.unmetConditions.length === 0,
    "boot_not_healthy_maintenance",
  );
  const extensions = jsonRecords(r.facts.extensions.stdout).map(
    (v) => (v.spec as { metadata: { name: string; version: string } }).metadata,
  );
  check(
    extensions.length === 2 &&
      extensions.some(
        (v) =>
          v.name === "pgcf-sandbox-controller" &&
          v.version === "0.1.0-" + expected.sourceCommit,
      ) &&
      extensions.some(
        (v) => v.name === "schematic" && v.version === expected.recipeSha256,
      ),
    "boot_extension_identity_mismatch",
  );
  const schemas = jsonRecords(r.facts.schematic.stdout);
  check(
    schemas.length === 1 &&
      (schemas[0]!.spec as { schematicId: string; flavor: string })
        .schematicId === expected.recipeSha256 &&
      (schemas[0]!.spec as { flavor: string }).flavor === "PGCF imager",
    "boot_recipe_identity_mismatch",
  );
  return {
    elapsed_ms: r.elapsed_ms,
    talos_version: v.version.tag,
    architecture: v.version.arch,
    platform: v.platform.name,
    machine_stage: state.stage,
    extensions,
  };
}
async function context(directory: string, sourceCommit: string) {
  const path = join(directory, "recipe-context"),
    prior = await json(join(path, "plan.json")),
    recipe = prior.recipe as ReturnType<typeof sandboxImagePlan>["recipe"];
  check(
    sourceCommit === recipe.source_commit &&
      recipe.architecture === "amd64" &&
      recipe.system_extensions.length === 1,
    "boot_recipe_scope_invalid",
  );
  const plan = sandboxImagePlan({
    sourceCommit,
    architecture: "amd64",
    sandboxExtension: recipe.sandbox_extension,
    otherExtensions: [],
  });
  check(canonical(plan) === canonical(prior), "boot_recipe_plan_changed");
  const installer = await json(join(path, "installer.profile.json")),
    raw = await json(join(path, "raw.profile.json")),
    refs = installer.input?.systemExtensions;
  check(
    Array.isArray(refs) &&
      refs.length === 2 &&
      typeof refs[1]?.imageRef === "string",
    "boot_recipe_extension_unbound",
  );
  const bound = bindSandboxImageProfiles(plan, refs[1].imageRef);
  check(
    canonical(installer) === canonical(bound.installer) &&
      canonical(raw) === canonical(bound.raw),
    "boot_profiles_changed",
  );
  for (const [name, profile, ref] of [
    ["extension-gate", "sandbox-extension", recipe.sandbox_extension],
    ["recipe-gate", "talos-recipe", refs[1].imageRef],
  ] as const) {
    const report = await json(join(directory, name, "qualification.json")),
      registry = await json(join(directory, name, "registry.json"));
    check(
      report.version === 2 &&
        report.profile === profile &&
        report.revision === sourceCommit &&
        report.unresolved === 0 &&
        Number.isSafeInteger(report.opaqueExpectedBytes) &&
        report.opaqueExpectedBytes > 0 &&
        report.opaqueExpectedBytes === report.opaqueDetectorBytes &&
        report.configDigest === registry.configDigest &&
        ref.endsWith("@" + registry.digest),
      "boot_input_qualification_unbound",
    );
    if (profile === "talos-recipe")
      check(
        report.recipeSha256 === plan.recipeSha256,
        "boot_qualified_recipe_changed",
      );
  }
  return {
    plan,
    recipeExtension: refs[1].imageRef,
    extensionReport: await json(
      join(directory, "extension-gate", "qualification.json"),
    ),
    path,
  };
}
async function sourceInput(
  path: string,
  logical: string,
  boundDigest?: string,
): Promise<ScanInput> {
  const value = await hash(path);
  return {
    kind: "layer-file",
    layer: null,
    tarEntry: null,
    path: safeBootPath(logical),
    sourcePath: path,
    ...value,
    ...(boundDigest ? { boundDigest } : {}),
  };
}
async function writePayload(directory: string, bytes: Buffer) {
  const path = join(directory, "payload-" + randomUUID());
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}
export async function expandBootInitrd(
  input: string,
  output: string,
  limit = 2 * 1024 ** 3,
) {
  check(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 2 * 1024 ** 3,
    "boot_initrd_expansion_limit",
  );
  let expanded = 0;
  async function* bounded(stream: AsyncIterable<Buffer>) {
    for await (const b of stream) {
      expanded += b.length;
      check(expanded <= limit, "boot_initrd_expansion_limit");
      yield b;
    }
  }
  const inputSize = (await stat(input)).size;
  check(inputSize > 0, "boot_initrd_decompression_failed");
  let consumed = 0;
  while (consumed < inputSize) {
    // Node ends at the first frame; Talos appends the system-extension CPIO in another frame.
    const decoder = createZstdDecompress();
    await pipeline(
      bounded(createReadStream(input, { start: consumed }).pipe(decoder)),
      createWriteStream(output, {
        mode: 0o600,
        flags: consumed === 0 ? "wx" : "a",
      }),
    );
    check(
      Number.isSafeInteger(decoder.bytesWritten) &&
        decoder.bytesWritten > 0 &&
        decoder.bytesWritten <= inputSize - consumed,
      "boot_initrd_frame_consumption_invalid",
    );
    consumed += decoder.bytesWritten;
  }
}
export async function inspectNestedBootPayload(
  uki: string,
  prefix: string,
  work: string,
  image: string,
  inputs: ScanInput[],
) {
  check((await stat(uki)).size <= 1024 ** 3, "boot_uki_size_limit");
  const bytes = await readFile(uki);
  const sections = ukiSections(bytes),
    ukihash = digest(bytes),
    linux = sections.find((s) => s.name === ".linux")!,
    initrd = sections.find((s) => s.name === ".initrd")!;
  const uname = sections.filter((s) => s.name === ".uname");
  check(
    uname.length === 1 && uname[0]!.size <= 128,
    "boot_kernel_release_missing",
  );
  const kernelRelease = bytes
    .subarray(uname[0]!.offset, uname[0]!.offset + uname[0]!.size)
    .toString("ascii")
    .replace(/\0.*$/s, "");
  check(
    /^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9._+-]*$/.test(kernelRelease),
    "boot_kernel_release_invalid",
  );
  const linuxBytes = bytes.subarray(linux.offset, linux.offset + linux.size),
    initrdBytes = bytes.subarray(initrd.offset, initrd.offset + initrd.size);
  check(
    initrdBytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])),
    "boot_initrd_compression_unsupported",
  );
  const linuxPath = await writePayload(work, linuxBytes),
    initrdPath = await writePayload(work, initrdBytes),
    cpioPath = join(work, "cpio-" + randomUUID());
  inputs.push(
    await sourceInput(linuxPath, prefix + "/kernel", "sha256:" + ukihash),
    await sourceInput(initrdPath, prefix + "/initrd.zstd", "sha256:" + ukihash),
  );
  await expandBootInitrd(initrdPath, cpioPath);
  inputs.push(
    await sourceInput(
      cpioPath,
      prefix + "/initrd.cpio",
      "sha256:" + digest(initrdBytes),
    ),
  );
  const cpio = await readFile(cpioPath),
    entries = cpioEntries(cpio),
    files: ToolFile[] = [],
    squash: { sha256: string; files: number }[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.size === 0) continue;
    const body = cpio.subarray(entry.offset, entry.offset + entry.size),
      path = await writePayload(work, body);
    inputs.push(
      await sourceInput(
        path,
        prefix + `/cpio-${entry.index}/` + entry.name,
        "sha256:" + digest(cpio),
      ),
    );
    if (
      body.subarray(0, 4).toString() === "hsqs" ||
      entry.name.endsWith(".sqsh") ||
      entry.name.endsWith(".squashfs")
    ) {
      const squashDigest = digest(body);
      check(
        body.subarray(0, 4).toString() === "hsqs",
        "boot_squashfs_magic_invalid",
      );
      const output = join(work, "squash-" + randomUUID());
      await runBootTool(
        image,
        { mode: "squashfs", prefix: prefix + "/" + entry.name },
        path,
        output,
        180000,
      );
      const facts = (await json(join(output, "files.json"))) as {
        files: ToolFile[];
        metadata: unknown[];
      };
      const pseudoPath = join(output, "filesystem.pseudo");
      check(
        (await stat(pseudoPath)).size <= 2 * 1024 ** 3,
        "boot_pseudo_size_limit",
      );
      inputs.push(
        await sourceInput(
          pseudoPath,
          prefix + `/squash-${entry.index}.pseudo`,
          "sha256:" + squashDigest,
        ),
      );
      const attributes = squashfsXattrs(await readFile(pseudoPath));
      for (const [index, value] of attributes.entries()) {
        const decoded = await writePayload(work, value);
        inputs.push(
          await sourceInput(
            decoded,
            prefix + `/squash-${entry.index}/xattr-${index}`,
            "sha256:" + squashDigest,
          ),
        );
      }

      for (const f of facts.files) {
        check(/^payload-[0-9]+$/.test(f.file), "boot_extracted_file_invalid");
        const child = join(output, f.file),
          actual = await sourceInput(child, f.path, "sha256:" + squashDigest);
        check(
          actual.sha256 === f.sha256 && actual.size === f.size,
          "boot_extracted_file_changed",
        );
        inputs.push(actual);
        files.push({ ...f, file: child });
      }
      const metadata = await writePayload(
        work,
        Buffer.from(JSON.stringify(facts.metadata)),
      );
      inputs.push(
        await sourceInput(
          metadata,
          prefix + `/squash-${entry.index}-metadata.json`,
          "sha256:" + squashDigest,
        ),
      );
      squash.push({ sha256: squashDigest, files: facts.files.length });
    }
  }
  check(squash.length > 0, "boot_root_filesystem_missing");
  return {
    kernel_release: kernelRelease,
    kernel_sha256: digest(linuxBytes),
    initrd_sha256: digest(initrdBytes),
    cpio_sha256: digest(cpio),
    files,
    squash,
  };
}
function expectedPayloads(extensionReport: Record<string, unknown>) {
  const artifacts = extensionReport.compiledArtifacts as {
    path: string;
    sha256: string;
    size: number;
  }[];
  check(
    Array.isArray(artifacts) && artifacts.length === 2,
    "boot_sandbox_provenance_missing",
  );
  const expected = artifacts.map((a) => ({
    path: a.path.replace(/^rootfs\//, ""),
    sha256: a.sha256,
  }));
  return expected;
}
async function verifyPayloads(
  files: ToolFile[],
  expected: { path: string; sha256: string }[],
  plan: ReturnType<typeof sandboxImagePlan>,
) {
  for (const x of expected) {
    const found = files.filter((f) => f.path.endsWith("/" + x.path));
    check(
      found.length === 1 && found[0]!.sha256 === x.sha256,
      "boot_runtime_payload_mismatch",
    );
  }
  const marker = files.filter((f) =>
    f.path.endsWith("/usr/local/share/pgcf/talos-recipe.json"),
  );
  check(marker.length === 1, "boot_recipe_payload_missing");
  check(
    canonical(await json(marker[0]!.file, 65536)) === canonical(plan.recipe),
    "boot_recipe_payload_mismatch",
  );
  for (const [path, source] of [
    ["usr/local/etc/containers/pgcf-sandbox-controller.yaml", "service.yaml"],
    ["etc/cri/conf.d/20-pgcf-prestarted.part", "20-pgcf-prestarted.part"],
  ]) {
    const value = await readFile(new URL(source!, import.meta.url)),
      found = files.filter((f) => f.path.endsWith("/" + path));
    check(
      found.length === 1 && found[0]!.sha256 === digest(value),
      "boot_host_payload_mismatch",
    );
  }
}
export async function qualifyBootImages(
  directoryInput: string,
  sourceCommit: string,
) {
  const directory = resolve(directoryInput);
  check(/^[a-f0-9]{40}$/.test(sourceCommit), "boot_source_revision_invalid");
  const binding = await context(directory, sourceCommit),
    work = await mkdtemp(join(directory, "whole-os-gate-")),
    started = Date.now(),
    installerPath = join(directory, "out", "installer-amd64.tar"),
    compressedPath = join(directory, "out", "nocloud-amd64.raw.xz"),
    rawPath = join(work, "nocloud-amd64.raw");
  let stage = "boot_tool_build";
  try {
    const tools = await buildBootTools(work);
    stage = "boot_base_identity";
    const pull = await command(
      [
        "pull",
        "--platform",
        "linux/amd64",
        TALOS_SANDBOX_BUILD_INPUTS.baseInstaller,
      ],
      join(work, "base-pull.private.log"),
      180000,
    );
    check(pull.code === 0, "boot_base_pull_failed");
    const inspected = await inspectBootBaseImage(
      TALOS_SANDBOX_BUILD_INPUTS.baseInstaller,
      work,
    );
    const baseDiffIDs = inspected.RootFS.Layers;
    check(
      Array.isArray(baseDiffIDs) && baseDiffIDs.length > 0,
      "boot_base_layers_missing",
    );
    stage = "boot_installer_inspection";
    const installer = await inspectTalosInstallerArchive(
      installerPath,
      join(work, "installer"),
      { talosVersion: TALOS_SANDBOX_BUILD_INPUTS.talosVersion, baseDiffIDs },
    );
    stage = "boot_raw_expansion";
    const xz = spawn("xz", ["--decompress", "--stdout", compressedPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let rawSize = 0;
    const completion = new Promise<number | null>((resolve, reject) => {
      xz.once("error", () => reject(Error("boot_raw_expansion_failed")));
      xz.once("close", resolve);
    });
    const timer = setTimeout(() => xz.kill("SIGKILL"), 180000);
    async function* raw() {
      for await (const b of xz.stdout) {
        rawSize += b.length;
        check(rawSize <= 32 * 1024 ** 3, "boot_raw_expansion_limit");
        yield b;
      }
    }
    try {
      await pipeline(
        raw(),
        createWriteStream(rawPath, { flags: "wx", mode: 0o600 }),
      );
      const code = await completion;
      check(code === 0, "boot_raw_expansion_failed");
    } finally {
      clearTimeout(timer);
      xz.kill("SIGKILL");
    }
    const rawIdentity = await hash(rawPath),
      compressedIdentity = await hash(compressedPath),
      gpt = await readBootGpt(rawPath);
    check(
      gpt.partitions.map((p) => p.name).join(",") === "EFI,BIOS,BOOT,META",
      "boot_raw_partition_layout_changed",
    );
    const inputs = [
      ...installer.inputs,
      await sourceInput(rawPath, "raw/nocloud-amd64.raw"),
      await sourceInput(compressedPath, "raw/nocloud-amd64.raw.xz"),
    ];
    stage = "boot_nested_installer";
    const installerUki = installer.files.filter(
      (f) => f.path === "usr/install/amd64/vmlinuz.efi",
    );
    check(installerUki.length === 1, "boot_installer_uki_missing");
    const installerPayload = await inspectNestedBootPayload(
        join(installer.scanDirectory, installerUki[0]!.scanPath),
        "installer-uki",
        work,
        tools.image,
        inputs,
      ),
      expected = expectedPayloads(binding.extensionReport);
    await verifyPayloads(installerPayload.files, expected, binding.plan);
    stage = "boot_raw_filesystems";
    const fsDirectory = join(work, "raw-filesystems");
    await runBootTool(
      tools.image,
      { mode: "filesystems", partitions: gpt.partitions },
      rawPath,
      fsDirectory,
      180000,
      true,
    );
    const rawFiles = (await json(join(fsDirectory, "files.json"))) as {
      files: ToolFile[];
      metadata: unknown[];
    };
    for (const f of rawFiles.files) {
      check(/^payload-[0-9]+$/.test(f.file), "boot_raw_file_invalid");
      const actual = await sourceInput(
        join(fsDirectory, f.file),
        f.path,
        "sha256:" + rawIdentity.sha256,
      );
      check(
        actual.sha256 === f.sha256 && actual.size === f.size,
        "boot_raw_file_changed",
      );
      inputs.push(actual);
    }
    const rawMetadata = await writePayload(
      work,
      Buffer.from(JSON.stringify(rawFiles.metadata)),
    );
    inputs.push(
      await sourceInput(
        rawMetadata,
        "raw/filesystem-metadata.json",
        "sha256:" + rawIdentity.sha256,
      ),
    );
    const rawUkis = rawFiles.files.filter(
      (f) => /\.efi$/.test(f.path) && /EFI\/Linux\//.test(f.path),
    );
    check(rawUkis.length === 1, "boot_raw_uki_missing");
    const rawPayload = await inspectNestedBootPayload(
      join(fsDirectory, rawUkis[0]!.file),
      "raw-uki",
      work,
      tools.image,
      inputs,
    );
    check(
      rawPayload.kernel_sha256 === installerPayload.kernel_sha256 &&
        rawPayload.kernel_release === installerPayload.kernel_release,
      "boot_kernel_artifacts_differ",
    );
    const biosKernel = rawFiles.files.filter(
        (f) => f.path === "raw/BOOT/A/vmlinuz",
      ),
      biosInitrd = rawFiles.files.filter(
        (f) => f.path === "raw/BOOT/A/initramfs.xz",
      );
    // Talos1.14 names this file .xz while its actual payload is Zstandard; compare bytes.
    check(
      biosKernel.length === 1 &&
        biosInitrd.length === 1 &&
        biosKernel[0]!.sha256 === installerPayload.kernel_sha256 &&
        biosInitrd[0]!.sha256 === rawPayload.initrd_sha256,
      "boot_bios_payloads_differ",
    );
    await verifyPayloads(rawPayload.files, expected, binding.plan);
    stage = "boot_full_byte_scan";
    const scanStarted = Date.now();
    const bytes = inputs.reduce((n, v) => n + v.size, 0),
      space = await statfs(work),
      // Original + opaque, plus an upper bound if every input needs a family alias.
      required = bytes * 3 + inputs.length * opaquePrefix.length * 2;
    check(
      space.bavail * space.bsize >= required,
      "boot_scanner_disk_insufficient",
    );
    const scanDir = join(work, "scan");
    await mkdir(scanDir, { mode: 0o700 });
    const scanner = await installScanner(scanDir),
      prepared = await prepareInputs(inputs, scanDir),
      passes = [];
    const mapped = [];
    for (const name of ["original", "opaque", "family"] as const) {
      const pass = await runPass(scanner, prepared[name], scanDir, name);
      passes.push(pass);
      mapped.push(
        ...(await mapFindings(pass.findings, prepared[name].aliases)),
      );
    }
    const findings = dedupeFindings(mapped),
      scanElapsed = Date.now() - scanStarted,
      aliasBytes = Object.values(prepared).reduce(
        (n, p) => n + p.expectedBytes,
        0,
      );
    await writeFile(
      join(work, "findings.private.json"),
      JSON.stringify(
        findings.map((f) => ({
          RuleID: f.RuleID,
          StartLine: f.StartLine,
          EndLine: f.EndLine,
          StartColumn: f.StartColumn,
          EndColumn: f.EndColumn,
          span: f.span,
          input: f.input,
        })),
      ),
      { mode: 0o600, flag: "wx" },
    );
    const classification = classifyReviewedTalosBoot(findings, {
      talosVersion: TALOS_SANDBOX_BUILD_INPUTS.talosVersion,
      baseInstaller: TALOS_SANDBOX_BUILD_INPUTS.baseInstaller,
      baseDiffIDs,
    });
    check(classification.unresolved === 0, "boot_unreviewed_finding");
    stage = "boot_isolated_maintenance";
    const bootDir = join(work, "maintenance");
    await runBootTool(
      tools.image,
      { mode: "boot", timeout_ms: 300000 },
      rawPath,
      bootDir,
      330000,
    );
    const boot = validateBootFacts(
      await json(join(bootDir, "boot.private.json")),
      {
        talosVersion: TALOS_SANDBOX_BUILD_INPUTS.talosVersion,
        sourceCommit,
        recipeSha256: binding.plan.recipeSha256,
      },
    );
    check(
      (await hash(rawPath)).sha256 === rawIdentity.sha256,
      "boot_raw_changed_during_maintenance",
    );
    const result = {
      version: 1,
      passed: true,
      source_commit: sourceCommit,
      qualification_inputs: Object.fromEntries(
        await Promise.all(
          [
            "infra/talos/sandbox/boot-image-qualification.ts",
            "infra/talos/sandbox/ci-artifacts.sh",
            "infra/talos/sandbox/boot-format.ts",
            "infra/talos/sandbox/boot-inspect-worker.ts",
            "infra/talos/sandbox/BootProof.Dockerfile",
            "infra/talos/sandbox/images.ts",
            "infra/platform/versions.lock.json",
            "scripts/ci/image-qualification.ts",
            "scripts/ci/scanner.ts",
            "scripts/ci/reviewed-findings.ts",
            "scripts/ci/reviewed-findings.json",
            "scripts/ci/talos-reviewed-findings.json",
          ].map(async (path) => [path, await hash(path)]),
        ),
      ),
      recipe_sha256: binding.plan.recipeSha256,
      extension_ref: binding.plan.recipe.sandbox_extension,
      recipe_extension_ref: binding.recipeExtension,
      installer: {
        archive_sha256: installer.archiveSha256,
        archive_bytes: installer.archiveSize,
        configDigest: installer.configDigest,
        diffIDs: installer.diffIDs,
        layerDigests: installer.layerDigests,
      },
      raw: { compressed: compressedIdentity, decompressed: rawIdentity, gpt },
      payloads: {
        kernel_release: installerPayload.kernel_release,
        kernel_sha256: installerPayload.kernel_sha256,
        installer_initrd_sha256: installerPayload.initrd_sha256,
        raw_initrd_sha256: rawPayload.initrd_sha256,
        installer_files: installerPayload.files.length,
        raw_files: rawPayload.files.length,
      },
      scan: {
        inputs: inputs.length,
        payload_bytes: bytes,
        temporary_alias_bytes: aliasBytes,
        canonical_findings: findings.length,
        resolved: classification.resolved,
        unresolved: classification.unresolved,
        findings: safeFindingCounts(findings),
        passes: passes.map((p) => p.safe),
        elapsed_ms: scanElapsed,
      },
      boot,
      tool: {
        image_id: tools.id,
        architecture: tools.architecture,
        talos_client_sha256: tools.client.sha256,
      },
      elapsed_ms: Date.now() - started,
    };
    await writeFile(
      join(directory, "whole-os-qualification.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return result;
  } catch (error) {
    await writeFile(
      join(work, "failure.private.json"),
      JSON.stringify({
        passed: false,
        stage,
        code:
          error instanceof Error && /^boot_[a-z_]+$/.test(error.message)
            ? error.message
            : "boot_gate_failed",
      }),
      { mode: 0o600 },
    );
    throw Error("whole_os_qualification_failed:" + stage);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [directory, source, ...rest] = process.argv.slice(2);
  if (!directory || !source || rest.length)
    throw Error(
      "Use boot-image-qualification.ts <CI boot directory> <source commit>",
    );
  qualifyBootImages(directory, source)
    .then((r) => console.log(JSON.stringify(r)))
    .catch(() => {
      console.error(
        "Whole OS qualification failed; installer/raw publication is not authorized.",
      );
      process.exitCode = 1;
    });
}
