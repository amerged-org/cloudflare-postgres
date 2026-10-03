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

function serviceAccountProjection() {
  const alphabet = "bcdfghjklmnpqrstvwxz2456789";
  const name = `kube-api-access-${[...randomBytes(5)].map((value) => alphabet[value % alphabet.length]).join("")}`;
  return {
    mount: {
      name,
      mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
      readOnly: true,
    },
    volume: {
      name,
      projected: {
        defaultMode: 420,
        sources: [
          { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
          {
            configMap: {
              name: "kube-root-ca.crt",
              items: [{ key: "ca.crt", path: "ca.crt" }],
            },
          },
          {
            downwardAPI: {
              items: [
                {
                  path: "namespace",
                  fieldRef: {
                    apiVersion: "v1",
                    fieldPath: "metadata.namespace",
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };
}

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
  const securityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  };
  const gateway = (): Record<string, unknown> => ({
    name: "gateway",
    image,
    command: ["node", "/app/gateway.mjs"],
    env: [
      {
        name: "PGCF_REGION_ID",
        valueFrom: {
          configMapKeyRef: { name: "pgcf-regional", key: "PGCF_REGION_ID" },
        },
      },
      {
        name: "PGCF_ROUTE_KEY",
        valueFrom: {
          secretKeyRef: { name: "pgcf-gateway", key: "PGCF_ROUTE_KEY" },
        },
      },
      { name: "PGCF_GATEWAY_PORT", value: "8080" },
    ],
    ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    livenessProbe: {
      httpGet: { path: "/healthz", port: "http" },
      initialDelaySeconds: 5,
      periodSeconds: 10,
      failureThreshold: 3,
    },
    readinessProbe: {
      httpGet: { path: "/readyz", port: "http" },
      periodSeconds: 5,
      failureThreshold: 2,
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
    volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
  });
  const deployment = {
    metadata: { namespace, name: "pgcf-gateway", uid: deploymentUid, labels },
    spec: {
      template: {
        spec: {
          containers: [gateway()],
          securityContext,
          serviceAccountName: "pgcf-gateway",
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 45,
          volumes: [
            { name: "tmp", emptyDir: { sizeLimit: "64Mi" } } as Record<
              string,
              unknown
            >,
          ],
        },
      },
    },
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
  const projection = serviceAccountProjection();
  const podSpec = structuredClone(deployment.spec.template.spec);
  podSpec.volumes.push(projection.volume);
  (podSpec.containers[0]!.volumeMounts as Record<string, unknown>[]).push(
    projection.mount,
  );
  const setSpec = {
    template: { spec: structuredClone(deployment.spec.template.spec) },
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
    spec: podSpec,
    status: {
      containerStatuses: [
        { name: "gateway", imageID: `docker-pullable://${image}` },
      ],
    },
  };
  return { namespace, image, deployment, set: { ...set, spec: setSpec }, pod };
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
          ...fixture.pod.spec,
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
              ...fixture.deployment.spec.template.spec,
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

function mismatchRun(
  resultChanges: Record<string, unknown> = {},
  gatewayEvidence?: (matching: ReturnType<typeof identity>) => string,
) {
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
    send(value: string, options: unknown, callback: (error?: Error) => void) {
      assert.deepEqual(JSON.parse(value), { debug: true });
      assert.deepEqual(options, {
        binary: false,
        compress: false,
        mask: false,
        fin: true,
      });
      callback();
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    terminate() {
      this.close();
    }
    emit(data: string) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
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
  const completed: string[] = [];
  const run = Object.assign(Object.create(Run.prototype) as Run, {
    traceOptions: { socketFactory: () => new TraceSocket(), settleMs: 0 },
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
      completed,
    },
    requireStep: () => undefined,
    complete: async (step: string) => {
      completed.push(step);
    },
    emit: async () => undefined,
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
      if (path === "/exercise") return { pass: true, timings: {} };
      paths.push(path);
      assert.equal(body, undefined);
      assert.match(marker, /^[a-f0-9]{16}\.[a-f0-9]{16}\.[a-f0-9]{16}$/);
      matching = { ...id, marker, connection: randomUUID() };
      sockets.at(-1)!.emit(edgeTrace(matching));
      return {
        pass: true,
        sqlstate: "28000",
        gateway_outcome: "startup_route_mismatch",
        duration_ms: paths.length,
        ...resultChanges,
      };
    },
    kube: {
      gatewayLogs: async (namespace: string, since: string, image: string) => {
        logReads++;
        assert.equal(namespace, fixture.namespace);
        assert.equal(image, fixture.image);
        assert.equal(new Date(since).toISOString(), since);
        return (
          gatewayEvidence?.(matching!) ??
          JSON.stringify({
            event: "conn_close",
            database: id.database,
            connection: matching!.connection,
            outcome: "startup_route_mismatch",
          })
        );
      },
    },
  });
  return {
    run,
    actions,
    operation,
    paths,
    completed,
    closed,
    sockets,
    guards: () => guards,
    logReads: () => logReads,
    restore() {
      sockets.forEach((socket) => socket.close());
    },
  };
}

test("named mismatch run correlates each exact rejection with real-shaped Edge and Gateway events", async () => {
  const fixture = mismatchRun();
  try {
    assert.deepEqual(await fixture.run.startupMismatches(), {
      negative_startup_database_ms: 1,
      negative_startup_user_ms: 2,
    });
    assert.deepEqual(fixture.paths, [
      "/startup-database-mismatch",
      "/startup-user-mismatch",
    ]);
    assert.equal(fixture.logReads(), 2);
    assert.equal(fixture.guards(), 5);
    assert.equal(fixture.closed.length, 2);
    assert.equal(fixture.actions.length, 2);
    for (const [index, action] of fixture.actions.entries()) {
      assert.equal(action.kind, "startup_mismatch_probe");
      assert.equal(action.target.mode, index === 0 ? "database" : "user");
      assert.equal(action.target.operation_id, fixture.operation);
      assert.equal(
        action.target.postgres_dial_evidence,
        "gateway_source_branch_inference",
      );
      assert.match(
        action.target.marker!,
        /^[a-f0-9]{16}\.[a-f0-9]{16}\.[a-f0-9]{16}$/,
      );
      assert.match(action.target.connection!, /^[a-f0-9-]{36}$/);
      assert(action.completed_at);
      assert.equal(Object.hasOwn(action.target, "postgres_dials"), false);
    }
    assert.notEqual(
      fixture.actions[0]!.target.marker,
      fixture.actions[1]!.target.marker,
    );
    assert(fixture.sockets.every((socket) => socket.readyState === 3));
  } finally {
    fixture.restore();
  }
});

async function incompleteMismatch(
  resultChanges: Record<string, unknown>,
  expectedError: string,
  gatewayEvidence?: (matching: ReturnType<typeof identity>) => string,
) {
  const fixture = mismatchRun(resultChanges, gatewayEvidence);
  try {
    await assert.rejects(fixture.run.exercise(), { message: expectedError });
    assert.deepEqual(fixture.completed, []);
    assert.equal(fixture.actions.length, 1);
    assert.equal(fixture.actions[0]!.completed_at, undefined);
    assert.deepEqual(fixture.paths, ["/startup-database-mismatch"]);
    assert.equal(fixture.logReads(), gatewayEvidence ? 1 : 0);
    assert.equal(fixture.closed.length, 1);
  } finally {
    fixture.restore();
  }
}

test("actual startup mismatch run keeps action and E3 incomplete for malformed SQLSTATE", async () => {
  await incompleteMismatch(
    { sqlstate: "28P01" },
    "startup_mismatch_probe_failed",
  );
});

test("actual startup mismatch run keeps action and E3 incomplete for an unrelated outcome", async () => {
  await incompleteMismatch(
    { gateway_outcome: "startup_error" },
    "startup_mismatch_probe_failed",
  );
});

test("actual startup mismatch run keeps action and E3 incomplete for a nonnumeric duration", async () => {
  await incompleteMismatch(
    { duration_ms: "1" },
    "startup_mismatch_probe_failed",
  );
});

test("actual startup mismatch run keeps action and E3 incomplete for a nonfinite duration", async () => {
  await incompleteMismatch(
    { duration_ms: Number.NaN },
    "startup_mismatch_probe_failed",
  );
});

test("actual startup mismatch run keeps action and E3 incomplete for a negative duration", async () => {
  await incompleteMismatch(
    { duration_ms: -1 },
    "startup_mismatch_probe_failed",
  );
});

test("actual startup mismatch run keeps action and E3 incomplete when Gateway evidence is unavailable", async () => {
  await incompleteMismatch({}, "gateway_evidence_unavailable", () => {
    throw new Error("gateway_evidence_unavailable");
  });
});

test("actual startup mismatch run keeps action and E3 incomplete for wrong Gateway connection evidence", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await incompleteMismatch({}, "poll_timeout", (matching) => {
    context.mock.timers.tick(30_000);
    return JSON.stringify({
      event: "conn_close",
      database: matching.database,
      connection: randomUUID(),
      outcome: "startup_route_mismatch",
    });
  });
});

function changedGateway(
  target: "deployment" | "pod",
  change: (container: Record<string, unknown>) => void,
) {
  const fixture = resources();
  const container =
    target === "deployment"
      ? fixture.deployment.spec.template.spec.containers[0]!
      : fixture.pod.spec.containers[0]!;
  change(container);
  return () =>
    clients.gatewayLogPods(
      { items: [fixture.deployment] },
      { items: [fixture.set] },
      { items: [fixture.pod] },
      fixture.namespace,
      fixture.image,
    );
}

test("approved Gateway image cannot prove source execution with an alternate Deployment command", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.command = ["node", "-e", "process.exit(0)"];
    }),
    { message: "gateway_log_entrypoint_mismatch" },
  );
});

test("approved Gateway image cannot prove source execution with an alternate Pod command or args", () => {
  assert.throws(
    changedGateway("pod", (container) => {
      container.command = ["node", "-e", "process.exit(0)"];
    }),
    { message: "gateway_log_entrypoint_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.args = ["--import", "/tmp/preload.mjs"];
    }),
    { message: "gateway_log_entrypoint_mismatch" },
  );
});

test("Gateway execution proof refuses inline runtime hooks in either Deployment or Pod", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.env = [
        { name: "NODE_OPTIONS", value: "--import=/tmp/preload.mjs" },
      ];
    }),
    { message: "gateway_log_execution_hook" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.env = [{ name: "PATH", value: "/tmp" }];
    }),
    { message: "gateway_log_execution_hook" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.env = [
        {
          name: "LD_PRELOAD",
          valueFrom: {
            configMapKeyRef: { name: "pgcf-regional", key: "library" },
          },
        },
      ];
    }),
    { message: "gateway_log_execution_hook" },
  );
});

test("Gateway execution proof accepts explicit references and rejects inherited environment sources", () => {
  assert.doesNotThrow(changedGateway("pod", () => undefined));
  assert.throws(
    changedGateway("deployment", (container) => {
      container.envFrom = [
        { configMapRef: { name: "pgcf-regional" }, prefix: "NODE_" },
        { secretRef: { name: "pgcf-gateway" } },
      ];
    }),
    { message: "gateway_log_environment_source_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.envFrom = [
        { configMapRef: { name: "pgcf-regional" } },
        { secretRef: { name: "pgcf-gateway" } },
        { configMapRef: { name: "pgcf-preload" } },
      ];
    }),
    { message: "gateway_log_environment_source_mismatch" },
  );
});

test("Gateway inline environment key guard rejects execution hooks", () => {
  assert.doesNotThrow(() =>
    clients.assertGatewayEnvironmentKeys([
      "PGCF_ROUTE_KEY",
      "PGCF_REGION_ID",
      "PGCF_API_URL",
    ]),
  );
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "OPENSSL_CONF",
  ]) {
    assert.throws(
      () => clients.assertGatewayEnvironmentKeys(["PGCF_ROUTE_KEY", key]),
      { message: "gateway_log_execution_hook" },
    );
  }
});

test("Gateway execution proof rejects mounts covering code, Node or runtime dependencies", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.volumeMounts = [{ name: "override", mountPath: "/app" }];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.volumeMounts = [
        { name: "override", mountPath: "/usr/local/bin/node", subPath: "node" },
      ];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.volumeMounts = [
        { name: "override", mountPath: "/app/node_modules" },
      ];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.volumeMounts = [{ name: "override", mountPath: "/lib" }];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.doesNotThrow(
    changedGateway("pod", (container) => {
      const mounts = container.volumeMounts as Record<string, unknown>[];
      assert.equal(mounts[0]!.name, "tmp");
      assert.equal(
        mounts[1]!.mountPath,
        "/var/run/secrets/kubernetes.io/serviceaccount",
      );
      assert.equal(mounts[1]!.readOnly, true);
    }),
  );
});

test("actual Gateway log reader refuses inherited environment before any log read", async () => {
  const fixture = resources();
  fixture.pod.spec.containers[0]!.envFrom = [
    { configMapRef: { name: "pgcf-regional" } },
    { secretRef: { name: "pgcf-gateway" } },
  ];
  const kube = new Kubernetes("test-kube-path", "test-context");
  let guards = 0;
  kube.setMutationGuard(async () => {
    guards++;
  });
  Object.assign(kube, {
    read: async (resource: string) => {
      if (resource === "deployments") return { items: [fixture.deployment] };
      if (resource === "replicasets") return { items: [fixture.set] };
      assert.equal(resource, "pods");
      return { items: [fixture.pod] };
    },
  });
  await assert.rejects(
    kube.gatewayLogs(
      fixture.namespace,
      new Date().toISOString(),
      fixture.image,
    ),
    {
      message: "gateway_log_environment_source_mismatch",
    },
  );
  assert.equal(guards, 3);
});

test("Gateway source proof refuses inherited approved envFrom references because Pod environment is historical", () => {
  assert.throws(
    changedGateway("pod", (container) => {
      container.envFrom = [
        { configMapRef: { name: "pgcf-regional" } },
        { secretRef: { name: "pgcf-gateway" } },
      ];
    }),
    { message: "gateway_log_environment_source_mismatch" },
  );
});

test("Gateway source proof requires readonly and nonroot execution settings", () => {
  assert.throws(
    changedGateway("pod", (container) => {
      container.securityContext = {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: false,
        capabilities: { drop: ["ALL"] },
      };
    }),
    { message: "gateway_log_execution_security_mismatch" },
  );
});

test("Gateway source proof binds explicit region and route-key names to their approved references", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      const env = container.env as Record<string, unknown>[];
      env[0] = {
        name: "PGCF_REGION_ID",
        value: `r-${randomBytes(8).toString("hex")}`,
      };
    }),
    { message: "gateway_log_environment_source_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      const env = container.env as Record<string, unknown>[];
      env[1] = {
        name: "PGCF_ROUTE_KEY",
        valueFrom: {
          secretKeyRef: { name: "pgcf-other", key: "PGCF_ROUTE_KEY" },
        },
      };
    }),
    { message: "gateway_log_environment_source_mismatch" },
  );
});

test("Gateway source proof rejects Deployment args and nonroot overrides in either execution layer", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.args = ["/app/agent.mjs"];
    }),
    { message: "gateway_log_entrypoint_mismatch" },
  );
  assert.throws(
    changedGateway("deployment", (container) => {
      container.securityContext = {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        runAsUser: 0,
        capabilities: { drop: ["ALL"] },
      };
    }),
    { message: "gateway_log_execution_security_mismatch" },
  );
  const fixture = resources();
  fixture.pod.spec.securityContext = {
    ...fixture.pod.spec.securityContext,
    runAsNonRoot: false,
  };
  assert.throws(
    () =>
      clients.gatewayLogPods(
        { items: [fixture.deployment] },
        { items: [fixture.set] },
        { items: [fixture.pod] },
        fixture.namespace,
        fixture.image,
      ),
    { message: "gateway_log_execution_security_mismatch" },
  );
});

test("Gateway source proof rejects postStart and preStop programs in both execution layers", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.lifecycle = {
        postStart: { exec: { command: ["node", "-e", "process.exit(0)"] } },
      };
    }),
    { message: "gateway_log_extra_program" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.lifecycle = {
        postStart: { exec: { command: ["node", "-e", "process.exit(0)"] } },
      };
      container.ports = [
        { name: "http", containerPort: 8090, protocol: "TCP" },
      ];
    }),
    { message: "gateway_log_extra_program" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.lifecycle = {
        preStop: { exec: { command: ["node", "-e", "process.exit(0)"] } },
      };
    }),
    { message: "gateway_log_extra_program" },
  );
});

test("Gateway source proof rejects executable probes in Deployment and Pod and unexpected startup probes", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.livenessProbe = {
        exec: { command: ["node", "-e", "process.exit(0)"] },
      };
    }),
    { message: "gateway_log_probe_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.readinessProbe = {
        exec: { command: ["node", "-e", "process.exit(0)"] },
      };
    }),
    { message: "gateway_log_probe_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.startupProbe = {
        exec: { command: ["node", "-e", "process.exit(0)"] },
      };
    }),
    { message: "gateway_log_probe_mismatch" },
  );
});

test("Gateway source proof binds the advertised HTTP port to the actual approved 8080 listener", () => {
  assert.throws(
    changedGateway("deployment", (container) => {
      container.ports = [
        { name: "http", containerPort: 8090, protocol: "TCP" },
      ];
    }),
    { message: "gateway_log_port_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.ports = [
        { name: "http", containerPort: 8090, protocol: "TCP" },
      ];
    }),
    { message: "gateway_log_port_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.readinessProbe = { httpGet: { path: "/readyz", port: 8090 } };
    }),
    { message: "gateway_log_probe_mismatch" },
  );
});

function changedGatewaySpec(
  target: "deployment" | "pod",
  change: (spec: Record<string, unknown>) => void,
) {
  const fixture = resources();
  const spec =
    target === "deployment"
      ? fixture.deployment.spec.template.spec
      : fixture.pod.spec;
  change(spec);
  return () =>
    clients.gatewayLogPods(
      { items: [fixture.deployment] },
      { items: [fixture.set] },
      { items: [fixture.pod] },
      fixture.namespace,
      fixture.image,
    );
}

test("Gateway source proof permits only the approved single-container Deployment program", () => {
  assert.throws(
    changedGatewaySpec("deployment", (spec) => {
      (spec.containers as Record<string, unknown>[]).push({
        name: "helper",
        image: (spec.containers as Record<string, unknown>[])[0]!.image,
        command: ["node", "-e", "process.exit(0)"],
      });
    }),
    { message: "gateway_log_extra_program" },
  );
  assert.throws(
    changedGatewaySpec("deployment", (spec) => {
      spec.initContainers = [
        { name: "prepare", command: ["node", "-e", "process.exit(0)"] },
      ];
    }),
    { message: "gateway_log_extra_program" },
  );
});

test("Gateway source proof rejects Pod sidecar, init and ephemeral programs", () => {
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      (spec.containers as Record<string, unknown>[]).push({
        name: "helper",
        image: (spec.containers as Record<string, unknown>[])[0]!.image,
        command: ["node", "-e", "process.exit(0)"],
      });
    }),
    { message: "gateway_log_extra_program" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      spec.initContainers = [
        { name: "prepare", command: ["node", "-e", "process.exit(0)"] },
      ];
    }),
    { message: "gateway_log_extra_program" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      spec.ephemeralContainers = [
        { name: "inspect", command: ["node", "-e", "process.exit(0)"] },
      ];
    }),
    { message: "gateway_log_extra_program" },
  );
});

test("approved Gateway HTTP health and readiness probes remain valid with Kubernetes defaults", () => {
  assert.doesNotThrow(
    changedGateway("pod", (container) => {
      container.livenessProbe = {
        httpGet: { path: "/healthz", port: "http", scheme: "HTTP" },
        initialDelaySeconds: 5,
        periodSeconds: 10,
        failureThreshold: 3,
        timeoutSeconds: 1,
        successThreshold: 1,
      };
      container.readinessProbe = {
        httpGet: { path: "/readyz", port: "http", scheme: "HTTP" },
        initialDelaySeconds: 0,
        periodSeconds: 5,
        failureThreshold: 2,
        timeoutSeconds: 1,
        successThreshold: 1,
      };
    }),
  );
});

function selectResources(
  fixture: ReturnType<typeof resources>,
  sets = [fixture.set],
) {
  return clients.gatewayLogPods(
    { items: [fixture.deployment] },
    { items: sets },
    { items: [fixture.pod] },
    fixture.namespace,
    fixture.image,
  );
}

test("Gateway approved mounts reject extra and renamed mounts outside executable paths", () => {
  assert.throws(
    changedGateway("pod", (container) => {
      (container.volumeMounts as Record<string, unknown>[]).push({
        name: "extra",
        mountPath: "/opt/data",
      });
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("deployment", (container) => {
      container.volumeMounts = [{ name: "renamed", mountPath: "/tmp" }];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      container.volumeMounts = [];
    }),
    { message: "gateway_log_executable_mount" },
  );
});

test("Gateway tmp volume must be the approved ordinary emptyDir with its complete mount", () => {
  assert.throws(
    changedGatewaySpec("deployment", (spec) => {
      spec.volumes = [
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
      ];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      (spec.volumes as Record<string, unknown>[])[0] = {
        name: "tmp",
        configMap: { name: "pgcf-regional" },
      };
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      (container.volumeMounts as Record<string, unknown>[])[0]!.subPath =
        "data";
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGateway("deployment", (container) => {
      container.volumeDevices = [{ name: "tmp", devicePath: "/tmp/device" }];
    }),
    { message: "gateway_log_executable_mount" },
  );
});

test("Gateway mount conformance rejects missing, extra and differently sized backing volumes", () => {
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      (spec.volumes as Record<string, unknown>[]).shift();
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGatewaySpec("deployment", (spec) => {
      spec.volumes = [{ name: "tmp", emptyDir: { sizeLimit: "65Mi" } }];
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGatewaySpec("deployment", (spec) => {
      (spec.volumes as Record<string, unknown>[]).push({
        name: "unused",
        emptyDir: { sizeLimit: "64Mi" },
      });
    }),
    { message: "gateway_log_executable_mount" },
  );
});

test("Gateway admitted service-account projection must be paired, readonly and standard", () => {
  assert.throws(
    changedGateway("pod", (container) => {
      (container.volumeMounts as Record<string, unknown>[])[1]!.readOnly =
        false;
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      (spec.volumes as Record<string, unknown>[])[1]!.name =
        serviceAccountProjection().volume.name;
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      const projected = (spec.volumes as Record<string, unknown>[])[1]!
        .projected as { sources: Record<string, unknown>[] };
      projected.sources[1] = {
        configMap: {
          name: "pgcf-other",
          items: [{ key: "ca.crt", path: "ca.crt" }],
        },
      };
    }),
    { message: "gateway_log_executable_mount" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      const projected = (spec.volumes as Record<string, unknown>[])[1]!
        .projected as { sources: Record<string, unknown>[] };
      projected.sources[0] = {
        serviceAccountToken: { expirationSeconds: 3600, path: "token" },
      };
    }),
    { message: "gateway_log_executable_mount" },
  );
});

test("Gateway service-account and ordinary networking/process configuration are bound", () => {
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      spec.serviceAccountName = "pgcf-other";
    }),
    { message: "gateway_log_pod_configuration_mismatch" },
  );
  assert.throws(
    changedGatewaySpec("deployment", (spec) => {
      spec.enableServiceLinks = true;
    }),
    { message: "gateway_log_pod_configuration_mismatch" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      spec.hostNetwork = true;
    }),
    { message: "gateway_log_pod_configuration_mismatch" },
  );
  assert.throws(
    changedGatewaySpec("pod", (spec) => {
      spec.shareProcessNamespace = true;
    }),
    { message: "gateway_log_pod_configuration_mismatch" },
  );
});

test("selected Gateway ReplicaSet template must match approved execution; unrelated historical sets are ignored", () => {
  const missing = resources();
  delete (missing.set as { spec?: unknown }).spec;
  assert.throws(() => selectResources(missing), {
    message: "gateway_log_replica_set_template_mismatch",
  });
  const drift = resources();
  const probe = drift.set.spec.template.spec.containers[0]!
    .livenessProbe as Record<string, unknown>;
  probe.periodSeconds = 11;
  assert.throws(() => selectResources(drift), {
    message: "gateway_log_replica_set_template_mismatch",
  });
  const valid = resources();
  const historical = structuredClone(valid.set);
  historical.metadata.uid = randomUUID();
  historical.metadata.name = `pgcf-gateway-${randomBytes(5).toString("hex")}`;
  delete (historical as { spec?: unknown }).spec;
  assert.deepEqual(selectResources(valid, [valid.set, historical]), [
    valid.pod.metadata.name,
  ]);
});

test("Kubernetes 1.36.3 documented defaults remain equivalent in Gateway templates and admitted Pods", () => {
  const fixture = resources();
  for (const spec of [fixture.set.spec.template.spec, fixture.pod.spec]) {
    const container = spec.containers[0]!;
    const env = container.env as {
      valueFrom?: {
        configMapKeyRef?: Record<string, unknown>;
        secretKeyRef?: Record<string, unknown>;
      };
    }[];
    env[0]!.valueFrom!.configMapKeyRef!.optional = false;
    env[1]!.valueFrom!.secretKeyRef!.optional = false;
    const security = container.securityContext as Record<string, unknown>;
    security.privileged = false;
    security.procMount = "Default";
    security.runAsNonRoot = true;
    security.runAsUser = 1000;
    security.runAsGroup = 1000;
    security.seccompProfile = { type: "RuntimeDefault" };
    (security.capabilities as Record<string, unknown>).add = [];
    (container.volumeMounts as Record<string, unknown>[])[0]!.readOnly = false;
    (container.volumeMounts as Record<string, unknown>[])[0]!.mountPropagation =
      "None";
    (spec.volumes[0]!.emptyDir as Record<string, unknown>).medium = "";
    (spec.volumes[0]!.emptyDir as Record<string, unknown>).sizeLimit =
      "67108864";
    const live = container.livenessProbe as Record<string, unknown>;
    const ready = container.readinessProbe as Record<string, unknown>;
    for (const probe of [live, ready]) {
      (probe.httpGet as Record<string, unknown>).scheme = "HTTP";
      probe.timeoutSeconds = 1;
      probe.successThreshold = 1;
    }
    ready.initialDelaySeconds = 0;
    Object.assign(spec, {
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      hostUsers: true,
      dnsPolicy: "ClusterFirst",
      restartPolicy: "Always",
      schedulerName: "default-scheduler",
      automountServiceAccountToken: true,
    });
  }
  const projection = fixture.pod.spec.volumes[1]!.projected as {
    defaultMode?: number;
    sources: Record<string, unknown>[];
  };
  delete projection.defaultMode;
  const ca = projection.sources[1]!.configMap as Record<string, unknown>;
  ca.optional = false;
  (ca.items as Record<string, unknown>[])[0]!.mode = 420;
  const namespace = (
    projection.sources[2]!.downwardAPI as {
      items: { fieldRef: Record<string, unknown>; mode?: number }[];
    }
  ).items[0]!;
  delete namespace.fieldRef.apiVersion;
  namespace.mode = 420;
  assert.deepEqual(selectResources(fixture), [fixture.pod.metadata.name]);
});

test("Gateway nondefault probe timing and security changes cannot normalize to approved execution", () => {
  assert.throws(
    changedGateway("pod", (container) => {
      (container.livenessProbe as Record<string, unknown>).periodSeconds = 11;
    }),
    { message: "gateway_log_probe_mismatch" },
  );
  assert.throws(
    changedGateway("pod", (container) => {
      (container.securityContext as Record<string, unknown>).procMount =
        "Unmasked";
    }),
    { message: "gateway_log_execution_security_mismatch" },
  );
});

test("actual Gateway log reader refuses mount/backing drift before any log command", async () => {
  const fixture = resources();
  fixture.pod.spec.volumes[0] = {
    name: "tmp",
    emptyDir: { medium: "Memory", sizeLimit: "64Mi" },
  };
  const kube = new Kubernetes("test-kube-path", "test-context", () => 0);
  let guards = 0;
  kube.setMutationGuard(async () => {
    guards++;
  });
  Object.assign(kube, {
    read: async (resource: string) => ({
      items:
        resource === "deployments"
          ? [fixture.deployment]
          : resource === "replicasets"
            ? [fixture.set]
            : [fixture.pod],
    }),
  });
  await assert.rejects(
    kube.gatewayLogs(
      fixture.namespace,
      new Date().toISOString(),
      fixture.image,
    ),
    { message: "gateway_log_executable_mount" },
  );
  assert.equal(guards, 3);
});

test("selected Gateway ReplicaSet container identity is part of normalized execution", () => {
  const fixture = resources();
  fixture.set.spec.template.spec.containers[0]!.name = "other";
  assert.throws(() => selectResources(fixture), {
    message: "gateway_log_replica_set_template_mismatch",
  });
});
