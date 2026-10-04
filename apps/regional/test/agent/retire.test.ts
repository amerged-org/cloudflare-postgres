// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { newOperationId } from "@pgcf/contracts";
import {
  gatewayFenceName,
  GATEWAY_FENCE_LABEL,
} from "@pgcf/contracts/gateway-control";
import { retireGatewayFence } from "../../src/agent/retire.ts";
import { MemoryKubernetes, fixture } from "./fixtures.ts";
import { record } from "../../src/agent/types.ts";

class CasKubernetes extends MemoryKubernetes {
  override async delete(
    kind: string,
    namespace: string | undefined,
    name: string,
    uid: string,
    version?: string,
  ) {
    const value = await this.read(kind, namespace, name);
    if (
      value &&
      version !== undefined &&
      value.metadata.resourceVersion !== version
    )
      throw new Error("fixture_version_conflict");
    await super.delete(kind, namespace, name, uid);
  }
}
function setup() {
  const k8s = new CasKubernetes(),
    { db } = fixture();
  db.desired_state = "deleted";
  db.generation = 2;
  const uid = randomUUID(),
    operation = newOperationId();
  const map = k8s.put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: gatewayFenceName(db.id),
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": db.id, [GATEWAY_FENCE_LABEL]: "true" },
    },
    data: {
      "intent.json": JSON.stringify({
        database: db.id,
        operation,
        revision: 1,
        mode: "running",
      }),
    },
  });
  const storage = k8s.put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `storage-${db.id}`,
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": db.id },
      annotations: {
        "pgcf.io/generation": "2",
        "pgcf.io/gateway-fence-uid": map.metadata.uid!,
      },
    },
    data: { state: "{}" },
  });
  const ledger = k8s.put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `delete-${db.id}`,
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": db.id },
      annotations: { "pgcf.io/generation": "2" },
    },
    data: {
      state: JSON.stringify({
        startedAt: 1,
        namespaceUid: uid,
        volumes: [],
        completed: false,
      }),
    },
  });
  const pods = [1, 2].map((n) => ({
    name: `gateway-${n}`,
    uid: randomUUID(),
    ip: [10, 20, 0, n].join("."),
    restarts: 0,
  }));
  const keyring = {
    active: "fixture",
    keys: new Map([["fixture", randomBytes(32)]]),
  };
  let now = 100_000,
    calls = 0,
    busy = false;
  const snapshot = async () => ({
    pods,
    keyring,
    keyUid: randomUUID(),
    keyVersion: "1",
  });
  const keyUid = randomUUID();
  const options = {
    k8s,
    signal: new AbortController().signal,
    now: () => now,
    snapshot: async () => ({ ...(await snapshot()), keyUid }),
    fetcher: async (_input: unknown, init?: RequestInit) => {
      calls++;
      const token = new Headers(init?.headers).get("X-PGCF-Control")!;
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
      );
      assert.equal(claims.action, "retire");
      assert.equal(init?.redirect, "error");
      return Response.json({
        database: db.id,
        operation: claims.operation,
        revision: claims.revision,
        pod: claims.pod,
        mode: "retired",
        status: "retired",
        connections: busy ? 1 : 0,
        busyConnections: 0,
        pendingDials: 0,
      });
    },
  };
  return {
    k8s,
    db,
    map,
    ledger,
    storage,
    pods,
    options,
    advance: () => {
      now += 66_000;
    },
    calls: () => calls,
    setBusy: () => {
      busy = true;
    },
  };
}
test("retirement persists a newer same-UID terminal marker, waits the token window, acknowledges all Pods and deletes with CAS", async () => {
  const f = setup();
  assert.equal(await retireGatewayFence(f.db, f.options), false);
  const terminal = await f.k8s.read(
    "ConfigMap",
    "pgcf-system",
    gatewayFenceName(f.db.id),
  );
  assert.equal(terminal!.metadata.uid, f.map.metadata.uid);
  assert.equal(
    JSON.parse(String(record(terminal!.data)["intent.json"])).mode,
    "retired",
  );
  assert.equal(f.calls(), 0);
  f.advance();
  assert.equal(await retireGatewayFence(f.db, f.options), true);
  assert.equal(f.calls(), 2);
  assert.equal(
    await f.k8s.read("ConfigMap", "pgcf-system", gatewayFenceName(f.db.id)),
    null,
  );
  assert.equal(await retireGatewayFence(f.db, f.options), true);
});
test("physical leftovers and live desired state cannot publish a retirement marker", async () => {
  const f = setup();
  f.k8s.put({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: `pgcf-db-${f.db.id}` },
  });
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
  assert.equal(
    JSON.parse(
      String(
        record(
          (await f.k8s.read(
            "ConfigMap",
            "pgcf-system",
            gatewayFenceName(f.db.id),
          ))!.data,
        )["intent.json"],
      ),
    ).mode,
    "running",
  );
  f.k8s.resources.delete(
    f.k8s.key("Namespace", undefined, `pgcf-db-${f.db.id}`),
  );
  f.db.desired_state = "running";
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
});
test("missing or replaced regular history is never recreated or retired", async () => {
  const f = setup();
  f.k8s.resources.delete(
    f.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(f.db.id)),
  );
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
  f.k8s.put({ ...f.map, metadata: { ...f.map.metadata } });
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
});
test("busy or incomplete inventory cannot remove a terminal marker", async () => {
  const f = setup();
  await retireGatewayFence(f.db, f.options);
  f.advance();
  f.setBusy();
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
  assert.ok(
    await f.k8s.read("ConfigMap", "pgcf-system", gatewayFenceName(f.db.id)),
  );
});

test("a lost delete response resumes only its persisted terminal deletion receipt without replay", async () => {
  const f = setup();
  await retireGatewayFence(f.db, f.options);
  f.advance();
  const original = f.k8s.delete.bind(f.k8s);
  let mutations = 0;
  f.k8s.delete = async (...args: Parameters<CasKubernetes["delete"]>) => {
    mutations++;
    await original(...args);
    throw new Error(randomBytes(32).toString("hex"));
  };
  await assert.rejects(() => retireGatewayFence(f.db, f.options), {
    message: "gateway_retirement_recovery_required",
  });
  assert.equal(await retireGatewayFence(f.db, f.options), true);
  assert.equal(mutations, 1);
  assert.equal(f.calls(), 2);
});
test("a changed marker version or gateway restart during acknowledgement cannot be adopted for deletion", async () => {
  const f = setup();
  await retireGatewayFence(f.db, f.options);
  f.advance();
  const original = f.options.fetcher;
  f.options.fetcher = async (...args: Parameters<typeof original>) => {
    const report = await original(...args);
    f.pods[0]!.restarts++;
    return report;
  };
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
  assert.ok(
    await f.k8s.read("ConfigMap", "pgcf-system", gatewayFenceName(f.db.id)),
  );
  const g = setup();
  await retireGatewayFence(g.db, g.options);
  g.advance();
  const deleted = g.k8s.delete.bind(g.k8s);
  g.k8s.delete = async (...args: Parameters<CasKubernetes["delete"]>) => {
    const map = g.k8s.resources.get(
      g.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(g.db.id)),
    )!;
    map.metadata.resourceVersion = String(++g.k8s.revision);
    await deleted(...args);
  };
  await assert.rejects(() => retireGatewayFence(g.db, g.options));
  await assert.rejects(() => retireGatewayFence(g.db, g.options));
  assert.ok(
    await g.k8s.read("ConfigMap", "pgcf-system", gatewayFenceName(g.db.id)),
  );
});
test("a recorded retained PV or LVM cannot be hidden by namespace disappearance", async () => {
  const f = setup(),
    handle = randomUUID(),
    volumeUid = randomUUID(),
    claimUid = randomUUID();
  const key = f.k8s.key("ConfigMap", "pgcf-system", `delete-${f.db.id}`),
    ledger = f.k8s.resources.get(key)!;
  ledger.data = {
    state: JSON.stringify({
      startedAt: 1,
      namespaceUid: randomUUID(),
      volumes: [{ name: "volume", uid: volumeUid, claimUid, handle }],
      completed: false,
    }),
  };
  f.k8s.put({
    apiVersion: "v1alpha1",
    kind: "LVMVolume",
    metadata: { name: handle, namespace: "storage" },
  });
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
  assert.equal(
    JSON.parse(
      String(
        record(
          (await f.k8s.read(
            "ConfigMap",
            "pgcf-system",
            gatewayFenceName(f.db.id),
          ))!.data,
        )["intent.json"],
      ),
    ).mode,
    "running",
  );
});

test("verified deletion keeps volume identities and the storage binding until retirement acknowledgement, then completes its ledger", async () => {
  const { Reconciler } = await import("../../src/agent/reconcile.ts");
  const { metrics, authenticate } = await import("./fixtures.ts");
  const { db, ctx } = fixture(),
    k8s = new CasKubernetes();
  const signal = new AbortController().signal;
  k8s.backupSecret(ctx);
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal,
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  k8s.addStorage(db);
  const marker = k8s.put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: gatewayFenceName(db.id),
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": db.id, [GATEWAY_FENCE_LABEL]: "true" },
    },
    data: {
      "intent.json": JSON.stringify({
        database: db.id,
        operation: newOperationId(),
        revision: 1,
        mode: "running",
      }),
    },
  });
  const storage = k8s.resources.get(
    k8s.key("ConfigMap", "pgcf-system", `storage-${db.id}`),
  )!;
  storage.metadata.annotations = {
    ...storage.metadata.annotations,
    "pgcf.io/gateway-fence-uid": marker.metadata.uid!,
  };
  const f = setup();
  let now = Date.now();
  const power = {
    gatewaySnapshot: f.options.snapshot,
  } as unknown as import("../../src/agent/power.ts").PowerCoordinator;
  const fetcher: typeof fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get("X-PGCF-Control")!;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    );
    return Response.json({
      database: claims.database,
      operation: claims.operation,
      revision: claims.revision,
      pod: claims.pod,
      mode: "retired",
      status: "retired",
      connections: 0,
      busyConnections: 0,
      pendingDials: 0,
    });
  };
  const deleted = { ...db, generation: 2, desired_state: "deleted" as const };
  const first = new Reconciler(
    k8s,
    signal,
    () => now,
    fetcher,
    authenticate,
    power,
  );
  assert.equal((await first.reconcile(deleted))?.state, "deleting");
  assert.ok(await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`));
  const ledger = await k8s.read("ConfigMap", "pgcf-system", `delete-${db.id}`);
  const state = JSON.parse(String(record(ledger!.data).state));
  assert.equal(state.completed, false);
  assert.ok(state.volumes.length > 0);
  now += 66_000;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal,
        () => now,
        fetcher,
        authenticate,
        power,
      ).reconcile(deleted)
    )?.state,
    "deleted",
  );
  assert.equal(
    await k8s.read("ConfigMap", "pgcf-system", gatewayFenceName(db.id)),
    null,
  );
  assert.equal(
    await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`),
    null,
  );
  const completed = await k8s.read(
    "ConfigMap",
    "pgcf-system",
    `delete-${db.id}`,
  );
  assert.equal(
    JSON.parse(String(record(completed!.data).state)).completed,
    true,
  );
  assert.equal(
    JSON.parse(String(record(completed!.data)["gateway-retirement.json"]))
      .phase,
    "deleting",
  );
});

test("slow publication/readback cannot consume the terminal hold window", async () => {
  const f = setup(),
    read = f.k8s.read.bind(f.k8s);
  let delayed = false;
  f.k8s.read = async (...args: Parameters<CasKubernetes["read"]>) => {
    const value = await read(...args);
    if (
      !delayed &&
      args[2] === gatewayFenceName(f.db.id) &&
      value &&
      JSON.parse(String(record(value.data)["intent.json"])).mode === "retired"
    ) {
      delayed = true;
      f.advance();
    }
    return value;
  };
  assert.equal(await retireGatewayFence(f.db, f.options), false);
  assert.equal(await retireGatewayFence(f.db, f.options), false);
  assert.equal(f.calls(), 0);
  f.advance();
  assert.equal(await retireGatewayFence(f.db, f.options), true);
});

test("a published terminal marker lost before its exact deletion receipt remains recovery-required", async () => {
  const f = setup();
  await retireGatewayFence(f.db, f.options);
  f.advance();
  f.k8s.resources.delete(
    f.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(f.db.id)),
  );
  await assert.rejects(() => retireGatewayFence(f.db, f.options));
});

test("a guarded foreground deletion waits for actual ConfigMap disappearance without repeating deletion", async () => {
  const f = setup();
  await retireGatewayFence(f.db, f.options);
  f.advance();
  let deletes = 0;
  f.k8s.delete = async (...args: Parameters<CasKubernetes["delete"]>) => {
    deletes++;
    const map = f.k8s.resources.get(f.k8s.key(args[0], args[1], args[2]))!;
    assert.equal(args[3], map.metadata.uid);
    assert.equal(args[4], map.metadata.resourceVersion);
    map.metadata.deletionTimestamp = new Date().toISOString();
    map.metadata.resourceVersion = String(++f.k8s.revision);
  };
  assert.equal(await retireGatewayFence(f.db, f.options), false);
  assert.equal(await retireGatewayFence(f.db, f.options), false);
  assert.equal(deletes, 1);
  f.k8s.resources.delete(
    f.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(f.db.id)),
  );
  assert.equal(await retireGatewayFence(f.db, f.options), true);
  assert.equal(deletes, 1);
});
