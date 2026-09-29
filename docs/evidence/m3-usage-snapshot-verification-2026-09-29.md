# Offline verification of recovered usage-journal custody

The regional operator package now supplies `verify-usage-snapshot`. An operator
can verify a recovered complete usage snapshot against an independently retained
source identity and database SHA-256. This verifies custody; it neither activates
a journal nor authorizes replay, settlement, source reassignment or customer
admission. Source commit `147b882` is integrated by `4f11657`.

## Implemented boundary

The command reuses the existing private file checks and supervised snapshot child.
It requires the exact existing version-two manifest, owner-private regular files,
one file link, no SQLite auxiliary siblings and a completed DELETE-mode header.
The independent digest and identity must match both the manifest and the database.
Byte length, pending count, schema identity, integrity and foreign keys are checked.

Only this closed, quiescent artifact is opened through an encoded immutable
read-only SQLite URI. Extensions are disabled, the schema is untrusted and SQL is
query-only with temporary storage in memory. The reader constructs no
`UsageJournal`, performs no migration or checkpoint and changes no permissions.
Held file/path identities, metadata and both file hashes are checked again before
success. The existing 64-MiB and approximately 60-second process bounds remain;
cancellation waits for actual child closure. Output contains aggregate metadata
and `activationSupported: false`; failure output contains a fixed error code.

Immutable SQLite access assumes the artifact remains quiescent under the
operator's control. Before/after checks do not defend against hostile transient
modification by the same owner. This mode must never open a live usage journal.
See the [operator contract](../contracts/usage-journal-snapshot-v1.md).

## Bounded verification

Two new top-level cases fail meaningfully first in 0.549 seconds: there is no
shipped verifier for a recovered artifact, and a modified copy is not rejected.
The corruption case rewrites the recovered manifest's digest too; the separately
retained receipt must still cause refusal. Both new cases and the two existing
snapshot cases pass on implementation attempt one in 2.410 seconds. No matrix,
permutation, unrelated case or weakened assertion is added. Two independent
bounded reviews pass.

The isolated workspace initially refuses automatic dependency installation
through shared dependency symlinks. A separate preparation error stops before any
dependency operation. These setup failures remain recorded. Only the three
worktree symlinks are subsequently unlinked; their existing targets are preserved.
One frozen-lockfile offline installation completes in 7.915 seconds, producing
isolated dependency directories without changing public dependency configuration.
The regional package is built before checking existing tests that import its
compiled artifacts.

The frozen candidate's canonical gate runs exactly once and passes in 26.078
seconds: format, lint, typecheck, 27 Worker cases and 43 Node cases, with zero
failures or skipped Node cases. Six unchanged Go cases retain their earlier
source-valid evidence; they are not rerun. The task's evidence baseline increases
from 74 to 76 cases, exactly the two new cases.

## Existing off-node artifact

One invocation of the built command verifies the existing off-node custody copy
in 0.581 seconds. Expected identity comes from the original source observation and
snapshot intent; the expected digest comes from the original separately retained
snapshot receipt. It verifies 3,076,096 database bytes and 4,096 pending facts.
Both files retain their exact byte hashes, sizes, permissions, device/inode
identities and modification timestamps. No auxiliary file appears.

The artifact and receipt remain private. No new snapshot, transfer, provider
operation, Worker deployment, database migration, Secret or regional image rollout
is performed by this slice. The source controller, journal and database are not
opened or modified by the offline qualification. Actual local environment values
and their encodings are scanned before publication; environment files stay
unchanged, private and excluded from Git.

## Remaining work

This command provides a repeatable custody check, not a complete node-loss
recovery exercise. Independent disaster custody, safe activation, final usage
coverage, fixture-evidence disposition and allowance settlement remain open.
The 4,096 unaccepted facts are not removed, acknowledged, rewritten or invoiced.
No stopped fixture or pending R2 credential operation is resumed. Database backup
and PITR, API-to-CNPG acceptance and the other gates remain in [PLAN.md](../../PLAN.md).
