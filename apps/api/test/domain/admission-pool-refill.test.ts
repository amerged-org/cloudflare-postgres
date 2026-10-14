// SPDX-License-Identifier: Apache-2.0
// Real local D1 metadata only; this is not Kubernetes or Dev refill acceptance.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { bytesToHex } from "@pgcf/contracts";
import {
  PoolPodAttestation,
  PoolPodPreparationContext,
} from "@pgcf/contracts/postgres-pool";
import {
  servingPostgresPoolFixture,
  postgresPoolFixture,
} from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { recordPostgresPoolPreparationContext } from "../../src/domain/postgres-pool-preparation.ts";
import { recordPostgresPoolInventory } from "../../src/domain/postgres-pool-inventory.ts";

afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("refills one free slot alongside its immutable bound holder without charging the bound Pod as idle", async () => {
  const f = await servingPostgresPoolFixture({ thin: true });
  const before = await env.DB.prepare(
    "SELECT scope_json,scope_sha256,state FROM pool_bindings WHERE id=?",
  )
    .bind(f.binding.scope.binding_id)
    .first();
  const { free, context, inventory } = await refillInputs(f);
  expect(f.policy.target_slots).toBe(1);
  await expect(
    recordPostgresPoolPreparationContext(env, f.node, context),
  ).resolves.toBeUndefined();
  await expect(
    recordPostgresPoolInventory(env, f.node, inventory),
  ).resolves.toBeUndefined();
  expect(
    await env.DB.prepare(
      "SELECT scope_json,scope_sha256,state FROM pool_bindings WHERE id=?",
    )
      .bind(f.binding.scope.binding_id)
      .first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT pod_uid,state,binding_id FROM pool_pods WHERE node_id=? ORDER BY state",
    )
      .bind(f.node)
      .all(),
  ).toMatchObject({
    results: [
      {
        pod_uid: f.pod.pool_pod_uid,
        state: "claimed",
        binding_id: f.binding.scope.binding_id,
      },
      { pod_uid: free.pool_pod_uid, state: "ready", binding_id: null },
    ],
  });
});

async function refillInputs(
  f: Awaited<ReturnType<typeof postgresPoolFixture>>,
) {
  const now = Date.now();
  const ids = f.pod.container_ids.map(() =>
    bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  );
  const free = PoolPodAttestation.parse({
    ...f.pod,
    pool_pod_uid: crypto.randomUUID(),
    pool_pod_name: "pgcf-pool-free-refill",
    pool_pod_ip: "10.1.2.4",
    container_id: ids[0],
    container_ids: ids,
    observed_at: now,
    workload_probes: f.pod.workload_probes.map((p, i) => ({
      ...p,
      container_id: ids[i],
      probe: { ...p.probe, observed_at: now },
    })),
  });
  const raw = await env.DB.prepare(
    "SELECT context_json FROM pool_preparation_contexts WHERE node_id=?",
  )
    .bind(f.node)
    .first<string>("context_json");
  const previous = JSON.parse(raw!) as PoolPodPreparationContext;
  const context = PoolPodPreparationContext.parse({
    ...previous,
    observed_at: now,
    expires_at: now + 60000,
    pods: [
      ...previous.pods,
      {
        pod_uid: free.pool_pod_uid,
        pod_name: free.pool_pod_name,
        pod_ip: free.pool_pod_ip,
        container_ids: free.container_ids,
      },
    ],
  });

  const inventory = {
    v: 1 as const,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    observed_at: now,
    pods: [f.pod, free],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: 12,
  };
  return { free, context, inventory };
}

it("refuses omission or retagging of the retained bound preparation before accepting refill", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    { free, context } = await refillInputs(f);
  const before = await env.DB.prepare(
    "SELECT context_json FROM pool_preparation_contexts WHERE node_id=?",
  )
    .bind(f.node)
    .first("context_json");
  await expect(
    recordPostgresPoolPreparationContext(env, f.node, {
      ...context,
      pods: context.pods.filter((p) => p.pod_uid === free.pool_pod_uid),
    }),
  ).rejects.toThrow();
  await expect(
    recordPostgresPoolPreparationContext(env, f.node, {
      ...context,
      pods: context.pods.map((p) =>
        p.pod_uid === f.pod.pool_pod_uid ? { ...p, pod_ip: "10.1.2.99" } : p,
      ),
    }),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT context_json FROM pool_preparation_contexts WHERE node_id=?",
    )
      .bind(f.node)
      .first("context_json"),
  ).toBe(before);
});

it("rolls back an observation when a real D1 trigger races the current policy during the bound refresh", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    { inventory } = await refillInputs(f);
  const before = await env.DB.prepare(
    "SELECT attestation_json,last_observed_at FROM pool_pods WHERE pod_uid=?",
  )
    .bind(f.pod.pool_pod_uid)
    .first();
  await env.DB.exec(
    `CREATE TRIGGER refill_policy_race BEFORE UPDATE ON pool_pods WHEN OLD.pod_uid='${f.pod.pool_pod_uid}' BEGIN UPDATE node_postgres_pool_policies SET revision=revision+1 WHERE node_id='${f.node}'; END`,
  );
  try {
    await expect(
      recordPostgresPoolInventory(env, f.node, {
        ...inventory,
        pods: [
          {
            ...f.pod,
            observed_at: inventory.observed_at,
            workload_probes: f.pod.workload_probes.map((p) => ({
              ...p,
              probe: { ...p.probe, observed_at: inventory.observed_at },
            })),
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT revision FROM node_postgres_pool_policies WHERE node_id=?",
      )
        .bind(f.node)
        .first("revision"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT attestation_json,last_observed_at FROM pool_pods WHERE pod_uid=?",
      )
        .bind(f.pod.pool_pod_uid)
        .first(),
    ).toEqual(before);
  } finally {
    await env.DB.exec("DROP TRIGGER refill_policy_race");
  }
});

it("refuses a free refill when existing database CPU plus its declared idle request would exceed the actual node", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    { context, inventory } = await refillInputs(f);
  const { databaseCpuChargeSql } =
    await import("../../src/domain/startup-admission.ts");
  const charge = await env.DB.prepare(
    `SELECT ${databaseCpuChargeSql("d", "s")} charge FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
  )
    .bind(f.id)
    .first<number>("charge");
  const policy = {
    ...context.policy,
    target_slots: 2,
    max_idle_cpu_millicores: 2 * context.policy.idle_cpu_millicores,
    max_idle_memory_mib: 2 * context.policy.idle_memory_mib,
  };
  await env.DB.prepare(
    "UPDATE node_postgres_pool_policies SET policy_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(policy), f.node)
    .run();
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(charge! + policy.idle_cpu_millicores - 1, f.node)
    .run();
  await recordPostgresPoolPreparationContext(env, f.node, {
    ...context,
    policy,
  });
  await expect(
    recordPostgresPoolInventory(env, f.node, inventory),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM pool_pods WHERE node_id=? AND state='ready'",
    )
      .bind(f.node)
      .first("count(*)"),
  ).toBe(0);
});

it("does not spend a deleted database's unreleased holder charge on free refill", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    { context, inventory } = await refillInputs(f);
  expect(
    (
      await request(
        `/v1/databases/${f.id}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(202);
  await env.DB.prepare(
    "UPDATE databases SET observed_state='deleted',observed_generation=generation WHERE id=?",
  )
    .bind(f.id)
    .run();
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(2 * f.policy.idle_cpu_millicores - 1, f.node)
    .run();
  await recordPostgresPoolPreparationContext(env, f.node, context);
  await expect(
    recordPostgresPoolInventory(env, f.node, inventory),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM pool_pods WHERE node_id=? AND state='ready'",
    )
      .bind(f.node)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("detaching");
});

it("keeps concurrent complete refill observations within one free slot and the persisted idle budgets", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    a = await refillInputs(f),
    b = await refillInputs(f);
  await recordPostgresPoolPreparationContext(env, f.node, {
    ...b.context,
    pods: [
      ...a.context.pods,
      b.context.pods.find((p) => p.pod_uid === b.free.pool_pod_uid)!,
    ],
  });
  const outcomes = await Promise.allSettled([
    recordPostgresPoolInventory(env, f.node, a.inventory),
    recordPostgresPoolInventory(env, f.node, b.inventory),
  ]);
  expect(
    outcomes.filter((o) => o.status === "fulfilled").length,
  ).toBeGreaterThanOrEqual(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) slots,sum(idle_cpu_millicores) cpu,sum(idle_memory_mib) memory FROM pool_pods WHERE node_id=? AND state='ready' AND binding_id IS NULL",
    )
      .bind(f.node)
      .first(),
  ).toEqual({
    slots: 1,
    cpu: f.policy.idle_cpu_millicores,
    memory: f.policy.idle_memory_mib,
  });
  expect(
    await env.DB.prepare(
      "SELECT state,binding_id FROM pool_pods WHERE pod_uid=?",
    )
      .bind(f.pod.pool_pod_uid)
      .first(),
  ).toEqual({ state: "claimed", binding_id: f.binding.scope.binding_id });
  const current =
    outcomes[1]!.status === "fulfilled" ? b.inventory : a.inventory;
  await expect(
    recordPostgresPoolInventory(env, f.node, {
      ...current,
      idle_memory_current_bytes: f.policy.max_idle_memory_mib * 1024 ** 2 + 1,
    }),
  ).rejects.toThrow();
});

it("retires only never-claimed free inventory after a current qualified boot replacement", async () => {
  const f = await postgresPoolFixture({ thin: true, qualifiedThin: true });
  const base = {
    v: 1 as const,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    observed_at: Date.now(),
    pods: [f.pod],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: 12,
  };
  await recordPostgresPoolInventory(env, f.node, base);
  const boot = crypto.randomUUID(),
    at = new Date().toISOString();
  // Controlled current host/Fleet/thin readbacks in real D1, not a physical reboot claim.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?),observed_at=?,received_at=? WHERE node_id=?",
    ).bind(boot, at, at, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET observed_json=json_set(observed_json,'$.boot_id',?),updated_at=? WHERE node_id=?",
    ).bind(boot, at, f.node),
    env.DB.prepare(
      "UPDATE node_thin_storage SET qualification_json=json_set(qualification_json,'$.boot_id',?),authority_json=json_set(authority_json,'$.observed_at',?,'$.captured_at',?,'$.expires_at',?),authority_received_at=? WHERE node_id=?",
    ).bind(
      boot,
      at,
      at,
      new Date(Date.now() + 10000).toISOString(),
      at,
      f.node,
    ),
  ]);
  const { readCurrentNodeThinStorage } =
    await import("../../src/domain/node-thin-storage.ts");
  const current = await readCurrentNodeThinStorage(env, f.node);
  expect(current?.row.current_qualified).toBe(1);
  expect(current?.authority).not.toBeNull();
  expect(JSON.parse(current!.row.qualification_json!).boot_id).toBe(boot);
  const { context, free, inventory } = await refillInputs(f);
  const replacement = PoolPodAttestation.parse({ ...free, boot_id: boot });
  await recordPostgresPoolPreparationContext(env, f.node, {
    ...context,
    boot_id: boot,
    pods: [
      {
        pod_uid: replacement.pool_pod_uid,
        pod_name: replacement.pool_pod_name,
        pod_ip: replacement.pool_pod_ip,
        container_ids: replacement.container_ids,
      },
    ],
  });
  await expect(
    recordPostgresPoolInventory(env, f.node, {
      ...inventory,
      boot_id: boot,
      pods: [replacement],
    }),
  ).resolves.toBeUndefined();
  expect(
    await env.DB.prepare(
      "SELECT state,binding_id,boot_id FROM pool_pods WHERE pod_uid=?",
    )
      .bind(f.pod.pool_pod_uid)
      .first(),
  ).toEqual({ state: "retired", binding_id: null, boot_id: f.proof.boot_id });
  expect(
    await env.DB.prepare(
      "SELECT state,binding_id,boot_id FROM pool_pods WHERE pod_uid=?",
    )
      .bind(replacement.pool_pod_uid)
      .first(),
  ).toEqual({ state: "ready", binding_id: null, boot_id: boot });
});

it("rolls back preparation publication if its expiry passes within the current SQLite second", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    { context } = await refillInputs(f);
  const before = await env.DB.prepare(
    "SELECT context_json,expires_at FROM pool_preparation_contexts WHERE node_id=?",
  )
    .bind(f.node)
    .first();
  // Leave a real subsecond window; no clock replacement or mocked D1 outcome.
  for (let attempt = 0; attempt < 20; attempt++) {
    const remainder = await env.DB.prepare(
      "SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)%1000 ms",
    ).first<number>("ms");
    if (remainder! >= 100 && remainder! < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await env.DB.exec(
    `CREATE TRIGGER refill_precise_expiry AFTER UPDATE ON pool_preparation_contexts WHEN NEW.node_id='${f.node}' AND NEW.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) BEGIN UPDATE pool_preparation_contexts SET expires_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-1 WHERE node_id=NEW.node_id; END`,
  );
  try {
    await expect(
      recordPostgresPoolPreparationContext(env, f.node, context),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT context_json,expires_at FROM pool_preparation_contexts WHERE node_id=?",
      )
        .bind(f.node)
        .first(),
    ).toEqual(before);
  } finally {
    await env.DB.exec("DROP TRIGGER refill_precise_expiry");
  }
});
