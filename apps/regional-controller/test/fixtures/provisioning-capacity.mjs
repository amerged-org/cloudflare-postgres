// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { seedCapacityInstallation } from "./capacity-installation.mjs";
import { CapacityJournal } from "../../src/capacity-journal.ts";
import { capacityAdmission } from "../../src/capacity-admission.ts";
import {
  ProvisioningFundingJournal,
  ProvisioningFundingBarrier,
} from "../../src/provisioning-funding.ts";
import { effectiveCapacityResources } from "../../src/capacity-pod-resources.ts";

// Dependency fixture only: native-shaped controller progress, not a live
// protection/compatibility claim. Product acquisition/handoff/admission run intact.
export function provisioningCapacityFixture(
  directory,
  originalClaim,
  resources,
) {
  const capacityDirectory = join(directory, "capacity");
  mkdirSync(capacityDirectory, { mode: 0o700 });
  const nodeUid = "88888888-8888-4888-8888-888888888888";
  const bootId = "99999999-9999-4999-8999-999999999999";
  const marginUid = "00000000-0000-4000-8000-000000000001";
  let revision = 1;
  let claim = originalClaim,
    transport,
    materializing = false,
    listedReady = false;
  const key = (kind, namespace, name) => `${kind}:${namespace}:${name}`;
  const id = (text) => {
    const h = createHash("sha256").update(text).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const save = (resource) => {
    const r = structuredClone(resource);
    r.metadata.uid ??= id(
      key(r.kind, r.metadata.namespace ?? "", r.metadata.name),
    );
    r.metadata.resourceVersion = String(revision++);
    resources.set(key(r.kind, r.metadata.namespace ?? "", r.metadata.name), r);
    return structuredClone(r);
  };
  const config = {
    version: 1,
    installationId: "funding-fixture",
    namespace: "pgcf-system",
    journalDirectory: capacityDirectory,
    schedulerName: "koord-scheduler",
    holdStorageClassPrefix: "pgcf-capacity",
    allowedNodes: [{ name: "node-a", uid: nodeUid }],
    storageNamespace: "openebs",
    platformReservations: [
      { nodeName: "node-a", nodeUid, name: "platform-margin", uid: marginUid },
    ],
    platformMargin: { cpuMilli: 100, memoryMiB: 128, podSlots: 1 },
    admission: {
      apiServerIdentity: "fixture-apiserver",
      jobUsername: "system:serviceaccount:kube-system:job-controller",
      replicaSetUsername:
        "system:serviceaccount:kube-system:replicaset-controller",
      approvedImages: [originalClaim.spec.profile.postgresImage],
      mutatingConfiguration: "pgcf-capacity-mutate",
      validatingConfiguration: "pgcf-capacity-validate",
      serviceNamespace: "pgcf-system",
      serviceName: "capacity-admission",
      operatorUsername: "system:serviceaccount:pgcf-system:regional-controller",
      schedulerUsername:
        "system:serviceaccount:koordinator-system:koord-scheduler",
      cnpgUsername: "system:serviceaccount:cnpg-system:cnpg-controller-manager",
    },
    schedulerDeployment: {
      namespace: "koordinator-system",
      name: "koord-scheduler",
      image: `registry.invalid/koord@sha256:${"b".repeat(64)}`,
    },
  };
  seedCapacityInstallation({ save, nodeUid, bootId, marginUid, config });
  const namespace = "pgcf-" + claim.environmentId.replaceAll("-", "");
  const raw = (kind, ns, name) =>
    structuredClone(resources.get(key(kind, ns, name)) ?? null);
  const check = () => {
    assert.ok(Date.now() < Date.parse(claim.leaseExpiresAt) - 5000);
    assert.equal(raw("Node", "", "node-a").metadata.uid, nodeUid);
    assert.equal(raw("Node", "", "node-a").status.nodeInfo.bootID, bootId);
  };
  const execution = {
    check,
    expiresAt: () =>
      Math.min(Date.parse(claim.leaseExpiresAt) - 5000, Date.now() + 10000),
    async refresh(state) {
      check();
      assert.equal(state.plan.binding.specHash, claim.specHash);
      assert.equal(state.plan.binding.runEpoch, "1");
      assert.equal(
        raw("Namespace", "", namespace).metadata.uid,
        state.namespaceUid,
      );
      assert.equal(
        raw("Cluster", namespace, "database").metadata.uid,
        state.clusterUid,
      );
      assert.equal(
        raw("ResourceQuota", namespace, "database-resources").metadata.uid,
        state.quotaUid,
      );
      assert.equal(state.slots[0].handoffPhase, "rebound");
      for (const slot of state.slots)
        assert.equal(
          raw("Reservation", "", slot.reservation.name).metadata.uid,
          slot.reservation.uid,
        );
    },
  };
  function bindClaims() {
    for (const pv of resources.values()) {
      if (pv.kind !== "PersistentVolume") continue;
      const ref = pv.spec.claimRef;
      const target =
        ref &&
        resources.get(key("PersistentVolumeClaim", ref.namespace, ref.name));
      if (
        target?.metadata.uid === ref.uid &&
        target.spec.volumeName === pv.metadata.name &&
        target.spec.storageClassName === pv.spec.storageClassName
      ) {
        save({ ...target, status: { phase: "Bound" } });
        save({ ...pv, status: { phase: "Bound" } });
      }
    }
  }
  const runtime = {
    async read(kind, ns, name) {
      if (kind === "Cluster" && !materializing) await advanceWorkload();
      return raw(kind, ns, name);
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
    async create(resource, dispatch) {
      assert.ok(dispatch);
      dispatch.check();
      assert.ok(dispatch.expiresAt() > Date.now());
      assert.equal(
        raw(
          resource.kind,
          resource.metadata.namespace ?? "",
          resource.metadata.name,
        ),
        null,
      );
      let r = save(resource);
      if (r.kind === "Reservation") {
        r = save({
          ...r,
          status: {
            phase: "Available",
            nodeName: "node-a",
            allocatable: r.spec.template.spec.containers[0].resources.requests,
            conditions: [
              { type: "Ready", status: "True" },
              { type: "Scheduled", status: "True" },
            ],
          },
        });
      } else if (r.kind === "PersistentVolumeClaim") {
        const volume = "volume-" + r.metadata.uid;
        const pv = save({
          apiVersion: "v1",
          kind: "PersistentVolume",
          metadata: { name: volume },
          spec: {
            capacity: { storage: r.spec.resources.requests.storage },
            accessModes: ["ReadWriteOnce"],
            volumeMode: "Filesystem",
            storageClassName: r.spec.storageClassName,
            persistentVolumeReclaimPolicy: "Retain",
            claimRef: {
              apiVersion: "v1",
              kind: "PersistentVolumeClaim",
              name: r.metadata.name,
              namespace: r.metadata.namespace,
              uid: r.metadata.uid,
            },
            csi: {
              driver: "local.csi.openebs.io",
              volumeHandle: volume,
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
          apiVersion: "local.openebs.io/v1alpha1",
          kind: "LVMVolume",
          metadata: { name: volume, namespace: "openebs" },
          spec: {
            ownerNodeID: "node-a",
            volGroup: "pgcf",
            vgPattern: "^pgcf$",
            thinProvision: "no",
            capacity: pv.spec.capacity.storage,
          },
          status: { state: "Ready" },
        });
        r = save({
          ...r,
          spec: { ...r.spec, volumeName: pv.metadata.name },
          status: { phase: "Bound" },
        });
      }
      return r;
    },
    async patch(kind, ns, name, operations, dispatch) {
      assert.ok(dispatch);
      dispatch.check();
      assert.ok(dispatch.expiresAt() > Date.now());
      const current = raw(kind, ns, name);
      assert.ok(current);
      for (const op of operations) {
        const parts = op.path
          .slice(1)
          .split("/")
          .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
        let target = current;
        for (const part of parts.slice(0, -1)) target = target[part];
        const last = parts.at(-1);
        if (op.op === "test") assert.deepEqual(target[last], op.value);
        else if (op.op === "remove") delete target[last];
        else target[last] = structuredClone(op.value);
      }
      if (kind === "ResourceQuota")
        current.status = { hard: current.spec.hard, used: { pods: "0" } };
      save(current);
      bindClaims();
      return raw(kind, ns, name);
    },
    async remove(kind, ns, name, uid, resourceVersion, dispatch) {
      assert.ok(dispatch);
      dispatch.check();
      const current = raw(kind, ns, name);
      assert.equal(current.metadata.uid, uid);
      assert.equal(current.metadata.resourceVersion, resourceVersion);
      resources.delete(key(kind, ns, name));
      for (const pv of resources.values())
        if (pv.kind === "PersistentVolume" && pv.spec.claimRef?.uid === uid)
          save({ ...pv, status: { phase: "Released" } });
    },
  };
  async function advanceWorkload() {
    const cluster = raw("Cluster", namespace, "database");
    if (!cluster || raw("Pod", namespace, "database-1")) return;
    const custody = CapacityJournal.openExisting(
      join(capacityDirectory, claim.operationId + ".sqlite"),
    );
    let fundingJournal;
    try {
      if (custody.snapshot().podQuotaGate?.phase !== "open") return;
      materializing = true;
      fundingJournal = new ProvisioningFundingJournal(directory, claim);
      const funding = new ProvisioningFundingBarrier(
        fundingJournal,
        transport,
        check,
        () => Date.parse(claim.leaseExpiresAt) - 5000,
      );
      await funding.acquire(claim);
      const dispatch = funding.dispatchAuthority();
      const fence = {
        refresh: () => funding.refresh(),
        check: dispatch.check,
        expiresAt: dispatch.expiresAt,
      };
      const compute = claim.spec.profile.compute;
      let pod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "database-1",
          namespace,
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
              uid: cluster.metadata.uid,
              controller: true,
            },
          ],
        },
        spec: {
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
              image: claim.spec.profile.postgresImage,
              command: [
                "/execution-guard",
                "--mode",
                "signed-window",
                "--",
                "/controller/manager",
              ],
              resources: {
                requests: {
                  cpu: `${compute.cpuMilli + 25}m`,
                  memory: `${compute.memoryMiB + 64}Mi`,
                },
                limits: {
                  cpu: `${compute.cpuMilli + 100}m`,
                  memory: `${compute.memoryMiB + 128}Mi`,
                },
              },
            },
          ],
        },
      };
      const context = {
        claim,
        runtime,
        journal: custody,
        config,
        funding: fence,
        authority: { check, expiresAt: execution.expiresAt },
        transportAuthenticated: () => true,
        executionPrepared: (candidate) =>
          candidate.spec.containers.every(
            (c) =>
              c.image === claim.spec.profile.postgresImage &&
              c.command?.join(" ") === pod.spec.containers[0].command.join(" "),
          ),
        workloadVolumesPrepared: (candidate, _state, slot) =>
          candidate.spec.volumes.every(
            (v) => v.persistentVolumeClaim?.claimName === slot.targetPvc?.name,
          ),
      };
      const review = {
        apiVersion: "admission.k8s.io/v1",
        kind: "AdmissionReview",
        request: {
          uid: "aaaaaaaa-aaaa-4aaa-8aaa-111111111111",
          operation: "CREATE",
          kind: { group: "", version: "v1", kind: "Pod" },
          resource: { group: "", version: "v1", resource: "pods" },
          namespace,
          name: "database-1",
          userInfo: { username: config.admission.cnpgUsername },
          object: pod,
        },
      };
      const mutate = await capacityAdmission(review, "mutate", context);
      assert.equal(mutate.allowed, true);
      for (const op of JSON.parse(
        Buffer.from(mutate.patch, "base64").toString(),
      )) {
        const parts = op.path.slice(1).split("/");
        let target = pod;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = op.value;
      }
      assert.equal(
        (
          await capacityAdmission(
            { ...review, request: { ...review.request, object: pod } },
            "validate",
            context,
          )
        ).allowed,
        true,
      );
      pod = save(pod);
      const allocated = {
        ...pod,
        metadata: {
          ...pod.metadata,
          annotations: {
            ...pod.metadata.annotations,
            "scheduling.koordinator.sh/reservation-allocated": JSON.stringify({
              name: custody.snapshot().slots[0].reservation.name,
              uid: custody.snapshot().slots[0].reservation.uid,
            }),
          },
        },
      };
      assert.equal(
        (
          await capacityAdmission(
            {
              ...review,
              request: {
                ...review.request,
                operation: "UPDATE",
                oldObject: pod,
                object: allocated,
                userInfo: { username: config.admission.schedulerUsername },
              },
            },
            "validate",
            context,
          )
        ).allowed,
        true,
      );
      pod = save(allocated);
      assert.equal(
        (
          await capacityAdmission(
            {
              ...review,
              request: {
                ...review.request,
                kind: { group: "", version: "v1", kind: "Binding" },
                subResource: "binding",
                userInfo: { username: config.admission.schedulerUsername },
                object: {
                  apiVersion: "v1",
                  kind: "Binding",
                  metadata: {
                    name: pod.metadata.name,
                    namespace,
                    uid: pod.metadata.uid,
                  },
                  target: { kind: "Node", name: "node-a" },
                },
              },
            },
            "validate",
            context,
          )
        ).allowed,
        true,
      );
      pod = save({
        ...pod,
        spec: { ...pod.spec, nodeName: "node-a" },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
        },
      });
      const reserved = raw(
        "Reservation",
        "",
        custody.snapshot().slots[0].reservation.name,
      );
      const amounts = effectiveCapacityResources(pod, "requests");
      save({
        ...reserved,
        status: {
          ...reserved.status,
          currentOwners: [
            { namespace, name: pod.metadata.name, uid: pod.metadata.uid },
          ],
          allocated: { cpu: `${amounts[0]}m`, memory: String(amounts[1]) },
        },
      });
      save({
        ...cluster,
        status: {
          readyInstances: 1,
          currentPrimary: pod.metadata.name,
          conditions: [
            {
              type: "Ready",
              status: "True",
              observedGeneration: cluster.metadata.generation,
            },
          ],
        },
      });
    } finally {
      materializing = false;
      fundingJournal?.close();
      custody.close();
    }
  }
  return {
    resources,
    config,
    lane: { configuration: config, runtime, execution },
    save,
    setTransport(currentClaim, client) {
      claim = currentClaim;
      transport = client;
    },
    onCreate(value) {
      if (value.kind === "ResourceQuota")
        value = {
          ...value,
          status: { hard: value.spec.hard, used: { pods: "0" } },
        };
      value = save(value);
      if (value.kind === "Cluster") {
        save({
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: "database-1",
            namespace,
            labels: {
              "cnpg.io/cluster": "database",
              "cnpg.io/pvcRole": "PG_DATA",
            },
            annotations: {
              "cnpg.io/nodeSerial": "1",
              "cnpg.io/pvcStatus": "initializing",
            },
            ownerReferences: [
              {
                apiVersion: "postgresql.cnpg.io/v1",
                kind: "Cluster",
                name: "database",
                uid: value.metadata.uid,
                controller: true,
              },
            ],
          },
          spec: {
            storageClassName:
              originalClaim.spec.profile.storage.storageClassName,
            accessModes: ["ReadWriteOnce"],
            volumeMode: "Filesystem",
            resources: {
              requests: { storage: `${originalClaim.spec.volumeGiB}Gi` },
            },
          },
          status: { phase: "Pending" },
        });
      }
      return value;
    },
    completeReadback() {
      return listedReady;
    },
    async listPods() {
      await advanceWorkload();
      const pods = await runtime.list("Pod", namespace);
      listedReady = pods.some(
        (p) =>
          p.status?.phase === "Running" &&
          p.status.conditions.some(
            (c) => c.type === "Ready" && c.status === "True",
          ),
      );
      return pods;
    },
  };
}
