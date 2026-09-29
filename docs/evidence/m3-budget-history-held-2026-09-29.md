# Budget history candidate held at its final typecheck

Contabo credentials are confirmed as five Cloudflare Dev Worker Secret names:
`CONTABO_API_USERNAME`, `CONTABO_API_PASSWORD`, `CONTABO_CLIENT_ID`,
`CONTABO_CLIENT_SECRET` and `CONTABO_VPS_ROOT_PASSWORD`. Eight configured secrets
remain present, including the installation, role-credential and allowance keys.
The local environment is unchanged, mode 0600, ignored and untracked; no value is
published. This verifies configured names, not credential validity or host
maintenance automation.

## Narrow API candidate

The isolated `codex/budget-history` draft adds read-only project/environment budget
account history: exact decimal counters, retained periods, signed parent/actor/
limit-bound keyset cursors and explicit observed-page consistency. Project and
environment policy counters overlap; consumers must use deduplicated usage fact
heads for usage totals rather than add those counters together. Current policy
and runtime-enforcement behavior remain unchanged.

The baseline is 65 automated cases. Exactly two new Worker cases demonstrate
meaningful failures before implementation, then pass their targeted files. An
additional read-only Dev case demonstrates the missing route with HTTP 404; it
has not run against a deployed candidate. No matrix, permutation or speculative
suite is added, and no live organization, project, environment or budget is
created or changed for qualification.

Review identifies two concrete gaps within the same cases: cumulative exact
counters can exceed the input quantity bound, and a consumed D1 `first-primary`
session does not give subsequent authorization reads a fresh primary guarantee.
Each fails first and receives one narrow correction. The lifecycle case passes
in 1.21 seconds; the authority/session case passes in 2.59 seconds. A separate
read-only review confirms distinct primary sessions for authorization, the guarded
read batch and the final actor check. These results are not a full release gate.

## Mandatory final-gate stop

The frozen canonical gate runs exactly once and stops after 11.361 seconds:
format and lint pass; typecheck fails. The D1 batch result lacks a declared type
for `active_present`, and seven array accesses in the new lifecycle case need
strict index narrowing. Vitest and `test:node` stages are not reached. The
candidate therefore has no verified new complete-suite total; unchanged Go
evidence is retained and not rerun.

The draft and six source/test/migration/contract files are sealed in the ignored
worktree with hashes. No correction, second full gate, runtime source publication,
migration application or deployment follows the failed gate. The smallest next
step is the identified result/index type correction; executing it and continuing
the interrupted release requires an explicit exception to the current final-gate
stop rule. Do not rename the task or reset its history to bypass that rule.

The seven held Pod-birth files and 22 held SDK files remain byte-identical. The
Dev Worker, D1 schema, PostgreSQL deployment, regional image and closed admission
are preserved. Whole-environment admission, funded expiry, verified stop, complete
final accounting, backup/restore and other open v1 gates remain unfinished.

## User-resumed narrow type correction and subsequent stop

The user explicitly requested continuation of the goal and plan. The known strict
result/index types receive a narrow repair: the heterogeneous D1 batch declares
its row shape and seven test dereferences use erased non-null markers after
existing one-row assertions. Runtime predicates, test assertions and authority
behavior remain unchanged. The draft integrates current main in its isolated
worktree, retaining Fleet and Control Recovery. The two named Worker cases pass
in 1.53 seconds; focused format/lint/typecheck also pass. A mistaken focused
format command includes SQL, for which Prettier has no parser; the supported
named files pass after the command-only correction.

The original failed full gate remains recorded. Only its previously unrun Vitest
and Node stages run once: 29 Worker cases pass in 5.951 seconds, then Node stops
in 3.624 seconds with 35 of 36 passing. The existing Control Recovery case asserts
a literal 14-migration count while the index draft now supplies 15. This is a
stale fixture expectation, not a missing data reconstruction proof. No assertion
is weakened or corrected after this stop; no broad gate is repeated.

The smallest next step is to make that existing migration-count expectation
track independently enumerated committed migration files and verify the same
named recovery case. Its previous expected values, high-water mark and exact
reconstruction checks remain required. This proposal is unapplied; the resumed
six-file draft and original history remain sealed privately. No migration is
applied, no runtime source is merged/published and no Worker is deployed.

Read-only infrastructure preflight preserves one Node, 29 Running Pods, four
PVCs, five PVs and both existing SQL markers. Initial inventory command plural
errors are corrected without infrastructure effects. A separate SQL metadata
preflight returns an error and supplies no state-count proof; the actual control
recovery checkpoint already records the prior 14-migration Dev snapshot. The
budget native route case remains its original red result, not a live green.

After eventual migration `0015`, older recovery bundles must retain and use their
matching 14-migration trusted source files. The recovery verifier intentionally
rejects a changed migration set. Neither this draft nor its stop activates
recovered state or alters runtime admission/enforcement.
