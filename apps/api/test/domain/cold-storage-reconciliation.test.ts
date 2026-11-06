// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { archiveDestinationPath, NodeDesiredQuery } from "@pgcf/contracts";
import {
  coldStorageVerificationCancellations,
  requestColdStorageWake,
  runColdStorageCron,
  startColdStorageArchive,
} from "../../src/domain/cold-storage.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import { nodeDesiredPage } from "../../src/domain/node-desired.ts";
import { placementNodes } from "../../src/domain/placement.ts";
import { nodeKeyPair } from "./fixtures.ts";
import { observation, report } from "./lifecycle-fixture.ts";
import {
  sleeping,
  claimed,
  archived,
  receipt,
  status,
  residency,
  activePins,
  cleanupColdFixture,
  type Fixture,
} from "./cold-storage-fixture.ts";

// Multi-boundary D1 scenarios are correctness checks, not connection-latency benchmarks.
afterEach(cleanupColdFixture);
const disabled = (f: Fixture) => ({
  ...f.configured,
  COLD_STORAGE_ARCHIVAL_ENABLED: "false",
});
async function retiring(f: Fixture) {
  const c = await claimed(f);
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [receipt(c.task)],
  });
  return { ...c, row: await status(c.operation) };
}
async function otherQualified(f: Fixture) {
  const key = await nodeKeyPair();
  await env.DB.prepare(
    `UPDATE nodes SET public_key=?,reported_release_id=?,os_boot_id=(SELECT os_boot_id FROM nodes WHERE id=?),
    os_booted_at=(SELECT os_booted_at FROM nodes WHERE id=?),os_kernel_release=(SELECT os_kernel_release FROM nodes WHERE id=?),
    os_packages_sha256=(SELECT os_packages_sha256 FROM nodes WHERE id=?),os_host_files_sha256=(SELECT os_host_files_sha256 FROM nodes WHERE id=?),last_observed_at=? WHERE id=?`,
  )
    .bind(
      key.publicKey,
      f.release,
      f.node,
      f.node,
      f.node,
      f.node,
      f.node,
      new Date().toISOString(),
      f.other,
    )
    .run();
}

it(
  "resumes a durably admitted wake after a crash between archive completion and child creation",
  { timeout: 30000 },
  async () => {
    const f = await sleeping(),
      c = await retiring(f),
      at = new Date().toISOString();
    const wake = await requestColdStorageWake(f.configured, f.id, {
      role: "app",
    });
    expect(wake.operationId).toBe(c.operation);
    // Persisted boundary after positive removal acknowledgment, before the next invocation can start recovery.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE lifecycle_orders SET result_status='done',closed_at=? WHERE operation=?",
      ).bind(at, c.row.retirement_operation),
      env.DB.prepare(
        "UPDATE database_cold_storage SET phase='archived',source_removed_at=?,completed_at=? WHERE operation=?",
      ).bind(at, at, c.operation),
      env.DB.prepare(
        "UPDATE databases SET storage_residency='archived',node_id=NULL,runtime_json=NULL WHERE id=?",
      ).bind(f.id),
      env.DB.prepare(
        "UPDATE lifecycle_orders SET closed_at=? WHERE operation=?",
      ).bind(at, c.operation),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT status FROM cold_storage_operations WHERE id=?",
      )
        .bind(c.operation)
        .first("status"),
    ).toBe("running");
    await runColdStorageCron(disabled(f));
    const current = await residency(f.id);
    expect(current).toMatchObject({
      storage_residency: "restoring",
      node_id: null,
    });
    const successor = await status(current!.storage_operation_id as string);
    expect(successor.source_operation).toBe(c.operation);
    await runColdStorageCron(disabled(f));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM database_cold_storage WHERE source_operation=?",
      )
        .bind(c.operation)
        .first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT status FROM cold_storage_operations WHERE id=?",
      )
        .bind(c.operation)
        .first("status"),
    ).toBe("running");
  },
);

it(
  "delivers explicit cleanup for an unacknowledged verification page and blocks another verifier until cleanup",
  { timeout: 30000 },
  async () => {
    const f = await sleeping(),
      c = await claimed(f);
    // The page has been issued but never reaches the native verifier: there is no native journal.
    await requestColdStorageWake(f.configured, f.id, { role: "app" });
    expect(await activePins(f.id)).toBe(1);
    expect(await startColdStorageArchive(f.configured, f.id)).toBeNull();
    const cancellations = await coldStorageVerificationCancellations(
      f.configured,
      f.node,
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.operation).toBe(c.operation);
    const node = await env.DB.prepare(
      "SELECT id,node_uid uid,region_id FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ id: string; uid: string; region_id: string }>();
    const page = await nodeDesiredPage(
      f.configured,
      { ...node!, fenced: true },
      NodeDesiredQuery.parse({}),
    );
    expect(page.archive_verification_cancellations).toEqual(cancellations);
    await applyLifecycleObservations(f.configured, f.node, {
      ...report([]),
      archive_verifications: [
        {
          ...cancellations[0]!,
          observed_at: new Date().toISOString(),
          status: "failed",
          reason: "archive_cancelled",
          cleaned_up: true,
        },
      ],
    });
    expect(await activePins(f.id)).toBe(0);
    expect(await startColdStorageArchive(f.configured, f.id)).not.toBeNull();
  },
);

it(
  "backs off a failed source proof, while a new proof may be verified immediately",
  { timeout: 30000 },
  async () => {
    const f = await sleeping(),
      c = await claimed(f);
    await applyLifecycleObservations(f.configured, f.node, {
      ...report([]),
      archive_verifications: [
        {
          operation: c.operation,
          database_id: f.id,
          source_generation: c.task.source_generation,
          source_storage_generation: c.task.source_storage_generation,
          inventory_sha256: c.task.inventory_sha256,
          observed_at: new Date().toISOString(),
          status: "failed",
          reason: "archive_unusable",
          cleaned_up: true,
        },
      ],
    });
    expect(await activePins(f.id)).toBe(0);
    expect(await startColdStorageArchive(f.configured, f.id)).toBeNull();
    const proof = {
      ...f.proof,
      proven_at: new Date(Date.parse(f.proof.proven_at) + 1).toISOString(),
    };
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE databases SET proven_sleep_json=?,sleep_since=? WHERE id=?",
      ).bind(JSON.stringify(proof), proof.proven_at, f.id),
      env.DB.prepare(
        "UPDATE database_recovery_points SET proven_sleep_json=? WHERE database_id=?",
      ).bind(JSON.stringify(proof), f.id),
    ]);
    expect(await startColdStorageArchive(f.configured, f.id)).not.toBeNull();
  },
);

it(
  "keeps failed-target capacity reserved until cleanup and retries a positively fenced lost target elsewhere",
  { timeout: 30000 },
  async () => {
    const f = await sleeping();
    await archived(f);
    await otherQualified(f);
    // Ensure the first target is the original node.
    await env.DB.prepare(
      "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
    )
      .bind(f.other)
      .run();
    const wake = await requestColdStorageWake(f.configured, f.id, {
        role: "app",
      }),
      target = await status(wake.operationId!);
    const before = (await placementNodes(env.DB, f.region)).find(
      (n) => n.id === f.node,
    )!;
    expect(before.pending_memory_mib).toBeGreaterThan(0);
    await applyLifecycleObservations(
      f.configured,
      f.node,
      report([
        observation({
          id: f.id,
          operation: target.operation,
          generation: target.target_generation!,
          storage_generation: target.target_storage_generation!,
          state: "error",
          error: "build_failed",
        }),
      ]),
    );
    expect((await status(target.operation)).phase).toBe("failed");
    const after = (await placementNodes(env.DB, f.region)).find(
      (n) => n.id === f.node,
    )!;
    expect(after.pending_memory_mib).toBeGreaterThanOrEqual(
      before.pending_memory_mib,
    );
    expect(after.pending_storage_mib).toBeGreaterThanOrEqual(
      before.pending_storage_mib,
    );
    expect(
      (await requestColdStorageWake(f.configured, f.id, { role: "app" }))
        .waiting,
    ).toBe(false);
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO node_losses(node_id,region_id,declared_at,reason) VALUES(?,?,?,'test loss')",
      ).bind(f.node, f.region, at),
      env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?").bind(at, f.node),
      env.DB.prepare(
        "UPDATE nodes SET database_placement_enabled=1 WHERE id=?",
      ).bind(f.other),
    ]);
    expect(
      (await requestColdStorageWake(f.configured, f.id, { role: "app" }))
        .waiting,
    ).toBe(false);
    await env.DB.prepare(
      "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
    )
      .bind(at, at, at, f.node)
      .run();
    const retry = await requestColdStorageWake(f.configured, f.id, {
      role: "app",
    });
    expect(retry.operationId).not.toBe(target.operation);
    expect(await status(retry.operationId!)).toMatchObject({
      phase: "restoring",
      target_node_id: f.other,
    });
  },
);

/** Rows represent durable already-accepted jobs, not product data or native acceptance evidence. */
async function blockedJob(f: Fixture, index: number) {
  const id = `a${index.toString().padStart(19, "0")}`,
    source = `op_1${index.toString().padStart(19, "0")}`,
    operation = `op_${index.toString().padStart(20, "0")}`;
  const at = new Date().toISOString(),
    path = archiveDestinationPath(
      env.ARCHIVE_BUCKET_NAME,
      f.region,
      id,
      1,
      source,
    );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,generation,archive_path,created_at,updated_at,own_memory_mib,storage_residency,storage_operation_id)
      VALUES(?,?,?,NULL,?,?,'running',1,?,?,?,4096,'restoring',?)`,
    ).bind(
      id,
      f.project,
      f.region,
      `blocked-${index}`,
      f.size,
      path,
      at,
      at,
      operation,
    ),
    env.DB.prepare(
      `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.archive','succeeded',?,?,1,?,?,?)`,
    ).bind(source, f.project, id, at, at, at),
    env.DB.prepare(
      `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,phase,source_node_id,source_generation,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,verification_receipt_json,source_removed_at,created_at,updated_at,completed_at)
      VALUES(?,'archive',?,?,?,'archived',?,1,1,?,?,?,'{}',?,?,?,?)`,
    ).bind(
      source,
      id,
      f.project,
      f.region,
      f.node,
      path,
      f.backup.backup_id,
      JSON.stringify(f.proof),
      at,
      at,
      at,
      at,
    ),
    env.DB.prepare(
      `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES(?,'database.rehydrate','pending',?,?,2,?,?)`,
    ).bind(operation, f.project, id, at, at),
    env.DB.prepare(
      `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,source_operation,phase,source_node_id,source_generation,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,created_at,updated_at)
      VALUES(?,'rehydrate',?,?,?,?,'waiting_capacity',?,1,1,?,?,?,?,?)`,
    ).bind(
      operation,
      id,
      f.project,
      f.region,
      source,
      f.node,
      path,
      f.backup.backup_id,
      JSON.stringify(f.proof),
      at,
      at,
    ),
    env.DB.prepare(
      "INSERT INTO archive_pins(operation,archive_path,database_id,created_at) VALUES(?,?,?,?),(?,?,?,?)",
    ).bind(source, path, id, at, operation, path, id, at),
  ]);
}

it(
  "advances the active cursor past fifty blocked recoveries to a newer eligible job",
  { timeout: 30000 },
  async () => {
    const f = await sleeping();
    await archived(f);
    await env.DB.prepare(
      "UPDATE nodes SET last_sample_json=json_set(last_sample_json,'$.room',json('false')) WHERE id=?",
    )
      .bind(f.node)
      .run();
    const wake = await requestColdStorageWake(disabled(f), f.id, {
      role: "app",
    });
    for (let i = 0; i < 50; i++) await blockedJob(f, i);
    expect(wake.operationId! > `op_${(49).toString().padStart(20, "0")}`).toBe(
      true,
    );
    await env.DB.prepare(
      "UPDATE nodes SET last_sample_json=json_set(last_sample_json,'$.room',json('true'),'$.memory.available_bytes',json_extract(last_sample_json,'$.memory.total_bytes')/2) WHERE id=?",
    )
      .bind(f.node)
      .run();
    await runColdStorageCron(disabled(f));
    expect((await status(wake.operationId!)).phase).toBe("waiting_capacity");
    await runColdStorageCron(disabled(f));
    expect((await status(wake.operationId!)).phase).toBe("restoring");
  },
);

it(
  "advances the due cursor past twenty ineligible sleepers",
  { timeout: 30000 },
  async () => {
    const f = await sleeping(),
      at = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      const id = `a${i.toString().padStart(19, "0")}`,
        op = `op_0${i.toString().padStart(19, "0")}`;
      const path = archiveDestinationPath(
        env.ARCHIVE_BUCKET_NAME,
        f.region,
        id,
        1,
        op,
      );
      await env.DB.prepare(
        `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,generation,archive_path,created_at,updated_at,observed_state,observed_power,observed_generation,sleep_since)
      VALUES(?,?,?,NULL,?,?,'suspended',1,?,?,?,'provisioning','hibernated',1,?)`,
      )
        .bind(
          id,
          f.project,
          f.region,
          `no-proof-${i}`,
          f.size,
          path,
          at,
          at,
          f.proof.proven_at,
        )
        .run();
    }
    expect((await runColdStorageCron(f.configured)).claimed).toBe(0);
    expect((await runColdStorageCron(f.configured)).claimed).toBe(1);
    expect(await residency(f.id)).toMatchObject({
      storage_residency: "archiving",
    });
  },
);
