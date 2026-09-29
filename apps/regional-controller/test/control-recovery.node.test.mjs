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
    let reads = 0;
    const snapshot = await captureControlSnapshot(
      async (sql) => {
        reads++;
        return f.query(sql);
      },
      migrationDirectory,
      f.source,
      "2026-09-29T00:02:00.000Z",
    );
    assert.equal(reads, 1);
    assert.equal(snapshot.migrations.files.length, 14);
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
