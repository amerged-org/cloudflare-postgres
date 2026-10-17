// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function command(
  program: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let tooLarge = false;
    // Discard stderr: tools may include credentials or server-provided text in errors.
    child.stderr!.resume();
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(
      stop,
      Math.min(options.timeoutMs ?? 60_000, 540_000),
    );
    child.stdout!.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
      if (stdout.length > 16_000_000) {
        tooLarge = true;
        stop();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new HarnessError("command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) reject(new HarnessError("command_failed"));
      else resolve(stdout);
    });
  });
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError("invalid_response");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new HarnessError("invalid_response");
  return value;
}
