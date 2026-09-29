// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { captureControlSnapshot } from "./control-snapshot.ts";
import type { ControlSnapshot } from "./control-snapshot.ts";

export interface ControlRecoveryD1Config {
  wranglerExecutable: string;
  wranglerConfigFile: string;
  emptyEnvFile: string;
  accountId: string;
  databaseName: string;
  migrationDirectory: string;
  source: ControlSnapshot["source"];
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const failed = () => new Error("control_recovery_d1_failed");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) &&
  isAbsolute(value);

function configuration(value: ControlRecoveryD1Config): void {
  const keys = [
    "wranglerExecutable",
    "wranglerConfigFile",
    "emptyEnvFile",
    "accountId",
    "databaseName",
    "migrationDirectory",
    "source",
  ];
  if (!object(value)) throw failed();
  const source: unknown = value.source;
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !keys.slice(0, 3).every((key) => absolute(value[key])) ||
    !absolute(value.migrationDirectory) ||
    typeof value.accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.accountId) ||
    typeof value.databaseName !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(value.databaseName) ||
    !object(source) ||
    Object.keys(source).length !== 2 ||
    !["installationId", "databaseId"].every(
      (key) => typeof source[key] === "string" && uuid.test(source[key]),
    )
  )
    throw failed();
}

async function privateDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw failed();
  return canonical;
}

async function privateFile(path: string, maximum: number): Promise<Buffer> {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      (process.getuid && before.uid !== process.getuid()) ||
      before.size > maximum
    )
      throw failed();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (
      length > maximum ||
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw failed();
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

function validateWrangler(
  contents: Buffer,
  config: ControlRecoveryD1Config,
): void {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(contents),
  );
  if (
    !object(value) ||
    Object.hasOwn(value, "env") ||
    (Object.hasOwn(value, "account_id") &&
      value.account_id !== config.accountId) ||
    Object.keys(value).some((key) => /^(?:CF_|CLOUDFLARE_)/i.test(key)) ||
    !Array.isArray(value.d1_databases) ||
    value.d1_databases.length < 1 ||
    value.d1_databases.length > 32
  )
    throw failed();
  if (
    object(value.vars) &&
    Object.keys(value.vars).some((key) => /^(?:CF_|CLOUDFLARE_)/i.test(key))
  )
    throw failed();
  const selected = value.d1_databases.filter(
    (binding: unknown) =>
      object(binding) &&
      (binding.database_name === config.databaseName ||
        binding.binding === config.databaseName),
  );
  if (
    selected.length !== 1 ||
    !object(selected[0]) ||
    selected[0].database_id !== config.source.databaseId
  )
    throw failed();
}

async function writePrivate(path: string, contents: Buffer): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

function environment(
  config: ControlRecoveryD1Config,
  working: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR"])
    if (process.env[key] !== undefined) result[key] = process.env[key];
  return {
    ...result,
    CI: "true",
    NO_COLOR: "1",
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
    WRANGLER_LOG_PATH: join(working, "logs"),
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_METRICS: "false",
  };
}

async function query(
  config: ControlRecoveryD1Config,
  working: string,
  sql: string,
  cancellation?: AbortSignal,
): Promise<string> {
  if (
    typeof sql !== "string" ||
    Buffer.byteLength(sql, "utf8") > 100_000 ||
    !/^\s*SELECT\b/i.test(sql)
  )
    throw failed();
  const stdout = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      config.wranglerExecutable,
      [
        "d1",
        "execute",
        config.databaseName,
        "--remote",
        "--json",
        "--command",
        sql,
        "--config",
        join(working, "wrangler.jsonc"),
        "--env-file",
        join(working, "empty.env"),
      ],
      {
        cwd: working,
        env: environment(config, working),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      },
    );
    let aborted = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const chunks: Buffer[] = [];
    const signal = (name: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, name);
        } catch {
          /* The process group may already have exited. */
        }
    };
    const stop = () => {
      if (aborted) return;
      aborted = true;
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 200);
    };
    const timer = setTimeout(stop, 60_000);
    cancellation?.addEventListener("abort", stop, { once: true });
    if (cancellation?.aborted) stop();
    child.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 16 * 1024 * 1024) stop();
      else if (!aborted) chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 16 * 1024) stop();
    });
    child.on("close", (code) => {
      cancellation?.removeEventListener("abort", stop);
      clearTimeout(timer);
      if (escalation) {
        clearTimeout(escalation);
        signal("SIGKILL");
      }
      if (aborted || code !== 0) reject(failed());
      else resolve(Buffer.concat(chunks));
    });
  });
  const response: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(stdout),
  );
  if (
    !Array.isArray(response) ||
    response.length !== 1 ||
    !object(response[0]) ||
    response[0].success !== true ||
    !Array.isArray(response[0].results) ||
    response[0].results.length !== 1 ||
    !object(response[0].results[0]) ||
    Object.keys(response[0].results[0]).length !== 1 ||
    typeof response[0].results[0].snapshot_json !== "string" ||
    Buffer.byteLength(response[0].results[0].snapshot_json, "utf8") > 2_000_000
  )
    throw failed();
  return response[0].results[0].snapshot_json;
}

export async function captureD1(
  config: ControlRecoveryD1Config,
  cancellation?: AbortSignal,
): Promise<ControlSnapshot> {
  let working: string | null = null;
  let snapshot: ControlSnapshot | null = null;
  let unsuccessful = false;
  try {
    configuration(config);
    if (process.platform !== "linux" && process.platform !== "darwin")
      throw failed();
    const [wrangler, empty] = await Promise.all([
      privateFile(config.wranglerConfigFile, 256 * 1024),
      privateFile(config.emptyEnvFile, 0),
    ]);
    validateWrangler(wrangler, config);
    if (empty.length !== 0) throw failed();
    const parent = await privateDirectory(dirname(config.wranglerConfigFile));
    working = await mkdtemp(join(parent, ".pgcf-d1-capture-"));
    await chmod(working, 0o700);
    await writePrivate(join(working, "wrangler.jsonc"), wrangler);
    await writePrivate(join(working, "empty.env"), empty);
    const capturedWorking = working;
    let invoked = false;
    snapshot = await captureControlSnapshot(
      async (sql) => {
        if (invoked) throw failed();
        invoked = true;
        return query(config, capturedWorking, sql, cancellation);
      },
      config.migrationDirectory,
      config.source,
      new Date().toISOString(),
    );
  } catch {
    unsuccessful = true;
  }
  if (working)
    try {
      await rm(working, { recursive: true, force: true });
    } catch {
      /* Never expose private paths or provider output in cleanup failures. */
      unsuccessful = true;
    }
  if (unsuccessful || snapshot === null) throw failed();
  return snapshot;
}
