# Durable per-Pod retirement v1

This is a prerequisite for safe Suspend and bounded runtime lifecycle. It persists original Pod identities before stop effects and qualified native termination evidence before removing a retention finalizer. It does not publish environment completion, finalized usage or released allowances.

## Explicit operator lane

Private Suspend configuration may add `podRetirement: {"version": 1}` together with the explicit node observer. The runtime binding must already contain a run epoch and original node cohort. The lane adds no default controller permission or automatic activation. Operators need narrowly scoped Pod read/patch and owner Job/ReplicaSet read rights in the managed namespace, plus the reviewed observer Exec rights. Missing authority or history stays pending.

A private SQLite journal seals installation, operation, project/environment/region, immutable specification, namespace/Cluster/quota identities, run epoch and node-cohort pointer. It stores a bounded original roster of at most 128 Pods with node UID/boot, full Pod specification hash, exact regular/init names, restart counters and original controller lineage. No lease credential, administrative password or full Pod specification is persisted. Initial capture happens before retention or stop effects; a reclaimed operation with missing history cannot reconstruct it from an empty list. The exact per-operation finalizer is `pgcf.io/retire-<operation UUID>`.

Direct Cluster Pods, Job-to-Cluster and ReplicaSet-to-bound-Pooler-Deployment lineage are supported. Nondeleting completed initialization Jobs require Never restart and complete termination without native Always init sidecars. Ordinary already-terminal or deleting Pods without the sealed history, ambiguous owners, unseen UIDs, host PID sharing and unsupported ephemeral groups defer. A changed roster/spec/restart identity is not silently refreshed.

## Acknowledgement and guarded release

Set own retention guard with exact Pod UID/resourceVersion and unchanged specification/ownership. Preserve unrelated finalizers. Then use the existing owned quota-zero, Pooler-zero and CNPG hibernation mutations. CNPG can delete serially; acknowledge and release individual Pods before waiting for whole-cluster API convergence.

Each acknowledgement requires the same retained deleting Pod, complete Terminated status for every regular/init/native-sidecar group and a fresh, original-node/boot/installation/region-bound all-state CRI snapshot. Terminal phase alone is insufficient. Recompute the challenged observation hash; require ordered bounded observation times after deletion and within 30 seconds of the consumer clock. Wrong/stale/unknown evidence never reuses cached proof as current truth. Historical receipt reads remain available without rewriting their bytes.

When runtime objects remain, require all current terminal container IDs/attempts and timestamp correlation; preserve exact CRI nanoseconds. Kubernetes normally garbage-collects stopped objects. A complete fresh snapshot with zero matching sandboxes and zero matching containers can therefore support the same qualified native acknowledgement alongside all retained API termination facts. Store the literal empty arrays and provenance, never fabricated CRI timestamps. Partial remnants or unseen namespace identities remain pending. [Kubelet garbage collection](https://github.com/kubernetes/kubernetes/blob/v1.36.3/pkg/kubelet/kuberuntime/kuberuntime_gc.go).

Commit the scoped receipt and its evidence hash before guard removal. The SDK then rechecks current namespace/Cluster/quota/cohort/run ownership, stop barriers, exact Pod UID/spec/controller and complete current termination facts against the receipt. Its JSON patch tests Pod UID, fresh resourceVersion and the full existing finalizer array, removing only this operation's guard. Resolve a lost mutation reply by exact current readback. Do not remove another actor's guard, overwrite newer state or discard a prior receipt.

## Remaining environment and accounting gates

This is conditional operational evidence from trusted kubelet/status/runtime authorities, not an exposed attestation of kubelet's internal worker state. A separate original birth history/admission policy must cover every potentially executing Pod across the whole environment, including unseen/deleted predecessors and in-flight admissions. Independent signed/funded expiry, run handoff, all-original-node coverage and complete final allocation accounting remain required. The existing Suspend result remains `physical_verification_pending`; all enforcement/final flags stay unchanged.

Retained storage and backups stay allocated. This lane deletes no PVC/PV or customer data and does not implement funded resume. The [qualification checkpoint](../evidence/m6-pod-retirement-2026-09-29.md) distinguishes the new isolated native fixture from public API migration or production readiness.
