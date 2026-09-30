# M3 — Automated encrypted usage-journal R2 custody

Status: source qualified; installation activation remains pending.

## Implemented path

The generic regional publisher schedules consistent source-bound snapshots,
includes the complete retired accepted-receipt predecessor chain, and persists
private upload intent/artifact identity before transport. It resumes the same
artifact after an uncertain response. The Cloudflare Worker rechecks the exact
meter/source/epoch on fresh primary reads and stores immutable encrypted R2
headers, bounded chunks and completion receipts. R2 provider credentials and
master keys stay outside the regional agent.

An installation-authorized recovery client downloads against an independently
retained receipt digest, preserves original SQL/manifest bytes, resolves retired
references by digest under fixed private filenames, and invokes the existing
independent SQLite verifier. Restored custody stays inactive. Optional archive
master rings, including historical keys, survive encrypted control recovery.

Complete local working copies retain the latest two artifacts and up to 256
private descriptor/receipt metadata records after verified remote completion.
Pending or uncertain custody and live source/accepted history are not pruned.
Insufficient scratch space defers publication. Cloud object retention and
independently retained operator receipts require their own installation policy.

## Bounded TDD evidence

The baseline is 45 Worker and 59 Node cases, with six unchanged Go cases retained.
Exactly three top-level cases were added or materially expanded across the fix:

1. One Worker custody story: meaningful missing-endpoint RED; the first
   implementation returned 503. A canonical-sort comparator correction passes
   the complete orphan chunk, late revocation, lost completion reply and guarded
   recovery story. Narrow type/lint corrections precede the frozen candidate.
2. One Node custody story: a loadable deferred workflow fails first. The first
   implementation refuses a noncanonical macOS temporary fixture path; using
   its real canonical path passes the actual HTTP clients, same-artifact reclaim,
   copied session, two retired dependencies and independent inactive recovery.
3. One existing control-recovery story expanded: sealing initially refuses the
   third archive ring. The implementation preserves both active and historical
   archive keys without exposing them in ciphertext output. Old two-ring
   recovery cases remain supported.

Only named files/checks were used during iteration. The single frozen canonical gate passes format, lint, typecheck, 46 Worker
and 60 Node cases in 64.091 seconds. Six unchanged Go cases retain their earlier
evidence; they were not rerun. No stopped qualifier, extra matrix or speculative suite is
introduced by these cases. The two earlier failed implementation observations
remain recorded rather than relabelled as passing runs.

## Installation boundary

Source/configuration checks scan 481 public candidate files against 59
sensitive variants with no matches. Both private environment files remain
mode 0600, unchanged, ignored and untracked; AGENTS.md remains 25 lines.
Frozen source/test hashes are unchanged through the final gate.

This checkpoint creates no live R2 bucket, Worker Secret, binding, controller
configuration, deployment or customer environment. Existing private environment
configuration and held source candidates are preserved. Admission stays closed
and the 4,096 refused live journal facts are neither accepted nor rewritten.

Live scheduling, independently retained keys/receipts, actual R2 round-trip and
fresh offline restore need installation evidence. Fenced node-loss collector
activation, finalized usage/settlement, runtime enforcement, PostgreSQL backup/
WAL/PITR, the native pilot and remaining M1–M8 gates remain incomplete.

The [contract](../contracts/usage-journal-r2-custody-v1.md) defines wire bounds,
operator configuration, authority, encryption and inactive recovery semantics.
