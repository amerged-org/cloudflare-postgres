// SPDX-License-Identifier: Apache-2.0
import { createPrivateKey, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeInspectionInput,
  NodeInstallationInspection,
  NodeInstallationInspectionRequest,
} from "@pgcf/contracts/node-installation";
import {
  BootstrapError,
  TALOS_VERSION,
  bootstrapSchematic,
  canonical,
  digest,
  partitions,
  runCommand,
  shellQuote,
  type CommandRunner,
} from "./bootstrap.ts";
import {
  inspectionResponseBody,
  validateInspectionProxyConfig,
  type InspectionProxyConfig,
} from "./inspection-proxy-command.ts";

const RECORD = "\n__PGCF_INSPECTION_RECORD__\n";
const RESERVE = 512 * 1024 ** 2;
const LIMIT = 512 * 1024;
const RAM = new Set(["tmpfs", "ramfs", "rootfs"]);
// sgdisk reports this valid reserved gap before its GPT verification result.
const GPT_RESERVED_GAP_ADVISORY = `Warning: There is a gap between the main partition table (ending sector 33)
and the first usable sector (2048). This is helpful in some exotic configurations,
but is unusual. The util-linux fdisk program often creates disks like this.
Using 'j' on the experts' menu can adjust this gap.
`;
type Json = Record<string, unknown>;
export interface InspectionOptions {
  run?: CommandRunner;
  request?: typeof fetch;
  signal?: AbortSignal;
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BootstrapError("inspection_readback_invalid");
  return value as Json;
}
function array(value: unknown): Json[] {
  if (!Array.isArray(value))
    throw new BootstrapError("inspection_readback_invalid");
  return value.map(object);
}
function positive(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new BootstrapError("inspection_readback_invalid");
  return number;
}
function ramMount(stdout: string, path: string) {
  const mounts = array(object(JSON.parse(stdout)).filesystems);
  const mount = mounts[0];
  if (
    mounts.length !== 1 ||
    !mount ||
    !RAM.has(String(mount.fstype)) ||
    typeof mount.target !== "string" ||
    !(
      mount.target === "/" ||
      path === mount.target ||
      path.startsWith(`${mount.target}/`)
    )
  )
    throw new BootstrapError("inspection_ram_backing_unproven");
}
function overlayPaths(root: Json) {
  if (root.fstype !== "overlay") return [];
  if (root.target !== "/" || typeof root.options !== "string")
    throw new BootstrapError("inspection_ram_backing_unproven");
  const options = root.options.split(",");
  return ["upperdir", "workdir"].map((key) => {
    const values = options.filter((value) => value.startsWith(`${key}=`));
    const path = values[0]?.slice(key.length + 1);
    if (
      values.length !== 1 ||
      !path ||
      path.length > 4096 ||
      !/^\/[A-Za-z0-9._/-]+$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw new BootstrapError("inspection_ram_backing_unproven");
    return path;
  });
}
function proxyConfig(input: NodeInspectionInput): InspectionProxyConfig {
  return validateInspectionProxyConfig({
    operation_id: input.operation_id,
    expected_generation: input.expected_generation,
    deadline_at: input.deadline_at,
    expected_network: input.expected_network,
    callback: input.callback,
    transport_url: input.transport_url,
    relay_url: input.relay_url,
  });
}
function validateInput(value: NodeInspectionInput) {
  const input = NodeInspectionInput.parse(value);
  proxyConfig(input);
  const blob = Buffer.from(input.rescue.ssh_host_key.split(" ")[1]!, "base64");
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString() !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32 ||
    `SHA256:${Buffer.from(digest(blob), "hex").toString("base64").replaceAll("=", "")}` !==
      input.rescue.ssh_host_fingerprint
  )
    throw new BootstrapError("inspection_host_key_mismatch");
  if (
    input.rescue.ssh_private_key.startsWith(
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    )
  ) {
    const bytes = Buffer.from(
      input.rescue.ssh_private_key.replaceAll(/-----[^\n]+-----|\s/g, ""),
      "base64",
    );
    if (!bytes.subarray(0, 15).equals(Buffer.from("openssh-key-v1\0")))
      throw new BootstrapError("inspection_client_key_invalid");
  } else {
    try {
      createPrivateKey(input.rescue.ssh_private_key);
    } catch {
      throw new BootstrapError("inspection_client_key_invalid");
    }
  }
  return input;
}

const rootGuard = `inspection_root="$(findmnt --noheadings --raw --target / --output FSTYPE)"
case "$inspection_root" in tmpfs|ramfs|rootfs) ;; overlay)
inspection_options="$(findmnt --noheadings --raw --target / --output OPTIONS)"
inspection_upper=; inspection_work=
IFS=, read -r -a inspection_values <<< "$inspection_options"
for inspection_value in "\${inspection_values[@]}"; do case "$inspection_value" in upperdir=*) test -z "$inspection_upper"; inspection_upper="\${inspection_value#upperdir=}";; workdir=*) test -z "$inspection_work"; inspection_work="\${inspection_value#workdir=}";; esac; done
for inspection_path in "$inspection_upper" "$inspection_work"; do
  [[ "$inspection_path" =~ ^/[A-Za-z0-9._/-]+$ ]]
  case "$inspection_path/" in */../*|*/./*) exit 41;; esac
  inspection_backing="$(findmnt --noheadings --raw --target "$inspection_path" --output FSTYPE)"
  case "$inspection_backing" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
done
;; *) exit 41;; esac
test -z "$(swapon --show --noheadings --raw --output NAME)"
test ! -L /run && test "$(readlink -f /run)" = /run
case "$(findmnt --noheadings --raw --target /run --output FSTYPE)" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac`;

class Inspector {
  readonly input: NodeInspectionInput;
  readonly run: CommandRunner;
  readonly request: typeof fetch;
  readonly signal: AbortSignal;
  readonly hard = new AbortController();
  readonly work = new AbortController();
  readonly end: number;
  readonly timers: ReturnType<typeof setTimeout>[];
  private readonly invocation = randomUUID();
  private directory = "";
  private env: NodeJS.ProcessEnv = {};
  private sshArgs: string[] = [];
  private scratchOwned = false;
  constructor(value: NodeInspectionInput, options: InspectionOptions) {
    this.input = validateInput(value);
    options.signal?.throwIfAborted();
    const remaining = Date.parse(this.input.deadline_at) - Date.now();
    if (remaining <= 0 || remaining > 600_000)
      throw new BootstrapError("inspection_deadline_invalid");
    this.end = performance.now() + remaining;
    const cleanupReserve = Math.min(15_000, remaining / 4);
    this.timers = [
      setTimeout(() => this.hard.abort(), remaining),
      setTimeout(() => this.work.abort(), remaining - cleanupReserve),
    ];
    for (const timer of this.timers) timer.unref();
    this.signal = AbortSignal.any([
      this.hard.signal,
      this.work.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    this.run = options.run ?? runCommand;
    this.request = options.request ?? fetch;
  }
  private remaining() {
    return Math.floor(this.end - performance.now());
  }
  private remotePath(name = "") {
    return `/run/pgcf-inspection/${this.input.operation_id}-${this.input.expected_generation}-${this.invocation}${name ? "/" + name : ""}`;
  }
  private scratchIdentity() {
    return digest(
      canonical({
        operation_id: this.input.operation_id,
        expected_generation: this.input.expected_generation,
        binding_sha256: this.input.binding_sha256,
        profile_sha256: this.input.profile_sha256,
        network_plan_sha256: this.input.network_plan_sha256,
        invocation: this.invocation,
      }),
    );
  }
  private scratchSource() {
    return `pgcf-inspection-${this.input.operation_id}-${this.scratchIdentity()}`;
  }
  private async execute(
    executable: string,
    args: string[],
    stdin?: string,
    cleanup = false,
  ) {
    const remaining = this.remaining();
    if (remaining <= 0) throw new BootstrapError("inspection_deadline_expired");
    const signal = cleanup
      ? AbortSignal.any([
          this.hard.signal,
          AbortSignal.timeout(Math.min(15_000, remaining)),
        ])
      : this.signal;
    signal.throwIfAborted();
    const result = await this.run({
      executable,
      args,
      signal,
      timeout_ms: Math.min(cleanup ? 15_000 : 540_000, remaining),
      env: this.env,
      ...(stdin === undefined ? {} : { stdin }),
    });
    signal.throwIfAborted();
    if (result.exit_code !== 0)
      throw new BootstrapError(
        cleanup ? "inspection_cleanup_failed" : "inspection_command_failed",
      );
    if (Buffer.byteLength(result.stdout) > LIMIT)
      throw new BootstrapError("inspection_output_limit");
    return result.stdout;
  }
  private ssh(script: string, cleanup = false) {
    return this.execute(
      "ssh",
      [
        ...this.sshArgs,
        `root@${this.input.expected_network.ipv4}`,
        "bash",
        "-se",
      ],
      `set -euo pipefail\numask 077\n${script}\n`,
      cleanup,
    );
  }
  private async setup() {
    this.signal.throwIfAborted();
    this.directory = await mkdtemp(join(tmpdir(), "pgcf-inspection-"));
    await chmod(this.directory, 0o700);
    this.env = { PATH: process.env.PATH, LANG: "C", TMPDIR: this.directory };
    const key = join(this.directory, "rescue-identity"),
      hosts = join(this.directory, "known-hosts"),
      proxy = join(this.directory, "inspection-proxy.json");
    await writeFile(key, this.input.rescue.ssh_private_key, { mode: 0o600 });
    await writeFile(
      hosts,
      `${this.input.operation_id} ${this.input.rescue.ssh_host_key}\n`,
      { mode: 0o600 },
    );
    await writeFile(proxy, JSON.stringify(proxyConfig(this.input)), {
      mode: 0o600,
    });
    await this.execute("ssh-keygen", ["-y", "-P", "", "-f", key]);
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "mjs";
    const proxyCommand = fileURLToPath(
      new URL(`./inspection-proxy-command.${extension}`, import.meta.url),
    );
    this.sshArgs = [
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      `UserKnownHostsFile=${hosts}`,
      "-o",
      `HostKeyAlias=${this.input.operation_id}`,
      "-o",
      "HostKeyAlgorithms=ssh-ed25519",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "IdentitiesOnly=yes",
      "-i",
      key,
      "-o",
      `ProxyCommand=${shellQuote(process.execPath)} ${shellQuote(proxyCommand)} ${shellQuote(proxy)}`,
    ];
  }
  private async hardware() {
    const stdout = await this.ssh(
      [
        "# __PGCF_INSPECTION_HARDWARE__",
        "lsblk --bytes --json --output NAME,PATH,TYPE,SIZE,MOUNTPOINTS",
        "ip -json link",
        "ip -json -4 address",
        "ip -json -4 route show default",
        "findmnt --json --target / --output TARGET,FSTYPE,SOURCE,OPTIONS",
        "swapon --show --noheadings --raw --output NAME",
        'awk \'$1 == "MemTotal:" {printf "%.0f\\n", $2 * 1024}\' /proc/meminfo',
        'awk \'$1 == "MemAvailable:" {printf "%.0f\\n", $2 * 1024}\' /proc/meminfo',
        "findmnt --json --target /run --output TARGET,FSTYPE,SOURCE,OPTIONS",
        ...(this.input.expected_network.ipv6
          ? ["ip -json -6 address", "ip -json -6 route show default"]
          : []),
      ]
        .slice(1)
        .join(`\nprintf ${shellQuote(RECORD)}\n`) +
        "\n# __PGCF_INSPECTION_HARDWARE__",
    );
    const parts = stdout.trim().split(RECORD);
    if (parts.length !== (this.input.expected_network.ipv6 ? 11 : 9))
      throw new BootstrapError("inspection_readback_invalid");
    const disks = array(object(JSON.parse(parts[0]!)).blockdevices).filter(
      (disk) => disk.type === "disk",
    );
    const disk = disks[0];
    if (
      disks.length !== 1 ||
      !disk ||
      typeof disk.path !== "string" ||
      !/^\/dev\/(?:[sv]d[a-z]|nvme[0-9]+n[0-9]+)$/.test(disk.path)
    )
      throw new BootstrapError("inspection_disk_invalid");
    const mounted = (block: Json): boolean => {
      if (!Array.isArray(block.mountpoints))
        throw new BootstrapError("inspection_disk_invalid");
      return (
        block.mountpoints.some(
          (value) => typeof value === "string" && value.length > 0,
        ) ||
        (block.children !== undefined && array(block.children).some(mounted))
      );
    };
    if (mounted(disk)) throw new BootstrapError("inspection_disk_mounted");
    const links = array(JSON.parse(parts[1]!)).filter(
        (link) => link.link_type === "ether",
      ),
      nic = links[0];
    const addresses = array(JSON.parse(parts[2]!)).find(
      (address) => address.ifname === nic?.ifname,
    );
    const assigned = addresses
      ? array(addresses.addr_info).filter(
          (address) => address.family === "inet",
        )
      : [];
    const routes = array(JSON.parse(parts[3]!));
    const expected = this.input.expected_network;
    if (
      links.length !== 1 ||
      !nic ||
      nic.address !== expected.mac ||
      assigned.length !== 1 ||
      assigned[0]?.local !== expected.ipv4 ||
      assigned[0]?.prefixlen !== expected.prefix_length ||
      routes.length !== 1 ||
      routes[0]?.gateway !== expected.gateway ||
      routes[0]?.dev !== nic.ifname
    )
      throw new BootstrapError("inspection_network_mismatch");
    let ipv6:
      { address: string; prefix_length: number; gateway: string } | undefined;
    if (expected.ipv6) {
      const normalize = (value: unknown) => {
        if (
          typeof value !== "string" ||
          value.includes("%") ||
          value.includes(".")
        )
          throw new BootstrapError("inspection_ipv6_unavailable");
        try {
          return new URL(`https://[${value}]`).hostname.slice(1, -1);
        } catch {
          throw new BootstrapError("inspection_ipv6_unavailable");
        }
      };
      const addresses6 = array(JSON.parse(parts[9]!)).find(
        (address) => address.ifname === nic.ifname,
      );
      const matches6 = addresses6
        ? array(addresses6.addr_info).filter(
            (address) =>
              address.family === "inet6" &&
              normalize(address.local) === normalize(expected.ipv6!.address),
          )
        : [];
      const routes6 = array(JSON.parse(parts[10]!)).filter(
        (route) => route.dev === nic.ifname,
      );
      if (
        matches6.length !== 1 ||
        matches6[0]!.prefixlen !== expected.ipv6.prefix_length ||
        routes6.length !== 1 ||
        (expected.ipv6.gateway !== undefined &&
          normalize(expected.ipv6.gateway) !== normalize(routes6[0]!.gateway))
      )
        throw new BootstrapError("inspection_ipv6_unavailable");
      ipv6 = {
        address: normalize(matches6[0]!.local),
        prefix_length: expected.ipv6.prefix_length,
        gateway: normalize(routes6[0]!.gateway),
      };
    }
    if (parts[5]!.trim()) throw new BootstrapError("inspection_swap_active");
    const roots = array(object(JSON.parse(parts[4]!)).filesystems),
      root = roots[0];
    if (roots.length !== 1 || !root)
      throw new BootstrapError("inspection_ram_backing_unproven");
    const paths = overlayPaths(root);
    if (paths.length) {
      const proof = (
        await this.ssh(
          paths
            .map(
              (path) =>
                `findmnt --json --target ${shellQuote(path)} --output TARGET,FSTYPE,SOURCE,OPTIONS`,
            )
            .join(`\nprintf ${shellQuote(RECORD)}\n`),
        )
      )
        .trim()
        .split(RECORD);
      if (proof.length !== paths.length)
        throw new BootstrapError("inspection_ram_backing_unproven");
      paths.forEach((path, index) => ramMount(proof[index]!, path));
    } else ramMount(parts[4]!, "/");
    ramMount(parts[8]!, "/run");
    const ram_bytes = positive(parts[6]),
      available = positive(parts[7]),
      disk_bytes = positive(disk.size);
    if (available > ram_bytes || disk_bytes % 512 !== 0 || available <= RESERVE)
      throw new BootstrapError("inspection_ram_insufficient");
    return {
      hardware: {
        ...expected,
        ...(ipv6 ? { ipv6 } : {}),
        install_disk: disk.path,
        disk_bytes,
        ram_bytes,
      },
      available,
    };
  }
  private async response(url: string, init?: RequestInit, registry = false) {
    this.signal.throwIfAborted();
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.min(15_000, this.remaining())),
    ]);
    let target = new URL(url),
      redirects = 0,
      authenticatedRepository: string | undefined,
      pullToken: string | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      signal.throwIfAborted();
      const headers = new Headers(init?.headers);
      const repository = target.pathname.match(
        /^\/v2\/(siderolabs\/.+)\/(?:manifests|blobs)\/[^/]+$/,
      )?.[1];
      if (
        pullToken &&
        target.hostname === "ghcr.io" &&
        repository === authenticatedRepository
      )
        headers.set("authorization", `Bearer ${pullToken}`);
      const response = await this.request(target.href, {
        ...init,
        headers,
        redirect: registry ? "manual" : "error",
        signal,
      });
      if (registry && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || ++redirects > 3)
          throw new BootstrapError("inspection_registry_redirect_invalid");
        const next = new URL(location, target);
        if (
          next.protocol !== "https:" ||
          next.port ||
          next.username ||
          next.password ||
          next.hash ||
          !(
            next.hostname === "factory.talos.dev" ||
            next.hostname === "ghcr.io" ||
            next.hostname.endsWith(".githubusercontent.com")
          )
        )
          throw new BootstrapError("inspection_registry_redirect_invalid");
        target = next;
        continue;
      }
      if (
        registry &&
        response.status === 401 &&
        target.hostname === "ghcr.io" &&
        repository &&
        !pullToken
      ) {
        const challenge = response.headers.get("www-authenticate") ?? "";
        await response.body?.cancel();
        const realm = challenge.match(/\brealm="([^"]+)"/)?.[1],
          service = challenge.match(/\bservice="([^"]+)"/)?.[1],
          scope = challenge.match(/\bscope="([^"]+)"/)?.[1];
        if (
          !/^Bearer /i.test(challenge) ||
          realm !== "https://ghcr.io/token" ||
          service !== "ghcr.io" ||
          scope !== `repository:${repository}:pull`
        )
          throw new BootstrapError("inspection_registry_challenge_invalid");
        const tokenURL = new URL(realm);
        tokenURL.searchParams.set("service", service);
        tokenURL.searchParams.set("scope", scope);
        const tokenBody = object(
          JSON.parse((await this.response(tokenURL.href)).body),
        );
        const token = tokenBody.token ?? tokenBody.access_token;
        if (
          typeof token !== "string" ||
          token.length < 1 ||
          token.length > 16_384 ||
          !/^[A-Za-z0-9._~+/=-]+$/.test(token)
        )
          throw new BootstrapError("inspection_registry_token_invalid");
        pullToken = token;
        authenticatedRepository = repository;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BootstrapError("inspection_official_source_refused");
      }
      return {
        response,
        body: await inspectionResponseBody(response, LIMIT, signal),
      };
    }
    throw new BootstrapError("inspection_registry_redirect_invalid");
  }
  private async imageIdentity() {
    const schematic = bootstrapSchematic({
      hardware: { ...this.input.expected_network, dns: this.input.dns },
      peer_ipv4: this.input.peer_ipv4,
    });
    const result = await this.response("https://factory.talos.dev/schematics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(schematic),
    });
    const id = object(JSON.parse(result.body)).id;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new BootstrapError("inspection_schematic_invalid");
    const manifest = await this.response(
      `https://factory.talos.dev/v2/metal-installer/${id}/manifests/v${TALOS_VERSION}`,
      {
        headers: {
          accept:
            "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json",
        },
      },
      true,
    );
    const installer_digest = `sha256:${digest(manifest.body)}`;
    if (
      manifest.response.headers.get("docker-content-digest") !==
      installer_digest
    )
      throw new BootstrapError("inspection_installer_digest_mismatch");
    const parsed = object(JSON.parse(manifest.body));
    if (
      parsed.schemaVersion !== 2 ||
      typeof parsed.mediaType !== "string" ||
      ![
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(parsed.mediaType)
    )
      throw new BootstrapError("inspection_installer_manifest_invalid");
    if (
      parsed.manifests !== undefined &&
      !array(parsed.manifests).some(
        (entry) =>
          typeof entry.digest === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(entry.digest) &&
          object(entry.platform).architecture === "amd64" &&
          object(entry.platform).os === "linux",
      )
    )
      throw new BootstrapError("inspection_installer_architecture_invalid");
    return { schematic_id: id, installer_digest };
  }
  private async prepareScratch(available: number) {
    this.scratchOwned = true;
    const path = shellQuote(this.remotePath()),
      source = shellQuote(this.scratchSource()),
      identity = shellQuote(this.scratchIdentity());
    const stdout = await this.ssh(`# __PGCF_INSPECTION_SCRATCH__\n${rootGuard}
for inspection_tool in curl python3 findmnt mount umount readlink find stat df awk getconf sfdisk sgdisk; do command -v "$inspection_tool" >/dev/null; done
python3 -c 'import lzma, hashlib'
test ! -L /run && test "$(readlink -f /run)" = /run
case "$(findmnt --noheadings --raw --target /run --output FSTYPE)" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
test ! -L /run/pgcf-inspection
if test -e /run/pgcf-inspection; then test -d /run/pgcf-inspection; else mkdir /run/pgcf-inspection; fi
test "$(readlink -f /run/pgcf-inspection)" = /run/pgcf-inspection
case "$(findmnt --noheadings --raw --target /run/pgcf-inspection --output FSTYPE)" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
test ! -e ${path} && test ! -L ${path}
inspection_available="$(awk '$1 == "MemAvailable:" {printf "%.0f\\n", $2 * 1024}' /proc/meminfo)"
inspection_page="$(getconf PAGESIZE)"
case "$inspection_available:$inspection_page" in *[!0-9:]*|:*|*:) exit 41;; esac
test "$inspection_page" -gt 0 && test "$inspection_available" -gt ${RESERVE}
if test "$inspection_available" -gt ${available}; then inspection_available=${available}; fi
inspection_size=$(( (inspection_available - ${RESERVE}) / inspection_page * inspection_page ))
test "$inspection_size" -gt 0
mkdir ${path}
printf '%s' ${identity} > ${path}/.owner
mount -t tmpfs -o "size=$inspection_size,mode=0700,nosuid,nodev,noexec" ${source} ${path}
test "$(findmnt --noheadings --raw --target ${path} --output TARGET,SOURCE,FSTYPE)" = ${shellQuote(`${this.remotePath()} ${this.scratchSource()} tmpfs`)}
test "$(findmnt --noheadings --raw --submounts --mountpoint ${path} --output TARGET)" = ${path}
printf '%s' ${identity} > ${path}/identity
inspection_capacity="$(df --block-size=1 --output=size,avail ${path} | awk 'NR == 2 {print $1, $2}')"
read -r inspection_total inspection_free inspection_extra <<< "$inspection_capacity"
test -z "$inspection_extra" && test "$inspection_total" -eq "$inspection_size" && test "$inspection_free" -gt 0
printf '%s\\n' "$inspection_free"`);
    return positive(stdout.trim());
  }
  private async inspectImage(id: string, bytes: number, diskBytes: number) {
    const path = this.remotePath(),
      compressed = shellQuote(`${path}/image.raw.xz`),
      raw = shellQuote(`${path}/image.raw`);
    const url = `https://factory.talos.dev/image/${id}/v${TALOS_VERSION}/nocloud-amd64.raw.xz`;
    const stdout = await this.ssh(`# __PGCF_INSPECTION_IMAGE__\n${rootGuard}
test "$(findmnt --noheadings --raw --target ${shellQuote(path)} --output TARGET,SOURCE,FSTYPE)" = ${shellQuote(`${path} ${this.scratchSource()} tmpfs`)}
test "$(cat ${shellQuote(`${path}/identity`)})" = ${shellQuote(this.scratchIdentity())}
test ! -e ${compressed} && test ! -L ${compressed} && test ! -e ${raw} && test ! -L ${raw}
curl --disable --silent --show-error --fail --location --max-redirs 3 --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 480 --retry 0 --max-filesize ${bytes} --output ${compressed} ${shellQuote(url)}
python3 - ${compressed} ${raw} ${bytes} ${diskBytes} <<'PGCF_INSPECTION_IMAGE_PY'
import hashlib, json, lzma, os, sys
compressed, raw = sys.argv[1:3]
compressed_bytes = os.stat(compressed).st_size
maximum = min(int(sys.argv[3]) - compressed_bytes - 4096, int(sys.argv[4]))
if compressed_bytes <= 0 or maximum <= 0:
    raise RuntimeError('inspection_image_size_invalid')
compressed_hash = hashlib.sha256()
with open(compressed, 'rb') as source:
    while chunk := source.read(1024 * 1024):
        compressed_hash.update(chunk)
raw_hash, written = hashlib.sha256(), 0
decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=256 * 1024 * 1024)
with open(compressed, 'rb') as source, open(raw, 'xb') as target:
    while not decoder.eof:
        data = source.read(1024 * 1024) if decoder.needs_input else b''
        if decoder.needs_input and not data:
            raise RuntimeError('inspection_image_truncated')
        chunk = decoder.decompress(data, max_length=1024 * 1024)
        written += len(chunk)
        if written > maximum:
            raise RuntimeError('inspection_image_size_invalid')
        target.write(chunk)
        raw_hash.update(chunk)
    if decoder.unused_data or source.read(1):
        raise RuntimeError('inspection_image_trailing_bytes')
if written <= 0 or written % 512:
    raise RuntimeError('inspection_image_size_invalid')
print(json.dumps({'compressed_sha256': compressed_hash.hexdigest(), 'compressed_bytes': compressed_bytes, 'raw_sha256': raw_hash.hexdigest(), 'raw_bytes': written}))
PGCF_INSPECTION_IMAGE_PY`);
    const measured = object(JSON.parse(stdout));
    const compressed_bytes = positive(measured.compressed_bytes),
      raw_bytes = positive(measured.raw_bytes);
    if (
      compressed_bytes + raw_bytes > bytes ||
      raw_bytes > diskBytes ||
      raw_bytes % 512 !== 0 ||
      typeof measured.compressed_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(measured.compressed_sha256) ||
      typeof measured.raw_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(measured.raw_sha256)
    )
      throw new BootstrapError("inspection_image_size_invalid");
    const layout = partitions(await this.ssh(`sfdisk --json ${raw}`));
    let previous = 34;
    for (const partition of layout.toSorted((a, b) => a.start - b.start)) {
      const end = partition.start + partition.size;
      if (
        !Number.isSafeInteger(end) ||
        partition.start < previous ||
        end * 512 > raw_bytes
      )
        throw new BootstrapError("inspection_image_partition_bounds");
      previous = end;
    }
    let verification = (
      await this.ssh(`sgdisk --verify ${raw} 2>&1`)
    ).trimStart();
    if (
      layout.every((partition) => partition.start >= 2048) &&
      verification.startsWith(GPT_RESERVED_GAP_ADVISORY)
    )
      verification = verification
        .slice(GPT_RESERVED_GAP_ADVISORY.length)
        .trimStart();
    if (
      !verification.startsWith("No problems found.") ||
      /warning|caution|error|invalid|mismatch/i.test(verification)
    )
      throw new BootstrapError("inspection_image_gpt_invalid");
    return {
      compressed_sha256: measured.compressed_sha256,
      compressed_bytes,
      raw_sha256: measured.raw_sha256,
      raw_bytes,
    };
  }
  private async cleanupScratch() {
    if (!this.scratchOwned) return;
    const path = shellQuote(this.remotePath());
    const stdout = await this.ssh(
      `# __PGCF_INSPECTION_CLEANUP__\n${rootGuard}
test ! -L /run && test "$(readlink -f /run)" = /run
test ! -L /run/pgcf-inspection && test ! -L ${path}
if test -e ${path}; then
  test -d ${path} && test "$(readlink -f ${path})" = ${path}
  inspection_mount="$(findmnt --noheadings --raw --target ${path} --output TARGET,SOURCE,FSTYPE)"
  if test "$inspection_mount" = ${shellQuote(`${this.remotePath()} ${this.scratchSource()} tmpfs`)}; then
    test "$(findmnt --noheadings --raw --submounts --mountpoint ${path} --output TARGET)" = ${path}
    test -z "$(find ${path} -mindepth 1 -maxdepth 1 ! -name identity ! -name image.raw.xz ! -name image.raw -print -quit)"
    for inspection_file in identity image.raw.xz image.raw; do
      test ! -L ${path}/"$inspection_file"
      if test -e ${path}/"$inspection_file"; then test -f ${path}/"$inspection_file"; fi
    done
    if test -e ${path}/identity; then test "$(cat ${path}/identity)" = ${shellQuote(this.scratchIdentity())}; fi
    rm -f -- ${path}/image.raw.xz ${path}/image.raw ${path}/identity
    umount -- ${path}
  fi
  test ! -L ${path}/.owner && test -f ${path}/.owner
  test "$(cat ${path}/.owner)" = ${shellQuote(this.scratchIdentity())}
  test -z "$(find ${path} -mindepth 1 -maxdepth 1 ! -name .owner -print -quit)"
  rm -f -- ${path}/.owner
  test -z "$(find ${path} -mindepth 1 -maxdepth 1 -print -quit)"
  test "$(findmnt --noheadings --raw --target ${path} --output TARGET)" != ${path}
  rmdir -- ${path}
fi
printf '%s\\n' pgcf_inspection_clean`,
      true,
    );
    if (stdout.trim() !== "pgcf_inspection_clean")
      throw new BootstrapError("inspection_cleanup_failed");
    this.scratchOwned = false;
  }
  async inspect(): Promise<NodeInstallationInspection> {
    try {
      await this.setup();
      const before = await this.hardware();
      const identity = await this.imageIdentity();
      const bytes = await this.prepareScratch(before.available);
      const image = await this.inspectImage(
        identity.schematic_id,
        bytes,
        before.hardware.disk_bytes,
      );
      await this.cleanupScratch();
      const after = await this.hardware();
      if (canonical(after.hardware) !== canonical(before.hardware))
        throw new BootstrapError("inspection_hardware_changed");
      this.signal.throwIfAborted();
      return NodeInstallationInspection.parse({
        purpose: "pgcf-node-inspection/v1",
        operation_id: this.input.operation_id,
        node_id: this.input.node_id,
        region_id: this.input.region_id,
        provider_instance_id: this.input.provider_instance_id,
        profile_sha256: this.input.profile_sha256,
        binding_sha256: this.input.binding_sha256,
        network_plan_sha256: this.input.network_plan_sha256,
        observed_at: new Date().toISOString(),
        rescue_host_fingerprint: this.input.rescue.ssh_host_fingerprint,
        hardware: after.hardware,
        image: { ...identity, ...image },
      });
    } finally {
      try {
        await this.cleanupScratch();
      } finally {
        for (const timer of this.timers) clearTimeout(timer);
        this.hard.abort();
        if (this.directory)
          await rm(this.directory, { recursive: true, force: true });
      }
    }
  }
}

/** No disk writes, service changes, persistent configurations or guessed SKU capacities. */
export async function inspectNode(
  input: NodeInspectionInput,
  options: InspectionOptions = {},
): Promise<NodeInstallationInspection> {
  return new Inspector(input, options).inspect();
}

/** Report exactly once after successful cleanup; a lost callback response is an unknown write. */
export async function runInspection(
  value: NodeInspectionInput,
  options: InspectionOptions = {},
): Promise<NodeInstallationInspection> {
  const input = validateInput(value),
    started = performance.now(),
    initialRemaining = Date.parse(input.deadline_at) - Date.now();
  const inspection = await inspectNode(input, options);
  const remaining = Math.floor(
    initialRemaining - (performance.now() - started),
  );
  if (remaining <= 0) throw new BootstrapError("inspection_deadline_expired");
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.min(15_000, remaining)),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const body = JSON.stringify(
    NodeInstallationInspectionRequest.parse({
      expected_generation: input.expected_generation,
      inspection,
    }),
  );
  if (Buffer.byteLength(body) > 64 * 1024)
    throw new BootstrapError("inspection_report_limit");
  try {
    const response = await (options.request ?? fetch)(input.callback.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.callback.bearer}`,
        "content-type": "application/json",
      },
      body,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BootstrapError("inspection_report_refused");
    }
    await inspectionResponseBody(response, 16_384, signal);
    return inspection;
  } catch (error) {
    if (
      error instanceof BootstrapError &&
      error.code === "inspection_report_refused"
    )
      throw error;
    throw new BootstrapError("inspection_report_unknown");
  }
}
