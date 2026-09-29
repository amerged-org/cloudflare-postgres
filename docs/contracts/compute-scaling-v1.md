# Compute size and scaling contract v1

This contract records the generic path from an immutable environment to manual
CPU/RAM resize and bounded automatic compute scaling. It distinguishes the size
catalog foundation from the runtime authority and physical proof still required
before either scaling mode can be offered. Storage and replica-count changes
have separate lifecycle contracts.

## Immutable operator-approved size policy

An installation operator may publish `computeScaling` inside a new immutable
regional profile version. Version 1 contains an `initialSizeId` and an ordered
list of two to eight `{id,cpuMilli,memoryMiB}` sizes. IDs are distinct bounded
ASCII identifiers; both CPU and RAM increase strictly between adjacent sizes.
The initial size must match the profile's existing `compute` values exactly.
The environment stores the complete approved policy in its original resolved
specification. Public catalog and environment projections expose only the size
IDs and CPU/RAM amounts. Clients may later request an approved size ID; they do
not submit Kubernetes quantities, arbitrary CPU/RAM pairs, image names, storage
classes, archive settings or credentials.

The policy is optional. Existing profiles and environments remain valid and
cannot be silently given a new size policy. The catalog slice makes the
operator-approved sizes immutable. The control slice retains a scoped manual
resize request with separate requested and effective sizes; it does not
activate physical resize, an auto-scaling decision, a budget grant or a
Kubernetes mutation.

## Separate compute identity and operation

The original `environments.spec_revision = 1`, `spec_hash`, `resolved_spec` and
run identity remain immutable. Roles, databases, backup requests, encrypted
credential contexts, allowance receipts and historical usage retain that base
identity. A future additive compute-state lane will hold desired and effective
size IDs and a monotonic compute revision. Its history and scoped idempotency
record the exact original and target sizes, owning environment/Cluster UID,
base spec hash, run epoch, runtime revision and operation cause (`manual` or
`automatic`).

Customer manual requests require an expected current compute revision and one
approved target size. Automatic proposals require a separate constrained
policy, since an executor token must not become a general customer writer.
Both paths use the same durable regional operation and public
`requested`/`applying`/`effective` status. A completed resize does not rewrite
the initial profile or an earlier operation's result.

The implemented control route is
`POST /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/resize`
with `projects:write`, `Idempotency-Key`, and exactly
`{sizeId,expectedRevision}`. It pins the base environment, selected approved
policy, Cluster UID, run epoch and runtime revision in retained D1 history.
`GET .../environments/{environmentId}/compute` reports revision zero and the
initial size until a request exists. A new request advances the desired compute
revision and reports `phase: requested` while the effective size stays old;
the ordinary operation read reports `awaiting_authority`. Exact idempotent
replay returns the retained response. The queue grants no lease or patch. The
planned regional activation and terminal result protocol are still required
before `applying` or `effective` can be published.

At current queue acceptance, D1 atomically checks active ownership and region,
a ready environment, running runtime, unchanged run and Cluster identity,
current revision, approved size, no pending conflicting operation and requested
budget state. Resize conflicts with queued/running suspend, backup and another
resize; in-flight database/role operations also prevent queuing. A future
physical activation transaction must recheck all these facts and add funded
capacity, execution authority and any automatic-policy cooldown. Its reverse
admission check must block competing work while an effect is uncertain. An
expired lease cannot clear that physical lock. Hard budget stopping remains
independent and takes precedence.

## Funding and capacity before growth

An allowed size is not a funding or fleet-capacity grant. Before increasing
requests, a bounded target/overlap resource-time envelope must be reserved
against all applicable project/environment budgets and the current execution
epoch. Admission must include the period end, lease deadline and the possibility
of the old and replacement Pods overlapping. A stale usage collector, changed
grant, expired allowance, requested pause or incomplete final accounting cannot
be treated as spare budget.

The existing allowance receipt is tied to the base spec and caller-supplied
units; it is not evidence for a new compute revision or target rate. Regional
admission must also reserve measured Node headroom for quota plus CNPG rolling
replacement and preserve a platform/maintenance margin. A Kubernetes scheduler
decision remains the final placement check. Fleet expansion has its own
capacity and Contabo provisioning policy; this contract authorizes no machine
purchase or assumed in-place VM resize. A downsize cannot credit the unused
size until the replacement Pods are actually effective.

The current Dev runtime reports `runtimeEnforced: false`. Source code may be
prepared with the above guards, but no live hard-budget or automatic-scaling
guarantee follows from the existing allowance API or requested budget state.
The current allowance receipt contains only the base spec, caller-proposed
units, epoch and expiry. Before the first increase in quota, a new immutable
compute funding segment must reserve the server-derived upper bound for the
full old/new Pod overlap horizon and stop margin against every applicable
project/environment account. It must bind compute revision, operation,
Cluster/Quota identities and run epoch, then reconcile without double-charging
or prematurely releasing old usage. A regional capacity reservation and
independent local deadline stop must cover the same period. None is implemented
by the queued control slice.

## Regional effect, uncertainty and completion

The regional writer must bind an approved lease and the owning Namespace,
Cluster, ResourceQuota and run identities. It reads their current UIDs,
resource versions and exact old fields before each limited JSON Patch. Growth
raises only the proportional owned quota ceiling first, then updates only CNPG
`Cluster.spec.resources`; contraction updates the Cluster first and lowers the
quota only after effective resource readback. Neither path changes volume size,
replicas, image, bootstrap, archive, extension or credentials.

A durable dispatch checkpoint precedes each effect. A lost Kubernetes reply is
resolved by exact owned readback; a reclaimed lease may observe but must never
blindly repeat an uncertain patch or restore an older size after a newer
revision. A changed UID, unrecognized field, mismatched run epoch, unavailable
funding or insufficient capacity defers or fails closed. The old provisioning
controller may not reconcile a completed environment back to its initial
resources. New role/database/backup claims must validate the effective compute
revision as needed while retaining the base identity; backup's current strict
Cluster-resource check must be updated before resize can be enabled.

CNPG 1.30.1 performs a rolling Pod update after a `Cluster.spec.resources`
change. The single-instance pilot will restart PostgreSQL and interrupt
connections; clients must reconnect and must not blindly replay uncertain
writes. `Cluster.status.readyInstances` alone is insufficient for success.
After the rollout, verify current Cluster UID/spec/generation and readiness,
owned primary and instance Pod identities, each PostgreSQL container's actual
CPU/RAM requests and limits, and absence of old effective Pods; then reread
lease/run authority before reporting the effective revision. Usage facts remain
attributable to the actual old and new Pod allocations across that transition.
The read-only regional proof implements this Pod/Cluster readback predicate.
The installed CNPG 1.30.1 does not populate a top-level Cluster
`status.observedGeneration` or the Ready condition's observed generation. An
absent optional generation is accepted only when the current Cluster UID,
spec/resources and generation are stable and the complete replacement Pod set
is Ready with target requests and limits in both Pod spec and
`status.containerStatuses.resources`. A present mismatched generation defers.
Completed CNPG initialization Job Pods may remain in the label-selector result;
they are excluded only after their terminal phase and identity are verified.
The full current Pod set is read once more after the final Namespace/Cluster
read, with the same instance UIDs, names, resource versions, readiness and
target Pod spec/status resources. A disappeared or changed Pod defers the result.
This bounded observation is not an atomic freeze; the later result writer must
recheck its lease and funding authority. The proof alone grants no effect,
funding or capacity.

Automatic scaling adds sustained CPU/memory/queue measurements, explicit
minimum and maximum size IDs, cooldown and hysteresis. It must share all manual
funding, capacity, effect and result rules. No metric by itself authorizes
unlimited scale-up or a new server order.

Upstream references: [CNPG rolling updates](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/rolling_update.md),
[resource management](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/resource_management.md),
[storage](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/storage.md),
and [failover behavior](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/failover.md).
