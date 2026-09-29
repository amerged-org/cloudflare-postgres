# Durable source-bound usage delivery diagnostics

The regional collector now retains one bounded private latest delivery failure
with known HTTP status/code and the original fact/source identity. An operator
can inspect why delivery is deferred without raw server errors or credentials.
This adds operational evidence; it neither recovers missing customer authority
nor resolves the existing noncanonical qualification queue.

## Implemented transport and accounting boundaries

The [diagnostic contract](../contracts/usage-delivery-diagnostics-v1.md) defines
an 8192-byte strict JSON error envelope and exact allowed status/code pairs.
Malformed, unknown, extra-field, oversized, stalled or cancelled bodies retain
the received HTTP status with null code. The existing single 20-second total
request deadline is preserved. Typed fixed transport/acknowledgement categories
replace arbitrary exception inspection; public logs keep the same constant event.
No raw response, header, token, URI or password is persisted or logged.

One <=2048-byte source-bound record is stored under the existing journal-meta key
`last_delivery_failure`. Source identity, exact pending payload/hash, fact ID,
revision and evidence hash are validated before write. Stored malformed or
wrong-source metadata is fatal; it is never overwritten into plausibility.
`UsageJournal.status()` adds the nullable record without changing journal schema,
existing fields, fact data or source epochs.

Exact new/replayed strict receipt success clears only its matching failure inside
the same transaction that retains acceptance and retires that outbox row.
Unrelated, weak legacy and archive operations never clear it. Local accepted-ledger
capacity failure remains deferred with a fixed safe category and unchanged pending
data; other durable acknowledgement failures remain fatal. Delivery cadence,
head ordering, retry identity and authority checks are unchanged.

## Bounded verification

Exactly two new meaningful red-first Node cases fail in 0.254 seconds: missing
safe HTTP code and missing durable refusal state. A focused wrong-source check
within the same second case independently fails in 0.144 seconds; no extra
top-level case is added. They pass on implementation attempt one, together with
the two named unchanged affected test files, in 0.766 seconds.

The cases cover safe known refusal, exclusion of arbitrary sensitive fields,
oversized stream cancellation, restart retention, unchanged pending data, exact
atomic acceptance clearing, wrong-source corruption and local capacity pressure.
No matrix, permutation or speculative suite is added. Independent bounded review
passes. The one frozen canonical format/lint/typecheck/Vitest/Node gate passes in
19.923 seconds: 27 Worker and 41 Node cases, retaining six unchanged Go cases as
prior source-valid evidence, giving 74 automated cases. Go is not rerun and no
second full gate occurs.

## Actual Dev delivery

Published source commit `fcfe2c4d22afe84ad579de8845f7d57ee0c61dec` supplies a sealed
71-file public-only build context. GitHub Git blobs match every input; no private
file or environment enters the context. One nonroot Linux/AMD64 build succeeds
in 29.614 seconds. Archive, OCI index, architecture manifest and configuration
digests are verified; no registry publication is claimed.

One authenticated Talos image import succeeds in 28.087 seconds. Exact cached
reference/index readback precedes one UID/resource-version/current-image
conditional image-only Deployment patch in 0.189 seconds. Recreate rollout reaches
Ready in 1.209 seconds; the same configuration, RBAC, volumes and Never pull policy
remain. The actual image configuration digest and all 63 compiled module hashes
match the frozen public source build.

The ordinary background sender, without an additional manual fact submission,
records the actual `404 / not_found` refusal. Its private source/fact-bound record
is 383 bytes and passes the compiled validator. A fresh read-only connection
observes durable storage. All 4,096 outbox sequences/payload/evidence hashes and
source identity remain exact, schema stays two and accepted receipt count stays
zero. Restart/atomic clear behavior is proven by the local case; no live receipt
success or queue recovery is claimed for this unowned scope.

The Node UID/boot stays Ready, all 28 other Running Pod UIDs/restart counts remain
intact, four PVC and five PV specifications are unchanged, the original CNPG
Cluster UID/spec/Ready state and both SQL markers are preserved. The Dev Worker
version and all eight Secret names remain unchanged. D1 retains fourteen
migrations, one organization/project, zero environments/roles/databases/facts/
reservations and closed admission. No CF/D1/provider mutation occurs.

## Remaining operational gates

The [provenance/custody checkpoint](m3-usage-journal-custody-2026-09-29.md) establishes
that the refused scope belongs to the previous native retirement fixture and its
preserved Released/Retain volume. The new record has `activationSupported: false`.
A 404/409 is not a permanent-disposition classification, a budget grant or a permit
to clear, reassign or invent usage. The full queue, data volume and custody copies
remain retained pending explicit evidence handling and future qualification
ownership. No invoice, settlement, correction or final usage is produced.

Failure visibility is now available. Scheduled custody, node-loss recovery,
safe replay, complete accounting and enforced budget stops remain open. Physical
backups/PITR, the pending dedicated S3 credential confirmation, gateway, sleep/wake,
manual resize and autoscaling remain required in [PLAN.md](../../PLAN.md).
The ignored local environment files stay byte-identical and untracked. No
credential value or private journal/fact/source identifier is published.
