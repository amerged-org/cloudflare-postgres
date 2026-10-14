// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import {
  poolQualificationSource,
  qualificationCompletionState,
  qualificationHostMeasurement,
} from "./postgres-pool-qualification-fixture.ts";
import type {
  PostgresPoolQualificationInput,
  PostgresPoolQualificationRun,
  PostgresPoolQualificationMeasurement,
} from "@pgcf/contracts/postgres-pool-qualification";
import { verifyPoolQualificationPermission } from "@pgcf/contracts/postgres-pool-qualification";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import { installationHash } from "../../src/domain/node-installation.ts";
import { readCurrentNodeThinStorage } from "../../src/domain/node-thin-storage.ts";
import {
  thinStorageAuthorityMatches,
  thinStorageInventory,
} from "@pgcf/contracts";
import type { Env } from "../../src/env.ts";
import {
  currentFence,
  readThinQualificationFence,
} from "../../src/domain/postgres-pool-qualification.ts";
import {
  PoolPodPreparationContext,
  poolPreparationContextHash,
} from "@pgcf/contracts/postgres-pool";
import { readPostgresPoolQualificationSetup } from "../../src/domain/postgres-pool-qualification-authority.ts";

const runs: string[] = [];
const releases: string[] = [];
it("publishes pending progress separately from challenge consumption", async () => {
  const response = await request("/agent/v1/openapi.json");
  expect(response.status).toBe(200);
  const doc = (await response.json()) as {
    paths: Record<
      string,
      {
        post: {
          summary: string;
          requestBody: {
            content: Record<
              string,
              { schema: { anyOf: { required: string[] }[] } }
            >;
          };
          responses: Record<
            string,
            {
              content: Record<
                string,
                { schema: { anyOf: { required: string[] }[] } }
              >;
            }
          >;
        };
      }
    >;
  };
  const post =
    doc.paths["/agent/v1/nodes/{id}/postgres-pool/qualification"]!.post;
  expect(
    post.requestBody.content["application/json"]!.schema.anyOf.map((s) =>
      s.required.includes("progress"),
    ),
  ).toEqual([false, true]);
  expect(
    post.responses["200"]!.content["application/json"]!.schema.anyOf.map(
      (s) => s.required,
    ),
  ).toEqual([["recorded"], ["accepted", "run"]]);
  expect(post.summary).toMatch(/progress/);
});
async function recordCleanupController(
  f: Awaited<ReturnType<typeof poolQualificationSource>>,
  run: PostgresPoolQualificationRun,
  report: Record<string, unknown>,
) {
  const { measurement: ignored, ...base } = report;
  void ignored;
  expect(
    (
      await request(
        `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
        f.agent,
        "POST",
        {
          ...base,
          producer: "controller",
          progress: {
            gate: "cleanup",
            phase: "controller_cleanup_observed",
            namespace_uid: run.scope.volume.namespace_uid,
            cnpg_cluster_uid: run.scope.volume.cluster_uid,
            hibernation: "on",
            remaining_instance_pods: 0,
            remaining_pool_pods: 0,
            primary_lease: null,
          },
        },
      )
    ).status,
  ).toBe(200);
}

it("does not accept a namespace-only probe as the host inspection gate", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    input = (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    },
    p = input.qualification.challenge,
    now = Date.now();
  const response = await request(url, f.agent, "POST", {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: run.scope.boot_id,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: now,
    measurement: {
      gate: p.gate,
      kernel_version: run.scope.software.kernel_version,
      caller_pid_namespace_inode: 0xeffffffc,
      initial_pid_namespace_inode: 0xeffffffc,
      caller_user_namespace_inode: 0xeffffffd,
      initial_user_namespace_inode: 0xeffffffd,
      next_namespace_errno: 2,
    },
  });
  expect(response.status).toBe(400);
  expect(
    (
      (await (
        await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
      ).json()) as PostgresPoolQualificationRun
    ).evidence,
  ).toHaveLength(0);
});
it("signs only the current CF-persisted preparation context for the owned run", async () => {
  const f = await poolQualificationSource(releases),
    response = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(response.status).toBe(202);
  const run = (await response.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const setup = await readPostgresPoolQualificationSetup(
      env as Env,
      f.database,
      run.scope.database_generation,
    ),
    now = Date.now();
  expect(setup).toBeDefined();
  const context = PoolPodPreparationContext.parse({
    v: 1,
    node_id: f.node,
    node_uid: run.scope.node_uid,
    boot_id: run.scope.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: crypto.randomUUID(),
    policy_revision: setup!.policy_revision,
    policy: setup!.policy,
    observed_at: now,
    expires_at: now + 60000,
    qualification_run_id: run.id,
    qualification_scope_sha256: run.scope_sha256,
    pods: [
      {
        pod_uid: crypto.randomUUID(),
        pod_name: "qualification-owned",
        pod_ip: "127.0.0.1",
        container_ids: ["a".repeat(64), "b".repeat(64)],
      },
    ],
  });
  await env.DB.prepare(
    "INSERT INTO pool_preparation_contexts(node_id,node_uid,boot_id,context_json,observed_at,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      f.node,
      run.scope.node_uid,
      run.scope.boot_id,
      JSON.stringify(context),
      now,
      now + 60000,
    )
    .run();
  const input = (await (
      await request(
        `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
        f.agent,
      )
    ).json()) as { qualification: PostgresPoolQualificationInput },
    trust = await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    ),
    claims = await verifyPoolQualificationPermission(
      input.qualification.permission,
      trust,
      Date.now(),
    );
  expect(claims?.preparation_sha256).toBe(
    await poolPreparationContextHash(context),
  );
  await env.DB.prepare(
    "UPDATE pool_preparation_contexts SET boot_id=? WHERE node_id=?",
  )
    .bind(crypto.randomUUID(), f.node)
    .run();
  const next = (await (
    await request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
    )
  ).json()) as { qualification: PostgresPoolQualificationInput };
  expect(
    (
      await verifyPoolQualificationPermission(
        next.qualification.permission,
        trust,
        Date.now(),
      )
    )?.preparation_sha256,
  ).toBeNull();
});
it("fences the validated physical-host snapshot without a nested SQLite gate", async () => {
  const f = await poolQualificationSource(releases),
    fence = await readThinQualificationFence(env as Env, f.node, true);
  expect(fence).toBeDefined();
  expect(
    await env.DB.prepare(`SELECT 1 WHERE ${fence!.sql}`)
      .bind(...fence!.bindings)
      .first(),
  ).not.toBeNull();
  const started = await request(
    `/v1/nodes/${f.node}/postgres-pool/qualifications`,
    f.admin,
    "POST",
    f.request,
  );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const row = await env.DB.prepare(
      "SELECT * FROM postgres_pool_qualification_runs WHERE id=?",
    )
      .bind(run.id)
      .first<Parameters<typeof currentFence>[1]>(),
    key = await env.DB.prepare("SELECT agent_key_hash FROM regions WHERE id=?")
      .bind(run.scope.region_id)
      .first<string>("agent_key_hash"),
    current = await currentFence(env as Env, row!, key!);
  expect(
    await env.DB.prepare(`SELECT 1 WHERE ${current.sql}`)
      .bind(...current.bindings)
      .first(),
  ).not.toBeNull();
  const input = await request(
    `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    f.agent,
  );
  expect(await input.json()).toMatchObject({
    qualification: expect.any(Object),
  });
  await env.DB.prepare(
    "UPDATE node_host_configurations SET release_id=? WHERE node_id=?",
  )
    .bind(f.qualified.releaseId, f.node)
    .run();
  expect(
    await env.DB.prepare(`SELECT 1 WHERE ${fence!.sql}`)
      .bind(...fence!.bindings)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(`SELECT 1 WHERE ${current.sql}`)
      .bind(...current.bindings)
      .first(),
  ).toBeNull();
});
afterEach(async () => {
  for (const id of runs.splice(0)) {
    await env.DB.prepare(
      "DELETE FROM postgres_pool_qualification_receipts WHERE run_id=?",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "DELETE FROM postgres_pool_qualification_runs WHERE id=?",
    )
      .bind(id)
      .run();
  }
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

async function scope() {
  const f = await fixture();
  const response = await f.create();
  expect(response.status).toBe(202);
  const created = (await response.json()) as { database: { id: string } };
  const candidate = `pool-${crypto.randomUUID()}`;
  releases.push(candidate);
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,'{}',?,?)",
  )
    .bind(candidate, "a".repeat(64), new Date().toISOString())
    .run();
  return { ...f, database: created.database.id, candidate };
}

async function begin(
  f: Awaited<ReturnType<typeof scope>>,
  database = f.database,
  now = Date.now(),
) {
  const id = crypto.randomUUID();
  runs.push(id);
  await env.DB.prepare(
    `INSERT INTO postgres_pool_qualification_runs
    (id,region_id,node_id,node_uid,boot_id,database_id,database_generation,candidate_release_id,candidate_spec_sha256,
     scope_sha256,scope_json,status,created_at,updated_at,expires_at)
    VALUES(?,?,?,?,?,?,1,?,?,?,'{}','running',?,?,?)`,
  )
    .bind(
      id,
      f.region,
      f.node,
      crypto.randomUUID(),
      crypto.randomUUID(),
      database,
      f.candidate,
      "a".repeat(64),
      "b".repeat(64),
      now,
      now,
      now + 60_000,
    )
    .run();
  return { id, now };
}

it("keeps a node reserved until actual cleanup, including after failure or timeout", async () => {
  const f = await scope(),
    run = await begin(f, f.database, Date.now() - 120_000);
  await expect(begin(f, "another-owned-db")).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='cleanup',error_code='qualification_cancelled' WHERE id=?",
  )
    .bind(run.id)
    .run();
  await expect(begin(f, "another-owned-db")).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET status='failed',completed_at=? WHERE id=?",
    )
      .bind(run.now + 1, run.id)
      .run(),
  ).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='failed',cleanup_json='{}',completed_at=? WHERE id=?",
  )
    .bind(run.now + 1, run.id)
    .run();
  await expect(begin(f)).resolves.toHaveProperty("id");
});

it("cannot change the node, database, candidate, scope or deadline of an admitted run", async () => {
  const f = await scope(),
    run = await begin(f);
  await expect(
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET scope_sha256=? WHERE id=?",
    )
      .bind("c".repeat(64), run.id)
      .run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET database_generation=2,expires_at=expires_at+1 WHERE id=?",
    )
      .bind(run.id)
      .run(),
  ).rejects.toThrow();
});

it("cannot reopen cleanup or mutate terminal evidence", async () => {
  const f = await scope(),
    run = await begin(f);
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='cleanup',error_code='qualification_failed' WHERE id=?",
  )
    .bind(run.id)
    .run();
  await expect(
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET status='running',error_code=NULL WHERE id=?",
    )
      .bind(run.id)
      .run(),
  ).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='failed',cleanup_json='{}',completed_at=? WHERE id=?",
  )
    .bind(run.now + 1, run.id)
    .run();
  await expect(
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET evidence_json=? WHERE id=?",
    )
      .bind(JSON.stringify({ changed: true }), run.id)
      .run(),
  ).rejects.toThrow();
});

it("refuses qualification of an unproven database and does not enable normal pool admission", async () => {
  const f = await scope();
  const node = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<{ node_uid: string }>();
  const response = await request(
    `/v1/nodes/${f.node}/postgres-pool/qualifications`,
    f.admin,
    "POST",
    {
      candidate_release_id: f.candidate,
      node_uid: node!.node_uid,
      database_id: f.database,
      expected_generation: 1,
    },
  );
  expect(response.status).toBe(409);
  const run = await env.DB.prepare(
    "SELECT count(*) count FROM postgres_pool_qualification_runs WHERE node_id=?",
  )
    .bind(f.node)
    .first<{ count: number }>();
  expect(run!.count).toBe(0);
});

it("keeps pool qualification start and cancellation administrative", async () => {
  const f = await scope();
  const response = await request(
    `/v1/nodes/${f.node}/postgres-pool/qualifications`,
    f.integrator,
    "POST",
    {
      candidate_release_id: f.candidate,
      node_uid: crypto.randomUUID(),
      database_id: f.database,
      expected_generation: 1,
    },
  );
  expect(response.status).toBe(403);
  const cancelled = await request(
    `/v1/postgres-pool/qualifications/${crypto.randomUUID()}/cancel`,
    f.integrator,
    "POST",
  );
  expect(cancelled.status).toBe(403);
});

it("moves an actual unavailable measurement to cleanup without invented successful facts", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    input = (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    },
    p = input.qualification.challenge,
    now = Date.now(),
    response = await request(url, f.agent, "POST", {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: p.sequence,
      nonce: p.nonce,
      producer: p.producer,
      node_uid: f.uid,
      boot_id: run.scope.boot_id,
      candidate_spec_sha256: f.specHash,
      started_at: now,
      observed_at: now,
      measurement: { gate: p.gate, failure_code: "measurement_unavailable" },
    });
  expect(response.status).toBe(200);
  const ended = (
    (await response.json()) as { run: PostgresPoolQualificationRun }
  ).run;
  expect(ended.status).toBe("cleanup");
  expect(ended.error_code).toBe("pool_qualification_gate_failed");
  expect(ended.receipt_sha256).toBeNull();
  expect(ended.evidence[0]!.measurement).toEqual({
    gate: p.gate,
    failure_code: "measurement_unavailable",
  });
});

it("binds one target wake generation and consumes a measured nonce once", async () => {
  const f = await poolQualificationSource(releases),
    response = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(response.status).toBe(202);
  const run = (await response.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  expect(run.scope.database_generation).toBe(f.request.expected_generation + 1);
  expect(run.scope.software.host_extension_image).toBe(
    f.specification.thin_storage_qualification!.host_extension_image,
  );
  const input = (await (
    await request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
    )
  ).json()) as { qualification: PostgresPoolQualificationInput };
  const challenge = input.qualification.challenge,
    measured = {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: challenge.sequence,
      nonce: challenge.nonce,
      producer: challenge.producer,
      node_uid: f.uid,
      boot_id: f.qualified.bootId,
      candidate_spec_sha256: f.specHash,
      started_at: Date.now(),
      observed_at: Date.now(),
      measurement: await qualificationHostMeasurement(f, run, challenge.nonce),
    };
  const selected = await readCurrentNodeThinStorage(env as Env, f.node);
  expect({
    qualified: selected?.row.current_qualified,
    boot:
      JSON.parse(selected?.row.qualification_json ?? "null")?.boot_id ===
      run.scope.boot_id,
    matches: thinStorageAuthorityMatches(
      run.scope.storage,
      selected?.authority,
      undefined,
      Date.now(),
    ),
    inventory:
      !!selected?.authority &&
      thinStorageInventory(selected.authority).expires_at > Date.now(),
  }).toEqual({ qualified: 1, boot: true, matches: true, inventory: true });
  expect(input.qualification.policy?.policy.class.memory_request_bytes).toBe(
    f.sleep.class.memory_request_bytes,
  );
  expect(input.qualification.policy?.policy.target_slots).toBe(1);
  const permission = await verifyPoolQualificationPermission(
    input.qualification.permission,
    await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    ),
  );
  expect(permission?.scope_sha256).toBe(run.scope_sha256);
  const post = () =>
    request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
      "POST",
      measured,
    );
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(409);
  const recorded = (await (
    await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
  ).json()) as PostgresPoolQualificationRun;
  expect(recorded.evidence).toHaveLength(1);
  expect(JSON.stringify(recorded)).not.toContain(challenge.nonce);
  expect(recorded.receipt_sha256).toBeNull();
  const joined = (await (
    await request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
    )
  ).json()) as { qualification: PostgresPoolQualificationInput };
  expect(joined.qualification.accepted_evidence).toEqual(recorded.evidence);
});

it("waits for authenticated driver replacement before consuming finite creator evidence", async () => {
  const f = await poolQualificationSource(releases),
    url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const first = (
      (await (await request(url, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    host = await qualificationHostMeasurement(f, run, first.challenge.nonce),
    at = Date.now();
  expect(
    (
      await request(url, f.agent, "POST", {
        run_id: run.id,
        scope_sha256: run.scope_sha256,
        sequence: 1,
        nonce: first.challenge.nonce,
        producer: "node_agent",
        node_uid: f.uid,
        boot_id: run.scope.boot_id,
        candidate_spec_sha256: f.specHash,
        started_at: at,
        observed_at: at,
        measurement: host,
      })
    ).status,
  ).toBe(200);
  const second = (
      (await (await request(url, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    replacement = crypto.randomUUID(),
    measuredAt = Date.now(),
    measurement: PostgresPoolQualificationMeasurement = {
      gate: "finite_creator_fence",
      binding_id: null,
      source_generation: run.scope.database_generation - 1,
      volume_handle: run.scope.volume.volume_handle,
      driver_sha256: run.scope.software.driver_sha256,
      deny_record_inode_before_restart: 42,
      deny_record_inode_after_restart: 42,
      deny_record_sha256_before_restart: "a".repeat(64),
      deny_record_sha256_after_restart: "a".repeat(64),
      deny_record_scope_sha256: run.scope_sha256,
      deny_record_fsync_errno: 0,
      driver_restarts: 1,
      driver_pod_uid_before_restart: f.authority.driver_pod_uid,
      driver_pod_uid_after_restart: replacement,
      driver_daemonset_uid: crypto.randomUUID(),
      driver_image: run.scope.software.driver_image,
      driver_deleted_at: measuredAt,
      driver_replacement_ready_at: measuredAt,
      agent_owner_deaths: 1,
      before_claim_requests_completed: 1,
      denied_operations: [
        {
          operation: "node_publish",
          grpc_status: 9,
          message: "pool_creator_fence_denied",
        },
        {
          operation: "node_expand",
          grpc_status: 9,
          message: "pool_creator_fence_denied",
        },
        { operation: "volume_reconcile", error: "pool_creator_fence_denied" },
        {
          operation: "snapshot_create",
          error: "pool_creator_fence_denied",
          snapshot_uid: crypto.randomUUID(),
          source_volume_handle: run.scope.volume.volume_handle,
          state_at_denial: "Pending",
          requested_at: measuredAt,
          deleted_at: measuredAt,
          absent_at: measuredAt,
        },
      ],
      surviving_creation_descriptors: 0,
      final_dm_open_count: 0,
    },
    report = {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: 2,
      nonce: second.challenge.nonce,
      producer: "node_agent",
      node_uid: f.uid,
      boot_id: run.scope.boot_id,
      candidate_spec_sha256: f.specHash,
      started_at: measuredAt,
      observed_at: measuredAt,
      measurement,
    };
  expect((await request(url, f.agent, "POST", report)).status).toBe(409);
  const { measurement: ignoredPart, ...partBase } = report;
  void ignoredPart;
  const piece = (producer: string, progress: unknown) =>
    request(url, f.agent, "POST", { ...partBase, producer, progress });
  expect(
    (
      await piece("node_agent", {
        gate: "finite_creator_fence",
        phase: "node_fence_ready",
        source_generation: measurement.source_generation,
        volume_handle: measurement.volume_handle,
        driver_sha256: measurement.driver_sha256,
        deny_record_inode: measurement.deny_record_inode_before_restart,
        deny_record_sha256: measurement.deny_record_sha256_before_restart,
        deny_record_scope_sha256: run.scope_sha256,
        deny_record_fsync_errno: 0,
        agent_owner_deaths: 1,
        before_claim_requests_completed: 1,
        surviving_creation_descriptors: 0,
        dm_open_count: 0,
        foreign_mounts: 0,
        named_namespace_scan_errno: 0,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "driver_delete_intent",
        driver_pod_uid: f.authority.driver_pod_uid,
        driver_pod_name: "driver-known",
        driver_pod_resource_version: "2",
        driver_namespace: "openebs",
        driver_daemonset_uid: measurement.driver_daemonset_uid,
        driver_image: measurement.driver_image,
      })
    ).status,
  ).toBe(200);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET authority_json=json_set(authority_json,'$.driver_pod_uid',?) WHERE node_id=?",
    ).bind(replacement, f.node),
    env.DB.prepare(
      "UPDATE pool_storage_observations SET observation_json=json_set(observation_json,'$.observed_at',?),observed_at=? WHERE database_id=?",
    ).bind(measuredAt, measuredAt, f.database),
  ]);
  const refreshed = (
      (await (await request(url, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    claims = await verifyPoolQualificationPermission(
      refreshed.permission,
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      ),
    );
  expect(refreshed.challenge.nonce).toBe(second.challenge.nonce);
  expect(claims?.execution.driver_pod_uid).toBe(replacement);
  expect((await request(url, f.agent, "POST", report)).status).toBe(409);
  const progressJournal = async () =>
    JSON.parse(
      (await env.DB.prepare(
        "SELECT evidence_json FROM postgres_pool_qualification_runs WHERE id=?",
      )
        .bind(run.id)
        .first<string>("evidence_json"))!,
    ) as {
      progress: { received_at: number; progress: { phase: string } }[];
    };
  const deleteIntentReceived = (await progressJournal()).progress.find(
    (e) => e.progress.phase === "driver_delete_intent",
  )!.received_at;
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "driver_restarted",
        driver_pod_uid_before_restart:
          measurement.driver_pod_uid_before_restart,
        driver_pod_uid_after_restart: measurement.driver_pod_uid_after_restart,
        driver_daemonset_uid: measurement.driver_daemonset_uid,
        driver_image: measurement.driver_image,
        driver_deleted_at: deleteIntentReceived - 5_001,
        driver_replacement_ready_at: measuredAt,
        volume_reconcile_error: "pool_creator_fence_denied",
        volume_reconcile_observed_at: measuredAt,
      })
    ).status,
  ).toBe(409);
  expect((await progressJournal()).progress).toHaveLength(2);
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "driver_restarted",
        driver_pod_uid_before_restart:
          measurement.driver_pod_uid_before_restart,
        driver_pod_uid_after_restart: measurement.driver_pod_uid_after_restart,
        driver_daemonset_uid: measurement.driver_daemonset_uid,
        driver_image: measurement.driver_image,
        driver_deleted_at: measuredAt,
        driver_replacement_ready_at: measuredAt,
        volume_reconcile_error: "pool_creator_fence_denied",
        volume_reconcile_observed_at: measuredAt,
      })
    ).status,
  ).toBe(200);
  const snapshot = measurement.denied_operations.find(
    (o) => o.operation === "snapshot_create",
  );
  if (!snapshot || snapshot.operation !== "snapshot_create")
    throw Error("Expected owned snapshot structural evidence");
  const name = `pgcf-q-${run.scope_sha256.slice(0, 24)}`;
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "snapshot_create_intent",
        snapshot_name: name,
        snapshot_namespace: "openebs",
        source_volume_handle: measurement.volume_handle,
      })
    ).status,
  ).toBe(200);
  const snapshotIntentReceived = (await progressJournal()).progress.find(
    (e) => e.progress.phase === "snapshot_create_intent",
  )!.received_at;
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "snapshot_created",
        snapshot_name: name,
        snapshot_namespace: "openebs",
        source_volume_handle: measurement.volume_handle,
        snapshot_uid: snapshot.snapshot_uid,
        snapshot_resource_version: "3",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "snapshot_removed",
        snapshot_uid: snapshot.snapshot_uid,
        source_volume_handle: measurement.volume_handle,
        state_at_denial: "Pending",
        error: "pool_creator_fence_denied",
        requested_at: snapshotIntentReceived - 5_001,
        deleted_at: measuredAt,
        absent_at: measuredAt,
        physical_snapshot_count: 0,
      })
    ).status,
  ).toBe(409);
  expect((await progressJournal()).progress).toHaveLength(5);
  expect(
    (
      await piece("controller", {
        gate: "finite_creator_fence",
        phase: "snapshot_removed",
        snapshot_uid: snapshot.snapshot_uid,
        source_volume_handle: measurement.volume_handle,
        state_at_denial: "Pending",
        error: "pool_creator_fence_denied",
        requested_at: measuredAt,
        deleted_at: measuredAt,
        absent_at: measuredAt,
        physical_snapshot_count: 0,
      })
    ).status,
  ).toBe(200);
  // Final gate evidence must match the independently recorded producer pieces.
  expect((await request(url, f.agent, "POST", report)).status).toBe(200);
  expect((await request(url, f.agent, "POST", report)).status).toBe(409);
  const recorded = (await (
    await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
  ).json()) as PostgresPoolQualificationRun;
  expect(recorded.evidence.map((e) => e.measurement.gate)).toEqual([
    "host_mount_context",
    "finite_creator_fence",
  ]);
  expect(recorded.evidence[1]!.execution.driver_pod_uid).toBe(replacement);
  expect(recorded.receipt_sha256).toBeNull();
});

it("refuses expired slow driver identity without cancelling an unchanged run", async () => {
  const f = await poolQualificationSource(releases),
    url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    response = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(response.status).toBe(202);
  const run = (await response.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const before = (await (await request(url, f.agent)).json()) as {
    qualification: PostgresPoolQualificationInput;
  };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=json_set(authority_json,'$.expires_at',?) WHERE node_id=?",
  )
    .bind(new Date(Date.now() - 1).toISOString(), f.node)
    .run();
  expect((await request(url, f.agent)).status).toBe(409);
  expect(
    (
      (await (
        await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
      ).json()) as PostgresPoolQualificationRun
    ).status,
  ).toBe("running");
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(f.authority), f.node)
    .run();
  const fresh = (await (await request(url, f.agent)).json()) as {
    qualification: PostgresPoolQualificationInput;
  };
  expect(fresh.qualification.challenge.nonce).toBe(
    before.qualification.challenge.nonce,
  );
});

it("journals one controller delete intent only after measured node fence readiness", async () => {
  const f = await poolQualificationSource(releases),
    url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const first = (
      (await (await request(url, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    host = await qualificationHostMeasurement(f, run, first.challenge.nonce),
    at = Date.now();
  expect(
    (
      await request(url, f.agent, "POST", {
        run_id: run.id,
        scope_sha256: run.scope_sha256,
        sequence: 1,
        nonce: first.challenge.nonce,
        producer: "node_agent",
        node_uid: f.uid,
        boot_id: run.scope.boot_id,
        candidate_spec_sha256: f.specHash,
        started_at: at,
        observed_at: at,
        measurement: host,
      })
    ).status,
  ).toBe(200);
  const second = (
      (await (await request(url, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    now = Date.now(),
    base = {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: 2,
      nonce: second.challenge.nonce,
      node_uid: f.uid,
      boot_id: run.scope.boot_id,
      candidate_spec_sha256: f.specHash,
      started_at: now,
      observed_at: now,
    },
    intent = {
      ...base,
      producer: "controller",
      progress: {
        gate: "finite_creator_fence",
        phase: "driver_delete_intent",
        driver_pod_uid: f.authority.driver_pod_uid,
        driver_pod_name: "driver-known",
        driver_pod_resource_version: "2",
        driver_namespace: "openebs",
        driver_daemonset_uid: crypto.randomUUID(),
        driver_image: run.scope.software.driver_image,
      },
    };
  expect((await request(url, f.agent, "POST", intent)).status).toBe(409);
  const ready = {
    ...base,
    producer: "node_agent",
    progress: {
      gate: "finite_creator_fence",
      phase: "node_fence_ready",
      source_generation: run.scope.database_generation - 1,
      volume_handle: run.scope.volume.volume_handle,
      driver_sha256: run.scope.software.driver_sha256,
      deny_record_inode: 42,
      deny_record_sha256: "a".repeat(64),
      deny_record_scope_sha256: run.scope_sha256,
      deny_record_fsync_errno: 0,
      agent_owner_deaths: 1,
      before_claim_requests_completed: 1,
      surviving_creation_descriptors: 0,
      dm_open_count: 0,
      foreign_mounts: 0,
      named_namespace_scan_errno: 0,
    },
  };
  expect((await request(url, f.agent, "POST", ready)).status).toBe(200);
  const saved = await request(url, f.agent, "POST", intent);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ recorded: true });
  expect((await request(url, f.agent, "POST", intent)).status).toBe(200);
  expect(
    (
      await request(url, f.agent, "POST", {
        ...intent,
        progress: { ...intent.progress, driver_pod_uid: crypto.randomUUID() },
      })
    ).status,
  ).toBe(409);
  const input = (
    (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    }
  ).qualification;
  expect(input.challenge.nonce).toBe(second.challenge.nonce);
  expect(input.accepted_evidence).toHaveLength(1);
  expect(input.pending_progress).toHaveLength(2);
  const claims = await verifyPoolQualificationPermission(
    input.permission,
    await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    ),
  );
  expect(claims?.progress_sha256).toBe(
    await installationHash(input.pending_progress),
  );
  const persisted = JSON.parse(
    (await env.DB.prepare(
      "SELECT evidence_json FROM postgres_pool_qualification_runs WHERE id=?",
    )
      .bind(run.id)
      .first<string>("evidence_json"))!,
  );
  persisted.pending.expires_at = Date.now() - 1;
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET evidence_json=? WHERE id=?",
  )
    .bind(JSON.stringify(persisted), run.id)
    .run();
  const expired = (
    (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    }
  ).qualification;
  expect(expired.status).toBe("cleanup");
  expect(expired.challenge.gate).toBe("cleanup");
  expect(expired.pending_progress.map((e) => e.progress.phase)).toEqual([
    "node_fence_ready",
    "driver_delete_intent",
  ]);
  expect((await request(url, f.agent, "POST", intent)).status).toBe(409);
});

it("refuses a previously issued challenge after the actual controller artifact rolls back", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const input = (await (
    await request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
    )
  ).json()) as { qualification: PostgresPoolQualificationInput };
  const staleMeasurement = await qualificationHostMeasurement(
      f,
      run,
      input.qualification.challenge.nonce,
    ),
    facts = JSON.parse(
      (await env.DB.prepare(
        "SELECT facts_json FROM fleet_node_release_observations WHERE node_id=?",
      )
        .bind(f.node)
        .first<string>("facts_json"))!,
    ) as { components: { name: string; sha256: string }[] };
  facts.components.find((c) => c.name === "native-controller")!.sha256 =
    "0".repeat(64);
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(facts), f.node)
    .run();
  const p = input.qualification.challenge,
    response = await request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
      "POST",
      {
        run_id: run.id,
        scope_sha256: run.scope_sha256,
        sequence: p.sequence,
        nonce: p.nonce,
        producer: p.producer,
        node_uid: f.uid,
        boot_id: f.qualified.bootId,
        candidate_spec_sha256: f.specHash,
        started_at: Date.now(),
        observed_at: Date.now(),
        measurement: staleMeasurement,
      },
    );
  expect(response.status).toBe(409);
  const recorded = (await (
    await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
  ).json()) as PostgresPoolQualificationRun;
  expect(recorded.evidence).toHaveLength(0);
});

it("replays a lost start by idempotency key and refuses another active run", async () => {
  const f = await poolQualificationSource(releases),
    key = crypto.randomUUID(),
    start = () =>
      request(
        `/v1/nodes/${f.node}/postgres-pool/qualifications`,
        f.admin,
        "POST",
        f.request,
        key,
      );
  const first = await start();
  expect(first.status).toBe(202);
  const run = (await first.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const replay = await start();
  expect(replay.status).toBe(202);
  expect(((await replay.json()) as PostgresPoolQualificationRun).id).toBe(
    run.id,
  );
  expect(
    (
      await request(
        `/v1/nodes/${f.node}/postgres-pool/qualifications`,
        f.admin,
        "POST",
        f.request,
      )
    ).status,
  ).toBe(409);
});

it("requires independently recorded Kubernetes absence before node cleanup can release a run", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  await request(
    `/v1/postgres-pool/qualifications/${run.id}/cancel`,
    f.admin,
    "POST",
    {},
  );
  const url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    input = (
      (await (await request(url, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    p = input.challenge,
    at = Date.now(),
    report = {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: p.sequence,
      nonce: p.nonce,
      producer: "node_agent",
      node_uid: f.uid,
      boot_id: run.scope.boot_id,
      candidate_spec_sha256: f.specHash,
      started_at: at,
      observed_at: at,
      measurement: {
        gate: "cleanup",
        binding_id: null,
        storage: f.volume,
        remaining_pool_pods: 0,
        remaining_instance_pods: 0,
        remaining_primary_lease_holders: 0,
        cnpg_hibernation: "on",
        remaining_creation_descriptors: 0,
        dm_open_count: 0,
        foreign_mounts: 0,
        named_namespace_scan_errno: 0,
        deny_record: "absent",
        unmount_errno: null,
      },
    };
  expect((await request(url, f.agent, "POST", report)).status).toBe(409);
  await recordCleanupController(f, run, report);
  expect((await request(url, f.agent, "POST", report)).status).toBe(200);
});

it("cleans a cancelled pre-wake run without inventing a binding or a receipt", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const cancelled = await request(
    `/v1/postgres-pool/qualifications/${run.id}/cancel`,
    f.admin,
    "POST",
  );
  expect(cancelled.status).toBe(200);
  expect(
    (
      await request(
        `/v1/nodes/${f.node}/postgres-pool/qualifications`,
        f.admin,
        "POST",
        f.request,
      )
    ).status,
  ).toBe(409);
  const input = (await (
      await request(
        `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
        f.agent,
      )
    ).json()) as { qualification: PostgresPoolQualificationInput },
    p = input.qualification.challenge,
    now = Date.now();
  await recordCleanupController(f, run, {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: f.qualified.bootId,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: now,
  });
  const response = await request(
    `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    f.agent,
    "POST",
    {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: p.sequence,
      nonce: p.nonce,
      producer: p.producer,
      node_uid: f.uid,
      boot_id: f.qualified.bootId,
      candidate_spec_sha256: f.specHash,
      started_at: now,
      observed_at: now,
      measurement: {
        gate: "cleanup",
        binding_id: null,
        storage: f.volume,
        remaining_pool_pods: 0,
        remaining_instance_pods: 0,
        remaining_primary_lease_holders: 0,
        cnpg_hibernation: "on",
        remaining_creation_descriptors: 0,
        dm_open_count: 0,
        foreign_mounts: 0,
        named_namespace_scan_errno: 0,
        deny_record: "absent",
        unmount_errno: null,
      },
    },
  );
  expect(response.status).toBe(200);
  const ended = (
    (await response.json()) as { run: PostgresPoolQualificationRun }
  ).run;
  expect(ended.status).toBe("failed");
  expect(ended.error_code).toBe("pool_qualification_cancelled");
  expect(ended.receipt_sha256).toBeNull();
  const next = await request(
    `/v1/nodes/${f.node}/postgres-pool/qualifications`,
    f.admin,
    "POST",
    f.request,
  );
  expect(next.status).toBe(202);
  runs.push(((await next.json()) as PostgresPoolQualificationRun).id);
});

it("retains lost inventory across boots until explicit retirement before start and cleanup", async () => {
  const f = await poolQualificationSource(releases),
    pod = crypto.randomUUID(),
    at = Date.now(),
    startUrl = `/v1/nodes/${f.node}/postgres-pool/qualifications`,
    agentUrl = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`;
  await env.DB.prepare(
    "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,'{}','lost',?,?)",
  )
    .bind(pod, f.node, f.uid, crypto.randomUUID(), at, at)
    .run();
  const blocked = await request(startUrl, f.admin, "POST", f.request);
  if (blocked.status === 202)
    runs.push(((await blocked.json()) as PostgresPoolQualificationRun).id);
  expect(blocked.status).toBe(409);
  await env.DB.prepare("UPDATE pool_pods SET state='retired' WHERE pod_uid=?")
    .bind(pod)
    .run();
  const response = await request(startUrl, f.admin, "POST", f.request);
  expect(response.status).toBe(202);
  const run = (await response.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  expect(
    (
      await request(
        `/v1/postgres-pool/qualifications/${run.id}/cancel`,
        f.admin,
        "POST",
        {},
      )
    ).status,
  ).toBe(200);
  const input = (
      (await (await request(agentUrl, f.agent)).json()) as {
        qualification: PostgresPoolQualificationInput;
      }
    ).qualification,
    p = input.challenge,
    now = Date.now(),
    lost = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at,qualification_run_id,qualification_scope_sha256) VALUES(?,?,?,?,1,'{}','lost',?,?,?,?)",
  )
    .bind(
      lost,
      f.node,
      f.uid,
      crypto.randomUUID(),
      now,
      now,
      run.id,
      run.scope_sha256,
    )
    .run();
  const report = {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: run.scope.boot_id,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: now,
    measurement: {
      gate: "cleanup",
      binding_id: null,
      storage: f.volume,
      remaining_pool_pods: 0,
      remaining_instance_pods: 0,
      remaining_primary_lease_holders: 0,
      cnpg_hibernation: "on",
      remaining_creation_descriptors: 0,
      dm_open_count: 0,
      foreign_mounts: 0,
      named_namespace_scan_errno: 0,
      deny_record: "absent",
      unmount_errno: null,
    },
  };
  await recordCleanupController(f, run, report);
  expect((await request(agentUrl, f.agent, "POST", report)).status).toBe(409);
  expect((await request(startUrl, f.admin, "POST", f.request)).status).toBe(
    409,
  );
  const pending = (await (
    await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
  ).json()) as PostgresPoolQualificationRun;
  expect(pending.status).toBe("cleanup");
  expect(pending.completed_at).toBeNull();
  expect(pending.receipt_sha256).toBeNull();
  // Structural authority regression: only an explicit persisted retirement is release evidence.
  await env.DB.prepare("UPDATE pool_pods SET state='retired' WHERE pod_uid=?")
    .bind(lost)
    .run();
  expect((await request(agentUrl, f.agent, "POST", report)).status).toBe(200);
  const next = await request(startUrl, f.admin, "POST", f.request);
  expect(next.status).toBe(202);
  runs.push(((await next.json()) as PostgresPoolQualificationRun).id);
});

it("fails boot drift permanently but permits current-attested cleanup of the original physical scope", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const boot = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
    ).bind(boot, f.node),
    env.DB.prepare(
      "UPDATE pool_storage_observations SET observation_json=json_set(observation_json,'$.boot_id',?) WHERE database_id=?",
    ).bind(boot, f.database),
  ]);
  const url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`;
  expect((await request(url, f.agent)).status).toBe(409);
  const recovery = await request(url, f.agent);
  expect(recovery.status).toBe(200);
  const input = (await recovery.json()) as {
      qualification: PostgresPoolQualificationInput;
    },
    p = input.qualification.challenge,
    permission = await verifyPoolQualificationPermission(
      input.qualification.permission,
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      ),
    );
  expect(permission?.scope.boot_id).toBe(f.qualified.bootId);
  expect(permission?.execution.boot_id).toBe(boot);
  expect(p.gate).toBe("cleanup");
  const now = Date.now();
  await recordCleanupController(f, run, {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: boot,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: now,
  });
  const response = await request(url, f.agent, "POST", {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: boot,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: now,
    measurement: {
      gate: "cleanup",
      binding_id: null,
      storage: f.volume,
      remaining_pool_pods: 0,
      remaining_instance_pods: 0,
      remaining_primary_lease_holders: 0,
      cnpg_hibernation: "on",
      remaining_creation_descriptors: 0,
      dm_open_count: 0,
      foreign_mounts: 0,
      named_namespace_scan_errno: 0,
      deny_record: "absent",
      unmount_errno: null,
    },
  });
  expect(response.status).toBe(200);
  const ended = (
    (await response.json()) as { run: PostgresPoolQualificationRun }
  ).run;
  expect(ended.status).toBe("failed");
  expect(ended.receipt_sha256).toBeNull();
  expect(ended.scope.boot_id).toBe(f.qualified.bootId);
});

it("waits for an admission transaction without cancelling an unchanged qualification", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  await env.DB.prepare(
    "UPDATE database_admission_epochs SET mutation_id=?,mutation_started_at=?,mutation_status='fenced' WHERE database_id=?",
  )
    .bind(crypto.randomUUID(), new Date().toISOString(), f.database)
    .run();
  expect(
    (
      await request(
        `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
        f.agent,
      )
    ).status,
  ).toBe(409);
  const state = (await (
    await request(`/v1/postgres-pool/qualifications/${run.id}`, f.admin)
  ).json()) as PostgresPoolQualificationRun;
  expect(state.status).toBe("running");
  expect(state.error_code).toBeNull();
  await env.DB.prepare(
    "UPDATE database_admission_epochs SET mutation_id=NULL,mutation_started_at=NULL,mutation_status=NULL WHERE database_id=?",
  )
    .bind(f.database)
    .run();
  expect(
    (
      await request(
        `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
        f.agent,
      )
    ).status,
  ).toBe(200);
});

it("atomically stores the completed receipt with actual cleanup and rolls both back on SQLite abort", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const prepared = await qualificationCompletionState(f, run),
    url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    input = (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    },
    p = input.qualification.challenge,
    body = {
      run_id: run.id,
      scope_sha256: run.scope_sha256,
      sequence: p.sequence,
      nonce: p.nonce,
      producer: p.producer,
      node_uid: f.uid,
      boot_id: f.qualified.bootId,
      candidate_spec_sha256: f.specHash,
      started_at: Date.now(),
      observed_at: Date.now(),
      measurement: prepared.measurement,
    };
  await recordCleanupController(f, run, body);
  await env.DB.exec(
    "CREATE TRIGGER qualification_completion_abort BEFORE UPDATE OF status ON postgres_pool_qualification_runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'qualification_completion_abort'); END;",
  );
  try {
    expect((await request(url, f.agent, "POST", body)).status).toBe(500);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) count FROM postgres_pool_qualification_receipts WHERE run_id=?",
      )
        .bind(run.id)
        .first<{ count: number }>())!.count,
    ).toBe(0);
    expect(
      (await env.DB.prepare(
        "SELECT status FROM postgres_pool_qualification_runs WHERE id=?",
      )
        .bind(run.id)
        .first<{ status: string }>())!.status,
    ).toBe("cleanup");
  } finally {
    await env.DB.exec("DROP TRIGGER qualification_completion_abort;");
  }
  const completed = await request(url, f.agent, "POST", body);
  expect(completed.status).toBe(200);
  const ended = (
    (await completed.json()) as { run: PostgresPoolQualificationRun }
  ).run;
  expect(ended.status).toBe("completed");
  expect(ended.qualification!.candidate_spec_sha256).toBe(f.specHash);
  expect(ended.qualification!.receipt_sha256).toBe(ended.receipt_sha256);
  expect(
    (await env.DB.prepare(
      "SELECT count(*) count FROM node_postgres_pool_policies WHERE node_id=?",
    )
      .bind(f.node)
      .first<{ count: number }>())!.count,
  ).toBe(0);
  await expect(
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET evidence_json='{}' WHERE id=?",
    )
      .bind(run.id)
      .run(),
  ).rejects.toThrow();
  expect((await request(url, f.agent, "POST", body)).status).toBe(409);
});

it("cannot complete a receipt when boot drift first appears during final cleanup", async () => {
  const f = await poolQualificationSource(releases),
    started = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(started.status).toBe(202);
  const run = (await started.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const prepared = await qualificationCompletionState(f, run),
    boot = crypto.randomUUID(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
    ).bind(boot, f.node),
    env.DB.prepare(
      "UPDATE pool_storage_observations SET observation_json=json_set(observation_json,'$.boot_id',?) WHERE database_id=?",
    ).bind(boot, f.database),
    env.DB.prepare(
      "UPDATE pool_bindings SET node_report_json=json_set(node_report_json,'$.boot_id',?,'$.observed_at',?) WHERE id=?",
    ).bind(boot, now, prepared.bindingId),
  ]);
  const url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    input = (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    },
    p = input.qualification.challenge;
  await recordCleanupController(f, run, {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: boot,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: now,
  });
  const response = await request(url, f.agent, "POST", {
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    sequence: p.sequence,
    nonce: p.nonce,
    producer: p.producer,
    node_uid: f.uid,
    boot_id: boot,
    candidate_spec_sha256: f.specHash,
    started_at: now,
    observed_at: Date.now(),
    measurement: prepared.measurement,
  });
  expect(response.status).toBe(200);
  const ended = (
    (await response.json()) as { run: PostgresPoolQualificationRun }
  ).run;
  expect(ended.status).toBe("failed");
  expect(ended.error_code).toBe("pool_qualification_scope_changed");
  expect(ended.receipt_sha256).toBeNull();
});

it("admits read-only qualification inspection before clean sleep evidence exists", async () => {
  const f = await poolQualificationSource(releases);
  await env.DB.prepare(
    "DELETE FROM database_runtime_holders WHERE database_id=?",
  )
    .bind(f.database)
    .run();
  const response = await request(
    `/v1/nodes/${f.node}/postgres-pool/qualifications`,
    f.admin,
    "POST",
    f.request,
  );
  expect(response.status).toBe(202);
  const run = (await response.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  expect(run.evidence).toHaveLength(0);
  expect(run.receipt_sha256).toBeNull();
  const input = (await (
    await request(
      `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
      f.agent,
    )
  ).json()) as { qualification: PostgresPoolQualificationInput };
  expect(input.qualification.challenge.gate).toBe("host_mount_context");
  expect(
    (await env.DB.prepare(
      "SELECT count(*) count FROM pool_bindings WHERE database_id=?",
    )
      .bind(f.database)
      .first<{ count: number }>())!.count,
  ).toBe(0);
});

it("exposes the accepted immutable source sleep without retiming or a new age gate", async () => {
  const f = await poolQualificationSource(releases),
    response = await request(
      `/v1/nodes/${f.node}/postgres-pool/qualifications`,
      f.admin,
      "POST",
      f.request,
    );
  expect(response.status).toBe(202);
  const run = (await response.json()) as PostgresPoolQualificationRun;
  runs.push(run.id);
  const original = { ...f.sleep, observed_at: Date.now() - 120000 };
  await env.DB.prepare(
    "UPDATE database_runtime_holders SET sleep_json=? WHERE database_id=?",
  )
    .bind(JSON.stringify(original), f.database)
    .run();
  const url = `/agent/v1/nodes/${f.node}/postgres-pool/qualification`,
    input = (await (await request(url, f.agent)).json()) as {
      qualification: PostgresPoolQualificationInput;
    };
  expect(input.qualification.accepted_sleep).toEqual(original);
  await env.DB.prepare(
    "UPDATE database_runtime_holders SET clean_stop=0 WHERE database_id=?",
  )
    .bind(f.database)
    .run();
  const revoked = (await (await request(url, f.agent)).json()) as {
    qualification: PostgresPoolQualificationInput;
  };
  expect(revoked.qualification.accepted_sleep).toBeNull();
});

it("requires the current thin host and physical authority qualification before admitting a run", async () => {
  const f = await poolQualificationSource(releases);
  await env.DB.prepare(
    "UPDATE node_host_configurations SET release_id=? WHERE node_id=?",
  )
    .bind(f.qualified.releaseId, f.node)
    .run();
  expect(
    (
      await request(
        `/v1/nodes/${f.node}/postgres-pool/qualifications`,
        f.admin,
        "POST",
        f.request,
      )
    ).status,
  ).toBe(409);
  expect(
    (await env.DB.prepare(
      "SELECT count(*) count FROM postgres_pool_qualification_runs WHERE node_id=?",
    )
      .bind(f.node)
      .first<{ count: number }>())!.count,
  ).toBe(0);
});
