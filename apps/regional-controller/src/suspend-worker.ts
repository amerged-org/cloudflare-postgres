// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readSuspendConfiguration } from "./suspend-cli.ts";
import { SuspendClient } from "./suspend-client.ts";

export interface SuspendWorkerOptions {
  pollMilliseconds: number;
  signal: AbortSignal;
  environment: NodeJS.ProcessEnv;
  log(event: string): void;
}
// Internal first-party test seam. The public CLI never selects an executable,
// entry point, environment override, or alternate child from caller input.
interface Dependencies {
  spawnChild?: (
    executable: string,
    arguments_: string[],
    options: SpawnOptions,
  ) => ChildProcess;
}
const childEntry = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js",
    import.meta.url,
  ),
);
const outputBound = 65_536;
// Leave time for TERM, KILL and actual closure inside the outer 310-second bound.
const childDeadline = 302_000;
const terminationGrace = 5_000;
const closureDeadline = 310_000;

function snapshot(info: Awaited<ReturnType<typeof lstat>>) {
  return JSON.stringify({
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
    size: info.size,
    mtime: info.mtimeMs,
    ctime: info.ctimeMs,
  });
}
async function configurationPin(path: string) {
  const before = await lstat(path);
  const configuration = await readSuspendConfiguration(path);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.byteLength > 65_536 || snapshot(before) !== snapshot(after))
    throw new Error("suspend_worker_configuration_changed");
  return {
    configuration,
    identity: snapshot(after),
    bytesHash: createHash("sha256").update(bytes).digest("hex"),
  };
}
async function privateJournalDirectory(
  path: string,
  create = false,
): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      !create ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    // Create only the exact configured child of an existing trusted parent.
    // Never repair permissions, recursively manufacture a mount, or use /tmp.
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o002) !== 0 ||
      (process.getuid && parent.uid !== 0 && parent.uid !== process.getuid())
    )
      throw new Error("suspend_worker_journal_parent_invalid");
    await mkdir(path, { mode: 0o700 });
    info = await lstat(path);
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("suspend_worker_journal_not_private");
  return JSON.stringify({
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
  });
}
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const origin = environment.PGCF_CONTROL_ORIGIN;
  const region = environment.PGCF_REGION_ID;
  const tokenFile = environment.PGCF_REGION_TOKEN_FILE;
  if (!origin || !region || !tokenFile || !isAbsolute(tokenFile))
    throw new Error("suspend_worker_configuration_invalid");
  // Reuse the actual client's origin/region validation without reading a token
  // or submitting a request. Children reload the token file on every request.
  new SuspendClient(origin, region, async () => "");
  return {
    PGCF_CONTROL_ORIGIN: origin,
    PGCF_REGION_ID: region,
    PGCF_REGION_TOKEN_FILE: tokenFile,
    LANG: "C.UTF-8",
    TZ: "UTC",
  };
}
type ChildOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array[];
  interruption: "aborted" | "timeout" | "output_bound" | null;
};
async function superviseChild(
  path: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  spawnChild: NonNullable<Dependencies["spawnChild"]>,
): Promise<ChildOutcome> {
  signal.throwIfAborted();
  const child = spawnChild(
    process.execPath,
    [childEntry, "run-suspend", "--config", path],
    {
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    },
  );
  return new Promise((resolve, reject) => {
    let interruption: ChildOutcome["interruption"] = null;
    let bytes = 0;
    const stdout: Uint8Array[] = [];
    let killing: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    const killGroup = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, value);
      } catch {
        /* Absence is resolved only by the child's actual close event. */
      }
    };
    const terminate = (reason: NonNullable<ChildOutcome["interruption"]>) => {
      if (completed) return;
      if (reason === "output_bound" || interruption === null)
        interruption = reason;
      if (killing) return;
      killGroup("SIGTERM");
      killing = setTimeout(() => killGroup("SIGKILL"), terminationGrace);
    };
    const aborted = () => terminate("aborted");
    const deadline = setTimeout(() => terminate("timeout"), childDeadline);
    const closure = setTimeout(() => {
      if (completed) return;
      completed = true;
      killGroup("SIGKILL");
      clearTimeout(deadline);
      if (killing) clearTimeout(killing);
      signal.removeEventListener("abort", aborted);
      // No subsequent child may run when closure is unproven. Release local
      // handles only so this failing service can report and exit to its owner.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(new Error("suspend_worker_child_close_unconfirmed"));
    }, closureDeadline);
    child.on("error", () => {
      /* Generic close classification follows; no raw error output. */
    });
    const output = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.byteLength;
      if (bytes > outputBound) {
        terminate("output_bound");
        return;
      }
      if (keep) stdout.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => output(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => output(chunk, false));
    child.once("close", (code, closedSignal) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      clearTimeout(closure);
      if (killing) clearTimeout(killing);
      if (interruption) killGroup("SIGKILL");
      signal.removeEventListener("abort", aborted);
      resolve({ code, signal: closedSignal, stdout, interruption });
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
function status(outcome: ChildOutcome): string | null {
  if (outcome.signal !== null) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(outcome.stdout))
        .trim(),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const input = value as Record<string, unknown>;
    if (input.mode !== "environment-suspend") return null;
    if (Object.keys(input).length === 2 && outcome.code === 0) {
      if (input.status === "no_work") return "suspend_worker_no_work";
      if (input.status === "suspended") return "suspend_worker_suspended";
    }
    if (
      Object.keys(input).length === 3 &&
      input.status === "deferred" &&
      (outcome.code === 1 || outcome.code === 2) &&
      input.error &&
      typeof input.error === "object" &&
      !Array.isArray(input.error)
    ) {
      const error = input.error as Record<string, unknown>;
      if (
        Object.keys(error).length === 1 &&
        [
          "physical_verification_pending",
          "suspend_execution_deferred",
          "suspend_journal_close_failed",
        ].includes(String(error.code))
      )
        return "suspend_worker_deferred";
    }
  } catch {
    /* Raw output is never a log message or an execution authority. */
  }
  return null;
}
export async function serveSuspendWorker(
  path: string,
  options: SuspendWorkerOptions,
  dependencies: Dependencies = {},
): Promise<number> {
  if (
    !isAbsolute(path) ||
    !Number.isSafeInteger(options.pollMilliseconds) ||
    options.pollMilliseconds < 1000 ||
    options.pollMilliseconds > 60_000 ||
    process.platform === "win32"
  ) {
    options.log("suspend_worker_configuration_invalid");
    return 2;
  }
  let pin;
  let journalIdentity: string;
  let environment: NodeJS.ProcessEnv;
  try {
    environment = childEnvironment(options.environment);
    pin = await configurationPin(path);
    journalIdentity = await privateJournalDirectory(
      pin.configuration.journalDirectory,
      true,
    );
  } catch {
    options.log("suspend_worker_configuration_invalid");
    return 2;
  }
  const unchanged = async () => {
    const current = await configurationPin(path);
    if (
      current.identity !== pin.identity ||
      current.bytesHash !== pin.bytesHash ||
      (await privateJournalDirectory(pin.configuration.journalDirectory)) !==
        journalIdentity
    )
      throw new Error("suspend_worker_configuration_changed");
  };
  const spawnChild =
    dependencies.spawnChild ??
    ((executable, arguments_, childOptions) =>
      spawn(executable, arguments_, childOptions));
  while (!options.signal.aborted) {
    try {
      await unchanged();
    } catch {
      options.log("suspend_worker_configuration_changed");
      return 2;
    }
    let outcome;
    try {
      outcome = await superviseChild(
        path,
        environment,
        options.signal,
        spawnChild,
      );
    } catch (error) {
      if (
        options.signal.aborted &&
        (!(error instanceof Error) ||
          error.message !== "suspend_worker_child_close_unconfirmed")
      )
        return 0;
      options.log("suspend_worker_child_close_unconfirmed");
      return 2;
    }
    if (outcome.interruption === "output_bound") {
      options.log("suspend_worker_output_bound");
      return 2;
    }
    if (options.signal.aborted) return 0;
    if (outcome.interruption === "timeout") {
      options.log("suspend_worker_child_timeout");
      return 2;
    }
    try {
      await unchanged();
    } catch {
      options.log("suspend_worker_configuration_changed");
      return 2;
    }
    const event = status(outcome);
    if (!event) {
      options.log("suspend_worker_child_protocol_invalid");
      return 2;
    }
    options.log(event);
    try {
      await pause(options.pollMilliseconds, undefined, {
        signal: options.signal,
      });
    } catch {
      if (!options.signal.aborted) {
        options.log("suspend_worker_poll_failed");
        return 2;
      }
    }
  }
  return 0;
}
export async function runSuspendWorker(arguments_: string[]): Promise<number> {
  const log = (event: string) =>
    process.stdout.write(
      `${JSON.stringify({ mode: "suspend-worker", event })}\n`,
    );
  if (
    (arguments_.length !== 2 && arguments_.length !== 4) ||
    arguments_[0] !== "--config" ||
    !arguments_[1] ||
    (arguments_.length === 4 &&
      (arguments_[2] !== "--poll-milliseconds" ||
        !/^\d+$/.test(arguments_[3] ?? "")))
  ) {
    log("suspend_worker_arguments_invalid");
    return 2;
  }
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await serveSuspendWorker(arguments_[1], {
      pollMilliseconds: arguments_.length === 4 ? Number(arguments_[3]) : 5000,
      signal: shutdown.signal,
      environment: process.env,
      log,
    });
  } finally {
    shutdown.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
