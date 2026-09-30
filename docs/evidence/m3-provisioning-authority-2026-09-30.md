# Provisioning lease authority — 2026-09-30

Status: **source qualified; Dev delivery pending**. This fixes the original
provisioning lane's request-body authorization race. It does not activate a
managed environment, fund execution or resume a held physical qualifier.

## Problem and resulting behavior

Provisioning claim, renewal and result authenticate before consuming the request
body. Previously, installation token reissue during that body read could revoke
the authenticated regional token while the in-flight request still returned
success and changed its operation/environment. Three real Worker API cases
demonstrate HTTP 200 after this revocation.

The corrected lane uses current token identity, hash, regional owner, required
scope and non-disabled region in its D1 mutation predicates and guarded readback.
Revocation during body delivery returns HTTP 401 without issuing or extending
a lease, publishing a terminal result, disclosing an observation or changing
operation/environment/accounting-guard state. Conditional transaction assertions
retain coupled result/observation changes and the existing deletion fences.
Empty/no-candidate claim polling creates no accounting guard row.

Every newly claimed/reclaimed provisioning lease records the exact actor in
the existing `operations.lease_actor_token_id` column from migration `0012`.
Replacement credentials do not inherit a newly bound lease; they wait for
expiry and reclaim with a new epoch. No schema, request or response change is
required. The existing regional ControlClient remains compatible.

Historical NULL-actor provisioning leases preserve their existing compatibility
under current authorized same-region credentials, exact lease hash/epoch and
unexpired deadline. Normal authorized renewal remains possible. Exact terminal
recovery remains available after deletion admission without rewriting the
environment. Ownership is never inferred or backfilled; reclaim records the
new actor. The original disabled-region response remains HTTP 403.

This is an API authority boundary, not immediate physical revocation of effects
previously authorized by a valid lease. Signed workload funding, independent
expiry, safe stop, final accounting and service recovery remain required v1 work.

## Bounded verification

Exactly three new top-level Worker cases exercise claim, renewal and result.
Each uses a zero-buffer streamed body whose first read invokes the actual
installation token-reissue API after initial authentication. There is no sleep,
direct fixture token revocation, matrix or additional case. The unchanged
runtime fails all three cases in 2.842 seconds; correction attempt one passes
all three in 2.468 seconds. Complete operation/environment/guard snapshots stay
unchanged on denial.

Selected formatting, lint and typecheck pass. Independent read-only source
review finds atomic guards, exact actor binding, legacy recovery and unchanged
wire/empty-poll behavior. The frozen canonical workspace gate runs exactly once
and passes in 26.451 seconds: format, lint, typecheck, 39 Worker cases and 58 Node
cases. Six unchanged Go cases retain their previous evidence. No existing test
assertion or deadline is weakened. The summary parser is corrected once for
Node's actual reporter prefix without repeating any command/test.

The Dev baseline independently verifies the prior Worker at 100%, eight unchanged
Secret names/types, 18 migrations and 319 historical guard rows. Environments,
permits, pending provisioning, stop operations and deletion intentions remain
empty; admission is closed. No credential value, provider token reissue or
customer resource is used by these checks. Source delivery and the bounded Dev
Worker preview/deploy/readback follow this checkpoint.

The similar original logical-project creation authorization race is outside
this three-case fix and remains separate work. Pre-compute funding and signed
guard integration are also still absent; this authority correction is not a
claim of complete M2, M3, M6 or production readiness.
