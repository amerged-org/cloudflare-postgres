// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { newOperationId, newRolePassword } from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import { PowerCoordinator } from "../../src/agent/power.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import {
  fixture,
  MemoryKubernetes,
  authenticate,
  metrics,
} from "./fixtures.ts";
import type { DesiredDatabase } from "@pgcf/contracts";

async function readyFixture() {
  const { db, ctx } = fixture();
  db.maintenance = {
    role: MAINTENANCE_ROLE,
    password: newRolePassword(),
    revision: 1,
  };
  const k8s = new MemoryKubernetes();
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
  const keyring = {
    active: "fixture",
    keys: { fixture: randomBytes(32).toString("base64url") },
  };
  k8s.put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "pgcf-gateway", namespace: "pgcf-system" },
    data: {
      PGCF_ROUTE_KEY: Buffer.from(JSON.stringify(keyring)).toString("base64"),
    },
  });
  for (const ordinal of [1, 2])
    k8s.put({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `gateway-${ordinal}`,
        namespace: "pgcf-system",
        labels: { "app.kubernetes.io/name": "pgcf-gateway" },
      },
      spec: { serviceAccountName: "pgcf-gateway" },
      status: {
        phase: "Running",
        podIP: [10, 20, 0, ordinal].join("."),
        containerStatuses: [{ name: "gateway", restartCount: 0 }],
      },
    });
  const fetcher: typeof fetch = async (_input, options) => {
    const token = new Headers(options?.headers).get("X-PGCF-Control")!;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    );
    return Response.json({
      database: claims.database,
      operation: claims.operation,
      revision: claims.revision,
      pod: claims.pod,
      mode: "quiesce",
      status: claims.action === "close" ? "closed" : "idle",
      connections: 0,
      busyConnections: 0,
      pendingDials: 0,
    });
  };
  return { db, ctx, k8s, signal, fetcher };
}
function suspended(db: DesiredDatabase) {
  return {
    ...db,
    generation: 2,
    desired_state: "suspended",
    power: {
      operation: newOperationId(),
      revision: 2,
      mode: "quiesce",
      reason: "manual",
    },
  } as unknown as DesiredDatabase;
}

test("busy catalog work reports matching refusal without hibernation or storage mutation", async () => {
  const state = await readyFixture();
  const target = suspended(state.db);
  const power = new PowerCoordinator({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    replicas: 2,
    fetcher: state.fetcher,
    probe: async () => ({ safe: false, reason: "sql_busy" }),
  });
  const observation = await new Reconciler(
    state.k8s,
    state.signal,
    Date.now,
    metrics,
    authenticate,
    power,
  ).reconcile(target);
  assert.equal(observation?.state, "error");
  assert.equal(
    (observation as unknown as { power: { refusal: string } }).power.refusal,
    "busy",
  );
  assert.equal(
    state.k8s.resources.get(
      state.k8s.key("Cluster", `pgcf-db-${state.db.id}`, "database"),
    )?.metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
  assert.equal(
    state.k8s.actions.some((action) => action.startsWith("delete:")),
    false,
  );
});
