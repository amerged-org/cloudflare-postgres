# Versioned execution identity v1

This contract binds updated lifecycle writers to one immutable compute-run identity. It is a prerequisite for excluding stale stoppers during a future resume or resize. It does not implement funded resume, epoch advancement, workload-local expiry or Kubernetes admission enforcement.

## Explicit new-environment producer

An installation operator may add exactly `executionFencing:{version:1}` to a new immutable catalog profile. Customers select that profile through the existing environment API. Callers cannot supply an epoch, annotation map or controller identity. Unknown fields, null and unsupported versions are rejected.

For a newly created opted-in environment, the Worker assigns `runEpoch:"1"`. The value is stored separately from the immutable specification and returned in customer metadata and the private provisioning claim. Its ready observation must include exactly that epoch. A missing or different epoch cannot publish readiness. Shared role-observation validation accepts the authoritative optional field without weakening existing Cluster/spec/role boundaries.

Legacy profile/spec serialization, hashes, claims, observations and existing rows remain unchanged when fencing is absent. The additive migration does not backfill old environments. There is no implicit retrofit of a running environment. This version creates only the initial epoch; it supplies no public or private epoch-advance route.

The regional producer requires the exact policy and initial claim epoch to agree before effects. Stamp `pgcf.io/run-epoch` only on the owned Namespace, `database-resources` quota, `database` Cluster and optional `database-pool-rw` Pooler. Their desired annotation values become part of the owned resource comparison. CNPG's generated Deployments/ReplicaSets/Pods and retained PVC/PVs do not need copied annotations for this contract. Their existing UID ownership checks remain mandatory.

## Immutable local binding

`RuntimeBinding.runEpoch` is optional. Explicit epochs are positive canonical decimal strings of at most 19 digits, without signs, leading zeros, whitespace or floating-point conversion. Absence denotes legacy behavior; it is not an invitation to learn the value from live annotations.

The allowance journal seals the value together with its existing immutable identity. Suspend claims/snapshots carry the authoritative epoch only for a fenced environment. Their operation journal identity, captured binding, adapter and accepted observation preserve it through a new lease epoch or process restart. Reopening with a different run epoch conflicts; starting another journal cannot by itself provide funding or current execution authority.

## Stop and mutation checks

All required owned resources participate in the check: Namespace, Cluster, quota and the bound Pooler where applicable. A legacy binding is accepted only when every required resource omits the annotation key entirely. A present empty/invalid annotation still rejects it. An explicit binding requires every annotation to be present, valid and exactly equal. Partial/mixed transitions defer both actors.

Updated stop logic verifies the complete owned inventory and immutable volume identity before effects and after uncertain writes. Every explicit mutation includes JSON Patch tests for target UID, resourceVersion and `/metadata/annotations/pgcf.io~1run-epoch`. Fresh adapter reads independently recheck owned identities, versions and the required epoch set before dispatch; an old actor cannot adopt a newer run by refreshing its resourceVersion. These reads are observations, not an atomic transaction across Kubernetes objects: a future handoff must exclude old actors before changing annotations. Existing operation-lease authorization remains active at every SDK dispatch.

No mismatch causes an annotation rewrite, Cluster replacement, volume deletion, automatic resume or authority renewal. Unknown state remains closed/deferred. Run epoch, operation lease epoch, budget execution epoch and specification revision have different owners and are not interchangeable.

## Activation and remaining limits

Before enabling the profile, deploy and verify every lifecycle/allowance writer using these checks. Revoke or otherwise quiesce old Kubernetes writers. An older privileged binary can ignore annotations; these client-side guards are not a server-enforced lock or permission revocation. Admission policy and adversarial-writer isolation remain release gates.

A future advance/wake protocol must first prove compute stopped, exclude old actors, atomically authorize the new run in the control plane, set/recheck the new epoch on every controlled object before growth, preserve retained data and bind fresh settled accounting/funding. Partial stamping remains blocked. Never remove, reuse or infer epochs to make startup pass. The current migration's initial identity is immutable until a separately reviewed advancement protocol exists.

Positive API-managed certificate/SQL, real run handoff/stale-writer refusal, complete final accounting, independent expiry, public gateway, autoscaling and recovery still require their own evidence. Enforcement flags remain false and closed lab admission is not relaxed by this feature.

## Bounded verification

Exactly three new top-level cases cover opted-in catalog/creation/readiness/suspend propagation with legacy preservation, stale/legacy/mixed-resource refusal and journal identity, and actual provisioning annotations plus SDK refusal despite fresh target UID/resourceVersion. Each fails first, affected files run during iteration, and the frozen candidate gets one canonical gate. No matrices, speculative suites or resumption of held workflows accompanies this change.
