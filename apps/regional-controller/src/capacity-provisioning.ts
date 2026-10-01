// SPDX-License-Identifier: Apache-2.0
import { acquireCapacity } from "./capacity-reconcile.ts";
import { handoffCapacity } from "./capacity-handoff.ts";
import { openCapacityPodQuota } from "./capacity-quota.ts";
import { inspectNodeCohort, nodesMatchCohort } from "./node-cohort.ts";
import type { CapacityQuotaPrerequisites } from "./capacity-quota.ts";
import type {
  CapacityConfiguration,
  CapacityRuntime,
} from "./capacity-types.ts";
import type { ProvisioningCapacityStages } from "./reconcile.ts";
import type {
  ProvisioningFunding,
  ProvisioningFundingBarrier,
} from "./provisioning-funding.ts";
import type { Claim, Kubernetes, Resource } from "./types.ts";

export interface CapacityProvisioningConfiguration {
  configuration: CapacityConfiguration;
  runtime: CapacityRuntime;
  // Installation-owned verifier of actual signed execution delivery/admission.
  // Absence permits closed preparation only, never an optimistic positive proof.
  execution: CapacityQuotaPrerequisites | null;
}
export interface ProvisioningCapacityOperation {
  api: Kubernetes;
  stages: ProvisioningCapacityStages;
  close: () => void;
}
const fail = () => new Error("provisioning_capacity_not_prepared");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
}

export async function prepareProvisioningCapacity(input: {
  api: Kubernetes;
  claim: Claim;
  lane: CapacityProvisioningConfiguration;
  funding: ProvisioningFundingBarrier;
  fundingIdentity: ProvisioningFunding;
}): Promise<ProvisioningCapacityOperation | null> {
  const { claim, lane, funding, fundingIdentity: identity } = input;
  funding.assert();
  if (
    identity.operationId !== claim.operationId ||
    identity.environmentId !== claim.environmentId ||
    identity.regionId !== claim.regionId ||
    identity.specHash !== claim.specHash ||
    identity.specRevision !== claim.specRevision ||
    identity.runEpoch !== (claim.runEpoch ?? null) ||
    !uuid.test(identity.projectId) ||
    !uuid.test(identity.organizationId)
  )
    throw fail();
  const barrier = await acquireCapacity(
    lane.runtime,
    claim,
    lane.configuration,
    () => funding.assert(),
  );
  if (!barrier) return null;
  try {
    const journal = barrier.custody();
    const authority = barrier.dispatchAuthority();
    const fundingDispatch = funding.dispatchAuthority();
    const fence = {
      refresh: () => funding.refresh(),
      check: fundingDispatch.check,
      expiresAt: fundingDispatch.expiresAt,
    };
    const api = funding.wrap(barrier.wrap(input.api, () => funding.assert()));
    const checkedExecution = (): CapacityQuotaPrerequisites => {
      const execution = lane.execution;
      if (!execution)
        throw new Error("signed_execution_preparation_unavailable");
      return {
        check: () => {
          authority.check();
          execution.check();
        },
        expiresAt: () => Math.min(authority.expiresAt(), execution.expiresAt()),
        refresh: async (state) => {
          await barrier.refresh();
          await execution.refresh(state);
          authority.check();
          execution.check();
        },
      };
    };
    // Recover an uncertain opening before ensure() compares the genuine quota
    // against its desired spec. Do not report a committed open as a conflict.
    if (journal.snapshot().podQuotaGate) {
      await openCapacityPodQuota(
        lane.runtime,
        journal,
        authority,
        fence,
        checkedExecution(),
      );
    }
    const quota = () => {
      const gate = journal.snapshot().podQuotaGate;
      return gate && gate.phase !== "opening"
        ? String(record(gate.openSpec.hard).pods)
        : "0";
    };
    const stages: ProvisioningCapacityStages = {
      podQuota: quota,
      beforeCluster: async () => {
        await barrier.beforeCluster();
        const state = journal.snapshot();
        if (!state.namespaceUid) throw fail();
        journal.bindRuntime({
          namespaceUid: state.namespaceUid,
          projectId: identity.projectId,
          organizationId: identity.organizationId,
        });
        if (claim.spec.profile.nodeTracking) {
          const resource = await api.read(
            "ConfigMap",
            state.plan.namespace,
            "execution-nodes",
          );
          const cohort = inspectNodeCohort(resource, {
            environmentId: claim.environmentId,
            regionId: claim.regionId,
            specHash: claim.specHash,
            runEpoch: claim.runEpoch,
            namespace: state.plan.namespace,
            namespaceUid: state.namespaceUid,
            ...(state.nodeCohort ? { nodeCohort: state.nodeCohort } : {}),
          });
          const nodes = api.listNodes ? await api.listNodes() : undefined;
          if (!cohort || !nodesMatchCohort(cohort.data, nodes)) throw fail();
          journal.bindRuntime({
            namespaceUid: state.namespaceUid,
            nodeCohort: cohort.pointer,
          });
        }
      },
      cluster: async (cluster: Resource) => {
        const state = journal.snapshot();
        if (
          !state.namespaceUid ||
          !state.clusterUid ||
          cluster.metadata.uid !== state.clusterUid
        )
          throw fail();
        // CNPG owns creation of customer claims. Never fabricate its PVCs.
        for (const slot of state.slots.filter(
          (v) => v.plan.kind === "database" && !v.plan.maintenance,
        )) {
          if (slot.handoffPhase === "rebound") continue;
          const name =
            "database-" + (Number(slot.plan.id.slice("database-".length)) + 1);
          const target = await lane.runtime.read(
            "PersistentVolumeClaim",
            state.plan.namespace,
            name,
          );
          if (!target) continue;
          if (
            !(await handoffCapacity(
              lane.runtime,
              journal,
              slot.plan.id,
              name,
              lane.configuration,
              authority,
              fence,
            ))
          )
            return false;
        }
        if (
          journal.snapshot().slots.find((v) => v.plan.id === "database-0")
            ?.handoffPhase !== "rebound"
        )
          return false;
        return openCapacityPodQuota(
          lane.runtime,
          journal,
          authority,
          fence,
          checkedExecution(),
        );
      },
      pooler: async (pooler) => {
        const state = journal.snapshot();
        if (
          !state.namespaceUid ||
          state.podQuotaGate?.phase !== "open" ||
          pooler.kind !== "Pooler" ||
          pooler.metadata.name !== "database-pool-rw" ||
          pooler.metadata.namespace !== state.plan.namespace ||
          !uuid.test(pooler.metadata.uid ?? "")
        )
          throw fail();
        journal.bindRuntime({
          namespaceUid: state.namespaceUid,
          poolerUid: pooler.metadata.uid!,
        });
        const deployment = await lane.runtime.read(
          "Deployment",
          state.plan.namespace,
          "database-pool-rw",
        );
        if (deployment) {
          const owner = deployment.metadata.ownerReferences?.[0];
          if (
            deployment.metadata.ownerReferences?.length !== 1 ||
            !owner ||
            owner.uid !== pooler.metadata.uid ||
            owner.kind !== "Pooler" ||
            owner.controller !== true ||
            record(record(deployment.spec).strategy).type !== "Recreate" ||
            !uuid.test(deployment.metadata.uid ?? "")
          )
            throw fail();
          journal.bindRuntime({
            namespaceUid: state.namespaceUid,
            poolerDeploymentUid: deployment.metadata.uid!,
          });
        }
      },
      ready: async (observation) => {
        funding.assert();
        await barrier.beforeCluster();
        const execution = checkedExecution();
        await execution.refresh(journal.snapshot());
        execution.check();
        const state = journal.snapshot();
        if (
          state.podQuotaGate?.phase !== "open" ||
          observation.clusterUid !== state.clusterUid ||
          observation.readyInstances < claim.spec.profile.instances ||
          (observation.runEpoch ?? null) !== state.plan.binding.runEpoch ||
          state.slots
            .filter((v) => v.plan.kind === "database" && !v.plan.maintenance)
            .some(
              (slot) =>
                slot.handoffPhase !== "rebound" ||
                slot.consumers.filter(
                  (c) => !slot.retirements.some((r) => r.podUid === c.uid),
                ).length !== 1,
            ) ||
          (claim.spec.profile.pooling &&
            (observation.pooler?.uid !== state.poolerUid ||
              observation.pooler?.deploymentUid !== state.poolerDeploymentUid))
        )
          throw fail();
        funding.assert();
        authority.check();
      },
    };
    return { api, stages, close: () => barrier.close() };
  } catch (error) {
    barrier.close();
    throw error;
  }
}
