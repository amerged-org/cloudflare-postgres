// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createPrivateKey, createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  NodeBootstrapMaintenanceObservation,
  NodeBootstrapStage,
  type NodeJoinBundle,
} from "@pgcf/contracts/node-bootstrap";
import {
  NodeProofBinding,
  NodeProofMeasurement,
  NodeProofReport,
  type NodeProofExecutionInput,
  type NodeProofSource,
} from "@pgcf/contracts/node-proof";
import {
  runCommand,
  shellQuote,
  jsonRecords,
  type Command,
  type CommandRunner,
  type CommandResult,
} from "./bootstrap.ts";
import { BootstrapError } from "./bootstrap-error.ts";
import { hash } from "../../../scripts/e2e/src/node-network-native.ts";
import {
  authorizeProofTransport,
  startProofProxy,
  validateProofExecution,
  type ProofProxyConfig,
} from "./proof-proxy-command.ts";
import { inspectionResponseBody } from "./inspection-proxy-command.ts";
import {
  cleanupOwnedProofSource,
  EXPIRED_SOURCE_CLEANUP_MAX_MS,
  runOwnedOutsideScan,
  type ProofSourceDescriptor,
  type ProofSourceOwnership,
  type ProofSourceCommandOptions,
} from "./proof-source.ts";
import type { OutsideScanInput } from "./outside-scan.ts";
import type { PostjoinProofOwnership } from "./postjoin-proof.ts";

type Json = Record<string, unknown>;
type ProofBinding = z.infer<typeof NodeProofBinding>;
export interface SavedProofSource {
  key: string;
  state: ProofSourceOwnership;
  originalInput: OutsideScanInput;
  publicSource: ProofSourceDescriptor;
}
export interface ProofSourceJournal {
  read(key: string): Promise<ProofSourceOwnership | null>;
  save(
    key: string,
    state: ProofSourceOwnership,
    originalInput: OutsideScanInput,
    publicSource: ProofSourceDescriptor,
  ): Promise<void>;
  expired?(): Promise<SavedProofSource[]>;
}
export interface ProofPostjoinJournal {
  read(): Promise<PostjoinProofOwnership | null>;
  save(state: PostjoinProofOwnership): Promise<void>;
}
export type ProofCaptureRunner = (
  command: Command,
) => Promise<{ stdout: Uint8Array; stderr: string }>;
export interface NodeProofOptions {
  run?: CommandRunner;
  request?: typeof fetch;
  capture?: ProofCaptureRunner;
  signal?: AbortSignal;
  sourceOwnership?: ProofSourceJournal;
  postjoinOwnership?: ProofPostjoinJournal;
}
const fail = (code: string): never => {
  throw new BootstrapError(`node_proof_${code}`);
};
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("readback_invalid");
  return value as Json;
}
function list(value: unknown): Json[] {
  if (!Array.isArray(value)) return fail("readback_invalid");
  return value.map(object);
}
export function publicProofSource(
  source: NodeProofSource,
): ProofSourceDescriptor {
  const shared = {
    node_id: source.node_id,
    provider_instance_id: source.provider_instance_id,
    ipv4: source.ipv4,
    ...(source.ipv6 ? { ipv6: source.ipv6 } : {}),
  };
  return source.kind === "rescue"
    ? { ...shared, kind: "rescue", operation_id: source.operation_id }
    : {
        ...shared,
        kind: "pod",
        cluster_uid: source.cluster_uid,
        node_uid: source.node_uid,
        node_name: source.node_name,
        region_id: source.region_id,
        image: source.image,
      };
}
/** Binary PCAP is bounded without conversion to UTF-8 or a shell interpolation. */
export const runProofCapture: ProofCaptureRunner = async (command) => {
  if (command.timeout_ms <= 0 || command.timeout_ms > 600_000)
    return fail("capture_bound_invalid");
  command.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: command.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0,
      stderr = "",
      failure: BootstrapError | null = null;
    const stop = (code: string) => {
      failure ??= new BootstrapError(`node_proof_${code}`);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () => stop("capture_cancelled"),
      timer = setTimeout(() => stop("capture_timeout"), command.timeout_ms);
    command.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 ** 2) stop("capture_output_limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.length > 64 * 1024)
        stop("capture_output_limit");
      else stderr += chunk.toString("utf8");
    });
    child.once("error", () => {
      failure ??= new BootstrapError("node_proof_capture_unavailable");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      command.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new BootstrapError("node_proof_capture_failed"));
      else resolve({ stdout: Buffer.concat(chunks, bytes), stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(command.stdin);
  });
};
class ProofRunner {
  readonly input: NodeProofExecutionInput;
  readonly options: NodeProofOptions;
  readonly request: typeof fetch;
  readonly runCommand: CommandRunner;
  readonly hard = new AbortController();
  readonly signal: AbortSignal;
  readonly end: number;
  readonly timer: ReturnType<typeof setTimeout>;
  directory = "";
  readonly proxies = new Map<
    "target" | "source",
    Awaited<ReturnType<typeof startProofProxy>>
  >();
  readonly configs = new Map<"target" | "source", string>();
  readonly sshArgs = new Map<"target" | "source", string[]>();
  constructor(value: NodeProofExecutionInput, options: NodeProofOptions) {
    this.input = validateProofExecution(value);
    this.options = options;
    this.request = options.request ?? fetch;
    this.runCommand = options.run ?? runCommand;
    const remaining = Date.parse(this.input.claims.expires_at) - Date.now();
    this.end = performance.now() + remaining;
    this.signal = AbortSignal.any([
      this.hard.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    this.timer = setTimeout(() => this.hard.abort(), remaining);
    this.timer.unref();
    for (const journal of [options.sourceOwnership, options.postjoinOwnership])
      if (journal && (!journal.read || !journal.save))
        fail("ownership_callbacks_invalid");
  }
  private remaining() {
    const remaining = Math.floor(this.end - performance.now());
    if (remaining <= 0) return fail("deadline");
    return remaining;
  }
  private config(direction: "target" | "source"): ProofProxyConfig {
    return { input: this.input, direction };
  }
  private async post(
    path: string,
    body: unknown,
    limit: number,
    signal = this.signal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const bytes = JSON.stringify(body);
    if (Buffer.byteLength(bytes) > 2 * 1024 ** 2) return fail("request_limit");
    const bounded = AbortSignal.any([
      signal,
      this.hard.signal,
      AbortSignal.timeout(Math.min(60_000, this.remaining())),
    ]);
    const response = await this.request(
      this.input.api_base_url +
        `/internal/v1/node-proof/${this.input.claims.operation_id}/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.input.session_bearer}`,
          "content-type": "application/json",
        },
        body: bytes,
        redirect: "error",
        signal: bounded,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return fail("authority_refused");
    }
    const text = await inspectionResponseBody(response, limit, bounded);
    bounded.throwIfAborted();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return fail("response_invalid");
    }
  }
  private async authorize(direction: "target" | "source") {
    const capability =
      direction === "source" && this.input.source.kind === "rescue"
        ? "rescue_ssh"
        : "kubernetes_api";
    await authorizeProofTransport(
      this.config(direction),
      capability,
      this.hard.signal,
      this.request,
    );
  }
  private sourceJournal(): ProofSourceJournal {
    if (this.options.sourceOwnership) return this.options.sourceOwnership;
    return {
      read: async (key) => {
        const body = object(
          await this.post(
            "ownership",
            { action: "read", kind: "source", key },
            2 * 1024 ** 2,
            this.hard.signal,
          ),
        );
        return body.entry === null
          ? null
          : (object(body.entry).state as ProofSourceOwnership);
      },
      save: async (key, state, originalInput, publicSource) => {
        const body = object(
          await this.post(
            "ownership",
            {
              action: "save",
              kind: "source",
              key,
              state,
              originalInput,
              publicSource,
            },
            16_384,
            this.hard.signal,
          ),
        );
        if (body.saved !== true) return fail("ownership_unconfirmed");
      },
      expired: async () => {
        const body = object(
          await this.post(
            "ownership",
            {
              action: "expired",
              kind: "source",
              key: this.input.claims.session_id,
            },
            2 * 1024 ** 2,
            this.hard.signal,
          ),
        );
        if (!Array.isArray(body.entries) || body.entries.length > 16)
          return fail("ownership_invalid");
        return body.entries as SavedProofSource[];
      },
    };
  }
  private postjoinJournal(): ProofPostjoinJournal {
    if (this.options.postjoinOwnership) return this.options.postjoinOwnership;
    const key = this.input.claims.session_id;
    return {
      read: async () => {
        const body = object(
          await this.post(
            "ownership",
            { action: "read", kind: "postjoin", key },
            2 * 1024 ** 2,
            this.hard.signal,
          ),
        );
        return body.entry === null
          ? null
          : (object(body.entry).state as PostjoinProofOwnership);
      },
      save: async (state) => {
        const body = object(
          await this.post(
            "ownership",
            { action: "save", kind: "postjoin", key, state },
            16_384,
            this.hard.signal,
          ),
        );
        if (body.saved !== true) return fail("ownership_unconfirmed");
      },
    };
  }
  private environment(direction: "target" | "source") {
    return {
      PATH: process.env.PATH,
      LANG: "C",
      TMPDIR: this.directory,
      HTTPS_PROXY: this.proxies.get(direction)?.url,
      HTTP_PROXY: this.proxies.get(direction)?.url,
      NO_PROXY: "",
    };
  }
  private async execute(
    direction: "target" | "source",
    executable: string,
    args: string[],
    stdin?: string,
    permitFailure = false,
    options?: ProofSourceCommandOptions,
  ): Promise<CommandResult> {
    const signal = AbortSignal.any([
      options?.signal ?? this.signal,
      this.hard.signal,
    ]);
    signal.throwIfAborted();
    const result = await this.runCommand({
      executable,
      args,
      env: this.environment(direction),
      signal,
      timeout_ms: Math.min(options?.timeout_ms ?? 540_000, this.remaining()),
      ...(stdin === undefined ? {} : { stdin }),
    });
    signal.throwIfAborted();
    if (Buffer.byteLength(result.stdout) > 512 * 1024)
      return fail("command_output_limit");
    if (result.exit_code !== 0 && !permitFailure) return fail("command_failed");
    return result;
  }
  private kube(
    direction: "target" | "source",
    args: string[],
    permitFailure = false,
    stdin?: string,
    options?: ProofSourceCommandOptions,
  ) {
    const path = this.configs.get(direction);
    if (!path) return fail("cluster_bundle_missing");
    return this.execute(
      direction,
      "kubectl",
      [
        "--kubeconfig",
        path,
        "--request-timeout=30s",
        "--cache-dir",
        join(this.directory, `${direction}-cache`),
        ...args,
      ],
      stdin,
      permitFailure,
      options,
    );
  }
  private async kubeconfig(
    direction: "target" | "source",
    bundle: NodeJoinBundle,
  ) {
    const config = object(parse(bundle.kubeconfig)),
      clusters = list(config.clusters),
      users = list(config.users),
      contexts = list(config.contexts);
    if (clusters.length !== 1 || users.length !== 1 || contexts.length !== 1)
      return fail("kubeconfig_invalid");
    const cluster = object(clusters[0]!.cluster),
      user = object(users[0]!.user),
      context = object(contexts[0]!.context);
    if (
      cluster.server !== bundle.cluster_endpoint ||
      cluster["insecure-skip-tls-verify"] ||
      !cluster["certificate-authority-data"] ||
      Object.keys(cluster).some(
        (key) =>
          ![
            "server",
            "certificate-authority-data",
            "proxy-url",
            "tls-server-name",
          ].includes(key),
      ) ||
      !user["client-certificate-data"] ||
      !user["client-key-data"] ||
      Object.keys(user).some(
        (key) => !["client-certificate-data", "client-key-data"].includes(key),
      ) ||
      context.cluster !== clusters[0]!.name ||
      context.user !== users[0]!.name ||
      config["current-context"] !== contexts[0]!.name ||
      (context.namespace !== undefined && context.namespace !== "default")
    )
      return fail("kubeconfig_identity_changed");
    delete context.namespace;
    delete cluster["tls-server-name"];
    cluster["proxy-url"] = this.proxies.get(direction)!.url;
    const filename = join(this.directory, `${direction}-kubeconfig`);
    await writeFile(filename, stringify(config), { mode: 0o600 });
    this.configs.set(direction, filename);
  }
  private async setupSsh() {
    if (this.input.source.kind !== "rescue") return;
    const source = this.input.source,
      rescue = source.access.rescue,
      bytes = Buffer.from(rescue.ssh_host_key.split(" ")[1]!, "base64"),
      fingerprint = `SHA256:${createHash("sha256").update(bytes).digest("base64").replaceAll("=", "")}`;
    if (
      bytes.length !== 51 ||
      bytes.readUInt32BE(0) !== 11 ||
      bytes.subarray(4, 15).toString() !== "ssh-ed25519" ||
      bytes.readUInt32BE(15) !== 32 ||
      fingerprint !== rescue.ssh_host_fingerprint
    )
      return fail("ssh_host_identity_changed");
    if (
      !rescue.ssh_private_key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")
    ) {
      try {
        createPrivateKey(rescue.ssh_private_key);
      } catch {
        return fail("ssh_client_invalid");
      }
    }
    const key = join(this.directory, "source-key"),
      hosts = join(this.directory, "source-known-hosts"),
      config = join(this.directory, "source-proxy.json");
    await writeFile(key, rescue.ssh_private_key, { mode: 0o600 });
    await writeFile(hosts, `${source.operation_id} ${rescue.ssh_host_key}\n`, {
      mode: 0o600,
    });
    await writeFile(config, JSON.stringify(this.config("source")), {
      mode: 0o600,
    });
    await this.execute("source", "ssh-keygen", ["-y", "-P", "", "-f", key]);
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "mjs",
      proxy = fileURLToPath(
        new URL(`./proof-proxy-command.${extension}`, import.meta.url),
      );
    this.sshArgs.set("source", [
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
      `HostKeyAlias=${source.operation_id}`,
      "-o",
      "HostKeyAlgorithms=ssh-ed25519",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=30",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-i",
      key,
      "-o",
      `ProxyCommand=${shellQuote(process.execPath)} ${shellQuote(proxy)} ${shellQuote(config)}`,
    ]);
  }
  private async setup() {
    this.signal.throwIfAborted();
    this.directory = await mkdtemp(join(tmpdir(), "pgcf-node-proof-"));
    await chmod(this.directory, 0o700);
    for (const direction of ["source", "target"] as const) {
      if (direction === "source" && this.input.source.kind === "rescue")
        continue;
      this.proxies.set(
        direction,
        await startProofProxy(
          this.config(direction),
          this.hard.signal,
          this.request,
        ),
      );
      const bundle =
        direction === "source" && this.input.source.kind === "pod"
          ? this.input.source.access.join_bundle
          : this.input.cluster_bundle;
      if (bundle) await this.kubeconfig(direction, bundle);
    }
    await this.setupSsh();
  }
  private sourceCommands(
    journal: ProofSourceJournal,
    key: string,
    original: OutsideScanInput,
    source: ProofSourceDescriptor,
    signal = this.signal,
  ) {
    return {
      authorizeSource: () => this.authorize("source"),
      signal,
      ssh: (script: string, options?: ProofSourceCommandOptions) =>
        this.execute(
          "source",
          "ssh",
          [
            ...this.sshArgs.get("source")!,
            `root@${this.input.source.ipv4}`,
            "bash",
            "-se",
          ],
          script,
          true,
          options,
        ),
      kube: (
        args: string[],
        permit?: boolean,
        stdin?: string,
        options?: ProofSourceCommandOptions,
      ) => this.kube("source", args, permit, stdin, options),
      readOwnership: () => journal.read(key),
      saveOwnership: (state: ProofSourceOwnership) =>
        journal.save(key, state, original, source),
    };
  }
  private async cleanupExpired(
    journal: ProofSourceJournal,
    source: ProofSourceDescriptor,
  ) {
    const entries = (await journal.expired?.()) ?? [];
    if (entries.length > 16) return fail("ownership_invalid");
    for (const entry of entries) {
      if (entry.state.stage === "cleaned") continue;
      if (
        hash(entry.publicSource) !== hash(source) ||
        entry.state.source_sha256 !== hash(source) ||
        typeof entry.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.key)
      )
        return fail("expired_source_authority_changed");
      const commands = this.sourceCommands(
          journal,
          entry.key,
          entry.originalInput,
          source,
        ),
        cleanupAt = new Date(
          Date.now() +
            Math.min(EXPIRED_SOURCE_CLEANUP_MAX_MS, this.remaining() - 1),
        ).toISOString();
      await cleanupOwnedProofSource(
        source,
        entry.originalInput,
        commands,
        cleanupAt,
      );
    }
  }
  private async initialTarget(): Promise<ProofBinding> {
    await this.authorize("target");
    const ns = object(
        JSON.parse(
          (
            await this.kube("target", [
              "get",
              "namespace",
              "kube-system",
              "--output=json",
            ])
          ).stdout,
        ),
      ),
      node = object(
        JSON.parse(
          (
            await this.kube("target", [
              "get",
              "node",
              this.input.bootstrap.spec.hostname,
              "--output=json",
            ])
          ).stdout,
        ),
      );
    const nsm = object(ns.metadata),
      m = object(node.metadata),
      labels = object(m.labels),
      spec = object(node.spec),
      status = object(node.status),
      expected = this.input.bootstrap.spec;
    if (
      ns.apiVersion !== "v1" ||
      ns.kind !== "Namespace" ||
      nsm.name !== "kube-system" ||
      nsm.uid !== this.input.cluster_bundle!.kube_system_uid ||
      nsm.deletionTimestamp ||
      object(ns.status).phase !== "Active" ||
      node.apiVersion !== "v1" ||
      node.kind !== "Node" ||
      m.name !== expected.hostname ||
      m.deletionTimestamp ||
      !z.uuid().safeParse(m.uid).success ||
      typeof m.resourceVersion !== "string" ||
      !/^[0-9]+$/.test(m.resourceVersion) ||
      labels["pgcf.io/node-id"] !== expected.node_id ||
      labels["pgcf.io/region"] !== expected.region_id ||
      labels["pgcf.io/provider-instance-id"] !==
        expected.provider_instance_id ||
      !list(status.conditions).some(
        (item) => item.type === "Ready" && item.status === "True",
      ) ||
      !list(status.addresses).some(
        (item) =>
          item.type === "InternalIP" && item.address === expected.hardware.ipv4,
      ) ||
      !list(spec.taints).some(
        (item) =>
          item.key === "pgcf.io/quarantine" &&
          item.value === "bootstrap" &&
          item.effect === "NoSchedule",
      )
    )
      return fail("target_identity_changed");
    return NodeProofBinding.parse({
      ...this.input.binding,
      verification: {
        input_hash: this.input.bootstrap.input_hash,
        checkpoint_reference: this.input.claims.checkpoint_reference,
        cluster_uid: nsm.uid,
        node_uid: m.uid,
        node_resource_version: m.resourceVersion,
        hostname: m.name,
      },
    });
  }
  private async maintenance() {
    const anchor = this.input.binding.maintenance;
    if (!anchor) return undefined;
    await authorizeProofTransport(
      this.config("target"),
      "talos_api",
      this.signal,
      this.request,
    );
    const target = this.input.bootstrap.spec.hardware.ipv4,
      base = ["--nodes", target, "--endpoints", target];
    const configured =
        NodeBootstrapStage.options.indexOf(anchor.checkpoint_stage) >=
        NodeBootstrapStage.options.indexOf("config_applied"),
      uncertainApply = anchor.checkpoint_stage === "config_apply_intent";
    let credentials = ["--insecure"];
    if (configured || uncertainApply) {
      const text =
        this.input.talos_admin_config ??
        this.input.cluster_bundle?.talos_admin_config;
      if (!text) return fail("talos_custody_missing");
      const admin = object(parse(text)),
        context = object(object(admin.contexts)[String(admin.context)]);
      if (
        ["ca", "crt", "key"].some(
          (key) => typeof context[key] !== "string" || !context[key],
        ) ||
        Object.keys(context).some(
          (key) =>
            !["ca", "crt", "key", "endpoints", "nodes", "proxy-url"].includes(
              key,
            ),
        )
      )
        return fail("talos_custody_invalid");
      context.endpoints = [target];
      context.nodes = [target];
      context["proxy-url"] = this.proxies.get("target")!.url;
      const filename = join(this.directory, "target-talosconfig");
      await writeFile(filename, stringify(admin), { mode: 0o600 });
      credentials = ["--talosconfig", filename];
    }
    let actualVersion = await this.execute(
      "target",
      "talosctl",
      [
        ...base,
        ...credentials.filter((value) => value !== "--insecure"),
        "version",
        "--json",
        ...(credentials[0] === "--insecure" ? credentials : []),
      ],
      undefined,
      true,
    );
    if (actualVersion.exit_code !== 0 && uncertainApply) {
      // An unacknowledged apply may still be in maintenance. This fallback
      // performs the same anchored read only; configured stages never use it.
      credentials = ["--insecure"];
      actualVersion = await this.execute(
        "target",
        "talosctl",
        [...base, "version", "--json", "--insecure"],
        undefined,
        true,
      );
    }
    if (actualVersion.exit_code !== 0)
      return fail("maintenance_authentication_failed");
    const version = object(JSON.parse(actualVersion.stdout));
    if (object(version.version).tag !== `v${anchor.talos_version}`)
      return fail("maintenance_version_changed");
    const disks = jsonRecords(
      (
        await this.execute("target", "talosctl", [
          ...base,
          ...credentials.filter((value) => value !== "--insecure"),
          "get",
          "disks",
          "--output",
          "json",
          ...(credentials[0] === "--insecure" ? credentials : []),
        ])
      ).stdout,
    );
    if (
      disks.filter(
        (entry) =>
          object(entry.spec).dev_path === anchor.install_disk &&
          Number(object(entry.spec).size) === anchor.disk_bytes,
      ).length !== 1
    )
      return fail("maintenance_disk_changed");
    return NodeBootstrapMaintenanceObservation.parse({
      ...anchor,
      observed_at: new Date().toISOString(),
    });
  }
  private async cleanupLocal() {
    for (const proxy of this.proxies.values()) await proxy.close();
    this.proxies.clear();
    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = "";
    }
  }
  async run(): Promise<NodeProofReport> {
    try {
      await this.setup();
      const source = publicProofSource(this.input.source),
        journal = this.sourceJournal();
      await this.cleanupExpired(journal, source);
      const binding: ProofBinding =
        this.input.claims.mode === "postjoin"
          ? await this.initialTarget()
          : structuredClone(this.input.binding);
      const deadline = new Date(
        Date.parse(this.input.claims.expires_at) - 60_000,
      ).toISOString();
      const scanning = new AbortController(),
        scans = (["ipv4", "ipv6"] as const).map(async (family) => {
          const address = family === "ipv4" ? source.ipv4 : source.ipv6;
          const members =
            binding.verification === null
              ? this.input.plan.members
              : this.input.plan.members.filter(
                  (member) => member.node_id === this.input.plan.node_id,
                );
          if (
            !address ||
            !members.length ||
            members.some((member) => member.addresses[family].length === 0)
          )
            return fail(`capability_gap_${family}`);
          const original: OutsideScanInput = {
            plan: this.input.plan,
            binding,
            family,
            control_keys: this.input.control_keys,
            direct_source: address,
            local_source: address,
            https_control: {
              origin: this.input.claims.origin,
              bearer: this.input.session_bearer,
              expires_at: this.input.claims.expires_at,
            },
            deadline_at: deadline,
          };
          const key = hash({
            session_id: this.input.claims.session_id,
            source,
            family,
          });
          return runOwnedOutsideScan(
            source,
            original,
            this.sourceCommands(
              journal,
              key,
              original,
              source,
              AbortSignal.any([this.signal, scanning.signal]),
            ),
          );
        });
      for (const scan of scans) void scan.catch(() => scanning.abort());
      const results = await Promise.allSettled(scans);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const measurements: NodeProofReport["measurements"] = results.map(
        (result) => {
          if (result.status !== "fulfilled") return fail("scan_failed");
          return result.value;
        },
      );
      let postjoin: NodeProofReport["postjoin"] = null;
      if (this.input.claims.mode === "preparation") {
        const maintenance = await this.maintenance();
        const access = NodeProofMeasurement.parse(
          await this.post(
            "access",
            {
              binding,
              ...(maintenance ? { maintenance_observation: maintenance } : {}),
            },
            512 * 1024,
          ),
        );
        if (access.kind !== "access" || access.binding_sha256 !== hash(binding))
          return fail("access_binding_changed");
        measurements.push(access);
      } else {
        const { collectPostjoinProof } = await import("./postjoin-proof.ts"),
          durable = this.postjoinJournal();
        postjoin = await collectPostjoinProof(
          this.input.bootstrap,
          this.input.cluster_bundle!,
          this.input.plan,
          this.input.claims.session_id,
          this.input.claims.expires_at,
          {
            kube: (args, permit, stdin) =>
              this.kube("target", args, permit, stdin, {
                signal: this.hard.signal,
                timeout_ms: Math.min(30_000, this.remaining()),
              }),
            authorize: () => this.authorize("target"),
            readOwnership: durable.read,
            saveOwnership: durable.save,
            signal: this.signal,
            expectedNodeUid: binding.verification!.node_uid,
            capture: (args, signal) =>
              (this.options.capture ?? runProofCapture)({
                executable: "kubectl",
                args: [
                  "--kubeconfig",
                  this.configs.get("target")!,
                  "--request-timeout=30s",
                  ...args,
                ],
                env: this.environment("target"),
                signal: AbortSignal.any([signal, this.hard.signal]),
                timeout_ms: Math.min(540_000, this.remaining()),
              }),
          },
        );
      }
      const report = NodeProofReport.parse({ binding, measurements, postjoin });
      await this.cleanupLocal();
      // One report attempt: an uncertain write is left for Worker/DO readback.
      await this.post("report", report, 16_384);
      return report;
    } finally {
      clearTimeout(this.timer);
      await this.cleanupLocal();
      this.hard.abort();
    }
  }
}
export async function runNodeProof(
  input: NodeProofExecutionInput,
  options: NodeProofOptions = {},
): Promise<NodeProofReport> {
  return new ProofRunner(input, options).run();
}
