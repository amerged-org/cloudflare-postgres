// SPDX-License-Identifier: Apache-2.0
import type { AllowanceRuntime, RuntimeInventory } from "./allowance-types.ts";
import type { NodeCohortData } from "./node-cohort.ts";
import { PodRetirementJournal } from "./pod-retirement.ts";

export async function preparePodRetirement(
  journal: PodRetirementJournal,
  runtime: AllowanceRuntime,
  inventory: RuntimeInventory,
  cohort: NodeCohortData,
  authorized: () => void,
): Promise<void> {
  if (!runtime.retainPod || !runtime.releasePod || !runtime.observeNode)
    throw new Error("pod_retirement_configuration_unavailable");
  authorized();
  const roster =
    journal.roster ??
    journal.capture(inventory.pods, cohort, [
      ...(inventory.jobs ?? []),
      ...(inventory.replicaSets ?? []),
    ]);
  for (const pod of inventory.pods) {
    const record = roster.find((record) => record.uid === pod.metadata.uid);
    if (!record) throw new Error("pod_retirement_history_incomplete");
    if (journal.proof(record.uid)) continue;
    if (pod.metadata.deletionTimestamp) {
      if (!pod.metadata.finalizers?.includes(journal.finalizer))
        throw new Error("pod_retirement_guard_missing");
      continue;
    }
    authorized();
    await runtime.retainPod(record, journal.finalizer);
    authorized();
  }
}

// Retire individually: CNPG may wait for one Pod deletion before deleting
// the next. This is not environment completeness or a settlement producer.
export async function acknowledgePodRetirement(
  journal: PodRetirementJournal,
  runtime: AllowanceRuntime,
  inventory: RuntimeInventory,
  authorized: () => void,
): Promise<number> {
  const roster = journal.roster;
  if (!roster || !runtime.releasePod || !runtime.observeNode)
    throw new Error("pod_retirement_history_missing");
  if (
    inventory.pods.some(
      (pod) => !roster.some((record) => record.uid === pod.metadata.uid),
    )
  )
    throw new Error("pod_retirement_history_incomplete");
  let count = 0;
  for (const record of roster) {
    const pod = inventory.pods.find((pod) => pod.metadata.uid === record.uid);
    const previous = journal.proof(record.uid);
    if (!pod) {
      if (!previous) throw new Error("pod_retirement_guard_missing");
      count++;
      continue;
    }
    if (
      !pod.metadata.deletionTimestamp ||
      !["Succeeded", "Failed"].includes(pod.status?.phase ?? "")
    )
      continue;
    authorized();
    const observation = await runtime.observeNode(record.nodeName);
    authorized();
    const proof = journal.prove(pod, observation);
    if (!proof) continue;
    await runtime.releasePod(record, journal.finalizer, proof);
    authorized();
    count++;
  }
  return count;
}
