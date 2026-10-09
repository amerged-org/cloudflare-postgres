// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { proofDockerArguments } from "./run-proof.ts";

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
