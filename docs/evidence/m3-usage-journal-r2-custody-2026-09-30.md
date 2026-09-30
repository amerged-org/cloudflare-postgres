# M3 — Automated encrypted usage-journal R2 custody

Status: source qualified and delivered in Dev; production qualification remains open.

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

## Verified Dev delivery

Public source `91295569b825862d2cb6b8be2810a57caaaf6cae` is deployed in Dev.
The Worker serves version `d5459289-fbe4-4a39-a3ec-536bf276d2ca` at 100% traffic
with one private EU R2 binding and one dedicated archive Secret. The previous
eight Secret names/types remain intact. Before activation, a fresh 50-table,
356-row control capture was encrypted and independently restored with all three
keyrings byte-for-byte, including the new archive ring. Secret values were never
queried from Cloudflare or sent to the regional node.

One dedicated EU bucket was created with r2.dev access disabled and no custom
domains. One Worker deployment preserves existing variables. An initially
unexpected Secret-write response was resolved by metadata readback, without
replaying the write; later decryption of an actual stored encrypted header with
the independently retained ring proves the installed key matches. An inherited
summary constant reported eight Secrets despite its verified nine-name list;
the retained metadata corrected that reporting field without rerunning delivery.

The sealed public Linux image contains 79 verified compiled modules and the
unchanged resource-envelope package. Its 88,569,344-byte image archive was
imported once. One guarded main Deployment patch changes only the image and adds
the optional private archive configuration reference. The nonroot configuration
and working directory are private on the existing persistent volume. The actual
resident scheduler, configured at 60 seconds, completes two distinct verified
archives; no separate manual publisher is launched.

A single operator-authorized HTTP recovery downloads an actual completed R2
archive into an exclusive off-node private directory in 2.763 seconds. The
3,076,096-byte SQLite file and original six-field manifest match the independently
source-held receipt digests. All nine tables, integrity, foreign keys, original
identity, exact payload/byte-count hashes, 4,096 pending facts, zero acknowledgements
and zero accepted receipts are verified. The captured post-restart session is
checked separately; normal gap/checkpoint clocks are not falsely required to
match the earlier session. Restored custody stays inactive.

Post-delivery readback matches all 79 compiled modules and preserves the other
29 Running Pod identities/restarts, Node/boot/runtime identity, five PVCs and six
PVs, CNPG/Pooler specs and both SQL markers. Main configuration/RBAC/ServiceAccount,
the suspend worker/initializer and the private empty provisioning sibling remain
unchanged. Source epoch and all 4,096 refused facts remain unchanged.

## Remaining qualification

This proves automatic off-node custody and inactive recovery in the observed Dev
window. Sustained cadence/outages, larger capacity and retention policies,
independent disaster bootstrap and fenced activation of a restored collector
still require evidence. No usage fact is acknowledged or billed by archiving.
Final usage/settlement, runtime budget enforcement, PostgreSQL backup/WAL/PITR,
the ordinary native pilot and the remaining M1–M8 gates stay incomplete. Held
backup, signing, native, SDK and admission qualifiers are not resumed.

Private environment files remain owner-only, unchanged, ignored and untracked.
No runtime/source/test edit or repeated full gate accompanies this delivery.

The [contract](../contracts/usage-journal-r2-custody-v1.md) defines wire bounds,
operator configuration, authority, encryption and inactive recovery semantics.
