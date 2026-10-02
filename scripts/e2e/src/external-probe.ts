// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { command } from "./clients.ts";
import { HarnessError, record, string } from "./core.ts";

type TcpState = "connected" | "refused" | "timed_out" | "inconclusive";
interface Sample {
  state: TcpState;
  at: string;
}
export interface ProbeConfig {
  version: 1;
  nonce: string;
  salt: string;
  created_at: string;
  expires_at: string;
  targets: string[];
  control: string;
  operator_allowlist: string[];
  operator_allowlist_complete: true;
}
interface ProbeContext {
  repository: string;
  commit: string;
  run_id: string;
  run_attempt: string;
}
interface ProbeReport {
  version: 1;
  nonce: string;
  started_at: string;
  finished_at: string;
  pool_observed_at: string;
  source_pool_hash: string;
  allowlist_hash: string;
  control_hash: string;
  commit_hash: string;
  run_hash: string;
  workflow_hash: string;
  source_pool_disjoint: boolean;
  results: {
    target_hash: string;
    family: 4 | 6;
    port: 25;
    native_source_proven: boolean;
    before: Sample;
    target: Sample;
    after: Sample;
  }[];
}

function json(value: string): unknown {
  if (value.length > 65_536)
    throw new HarnessError("external_probe_input_invalid");
  try {
    return JSON.parse(value);
  } catch {
    throw new HarnessError("external_probe_input_invalid");
  }
}
function ipValue(host: string): { family: 4 | 6; value: bigint } {
  const family = isIP(host);
  if (family === 4)
    return {
      family,
      value: host.split(".").reduce((n, b) => (n << 8n) | BigInt(b), 0n),
    };
  if (family !== 6 || host.includes(".") || host.includes("%"))
    throw new HarnessError("external_probe_address_invalid");
  const halves = host.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 2
      ? [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ]
      : left;
  const value = words.reduce((n, b) => (n << 16n) | BigInt(`0x${b}`), 0n);
  if (value >> 32n === 0xffffn)
    throw new HarnessError("external_probe_mapped_address_refused");
  return { family, value };
}
function cidr(value: string): { family: 4 | 6; first: bigint; last: bigint } {
  const parts = value.split("/");
  if (parts.length !== 2 || !/^(?:0|[1-9][0-9]{0,2})$/.test(parts[1]!))
    throw new HarnessError("external_probe_cidr_invalid");
  const address = ipValue(parts[0]!);
  const width = address.family === 4 ? 32 : 128;
  const prefix = Number(parts[1]);
  if (prefix > width) throw new HarnessError("external_probe_cidr_invalid");
  const mask = (1n << BigInt(width - prefix)) - 1n;
  return {
    family: address.family,
    first: address.value & ~mask,
    last: address.value | mask,
  };
}
function normalizedCidrs(values: readonly string[]): string[] {
  if (!values.length || values.length > 256)
    throw new HarnessError("external_probe_allowlist_required");
  return [
    ...new Set(
      values.map((value) => {
        const c = cidr(value);
        return `${c.family}:${c.first.toString(16)}:${c.last.toString(16)}`;
      }),
    ),
  ].sort();
}
export function cidrPoolsDisjoint(
  pool: readonly string[],
  allowlist: readonly string[],
): boolean {
  normalizedCidrs(pool);
  normalizedCidrs(allowlist);
  return pool.every((entry) => {
    const source = cidr(entry);
    return allowlist.every((entry) => {
      const allowed = cidr(entry);
      return (
        source.family !== allowed.family ||
        source.last < allowed.first ||
        allowed.last < source.first
      );
    });
  });
}
export function parseProbeConfig(value: string, now = Date.now()): ProbeConfig {
  const entry = record(json(value));
  const targets = entry.targets;
  const allowlist = entry.operator_allowlist;
  if (
    entry.version !== 1 ||
    typeof entry.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.nonce) ||
    typeof entry.salt !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(entry.salt) ||
    Buffer.from(entry.salt, "base64url").toString("base64url") !== entry.salt ||
    !Array.isArray(targets) ||
    !targets.length ||
    targets.length > 16 ||
    targets.some((v) => typeof v !== "string") ||
    new Set(targets).size !== targets.length ||
    !Array.isArray(allowlist) ||
    allowlist.some((v) => typeof v !== "string") ||
    entry.operator_allowlist_complete !== true
  )
    throw new HarnessError("external_probe_config_invalid");
  const created = Date.parse(string(entry.created_at));
  const expires = Date.parse(string(entry.expires_at));
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    created > now ||
    expires <= now ||
    expires - created > 1_800_000
  )
    throw new HarnessError("external_probe_config_expired");
  targets.forEach((target: string) => ipValue(target));
  const control = string(entry.control);
  if (ipValue(control).family !== 4 || targets.includes(control))
    throw new HarnessError("external_probe_control_invalid");
  normalizedCidrs(allowlist as string[]);
  return {
    version: 1,
    nonce: entry.nonce,
    salt: entry.salt,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expires).toISOString(),
    targets: targets as string[],
    control,
    operator_allowlist: allowlist as string[],
    operator_allowlist_complete: true,
  };
}
function parseContext(value: unknown): ProbeContext {
  const row = record(value);
  const repository = string(row.repository),
    commit = string(row.commit),
    run_id = string(row.run_id),
    run_attempt = string(row.run_attempt);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
      repository,
    ) ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !/^[1-9][0-9]{0,19}$/.test(run_id) ||
    !/^[1-9][0-9]{0,3}$/.test(run_attempt)
  )
    throw new HarnessError("external_probe_context_invalid");
  return { repository, commit, run_id, run_attempt };
}
export function keyedHash(
  config: ProbeConfig,
  domain: string,
  value: string,
): string {
  return createHmac("sha256", Buffer.from(config.salt, "base64url"))
    .update(`${config.nonce}\0${domain}\0${value}`)
    .digest("hex");
}
function workflow(context: ProbeContext): string {
  return `https://github.com/${context.repository}/.github/workflows/ci.yml@refs/heads/main`;
}
export function probeReport(
  config: ProbeConfig,
  pool: readonly string[],
  context: ProbeContext,
  now = Date.now(),
): ProbeReport {
  parseContext(context);
  const at = new Date(now).toISOString();
  const disjoint = cidrPoolsDisjoint(pool, config.operator_allowlist);
  return {
    version: 1,
    nonce: config.nonce,
    started_at: at,
    finished_at: at,
    pool_observed_at: at,
    source_pool_hash: keyedHash(
      config,
      "source_pool",
      JSON.stringify(normalizedCidrs(pool)),
    ),
    allowlist_hash: keyedHash(
      config,
      "allowlist",
      JSON.stringify(normalizedCidrs(config.operator_allowlist)),
    ),
    control_hash: keyedHash(config, "control", config.control),
    commit_hash: keyedHash(config, "commit", context.commit),
    run_hash: keyedHash(
      config,
      "run",
      `${context.repository}:${context.run_id}:${context.run_attempt}`,
    ),
    workflow_hash: keyedHash(config, "workflow", workflow(context)),
    source_pool_disjoint: disjoint,
    results: config.targets.map((target) => ({
      target_hash: keyedHash(config, "target", target),
      family: ipValue(target).family,
      port: 25,
      native_source_proven: disjoint && ipValue(target).family === 4,
      before: { state: "inconclusive", at },
      target: { state: "inconclusive", at },
      after: { state: "inconclusive", at },
    })),
  };
}
export async function nativeTcp(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<TcpState> {
  let family: 4 | 6;
  try {
    family = ipValue(host).family;
  } catch {
    return "inconclusive";
  }
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    throw new HarnessError("external_probe_tcp_invalid");
  return new Promise((resolve) => {
    const socket = createConnection({
      host,
      port,
      family,
      autoSelectFamily: false,
    });
    let finished = false;
    const finish = (state: TcpState) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish("timed_out"), timeoutMs);
    socket.once("connect", () =>
      finish(
        socket.remoteFamily === `IPv${family}` ? "connected" : "inconclusive",
      ),
    );
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "refused"
          : error.code === "ETIMEDOUT"
            ? "timed_out"
            : "inconclusive",
      ),
    );
    socket.once("close", () => finish("inconclusive"));
  });
}
async function sourcePool(): Promise<string[]> {
  const response = await fetch("https://api.github.com/meta", {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "pgcf-e6-native-probe" },
  });
  if (!response.ok)
    throw new HarnessError("external_probe_source_pool_unavailable");
  const body = await response.text();
  if (body.length > 1_000_000)
    throw new HarnessError("external_probe_source_pool_invalid");
  const pool = record(JSON.parse(body)).actions_macos;
  if (
    !Array.isArray(pool) ||
    pool.some((v) => typeof v !== "string") ||
    pool.some((v) => cidr(v as string).family !== 4)
  )
    throw new HarnessError("external_probe_source_pool_invalid");
  normalizedCidrs(pool as string[]);
  return pool as string[];
}
export function assertExternalReport(
  value: unknown,
  config: ProbeConfig,
  pool: readonly string[],
  context: ProbeContext,
  authoritativeAllowlist: readonly string[],
  targets: readonly string[],
  now = Date.now(),
): string[] {
  const expected = probeReport(config, pool, context, now);
  const row = record(value);
  const start = Date.parse(string(row.started_at)),
    end = Date.parse(string(row.finished_at)),
    observed = Date.parse(string(row.pool_observed_at));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(observed) ||
    start < Date.parse(config.created_at) ||
    end < start ||
    end > now + 5000 ||
    end >= Date.parse(config.expires_at) ||
    now - start > 900_000 ||
    observed > start ||
    start - observed > 10_000 ||
    now >= Date.parse(config.expires_at)
  )
    throw new HarnessError("external_probe_report_stale");
  for (const field of [
    "version",
    "nonce",
    "source_pool_hash",
    "allowlist_hash",
    "control_hash",
    "commit_hash",
    "run_hash",
    "workflow_hash",
    "source_pool_disjoint",
  ] as const)
    if (row[field] !== expected[field])
      throw new HarnessError("external_probe_report_mismatch");
  if (
    JSON.stringify(normalizedCidrs(authoritativeAllowlist)) !==
      JSON.stringify(normalizedCidrs(config.operator_allowlist)) ||
    !expected.source_pool_disjoint
  )
    throw new HarnessError("external_probe_source_not_proven");
  if (
    JSON.stringify([...targets].sort()) !==
      JSON.stringify([...config.targets].sort()) ||
    !Array.isArray(row.results) ||
    row.results.length !== expected.results.length
  )
    throw new HarnessError("external_probe_targets_mismatch");
  const closed: string[] = [];
  for (let index = 0; index < config.targets.length; index++) {
    const entry = record(row.results[index]);
    const expectedEntry = expected.results[index]!;
    for (const field of [
      "target_hash",
      "family",
      "port",
      "native_source_proven",
    ] as const)
      if (entry[field] !== expectedEntry[field])
        throw new HarnessError("external_probe_result_mismatch");
    const samples = ["before", "target", "after"].map((name) => {
      const sample = record(entry[name]);
      const at = Date.parse(string(sample.at));
      if (
        !["connected", "refused", "timed_out", "inconclusive"].includes(
          string(sample.state),
        ) ||
        !Number.isFinite(at) ||
        at < start ||
        at > end
      )
        throw new HarnessError("external_probe_sample_invalid");
      return { state: sample.state as TcpState, at };
    });
    if (
      samples[0]!.at > samples[1]!.at ||
      samples[1]!.at > samples[2]!.at ||
      samples[2]!.at - samples[0]!.at > 20_000
    )
      throw new HarnessError("external_probe_control_not_adjacent");
    if (samples[1]!.state === "connected")
      throw new HarnessError("unexpected_open_port");
    if (
      expectedEntry.family === 4 &&
      expectedEntry.native_source_proven &&
      samples[0]!.state === "connected" &&
      samples[2]!.state === "connected" &&
      ["refused", "timed_out"].includes(samples[1]!.state)
    )
      closed.push(config.targets[index]!);
  }
  return closed;
}
export function assertProbeProvenance(
  value: unknown,
  context: ProbeContext,
  subjectDigest: string,
): void {
  parseContext(context);
  if (!/^[0-9a-f]{64}$/.test(subjectDigest))
    throw new HarnessError("external_probe_subject_invalid");
  if (!Array.isArray(value) || !value.length)
    throw new HarnessError("external_probe_attestation_missing");
  const accepted = value.some((entry: unknown) => {
    const result = record(record(entry).verificationResult);
    const certificate = record(record(result.signature).certificate);
    const subject = record(result.statement).subject;
    return (
      Array.isArray(subject) &&
      subject.some(
        (entry: unknown) =>
          record(record(entry).digest).sha256 === subjectDigest,
      ) &&
      certificate.issuer === "https://token.actions.githubusercontent.com" &&
      certificate.subjectAlternativeName === workflow(context) &&
      certificate.sourceRepositoryURI ===
        `https://github.com/${context.repository}` &&
      certificate.sourceRepositoryDigest === context.commit &&
      certificate.sourceRepositoryRef === "refs/heads/main" &&
      certificate.runnerEnvironment === "github-hosted" &&
      certificate.buildTrigger === "workflow_dispatch" &&
      certificate.runInvocationURI ===
        `https://github.com/${context.repository}/actions/runs/${context.run_id}/attempts/${context.run_attempt}` &&
      certificate.sourceRepositoryVisibilityAtSigning === "public" &&
      Array.isArray(result.verifiedTimestamps) &&
      result.verifiedTimestamps.length > 0
    );
  });
  if (!accepted) throw new HarnessError("external_probe_attestation_mismatch");
}

export async function consumeExternalProbe(
  root: string,
  targets: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<string>> {
  if (
    !env.PGCF_E2E_EXTERNAL_PROBE_CONFIG ||
    !env.PGCF_E2E_EXTERNAL_PROBE_EXPECTATION ||
    !env.PGCF_E2E_OPERATOR_ALLOWLIST
  )
    throw new HarnessError("supplemental_external_tcp_probe_required");
  const config = parseProbeConfig(env.PGCF_E2E_EXTERNAL_PROBE_CONFIG);
  const expectation = record(json(env.PGCF_E2E_EXTERNAL_PROBE_EXPECTATION));
  const context = parseContext(expectation);
  if (expectation.nonce !== config.nonce)
    throw new HarnessError("external_probe_nonce_mismatch");
  const allowlist = json(env.PGCF_E2E_OPERATOR_ALLOWLIST);
  if (!Array.isArray(allowlist) || allowlist.some((v) => typeof v !== "string"))
    throw new HarnessError("external_probe_allowlist_required");
  const path = resolve(root, ".local/evidence/phase1/pgcf-e6-native.json");
  const body = await readFile(path, "utf8");
  const verified = await command(
    "gh",
    [
      "attestation",
      "verify",
      path,
      "--hostname",
      "github.com",
      "--repo",
      context.repository,
      "--signer-workflow",
      `${context.repository}/.github/workflows/ci.yml`,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      context.commit,
      "--signer-digest",
      context.commit,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    { env, timeoutMs: 60_000 },
  );
  // Bind the parsed bytes to the verified subject even if the downloaded file changes.
  assertProbeProvenance(
    JSON.parse(verified),
    context,
    createHash("sha256").update(body).digest("hex"),
  );
  const run = record(
    JSON.parse(
      await command(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          `repos/${context.repository}/actions/runs/${context.run_id}`,
        ],
        { env, timeoutMs: 30_000 },
      ),
    ),
  );
  if (
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== context.commit ||
    run.path !== ".github/workflows/ci.yml" ||
    run.run_attempt !== Number(context.run_attempt) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new HarnessError("external_probe_run_mismatch");
  const artifacts = record(
    JSON.parse(
      await command(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          `repos/${context.repository}/actions/runs/${context.run_id}/artifacts`,
        ],
        { env, timeoutMs: 30_000 },
      ),
    ),
  );
  if (
    !Array.isArray(artifacts.artifacts) ||
    !artifacts.artifacts.some((entry: unknown) => {
      const a = record(entry);
      return a.name === "pgcf-e6-native" && a.expired === false;
    })
  )
    throw new HarnessError("external_probe_artifact_missing");
  const currentCommit = (
    await command("git", ["rev-parse", "HEAD"], { cwd: root })
  ).trim();
  const currentRef = (
    await command("git", ["symbolic-ref", "HEAD"], { cwd: root })
  ).trim();
  if (currentCommit !== context.commit || currentRef !== "refs/heads/main")
    throw new HarnessError("external_probe_commit_mismatch");
  return new Set(
    assertExternalReport(
      json(body),
      config,
      await sourcePool(),
      context,
      allowlist as string[],
      targets,
    ),
  );
}

async function main(): Promise<void> {
  if (
    process.platform !== "darwin" ||
    process.env.RUNNER_OS !== "macOS" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.PGCF_E2E_EXTERNAL_PROBE_CONFIG
  )
    throw new HarnessError("external_probe_hosted_main_required");
  const config = parseProbeConfig(process.env.PGCF_E2E_EXTERNAL_PROBE_CONFIG);
  const context = parseContext({
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  const pool = await sourcePool();
  const report = probeReport(config, pool, context);
  for (let index = 0; index < config.targets.length; index++) {
    const result = report.results[index]!;
    if (!result.native_source_proven) continue;
    if (Date.now() + 20_000 >= Date.parse(config.expires_at))
      throw new HarnessError("external_probe_config_expired");
    const sample = async (host: string): Promise<Sample> => ({
      state: await nativeTcp(host, 25),
      at: new Date().toISOString(),
    });
    result.before = await sample(config.control);
    result.target = await sample(config.targets[index]!);
    result.after = await sample(config.control);
  }
  report.finished_at = new Date().toISOString();
  await writeFile(
    resolve(process.env.RUNNER_TEMP!, "pgcf-e6-native.json"),
    `${JSON.stringify(report)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ external_probe_report: true }));
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        external_probe_report: false,
        code:
          error instanceof HarnessError ? error.code : "external_probe_failed",
      }),
    );
    process.exitCode = 1;
  });
