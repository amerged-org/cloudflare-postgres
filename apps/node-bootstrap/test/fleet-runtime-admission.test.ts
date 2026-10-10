// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import generated from "../../../packages/contracts/native/compute-pool.generated.json" with { type: "json" };
import {
  ComputePoolPolicyState,
  ComputePoolObservation,
} from "@pgcf/contracts/compute-pool";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { canonical, digest } from "../src/bootstrap.ts";
import {
  readRuntimeAdmission,
  applyRuntimeAdmission,
  refreshRuntimeAdmissionObservation,
  type RuntimeAdmissionInput,
} from "../src/fleet-runtime-admission.ts";
function fixture() {
  const base = patchFixture().input,
    profile = {
      ...generated.lease.policy.profile,
      release_id: base.status.release_id,
    },
    now = new Date().toISOString(),
    pool = ComputePoolPolicyState.parse({
      node_id: base.status.node_id,
      node_uid: base.status.node_uid,
      region_id: base.status.region_id,
      revision: 1,
      policy: { ...generated.lease.policy, target_slots: 0, profile },
      updated_at: now,
    }),
    image = {
      name: "image/cloudnative-pg/cloudnative-pg",
      kind: "image" as const,
      reference: `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
      version: "1.30.1",
    },
    input: RuntimeAdmissionInput = {
      ...base,
      spec: { ...base.spec, components: [...base.spec.components, image] },
      compute_pool: pool,
      compute_pool_observation: ComputePoolObservation.parse({
        node_id: pool.node_id,
        node_uid: pool.node_uid,
        policy_revision: 1,
        material_revision: 1,
        observed_at: now,
        profile,
        idle_memory_current_bytes: 0,
        idle_cpu_usage_usec: 0,
        slots: [],
      }),
      host_configuration: {
        status: {
          version: 1,
          node_id: pool.node_id,
          node_uid: pool.node_uid,
          region_id: pool.region_id,
          cluster_uid: base.status.cluster_uid,
          material_revision: 1,
          revision: 1,
          sha256: "a".repeat(64),
          release_id: base.status.release_id,
          pool_policy_revision: 1,
          profile_sha256: digest(canonical(profile)),
          created_at: now,
        },
        files: [
          {
            path: "/var/lib/pgcf-sandbox/settings.json",
            permissions: 384,
            content: "fixture",
          },
          {
            path: "/var/lib/pgcf-sandbox/agent-key",
            permissions: 384,
            content: "fixture",
          },
        ],
      },
    },
    node = {
      metadata: {
        uid: base.status.node_uid,
        resourceVersion: "1",
        labels: {
          "pgcf.io/node-id": base.status.node_id,
          "pgcf.io/region": base.status.region_id,
          "openebs.io/nodeid": "preserved",
        } as Record<string, string>,
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    deployment = {
      metadata: {
        generation: 1,
        annotations: {
          "meta.helm.sh/release-name": "cloudnative-pg",
          "meta.helm.sh/release-namespace": "cnpg-system",
        },
      },
      spec: {
        replicas: 1,
        template: {
          spec: {
            serviceAccountName: "cloudnative-pg",
            containers: [{ image: image.reference }],
          },
        },
      },
      status: {
        observedGeneration: 1,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
      },
    },
    objects = new Map<string, Record<string, unknown>>();
  let writes = 0,
    loseApply = false;
  const commands = {
    authorize: async () => {},
    kube: async (args: string[], stdin?: string) => {
      if (args[0] === "get") {
        if (args[1] === "node") return JSON.stringify(node);
        if (args[1] === "deployment") return JSON.stringify(deployment);
        return JSON.stringify(
          objects.get(
            (
              {
                "runtimeclass.node.k8s.io": "RuntimeClass",
                "mutatingadmissionpolicy.admissionregistration.k8s.io":
                  "MutatingAdmissionPolicy",
                "mutatingadmissionpolicybinding.admissionregistration.k8s.io":
                  "MutatingAdmissionPolicyBinding",
              } as Record<string, string>
            )[args[1]!] +
              "/" +
              args[2]!,
          ) ?? null,
        ).replace(/^null$/, "");
      }
      if (args[0] === "apply") {
        const value = JSON.parse(stdin!) as Record<string, unknown>;
        if (args.includes("--dry-run=server")) return JSON.stringify(value);
        (value.metadata as Record<string, unknown>).uid =
          "uid-" + String(objects.size);
        writes++;
        objects.set(
          value.kind + "/" + (value.metadata as { name: string }).name,
          value,
        );
        if (loseApply) {
          loseApply = false;
          throw Error("lost apply response");
        }
        return JSON.stringify(value);
      }
      assert.equal(args[0], "patch");
      const path = args
        .find((value) => value.startsWith("--patch-file="))!
        .slice("--patch-file=".length);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const patch = JSON.parse(await readFile(path, "utf8"));
      if (args[1] !== "node") {
        const key =
          (
            {
              "runtimeclass.node.k8s.io": "RuntimeClass",
              "mutatingadmissionpolicy.admissionregistration.k8s.io":
                "MutatingAdmissionPolicy",
              "mutatingadmissionpolicybinding.admissionregistration.k8s.io":
                "MutatingAdmissionPolicyBinding",
            } as Record<string, string>
          )[args[1]!] +
          "/" +
          args[2];
        const existing = objects.get(key)!;
        for (const entry of patch) {
          const path = entry.path.slice(1).split("/");
          let parent = existing;
          for (const part of path.slice(0, -1))
            parent = parent[part] as Record<string, unknown>;
          const leaf = path.at(-1)!;
          if (entry.op === "test") assert.deepEqual(parent[leaf], entry.value);
          else if (!args.includes("--dry-run=server"))
            parent[leaf] = entry.value;
        }
        if (!args.includes("--dry-run=server")) writes++;
        return JSON.stringify(existing);
      }
      assert.equal(patch[0].value, node.metadata.uid);
      assert.deepEqual(patch[1].value, node.metadata.labels);
      assert(
        !patch.some((value: { path: string }) =>
          value.path.includes("resourceVersion"),
        ),
      );
      node.metadata.resourceVersion = String(
        Number(node.metadata.resourceVersion) + 1,
      ); // Real kubelet heartbeats may change status between dry-run/apply.
      if (!args.includes("--dry-run=server")) {
        writes++;
        node.metadata.labels = patch[2].value;
      }
      return JSON.stringify(node);
    },
  };
  return {
    input,
    node,
    deployment,
    objects,
    commands,
    writes: () => writes,
    loseNextApply: () => {
      loseApply = true;
    },
  };
}
test("fixed managed CNPG activation is real-state gated, target0 needs no idle holder and preserves unrelated Node labels across heartbeats", async () => {
  const f = fixture();
  delete f.node.metadata.labels["pgcf.io/region"]; // Actual retained control-node metadata.
  f.input.compute_pool.revision = 2;
  f.input.compute_pool_observation.policy_revision = 2; // Target-only policy changes preserve host files.
  f.deployment.spec.template.spec.containers[0]!.image =
    f.deployment.spec.template.spec.containers[0]!.image.replace(
      ":1.30.1@",
      "@",
    );
  assert.equal(
    (await readRuntimeAdmission(f.commands, f.input)).confirmed,
    false,
  );
  await applyRuntimeAdmission(f.commands, f.input);
  assert.equal(
    (await readRuntimeAdmission(f.commands, f.input)).confirmed,
    true,
  );
  assert.equal(f.objects.size, 3);
  assert.equal(f.node.metadata.labels["openebs.io/nodeid"], "preserved");
  assert.equal(
    f.node.metadata.labels["pgcf.io/region"],
    f.input.status.region_id,
  );
  const count = f.writes();
  await applyRuntimeAdmission(f.commands, f.input);
  assert.equal(f.writes(), count);
});
test("a lost SSA response resumes from exact owned readback without repeating that mutation", async () => {
  const f = fixture();
  f.loseNextApply();
  await applyRuntimeAdmission(f.commands, f.input);
  assert.equal(f.objects.size, 1);
  await applyRuntimeAdmission(f.commands, f.input);
  assert.equal(f.writes(), 4);
  assert.equal(
    (await readRuntimeAdmission(f.commands, f.input)).confirmed,
    true,
  );
});
test("stale observations, wrong operator and unrelated fixed-object ownership fail before mutation", async () => {
  const f = fixture();
  f.input.compute_pool_observation.observed_at = new Date(
    Date.now() - 121000,
  ).toISOString();
  await assert.rejects(applyRuntimeAdmission(f.commands, f.input));
  assert.equal(f.writes(), 0);
  const wrong = fixture();
  wrong.deployment.spec.template.spec.serviceAccountName = "other";
  await assert.rejects(applyRuntimeAdmission(wrong.commands, wrong.input));
  assert.equal(wrong.writes(), 0);
  const owned = fixture();
  owned.objects.set("RuntimeClass/pgcf-prestarted", {
    metadata: { labels: { "pgcf.io/managed-by": "someone-else" } },
  });
  await assert.rejects(applyRuntimeAdmission(owned.commands, owned.input));
  assert.equal(owned.writes(), 0);
});

test("actuation refreshes the authenticated pool observation before its first read and preserves the old report", async () => {
  const f = fixture(),
    stale = {
      ...f.input.compute_pool_observation,
      observed_at: new Date(Date.now() - 139_457).toISOString(),
    },
    fresh = structuredClone(f.input.compute_pool_observation),
    facts = patchFixture().facts;
  f.input.compute_pool_observation = stale;
  const originalTimestamp = stale.observed_at;
  let authorizations = 0;
  f.commands.authorize = async () => {
    authorizations++;
    refreshRuntimeAdmissionObservation(
      f.input,
      {
        ...f.input.status,
        observed: facts,
        compute_pool_observation: fresh,
      },
      facts.boot_id,
    );
  };
  await applyRuntimeAdmission(f.commands, f.input);
  assert.ok(authorizations > 0);
  assert.equal(f.objects.size, 3);
  assert.equal(
    (await readRuntimeAdmission(f.commands, f.input)).confirmed,
    true,
  );
  assert.equal(stale.observed_at, originalTimestamp);
  assert.equal(f.input.compute_pool_observation.observed_at, fresh.observed_at);
});

test("a fresh callback cannot replace the selected boot or pool-policy authority", async () => {
  const f = fixture(),
    original = f.input.compute_pool_observation,
    report = structuredClone(f.input.compute_pool_observation),
    facts = patchFixture().facts;
  f.commands.authorize = async () => {
    refreshRuntimeAdmissionObservation(
      f.input,
      {
        ...f.input.status,
        observed: { ...facts, boot_id: "00000000-0000-4000-8000-000000000001" },
        compute_pool_observation: report,
      },
      facts.boot_id,
    );
  };
  await assert.rejects(
    applyRuntimeAdmission(f.commands, f.input),
    /patch_runtime_admission_conflict/,
  );
  assert.equal(f.writes(), 0);
  assert.equal(f.input.compute_pool_observation, original);
  report.policy_revision++;
  assert.throws(
    () =>
      refreshRuntimeAdmissionObservation(
        f.input,
        {
          ...f.input.status,
          observed: facts,
          compute_pool_observation: report,
        },
        facts.boot_id,
      ),
    /patch_runtime_admission_conflict/,
  );
  assert.equal(f.writes(), 0);
});

test("a qualified profile transition updates only the existing owned RuntimeClass fields and preserves its UID and unrelated scheduling", async () => {
  const f = fixture();
  await applyRuntimeAdmission(f.commands, f.input);
  const runtime = f.objects.get("RuntimeClass/pgcf-prestarted")!;
  (runtime.metadata as Record<string, unknown>).uid = "retained-runtime-uid";
  (runtime.scheduling as Record<string, unknown>).tolerations = [
    { key: "retained", operator: "Exists" },
  ];
  const priorProfile = f.input.host_configuration!.status.profile_sha256;
  f.input.compute_pool.policy.profile.holder_sha256 = "f".repeat(64);
  f.input.compute_pool_observation.profile = {
    ...f.input.compute_pool.policy.profile,
  };
  f.input.host_configuration!.status.profile_sha256 = digest(
    canonical(f.input.compute_pool.policy.profile),
  );
  f.input.compute_pool.policy.per_slot_memory_mib = 32;
  assert.notEqual(
    f.input.host_configuration!.status.profile_sha256,
    priorProfile,
  );
  assert.equal(
    (await readRuntimeAdmission(f.commands, f.input)).confirmed,
    false,
  );
  f.commands.authorize = async () => {
    for (const value of f.objects.values()) {
      const metadata = value.metadata as Record<string, unknown>;
      metadata.resourceVersion = String(
        Number(metadata.resourceVersion ?? 0) + 1,
      );
    }
  };
  await applyRuntimeAdmission(f.commands, f.input);
  assert.equal(
    (await readRuntimeAdmission(f.commands, f.input)).confirmed,
    true,
  );
  assert.equal(
    (runtime.metadata as Record<string, unknown>).uid,
    "retained-runtime-uid",
  );
  assert.deepEqual(
    (runtime.scheduling as Record<string, unknown>).tolerations,
    [{ key: "retained", operator: "Exists" }],
  );
});

test("an omitted CNPG readyReplicas is zero readiness and cannot activate shared runtime objects", async () => {
  const f = fixture();
  Reflect.deleteProperty(f.deployment.status, "readyReplicas");
  await assert.rejects(
    applyRuntimeAdmission(f.commands, f.input),
    /patch_runtime_admission_conflict/,
  );
  assert.equal(f.writes(), 0);
});
