// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type {
  RuntimeBinding,
  RuntimeInventory,
  RuntimePatch,
} from "./allowance-types.ts";
import type {
  PodRetirementProof,
  PodRetirementRecord,
} from "./pod-retirement.ts";
import type { Resource } from "./types.ts";
import { canonicalCohort } from "./node-cohort.ts";
import { ownedInventory } from "./owned-stop.ts";
import { validRuntimeBinding } from "./allowance-journal.ts";

export interface PodRetirementPorts {
  owners(): Promise<RuntimeInventory>;
  readPod(name: string): Promise<Resource | null>;
  patchPod(name: string, operations: RuntimePatch[]): Promise<void>;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalCohort(value)).digest("hex");
const unknown = () => new Error("pod_retirement_effect_unknown");
function matches(
  pod: Resource,
  record: PodRetirementRecord,
  binding: RuntimeBinding,
): boolean {
  const owners = pod.metadata.ownerReferences;
  const owner = record.ownerChain[0];
  const version =
    owner?.kind === "Cluster"
      ? "postgresql.cnpg.io/v1"
      : owner?.kind === "Job"
        ? "batch/v1"
        : owner?.kind === "ReplicaSet"
          ? "apps/v1"
          : null;
  return (
    pod.kind === "Pod" &&
    pod.apiVersion === "v1" &&
    pod.metadata.uid === record.uid &&
    pod.metadata.name === record.name &&
    pod.metadata.namespace === binding.namespace &&
    pod.spec?.nodeName === record.nodeName &&
    digest(pod.spec) === record.specHash &&
    owners?.length === 1 &&
    owners[0]?.controller === true &&
    owners[0].apiVersion === version &&
    owners[0].uid === owner?.uid &&
    owners[0].name === owner.name &&
    owners[0].kind === owner.kind
  );
}
function stopBarriers(
  inventory: RuntimeInventory,
  binding: RuntimeBinding,
): boolean {
  return (
    (inventory.quota.spec?.hard as Record<string, unknown> | undefined)
      ?.pods === "0" &&
    inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] === "on" &&
    (!binding.pooler ||
      (inventory.poolers?.length === 1 &&
        inventory.poolers[0]?.spec?.instances === 0 &&
        inventory.deployments?.length === 1 &&
        inventory.deployments[0]?.spec?.replicas === 0))
  );
}
function freshTerminalMatches(
  pod: Resource,
  proof: PodRetirementProof,
): boolean {
  try {
    const expected = proof.terminal as {
      deletionTimestamp?: unknown;
      phase?: unknown;
      containers?: unknown;
    };
    if (
      expected.phase !== pod.status?.phase ||
      typeof expected.deletionTimestamp !== "string" ||
      typeof pod.metadata.deletionTimestamp !== "string" ||
      new Date(expected.deletionTimestamp).toISOString() !==
        new Date(pod.metadata.deletionTimestamp).toISOString() ||
      !Array.isArray(expected.containers)
    )
      return false;
    const fields = [
      ...(pod.status?.containerStatuses ?? []),
      ...(pod.status?.initContainerStatuses ?? []),
    ];
    if (
      fields.length !== expected.containers.length ||
      new Set(fields.map((value) => value.name)).size !== fields.length
    )
      return false;
    const current = fields
      .map((value) => {
        const state = value.state as Record<string, unknown> | undefined,
          terminated = state?.terminated as
            | {
                exitCode?: unknown;
                containerID?: unknown;
                startedAt?: unknown;
                finishedAt?: unknown;
              }
            | undefined;
        if (
          !state ||
          Object.keys(state).filter((key) => state[key] !== undefined)
            .length !== 1 ||
          !terminated ||
          !Number.isSafeInteger(terminated.exitCode) ||
          typeof value.containerID !== "string" ||
          !Number.isSafeInteger(value.restartCount) ||
          (terminated.containerID !== undefined &&
            terminated.containerID !== value.containerID) ||
          typeof terminated.startedAt !== "string" ||
          typeof terminated.finishedAt !== "string"
        )
          throw unknown();
        return {
          name: value.name,
          restartCount: value.restartCount,
          containerId: value.containerID,
          exitCode: terminated.exitCode,
          startedAt: new Date(terminated.startedAt).toISOString(),
          finishedAt: new Date(terminated.finishedAt).toISOString(),
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const sealed = [...expected.containers].sort((a, b) =>
      String((a as { name?: unknown }).name) <
      String((b as { name?: unknown }).name)
        ? -1
        : 1,
    );
    return canonicalCohort(current) === canonicalCohort(sealed);
  } catch {
    return false;
  }
}
export function podRetirementAdapter(
  supplied: RuntimeBinding,
  operationId: string,
  ports: PodRetirementPorts,
  authorized: () => void,
): {
  retainPod(record: PodRetirementRecord, finalizer: string): Promise<void>;
  releasePod(
    record: PodRetirementRecord,
    finalizer: string,
    proof: PodRetirementProof,
  ): Promise<void>;
} {
  if (
    !validRuntimeBinding(supplied) ||
    !supplied.runEpoch ||
    !supplied.nodeCohort ||
    !uuid.test(operationId)
  )
    throw unknown();
  const binding = JSON.parse(JSON.stringify(supplied)) as RuntimeBinding;
  const expected = `pgcf.io/retire-${operationId}`;
  const owners = async () => {
    authorized();
    const current = await ports.owners();
    authorized();
    if (!ownedInventory(current, binding)) throw unknown();
    return current;
  };
  const read = async (record: PodRetirementRecord) => {
    authorized();
    const pod = await ports.readPod(record.name);
    authorized();
    if (pod && !matches(pod, record, binding)) throw unknown();
    if (
      pod?.metadata.finalizers?.some(
        (value) => value.startsWith("pgcf.io/retire-") && value !== expected,
      )
    )
      throw unknown();
    return pod;
  };
  const edit = async (pod: Resource, values: string[]) => {
    if (!pod.metadata.resourceVersion) throw unknown();
    const current = pod.metadata.finalizers;
    const operations: RuntimePatch[] = [
      { op: "test", path: "/metadata/uid", value: pod.metadata.uid },
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: pod.metadata.resourceVersion,
      },
      ...(current
        ? [
            {
              op: "test" as const,
              path: "/metadata/finalizers",
              value: current,
            },
          ]
        : []),
      {
        op: current ? "replace" : "add",
        path: "/metadata/finalizers",
        value: values,
      },
    ];
    authorized();
    await ports.patchPod(pod.metadata.name, operations);
    authorized();
  };
  return {
    async retainPod(record, finalizer) {
      try {
        if (finalizer !== expected) throw unknown();
        await owners();
        const pod = await read(record);
        if (!pod || pod.metadata.deletionTimestamp) throw unknown();
        if (pod.metadata.finalizers?.includes(expected)) return;
        try {
          await edit(pod, [...(pod.metadata.finalizers ?? []), expected]);
        } catch {
          /* Resolve exactly this uncertain edit by scoped readback. */
        }
        await owners();
        const observed = await read(record);
        if (
          !observed?.metadata.finalizers?.includes(expected) ||
          observed.metadata.deletionTimestamp
        )
          throw unknown();
      } catch {
        throw unknown();
      }
    },
    async releasePod(record, finalizer, proof) {
      try {
        if (
          finalizer !== expected ||
          proof?.podUid !== record.uid ||
          canonicalCohort(proof.record) !== canonicalCohort(record)
        )
          throw unknown();
        const body = proof as unknown as Record<string, unknown>,
          sealed = body.binding as Record<string, unknown> | undefined;
        const { evidenceHash, ...preimage } = body;
        if (
          evidenceHash !== digest(preimage) ||
          !sealed ||
          sealed.operationId !== operationId ||
          [
            "regionId",
            "environmentId",
            "projectId",
            "specRevision",
            "specHash",
            "namespace",
            "namespaceUid",
            "clusterUid",
            "quotaUid",
            "runEpoch",
          ].some(
            (key) => sealed[key] !== binding[key as keyof RuntimeBinding],
          ) ||
          canonicalCohort(sealed.nodeCohort) !==
            canonicalCohort(binding.nodeCohort) ||
          canonicalCohort(sealed.pooler ?? null) !==
            canonicalCohort(binding.pooler ?? null)
        )
          throw unknown();
        const current = await owners();
        if (!stopBarriers(current, binding)) throw unknown();
        const pod = await read(record);
        if (!pod) return;
        if (
          !pod.metadata.deletionTimestamp ||
          !["Succeeded", "Failed"].includes(pod.status?.phase ?? "") ||
          !freshTerminalMatches(pod, proof)
        )
          throw unknown();
        if (!pod.metadata.finalizers?.includes(expected)) return;
        try {
          await edit(
            pod,
            pod.metadata.finalizers.filter((value) => value !== expected),
          );
        } catch {
          /* Durable proof precedes the uncertain guard removal. */
        }
        const after = await owners();
        if (!stopBarriers(after, binding)) throw unknown();
        const observed = await read(record);
        if (observed?.metadata.finalizers?.includes(expected)) throw unknown();
      } catch {
        throw unknown();
      }
    },
  };
}
