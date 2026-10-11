# ULTRA — customer-ready PostgreSQL

Canonical scope and status. Owner coaching of **11 October 2026, 03:30 Europe/Amsterdam**
supersedes the earlier execution order. Customer migration is not yet authorized.

## Fixed scope

Cloudflare owns configuration, placement, progress and provider actions. The retained fleet is
EU control/relay, customer EU1 and customer US1. Preserve all three servers, existing data and
keys; no replacement purchase or EU reinstall. Control receives no new customer databases.

**R1-final is frozen:** the qualified Golden image containing the sandbox DNS/hostname fix,
Talos 1.14.2 and Kubernetes 1.36.5. Its installer and raw image are privately distributed and
fully verified. Further Golden changes require an observed boot or data blocker; other work
belongs to R2. Runtime/platform references are immutable release inputs from the verified lock.

**R1 uses standard PostgreSQL runtime.** A region API switch selects the pool runtime; it is off
for R1 acceptance and EU. US1 enables it deliberately for R2 work. The shared prestarted pool,
Rust runtime and measured first SQL below one second remain mandatory **before migration**.
Pool tests must not block the standard-runtime fleet acceptance.

## Done

| Completed step | Measurement / boundary |
| --- | --- |
| Generic API controls | RAM threshold and purchase switches accepted live; fresh installations buy/send nothing. |
| Credential retirement | US authority and route signer checked; current US custody metadata retains the same keys. EU replacement is prepared. |
| Daily infrastructure backup | D1 and both etcd artifacts fully verified in R2; successful run 232.7 s. Email remains operator-configured. |
| EU read-only preparation | 279 role documents validated; isolated role boot passed in 125.7 s; direct rescue/config/snapshot custody ready. |
| US technical release | Ready at 21:35 UTC via Cloudflare; later operator repairs are counted separately. Database acceptance remains open. |
| Corrected sandbox runtime qualification | AMD64 proof passed: pool claims 10.4/11.5 ms. These are runtime timings, not first-SQL results. |
| Frozen R1-final image | One installer/raw composition: 11.5/28.0 s. Five private immutable objects fully read back; public eligibility remains open. |
| Observed-error class corrections | Generation, host-file activation, Kubelet pin, persistent taint and safe held-target replacement tested; qualified/current delivery varies below. |

## Open — customer readiness

- Deliver one combined region runtime switch and pending public-image authorization correction.
- Approve R1-final immutable references, verify public bytes, then select it with one API request.
- US1 automatic R1-final patch and all six checks, using standard runtime and the original DB/PVC.
- EU1 then control through the same successor intent, prepared EU keys, six checks and no operator interventions.
- Alarm delivery test after the owner configures the recipient/sender through the API.
- Thin storage for new databases, sleeping CPU release, real backup/restore/reclamation and measured density.
- Rust/shared pool on US1: genuine sleeping DB, prestarted claim, first SQL timing and refill; then uniform R2.
- Concrete migration handover: client adapter, timeout policy, restore/new ID mapping, capacity and recovery.

Current US database resources are physically Ready, but first admission remains closed because
the old pool runtime cannot archive WAL. Its original create operation timed out; it is not
recreated, falsely marked Ready or repeatedly reactivated. The standard-runtime transition and
qualified image correction must preserve its owned Namespace, Cluster, PVC, fence and archive.

## Execution order

1. Finish the region switch and public-image correction together. Reuse the frozen Golden bytes.
2. Bind and approve R1-final, complete anonymous image readback, then make one target API request.
   Replace only the quiescent held predecessor; preserve EU hold and all completed receipts.
3. Patch US1 automatically, verify all six checks, then release only the current successor's EU hold.
4. Before EU, close the entire restart class below as one batch. Reuse unchanged preparation;
   repeat a check only for an actual changed input or observed failure.
5. Patch EU1 then control with prepared EU authority. Start EU by **12:00 local / 10:00 UTC**;
   otherwise report the exact blocking error class. Allow one or two programmed reboots per node.
6. After fleet acceptance: alarm test, thin storage/density, US pool first SQL/refill and uniform R2.
7. Deliver handover only after required live results pass. Neon migration is a separate task.

## Restart class — one pre-EU gate

| Changed fact | Required programmed behavior |
| --- | --- |
| Host files | Apply declarations, activate at the supported boot, verify both actual files. |
| Kubelet serving leaf | Refresh the public pin through authenticated identity-bound Talos/Kubernetes; keep strict TLS. |
| Bootstrap taint | Remove only its owned persisted entry for admitted nodes; wait for vendor reconciliation. |
| Boot/Node/cluster identity | Verify fresh boot while retaining Node, cluster, hardware and volume identities. |
| Pool slots / Pod IPs | Respect the region runtime switch, refill only enabled pools, refresh actual routes and observations. |
| Operation deadlines | Preserve original orders/storage and uncertain writes; handle maintenance without expiring valid work. |

## Six checks per node

1. Selected Talos/Kubernetes release and Node Ready.
2. Flux/Helm/platform Ready at the selected immutable revision.
3. Fresh actual RAM and inventory in Cloudflare.
4. Real SQL through `db.ohmyho.st`, correct roles/TLS, deletion and physical storage reclamation.
5. R2 base backup, archived WAL and real restore into a separate target.
6. Existing databases and committed markers preserved.

US intervention accounting retains three historical OS actions, one later operator configuration
apply, public-pin/inventory repairs, one create retry and qualified consumer cycles. A programmed
activation reboot is separate. Do not claim fully automatic US acceptance from those results.
EU has no operator exception. No new server purchase is part of this corrective rollout.

The installation selects actual RAM at76% over ten fresh consecutive minutes/stable physical
Node UID; threshold and automatic purchasing are API configurable. Eligible nodes remain available
during expansion under hard startup/CPU/storage/PostgreSQL/Barman bounds. There is no81% cutoff,
personal email default or fixed purchase cap. Historical real ten-minute RAM acceptance is reused;
new workload density still requires measurement.

Keep Done to one row per completed step, at most one measurement line and roughly15 lines.
Record only final customer-readiness results here; detailed hashes, bytes and intermediate
corrections remain in Git history and protected receipts. Runbooks are English and API-only.
[Runtime design](rust-runtime-and-cold-starts.md) and [operations](../operations) supply procedures.
