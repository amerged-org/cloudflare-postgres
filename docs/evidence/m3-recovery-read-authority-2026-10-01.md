# Recovery reads — current token authority

Status: source, local verification, public delivery and Dev readback complete.
This closes one management-API revocation defect. It does not establish regional
execution, customer SQL access or complete M3/M8 readiness.

## Defect and correction

The recovery reader used one `first-primary` D1 session. Initial authentication
consumed its primary query; later page/operation batches and the final actor
check after cursor signing could read a replica preceding a sibling revocation.
A sequentially consistent old bookmark is insufficient for current authority.

The reader now uses the direct D1 binding for every query and batch. Existing
actor/ownership predicates stay in the same atomic read batch as public data;
the final actor check after signing also reads the primary. Resource ordering,
redaction, scope boundaries, `observed-page` semantics, cursor format and
`Cache-Control: no-store` are unchanged.

The shared `AccountingDb` type names only its used `prepare` and `batch` methods.
Both database and session callers remain structurally compatible; the direct
binding is not cast as an object providing the session-only `getBookmark`.
There is no schema migration, new secret or regional configuration change.

## Two meaningful red-first cases

Exactly two new top-level Worker cases model legal stale session reads from
actual captured D1 results, without parsing SQL or manufacturing authorized rows:

- Selective token revocation commits through the real installation API after
  the token lookup, before the canonical operation batch. Require exact 401,
  no operation metadata, unchanged business rows and an active sibling's access.
- Real cursor signing completes cryptography, then commits revocation before
  returning the signature. The original session can still see its saved active
  actor. Require exact 401 with neither resource data nor cursor; preserve an
  active sibling's valid two-project traversal.

The initial harness incorrectly expected DELETE to return 204. Its setup errors
are retained and are not the required red proof. After matching the existing
200/redacted-revocation contract, both tests fail for the intended defect:
expected 401, received 200. Correction attempt one passes both cases plus six
existing recovery and credential-disclosure cases in three named files.
An independent read-only source/test review finds no actionable gap.

## Frozen verification

The fresh isolated worktree installs the unchanged lockfile from its local
store. It builds the regional artifact required by existing Node tests before
starting the final gate. The frozen runtime source remains unchanged throughout.
Exactly one canonical format/lint/typecheck/Vitest/Node gate passes in
56.559 seconds, with 51 Worker cases and 60 existing Node cases.
No matrices, renamed cases or extra test stories are added.

Private environment files and unrelated held drafts remain outside the clean
candidate. An incidental Kubernetes discovery cache is moved byte-for-byte into
ignored `.local/cache/`; no environment data is deleted or published. Public
source/Dev readback and live revocation/pagination checks are recorded below.

## Dev delivery and its evidence boundary

Public source commit `58d853efe8ba2863490624aaec8a4cc1c0b4f674` is independently
read back from GitHub. The frozen artifact dry-run passes and all three bundle
files contain zero matches across 82 actual private-value representations.
One deployment delivers Dev Worker version
`ae59f9ec-907c-43f2-859f-3bf1de7bc556` at 100% traffic, retaining the existing
bindings and nine Secret names/types. There is no migration or new regional image.

One 22-request live qualification passes in 7.297 seconds. It creates two scoped
read tokens, uses both existing logical projects and their stored operation,
verifies bounded pages and continuation, then selectively revokes one token.
That token receives exact 401/no-store responses for operation, initial page
and cursor continuation, while the active sibling and original token retain
access. Both probe tokens are finally revoked. No credential value is printed
or published. Only two retained token-history rows are added; every other
control-table count, 18 migrations, zero managed environments and closed
admission remain exact.

The asynchronous in-request cuts with legally stale replica results are proved
by the two local Worker cases. The live qualification proves deployed ordinary
revocation/pagination behavior; it does not claim that a physical D1 replica was
forced to replay that exact concurrent schedule.

Independent regional readback preserves Node/boot, all 30 post-backup Running
Pod identities/restarts, all original PVC/PV full specs, the healthy source
Cluster, enabled R2 archiving and both original SQL markers. Environment bytes,
ignored/untracked mode 0600 and unrelated held source hashes remain unchanged.
The broader original platform objective remains incomplete.

References: [recovery contract](../contracts/recovery-reads-v1.md),
[Cloudflare D1 session semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession).
