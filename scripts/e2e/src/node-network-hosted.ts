// SPDX-License-Identifier: Apache-2.0
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
} from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { command } from "./clients.ts";
import {
  sourcePool,
  assertProbeProvenance,
  publicIPv4,
} from "./external-probe.ts";
import {
  blocked,
  canonical,
  hash,
  MAX_JSON_BYTES,
  writeArtifact,
} from "./node-network-native.ts";
import {
  measureScans,
  parsePlan,
  verifyMeasurements,
  validateBinding,
} from "./node-network-proof.ts";
import type { CommonConfig, Measurement } from "./node-network-proof.ts";
import type { Envelope } from "./node-network-native.ts";

interface Context {
  repository: string;
  commit: string;
  run_id: string;
  run_attempt: string;
}
interface HostedConfig {
  version: 1;
  nonce: string;
  created_at: string;
  expires_at: string;
  encryption_key: string;
  signing_jwk: JsonWebKey;
  network: CommonConfig;
}
interface Encrypted {
  version: 1;
  purpose: "pgcf-node-hosted-network-encrypted/v1";
  nonce: string;
  context: Context;
  iv: string;
  tag: string;
  ciphertext: string;
}
interface Report {
  version: 1;
  nonce: string;
  context: Context;
  config_sha256: string;
  pool_observed_at: string;
  source_pool: string[];
  started_at: string;
  finished_at: string;
  measurement: Envelope<Measurement>;
}
function context(value: Context): Context {
  if (
    !value ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
      value.repository,
    ) ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    !/^[1-9][0-9]{0,19}$/.test(value.run_id) ||
    !/^[1-9][0-9]{0,3}$/.test(value.run_attempt)
  )
    blocked("hosted_context_invalid");
  return value;
}
function bytes(value: string, length: number): Buffer {
  if (typeof value !== "string") blocked("encrypted_artifact_invalid");
  const result = Buffer.from(value, "base64url");
  if (result.length !== length || result.toString("base64url") !== value)
    blocked("encrypted_artifact_invalid");
  return result;
}
export function encryptHostedReport(
  value: unknown,
  key: string,
  nonce: string,
  run: Context,
): Encrypted {
  const header = {
      version: 1 as const,
      purpose: "pgcf-node-hosted-network-encrypted/v1" as const,
      nonce,
      context: context(run),
    },
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", bytes(key, 32), iv);
  cipher.setAAD(Buffer.from(canonical(header)));
  const plaintext = Buffer.from(canonical(value));
  if (plaintext.length > MAX_JSON_BYTES / 2) blocked("artifact_bytes");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ...header,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}
export function decryptHostedReport(
  value: Encrypted,
  key: string,
  nonce: string,
  run: Context,
): unknown {
  try {
    if (
      Object.keys(value).sort().join(",") !==
        "ciphertext,context,iv,nonce,purpose,tag,version" ||
      value.version !== 1 ||
      value.purpose !== "pgcf-node-hosted-network-encrypted/v1" ||
      value.nonce !== nonce ||
      canonical(value.context) !== canonical(context(run)) ||
      typeof value.ciphertext !== "string" ||
      value.ciphertext.length > MAX_JSON_BYTES
    )
      blocked("encrypted_artifact_invalid");
    const ciphertext = Buffer.from(value.ciphertext, "base64url");
    if (ciphertext.toString("base64url") !== value.ciphertext)
      blocked("encrypted_artifact_invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      bytes(key, 32),
      bytes(value.iv, 12),
    );
    decipher.setAAD(
      Buffer.from(
        canonical({
          version: value.version,
          purpose: value.purpose,
          nonce: value.nonce,
          context: value.context,
        }),
      ),
    );
    decipher.setAuthTag(bytes(value.tag, 16));
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      ),
    );
  } catch {
    return blocked("encrypted_artifact_invalid");
  }
}
export function parseHostedConfig(raw: string): HostedConfig {
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) blocked("config_bytes");
  const value = JSON.parse(raw) as HostedConfig,
    now = Date.now();
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.nonce) ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.created_at) > now ||
    Date.parse(value.expires_at) <= now ||
    Date.parse(value.expires_at) - Date.parse(value.created_at) > 600_000 ||
    !value.network?.scan?.https_control ||
    !value.network.scan.tcp25_control
  )
    blocked("hosted_config_invalid");
  bytes(value.encryption_key, 32);
  parsePlan(value.network.plan, value.network.binding.plan_sha256);
  validateBinding(value.network.binding, value.network.plan);
  const control = value.network.scan!.tcp25_control!;
  if (
    !publicIPv4(control) ||
    value.network.plan.scan_control.port !== 443 ||
    value.network.plan.members.some((member) =>
      member.addresses.ipv4.includes(control),
    )
  )
    blocked("tcp25_control_invalid");
  return value;
}
export function assertHostedReport(
  report: Report,
  config: HostedConfig,
  run: Context,
  pool: string[],
  now = Date.now(),
): Envelope<Measurement> {
  const start = Date.parse(report.started_at),
    finish = Date.parse(report.finished_at),
    observed = Date.parse(report.pool_observed_at);
  if (
    report.version !== 1 ||
    report.nonce !== config.nonce ||
    canonical(report.context) !== canonical(context(run)) ||
    report.config_sha256 !== hash(config.network) ||
    !Number.isFinite(start) ||
    !Number.isFinite(finish) ||
    !Number.isFinite(observed) ||
    start < Date.parse(config.created_at) ||
    finish < start ||
    finish > now + 5000 ||
    finish >= Date.parse(config.expires_at) ||
    start - observed > 10000 ||
    observed > start ||
    now - start > 120000 ||
    now >= Date.parse(config.expires_at) ||
    canonical([...report.source_pool].sort()) !== canonical([...pool].sort())
  )
    blocked("hosted_report_invalid");
  const network = {
    ...config.network,
    scan: { ...config.network.scan, source_pool: pool },
  };
  const measurement = verifyMeasurements(network, [report.measurement], now)[0];
  if (measurement?.kind !== "scan" || measurement.family !== "ipv4")
    blocked("hosted_report_invalid");
  return report.measurement;
}
export async function consumeHostedReport(
  path: string,
  config: HostedConfig,
  run: Context,
  root: string,
): Promise<Envelope<Measurement>> {
  context(run);
  const body = await readFile(path);
  if (body.length > MAX_JSON_BYTES) blocked("artifact_bytes");
  const verified = await command(
    "gh",
    [
      "attestation",
      "verify",
      path,
      "--hostname",
      "github.com",
      "--repo",
      run.repository,
      "--signer-workflow",
      `${run.repository}/.github/workflows/ci.yml`,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      run.commit,
      "--signer-digest",
      run.commit,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    { timeoutMs: 60000 },
  );
  assertProbeProvenance(
    JSON.parse(verified),
    run,
    createHash("sha256").update(body).digest("hex"),
  );
  const execution = JSON.parse(
    await command(
      "gh",
      ["api", `repos/${run.repository}/actions/runs/${run.run_id}`],
      { timeoutMs: 30000 },
    ),
  );
  if (
    execution.event !== "workflow_dispatch" ||
    execution.head_branch !== "main" ||
    execution.head_sha !== run.commit ||
    execution.path !== ".github/workflows/ci.yml" ||
    execution.run_attempt !== Number(run.run_attempt) ||
    execution.status !== "completed" ||
    execution.conclusion !== "success"
  )
    blocked("hosted_run_invalid");
  const artifacts = JSON.parse(
    await command(
      "gh",
      ["api", `repos/${run.repository}/actions/runs/${run.run_id}/artifacts`],
      { timeoutMs: 30000 },
    ),
  );
  if (
    !Array.isArray(artifacts.artifacts) ||
    !artifacts.artifacts.some(
      (entry: { name?: string; expired?: boolean }) =>
        entry.name === "pgcf-node-network" && entry.expired === false,
    )
  )
    blocked("hosted_artifact_missing");
  const commit = (
      await command("git", ["rev-parse", "HEAD"], { cwd: root })
    ).trim(),
    ref = (
      await command("git", ["symbolic-ref", "HEAD"], { cwd: root })
    ).trim();
  if (commit !== run.commit || ref !== "refs/heads/main")
    blocked("hosted_commit_mismatch");
  return assertHostedReport(
    decryptHostedReport(
      JSON.parse(body.toString("utf8")),
      config.encryption_key,
      config.nonce,
      run,
    ) as Report,
    config,
    run,
    await sourcePool(),
  );
}
function env(name: string): string {
  const value = process.env[name];
  if (!value) blocked("environment_missing");
  return value;
}
async function main(): Promise<void> {
  const config = parseHostedConfig(env("PGCF_NETWORK_HOSTED_CONFIG"));
  if (process.argv[2] === "consume") {
    const measurement = await consumeHostedReport(
      env("PGCF_NETWORK_HOSTED_ARTIFACT"),
      config,
      context(JSON.parse(env("PGCF_NETWORK_HOSTED_EXPECTATION"))),
      process.cwd(),
    );
    const sha256 = await writeArtifact(env("PGCF_NETWORK_OUTPUT"), measurement);
    process.stdout.write(
      JSON.stringify({ event: "node_network_hosted_verified", sha256 }) + "\n",
    );
    return;
  }
  if (
    process.platform !== "darwin" ||
    process.env.RUNNER_OS !== "macOS" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  )
    blocked("hosted_main_required");
  const run = context({
      repository: env("GITHUB_REPOSITORY"),
      commit: env("GITHUB_SHA"),
      run_id: env("GITHUB_RUN_ID"),
      run_attempt: env("GITHUB_RUN_ATTEMPT"),
    }),
    pool = await sourcePool(),
    pool_observed_at = new Date().toISOString(),
    started_at = new Date().toISOString(),
    network = {
      ...config.network,
      scan: { ...config.network.scan, source_pool: pool },
    },
    key = createPrivateKey({ key: config.signing_jwk, format: "jwk" }),
    measurement = await measureScans(
      network,
      "auto",
      key,
      Date.parse(config.expires_at),
    );
  const report: Report = {
    version: 1,
    nonce: config.nonce,
    context: run,
    config_sha256: hash(config.network),
    pool_observed_at,
    source_pool: pool,
    started_at,
    finished_at: new Date().toISOString(),
    measurement,
  };
  assertHostedReport(report, config, run, pool);
  const sha256 = await writeArtifact(
    resolve(env("RUNNER_TEMP"), "pgcf-node-network.enc.json"),
    encryptHostedReport(report, config.encryption_key, config.nonce, run),
  );
  process.stdout.write(
    JSON.stringify({ event: "node_network_hosted_artifact_written", sha256 }) +
      "\n",
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const code = /^(?:node_network|external_probe)_[a-z_]{1,80}$/.test(message)
      ? message
      : "node_network_hosted_failed";
    process.stderr.write(
      JSON.stringify({ event: "node_network_hosted_failed", code }) + "\n",
    );
    process.exitCode = 1;
  });
