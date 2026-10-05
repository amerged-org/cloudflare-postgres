// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { recoveryFixture } from "./recovery-fixture.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import { buildDatabaseManifests } from "../../src/agent/builders/index.ts";
import { record } from "../../src/agent/types.ts";
import { MemoryKubernetes, metrics, authenticate } from "./fixtures.ts";

test("uses source database recovery and distinct archive rather than creating an empty target", () => {
  const { db, ctx } = recoveryFixture();
  const manifests = buildDatabaseManifests(db, ctx),
    cluster = manifests.find((o) => o.kind === "Cluster")!;
  const spec = record(cluster.spec),
    boot = record(spec.bootstrap),
    recovery = record(boot.recovery);
  assert.equal(boot.initdb, undefined);
  assert.equal(recovery.database, db.recovery!.source_database_id);
  assert.equal(
    record(recovery.recoveryTarget).backupID,
    db.recovery!.backup_id,
  );
  assert.equal(
    record(recovery.recoveryTarget).targetTime,
    db.recovery!.target_time,
  );
  assert.equal(spec.enableSuperuserAccess, true);
  assert.equal(record(spec.superuserSecret).name, "restore-superuser");
  const source = manifests.find(
    (o) => o.kind === "ObjectStore" && o.metadata.name === "recovery-source",
  )!;
  assert.equal(
    record(record(source.spec).configuration).destinationPath,
    db.recovery!.source_archive_path,
  );
});
test("SQL failure never publishes a target and restart can resume the same recovery storage", async () => {
  const { db, ctx } = recoveryFixture(),
    k8s = new MemoryKubernetes();
  let mapped = false,
    calls = 0;
  const admin = async () => {
    calls++;
    return mapped;
  };
  const reconciler = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      authenticate,
      undefined,
      undefined,
      undefined,
      undefined,
      admin,
    );
  const first = await reconciler().reconcile(db, ctx);
  assert.notEqual(first?.state, "ready");
  assert.ok(calls > 0);
  const original = await k8s.read("Cluster", `pgcf-db-${db.id}`, "database");
  assert.ok(original);
  mapped = true;
  const complete = await reconciler().reconcile(db, ctx);
  assert.equal(complete?.state, "ready");
  assert.deepEqual(complete?.recovery, {
    operation_id: db.recovery!.operation_id,
    storage_generation: 2,
    verified: true,
  });
  const after = await k8s.read("Cluster", `pgcf-db-${db.id}`, "database");
  assert.equal(after?.metadata.uid, original.metadata.uid);
  assert.equal(record(after?.spec).enableSuperuserAccess, false);
  assert.equal(
    await k8s.read("Secret", `pgcf-db-${db.id}`, "restore-superuser"),
    null,
  );
  const repeat = await reconciler().reconcile(db, ctx);
  assert.equal(repeat?.state, "ready");
  assert.equal(
    k8s.actions.filter((a) => a === "create:Cluster:database").length,
    1,
  );
});

test("a restored target can be deleted without resurrecting its retained source", async () => {
  const { db, ctx } = recoveryFixture(),
    k8s = new MemoryKubernetes();
  const reconciler = new Reconciler(
    k8s,
    new AbortController().signal,
    Date.now,
    metrics,
    authenticate,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => true,
  );
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  const source = db.recovery!.source_database_id;
  db.desired_state = "deleted";
  db.generation = 2;
  db.recovery = undefined;
  db.roles = [];
  assert.equal((await reconciler.reconcile(db))?.state, "deleted");
  assert.equal(
    await k8s.read("Namespace", undefined, `pgcf-db-${source}`),
    null,
  );
});
