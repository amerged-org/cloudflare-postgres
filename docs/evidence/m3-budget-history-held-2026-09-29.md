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
