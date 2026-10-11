// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as proof from "./run-proof.ts";
import { test } from "node:test";
import { proofDockerArguments } from "./run-proof.ts";

test("failed child preserves its exit or deadline while published metadata omits private output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-proof-failure-test-"));
  try {
    const invoke = Reflect.get(proof, "invokeProofDocker"),
      receipt = Reflect.get(proof, "sandboxProofFailure");
    assert.equal(typeof invoke, "function", "child exit details are discarded");
    assert.equal(typeof receipt, "function");
    const child = new EventEmitter();
    Reflect.set(child, "kill", () => true);
    const simulateExit = (() => {
      queueMicrotask(() => child.emit("close", 73, null));
      return child;
    }) as unknown as typeof spawn;
    const pending = invoke([], join(directory, "child.private.log"), 1000, simulateExit);
    const result = await pending;
    assert.equal(result.exit_code, 73);
    assert.equal(result.signal, null);
    assert.equal(result.timed_out, false);
    assert.ok(result.elapsed_ms >= 0);

    const timed = new EventEmitter();
    Reflect.set(timed, "kill", (signal: string) => {
      queueMicrotask(() => timed.emit("close", null, signal));
      return true;
    });
    const timeout = await invoke(
      [],
      join(directory, "timeout.private.log"),
      1,
      (() => timed) as unknown as typeof spawn,
    );
    assert.equal(timeout.exit_code, null);
    assert.equal(timeout.signal, "SIGKILL");
    assert.equal(timeout.timed_out, true);

    const log = join(directory, "runtime.private.log"),
      privateOutput = "private-key-sentinel\nRead-only file system (os error 30)";
    await writeFile(log, privateOutput, { mode: 0o600 });
    const safe = await receipt(result, log, {
      exit_code: 73,
      oom_killed: false,
      status: "exited",
    });
    assert.equal(safe.invocation.exit_code, 73);
    assert.equal(safe.error_class, "errno_EROFS");
    assert.equal(safe.runtime_log.bytes, Buffer.byteLength(privateOutput));
    assert.match(safe.runtime_log.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(safe), /private-key-sentinel|Read-only|error 30/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("kernel proof executes debug tests without an unused workspace release build", async () => {
  const dockerfile = await readFile(
    new URL("../../../apps/node-runtime/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(dockerfile, /cargo build --workspace --release\b/);
  for (const command of [
    "cargo fmt --all -- --check",
    "cargo test --workspace --locked",
    "cargo clippy --workspace --all-targets --locked -- -D warnings",
    "find target/debug/deps -maxdepth 1 -type f -name 'kernel_assignment-*' -perm -111",
    "-exec cp '{}' /usr/local/bin/pgcf-slot-kernel-test ';'",
  ])
    assert.ok(dockerfile.includes(command));
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["\/usr\/local\/bin\/pgcf-slot-kernel-test"\]$/m,
  );
  assert.match(
    dockerfile,
    /^CMD \["--ignored", "--test-threads=1", "--nocapture"\]$/m,
  );
});

test("public kernel proof is bounded with private cgroups, no network or workstation mounts/devices/socket", () => {
  const args = proofDockerArguments("fixture-image", "fixture-container");
  for (const [flag, value] of [
    ["--platform", "linux/amd64"],
    ["--network", "none"],
    ["--cgroupns", "private"],
    ["--memory", "768m"],
    ["--cpus", "2"],
    ["--pids-limit", "256"],
  ])
    assert.equal(args[args.indexOf(flag!) + 1], value);
  assert.ok(args.includes("--privileged"));
  assert.ok(
    !args.some(
      (value) =>
        ["--mount", "--volume", "-v", "--device"].includes(value) ||
        value.includes("docker.sock"),
    ),
  );
  assert.deepEqual(args.slice(-1), ["fixture-image"]);
});
