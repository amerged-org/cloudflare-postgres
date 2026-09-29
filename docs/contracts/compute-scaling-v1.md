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
cannot be silently given a new size policy. This first source slice only makes
the operator-approved sizes available and immutable; it does not add a resize
request, auto-scaling decision, budget grant or Kubernetes mutation.

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

At acceptance, D1 atomically checks active ownership and region, a ready
environment, running runtime, unchanged run and Cluster identity, current
revision, policy bounds, cooldown, no pending conflicting operation and budget
state. Resize conflicts with suspend, backup and another resize. Existing
in-flight database/role operations must finish or defer before the Pod rollout;
the reverse admission check must also block them while resize is uncertain.
Expiry of a lease does not clear these locks. Hard budget stopping remains
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

Automatic scaling adds sustained CPU/memory/queue measurements, explicit
minimum and maximum size IDs, cooldown and hysteresis. It must share all manual
funding, capacity, effect and result rules. No metric by itself authorizes
unlimited scale-up or a new server order.

Upstream references: [CNPG rolling updates](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/rolling_update.md),
[resource management](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/resource_management.md),
[storage](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/storage.md),
and [failover behavior](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/failover.md).
