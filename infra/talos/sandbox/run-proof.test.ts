// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { proofDockerArguments } from "./run-proof.ts";
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
