// SPDX-License-Identifier: Apache-2.0
import { canonicalCohort } from "./node-cohort.ts";
import { capacityQuotaSpecs } from "./capacity-quota-policy.ts";
import type { CapacityJournal } from "./capacity-journal.ts";
import type { CapacityFundingFence } from "./capacity-handoff.ts";
import type {
  CapacityRef,
  CapacityRuntime,
  CapacitySnapshot,
} from "./capacity-types.ts";
import type { Resource } from "./types.ts";

type Authority = { check: () => void; expiresAt: () => number };
export interface CapacityQuotaPrerequisites extends Authority {
  // The installation supplies a bounded live physical-capacity and protected
  // execution/admission verifier. This internal interface is never client input.
  refresh: (state: CapacitySnapshot) => Promise<void>;
}
const fail = () => new Error("capacity_quota_opening_unproven");
const equal = (a: unknown, b: unknown) =>
  canonicalCohort(a) === canonicalCohort(b);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}
function reference(r: Resource): CapacityRef {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      r.metadata.uid ?? "",
    ) ||
    !/^[1-9][0-9]{0,18}$/.test(r.metadata.resourceVersion ?? "") ||
    r.metadata.deletionTimestamp
  )
    throw fail();
  return {
    name: r.metadata.name,
    namespace: r.metadata.namespace ?? "",
    uid: r.metadata.uid!,
    resourceVersion: r.metadata.resourceVersion!,
  };
}

// A committed patch is not admission authority. The original intent and actual
// quota-controller convergence must both survive a lost response or restart.
export async function openCapacityPodQuota(
  runtime: CapacityRuntime,
  journal: CapacityJournal,
  authority: Authority,
  funding: CapacityFundingFence,
  prepared: CapacityQuotaPrerequisites,
): Promise<boolean> {
  const deadline = Math.min(Date.now() + 20_000, authority.expiresAt());
  let reads = 0;
  const check = () => {
    authority.check();
    if (
      !Number.isSafeInteger(deadline) ||
      Date.now() >= deadline ||
      ++reads > 128
    )
      throw fail();
  };
  const dispatch: Authority = {
    check: () => {
      check();
      funding.check();
      prepared.check();
      const live = journal.snapshot();
      if (
        !["materializing", "active"].includes(live.phase) ||
        live.namespaceUid !== state.namespaceUid ||
        live.clusterUid !== state.clusterUid ||
        live.quotaUid !== state.quotaUid ||
        !equal(live.plan.binding, state.plan.binding) ||
        !live.podQuotaGate ||
        live.podQuotaGate.quota.uid !== state.quotaUid
      )
        throw fail();
      const expires = Math.min(
        deadline,
        authority.expiresAt(),
        funding.expiresAt(),
        prepared.expiresAt(),
      );
      if (!Number.isSafeInteger(expires) || Date.now() >= expires) throw fail();
    },
    expiresAt: () =>
      Math.min(
        deadline,
        authority.expiresAt(),
        funding.expiresAt(),
        prepared.expiresAt(),
      ),
  };
  const state = journal.snapshot();
  if (
    !state.namespaceUid ||
    !state.clusterUid ||
    !state.quotaUid ||
    !["materializing", "active"].includes(state.phase)
  )
    throw fail();
  const specs = capacityQuotaSpecs(state.plan);
  const read = async (
    kind: string,
    namespace: string,
    name: string,
  ): Promise<Resource> => {
    check();
    const r = await runtime.read(kind, namespace, name);
    check();
    if (
      !r ||
      r.kind !== kind ||
      r.metadata.name !== name ||
      (r.metadata.namespace ?? "") !== namespace
    )
      throw fail();
    reference(r);
    return r;
  };
  const owned = (r: Resource) => {
    if (
      r.metadata.labels?.["app.kubernetes.io/managed-by"] !==
        "cloudflare-postgres" ||
      r.metadata.labels?.["pgcf.io/environment-id"] !==
        state.plan.binding.environmentId ||
      r.metadata.labels?.["pgcf.io/region-id"] !==
        state.plan.binding.regionId ||
      r.metadata.annotations?.["pgcf.io/spec-hash"] !==
        state.plan.binding.specHash ||
      (r.metadata.annotations?.["pgcf.io/run-epoch"] ?? null) !==
        state.plan.binding.runEpoch
    )
      throw fail();
  };
  const originalIdentity = async () => {
    const ns = await read("Namespace", "", state.plan.namespace);
    const cluster = await read("Cluster", state.plan.namespace, "database");
    owned(ns);
    owned(cluster);
    if (
      ns.metadata.uid !== state.namespaceUid ||
      cluster.metadata.uid !== state.clusterUid
    )
      throw fail();
  };
  const quotaRead = async () => {
    const quota = await read(
      "ResourceQuota",
      state.plan.namespace,
      "database-resources",
    );
    owned(quota);
    if (quota.metadata.uid !== state.quotaUid) throw fail();
    const gate = journal.snapshot().podQuotaGate;
    if (gate && quota.metadata.uid !== gate.quota.uid) throw fail();
    if (
      !equal(quota.spec, specs.closed) &&
      !(gate && equal(quota.spec, specs.open))
    )
      throw fail();
    if (
      gate?.phase !== undefined &&
      gate.phase !== "opening" &&
      !equal(quota.spec, specs.open)
    )
      throw fail();
    if (gate && equal(quota.spec, specs.open)) {
      check();
      // Latch the first actual applied observation even before controller
      // convergence; a later external closure cannot reset this operation.
      journal.recordPodQuotaApplied(reference(quota), object(quota.spec));
    }
    return quota;
  };
  await originalIdentity();
  let quota = await quotaRead();
  const prior = journal.snapshot().podQuotaGate;
  if (!prior) {
    if (!equal(quota.spec, specs.closed)) throw fail();
    check();
    journal.beginPodQuotaOpening(reference(quota), object(quota.spec));
  } else if (prior.phase !== "opening" && !equal(quota.spec, specs.open)) {
    // A subsequently closed gate cannot be reopened by the original provisioner.
    throw fail();
  }
  await funding.refresh();
  funding.check();
  check();
  await prepared.refresh(journal.snapshot());
  dispatch.check();
  await originalIdentity();
  quota = await quotaRead();
  if (equal(quota.spec, specs.closed)) {
    const status = object(quota.status);
    if (
      !equal(status.hard, object(specs.closed).hard) ||
      object(status.used).pods !== "0"
    )
      throw fail();
    check();
    const pods = await runtime.list("Pod", state.plan.namespace);
    check();
    if (pods.length !== 0) throw fail();
    dispatch.check();
    const original = reference(quota);
    const openingDispatch: Authority = {
      expiresAt: dispatch.expiresAt,
      check: () => {
        dispatch.check();
        if (journal.snapshot().podQuotaGate?.phase !== "opening") throw fail();
      },
    };
    let changed: Resource | undefined;
    try {
      changed = await runtime.patch(
        "ResourceQuota",
        state.plan.namespace,
        original.name,
        [
          { op: "test", path: "/metadata/uid", value: original.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: original.resourceVersion,
          },
          { op: "test", path: "/spec", value: quota.spec },
          {
            op: "replace",
            path: "/spec/hard/pods",
            value: object(specs.open.hard).pods,
          },
        ],
        openingDispatch,
      );
    } catch {
      // A dispatched patch may have committed. Inspect once; do not repeat it
      // in this invocation or infer success from a transport error.
      dispatch.check();
      quota = await quotaRead();
      if (equal(quota.spec, specs.closed)) return false;
    }
    if (changed && changed.metadata.uid !== original.uid) throw fail();
  }
  dispatch.check();
  quota = await quotaRead();
  if (!equal(quota.spec, specs.open)) return false;
  dispatch.check();
  journal.recordPodQuotaApplied(reference(quota), object(quota.spec));
  if (!equal(object(quota.status).hard, object(specs.open).hard)) return false;
  dispatch.check();
  journal.confirmPodQuotaOpening(reference(quota), object(quota.spec));
  return true;
}
