# Durable accepted usage receipts v1

The regional collector retains exact control-plane acceptance evidence before deleting a delivered outbox fact. This supports later accounting reconciliation; it does not finalize observations, submit corrections, settle allowances or release budget holds.

## Strict transport and local commit

`UsageClient.sendReceipt(fact)` uses the existing scoped meter credential and bounded HTTPS delivery. The accepted response must echo every submitted fact field exactly, match source/region identity, contain valid organization/project UUIDs and provide a positive canonical decimal acceptance sequence plus an exact UTC millisecond acceptance timestamp. Normalize only those known fields into `{fact,regionId,organizationId,projectId,acceptanceSequence,acceptedAt}`. Do not retain arbitrary response fields or exception bodies.

Keep the existing boolean `send()` compatibility path, but normal collector delivery uses only strict receipts. There is no fallback from a malformed receipt to weak acknowledgement. Failed transport or local commit keeps the same durable fact ID/revision/evidence in the outbox for the control plane's existing exact replay.

`UsageJournal.acknowledgeAccepted(receipt)` validates receipt/source identity, the exact pending fact payload and immutable metadata. In one SQLite transaction, persist the full normalized receipt and its digest, then remove that matching pending fact. Exact duplicate acceptance is idempotent; differing quantity, ownership, acceptance metadata or hash conflicts. Acceptance sequences remain decimal strings, including values beyond JavaScript's safe integer range.

## Compatibility and retained history

Upgrade the private journal transactionally without rewriting pending facts, checkpoints, retained volume bindings, gaps or source identity. Old short acknowledgements lack payload/sequence/time/ownership and may already have been pruned. Preserve them as legacy history; never fabricate receipts or claim that absence means no prior usage. The receipt ledger describes retained local evidence since receipt retention began, not complete database history or complete consumption.

The old weak acknowledgement API remains an explicitly incomplete compatibility operation. It does not populate a receipt ledger or satisfy the strict collector guarantee. Production delivery cannot use it as a shortcut.

## Bounded paging and capacity

`acceptedPage(afterSequence,limit)` reads retained immutable rows in ascending local journal sequence. `limit` is at most 256; `nextSequence` continues after the last returned local sequence. This local ordering is separate from the preserved control-plane acceptance sequence. Report legacy/retired-history boundaries rather than presenting a local page as a full usage window or invoice.

The accepted ledger has explicit record and serialized-byte limits. Capacity exhaustion leaves the pending fact available and defers delivery retirement; it never prunes accepted evidence to make a new record fit. Outbox/observation pressure remains subject to the existing visible gap policy. A logical payload cap is not a physical SQLite/WAL/filesystem size guarantee.

## Explicit private archive retirement

`archiveAccepted(absolutePath,limit)` selects a bounded immutable batch of at most 256 records and writes a source-bound full-receipt JSON bundle with exact local sequences and hashes. The archive ID is derived from its identity and batch. Paths must be private, owned, absolute and outside the journal and its auxiliary files; reject symlinks or conflicting destinations. Never overwrite an existing different archive.

Publish a private exclusive file atomically without replacement, flush its bytes and containing directory, then re-read and verify the published content. Only afterward revalidate and retire that exact batch in a SQLite transaction. No appended or changed record can be removed by an older bundle. Persist a bounded last-archive checkpoint with its path/digest/identity and retirement result.

A crash after publication but before database retirement leaves a harmless durable bundle and active records. Retry validates the same file and finishes only its original batch. A crash after retirement but before response returns the verified last checkpoint; tampered/missing files fail rather than rewriting or deleting another batch. Older archives remain operator-owned files; the bounded local checkpoint is not a complete archive catalog.

The archive is local retained evidence, not an independent backup or proof of node-loss recovery. Operators must qualify off-node custody, durable storage and retention policy before relying on it for production accounting. No credential or provider token is included in the bundle, though usage identities and quantities remain private operational data.

## Final accounting remains separate

Polling stability and successful acceptance do not prove a final physical allocation interval. Facts remain `provisional` or explicit `gap`, with exact quantities/unknowns unchanged. A future final producer must retain independent lifecycle/allocation evidence, append an exact next revision under control-plane predecessor checks and reconcile gaps without inventing zero usage. Stop observation alone is not final consumption or a settlement permit.

## Bounded verification

Exactly three new top-level cases cover exact receipt recovery across restart, capacity and verified archive/idempotent retirement, and strict transport/default-sender refusal before acknowledgement. Run named affected files during iteration and one canonical gate after freezing; archive/crash assertions stay within those cases. No generated matrices, speculative suites or resumption of held workflows is permitted.
