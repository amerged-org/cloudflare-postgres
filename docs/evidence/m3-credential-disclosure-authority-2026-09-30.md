# Plaintext credential disclosure authority — 2026-09-30

Status: source qualified and delivered to Dev; bounded readback verified. Four secret-bearing responses
now validate the original principal and current resources with a fresh primary
D1 query after every decryption await: customer role credentials, customer
owned-database credentials, regional role application claims (current and
previous password), and regional database creation claims (owner password).
No credential format, encryption, AAD, immutable history, public payload, schema
or regional operation contract changes.

## Current authority and lease snapshot

The previous final queries reused the initial `first-primary` session. That
session can legitimately serve later queries from a replica at its earlier
bookmark, even after another request has revoked the token, rotated the owner
or changed runtime/lease state. A correct SQL predicate evaluated against that
older state can still disclose plaintext.

The shared final helper creates a fresh `first-primary` session and immediately
performs its first and only SELECT. Each query retains the captured actor ID,
hash, owner and scope; role/database versions and credential revisions; parent,
runtime, region and deletion conditions. Customer database credentials still
use the latest applied owner revision. Pending database creation remains bound
to its original owner identity/revision. A refused response returns the existing
late `409` error, with no password, and does not reset or delete a committed lease.
[D1 primary/session behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Regional fences also require exact winning token/actor/epoch and stored returned
lease expiry, checked against D1 `strftime` time. Role claims repeat pending and
applied-revision-plus-one constraints. The helper reads both compared timestamp
values from D1 and subtracts `ceil(queryElapsedMs)+1ms` from the remaining lease
window. It refuses malformed timestamps and nonfinite/backward timing. Existing
lease issuance/renewal still uses its original clock behavior; this change does
not migrate that protocol. Worker wall time never supplies a new authority
mapping in this final disclosure check.

All asynchronous cryptography precedes the fence. Only bounded validation and
response construction follow it. This is a point-in-time confidentiality check,
not continuous revocation monitoring or a guarantee about later network delivery.
Workers timers advance at I/O boundaries; query-delay observation is not precise
CPU-time measurement or a physical execution deadline.
[Worker timers](https://developers.cloudflare.com/workers/runtime-apis/performance/).

## Bounded causal evidence

The isolated task starts from published `b3c41c1`, with 42 Worker/59 Node and six
unchanged Go cases. Exactly three new Worker stories reproduce concrete plaintext
leaks: late organization-token reissue during role decryption, real owner rotation
during database decryption, and regional token reissue after the actual guarded
rotation-lease UPDATE. The last refusal must retain the committed lease and
return neither current nor previous password.

The first fixture run stops in 1.29 seconds before the credential boundary because
its ready-report body contains extra fields. It is preserved as a preparation
failure, not a meaningful RED. One fixture correction makes the exact existing
body. All three stories then fail meaningfully in 1.42 seconds: the real Worker
returns `200` instead of `409` after real primary-state changes.

The narrow facade serves a verified earlier positive snapshot to any later read
on the original session, independent of SQL text. Fresh primary queries use real
changed local D1 state, and each case requires a fresh read after the cut. This
models documented replica lag; an ordinary local mutation would already be
visible and would not prove the defect. There is no SQL parser, permutation,
second database engine, matrix or fourth hidden negative scenario.

The first code candidate passes all three named stories in 1.65 seconds; selected
formatting, lint and type checks pass. Independent read-only review finds no
remaining material identity/time blocker. Existing positive lifecycle coverage
continues to cover the fourth database-claim path using the same shared helper.

The frozen canonical gate runs exactly once and passes in **60.367 seconds**:
format, lint, typecheck, **45 Worker** and **59 Node** cases. Six unchanged Go cases
retain prior evidence. Frozen source is unchanged; no second broad gate, regional
build/image, schema migration, key creation or held qualifier occurs.

## Public source and Dev delivery

Source [8aa8b78](https://github.com/amerged-org/cloudflare-postgres/commit/8aa8b78091f72bb91b5bc32cbb74a77de4151b61)
is published to the public default branch. Six edited file bytes match independent
GitHub readback. One same-source Worker preview passes in 5.577 seconds; its three
output files contain no known local credential variants. One reviewed Dev
Worker deployment passes in 13.451 seconds without schema migrations, key changes,
regional image changes or Contabo actions.

The new Dev version is `4dee98aa-521b-455a-a990-e7a509f7f3b1`. Nine bounded
post-deployment requests complete in 1.567 seconds and verify 100 percent traffic,
exact account/database identity, eight unchanged Secret names/types,
18 migrations/50 tables, 319 retained guard rows, the original one organization
and project, closed admission and zero managed/create-stop-delete/permit/allowance
work. Budget targets/accounts/revisions remain 1/1/3 with zero reserved units.
The existing owned project remains readable. Secret values are never queried.

Both unauthenticated customer credential GETs return exact `401` refusal. They send
no token/body/query and request canonical absent environment/resource UUIDs.
An unexpected response would be cancelled before body consumption; no password
response is read, retained or printed. These probes establish routing/auth refusal
only. Real password delivery, replica races and regional disclosure correctness
come from source and isolated test evidence, not those live requests. The single
counts snapshot precedes the two probes and is not a second post-probe capture.

Known local configuration remains ignored, untracked and mode0600 with unchanged
bytes. A public candidate scan checks 22 sensitive assignments and 65 variants
against 470 files with zero matches; no private configuration is copied into the
isolated worktree. Held signing/native/backup code is not part of this public
source or deployment.

Private source/RED/GREEN/gate/delivery evidence is retained under
`.local/evidence/credential-disclosure-authority/`. Backup activation remains
pending its explicit bounded exception; signed Linux, native/birth and other
held workflows remain held. API-managed production admission and the whole
production milestone remain incomplete.
