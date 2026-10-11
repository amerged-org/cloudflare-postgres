// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { runRegionAuthorityRotation } from "../src/region-authority-rotation.ts";
import type { FleetRegionMaterialRotationInput } from "@pgcf/contracts/region-material-rotation";
import { rotationInputFixture } from "./region-authority.fixture.ts";
import type { CommandRunner } from "../src/bootstrap.ts";
import type { openTalosOperator } from "../src/talos-operator.ts";
function setup() {
  const old = [
      {
        version: "v1alpha1",
        machine: { type: "controlplane", token: "old-trustd" },
        cluster: { token: "aaaaaa.aaaaaaaaaaaaaaaa" },
      },
      { kind: "DiscoveryIdentityConfig", clusterID: "same-cluster" },
      {
        kind: "KubeClusterConfig",
        clusterName: "test-cluster",
        endpoint: "https://192.0.2.1:6443",
      },
    ],
    next = structuredClone(old);
  (next[0]!.machine as { type: string; token: string }).token = "new-trustd";
  const input = rotationInputFixture(),
    cluster = input.cluster_uid,
    node = input.nodes[0]!.node_uid,
    captured: FleetRegionMaterialRotationInput["checkpoint"][] = [];
  let live = old,
    apply = 0,
    invalid = false,
    validator: ((args: string[]) => Promise<number>) | undefined;
  const run: CommandRunner = async (command) => {
      if (command.args[0] === "gen") {
        const out = command.args[command.args.indexOf("--output") + 1]!;
        await writeFile(
          out,
          (out.includes("prior-") ? old : next)
            .map((d) => stringify(d))
            .join("---\n"),
          { mode: 0o600 },
        );
        return { exit_code: 0, stdout: "" };
      }
      if (command.args[0] === "validate")
        return {
          exit_code: validator
            ? await validator(command.args)
            : invalid
              ? 1
              : 0,
          stdout: "",
        };
      if (command.args.includes("apply-config")) {
        apply++;
        throw Error("command_timeout");
      }
      if (command.args.includes("machineconfig"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            node: "192.0.2.1",
            spec: live.map((d) => stringify(d)).join("---\n"),
          }),
        };
      throw Error("unexpected_command");
    },
    request: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      captured.push(body.checkpoint);
      return Response.json({
        checkpoint: body.checkpoint,
        bearer: "y".repeat(32),
      });
    },
    openOperator = (async (options) => ({
      talosPath: options.talosconfig,
      outputDir: options.outputDir,
      verify: async () => undefined,
      close: async () => undefined,
      binding: {
        node_uid: node,
        cluster_uid: cluster,
        node_name: "node",
        material_revision: 1,
      },
      carrier: { physical: { bootId: "33333333-3333-4333-8333-333333333333" } },
    })) as typeof openTalosOperator;
  return {
    input,
    captured,
    run,
    request,
    openOperator,
    apply: () => apply,
    invalid: () => {
      invalid = true;
    },
    commitLate: () => {
      live = next;
    },
    liveFiles: () => {
      live = old.map((d) =>
        d.version === "v1alpha1"
          ? {
              ...d,
              machine: {
                ...d.machine,
                files: [{ path: "/var/etc/x", content: "x", op: "create" }],
              },
            }
          : d,
      );
    },
    validate: (check: (args: string[]) => Promise<number>) => {
      validator = check;
    },
  };
}
// talosctl 1.14 --strict rejects the deprecated .machine.files, which host configuration writes.
const strictRejectsFiles = (seen: string[][]) => async (args: string[]) => {
  seen.push(args);
  const text = await readFile(args[args.indexOf("--config") + 1]!, "utf8");
  return args.includes("--strict") && /\n\s+files:/.test(text) ? 1 : 0;
};
test("a candidate whose only strict finding is the deprecated machine.files is applied", async () => {
  const f = setup(),
    seen: string[][] = [];
  f.liveFiles();
  f.validate(strictRejectsFiles(seen));
  await assert.rejects(runRegionAuthorityRotation(f.input, f));
  assert.deepEqual(
    seen.map((args) => args.includes("--strict")),
    [true, false, true],
  );
  const stripped = seen[2]![seen[2]!.indexOf("--config") + 1]!;
  assert.match(stripped, /without-files/);
  await assert.rejects(access(stripped));
  assert.equal(f.apply(), 1);
  assert.equal(
    f.captured.some((c) => c.state === "dispatched"),
    true,
  );
});
test("any other strict finding still rejects a candidate with machine.files", async () => {
  const f = setup(),
    seen: string[][] = [];
  f.liveFiles();
  f.validate(async (args) => {
    seen.push(args);
    return args.includes("--strict") ? 1 : 0;
  });
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_candidate_validation_failed/,
  );
  assert.equal(seen.length, 3);
  assert.equal(f.apply(), 0);
  assert.equal(
    f.captured.some((c) => c.state === "dispatched"),
    false,
  );
});
test("invalid candidates never consume a native apply dispatch", async () => {
  const f = setup();
  f.invalid();
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_candidate_validation_failed/,
  );
  assert.equal(f.apply(), 0);
  assert.equal(
    f.captured.some((c) => c.state === "dispatched"),
    false,
  );
});
test("an uncertain config apply is read-only on resume and a late target readback completes the same phase", async () => {
  const f = setup();
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_apply_unresolved_no_replay/,
  );
  assert.equal(f.apply(), 1);
  f.input.checkpoint = f.captured.at(-1)!;
  await assert.rejects(
    runRegionAuthorityRotation(f.input, f),
    /rotation_apply_unresolved_no_replay/,
  );
  assert.equal(f.apply(), 1);
  f.input.checkpoint = f.captured.at(-1)!;
  f.commitLate();
  await runRegionAuthorityRotation(f.input, f);
  assert.equal(f.apply(), 1);
  assert.equal(f.captured.at(-1)!.state, "confirmed");
});
