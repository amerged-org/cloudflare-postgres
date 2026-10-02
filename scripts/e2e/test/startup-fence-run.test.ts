// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import * as harness from "../src/run.ts";
import * as clients from "../src/clients.ts";
import { Run } from "../src/run.ts";
import { Kubernetes } from "../src/clients.ts";

function identity() {
  return {
    marker: randomBytes(24).toString("hex"),
    database: `d${randomBytes(10).toString("hex").slice(0, 19)}`,
    region: `r-${randomBytes(8).toString("hex")}`,
    connection: randomUUID(),
  };
}

function edgeTrace(
  id: ReturnType<typeof identity>,
  requestChanges: Record<string, string> = {},
  logChanges: Record<string, unknown> = {},
): string {
  const query = new URLSearchParams({
    database: id.database,
    user: "app",
    pgcf_trace: id.marker,
    ...requestChanges,
  });
  return JSON.stringify([
    {
      event: {
        request: { url: `https://${["edge", "test"].join(".")}/v2?${query}` },
      },
      logs: [
        {
          message: [
            JSON.stringify({
              event: "conn_admission",
              cid: id.connection,
              database_id: id.database,
              user: "app",
              region_id: id.region,
              outcome: "accepted",
              ...logChanges,
            }),
          ],
        },
      ],
    },
  ]);
}

test("startup mismatch admission requires its exact trace, original admitted hints and accepted connection", () => {
  const id = identity();
  assert.equal(
    harness.startupMismatchAdmission(
      [edgeTrace(id)],
      id.marker,
      id.database,
      id.region,
    ),
    id.connection,
  );
  for (const trace of [
    edgeTrace(id, { pgcf_trace: randomBytes(24).toString("hex") }),
    edgeTrace(id, { database: identity().database }),
    edgeTrace(id, { user: "another_role" }),
    edgeTrace(id, {}, { database_id: identity().database }),
    edgeTrace(id, {}, { user: "another_role" }),
    edgeTrace(id, {}, { region_id: identity().region }),
    edgeTrace(id, {}, { outcome: "28000" }),
    edgeTrace(id, {}, { cid: "invalid" }),
    JSON.stringify({
      event: {
        request: { url: `https://${["edge", "test"].join(".")}/${id.marker}` },
      },
    }),
  ]) {
    assert.throws(
      () =>
        harness.startupMismatchAdmission(
          [trace],
          id.marker,
          id.database,
          id.region,
        ),
      {
        message: "startup_mismatch_admission_missing",
      },
    );
  }
  const other = { ...id, connection: randomUUID() };
  assert.throws(
    () =>
      harness.startupMismatchAdmission(
        [edgeTrace(id), edgeTrace(other)],
        id.marker,
        id.database,
        id.region,
      ),
    {
      message: "startup_mismatch_admission_ambiguous",
    },
  );
  assert.equal(
    harness.startupMismatchAdmission(
      [edgeTrace(id), edgeTrace(id)],
      id.marker,
      id.database,
      id.region,
    ),
    id.connection,
  );
});

test("Gateway mismatch proof matches the admitted connection, database and actual close outcome", () => {
  const id = identity();
  const event = {
    event: "conn_close",
    connection: id.connection,
    database: id.database,
    outcome: "startup_route_mismatch",
  };
  assert.equal(
    harness.gatewayStartupMismatchClose(
      JSON.stringify(event),
      id.connection,
      id.database,
    ),
    true,
  );
  assert.equal(
    harness.gatewayStartupMismatchClose(
      `unstructured line\n${JSON.stringify(event)}\n`,
      id.connection,
      id.database,
    ),
    true,
  );
  for (const changed of [
    { event: "conn_admission" },
    { connection: randomUUID() },
    { database: identity().database },
    { outcome: "postgres_connect_error" },
    { outcome: "startup_error" },
  ]) {
    assert.equal(
      harness.gatewayStartupMismatchClose(
        JSON.stringify({ ...event, ...changed }),
        id.connection,
        id.database,
      ),
      false,
    );
  }
});

function resources() {
  const namespace = "pgcf-system";
  const digest = randomBytes(32).toString("hex");
  const image = `ghcr.io/pgcf/${randomBytes(8).toString("hex")}@sha256:${digest}`;
  const deploymentUid = randomUUID();
  const setUid = randomUUID();
  const labels = {
    "app.kubernetes.io/name": "pgcf-gateway",
    "app.kubernetes.io/part-of": "pgcf",
  };
  const deployment = {
    metadata: { namespace, name: "pgcf-gateway", uid: deploymentUid, labels },
    spec: { template: { spec: { containers: [{ name: "gateway", image }] } } },
  };
  const set = {
    metadata: {
      namespace,
      name: `pgcf-gateway-${randomBytes(5).toString("hex")}`,
      uid: setUid,
      ownerReferences: [
        {
          kind: "Deployment",
          name: "pgcf-gateway",
          uid: deploymentUid,
          controller: true,
        },
      ],
    },
  };
  const pod = {
    metadata: {
      namespace,
      name: `pgcf-gateway-${randomBytes(5).toString("hex")}`,
      uid: randomUUID(),
      labels,
      ownerReferences: [
        {
          kind: "ReplicaSet",
          name: set.metadata.name,
          uid: setUid,
          controller: true,
        },
      ],
    },
    spec: { containers: [{ name: "gateway", image }] },
    status: {
      containerStatuses: [
        { name: "gateway", imageID: `docker-pullable://${image}` },
      ],
    },
  };
  return { namespace, image, deployment, set, pod };
}

test("Gateway log pod selection requires namespace, Deployment ownership and the approved source image", () => {
  const fixture = resources();
  const select = (
    pod = fixture.pod,
    set = fixture.set,
    deployment = fixture.deployment,
  ) =>
    clients.gatewayLogPods(
      { items: [deployment] },
      { items: [set] },
      { items: [pod] },
      fixture.namespace,
      fixture.image,
    );
  assert.deepEqual(select(), [fixture.pod.metadata.name]);
  assert.throws(
    () =>
      select({
        ...fixture.pod,
        metadata: { ...fixture.pod.metadata, namespace: "foreign" },
      }),
    {
      message: "gateway_log_pods_missing",
    },
  );
  assert.throws(
    () =>
      select({
        ...fixture.pod,
        metadata: {
          ...fixture.pod.metadata,
          ownerReferences: [
            { ...fixture.pod.metadata.ownerReferences[0]!, uid: randomUUID() },
          ],
        },
      }),
    {
      message: "gateway_log_pods_missing",
    },
  );
  assert.throws(
    () =>
      select(fixture.pod, {
        ...fixture.set,
        metadata: {
          ...fixture.set.metadata,
          ownerReferences: [
            { ...fixture.set.metadata.ownerReferences[0]!, uid: randomUUID() },
          ],
        },
      }),
    {
      message: "gateway_log_pods_missing",
    },
  );
  assert.throws(
    () =>
      select({
        ...fixture.pod,
        spec: {
          containers: [{ name: "gateway", image: `${fixture.image}-changed` }],
        },
      }),
    {
      message: "gateway_log_source_image_mismatch",
    },
  );
  assert.throws(
    () =>
      select({
        ...fixture.pod,
        status: {
          containerStatuses: [
            {
              name: "gateway",
              imageID: `containerd://sha256:${randomBytes(32).toString("hex")}`,
            },
          ],
        },
      }),
    {
      message: "gateway_log_source_image_mismatch",
    },
  );
  assert.throws(
    () =>
      select(fixture.pod, fixture.set, {
        ...fixture.deployment,
        spec: {
          template: {
            spec: {
              containers: [
                { name: "gateway", image: `${fixture.image}-changed` },
              ],
            },
          },
        },
      }),
    {
      message: "gateway_log_source_image_mismatch",
    },
  );
});

test("E3 cannot complete when the named startup mismatch proof is missing", async () => {
  let completed = false;
  const run = Object.assign(Object.create(Run.prototype) as Run, {
    requireStep: () => undefined,
    probe: async () => ({ pass: true, timings: {} }),
    startupMismatches: async () => {
      throw new Error("startup_mismatch_gateway_event_missing");
    },
    complete: async () => {
      completed = true;
    },
    emit: async () => undefined,
  });
  await assert.rejects(run.exercise(), {
    message: "startup_mismatch_gateway_event_missing",
  });
  assert.equal(completed, false);
});

test("E3 counts both startup mismatch probes after their actual Gateway proof", async () => {
  let completed = false;
  let checked = false;
  const emitted: unknown[] = [];
  const run = Object.assign(Object.create(Run.prototype) as Run, {
    requireStep: () => undefined,
    probe: async () => ({ pass: true, timings: { cold_connect_ms: 1 } }),
    startupMismatches: async () => {
      checked = true;
      return { negative_startup_database_ms: 1, negative_startup_user_ms: 2 };
    },
    complete: async () => {
      assert.equal(checked, true);
      completed = true;
    },
    emit: async (...args: unknown[]) => emitted.push(args),
  });
  await run.exercise();
  assert.equal(completed, true);
  assert.deepEqual(emitted, [
    [
      "E3",
      {
        transactions: 2,
        negative_cases: 5,
        startup_mismatch_cases: 2,
        gateway_startup_mismatch_events: 2,
      },
      {
        cold_connect_ms: 1,
        negative_startup_database_ms: 1,
        negative_startup_user_ms: 2,
      },
    ],
  ]);
});

test("startup mismatch evidence refuses a rebound cluster before any trace or Gateway log read", async () => {
  let evidenceReads = 0;
  const run = Object.assign(Object.create(Run.prototype) as Run, {
    assertCluster: async () => {
      throw new Error("dev_cluster_identity_mismatch");
    },
    state: { operation_id: randomUUID(), database_id: identity().database },
    kube: {
      gatewayLogs: async () => {
        evidenceReads++;
        return "";
      },
    },
    probe: async () => {
      evidenceReads++;
      return {};
    },
    cf: {
      request: async () => {
        evidenceReads++;
        return {};
      },
    },
  });
  await assert.rejects(run.startupMismatches(), {
    message: "dev_cluster_identity_mismatch",
  });
  assert.equal(evidenceReads, 0);
});

test("Gateway log read rechecks the bound cluster before reading pod ownership", async () => {
  const kube = new Kubernetes("test-kube-path", "test-context");
  let reads = 0;
  Object.assign(kube, {
    read: async () => {
      reads++;
      return { items: [] };
    },
  });
  kube.setMutationGuard(async () => {
    throw new Error("dev_cluster_identity_mismatch");
  });
  const fixture = resources();
  await assert.rejects(
    kube.gatewayLogs(
      fixture.namespace,
      new Date().toISOString(),
      fixture.image,
    ),
    {
      message: "dev_cluster_identity_mismatch",
    },
  );
  assert.equal(reads, 0);
});

test("named mismatch run correlates each exact rejection with real-shaped Edge and Gateway events", async () => {
  const original = globalThis.WebSocket;
  const sockets: TraceSocket[] = [];
  class TraceSocket extends EventTarget {
    static CLOSING = 2;
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send() {}
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    emit(data: string) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  globalThis.WebSocket = TraceSocket as unknown as typeof WebSocket;
  const id = identity();
  const fixture = resources();
  const operation = randomUUID();
  const closed: string[] = [];
  const paths: string[] = [];
  let guards = 0;
  let logReads = 0;
  let matching: typeof id | undefined;
  const actions: {
    kind: string;
    target: Record<string, string>;
    at: string;
    completed_at?: string;
  }[] = [];
  const run = Object.assign(Object.create(Run.prototype) as Run, {
    c: {
      values: {
        PGCF_E2E_EDGE_WORKER_NAME: "pgcf-edge-dev",
        PGCF_E2E_REGION_ID: id.region,
        PGCF_E2E_REGIONAL_NAMESPACE: fixture.namespace,
        PGCF_E2E_GHCR_IMAGE: fixture.image,
      },
    },
    state: {
      database_id: id.database,
      operation_id: operation,
      actions,
      tails: [],
    },
    assertCluster: async () => {
      guards++;
    },
    save: async () => undefined,
    intent: async () => undefined,
    cf: {
      request: async (path: string, method: string) => {
        if (method === "DELETE") {
          closed.push(path);
          return { result: null };
        }
        assert.equal(method, "POST");
        return {
          result: {
            id: randomBytes(16).toString("hex"),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            url: `wss://${["trace", "test"].join(".")}/${randomBytes(32).toString("base64url")}`,
          },
        };
      },
    },
    probe: async (path: string, body: unknown, marker: string) => {
      paths.push(path);
      assert.equal(body, undefined);
      assert.match(marker, /^[a-f0-9]{48}$/);
      matching = { ...id, marker, connection: randomUUID() };
      sockets.at(-1)!.emit(edgeTrace(matching));
      return {
        pass: true,
        sqlstate: "28000",
        gateway_outcome: "startup_route_mismatch",
        duration_ms: paths.length,
      };
    },
    kube: {
      gatewayLogs: async (namespace: string, since: string, image: string) => {
        logReads++;
        assert.equal(namespace, fixture.namespace);
        assert.equal(image, fixture.image);
        assert.equal(new Date(since).toISOString(), since);
        return JSON.stringify({
          event: "conn_close",
          database: id.database,
          connection: matching!.connection,
          outcome: "startup_route_mismatch",
        });
      },
    },
  });
  try {
    assert.deepEqual(await run.startupMismatches(), {
      negative_startup_database_ms: 1,
      negative_startup_user_ms: 2,
    });
    assert.deepEqual(paths, [
      "/startup-database-mismatch",
      "/startup-user-mismatch",
    ]);
    assert.equal(logReads, 2);
    assert.equal(guards, 5);
    assert.equal(closed.length, 2);
    assert.equal(actions.length, 2);
    for (const [index, action] of actions.entries()) {
      assert.equal(action.kind, "startup_mismatch_probe");
      assert.equal(action.target.mode, index === 0 ? "database" : "user");
      assert.equal(action.target.operation_id, operation);
      assert.equal(
        action.target.postgres_dial_evidence,
        "gateway_source_branch_inference",
      );
      assert.match(action.target.marker!, /^[a-f0-9]{48}$/);
      assert.match(action.target.connection!, /^[a-f0-9-]{36}$/);
      assert(action.completed_at);
      assert.equal(Object.hasOwn(action.target, "postgres_dials"), false);
    }
    assert.notEqual(actions[0]!.target.marker, actions[1]!.target.marker);
    assert(sockets.every((socket) => socket.readyState === 3));
  } finally {
    sockets.forEach((socket) => socket.close());
    globalThis.WebSocket = original;
  }
});
