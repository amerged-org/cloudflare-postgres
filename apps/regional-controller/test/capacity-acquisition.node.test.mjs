// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:http";
import { once } from "node:events";
import { backup, DatabaseSync } from "node:sqlite";
import { KubeConfig } from "@kubernetes/client-node";
import { capacityKubernetesFromClientConfig } from "../src/capacity-kubernetes.ts";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { runController } from "../src/run.ts";
import { ControlClient } from "../src/control-client.ts";
import { preparePostgresExpectedManifest } from "../src/execution-manifest.ts";
import {
  provisioningResourceEnvelope,
  provisioningAllowanceUnits,
} from "@cloudflare-postgres/resource-envelope";
import { join } from "node:path";
import { acquireCapacity } from "../src/capacity-reconcile.ts";
import { CapacityJournal } from "../src/capacity-journal.ts";
import { handoffCapacity } from "../src/capacity-handoff.ts";
import { capacityAdmission } from "../src/capacity-admission.ts";
import { startCapacityAdmissionServer } from "../src/capacity-admission-server.ts";
import { seedCapacityInstallation } from "./fixtures/capacity-installation.mjs";
import { capacityQuotaSpecs } from "../src/capacity-quota-policy.ts";
import { openCapacityPodQuota } from "../src/capacity-quota.ts";

test(
  "concurrent provisioning reclaims the same actual capacity hold after an uncertain response before any customer effect",
  { timeout: 90_000 },
  async (t) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "pgcf-capacity-")),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const nodeUid = "77777777-7777-4777-8777-777777777777";
    const bootId = "88888888-8888-4888-8888-888888888888";
    const regionId = "22222222-2222-4222-8222-222222222222";
    const marginUid = "66666666-6666-4666-8666-666666666666";
    const config = {
      version: 1,
      installationId: "capacity-fixture",
      namespace: "pgcf-system",
      journalDirectory: directory,
      schedulerName: "koord-scheduler",
      holdStorageClassPrefix: "pgcf-capacity",
      allowedNodes: [{ name: "node-a", uid: nodeUid }],
      storageNamespace: "openebs",
      platformReservations: [
        {
          nodeName: "node-a",
          nodeUid,
          name: "platform-margin",
          uid: marginUid,
        },
      ],
      platformMargin: { cpuMilli: 100, memoryMiB: 128, podSlots: 1 },
      admission: {
        apiServerIdentity: "fixture-apiserver",
        jobUsername: "system:serviceaccount:kube-system:job-controller",
        replicaSetUsername:
          "system:serviceaccount:kube-system:replicaset-controller",
        approvedImages: [
          `registry.invalid/postgres@sha256:${"b".repeat(64)}`,
          `registry.invalid/pooler@sha256:${"c".repeat(64)}`,
        ],
        mutatingConfiguration: "pgcf-capacity-mutate",
        validatingConfiguration: "pgcf-capacity-validate",
        serviceNamespace: "pgcf-system",
        serviceName: "capacity-admission",
        operatorUsername:
          "system:serviceaccount:pgcf-system:regional-controller",
        schedulerUsername:
          "system:serviceaccount:koordinator-system:koord-scheduler",
        cnpgUsername:
          "system:serviceaccount:cnpg-system:cnpg-controller-manager",
      },
      schedulerDeployment: {
        namespace: "koordinator-system",
        name: "koord-scheduler",
        image: `registry.invalid/koord-scheduler@sha256:${"a".repeat(64)}`,
      },
    };
    const spec = {
      name: "ordinary",
      regionId,
      catalogVersion: "fixture",
      profileId: "small",
      volumeGiB: 5,
      profile: {
        id: "small",
        instances: 1,
        executionFencing: { version: 1 },
        postgresImage: `registry.invalid/postgres@sha256:${"b".repeat(64)}`,
        compute: { cpuMilli: 100, memoryMiB: 128 },
        storage: {
          classId: "local",
          storageClassName: "pgcf-lvm",
          minGiB: 5,
          maxGiB: 10,
          stepGiB: 5,
        },
        pooling: {
          version: 1,
          image: `registry.invalid/pooler@sha256:${"c".repeat(64)}`,
          mode: "session",
          compute: {
            requests: { cpuMilli: 75, memoryMiB: 64 },
            limits: { cpuMilli: 100, memoryMiB: 128 },
          },
          connections: {
            maxClients: 20,
            poolSize: 5,
            maxDatabaseConnections: 10,
            maxUserConnections: 10,
          },
          timeouts: {
            queryWaitSeconds: 3,
            connectSeconds: 3,
            cancelWaitSeconds: 3,
          },
        },
        backup: {
          endpointURL: "https://archive.invalid",
          region: "auto",
          destinationPath: "s3://fixture",
          retentionPolicy: "7d",
          credentialSecret: {
            namespace: "platform",
            name: "backup",
            accessKeyIdKey: "access",
            secretAccessKeyKey: "secret",
          },
        },
      },
    };
    const claim = {
      operationId: "33333333-3333-4333-8333-333333333333",
      environmentId: "11111111-1111-4111-8111-111111111111",
      regionId,
      kind: "environment.create",
      leaseToken: "fixture-only",
      leaseEpoch: 1,
      runEpoch: "1",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      specRevision: 1,
      specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
      spec,
    };
    let ordinal = 10,
      lost = true;
    let failAfterVolume = false,
      sawVolume = false;
    let lostQuotaPatch = true;
    const resources = new Map();
    const effects = [];
    const capacityEffects = [];
    const nativeMutations = [];
    const uid = () =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(ordinal++).padStart(12, "0")}`;
    const key = (kind, ns, name) => `${kind}:${ns}:${name}`;
    const save = (resource) => {
      const value = structuredClone(resource);
      value.metadata.uid ??= uid();
      value.metadata.resourceVersion = String(ordinal++);
      resources.set(
        key(value.kind, value.metadata.namespace ?? "", value.metadata.name),
        value,
      );
      return structuredClone(value);
    };
    seedCapacityInstallation({ save, nodeUid, bootId, marginUid, config });
    const nativeRuntime = {
      async read(kind, ns, name) {
        if (kind === "LVMVolume") sawVolume = true;
        if (kind === "Node" && failAfterVolume && sawVolume) {
          failAfterVolume = false;
          throw new Error("node_readback_lost_after_volume_observation");
        }
        return structuredClone(resources.get(key(kind, ns, name)) ?? null);
      },
      async list(kind, ns) {
        return [...resources.values()]
          .filter(
            (r) =>
              r.kind === kind &&
              (ns === undefined || r.metadata.namespace === ns),
          )
          .map((r) => structuredClone(r));
      },
      async create(resource) {
        capacityEffects.push(resource.metadata.name);
        const k = key(
          resource.kind,
          resource.metadata.namespace ?? "",
          resource.metadata.name,
        );
        if (resources.has(k)) throw new Error("conflict");
        if (
          resource.kind === "Reservation" ||
          resource.kind === "PersistentVolumeClaim"
        ) {
          const created = save(resource);
          if (resource.kind === "Reservation" && lost) {
            lost = false;
            throw new Error("response_lost_after_committed_reservation");
          }
          return created;
        }
        return save(resource);
      },
      async patch(kind, ns, name, ops) {
        nativeMutations.push("patch:" + kind + ":" + name);
        const current = await this.read(kind, ns, name);
        if (!current) throw new Error("missing");
        for (const op of ops) {
          const parts = op.path
            .slice(1)
            .split("/")
            .map((v) => v.replaceAll("~1", "/").replaceAll("~0", "~"));
          let target = current;
          for (const part of parts.slice(0, -1)) target = target[part];
          const last = parts.at(-1);
          if (op.op === "test") assert.deepEqual(target[last], op.value);
          else if (op.op === "remove") delete target[last];
          else target[last] = structuredClone(op.value);
        }
        const changed = save(current);
        if (kind === "ResourceQuota" && lostQuotaPatch) {
          lostQuotaPatch = false;
          throw new Error("response_lost_after_committed_quota_opening");
        }
        if (
          kind === "PersistentVolume" &&
          lostPvPatch &&
          ops.some((p) => p.op !== "test" && p.path === "/spec/claimRef")
        ) {
          lostPvPatch = false;
          throw new Error("response_lost_after_committed_pv_transfer");
        }
        return changed;
      },
      async remove(kind, ns, name, expectedUid) {
        nativeMutations.push("delete:" + kind + ":" + name);
        const r = await this.read(kind, ns, name);
        assert.equal(r.metadata.uid, expectedUid);
        resources.delete(key(kind, ns, name));
        if (kind === "PersistentVolumeClaim") {
          for (const pv of [...resources.values()])
            if (
              pv.kind === "PersistentVolume" &&
              pv.spec.claimRef?.uid === expectedUid
            )
              save({ ...pv, status: { phase: "Released" } });
        }
      },
    };
    // The same lifecycle now passes through the actual official SDK wire,
    // including custom-resource paths, model normalization and guarded writes.
    const plurals = {
      namespaces: "Namespace",
      clusters: "Cluster",
      resourcequotas: "ResourceQuota",
      nodes: "Node",
      pods: "Pod",
      persistentvolumes: "PersistentVolume",
      persistentvolumeclaims: "PersistentVolumeClaim",
      storageclasses: "StorageClass",
      csinodes: "CSINode",
      deployments: "Deployment",
      reservations: "Reservation",
      lvmnodes: "LVMNode",
      lvmvolumes: "LVMVolume",
      mutatingwebhookconfigurations: "MutatingWebhookConfiguration",
      validatingwebhookconfigurations: "ValidatingWebhookConfiguration",
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      const at = parts.indexOf("namespaces"),
        namespaced = at >= 0 && parts.length > at + 2,
        ns = namespaced ? parts[at + 1] : "";
      const collection = namespaced ? at + 2 : parts[0] === "api" ? 2 : 3;
      const kind = plurals[parts[collection]],
        name = parts[collection + 1];
      const apiVersion =
        parts[0] === "api" ? parts[1] : parts[1] + "/" + parts[2];
      const send = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      try {
        assert.ok(kind, "unsupported native fixture route");
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          assert.ok(raw.length <= 1048576);
        }
        const body = raw ? JSON.parse(raw) : null;
        let value;
        if (request.method === "GET") {
          if (name) value = await nativeRuntime.read(kind, ns, name);
          else {
            const items = await nativeRuntime.list(kind, ns || undefined);
            return send(200, {
              apiVersion,
              kind: kind + "List",
              metadata: { resourceVersion: String(ordinal) },
              items,
            });
          }
          if (!value)
            return send(404, {
              apiVersion: "v1",
              kind: "Status",
              status: "Failure",
              reason: "NotFound",
              code: 404,
            });
        } else if (request.method === "POST") {
          assert.equal(url.searchParams.get("fieldValidation"), "Strict");
          assert.equal(body.kind, kind);
          value = await nativeRuntime.create(body);
        } else if (request.method === "PATCH") {
          assert.equal(
            request.headers["content-type"],
            "application/json-patch+json",
          );
          assert.equal(url.searchParams.get("fieldValidation"), "Strict");
          value = await nativeRuntime.patch(kind, ns, name, body);
        } else if (request.method === "DELETE") {
          const current = await nativeRuntime.read(kind, ns, name);
          assert.equal(body.preconditions.uid, current.metadata.uid);
          assert.equal(
            body.preconditions.resourceVersion,
            current.metadata.resourceVersion,
          );
          await nativeRuntime.remove(kind, ns, name, body.preconditions.uid);
          value = {
            apiVersion: "v1",
            kind: "Status",
            status: "Success",
            code: 200,
          };
        } else throw new Error("method unsupported");
        return send(200, value);
      } catch {
        return send(500, {
          apiVersion: "v1",
          kind: "Status",
          status: "Failure",
          reason: "InternalError",
          code: 500,
        });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    // Only this public loopback fixture permits HTTP; no credential or
    // production TLS configuration is weakened.
    const clientConfig = new KubeConfig();
    clientConfig.loadFromOptions({
      clusters: [
        {
          name: "fixture",
          server: "http://127.0.0.1:" + server.address().port,
          skipTLSVerify: true,
        },
      ],
      users: [{ name: "fixture" }],
      contexts: [{ name: "fixture", cluster: "fixture", user: "fixture" }],
      currentContext: "fixture",
    });
    const runtime = capacityKubernetesFromClientConfig(clientConfig);

    // Explicit controller progress is separate from API creates. A Pending
    // object is not capacity; this models one lifecycle, not a test matrix.
    function advanceNativeControllers() {
      const bytes = (q) =>
        q.endsWith("Mi") ? BigInt(q.slice(0, -2)) * 1048576n : BigInt(q);
      const cpu = (q) =>
        q.endsWith("m") ? Number(q.slice(0, -1)) : Number(q) * 1000;
      let usedCpu = 0,
        usedMemory = 0n,
        usedPods = 0;
      for (const r of resources.values()) {
        if (
          (r.kind === "Pod" && r.spec.nodeName === "node-a") ||
          (r.kind === "Reservation" && r.status?.phase === "Available")
        ) {
          const containers =
            r.kind === "Pod"
              ? r.spec.containers
              : r.spec.template.spec.containers;
          usedPods++;
          for (const c of containers) {
            usedCpu += cpu(c.resources.requests.cpu);
            usedMemory += bytes(c.resources.requests.memory);
          }
        }
      }
      for (const r of [...resources.values()]) {
        if (
          r.kind !== "Reservation" ||
          (r.status?.phase ?? "Pending") !== "Pending"
        )
          continue;
        const requests = r.spec.template.spec.containers[0].resources.requests;
        const requestedCpu = cpu(requests.cpu),
          requestedMemory = bytes(requests.memory);
        if (
          usedCpu + requestedCpu > 450 ||
          usedMemory + requestedMemory > 4294967296n ||
          usedPods + 1 > 30
        )
          continue;
        usedCpu += requestedCpu;
        usedMemory += requestedMemory;
        usedPods++;
        save({
          ...r,
          status: {
            phase: "Available",
            nodeName: "node-a",
            allocatable: requests,
            conditions: [
              { type: "Ready", status: "True" },
              { type: "Scheduled", status: "True" },
            ],
          },
        });
      }
      for (const claim of [...resources.values()]) {
        if (claim.kind !== "PersistentVolumeClaim" || !claim.spec.volumeName)
          continue;
        const pv = resources.get(
          key("PersistentVolume", "", claim.spec.volumeName),
        );
        if (
          !pv ||
          pv.spec.claimRef?.uid !== claim.metadata.uid ||
          pv.spec.claimRef.namespace !== claim.metadata.namespace ||
          pv.spec.storageClassName !== claim.spec.storageClassName ||
          JSON.stringify(pv.spec.accessModes) !==
            JSON.stringify(claim.spec.accessModes) ||
          BigInt(pv.spec.capacity.storage) <
            BigInt(claim.spec.resources.requests.storage)
        )
          continue;
        save({ ...pv, status: { phase: "Bound" } });
        save({ ...claim, status: { phase: "Bound" } });
      }
      for (const r of [...resources.values()]) {
        if (
          r.kind !== "PersistentVolumeClaim" ||
          (r.status?.phase ?? "Pending") !== "Pending"
        )
          continue;
        const storageClass = resources.get(
          key("StorageClass", "", r.spec.storageClassName),
        );
        // WFFC needs the authenticated reserved-node selection, compatible
        // topology and sufficient thick extents, not unconditional binding.
        if (
          r.metadata.annotations?.["volume.kubernetes.io/selected-node"] !==
            "node-a" ||
          storageClass?.volumeBindingMode !== "WaitForFirstConsumer" ||
          storageClass?.allowedTopologies?.[0]?.matchLabelExpressions?.[0]
            ?.values?.[0] !== "node-a"
        )
          continue;
        assert.equal(r.spec.accessModes[0], "ReadWriteOnce");
        const lvmNode = resources.get(key("LVMNode", "openebs", "node-a"));
        const vg = lvmNode.volumeGroups[0],
          amount = bytes(r.spec.resources.requests.storage);
        if (BigInt(vg.free) < amount) continue;
        vg.free = (BigInt(vg.free) - amount).toString();
        vg.lvCount++;
        save(lvmNode);
        const pvName = "pv-" + r.metadata.uid;
        const lv = save({
          apiVersion: "local.openebs.io/v1alpha1",
          kind: "LVMVolume",
          metadata: { name: pvName, namespace: "openebs" },
          spec: {
            ownerNodeID: "node-a",
            volGroup: "pgcf",
            vgPattern: "^pgcf$",
            capacity: amount.toString(),
            thinProvision: "no",
          },
          status: { state: "Ready" },
        });
        save({
          apiVersion: "v1",
          kind: "PersistentVolume",
          metadata: { name: pvName },
          spec: {
            capacity: { storage: amount.toString() },
            accessModes: ["ReadWriteOnce"],
            volumeMode: "Filesystem",
            storageClassName: r.spec.storageClassName,
            persistentVolumeReclaimPolicy: "Retain",
            claimRef: {
              apiVersion: "v1",
              kind: "PersistentVolumeClaim",
              namespace: r.metadata.namespace,
              name: r.metadata.name,
              uid: r.metadata.uid,
            },
            csi: {
              driver: "local.csi.openebs.io",
              volumeHandle: lv.metadata.name,
              volumeAttributes: { "openebs.io/volgroup": "pgcf" },
            },
            nodeAffinity: {
              required: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: "openebs.io/nodename",
                        operator: "In",
                        values: ["node-a"],
                      },
                    ],
                  },
                ],
              },
            },
          },
          status: { phase: "Bound" },
        });
        save({
          ...r,
          spec: { ...r.spec, volumeName: pvName },
          status: { phase: "Bound" },
        });
      }
    }
    assert.equal(
      await acquireCapacity(runtime, claim, config, () => {}),
      null,
      "uncertain Pending reservations never admit customer effects",
    );
    assert.deepEqual(effects, []);
    advanceNativeControllers();
    assert.equal(
      await acquireCapacity(runtime, claim, config, () => {}),
      null,
      "Pending WFFC claims are not physical storage holds",
    );
    advanceNativeControllers();
    failAfterVolume = true;
    sawVolume = false;
    await assert.rejects(acquireCapacity(runtime, claim, config, () => {}));
    const holdingClaim = resources.get(
      key(
        "PersistentVolumeClaim",
        config.namespace,
        [...resources.values()].find(
          (r) =>
            r.kind === "PersistentVolumeClaim" &&
            r.metadata.labels?.["pgcf.io/capacity-slot"] === "database-0",
        ).metadata.name,
      ),
    );
    const originalPv = resources.get(
      key("PersistentVolume", "", holdingClaim.spec.volumeName),
    );
    const originalLv = resources.get(
      key(
        "LVMVolume",
        config.storageNamespace,
        originalPv.spec.csi.volumeHandle,
      ),
    );
    const inspection = CapacityJournal.openExisting(
      join(directory, claim.operationId + ".sqlite"),
    );
    try {
      assert.equal(
        inspection.snapshot().slots[0].pv?.uid,
        originalPv.metadata.uid,
        "already observed PV identity survives a later uncertain read",
      );
      assert.equal(
        inspection.snapshot().slots[0].lvmVolume?.uid,
        originalLv.metadata.uid,
      );
    } finally {
      inspection.close();
    }
    const first = await acquireCapacity(runtime, claim, config, () => {});
    assert.ok(
      first,
      "loadable baseline must acquire actual durable slot capacity instead of deferring",
    );
    const snapshot = first.snapshot();
    assert.equal(
      snapshot.slots.length,
      3,
      "maintenance plus optional pooler are reserved exactly once",
    );
    assert.equal(snapshot.slots.filter((s) => s.storage).length, 2);
    const original = structuredClone(snapshot.slots);
    first.close();
    const validationKey = key(
      "ValidatingWebhookConfiguration",
      "",
      config.admission.validatingConfiguration,
    );
    const originalValidation = structuredClone(resources.get(validationKey));
    save({
      ...originalValidation,
      webhooks: [
        {
          ...originalValidation.webhooks[0],
          matchConditions: [{ name: "skip", expression: "false" }],
        },
      ],
    });
    const effectsBeforeBypass = capacityEffects.length;
    await assert.rejects(
      acquireCapacity(runtime, { ...claim, leaseEpoch: 2 }, config, () => {}),
      "a false webhook match condition cannot satisfy protected admission",
    );
    assert.equal(capacityEffects.length, effectsBeforeBypass);
    save(originalValidation);
    const reclaimed = await acquireCapacity(
      runtime,
      { ...claim, leaseEpoch: 2 },
      config,
      () => {},
    );
    assert.deepEqual(
      reclaimed.snapshot().slots,
      original,
      "uncertain reservation and actual volumes must not be reallocated on reclaim",
    );
    const competing = {
      ...claim,
      operationId: "44444444-4444-4444-8444-444444444444",
      environmentId: "55555555-5555-4555-8555-555555555555",
    };
    const loser = await acquireCapacity(runtime, competing, config, () => {});
    assert.equal(loser, null);
    advanceNativeControllers();
    assert.equal(
      await acquireCapacity(runtime, competing, config, () => {}),
      null,
      "occupied/reserved CPU, memory and Pod slots prevent overbooking",
    );
    let funded = false;
    const ownerLabels = {
      "app.kubernetes.io/managed-by": "cloudflare-postgres",
      "pgcf.io/environment-id": claim.environmentId,
      "pgcf.io/region-id": claim.regionId,
    };
    const ownerAnnotations = {
      "pgcf.io/spec-hash": claim.specHash,
      "pgcf.io/run-epoch": claim.runEpoch,
    };
    const wrapped = reclaimed.wrap(
      {
        async read(kind, namespace, name) {
          return structuredClone(
            resources.get(key(kind, namespace, name)) ?? null,
          );
        },
        async create(r, authority) {
          assert.ok(
            authority,
            "capacity authority must reach the actual dispatch",
          );
          authority.check();
          assert.ok(authority.expiresAt() > Date.now());
          effects.push(r.kind);
          const committed = save(r);
          if (["Namespace", "Cluster"].includes(r.kind))
            throw new Error("lost_committed_response");
          return committed;
        },
        async readSecret() {
          return {};
        },
        async listPods() {
          return [];
        },
      },
      () => {
        assert.ok(funded, "funding must precede all customer effects");
      },
    );
    await assert.rejects(
      wrapped.create({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: original.length ? snapshot.plan.namespace : "never" },
      }),
    );
    assert.deepEqual(effects, []);
    funded = true;
    await assert.rejects(
      wrapped.create({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: snapshot.plan.namespace,
          labels: ownerLabels,
          annotations: ownerAnnotations,
        },
      }),
    );
    const recoveredNamespace = await wrapped.read(
      "Namespace",
      "",
      snapshot.plan.namespace,
    );
    assert.equal(
      reclaimed.snapshot().namespaceUid,
      recoveredNamespace.metadata.uid,
      "readback after a committed timeout seals the same namespace identity",
    );
    assert.deepEqual(effects, ["Namespace"]);
    // CNPG creates its own pending claim after its Cluster exists. A zero-Pod
    // quota gates bootstrap/ordinary/Pooler compute during exact-volume handoff.
    const transferJournal = CapacityJournal.openExisting(
      join(directory, claim.operationId + ".sqlite"),
    );
    const clusterUid = "99999999-9999-4999-8999-999999999999";
    transferJournal.bindRuntime({
      projectId: "77777777-7777-4777-8777-777777777778",
      organizationId: "77777777-7777-4777-8777-777777777779",
    });
    save({
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: {
        name: "database-resources",
        namespace: snapshot.plan.namespace,
        labels: ownerLabels,
        annotations: ownerAnnotations,
      },
      spec: capacityQuotaSpecs(snapshot.plan).closed,
      status: {
        hard: capacityQuotaSpecs(snapshot.plan).closed.hard,
        used: { pods: "0" },
      },
    });
    await assert.rejects(
      wrapped.create({
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: {
          name: "database",
          namespace: snapshot.plan.namespace,
          uid: clusterUid,
          labels: ownerLabels,
          annotations: ownerAnnotations,
        },
        spec: {
          imageName: spec.profile.postgresImage,
          storage: {
            storageClass: snapshot.plan.customerStorageClass,
            size: "5Gi",
          },
        },
      }),
    );
    const recoveredCluster = await wrapped.read(
      "Cluster",
      snapshot.plan.namespace,
      "database",
    );
    assert.equal(
      reclaimed.snapshot().clusterUid,
      recoveredCluster.metadata.uid,
    );
    const namespaceKey = key("Namespace", "", snapshot.plan.namespace);
    const originalNamespace = resources.get(namespaceKey);
    resources.set(namespaceKey, {
      ...originalNamespace,
      metadata: {
        ...originalNamespace.metadata,
        uid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    await assert.rejects(
      wrapped.read("Namespace", "", snapshot.plan.namespace),
      "a replacement namespace cannot be adopted on retry",
    );
    resources.set(namespaceKey, originalNamespace);
    assert.deepEqual(effects, ["Namespace", "Cluster"]);
    reclaimed.close();
    const target = save({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: "database-1",
        namespace: snapshot.plan.namespace,
        labels: { "cnpg.io/cluster": "database", "cnpg.io/pvcRole": "PG_DATA" },
        annotations: {
          "cnpg.io/nodeSerial": "1",
          "cnpg.io/pvcStatus": "initializing",
        },
        ownerReferences: [
          {
            apiVersion: "postgresql.cnpg.io/v1",
            kind: "Cluster",
            name: "database",
            uid: clusterUid,
            controller: true,
          },
        ],
      },
      spec: {
        storageClassName: snapshot.plan.customerStorageClass,
        accessModes: ["ReadWriteOnce"],
        volumeMode: "Filesystem",
        resources: { requests: { storage: "5368709120" } },
      },
      status: { phase: "Pending" },
    });
    const authority = {
      check() {}, // Winning regional lease remains live during this funding cut.
      expiresAt: () => Date.now() + 15000,
    };
    const fundingFence = {
      refresh() {
        assert.ok(funded);
      },
      check() {
        assert.ok(funded);
      },
      expiresAt: authority.expiresAt,
    };
    const originalAuthentication =
      clientConfig.applySecurityAuthentication.bind(clientConfig);
    let expireOnPatch = true;
    clientConfig.applySecurityAuthentication = async (context) => {
      await originalAuthentication(context);
      if (expireOnPatch && context.getHttpMethod() === "PATCH") {
        expireOnPatch = false;
        funded = false;
      }
    };
    const beforeExpiredDispatch = nativeMutations.length;
    try {
      assert.equal(
        await handoffCapacity(
          runtime,
          transferJournal,
          "database-0",
          target.metadata.name,
          config,
          authority,
          fundingFence,
        ),
        false,
      );
      assert.equal(
        nativeMutations.length,
        beforeExpiredDispatch,
        "funding cut during asynchronous SDK auth refuses the physical write",
      );
    } finally {
      clientConfig.applySecurityAuthentication = originalAuthentication;
      funded = true;
    }
    const pvKey = key("PersistentVolume", "", original[0].storage.pv.name);
    const beforeContradiction = structuredClone(resources.get(pvKey));
    save({
      ...beforeContradiction,
      spec: {
        ...beforeContradiction.spec,
        claimRef: {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          name: "foreign",
          namespace: "foreign",
          uid: "aaaaaaaa-aaaa-4aaa-8aaa-111111111111",
        },
      },
    });
    const mutationsBeforeContradiction = nativeMutations.length;
    try {
      await assert.rejects(
        handoffCapacity(
          runtime,
          transferJournal,
          "database-0",
          target.metadata.name,
          config,
          authority,
          fundingFence,
        ),
      );
      assert.equal(
        nativeMutations.length,
        mutationsBeforeContradiction,
        "contradictory PV ownership refuses before prebinding or holding-claim deletion",
      );
    } finally {
      save(beforeContradiction);
    }
    const groupKey = key("LVMNode", config.storageNamespace, "node-a");
    const originalGroup = structuredClone(resources.get(groupKey));
    save({
      ...originalGroup,
      volumeGroups: [{ ...originalGroup.volumeGroups[0], uuid: "foreign-vg" }],
    });
    const mutationsBeforeGroupDrift = nativeMutations.length;
    try {
      await assert.rejects(
        handoffCapacity(
          runtime,
          transferJournal,
          "database-0",
          target.metadata.name,
          config,
          authority,
          fundingFence,
        ),
        "a changed physical group cannot inherit the original capacity receipt",
      );
      assert.equal(nativeMutations.length, mutationsBeforeGroupDrift);
    } finally {
      save(originalGroup);
    }
    try {
      assert.equal(
        await handoffCapacity(
          runtime,
          transferJournal,
          "database-0",
          target.metadata.name,
          config,
          authority,
          fundingFence,
        ),
        false,
      );
      advanceNativeControllers();
      assert.equal(
        await handoffCapacity(
          runtime,
          transferJournal,
          "database-0",
          target.metadata.name,
          config,
          authority,
          fundingFence,
        ),
        true,
        "the same physical volume must converge after a lost committed PV patch",
      );
      const transferred = resources.get(
        key("PersistentVolume", "", original[0].storage.pv.name),
      );
      assert.equal(transferred.metadata.uid, original[0].storage.pv.uid);
      assert.equal(
        transferred.spec.csi.volumeHandle,
        original[0].storage.csiHandle,
      );
      assert.equal(transferred.spec.claimRef.uid, target.metadata.uid);
      assert.equal(
        transferred.spec.storageClassName,
        snapshot.plan.customerStorageClass,
      );
      assert.equal(transferJournal.snapshot().slots[0].handoffPhase, "rebound");
      assert.equal(
        resources.get(
          key(
            "PersistentVolumeClaim",
            snapshot.plan.namespace,
            target.metadata.name,
          ),
        ).metadata.annotations["cnpg.io/pvcStatus"],
        "initializing",
      );
      assert.equal(
        resources.has(
          key(
            "PersistentVolumeClaim",
            config.namespace,
            original[0].storage.holdPvc.name,
          ),
        ),
        false,
      );
      transferJournal.close();
      const completedTarget = resources.get(
        key(
          "PersistentVolumeClaim",
          snapshot.plan.namespace,
          target.metadata.name,
        ),
      );
      save({
        ...completedTarget,
        metadata: {
          ...completedTarget.metadata,
          annotations: {
            ...completedTarget.metadata.annotations,
            "cnpg.io/pvcStatus": "ready",
          },
        },
      });
      const replay = CapacityJournal.openExisting(
        join(directory, claim.operationId + ".sqlite"),
      );
      const effectsBeforeReplay = capacityEffects.length;
      try {
        assert.equal(
          await handoffCapacity(
            runtime,
            replay,
            "database-0",
            target.metadata.name,
            config,
            authority,
            fundingFence,
          ),
          true,
          "a completed handoff replays after restart without replacement effects",
        );
        assert.equal(capacityEffects.length, effectsBeforeReplay);
      } finally {
        replay.close();
      }
    } finally {
      transferJournal.close();
    }
    const effectsBeforeTransferredReclaim =
      nativeMutations.length + capacityEffects.length;
    const transferredReclaim = await acquireCapacity(
      runtime,
      { ...claim, leaseEpoch: 2 },
      config,
      () => {},
    );
    assert.ok(
      transferredReclaim,
      "reclaim observes the transferred volume rather than recreating its holding claim",
    );
    assert.equal(
      transferredReclaim.snapshot().slots[0].handoffPhase,
      "rebound",
    );
    transferredReclaim.close();
    assert.equal(
      nativeMutations.length + capacityEffects.length,
      effectsBeforeTransferredReclaim,
    );
    const admissionJournal = CapacityJournal.openExisting(
      join(directory, claim.operationId + ".sqlite"),
    );
    const oldQuota = resources.get(
      key("ResourceQuota", snapshot.plan.namespace, "database-resources"),
    );
    save({
      ...oldQuota,
      spec: capacityQuotaSpecs(snapshot.plan).open,
      status: {
        hard: capacityQuotaSpecs(snapshot.plan).open.hard,
        used: { pods: "0" },
      },
    });
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "database-1",
        namespace: snapshot.plan.namespace,
        labels: {
          "cnpg.io/cluster": "database",
          "cnpg.io/instanceName": "database-1",
          "cnpg.io/podRole": "instance",
        },
        annotations: { "cnpg.io/nodeSerial": "1" },
        ownerReferences: [
          {
            apiVersion: "postgresql.cnpg.io/v1",
            kind: "Cluster",
            name: "database",
            uid: clusterUid,
            controller: true,
          },
        ],
      },
      spec: {
        schedulerName: "default-scheduler",
        restartPolicy: "Always",
        volumes: [
          {
            name: "pgdata",
            persistentVolumeClaim: { claimName: "database-1" },
          },
        ],
        containers: [
          {
            name: "postgres",
            image: spec.profile.postgresImage,
            securityContext: { readOnlyRootFilesystem: true },
            command: [
              "/execution-guard",
              "--mode",
              "signed-window",
              "--",
              "/controller/manager",
              "instance",
              "run",
            ],
            resources: {
              requests: { cpu: "125m", memory: "192Mi" },
              limits: { cpu: "200m", memory: "256Mi" },
            },
          },
        ],
      },
    };
    const admissionContext = {
      claim,
      workloadVolumesPrepared: (candidate, _state, slot) =>
        candidate.spec.volumes.every(
          (v) => v.persistentVolumeClaim?.claimName === slot.targetPvc.name,
        ),
      runtime,
      journal: admissionJournal,
      config,
      funding: fundingFence,
      authority,
      transportAuthenticated: () => true,
      executionPrepared: (candidate) =>
        candidate.spec.containers.every(
          (c) =>
            c.command?.[0] === "/execution-guard" &&
            c.command?.includes("signed-window"),
        ),
    };
    const review = {
      apiVersion: "admission.k8s.io/v1",
      kind: "AdmissionReview",
      request: {
        uid: "aaaaaaaa-aaaa-4aaa-8aaa-333333333333",
        operation: "CREATE",
        kind: { group: "", version: "v1", kind: "Pod" },
        resource: { group: "", version: "v1", resource: "pods" },
        namespace: snapshot.plan.namespace,
        name: "database-1",
        userInfo: { username: config.admission.cnpgUsername },
        object: pod,
      },
    };
    try {
      const unsealed = await capacityAdmission(
        review,
        "mutate",
        admissionContext,
      );
      assert.equal(
        unsealed.allowed,
        false,
        "an externally opened quota without durable opening custody must not admit compute",
      );
      save(oldQuota);
      const prepared = {
        check: () => authority.check(),
        expiresAt: () => authority.expiresAt(),
        refresh: async () => {
          const current = await acquireCapacity(
            runtime,
            { ...claim, leaseEpoch: 2 },
            config,
            authority.check,
          );
          assert.ok(
            current,
            "opening requires current physical capacity and installed admission prerequisites",
          );
          current.close();
        },
      };
      // Preserve an exact pre-opening fixture checkpoint for one irreversible
      // release race. The original workflow is not rewound or unfenced.
      const releasePath = join(directory, "release-race.sqlite");
      writeFileSync(releasePath, "", { mode: 0o600 });
      const sourceJournal = new DatabaseSync(
        join(directory, claim.operationId + ".sqlite"),
        { readOnly: true },
      );
      try {
        await backup(sourceJournal, releasePath);
      } finally {
        sourceJournal.close();
      }
      const releaseJournal = CapacityJournal.openExisting(releasePath);
      const beforeReleaseDispatch = nativeMutations.length;
      clientConfig.applySecurityAuthentication = async (context) => {
        await originalAuthentication(context);
        if (context.getHttpMethod() === "PATCH")
          releaseJournal.beginComputeRelease();
      };
      try {
        await assert.rejects(
          openCapacityPodQuota(
            runtime,
            releaseJournal,
            authority,
            fundingFence,
            prepared,
          ),
        );
        assert.equal(
          nativeMutations.length,
          beforeReleaseDispatch,
          "release latched during asynchronous SDK authentication must stop quota opening before dispatch",
        );
        assert.equal(releaseJournal.snapshot().phase, "releasing");
      } finally {
        clientConfig.applySecurityAuthentication = originalAuthentication;
        releaseJournal.close();
      }
      const lateAppliedPath = join(directory, "late-applied-race.sqlite");
      writeFileSync(lateAppliedPath, "", { mode: 0o600 });
      const lateAppliedSource = new DatabaseSync(
        join(directory, claim.operationId + ".sqlite"),
        { readOnly: true },
      );
      try {
        await backup(lateAppliedSource, lateAppliedPath);
      } finally {
        lateAppliedSource.close();
      }
      const lateAppliedJournal = CapacityJournal.openExisting(lateAppliedPath);
      // A different observer retains a real applied observation; its journal
      // write arrives after the external close and this invocation's fresh read.
      const observedApplied = save({
        ...oldQuota,
        spec: capacityQuotaSpecs(snapshot.plan).open,
      });
      save(oldQuota);
      const beforeLateAppliedDispatch = nativeMutations.length;
      clientConfig.applySecurityAuthentication = async (context) => {
        await originalAuthentication(context);
        if (context.getHttpMethod() === "PATCH")
          lateAppliedJournal.recordPodQuotaApplied(
            {
              name: observedApplied.metadata.name,
              namespace: observedApplied.metadata.namespace,
              uid: observedApplied.metadata.uid,
              resourceVersion: observedApplied.metadata.resourceVersion,
            },
            observedApplied.spec,
          );
      };
      try {
        await assert.rejects(
          openCapacityPodQuota(
            runtime,
            lateAppliedJournal,
            authority,
            fundingFence,
            prepared,
          ),
        );
        assert.equal(
          nativeMutations.length,
          beforeLateAppliedDispatch,
          "an applied latch arriving during SDK authentication prevents the stale opening intent from dispatching",
        );
        assert.equal(
          lateAppliedJournal.snapshot().podQuotaGate.phase,
          "applied",
        );
      } finally {
        clientConfig.applySecurityAuthentication = originalAuthentication;
        lateAppliedJournal.close();
      }
      const beforeQuotaPatch = nativeMutations.length;
      assert.equal(
        await openCapacityPodQuota(
          runtime,
          admissionJournal,
          authority,
          fundingFence,
          prepared,
        ),
        false,
        "a committed patch with stale quota-controller status remains pending",
      );
      const opening = admissionJournal.snapshot().podQuotaGate;
      assert.equal(opening.phase, "applied");
      const recoveredCustody = CapacityJournal.openExisting(
        join(directory, claim.operationId + ".sqlite"),
      );
      try {
        assert.deepEqual(recoveredCustody.snapshot().podQuotaGate, opening);
      } finally {
        recoveredCustody.close();
      }
      const effectiveQuota = resources.get(
        key("ResourceQuota", snapshot.plan.namespace, "database-resources"),
      );
      save(oldQuota);
      await assert.rejects(
        openCapacityPodQuota(
          runtime,
          admissionJournal,
          authority,
          fundingFence,
          prepared,
        ),
        "an applied-but-not-yet-effective gate closed by another operation cannot be reopened",
      );
      assert.equal(nativeMutations.length, beforeQuotaPatch + 1);
      save({
        ...effectiveQuota,
        status: { hard: effectiveQuota.spec.hard, used: { pods: "0" } },
      });
      assert.equal(
        await openCapacityPodQuota(
          runtime,
          admissionJournal,
          authority,
          fundingFence,
          prepared,
        ),
        true,
      );
      assert.equal(
        nativeMutations.length,
        beforeQuotaPatch + 1,
        "the lost committed opening is recovered without repeating its mutation",
      );
      assert.equal(admissionJournal.snapshot().podQuotaGate.phase, "open");
      const admitted = await capacityAdmission(
        review,
        "mutate",
        admissionContext,
      );
      assert.equal(
        admitted.allowed,
        true,
        "only the original fully bound and funded workload enters protected admission",
      );
      assert.equal(admitted.uid, review.request.uid);
      assert.equal(admitted.patchType, "JSONPatch");
      const patches = JSON.parse(
        Buffer.from(admitted.patch, "base64").toString(),
      );
      const secured = structuredClone(pod);
      for (const edit of patches) {
        const path = edit.path
          .slice(1)
          .split("/")
          .map((v) => v.replaceAll("~1", "/").replaceAll("~0", "~"));
        let t = secured;
        for (const key of path.slice(0, -1)) t = t[key];
        t[path.at(-1)] = edit.value;
      }
      assert.equal(secured.spec.schedulerName, "koord-scheduler");
      const reservationOwner = resources.get(
        key("Reservation", "", original[0].reservation.name),
      ).spec.owners[0];
      // Koordinator combines ObjectReference and label selectors within one
      // owner. Check the emitted recipe against that upstream contract.
      const selectedByReservation = (candidate) =>
        reservationOwner.object?.namespace === candidate.metadata.namespace &&
        Object.entries(reservationOwner.labelSelector.matchLabels).every(
          ([name, value]) => candidate.metadata.labels?.[name] === value,
        );
      assert.equal(
        selectedByReservation(secured),
        true,
        "the protected Pod must actually match the native reservation's namespace and labels",
      );
      assert.equal(
        selectedByReservation({
          ...secured,
          metadata: { ...secured.metadata, namespace: "foreign-project" },
        }),
        false,
        "copying all protected labels in another namespace cannot consume the original reservation",
      );
      assert.equal(
        JSON.parse(
          secured.metadata.annotations[
            "scheduling.koordinator.sh/reservation-affinity"
          ],
        ).name,
        original[0].reservation.name,
      );
      const validated = await capacityAdmission(
        {
          ...review,
          request: {
            ...review.request,
            uid: "aaaaaaaa-aaaa-4aaa-8aaa-333333333334",
            object: secured,
          },
        },
        "validate",
        admissionContext,
      );
      assert.equal(validated.allowed, true);
      const bypassPod = {
        ...secured,
        metadata: {
          ...secured.metadata,
          labels: {
            ...secured.metadata.labels,
            "scheduling.koordinator.sh/reservation-ignored": "true",
          },
        },
      };
      assert.equal(
        (
          await capacityAdmission(
            { ...review, request: { ...review.request, object: bypassPod } },
            "validate",
            admissionContext,
          )
        ).allowed,
        false,
        "later mutation cannot inject Koordinator bypass labels",
      );
      const committed = save({
        ...secured,
        metadata: {
          ...secured.metadata,
          uid: "aaaaaaaa-aaaa-4aaa-8aaa-333333333335",
        },
        status: { phase: "Pending" },
      });
      const allocated = {
        ...committed,
        metadata: {
          ...committed.metadata,
          annotations: {
            ...committed.metadata.annotations,
            "scheduling.koordinator.sh/reservation-allocated": JSON.stringify({
              name: original[0].reservation.name,
              uid: original[0].reservation.uid,
            }),
          },
        },
      };
      const prebind = {
        ...review,
        request: {
          ...review.request,
          uid: "aaaaaaaa-aaaa-4aaa-8aaa-333333333336",
          operation: "UPDATE",
          name: committed.metadata.name,
          userInfo: { username: config.admission.schedulerUsername },
          oldObject: committed,
          object: allocated,
        },
      };
      assert.equal(
        (await capacityAdmission(prebind, "validate", admissionContext))
          .allowed,
        true,
      );
      save(allocated);
      const binding = {
        apiVersion: "v1",
        kind: "Binding",
        metadata: {
          name: committed.metadata.name,
          namespace: snapshot.plan.namespace,
          uid: committed.metadata.uid,
        },
        target: { kind: "Node", name: "node-a" },
      };
      const bindReview = {
        ...review,
        request: {
          ...review.request,
          uid: "aaaaaaaa-aaaa-4aaa-8aaa-333333333337",
          kind: { group: "", version: "v1", kind: "Binding" },
          resource: { group: "", version: "v1", resource: "pods" },
          subResource: "binding",
          object: binding,
          userInfo: { username: config.admission.schedulerUsername },
        },
      };
      assert.equal(
        (await capacityAdmission(bindReview, "validate", admissionContext))
          .allowed,
        true,
      );
      assert.equal(
        admissionJournal.snapshot().slots[0].consumers[0].uid,
        committed.metadata.uid,
      );
      // Known public test-only mutual-TLS material; no installation key enters
      // the fixture. The same workload now crosses the actual HTTPS boundary.
      const certificate = readFileSync(
        new URL("./fixtures/node-observer-tls/cert.pem", import.meta.url),
      );
      const privateKey = readFileSync(
        new URL("./fixtures/node-observer-tls/key.pem", import.meta.url),
      );
      const certificateFile = join(directory, "admission-cert.pem"),
        privateKeyFile = join(directory, "admission-key.pem"),
        clientCaFile = join(directory, "admission-ca.pem");
      for (const [path, bytes] of [
        [certificateFile, certificate],
        [privateKeyFile, privateKey],
        [clientCaFile, certificate],
      ])
        writeFileSync(path, bytes, { mode: 0o600 });
      const admissionServer = await startCapacityAdmissionServer({
        address: "127.0.0.1",
        port: 0,
        certificateFile,
        privateKeyFile,
        clientCaFile,
        apiServerFingerprint256: new X509Certificate(certificate)
          .fingerprint256,
        context: async (namespace) =>
          namespace === snapshot.plan.namespace ? admissionContext : null,
      });
      const throughHttps = async (
        port = admissionServer.port,
        withClient = true,
      ) =>
        new Promise((resolve, reject) => {
          const request = httpsRequest(
            {
              hostname: "127.0.0.1",
              port,
              path: "/validate",
              method: "POST",
              key: withClient ? privateKey : undefined,
              cert: withClient ? certificate : undefined,
              ca: certificate,
              rejectUnauthorized: true,
              headers: { "content-type": "application/json" },
            },
            (response) => {
              let body = "";
              response.on("data", (c) => {
                body += c;
              });
              response.on("end", () =>
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(body),
                }),
              );
            },
          );
          request.on("error", reject);
          request.end(JSON.stringify(bindReview));
        });
      try {
        const response = await throughHttps();
        assert.equal(
          response.status,
          200,
          "authenticated API-server traffic reaches the admission handler",
        );
        assert.equal(response.body.response.allowed, true);
        assert.equal(response.body.response.uid, bindReview.request.uid);
        await assert.rejects(
          throughHttps(admissionServer.port, false),
          "client certificates are required before request processing",
        );
      } finally {
        await admissionServer.close();
      }
      const wrongPeerServer = await startCapacityAdmissionServer({
        address: "127.0.0.1",
        port: 0,
        certificateFile,
        privateKeyFile,
        clientCaFile,
        apiServerFingerprint256: "00".repeat(32),
        context: async () => {
          throw new Error("untrusted peer must not select custody");
        },
      });
      try {
        const refused = await throughHttps(wrongPeerServer.port);
        assert.equal(
          refused.status,
          403,
          "a trusted CA alone cannot select the pinned API-server identity",
        );
      } finally {
        await wrongPeerServer.close();
      }
      const slowContextServer = await startCapacityAdmissionServer({
        address: "127.0.0.1",
        port: 0,
        certificateFile,
        privateKeyFile,
        clientCaFile,
        apiServerFingerprint256: new X509Certificate(certificate)
          .fingerprint256,
        requestDeadlineMilliseconds: 50,
        context: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return admissionContext;
        },
      });
      try {
        const expired = await throughHttps(slowContextServer.port);
        assert.equal(
          expired.status,
          503,
          "the admission deadline includes asynchronous context lookup",
        );
      } finally {
        await slowContextServer.close();
      }

      const originalReservationState = structuredClone(
        resources.get(key("Reservation", "", original[0].reservation.name)),
      );
      save({
        ...originalReservationState,
        status: { ...originalReservationState.status, phase: "Failed" },
      });
      try {
        assert.equal(
          (await capacityAdmission(bindReview, "validate", admissionContext))
            .allowed,
          false,
          "failed native reservations never authorize placement despite matching annotations",
        );
      } finally {
        save(originalReservationState);
      }
      assert.equal(
        (
          await capacityAdmission(
            {
              ...bindReview,
              request: {
                ...bindReview.request,
                userInfo: { username: "untrusted-user" },
              },
            },
            "validate",
            admissionContext,
          )
        ).allowed,
        false,
      );
      assert.equal(
        (
          await capacityAdmission(
            {
              ...bindReview,
              request: {
                ...bindReview.request,
                object: {
                  ...binding,
                  target: { kind: "Node", name: "foreign-node" },
                },
              },
            },
            "validate",
            admissionContext,
          )
        ).allowed,
        false,
      );
      const effectsBeforeBoundRecovery =
        nativeMutations.length + capacityEffects.length;
      const awaitingBinding = await acquireCapacity(
        runtime,
        { ...claim, leaseEpoch: 2 },
        config,
        () => {},
      );
      awaitingBinding?.close();
      assert.equal(
        awaitingBinding,
        null,
        "durable Binding approval without the actual bound Pod remains pending after restart",
      );
      const boundPod = save({
        ...allocated,
        spec: { ...allocated.spec, nodeName: "node-a" },
        status: { phase: "Running" },
      });
      const awaitingProjection = await acquireCapacity(
        runtime,
        { ...claim, leaseEpoch: 2 },
        config,
        () => {},
      );
      awaitingProjection?.close();
      assert.equal(
        awaitingProjection,
        null,
        "delayed reservation owners cannot turn a recorded live consumer into a fresh empty hold",
      );
      const occupiedReservation = save({
        ...originalReservationState,
        status: {
          ...originalReservationState.status,
          currentOwners: [
            {
              namespace: snapshot.plan.namespace,
              name: boundPod.metadata.name,
              uid: boundPod.metadata.uid,
            },
          ],
          allocated: boundPod.spec.containers[0].resources.requests,
        },
      });
      const occupiedRecovery = await acquireCapacity(
        runtime,
        { ...claim, leaseEpoch: 2 },
        config,
        () => {},
      );
      assert.ok(
        occupiedRecovery,
        "the same original occupied reservation and exact bound Pod can be recovered",
      );
      try {
        assert.deepEqual(
          occupiedRecovery.snapshot().slots.map((slot) => slot.storage),
          admissionJournal.snapshot().slots.map((slot) => slot.storage),
        );
        assert.equal(
          occupiedRecovery.snapshot().slots[0].consumers[0].uid,
          boundPod.metadata.uid,
        );
        await occupiedRecovery.beforeCluster();
        const recoveredApi = occupiedRecovery.wrap(
          {
            read: runtime.read.bind(runtime),
            create: async () => {
              throw new Error("recovery_must_not_create");
            },
            readSecret: async () => ({}),
            listPods: async (namespace) => runtime.list("Pod", namespace),
          },
          () => {},
        );
        assert.equal(
          (
            await recoveredApi.read(
              "Cluster",
              snapshot.plan.namespace,
              "database",
            )
          ).metadata.uid,
          clusterUid,
          "confirmed-open recovery revalidates the original Cluster instead of requiring initial zero-Pod state",
        );
        const pooledApi = occupiedRecovery.wrap(
          {
            ...recoveredApi,
            create: async (resource, dispatch) => {
              dispatch.check();
              return save(resource);
            },
          },
          () => assert.ok(funded),
        );
        const pooled = await pooledApi.create({
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Pooler",
          metadata: {
            name: "database-pool-rw",
            namespace: snapshot.plan.namespace,
            labels: ownerLabels,
            annotations: ownerAnnotations,
            ownerReferences: [
              {
                apiVersion: "postgresql.cnpg.io/v1",
                kind: "Cluster",
                name: "database",
                uid: clusterUid,
                controller: true,
              },
            ],
          },
          spec: {
            cluster: { name: "database" },
            instances: 1,
            deploymentStrategy: { type: "Recreate" },
            pgbouncer: { image: spec.profile.pooling.image },
          },
        });
        assert.equal(
          occupiedRecovery.snapshot().poolerUid,
          pooled.metadata.uid,
          "an owned Pooler is materialized and sealed only behind confirmed-open capacity",
        );
      } finally {
        occupiedRecovery.close();
      }
      assert.equal(
        nativeMutations.length + capacityEffects.length,
        effectsBeforeBoundRecovery,
        "occupied recovery neither reallocates capacity nor mutates original storage",
      );
      save({
        ...occupiedReservation,
        status: {
          ...occupiedReservation.status,
          currentOwners: [
            {
              namespace: snapshot.plan.namespace,
              name: boundPod.metadata.name,
              uid: "aaaaaaaa-aaaa-4aaa-8aaa-999999999999",
            },
          ],
        },
      });
      await assert.rejects(
        acquireCapacity(runtime, { ...claim, leaseEpoch: 2 }, config, () => {}),
        "a foreign/replaced owner UID cannot reuse the original slot",
      );
      save(occupiedReservation);
    } finally {
      admissionJournal.close();
    }
    const now = Date.now(),
      units = provisioningAllowanceUnits(
        { ...spec.profile, volumeGiB: spec.volumeGiB },
        300,
      );
    const funding = {
      version: 1,
      envelopeVersion: 1,
      operationId: claim.operationId,
      organizationId: "77777777-7777-4777-8777-777777777779",
      projectId: "77777777-7777-4777-8777-777777777778",
      environmentId: claim.environmentId,
      regionId: claim.regionId,
      specRevision: 1,
      specHash: claim.specHash,
      runEpoch: claim.runEpoch,
      fundingSeconds: 300,
      units,
      rates: provisioningResourceEnvelope({
        ...spec.profile,
        volumeGiB: spec.volumeGiB,
      }).rates,
      reservation: {
        id: "66666666-6666-4666-8666-666666666666",
        environmentId: claim.environmentId,
        regionId: claim.regionId,
        specRevision: 1,
        specHash: claim.specHash,
        epoch: "0",
        revision: "0",
        units,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300000).toISOString(),
        status: "issued",
        gapCount: "0",
        stoppedAt: null,
        fenceToken: `cprsv_${"x".repeat(43)}`,
        runtimeEnforced: false,
        enforcementStatus: "pending_runtime",
      },
    };
    // The regional issuer transport preserves the existing initial PostgreSQL
    // contract and carries cancellation without any customer-container token.
    const previousFetch = globalThis.fetch;
    const nonce = Buffer.alloc(32, 7).toString("base64url");
    const challenge = {
      version: 2,
      nonce,
      binding: {
        installationId: config.installationId,
        namespaceUid: recoveredNamespace.metadata.uid,
        podUid: "aaaaaaaa-aaaa-4aaa-8aaa-333333333335",
        containerName: "postgres",
        nodeName: "node-a",
        nodeUid,
        bootId,
        imageHash: spec.profile.postgresImage.split("@sha256:")[1],
        commandHash: "d".repeat(64),
      },
    };
    const permit = {
      version: 2,
      keyId: "fixture-key",
      payload: Buffer.from("fixture-payload").toString("base64url"),
      signature: Buffer.alloc(64, 9).toString("base64url"),
    };
    let permitCalls = 0;
    const permitAbort = new AbortController();
    globalThis.fetch = async (url, request) => {
      permitCalls++;
      assert.equal(
        url,
        `https://control.invalid/v1/regions/${claim.regionId}/operations/${claim.operationId}/execution-permits`,
      );
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "error");
      assert.equal(
        request.headers.Authorization,
        "Bearer fixture-region-token",
      );
      assert.deepEqual(JSON.parse(request.body), {
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        reservationId: "66666666-6666-4666-8666-666666666666",
        challenge,
      });
      assert.ok(request.signal instanceof AbortSignal);
      assert.equal(request.signal.aborted, false);
      return Response.json({
        permit,
        runtimeEnforced: false,
        enforcementStatus: "pending_runtime",
      });
    };
    try {
      const issuer = new ControlClient(
        "https://control.invalid",
        claim.regionId,
        "fixture-region-token",
      );
      assert.deepEqual(
        await issuer.executionPermit(
          claim,
          "66666666-6666-4666-8666-666666666666",
          challenge,
          permitAbort.signal,
        ),
        {
          permit,
          runtimeEnforced: false,
          enforcementStatus: "pending_runtime",
        },
      );
      assert.equal(
        permitCalls,
        1,
        "a finite startup request is sent once with its actual private operation lease",
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
    const manifestCustody = CapacityJournal.openExisting(
      join(directory, claim.operationId + ".sqlite"),
    );
    const commandVector = JSON.parse(
      readFileSync(
        new URL(
          "../../execution-guard/testdata/signed-window-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    try {
      const expected = await preparePostgresExpectedManifest({
        claim,
        funding,
        journal: manifestCustody,
        runtime,
        podUid: challenge.binding.podUid,
        recipe: {
          image: spec.profile.postgresImage,
          command: commandVector.command,
          guard: {
            executable: "/execution-guard",
            image: spec.profile.postgresImage,
          },
        },
        authority: { check: () => {}, expiresAt: () => Date.now() + 10000 },
      });
      assert.equal(expected.version, 2);
      assert.deepEqual(expected.command, commandVector.command);
      assert.equal(
        expected.binding.commandHash,
        commandVector.commandHash,
        "prepared argv uses the unchanged guard's independently published command framing",
      );
      assert.equal(
        expected.binding.namespaceUid,
        recoveredNamespace.metadata.uid,
      );
      assert.equal(expected.binding.podUid, challenge.binding.podUid);
      assert.equal(expected.binding.nodeUid, nodeUid);
      assert.equal(expected.binding.bootId, bootId);
      assert.equal(expected.binding.reservationId, funding.reservation.id);
      assert.equal(expected.binding.projectId, funding.projectId);
    } finally {
      manifestCustody.close();
    }
    // Loss of an already sealed reservation is missing custody, not permission
    // to create a replacement and discover the UID mismatch afterward.
    // A funding grant does not authorize the default runner to bypass physical
    // capacity when its installation lane is absent.
    const fundingDirectory = join(directory, "runner-funding");
    mkdirSync(fundingDirectory, { mode: 0o700 });
    const shutdown = new AbortController();
    const beforeUnconfiguredRunner = effects.length;
    let runnerClaimed = false;
    await runController(
      {
        read: async () => null,
        create: async (resource) => {
          effects.push(resource.kind);
          throw new Error("must_not_create_without_capacity");
        },
        readSecret: async () => {
          throw new Error("must_not_read_without_capacity");
        },
        listPods: async () => [],
      },
      {
        claim: async () => {
          if (runnerClaimed) return null;
          runnerClaimed = true;
          return claim;
        },
        renew: async () => {
          throw new Error("must_not_renew");
        },
        funding: async () => funding,
        authority: async (id) => ({
          schemaVersion: 1,
          reservationId: id,
          environmentId: claim.environmentId,
          regionId: claim.regionId,
          projectId: funding.projectId,
          specRevision: 1,
          specHash: claim.specHash,
          epoch: "0",
          decision: "allow",
          reason: "authorized",
          observedAt: new Date(now).toISOString(),
          validUntil: new Date(now + 15000).toISOString(),
          units,
          limitedMetrics: [],
          bindings: [],
          evidenceHash: "b".repeat(64),
          runtimeEnforced: false,
          enforcementStatus: "pending_runtime",
        }),
        result: async () => {
          throw new Error("must_not_publish_without_capacity");
        },
      },
      {
        operatorNamespace: "cnpg-system",
        operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
        allowedBackupSecrets: [spec.profile.backup.credentialSecret],
      },
      {
        leaseSeconds: 90,
        pollMilliseconds: 1,
        readinessMilliseconds: 30000,
        provisioningJournalDirectory: fundingDirectory,
        signal: shutdown.signal,
        log: (event) => {
          if (["operation_deferred", "readiness_deferred"].includes(event))
            shutdown.abort();
        },
      },
    );
    assert.equal(
      effects.length,
      beforeUnconfiguredRunner,
      "the real default controller cannot materialize any customer resource without its capacity lane",
    );
    const runnerCapacityDirectory = join(directory, "runner-capacity");
    mkdirSync(runnerCapacityDirectory, { mode: 0o700 });
    let earlyFundingRequests = 0;
    async function failFundingWithLane(leaseEpoch) {
      const stopped = new AbortController();
      let requested = false;
      await runController(
        {
          read: async () => {
            throw new Error("no_provider_before_funding");
          },
          create: async () => {
            throw new Error("no_provider_before_funding");
          },
          readSecret: async () => {
            throw new Error("no_provider_before_funding");
          },
          listPods: async () => [],
        },
        {
          claim: async () => {
            if (requested) return null;
            requested = true;
            return { ...claim, leaseEpoch };
          },
          renew: async () => {
            throw new Error("must_not_renew");
          },
          funding: async () => {
            earlyFundingRequests++;
            throw new Error("funding_transport_unavailable");
          },
          authority: async () => {
            throw new Error("must_not_check_authority");
          },
          result: async () => {
            throw new Error("must_not_publish");
          },
        },
        {
          operatorNamespace: "cnpg-system",
          operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
          allowedBackupSecrets: [spec.profile.backup.credentialSecret],
        },
        {
          capacity: {
            configuration: {
              ...config,
              journalDirectory: runnerCapacityDirectory,
            },
            runtime: {
              read: async () => {
                throw new Error("no_provider_before_funding");
              },
              list: async () => {
                throw new Error("no_provider_before_funding");
              },
              create: async () => {
                throw new Error("no_provider_before_funding");
              },
              patch: async () => {
                throw new Error("no_provider_before_funding");
              },
              remove: async () => {
                throw new Error("no_provider_before_funding");
              },
            },
            execution: null,
          },
          provisioningJournalDirectory: fundingDirectory,
          leaseSeconds: 90,
          pollMilliseconds: 1,
          readinessMilliseconds: 30000,
          signal: stopped.signal,
          log: (event) => {
            if (["operation_deferred", "readiness_deferred"].includes(event))
              stopped.abort();
          },
        },
      );
    }
    await failFundingWithLane(1);
    const beforeFundingCustody = CapacityJournal.openExisting(
      join(runnerCapacityDirectory, claim.operationId + ".sqlite"),
    );
    try {
      assert.equal(beforeFundingCustody.snapshot().phase, "pending");
      assert.ok(
        beforeFundingCustody
          .snapshot()
          .slots.every((slot) => slot.reservation === null),
      );
    } finally {
      beforeFundingCustody.close();
    }
    await failFundingWithLane(2);
    assert.equal(
      earlyFundingRequests,
      2,
      "capacity intent predates failed funding transport and the next real lease recovers it without inventing custody",
    );
    const originalReservation = original[0].reservation;
    resources.delete(key("Reservation", "", originalReservation.name));
    const dispatchedBeforeLoss = capacityEffects.length;
    await assert.rejects(
      acquireCapacity(runtime, { ...claim, leaseEpoch: 2 }, config, () => {}),
    );
    assert.equal(
      capacityEffects.length,
      dispatchedBeforeLoss,
      "missing original custody refuses before any replacement dispatch",
    );
  },
);
