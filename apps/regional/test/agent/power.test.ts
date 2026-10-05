// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { ApiException } from "@kubernetes/client-node";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { newOperationId, newRolePassword } from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import { gatewayFenceName } from "@pgcf/contracts/gateway-control";
import type { AuthenticationProbe } from "../../src/agent/readiness.ts";
import type { SleepProbeOptions } from "../../src/agent/sleep.ts";
import { record } from "../../src/agent/types.ts";
import {
  PowerCoordinator,
  beginWakePhase,
  measureWakePhase,
  type WakePhase,
} from "../../src/agent/power.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import {
  fixture,
  MemoryKubernetes,
  authenticate,
  metrics,
} from "./fixtures.ts";
import type { DesiredDatabase } from "@pgcf/contracts";

async function readyFixture(k8s = new MemoryKubernetes()) {
  const { db, ctx } = fixture();
  db.maintenance = {
    role: MAINTENANCE_ROLE,
    password: newRolePassword(),
    revision: 1,
  };
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
    const mode = JSON.parse(
      String(
        record(
          k8s.resources.get(
            k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(db.id)),
          )?.data,
        )["intent.json"],
      ),
    ).mode;
    return Response.json({
      database: claims.database,
      operation: claims.operation,
      revision: claims.revision,
      pod: claims.pod,
      mode,
      status:
        mode === "running"
          ? "running"
          : claims.action === "close"
            ? "closed"
            : "idle",
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
  } as DesiredDatabase;
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

function progress(state: Awaited<ReturnType<typeof readyFixture>>) {
  const map = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(state.db.id)),
  )!;
  return JSON.parse(String(record(map.data)["power.json"]));
}
function confirmedHibernation(state: Awaited<ReturnType<typeof readyFixture>>) {
  const cluster = state.k8s.resources.get(
    state.k8s.key("Cluster", `pgcf-db-${state.db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "cnpg.io/hibernation", status: "True", reason: "Hibernated" },
  ];
  for (const [key, value] of state.k8s.resources)
    if (
      value.kind === "Pod" &&
      value.metadata.namespace === `pgcf-db-${state.db.id}`
    )
      state.k8s.resources.delete(key);
}

test("exact archive proof precedes hibernation; confirmation requires Hibernated and zero actual Pods", async () => {
  const state = await readyFixture();
  const target = suspended(state.db);
  const segment = randomBytes(12).toString("hex").toUpperCase();
  let switches = 0;
  const probe = async (options: SleepProbeOptions) => {
    switches++;
    assert.equal(progress(state).phase, "switching");
    await options.verifyQuiescence(options.signal);
    await options.onClosedSegment!(segment);
    return { safe: true as const, segment };
  };
  const make = () =>
    new Reconciler(
      state.k8s,
      state.signal,
      Date.now,
      metrics,
      authenticate,
      new PowerCoordinator({
        k8s: state.k8s,
        signal: state.signal,
        region: "eu-test",
        replicas: 2,
        fetcher: state.fetcher,
        probe,
      }),
    );
  assert.equal(await make().reconcile(target), null);
  assert.equal(progress(state).segment, segment);
  const cluster = state.k8s.resources.get(
    state.k8s.key("Cluster", `pgcf-db-${state.db.id}`, "database"),
  )!;
  assert.equal(cluster.metadata.annotations?.["cnpg.io/hibernation"], "on");
  assert.equal(await make().reconcile(target), null);
  record(cluster.status).conditions = [
    { type: "cnpg.io/hibernation", status: "True", reason: "Hibernated" },
  ];
  assert.equal(await make().reconcile(target), null);
  confirmedHibernation(state);
  assert.equal((await make().reconcile(target))?.state, "hibernated");
  assert.equal(switches, 1);
});

test("a configuration revision on an already suspended database remains asleep without SQL or awake refusal", async () => {
  const state = await readyFixture();
  const target = suspended(state.db);
  const segment = randomBytes(12).toString("hex").toUpperCase();
  let probes = 0;
  const probe = async (options: SleepProbeOptions) => {
    probes++;
    await options.onClosedSegment!(segment);
    return { safe: true as const, segment };
  };
  const make = () =>
    new Reconciler(
      state.k8s,
      state.signal,
      Date.now,
      metrics,
      authenticate,
      new PowerCoordinator({
        k8s: state.k8s,
        signal: state.signal,
        region: "eu-test",
        replicas: 2,
        fetcher: state.fetcher,
        probe,
      }),
    );
  await make().reconcile(target);
  confirmedHibernation(state);
  assert.equal((await make().reconcile(target))?.state, "hibernated");
  const changed = {
    ...target,
    generation: 3,
    power: { ...target.power!, revision: 3 },
    roles: [{ ...target.roles[0]!, password: newRolePassword(), revision: 2 }],
  };
  const result = await make().reconcile(changed);
  assert.equal(result?.state, "hibernated");
  assert.equal(result?.power?.revision, 3);
  assert.equal(probes, 1);
  assert.equal(progress(state).proofIntent.revision, 2);
});

function reconciler(
  state: Awaited<ReturnType<typeof readyFixture>>,
  overrides: Partial<ConstructorParameters<typeof PowerCoordinator>[0]> = {},
  auth: AuthenticationProbe = authenticate,
) {
  return new Reconciler(
    state.k8s,
    state.signal,
    Date.now,
    metrics,
    auth,
    new PowerCoordinator({
      k8s: state.k8s,
      signal: state.signal,
      region: "eu-test",
      replicas: 2,
      fetcher: state.fetcher,
      ...overrides,
    }),
  );
}
function running(db: DesiredDatabase, generation = 3): DesiredDatabase {
  return {
    ...db,
    generation,
    desired_state: "running",
    power: {
      operation: newOperationId(),
      revision: generation,
      mode: "running",
      reason: null,
    },
  };
}
const clusterFor = (state: Awaited<ReturnType<typeof readyFixture>>) =>
  state.k8s.resources.get(
    state.k8s.key("Cluster", `pgcf-db-${state.db.id}`, "database"),
  )!;

test("prepared transactions refuse sleep without annotation and retain the original refusal after restart", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  let calls = 0;
  const probe = async () => {
    calls++;
    return { safe: false as const, reason: "prepared_work" as const };
  };
  assert.equal(
    (await reconciler(state, { probe }).reconcile(target))?.power?.refusal,
    "busy",
  );
  assert.equal(
    (await reconciler(state, { probe }).reconcile(target))?.power?.refusal,
    "busy",
  );
  assert.equal(calls, 1);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("known exact segments resume after agent restart without another WAL switch", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  let switched = 0,
    resumed = 0;
  const probe = async (options: SleepProbeOptions) => {
    switched++;
    await options.onClosedSegment!(segment);
    return {
      safe: false as const,
      reason: "archive_timeout" as const,
      segment,
    };
  };
  const resume = async (options: SleepProbeOptions, known: string) => {
    resumed++;
    assert.equal(known, segment);
    await options.verifyQuiescence(options.signal);
    return { safe: true as const, segment: known };
  };
  assert.equal(
    await reconciler(state, { probe, resume }).reconcile(target),
    null,
  );
  assert.equal(progress(state).phase, "archive");
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
  assert.equal(
    await reconciler(state, { probe, resume }).reconcile(target),
    null,
  );
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    "on",
  );
  assert.equal(switched, 1);
  assert.equal(resumed, 1);
  assert.equal(progress(state).anchor.physicalGeneration, 1);
});

test("unknown switch responses are refused once and are never retried", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  let calls = 0;
  const probe = async () => {
    calls++;
    return { safe: false as const, reason: "switch_unknown" as const };
  };
  assert.equal(
    (await reconciler(state, { probe }).reconcile(target))?.power?.refusal,
    "unknown",
  );
  assert.equal(
    (await reconciler(state, { probe }).reconcile(target))?.power?.refusal,
    "unknown",
  );
  assert.equal(calls, 1);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("missing replicas and a pending replica with no address cannot produce a quiescence proof", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  let calls = 0;
  state.k8s.resources.delete(state.k8s.key("Pod", "pgcf-system", "gateway-2"));
  const probe = async () => {
    calls++;
    return { safe: false as const, reason: "sql_busy" as const };
  };
  assert.equal(await reconciler(state, { probe }).reconcile(target), null);
  state.k8s.put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "gateway-pending",
      namespace: "pgcf-system",
      labels: { "app.kubernetes.io/name": "pgcf-gateway" },
    },
    spec: { serviceAccountName: "pgcf-gateway" },
    status: { phase: "Pending" },
  });
  assert.equal(await reconciler(state, { probe }).reconcile(target), null);
  assert.equal(calls, 0);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("a new gateway Pod after the switch invalidates the old proof before archive resume", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  let resumed = 0;
  const probe = async (options: SleepProbeOptions) => {
    await options.onClosedSegment!(segment);
    return {
      safe: false as const,
      reason: "archive_timeout" as const,
      segment,
    };
  };
  await reconciler(state, { probe }).reconcile(target);
  const prior = state.k8s.resources.get(
    state.k8s.key("Pod", "pgcf-system", "gateway-2"),
  )!;
  state.k8s.put(prior);
  const result = await reconciler(state, {
    probe,
    resume: async () => {
      resumed++;
      return { safe: true, segment };
    },
  }).reconcile(target);
  assert.equal(result?.power?.refusal, "unknown");
  assert.equal(resumed, 0);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("newer running intent cancels archive waiting, verifies actual credentials and releases only after readiness", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  let resumed = 0;
  const probe = async (options: SleepProbeOptions) => {
    await options.onClosedSegment!(segment);
    return {
      safe: false as const,
      reason: "archive_timeout" as const,
      segment,
    };
  };
  await reconciler(state, { probe }).reconcile(target);
  const wake = running(target);
  const denied = await reconciler(
    state,
    {
      probe,
      resume: async () => {
        resumed++;
        return { safe: true, segment };
      },
    },
    async () => false,
  ).reconcile(wake, state.ctx);
  assert.equal(denied?.state, "provisioning");
  const map = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(target.id)),
  )!;
  assert.equal(
    JSON.parse(String(record(map.data)["intent.json"])).mode,
    "quiesce",
  );
  const awake = await reconciler(state, { probe }).reconcile(wake, state.ctx);
  assert.equal(awake?.state, "ready");
  assert.equal(awake?.power?.state, "awake");
  assert.equal(awake?.power?.revision, 3);
  assert.equal(
    JSON.parse(String(record(map.data)["intent.json"])).mode,
    "running",
  );
  assert.equal(resumed, 0);
  assert.equal(progress(state).segment, undefined);
  assert.equal(progress(state).anchor.physicalGeneration, 1);
  assert.equal(await reconciler(state, { probe }).reconcile(target), null);
});

test("waking a missing claim cannot remove hibernation or recreate empty storage", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  const probe = async (options: SleepProbeOptions) => {
    await options.onClosedSegment!(segment);
    return { safe: true as const, segment };
  };
  await reconciler(state, { probe }).reconcile(target);
  confirmedHibernation(state);
  state.k8s.resources.delete(
    state.k8s.key(
      "PersistentVolumeClaim",
      `pgcf-db-${target.id}`,
      "database-1",
    ),
  );
  const before = state.k8s.actions.length;
  const result = await reconciler(state, { probe }).reconcile(
    running(target),
    state.ctx,
  );
  assert.equal(result?.state, "error");
  assert.match(result?.message ?? "", /recovery required/);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    "on",
  );
  assert.equal(
    state.k8s.actions
      .slice(before)
      .some((action) => action.startsWith("create:")),
    false,
  );
});

test("legacy databases without maintenance capability receive a refusal and no privilege grant", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  delete target.maintenance;
  let calls = 0;
  const before = state.k8s.actions.length;
  const result = await reconciler(state, {
    probe: async () => {
      calls++;
      return { safe: false, reason: "sql_busy" };
    },
  }).reconcile(target);
  assert.equal(result?.power?.refusal, "unknown");
  assert.equal(calls, 0);
  assert.equal(
    state.k8s.actions
      .slice(before)
      .some(
        (action) => action.includes("Secret") || action.includes("Cluster"),
      ),
    false,
  );
});

test("node and archive identities cannot change during a power operation", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  const result = await reconciler(state).reconcile({
    ...target,
    node: "another-test-node",
  });
  assert.equal(result?.state, "error");
  assert.match(result?.message ?? "", /recovery required/);
  assert.equal(
    state.k8s.resources.has(
      state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(target.id)),
    ),
    false,
  );
  const changedArchive = {
    ...target,
    archive: {
      ...target.archive,
      destination_path: target.archive.destination_path.replace(
        "eu-test",
        "another-region",
      ),
    },
  };
  assert.equal(
    (await reconciler(state).reconcile(changedArchive))?.state,
    "error",
  );
});

class CrashAtStage extends MemoryKubernetes {
  stage?: string;
  crashed = false;
  override mutation(action: string): void {
    super.mutation(action);
    if (
      !this.stage ||
      this.crashed ||
      !action.includes("ConfigMap:gateway-fence-")
    )
      return;
    const value = [...this.resources.values()].find(
      (resource) =>
        resource.kind === "ConfigMap" &&
        resource.metadata.name.startsWith("gateway-fence-"),
    );
    if (
      JSON.parse(String(record(value?.data)["power.json"])).phase === this.stage
    ) {
      this.crashed = true;
      throw new Error("fixture_lost_mutation_response");
    }
  }
}
async function crashStage(stage: string) {
  const k8s = new CrashAtStage(),
    state = await readyFixture(k8s);
  k8s.stage = stage;
  const target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  let switches = 0,
    resumes = 0;
  const probe = async (options: SleepProbeOptions) => {
    switches++;
    await options.onClosedSegment!(segment);
    return { safe: true as const, segment };
  };
  const resume = async (options: SleepProbeOptions, known: string) => {
    resumes++;
    assert.equal(known, segment);
    await options.verifyQuiescence(options.signal);
    return { safe: true as const, segment };
  };
  await reconciler(state, { probe, resume }).reconcile(target);
  assert.equal(k8s.crashed, true);
  const map = k8s.resources.get(
    k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(target.id)),
  )!;
  const uid = map.metadata.uid;
  const result = await reconciler(state, { probe, resume }).reconcile(target);
  assert.equal(map.metadata.uid, uid);
  assert.equal(
    k8s.actions.filter((action) =>
      action.startsWith("create:ConfigMap:gateway-fence-"),
    ).length,
    1,
  );
  return { state, result, switches, resumes };
}

test("restart after the initial quiescence write preserves its ConfigMap UID and converges", async () => {
  const result = await crashStage("quiescing");
  assert.equal(result.switches, 1);
  assert.equal(
    clusterFor(result.state).metadata.annotations?.["cnpg.io/hibernation"],
    "on",
  );
});
test("restart after the durable switching reservation refuses an ambiguous attempt without SQL", async () => {
  const result = await crashStage("switching");
  assert.equal(result.switches, 0);
  assert.equal(result.resumes, 0);
  assert.equal(result.result?.power?.refusal, "unknown");
});
test("restart after the exact segment write resumes that segment and never switches again", async () => {
  const result = await crashStage("archive");
  assert.equal(result.switches, 1);
  assert.equal(result.resumes, 1);
  assert.equal(
    clusterFor(result.state).metadata.annotations?.["cnpg.io/hibernation"],
    "on",
  );
});
test("restart after the proved step rechecks SQL/archive rather than trusting a canned acknowledgement", async () => {
  const result = await crashStage("proved");
  assert.equal(result.switches, 1);
  assert.equal(result.resumes, 1);
  assert.equal(
    clusterFor(result.state).metadata.annotations?.["cnpg.io/hibernation"],
    "on",
  );
});
test("restart before hibernation dispatch rechecks the exact proof before one guarded annotation", async () => {
  const result = await crashStage("hibernating");
  assert.equal(result.switches, 1);
  assert.equal(result.resumes, 1);
  assert.equal(
    clusterFor(result.state).metadata.annotations?.["cnpg.io/hibernation"],
    "on",
  );
});

test("region hints interrupt an in-flight archive step without inventing a same-revision release", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  let entered!: () => void;
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const power = new PowerCoordinator({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    replicas: 2,
    fetcher: state.fetcher,
    probe: async (options) => {
      await options.onClosedSegment!(segment);
      entered();
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return { safe: false, reason: "aborted", segment };
    },
  });
  const reconcile = new Reconciler(
    state.k8s,
    state.signal,
    Date.now,
    metrics,
    authenticate,
    power,
  );
  const pending = reconcile.reconcile(target);
  await begun;
  reconcile.hint();
  assert.equal(await pending, null);
  assert.equal(progress(state).phase, "archive");
  const map = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(target.id)),
  )!;
  assert.equal(
    JSON.parse(String(record(map.data)["intent.json"])).mode,
    "quiesce",
  );
});

test("an initial running measurement fence is published only after actual credential readiness", async () => {
  const state = await readyFixture();
  assert.equal(
    (
      await reconciler(state, {}, async () => false).reconcile(
        state.db,
        state.ctx,
      )
    )?.state,
    "provisioning",
  );
  assert.equal(
    state.k8s.resources.has(
      state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(state.db.id)),
    ),
    false,
  );
  const ready = await reconciler(state).reconcile(state.db, state.ctx);
  assert.equal(ready?.state, "ready");
  assert.equal(ready?.power, undefined);
  const map = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(state.db.id)),
  )!;
  const intent = JSON.parse(String(record(map.data)["intent.json"]));
  assert.equal(intent.operation, state.db.creation!.operation_id);
  assert.equal(intent.mode, "running");
  assert.equal(intent.revision, 1);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("loss of the persisted gateway record cannot restart a known or uncertain switch", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  let calls = 0;
  const probe = async (options: SleepProbeOptions) => {
    calls++;
    await options.onClosedSegment!(segment);
    return {
      safe: false as const,
      reason: "archive_timeout" as const,
      segment,
    };
  };
  await reconciler(state, { probe }).reconcile(target);
  state.k8s.resources.delete(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(target.id)),
  );
  const before = state.k8s.actions.length;
  const result = await reconciler(state, { probe }).reconcile(target);
  assert.equal(result?.state, "error");
  assert.match(result?.message ?? "", /recovery required/);
  assert.equal(calls, 1);
  assert.equal(
    state.k8s.actions
      .slice(before)
      .some((action) => action.startsWith("create:")),
    false,
  );
});

test("a current all-replica response must match its exact recipient identity", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  let calls = 0;
  const bad: typeof fetch = async (url, options) => {
    const response = await state.fetcher(url, options);
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...body, pod: randomUUID() });
  };
  const result = await reconciler(state, {
    fetcher: bad,
    probe: async () => {
      calls++;
      return { safe: false, reason: "sql_busy" };
    },
  }).reconcile(target);
  assert.equal(result?.power?.refusal, "unknown");
  assert.equal(calls, 0);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("a running measurement marker cannot release an existing manual suspension", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  await reconciler(state, {
    probe: async () => ({ safe: false, reason: "sql_busy" }),
  }).reconcile(target);
  const coordinator = new PowerCoordinator({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    replicas: 2,
    fetcher: state.fetcher,
  });
  const ready: import("@pgcf/contracts").DatabaseObservation = {
    id: target.id,
    generation: 2,
    state: "ready",
    archive: { continuous: true, ready_wal_files: 0 },
  };
  assert.equal(
    await coordinator.publishReadyFence(
      { ...target, desired_state: "running", power: undefined },
      ready,
    ),
    null,
  );
  assert.equal(
    JSON.parse(
      String(
        record(
          state.k8s.resources.get(
            state.k8s.key(
              "ConfigMap",
              "pgcf-system",
              gatewayFenceName(target.id),
            ),
          )?.data,
        )["intent.json"],
      ),
    ).mode,
    "quiesce",
  );
});

test("loss of an initial measurement fence is a visible recovery error rather than a suppressed observation", async () => {
  const state = await readyFixture();
  assert.equal(
    (await reconciler(state).reconcile(state.db, state.ctx))?.state,
    "ready",
  );
  state.k8s.resources.delete(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(state.db.id)),
  );
  const result = await reconciler(state).reconcile(state.db, state.ctx);
  assert.equal(result?.state, "error");
  assert.match(result?.message ?? "", /recovery required/);
});

test("resume from actual hibernation preserves every storage UID and gates new credentials before release", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    segment = randomBytes(12).toString("hex").toUpperCase();
  const probe = async (options: SleepProbeOptions) => {
    await options.onClosedSegment!(segment);
    return { safe: true as const, segment };
  };
  await reconciler(state, { probe }).reconcile(target);
  confirmedHibernation(state);
  assert.equal(
    (await reconciler(state, { probe }).reconcile(target))?.state,
    "hibernated",
  );
  const identities = [...state.k8s.resources.values()]
    .filter((value) =>
      [
        "Namespace",
        "Cluster",
        "PersistentVolume",
        "PersistentVolumeClaim",
        "LVMVolume",
      ].includes(value.kind),
    )
    .map((value) => [value.kind, value.metadata.name, value.metadata.uid]);
  const password = newRolePassword();
  const wake = {
    ...running(target),
    roles: [{ ...target.roles[0]!, password, revision: 2 }],
  };
  const denied = await reconciler(state, { probe }, async (actual) => {
    assert.equal(actual.roles[0]!.password, password);
    return false;
  }).reconcile(wake, state.ctx);
  assert.equal(denied?.state, "provisioning");
  const map = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(target.id)),
  )!;
  assert.equal(
    JSON.parse(String(record(map.data)["intent.json"])).mode,
    "quiesce",
  );
  const ready = await reconciler(state, { probe }, async (actual) => {
    assert.equal(actual.roles[0]!.password, password);
    return true;
  }).reconcile(wake, state.ctx);
  assert.equal(ready?.state, "ready");
  assert.equal(ready?.power?.state, "awake");
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    "off",
  );
  assert.deepEqual(
    [...state.k8s.resources.values()]
      .filter((value) =>
        [
          "Namespace",
          "Cluster",
          "PersistentVolume",
          "PersistentVolumeClaim",
          "LVMVolume",
        ].includes(value.kind),
      )
      .map((value) => [value.kind, value.metadata.name, value.metadata.uid]),
    identities,
  );
});

test("wake timing schema rejects untrusted names and invalid clocks, caps durations and emits once", () => {
  const canary = randomUUID(),
    events: {
      event: string;
      fields: Record<string, string | number | boolean>;
    }[] = [];
  const log = (
    event: string,
    fields: Record<string, string | number | boolean> = {},
  ) => events.push({ event, fields });
  let ticks = 0;
  const finish = beginWakePhase(log, "volume_identity", canary, () =>
    ticks++ === 0 ? 1 : 900001,
  );
  finish("completed");
  finish("failed");
  assert.deepEqual(events, [
    {
      event: "wake_phase",
      fields: {
        phase: "volume_identity",
        elapsedMs: 600000,
        outcome: "completed",
      },
    },
  ]);
  beginWakePhase(log, canary as WakePhase, undefined, () => 0)("completed");
  beginWakePhase(log, "archive_metrics", undefined, () => NaN)("completed");
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes(canary), false);
});

test("wake diagnostics preserve returned objects and thrown exceptions without logging payloads", async () => {
  const canary = randomUUID(),
    events: {
      event: string;
      fields: Record<string, string | number | boolean>;
    }[] = [];
  const log = (
    event: string,
    fields: Record<string, string | number | boolean> = {},
  ) => events.push({ event, fields });
  const result = { state: "ready", payload: canary };
  let ticks = 0;
  assert.equal(
    await measureWakePhase(
      log,
      "role_runtime_auth",
      undefined,
      async () => result,
      () => ticks++,
    ),
    result,
  );
  const error = new Error(canary);
  await assert.rejects(
    measureWakePhase(
      log,
      "fence_release",
      undefined,
      async () => {
        throw error;
      },
      () => ticks++,
    ),
    (value) => value === error,
  );
  assert.deepEqual(
    events.map((entry) => entry.fields.outcome),
    ["completed", "failed"],
  );
  assert.equal(JSON.stringify(events).includes(canary), false);
  assert.equal(
    await measureWakePhase(
      () => {
        throw error;
      },
      "desired_applied",
      undefined,
      async () => result,
      () => ticks++,
    ),
    result,
  );
});

test("sleep refusal logs a bounded probe reason without credentials, CA, SQL or WAL data", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  const segment = randomBytes(12).toString("hex").toUpperCase(),
    logs: unknown[] = [];
  const result = await reconciler(state, {
    probe: async () => ({ safe: false, reason: "probe_unavailable", segment }),
    log: (event, fields) => logs.push({ event, fields }),
  }).reconcile(target);
  assert.equal(result?.state, "error");
  assert.equal(result?.power?.refusal, "unknown");
  assert.deepEqual(logs, [
    {
      event: "sleep_refused",
      fields: {
        phase: "switching",
        category: "probe",
        reason: "probe_unavailable",
      },
    },
  ]);
  const encoded = JSON.stringify(logs);
  assert.equal(encoded.includes(state.db.maintenance!.password), false);
  assert.equal(encoded.includes(segment), false);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("a throwing sleep diagnostic logger preserves the refusal and one probe attempt", async () => {
  const state = await readyFixture(),
    target = suspended(state.db);
  let probes = 0,
    logs = 0;
  const result = await reconciler(state, {
    probe: async () => {
      probes++;
      return { safe: false, reason: "sql_unknown" };
    },
    log: () => {
      logs++;
      throw new Error(newRolePassword());
    },
  }).reconcile(target);
  assert.equal(logs, 1);
  assert.equal(probes, 1);
  assert.equal(result?.power?.refusal, "unknown");
  assert.equal(progress(state).phase, "refused");
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("typed Kubernetes sleep failures expose only safe status and unrelated errors remain unknown", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    canary = newRolePassword(),
    logs: unknown[] = [];
  let failure: Error = new ApiException(
    403,
    canary,
    { body: canary },
    { Authorization: canary },
  );
  const list = state.k8s.list.bind(state.k8s);
  state.k8s.list = async (...args) => {
    if (args[0] === "PersistentVolume") throw failure;
    return list(...args);
  };
  const coordinator = new PowerCoordinator({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    replicas: 2,
    fetcher: state.fetcher,
    log: (event, fields) => logs.push({ event, fields }),
  });
  assert.equal((await coordinator.suspend(target))?.power?.refusal, "unknown");
  failure = Object.assign(new Error("maintenance_capability_missing"), {
    code: 403,
    statusCode: 403,
  });
  assert.equal((await coordinator.suspend(target))?.power?.refusal, "unknown");
  assert.deepEqual(logs, [
    {
      event: "sleep_refused",
      fields: {
        phase: "prepare",
        category: "kubernetes_http",
        reason: "unknown",
        status: 403,
      },
    },
    {
      event: "sleep_refused",
      fields: { phase: "prepare", category: "unknown", reason: "unknown" },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(canary), false);
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
});

test("a typed maintenance refusal is distinguishable and an async logger failure cannot alter it", async () => {
  const state = await readyFixture(),
    target = suspended(state.db),
    logs: unknown[] = [];
  delete target.maintenance;
  const first = await reconciler(state, {
    log: (event, fields) => logs.push({ event, fields }),
  }).reconcile(target);
  assert.equal(first?.power?.refusal, "unknown");
  assert.deepEqual(logs, [
    {
      event: "sleep_refused",
      fields: {
        phase: "quiescing",
        category: "unavailable",
        reason: "maintenance_capability_missing",
      },
    },
  ]);
  target.generation = 3;
  target.power!.revision = 3;
  target.power!.operation = newOperationId();
  let attempts = 0;
  const second = await reconciler(state, {
    log: async () => {
      attempts++;
      throw new Error(newRolePassword());
    },
  }).reconcile(target);
  assert.equal(attempts, 1);
  assert.equal(second?.power?.refusal, "unknown");
  assert.equal(
    clusterFor(state).metadata.annotations?.["cnpg.io/hibernation"],
    undefined,
  );
  assert.equal(progress(state).phase, "refused");
});
