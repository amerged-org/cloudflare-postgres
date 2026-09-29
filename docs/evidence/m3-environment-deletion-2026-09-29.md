# Retained environment deletion intention — 2026-09-29

The source now supplies scoped environment DELETE and lifecycle recovery reads.
One primary D1 transaction records an immutable deletion binding and queued parent
operation, then creates or attaches to the ordinary suspend child. It reuses the
existing regional stop protocol rather than introducing another stop engine.
Already suspending or suspended environments need not resume to request deletion.

The accepted intention closes new execution authority through the shared running
predicate. Creation claims, renewals and publication also check the tombstone;
exact completed creation replay performs no write and exposes current lifecycle.
Existing allowance snapshots include the immutable deletion pointer, recheck it
after hashing and return `environment_deleting`, even after mutable runtime or
budget changes. Historical ciphertext, reservations, usage and backups remain.

The parent remains queued. Public views always report
`physicalDeletionVerified: false`; a reported stop result advances only to
`pending_physical_deletion`. No Namespace, database disk or R2 object is removed.
The operator-selected ordinary suspend lane remains responsible for consuming
the child; this checkpoint enables no unattended physical-disposal lane.
Pending/failed provisioning cleanup and qualified physical retirement, storage
deallocation, independent retained-archive custody and final accounting remain
required. See the [contract](../contracts/environment-deletion-v1.md).

## Bounded source evidence

Exactly **two new Worker cases and one expanded existing Node case** are used.
No matrix, permutation, new Node case or speculative suite is added.

The new deletion case fails first on the missing DELETE route in 3.007 seconds.
The first implementation reaches the intended lifecycle but stops on a fixture
using the wrong existing collection wrapper. One assertion correction passes the
case in 2.563 seconds. Independent review then finds an actual omitted lifecycle
join in original creation replay. Its one additional assertion, in the same
causal case, fails first in 2.606 seconds; one narrow projection correction passes
in 2.443 seconds. All earlier evidence is retained, without test/task renaming.

The authority case fails first because the attached stop reports
`environment_suspended` instead of deletion authority. One implementation
candidate passes both named-file cases in 2.589 seconds. The case also verifies
same-child reuse, lasting denial after runtime/budget changes and retained
reservation custody without settlement.

Migration `0018` adds one immutable 20-column table and five triggers. Its growth
initially makes the complete legacy/ordered snapshot statements exceed the
unchanged 99,000-byte guard. The expanded existing recovery case fails first.
Removing quotes only from program-generated `cN`/`oN` aliases restores the bound;
actual schema names, values, type markers, ordering, completeness and digests are
unchanged. All five named-file cases pass after one correction. The complete
18-migration, 50-table fixture seals and restores deletion, suspend, runtime and
replay records exactly. The existing 10,000-project digest comparison also passes.
Final query sizes are **95,803 bytes** legacy and **94,580 bytes** ordered.

After rebuilding the affected regional package and freezing the source, the
canonical format/lint/typecheck/Vitest/Node gate passes **exactly once in
21.018 seconds**: **35 Worker and 55 Node cases**, zero failures or skipped Node
cases. Six unchanged Go cases retain their prior evidence. The source candidate
does not change during the gate. OpenAPI resolves 807 references and 67 distinct
operations with complete path parameters.

## Delivery boundary

The source is qualified locally. Dev migration and Worker delivery are prepared
as the next step; no API-managed deletion or physical disposal is claimed here.
Ordinary admission remains closed. The separately held backup, native and birth
qualification workflows are not resumed, and the full v1 objective remains open.
