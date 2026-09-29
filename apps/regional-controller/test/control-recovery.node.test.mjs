// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  fixture,
  migrationDirectory,
} from "./control-recovery-fixture/fixture.mjs";
import { captureControlSnapshot } from "../src/control-snapshot.ts";
import {
  createRecoveryBundle,
  restoreRecoveryBundle,
} from "../src/control-recovery.ts";

test("rebuilds all current control migrations and historical encrypted credentials exactly from one read into a quarantined private recovery directory", async () => {
  const f = await fixture();
  try {
    const backupId = "99999999-9999-4999-8999-999999999999",
      operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tokenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      now = "2026-09-29T00:00:00.000Z",
      observedAt = "2026-09-29T00:00:30.000Z",
      resourceName = `backup-${backupId.replaceAll("-", "")}`;
    const binding = JSON.stringify({
      namespaceUid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clusterUid: f.ids.cluster,
      specHash: "a".repeat(64),
      objectStoreUid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      objectStoreGeneration: 1,
      objectStoreSpecHash: "d".repeat(64),
      backupName: resourceName,
      backupSpecHash: "e".repeat(64),
    });
    const observation = JSON.stringify({
      ...JSON.parse(binding),
      backupResourceUid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      backupResourceVersion: "9007199254740994",
      phase: "completed",
      artifact: {
        backupId: "20260929T000000",
        backupName: "backup-20260929T000000",
        majorVersion: 18,
        startedAt: now,
        stoppedAt: observedAt,
        beginWal: "000000010000000000000001",
        endWal: "000000010000000000000002",
        beginLSN: "0/1000000",
        endLSN: "0/2000000",
        online: true,
        pluginMetadata: {
          timeline: "1",
          version: "0.15.0",
          name: "barman-cloud.cloudnative-pg.io",
          displayName: "BarmanCloudInstance",
          clusterUID: f.ids.cluster,
          pluginName: "barman-cloud.cloudnative-pg.io",
        },
      },
      remoteObjectsVerified: false,
      restoreVerified: false,
    });
    f.db
      .prepare("INSERT INTO region_tokens VALUES(?,?,?,?,?,?)")
      .run(
        tokenId,
        f.ids.region,
        "f".repeat(64),
        '["region:execute"]',
        now,
        null,
      );
    f.db
      .prepare(
        "INSERT INTO environment_backups VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        backupId,
        f.ids.organization,
        f.ids.project,
        f.ids.environment,
        f.ids.region,
        1,
        "a".repeat(64),
        '{"profile":{}}',
        "b".repeat(64),
        f.ids.cluster,
        "1",
        0,
        resourceName,
        "completed",
        "backup-version",
        now,
        observedAt,
        observation,
      );
    f.db
      .prepare(
        "INSERT INTO backup_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        operationId,
        backupId,
        "environment.backup",
        "completed",
        tokenId,
        "c".repeat(64),
        1,
        "2026-09-29T00:01:00.000Z",
        "operation-version",
        now,
        observedAt,
        "base_backup_completed",
        "a".repeat(64),
        observation,
      );
    f.db.prepare("INSERT INTO backup_requests VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      f.ids.organization,
      f.ids.project,
      f.ids.environment,
      `environment:${f.ids.environment}:backup:create`,
      "retained-backup-intent",
      "b".repeat(64),
      backupId,
      operationId,
      JSON.stringify({
        backup: { id: backupId, status: "pending" },
        operation: { id: operationId, status: "queued" },
      }),
      now,
    );
    f.db
      .prepare("INSERT INTO backup_dispatches VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        operationId,
        backupId,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        tokenId,
        "c".repeat(64),
        1,
        binding,
        "c".repeat(64),
        now,
      );
    const retainedBackupRows = [
      "environment_backups",
      "backup_operations",
      "backup_requests",
      "backup_dispatches",
    ].map((name) => ({
      name,
      rows: f.db.prepare(`SELECT * FROM ${name}`).all(),
    }));
    const resizeOperationId = "abababab-abab-4aba-8aba-abababababab";
    const resizeResponse = JSON.stringify({
      compute: {
        environmentId: f.ids.environment,
        revision: 1,
        requestedSizeId: "large",
        effectiveSizeId: "standard",
        phase: "requested",
        operationId: resizeOperationId,
        updatedAt: now,
        observedAt: null,
      },
      operation: {
        id: resizeOperationId,
        kind: "environment.resize",
        cause: "manual",
        status: "queued",
        computeRevision: 1,
        fromSizeId: "standard",
        targetSizeId: "large",
        createdAt: now,
        observedAt: null,
        resultCode: "awaiting_authority",
      },
    });
    f.db
      .prepare(
        "INSERT INTO resize_operations(id,organization_id,project_id,environment_id,region_id,kind,cause,status,spec_revision,spec_hash,spec_json,cluster_uid,run_epoch,runtime_revision,policy_hash,compute_revision,from_size_id,target_size_id,created_at,result_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        resizeOperationId,
        f.ids.organization,
        f.ids.project,
        f.ids.environment,
        f.ids.region,
        "environment.resize",
        "manual",
        "queued",
        1,
        "a".repeat(64),
        '{"profile":{}}',
        f.ids.cluster,
        "1",
        0,
        "f".repeat(64),
        1,
        "standard",
        "large",
        now,
        "awaiting_authority",
      );
    f.db
      .prepare(
        "INSERT INTO environment_compute(environment_id,organization_id,project_id,revision,requested_size_id,effective_size_id,phase,operation_id,version_token,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        f.ids.environment,
        f.ids.organization,
        f.ids.project,
        1,
        "large",
        "standard",
        "requested",
        resizeOperationId,
        "compute-version",
        now,
      );
    f.db
      .prepare(
        "INSERT INTO resize_requests(organization_id,project_id,environment_id,scope_key,idempotency_key,request_hash,operation_id,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        f.ids.organization,
        f.ids.project,
        f.ids.environment,
        `environment:${f.ids.environment}:resize`,
        "retained-resize-intent",
        "d".repeat(64),
        resizeOperationId,
        resizeResponse,
        now,
      );
    const retainedResizeRows = [
      "resize_operations",
      "environment_compute",
      "resize_requests",
    ].map((name) => ({
      name,
      rows: f.db.prepare(`SELECT * FROM ${name}`).all(),
    }));
    let reads = 0;
    const snapshot = await captureControlSnapshot(
      async (sql) => {
        reads++;
        assert(Buffer.byteLength(sql, "utf8") <= 99000);
        return f.query(sql);
      },
      migrationDirectory,
      f.source,
      "2026-09-29T00:02:00.000Z",
    );
    assert.equal(reads, 1);
    assert.equal(
      snapshot.tables.some((table) => table.name === "environment_compute"),
      true,
      "control recovery must retain durable compute revisions",
    );
    assert.equal(
      snapshot.tables.some((table) => table.name === "environment_backups"),
      true,
      "current control recovery must include durable backup identities",
    );
    assert.equal(snapshot.migrations.files.length, 16);
    assert.equal(
      snapshot.sequences.find((s) => s.name === "d1_migrations").seq,
      "9007199254740993",
    );
    const archivePath = join(f.directory, "recovery.bundle"),
      targetDirectory = join(f.directory, "offline");
    const sealed = await createRecoveryBundle({
      snapshot,
      keyrings: f.keyrings,
      recoveryKeyFile: f.recoveryKeyFile,
      archivePath,
      migrationDirectory,
    });
    assert.equal(sealed.status, "sealed");
    assert.equal(statSync(archivePath).mode & 0o777, 0o600);
    const ciphertext = readFileSync(archivePath, "utf8");
    for (const secret of [
      f.firstPassword,
      f.currentPassword,
      f.fence,
      ...Object.values(JSON.parse(f.keyrings.ROLE_CREDENTIAL_KEYS).keys),
    ])
      assert(!ciphertext.includes(secret));
    const restored = await restoreRecoveryBundle({
      archivePath,
      recoveryKeyFile: f.recoveryKeyFile,
      targetDirectory,
      migrationDirectory,
      expectedSource: f.source,
    });
    assert.equal(restored.status, "verified_offline");
    assert.equal(restored.activationSupported, false);
    assert.equal(restored.roleCredentials, 2);
    assert.equal(restored.allowanceFences, 1);
    assert.equal(statSync(targetDirectory).mode & 0o777, 0o700);
    const db = new DatabaseSync(join(targetDirectory, "control.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM role_credentials").get().n,
        2,
      );
      assert.equal(
        db
          .prepare(
            "SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name='d1_migrations'",
          )
          .get().seq,
        "9007199254740993",
      );
      assert.equal(
        db
          .prepare("SELECT status FROM allowance_reservations WHERE id=?")
          .get(f.ids.reservation).status,
        "issued",
      );
      for (const retained of retainedBackupRows) {
        assert.equal(retained.rows.length, 1);
        assert.deepEqual(
          db.prepare(`SELECT * FROM ${retained.name}`).all(),
          retained.rows,
          `${retained.name} must retain the exact accepted artifact, dispatch and replay identity`,
        );
      }
      for (const retained of retainedResizeRows) {
        assert.equal(retained.rows.length, 1);
        assert.deepEqual(
          db.prepare(`SELECT * FROM ${retained.name}`).all(),
          retained.rows,
          `${retained.name} must retain the exact queued intention and compute revision`,
        );
      }
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        db.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      JSON.parse(readFileSync(join(targetDirectory, "keyrings.json"), "utf8")),
      f.keyrings,
    );
    const manifest = JSON.parse(
      readFileSync(join(targetDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.activationSupported, false);
    assert.equal(manifest.recoveryFencesImplemented, false);
    assert.equal(
      statSync(join(targetDirectory, "keyrings.json")).mode & 0o777,
      0o600,
    );
  } finally {
    f.close();
  }
});

test("authenticates recovery before publication and refuses wrong keys, missing historical custody, overwritten files and nonprivate CLI configuration without revealing secrets", async () => {
  const f = await fixture();
  try {
    const snapshot = await captureControlSnapshot(
      f.query,
      migrationDirectory,
      f.source,
      "2026-09-29T00:02:00.000Z",
    );
    const archivePath = join(f.directory, "bundle"),
      targetDirectory = join(f.directory, "never");
    const input = {
      snapshot,
      keyrings: f.keyrings,
      recoveryKeyFile: f.recoveryKeyFile,
      archivePath,
      migrationDirectory,
    };
    await createRecoveryBundle(input);
    const original = readFileSync(archivePath);
    await assert.rejects(createRecoveryBundle(input));
    assert.deepEqual(readFileSync(archivePath), original);
    const corruptPath = join(f.directory, "invalid-snapshot");
    await assert.rejects(
      createRecoveryBundle({
        ...input,
        archivePath: corruptPath,
        snapshot: { ...snapshot, sha256: "0".repeat(64) },
      }),
    );
    assert.equal(existsSync(corruptPath), false);
    const missing = {
      ...f.keyrings,
      ROLE_CREDENTIAL_KEYS: JSON.stringify({
        active: "current",
        keys: {
          current: JSON.parse(f.keyrings.ROLE_CREDENTIAL_KEYS).keys.current,
        },
      }),
    };
    const missingPath = join(f.directory, "missing");
    await assert.rejects(
      createRecoveryBundle({
        ...input,
        keyrings: missing,
        archivePath: missingPath,
      }),
    );
    assert.equal(existsSync(missingPath), false);
    const badKey = join(f.directory, "wrong.key");
    writeFileSync(badKey, "A".repeat(43) + "\n", { mode: 0o600 });
    await assert.rejects(
      restoreRecoveryBundle({
        archivePath,
        recoveryKeyFile: badKey,
        targetDirectory,
        migrationDirectory,
        expectedSource: f.source,
      }),
    );
    assert.equal(existsSync(targetDirectory), false);
    const tampered = JSON.parse(original);
    tampered.ciphertext =
      (tampered.ciphertext[0] === "A" ? "B" : "A") +
      tampered.ciphertext.slice(1);
    const tamperedPath = join(f.directory, "tampered");
    writeFileSync(tamperedPath, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(
      restoreRecoveryBundle({
        archivePath: tamperedPath,
        recoveryKeyFile: f.recoveryKeyFile,
        targetDirectory,
        migrationDirectory,
        expectedSource: f.source,
      }),
    );
    assert.equal(existsSync(targetDirectory), false);
    const configPath = join(f.directory, "restore.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        action: "restore",
        archivePath,
        recoveryKeyFile: f.recoveryKeyFile,
        targetDirectory,
        migrationDirectory,
        expectedSource: f.source,
      }),
      { mode: 0o600 },
    );
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          new URL("../src/main.ts", import.meta.url).pathname,
          "recover-control",
          "--config",
          configPath,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
    const result = invoke();
    assert.equal(result.status, 0);
    const publicResult = JSON.parse(result.stdout);
    assert.equal(publicResult.status, "verified_offline");
    assert.equal(publicResult.activationSupported, false);
    for (const secret of [
      f.directory,
      f.firstPassword,
      f.currentPassword,
      f.fence,
      ...Object.values(JSON.parse(f.keyrings.ROLE_CREDENTIAL_KEYS).keys),
    ])
      assert(!`${result.stdout}${result.stderr}`.includes(secret));
    chmodSync(configPath, 0o644);
    const refused = invoke();
    assert.equal(refused.status, 2);
    assert.equal(
      JSON.parse(refused.stdout).error.code,
      "control_recovery_failed",
    );
  } finally {
    f.close();
  }
});
