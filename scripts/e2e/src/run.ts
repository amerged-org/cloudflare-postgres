// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ApiKeyCreated,
  ConnectionUri,
  Database,
  DatabaseWithOperation,
  Operation,
  Project,
  Region,
  SizeClass,
} from "@pgcf/contracts";
import {
  Cloudflare,
  Kubernetes,
  ManagementApi,
  command,
  nodeAddresses,
  vgSamples,
} from "./clients.ts";
import type { VgSample } from "./clients.ts";
import {
  HarnessError,
  liveArchiveCounts,
  assertOwned,
  assertRunId,
  evidence,
  fingerprint,
  httpsUrl,
  items,
  objectName,
  objectNamespace,
  poll,
  record,
  requireEnv,
  string,
} from "./core.ts";
import { cloudflareInventory } from "./phase0-accept.ts";
import { assertOpenSubset, scanPorts } from "./scan.ts";
import { networkingAudit, chaosEgressPolicy } from "./security.ts";
import { captureTrace } from "./trace.ts";
import { restartSummary } from "./restarts.ts";
import { redactKnownCredentials } from "./audit.ts";

export const REQUIRED_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PGCF_E2E_EXPECTED_ACCOUNT_NAME",
  "PGCF_E2E_API_URL",
  "PGCF_E2E_API_WORKER_NAME",
  "PGCF_E2E_ADMIN_KEY",
  "PGCF_E2E_ENDPOINT_HOST",
  "PGCF_E2E_REGION_ID",
  "PGCF_E2E_BACKUP_BUCKET",
  "PGCF_E2E_BACKUP_JURISDICTION",
  "PGCF_E2E_KUBECONFIG",
  "PGCF_E2E_KUBE_CONTEXT",
  "PGCF_E2E_NODE_NAMES",
  "PGCF_E2E_REGIONAL_NAMESPACE",
  "PGCF_E2E_GHCR_IMAGE",
  "PGCF_E2E_PROBE_BEARER",
  "PGCF_E2E_CREDENTIAL_EXPIRIES",
] as const;

interface Config {
  values: Record<string, string>;
  nodes: string[];
  jurisdiction: "default" | "eu";
  apiUrl: URL;
  credentialExpiries: { name: string; expires_at: string }[];
}
interface Ledger {
  version: 1;
  run_id: string;
  identity: string;
  worker_name: string;
  created_at: string;
  intents: string[];
  completed: string[];
  baseline: VgSample[];
  allocated: VgSample[];
  project_id?: string;
  key_id?: string;
  database_id?: string;
  operation_id?: string;
  pvs: string[];
  lvm_volumes: string[];
  scans: string[];
  operator_scans: string[];
  scan_ranges: Record<string, [number, number][]>;
  archive_failure_started_at?: string;
  tails: { worker: string; id: string }[];
  chaos?: {
    relay_name: string;
    policy_name: string;
    agent_name?: string;
    settings?: {
      uid: string;
      container: string;
      override: Record<string, unknown> | null;
    };
    inverse_needed: boolean;
  };
}

function config(env: NodeJS.ProcessEnv): Config {
  const values = requireEnv(env, REQUIRED_ENV);
  assertOwned(values.PGCF_E2E_API_WORKER_NAME!);
  if (!/(?:-dev|-test)$/.test(values.PGCF_E2E_API_WORKER_NAME!))
    throw new HarnessError("dev_worker_required");
  assertOwned(values.PGCF_E2E_BACKUP_BUCKET!);
  assertOwned(values.PGCF_E2E_REGIONAL_NAMESPACE!);
  const apiUrl = httpsUrl(values.PGCF_E2E_API_URL!);
  if (apiUrl.pathname !== "/") throw new HarnessError("invalid_url");
  if (
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(
      values.PGCF_E2E_ENDPOINT_HOST!,
    ) ||
    values.PGCF_E2E_ENDPOINT_HOST!.includes("..")
  )
    throw new HarnessError("invalid_endpoint_host");
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(values.PGCF_E2E_REGION_ID!))
    throw new HarnessError("invalid_region");
  const jurisdiction = values.PGCF_E2E_BACKUP_JURISDICTION;
  if (jurisdiction !== "default" && jurisdiction !== "eu")
    throw new HarnessError("invalid_jurisdiction");
  if (values.PGCF_E2E_PROBE_BEARER!.length < 32)
    throw new HarnessError("probe_bearer_too_short");
  let nodes: string[],
    credentialExpiries: { name: string; expires_at: string }[];
  try {
    nodes = JSON.parse(values.PGCF_E2E_NODE_NAMES!);
    const input: unknown = JSON.parse(values.PGCF_E2E_CREDENTIAL_EXPIRIES!);
    if (
      !Array.isArray(nodes) ||
      !nodes.length ||
      new Set(nodes).size !== nodes.length ||
      nodes.some(
        (name) =>
          typeof name !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(name),
      ) ||
      !Array.isArray(input)
    )
      throw new HarnessError("invalid_config");
    credentialExpiries = input.map((row: unknown) => {
      const entry = record(row);
      const name = string(entry.name),
        expires_at = string(entry.expires_at);
      if (
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
        Number.isNaN(Date.parse(expires_at)) ||
        Date.parse(expires_at) <= Date.now()
      )
        throw new HarnessError("credential_expired");
      return { name, expires_at: new Date(expires_at).toISOString() };
    });
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "PGCF_E2E_ADMIN_KEY",
      "PGCF_E2E_PROBE_BEARER",
      "PGCF_E2E_KUBECONFIG",
    ])
      if (!credentialExpiries.some((e) => e.name === name))
        throw new HarnessError("credential_expiry_missing");
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("invalid_config");
  }
  return { values, nodes, jurisdiction, apiUrl, credentialExpiries };
}

function runIdentity(c: Config): string {
  return fingerprint(
    [
      c.values.CLOUDFLARE_ACCOUNT_ID,
      c.apiUrl.href,
      c.values.PGCF_E2E_ENDPOINT_HOST,
      c.values.PGCF_E2E_REGION_ID,
      c.values.PGCF_E2E_BACKUP_BUCKET,
      c.values.PGCF_E2E_BACKUP_JURISDICTION,
      c.values.PGCF_E2E_KUBE_CONTEXT,
      ...c.nodes,
    ].join("\n"),
  );
}

async function anonymousImage(image: string): Promise<void> {
  const match = /^ghcr\.io\/([a-z0-9_./-]+)@(sha256:[a-f0-9]{64})$/.exec(image);
  if (!match || match[1]!.includes(".."))
    throw new HarnessError("pinned_image_required");
  const url = `https://ghcr.io/v2/${match[1]}/manifests/${match[2]}`;
  const headers: Record<string, string> = {
    Accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
  };
  let reply = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (reply.status === 401) {
    const tokenReply = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${match[1]}:pull`)}`,
      { redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
    if (!tokenReply.ok) throw new HarnessError("anonymous_image_unavailable");
    const token = string(record(await tokenReply.json()).token);
    reply = await fetch(url, {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  }
  if (!reply.ok || reply.headers.get("docker-content-digest") !== match[2])
    throw new HarnessError("anonymous_image_unavailable");
  await reply.arrayBuffer();
}

class Run {
  readonly c: Config;
  readonly state: Ledger;
  readonly dryRun: boolean;
  readonly cf: Cloudflare;
  readonly api: ManagementApi;
  readonly kube: Kubernetes;
  readonly dir: string;
  readonly stateDir: string;
  readonly runName: string;
  private deadline = Date.now() + 450_000;
  private probeHost?: string;
  constructor(c: Config, state: Ledger, root: string, dryRun: boolean) {
    this.c = c;
    this.state = state;
    this.dryRun = dryRun;
    this.cf = new Cloudflare(
      c.values.CLOUDFLARE_ACCOUNT_ID!,
      c.values.CLOUDFLARE_API_TOKEN!,
      c.values.PGCF_E2E_EXPECTED_ACCOUNT_NAME!,
      () => this.deadline,
    );
    this.api = new ManagementApi(
      c.apiUrl,
      c.values.PGCF_E2E_ADMIN_KEY!,
      () => this.deadline,
    );
    this.kube = new Kubernetes(
      c.values.PGCF_E2E_KUBECONFIG!,
      c.values.PGCF_E2E_KUBE_CONTEXT!,
      () => this.deadline,
    );
    this.dir = resolve(root, ".local", "evidence", "phase1", state.run_id);
    this.stateDir = resolve(root, ".local", "state", "e2e", state.run_id);
    this.runName = `pgcf-e2e-${state.run_id}`;
    assertOwned(this.runName, state.worker_name);
    if (state.identity !== runIdentity(c))
      throw new HarnessError("run_identity_mismatch");
  }
  async save(): Promise<void> {
    if (this.dryRun) return;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const target = resolve(this.stateDir, "ledger.json");
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, target);
  }
  async emit(
    event: string,
    counts: Record<string, number> = {},
    timings: Record<string, number> = {},
    pass = true,
  ): Promise<void> {
    const result = evidence(
      {
        event,
        pass,
        counts,
        timings,
        at: new Date().toISOString(),
        names: [this.runName],
      },
      new Set([this.runName]),
    );
    console.log(JSON.stringify(result));
    if (!this.dryRun) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(this.dir, `${event}.json`),
        JSON.stringify(result),
        { mode: 0o600 },
      );
    }
  }
  async intent(name: string): Promise<void> {
    if (this.dryRun) throw new HarnessError("dry_run_mutation_refused");
    assertOwned(this.runName, this.state.worker_name);
    if (!this.state.intents.includes(name)) this.state.intents.push(name);
    await this.save();
  }
  async complete(step: string): Promise<void> {
    if (!this.state.completed.includes(step)) this.state.completed.push(step);
    await this.save();
  }
  requireStep(step: string): void {
    if (!this.state.completed.includes(step))
      throw new HarnessError("previous_step_required");
  }
  async verifyIdentity(): Promise<void> {
    await this.cf.verifyAccount();
    const subdomain = string(
      record((await this.cf.request("/workers/subdomain")).result).subdomain,
    );
    const expected = `${this.c.values.PGCF_E2E_API_WORKER_NAME}.${subdomain}.workers.dev`;
    if (this.c.apiUrl.hostname !== expected) {
      const domains = await this.cf.list("/workers/domains");
      if (
        !domains.some(
          (d) =>
            d.hostname === this.c.apiUrl.hostname &&
            d.service === this.c.values.PGCF_E2E_API_WORKER_NAME,
        )
      )
        throw new HarnessError("api_worker_identity_mismatch");
    }
  }
  async verify(): Promise<void> {
    await this.verifyIdentity();
    const regions = (await this.api.list("/v1/regions")).map((row) =>
      Region.parse(row),
    );
    const region = regions.find(
      (r) => r.id === this.c.values.PGCF_E2E_REGION_ID,
    );
    if (
      !region ||
      region.backup_bucket !== this.c.values.PGCF_E2E_BACKUP_BUCKET
    )
      throw new HarnessError("region_bucket_mismatch");
    const sizes = (await this.api.list("/v1/size-classes")).map((row) =>
      SizeClass.parse(row),
    );
    if (!sizes.some((s) => s.id === "small" && s.enabled))
      throw new HarnessError("small_size_class_required");
  }
  async sample(): Promise<VgSample[]> {
    return vgSamples(
      await this.kube.read("lvmnodes.local.openebs.io"),
      this.c.nodes,
      "pgcf",
    );
  }
  async preflight(): Promise<void> {
    await this.verify();
    const [inventory, projects, keys, baseline] = await Promise.all([
      cloudflareInventory(this.cf),
      this.api.list("/v1/projects"),
      this.api.list("/v1/api-keys"),
      this.sample(),
    ]);
    const leftover =
      inventory.some(
        (row) =>
          row.name.startsWith("pgcf-e2e-") &&
          (row.name !== this.runName ||
            !this.state.intents.includes("worker_create")),
      ) ||
      projects.some(
        (p) =>
          String(p.name).startsWith("pgcf-e2e-") &&
          (p.name !== this.runName ||
            !this.state.intents.includes("project_create")),
      ) ||
      keys.some(
        (k) =>
          String(k.name).startsWith("pgcf-e2e-") &&
          (k.name !== this.runName ||
            !this.state.intents.includes("integrator_key_create")) &&
          k.revoked_at === null,
      );
    if (leftover) throw new HarnessError("leftover_e2e_resources");
    await anonymousImage(this.c.values.PGCF_E2E_GHCR_IMAGE!);
    if (!this.state.baseline.length) this.state.baseline = baseline;
    if (!this.dryRun) {
      await this.complete("E0");
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      // Only credential variable names and dates are stored, never credentials.
      await writeFile(
        resolve(this.dir, "credential-expiries.json"),
        JSON.stringify(this.c.credentialExpiries),
        { mode: 0o600 },
      );
    }
    await this.emit("E0", {
      measured_nodes: baseline.length,
      credential_count: this.c.credentialExpiries.length,
    });
  }
  async deployProbe(): Promise<void> {
    await this.intent("worker_create");
    const configPath = resolve(this.stateDir, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: this.runName,
        account_id: this.c.values.CLOUDFLARE_ACCOUNT_ID,
        main: fileURLToPath(new URL("../probe/worker.ts", import.meta.url)),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        observability: { enabled: false },
        vars: {
          API_URL: this.c.apiUrl.href,
          ENDPOINT_HOST: this.c.values.PGCF_E2E_ENDPOINT_HOST,
        },
      }),
      { mode: 0o600 },
    );
    const wrangler = fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    );
    await command(
      process.execPath,
      [wrangler, "deploy", "--config", configPath, "--keep-vars"],
      {
        timeoutMs: Math.min(180_000, this.deadline - Date.now()),
        cwd: this.stateDir,
        env: {
          ...process.env,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_API_TOKEN: this.c.values.CLOUDFLARE_API_TOKEN!,
          CLOUDFLARE_ACCOUNT_ID: this.c.values.CLOUDFLARE_ACCOUNT_ID!,
        },
      },
    );
    await this.secret("PROBE_BEARER", this.c.values.PGCF_E2E_PROBE_BEARER!);
  }
  async secret(name: string, value: string): Promise<void> {
    await this.intent("worker_secrets");
    await this.cf.request(`/workers/scripts/${this.runName}/secrets`, "PUT", {
      name,
      text: value,
      type: "secret_text",
    });
  }
  async deployRelay(): Promise<void> {
    const values = requireEnv(process.env, ["PGCF_E2E_AGENT_KEY"]);
    if (
      !this.c.credentialExpiries.some(
        (entry) => entry.name === "PGCF_E2E_AGENT_KEY",
      )
    )
      throw new HarnessError("credential_expiry_missing");
    const relayName = `${this.runName}-relay`;
    assertOwned(relayName);
    this.state.chaos = {
      relay_name: relayName,
      policy_name: `${this.runName}-egress`,
      inverse_needed: false,
    };
    await this.intent("relay_create");
    const configPath = resolve(this.stateDir, "chaos-wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: relayName,
        account_id: this.c.values.CLOUDFLARE_ACCOUNT_ID,
        main: fileURLToPath(new URL("../test/chaos-relay.ts", import.meta.url)),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        observability: { enabled: false },
        vars: { API_URL: this.c.apiUrl.href, RUN_NAME: this.runName },
        durable_objects: {
          bindings: [{ name: "RELAY", class_name: "ChaosRelay" }],
        },
        migrations: [{ tag: "initial", new_sqlite_classes: ["ChaosRelay"] }],
      }),
      { mode: 0o600 },
    );
    const wrangler = fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    );
    await command(
      process.execPath,
      [wrangler, "deploy", "--config", configPath],
      {
        cwd: this.stateDir,
        timeoutMs: Math.min(180_000, this.deadline - Date.now()),
        env: {
          ...process.env,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_API_TOKEN: this.c.values.CLOUDFLARE_API_TOKEN!,
          CLOUDFLARE_ACCOUNT_ID: this.c.values.CLOUDFLARE_ACCOUNT_ID!,
        },
      },
    );
    for (const [name, text] of [
      ["PROBE_BEARER", this.c.values.PGCF_E2E_PROBE_BEARER!],
      ["AGENT_KEY", values.PGCF_E2E_AGENT_KEY!],
    ]) {
      await this.intent("relay_secrets");
      await this.cf.request(`/workers/scripts/${relayName}/secrets`, "PUT", {
        name,
        text,
        type: "secret_text",
      });
    }
    await this.relay("/control/capture-empty");
    await this.complete("chaos-empty-captured");
    await this.emit("chaos_start", { real_empty_snapshots: 1 });
  }
  async relayUrl(): Promise<URL> {
    if (!this.state.chaos) throw new HarnessError("chaos_relay_required");
    assertOwned(this.state.chaos.relay_name, `${this.runName}-relay`);
    const subdomain = string(
      record((await this.cf.request("/workers/subdomain")).result).subdomain,
    );
    return new URL(
      `https://${this.state.chaos.relay_name}.${subdomain}.workers.dev`,
    );
  }
  async relay(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const reply = await fetch(new URL(path, await this.relayUrl()), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(30_000, this.deadline - Date.now())),
      headers: {
        Authorization: `Bearer ${this.c.values.PGCF_E2E_PROBE_BEARER}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!reply.ok)
      throw new HarnessError("real_chaos_snapshot_or_relay_unavailable");
    return record(await reply.json());
  }
  async startChaos(): Promise<void> {
    this.requireStep("E1");
    this.requireStep("chaos-empty-captured");
    await this.verify();
    const chaos = this.state.chaos!;
    const name = requireEnv(process.env, [
      "PGCF_E2E_AGENT_DEPLOYMENT_NAME",
    ]).PGCF_E2E_AGENT_DEPLOYMENT_NAME!;
    const namespace = this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!;
    const settings = await this.kube.agentSettings(namespace, name);
    if (
      settings.override &&
      (typeof settings.override.value !== "string" ||
        httpsUrl(settings.override.value).href !== this.c.apiUrl.href)
    )
      throw new HarnessError("agent_original_api_mismatch");
    chaos.agent_name = name;
    chaos.settings = settings;
    const url = await this.relayUrl();
    await this.intent("chaos_policy_create");
    await this.kube.applyPolicy(
      chaosEgressPolicy(
        chaos.policy_name,
        namespace,
        name,
        url.hostname,
        this.runName,
      ),
      chaos.policy_name,
      namespace,
      this.runName,
    );
    // Record the inverse before replacing the real deployment's URL.
    chaos.inverse_needed = true;
    await this.intent("chaos_agent_patch");
    await this.kube.patchAgentUrl(
      namespace,
      name,
      settings.uid,
      settings.container,
      { name: "PGCF_API_URL", value: url.href.replace(/\/$/, "") },
    );
    await poll(
      () => this.relay("/control/counts"),
      (counts) => Number(counts.pulls) > 0 && Number(counts.observations) > 0,
      90_000,
    );
    await this.complete("chaos-started");
    await this.emit("chaos_start", {
      agent_patches: 1,
      exact_fqdn_policies: 1,
    });
  }
  async restoreChaos(): Promise<void> {
    const chaos = this.state.chaos;
    if (!chaos) return;
    const namespace = this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!;
    if (chaos.inverse_needed) {
      if (!chaos.settings || !chaos.agent_name)
        throw new HarnessError("chaos_inverse_missing");
      const current = await this.kube.agentSettings(
        namespace,
        chaos.agent_name,
      );
      const expected = (await this.relayUrl()).href.replace(/\/$/, "");
      const originalRestored =
        current.override === null
          ? chaos.settings.override === null
          : current.override.name === chaos.settings.override?.name &&
            current.override.value === chaos.settings.override?.value;
      if (
        current.uid !== chaos.settings.uid ||
        (!originalRestored && current.override?.value !== expected)
      )
        throw new HarnessError("agent_inverse_conflict");
      if (!originalRestored) {
        await this.intent("chaos_agent_restore");
        await this.kube.patchAgentUrl(
          namespace,
          chaos.agent_name,
          chaos.settings.uid,
          chaos.settings.container,
          chaos.settings.override,
        );
      }
      chaos.inverse_needed = false;
      await this.save();
      await poll(
        () => this.kube.read("deployments"),
        (value) =>
          items(value).some(
            (deployment) =>
              objectName(deployment) === chaos.agent_name &&
              record(deployment.metadata).namespace === namespace &&
              record(deployment.status).observedGeneration ===
                record(deployment.metadata).generation &&
              Number(record(deployment.status).availableReplicas) ===
                Number(record(deployment.spec).replicas),
          ),
        60_000,
      );
    }
    await this.intent("chaos_policy_delete");
    await this.kube.deletePolicy(chaos.policy_name, namespace, this.runName);
  }
  async checkChaos(): Promise<void> {
    this.requireStep("chaos-started");
    const chaos = this.state.chaos!;
    const namespace = `pgcf-db-${this.state.database_id}`;
    const before = items(await this.kube.read("namespaces")).find(
      (ns) => objectName(ns) === namespace,
    );
    if (!before) throw new HarnessError("run_namespace_missing");
    const uid = string(record(before.metadata).uid);
    const assertPreserved = async () => {
      const resource = items(await this.kube.read("namespaces")).find(
        (ns) => objectName(ns) === namespace,
      );
      if (
        !resource ||
        record(resource.metadata).uid !== uid ||
        record(resource.metadata).deletionTimestamp
      )
        throw new HarnessError("chaos_deleted_database");
      const database = Database.parse(
        await this.api.request(`/v1/databases/${this.state.database_id}`),
      );
      if (
        database.desired_state !== "running" ||
        database.observed_state === "deleted" ||
        database.observed_generation < database.generation
      )
        throw new HarnessError("chaos_generation_regressed");
    };
    try {
      const baseline = Database.parse(
        await this.api.request(`/v1/databases/${this.state.database_id}`),
      );
      for (const mode of ["empty", "failure"] as const) {
        const counts = await this.relay("/control/counts");
        await this.relay("/control/mode", { mode });
        await this.kube.restartAgent(
          this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
          chaos.agent_name!,
        );
        await poll(
          () => this.relay("/control/counts"),
          (value) => Number(value.pulls) > Number(counts.pulls),
          60_000,
        );
        await assertPreserved();
        await this.relay("/control/mode", { mode: "pass" });
      }
      await this.relay("/control/capture-older", {
        database_id: this.state.database_id,
      });
      await this.intent("chaos_real_password_rotation");
      await this.api.request(
        `/v1/databases/${this.state.database_id}/roles/app/reset-password`,
        "POST",
        undefined,
        `${this.state.run_id}-chaos-rotate`,
      );
      await this.relay("/control/capture-fresh");
      await poll(
        async () =>
          Database.parse(
            await this.api.request(`/v1/databases/${this.state.database_id}`),
          ),
        (database) =>
          database.generation > baseline.generation &&
          database.observed_generation === database.generation &&
          database.observed_state === "ready",
        90_000,
      );
      for (const mode of ["older", "out_of_order"] as const) {
        const counts = await this.relay("/control/counts");
        await this.relay("/control/mode", { mode });
        await this.kube.restartAgent(
          this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
          chaos.agent_name!,
        );
        await poll(
          () => this.relay("/control/counts"),
          (value) =>
            Number(value.pulls) >=
            Number(counts.pulls) + (mode === "out_of_order" ? 2 : 1),
          mode === "out_of_order" ? 135_000 : 60_000,
        );
        await assertPreserved();
        await this.relay("/control/mode", { mode: "pass" });
      }
      const counts = await this.relay("/control/counts");
      if (
        Number(counts.regressed_generations) !== 0 ||
        Number(counts.replayed) < 4 ||
        Number(counts.transport_failures) < 1
      )
        throw new HarnessError("chaos_evidence_incomplete");
      await this.complete("chaos-checked");
      await this.emit("chaos_check", counts as Record<string, number>);
    } finally {
      await this.restoreChaos();
    }
  }
  async probe(path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!this.probeHost) {
      const subdomain = string(
        record((await this.cf.request("/workers/subdomain")).result).subdomain,
      );
      this.probeHost = `${this.runName}.${subdomain}.workers.dev`;
    }
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new HarnessError("step_time_budget_exhausted");
    const reply = await fetch(`https://${this.probeHost}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(60_000, remaining)),
      headers: {
        Authorization: `Bearer ${this.c.values.PGCF_E2E_PROBE_BEARER}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!reply.ok) {
      const result = record(await reply.json());
      if (result.code === "worker_scan_unavailable")
        throw new HarnessError("supplemental_external_tcp_probe_required");
      throw new HarnessError("probe_request_failed");
    }
    return record(await reply.json());
  }
  async create(restartAgent = false): Promise<void> {
    this.requireStep("E0");
    await this.verify();
    const started = Date.now();
    if (this.state.intents.includes("integrator_key_create"))
      throw new HarnessError("one_time_key_resume_requires_cleanup");
    await this.deployProbe();
    await this.intent("project_create");
    const project = Project.parse(
      await this.api.request(
        "/v1/projects",
        "POST",
        { name: this.runName, external_id: this.runName },
        `${this.state.run_id}-project`,
      ),
    );
    assertOwned(project.name, this.runName);
    this.state.project_id = project.id;
    await this.save();
    await this.intent("integrator_key_create");
    const key = ApiKeyCreated.parse(
      await this.api.request(
        "/v1/api-keys",
        "POST",
        { name: this.runName, scope: "integrator", project_id: project.id },
        `${this.state.run_id}-key`,
      ),
    );
    if (
      key.api_key.project_id !== project.id ||
      key.api_key.scope !== "integrator"
    )
      throw new HarnessError("key_ownership_mismatch");
    this.state.key_id = key.api_key.id;
    await this.save();
    await this.secret("INTEGRATOR_KEY", key.key);
    await this.intent("database_create");
    const body = {
      project_id: project.id,
      name: this.runName,
      region_id: this.c.values.PGCF_E2E_REGION_ID,
      size_class_id: "small",
    };
    const databaseStarted = Date.now();
    const created = DatabaseWithOperation.parse(
      await this.api.request(
        "/v1/databases",
        "POST",
        body,
        `${this.state.run_id}-database`,
      ),
    );
    assertOwned(created.database.name, this.runName);
    if (created.database.project_id !== project.id)
      throw new HarnessError("database_ownership_mismatch");
    this.state.database_id = created.database.id;
    this.state.operation_id = created.operation.id;
    await this.save();
    if (restartAgent) await this.restartAgent("create");
    const replay = DatabaseWithOperation.parse(
      await this.api.request(
        "/v1/databases",
        "POST",
        body,
        `${this.state.run_id}-database`,
      ),
    );
    if (
      replay.database.id !== created.database.id ||
      replay.operation.id !== created.operation.id
    )
      throw new HarnessError("idempotency_duplicated_resource");
    await this.secret("DATABASE_ID", created.database.id);
    await poll(
      async () => {
        const operation = Operation.parse(
          await this.api.request(`/v1/operations/${created.operation.id}`),
        );
        if (operation.status === "failed")
          throw new HarnessError("database_operation_failed");
        return operation;
      },
      (operation) => operation.status === "succeeded",
      240_000,
    );
    const readyMs = Date.now() - databaseStarted;
    const database = Database.parse(
      await this.api.request(`/v1/databases/${created.database.id}`),
    );
    if (
      database.observed_state !== "ready" ||
      database.health.archiving !== "ok" ||
      database.observed_generation !== database.generation
    )
      throw new HarnessError("database_not_ready");
    this.state.allocated = await poll(
      () => this.sample(),
      (samples) =>
        samples.some((sample) =>
          this.state.baseline.some(
            (base) =>
              sample.node === base.node &&
              sample.free_bytes < base.free_bytes &&
              sample.resource_version !== base.resource_version,
          ),
        ),
      60_000,
    );
    await this.captureStorage();
    await this.complete("E1");
    await this.emit(
      "E1",
      { databases: 1 },
      { ready_ms: readyMs, e1_ms: Date.now() - started },
    );
  }
  async metadata(): Promise<void> {
    this.requireStep("E1");
    const id = this.state.database_id!;
    const admin = ConnectionUri.parse(
      await this.api.request(`/v1/databases/${id}/roles/app/connection-uri`),
    );
    const uri = new URL(admin.uri);
    if (
      admin.includes_password ||
      uri.password ||
      admin.role !== "app" ||
      decodeURIComponent(uri.username) !== "app" ||
      admin.host !== this.c.values.PGCF_E2E_ENDPOINT_HOST ||
      uri.hostname !== admin.host ||
      admin.database !== id ||
      decodeURIComponent(uri.pathname.slice(1)) !== id
    )
      throw new HarnessError("admin_uri_invalid");
    const result = await this.probe("/metadata");
    if (
      result.includes_password !== true ||
      result.host_matches !== true ||
      result.database_matches !== true
    )
      throw new HarnessError("integrator_uri_invalid");
    await this.complete("E2");
    await this.emit("E2", { checked_scopes: 2 });
  }
  async exercise(): Promise<void> {
    this.requireStep("E2");
    const result = await this.probe("/exercise");
    if (result.pass !== true) throw new HarnessError("probe_failed");
    await this.complete("E3");
    await this.emit(
      "E3",
      { transactions: 2, negative_cases: 3 },
      record(result.timings) as Record<string, number>,
    );
  }
  async audit(): Promise<void> {
    this.requireStep("E3");
    await this.verify();
    const edgeName = requireEnv(process.env, [
      "PGCF_E2E_EDGE_WORKER_NAME",
    ]).PGCF_E2E_EDGE_WORKER_NAME!;
    assertOwned(edgeName);
    if (!/(?:-dev|-test)$/.test(edgeName))
      throw new HarnessError("dev_worker_required");
    const domains = await this.cf.list("/workers/domains");
    if (
      !domains.some(
        (domain) =>
          domain.hostname === this.c.values.PGCF_E2E_ENDPOINT_HOST &&
          domain.service === edgeName,
      )
    )
      throw new HarnessError("edge_worker_identity_mismatch");
    const settings = record(
      (
        await this.cf.request(
          `/workers/scripts/${this.c.values.PGCF_E2E_API_WORKER_NAME}/settings`,
        )
      ).result,
    );
    if (!Array.isArray(settings.bindings))
      throw new HarnessError("d1_binding_missing");
    const binding = settings.bindings
      .map(record)
      .find((row) => row.type === "d1" && row.name === "DB");
    if (!binding) throw new HarnessError("d1_binding_missing");
    const d1Id = string(binding.id);
    const d1Metadata = record(
      (await this.cf.request(`/d1/database/${encodeURIComponent(d1Id)}`))
        .result,
    );
    assertOwned(string(d1Metadata.name));
    const d1 = (
      await this.cf.request(
        `/d1/database/${encodeURIComponent(d1Id)}/query`,
        "POST",
        {
          sql: "SELECT database_id, name, password_ciphertext, password_iv, password_kid FROM roles WHERE database_id = ?",
          params: [this.state.database_id],
        },
      )
    ).result;
    if (
      !Array.isArray(d1) ||
      !d1.length ||
      !Array.isArray(record(d1[0]).results) ||
      (record(d1[0]).results as unknown[]).length < 1
    )
      throw new HarnessError("d1_roles_missing");
    const passwords = await this.kube.rolePasswords(
      `pgcf-db-${this.state.database_id}`,
    );
    const tails: string[] = [];
    for (const worker of [this.c.values.PGCF_E2E_API_WORKER_NAME!, edgeName]) {
      await this.intent("tail_create");
      const messages = await captureTrace(
        this.cf,
        worker,
        () =>
          worker === edgeName
            ? this.probe("/exercise")
            : this.api.request(
                `/v1/databases/${this.state.database_id}/roles/app/connection-uri`,
              ),
        async (id) => {
          this.state.tails.push({ worker, id });
          await this.save();
        },
      );
      tails.push(
        ...messages.map((message) =>
          redactKnownCredentials(message, [
            this.c.values.CLOUDFLARE_API_TOKEN!,
            this.c.values.PGCF_E2E_ADMIN_KEY!,
            this.c.values.PGCF_E2E_PROBE_BEARER!,
            process.env.PGCF_E2E_AGENT_KEY ?? "",
          ]),
        ),
      );
    }
    const result = await this.probe("/canary-audit", {
      d1: JSON.stringify(d1),
      passwords,
      tails,
    });
    if (result.pass !== true) throw new HarnessError("canary_plaintext_leak");
    await this.complete("canary-audit");
    await this.emit("canary_audit", {
      ...(record(result.counts) as Record<string, number>),
      trace_events: tails.length,
    });
  }
  async restartAgent(stage: "create" | "delete"): Promise<void> {
    const name = requireEnv(process.env, [
      "PGCF_E2E_AGENT_DEPLOYMENT_NAME",
    ]).PGCF_E2E_AGENT_DEPLOYMENT_NAME!;
    assertOwned(name);
    const database = Database.parse(
      await this.api.request(`/v1/databases/${this.state.database_id}`),
    );
    if (
      (stage === "create" && database.observed_state === "ready") ||
      (stage === "delete" && database.observed_state === "deleted")
    )
      throw new HarnessError("restart_window_missed");
    await this.intent(`agent_restart_${stage}`);
    await this.kube.restartAgent(
      this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
      name,
    );
    await this.complete(`agent-restarted-${stage}`);
  }
  async backups(): Promise<void> {
    this.requireStep("E3");
    const classes = (await this.api.list("/v1/size-classes")).map((row) =>
      SizeClass.parse(row),
    );
    const small = classes.find((s) => s.id === "small")!;
    const timeout = (small.archive_timeout_seconds + 60) * 1000;
    if (timeout > 540_000)
      throw new HarnessError("archive_timeout_requires_stepwise_poll");
    const started = Date.now();
    const counts = await poll(
      async () => {
        const summary = record(
          await this.api.request(
            `/v1/databases/${this.state.database_id}/archive`,
          ),
        );
        const objects = await this.cf.objects(
          this.c.values.PGCF_E2E_BACKUP_BUCKET!,
          `${this.c.values.PGCF_E2E_REGION_ID}/${this.state.database_id}/`,
          this.c.jurisdiction,
        );
        return liveArchiveCounts(summary, this.state.database_id!, objects);
      },
      (counts) =>
        counts.base_backup_count! >= 1 &&
        counts.wal_count! >= 1 &&
        counts.api_base_backup_count! >= 1 &&
        counts.api_wal_count! >= 1,
      timeout,
    );
    await this.complete("E4");
    await this.emit("E4", counts, { archive_wait_ms: Date.now() - started });
  }
  async captureStorage(): Promise<void> {
    if (!this.state.database_id) return;
    const namespace = `pgcf-db-${this.state.database_id}`;
    assertOwned(namespace);
    const [pvs, lvms] = await Promise.all([
      this.kube.read("persistentvolumes"),
      this.kube.read("lvmvolumes.local.openebs.io"),
    ]);
    for (const pv of items(pvs)) {
      const spec = record(pv.spec),
        claim = spec.claimRef ? record(spec.claimRef) : {};
      if (claim.namespace !== namespace) continue;
      const csi = record(spec.csi);
      if (csi.driver !== "local.csi.openebs.io")
        throw new HarnessError("unexpected_volume_driver");
      const pvName = objectName(pv),
        handle = string(csi.volumeHandle);
      if (!this.state.pvs.includes(pvName)) this.state.pvs.push(pvName);
      const matches = items(lvms).filter((lvm) => objectName(lvm) === handle);
      for (const lvm of matches) {
        const key = `${objectNamespace(lvm)}/${objectName(lvm)}`;
        if (!this.state.lvm_volumes.includes(key))
          this.state.lvm_volumes.push(key);
      }
      // Remember the expected handle even if the CSI deletion raced with capture.
      if (!matches.length && !this.state.lvm_volumes.includes(`*/${handle}`))
        this.state.lvm_volumes.push(`*/${handle}`);
    }
    await this.save();
  }
  async assertStorageGone(): Promise<boolean> {
    const namespace = `pgcf-db-${this.state.database_id}`;
    const [namespaces, pvcs, pvs, lvms, samples] = await Promise.all([
      this.kube.read("namespaces"),
      this.kube.read("persistentvolumeclaims"),
      this.kube.read("persistentvolumes"),
      this.kube.read("lvmvolumes.local.openebs.io"),
      this.sample(),
    ]);
    const storageRemains =
      items(namespaces).some((ns) => objectName(ns) === namespace) ||
      items(pvcs).some((pvc) => objectNamespace(pvc) === namespace) ||
      items(pvs).some(
        (pv) =>
          this.state.pvs.includes(objectName(pv)) ||
          (record(pv.spec).claimRef &&
            record(record(pv.spec).claimRef).namespace === namespace),
      ) ||
      items(lvms).some((lvm) =>
        this.state.lvm_volumes.some(
          (name) =>
            name === `${objectNamespace(lvm)}/${objectName(lvm)}` ||
            name === `*/${objectName(lvm)}`,
        ),
      );
    const freeRestored =
      samples.every((sample) =>
        this.state.baseline.some(
          (base) =>
            base.node === sample.node && base.free_bytes === sample.free_bytes,
        ),
      ) &&
      this.state.allocated
        .filter((allocated) =>
          this.state.baseline.some(
            (base) =>
              allocated.node === base.node &&
              allocated.free_bytes < base.free_bytes,
          ),
        )
        .every((allocated) =>
          samples.some(
            (sample) =>
              sample.node === allocated.node &&
              sample.resource_version !== allocated.resource_version,
          ),
        );
    return !storageRemains && freeRestored;
  }
  async deleteDatabase(restartAgent = false): Promise<void> {
    if (!this.state.database_id) return;
    const database = Database.parse(
      await this.api.request(`/v1/databases/${this.state.database_id}`),
    );
    assertOwned(database.name, this.runName);
    if (database.project_id !== this.state.project_id)
      throw new HarnessError("database_ownership_mismatch");
    await this.captureStorage();
    if (database.observed_state !== "deleted") {
      await this.intent("database_delete");
      await this.api.request(
        `/v1/databases/${database.id}`,
        "DELETE",
        undefined,
        `${this.state.run_id}-delete`,
      );
      if (restartAgent) await this.restartAgent("delete");
      await poll(
        async () =>
          Database.parse(
            await this.api.request(`/v1/databases/${database.id}`),
          ),
        (db) =>
          db.desired_state === "deleted" && db.observed_state === "deleted",
        180_000,
      );
    }
    await poll(
      () => this.assertStorageGone(),
      (gone) => gone,
      120_000,
    );
    await this.intent("archive_cleanup");
    await this.cf.deleteObjects(
      this.c.values.PGCF_E2E_BACKUP_BUCKET!,
      `${this.c.values.PGCF_E2E_REGION_ID}/${database.id}/`,
      this.c.jurisdiction,
    );
  }
  async deletion(restartAgent = false): Promise<void> {
    this.requireStep("E4");
    await this.verify();
    const started = Date.now();
    await this.deleteDatabase(restartAgent);
    const refusal = await this.probe("/refusal");
    if (refusal.pass !== true)
      throw new HarnessError("deleted_database_accepted");
    await this.complete("E5");
    await this.emit(
      "E5",
      { remaining_volumes: 0, archive_objects: 0 },
      { delete_ms: Date.now() - started },
    );
  }
  async scan(addressIndex?: number): Promise<boolean> {
    this.requireStep("E5");
    const [nodeList, pods, deployments, daemonsets, statefulsets, services] =
      await Promise.all([
        this.kube.read("nodes"),
        this.kube.read("pods"),
        this.kube.read("deployments"),
        this.kube.read("daemonsets"),
        this.kube.read("statefulsets"),
        this.kube.read("services"),
      ]);
    const counts = networkingAudit(
      [pods, deployments, daemonsets, statefulsets],
      services,
      this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
    );
    const addresses = nodeAddresses(nodeList);
    const started = Date.now();
    if (
      addressIndex !== undefined &&
      (!Number.isInteger(addressIndex) ||
        addressIndex < 0 ||
        addressIndex >= addresses.length)
    )
      throw new HarnessError("invalid_address_index");
    for (let index = 0; index < addresses.length; index++) {
      const address = addresses[index]!;
      const scanId = fingerprint(`${address.node}:${address.host}`);
      if (
        this.state.scans.includes(scanId) ||
        (addressIndex !== undefined && addressIndex !== index)
      )
        continue;
      const ports = Array.from({ length: 65535 }, (_, i) => i + 1);
      if (!this.state.operator_scans.includes(scanId)) {
        const operator = await scanPorts(address.host, ports, {
          timeoutMs: 400,
          concurrency: 256,
          signal: AbortSignal.timeout(
            Math.min(180_000, this.deadline - Date.now()),
          ),
        });
        if (operator.checked !== 65535)
          throw new HarnessError("scan_incomplete");
        assertOpenSubset(operator.open, [50000, 6443]);
        this.state.operator_scans.push(scanId);
        await this.save();
      }
      const ranges = this.state.scan_ranges[scanId] ?? [];
      const first = Math.max(1, ...ranges.map((range) => range[1] + 1));
      const last = Math.min(first + 4095, 65535);
      const segment = ports.slice(first - 1, last);
      for (let offset = 0; offset < segment.length; offset += 256) {
        const batch = segment.slice(offset, offset + 256);
        const result = await this.probe("/scan", {
          host: address.host,
          ports: batch,
        });
        if (
          !Array.isArray(result.open) ||
          result.open.some((p) => typeof p !== "number") ||
          result.checked !== batch.length
        )
          throw new HarnessError("invalid_scan_result");
        assertOpenSubset(result.open as number[], []);
      }
      ranges.push([first, last]);
      this.state.scan_ranges[scanId] = ranges;
      if (last === 65535) this.state.scans.push(scanId);
      await this.save();
      break;
    }
    const complete = addresses.every((a) =>
      this.state.scans.includes(fingerprint(`${a.node}:${a.host}`)),
    );
    if (complete) await this.complete("E6");
    await this.emit(
      "E6",
      {
        ...counts,
        addresses: addresses.length,
        completed_addresses: this.state.scans.length,
        ports_per_address: 65535,
      },
      { scan_ms: Date.now() - started },
      complete,
    );
    return complete;
  }
  async archiveFailure(mode: "start" | "check"): Promise<void> {
    this.requireStep("E1");
    const database = Database.parse(
      await this.api.request(`/v1/databases/${this.state.database_id}`),
    );
    if (mode === "start") {
      // The live operator induces the outage; this step persists observation timing only.
      if (database.health.archiving === "ok")
        throw new HarnessError("archive_outage_not_observed");
      this.state.archive_failure_started_at = new Date().toISOString();
      await this.save();
      await this.emit("archive_failure_start", { observations: 1 });
    } else {
      if (
        !this.state.archive_failure_started_at ||
        Date.now() - Date.parse(this.state.archive_failure_started_at) < 600_000
      )
        throw new HarnessError("archive_failure_wait_pending");
      if (database.health.archiving !== "failing")
        throw new HarnessError("archive_failure_not_reported");
      await this.emit(
        "archive_failure_check",
        { failing_health_observations: 1 },
        {
          elapsed_ms:
            Date.now() - Date.parse(this.state.archive_failure_started_at),
        },
      );
    }
  }
  async recoverOwnership(): Promise<void> {
    const projects = await this.api.list("/v1/projects");
    const owned = projects.filter(
      (p) => p.name === this.runName && p.external_id === this.runName,
    );
    if (owned.length > 1) throw new HarnessError("ambiguous_run_ownership");
    if (owned[0]) {
      const id = string(owned[0].id);
      if (this.state.project_id && id !== this.state.project_id)
        throw new HarnessError("run_ownership_mismatch");
      this.state.project_id = id;
    }
    if (this.state.project_id) {
      const databases = (
        await this.api.list(`/v1/databases?project_id=${this.state.project_id}`)
      ).filter(
        (d) =>
          d.project_id === this.state.project_id && d.name === this.runName,
      );
      if (databases.length > 1)
        throw new HarnessError("ambiguous_run_ownership");
      if (databases[0]) this.state.database_id = string(databases[0].id);
    }
    await this.save();
  }
  async cleanup(): Promise<void> {
    this.deadline = Date.now() + 120_000;
    await this.verifyIdentity();
    await this.recoverOwnership();
    const failures: string[] = [];
    // The real agent must use the real API before any database deletion is requested.
    try {
      await this.restoreChaos();
    } catch {
      await this.emit("cleanup", { failure_count: 1 }, {}, false);
      throw new HarnessError("chaos_inverse_required");
    }
    for (const tail of this.state.tails) {
      try {
        assertOwned(tail.worker);
        const existing = await this.cf.list(
          `/workers/scripts/${tail.worker}/tails`,
        );
        if (existing.some((row) => row.id === tail.id)) {
          await this.intent("tail_delete");
          await this.cf.request(
            `/workers/scripts/${tail.worker}/tails/${encodeURIComponent(tail.id)}`,
            "DELETE",
          );
        }
      } catch {
        failures.push("tail");
      }
    }
    try {
      await this.deleteDatabase();
    } catch {
      failures.push("database");
    }
    try {
      const keys = (await this.api.list("/v1/api-keys")).filter(
        (key) =>
          key.name === this.runName &&
          key.project_id === this.state.project_id &&
          key.revoked_at === null,
      );
      for (const key of keys) {
        assertOwned(string(key.name), this.runName);
        await this.intent("key_revoke");
        await this.api.request(
          `/v1/api-keys/${string(key.id)}`,
          "DELETE",
          undefined,
          `${this.state.run_id}-revoke-${string(key.id)}`,
        );
      }
    } catch {
      failures.push("key");
    }
    if (!failures.includes("database") && this.state.project_id) {
      try {
        const project = Project.parse(
          await this.api.request(`/v1/projects/${this.state.project_id}`),
        );
        assertOwned(project.name, this.runName);
        if (project.external_id !== this.runName)
          throw new HarnessError("project_ownership_mismatch");
        await this.intent("project_delete");
        await this.api.request(
          `/v1/projects/${this.state.project_id}`,
          "DELETE",
          undefined,
          `${this.state.run_id}-project-delete`,
        );
      } catch {
        failures.push("project");
      }
    }
    try {
      const workers = await this.cf.list("/workers/scripts");
      if (
        this.state.chaos &&
        workers.some((worker) => worker.id === this.state.chaos!.relay_name)
      ) {
        assertOwned(this.state.chaos.relay_name, `${this.runName}-relay`);
        await this.intent("relay_delete");
        await this.cf.request(
          `/workers/scripts/${this.state.chaos.relay_name}`,
          "DELETE",
        );
      }
      if (workers.some((worker) => worker.id === this.runName)) {
        await this.intent("worker_delete");
        await this.cf.request(`/workers/scripts/${this.runName}`, "DELETE");
      }
    } catch {
      failures.push("worker");
    }
    await this.emit(
      "cleanup",
      { failure_count: failures.length },
      {},
      failures.length === 0,
    );
    if (failures.length) throw new HarnessError("cleanup_incomplete");
    await this.complete("cleanup");
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dryRun = args.includes("--dry-run"),
    cleanupOnly = args.includes("--cleanup-only");
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const step = value("--step") ?? "E0",
    runId =
      value("--run-id") ??
      `${new Date()
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, 14)}-${randomBytes(4).toString("hex").slice(0, 6)}`;
  assertRunId(runId);
  if (cleanupOnly && !value("--run-id"))
    throw new HarnessError("cleanup_run_id_required");
  if (dryRun && cleanupOnly) throw new HarnessError("conflicting_arguments");
  const known = new Set([
    "--dry-run",
    "--cleanup-only",
    "--run-id",
    "--step",
    "--scan-address-index",
    "--restart-agent",
    "--chaos",
    "--restart-summary",
    "--run-ids",
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!known.has(flag)) throw new HarnessError("invalid_arguments");
    if (
      ["--run-id", "--step", "--scan-address-index", "--run-ids"].includes(flag)
    ) {
      if (!args[++i] || args[i]!.startsWith("--"))
        throw new HarnessError("invalid_arguments");
    }
  }
  if (
    step &&
    ![
      "E0",
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "archive-failure-start",
      "archive-failure-check",
      "canary-audit",
      "chaos-start",
      "chaos-check",
    ].includes(step)
  )
    throw new HarnessError("invalid_step");
  const c = config(env);
  const root = (await command("git", ["rev-parse", "--show-toplevel"])).trim();
  if (args.includes("--restart-summary")) {
    if (
      dryRun ||
      cleanupOnly ||
      args.includes("--chaos") ||
      args.includes("--restart-agent")
    )
      throw new HarnessError("conflicting_arguments");
    const ids = (value("--run-ids") ?? "").split(",");
    ids.forEach(assertRunId);
    const ledgers = await Promise.all(
      ids.map(
        async (id) =>
          JSON.parse(
            await readFile(
              resolve(root, ".local", "state", "e2e", id, "ledger.json"),
              "utf8",
            ),
          ) as unknown,
      ),
    );
    console.log(
      JSON.stringify(
        evidence({
          event: "restart_summary",
          pass: true,
          counts: restartSummary(ledgers, runIdentity(c)),
        }),
      ),
    );
    return;
  }
  const path = resolve(root, ".local", "state", "e2e", runId, "ledger.json");
  let state: Ledger;
  try {
    state = JSON.parse(await readFile(path, "utf8")) as Ledger;
    if (
      state.version !== 1 ||
      state.run_id !== runId ||
      !Array.isArray(state.intents) ||
      !Array.isArray(state.completed) ||
      !Array.isArray(state.baseline) ||
      !Array.isArray(state.allocated) ||
      !Array.isArray(state.pvs) ||
      !Array.isArray(state.lvm_volumes) ||
      !Array.isArray(state.scans) ||
      !Array.isArray(state.operator_scans) ||
      !state.scan_ranges ||
      !Array.isArray(state.tails)
    )
      throw new HarnessError("invalid_run_ledger");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new HarnessError("invalid_run_ledger");
    if (cleanupOnly || step !== "E0")
      throw new HarnessError("run_ledger_required");
    state = {
      version: 1,
      run_id: runId,
      identity: runIdentity(c),
      worker_name: `pgcf-e2e-${runId}`,
      created_at: new Date().toISOString(),
      intents: [],
      completed: [],
      baseline: [],
      allocated: [],
      pvs: [],
      lvm_volumes: [],
      scans: [],
      operator_scans: [],
      scan_ranges: {},
      tails: [],
    };
  }
  const run = new Run(c, state, root, dryRun);
  if (!dryRun && !cleanupOnly && step === "E0" && state.intents.length)
    throw new HarnessError("mutated_run_requires_resume_or_cleanup");
  if (dryRun) {
    await run.preflight();
    return;
  }
  if (cleanupOnly) {
    await run.cleanup();
    return;
  }
  if (state.completed.includes("cleanup"))
    throw new HarnessError("run_already_cleaned");
  const addressIndex = value("--scan-address-index");
  let preserve = false;
  try {
    if (!step || step === "E0") {
      await run.preflight();
      if (args.includes("--chaos")) await run.deployRelay();
    }
    if (!step || step === "E1")
      await run.create(args.includes("--restart-agent"));
    if (!step || step === "E2") await run.metadata();
    if (!step || step === "E3") await run.exercise();
    if (!step || step === "E4") await run.backups();
    if (!step || step === "E5")
      await run.deletion(args.includes("--restart-agent"));
    if (step === "canary-audit") await run.audit();
    if (step === "chaos-start") await run.startChaos();
    if (step === "chaos-check") await run.checkChaos();
    if (!step || step === "E6") {
      if (
        !(await run.scan(
          addressIndex === undefined ? undefined : Number(addressIndex),
        ))
      )
        preserve = true;
    }
    if (step === "archive-failure-start" || step === "archive-failure-check")
      await run.archiveFailure(step.endsWith("start") ? "start" : "check");
    preserve ||= !!step && step !== "E6";
  } catch (error) {
    if (
      error instanceof HarnessError &&
      error.code === "archive_failure_wait_pending"
    )
      preserve = true;
    throw error;
  } finally {
    if (!preserve && state.intents.length) await run.cleanup();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        code: error instanceof HarnessError ? error.code : "acceptance_failed",
        ...(error instanceof HarnessError &&
        error.code === "missing_environment"
          ? { names: error.names }
          : {}),
      }),
    );
    process.exitCode = 1;
  });
}
