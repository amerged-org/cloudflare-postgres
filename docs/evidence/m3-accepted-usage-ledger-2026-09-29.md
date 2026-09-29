# Durable accepted usage checkpoint — 2026-09-29

Source [`96b054b21f5aec3d1db562ae23085451d3d75cf3`](https://github.com/amerged-org/cloudflare-postgres/commit/96b054b21f5aec3d1db562ae23085451d3d75cf3) implements the [accepted-receipt contract](../contracts/accepted-usage-ledger-v1.md). Complete acceptance evidence now survives normal collector delivery and can be retired through a verified private archive. This advances accounting reconciliation; it produces no final facts, corrections, allowance settlement or released budget holds.

## Implemented evidence flow

The strict transport verifies every echoed fact field, source/region identity, owner UUIDs, decimal acceptance sequence and exact UTC acceptance timestamp. Normal delivery uses that receipt path only. The journal atomically persists the full normalized receipt, original outbox payload and hashes before removing the matching pending fact. Duplicate metadata is immutable/idempotent; conflicts leave pending evidence intact. The older boolean/short-ack APIs remain explicitly incomplete compatibility paths.

Schema two adds a bounded immutable accepted ledger, local sequence pages and a one-row last-archive checkpoint. Version-one pending facts/checkpoints/gaps/identity and legacy acknowledgements are preserved; previously pruned history is never fabricated. Existing journals mark legacy receipt history unknown, even with no surviving acknowledgement records. Ledger pressure leaves the pending fact available and reports a visible pressure gap.

Explicit archive batches are source-bound, at most 256 records and eight MiB. Private exclusive files are flushed, published without overwrite, directory-flushed and re-read before exact batch retirement. A published-file/failed-database crash recovers through the same validated bundle; later appended records are untouched. The bounded checkpoint links to the previous archive rather than maintaining an unbounded local manifest table. Tampered/conflicting paths, source mismatch and journal/auxiliary aliases refuse retirement. The operator CLI needs only local private configuration, not Kubernetes/provider credentials.

These are retained accepted observations, not complete historical coverage, invoices or final physical measurements. Provisional/gap status and unknown consumption remain unchanged.

## Bounded TDD and independent review

Exactly three new top-level cases fail meaningfully first through inert feature seams, after preserving the initial absent-method observations. They cover lost local acknowledgement/restart, capacity plus archive publication/retirement failure and idempotent/tamper behavior, and strict metadata/default-sender refusal. The first case also upgrades a real minimal v1 schema with a pending payload and absent old receipts; no history is synthesized. The archive case injects a SQLite deletion failure after file publication inside the same existing case.

Independent helper review identifies three pre-candidate defects: existing recovery did not flush the verified file descriptor, retirement comparison lacked a 257-row bound, and lexical path checks missed absent journal auxiliaries through directory aliases. All are corrected before candidate verification and the exact published source passes final read-only review. No test matrix or extra top-level case is added.

The eight cases in four named Node files pass candidate one in 0.892 seconds. Build succeeds. The frozen one-time canonical format/lint/typecheck/Worker/Node gate passes uninterrupted in 16.478 seconds: 25 Worker and 27 Node cases, totaling 52 versus 49 initially. No repair, second broad gate, dependency update or Control API/D1 migration accompanies this slice.

## Journal safeguard and source-only image

Before the image change, one read-only SQLite transaction captures the actual regional journal's seven application tables/four rows under schema one. A private local reconstruction exactly matches them and passes integrity checking. No source journal write, remote backup file or credential payload read occurs. This is a local restore sample, not independent node-loss recovery.

One Linux amd64 image build from 54 sealed public Git inputs completes in 23.571 seconds. Fingerprint `f1ab00860c946f375844c433a966c8aca0937ee1de13f16092cdd27e9094dfbf` names local image `docker.io/library/pgcf-regional-dev:receipts-f1ab00860c94`. Verified OCI index is `sha256:73a99f7a7de762b174ceaaa03a2d443a236b93913d13459d89387d41289c05b3`, amd64 manifest `sha256:b49a2c89ce7b905ccee473e9b2de78cc9bc384a3826e1c86e983471bf8c14928` and configuration `sha256:2c03665d69322cb54d528584729d7e3911605376e5bcaf0459a19a8e929fd0de`. The 88,494,080-byte archive SHA-256 is `22159741213365d795e514b4e4b25d10ed77067e0c53db216323da3defebea09`. No private environment/configuration enters the context or registry push occurs.

Network-disabled/read-only/nonroot inspection verifies Node `24.21.0`, UID `1000` and seven selected compiled module hashes against the candidate. One authenticated Talos image import/exact-reference readback completes in 9.167 seconds. A fresh UID/resource-version/old-image conditional image-only patch rolls out in 1.468 seconds. Permission rules and deployment configuration are unchanged.

## Actual upgraded runtime

The new zero-restart Pod matches all seven selected hashes and exposes the strict transport. Its actual persistent journal upgrades to schema two, preserves the sealed source identity and private directory/file modes, retains WAL mode and reports legacy receipt history unknown. Outbox and accepted ledger both remain empty; the same new session's checkpoint advances and the explicit process-restart gap remains visible.

Node UID/boot, source PostgreSQL UID/spec/primary, manual Pooler UID/spec, 27 non-controller active Pod identities/restart counts and all four Bound PV/PVC identities/specifications are preserved. Both existing SQL marker counts remain one. No Control Worker, D1 resource, Secret, customer profile, allowance or database operation is created or modified by this rollout.

Empty managed inventory means no positive customer receipt delivery or archive is claimed. Local cases prove exact payload/metadata retention, capacity handling and crash-boundary behavior; live evidence proves image, safe schema upgrade, journal progress and source preservation.

## Remaining accounting and operational gates

Implement and qualify independently evidenced final allocation intervals, corrections, gap recovery, allowance settlement and fresh funding before resume. Successful acceptance or stop cannot promote provisional facts or invent zero consumption. Off-node archive custody, archive catalog/retention recovery, journal node-loss behavior and physical storage durability remain open; local fsync/checksums are insufficient.

Native API-managed SQL/lifecycle, epoch handoff, automatic idle/wake, independent expiry, resizing/autoscaling, backup/PITR and production isolation remain required. The R2 grant and held SDK/Barman/standalone-SQL/effective-parameter workflows are unchanged. The local environment stays byte-identical/owner-readable/ignored; all 295 public candidate files scan without matching private token/password/key values, and the archived SDK's 22 hashes are preserved.
