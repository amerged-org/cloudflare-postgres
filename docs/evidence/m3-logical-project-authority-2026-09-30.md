# Logical-project write authority — 2026-09-30

Status: source qualified and delivered to Dev, with bounded readback verified. This change closes the observed
stale-authorization race in `POST /v1/organizations/{organizationId}/projects`,
including its retained idempotent response and concurrent-winner recovery.
It changes no API schema, database schema, region admission, compute operation
or signing/backup/native qualification.

## Current principal and atomic effect

Previously the route authorized the organization token once, then awaited the
request body, request hash and history before writing an unconditional project,
succeeded operation and idempotency record. Token reissue during body delivery
still returned `201`. Removing write scope during a retained request similarly
returned the old resource body.

The route now captures the original token ID, digest, organization and write
scope. Current actor predicates protect history/resource reads and an assertion
at the beginning of the same D1 business batch. A failed assertion rolls back
all writes; successful cleanup deletes only that freshly generated assertion ID,
with no global deletion of retained guard history. Other assertion callers retain
the default generated-ID behavior.

All reads in this logical route use the direct D1 binding, which Cloudflare
routes to the primary. A previously started `first-primary` session would only
pin its first query; later reads can use replicas with an earlier bookmark.
The same current principal is checked after asynchronous history/resource reads,
conflict recovery and successful commits. A commit made while authorized remains
recoverable; revocation before response denies disclosure rather than undoing it.
[D1 batch and session semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Existing bearer syntax,`401`/`403`/`404` behavior, name/request hash/idempotency rules,
logical active/succeeded `201` result and legacy queued `202` replay are preserved.
Project creation still creates only the global logical container. It does not
provision a database. Other API readers remain outside this change.

## Bounded evidence

The task starts from published `0fcdba9` in a separate worktree. The stopped signed
Linux candidate remains preserved outside this source and gate.

Exactly two new Worker stories fail meaningfully in 5.18 seconds: real streamed
organization token reissue returns `201` rather than `401`, and streamed scope removal
returns `201` rather than `403` on retained replay. The first implementation passes in
1.67 seconds. A read-only review identifies the D1 session freshness issue above;
the same two stories pass its primary-read correction in 1.98 seconds. Selected
format/lint/type checks pass. No matrix, permutations, Node or Go case is added.

The frozen canonical gate runs exactly once and passes in **65.631 seconds**:
format, lint, typecheck, **42 Worker** and **59 Node** cases. The six unchanged Go
cases retain previous evidence. Application source stays frozen; no second broad
gate is run. Unchanged regional artifacts are rebuilt for the isolated Node gate;
no regional image or runtime is changed.

## Public source and Dev delivery

Source [3c15c1c](https://github.com/amerged-org/cloudflare-postgres/commit/3c15c1cfd3b0e7e01dc83aeb47c2fdb68dee6ae7)
is published to the public default branch. Five edited file contents match an
independent GitHub readback. A same-source Worker preview passes in 4.900 seconds;
all three output files contain no known local credential variants. One reviewed
Dev deployment passes in 13.185 seconds, without schema migrations, new keys,
regional images or Contabo effects.

The new Worker version is `4580876f-add3-48e0-a24a-a9eecb46daed`. Eight bounded
post-deployment requests complete in 1.140 seconds and verify 100 percent traffic,
the exact account/database identity, eight unchanged Secret names/types,
18 migrations/50 tables, 319 retained assertion rows, one organization/project,
zero managed environments/create-stop-delete work/permits/allowance holds,
budget counts 1/1/3, zero reserved units and closed admission. Secret values are
never queried. The existing owned project GET returns `200` with matching identity;
an unauthenticated empty POST on this logical-project collection returns exact
401 `unauthorized`, without credentials, body or idempotency key.

The single SELECT counts capture precedes that unauthenticated dispatch; it is
post-deployment evidence, not a separate post-probe snapshot. These live probes
establish routing/read compatibility, not reproduction of a credential-revocation
race. That race evidence comes from the two isolated Worker stories.

The first baseline capture correctly stops on a checker defect: a historical
binding alias `DB` was compared with the live database display name. The original
checker and failure remain retained. One approved manual correction takes the
established Wrangler `database_name` while preserving account ID/database UUID
checks; one fresh same-scope read captures metadata before validation and passes.
No third baseline attempt or automatic retry occurs.

The stopped signed candidate remains unpublished and unactivated. No held
Linux, Barman/backup, native-access, birth or maintenance qualification resumes.
Customer production acceptance, actual backup/PITR and runtime enforcement
remain open.

Private logs, source hashes, gate results and original held-source custody are
retained under `.local/evidence/logical-project-authority/`. Credentials are not
copied into the worktree or any public source. Local signing/Linux, backup/PITR,
physical admission and production acceptance remain open.
