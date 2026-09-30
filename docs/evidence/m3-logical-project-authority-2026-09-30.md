# Logical-project write authority — 2026-09-30

Status: source qualified; Dev delivery pending. This change closes the observed
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

Dev delivery and final readback remain pending. No live credential revocation,
project write or customer provisioning is needed for delivery observations;
streamed-body race evidence comes from the isolated Worker tests. Planned live
checks must remain read-only apart from the reviewed Worker deployment.

Private logs, source hashes, gate results and original held-source custody are
retained under `.local/evidence/logical-project-authority/`. Credentials are not
copied into the worktree or any public source. Local signing/Linux, backup/PITR,
physical admission and production acceptance remain open.
