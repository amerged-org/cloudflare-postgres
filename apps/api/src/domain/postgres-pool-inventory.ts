// SPDX-License-Identifier: Apache-2.0
import { poolWorkloadProbeSafe } from "@pgcf/contracts";
import {
  PoolPodInventory,
  PoolPodAttestation,
  POSTGRES_POOL,
} from "@pgcf/contracts/postgres-pool";
import { databaseCpuChargeSql } from "./startup-admission.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { readPostgresPoolNodeContext as currentNode } from "./postgres-pool.ts";
import {
  readPostgresPoolNodePolicy,
  readPostgresPoolPreparationContexts,
} from "./postgres-pool-preparation.ts";
const conflict = (message = "PostgreSQL pool authority changed") =>
  new ApiError("conflict", message);
const fresh = (at: number, now: number) =>
  at <= now + POSTGRES_POOL.clock_skew_ms &&
  at > now - POSTGRES_POOL.observation_max_age_ms;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function poolPodIdentity(pod: PoolPodAttestation) {
  return {
    ...pod,
    observed_at: 0,
    container_ids: [...pod.container_ids].sort(),
    workload_probes: pod.workload_probes
      .map((p) => ({ ...p, probe: { ...p.probe, observed_at: 0 } }))
      .sort((a, b) =>
        a.container_id < b.container_id
          ? -1
          : a.container_id > b.container_id
            ? 1
            : 0,
      ),
  };
}
export async function recordPostgresPoolInventory(
  env: Env,
  nodeId: string,
  value: PoolPodInventory,
) {
  const inventory = PoolPodInventory.parse(value),
    node = await currentNode(env, nodeId),
    now = Date.now();
  const selected = await readPostgresPoolNodePolicy(env, nodeId, now);
  // Cleanup can retire only absent, never-claimed inventory from this exact run.
  // It cannot publish a Pod, refresh a preparation, or create writer authority.
  if (
    !selected &&
    inventory.pods.length === 0 &&
    inventory.qualification_run_id &&
    inventory.qualification_scope_sha256
  ) {
    if (
      inventory.node_id !== nodeId ||
      inventory.node_uid !== node.node_uid ||
      inventory.boot_id !== node.boot_id ||
      !fresh(inventory.observed_at, now)
    )
      throw conflict();
    const result = await env.DB.prepare(
      `UPDATE pool_pods SET state='retired' WHERE node_id=? AND node_uid=? AND boot_id=?
      AND state='ready' AND binding_id IS NULL AND qualification_run_id=? AND qualification_scope_sha256=?
      AND EXISTS(SELECT 1 FROM postgres_pool_qualification_runs q JOIN nodes n ON n.id=q.node_id
      JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid
      WHERE q.id=? AND q.scope_sha256=? AND q.status='cleanup' AND q.node_id=? AND q.node_uid=? AND q.boot_id=?
      AND n.lost_at IS NULL AND n.node_uid=q.node_uid AND json_extract(o.facts_json,'$.boot_id')=q.boot_id)`,
    )
      .bind(
        nodeId,
        node.node_uid,
        node.boot_id,
        inventory.qualification_run_id,
        inventory.qualification_scope_sha256,
        inventory.qualification_run_id,
        inventory.qualification_scope_sha256,
        nodeId,
        node.node_uid,
        node.boot_id,
      )
      .run();
    if (
      result.meta.changes === 0 &&
      !(await env.DB.prepare(
        "SELECT 1 FROM postgres_pool_qualification_runs WHERE id=? AND scope_sha256=? AND status='cleanup' AND node_id=? AND node_uid=? AND boot_id=?",
      )
        .bind(
          inventory.qualification_run_id,
          inventory.qualification_scope_sha256,
          nodeId,
          node.node_uid,
          node.boot_id,
        )
        .first())
    )
      throw conflict();
    return;
  }
  const row = selected ? { revision: selected.revision } : undefined;
  if (
    !row ||
    inventory.node_id !== nodeId ||
    inventory.node_uid !== node.node_uid ||
    inventory.boot_id !== node.boot_id ||
    inventory.policy_revision !== row.revision ||
    inventory.qualification_run_id !== selected?.qualification_run_id ||
    inventory.qualification_scope_sha256 !==
      selected?.qualification_scope_sha256 ||
    !fresh(inventory.observed_at, now)
  )
    throw conflict();
  const policy = selected!.policy;
  const preparation = (
    await readPostgresPoolPreparationContexts(env, nodeId, now)
  )[0];
  if (!preparation)
    throw conflict("Authenticated preclaim Kubernetes context is missing");
  if (
    inventory.idle_memory_current_bytes >
    policy.max_idle_memory_mib * 1024 ** 2
  )
    throw conflict("Actual pool inventory exceeds its hard idle bound");
  const rawPreparation = await env.DB.prepare(
    "SELECT context_json FROM pool_preparation_contexts WHERE node_id=? AND node_uid=? AND boot_id=?",
  )
    .bind(nodeId, node.node_uid, node.boot_id)
    .first<string>("context_json");
  if (!rawPreparation || !equal(JSON.parse(rawPreparation), preparation))
    throw conflict("Preparation changed during the inventory read");
  const viewSql = `SELECT json_group_array(json(j)) FROM (SELECT json_array(p.pod_uid,p.node_uid,p.boot_id,p.policy_revision,p.attestation_json,p.state,p.binding_id,p.last_observed_at,p.qualification_run_id,p.qualification_scope_sha256,p.idle_cpu_millicores,p.idle_memory_mib,
    json((SELECT json_array(b.state,h.binding_id,h.revision,h.state,b.holder_revision) FROM pool_bindings b LEFT JOIN database_runtime_holders h ON h.database_id=b.database_id WHERE b.id=p.binding_id))) j FROM pool_pods p WHERE p.node_id=? ORDER BY p.pod_uid)`;
  const view = await env.DB.prepare(`SELECT (${viewSql}) witness`)
    .bind(nodeId)
    .first<string>("witness");
  type Prior = [
    string,
    string,
    string,
    number,
    string,
    string,
    string | null,
    number,
    string | null,
    string | null,
    number,
    number,
    [string, string, number, string, number] | null,
  ];
  const retained = JSON.parse(view ?? "[]") as Prior[],
    present = new Set(inventory.pods.map((p) => p.pool_pod_uid));
  const authority: AdmissionSqlGuard = {
    sql: `(${selected!.guard.sql}) AND EXISTS(SELECT 1 FROM pool_preparation_contexts WHERE node_id=? AND node_uid=? AND boot_id=? AND context_json=? AND expires_at>? AND julianday(expires_at/1000.0,'unixepoch')>julianday('now'))
      AND EXISTS(SELECT 1 FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision
        WHERE n.id=? AND n.node_uid=? AND n.ready=1 AND n.schedulable=1 AND n.lost_at IS NULL AND json_extract(o.facts_json,'$.boot_id')=? AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds') AND julianday(o.observed_at)>=julianday('now','-180 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds'))
      AND NOT EXISTS(SELECT 1 FROM admission_scope_fences WHERE kind='node' AND scope_id=? AND mutation_id IS NOT NULL)`,
    bindings: [
      ...selected!.guard.bindings,
      nodeId,
      node.node_uid,
      node.boot_id,
      rawPreparation,
      now,
      nodeId,
      node.node_uid,
      node.boot_id,
      nodeId,
    ],
  };
  const assert = (guard: AdmissionSqlGuard) =>
    env.DB.prepare(
      `SELECT json(CASE WHEN (${guard.sql}) THEN 'true' ELSE '' END)`,
    ).bind(...guard.bindings);
  const statements: D1PreparedStatement[] = [
    assert({
      sql: `(${authority.sql}) AND (${viewSql}) IS ?`,
      bindings: [...authority.bindings, nodeId, view],
    }),
  ];
  // An authenticated complete current-boot observation can retire absent never-claimed FREE inventory, including old-boot Pods.
  // Missing bound/failed/lost custody is retained; labels never release a holder.
  for (const previous of retained) {
    if (
      previous[5] === "ready" &&
      previous[6] === null &&
      previous[1] === node.node_uid &&
      previous[8] === (inventory.qualification_run_id ?? null) &&
      previous[9] === (inventory.qualification_scope_sha256 ?? null) &&
      !present.has(previous[0])
    ) {
      if (previous[7] > inventory.observed_at)
        throw conflict(
          "A delayed inventory cannot retire a newer free observation",
        );
      statements.push(
        env.DB.prepare(
          `UPDATE pool_pods SET state='retired' WHERE pod_uid=? AND state='ready' AND binding_id IS NULL AND NOT EXISTS(SELECT 1 FROM pool_bindings b WHERE b.pool_pod_uid=pool_pods.pod_uid) AND attestation_json=? AND last_observed_at<=? AND (${authority.sql})`,
        ).bind(
          previous[0],
          previous[4],
          inventory.observed_at,
          ...authority.bindings,
        ),
      );
    }
  }
  const committed: AdmissionSqlGuard[] = [];
  let free = 0;
  for (const pod of inventory.pods) {
    const prepared = preparation.pods.find(
      (p) => p.pod_uid === pod.pool_pod_uid,
    );
    if (
      !prepared ||
      preparation.pool_namespace_uid !== pod.pool_namespace_uid ||
      prepared.pod_name !== pod.pool_pod_name ||
      prepared.pod_ip !== pod.pool_pod_ip ||
      !equal([...prepared.container_ids].sort(), [...pod.container_ids].sort())
    )
      throw conflict(
        "Pool Pod differs from the authenticated Kubernetes context",
      );
    const probeIds = new Set(
      pod.workload_probes
        .filter(
          ({ probe }) =>
            poolWorkloadProbeSafe(probe) && fresh(probe.observed_at, now),
        )
        .map(({ container_id }) => container_id),
    );
    if (pod.container_ids.some((cid) => !probeIds.has(cid)))
      throw conflict(
        "Actual OCI namespace/mount isolation was not proved for every writer",
      );
    if (
      pod.node_id !== nodeId ||
      pod.node_uid !== node.node_uid ||
      pod.boot_id !== node.boot_id ||
      !fresh(pod.observed_at, now) ||
      pod.observed_at > inventory.observed_at
    )
      throw conflict(
        "Pool Pod attestation differs from the current node observation",
      );
    const previous = retained.find((p) => p[0] === pod.pool_pod_uid),
      serialized = JSON.stringify(pod);
    if (previous) {
      const old = PoolPodAttestation.parse(JSON.parse(previous[4]));
      if (
        !equal(poolPodIdentity(old), poolPodIdentity(pod)) ||
        previous[1] !== node.node_uid ||
        previous[2] !== node.boot_id ||
        previous[8] !== (inventory.qualification_run_id ?? null) ||
        previous[9] !== (inventory.qualification_scope_sha256 ?? null) ||
        previous[7] > pod.observed_at
      )
        throw conflict(
          "Pool Pod runtime identity or lineage cannot be replaced",
        );
      if (previous[6] !== null) {
        const bound = previous[12];
        if (
          previous[5] !== "claimed" ||
          !bound ||
          bound[1] !== previous[6] ||
          bound[2] !== bound[4] ||
          bound[0] !== bound[3] ||
          ["released", "refused"].includes(bound[0])
        )
          throw conflict("Bound Pod holder authority is unresolved");
        statements.push(
          env.DB.prepare(
            `UPDATE pool_pods SET attestation_json=?,last_observed_at=? WHERE pod_uid=? AND state='claimed' AND binding_id=? AND attestation_json=? AND (${authority.sql})`,
          ).bind(
            serialized,
            pod.observed_at,
            pod.pool_pod_uid,
            previous[6],
            previous[4],
            ...authority.bindings,
          ),
        );
        committed.push({
          sql: "EXISTS(SELECT 1 FROM pool_pods WHERE pod_uid=? AND state='claimed' AND binding_id=? AND attestation_json=? AND last_observed_at=?)",
          bindings: [
            pod.pool_pod_uid,
            previous[6],
            serialized,
            pod.observed_at,
          ],
        });
        continue;
      }
      if (previous[5] !== "ready")
        throw conflict("Retired or lost inventory cannot be revived");
    }
    if (
      !equal(pod.class, policy.class) ||
      pod.supervisor_sha256 !== policy.supervisor_sha256
    )
      throw conflict("Free Pod differs from its immutable policy");
    free++;
    statements.push(
      env.DB.prepare(
        `INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at,qualification_run_id,qualification_scope_sha256,idle_cpu_millicores,idle_memory_mib)
      SELECT ?,?,?,?,?,?,'ready',?,?,?,?,?,? WHERE (${authority.sql}) ON CONFLICT(pod_uid) DO UPDATE SET attestation_json=excluded.attestation_json,last_observed_at=excluded.last_observed_at,policy_revision=excluded.policy_revision,idle_cpu_millicores=excluded.idle_cpu_millicores,idle_memory_mib=excluded.idle_memory_mib
      WHERE pool_pods.state='ready' AND pool_pods.binding_id IS NULL AND pool_pods.last_observed_at<=excluded.last_observed_at`,
      ).bind(
        pod.pool_pod_uid,
        nodeId,
        node.node_uid,
        node.boot_id,
        row.revision,
        serialized,
        pod.observed_at,
        pod.observed_at,
        inventory.qualification_run_id ?? null,
        inventory.qualification_scope_sha256 ?? null,
        policy.idle_cpu_millicores,
        policy.idle_memory_mib,
        ...authority.bindings,
      ),
    );
    committed.push({
      sql: "EXISTS(SELECT 1 FROM pool_pods WHERE pod_uid=? AND state='ready' AND binding_id IS NULL AND attestation_json=? AND last_observed_at=?)",
      bindings: [pod.pool_pod_uid, serialized, pod.observed_at],
    });
  }
  if (free > policy.target_slots)
    throw conflict("Actual free inventory exceeds its refill target");
  const budget: AdmissionSqlGuard = {
    sql: `EXISTS(SELECT 1 FROM nodes n WHERE n.id=? AND n.node_uid=? AND typeof(n.allocatable_cpu_millicores)='integer' AND n.allocatable_cpu_millicores>0 AND typeof(n.platform_reserved_cpu_millicores)='integer' AND n.platform_reserved_cpu_millicores>=0
      AND NOT EXISTS(SELECT 1 FROM pool_pods p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.state='ready' AND (p.binding_id IS NOT NULL OR p.idle_cpu_millicores<=0 OR p.idle_memory_mib<=0))
      AND (SELECT count(*) FROM pool_pods p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.state='ready')<=?
      AND COALESCE((SELECT sum(p.idle_cpu_millicores) FROM pool_pods p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.state='ready'),0)<=?
      AND COALESCE((SELECT sum(p.idle_memory_mib) FROM pool_pods p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.state='ready'),0)<=?
      AND n.allocatable_cpu_millicores-n.platform_reserved_cpu_millicores>=COALESCE((SELECT sum(${databaseCpuChargeSql("d", "s")}) FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)+COALESCE((SELECT sum(p.idle_cpu_millicores) FROM pool_pods p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.state='ready'),0))`,
    bindings: [
      nodeId,
      node.node_uid,
      policy.target_slots,
      policy.max_idle_cpu_millicores,
      policy.max_idle_memory_mib,
    ],
  };
  statements.push(
    assert({
      sql: [authority.sql, budget.sql, ...committed.map((g) => g.sql)]
        .map((x) => `(${x})`)
        .join(" AND "),
      bindings: [
        ...authority.bindings,
        ...budget.bindings,
        ...committed.flatMap((g) => g.bindings),
      ],
    }),
  );
  try {
    await env.DB.batch(statements);
  } catch {
    throw conflict(
      "Pool inventory authority or capacity changed before commit",
    );
  }
}
