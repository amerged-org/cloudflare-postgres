# Manual resize control-intent checkpoint — 2026-09-29

The generic management API now has a scoped manual resize request and a read
endpoint for requested versus effective compute size. Additive migration `0016`
retains the immutable operation, idempotency response and current desired size
without changing the original environment specification, run epoch, role or
database identities. A new environment has implicit compute revision zero and
the catalog's initial size. The first accepted request advances desired revision
to one while effective size remains the previous value.

The API requires an operator-approved size ID, expected compute revision,
organization `projects:write` and `Idempotency-Key`. It checks active scoped
ownership, ready environment and Cluster observation, running runtime, current
budget requested state and no conflicting outstanding work in one D1 batch.
Exact replay preserves the original response and operation identity. Public
reads expose only size and operation metadata, not backend hostnames,
credentials or internal resource identities.

The operation reports `queued` and `awaiting_authority`. It has **no regional
claim, dispatch, funding grant, fleet reservation, Kubernetes patch or terminal
result route**. Requested size therefore cannot be reported as physically
effective. Hard budget enforcement still reports `runtimeEnforced: false` in the
Dev installation. The [compute scaling contract](../contracts/compute-scaling-v1.md)
defines the target funding and capacity segment, local expiry and bounded
quota/Cluster effect still needed before activation.

The regional source contains a read-only effective-size predicate for that
future executor. It binds Namespace/Cluster ownership, base spec hash and run
epoch, verifies the target Cluster resources, observes the owned PostgreSQL
instance Pods and requires matching requests and limits in both Pod spec and
`status.containerStatuses.resources`. The old Pod UIDs must be absent. Real
CNPG 1.30.1 observations lack top-level and Ready-condition observed-generation
fields, so their absence alone is not failure; a present contradictory
generation remains a deferral. A completed, identity-matched CNPG initdb Job Pod
can coexist with current instances and is not counted as running database
compute. The predicate does not authorize an effect or bypass current funding.
The same bounded Pod inventory is read again after the final Cluster check;
changed or missing instance UIDs/resource versions defer publication.

Control-state recovery still captures the full schema and retains one accepted
queued resize identity, compute revision and original response exactly in its
quarantined offline rebuild. The trusted SQL generator uses short private column
aliases so the 16-migration one-read statement is 93,428 bytes, below D1's
100,000-byte statement limit. This does not address the separate 2,000,000-byte
result-string limit. The [10,000-project checkpoint](m3-scale-10000-projects-2026-09-29.md)
records why a consistent multi-part recovery path is required before that
scale can be advertised.

The task's test-count baseline is 84 automated cases. Exactly three top-level
cases are involved: one new Worker case, one new regional Node case and one
expanded existing control-recovery case. The Worker request first returned 404
before implementation and passed after the source change. The recovery case
first found no `environment_compute` table, then passed with all three new
tables and their rows round-tripped. The Node case records actual CNPG status
shape, retained completed-initdb Pods and a Pod disappearing between readbacks
as meaningful REDs before narrow corrections, then passes. Initial module-
import and duplicate-name fixture errors remain visible in private evidence;
no generated matrices or extra top-level cases were introduced. The final gate
and Dev delivery are recorded only after their separate checks.

The frozen candidate passed the canonical gate **once** in 18.874 seconds:
format, lint, typecheck, 31 Worker tests and 49 Node tests. Six unchanged Go
cases retain their earlier evidence; the automated inventory is 86 cases. The
regional package was built before the Node stage so its existing command tests
used the actual compiled entry. The no-secret/private-file preflight matched
all 427 frozen public files and found zero matches against 105 known-value
variants. No source or test was changed after the gate.
