// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BootstrapJob, canonical, digest } from "../src/bootstrap.ts";
import { authority, fixture } from "./fixture.ts";

function coreDNSFixture() {
  const input = fixture();
  const current = authority(input);
  const clusterUID = randomUUID();
  const material = {
    version: 1 as const,
    cluster_name: input.spec.cluster_name,
    cluster_endpoint: input.spec.cluster_endpoint,
    talos_version: "1.14.1" as const,
    kubernetes_version: "1.36.3" as const,
    talos_machine_secrets_yaml: randomUUID(),
    talos_admin_config: randomUUID(),
    kube_system_uid: clusterUID,
    kubeconfig: randomUUID(),
  };
  current.protected_material = { purpose: "join_bundle", material };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "coredns",
      namespace: "kube-system",
      uid: randomUUID(),
      resourceVersion: "41",
    },
    spec: {
      template: {
        spec: {
          tolerations: [
            {
              key: "node-role.kubernetes.io/control-plane",
              operator: "Exists",
              effect: "NoSchedule",
            },
          ],
        },
      },
    },
  };
  return { input, current, clusterUID, material, deployment };
}

test("CoreDNS bootstrap appends only the exact quarantine toleration using a private patch file and reads back a lost response", async (t) => {
  const state = coreDNSFixture();
  let patches = 0;
  let patchFile = "";
  const directory = await mkdtemp(join(tmpdir(), "pgcf-coredns-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = structuredClone(
    state.deployment.spec.template.spec.tolerations,
  );
  const job = new BootstrapJob(state.input, {
    request: async () => Response.json(state.current),
    run: async (command) => {
      if (command.args.includes("namespace"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({ metadata: { uid: state.clusterUID } }),
        };
      if (command.args.includes("patch")) {
        patches++;
        patchFile = command.args
          .find((arg) => arg.startsWith("--patch-file="))!
          .slice("--patch-file=".length);
        assert.equal(command.stdin, undefined);
        assert.equal((await stat(patchFile)).mode & 0o777, 0o600);
        assert.equal(patchFile.startsWith(`${directory}/`), true);
        const patch = JSON.parse(await readFile(patchFile, "utf8")) as Array<{
          op: string;
          path: string;
          value?: unknown;
        }>;
        assert.deepEqual(patch.slice(0, 2), [
          {
            op: "test",
            path: "/metadata/uid",
            value: state.deployment.metadata.uid,
          },
          { op: "test", path: "/metadata/resourceVersion", value: "41" },
        ]);
        assert.equal(patch[2]?.op, "add");
        assert.equal(patch[2]?.path, "/spec/template/spec/tolerations/-");
        state.deployment.spec.template.spec.tolerations.push(
          patch[2]!.value as { key: string; operator: string; effect: string },
        );
        state.deployment.metadata.resourceVersion = "42";
        throw new Error("patch response lost");
      }
      return { exit_code: 0, stdout: JSON.stringify(state.deployment) };
    },
  });
  Reflect.set(job, "directory", directory);
  await Reflect.get(job, "ensureCoreDNSQuarantineToleration").call(
    job,
    state.clusterUID,
  );
  assert.equal(patches, 1);
  await assert.rejects(readFile(patchFile), { code: "ENOENT" });
  assert.deepEqual(
    state.deployment.spec.template.spec.tolerations.slice(0, 1),
    previous,
  );
  assert.deepEqual(state.deployment.spec.template.spec.tolerations[1], {
    key: "pgcf.io/quarantine",
    operator: "Equal",
    value: "bootstrap",
    effect: "NoSchedule",
  });
  await Reflect.get(job, "ensureCoreDNSQuarantineToleration").call(
    job,
    state.clusterUID,
  );
  assert.equal(patches, 1);
});

test("CoreDNS bootstrap rejects a replacement Deployment during readback", async (t) => {
  const state = coreDNSFixture();
  const directory = await mkdtemp(join(tmpdir(), "pgcf-coredns-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let patches = 0;
  const job = new BootstrapJob(state.input, {
    request: async () => Response.json(state.current),
    run: async (command) => {
      if (command.args.includes("namespace"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({ metadata: { uid: state.clusterUID } }),
        };
      if (command.args.includes("patch")) {
        patches++;
        state.deployment.metadata.uid = randomUUID();
        return { exit_code: 0, stdout: "" };
      }
      return { exit_code: 0, stdout: JSON.stringify(state.deployment) };
    },
  });
  Reflect.set(job, "directory", directory);
  await assert.rejects(
    async () =>
      Reflect.get(job, "ensureCoreDNSQuarantineToleration").call(
        job,
        state.clusterUID,
      ),
    /coredns_identity_mismatch/,
  );
  assert.equal(patches, 1);
});

test("joining workers never query or patch the existing CoreDNS Deployment", async () => {
  const state = coreDNSFixture();
  const spec = {
    ...state.input.spec,
    role: "worker" as const,
    cluster_uid: state.clusterUID,
    join_bundle_sha256: digest(canonical(state.material)),
  };
  const input = {
    ...state.input,
    spec,
    input_hash: digest(canonical(spec)),
    join_bundle: state.material,
  };
  let calls = 0;
  const job = new BootstrapJob(input, {
    request: async () => {
      calls++;
      throw new Error("worker contacted CoreDNS");
    },
    run: async () => {
      calls++;
      throw new Error("worker patched CoreDNS");
    },
  });
  await Reflect.get(job, "ensureCoreDNSQuarantineToleration").call(
    job,
    state.clusterUID,
  );
  await Reflect.get(job, "installPlatform").call(job);
  assert.equal(calls, 0);
});
