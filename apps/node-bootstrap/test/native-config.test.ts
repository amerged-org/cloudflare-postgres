// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeBootstrapCallback } from "@pgcf/contracts/node-bootstrap";
import { BootstrapJob, canonical, runCommand } from "../src/bootstrap.ts";
import { authority, fixture } from "./fixture.ts";

const client = process.env.PGCF_TEST_TALOSCTL;
test("pinned native client generates and validates both roles while recovered seed keys remain identical", async () => {
  assert.ok(
    client,
    "PGCF_TEST_TALOSCTL must select the checksum-verified Talos 1.14.1 client",
  );
  const input = fixture();
  let current = authority(input);
  let generated = 0;
  const directory = await mkdtemp(join(tmpdir(), "pgcf-native-test-"));
  await chmod(directory, 0o700);
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      const envelope = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (envelope.kind === "seal") {
        current = {
          ...current,
          revision: current.revision + 1,
          protected_material: envelope.payload,
          checkpoint: { ...current.checkpoint, sealed_ref: randomUUID() },
        };
      } else if (envelope.kind === "checkpoint") {
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: envelope.payload,
        };
      }
      return Response.json(current);
    },
    run: async (command) => {
      assert.equal(command.executable, "talosctl");
      if (command.args.includes("secrets")) generated++;
      const result = await runCommand({ ...command, executable: client });
      if (result.exit_code && command.args.includes("validate")) {
        const diagnostic = spawnSync(client, command.args, {
          encoding: "utf8",
          timeout: 60_000,
          env: command.env,
        });
        const names = [
          "deprecated",
          "network",
          "hostname",
          "nodeLabels",
          "nodeTaints",
          "KubeNodeConfig",
          "ResolverConfig",
          "VolumeConfig",
          "EPHEMERAL",
          "systemReserved",
          "kubeReserved",
          "gateway",
          "invalid",
          "unknown",
          "taint",
          "disk",
          "endpoint",
          "install",
          "taint",
          "cloud",
          "controlplane",
          "kubelet",
          "cidr",
          "san",
          "registry",
          "error",
        ];
        assert.fail(
          `native validation diagnostic categories: ${names.filter((name) => (diagnostic.stderr + diagnostic.stdout).includes(name)).join(",")}`,
        );
      }
      return result;
    },
  });
  Reflect.set(job, "directory", directory);
  Reflect.set(job, "env", {
    PATH: process.env.PATH,
    LANG: "C",
    TMPDIR: directory,
  });
  try {
    await Reflect.get(job, "prepareConfig").call(job, current);
    assert.equal(current.protected_material?.purpose, "region_seed");
    const first = current.protected_material;
    await Reflect.get(job, "prepareConfig").call(job, current);
    assert.equal(generated, 1);
    assert.ok(canonical(current.protected_material) === canonical(first));
    const roleValidation = await runCommand({
      executable: client,
      args: [
        "validate",
        "--mode",
        "cloud",
        "--strict",
        "--config",
        join(directory, "worker.yaml"),
      ],
      signal: AbortSignal.timeout(60_000),
      timeout_ms: 60_000,
      env: { PATH: process.env.PATH, LANG: "C", TMPDIR: directory },
    });
    assert.equal(roleValidation.exit_code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
