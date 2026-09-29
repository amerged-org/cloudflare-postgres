# D1 REST control-capture checkpoint — 2026-09-29

The generic `recover-control` operator command now has an explicit Cloudflare
D1 REST capture backend alongside its original Wrangler backend. Both feed the
same one-statement, ordered, bounded rowset decoder and unchanged encrypted v1
recovery format. This is a private operator path; it adds no customer HTTP route,
D1 write, restored live control service or execution authority.

## Authority and fail-closed transport

The REST configuration names one Cloudflare account and the source D1 UUID. It
uses only `https://api.cloudflare.com/client/v4/accounts/.../d1/database/.../query`
and a mode-0600 token file under a mode-0700 owner directory. The adapter does
not pass the token through config JSON, arguments, environment variables or
public output. Cloudflare
[accepts D1 Read permission](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
for this endpoint; a dedicated restricted token is recommended for operators.

The code sends one internally generated read-only `SELECT`, rejects redirects,
requires one successful provider result explicitly marked
`meta.served_by_primary: true`, and bounds the streamed HTTP body at 16 MiB.
The provider's [primary metadata](https://developers.cloudflare.com/d1/best-practices/read-replication/)
is required because a lagging read replica cannot establish the current control
state. Timeouts, cancellation, malformed responses and provider errors become
one redacted failure; no partial snapshot is published. The installation UUID
remains a trusted operator-owned identity because D1's query response cannot
independently prove it.

## Bounded red-first verification

Three new top-level Node cases failed first and then passed: exact fixed-origin
rowset capture, redacted provider failure and a too-large streaming response.
An independent review found that awaiting stream cancellation could hang past
the stated deadline. The existing oversized-response case was made to return a
never-settling cancellation promise, failed in 1.018 seconds before the fix and
passed after abort was moved ahead of nonblocking cleanup. A missing-primary
response also failed first and was rejected without adding a fourth case.

The targeted recovery files pass **8/8**. The frozen final source passed the
canonical format, lint, typecheck, Vitest and `test:node` gate exactly once in
20.351 seconds: **31 Worker and 55 Node tests** passed. The unchanged Go source
retains its prior evidence. No test matrix or broad-gate rerun was added.

## Actual Dev capture and offline rebuild

One read-only invocation against the existing Dev D1 used the already held
admin credential in a temporary owner-only file; no new API token was issued.
The dedicated least-privilege D1 Read credential remains a deployment hardening
item. The temporary token file was removed immediately after capture. The
operator command reported **47 tables and 49 rows**; the 78,657-byte private
snapshot contains all **16 migrations**. A new random, separate recovery key
sealed the snapshot with existing operator-held keyrings into a 105,610-byte
mode-0600 bundle. Independent restore reported `verified_offline`, 47 tables,
49 rows and `activationSupported: false`.

A separate SQLite read of the reconstructed 741,376-byte database found 16
migrations, one organization, one project, zero managed environments,
`integrity_check = ok` and zero foreign-key errors. The private restored
directory is mode 0700 and its database, manifest and keyring files are
owner-only. A fresh provider read still found 16 migrations, one organization,
one project, no environment, resize or backup rows. No D1 control row, Worker
Secret, PostgreSQL workload, Contabo server or R2 resource was changed.

The live Dev state has zero retained role credentials and allowance fences, so
this sample does not independently prove decryption of positive historical
rows. Earlier local cases use actual Worker-generated ciphertext and retained
key versions. The new key and bundle still reside on one workstation; off-node
custody, fresh Cloudflare bootstrap, fencing and safe activation remain open.
Concurrent-writer recovery-point behavior and a 10,000-project invocation
through this operator command remain separate gates. The isolated
[10,000-project D1 rowset proof](m3-scale-10000-projects-2026-09-29.md)
does not supply those guarantees.

All 428 tracked public files were checked against 45 private credential-value
variants with no match. `.env.local`, `.dev.vars` and `.local/` remain ignored;
the temporary admin-token file is absent.
