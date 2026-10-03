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
import {
  assertClusterIdentity,
  inverseReady,
  parseUidMap,
} from "./identity.ts";
import type { ClusterIdentity } from "./identity.ts";
import { runActive } from "./run-expiry.ts";
import { faultCycleReady, preservedDatabase } from "./cycles.ts";
import type { DatabaseProof } from "./cycles.ts";
import { consumeExternalProbe } from "./external-probe.ts";

const PROBE_ERROR_CODES = new Set([
  "run_expired",
  "unauthorized",
  "method_not_allowed",
  "invalid_trace_marker",
  "not_found",
  "worker_scan_unavailable",
  "probe_failed",
]);

function failureCode(error: unknown): string {
  return error instanceof HarnessError &&
    /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "acceptance_failed";
}

class ProbeFailure extends HarnessError {
  readonly httpStatus: number;
  readonly probeCode: string;
  constructor(code: string, httpStatus: number, probeCode = "unknown") {
    super(code);
    this.httpStatus = httpStatus;
    this.probeCode = probeCode;
  }
}

interface CleanupReason {
  stage: "tail" | "database" | "key" | "project" | "worker" | "chaos_inverse";
  code: string;
}

class CleanupFailure extends HarnessError {
  readonly failures: readonly CleanupReason[];
  constructor(failures: readonly CleanupReason[], code = "cleanup_incomplete") {
    super(code);
    this.failures = failures;
  }
}

class AcceptanceFailure extends HarnessError {
  readonly stage: string;
  readonly original: unknown;
  readonly cleanup: unknown;
  constructor(stage: string, original: unknown, cleanup?: unknown) {
    super(failureCode(original));
    this.stage = stage;
    this.original = original;
    this.cleanup = cleanup;
  }
}

export function acceptanceDiagnostic(error: unknown): Record<string, unknown> {
  const failure = error instanceof AcceptanceFailure ? error : undefined;
  const original = failure ? failure.original : error;
  return {
    code: failureCode(error),
    ...(failure ? { stage: failure.stage } : {}),
    ...(original instanceof ProbeFailure
      ? { http_status: original.httpStatus, probe_code: original.probeCode }
      : {}),
    ...(original instanceof HarnessError &&
    original.code === "missing_environment"
      ? { names: original.names }
      : {}),
    ...(failure?.cleanup !== undefined
      ? {
          cleanup: {
            code: failureCode(failure.cleanup),
            failure_count:
              failure.cleanup instanceof CleanupFailure
                ? failure.cleanup.failures.length
                : 1,
            ...(failure.cleanup instanceof CleanupFailure
              ? { failures: failure.cleanup.failures.slice(0, 16) }
              : {}),
          },
        }
      : {}),
    ...(error instanceof CleanupFailure
      ? {
          failure_count: error.failures.length,
          failures: error.failures.slice(0, 16),
        }
      : {}),
  };
}

async function probeErrorCode(reply: Response): Promise<string> {
  const reader = reply.body?.getReader();
  if (!reader) return "unknown";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) return "unknown";
      chunks.push(value);
    }
    const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return typeof parsed.code === "string" && PROBE_ERROR_CODES.has(parsed.code)
      ? parsed.code
      : "unknown";
  } catch {
    return "unknown";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const REQUIRED_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PGCF_E2E_EXPECTED_ACCOUNT_NAME",
  "PGCF_E2E_API_URL",
  "PGCF_E2E_API_WORKER_NAME",
  "PGCF_E2E_EDGE_WORKER_NAME",
  "PGCF_E2E_CONNECTION_RATE_LIMIT_NAMESPACE_ID",
  "PGCF_E2E_DATABASE_RATE_LIMIT_NAMESPACE_ID",
  "PGCF_E2E_ADMIN_KEY",
  "PGCF_E2E_ENDPOINT_HOST",
  "PGCF_E2E_REGION_ID",
  "PGCF_E2E_BACKUP_BUCKET",
  "PGCF_E2E_BACKUP_JURISDICTION",
  "PGCF_E2E_KUBECONFIG",
  "PGCF_E2E_KUBE_CONTEXT",
  "PGCF_E2E_NODE_NAMES",
  "PGCF_E2E_REGIONAL_NAMESPACE",
  "PGCF_E2E_AGENT_DEPLOYMENT_NAME",
  "PGCF_E2E_EXPECTED_CLUSTER_UID",
  "PGCF_E2E_EXPECTED_REGIONAL_NAMESPACE_UID",
  "PGCF_E2E_EXPECTED_AGENT_DEPLOYMENT_UID",
  "PGCF_E2E_EXPECTED_NODE_UIDS",
  "PGCF_E2E_GHCR_IMAGE",
  "PGCF_E2E_PROBE_BEARER",
  "PGCF_E2E_CREDENTIAL_EXPIRIES",
] as const;

export type CredentialExpiry =
  | { name: string; expires_at: string; expiry_source?: never }
  // Null explicitly confirms that the v1 API/agent key has no expiry; it is not unknown.
  | {
      name: "PGCF_E2E_ADMIN_KEY" | "PGCF_E2E_AGENT_KEY";
      expires_at: null;
      expiry_source?: never;
    }
  // The probe secret's effective expiry is the deployed Worker's RUN_EXPIRES_AT.
  | {
      name: "PGCF_E2E_PROBE_BEARER";
      expiry_source: "run";
      expires_at?: never;
    };

export function parseCredentialExpiries(
  input: unknown,
  now = Date.now(),
): CredentialExpiry[] {
  if (!Array.isArray(input) || !Number.isFinite(now))
    throw new HarnessError("invalid_config");
  const names = new Set<string>();
  const entries = input.map((value: unknown): CredentialExpiry => {
    const row = record(value);
    const name = string(row.name);
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
      Object.keys(row).some(
        (key) => !["name", "expires_at", "expiry_source"].includes(key),
      )
    )
      throw new HarnessError("credential_expiry_invalid");
    if (names.has(name)) throw new HarnessError("credential_expiry_duplicate");
    names.add(name);
    if (row.expiry_source === "run") {
      if (name !== "PGCF_E2E_PROBE_BEARER" || "expires_at" in row)
        throw new HarnessError("credential_expiry_invalid");
      return { name, expiry_source: "run" };
    }
    if ("expiry_source" in row)
      throw new HarnessError("credential_expiry_invalid");
    if (row.expires_at === null) {
      if (name !== "PGCF_E2E_ADMIN_KEY" && name !== "PGCF_E2E_AGENT_KEY")
        throw new HarnessError("credential_expiry_invalid");
      return { name, expires_at: null };
    }
    const expires_at = string(row.expires_at);
    const iso =
      /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
        expires_at,
      );
    const expiry = Date.parse(expires_at);
    if (
      !iso ||
      !Number.isFinite(expiry) ||
      expiry <= now ||
      new Date(`${iso[1]}T00:00:00.000Z`).toISOString().slice(0, 10) !== iso[1]
    )
      throw new HarnessError("credential_expired");
    return { name, expires_at: new Date(expiry).toISOString() };
  });
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "PGCF_E2E_ADMIN_KEY",
    "PGCF_E2E_PROBE_BEARER",
    "PGCF_E2E_KUBECONFIG",
  ])
    if (!names.has(name)) throw new HarnessError("credential_expiry_missing");
  return entries;
}

export function credentialInventory(
  entries: readonly CredentialExpiry[],
  runExpiresAt: string,
  now = Date.now(),
) {
  if (!runActive(runExpiresAt, now))
    throw new HarnessError("run_expired_cleanup_required");
  return entries.map((entry) =>
    entry.expiry_source === "run"
      ? { ...entry, expires_at: runExpiresAt }
      : entry,
  );
}

interface Config {
  values: Record<string, string>;
  nodes: string[];
  jurisdiction: "default" | "eu";
  apiUrl: URL;
  credentialExpiries: CredentialExpiry[];
  expectedCluster: ClusterIdentity;
}
interface Ledger {
  version: 1;
  run_id: string;
  identity: string;
  worker_name: string;
  created_at: string;
  expires_at: string;
  cluster?: ClusterIdentity;
  actions: {
    kind: string;
    target: Record<string, string>;
    at: string;
    completed_at?: string;
  }[];
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
  tails: { worker: string; id: string; expires_at: string }[];
  chaos?: {
    relay_name: string;
    policy_name: string;
    policy_uid?: string;
    agent_name?: string;
    settings?: {
      uid: string;
      container: string;
      override: Record<string, unknown> | null;
      effective: { api_url: string; region_id: string };
    };
    inverse_needed: boolean;
    restore_started_at?: string;
    restore_ready_at?: string;
    restored_pod_uid?: string;
  };
}

function config(env: NodeJS.ProcessEnv): Config {
  const values = requireEnv(env, REQUIRED_ENV);
  assertOwned(values.PGCF_E2E_API_WORKER_NAME!);
  assertOwned(values.PGCF_E2E_EDGE_WORKER_NAME!);
  if (
    !/^[0-9]{1,19}$/.test(
      values.PGCF_E2E_CONNECTION_RATE_LIMIT_NAMESPACE_ID!,
    ) ||
    !/^[0-9]{1,19}$/.test(values.PGCF_E2E_DATABASE_RATE_LIMIT_NAMESPACE_ID!) ||
    values.PGCF_E2E_CONNECTION_RATE_LIMIT_NAMESPACE_ID ===
      values.PGCF_E2E_DATABASE_RATE_LIMIT_NAMESPACE_ID
  )
    throw new HarnessError("distinct_approved_rate_limit_namespaces_required");
  assertOwned(values.PGCF_E2E_AGENT_DEPLOYMENT_NAME!);
  if (!/(?:-dev|-test)$/.test(values.PGCF_E2E_EDGE_WORKER_NAME!))
    throw new HarnessError("dev_worker_required");
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
  let nodes: string[], credentialExpiries: CredentialExpiry[];
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
      )
    )
      throw new HarnessError("invalid_config");
    credentialExpiries = parseCredentialExpiries(input);
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("invalid_config");
  }
  const nodeUids = parseUidMap(JSON.parse(values.PGCF_E2E_EXPECTED_NODE_UIDS!));
  if (
    JSON.stringify(Object.keys(nodeUids).sort()) !==
    JSON.stringify([...nodes].sort())
  )
    throw new HarnessError("expected_node_identity_mismatch");
  const expectedCluster = {
    cluster_uid: values.PGCF_E2E_EXPECTED_CLUSTER_UID!,
    namespace_uid: values.PGCF_E2E_EXPECTED_REGIONAL_NAMESPACE_UID!,
    agent_uid: values.PGCF_E2E_EXPECTED_AGENT_DEPLOYMENT_UID!,
    nodes: nodeUids,
    agent_api_url: apiUrl.href,
    region_id: values.PGCF_E2E_REGION_ID!,
  };
  return {
    values,
    nodes,
    jurisdiction,
    apiUrl,
    credentialExpiries,
    expectedCluster,
  };
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
      c.values.PGCF_E2E_REGIONAL_NAMESPACE,
      c.values.PGCF_E2E_AGENT_DEPLOYMENT_NAME,
      c.values.PGCF_E2E_EDGE_WORKER_NAME,
      JSON.stringify(c.expectedCluster),
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

export function startupMismatchAdmission(
  traces: readonly string[],
  marker: string,
  database: string,
  region: string,
): string {
  const connections = new Set<string>();
  for (const trace of traces) {
    let events: unknown;
    try {
      events = JSON.parse(trace);
    } catch {
      continue;
    }
    for (const value of Array.isArray(events) ? events : [events]) {
      try {
        const row = record(value);
        const request = record(record(row.event).request);
        const url = new URL(string(request.url));
        if (
          url.pathname !== "/v2" ||
          ["pgcf_trace", "database", "user"].some(
            (name) => url.searchParams.getAll(name).length !== 1,
          ) ||
          url.searchParams.get("pgcf_trace") !== marker ||
          url.searchParams.get("database") !== database ||
          url.searchParams.get("user") !== "app" ||
          !Array.isArray(row.logs)
        )
          continue;
        for (const log of row.logs) {
          const messages = record(log).message;
          if (!Array.isArray(messages)) continue;
          for (const message of messages) {
            if (typeof message !== "string") continue;
            try {
              const event = record(JSON.parse(message));
              if (
                event.event === "conn_admission" &&
                event.database_id === database &&
                event.user === "app" &&
                event.region_id === region &&
                event.outcome === "accepted" &&
                typeof event.cid === "string" &&
                /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                  event.cid,
                )
              )
                connections.add(event.cid);
            } catch {
              // Other Worker logs cannot establish admitted connection identity.
            }
          }
        }
      } catch {
        // Only complete, correlated Edge request events can establish admission.
      }
    }
  }
  if (connections.size !== 1)
    throw new HarnessError(
      connections.size
        ? "startup_mismatch_admission_ambiguous"
        : "startup_mismatch_admission_missing",
    );
  return [...connections][0]!;
}

export function gatewayStartupMismatchClose(
  logs: string,
  connection: string,
  database: string,
): boolean {
  return logs.split("\n").some((line) => {
    try {
      const event = record(JSON.parse(line));
      return (
        event.event === "conn_close" &&
        event.connection === connection &&
        event.database === database &&
        event.outcome === "startup_route_mismatch"
      );
    } catch {
      return false;
    }
  });
}

export class Run {
  readonly c: Config;
  readonly state: Ledger;
  readonly dryRun: boolean;
  readonly cf: Cloudflare;
  readonly api: ManagementApi;
  readonly kube: Kubernetes;
  readonly dir: string;
  readonly stateDir: string;
  readonly runName: string;
  private readonly root: string;
  private deadline = Date.now() + 450_000;
  private probeHost?: string;
  constructor(c: Config, state: Ledger, root: string, dryRun: boolean) {
    this.c = c;
    this.root = root;
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
    this.kube.setMutationGuard(() => this.assertCluster());
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
  async action(kind: string, target: Record<string, string>): Promise<number> {
    this.state.actions.push({ kind, target, at: new Date().toISOString() });
    await this.save();
    return this.state.actions.length - 1;
  }
  async actionDone(index: number): Promise<void> {
    this.state.actions[index]!.completed_at = new Date().toISOString();
    await this.save();
  }
  async assertCluster(): Promise<void> {
    await this.verifyIdentity(false);
    const actual = await this.kube.clusterIdentity(
      this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
      this.c.values.PGCF_E2E_AGENT_DEPLOYMENT_NAME!,
    );
    const allowed = [this.c.apiUrl.href];
    if (this.state.chaos?.inverse_needed)
      allowed.push((await this.relayUrl()).href);
    assertClusterIdentity(actual, this.c.expectedCluster, allowed);
    if (this.state.cluster)
      assertClusterIdentity(actual, this.state.cluster, allowed);
    else {
      this.state.cluster = actual;
      await this.save();
    }
  }
  requireStep(step: string): void {
    if (!this.state.completed.includes(step))
      throw new HarnessError("previous_step_required");
  }
  async verifyIdentity(checkEdge = true): Promise<void> {
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
    if (!checkEdge) return;
    const edge = this.c.values.PGCF_E2E_EDGE_WORKER_NAME!,
      endpoint = this.c.values.PGCF_E2E_ENDPOINT_HOST!;
    if (endpoint !== `${edge}.${subdomain}.workers.dev`) {
      const domains = await this.cf.list("/workers/domains");
      if (
        !domains.some(
          (domain) => domain.hostname === endpoint && domain.service === edge,
        )
      )
        throw new HarnessError("edge_worker_identity_mismatch");
    }
    const edgeSettings = record(
      (await this.cf.request(`/workers/scripts/${edge}/settings`)).result,
    );
    if (!Array.isArray(edgeSettings.bindings))
      throw new HarnessError("edge_rate_limit_bindings_missing");
    const bindings = edgeSettings.bindings.map(record);
    for (const [name, id] of [
      [
        "CONNECTION_RATE_LIMITER",
        this.c.values.PGCF_E2E_CONNECTION_RATE_LIMIT_NAMESPACE_ID,
      ],
      [
        "DATABASE_CONNECTION_RATE_LIMITER",
        this.c.values.PGCF_E2E_DATABASE_RATE_LIMIT_NAMESPACE_ID,
      ],
    ]) {
      if (
        !bindings.some(
          (binding) =>
            binding.name === name &&
            binding.type === "ratelimit" &&
            String(binding.namespace_id) === id,
        )
      )
        throw new HarnessError("edge_rate_limit_namespace_mismatch");
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
    await this.assertCluster();
    return vgSamples(
      await this.kube.read("lvmnodes.local.openebs.io"),
      this.c.nodes,
      "pgcf",
    );
  }
  async preflight(): Promise<void> {
    await this.verify();
    await this.assertCluster();
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
      const credentials = credentialInventory(
        this.c.credentialExpiries,
        this.state.expires_at,
      );
      await this.complete("E0");
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      // Only names, explicit nonexpiry and actual expiry sources are stored.
      await writeFile(
        resolve(this.dir, "credential-expiries.json"),
        JSON.stringify(credentials),
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
          RUN_EXPIRES_AT: this.state.expires_at,
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
        vars: {
          API_URL: this.c.apiUrl.href,
          RUN_NAME: this.runName,
          RUN_EXPIRES_AT: this.state.expires_at,
        },
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
    const policyAction = await this.action("chaos_policy_create", {
      policy_name: chaos.policy_name,
      namespace_uid: this.state.cluster!.namespace_uid,
      deployment_uid: settings.uid,
    });
    chaos.policy_uid = await this.kube.applyPolicy(
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
      chaos.policy_uid,
    );
    await this.save();
    await this.actionDone(policyAction);
    // Record the inverse before replacing the real deployment's URL.
    chaos.inverse_needed = true;
    await this.intent("chaos_agent_patch");
    const patchAction = await this.action("chaos_agent_patch", {
      namespace_uid: this.state.cluster!.namespace_uid,
      deployment_uid: settings.uid,
      deployment_name: name,
    });
    await this.kube.patchAgentUrl(
      namespace,
      name,
      settings.uid,
      settings.container,
      { name: "PGCF_API_URL", value: url.href.replace(/\/$/, "") },
    );
    await this.actionDone(patchAction);
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
      if (!chaos.restore_started_at) {
        chaos.restore_started_at = new Date().toISOString();
        await this.save();
      }
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
        const action = await this.action("chaos_agent_restore", {
          namespace_uid: this.state.cluster!.namespace_uid,
          deployment_uid: chaos.settings.uid,
          deployment_name: chaos.agent_name,
        });
        await this.kube.patchAgentUrl(
          namespace,
          chaos.agent_name,
          chaos.settings.uid,
          chaos.settings.container,
          chaos.settings.override,
        );
        await this.actionDone(action);
      }
      await poll(
        async () => {
          await this.assertCluster();
          const deployment = items(await this.kube.read("deployments")).find(
            (row) =>
              objectName(row) === chaos.agent_name &&
              record(row.metadata).namespace === namespace,
          );
          if (!deployment) throw new HarnessError("agent_deployment_missing");
          const settings = await this.kube.agentSettings(
            namespace,
            chaos.agent_name!,
          );
          const pod = await this.kube.agentPod(namespace, chaos.agent_name!);
          const containers = record(pod.spec).containers;
          const agent = Array.isArray(containers)
            ? containers.map(record).find((row) => row.name === "agent")
            : undefined;
          if (!agent) throw new HarnessError("agent_container_missing");
          const podConfig = await this.kube.effectiveConfig(agent, namespace);
          const regions = (await this.api.list("/v1/regions")).map((row) =>
            Region.parse(row),
          );
          const region = regions.find(
            (row) => row.id === this.c.values.PGCF_E2E_REGION_ID,
          );
          const status = record(deployment.status),
            metadata = record(deployment.metadata);
          const podOriginal =
            podConfig.api_url.replace(/\/$/, "") ===
              chaos.settings!.effective.api_url.replace(/\/$/, "") &&
            podConfig.region_id === this.c.values.PGCF_E2E_REGION_ID &&
            Array.isArray(record(pod.status).conditions) &&
            (record(pod.status).conditions as unknown[])
              .map(record)
              .some(
                (condition) =>
                  condition.type === "Ready" && condition.status === "True",
              );
          const rolloutReady =
            settings.uid === chaos.settings!.uid &&
            Number(status.observedGeneration) === Number(metadata.generation) &&
            Number(status.availableReplicas) ===
              Number(record(deployment.spec).replicas) &&
            podOriginal;
          const podUid = string(record(pod.metadata).uid);
          if (!rolloutReady) return false;
          if (!chaos.restore_ready_at || chaos.restored_pod_uid !== podUid) {
            chaos.restore_ready_at = new Date().toISOString();
            chaos.restored_pod_uid = podUid;
            await this.save();
            return false;
          }
          return inverseReady({
            uid: settings.uid,
            expected_uid: chaos.settings!.uid,
            actual_url: settings.effective.api_url,
            original_url: chaos.settings!.effective.api_url,
            generation: Number(metadata.generation),
            observed_generation: Number(status.observedGeneration),
            replicas: Number(record(deployment.spec).replicas),
            available_replicas: Number(status.availableReplicas),
            api_seen_at: region?.agent_last_seen_at ?? null,
            started_at: chaos.restore_ready_at!,
            pod_original_url: podOriginal,
          });
        },
        (ready) => ready,
        90_000,
      );
      chaos.inverse_needed = false;
      await this.save();
    }
    if (this.state.intents.includes("chaos_policy_create")) {
      const action = await this.action("chaos_policy_delete", {
        policy_name: chaos.policy_name,
        policy_uid: chaos.policy_uid ?? "unknown",
        namespace_uid: this.state.cluster!.namespace_uid,
      });
      await this.kube.deletePolicy(
        chaos.policy_name,
        namespace,
        this.runName,
        chaos.policy_uid,
      );
      await this.actionDone(action);
    }
  }
  async mode(mode: string): Promise<void> {
    const chaos = this.state.chaos!;
    const cycle = randomBytes(24).toString("hex");
    const action = await this.action("relay_mode", {
      relay_name: chaos.relay_name,
      mode,
      cycle_id: cycle,
      cluster_uid: this.state.cluster!.cluster_uid,
    });
    await this.relay("/control/mode", { mode, cycle_id: cycle });
    await this.actionDone(action);
  }
  async databaseProof(): Promise<DatabaseProof> {
    await this.assertCluster();
    const namespace = `pgcf-db-${this.state.database_id}`;
    const resource = items(await this.kube.read("namespaces")).find(
      (row) => objectName(row) === namespace,
    );
    if (!resource || record(resource.metadata).deletionTimestamp)
      throw new HarnessError("chaos_deleted_database");
    const annotations = record(record(resource.metadata).annotations);
    const accepted = Number(annotations["pgcf.io/accepted-generation"]),
      completed = Number(annotations["pgcf.io/generation"]);
    if (
      !Number.isSafeInteger(accepted) ||
      accepted < 1 ||
      !Number.isSafeInteger(completed) ||
      completed < 1
    )
      throw new HarnessError("database_fence_missing");
    return {
      uid: string(record(resource.metadata).uid),
      accepted,
      completed,
      roles: (await this.kube.rolePasswords(namespace)).map(fingerprint).sort(),
    };
  }
  async recoveredCycle(): Promise<void> {
    await this.mode("pass");
    await this.killAgent("chaos_recovery_restart");
    await poll(
      () => this.relay("/control/counts"),
      (counts) => faultCycleReady(counts, 1),
      90_000,
    );
  }
  async checkChaos(): Promise<void> {
    this.requireStep("chaos-started");
    let replayed = 0,
      failures = 0,
      observed = 0;
    const checkPreserved = async (before: DatabaseProof) => {
      if (!preservedDatabase(before, await this.databaseProof()))
        throw new HarnessError("chaos_persisted_state_regressed");
      const database = Database.parse(
        await this.api.request(`/v1/databases/${this.state.database_id}`),
      );
      if (
        database.desired_state !== "running" ||
        database.observed_generation !== database.generation ||
        database.observed_state !== "ready"
      )
        throw new HarnessError("chaos_generation_regressed");
    };
    try {
      for (const mode of ["empty", "failure"] as const) {
        const before = await this.databaseProof();
        await this.mode(mode);
        await this.killAgent(`chaos_${mode}_restart`);
        const counts = await poll(
          () => this.relay("/control/counts"),
          (value) =>
            mode === "failure"
              ? Number(value.failure_responses) >= 1
              : faultCycleReady(value, 1),
          90_000,
        );
        failures += Number(counts.failure_responses);
        replayed += mode === "empty" ? Number(counts.completed_responses) : 0;
        observed += Number(counts.observations_after_response);
        if (mode === "failure") await this.recoveredCycle();
        await checkPreserved(before);
        if (mode !== "failure") await this.recoveredCycle();
        await checkPreserved(before);
      }
      const baseline = Database.parse(
        await this.api.request(`/v1/databases/${this.state.database_id}`),
      );
      await this.relay("/control/capture-older", {
        database_id: this.state.database_id,
      });
      const rotate = await this.action("chaos_real_password_rotation", {
        database_id: this.state.database_id!,
        project_id: this.state.project_id!,
      });
      await this.api.request(
        `/v1/databases/${this.state.database_id}/roles/app/reset-password`,
        "POST",
        undefined,
        `${this.state.run_id}-chaos-rotate`,
      );
      await this.actionDone(rotate);
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
        const before = await this.databaseProof();
        await this.mode(mode);
        await this.killAgent(`chaos_${mode}_restart`);
        const counts = await poll(
          () => this.relay("/control/counts"),
          (value) => faultCycleReady(value, mode === "out_of_order" ? 2 : 1),
          mode === "out_of_order" ? 135_000 : 90_000,
        );
        replayed += Number(counts.completed_responses);
        observed += Number(counts.observations_after_response);
        if (Number(counts.regressed_generations) !== 0)
          throw new HarnessError("chaos_observation_generation_regressed");
        await checkPreserved(before);
        await this.recoveredCycle();
        await checkPreserved(before);
      }
      if (replayed < 4 || failures < 1 || observed < 4)
        throw new HarnessError("chaos_evidence_incomplete");
      await this.complete("chaos-checked");
      await this.emit("chaos_check", {
        completed_fault_responses: replayed,
        failure_responses: failures,
        observations_after_response: observed,
      });
    } finally {
      await this.restoreChaos();
    }
  }
  async probe(
    path: string,
    body?: unknown,
    marker?: string,
  ): Promise<Record<string, unknown>> {
    await this.verifyIdentity();
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
        ...(marker ? { "X-PGCF-E2E-Marker": marker } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!reply.ok) {
      const code = await probeErrorCode(reply);
      throw new ProbeFailure(
        code === "worker_scan_unavailable"
          ? "supplemental_external_tcp_probe_required"
          : "probe_request_failed",
        reply.status,
        code,
      );
    }
    return record(await reply.json());
  }
  async create(restartAgent = false): Promise<void> {
    this.requireStep("E0");
    await this.verify();
    await this.assertCluster();
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
    const startupTimings = await this.startupMismatches();
    await this.complete("E3");
    await this.emit(
      "E3",
      {
        transactions: 2,
        negative_cases: 5,
        startup_mismatch_cases: 2,
        gateway_startup_mismatch_events: 2,
      },
      {
        ...(record(result.timings) as Record<string, number>),
        ...startupTimings,
      },
    );
  }
  async startupMismatches(): Promise<Record<string, number>> {
    await this.assertCluster();
    const database = string(this.state.database_id);
    const operation = string(this.state.operation_id);
    const timings: Record<string, number> = {};
    for (const mode of ["database", "user"] as const) {
      await this.assertCluster();
      const marker = randomBytes(24).toString("hex");
      const since = new Date().toISOString();
      const action = await this.action("startup_mismatch_probe", {
        mode,
        marker,
        operation_id: operation,
        postgres_dial_evidence: "gateway_source_branch_inference",
      });
      const worker = this.c.values.PGCF_E2E_EDGE_WORKER_NAME!;
      let result: Record<string, unknown> | undefined;
      await this.intent("tail_create");
      const traces = await captureTrace(
        this.cf,
        worker,
        marker,
        async () => {
          result = await this.probe(
            `/startup-${mode}-mismatch`,
            undefined,
            marker,
          );
        },
        async (tail) => {
          this.state.tails.push({ worker, ...tail });
          await this.save();
        },
      );
      if (
        result?.pass !== true ||
        result.sqlstate !== "28000" ||
        result.gateway_outcome !== "startup_route_mismatch" ||
        typeof result.duration_ms !== "number" ||
        !Number.isFinite(result.duration_ms) ||
        result.duration_ms < 0
      )
        throw new HarnessError("startup_mismatch_probe_failed");
      const connection = startupMismatchAdmission(
        traces,
        marker,
        database,
        this.c.values.PGCF_E2E_REGION_ID!,
      );
      this.state.actions[action]!.target.connection = connection;
      await this.save();
      // The close event is measured; pre-dial rejection follows the pinned source branch.
      await poll(
        async () => {
          await this.assertCluster();
          const logs = await this.kube.gatewayLogs(
            this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
            since,
            this.c.values.PGCF_E2E_GHCR_IMAGE!,
          );
          return gatewayStartupMismatchClose(logs, connection, database);
        },
        (matched) => matched,
        30_000,
      );
      timings[`negative_startup_${mode}_ms`] = result.duration_ms;
      await this.actionDone(action);
    }
    return timings;
  }
  async audit(): Promise<void> {
    this.requireStep("E3");
    await this.verify();
    await this.assertCluster();
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
    const marker = randomBytes(24).toString("hex");
    for (const worker of [this.c.values.PGCF_E2E_API_WORKER_NAME!, edgeName]) {
      await this.intent("tail_create");
      const messages = await captureTrace(
        this.cf,
        worker,
        marker,
        () =>
          worker === edgeName
            ? this.probe("/exercise", undefined, marker)
            : this.probe("/integrator-trace", undefined, marker),
        async (tail) => {
          this.state.tails.push({ worker, ...tail });
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
    await this.killAgent(`agent_restart_${stage}`);
    await this.complete(`agent-restarted-${stage}`);
  }
  async killAgent(kind: string): Promise<void> {
    await this.assertCluster();
    const namespace = this.c.values.PGCF_E2E_REGIONAL_NAMESPACE!,
      name = this.c.values.PGCF_E2E_AGENT_DEPLOYMENT_NAME!;
    const pod = await this.kube.agentPod(namespace, name);
    const victim = {
      name: objectName(pod),
      uid: string(record(pod.metadata).uid),
    };
    const action = await this.action(kind, {
      cluster_uid: this.state.cluster!.cluster_uid,
      namespace_uid: this.state.cluster!.namespace_uid,
      deployment_uid: this.state.cluster!.agent_uid,
      pod_name: victim.name,
      pod_uid: victim.uid,
    });
    await this.kube.restartAgent(namespace, name, victim);
    await this.actionDone(action);
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
    await this.assertCluster();
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
    await this.assertCluster();
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
    await this.assertCluster();
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
  private nativeProof(targets: readonly string[]): Promise<Set<string>> {
    return consumeExternalProbe(this.root, targets);
  }
  async scan(addressIndex?: number): Promise<boolean> {
    this.requireStep("E5");
    await this.assertCluster();
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
        // Workers cannot dial TCP/25. A signed, independent native probe must cover it.
        if (batch.includes(25)) {
          const proven = await this.nativeProof(
            addresses.map((entry) => entry.host),
          );
          if (!proven.has(address.host))
            throw new HarnessError("supplemental_external_tcp_probe_required");
        }
        const workerPorts = batch.filter((port) => port !== 25);
        const result = await this.probe("/scan", {
          host: address.host,
          ports: workerPorts,
        });
        if (
          !Array.isArray(result.open) ||
          result.open.some((p) => typeof p !== "number") ||
          result.checked !== workerPorts.length
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
    if (complete) {
      const proven = await this.nativeProof(
        addresses.map((entry) => entry.host),
      );
      if (addresses.some((address) => !proven.has(address.host)))
        throw new HarnessError("supplemental_external_tcp_probe_required");
      await this.complete("E6");
    }
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
    await this.verifyIdentity(false);
    await this.assertCluster();
    await this.recoverOwnership();
    const failures: CleanupReason[] = [];
    // The real agent must use the real API before any database deletion is requested.
    try {
      await this.restoreChaos();
    } catch (error) {
      await this.emit("cleanup", { failure_count: 1 }, {}, false);
      throw new CleanupFailure(
        [{ stage: "chaos_inverse", code: failureCode(error) }],
        "chaos_inverse_required",
      );
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
      } catch (error) {
        failures.push({ stage: "tail", code: failureCode(error) });
      }
    }
    try {
      await this.deleteDatabase();
    } catch (error) {
      failures.push({ stage: "database", code: failureCode(error) });
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
    } catch (error) {
      failures.push({ stage: "key", code: failureCode(error) });
    }
    if (
      !failures.some((failure) => failure.stage === "database") &&
      this.state.project_id
    ) {
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
      } catch (error) {
        failures.push({ stage: "project", code: failureCode(error) });
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
    } catch (error) {
      failures.push({ stage: "worker", code: failureCode(error) });
    }
    await this.emit(
      "cleanup",
      { failure_count: failures.length },
      {},
      failures.length === 0,
    );
    if (failures.length) throw new CleanupFailure(failures);
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
      !Array.isArray(state.tails) ||
      !Array.isArray(state.actions) ||
      typeof state.expires_at !== "string"
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
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      actions: [],
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
  if (!cleanupOnly && !runActive(state.expires_at))
    throw new HarnessError("run_expired_cleanup_required");
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
  let failed = false;
  let originalFailure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
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
    failed = true;
    originalFailure = error;
    if (
      error instanceof HarnessError &&
      error.code === "archive_failure_wait_pending"
    )
      preserve = true;
  } finally {
    if (!preserve && state.intents.length) {
      try {
        await run.cleanup();
      } catch (cleanupError) {
        cleanupFailed = true;
        cleanupFailure = cleanupError;
      }
    }
  }
  if (cleanupFailed)
    throw new AcceptanceFailure(
      step,
      failed ? originalFailure : cleanupFailure,
      cleanupFailure,
    );
  if (failed) throw new AcceptanceFailure(step, originalFailure);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify(acceptanceDiagnostic(error)));
    process.exitCode = 1;
  });
}
