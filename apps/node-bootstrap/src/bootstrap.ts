// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  NodeBootstrapAuthority,
  NodeBootstrapCallback,
  NodeBootstrapInput,
  NodeJoinBundle,
  NodeRegionSeed,
  type NodeBootstrapCheckpoint,
  type NodeBootstrapMaterial,
  type NodeBootstrapSpec,
  type NodeBootstrapStage,
  type NodeBootstrapStatus,
} from "../../../packages/contracts/src/node-bootstrap.ts";
import { startNativeProxy, type ProxyConfig } from "./proxy-command.ts";

export const TALOS_VERSION = "1.14.1";
export const KUBERNETES_VERSION = "1.36.3";
export const CHUNK_BYTES = 16 * 1024 ** 2;
const MAX_COMMAND_MS = 540_000;
const OUTPUT_LIMIT = 512 * 1024;
const RECORD = "\n__PGCF_RECORD__\n";
const GI = 1024 ** 3;
const STAGES: NodeBootstrapStage[] = [
  "created", "rescue_verified", "image_verified", "disk_write_intent", "disk_written",
  "gpt_relocated", "rescue_reboot_intent", "talos_maintenance", "config_prepared",
  "config_apply_intent", "config_applied", "talos_reboot_intent", "talos_authenticated",
  "kubernetes_bootstrap_intent", "kubernetes_joined", "awaiting_verification",
];

export class BootstrapError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function inputHash(spec: NodeBootstrapSpec): string { return digest(canonical(spec)); }
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function initialCheckpoint(): NodeBootstrapCheckpoint {
  return {
    stage: "created", status: "running", downloaded_bytes: 0, written_bytes: 0,
    write_intent_offset: null, destructive_intent: false, sealed_ref: null, error_code: null,
  };
}

export interface Command {
  executable: string;
  args: string[];
  signal: AbortSignal;
  timeout_ms: number;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}
export interface CommandResult { exit_code: number; stdout: string }
export type CommandRunner = (command: Command) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command) => {
  if (command.timeout_ms <= 0 || command.timeout_ms > 600_000) throw new BootstrapError("command_bound_invalid");
  command.signal.throwIfAborted();
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: command.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let output_bytes = 0;
    let failure: BootstrapError | null = null;
    const stop = (code: string) => {
      failure ??= new BootstrapError(code);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop("job_cancelled");
    const timer = setTimeout(() => stop("command_timeout"), command.timeout_ms);
    command.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (bytes: Buffer) => {
      output_bytes += bytes.length;
      if (output_bytes > OUTPUT_LIMIT) stop("command_output_limit");
      else stdout += bytes.toString("utf8");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      output_bytes += bytes.length;
      if (output_bytes > OUTPUT_LIMIT) stop("command_output_limit");
    });
    child.once("error", () => { failure ??= new BootstrapError("command_unavailable"); });
    child.once("close", (exit_code) => {
      clearTimeout(timer);
      command.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ exit_code: exit_code ?? 255, stdout });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(command.stdin);
  });
};

export function validateInput(value: unknown): NodeBootstrapInput {
  const input = NodeBootstrapInput.parse(value);
  if (input.input_hash !== inputHash(input.spec)) throw new BootstrapError("input_hash_mismatch");
  const blob = Buffer.from(input.rescue.ssh_host_key.split(" ")[1]!, "base64");
  const keyType = Buffer.from("ssh-ed25519");
  if (
    blob.length !== 51 || blob.readUInt32BE(0) !== keyType.length ||
    !blob.subarray(4, 15).equals(keyType) || blob.readUInt32BE(15) !== 32 ||
    input.rescue.ssh_host_fingerprint !== `SHA256:${createHash("sha256").update(blob).digest("base64").replaceAll("=", "")}`
  ) throw new BootstrapError("rescue_host_key_mismatch");
  try { createPrivateKey(input.rescue.ssh_private_key); }
  catch { throw new BootstrapError("rescue_private_key_invalid"); }
  if (input.spec.role === "worker") {
    if (!input.join_bundle || digest(canonical(input.join_bundle)) !== input.spec.join_bundle_sha256) {
      throw new BootstrapError("join_bundle_identity_mismatch");
    }
    assertBundleIdentity(input.spec, input.join_bundle);
    if (input.join_bundle.kube_system_uid !== input.spec.cluster_uid) throw new BootstrapError("cluster_uid_mismatch");
  } else if (input.join_bundle) assertBundleIdentity(input.spec, input.join_bundle);
  return input;
}

function assertBundleIdentity(spec: NodeBootstrapSpec, material: NodeRegionSeed) {
  if (material.cluster_name !== spec.cluster_name || material.cluster_endpoint !== spec.cluster_endpoint) {
    throw new BootstrapError("cluster_identity_mismatch");
  }
}

export function assertAuthority(input: NodeBootstrapInput, authority: NodeBootstrapAuthority) {
  const spec = input.spec;
  if (
    authority.operation_id !== spec.operation_id || authority.node_id !== spec.node_id ||
    authority.region_id !== spec.region_id || authority.input_hash !== input.input_hash ||
    authority.provider_instance_id !== spec.provider_instance_id ||
    authority.inventory_revision !== spec.inventory_revision
  ) throw new BootstrapError("authority_identity_mismatch");
  if (!authority.authorized) throw new BootstrapError("job_unauthorized");
  if (authority.admitted) throw new BootstrapError("node_already_admitted");
  if (authority.cancelled || authority.checkpoint.status === "cancelled") throw new BootstrapError("job_cancelled");
  if (
    authority.checkpoint.written_bytes > spec.image.raw_bytes ||
    authority.checkpoint.downloaded_bytes > spec.image.compressed_bytes ||
    (authority.checkpoint.written_bytes > 0 && !authority.checkpoint.destructive_intent)
  ) throw new BootstrapError("checkpoint_invalid");
}

export class AuthorityClient {
  constructor(readonly input: NodeBootstrapInput, readonly request: typeof fetch = fetch) {}
  async call(value: NodeBootstrapCallback, signal: AbortSignal) {
    const response = await this.request(this.input.callback.url, {
      method: "POST", headers: {
        authorization: `Bearer ${this.input.callback.bearer}`, "content-type": "application/json",
      }, body: JSON.stringify(NodeBootstrapCallback.parse(value)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error",
    });
    if (!response.ok) throw new BootstrapError(response.status === 409 ? "checkpoint_conflict" : "authority_refused");
    const text = await response.text();
    if (Buffer.byteLength(text) > OUTPUT_LIMIT) throw new BootstrapError("authority_response_limit");
    return JSON.parse(text) as unknown;
  }
  identity() {
    return {
      version: 1 as const, operation_id: this.input.spec.operation_id, node_id: this.input.spec.node_id,
      region_id: this.input.spec.region_id, input_hash: this.input.input_hash, request_id: randomUUID(),
    };
  }
  async read(signal: AbortSignal) {
    const authority = NodeBootstrapAuthority.parse(await this.call({ ...this.identity(), kind: "read" }, signal));
    assertAuthority(this.input, authority);
    return authority;
  }
  async checkpoint(previous: NodeBootstrapAuthority, checkpoint: NodeBootstrapCheckpoint, signal: AbortSignal) {
    try {
      await this.call({ ...this.identity(), kind: "checkpoint", expected_revision: previous.revision, payload: checkpoint }, signal);
    } catch {
      // A lost HTTP response can be a committed CAS. The subsequent authoritative read decides.
    }
    const next = await this.read(signal);
    if (next.revision <= previous.revision || canonical(next.checkpoint) !== canonical(checkpoint)) {
      throw new BootstrapError("checkpoint_not_committed");
    }
    return next;
  }
  async seal(previous: NodeBootstrapAuthority, material: NodeBootstrapMaterial, signal: AbortSignal) {
    try {
      await this.call({ ...this.identity(), kind: "seal", expected_revision: previous.revision, payload: material }, signal);
    } catch {
      // Credentials must be durably recovered before ephemeral local copies can be used.
    }
    const next = await this.read(signal);
    if (canonical(next.protected_material) !== canonical(material) || !next.checkpoint.sealed_ref) {
      throw new BootstrapError("credentials_not_sealed");
    }
    return next;
  }
}

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BootstrapError("readback_invalid");
  return value as Json;
}
function array(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new BootstrapError("readback_invalid");
  return value.map(record);
}

export function verifyRescue(spec: NodeBootstrapSpec, stdout: string) {
  const parts = stdout.trim().split(RECORD);
  if (parts.length !== 7) throw new BootstrapError("rescue_readback_invalid");
  const blocks = array(record(JSON.parse(parts[0]!)).blockdevices);
  const disks = blocks.filter((disk) => disk.type === "disk");
  const disk = disks[0];
  if (disks.length !== 1 || !disk || disk.path !== spec.hardware.install_disk || Number(disk.size) !== spec.hardware.disk_bytes) {
    throw new BootstrapError("rescue_disk_mismatch");
  }
  const mounted = (block: Json): boolean =>
    (Array.isArray(block.mountpoints) && block.mountpoints.some((point) => typeof point === "string" && point.length > 0)) ||
    (Array.isArray(block.children) && array(block.children).some(mounted));
  if (mounted(disk)) throw new BootstrapError("rescue_disk_mounted");
  const links = array(JSON.parse(parts[1]!)).filter((link) => link.link_type === "ether");
  const nic = links[0];
  if (links.length !== 1 || !nic || nic.address !== spec.hardware.mac) throw new BootstrapError("rescue_mac_mismatch");
  const addresses = array(JSON.parse(parts[2]!));
  const nicAddress = addresses.find((address) => address.ifname === nic.ifname);
  if (!nicAddress || !array(nicAddress.addr_info).some((address) =>
    address.family === "inet" && address.local === spec.hardware.ipv4 && address.prefixlen === spec.hardware.prefix_length,
  )) throw new BootstrapError("rescue_address_mismatch");
  const defaults = array(JSON.parse(parts[3]!));
  if (defaults.length !== 1 || defaults[0]?.gateway !== spec.hardware.gateway || defaults[0]?.dev !== nic.ifname) {
    throw new BootstrapError("rescue_gateway_mismatch");
  }
  const roots = array(record(JSON.parse(parts[4]!)).filesystems);
  if (roots.length !== 1 || !["tmpfs", "ramfs", "rootfs"].includes(String(roots[0]?.fstype))) {
    throw new BootstrapError("rescue_root_not_ram");
  }
  const swap = record(JSON.parse(parts[5]!));
  if (!Array.isArray(swap.swapdevices) || swap.swapdevices.length) throw new BootstrapError("rescue_swap_active");
  if (!/^\d+$/.test(parts[6]!) || Number(parts[6]) < spec.hardware.rescue_ram_min_bytes) {
    throw new BootstrapError("rescue_ram_insufficient");
  }
}

export function networkKernelArg(spec: NodeBootstrapSpec) {
  const hardware = spec.hardware;
  return `ip=${hardware.ipv4}::${hardware.gateway}:${hardware.prefix_length}::eth0:off:${hardware.dns.join(":")}`;
}
export function imageURL(spec: NodeBootstrapSpec) {
  return `https://factory.talos.dev/image/${spec.image.schematic_id}/v${TALOS_VERSION}/nocloud-amd64.raw.xz`;
}

interface Partition { start: number; size: number; type: string; uuid: string; name?: string; attrs?: string }
export function partitions(stdout: string): Partition[] {
  const entries = array(record(record(JSON.parse(stdout)).partitiontable).partitions);
  if (entries.length !== 4) throw new BootstrapError("image_partition_count");
  return entries.map((value) => {
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.size) || Number(value.start) < 0 || Number(value.size) <= 0 ||
      typeof value.type !== "string" || typeof value.uuid !== "string") throw new BootstrapError("image_partition_invalid");
    return {
      start: Number(value.start), size: Number(value.size), type: value.type, uuid: value.uuid,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.attrs === "string" ? { attrs: value.attrs } : {}),
    };
  });
}

export interface BootstrapOptions {
  run?: CommandRunner;
  request?: typeof fetch;
  operator_direct?: boolean;
  proxy_command_path?: string;
}

export class BootstrapJob {
  readonly authority: AuthorityClient;
  readonly run: CommandRunner;
  readonly request: typeof fetch;
  readonly abort = new AbortController();
  private directory = "";
  private env: NodeJS.ProcessEnv = {};
  private sshArgs: string[] = [];
  private nativeProxy: Awaited<ReturnType<typeof startNativeProxy>> | null = null;
  private seed: NodeRegionSeed | null = null;
  constructor(readonly input: NodeBootstrapInput, readonly options: BootstrapOptions = {}) {
    this.input = validateInput(input);
    this.authority = new AuthorityClient(this.input, options.request);
    this.run = options.run ?? runCommand;
    this.request = options.request ?? fetch;
    if (input.spec.transport.mode === "operator_direct" && !options.operator_direct) {
      throw new BootstrapError("operator_transport_not_enabled");
    }
  }
  async status(): Promise<NodeBootstrapStatus> {
    const authority = await this.authority.read(AbortSignal.timeout(15_000));
    return { operation_id: this.input.spec.operation_id, input_hash: this.input.input_hash, revision: authority.revision, checkpoint: authority.checkpoint };
  }
  async cancel() {
    const signal = AbortSignal.timeout(15_000);
    const previous = await this.authority.read(signal);
    this.abort.abort();
    const checkpoint = { ...previous.checkpoint, status: "cancelled" as const, error_code: "job_cancelled" };
    await this.authority.call({ ...this.authority.identity(), kind: "checkpoint", expected_revision: previous.revision, payload: checkpoint }, signal);
  }
  private async execute(executable: string, args: string[], stdin?: string, permit_failure = false) {
    const result = await this.run({ executable, args, signal: this.abort.signal, timeout_ms: MAX_COMMAND_MS, env: this.env, ...(stdin === undefined ? {} : { stdin }) });
    if (result.exit_code && !permit_failure) throw new BootstrapError("native_command_failed");
    return result;
  }
  private async ssh(script: string, permit_failure = false) {
    return await this.execute("ssh", [...this.sshArgs, "root@" + this.input.spec.hardware.ipv4, "bash", "-se"], `set -euo pipefail\n${script}\n`, permit_failure);
  }
  private remotePath(name: string) { return `/run/pgcf-bootstrap/${this.input.spec.operation_id}/${name}`; }
  private async checkpoint(stage: NodeBootstrapStage, fields: Partial<NodeBootstrapCheckpoint> = {}) {
    const previous = await this.authority.read(this.abort.signal);
    return await this.authority.checkpoint(previous, {
      ...previous.checkpoint, stage, status: "running", error_code: null, ...fields,
    }, this.abort.signal);
  }
  private async inspectRescue() {
    const result = await this.ssh([
      "lsblk --bytes --json --output NAME,PATH,TYPE,SIZE,MOUNTPOINTS",
      "ip -json link", "ip -json -4 address", "ip -json -4 route show default",
      "findmnt --json --target / --output FSTYPE", "swapon --show --json --bytes",
      "awk '$1 == \"MemTotal:\" {printf \"%.0f\\n\", $2 * 1024}' /proc/meminfo",
    ].join(`\nprintf ${shellQuote(RECORD)}\n`));
    verifyRescue(this.input.spec, result.stdout);
  }
  private guardScript() {
    const hardware = this.input.spec.hardware;
    const disk = shellQuote(hardware.install_disk);
    return [
      `test "$(blockdev --getsize64 ${disk})" = ${hardware.disk_bytes}`,
      `test "$(lsblk --noheadings --output TYPE ${disk} | head -n1 | tr -d ' ')" = disk`,
      `test -z "$(lsblk --noheadings --output MOUNTPOINTS ${disk} | tr -d '[:space:]')"`,
      "test -z \"$(swapon --show --noheadings)\"",
      "case \"$(findmnt --noheadings --target / --output FSTYPE)\" in tmpfs|ramfs|rootfs) ;; *) exit 41 ;; esac",
    ].join("\n");
  }
  private async setup() {
    this.directory = await mkdtemp(join(tmpdir(), "pgcf-bootstrap-"));
    await chmod(this.directory, 0o700);
    this.env = { PATH: process.env.PATH, LANG: "C", TMPDIR: this.directory };
    await writeFile(join(this.directory, "rescue-identity"), this.input.rescue.ssh_private_key, { mode: 0o600 });
    await writeFile(join(this.directory, "known-hosts"), `${this.input.spec.operation_id} ${this.input.rescue.ssh_host_key}\n`, { mode: 0o600 });
    this.sshArgs = [
      "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", `UserKnownHostsFile=${join(this.directory, "known-hosts")}`,
      "-o", `HostKeyAlias=${this.input.spec.operation_id}`, "-o", "HostKeyAlgorithms=ssh-ed25519",
      "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2", "-o", "IdentitiesOnly=yes", "-i", join(this.directory, "rescue-identity"),
    ];
    if (this.input.spec.transport.mode === "relay") {
      const config: ProxyConfig = { spec: this.input.spec, input_hash: this.input.input_hash, callback: this.input.callback };
      const file = join(this.directory, "proxy.json");
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
      this.sshArgs.push("-o", `ProxyCommand=${shellQuote(process.execPath)} ${shellQuote(this.options.proxy_command_path ?? "/app/proxy-command.mjs")} ${shellQuote(file)}`);
      this.nativeProxy = await startNativeProxy(config, this.abort.signal);
      this.env.HTTPS_PROXY = this.nativeProxy.url;
      this.env.HTTP_PROXY = this.nativeProxy.url;
      this.env.NO_PROXY = "";
    }
  }
  private async verifySchematic() {
    const response = await this.request("https://factory.talos.dev/schematics", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ customization: { extraKernelArgs: [networkKernelArg(this.input.spec)] } }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]), redirect: "error",
    });
    if (!response.ok) throw new BootstrapError("schematic_verification_failed");
    const body = await response.text();
    if (body.length > 4096 || record(JSON.parse(body)).id !== this.input.spec.image.schematic_id) {
      throw new BootstrapError("schematic_identity_mismatch");
    }
  }
  private async verifyImage() {
    const spec = this.input.spec;
    const compressed = shellQuote(this.remotePath("image.raw.xz"));
    const raw = shellQuote(this.remotePath("image.raw"));
    await this.ssh(`umask 077\nmkdir -p ${shellQuote(this.remotePath(""))}\ncommand -v curl xz sfdisk sgdisk dd cmp sha256sum stat blockdev >/dev/null\ntest ! -L ${compressed}\ntest ! -L ${raw}`);
    let size = Number((await this.ssh(`if test -f ${compressed}; then stat --format=%s ${compressed}; else printf 0; fi`)).stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > spec.image.compressed_bytes) throw new BootstrapError("image_download_size_invalid");
    while (size < spec.image.compressed_bytes) {
      await this.authority.read(this.abort.signal);
      const result = await this.ssh(`curl --silent --show-error --fail --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 480 --retry 0 --continue-at - --output ${compressed} ${shellQuote(imageURL(spec))}`, true);
      const next = Number((await this.ssh(`stat --format=%s ${compressed}`)).stdout.trim());
      if (!Number.isSafeInteger(next) || next <= size || next > spec.image.compressed_bytes || (result.exit_code !== 0 && result.exit_code !== 28)) {
        throw new BootstrapError("image_download_incomplete");
      }
      size = next;
      await this.checkpoint("rescue_verified", { downloaded_bytes: size });
    }
    await this.ssh(`printf '%s  %s\\n' ${shellQuote(spec.image.compressed_sha256)} ${compressed} | sha256sum --check --status\nxz --decompress --stdout --single-stream ${compressed} > ${raw}.partial\ntest "$(stat --format=%s ${raw}.partial)" = ${spec.image.raw_bytes}\nprintf '%s  %s\\n' ${shellQuote(spec.image.raw_sha256)} ${raw}.partial | sha256sum --check --status\nmv -- ${raw}.partial ${raw}`);
    const layout = partitions((await this.ssh(`sfdisk --json ${raw}`)).stdout);
    for (const partition of layout) {
      if ((partition.start + partition.size) * 512 > spec.image.raw_bytes) throw new BootstrapError("image_partition_out_of_bounds");
    }
    return layout;
  }
  private async writeDisk() {
    const spec = this.input.spec;
    const raw = shellQuote(this.remotePath("image.raw"));
    const disk = shellQuote(spec.hardware.install_disk);
    let authority = await this.authority.read(this.abort.signal);
    if (!authority.checkpoint.destructive_intent) {
      authority = await this.checkpoint("disk_write_intent", { destructive_intent: true, write_intent_offset: 0 });
      await this.ssh(`${this.guardScript()}\nsgdisk --zap-all ${disk}`);
    }
    let offset = authority.checkpoint.written_bytes;
    if (offset % 512 !== 0 || (offset !== spec.image.raw_bytes && offset % CHUNK_BYTES !== 0)) throw new BootstrapError("write_offset_invalid");
    // Every acknowledged chunk is read back after restart; a stored offset alone is not disk evidence.
    for (let verified = 0; verified < offset; verified += CHUNK_BYTES) {
      const count = Math.min(CHUNK_BYTES, offset - verified);
      await this.ssh(`cmp --bytes=${count} --ignore-initial=${verified}:${verified} ${raw} ${disk}`);
    }
    while (offset < spec.image.raw_bytes) {
      const count = Math.min(CHUNK_BYTES, spec.image.raw_bytes - offset);
      authority = await this.authority.read(this.abort.signal);
      if (!authority.checkpoint.destructive_intent) throw new BootstrapError("destructive_intent_missing");
      const comparison = await this.ssh(`cmp --bytes=${count} --ignore-initial=${offset}:${offset} ${raw} ${disk}`, true);
      if (comparison.exit_code === 1) {
        if (authority.checkpoint.write_intent_offset !== null && authority.checkpoint.write_intent_offset !== offset) throw new BootstrapError("write_intent_mismatch");
        await this.checkpoint("disk_write_intent", { write_intent_offset: offset });
        // SSH disconnects never replay a command. Re-entry compares this exact chunk before deciding.
        await this.ssh(`${this.guardScript()}\ndd if=${raw} of=${disk} bs=512 skip=${offset / 512} seek=${offset / 512} count=${count / 512} conv=notrunc,fsync status=none\ncmp --bytes=${count} --ignore-initial=${offset}:${offset} ${raw} ${disk}`);
      } else if (comparison.exit_code !== 0) throw new BootstrapError("disk_readback_failed");
      offset += count;
      await this.checkpoint("disk_write_intent", { written_bytes: offset, write_intent_offset: null });
    }
    await this.checkpoint("disk_written", { written_bytes: spec.image.raw_bytes });
  }
  private async verifyPartitions(expected: Partition[]) {
    const raw = shellQuote(this.remotePath("image.raw"));
    const disk = shellQuote(this.input.spec.hardware.install_disk);
    if (canonical(partitions((await this.ssh(`sfdisk --json ${disk}`)).stdout)) !== canonical(expected)) {
      throw new BootstrapError("disk_partition_mismatch");
    }
    for (const partition of expected) {
      await this.ssh(`cmp --bytes=${partition.size * 512} --ignore-initial=${partition.start * 512}:${partition.start * 512} ${raw} ${disk}`);
    }
    const validation = await this.ssh(`sgdisk --verify ${disk}`);
    if (!validation.stdout.includes("No problems found.")) throw new BootstrapError("disk_gpt_invalid");
  }
  private async talos(args: string[], insecure = false, permit_failure = false) {
    return await this.execute("talosctl", [
      "--nodes", this.input.spec.hardware.ipv4, "--endpoints", this.input.spec.hardware.ipv4,
      ...(insecure ? ["--insecure"] : ["--talosconfig", join(this.directory, "talosconfig")]),
      ...args,
    ], undefined, permit_failure);
  }
  private async kube(args: string[], permit_failure = false) {
    return await this.execute("kubectl", ["--kubeconfig", join(this.directory, "kubeconfig"), "--request-timeout=30s", ...args], undefined, permit_failure);
  }
  private async prepareConfig(authority: NodeBootstrapAuthority) {
    const spec = this.input.spec;
    let material = authority.protected_material?.material ?? this.input.join_bundle;
    if (!material) {
      if (spec.role !== "controlplane" || STAGES.indexOf(authority.checkpoint.stage) >= STAGES.indexOf("config_apply_intent")) {
        throw new BootstrapError("sealed_cluster_material_missing");
      }
      await this.execute("talosctl", ["gen", "secrets", "--talos-version", `v${TALOS_VERSION}`, "--output-file", join(this.directory, "machine-secrets")]);
    } else {
      assertBundleIdentity(spec, material);
      await writeFile(join(this.directory, "machine-secrets"), material.talos_machine_secrets_yaml, { mode: 0o600 });
    }
    const hardware = spec.hardware;
    const zero = Array(4).fill(0).join(".");
    const network = [
      { machine: {
        network: { hostname: spec.hostname, interfaces: [{ deviceSelector: { hardwareAddr: hardware.mac }, addresses: [`${hardware.ipv4}/${hardware.prefix_length}`], routes: [{ network: `${zero}/0`, gateway: hardware.gateway }], dhcp: false }] },
        certSANs: [hardware.ipv4], install: { disk: hardware.install_disk, image: `factory.talos.dev/installer/${spec.image.schematic_id}@${spec.image.installer_digest}` },
        nodeLabels: { "pgcf.io/node-id": spec.node_id, "pgcf.io/region": spec.region_id },
        nodeTaints: { "pgcf.io/quarantine": "bootstrap:NoSchedule" },
      } },
      { apiVersion: "v1alpha1", kind: "ResolverConfig", nameservers: hardware.dns.map((address) => ({ address })), hostDNS: { enabled: true, forwardKubeDNSToHost: true } },
    ];
    const storage = [
      { apiVersion: "v1alpha1", kind: "VolumeConfig", name: "EPHEMERAL", provisioning: { diskSelector: { match: "system_disk" }, grow: false, minSize: `${spec.storage.ephemeral_gib}GiB`, maxSize: `${spec.storage.ephemeral_gib}GiB` }, mount: { secure: true } },
      { apiVersion: "v1alpha1", kind: "RawVolumeConfig", name: "pgcf-lvm", provisioning: { diskSelector: { match: "system_disk" }, grow: false, minSize: `${spec.storage.lvm_gib}GiB`, maxSize: `${spec.storage.lvm_gib}GiB` } },
      { apiVersion: "v1alpha1", kind: "LVMVolumeGroupConfig", name: "pgcf", provisioning: { volumeSelector: { match: 'volume.partition_label == "r-pgcf-lvm"' } } },
    ];
    const reservations = { apiVersion: "v1alpha1", kind: "KubeletConfig", config: { systemReserved: { cpu: "500m", memory: "512Mi", pid: "100", "ephemeral-storage": "256Mi" }, kubeReserved: { cpu: "500m", memory: "512Mi" } } };
    const scheduling = [reservations, { apiVersion: "v1alpha1", kind: "KubeNodeConfig", taints: { "node-role.kubernetes.io/control-plane": { $patch: "delete" } } }];
    const cilium = [
      { apiVersion: "v1alpha1", kind: "KubeFlannelCNIConfig", $patch: "delete" },
      { apiVersion: "v1alpha1", kind: "KubeProxyConfig", enabled: false },
      { apiVersion: "v1alpha1", kind: "KubePrismConfig", port: 7445 },
    ];
    for (const [name, documents] of [["network", network], ["storage", storage], ["reservations", [reservations]], ["scheduling", scheduling], ["cilium", cilium]] as const) {
      await writeFile(join(this.directory, name), documents.map((document) => stringify(document)).join("---\n"), { mode: 0o600 });
    }
    await this.execute("talosctl", [
      "gen", "config", spec.cluster_name, spec.cluster_endpoint, "--talos-version", `v${TALOS_VERSION}`,
      "--kubernetes-version", KUBERNETES_VERSION, "--install-disk", hardware.install_disk,
      "--with-secrets", join(this.directory, "machine-secrets"), "--config-patch", `@${join(this.directory, "network")}`,
      "--config-patch", `@${join(this.directory, "storage")}`, "--config-patch-control-plane", `@${join(this.directory, "cilium")}`,
      "--config-patch-control-plane", `@${join(this.directory, "scheduling")}`, "--config-patch-worker", `@${join(this.directory, "reservations")}`,
      "--output", this.directory, "--force",
    ]);
    await this.execute("talosctl", ["validate", "--mode", "cloud", "--strict", "--config", join(this.directory, `${spec.role}.yaml`)]);
    if (!material) {
      material = NodeRegionSeed.parse({
        version: 1, cluster_name: spec.cluster_name, cluster_endpoint: spec.cluster_endpoint,
        talos_version: TALOS_VERSION, kubernetes_version: KUBERNETES_VERSION,
        talos_machine_secrets_yaml: await readFile(join(this.directory, "machine-secrets"), "utf8"),
        talos_admin_config: await readFile(join(this.directory, "talosconfig"), "utf8"),
      });
      authority = await this.authority.seal(await this.authority.read(this.abort.signal), { purpose: "region_seed", material }, this.abort.signal);
    }
    this.seed = material;
    // A supplied config can carry proxy overrides. Pin its proxy to the authorized local bridge.
    const admin = record(parse(material.talos_admin_config));
    const contexts = record(admin.contexts);
    const context = record(contexts[String(admin.context)]);
    context["proxy-url"] = this.nativeProxy?.url ?? "direct";
    context.endpoints = [hardware.ipv4];
    context.nodes = [hardware.ipv4];
    await writeFile(join(this.directory, "talosconfig"), stringify(admin), { mode: 0o600 });
    if ("kubeconfig" in material && typeof material.kubeconfig === "string") await this.writeKubeconfig(material.kubeconfig);
    if (STAGES.indexOf(authority.checkpoint.stage) < STAGES.indexOf("config_prepared")) await this.checkpoint("config_prepared");
  }
  private async writeKubeconfig(text: string) {
    const config = record(parse(text));
    const clusters = array(config.clusters);
    if (clusters.length !== 1) throw new BootstrapError("kubeconfig_cluster_invalid");
    const cluster = record(clusters[0]!.cluster);
    if (cluster.server !== this.input.spec.cluster_endpoint || cluster["insecure-skip-tls-verify"] || !cluster["certificate-authority-data"]) {
      throw new BootstrapError("kubeconfig_identity_invalid");
    }
    const users = array(config.users);
    if (users.length !== 1 || !record(users[0]!.user)["client-certificate-data"] || !record(users[0]!.user)["client-key-data"] || record(users[0]!.user).exec) {
      throw new BootstrapError("kubeconfig_credentials_invalid");
    }
    if (this.nativeProxy) cluster["proxy-url"] = this.nativeProxy.url;
    else delete cluster["proxy-url"];
    await writeFile(join(this.directory, "kubeconfig"), stringify(config), { mode: 0o600 });
  }
  private async authenticatedReadback() {
    const version = await this.talos(["version", "--output", "json"]);
    const parsed = record(JSON.parse(version.stdout));
    if (!canonical(parsed).includes(`v${TALOS_VERSION}`)) throw new BootstrapError("talos_version_mismatch");
    const disk = await this.talos(["get", "disks", "--output", "json"]);
    const records = jsonRecords(disk.stdout);
    const found = records.filter((entry) => {
      const value = record(entry.spec);
      return value.dev_path === this.input.spec.hardware.install_disk && Number(value.size) === this.input.spec.hardware.disk_bytes;
    });
    if (found.length !== 1) throw new BootstrapError("talos_disk_mismatch");
    const volumes = jsonRecords((await this.talos(["get", "volumestatus", "--output", "json"])).stdout);
    for (const [name, bytes] of [["EPHEMERAL", this.input.spec.storage.ephemeral_gib * GI], ["r-pgcf-lvm", this.input.spec.storage.lvm_gib * GI]] as const) {
      const volume = volumes.find((entry) => record(entry.metadata).id === name);
      if (!volume || record(volume.spec).phase !== "ready" || Number(record(volume.spec).size) !== bytes) throw new BootstrapError("talos_volume_mismatch");
    }
    const state = volumes.find((entry) => record(entry.metadata).id === "STATE");
    if (!state || record(state.spec).phase !== "ready") throw new BootstrapError("talos_state_not_ready");
    const groups = jsonRecords((await this.talos(["get", "lvmvolumegroupstatus", "--output", "json"])).stdout);
    const group = groups.find((entry) => record(entry.metadata).id === "pgcf");
    if (!group || record(group.spec).phase !== "ready") throw new BootstrapError("talos_lvm_not_ready");
  }
  async start() {
    let authority = await this.authority.read(this.abort.signal);
    if (authority.checkpoint.status === "awaiting_verification") return;
    await this.setup();
    try {
      const position = () => STAGES.indexOf(authority.checkpoint.stage);
      const at = (stage: NodeBootstrapStage) => STAGES.indexOf(stage);
      if (position() < at("rescue_reboot_intent")) {
        if (!authority.rescue_active) throw new BootstrapError("provider_rescue_not_confirmed");
        await this.inspectRescue();
        if (position() < at("rescue_verified")) authority = await this.checkpoint("rescue_verified");
        await this.verifySchematic();
        const expected = await this.verifyImage();
        authority = await this.authority.read(this.abort.signal);
        if (position() < at("image_verified")) authority = await this.checkpoint("image_verified");
        if (position() < at("disk_written")) await this.writeDisk();
        authority = await this.authority.read(this.abort.signal);
        if (position() < at("gpt_relocated")) {
          await this.authority.read(this.abort.signal);
          // Relocation is reconciled by partition identity/data and the GPT validator.
          const disk = shellQuote(this.input.spec.hardware.install_disk);
          await this.ssh(`${this.guardScript()}\nsgdisk --move-second-header ${disk}`);
          await this.verifyPartitions(expected);
          authority = await this.checkpoint("gpt_relocated");
        } else await this.verifyPartitions(expected);
        authority = await this.checkpoint("rescue_reboot_intent");
        await this.ssh("reboot", true);
      }
      // A stored reboot intent never resends reboot. Talos readback resolves the uncertain result.
      if (position() < at("talos_maintenance")) {
        const disks = jsonRecords((await this.talos(["get", "disks", "--output", "json"], true)).stdout);
        if (!disks.some((disk) => record(disk.spec).dev_path === this.input.spec.hardware.install_disk && Number(record(disk.spec).size) === this.input.spec.hardware.disk_bytes)) {
          throw new BootstrapError("maintenance_disk_mismatch");
        }
        authority = await this.checkpoint("talos_maintenance");
      }
      await this.prepareConfig(authority);
      authority = await this.authority.read(this.abort.signal);
      if (position() < at("config_apply_intent")) {
        authority = await this.checkpoint("config_apply_intent");
        await this.talos(["apply-config", "--file", join(this.directory, `${this.input.spec.role}.yaml`)], true, true);
      }
      if (position() < at("config_applied")) {
        await this.authenticatedReadback();
        authority = await this.checkpoint("config_applied");
      }
      if (position() < at("talos_reboot_intent")) {
        authority = await this.checkpoint("talos_reboot_intent");
        await this.talos(["reboot"], false, true);
      }
      await this.authenticatedReadback();
      if (position() < at("talos_authenticated")) authority = await this.checkpoint("talos_authenticated");
      if (this.input.spec.role === "controlplane") {
        if (position() < at("kubernetes_bootstrap_intent")) {
          authority = await this.checkpoint("kubernetes_bootstrap_intent");
          await this.talos(["bootstrap"], false, true);
        }
        // Kubeconfig and kube-system UID are the evidence, including after an uncertain bootstrap.
        const file = join(this.directory, "observed-kubeconfig");
        await this.talos(["kubeconfig", file, "--merge=false", "--force"]);
        const rawConfig = await readFile(file, "utf8");
        await this.writeKubeconfig(rawConfig);
        const namespace = record(JSON.parse((await this.kube(["get", "namespace", "kube-system", "--output=json"])).stdout));
        const uid = record(namespace.metadata).uid;
        if (typeof uid !== "string" || !this.seed) throw new BootstrapError("cluster_identity_unobserved");
        if (authority.protected_material?.purpose === "join_bundle" && authority.protected_material.material.kube_system_uid !== uid) throw new BootstrapError("cluster_uid_mismatch");
        const bundle = NodeJoinBundle.parse({ ...this.seed, kube_system_uid: uid, kubeconfig: rawConfig });
        authority = await this.authority.seal(await this.authority.read(this.abort.signal), { purpose: "join_bundle", material: bundle }, this.abort.signal);
      } else {
        const namespace = record(JSON.parse((await this.kube(["get", "namespace", "kube-system", "--output=json"])).stdout));
        if (record(namespace.metadata).uid !== this.input.spec.cluster_uid) throw new BootstrapError("cluster_uid_mismatch");
      }
      const node = record(JSON.parse((await this.kube(["get", "node", this.input.spec.hostname, "--output=json"])).stdout));
      const metadata = record(node.metadata);
      const labels = record(metadata.labels);
      const nodeStatus = record(node.status);
      if (labels["pgcf.io/node-id"] !== this.input.spec.node_id || labels["pgcf.io/region"] !== this.input.spec.region_id ||
        record(nodeStatus.nodeInfo).kubeletVersion !== `v${KUBERNETES_VERSION}` ||
        !array(nodeStatus.addresses).some((address) => address.type === "InternalIP" && address.address === this.input.spec.hardware.ipv4) ||
        !array(record(node.spec).taints).some((taint) => taint.key === "pgcf.io/quarantine" && taint.value === "bootstrap" && taint.effect === "NoSchedule")) {
        throw new BootstrapError("kubernetes_node_identity_mismatch");
      }
      authority = await this.checkpoint("kubernetes_joined");
      await this.checkpoint("awaiting_verification", { status: "awaiting_verification" });
    } catch (error) {
      const code = this.abort.signal.aborted ? "job_cancelled" : error instanceof BootstrapError ? error.code : "bootstrap_readback_failed";
      if (!this.abort.signal.aborted) {
        try {
          const signal = AbortSignal.timeout(15_000);
          const previous = await this.authority.read(signal);
          await this.authority.checkpoint(previous, { ...previous.checkpoint, status: "waiting", error_code: code }, signal);
        } catch { /* The Workflow still reads D1; a callback failure never creates fictional progress. */ }
      }
      throw new BootstrapError(code);
    } finally {
      await this.nativeProxy?.close();
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }
}

export function jsonRecords(stdout: string): Json[] {
  const output: Json[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < stdout.length; index++) {
    const character = stdout[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") { if (depth === 0) start = index; depth++; }
    else if (character === "}") {
      depth--;
      if (depth < 0) throw new BootstrapError("readback_invalid");
      if (depth === 0) { output.push(record(JSON.parse(stdout.slice(start, index + 1)))); start = -1; }
    } else if (depth === 0 && character.trim()) throw new BootstrapError("readback_invalid");
  }
  if (depth !== 0 || quoted || !output.length) throw new BootstrapError("readback_invalid");
  return output;
}
