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

## Dev delivery and observed idle-claim correction

Public source `29f7b4be2770ccff8df018f47661906701602ab7` is delivered in Dev.
A fresh pre-migration capture, encrypted seal and independent offline restore
verify 49 tables and 50 rows. Migration `0018` is applied once; its table/five
triggers match, foreign keys pass and the new table is empty. One dry run checks
the bundle, then one `--keep-vars` Worker deployment passes in 9.997 seconds.
The deployed version is `2b18ef4a-7dd0-4624-bd5b-01c08f401c6c` at 100%.
Eight Secret names/types remain. No Secret values are queried or printed.

Six successful GET observations are retained. Two DELETE probe calls initially
omit the required Idempotency-Key. One harness correction repeats only those
calls: invalid input returns 400 and an unknown environment returns 404.
No managed environment, deletion or stop operation is created.

The post-migration capture, seal and offline restore each complete once, but the
subsequent before/after count assertion stops: `accounting_assertions` grows from
14 to 150 during idle controller polling. All other expected counts match.
This exposes a genuine regression: the new creation-claim fence writes a durable
guard even when its queue is empty. The failed preservation check and all complete
artifacts remain private and unchanged; it is not reported as a clean delivery.

One assertion added to the same existing causal deletion case fails first in
2.669 seconds on an empty claim adding a row. A conditional guard INSERT now runs
only for a genuinely selected create lease, keeping the same transaction and
tombstone predicate. The case, including its actual nonempty creation claim,
passes in 2.722 seconds after one correction. Selected-file formatting and lint
pass. No new top-level case, data deletion or full gate rerun occurs. The single
21.018-second workspace gate above predates this focused live correction;
it is not claimed as a new clean full gate for the corrected source.

The corrective source is published as `1ab8822`. One credential-free dry run and
one reviewed corrective Worker deployment pass, the latter in 9.558 seconds.
Version `1361b660-cfdd-4cc3-87eb-c4aa287b0b8d` serves 100%; the same eight Secret
names/types are preserved. An authenticated compiled ControlClient invocation in
the running regional Pod returns null. Primary counts before/after that request
and twelve seconds of ordinary background polling remain identical: 319
historical guard rows, zero environments/deletions/stop operations and closed
admission. No historical guard row is removed to conceal the regression.

One fresh corrected capture, seal and independent offline restore each pass:
**50 tables, 356 rows, 18 migrations**, exact retained counts, integrity and foreign
keys. The snapshot is 116,980 bytes and the encrypted bundle 156,707 bytes. The
temporary administrative token is removed; directories are mode 0700 and files 0600. This proves complete control-state recovery custody, not live activation,
PostgreSQL backup/PITR or independently escrowed disaster recovery.

Ordinary admission remains closed. No API-managed deletion or physical disposal
is claimed. The separately held backup, native and birth qualification workflows
are not resumed, and the full v1 objective remains open.
