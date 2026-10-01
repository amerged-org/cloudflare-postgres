// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  realpathSync,
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CapacityJournal } from "../src/capacity-journal.ts";
import { canonicalCohort } from "../src/node-cohort.ts";
import { ControlClient } from "../src/control-client.ts";
import { deliverInitialPostgres } from "../src/execution-broker.ts";

const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalCohort(value))
    .digest("hex");
const golden = JSON.parse(
  readFileSync(
    new URL(
      "../../execution-guard/testdata/signed-window-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const payload = JSON.parse(golden.payload),
  b = {
    ...payload.binding,
    namespace: "pgcf-" + payload.binding.environmentId.replaceAll("-", ""),
  };
const nonce = payload.nonce,
  containerId = "e".repeat(64);
const key = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
  ]),
  format: "der",
  type: "pkcs8",
}); // Public RFC8032 test vector, never installation credentials.

function fixture(t) {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "pgcf-execution-broker-")),
  );
  chmodSync(dir, 0o700);
  let capacity;
  t.after(() => {
    capacity?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const custody = join(dir, "capacity"),
    broker = join(dir, "broker");
  mkdirSync(custody, { mode: 0o700 });
  mkdirSync(broker, { mode: 0o700 });
  const spec = {
    name: "ordinary",
    regionId: b.regionId,
    catalogVersion: "fixture",
    profileId: "small",
    volumeGiB: 1,
    profile: {
      id: "small",
      instances: 1,
      postgresImage: `registry.invalid/postgres@sha256:${b.imageHash}`,
      compute: { cpuMilli: 100, memoryMiB: 128 },
      storage: {
        classId: "local",
        storageClassName: "pgcf-data",
        minGiB: 1,
        maxGiB: 5,
        stepGiB: 1,
      },
      executionFencing: { version: 1 },
      backup: {
        endpointURL: "https://archive.invalid",
        region: "auto",
        destinationPath: "s3://fixture",
        retentionPolicy: "7d",
        credentialSecret: {
          namespace: "fixture",
          name: "archive",
          accessKeyIdKey: "access",
          secretAccessKeyKey: "secret",
        },
      },
    },
  };
  const claim = {
    kind: "environment.create",
    operationId: b.operationId,
    environmentId: b.environmentId,
    regionId: b.regionId,
    specRevision: 1,
    specHash: digest(JSON.stringify(spec)),
    runEpoch: "1",
    leaseEpoch: 1,
    leaseToken: "fixture-operation-lease",
    leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    spec,
  };
  const binding = {
    installationId: b.installationId,
    regionId: b.regionId,
    operationId: b.operationId,
    environmentId: b.environmentId,
    specRevision: 1,
    specHash: claim.specHash,
    runEpoch: "1",
  };
  const slot = (id, maintenance) => ({
    id,
    kind: "database",
    maintenance,
    reservationName: "capacity-" + id,
    holdPvcName: "hold-" + id,
    cpuMilli: 125,
    memoryBytes: "201326592",
    cpuLimitMilli: 200,
    memoryLimitBytes: "268435456",
    volumeBytes: "1073741824",
  });
  const plan = {
    version: 1,
    binding,
    namespace: b.namespace,
    customerStorageClass: "pgcf-data",
    holdNamespace: "capacity",
    holdStorageClassPrefix: "pgcf-hold",
    instances: 1,
    slots: [slot("database-0", false), slot("database-1", true)],
  };
  capacity = new CapacityJournal(
    join(custody, b.operationId + ".sqlite"),
    plan,
  );
  const ref = (name, uid, namespace = "") => ({
    name,
    uid,
    namespace,
    resourceVersion: "1",
  });
  const node = {
    name: b.nodeName,
    uid: b.nodeUid,
    bootId: b.bootId,
    topologyKey: "openebs.io/nodename",
    topologyValue: b.nodeName,
    vgUuid: "vg-fixture",
  };
  const hold = ref(
      "hold-database-0",
      "10000000-0000-4000-8000-000000000000",
      "capacity",
    ),
    pv = ref("pv-fixture", "20000000-0000-4000-8000-000000000000"),
    lv = ref("lvm-fixture", "30000000-0000-4000-8000-000000000000", "openebs");
  capacity.observeHold("database-0", {
    reservation: ref(
      "capacity-database-0",
      "40000000-0000-4000-8000-000000000000",
    ),
    node,
    storage: {
      holdPvc: hold,
      pv,
      lvmVolume: lv,
      csiHandle: "lvm-fixture",
      bytes: "1073741824",
      storageClassName: "pgcf-hold-fixture",
    },
  });
  // The independent maintenance slot is not used by this single-target delivery.
  const mh = {
    reservation: ref(
      "capacity-database-1",
      "40000000-0000-4000-8000-000000000001",
    ),
    node,
    storage: {
      holdPvc: ref(
        "hold-database-1",
        "10000000-0000-4000-8000-000000000001",
        "capacity",
      ),
      pv: ref("pv-spare", "20000000-0000-4000-8000-000000000001"),
      lvmVolume: ref(
        "lvm-spare",
        "30000000-0000-4000-8000-000000000001",
        "openebs",
      ),
      csiHandle: "lvm-spare",
      bytes: "1073741824",
      storageClassName: "pgcf-hold-fixture",
    },
  };
  capacity.observeHold("database-1", mh);
  capacity.available();
  capacity.beginEffects();
  capacity.bindRuntime({
    namespaceUid: b.namespaceUid,
    clusterUid: "55555555-5555-4555-8555-555555555556",
    projectId: b.projectId,
    organizationId: b.organizationId,
  });
  const pvc = ref(
    "database-1",
    "50000000-0000-4000-8000-000000000000",
    b.namespace,
  );
  capacity.handoff("database-0", {
    operator: "system:serviceaccount:platform:regional",
    targetPvc: pvc,
    oldClaimRef: { name: hold.name, namespace: hold.namespace, uid: hold.uid },
    newClaimRef: { name: pvc.name, namespace: pvc.namespace, uid: pvc.uid },
  });
  capacity.handoffProgress("database-0", "hold_released");
  capacity.handoffProgress("database-0", "rebound");
  const publicKeyPin = {
    version: 2,
    keyId: golden.keyId,
    publicKey: golden.publicKey,
  };
  const config = {
    version: 1,
    journalDirectory: broker,
    delivery: {
      installationId: b.installationId,
      regionId: b.regionId,
      deliveryNamespace: "pgcf-runtime-delivery",
      deliveryNamespaceUid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      owner: {
        kind: "DaemonSet",
        name: "node-execution-delivery",
        uid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
      image: {
        reference: `registry.invalid/delivery@sha256:${"d".repeat(64)}`,
        indexDigest: "sha256:" + "d".repeat(64),
        amd64Digest: "sha256:" + "e".repeat(64),
        configDigest: "sha256:" + "f".repeat(64),
      },
      peers: [
        {
          nodeName: b.nodeName,
          nodeUid: b.nodeUid,
          bootId: b.bootId,
          podName: "delivery-fixture",
          podUid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
      ],
      kubeletRoot: "/var/lib/kubelet",
    },
    recipe: {
      image: spec.profile.postgresImage,
      command: golden.command,
      guard: {
        image: spec.profile.postgresImage,
        executable: "/execution-guard",
      },
    },
    runtimeImageId: spec.profile.postgresImage,
    publicKeyPin,
    publicKeyPinHash: digest(publicKeyPin),
    guardUid: 26,
    guardGid: 26,
    inputs: {
      volumeName: "pgcf-input-postgres",
      mountPath: "/pgcf/input/postgres",
      privateDirectory: "private",
    },
    ipc: {
      volumeName: "pgcf-ipc-postgres",
      mountPath: "/pgcf/ipc/postgres",
      privateDirectory: "private",
    },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "database-1",
      namespace: b.namespace,
      uid: b.podUid,
      labels: { "cnpg.io/podRole": "instance" },
      finalizers: ["pgcf.io/capacity-" + b.operationId],
      ownerReferences: [
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Cluster",
          name: "database",
          uid: capacity.snapshot().clusterUid,
          controller: true,
        },
      ],
    },
    spec: {
      nodeName: b.nodeName,
      securityContext: {
        runAsUser: 26,
        runAsGroup: 26,
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "postgres",
          image: spec.profile.postgresImage,
          command: [
            "/execution-guard",
            "--mode",
            "signed-window",
            "--expected-file",
            "/pgcf/input/postgres/private/expected.json",
            "--public-key-file",
            "/pgcf/input/postgres/private/key.json",
            "--ipc-directory",
            "/pgcf/ipc/postgres/private",
            "--",
            ...golden.command,
          ],
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            {
              name: config.inputs.volumeName,
              mountPath: config.inputs.mountPath,
              readOnly: true,
            },
            {
              name: config.ipc.volumeName,
              mountPath: config.ipc.mountPath,
              readOnly: false,
            },
          ],
        },
      ],
      volumes: [
        { name: config.inputs.volumeName, emptyDir: {} },
        { name: config.ipc.volumeName, emptyDir: {} },
      ],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "postgres",
          restartCount: 0,
          containerID: "containerd://" + containerId,
          imageID: spec.profile.postgresImage,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  };
  capacity.admitAttempt({
    id: "60000000-0000-4000-8000-000000000000",
    slotId: "database-0",
    name: pod.metadata.name,
    namespace: b.namespace,
    podUid: null,
  });
  capacity.observeComputeConsumer(
    "database-0",
    {
      uid: b.podUid,
      name: pod.metadata.name,
      namespace: b.namespace,
      nodeUid: b.nodeUid,
      specHash: digest(pod.spec),
      ownerChain: [
        {
          kind: "Cluster",
          name: "database",
          uid: capacity.snapshot().clusterUid,
        },
      ],
    },
    "60000000-0000-4000-8000-000000000000",
  );
  const resources = [
    pod,
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: b.namespace, uid: b.namespaceUid },
    },
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: {
        name: "database",
        namespace: b.namespace,
        uid: capacity.snapshot().clusterUid,
      },
    },
    {
      apiVersion: "v1",
      kind: "Node",
      metadata: { name: b.nodeName, uid: b.nodeUid },
      status: { nodeInfo: { bootID: b.bootId } },
    },
  ];
  const state = {
    issuerCalls: 0,
    dispatches: 0,
    refreshes: 0,
    allow: true,
    mode: "success",
    initializations: [],
  };
  const funding = {
    version: 1,
    envelopeVersion: 1,
    operationId: b.operationId,
    organizationId: b.organizationId,
    projectId: b.projectId,
    environmentId: b.environmentId,
    regionId: b.regionId,
    specRevision: 1,
    specHash: claim.specHash,
    runEpoch: "1",
    reservation: {
      id: b.reservationId,
      revision: "0",
      epoch: "1",
      environmentId: b.environmentId,
      regionId: b.regionId,
      specRevision: 1,
      specHash: claim.specHash,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      status: "issued",
      gapCount: "0",
      stoppedAt: null,
    },
  };
  const check = () => {
    if (!state.allow) throw new Error("fixture_authority_revoked");
  };
  const deps = {
    configuration: config,
    capacity,
    runtime: {
      read: async (kind, namespace, name) =>
        structuredClone(
          resources.find(
            (r) =>
              r.kind === kind &&
              (r.metadata.namespace ?? "") === namespace &&
              r.metadata.name === name,
          ) ?? null,
        ),
    },
    funding: {
      assert: check,
      refresh: async () => {
        state.refreshes++;
        check();
      },
      dispatchAuthority: () => ({
        check,
        expiresAt: () => Date.now() + 20_000,
      }),
    },
    fundingIdentity: funding,
    authority: { check, expiresAt: () => Date.now() + 20_000 },
    control: new ControlClient(
      "https://control.invalid",
      b.regionId,
      "fixture-region-token",
    ),
    delivery: {
      deliver: async (init, authority) => {
        state.dispatches++;
        state.initializations.push(init);
        await authority.revalidate(new AbortController().signal);
        const actual = {
          version: 2,
          nonce: init.nonce,
          binding: {
            installationId: init.expected.binding.installationId,
            namespaceUid: init.expected.binding.namespaceUid,
            podUid: init.expected.binding.podUid,
            containerName: "postgres",
            nodeName: init.expected.binding.nodeName,
            nodeUid: init.expected.binding.nodeUid,
            bootId: init.expected.binding.bootId,
            imageHash: init.expected.binding.imageHash,
            commandHash: init.expected.binding.commandHash,
          },
        };
        const permit = await authority.issue(
          actual,
          new AbortController().signal,
        );
        if (state.mode === "lost-ack")
          throw new Error("node_execution_publication_uncertain");
        await authority.revalidate(new AbortController().signal);
        return {
          receipt: {
            version: 1,
            type: "receipt",
            requestId: init.requestId,
            self: {
              podUid: config.delivery.peers[0].podUid,
              namespace: config.delivery.deliveryNamespace,
              nodeName: b.nodeName,
              installationId: b.installationId,
              regionId: b.regionId,
            },
            challengeHash: digest(JSON.stringify(actual)),
            permitHash: digest(JSON.stringify(permit)),
            state: "published",
            deadlineBootNs: "11000000000",
          },
          probeHash: "a".repeat(64),
        };
      },
    },
  };
  const beforeFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    state.issuerCalls++;
    assert.equal(
      url,
      `https://control.invalid/v1/regions/${b.regionId}/operations/${b.operationId}/execution-permits`,
    );
    assert.equal(request.redirect, "error");
    const body = JSON.parse(request.body);
    assert.equal(body.leaseToken, claim.leaseToken);
    const init = state.initializations.at(-1);
    const signed = canonicalCohort({
      version: 2,
      nonce: init.nonce,
      binding: init.expected.binding,
      durationNs: "12000000000",
      issuedAt: "2026-10-01T00:00:00.000Z",
      validUntil: "2026-10-01T00:00:12.000Z",
    });
    return Response.json({
      permit: {
        version: 2,
        keyId: golden.keyId,
        payload: Buffer.from(signed).toString("base64url"),
        signature: sign(
          null,
          Buffer.concat([
            Buffer.from(
              `cloudflare-postgres/execution-permit/v2\0${golden.keyId}\0`,
            ),
            Buffer.from(signed),
          ]),
          key,
        ).toString("base64url"),
      },
      runtimeEnforced: false,
      enforcementStatus: "pending_runtime",
    });
  };
  t.after(() => {
    globalThis.fetch = beforeFetch;
  });
  return {
    state,
    deps,
    claim,
    pod,
    dir,
    broker,
    input: {
      claim,
      podUid: b.podUid,
      attemptHint: { nonce, containerId, attempt: 0 },
    },
  };
}

test("derives initial PostgreSQL delivery from original capacity and target identities, records publication and reopens the same history without another issuer", async (t) => {
  const f = fixture(t);
  const first = await deliverInitialPostgres(f.input, f.deps);
  assert.equal(first.outcome, "published");
  assert.equal(f.state.dispatches, 1);
  assert.equal(f.state.issuerCalls, 1);
  assert.equal(f.state.initializations[0].expected.binding.podUid, b.podUid);
  assert.equal(f.state.initializations[0].publicKeyPin.keyId, golden.keyId);
  const second = await deliverInitialPostgres(f.input, f.deps);
  assert.equal(second.outcome, "already_recorded");
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(f.state.dispatches, 1);
  assert.equal(f.state.issuerCalls, 1);
  assert.equal(
    statSync(join(f.broker, b.operationId + ".execution.sqlite")).mode & 0o777,
    0o600,
  );
});
test("retains uncertain publication across restart and refuses a new nonce or container identity instead of silently issuing again", async (t) => {
  const f = fixture(t);
  f.state.mode = "lost-ack";
  await assert.rejects(
    deliverInitialPostgres(f.input, f.deps),
    /execution.*uncertain/,
  );
  assert.equal(f.state.issuerCalls, 1);
  await assert.rejects(
    deliverInitialPostgres(f.input, f.deps),
    /execution.*(uncertain|blocked)/,
  );
  assert.equal(f.state.issuerCalls, 1);
  assert.equal(f.state.dispatches, 1);
  await assert.rejects(
    deliverInitialPostgres(
      {
        ...f.input,
        attemptHint: {
          ...f.input.attemptHint,
          nonce: Buffer.alloc(32, 4).toString("base64url"),
        },
      },
      f.deps,
    ),
    /execution/,
  );
  assert.equal(f.state.issuerCalls, 1);
});
test("durably claims one concurrent broker and refreshes original authority before any issuer effect", async (t) => {
  const f = fixture(t);
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const original = f.deps.delivery.deliver;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.deps.delivery.deliver = async (...args) => {
    entered();
    await hold;
    return original(...args);
  };
  const pending = deliverInitialPostgres(f.input, f.deps);
  await Promise.race([started, pending]);
  await assert.rejects(
    deliverInitialPostgres(f.input, f.deps),
    /execution.*(blocked|in_progress)/,
  );
  assert.equal(f.state.issuerCalls, 0);
  f.state.allow = false;
  release();
  await assert.rejects(pending, /execution/);
  assert.equal(f.state.issuerCalls, 0);
});
