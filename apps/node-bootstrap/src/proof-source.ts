// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { OperationId, NodeId, RegionId, Timestamp } from "@pgcf/contracts";
import { ProviderInstanceId } from "@pgcf/contracts/nodes";
import { NodeProofMeasurement } from "@pgcf/contracts/node-proof";
import { hash, ip } from "../../../scripts/e2e/src/node-network-native.ts";
import {
  BootstrapError,
  canonical,
  digest,
  shellQuote,
  type CommandResult,
} from "./bootstrap.ts";
import { storageDeleteRequest } from "./storage-capacity.ts";
import type {
  OutsideScanInput,
  OutsideScanMeasurement,
} from "./outside-scan.ts";

type Json = Record<string, unknown>;
export type ProofSourceDescriptor =
  | {
      kind: "rescue";
      operation_id: string;
      node_id: string;
      provider_instance_id: string;
      ipv4: string;
      ipv6?: string;
    }
  | {
      kind: "pod";
      cluster_uid: string;
      node_uid: string;
      node_name: string;
      node_id?: string;
      region_id: string;
      provider_instance_id: string;
      ipv4: string;
      ipv6?: string;
      image: string;
    };
export interface ProofSourceOwnership {
  version: 1;
  source_sha256: string;
  input_sha256: string;
  invocation_id: string;
  kind: "rescue" | "pod";
  stage: "intent" | "ready" | "running" | "measured" | "cleanup" | "cleaned";
  scratch_directory: string | null;
  mount_source: string | null;
  namespace_name: string | null;
  namespace_uid: string | null;
  pod_uid: string | null;
  node_sha256: string | null;
  node_bytes: number | null;
  node_received_bytes: number;
  cli_sha256: string;
  cli_bytes: number;
  receipt_sha256: string | null;
}
export interface ProofSourceCommandOptions {
  signal: AbortSignal;
  timeout_ms: number;
}
export interface ProofSourceCommands {
  authorizeSource(): Promise<void>;
  ssh?(
    script: string,
    options?: ProofSourceCommandOptions,
  ): Promise<CommandResult>;
  kube?(
    args: string[],
    permitFailure?: boolean,
    stdin?: string,
    options?: ProofSourceCommandOptions,
  ): Promise<CommandResult>;
  readOwnership?(): Promise<ProofSourceOwnership | null>;
  saveOwnership?(state: ProofSourceOwnership): Promise<void>;
  signal?: AbortSignal;
  wait?(milliseconds: number): Promise<void>;
}
export interface ProofSourceAssets {
  cli_path: string;
  cli_bytes: number;
  cli_sha256: string;
  node_path: string | null;
  node_bytes: number | null;
  node_sha256: string | null;
  node_version: string;
  architecture: "x86_64" | "aarch64" | null;
}
const CHUNK = 4 * 1024 ** 2,
  RESERVE = 256 * 1024 ** 2;
const UID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
  HASH = /^[a-f0-9]{64}$/;
const stages = ["intent", "ready", "running", "measured", "cleanup", "cleaned"];
const fail = (code: string): never => {
  throw new BootstrapError(`proof_source_${code}`);
};
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("readback_invalid");
  return value as Json;
}
function metadata(value: Json) {
  const result = object(value.metadata);
  if (
    typeof result.uid !== "string" ||
    !UID.test(result.uid) ||
    typeof result.resourceVersion !== "string" ||
    !/^[0-9]+$/.test(result.resourceVersion)
  )
    return fail("resource_identity_invalid");
  return result as Json & { uid: string; resourceVersion: string };
}
function bounded(result: CommandResult) {
  if (Buffer.byteLength(result.stdout) > 256 * 1024)
    return fail("output_limit");
  return result;
}
function successful(result: CommandResult) {
  if (bounded(result).exit_code !== 0) return fail("command_failed");
  return result.stdout;
}
function validSource(source: ProofSourceDescriptor, input: OutsideScanInput) {
  OperationId.parse(input.plan.operation_id);
  if (Buffer.byteLength(JSON.stringify({ input })) > 512 * 1024)
    return fail("input_limit");
  ProviderInstanceId.parse(source.provider_instance_id);
  if (
    isIP(source.ipv4) !== 4 ||
    (source.ipv6 !== undefined && isIP(source.ipv6) !== 6)
  )
    return fail("descriptor_invalid");
  const expected = input.family === "ipv4" ? source.ipv4 : source.ipv6;
  if (
    !expected ||
    !input.direct_source ||
    ip(input.direct_source) !== ip(expected) ||
    (input.local_source && ip(input.local_source) !== ip(expected))
  )
    return fail("direct_source_mismatch");
  if (source.kind === "rescue") {
    OperationId.parse(source.operation_id);
    NodeId.parse(source.node_id);
  } else {
    RegionId.parse(source.region_id);
    if (source.node_id) NodeId.parse(source.node_id);
    if (
      !UID.test(source.cluster_uid) ||
      !UID.test(source.node_uid) ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(source.node_name) ||
      !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(source.image)
    )
      return fail("descriptor_invalid");
  }
}
export async function readProofSourceAssets(
  rescue: boolean,
): Promise<ProofSourceAssets> {
  const cli_path = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../dist/outside-scan-command.mjs"
        : "./outside-scan-command.mjs",
      import.meta.url,
    ),
  );
  const cli = await readFile(cli_path);
  if (!cli.length || cli.length > CHUNK) return fail("cli_asset_invalid");
  const result: ProofSourceAssets = {
    cli_path,
    cli_bytes: cli.length,
    cli_sha256: digest(cli),
    node_path: null,
    node_bytes: null,
    node_sha256: null,
    node_version: process.version,
    architecture: null,
  };
  if (!rescue) return result;
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    return fail("linux_runtime_required");
  const file = await open(process.execPath, "r");
  try {
    const info = await file.stat(),
      header = Buffer.alloc(64);
    await file.read(header, 0, header.length, 0);
    const machine = header.readUInt16LE(18);
    if (
      !info.isFile() ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 64 ||
      !header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      ![62, 183].includes(machine)
    )
      return fail("node_asset_invalid");
    const checksum = createHash("sha256"),
      buffer = Buffer.alloc(CHUNK);
    let position = 0;
    while (position < info.size) {
      const next = await file.read(
        buffer,
        0,
        Math.min(CHUNK, info.size - position),
        position,
      );
      if (!next.bytesRead) return fail("node_asset_invalid");
      checksum.update(buffer.subarray(0, next.bytesRead));
      position += next.bytesRead;
    }
    result.node_path = process.execPath;
    result.node_bytes = info.size;
    result.node_sha256 = checksum.digest("hex");
    result.architecture = machine === 62 ? "x86_64" : "aarch64";
  } finally {
    await file.close();
  }
  return result;
}
const ramGuard = `proof_root="$(findmnt --noheadings --raw --target / --output FSTYPE)"
case "$proof_root" in tmpfs|ramfs|rootfs) ;; overlay)
proof_options="$(findmnt --noheadings --raw --target / --output OPTIONS)"
proof_upper=; proof_work=
IFS=, read -r -a proof_values <<< "$proof_options"
for proof_value in "\${proof_values[@]}"; do case "$proof_value" in upperdir=*) test -z "$proof_upper"; proof_upper="\${proof_value#upperdir=}";; workdir=*) test -z "$proof_work"; proof_work="\${proof_value#workdir=}";; esac; done
for proof_path in "$proof_upper" "$proof_work"; do
 [[ "$proof_path" =~ ^/[A-Za-z0-9._/-]+$ ]]; case "$proof_path/" in */../*|*/./*) exit 41;; esac
 case "$(findmnt --noheadings --raw --target "$proof_path" --output FSTYPE)" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
done
;; *) exit 41;; esac
test -z "$(swapon --show --noheadings --raw --output NAME)"
test ! -L /run && test "$(readlink -f /run)" = /run
case "$(findmnt --noheadings --raw --target /run --output FSTYPE)" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac`;
function scratchFields(state: ProofSourceOwnership) {
  if (
    state.kind !== "rescue" ||
    !state.scratch_directory ||
    !/^\/run\/pgcf-proof-source\/op_[a-z0-9]{20}-[a-f0-9-]{36}$/.test(
      state.scratch_directory,
    ) ||
    !state.mount_source ||
    !/^[a-z0-9-]{1,160}$/.test(state.mount_source) ||
    !HASH.test(state.input_sha256) ||
    !HASH.test(state.source_sha256) ||
    !UID.test(state.invocation_id)
  )
    return fail("ownership_invalid");
  return {
    path: state.scratch_directory,
    source: state.mount_source,
    identity: hash({
      source: state.source_sha256,
      input: state.input_sha256,
      invocation: state.invocation_id,
    }),
  };
}
function mountedGuard(state: ProofSourceOwnership) {
  const value = scratchFields(state),
    path = shellQuote(value.path);
  return `${ramGuard}\ntest ! -L ${path} && test -d ${path}\ntest "$(findmnt --noheadings --raw --target ${path} --output TARGET,SOURCE,FSTYPE)" = ${shellQuote(`${value.path} ${value.source} tmpfs`)}\ntest "$(findmnt --noheadings --raw --submounts --mountpoint ${path} --output TARGET)" = ${path}\ntest ! -L ${path}/identity && test "$(cat ${path}/identity)" = ${shellQuote(value.identity)}`;
}
function filesGuard(state: ProofSourceOwnership, files: string[]) {
  const path = shellQuote(scratchFields(state).path);
  return `for proof_file in ${files.join(" ")}; do test ! -L ${path}/"$proof_file"; if test -e ${path}/"$proof_file"; then test -f ${path}/"$proof_file"; fi; done`;
}
export function proofSourceScratchScript(
  state: ProofSourceOwnership,
  assets: ProofSourceAssets,
  inputBytes: number,
): string {
  const value = scratchFields(state),
    path = shellQuote(value.path),
    needed =
      (assets.node_bytes ?? 0) * 2 +
      assets.cli_bytes +
      inputBytes +
      CHUNK * 3 +
      RESERVE;
  if (
    !assets.architecture ||
    !Number.isSafeInteger(needed) ||
    needed <= RESERVE
  )
    return fail("assets_invalid");
  return `set -euo pipefail\numask 077\n${ramGuard}
for proof_tool in findmnt swapon readlink lsblk python3 base64 gzip sha256sum stat dd cat chmod mount umount df awk getconf uname cut cp find rm rmdir timeout; do command -v "$proof_tool" >/dev/null; done
test "$(uname -m)" = ${shellQuote(assets.architecture)}
proof_blocks="$(lsblk --bytes --json --output TYPE,MOUNTPOINTS)"
python3 -c 'import json,sys
def mounted(b):
 p=b.get("mountpoints")
 if not isinstance(p,list): raise RuntimeError("source_disk_unknown")
 return any(isinstance(x,str) and x for x in p) or any(mounted(x) for x in b.get("children",[]))
disks=[b for b in json.loads(sys.argv[1])["blockdevices"] if b.get("type")=="disk"]
if not disks or any(mounted(b) for b in disks): raise RuntimeError("source_disk_mounted")' "$proof_blocks"
test ! -L /run/pgcf-proof-source
if test -e /run/pgcf-proof-source; then test -d /run/pgcf-proof-source; else mkdir /run/pgcf-proof-source; fi
test "$(readlink -f /run/pgcf-proof-source)" = /run/pgcf-proof-source
case "$(findmnt --noheadings --raw --target /run/pgcf-proof-source --output FSTYPE)" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
if ! test -e ${path}; then
 proof_available="$(awk '$1 == "MemAvailable:" {printf "%.0f\\n", $2 * 1024}' /proc/meminfo)"
 proof_page="$(getconf PAGESIZE)"
 case "$proof_available:$proof_page" in *[!0-9:]*|:*|*:) exit 41;; esac
 test "$proof_page" -gt 0 && test "$proof_available" -ge ${needed}
 proof_size=$(( (${needed} + proof_page - 1) / proof_page * proof_page ))
 mkdir ${path}; printf '%s' ${shellQuote(value.identity)} > ${path}/.owner
 mount -t tmpfs -o "size=$proof_size,mode=0700,nosuid,nodev" ${shellQuote(value.source)} ${path}
 printf '%s' ${shellQuote(value.identity)} > ${path}/identity
fi
${mountedGuard(state)}
printf '%s\\n' pgcf_proof_source_ready`;
}
export function proofSourceChunkScript(
  state: ProofSourceOwnership,
  offset: number,
  bytes: Buffer,
): string {
  const value = scratchFields(state),
    path = shellQuote(value.path),
    expected = digest(bytes),
    next = offset + bytes.length;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % CHUNK ||
    !bytes.length ||
    bytes.length > CHUNK
  )
    return fail("chunk_invalid");
  const encoded = gzipSync(bytes, { level: 1 }).toString("base64");
  return `set -euo pipefail\numask 077\n${mountedGuard(state)}
for proof_file in node.part chunk.gz chunk.raw; do test ! -L ${path}/"$proof_file"; if test -e ${path}/"$proof_file"; then test -f ${path}/"$proof_file"; fi; done
proof_current=0; if test -e ${path}/node.part; then proof_current="$(stat --format=%s ${path}/node.part)"; fi
if test "$proof_current" -eq ${offset}; then
 base64 --decode > ${path}/chunk.gz <<'PGCF_PROOF_CHUNK'
${encoded}
PGCF_PROOF_CHUNK
 gzip --decompress --stdout ${path}/chunk.gz > ${path}/chunk.raw
 test "$(stat --format=%s ${path}/chunk.raw)" -eq ${bytes.length}
 test "$(sha256sum ${path}/chunk.raw | cut -d ' ' -f1)" = ${shellQuote(expected)}
 cat ${path}/chunk.raw >> ${path}/node.part
elif test "$proof_current" -ne ${next}; then exit 41; fi
test "$(dd if=${path}/node.part bs=1048576 skip=${offset} count=${bytes.length} iflag=skip_bytes,count_bytes status=none | sha256sum | cut -d ' ' -f1)" = ${shellQuote(expected)}
rm -f -- ${path}/chunk.raw ${path}/chunk.gz
printf '%s\\n' ${shellQuote(`pgcf_proof_chunk ${next}`)}`;
}
export function proofSourceCleanupScript(state: ProofSourceOwnership): string {
  const value = scratchFields(state),
    path = shellQuote(value.path);
  return `set -euo pipefail\n${ramGuard}
test ! -L /run/pgcf-proof-source && test ! -L ${path}
if test -e ${path}; then
 test -d ${path} && test "$(readlink -f ${path})" = ${path}
 if test "$(findmnt --noheadings --raw --target ${path} --output TARGET,SOURCE,FSTYPE)" = ${shellQuote(`${value.path} ${value.source} tmpfs`)}; then
  ${mountedGuard(state)}
  test -z "$(find ${path} -mindepth 1 -maxdepth 1 ! -name identity ! -name node.part ! -name node ! -name outside-scan-command.mjs ! -name input.json ! -name receipt.json ! -name receipt.part ! -name error.json ! -name chunk.gz ! -name chunk.raw ! -name scan.started -print -quit)"
  for proof_file in identity node.part node outside-scan-command.mjs input.json receipt.json receipt.part error.json chunk.gz chunk.raw scan.started; do
   test ! -L ${path}/"$proof_file"; if test -e ${path}/"$proof_file"; then test -f ${path}/"$proof_file"; fi
   rm -f -- ${path}/"$proof_file"
  done
  umount -- ${path}
 fi
 test ! -L ${path}/.owner && test -f ${path}/.owner && test "$(cat ${path}/.owner)" = ${shellQuote(value.identity)}
 test -z "$(find ${path} -mindepth 1 -maxdepth 1 ! -name .owner -print -quit)"
 rm -f -- ${path}/.owner; rmdir -- ${path}
fi
printf '%s\\n' pgcf_proof_source_clean`;
}
export function proofSourceExecutionScript(
  state: ProofSourceOwnership,
  timeout_ms: number,
) {
  const value = scratchFields(state),
    path = shellQuote(value.path);
  if (
    !Number.isInteger(timeout_ms) ||
    timeout_ms <= 5000 ||
    timeout_ms > 540_000
  )
    return fail("deadline");
  return `set -euo pipefail\numask 077\n${mountedGuard(state)}\n${filesGuard(state, ["node", "outside-scan-command.mjs", "input.json", "receipt.json", "receipt.part", "error.json", "scan.started"])}
if ! test -f ${path}/receipt.json; then
 test ! -e ${path}/scan.started
 (set -C; printf '%s' ${shellQuote(value.identity)} > ${path}/scan.started)
 timeout --signal=TERM --kill-after=5s ${(timeout_ms / 1000).toFixed(3)}s ${path}/node ${path}/outside-scan-command.mjs ${path}/input.json > ${path}/receipt.part 2> ${path}/error.json
 test "$(stat --format=%s ${path}/receipt.part)" -le 262144
 mv ${path}/receipt.part ${path}/receipt.json
fi
test "$(cat ${path}/scan.started)" = ${shellQuote(value.identity)}
test "$(stat --format=%s ${path}/receipt.json)" -le 262144
cat ${path}/receipt.json`;
}
function annotations(state: ProofSourceOwnership) {
  return {
    "pgcf.io/proof-source": state.source_sha256,
    "pgcf.io/proof-input": state.input_sha256,
    "pgcf.io/proof-invocation": state.invocation_id,
  };
}
export function proofSourcePodObjects(
  source: Extract<ProofSourceDescriptor, { kind: "pod" }>,
  state: ProofSourceOwnership,
  assets: ProofSourceAssets,
  activeDeadlineSeconds: number,
): Json[] {
  if (
    !state.namespace_name ||
    !/^pgcf-proof-[a-f0-9]{32}$/.test(state.namespace_name) ||
    !Number.isInteger(activeDeadlineSeconds) ||
    activeDeadlineSeconds < 1 ||
    activeDeadlineSeconds > 600
  )
    return fail("ownership_invalid");
  const launcher = `const fs=require('node:fs'),c=require('node:crypto'),p=require('node:child_process');const input='/run/pgcf-proof/input.json',cli='/run/pgcf-proof/outside-scan-command.mjs';function launch(){if(!fs.existsSync(input)||!fs.existsSync(cli))return;clearInterval(t);const b=fs.readFileSync(cli);const version=process.versions.node.split('.').map(Number);if(version[0]!==24||version[1]<6||b.length!==${assets.cli_bytes}||c.createHash('sha256').update(b).digest('hex')!==${JSON.stringify(assets.cli_sha256)}){console.error(JSON.stringify({error_code:'proof_source_runtime_identity_changed'}));process.exit(1)}const child=p.spawn(process.execPath,[cli,input],{stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1))}const t=setInterval(launch,100);launch();`;
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: state.namespace_name,
        annotations: annotations(state),
        labels: {
          "pod-security.kubernetes.io/enforce": "privileged",
          "pod-security.kubernetes.io/enforce-version": "v1.36",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "outside-scan",
        namespace: state.namespace_name,
        annotations: annotations(state),
      },
      spec: {
        nodeName: source.node_name,
        hostNetwork: true,
        dnsPolicy: "ClusterFirstWithHostNet",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        activeDeadlineSeconds,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [
          { name: "memory", emptyDir: { medium: "Memory", sizeLimit: "8Mi" } },
        ],
        containers: [
          {
            name: "scan",
            image: source.image,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "-e", launcher],
            resources: {
              requests: { memory: "256Mi", cpu: "250m" },
              limits: { memory: "512Mi", cpu: "500m" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [{ name: "memory", mountPath: "/run/pgcf-proof" }],
          },
        ],
      },
    },
  ];
}
function receipt(
  text: string,
  input: OutsideScanInput,
): OutsideScanMeasurement {
  if (Buffer.byteLength(text) > 256 * 1024) return fail("receipt_limit");
  const value = NodeProofMeasurement.parse(JSON.parse(text));
  const targets = (
    input.binding.verification === null
      ? input.plan.members
      : input.plan.members.filter(
          (member) => member.node_id === input.plan.node_id,
        )
  ).flatMap((member) =>
    member.addresses[input.family].map(
      (address) => `${member.provider_instance_id}:${ip(address)}`,
    ),
  );
  if (
    value.purpose !== "pgcf-node-measurement/v1" ||
    value.kind !== "scan" ||
    value.binding_sha256 !== hash(input.binding) ||
    value.family !== input.family ||
    typeof value.source !== "string" ||
    ip(value.source) !== ip(input.direct_source!) ||
    !Array.isArray(value.scans) ||
    value.scans.length !== targets.length
  )
    return fail("receipt_invalid");
  Timestamp.parse(value.observed_at);
  if (
    Date.parse(String(value.observed_at)) < Date.now() - 120_000 ||
    Date.parse(String(value.observed_at)) > Date.now() + 5000
  )
    return fail("receipt_stale");
  const seen = new Set<string>();
  for (const raw of value.scans) {
    const scan = object(raw),
      target = `${scan.provider_instance_id}:${ip(String(scan.address))}`;
    if (
      !targets.includes(target) ||
      seen.has(target) ||
      scan.protocol !== "tcp" ||
      scan.first_port !== 1 ||
      scan.last_port !== 65535 ||
      scan.scanned_ports !== 65535 ||
      !Array.isArray(scan.open_ports) ||
      scan.open_ports.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      ) ||
      new Set(scan.open_ports).size !== scan.open_ports.length
    )
      return fail("receipt_invalid");
    seen.add(target);
  }
  return value as OutsideScanMeasurement;
}
class SourceRunner {
  readonly source: ProofSourceDescriptor;
  readonly input: OutsideScanInput;
  readonly commands: ProofSourceCommands;
  readonly end: number;
  state!: ProofSourceOwnership;
  assets!: ProofSourceAssets;
  constructor(
    source: ProofSourceDescriptor,
    input: OutsideScanInput,
    commands: ProofSourceCommands,
    cleanupDeadline?: string,
  ) {
    validSource(source, input);
    if (Boolean(commands.readOwnership) !== Boolean(commands.saveOwnership))
      fail("journal_invalid");
    this.source = structuredClone(source);
    this.input = structuredClone(input);
    this.commands = commands;
    Timestamp.parse(input.deadline_at);
    const remaining =
      Date.parse(Timestamp.parse(cleanupDeadline ?? input.deadline_at)) -
      Date.now();
    if (remaining <= 0 || remaining > (cleanupDeadline ? 30_000 : 600_000))
      throw new BootstrapError("proof_source_deadline_invalid");
    this.end = performance.now() + remaining;
  }
  private check(cleanup = false) {
    if (!cleanup && this.commands.signal?.aborted) return fail("cancelled");
    if (this.end - performance.now() <= (cleanup ? 0 : 30_000))
      return fail("deadline");
  }
  private async options(cleanup = false): Promise<ProofSourceCommandOptions> {
    this.check(cleanup);
    await this.commands.authorizeSource();
    this.check(cleanup);
    const remaining =
      Math.floor(this.end - performance.now()) - (cleanup ? 0 : 30_000);
    return {
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.min(cleanup ? 30_000 : 540_000, remaining)),
        ...(!cleanup && this.commands.signal ? [this.commands.signal] : []),
      ]),
      timeout_ms: Math.min(cleanup ? 30_000 : 540_000, remaining),
    };
  }
  private async ssh(script: string, cleanup = false) {
    if (!this.commands.ssh) return fail("ssh_adapter_required");
    return bounded(
      await this.commands.ssh(script, await this.options(cleanup)),
    );
  }
  private async kube(args: string[], stdin?: string, cleanup = false) {
    if (!this.commands.kube) return fail("kube_adapter_required");
    return bounded(
      await this.commands.kube(args, true, stdin, await this.options(cleanup)),
    );
  }
  private async save(fields: Partial<ProofSourceOwnership>, cleanup = false) {
    this.check(cleanup);
    const next = { ...this.state, ...fields };
    if (this.commands.saveOwnership) {
      await this.commands.authorizeSource();
      this.check(cleanup);
      try {
        await this.commands.saveOwnership(next);
      } catch {
        if (canonical(await this.commands.readOwnership!()) !== canonical(next))
          return fail("ownership_unconfirmed");
      }
    }
    this.state = next;
  }
  private async wait(cleanup = false) {
    this.check(cleanup);
    if (this.commands.wait) await this.commands.wait(250);
    else
      await delay(
        250,
        undefined,
        !cleanup && this.commands.signal
          ? { signal: this.commands.signal }
          : undefined,
      );
    this.check(cleanup);
  }
  private async get(
    kind: string,
    name: string,
    namespace?: string,
    cleanup = false,
  ): Promise<Json | null> {
    const result = await this.kube(
      [
        "get",
        kind,
        name,
        "--ignore-not-found",
        ...(namespace ? ["--namespace", namespace] : []),
        "--output=json",
      ],
      undefined,
      cleanup,
    );
    if (result.exit_code !== 0) return fail("readback_failed");
    return result.stdout.trim() ? object(JSON.parse(result.stdout)) : null;
  }
  private owned(
    value: Json,
    kind: string,
    uid: string | null,
    cleanup = false,
  ) {
    const m = metadata(value),
      expected = annotations(this.state),
      actual = object(m.annotations);
    if (
      value.apiVersion !== "v1" ||
      value.kind !== kind ||
      (uid && m.uid !== uid) ||
      (kind === "Namespace"
        ? m.name !== this.state.namespace_name
        : m.name !== "outside-scan" ||
          m.namespace !== this.state.namespace_name) ||
      Object.entries(expected).some(
        ([key, wanted]) => actual[key] !== wanted,
      ) ||
      (!cleanup && m.deletionTimestamp)
    )
      return fail("resource_not_owned");
    if (kind === "Pod") this.assertPod(value);
    return m;
  }
  private assertPod(value: Json) {
    if (this.source.kind !== "pod") return fail("pod_identity_changed");
    const expected = object(
        proofSourcePodObjects(this.source, this.state, this.assets, 600)[1]!
          .spec,
      ),
      actual = object(value.spec);
    for (const key of [
      "nodeName",
      "hostNetwork",
      "dnsPolicy",
      "automountServiceAccountToken",
      "enableServiceLinks",
      "restartPolicy",
      "securityContext",
      "volumes",
    ]) {
      if (canonical(actual[key]) !== canonical(expected[key]))
        return fail("pod_identity_changed");
    }
    if (
      !Number.isInteger(actual.activeDeadlineSeconds) ||
      Number(actual.activeDeadlineSeconds) < 1 ||
      Number(actual.activeDeadlineSeconds) > 600 ||
      actual.hostPID === true ||
      actual.hostIPC === true ||
      actual.shareProcessNamespace === true ||
      (Array.isArray(actual.initContainers) && actual.initContainers.length) ||
      (Array.isArray(actual.ephemeralContainers) &&
        actual.ephemeralContainers.length)
    )
      return fail("pod_identity_changed");
    const containers = actual.containers;
    if (!Array.isArray(containers) || containers.length !== 1)
      return fail("pod_identity_changed");
    const wanted = object((expected.containers as Json[])[0]),
      container = object(containers[0]);
    const defaults = new Set([
      "terminationMessagePath",
      "terminationMessagePolicy",
    ]);
    if (
      Object.keys(container).some(
        (key) => !(key in wanted) && !defaults.has(key),
      ) ||
      Object.keys(wanted).some(
        (key) => canonical(container[key]) !== canonical(wanted[key]),
      )
    )
      return fail("pod_identity_changed");
  }
  private async sourceNode(cleanup = false) {
    if (this.source.kind !== "pod") return;
    const cluster = await this.get(
        "namespace",
        "kube-system",
        undefined,
        cleanup,
      ),
      node = await this.get("node", this.source.node_name, undefined, cleanup);
    if (
      !cluster ||
      object(cluster.metadata).uid !== this.source.cluster_uid ||
      object(cluster.metadata).deletionTimestamp ||
      !node
    )
      return fail("source_identity_changed");
    const m = metadata(node),
      labels = object(m.labels),
      status = object(node.status);
    if (
      m.uid !== this.source.node_uid ||
      m.deletionTimestamp ||
      labels["pgcf.io/provider-instance-id"] !==
        this.source.provider_instance_id ||
      labels["pgcf.io/region"] !== this.source.region_id ||
      (this.source.node_id &&
        labels["pgcf.io/node-id"] !== this.source.node_id) ||
      !Array.isArray(status.conditions) ||
      !status.conditions.some(
        (value) =>
          object(value).type === "Ready" && object(value).status === "True",
      ) ||
      !Array.isArray(status.addresses) ||
      !status.addresses.some(
        (value) =>
          object(value).type === "InternalIP" &&
          object(value).address === this.source.ipv4,
      )
    )
      return fail("source_identity_changed");
  }
  private async namespaceChildren() {
    const resources =
      "pods,persistentvolumeclaims,secrets,configmaps,services,serviceaccounts,replicationcontrollers,deployments.apps,statefulsets.apps,daemonsets.apps,replicasets.apps,jobs.batch,cronjobs.batch";
    const result = await this.kube(
      [
        "get",
        resources,
        "--namespace",
        this.state.namespace_name!,
        "--output=json",
      ],
      undefined,
      true,
    );
    if (result.exit_code !== 0) return fail("namespace_children_unknown");
    const list = object(JSON.parse(result.stdout));
    if (
      list.apiVersion !== "v1" ||
      list.kind !== "List" ||
      !Array.isArray(list.items)
    )
      return fail("namespace_children_unknown");
    for (const raw of list.items) {
      const value = object(raw),
        m = metadata(value);
      if (
        m.namespace !== this.state.namespace_name ||
        m.deletionTimestamp ||
        value.apiVersion !== "v1"
      )
        return fail("namespace_children_unknown");
      if (
        value.kind === "ServiceAccount" &&
        m.name === "default" &&
        (value.secrets === undefined ||
          (Array.isArray(value.secrets) && value.secrets.length === 0)) &&
        (value.imagePullSecrets === undefined ||
          (Array.isArray(value.imagePullSecrets) &&
            value.imagePullSecrets.length === 0))
      )
        continue;
      if (
        value.kind === "ConfigMap" &&
        m.name === "kube-root-ca.crt" &&
        value.binaryData === undefined
      ) {
        const data = object(value.data);
        if (
          Object.keys(data).join(",") === "ca.crt" &&
          typeof data["ca.crt"] === "string" &&
          /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/.test(
            data["ca.crt"],
          )
        )
          continue;
      }
      return fail("namespace_children_unknown");
    }
  }
  private async pod(
    assets: ProofSourceAssets,
  ): Promise<OutsideScanMeasurement> {
    const source = this.source as Extract<
      ProofSourceDescriptor,
      { kind: "pod" }
    >;
    const objects = proofSourcePodObjects(
      source,
      this.state,
      assets,
      Math.min(
        600,
        Math.max(1, Math.floor((this.end - performance.now() - 30_000) / 1000)),
      ),
    );
    await this.sourceNode();
    for (const expected of objects) {
      const kind = String(expected.kind),
        field = kind === "Namespace" ? "namespace_uid" : "pod_uid";
      let actual = await this.get(
        kind.toLowerCase(),
        kind === "Namespace" ? this.state.namespace_name! : "outside-scan",
        kind === "Namespace" ? undefined : this.state.namespace_name!,
      );
      if (!actual && this.state[field]) return fail("resource_disappeared");
      if (!actual) {
        await this.sourceNode();
        try {
          await this.kube(
            ["create", "--filename=-", "--output=json"],
            JSON.stringify(expected),
          );
        } catch {
          /* Resolve the exact owned create through reads. */
        }
        actual = await this.get(
          kind.toLowerCase(),
          kind === "Namespace" ? this.state.namespace_name! : "outside-scan",
          kind === "Namespace" ? undefined : this.state.namespace_name!,
        );
      }
      if (!actual) return fail("create_unconfirmed");
      const m = this.owned(actual, kind, this.state[field]);
      if (!this.state[field]) await this.save({ [field]: m.uid });
    }
    if (this.state.stage === "intent") await this.save({ stage: "ready" });
    const input = Buffer.from(JSON.stringify({ input: this.input })),
      encoded = input.toString("base64"),
      cli = await readFile(assets.cli_path);
    if (cli.length !== assets.cli_bytes || digest(cli) !== assets.cli_sha256)
      return fail("cli_asset_changed");
    let phase: unknown;
    for (;;) {
      const pod = await this.get(
        "pod",
        "outside-scan",
        this.state.namespace_name!,
      );
      if (!pod) return fail("resource_disappeared");
      this.owned(pod, "Pod", this.state.pod_uid);
      phase = object(pod.status).phase;
      if (phase === "Failed") return fail("pod_failed");
      if (phase === "Running" || phase === "Succeeded") {
        const statuses = object(pod.status).containerStatuses;
        if (
          !Array.isArray(statuses) ||
          statuses.length !== 1 ||
          object(statuses[0]).name !== "scan" ||
          typeof object(statuses[0]).imageID !== "string" ||
          !String(object(statuses[0]).imageID).endsWith(
            `@${source.image.split("@")[1]}`,
          )
        )
          return fail("pod_image_changed");
        break;
      }
      await this.wait();
    }
    await this.sourceNode();
    if (
      phase !== "Succeeded" &&
      ["ready", "running"].includes(this.state.stage)
    ) {
      const stage = `set -eu\numask 077\ntest -d /run/pgcf-proof && test ! -L /run/pgcf-proof\ntest "$(stat -f -c %T /run/pgcf-proof)" = tmpfs\nfor proof_file in input.json input.part outside-scan-command.mjs cli.part; do test ! -L /run/pgcf-proof/"$proof_file"; if test -e /run/pgcf-proof/"$proof_file"; then test -f /run/pgcf-proof/"$proof_file"; fi; done\nif ! test -e /run/pgcf-proof/outside-scan-command.mjs; then\nbase64 --decode > /run/pgcf-proof/cli.part <<'PGCF_PROOF_CLI'\n${cli.toString("base64")}\nPGCF_PROOF_CLI\nchmod 600 /run/pgcf-proof/cli.part\ntest "$(wc -c < /run/pgcf-proof/cli.part)" -eq ${assets.cli_bytes}\ntest "$(sha256sum /run/pgcf-proof/cli.part | cut -d ' ' -f1)" = ${shellQuote(assets.cli_sha256)}\nmv /run/pgcf-proof/cli.part /run/pgcf-proof/outside-scan-command.mjs\nfi\ntest "$(wc -c < /run/pgcf-proof/outside-scan-command.mjs)" -eq ${assets.cli_bytes}\ntest "$(sha256sum /run/pgcf-proof/outside-scan-command.mjs | cut -d ' ' -f1)" = ${shellQuote(assets.cli_sha256)}\nif ! test -e /run/pgcf-proof/input.json; then\nbase64 --decode > /run/pgcf-proof/input.part <<'PGCF_PROOF_INPUT'\n${encoded}\nPGCF_PROOF_INPUT\nchmod 600 /run/pgcf-proof/input.part\ntest "$(wc -c < /run/pgcf-proof/input.part)" -eq ${input.length}\ntest "$(sha256sum /run/pgcf-proof/input.part | cut -d ' ' -f1)" = ${shellQuote(digest(input))}\nmv /run/pgcf-proof/input.part /run/pgcf-proof/input.json\nfi\ntest "$(wc -c < /run/pgcf-proof/input.json)" -eq ${input.length}\ntest "$(sha256sum /run/pgcf-proof/input.json | cut -d ' ' -f1)" = ${shellQuote(digest(input))}\nprintf '%s\\n' pgcf_proof_input_ready`;
      if (this.state.stage === "ready") await this.save({ stage: "running" });
      try {
        const staged = await this.kube(
          [
            "exec",
            "--stdin",
            "outside-scan",
            "--namespace",
            this.state.namespace_name!,
            "--container=scan",
            "--",
            "sh",
            "-se",
          ],
          stage,
        );
        if (
          staged.exit_code !== 0 ||
          staged.stdout.trim() !== "pgcf_proof_input_ready"
        )
          return fail("input_stage_unconfirmed");
      } catch {
        // Completed execution resolves a lost staging response. A running source
        // is preserved for a later idempotent input-file check, never restarted.
        const actual = await this.get(
          "pod",
          "outside-scan",
          this.state.namespace_name!,
        );
        if (!actual) return fail("input_stage_unconfirmed");
        this.owned(actual, "Pod", this.state.pod_uid);
        if (object(actual.status).phase !== "Succeeded")
          return fail("input_stage_unconfirmed");
      }
    }
    for (;;) {
      const pod = await this.get(
        "pod",
        "outside-scan",
        this.state.namespace_name!,
      );
      if (!pod) return fail("resource_disappeared");
      this.owned(pod, "Pod", this.state.pod_uid);
      const status = object(pod.status);
      if (status.phase === "Failed") return fail("pod_failed");
      if (status.phase === "Succeeded") {
        const statuses = status.containerStatuses;
        if (
          !Array.isArray(statuses) ||
          statuses.length !== 1 ||
          object(object(object(statuses[0]).state).terminated).exitCode !== 0
        )
          return fail("pod_failed");
        return receipt(
          successful(
            await this.kube([
              "logs",
              "outside-scan",
              "--namespace",
              this.state.namespace_name!,
              "--container=scan",
              "--limit-bytes=262144",
            ]),
          ),
          this.input,
        );
      }
      await this.wait();
    }
  }
  private async rescue(
    assets: ProofSourceAssets,
  ): Promise<OutsideScanMeasurement> {
    const value = scratchFields(this.state),
      path = shellQuote(value.path),
      input = Buffer.from(JSON.stringify({ input: this.input }));
    if (
      successful(
        await this.ssh(
          proofSourceScratchScript(this.state, assets, input.length),
        ),
      ).trim() !== "pgcf_proof_source_ready"
    )
      return fail("scratch_unconfirmed");
    const file = await open(assets.node_path!, "r");
    try {
      const buffer = Buffer.alloc(CHUNK);
      for (
        let offset = this.state.node_received_bytes;
        offset < assets.node_bytes!;
      ) {
        const count = Math.min(CHUNK, assets.node_bytes! - offset),
          read = await file.read(buffer, 0, count, offset);
        if (read.bytesRead !== count) return fail("node_asset_changed");
        const next = offset + count;
        if (
          successful(
            await this.ssh(
              proofSourceChunkScript(
                this.state,
                offset,
                buffer.subarray(0, count),
              ),
            ),
          ).trim() !== `pgcf_proof_chunk ${next}`
        )
          return fail("chunk_unconfirmed");
        await this.save({ node_received_bytes: next });
        offset = next;
      }
    } finally {
      await file.close();
    }
    const cli = await readFile(assets.cli_path);
    if (cli.length !== assets.cli_bytes || digest(cli) !== assets.cli_sha256)
      return fail("cli_asset_changed");
    const stage = `${mountedGuard(this.state)}\n${filesGuard(this.state, ["node.part", "node", "outside-scan-command.mjs", "input.json"])}\ntest "$(stat --format=%s ${path}/node.part)" -eq ${assets.node_bytes}\ntest "$(sha256sum ${path}/node.part | cut -d ' ' -f1)" = ${shellQuote(assets.node_sha256!)}\ncp ${path}/node.part ${path}/node\nchmod 700 ${path}/node\nbase64 --decode > ${path}/outside-scan-command.mjs <<'PGCF_PROOF_CLI'\n${cli.toString("base64")}\nPGCF_PROOF_CLI\ntest "$(stat --format=%s ${path}/outside-scan-command.mjs)" -eq ${assets.cli_bytes}\ntest "$(sha256sum ${path}/outside-scan-command.mjs | cut -d ' ' -f1)" = ${shellQuote(assets.cli_sha256)}\nbase64 --decode > ${path}/input.json <<'PGCF_PROOF_INPUT'\n${input.toString("base64")}\nPGCF_PROOF_INPUT\nchmod 600 ${path}/input.json\ntest "$(${path}/node --version)" = ${shellQuote(assets.node_version)}\nprintf '%s\\n' pgcf_proof_assets_ready`;
    if (
      successful(
        await this.ssh(`set -euo pipefail\numask 077\n${stage}`),
      ).trim() !== "pgcf_proof_assets_ready"
    )
      return fail("runtime_unconfirmed");
    await this.save({ stage: "running" });
    const result = await this.ssh(
      proofSourceExecutionScript(
        this.state,
        Math.min(540_000, Math.floor(this.end - performance.now() - 35_000)),
      ),
    );
    return receipt(successful(result), this.input);
  }
  async cleanup() {
    if (!this.state || this.state.stage === "cleaned") return;
    await this.save({ stage: "cleanup" }, true);
    if (this.source.kind === "rescue") {
      if (
        successful(
          await this.ssh(proofSourceCleanupScript(this.state), true),
        ).trim() !== "pgcf_proof_source_clean"
      )
        return fail("cleanup_unconfirmed");
    } else {
      await this.sourceNode(true);
      for (const [kind, uid] of [
        ["Pod", this.state.pod_uid],
        ["Namespace", this.state.namespace_uid],
      ] as const) {
        const actual = await this.get(
          kind.toLowerCase(),
          kind === "Pod" ? "outside-scan" : this.state.namespace_name!,
          kind === "Pod" ? this.state.namespace_name! : undefined,
          true,
        );
        if (!actual) continue;
        const m = this.owned(actual, kind, uid, true);
        if (kind === "Namespace") await this.namespaceChildren();
        if (!uid)
          await this.save(
            { [kind === "Pod" ? "pod_uid" : "namespace_uid"]: m.uid },
            true,
          );
        if (!m.deletionTimestamp) {
          const path =
            kind === "Pod"
              ? `/api/v1/namespaces/${this.state.namespace_name}/pods/outside-scan`
              : `/api/v1/namespaces/${this.state.namespace_name}`;
          const request = storageDeleteRequest(path, {
            uid: m.uid,
            resourceVersion: m.resourceVersion,
          });
          await this.sourceNode(true);
          try {
            await this.kube(request.args, request.stdin, true);
          } catch {
            /* Confirm deletion below; never force foreign cleanup. */
          }
        }
        while (
          await this.get(
            kind.toLowerCase(),
            kind === "Pod" ? "outside-scan" : this.state.namespace_name!,
            kind === "Pod" ? this.state.namespace_name! : undefined,
            true,
          )
        )
          await this.wait(true);
      }
    }
    await this.save({ stage: "cleaned" }, true);
  }
  private acceptOwnership(
    previous: ProofSourceOwnership,
    assets: ProofSourceAssets,
    cleanupOnly = false,
  ) {
    if (previous) {
      const expectedScratch =
        this.source.kind === "rescue"
          ? `/run/pgcf-proof-source/${this.input.plan.operation_id}-${previous.invocation_id}`
          : null;
      const expectedMount =
        this.source.kind === "rescue"
          ? `pgcf-proof-${previous.invocation_id}-${hash(this.input)}`
          : null;
      const expectedNamespace =
        this.source.kind === "pod"
          ? `pgcf-proof-${hash({ input: hash(this.input), source: hash(this.source), invocation: previous.invocation_id }).slice(0, 32)}`
          : null;
      if (
        previous.version !== 1 ||
        previous.source_sha256 !== hash(this.source) ||
        previous.input_sha256 !== hash(this.input) ||
        previous.kind !== this.source.kind ||
        !UID.test(previous.invocation_id) ||
        !stages.includes(previous.stage) ||
        (!cleanupOnly && previous.stage === "cleaned") ||
        previous.cli_sha256 !== assets.cli_sha256 ||
        previous.cli_bytes !== assets.cli_bytes ||
        previous.node_sha256 !== assets.node_sha256 ||
        previous.node_bytes !== assets.node_bytes ||
        previous.scratch_directory !== expectedScratch ||
        previous.mount_source !== expectedMount ||
        previous.namespace_name !== expectedNamespace ||
        ![previous.namespace_uid, previous.pod_uid].every(
          (uid) => uid === null || (typeof uid === "string" && UID.test(uid)),
        ) ||
        !Number.isSafeInteger(previous.node_received_bytes) ||
        previous.node_received_bytes < 0 ||
        previous.node_received_bytes > (assets.node_bytes ?? 0) ||
        (previous.node_received_bytes !== (assets.node_bytes ?? 0) &&
          previous.node_received_bytes % CHUNK !== 0) ||
        (previous.receipt_sha256 !== null &&
          !HASH.test(previous.receipt_sha256)) ||
        (previous.stage === "measured" && previous.receipt_sha256 === null) ||
        (this.source.kind === "rescue" &&
          (previous.namespace_uid !== null || previous.pod_uid !== null)) ||
        (this.source.kind === "pod" &&
          ["ready", "running", "measured"].includes(previous.stage) &&
          (!previous.namespace_uid || !previous.pod_uid))
      )
        return fail("ownership_changed");
      this.state = structuredClone(previous);
    }
  }
  async finishCleanup(): Promise<void> {
    if (!this.commands.readOwnership) return fail("journal_required");
    this.check(true);
    await this.commands.authorizeSource();
    const previous = await this.commands.readOwnership();
    if (!previous) return fail("ownership_missing");
    // Cleanup uses sealed provenance rather than requiring the caller to retain
    // an older executable. No bytes are staged or executed on this path.
    if (
      !HASH.test(previous.cli_sha256) ||
      !Number.isSafeInteger(previous.cli_bytes) ||
      previous.cli_bytes < 1 ||
      previous.cli_bytes > CHUNK ||
      (this.source.kind === "rescue"
        ? !previous.node_sha256 ||
          !HASH.test(previous.node_sha256) ||
          !Number.isSafeInteger(previous.node_bytes) ||
          Number(previous.node_bytes) <= 64
        : previous.node_sha256 !== null || previous.node_bytes !== null)
    )
      return fail("ownership_changed");
    const assets: ProofSourceAssets = {
      cli_path: "",
      cli_bytes: previous.cli_bytes,
      cli_sha256: previous.cli_sha256,
      node_path: null,
      node_bytes: previous.node_bytes,
      node_sha256: previous.node_sha256,
      node_version: process.version,
      architecture: null,
    };
    this.assets = assets;
    this.acceptOwnership(previous, assets, true);
    await this.cleanup();
  }
  async run(): Promise<OutsideScanMeasurement> {
    const assets = await readProofSourceAssets(this.source.kind === "rescue"),
      previous = await this.commands.readOwnership?.();
    this.assets = assets;
    if (previous) {
      this.acceptOwnership(previous, assets);
    } else {
      const invocation = randomUUID(),
        inputHash = hash(this.input),
        sourceHash = hash(this.source);
      this.state = {
        version: 1,
        source_sha256: sourceHash,
        input_sha256: inputHash,
        invocation_id: invocation,
        kind: this.source.kind,
        stage: "intent",
        scratch_directory:
          this.source.kind === "rescue"
            ? `/run/pgcf-proof-source/${this.input.plan.operation_id}-${invocation}`
            : null,
        mount_source:
          this.source.kind === "rescue"
            ? `pgcf-proof-${invocation}-${inputHash}`
            : null,
        namespace_name:
          this.source.kind === "pod"
            ? `pgcf-proof-${hash({ input: inputHash, source: sourceHash, invocation }).slice(0, 32)}`
            : null,
        namespace_uid: null,
        pod_uid: null,
        node_sha256: assets.node_sha256,
        node_bytes: assets.node_bytes,
        node_received_bytes: 0,
        cli_sha256: assets.cli_sha256,
        cli_bytes: assets.cli_bytes,
        receipt_sha256: null,
      };
      await this.save({});
    }
    try {
      if (this.state.stage === "cleanup") {
        await this.cleanup();
        return fail("previous_run_cleaned");
      }
      const measured =
        this.source.kind === "rescue"
          ? await this.rescue(assets)
          : await this.pod(assets);
      await this.save({ stage: "measured", receipt_sha256: hash(measured) });
      await this.cleanup();
      return measured;
    } catch (error) {
      try {
        await this.cleanup();
      } catch {
        /* Keep exact dirty ownership for authorized later cleanup. */
      }
      throw error;
    }
  }
}
/** Selection and source custody stay with the caller; returned data never precedes owned cleanup. */
export async function runOwnedOutsideScan(
  source: ProofSourceDescriptor,
  input: OutsideScanInput,
  commands: ProofSourceCommands,
): Promise<OutsideScanMeasurement> {
  return new SourceRunner(source, input, commands).run();
}
/** Fresh authority may clean an expired invocation; it cannot renew its execution. */
export async function cleanupOwnedProofSource(
  source: ProofSourceDescriptor,
  originalInput: OutsideScanInput,
  commands: ProofSourceCommands,
  newDeadlineAt: string,
): Promise<void> {
  return new SourceRunner(
    source,
    originalInput,
    commands,
    newDeadlineAt,
  ).finishCleanup();
}
