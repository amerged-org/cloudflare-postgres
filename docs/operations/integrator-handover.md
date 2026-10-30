# Integrator handover

For the engineers of an integrator who create their databases on PGCF through its API and operate
them without reading PGCF code. You know PostgreSQL and Neon.
This runbook states what is different, which limits you must enforce yourselves, which values PGCF
has measured and what is not available yet.

Every statement is derived from the code and contracts of this repository; Appendix B lists where,
and Appendix C lists what the served OpenAPI document states in words rather than in schema.
Behaviour without a live acceptance is marked **not yet verified**. A number is of one of four
kinds, and the text says which:

- **Measured** values carry their date and the title of the row of the
  [ULTRA plan's Done table](../architecture/cloudflare-convergence-and-serverless-plan.md#111-done) that records them, in quotation marks, or name the dated ULTRA update.
  PGCF publishes new measurements only in that canonical plan.
- **Decided** values are an owner decision ([11.3](../architecture/cloudflare-convergence-and-serverless-plan.md#113-owner-decisions-taken)) or a plan
  default ([11.4](../architecture/cloudflare-convergence-and-serverless-plan.md#114-design-decisions-taken-in-this-plan),
  [11.5](../architecture/cloudflare-convergence-and-serverless-plan.md#115-decisions-open-for-the-owner): work proceeds on the default unless the owner
  says otherwise).
- **Extrapolated** values are computed from a measured sample, not measured themselves; the text
  names the sample (the node-loss total of [7.3](#73-recovery-time)).
- **To be measured** marks a value that no measurement has produced yet; the text names the plan's
  stage that will.

A name or a rule that the plan does not record yet is marked **pending**, with the reason.

Values that are installation configuration rather than code (node policy, alert thresholds, rate
limits) are labelled as such; the operator reads them from the live installation.
[Section 9](#9-values-for-production-acceptance-and-handover-go-live-gate-g11) lists every value that go-live
gate G11 asks for in one table, with its kind, date and source. The plan's
[go-live gates](../architecture/cloudflare-convergence-and-serverless-plan.md#stage-7-go-live-gates) are the authority on what still blocks go-live;
operator procedures are in the other runbooks ([recovery](recovery.md),
[credentials](credentials.md), [infrastructure backups](infrastructure-backups.md)).

## Integration contract 1.5.0 — delivered, 2026-10-26

Contract 1.5.0 is live: signed native release `sha-6aee8263071e` runs on both nodes, migrations
0090 to 0094 are applied and API version `c0d24652` has served the contract since 20:10:05 UTC
(the control plane was in maintenance from 18:59:11, 1 h 10 min 54 s). The dated receipts, the
bounded live check on US1 and one unexplained `power_busy` refusal of a suspend issued right after
the last client closed are in the
[ULTRA plan's Done table](../architecture/cloudflare-convergence-and-serverless-plan.md#111-done),
row "Integration release delivered to both regions and the control plane (2026-10-26)". Confirm
the installation's served `/v1/openapi.json` before using the new fields. The accepted latency
exception and prohibition on new general speed/restore campaigns remain unchanged.

The release adds exact MiB storage, restricted role memberships, independent alert destinations
and recovery notifications. These are generic platform capabilities; adopter classes, prices,
wallets, customer migration and the end of adopter-to-Neon traffic remain the adopter's work.
The owner-approved G10 catalog follow-up completed on 2026-10-26 at 15:26:51 UTC.
A complete three-page inventory found zero live references to the six historical `dev-*`
classes and `small`; all seven were disabled through the management API and read back.
The referenced `rp-*` profile remains enabled with 108 live database references, alongside
101 `xs` and one `sm` database. No database, key or archive was deleted. New adopter classes
still require the qualified extension release and their own exact catalog readback.

**Operator deployment order.** Qualify the exact commit with the existing CI and signed image/
native-release workflow. Stage the management Worker version without routing traffic to it,
then update both existing nodes to the same qualified native release through normal release/OS
convergence; no reinstall is required. Read back the actual release, process and OS identities.
For the D1/API switch, activate that same qualified API source first with the operator binding
`CONTROL_PLANE_MAINTENANCE="on"`. It serves pre-authentication/pre-D1 HTTP 503 `service_unavailable`
in the normal versioned error envelope with a request ID and `Retry-After`,
the maintenance header and actual Worker version; refuses new admission and mutation RPCs;
and defers independent watchdog, warmer and node-sample alarms without reading or writing D1.
Those alarms keep their next wake and local state. `control_maintenance_hold` records the source
and Worker version of each deferred producer. Native control links reconnect after maintenance;
existing tenant SQL sessions remain native and are not stopped, but new connections are refused.
The paused source can run against either schema because the HTTP gate and actor D1 guard run
before schema-dependent work. Removing the minute cron alone is insufficient.

Confirm the paused version and its producer holds, and drain old invocations and existing Workflow
instances to terminal states before touching the schema: a new binding cannot stop an already-running
old invocation. A temporary Workflow pause may help inspection, but does not upgrade pinned code;
never resume an old schema-dependent continuation after `0090`. Any nonterminal old instance needs
explicit compatible forward handling before the migration may proceed. New Workflow runs are refused
at their entrypoint. Snapshot the trigger/Workflow state and record the drain evidence outside D1.
Apply migrations `0090`–`0094`,
and activate the identical qualified source with maintenance off. Migration
`0090` drops the old GiB columns: the old API cannot run against the migrated schema. Treat the
switch as a brief management-API interruption, not as a zero-interruption deployment. Restore
compatible producers only after matching schema/API readback and operational-health checks. Keep SQL writes
out of any separate customer cutover until that migration's own checks pass.

Set `NATIVE_EXTENDED_RESOURCES_RELEASE_IDS` to a JSON array containing only signed release IDs
whose actual native binaries are qualified for MiB storage and membership options. The default
empty array refuses extended operations. Their admission checks current signed release, fresh
node observations, regional assignment and OS convergence. The first extended database/role
mutation raises a durable regional format floor; later resizing, deleting the role or deleting
the database cannot lower it. Do not roll back to an API before `0090`, or to a native release
outside the qualified allowlist after that floor is raised. Restore/move/desired-state delivery
also preserve these constraints. Keep newly provisioned nodes on the same qualified image and
release. Complete the focused small-volume and temporary-login checks before exposing adopter
classes; no new purchase or customer write is implied by this documentation.

## Current release decision — 2026-10-26

The owner accepts the existing cold latency and has cancelled all further speed tests, including the additional EU diagnostic and final 1h/24h campaigns. G3 is an **owner-accepted exception**, not a measured subsecond-p95 pass. The failed EU 1,516-ms / US 452-ms six-statement phase and later EU 563-ms diagnostic remain recorded; the cause of the outlier is not proven. Do not promise p95 below 1,000 ms. Cold/warm are the only existing-database states; first creation until Ready is separate.

G1, G2 and G4–G10 reuse their accepted evidence. Operational closeout passed October 26 at 10:45 UTC: all 419 own test databases and their volumes/accounts are removed; nine legacy test keys are revoked/read-confirmed, with zero usable keys in the test-population project. Current release/OS/process, readiness, placement and backup checks passed. Merging this accepted ULTRA/handover record closes G11. No new test campaign, schedule, purchase or customer migration is part of closeout. See the [current execution order](../architecture/cloudflare-convergence-and-serverless-plan.md#owner-approved-shortest-path-to-g11--2026-10-26). Once closeout completes, PGCF can be released for the separately planned ohmyho.st connection and Neon migration, with the documented latency exception.

## Operating snapshot after closeout — 2026-10-26

Both nodes retain the same signed `sha-acb21e26e064` release, actual accepted agent digest and OS pins. API `a058ba8b-ce24-4bc4-895e-90e51a902644` and Edge `ae7f06a2-5362-4d84-bfdb-74e22c3c0866` are unchanged at 100%. Current regional capacity previews are `idle`: each region can place the smallest offered class; no node was purchased or database created by the check.

| Snapshot | EU1 | US1 |
| --- | --- | --- |
| Allocatable CPU / memory | 6,000 millicores / 11,966 MiB | 6,000 millicores / 11,966 MiB |
| Free pool bytes, last closed 10:40 UTC sample | 291,297,296,384 (271.292 GiB) | 307,368,689,664 (286.259 GiB) |
| Native pool data use at 10:41 UTC | 6.27% | 1.10% |
| Owned test databases removed, with physical confirmation | 119 | 300 |
| Unlisted databases preserved, all reporting backup health `ok` | 192 | 18 |

These are dated headroom observations, not workload-concurrency guarantees. CPU/awake-memory, storage, starts, session counts and buffer budgets still constrain admission. The October 26 daily infrastructure backup completed at 00:00:55.673 UTC on attempt 1; control cron is healthy and neither node has an archive-ready backlog in its latest sample. Existing regional healthy archive-point bounds of 53.393/54.674 s remain observations, not unconditional RPO guarantees.

No owned performance producers or cleanup processes remain; both nodes have no acceptance R2-denial table or guard unit. The only active infrastructure-alert episodes in the final read are the retained unexpected-reboot records from the owner-authorized October 25 hard cuts (EU 16:30 UTC / US 20:05 UTC). Exact current boots and services match accepted recovery, so those historical episodes were documented, not suppressed. Manual/unlisted databases, other project credentials, administrator credentials and R2 archives were preserved. Standard XS/SM classes remain available; no unproven test-class ownership was inferred.

One cleanup DELETE failed during a Cloudflare connection loss; a later intent was refused while the durable admission barrier awaited normal repair. Read-only checks proved no delete commit. Only after a positive ordinary fence advanced the epoch was a fresh intent accepted; original failed attempts remain retained. An admin mutation can therefore be refused temporarily during repair/publication. Do not blindly replay an uncertain write or manually remove its barrier; reconcile the operation, generation and idempotency authority first. This observation is not a repair-time SLO.

## Read first

The [dated ULTRA update](../architecture/cloudflare-convergence-and-serverless-plan.md#production-readiness-update--2026-10-24)
is the authority for current scope and measured results; older deployment rows are history.
API is from qualified main `2b007721`, Worker version `a058ba8b-ce24-4bc4-895e-90e51a902644`
(full workflow `40274237444` attempt 1, including signing; API delivery October 26 05:52:41 UTC);
Edge remains on compatible `434f47d4`, with migrations through `0089` applied.
Both regional nodes now run qualified signed `sha-acb21e26e064`, main
`acb21e26e0647c0d565cc209cfb7682b36eb7129` (full workflow `40245152144`, attempt 1).
The October 26 00:23:05.906 UTC barrier verified actual agent bytes/current links and
ready/placeable/OS convergence: US revision 13, PID 70170; EU revision 12, PID 80587.
Each had exactly one expected agent restart, with gateway, Tunnel, mount holder and boot unchanged.
US boot is `14a628e6-0f57-4f2f-89e1-ab96565455fa`; EU boot is
`4db3fa4b-a958-4691-9457-652ebd838d3c`. Spec SHA-256 is
`0ff6bddcd464cbcaf77fc7d1ec9f0b6491020ac3312dd0a30420e1ade00f130d`;
the 27,466,384-byte agent is `3f89f7a3b0e8c636ef0b9c88628e58990abe2b8195f062b6a5b51c8767c07e1e`.
Barrier SHA-256: `4769c6007bc444c866c6ea92f25b301201a111f114d2979b2fe92d80168a86b5`.
The agent ready hot list is Off; program warming is On, bind prefetch Off, PostgreSQL autoprewarm
On and PostgreSQL configuration unchanged. The scoped agent DataLock explicitly unlocks its own
open-file description; PostgreSQL's separate lifetime lock is unchanged. Other binaries and OS pins match.
The preceding `sha-af03b0a3b37a` configuration-cache correction passed its minimal checks on both
regions: cold/warm marker timings were US1 577.755/433.726 ms and EU1 355.308/169.066 ms
(one attempt each, not G3). Cached hashes and files matched before and across the first cold wake.
All four temporary databases/LVs/accounts and four keys were cleaned at October 25 22:08:39.974 UTC.

The prior `sha-f0e7090629fe` proof-recovery and hard-cut receipts below are historical acceptance,
reused for unchanged behavior. Fixed Prefetch Off, other binaries and signed OS pins are unchanged.
Future servers use the same signed golden image/release/OS pins; verify each node's identity,
routing, storage and health, and reuse shared product acceptance.

Both nodes now have matching signed kernel/package/host-file pins and `os_converged=true`.
Neither maintenance cycle required a reboot. US1's server cycle took 25.166 seconds;
EU1's loaded cycle took 79 minutes 19.188 seconds while draining 69 due base backups through
the configured single big-job slot. Both post-maintenance data comparisons matched, and all
maintenance-owned keys/processes are cleaned. These different measured loads do not establish
a universal maintenance duration.

The corrected API and native runtime passed all four original provider restore paths on each
region: positive same-identity PITR, retained-history/new-ID restore, normal new-ID restore and
negative forward rollback, including cached credentials, original data and actual first-DONE-before-Ready
ordering. EU1's single small-fixture suite also passed transport, roles, extensions and snapshot
export/import; all three owned databases/volumes, its key and processes were cleaned after native
receipts finalized. US1's earlier valid four-path receipt is reused without rewriting its old
collector failure. The extra post-terminal manual-suspension probe is outside the agreed gate;
it was unmeasured in that US run and passed incidentally in the same EU run, without a new campaign.

The US1 product subset passed ordinary ANALYZE, actual autovacuum, expression-memory/remedy,
SM resize and manual suspend (`57P03`) followed by explicit resume. Actual XS/SM leaf limits are
recorded in [4.2](#42-awake-databases-what-a-sold-memory-size-means). One oversized ANALYZE
returned `57014` after about 63 seconds before any kernel OOM; that branch is inconclusive for
OOM and is not repeated. The run recorded 686 acknowledged intents; subsequent checks matched
100 source markers and all 337 witness rows. No unknown write, owned key or process remained.
This does not promise arbitrary SQL fits in 256 MiB. The required subsequent storage/fault receipts are recorded below.

EU1 passed full-volume and inode-exhaustion recovery on the same four owned fault fixtures.
The volume reached `ENOSPC` after 1,976,037,376 bytes with zero space available. Its 2-to-5-GiB
growth reported 5,364,514,816 storage bytes while the filler remained; `statvfs` then showed
5,334,786,048 usable filesystem bytes and 3,225,067,520 available. All 29 acknowledged writes
matched exactly. The inode case exhausted all inodes after 31,439 files while 2,008,788,992 bytes
were still free, then passed the same growth and observed-size check with all 109 acknowledgements
exact. Both fillers are removed, with zero unknown outcomes, losses or duplicates.
The owned volume/inode fixtures were deleted, with their LVs/accounts verified absent at
16:37:51.305 UTC. EU all-four fault-fixture cleanup later completed at 19:53:19.635.
US1 also passed full-pool and combined R2/hard-cut acceptance: exact 1,789 and cumulative 1,875
acknowledgements, respectively, with all five owned fixtures/LVs/accounts and their keys/processes/
injections clean at 20:22:42.053 UTC. No additional storage/fault matrix is required for this closure.

The earlier bounded US restore batch had three per-job memory-limit failures during extraction,
before PostgreSQL recovery. Its failed targets were deleted with verified API/physical cleanup
and preserved lineage; that G9 run is aborted and reconciled, not passed. The affected replacement
on `sha-eb9d0f729663` reached Ready and matched all seven counts and bit-xor fingerprints
(533,386,943 bytes) at 14:55:08.622 UTC; its key is revoked. Natural idle sleep was proven at
15:00:15.373 UTC and the Hibernate operation completed at 15:00:15.958. The scoped observer found
no matching loaded job unit, so actual MemoryHigh, peak and OOM/event counters could not be
measured; the reason for the unit's absence is not established. The successful restore/data proof is valid; no native
pressure-counter pass is claimed. The later bounded G9 queue/restart case below has passed;
no additional restore is required solely to replace that earlier missing observation.

At 17:10:50 UTC, existing US1 members 037–045 passed bounded G9 queue/restart acceptance.
Eight witnesses queued for at least 1,295.808 seconds. The agent was killed during fetch at
16:48:16.995245 UTC and during post-first-backup/Ready adoption for 045 at 17:03:25.751402.
The latter kept backup `20261025T170027` with no refetch; all nine full fingerprints and natural
sleeps passed. All 59 US1 members subsequently reached the full-data/natural-sleep barrier at
17:47:03.377 UTC, with a minimum dataset size of 533,378,751 bytes and run keys/processes
closed/lock free. Original 001–017 subsequently completed their exactly-once `SELECT 1` and fresh
natural-age proofs at 18:21:44 UTC, without another full-data verification. This is not a final cold-gate pass. The earlier real-PostgreSQL `Resume::Finish` regression remains
valid; no fresh live interruption of the narrow DONE-before-listing window is claimed.
The required Stage 5 agent-kill timing is qualified by the EU 2,274.224501-ms successful-SQL
receipt. US G9's two actual restarts/adoption qualify US broken-agent recovery; US first SQL
below 3 seconds was not measured and is not an additional regional timing gate.

EU1 also passed the combined R2-outage/provider hard cut with exactly one stop/start. The guard
persisted over reboot and recorded nine denials afterwards, then was removed at 16:31:22 UTC.
All 1,057 acknowledged writes matched exactly; the five explicit refusals and the single
uncertain write at sequence 809 were confirmed absent, without replay. Archived segment `1F` covered pre-cut LSN `0/1D0015E0`. Guard/table/timer/file,
writer, key and process cleanup was clear at 16:33:29.794 UTC, with healthy native control.
These results do not make archive timeout plus upload an unconditional outage RPO guarantee.

The owner reduced remaining acceptance to small disposable Dev fixtures with synthetic data.
An additional old historical fixture and deliberate OOM are outside the critical path; honest
failed/inconclusive receipts stay preserved. Guarded archive repair is complete for 279 prefixes
(251 nonempty, 2,833 verified objects / 4,772,644,496 bytes; 28 explained empty prefixes), with no
unsettled PUT. Active backup dependencies must still be preserved. Exact-owner API lease fencing
is deployed; it never authorizes automatic replay of uncertain SQL, provider calls or one-time secrets.

The bounded EU prefetch A/B selected Off: 29 Off requests had p50/p95/max 566/964/1,995 ms;
30 On requests had 524/4,126/7,387 ms. All completed, but three were at or above 1,000 ms.
Its rapid diagnostic cadence accumulated warm databases, so this is not G3. The final protocol
is 150 seconds between requests and at least 59 per region per one-hour/24-hour stratum, with
zero errors or requests at or above 1,000 ms. Bounded G9 queue/restart acceptance passed;
the required combined R2/hard-cut cases passed in both regions. All five US and four EU fault fixtures are physically
clean. The full 241-target US density barrier passed at 21:19:40 UTC, with all 221 other
density/background databases naturally asleep; this is not a one-hour/24-hour cold-gate pass. Root has accepted the required EU proof-recovery
path; G11 is not ready and this phase performs no customer migration. Regional healthy archive points are now observed; final cold measurements remain; the US operating-envelope snapshot is recorded below.
This delivery ends with verified generic PGCF readiness and this handover; OMH implementation,
customer connection/data migration and its control-database migration follow separately.
No 72-hour canary or written integrator acknowledgement is required for G11. The owner also
waived operator-contact and maintenance-lead-time completion as G11 gates on October 25.

| Topic | Latest recorded state on 2026-10-26 |
| --- | --- |
| Runtime | Both nodes run signed `sha-acb21e26e064`, spec `0ff6bddcd464cbcaf77fc7d1ec9f0b6491020ac3312dd0a30420e1ade00f130d`, agent `3f89f7a3b0e8c636ef0b9c88628e58990abe2b8195f062b6a5b51c8767c07e1e`, with actual process/OS convergence at October 26 00:23:05.906 UTC. US revision 13/PID 70170 and EU revision 12/PID 80587 each needed one agent restart; other services/boots/pins stayed unchanged. Agent hot list Off, program warming On, bind Off, PostgreSQL autoprewarm On; PostgreSQL configuration unchanged. Required product/storage/recovery and US density evidence remain accepted. The fresh r2 phase failed at 01:44:14.348 UTC on its fourth EU cold request (2,036 ms, versus US 293 ms). All keys, writers and pressure readers are clean; no p95/pass is certified. The first acb one-hour G3 run failed at 00:26:28.283 on an unacknowledged background attempt; a single warm read later found the uncertain increment absent at that read, with no terminal commit conclusion or replay. Final one-hour/24-hour gates, cleanup and handover remain open. |
| EU agent restart | The October 25 15:06 UTC SIGKILL check on final `sha-eb9d0f729663` passed: first successful public client SQL within 2,274.224501 ms, agent exit 11.689326 ms, 30/30 probes successful. All 254 acknowledged intents matched exactly; 12 explicit write refusals were absent, with no unknown/lost/duplicate/payload errors. Three writer postmasters, gateway, Tunnel and mount holder stayed unchanged, with exclusive locks/adopted slots and no overlapping writer. Own keys/processes are cleaned. The same four non-cohort fixtures also passed the EU storage and combined outage/hard-cut cases; their later cleanup is recorded above. G3 and remaining regional acceptance are not certified by this receipt. |
| First request after a wake | The whole request is one HTTP `/sql` transaction of six statements, sent from a Worker over the public hostname. After about 50 h asleep, 59 samples on 2026-10-23: p50 948 ms, p95 1,583 ms, 26 of 59 at or above 1 s. After 1 h or more asleep, 59 samples on 2026-10-20: p50 1,126 ms, p95 1,814 ms. **The go-live target, whole-request p95 strictly below 1,000 ms independently in each region, is not met yet** ([3.4](#34-timeouts-and-retries-for-a-sleeping-database)). The first acb one-hour phase failed at October 26 00:26:28.283 after its first individual cold requests of EU1 617 ms / US1 275 ms (n=1 each). A separate background write returned unknown `08007`; its increment was absent at a later owned warm read. The original unknown is retained without a terminal commit conclusion. This is not p95 or a gate pass. |
| Backups | Every database archives its WAL and base backups into the installation's one R2 bucket, which is in the EU jurisdiction, for both regions (cutover 2026-10-23). A new database is ready only after its first base backup is DONE. The four production classes keep a 7-day recovery window. The scheduled infrastructure backup of 2026-10-24 also completed in the new bucket; G6 remains closed ([2.7](#27-backups-restorable-window-and-restore), [7.2](#72-recovery-point)). A US healthy archive witness used acknowledged sequence 42; segment `009` remained open after 180 seconds. R2 object metadata later gives a 222.799-second ACK-to-Last-Modified wall-clock difference, with one-second precision and uncalibrated clocks; the observation-gap upper bound is 1,835.597 seconds. These do not establish an unconditional RPO guarantee or a latency SLO. One healthy point per region has now been observed during the r2 background workload before its later cold-gate failure: EU 53.393087333 s and US 54.673786958 s acknowledged-attempt-start-to-operator-positive upper bounds, not ACK-response/upload latency or unconditional RPO. No cohort SQL, WAL switch, replay or extra write was used; the bounded observer processes exited. |
| Redundancy | One node per region, one PostgreSQL instance per database, no replica, no second node in a region. Losing a node stops every database on it until it is restored from R2 into new IDs. **Extrapolated** on 2026-10-23 for EU1's 167 databases and 23.4 GB of archives from a sample of 8 restores, of which 7 became ready: about 2.2 to 3.4 h in all, if every restore succeeds. The eighth failed `archive_unusable`; the total assumes every restore succeeds, which that sample did not establish; later restore fixes are deployed and bounded G9 queue/restart acceptance passed on October 25; the extrapolated total is still not a full-node recovery-time guarantee ([7.3](#73-recovery-time), [7.4](#74-eu1-lost)). |
| Capacity numbers | The October 25 14:54 UTC EU1 snapshot had 311 nondeleted databases and 312 thin volumes, with none awake/starting/queued. The extra `pgcfcheckscratch0000/g1` is the intentional reusable 1-GiB health-check volume; keep it outside tenant cleanup. EU's required storm/recovery path is accepted. US1's full 241-target density barrier completed at 21:19:40 UTC: all creates succeeded, all 221 other density/background databases were naturally asleep, no active database operation or producer remained, and the lock was released. Its baseline was 318 nondeleted/zero awake: 316 auto-idle plus two manually suspended; legacy raw `provisioning` labels are not errors. The protected 59 checkpoint is unchanged (`4b8b6c62…`); 30 hashes present/29 empty were recorded without SQL, wake or backfill. See the dated ULTRA density checkpoint for full manifest/binding/barrier hashes. |
| US operating envelope | At 21:19:02 UTC: 6,000 millicores/11,966 MiB allocatable; pool total/used/free 310,776,954,880 / 92,948,070,400 / 217,828,884,480 bytes; metadata used/total 48,865,280 / 1,073,741,824 bytes. Nominal storage 1,195,074,650,112 bytes, 48,033,169,408 bytes below the 4× cap. Policy read at 20:26 UTC: 9,937-MiB awake budget, 600-MiB floor/8-MiB overhead, 8 starts, 10-second queue/5-second retry, one big archive job, 6-GiB reserve. XS: 256 MiB/250 millicores/2 GiB/20 PostgreSQL connections. The October 26 check confirmed native fixed count ceilings of 2,000 total/200 per database and default accounted byte budgets of 192/96 MiB on both nodes; these are not measured usable concurrency or RSS guarantees. These are dated capacity/configuration observations, not a cold-latency pass. |
| EU storm | Preserve the first 39/40 failure and later 40/40 HTTP result (p95/max 4,373.5/14,315.8 ms). On the qualified proof fix, four verified affected-only kills gave 4.455963-second automatic Ready versus 604.210285 seconds before. Proof preceded normal marker wake, bounded above by 7.428105 seconds; marker/data and natural sleep matched. Root accepted this required path. The helper safely aborted before a fifth signal with an unrecorded identity-field change, exit 1 preserved; no clean helper exit or extra case is claimed. Reuse unchanged one-hour/1,000-cycle/transport evidence; no additional WS or US 3-second matrix. |
| New databases | Every database lives on a thin LVM volume of its node, placed by the 80 % rule of [2.1](#21-create). When no node qualifies, `POST /v1/databases` and restores are still accepted and the database waits unplaced. After a burst of awake databases a node stays closed for the length of the placement window: 3 days (owner decision O6 of 2026-10-23; deployed in baseline B, [2.1](#21-create)). |
| Alerts | Infrastructure alerts go to the operator's alert webhook and the owner receives them (go-live gate G5 met on 2026-10-20); you receive none from PGCF ([6](#6-alerts-and-operations)). |
| Your key | The October 24 live access checks passed: cross-project resources returned 404, read-only admin writes returned 403, and rotation left the revoked key at 401 and its successor at 200. Run-owned keys were revoked. This closes the exercised G10 access subset; production catalog and dependent population cleanup remain open. |
| Maintenance | Maintenance closes placement, holds wakes with `57P03`, proves every awake database asleep and reboots only when required. On October 25, neither node needed a reboot: US1 completed in 25.166 seconds; loaded EU1 took 79 minutes 19.188 seconds while draining 69 due backups. Exact post-maintenance data and signed OS pins matched on both, and owned keys/processes were cleaned. These are measured loads, not a fixed outage bound. From production acceptance onward reboots use an announced window, with kernel security reboots pre-approved within 7 days, one node at a time. The default window is Tuesday 02:00–04:00 UTC until the owner names another; the operator forwards the announcement ([7.1](#71-what-happens-in-each-situation)). |

The EU post-fault recovery exposed a product defect: after the last PostgreSQL kill at
17:35:38.826 UTC, the proof poll waited for its 600-second archive budget without checking the
closed client. PostgreSQL recovered automatically at 17:45:43.036583 (604.210285 seconds);
proof completed at 17:45:48.358 (609.532 seconds). One separate exact marker read at
17:47:49.990–17:47:50.798 took 807.418 ms and matched. Its key was revoked, without manual
resume/restart or write replay. Cleanup completed at 17:51:38.494: 41 natural sleepers, 32 pool
slots, zero unknown entries, stable control/boot, no fault injection and owned keys/processes closed.
The targeted five-line `proof.rs` candidate returns `Unknown` when the client is closed.
A real-PostgreSQL regression failed first at 5 seconds; all 10 proof tests, formatting and
all-target Clippy then passed, with independent review clear. It is now qualified/deployed.
Root accepted the affected required path: the 19:02:27.571871 kill was followed by automatic Ready
at 19:02:32.027834 (4.455963 seconds), proof before normal marker wake (7.428105-second upper bound),
and exact marker plus fresh natural sleep at 19:03:37.392/generation 12. Owned keys/processes/faults
were clean. The helper retained exit 1 after safely refusing a fifth signal with
`postmaster_identity_changed`; its changed field was not recorded. No clean helper exit is claimed.
US pool/R2-hard-cut acceptance, owned cleanup and density subsequently passed; final regional cold gates are still open.

**Historical af03 attempt and correction — 2026-10-25:**

The first declared-load one-hour pair on af03 stopped at EU1 1,295 ms versus US1 296 ms
(one complete six-statement public request each, AMS). This is a failed zero-miss attempt,
not a qualified p95. The joined trace attributes EU 867 ms to the native gateway, 38 ms to
its transport envelope and 29 ms to Edge work; 361 ms remains outside the instrumented Edge
handler and is not proven TLS delay. US is 148 + 119 + 22 + 7 = 296 ms. Both Actor handlers
were hot at 0 ms, and all 36 recorded warmer cycles completed without failure or overrun;
no warmer adjustment is supported. Both loads, all keys and pressure readers were cleaned.
The performance candidate disables only the agent's optional ready-list readahead to evaluate
observed I/O competition. PostgreSQL autoprewarm, program warming, bind Off and PostgreSQL
configuration are unchanged. The existing 16 readahead tests and scoped checks pass.

PR #13's first CI attempt failed during an initial test create. A deterministic regression
then reproduced an agent guard's lock surviving its scope through an inherited descriptor.
The minimal explicit-unlock correction passed all 34 slot tests, the exact real-PostgreSQL
move test, formatting, all-target Clippy and independent review. PostgreSQL's separate
lifetime lock is unchanged. Full CI/signing and regional qualification remain pending;
no live performance improvement is claimed yet.

**Current signed rollout and measurement — 2026-10-26:** corrected PR #13 CI `40243216160`
and full main `40245152144` attempt 1 passed; the original failed `40241752915` remains failed.
Registration verified the signature and every pin. US's single assignment was accepted on
October 25 at 23:59:31 UTC (12→13); EU's on October 26 at 00:02:30.375 (11→12).
EU's slow first-binary transfer and expired 13-minute read-only observer remain recorded;
a later independent actual-process/OS barrier passed at 00:23:05.906 with no reassignment,
manual staging or forced restart. The later resource snapshots already had the new process,
so the historical slow-transfer cause remains unproven. The actual one-hour G3 phase began
at 00:23:49.943 UTC and failed at 00:26:28.283 with `background_unacknowledged_attempt`.
Its first individual six-statement cold requests were EU1 617 ms / US1 275 ms, n=1 each;
these are not p95 or a gate pass. EU background database `szk21izt40x62f0jmfb2`, run
`g3hotlisteu10251h`, attempt 73 returned unknown `08007` after 2,101.205 ms at
00:26:18.209733. One owned read while warm at 00:30:48.629 returned n=2, matching latest
acknowledged attempt 53. Unknown attempt 73 would have produced n=3; its increment was absent
at that read. Preserve the original unknown without replay or a terminal commit conclusion.
Cloudflare CID `a2fd374b-a1d9-47d1-ad99-be81d94f24c4` reports 520/`08007`, 2,036-ms gateway
timing and 8-ms admission. None of the nine selected native-window rows matched the database
or CID; no source/product fault is established. Fresh EU ready/OS state and controls remained
healthy, with keys/readers clean. Reconciliation-summary SHA-256:
`a9fc59b5d2212985fd2bf67b1ac9c274285d1e41ba1723096a69cc118a0ad180`.
The individual total/native/wake/auth/query timings were EU 617/503/258/37/204 ms and US
275/98/67/8/22 ms, n=1 per region; no distribution is qualified.
All three phase keys are revoked. Pressure coordinator 17224 closed at 00:26:36 without
errors; all pressure readers and SSH sessions are closed. The original failed phase retains
`cleanup_errors: ['eu-dev_background_cleanup_or_outcome_unconfirmed']`: the semantic
outcome is still unconfirmed; this does not mean a key leaked. Final one-hour/24-hour gates,
dependent cleanup and handover remain open.

**Next fresh G3 phase — prospective rule dated 2026-10-26:** every required cold first request
(at least 59 per regional stratum) must still succeed below 1,000 ms, with zero errors.
The additional all-background-writes-acknowledged helper rule is being corrected for a new
phase with fresh r2 labels: at most one write `08007` unknown per region per phase is allowed,
with every uncertain attempt, duration and acknowledgement/unknown-derived counter bound retained.
There is no replay or catch-up; only the next distinct normally scheduled transaction proceeds.
Setup failures, refusals, other faults, a repeated unknown or a data/counter mismatch stop the run.
All 20 background databases per region must remain active at one transaction per 30 seconds each.
The old phase stays failed. The next one-hour phase requires the consumed first IDs' fresh
completed natural Hibernate proof plus 3,660 seconds; the 24-hour phase uses actual 24-hour sleep.
The corrected private generator passed its failing-first regression, three background-policy checks, nine unchanged cold guards and independent review. This was recorded before the fresh r2 launch below; it establishes no p95/pass. Fresh operation receipts place the earliest common one-hour eligibility at October 26 01:32:20.874 UTC, provided both consumed databases remain cold; their current/observed generations are EU 40 and US 8. No forced wake, age reset or clock adjustment is used.

Existing-database latency has only **cold** (PostgreSQL sleeps and the request wakes it) and
**warm** (PostgreSQL is already running). Creating a database is a separate lifecycle operation;
its first-Ready time includes the initial DONE backup and is not cold-start latency. The current
slow Off diagnostic was predominantly inside the node, not the Europe-to-US network path. A
confirmed missing configuration-hash update after restore is corrected, qualified and verified
on both regions before and across their first cold wake. The complete regional G3 gates remain open.
Already-built databases with an empty hash retain their existing one-time refresh on the next wake.

**Second acb measurement — failed, 2026-10-26:** the fresh r2 one-hour phase started at 01:33:44.477 UTC after valid operation-derived cold-age checks. All 20 background databases per region completed their first ACK cycle before sampling at 01:35:35.827. Four public six-statement requests completed per region: EU1 375/506/449/2,036 ms; US1 511/684/613/293 ms. The fourth EU request failed the strict below-1,000-ms cell at 01:44:14.348 UTC. Background unknown/error outcomes were zero; all three keys are revoked, writers stopped and pressure readers closed without cleanup errors. These are n=4 descriptions, not a qualified p95 or G3/G11 pass. Its exact EU trace is whole 2,036 ms, Edge 2,028 ms (admission RPC 1,437 + gateway hop 591), and native gateway 538 ms (wake 155/authentication 36/SQL 340); the Actor handler recorded 0 ms on an instance aged 1,125,946 ms. The principal delay is within the Cloudflare admission boundary; queueing, response commit and transport still require distinction. No additional PostgreSQL tuning, replay or identical rerun follows from it. The original failures and all attempts remain preserved. Only after a supported correction and a complete one-hour pass will the follow-up schedule the actual 24-hour natural-sleep condition.

**API observer delivery — 2026-10-26:** the clean qualified main API was deployed once as `3bff9eb9…`, with configured HTTP traffic 100% and unchanged bindings, variables, secrets names, compatibility and migration `0089`. Native nodes remain on `sha-acb21e26e064`; Edge was not redeployed. One read-only single-statement request per existing background database succeeded from the laptop in EU1 774.440 ms / US1 625.474 ms, with the temporary key revoked and process closed. The actual Actor invocations still ran old API version `968c26e2…`, so the new pending-sync observer was not exercised. This is not a six-statement G3 result or a diagnosis of the earlier tail. The installed Wrangler 4.145.0 defaults to deferred DO code updates with a 300-second maximum delay; those calls occurred about 247–248 seconds after deployment. Configured HTTP traffic alone is therefore insufficient rollout evidence. Respect the deferred boundary and verify actual Actor version/observer events in the changed-path receipt; keep the original diagnostics unchanged. Cloudflare also documents [temporarily different Worker/DO code versions](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates). No extra deployment or warmer change is required by the evidence.

**Qualified observer pair — 2026-10-26 04:29 UTC:** after the deferred window and fresh completed natural sleeps after the earlier requests, a separately labelled pair executed the intended `3bff9eb9…` Actor code. EU1 took 947.624 ms whole for one read-only statement, including Edge admission 422 ms and pending-sync completion 409 ms; native wake was 203 ms. US1 took 523.483 ms whole, admission 52/sync 7/native wake 67 ms. Both results matched; the temporary key was revoked/read-confirmed and the owned process exited zero. The sync interval includes pending writes and possible JavaScript scheduling; it is not physical-disk time. These are laptop diagnostics, not the public Worker six-statement G3/p95 distribution or proof of the earlier 1,437-ms cause. The current material cost supports preparing a durable wake ticket on authoritative sleep publication, with every existing generation/role/route fence intact; the subsequent qualified API delivery is recorded below, while latency acceptance remains pending. The earlier observer-unqualified pair stays preserved.

**Prepared-ticket API delivery — 2026-10-26 05:52 UTC:** PR #16 and exact main `2b007721` passed full CI, including actual Linux/QEMU and signing. The API was deployed once as `a058ba8b-ce24-4bc4-895e-90e51a902644`, with post-readback confirming configured HTTP traffic at 100% and preserved bindings, variables, secret names, compatibility and migration boundary. Native `sha-acb21e26e064`, Edge and OS are unchanged. The first prepared cold admission is designed to reuse the ticket committed by ordinary authoritative sleep publication; preparation alone does not claim or wake PostgreSQL. The following changed-path receipt confirms the actual new code on the two selected Actors; the required G3 distribution remains open.

**Changed-path acceptance and failed one-hour gate — 2026-10-26:** the two existing background databases performed genuine cold read-only requests on actual new Actor code, with prepared-ticket reuse and no initial pending-sync event. EU laptop/Edge/admission/native-wake times were 1,077.510/920/11/666 ms; US 319.788/253/17/74 ms. The EU laptop request remains above one second; these single-statement points are not the six-statement Worker p95 gate. Both results matched, the one scoped key was revoked/read-confirmed and all diagnostic/collector processes closed. Bounded CF/native receipts preserve the clock/correlation limits and every attempt. The required fresh one-hour phase ran from 06:16:38.570 to 06:19:48.905 UTC, with samples from 06:18:40.678 under the existing 59 unique first requests per region, 150-second cadence, 20 background databases per region and normal backups. Its first EU request took 1,516 ms and failed the cell; US was 452 ms, n=1 each. All three keys, writers and pressure readers are closed, with zero background unknowns/errors and no cleanup errors. The failed EU admission was 16 ms; native gateway time was 1,341 ms, including wake 568, PostgreSQL login 189 and six-statement transaction 580. The remaining native cause is not yet established; no unchanged repeat or speculative tuning follows from the aggregate pressure alone. The strict success/below-1,000-ms rule is unchanged. No G3/G11 pass or migration readiness is claimed; 24-hour acceptance and dependent cleanup remain outstanding.

**Installed plan and focused diagnosis — 2026-10-26:** both provider instances are Cloud VPS Plus 6 (`V160`), six vCPUs, 12,288 MB RAM and 307,200 MB disk. These are provider allocations on a [shared-CPU product](https://docs.contabo.com/docs/servers-hosting/vps/), not a guarantee of usable concurrency or tail latency. A single separately instrumented cold EU request on the already-consumed fixture took 563 ms; Edge/native wake/login/batch were 519/278/80/86 ms. Target slot and pgcf.slice quotas were unlimited during that request; sampled waits showed filesystem journal/page I/O, with modest observed run-queue delays. Observer CPU overhead was about 15% of one CPU. The 1,516 ms G3 miss was not reproduced and remains failed; neither host contention nor a software-cap defect is proven by this sample. All diagnostic keys/load/readers are cleaned. A replacement with dedicated CPU resources is an owner decision and still requires the existing regional/cold qualification; no new instance was bought.

## 1. The model

### 1.1 One endpoint, two identifiers

All databases share one hostname, the `host` of every connection URI. The operator gives you the
real hostname of the installation; the examples in this runbook use `db.example.com`. There is no
TCP listener. The transport is a WebSocket that carries the
PostgreSQL wire protocol, as in Neon's serverless driver:
`wss://<host>/v2?database=<id>&user=<role>`. The Neon driver's HTTP query mode is served at
`https://<host>/sql` ([3.7](#37-http-query-mode-neon)). A `postgres://` TCP connection to the
hostname and any other path do not work.

A connection names its target twice, and both must agree:

| Where                                                  | Value                                               | Checked by                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Query string of the WebSocket URL                      | `database=<id>` and `user=<role>`, exactly one each | Edge Worker: refuses an unregistered database or role before any wake; once the database is awake it signs a route token that lives 30 s |
| `database` and `user` of the PostgreSQL StartupMessage | the same two values                                 | The node's gateway: comparison with the signed route; a mismatch ends with SQLSTATE `28000` before PostgreSQL is dialled                   |

`<id>` is the 20-character database ID the API returned (`^[a-z][a-z0-9]{19}$`, random, not derived
from the name). It is also the PostgreSQL database name. The `name` you give a database is an API
label, unique among the live databases of a project, and plays no role in routing. The `user` is a
role name from `GET /v1/databases/{id}/roles`; the owner role of every database is `app`.

The StartupMessage `database` parameter defaults to the user name when absent, so set it
explicitly (drivers do). `replication` startup parameters are refused (`0A000`).

### 1.2 Regions

A database lives on one node of one region, chosen at creation (`region_id`). The operator can move
it to another node of the region under the same ID (`POST /v1/databases/{id}/move`, admin): the
source proves the sleep, your connections get `57P03` while the move runs, and a move that fails
leaves the database where it was. The target must be a different node in the same region;
same-node moves return `400 invalid_request` before creating work. A move needs a second node in
the region, and each region has
one node until a second is needed (plan decision D9: it is bought then, with the owner's costed
go). Automatic rebalancing comes after go-live. A move has not been timed: **to be measured** (plan
Stage 5.7). The hostname is the same for every region; the Edge finds the region from the
database's record.

The installation serves two regions: `eu-dev` (node EU1) and `us-dev` (node US1). The IDs carry the
name `dev` and stay in v1. `GET /v1/regions` with your key lists `{id, provider_region}` of the
regions that accept placement and nothing else about them: those with a node that is ready,
schedulable, not lost, open for new databases and has reported in the last 180 seconds (a node that
goes silent closes its region until its next report; `regional_node_stale` is raised at the same
moment). A region without such a node is not listed, and
a database created in a region record that has none waits unplaced ("Waiting for verified regional
capacity") until a node there opens.

US1 was installed from the image of EU1 on 2026-10-22 ("US1 installed into `us-dev` from the
image"). On 2026-10-23 it passed its database acceptance: an `sm` database was ready 23.1 s after
the create and only after its first base backup, SQL ran through Cloudflare, a new connection 2 min
44 s after an idle sleep answered in 601 ms end to end, and a full restore was ready in 26.5 s with
the same digest ("US1 database acceptance in `us-dev`").

**Both regions archive into the installation's one R2 bucket, which is in the EU jurisdiction**
(cutover 2026-10-23, "G8 one archive bucket: the cutover on Dev, steps 1 to 11"). The WAL of a US1
database therefore travels from the US node to an EU-jurisdiction bucket. On October 26, one healthy native archive observation per region had conservative
acknowledged-attempt-start-to-operator-positive bounds of EU 53.393 s / US 54.674 s.
These observations do not isolate upload latency or establish per-class guarantees. The healthy timeout-plus-upload
expectation does not bound data loss during backlog or an R2 outage ([7.2](#72-recovery-point)).

### 1.3 Size classes

A size class fixes the resources and policies of a database. The operator defines classes
(`PUT /v1/size-classes/{id}`, admin); you read them with `GET /v1/size-classes` and pass the ID at
creation or resize. Disabled classes (`enabled: false`) are listed but refused.

| Field                                      | Bounds in the contract                                 | Meaning                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_mib`                               | 256 to 1,048,576 in steps of 256                       | The database's hard memory ceiling while it is awake; PostgreSQL's settings follow it (`shared_buffers` an eighth, `effective_cache_size` three quarters of it) |
| `cpu_millicores`                           | 100 to 256,000                                         | CPU size: the database's CPU weight is proportional to it and a quota of it applies once PostgreSQL has started; after a wake the quota comes only after the region's CPU burst (the node policy's `cpu_boost_ms`, 5 s at first), during which the database is not held to its size: it takes its weight's share of contested CPU and what is idle. Each wake has such a burst, so frequent suspend and resume cycles repeat it |
| `storage_mib` or legacy `storage_gib` | MiB: 4 to 67,108,864 in multiples of 4; GiB: whole numbers 1 to 65,536 | Nominal total volume size, including PostgreSQL, WAL and filesystem overhead; exactly one storage field. Growth only. Operator-defined classes still require qualification. |
| `max_connections`                          | 10 to 10,000                                           | PostgreSQL `max_connections`                                                                                                              |
| `sleep_after_seconds`                      | 60 to 2,592,000, or `null`                             | Idle time before hibernation of a database that sets none of its own; `null` is always warm                                               |
| `archive_timeout_seconds`                  | 30 to 3,600                                            | PostgreSQL `archive_timeout`: switches an active WAL segment after this interval; it does not bound completed archive lag                                                                       |
| `backup_retention_days`                    | 1 to 3,650                                             | Recovery window: after each DONE backup the Worker deletes older base backups and the WAL only they need, never the newest DONE backup; also how long a deleted database stays restorable |

Storage is integer MiB inside the control plane and native agent. Old whole-GiB inputs convert
exactly by multiplying by 1,024. Responses retain `storage_gib` for whole-GiB values and use
`storage_mib` otherwise; upgrade clients before they read a new sub-GiB class. Supplying both
fields is invalid. A 500 MiB volume is 524,288,000 bytes, never rounded to 512 MiB or 1 GiB; the
filesystem ends 4 MiB before the volume's end, then filesystem/engine/WAL overhead consumes
space inside it. This is not a promise of 500 MiB of customer table data or a separate soft quota.

A class that databases reference cannot change its resources or policies (`409`); a class that a
resource profile revision references cannot change at all. New values need a new class.

**Resources of one database.** The class supplies a database's memory, CPU and storage, and an
**admin key** may give one database its own: in `resources` on `POST /v1/databases`, or with
`PUT /v1/databases/{id}/resources` (an integrator key gets `403`). Every `Database` reports the
values it runs with in `resources` (`memory_mib`, `cpu_millicores`, and one of
`storage_mib`/`storage_gib`). A `PUT` sets all three resource values, and `null` hands one back to the class. Memory is a multiple of 256 MiB up to the
region's per-database maximum; CPU is at least 100 millicores and at most the cores of the region's
largest node; storage is at least the database's current size and never shrinks. The change is a
resize ([2.5](#25-resize)), and a change of class keeps the database's own values. A restore
creates its database with the source's resources.

The API refuses a class whose memory exceeds the region's per-database maximum (`400`; 4,096 MiB
unless the operator sets another). It does **not** refuse a class that no node can host, for
example a volume size that would take a node's sold storage past four times its pool, or a CPU
size above the node's cores: creates of such a class are accepted and then wait unplaced. Ask the
operator which classes are placeable.

**The production catalog.** The owner approved it on 2026-10-19 (plan 11.3, "2026-10-19 (evening)")
and the operator created it on 2026-10-20 ("Production size classes `xs`, `sm`, `md`, `lg` created"):

| Class | Memory | CPU | Storage | `max_connections` |
| --- | --- | --- | --- | --- |
| `xs` | 256 MiB | 0.25 | 2 GiB | 20 |
| `sm` | 1 GiB | 0.5 | 10 GiB | 100 |
| `md` | 2 GiB | 1 | 25 GiB | 200 |
| `lg` | 4 GiB | 2 | 50 GiB | 300 |

All four have `sleep_after_seconds` 300, `archive_timeout_seconds` 60 and `backup_retention_days` 7.
The historical test classes and `small` were disabled in the October 26 G10 follow-up above.
`GET /v1/size-classes` also lists disabled entries; integrators must use their explicitly
approved catalog rather than treating every returned class as a product offering.

### 1.4 Projects and keys

There are three key scopes. You hold an integrator key; the table compares it with the operator's
`admin` key:

|                                                                                            | Integrator key                                                                                              | Admin key                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Bound to                                                                                   | exactly one project                                                                                         | nothing                                                |
| Databases, roles, operations, archive summary, usage                                       | its own project; a resource of another project is reported as `404`, never `403`                            | all projects                                           |
| Connection URI                                                                             | **includes the role password**                                                                              | never includes a password (`includes_password: false`) |
| Size classes                                                                               | list                                                                                                        | list and define                                        |
| Regions                                                                                    | list `{id, provider_region}` of those that accept placement                                                 | list the full records, create, read                    |
| Projects                                                                                   | list and read its own; delete its own once it holds no live database (this also revokes the project's keys) | create, list, delete                                   |
| API keys, nodes, capacity policy, costs, operational health, infrastructure backups, fleet | `403`                                                                                                       | yes                                                    |

The third scope, `admin_read`, is the operator's read-only administrator key, for monitoring and
dashboards: it reads what an admin key reads, and every request that is not a GET is refused with
`403` before it runs. You are never given one. The operator's keys leave an audit log
(`GET /v1/audit-events`, administrator keys only); yours do not.

A key is `pgcf_sk_<12 characters>_<43 characters>`, sent as `Authorization: Bearer <key>`. PGCF
stores only an HMAC of it; the full key appears once, in the creation response. A lost response
means revoking the key and creating another.

**Obtaining a key.** You cannot mint your own. The operator creates a project and an integrator
key bound to it and hands you the key over a private channel (`external_id` carries your own
reference and must be unique among live projects):

```sh
# Operator, with an admin key
curl -sS -X POST "$PGCF_API/v1/projects" -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: project-$STABLE_ID" \
  -d '{"name":"<display name>","external_id":"<your reference>"}'
curl -sS -X POST "$PGCF_API/v1/api-keys" -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: key-$STABLE_ID" \
  -d '{"scope":"integrator","project_id":"<project-id>","name":"<label>"}'
```

**Rotating a key.** There is no self-service rotation. An integrator key never expires unless the
operator gave it an `expires_at` when making it (the key's resource shows it; it cannot be
changed): from that time the key answers `401` like a revoked one, so ask for the replacement
before it. The operator follows [credentials](credentials.md#api-keys): create a second integrator
key for the same project, you deploy it, the operator revokes the first with
`DELETE /v1/api-keys/{id}`. A revoked key answers `401` at once. Idempotency keys are scoped to the
API key that used them: settle in-flight mutations before the switch, and do not expect a new key
to replay an old key's `Idempotency-Key`. Last-use display and bounded admin minting are open
work.

## 2. Lifecycle API

The machine-readable reference is `GET /v1/openapi.json` (no key needed). Its `info.version` is
the version of the API contract (`1.5.0` for this candidate document): it changes when the contract changes
and not with a Worker release, which is named in `info.x-worker-version`. Rules a schema cannot
state are in descriptions ([Appendix C](#appendix-c-what-the-served-openapi-document-states-in-words)).
Its operation IDs are listed below. Examples assume:

```sh
export PGCF_API='https://<management-api-origin>'   # the operator tells you; it is not the database host
export PGCF_KEY='<integrator API key>'              # keep it in a secret store
pgcf() { curl -sS -H "Authorization: Bearer $PGCF_KEY" -H 'Accept: application/json' "$@"; }
```

### 2.0 Conventions

- **Bodies.** JSON, at most 64 KiB, `Content-Type: application/json` whenever there is a body.
  Request objects are strict: unknown fields are `400`. Success responses are closed objects too,
  and PGCF's own TypeScript client validates them strictly, so it must match the deployed Worker.
  Ignore unknown response fields in your client.
- **Timestamps** have exactly one form: UTC with three fractional digits and a literal `Z`
  (`2026-10-15T09:30:00.000Z`). `…:00Z`, `…:00.0Z` and `+00:00` offsets are `400`; the served
  OpenAPI gives the pattern.
- **Lists** take `limit` (1 to 100, default 50) and an opaque `cursor`, return
  `{ "data": [...], "next_cursor": string | null }` and are ordered newest first. The role list is
  not paginated (at most 100 roles, ordered by name).
- **Request IDs.** Send `X-Request-Id` (1 to 128 characters of `A-Za-z0-9._~-`) or receive a UUID;
  it is echoed, and `error.request_id` repeats it. Every response also carries a fresh
  `X-PGCF-Diagnostic-Id`. Quote both when you escalate ([7.6](#76-escalation)).
- **Asynchronous writes** return `202` with `{database, operation}` (restore: `{target_database,
operation}`) and `Location: /v1/operations/{id}`.
- **Idempotency.** Send `Idempotency-Key` (`^[A-Za-z0-9._~-]{1,128}$`) on every mutation, generate
  it once per logical operation and persist it with your intent before sending. It is
  **required** (`400` without it) on creating, resizing, deleting, suspending, resuming and
  restoring a database, on assigning a resource profile and on creating, resetting and deleting a
  role; the served document marks it required on exactly these routes. The same key with the same
  method, path and JSON body returns the retained result (for database operations the original
  operation, read fresh); the same key with another request is `409 idempotency_conflict`; while
  the first call still runs it is `409 idempotency_in_progress`. Only an uncompleted reservation
  is discarded after failure; a completed mutation remains reserved even if producing its
  response fails. Keys are kept for 24 hours per API key. `GET`
  needs none. Never retry a mutation under a new key after an uncertain response. After key
  rotation or the retention period, reconcile the original resource or operation before a new
  submission; the old reservation no longer protects it.
- **Refusals and retries.** Every error body is `{error: {code, message, request_id, details?}}`.
  Where one code stands for several causes, `error.details.reason` names the cause from a closed
  set; switch on it and never on the message, which may change. A refusal that can clear by
  itself carries a `Retry-After` header in seconds (a hint, not a promise): the retryable reasons
  and `capacity_exhausted` and `idempotency_in_progress`. The reasons are listed in
  [A.1](#a1-http).
- **Client library.** `PgcfClient` in `packages/contracts/src/client.ts` is workspace-only (the
  package is private and not published) and strict about response shapes; call the HTTP API
  directly or vendor it. It uses a 30 s timeout by default and never retries a write.

| Operation ID                                                  | Call                                                  | Notes                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDatabase`                                              | `POST /v1/databases`                                  | 202                                                                                                                                                                                                                     |
| `listDatabases`                                               | `GET /v1/databases`                                   | filters `project_id`, `region_id`, `node_id`, `desired_state`, `observed_state` and `name` (exact, case-sensitive; unique among the live databases of a project, so one match inside your project); excludes deleted    |
| `getDatabase`                                                 | `GET /v1/databases/{id}`                              | also returns a deleted database (`desired_state: deleted`)                                                                                                                                                              |
| `resizeDatabase`                                              | `PATCH /v1/databases/{id}`                            | body `{size_class_id}` only; no rename                                                                                                                                                                                  |
| `setDatabaseResources`                                        | `PUT /v1/databases/{id}/resources`                    | admin key only (`403` otherwise); body `{memory_mib, cpu_millicores, storage_mib}` (or legacy `storage_gib`, never both), each a value or `null` for the size class's ([1.3](#13-size-classes)); 202 with the operation, a resize; `Idempotency-Key` required |
| `setDatabaseIdleTime`                                         | `PUT /v1/databases/{id}/idle-time`                    | body `{sleep_after_seconds}`; 200 with the database, no operation ([3.5](#35-idle-sleep-and-wake-on-connect)); `Idempotency-Key` required                                                                               |
| `deleteDatabase`                                              | `DELETE /v1/databases/{id}`                           | 202                                                                                                                                                                                                                     |
| `suspendDatabase`, `resumeDatabase`                           | `POST /v1/databases/{id}/suspend`, `/resume`          | 202                                                                                                                                                                                                                     |
| `restoreDatabase`                                             | `POST /v1/databases/{id}/restore`                     | 202, creates a new database                                                                                                                                                                                             |
| `listDatabaseRoles`, `createDatabaseRole`                     | `GET`, `POST /v1/databases/{id}/roles`                | at most 100 roles; optional `valid_until`, `connection_limit`, `member_of`, `membership_options`, `bypass_rls` ([2.3](#23-roles-connection-uri-and-passwords)); `Idempotency-Key` required                                                    |
| `resetDatabaseRolePassword`                                   | `POST /v1/databases/{id}/roles/{name}/reset-password` | `Idempotency-Key` required                                                                                                                                                                                              |
| `deleteDatabaseRole`                                          | `DELETE /v1/databases/{id}/roles/{name}`              | 202, operation `database.role.delete` ([2.3](#23-roles-connection-uri-and-passwords)); `Idempotency-Key` required                                                                                                       |
| `getDatabaseConnectionUri`                                    | `GET /v1/databases/{id}/roles/{name}/connection-uri`  | password included for integrator keys                                                                                                                                                                                   |
| `getDatabaseOperation`                                        | `GET /v1/operations/{id}`                             |                                                                                                                                                                                                                         |
| `listDatabaseOperations`                                      | `GET /v1/databases/{id}/operations`                   | newest first, the view of `getDatabaseOperation`; also the operations PGCF starts itself; a deleted database stays listable                                                                                             |
| `listRegions`                                                 | `GET /v1/regions`                                     | `{id, provider_region}` of the regions that accept placement ([1.2](#12-regions))                                                                                                                                       |
| `getDatabaseArchive`                                          | `GET /v1/databases/{id}/archive`                      | counts only                                                                                                                                                                                                             |
| `getDatabaseBackups`                                          | `GET /v1/databases/{id}/backups`                      | the restorable window and the restorable base backups ([2.7](#27-backups-restorable-window-and-restore))                                                                                                                |
| `getUsage`                                                    | `GET /v1/usage`                                       | [5](#5-metering)                                                                                                                                                                                                        |
| `createWebhook`, `listWebhooks`, `getWebhook`, `deleteWebhook`   | `/v1/webhooks`, `/v1/webhooks/{id}`                   | [2.8](#28-webhooks); `createWebhook` shows the signing secret once
| `putSchedule`, `listSchedules`, `getSchedule`, `deleteSchedule` | `PUT`, `GET`, `DELETE /v1/databases/{id}/schedules/{name}`, `GET …/schedules` | [2.9](#29-schedules); `PUT` creates (201) or replaces (200)
| `listScheduleRuns`, `runScheduleNow`                          | `GET …/schedules/{name}/runs`, `POST …/schedules/{name}/run` | the last 50 runs; a manual run, queued (202)
| `getExecutionUsage`                                           | `GET /v1/execution-usage`                             | [5.1](#51-executions)
| `testWebhook`                                                 | `POST /v1/webhooks/{id}/test`                         | one `webhook.test` event, sent now, not retried
| `listWebhookDeliveries`, `replayWebhookDelivery`              | `GET /v1/databases/{id}/webhook-deliveries`, `POST …/{delivery_id}/replay` | the deliveries of a database's events
| `listSizeClasses`                                             | `GET /v1/size-classes`                                |                                                                                                                                                                                                                         |
| `listProjects`, `getProject`, `deleteProject`                 | `/v1/projects`, `/v1/projects/{id}`                   |                                                                                                                                                                                                                         |
| `getDatabaseResourceProfile`, `assignDatabaseResourceProfile` | `GET`, `PUT /v1/databases/{id}/resource-profile`      | operator-defined profile revisions; an assignment is a resize                                                                                                                                                           |

### 2.1 Create

Fresh clusters created by the integration-extension release use PostgreSQL's built-in locale
provider with `C.UTF-8`, UTF-8 encoding and collation version `1`. The tenant database inherits
that template. Unicode case behavior therefore follows PostgreSQL rather than the node's libc.
Existing clusters, physical restores and move targets retain their original provider, locale
and collation version; an update never rewrites their collations. For a logical import, compare
the source's `pg_database` locale metadata and application-sensitive case/sort/unique behavior
with the actual target before admitting writes. This is a fixed fresh-cluster default, not a new
per-integrator locale option.

```sh
KEY="create-$(uuidgen)"   # persist with your intent; reuse for every retry of this creation
pgcf -i -X POST "$PGCF_API/v1/databases" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"project_id":"<project-id>","region_id":"<region-id>","name":"orders","size_class_id":"<size-class-id>"}'
```

What happens: the database record (generation 1) and the owner role `app` with a server-generated
password are written; the
placement step picks the fullest qualifying node. Its CPU peak (the highest 30-minute average of
the last three days) must stay under 80 %, and the requested CPU must fit its physical cores.
RAM uses the higher of its three-day peak and current sample, plus the full memory of databases
placed since that sample and the requested database; the sum must stay under 80 %. Its thin pool is
open (data below 80 %, metadata below 50 %, sold storage within four times its data), and the node
holds fewer than 1,000 volumes. The node then creates the volume
and the cluster, applies the roles, starts PostgreSQL through its own admission and takes the first
base backup; WAL archiving starts with the first start. The database is ready only when that backup
is DONE, so it is never writable before it is restorable. The idle time
(`effective_sleep_after_seconds`) counts from readiness.

- Ready means the operation is `succeeded`, the database `observed_state` is `ready` and
  `observed_generation` equals `generation`. Poll `GET /v1/operations/{id}`; the database stays
  `pending` or `provisioning` until then. Connecting earlier returns `57P03` immediately.
- **Create to ready, measured.** On the slot-pool release (2026-10-23, "Live acceptance on the
  slot-pool release, part 1", Stage 5.1, `xs` class, test data) 8 of 8 databases were ready only
  after their first base backup was DONE. The target for create to ready is 30.7 s or less; 6 of 8
  met it and 2 took 30.8 s and 32.8 s, both while other creates or resizes ran. An `sm` database on
  US1 was ready after 23.1 s ("US1 database acceptance in `us-dev`"). On 2026-10-18 a create took
  16.8 s, and a database loaded with a SaaS dataset of about 2.5 million rows (74.1 s through
  Cloudflare) held one base backup and 49 WAL segments (188.6 MB) in R2 afterwards ("Stage 5 first
  live results on EU1").
- **No capacity.** If no node qualifies, the call still returns `202`: `node_id` is `null`,
  `observed_state` is `pending` and `status_message` is `Waiting for verified regional capacity`.
  A minute cron places it when a node qualifies.
  This wait has no timeout of its own; set your own deadline and delete the database to cancel.
  Accepted deletions also have no timeout ([2.6](#26-delete)); other regional operations fail with
  `operation_timeout` after 20 minutes without a report.
- **Placement window.** The peak that placement counts is the highest 30-minute average of a
  node's active RAM and of its CPU load within the placement window. The window is 3 days (owner
  decision O6 of 2026-10-23, plan 11.3; `PEAK_WINDOW_MS`, deployed in baseline B). The historical
  Open row's deployment warning predates that baseline. A burst of awake databases raises the
  peak and closes the node for the databases that no longer fit under 80 % until the peak leaves
  the window: seeding 59 databases at once put 55 of them awake and the 30-minute average at 73.5 %
  (peak at 21:36 UTC on 2026-10-19), and a new 1 GiB database was then refused as "Waiting for
  verified regional capacity" for as long as that peak stood. Databases that are already running
  are not affected.
- Errors: `400` for an unknown or disabled class or region, `404` for an unknown project, `409`
  with reason `name_in_use` for a name that a live database of the project already uses.
- Engine: PostgreSQL 18 (18.6 at the time of writing, unmodified engine, `pgvector` 0.8.7). Which
  other extensions the owner role may create is **not yet verified**.

### 2.2 Operations and readiness

`GET /v1/operations/{id}` returns `{id, kind, status, database_id, generation, error, ...}`.

| `status`             | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `pending`, `running` | accepted; the node has not finished                                            |
| `succeeded`          | the observed state matches the intent                                          |
| `failed`             | `error.code` and `error.message` say why; see [A.3](#a3-operation-error-codes) |

Poll with a short interval at first and a longer one afterwards, or subscribe to
`operation.succeeded` and `operation.failed` webhooks ([2.8](#28-webhooks)). Kinds you start: `database.create`, `database.restore` (it belongs to the new
database), `database.delete`, `database.resize`, `database.suspend`, `database.resume`,
`database.role.delete`. PGCF starts `database.hibernate` (idle sleep) and `database.wake` (a
connection) itself; they appear in `GET /v1/databases/{id}/operations` like any other.

The `Database` object: `desired_state` (`running`, `suspended`, `deleted`), `observed_state`
(`pending`, `provisioning`, `hibernated`, `ready`, `error`, `deleting`, `deleted`),
`suspension_reason` (`manual`, `idle`, `null`), `generation` and `observed_generation` (a changed
configuration is applied when they are equal), `status_message`, `node_id` (`null` while
unplaced), `health` and `storage`:

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.archiving` | `ok`, `failing`, `unknown`, with `since`                                                                                                                                                                                                                                                                                                        |
| `health.backup`    | `status` is `ok` while the last completed base backup is at most 36 h old, `stale` when older, `failing` when the node reports failing or its last failure is newer than its last completion, `unknown` without a report of the database within 45 min (a node names an unchanged database once in 15 min) or without a completed backup; `last_base_backup_at` is when that backup finished, `null` while unknown |
| `health.disk` | `status` is `warning` from 90 % of the mounted filesystem used and `unknown` without a valid report within 180 s for the current node and storage generation. `used_ratio` uses actual filesystem capacity, so a logical-volume grow alone does not hide a full filesystem. The node reports volumes every minute; the separate storage and usage fields retain nominal allocation for metering. |
| `storage`          | `{used_bytes, allocated_bytes, observed_at}` of the newest sample the node's agent reported (at most a minute old for an awake database, at most 15 minutes for a hibernated one), with `null` figures where it measured nothing; the whole object is `null` before the first sample. It is not cut off by age: judge `observed_at` yourself                                                                                        |

`null` and `unknown` mean not known, never fine and never zero. These are the very figures the
operator reads in `GET /v1/operational-health?scope=databases`: one source, two views.

### 2.3 Roles, connection URI and passwords

```sh
pgcf -X POST "$PGCF_API/v1/databases/<database-id>/roles" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d '{"name":"web"}'
pgcf "$PGCF_API/v1/databases/<database-id>/roles/web/connection-uri"
# {"database_id":"...","role":"web","host":"db.example.com","database":"<database-id>",
#  "uri":"postgres://web:<password>@db.example.com/<database-id>","includes_password":true}
```

- `app` is the database owner and not a superuser (the acceptance probe asserts
  `rolsuper = false`). Roles you add are login roles without superuser, `createdb`,
  `createrole` or replication; `bypassrls` only when you ask for it (below). Grant them
  privileges with SQL as `app`. Role names match `^[a-z][a-z0-9_]{0,62}$` and may not be
  `postgres`, `pgcf_backup` (the role of the node's base backups), `public` or `none` (PostgreSQL
  refuses both as role names) or start with `pg_`. This list is included in deployed baseline B
  (plan W2-C, migration `0085`); `streaming_replica`, `cnpg_*` and `pgcf_maintenance` are ordinary
  names. The older plan row's "not deployed" status predates that baseline. The final regional
  role/connection acceptance remains open. There is no API to choose a password.
- Passwords are 43 characters of base64url, server-generated. Only an integrator key can read one,
  and only through the connection URI. `reset-password` replaces it (`password_revision` + 1).
- Creating, resetting and deleting a role require an `Idempotency-Key` (`400` without one).
- After `POST /roles` returns `201`, or `reset-password` returns `200`, the role is registered but
  the change reaches PostgreSQL with the database's next configuration pass. Wait until
  `observed_generation == generation` before connecting as the new role (earlier: `57P03`). A
  hibernated database applies it at its next wake.
- The URI has no port and no `sslmode`; see [3.1](#31-driver-configuration) for how to use it.

**Attributes at creation.** All are optional; a role created without them is the plain login role
of before. None can be changed afterwards (there is no `PATCH`): delete the role and create it
again.

```sh
pgcf -X POST "$PGCF_API/v1/databases/<database-id>/roles" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"name":"report_a1b2c3","valid_until":"2030-01-01T10:00:00.000Z","connection_limit":5,"member_of":["reader"]}'
```

| Field              | Meaning                                                                                                                                                                       | Limits                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid_until`      | PostgreSQL `VALID UNTIL`: from this time the role cannot log in                                                                                                               | a [timestamp](#20-conventions) in the future when the request executes, no maximum; PostgreSQL applies it at whole seconds, truncated, so `…:05.678Z` expires at `…:05.000Z` and a value whose whole second has already begun is refused with `400` |
| `connection_limit` | PostgreSQL `CONNECTION LIMIT`: concurrent sessions of the role; one more gets `53300` "too many connections for role"                                                         | 1 to 10,000; omitted means unlimited                                                                                                                                                                                                                |
| `member_of`        | membership targets; omitted options retain inherited privileges and `SET ROLE`; explicit `membership_options` can restrict both                            | at most 8 distinct live roles of this database; never `app` or the role itself; otherwise `400`                                                                                                               |
| `bypass_rls`       | PostgreSQL `BYPASSRLS`: the role ignores row-level security policies, also `FORCE ROW LEVEL SECURITY`; it still needs table privileges. Typical use: an export or backup role | boolean, default `false`                                                                                                                                                                                                                            |

`membership_options: {"inherit": true, "set": false}` applies uniformly to all entries of
`member_of`: the role inherits the targets' grants but cannot `SET ROLE` to them. Both booleans
are required when supplied; options without membership targets are invalid. `ADMIN OPTION` is
always false. Omission means `{inherit:true,set:true}`; default options remain omitted in the
response and desired page. Native reconciliation verifies grant options as well as target names,
including after restore, and refuses an unexpected grantor rather than accepting a permissive
parallel grant. These creation-time attributes remain immutable; no role PATCH is added.

`GET /v1/databases/{id}/roles` returns the existing attributes on every role (`null`, `[]`,
`false` when not set) and non-default membership options when present. A role past its `valid_until` stays listed and counts toward the 100 roles until you delete
it; its connection URI is still readable but a connection with it is refused. Expiry stops new
logins only: **a session that is already open is not ended by it**. Delete the role to end its
sessions.

An ordinary role may set its own session defaults through an authenticated connection, for
example `ALTER ROLE CURRENT_USER SET statement_timeout='60s'`. Role application/password reset
does not reset those defaults. The owner `app` cannot create roles or change other roles' defaults;
use the role API and then authenticate as the intended role. SQL role comments require role
administration privileges that `app` does not hold; maintain integration provenance in the
integrator's scoped resource/operation records instead.

**Expired credentials.** The Edge refuses a role past `valid_until` with `28P01` before it would
wake a hibernated database or spend connection budget, exactly the SQLSTATE PostgreSQL answers an
expired password with ([A.4](#a4-sqlstate-at-connect-time)); it refuses from the start of the
whole second the expiry falls in, the instant PostgreSQL enforces for anything that reaches it.

**Deleting a role.**

```sh
pgcf -i -X DELETE "$PGCF_API/v1/databases/<database-id>/roles/report_a1b2c3" \
  -H "Idempotency-Key: del-$KEY"
# 202 {"database":{...},"operation":{"id":"op_...","kind":"database.role.delete","status":"pending",...}}
```

- **Unroutable at once.** From the moment the request is accepted the role is no longer listed, its
  connection URI is `404`, and the Edge answers `28P01` to a new connection. A route token issued
  just before lives up to 30 s. The node then sets the role to `NOLOGIN`, ends its sessions and
  drops it; the operation is `succeeded` when PostgreSQL has confirmed that. Sessions that are open
  at the time are ended once the role is `NOLOGIN`: do not rely on one surviving the deletion.
- **A role that owns objects cannot be dropped.** If it owns objects or holds privileges
  (including default privileges), PostgreSQL refuses `DROP ROLE`: the operation ends `failed` with
  `error.code` `role_not_droppable`, and the role **stays unable to log in and unroutable**. To
  prevent it, connect as the role while it is live and run `DROP OWNED BY CURRENT_USER` (or drop
  its objects as `app`, which owns the `public` schema, and `REVOKE` what it holds) before
  deleting it. Afterwards `DELETE` the role again under a new `Idempotency-Key` (the old key
  replays the failed operation): a failed removal starts a new operation, and the node drops the
  role as soon as nothing depends on it. The old operation stays `failed`.
- **The name** is free again only when the removal is confirmed; creating it earlier is `409` with
  reason `role_being_deleted`. A role awaiting its removal counts toward the 100 roles
  (`role_limit`).
- **Hibernated database.** A suspended or idle-hibernated database has no PostgreSQL running, so the
  node applies the removal at its next wake. The operation reports `succeeded` at once because
  the role is already unroutable, **before** PostgreSQL has dropped it (a removal still waiting
  when a running database goes to sleep ends the same way); if the drop then fails (the role owns
  objects) the failure is not reported through that operation. To observe the outcome,
  `resume` the database and, once it is running, `DELETE` the role again under a new key: that
  starts a new operation which succeeds when PostgreSQL has dropped the role, or fails with
  `role_not_droppable`; once the removal is complete the role is gone (`404`).
- **Repeats.** Another `DELETE` of a role whose removal is still running, or whose operation
  completed for a database that still is not running, returns the same operation, without a new
  generation. After a removal was confirmed the role is `404`.
- **Refusals.** `400` for the owner `app`; `404` for an unknown role;
  `409` for a role that other live roles are `member_of` (`role_has_members`: delete the members
  first). Deleting a database ends a pending removal with `superseded`.

### 2.4 Suspend and resume

`POST /v1/databases/{id}/suspend` is a **manual** suspension: connections are refused with `57P03`
until `POST /v1/databases/{id}/resume`. A connection never wakes a manually suspended database.
The database must be `ready`, or an idle sleeper that is already `hibernated` with a verified
sleep (`409 "Database configuration is not ready"` otherwise, for example while a wake is in
flight). An idle sleeper is claimed at once: it needs no node action, its `suspension_reason`
becomes `manual`, and a connection no longer wakes it. For a `ready` database the node
runs the sleep proof: it stops new work, closes idle sessions, checkpoints, switches the WAL
segment, waits until every committed segment is in R2 and only then stops PostgreSQL; the volume
stays mounted. If sessions are busy, a prepared transaction exists or the
archive does not drain, the operation fails with `power_busy` or `power_archive` and the database
keeps running: drain your pools first. Suspending a database that is already manually suspended returns
its existing operation.

**Conditional power intent (1.5.0 candidate).** Both endpoints accept an optional JSON body
`{"expected_generation": 12}`. The value must be a positive safe integer. Omit the body (or send
`{}`) for the existing unconditional behavior; an empty body remains valid with or without a JSON
Content-Type. The generation is checked at acceptance, including existing-state and ready-resume
shortcuts. A mismatch returns HTTP `409`, `error.code: "conflict"` and
`error.details.reason: "generation_changed"` before changing power or adopting another operation.
Read the new state and decide whether a new intent is still authorized; do not automatically
replace the expected generation. After an unknown outcome, resend the **same original body and
Idempotency-Key**. An accepted request replays its original operation even if the database has
since advanced; the database object alongside it describes the current state. The published
client accepts the body as the optional third argument to `suspendDatabase(id, key, body)` and
`resumeDatabase(id, key, body)`.

`resume` also works as a **pre-wake** of an idle-hibernated database: it is the supported way to
wake before traffic (poll the operation, then run `SELECT 1`). When the node cannot take the
start (no report within 180 s, no room in its thin pool, or less memory available than the
database's memory plus the node's 600 MiB floor), `resume` answers `409 conflict` with reason `node_capacity` and `Retry-After: 30`: retry later or
free capacity. A `409` with reason `generation_changed` means the generation precondition failed
or a change raced the request; reconcile the current intent before retrying. Measured: a resume pre-woke a manually suspended database in 0.8 s (2026-10-23, "Live acceptance
on the slot-pool release, part 1", Stage 5.2). Over 1,001 resumes and 1,004 suspends through the
API (5 databases, 200 cycles each, 2026-10-20) the average resume took 1.2 s and the average
suspend 3.5 s ("Stage 5.6 1,000 resume/suspend cycles through the API").

### 2.5 Resize

`PATCH /v1/databases/{id}` with `{"size_class_id": "<class>"}`.

- A running database takes new memory and CPU limits as live limits on its unit, without ending its
  sessions; PostgreSQL's own settings follow the new memory at its next start, and storage grows
  online. A hibernated database changes immediately and starts on the new class at its next wake:
its memory and CPU are admitted by its node then, while its storage growth must fit the node now
(see below).
- The target class must be enabled and within the region's memory maximum. A running database that
  grows must fit the node now, else `503 capacity_exhausted` ("Current node has insufficient
  memory, CPU or storage"): the node has no observation from the last 180 s, its active RAM would
  reach 80 % with the extra memory, its CPU would exceed the node's cores, or, for extra storage,
  the node reports no thin pool or no room in it, or its sold storage would pass four times its
  pool. A smaller or equal size needs no room. A hibernated database waits for its next wake only for
  memory and CPU; growth of its storage is sold from now on and is refused with the same `503` on
  the same storage test.
- Storage may only grow; shrinking is `400` ("Storage shrink is not supported"). Growth through the
  API is **not yet verified live** on the final production candidate. An operation succeeds only
  after the node reports the measured filesystem at the requested size less its 4 MiB isolation
  gap. A missing or smaller size keeps it running; after 20 minutes it fails with
  `filesystem_not_grown`, while the node continues reconciliation. Existing filesystems with the
  earlier layout require a clean stop before offline growth; active transactions or unavailable
  archiving can defer that stop. Full-volume and inode-exhaustion recovery is by explicit growth,
  which also applies before crash recovery. No tenant project quota is imposed and arbitrary SQL
  cleanup at zero available space is not guaranteed.
- The operator can roll a new revision of a resource profile out to every database assigned to
  it; that changes your database's `size_class_id` (a hibernated one at its next wake). Read it
  with `GET /v1/databases/{id}/resource-profile`.

### 2.6 Delete

`DELETE /v1/databases/{id}` returns `202`; the node stops PostgreSQL, removes the volume (its chunks
return to the pool) and the Linux user, and the database record ends as `observed_state: deleted`
(on EU1 the volume left the node's report 37.9 s after the request on 2026-10-18, "Stage 5.1 restore,
PITR and delete on EU1"; the delete of 2026-10-23 returned 411 MiB to the pool, "Live acceptance on
the slot-pool release, part 1"). The name is free at once. The backup archive is **retained** for the class's
`backup_retention_days`; the database stays restorable until `deleted_at + backup_retention_days`
(the API does not return that date). Role credentials and attributes are retained with it; a role
awaiting its removal is not. A project can be deleted only after all its databases have finished
deleting. Retained archives are removed by a cron after expiry.

An accepted deletion cannot be cancelled. Its operation stays `pending` or `running` until the
node confirms that PostgreSQL, its owned volumes, its account and its local files are gone; only
then does it succeed. It does not fail merely because cleanup takes more than 20 minutes. The
agent retries failed cleanup steps and `database_delete_incomplete` alerts the operator after ten
minutes without completed cleanup. Repeating `DELETE` returns the same operation. A client may
stop polling at its own deadline, but that does not cancel deletion or prove cleanup complete.

A `409 conflict` from `DELETE` deletes nothing. Reason `mutation_in_progress` means another change
to the same database holds it at that moment: a wake, an idle sleep or its compensation, a move or a
node maintenance step. Retry with backoff and
jitter (for example 1 s, 2 s, 4 s, up to about two minutes) under the same `Idempotency-Key`;
`Retry-After` gives the first delay. Reason `generation_changed` means another request changed the
database first (for example deleted it); the retry returns that deletion's operation.

### 2.7 Backups, restorable window and restore

**What exists.** Each database archives WAL continuously to R2 (gzip) with Barman Cloud tools that
its node runs, and takes a base backup when it is created (it is ready only when that backup is
DONE), after a restore, before an idle sleep when one is due (none on the current timeline, or the
newest is older than 24 h) and, for an always-warm database, once the newest is older than 24 h. A
sleeping database is never woken to be backed up, and the sleep proof archives its last WAL first.
The Worker applies `backup_retention_days` as the recovery window: after each DONE backup it deletes
older base backups and the WAL only they needed, and it never deletes the newest DONE backup, so a
database that sleeps through its whole window keeps its last backup (plan 7.7).

**What the API shows.** `GET /v1/databases/{id}/backups` reads the window a restore can reach and
the base backups it can start from, from the very catalog the restore reads:

```sh
pgcf "$PGCF_API/v1/databases/<database-id>/backups"
# {"database_id":"...","earliest_restorable_time":"2026-10-14T03:00:41.000Z",
#  "latest_restorable_time":"2026-10-15T09:41:07.000Z",
#  "base_backups":[{"id":"20261015T030000","started_at":"2026-10-15T03:00:00.000Z",
#                   "completed_at":"2026-10-15T03:00:38.000Z"}, ...]}
```

- `earliest_restorable_time` is the end time of the oldest base backup whose data and WAL chain
  are complete: the end of the first base backup for a young database, afterwards about
  `backup_retention_days` back; no `pitr` target before it can be restored;
- `latest_restorable_time` is when the newest archived WAL segment was uploaded, an **upper
  bound**: a `pitr` target after the last commit in the archive fails recovery, and `full`
  restores everything archived;
- `base_backups` lists only restorable backups, newest first, at most 64 (the bound of the
  catalog); one without its WAL chain is not restorable and is not listed.

Both times are `null`, with no base backups, while the archive holds no complete base backup (a
database younger than its first one), cannot be read completely (the catalog reads at most 16,000
objects), or belongs to a deleted database past its retention. `null` means unknown. A deleted
database inside its retention is read like a live one.
`GET /v1/databases/{id}/archive` returns only `{base_backup_count, wal_count, bytes}`, and
`health.archiving` on the database says whether archiving works.

**The window in numbers.** `backup_retention_days` is 7 in all four production classes (decided: the
owner approved the catalog on 2026-10-19). The restorable window of a database that has lived that
long therefore reaches back about 7 days from now and ends at the newest archived WAL segment; the
API states both ends per database. **Measured:** a point-in-time restore into a new database was
ready 50.1 s after the request and held the state at the target, the later table absent
(2026-10-23, "Live acceptance on the slot-pool release, part 1"); the same restore from the new
bucket at the archive cutover took 52.4 s with the same digest (2026-10-23, "G8 one archive bucket:
the cutover on Dev, steps 1 to 11"). **To be measured:** a restore at the edge of a full 7-day
window.

**Restore into a new database** keeps the source unchanged:

```sh
pgcf -i -X POST "$PGCF_API/v1/databases/<source-id>/restore" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"mode":"pitr","name":"orders-restored","target_time":"2026-10-15T09:30:00.000Z"}'
# {"target_database":{"id":"<NEW id>", ...},"operation":{"id":"op_...","kind":"database.restore",...}}
```

`mode` is `full` (newest complete base backup plus all archived WAL) or `pitr` (`target_time`, not
in the future). `region_id` is optional and, when given, must be the source's own region: a node
reads only its own region's archives, so another region is refused with `region_unavailable`.

**Restore while keeping the connection identity (implemented and exercised through the US1 API; final regional qualification remains open).** `POST /v1/databases/{id}/restore-in-place`
with `Idempotency-Key` and `{"mode":"pitr","target_time":"<UTC timestamp>"}` returns
`{database,operation}` with the original database ID. The database name, connection address,
region, roles and passwords remain the same. Existing sessions are ended as the source is stopped;
new connections receive `57P03` until the operation has finished. Do not retry an uncertain write.
The source must prove its last committed WAL is archived before its volume is unmounted and
preserved. A fresh storage generation restores the requested time. Cutover requires a usable
promoted database with its first DONE base backup. Other lifecycle and role mutations are refused
with `409 mutation_in_progress` while this operation holds the database.

An unsuccessful PITR restores the proven pre-request state into a further storage generation;
no generation is lowered. The operation remains running while that rollback is incomplete,
including while R2 is unavailable, and admission stays closed. It ends `failed` only once the
prior state is restored and backed up (or if quiescing failed before any replacement was staged).
The local source volume and state are preserved until either outcome is recoverable. The ordinary
new-database restore timeout does not terminate an active in-place recovery. If the owning node is
declared lost, the operation ends with `node_lost` and routing stays closed. The original database
row and source archive remain the recovery authority; use the existing fenced-node recovery into
a new database. This is the single-node loss boundary, not an automatic in-place rollback.

`GET /v1/databases/{id}/restores/in-place` returns the newest 50 operations with their phase,
requested time, failure and `retained_until`. A completed operation's pre-restore archive remains
available through that retention deadline. To recover it into a new database, use the existing
`/restore` request with `source_operation_id` set to that operation ID, plus `mode` and `name`.
Omitting `source_operation_id` restores the database's current archive as before. Retention expiry
claims the old archive before deletion and waits for any running restore reader to finish.

Rollout is API/migration first, then native consumers. A request is refused until the owning node
is converged and advertises `restore_in_place_v1` in its current connection hello. An older hello
without that capability clears support; delayed samples cannot enable it. No old agent receives a `replace` origin. Before production enablement,
prove the same-identity success, interrupted recovery, archive outage and prior-state recovery on
both regions; local tests alone are not production acceptance.

**The ID mapping for `/restore` into a new database.** The following table and connection-switch
procedure apply only to the new-ID route; `/restore-in-place` retains the existing identity and
credentials.

|                                                                                                     | Source        | Restored target                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database ID and PostgreSQL database name                                                            | `<source-id>` | **new** `<target-id>`                                                                                                                                                                                         |
| `name`                                                                                              | the old label | the `name` of the request; it must differ from every live database of the project (`409` otherwise)                                                                                                           |
| Project, size class, region                                                                         |               | the same (region unless `region_id` is given)                                                                                                                                                                 |
| Role names, passwords and attributes (`valid_until`, `connection_limit`, `member_of`, `membership_options`, `bypass_rls`) |               | the same names, passwords and attributes registered at the time of the call (from the retained record for a deleted source); a role awaiting its removal is not copied, and an expired role is copied expired |
| Data, grants, sequences                                                                             |               | from the backup, as of `target_time` or the end of the archive                                                                                                                                                |

The source keeps running until you delete it. Persist `source_id -> target_id`, the restore
operation ID and its idempotency key. To switch, read the target's connection URI, make your pool
use the new ID in both the connection string and the `wsProxy` hints, drain the old pool and
delete the old database when you are done. Once writes reach the target, do not switch back to
the source without reconciling them. A stale ID fails with `28P01` ([A.4](#a4-sqlstate-at-connect-time)).

The restore is ready when its operation is `succeeded`: recovery has promoted the database onto a
later timeline, its roles are reset and the first base backup of the new timeline is DONE. Compare
your markers before cutover. A restore whose operation ends `failed` (for example `no_recovery_point`
or `archive_unusable` after the `202`) is not tried again by the node: it abandons the build, and
the target stays in `error` and holds nothing on the node. Its error code can change to
`volume_missing` after the node's agent restarts, because the node has nothing of the target and
the API names no source for a failed restore. Delete the target and request the restore again with
a new `Idempotency-Key`.

A restore (or a create) is failed by the operation timeout (`operation_timeout`) after 20 minutes
without a report. The node reports a build that is under way as `building` with every pull of its
page, and each report restarts the 20 minutes, so a restore that waits for the node's one big-job
slot (one base fetch or base backup at a time, first come first served, for every restore and
create on the node) behind other restores is not failed while its node reports it, however long
the queue. Restores requested together on one node take turns: each holds the slot for 18.2 s
(xs-sized) and 99 to 170 s (557 MB of data), as measured, so the last of a large batch is ready
after the sum of the slot times of all of them. A build the node reports nothing about for 20 minutes (the
node or its link is down) is failed `operation_timeout`; it is failed 20 minutes after its
placement if the node never reported it. A create or a restore that is still `building` 24 hours
after its placement is failed `operation_timeout` as well, whatever the node reports ("Build
exceeded 24 hours after its placement"): `building` says that the node awaits the build and not
that it moves. **The October 25 bounded G9 case passed on the final release: eight queue witnesses exceeded
20 minutes, with fetch and post-first-backup/Ready restarts, the same backup without refetch,
and all nine full fingerprints/natural sleeps verified** (the plan's 11.1 row "The operation timeout
counts the time without a report", its historical 11.2 acceptance and the dated completion sequence).

Request the restores of one node's population in batches, the next batch when every operation of
the previous one has ended. A batch is bounded by the node's awake memory: a restore starts its
PostgreSQL right after its fetch and keeps it running through its first base backup and the listing
after it, which wait for the slot behind the other restores, so nearly all restores of a batch are
awake at once, and a start that the node cannot fit within its admission wait is refused and fails
that restore `start_failed`. The summed memory of the size classes of a batch must stay within the
awake budget of the region's node policy (the operator tells you; the plan's value for EU1 is
9,937 MiB: at most 38 xs-sized (256 MiB) or 9 gate-sized (1 GiB) restores at a time, or a mix that
adds up to it, and less what the node's other awake databases hold). This capacity bound is derived from code and policy. The October 25 nine-target bounded batch
passed; other batch sizes are not certified by that receipt. The same wait counts for a create: creates that
you send together on one node queue for the same slot and are awake together too.

On an installation whose release does not have the report-based timeout, the 20 minutes run from
the first `building` report whatever the progress and include the wait for the slot: restores
requested together on one node time out far below 2.5 GiB of data, more than about 65 xs-sized or
7 to 12 gate-sized restores at once are longer in the queue than 20 minutes and most or all of them
are failed, and the build can end ready on the node and archive WAL while the API keeps the target
`provisioning` with the operation `failed`. There delete such a target and request the restore
again, and keep each batch's summed slot time well within 20 minutes. A release rollout restarts
the node's agent, which builds a restore it was working on again: it fetches again from the
beginning when the restore's first base backup was not DONE (that costs the restore its time
again), and finishes over that backup, with no second fetch, when it was. A rollout does not fail
a restore. The October 25 G9 receipt qualifies the exercised fetch and post-first-backup/Ready
adoption paths; it does not claim a fresh live interruption of the narrow DONE-before-listing
`Resume::Finish` path, whose earlier real-PostgreSQL regression remains valid.

| `409` reason         | Meaning                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `archive_expired`    | deleted source past `deleted_at + backup_retention_days`, or its cleanup has begun                                                         |
| `no_recovery_point`  | no complete base backup ends at or before `target_time`, or its WAL chain has a gap                                                        |
| `archive_unusable`   | the v1 catalog reads at most 16,000 objects and 64 base backups per database, and the listing was incomplete, invalid or beyond that bound |
| `name_in_use`        | a live database of the project already has the target `name`; choose another                                                               |
| `source_unavailable` | the source's class is disabled, its region record is gone or its credentials are unavailable                                               |
| `region_unavailable` | the `region_id` of the request is not the source's own region (a restore stays in the source's region)                                     |
| `generation_changed` | the source, its retained archive or the placement changed under the request; retry                                                         |

A restore needs capacity like a create; without it the target waits unplaced and the operation
stays `pending`. **Measured on EU1** (2026-10-23, "Live acceptance on the slot-pool release, part
1", test data): a point-in-time restore was ready 50.1 s after the request and a full restore
44.7 s with an equal digest; of 8 restores, 7 became ready, the `xs`-sized ones in 34.5 to 50.9 s
and the gate-sized ones (the size of the cold gate's databases, 557 MB) in 248.7 s and 319.3 s. The
248.7 s restore ran alone: its data lay in WAL (889 MB replayed in 139 s off the slot) and it held
the slot for 99 s. The 319.3 s restore, with its data in the base backup, overlapped the agent's own
rebuild of a failed restore of the same backup, waited 6.4 s for its listing and 112 s for its first
base backup, held the slot for 170 s, and took about 200 s without the waits. A node runs
one base-backup or restore job at a time (`backup.base_backups` 1), which serialises the base
fetch and first backup of every restore on it: a restore was ready 154.6 s after the request when
alone and 309.5 s with three at once on 2026-10-18 ("Stage 5.1 restore, PITR and delete on EU1").
On US1 a full restore was ready in 26.5 s ("US1 database acceptance in `us-dev`"). These are
restore times of test databases, not a recovery-time promise; the time to restore a whole node is
in [7.3](#73-recovery-time).

The October 23 restore failures listed in [8](#8-not-available-yet) are historical. The corrected
regional provider paths and bounded G9 queue/restart acceptance passed on October 25. A terminal
failed `/restore` operation remains failed; reconcile its target before requesting another restore.

### 2.8 Webhooks

A webhook subscribes an HTTPS URL to the events of your project's databases, so that nothing has to
poll. These events exist now:

| Type | When |
| --- | --- |
| `database.created`, `database.ready` | the database was accepted, and it is ready to connect |
| `database.woke`, `database.slept` | it started for a connection or `resume`, and it went to sleep when idle |
| `database.suspended`, `database.resized`, `database.deleted` | a `suspend`, a resize and a delete finished |
| `operation.succeeded`, `operation.failed` | an operation you started finished (`data.operation_id`, `kind`, `error_code`); the operations PGCF starts itself (`database.hibernate`, `database.wake`) are announced as `database.slept` and `database.woke` instead |
| `webhook.test` | only from `POST /v1/webhooks/{id}/test` |

```sh
curl -sS -X POST https://api.example.org/v1/webhooks -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{
    "url": "https://hooks.example.com/pgcf",
    "event_types": ["database.*", "operation.*"],
    "database_ids": ["<optional: only these databases>"],
    "headers": {"Authorization": "Bearer <your receiver token>"}
  }'
# 201 {"id":"whk_...","project_id":"prj_...","url":"...","event_types":[...],"database_ids":null,
#      "header_names":["Authorization"],"created_at":"...","secret":"whsec_..."}
```

- **Patterns:** `*`, `<group>.*` or one exact type. An integrator key subscribes its own project; an
  administrator key names `project_id`. A project holds at most 20 webhooks.
- **The secret** is shown in the creation answer only (and in an idempotent replay of it). The static
  `headers` are stored sealed and never shown again (only their names). Many automation tools cannot
  verify a signature but can check a header or keep the URL secret; use `headers` for them.
- **The URL** must be `https`, on port 443 or 8443, with a DNS name (no IP address, `localhost`,
  user information or fragment). Redirects are not followed.
- **A delivery** is a POST of `{"id","type","occurred_at","project_id","database_id","data"}` with the
  headers `PGCF-Signature: t=<unix seconds>,v1=<hex>`, `PGCF-Event-Id` and `PGCF-Delivery-Id`. The
  signature is the hex HMAC-SHA256, keyed with the secret, of the string `<t>.<raw body>`; reject a
  `t` more than five minutes from your clock.
  ```ts
  import { createHmac, timingSafeEqual } from "node:crypto";
  function verify(secret: string, header: string, rawBody: string, nowSeconds: number): boolean {
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
    if (!m || Math.abs(nowSeconds - Number(m[1])) > 300) return false;
    const mac = createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
    return timingSafeEqual(mac, Buffer.from(m[2]!, "hex"));
  }
  ```
- **At least once.** Answer 2xx within 5 seconds; deduplicate by the event `id`. A failure is retried after
  1 min, 5 min, 30 min, 2 h, 6 h and then every 12 h, for 24 hours in all; `Retry-After` (at most one
  hour) replaces the delay. A 4xx other than 408, 425 and 429, and any redirect, end the retries at once.
  A delivery that is out of retries is dead-lettered: `GET /v1/databases/{id}/webhook-deliveries` shows it
  (delivered ones for 24 hours, dead-lettered ones for seven days), and `POST …/{delivery_id}/replay`
  delivers it again with a fresh window. Deleting a webhook dead-letters its waiting deliveries.
- **Timing.** Events leave within about a minute of the change: they are read from the lifecycle log by the
  minute cron, so an event is not a real-time signal for a connection.
- **History is not announced.** A webhook sees events from its creation on. Events of a restored copy
  belong to the new database.

### 2.9 Schedules

A schedule runs SQL statements on a database at fixed times, without a connection of yours. The run is
an ordinary request to `/sql` that PGCF sends as one of the database's roles, so it wakes a sleeping
database exactly as your own request does and the database goes back to sleep after its idle time.

```sh
curl -sS -X PUT https://api.example.org/v1/databases/$DB/schedules/cleanup -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{
    "cron": "30 3 * * *",
    "role": "app",
    "statements": ["delete from sessions where expires_at < now()"],
    "timeout_ms": 60000
  }'
# 201 {"name":"cleanup","cron":"30 3 * * *","every_seconds":null,"statements":[...],"role":"app",
#      "timeout_ms":60000,"enabled":true,"next_run_at":"2026-10-31T03:30:00.000Z","created_at":"..."}
```

- **Times.** `cron` is a UTC five-field expression (`*`, numbers, ranges, steps, lists, month and weekday
  names; a day that is restricted in both the day-of-month and weekday field matches either, as in Vixie
  cron). `every_seconds` (60 to 2,678,400) counts from the moment you create the schedule. Give exactly
  one. There is no finer resolution than a minute: a database that must run something more often than
  that has to stay warm and run it itself.
- **Start offset.** A run starts a fixed time after its instant, different for each database and schedule,
  up to a quarter of the interval and at most one minute, so that databases that share an expression
  do not wake together. `next_run_at` is the instant, not the start.
- **The statements** are one transaction (at most 20 statements, 64 KiB together) sent with a `SET LOCAL
  statement_timeout` of `timeout_ms` (default 60,000, at most 900,000). The role must exist and needs
  only the rights the statements use. A database holds at most 20 schedules.
- **Outcomes** are listed by `GET …/runs` (the last 50): `succeeded`, `failed` (PostgreSQL refused a
  statement; `sqlstate` tells which), `timed_out`, `rejected` (the role, its password or the endpoint
  is unusable), `outcome_unknown` (the answer was lost: **the run is never sent again**, and the next
  occurrence is a new run, so write idempotent statements), `skipped_capacity` (the node refused to
  wake the database; the run is tried again with backoff until half the interval has passed, at most
  ten minutes), `skipped_suspended`, `skipped_deleted` and `skipped_missed` (the run could not start
  within half the interval; it is not made up).
- **A suspended database is not woken** by a schedule; resume it and the next occurrence runs.
- **A restored copy has no schedules**, because it is a new database; schedules are not part of the data.
- **Cost.** Every run that starts the database adds to its `awake_seconds`. A schedule that runs more
  often than the idle time keeps the database awake.
- `POST …/schedules/{name}/run` queues one run now, besides the regular ones (`manual: true`).

## 3. Connecting

### 3.1 Driver configuration

Use the Neon serverless driver's WebSocket mode. The driver version PGCF's own acceptance suite
runs is `@neondatabase/serverless` 1.2.0 (`scripts/e2e/probe/worker.ts` is the reference):

```ts
import { Client, Pool } from "@neondatabase/serverless";
// Outside Workers (Node) also: neonConfig.webSocketConstructor = WebSocket from the "ws" package

const target = new URL(connectionUri); // from GET .../connection-uri
const database = decodeURIComponent(target.pathname.slice(1)); // the 20-character ID
const user = decodeURIComponent(target.username);

const pool = new Pool({
  connectionString: connectionUri,
  max: 10, // well below the size class's max_connections
  connectionTimeoutMillis: 70_000, // 3.4: the Edge waits up to 60 s for a wake
  idleTimeoutMillis: 30_000,
});
pool.on("error", () => {
  /* an idle client was closed, for example "database sleeping"; the next query reconnects */
});
pool.Client = class extends Client {
  constructor(config?: ConstructorParameters<typeof Client>[0]) {
    super(config);
    this.neonConfig.useSecureWebSocket = true; // wss
    this.neonConfig.forceDisablePgSSL = true; // TLS is the WebSocket; see 3.3
    // pipelineConnect keeps its default "password" and coalesceWrites its default true; see below
    // The driver prepends wss://; return host and path only, with both hints.
    this.neonConfig.wsProxy = (host) =>
      `${host}/v2?${new URLSearchParams({ database, user })}`;
  }
};
```

Keep the driver's defaults `pipelineConnect: "password"` and `coalesceWrites: true`: the driver
then sends the StartupMessage, the password and the first query in one WebSocket message. The
gateway answers AuthenticationCleartextPassword, logs in to PostgreSQL with SCRAM-SHA-256 on
the node and sends AuthenticationOk through ReadyForQuery as one message, so a new connection
needs one round trip after the upgrade instead of four, also after a wake: a sleeping database's
connection is asked for its password while it waits. The gateway decides from the message that
carries the StartupMessage, so pass the password as a string (a password function must not wait
for anything). `pipelineConnect: false` still works and authenticates with SCRAM end to end, at
three more round trips per connection. A TCP DSN with only the hostname replaced is not enough.
For HTTP query mode (`neon()`) see [3.7](#37-http-query-mode-neon).

For `psql` and migration tools build the CLI (`pnpm --filter @pgcf/cli build`) and run
`node packages/cli/dist/main.js connect --endpoint wss://db.example.com --database <id> --user <role>`;
use the printed loopback port with `host=127.0.0.1` and `sslmode=disable`. The CLI never retries
SQL and allows 16 local connections.

### 3.2 What the gateway does and does not support

- One WebSocket is one dedicated PostgreSQL backend and there is no server-side pooler: session
  state (prepared statements, temporary tables, advisory locks, `LISTEN`) is ordinary PostgreSQL
  session state and ends with the connection, also when the database sleeps. None of these is
  separately verified by PGCF's acceptance.
- Cancel requests are not supported (the gateway closes such a connection); use
  `statement_timeout` and `pg_cancel_backend()` from another session.
- `replication` connections and logical replication are refused. Frames are binary; text
  WebSocket frames are refused.
- Text-format results are what the acceptance suite verifies. Decoded binary-result assertions
  failed in an earlier acceptance under the retired runtime, on WebSocket and on direct TCP with
  node-postgres 8.22, and have not been run since; do not rely on binary result formats.
- One WebSocket message may be up to 32 MiB; the gateway sends frames of at most 64 KiB. `COPY`
  works over the same connection (a 105 MB binary `COPY` integrity check through the CLI passed
  under the retired runtime and has not been run on the node runtime).
- The gateway pings every 30 s and drops a connection that misses a pong; ordinary WebSocket
  stacks answer automatically.
- The StartupMessage must arrive within 10 s of the upgrade and is at most 10,000 bytes. A
  password pipelined with it is a PasswordMessage of at most 4,096 bytes; an empty, oversized or
  wrong one, an unknown role and an unknown database are all answered with the same `28P01`.
- The gateway logs in with a pipelined password (and over HTTP) only to a PostgreSQL that asks for
  SCRAM-SHA-256 with at most 100,000 iterations (PostgreSQL's default `scram_iterations` is
  4,096), or for no password; anything else answers `08006` and never receives the password.

### 3.3 TLS

Two hops carry your data over a network, and both are protected: your client to Cloudflare over
`wss` (Cloudflare terminates TLS for the hostname), and Cloudflare to the node's gateway through the
node's Tunnel and Cloudflare Access with a signed, 30-second route token. The last hop, gateway to
PostgreSQL, is a Unix socket on the node: PostgreSQL has no network address at all, and its unit has
no network. The gateway answers a PostgreSQL `SSLRequest` or GSS request with `N`, so a client that
requires protocol-level TLS (`ssl: true`, `sslmode=require`) fails; the WebSocket is the
encryption. A password pipelined with the StartupMessage travels inside that WebSocket to the
gateway, which proves it to PostgreSQL with SCRAM-SHA-256 and continues only after PostgreSQL's
server signature matches; the gateway never logs or stores the password and zeroizes it after the
login. Without a pipelined password (`pipelineConnect: false`, the CLI) SCRAM runs between your
client and PostgreSQL, and PGCF's Edge and gateway only relay it.

### 3.4 Timeouts and retries for a sleeping database

An existing database has only two temperature states: **warm** means its serving PostgreSQL is
running; **cold** means it is not running. During ordinary idle sleep its volume stays mounted.
An eligible connection takes an idle slot of the node's pool, binds it and starts PostgreSQL through the node's
admission. One-hour and 24-hour cohorts are measurements of the same cold state. Cached pages,
prestarted slots, suspension, recovery and maintenance do not add temperature states; manual
suspension still requires an authorized resume.

**Measured cold requests.** The whole request is the six statements of the SaaS page request sent
as one HTTP `/sql` transaction ([3.7](#37-http-query-mode-neon)) from a Worker over the public
hostname, one request per database, 8 s apart, to databases that had been asleep. This is the
request go-live gate G3 counts: the first request after a sleep may be one HTTP `/sql` transaction
(owner decision D1, 2026-10-19); WebSocket compatibility remains required. Each scheduled first
request, including an error, retry or pool miss, remains in the acceptance ledger.

| Asleep | Date | Samples | p50 | p95 | Max | Plan row |
| --- | --- | --- | --- | --- | --- | --- |
| about 50 h (the 24 h stratum), on the slot pool | 2026-10-23 | 59, 0 failed | 948 ms | 1,583 ms | 1,851 ms | "Slot pool live on EU1 and US1, and the first 24 h cold pass on it" |
| 1 h or more, before the slot pool | 2026-10-20 | 59, 0 failed | 1,126 ms | 1,814 ms | 2,327 ms | "Stage 5.3 cold gate, 1 h stratum, full pass of 59 samples" |
| 1 h or more, while the node ran the first day's base backups | 2026-10-20 | 59, 0 failed | 1,717 ms | 5,522 ms | 9,061 ms | "Cold pass during the first day's base backups" |

In the 24 h pass 26 of 59 samples were at or above 1 s (39 of 59 in the 1 h pass). From a laptop
(`pgcf connect` over the public hostname) the first answer had a p50 of 1,027 ms over 10 samples
after 1 h or more asleep (2026-10-20, "Stage 5.3 cold gate, 1 h stratum, after the race fix").
The cold gate's databases are 59 `sm`-class databases with a dataset of about 510 MB ("Stage 5.3
cold gate, first pass of the 1 h stratum on the final code"); the passes above name no other sample.

**The target is not met.** The owner-confirmed target of 2026-10-24 is whole-request p95
**strictly below 1,000 ms**, including connection, wake, authentication and all six statements.
There is no additional 750 ms gate. Measure EU1 and US1 independently from a Cloudflare Worker
through the public endpoint, using the established one-hour/24-hour protocol, 150 seconds between
requests and at least 59 cold samples per region per stratum at declared density/background load,
including normal backups. Final acceptance requires zero errors or requests at or above 1,000 ms;
every scheduled first request, retry and pool miss remains counted. The historical passes above used
their recorded eight-second spacing; the rapid mixed A/B is not a final G3 pass.
Record release, colo, class, dataset, load, p50/p95/max, errors and capacity waits. The Germany-laptop
path is reported separately. The best full historical EU1 pass above has p95 1,583 ms; neither
region has a passing final-release result. An empty-node run, connect-only timing, trivial query
or newly created database cannot close G3.

**Where the time goes**, in the 24 h pass (p50 / p95 ms): the hop from the Worker to the Edge
13 / 204, the Edge's admission by the DatabaseActor 23 / 260, the Tunnel to the node 69 / 182, the
wake the gateway waits for 313 / 751 (the node agent's own total 309 / 711: binding the slot 13 /
84, PostgreSQL's exec to `starting` 144 / 407, to the checkpoint read 51 / 153, to ready 40 / 172),
the login 116 / 280 and the six statements 270 / 522. All 59 wakes took an idle slot. These
component percentiles cannot be added to reconstruct whole-request p95. This historical pass
predates the current program warming and bind-prefetch experiment; it cannot select a prefetch
mode or qualify the candidate. The October 25 bounded comparison selected Off, now fixed in
signed `sha-eb9d0f729663`; both final regional one-hour/24-hour gates remain open.

**A node that is busy with base backups is slower.** A cold request that met a node with due base
backups was three to eight times slower (the 1,717 / 5,522 ms row above): databases that sleep all
day get their base backup at the first wake after it is due. The agent now holds a due base backup
back while wakes are served (at most 10 minutes) and limits the backup slice's disk bandwidth; both
are in the releases live since 2026-10-22 ("Release of main `69d2b245` live on EU1"). Their effect on
the cold request has not been measured ("Background jobs slow cold requests", plan 11.2).

**Warm requests.** The same six-statement batch against an awake database took 275 to 340 ms from a
Worker (2026-10-20, "Stage 5.3 cold gate, first pass of the 1 h stratum on the final code"). A new
connection to an awake database had a median of 124.5 ms through a service binding and 133.5 ms
through the public hostname, 14 calls each (2026-10-18, "Cloudflare Access in front of the node
gateways, live on EU1"). PGCF has no warm p95: **to be measured** (the warm pass of Stage 5.3).

A WebSocket connection that sends the same statements one by one costs more: a median of 789 ms
through a service binding and 989 ms through the public hostname, after at least 2 h asleep, 5
databases each, before the slot pool (2026-10-19, "First live binary update of EU1 and the cold
request after it"). These are small samples and no p95.

Edge/Actor admission has a **60-second deadline** (`ADMISSION_DEADLINE_MS`); the Actor fallback
coalesces connections of one database and admits at most 32 waiters. A native wake-ticket hold
has a separate **25-second bound**, counted from the HTTP request receipt or WebSocket upgrade,
and returns `57P03` on timeout. Giving up removes that connection or waiter; it does not cancel
the database wake. A later connection may therefore find the database already ready.

Recommended policy (derived from those numbers, not a PGCF guarantee):

| Setting | Value | Reason |
| --- | --- | --- |
| Connect timeout | at least 65 s; 70 s used above | 60 s Edge deadline plus login and startup; a wake that waits in the node's queue takes seconds, not milliseconds |
| Statement timeout | separate from the connect timeout | a connect timeout does not bound a query |
| Connection/admission refusals `57P03`, `08006`, `53300` | reconnect with exponential backoff and jitter: 1 s, 2 s, 4 s, then 8 s, for about 90 s in total | inspect the admission cause and retry hints; manual suspension requires resume, and unavailable storage requires operator action |
| Retry `28P01`, `3D000`, `28000`, `0A000`, `08P01` | never | configuration or credentials; fix, do not loop |
| After SQL was sent and its answer was lost | reconnect; reconcile the outcome or use application-level idempotency before reissuing a write | PGCF never replays SQL; an in-flight statement or `COMMIT` can still complete after the error |
| Latency-sensitive paths | pre-wake with `POST /resume`, keep the database awake longer (`sleep_after_seconds`), or use an always-warm class (`sleep_after_seconds: null`) | removes the wake from the request |

The connection retry rule does not authorize retrying a transaction whose outcome is unknown
(`08007`, a dropped response, or the HTTP result-size refusal described in 3.7). An API
`Idempotency-Key` does not deduplicate SQL statements.

**What a `57P03` means.** It is PostgreSQL's "cannot accept connections now"; every cause below is
safe to retry under the rule above. The error's DETAIL and HINT name the cause where the node
supplied one:

| DETAIL and HINT | Cause | Retry |
| --- | --- | --- |
| `storage` | The node's thin pool has no room: free data is below the reserve, or metadata is at 75 %. The node refuses every wake, create and restore until space is back; running databases keep running. | back off; waiting does not make room, so there is no hint |
| `node at awake capacity`, HINT `retry after <n> s` | The node could not admit the start within its queue wait for want of memory: under the memory rule `measured` its available memory, minus the starts in flight and the 600 MiB floor, was below the database's memory (or the start ahead of it in the queue could not start). Starting values: a wait of up to 10 s and a hint of 5 s. | retry after the hint; shed load |
| `node busy starting databases`, HINT `retry after <n> s` | The node had the memory but could not begin the start within its queue wait, because it was starting as many databases as the policy allows at once (EU1 runs 8, 4.1): many databases were waking together. The same wait and hint as above. | retry after the hint; shed load |
| none (a bare `57P03`) | A hold that carries no detail: a manual suspension, a database that is being created, restored or resized, a maintenance cycle that holds new wakes on the node, the source of a move, a database whose recovery after a crash is pending, a volume that cannot start, a node that is offline, lost, closed or fenced, a node whose copy of the database's state was still older than the connection after 8 s (a connection right after an idle sleep makes it fetch the state at once and wait for it; a longer wait means its link to Cloudflare is down), more than 32 waiters, or a native held wake that did not finish within 25 s (the separate Edge/Actor admission deadline is 60 s) | by cause, from the table below |

**Early sleep (decision D2, the plan's default: the owner has not named another).** When a wake
waits for room, the node may put one idle but awake database to sleep for each waiting wake, before
its idle time; never an always-warm database and never one with client activity in the last 30
seconds. An early sleep is a full sleep proof, so a wake that waited for it takes seconds and misses
the one-second target: the proof alone took 1,016.6 ms at p50 and 1,084.4 ms at p95 in Stage 1 on
EU1 (2026-10-17, 10 runs, "Stage 1 Block 2: create and sleep costs"), most of it the archive wait. It is
not a refusal: the wake succeeds, and the time is counted in the cold p95. The counts of early
sleeps and of capacity refusals on a loaded node are **to be measured** (Stage 5.6).

A `57P03` that arrives immediately, in well under a second, is not a wake timeout. At the 60 s
mark the Edge aborts the admission and answers `08006` ("connection admission interrupted"); the
Actor's own deadline answers `57P03` and can win that race. To tell the causes apart read
`GET /v1/databases/{id}`:

| `desired_state` / `observed_state` / `status_message` | Cause | Action |
| --- | --- | --- |
| `suspended`, `suspension_reason: manual` | manual suspension | `POST /resume` |
| `running`, `pending` or `provisioning` | creation, restore, resize or resume in progress | poll the operation |
| `running`, `node_id: null`, `Waiting for verified regional capacity` | no node fits yet | wait; set a deadline |
| `error` | the node reports a failure | escalate |
| `hibernated` (idle) and `57P03` | the wake could not start: the node is offline, lost or closed, or an admission change is in flight (at once); or the node refused the start after its queue wait, for want of room in its thin pool (DETAIL `storage`) or because its awake capacity is full (DETAIL `node at awake capacity`, with a retry hint) or it is starting as many databases as it may (DETAIL `node busy starting databases`, with a retry hint); no wake operation starts | back off and retry; shed load |

### 3.5 Idle sleep and wake on connect

A database hibernates when it has had **no busy session and no client activity for
`effective_sleep_after_seconds`**: its own `sleep_after_seconds` (60 to 900, set on create or with
`PUT /v1/databases/{id}/idle-time`; `null` hands it back to the class), else its class's; a class
with `null` is always warm (`effective_sleep_after_seconds` is then `null`). The `PUT` is accepted
in every state but deleted, also during a resize; it creates no operation and no new generation,
and the value applies from the next idle check. A session is busy while
it is authenticating, in a transaction (including `idle in transaction`), running a statement, in
`COPY`, or when its state is uncertain; a prepared transaction also stops the sleep (`power_busy`).
A merely open, idle connection is not busy and does not keep the database awake: the gateway
closes it with WebSocket close code 1000 and reason `database sleeping` when the database goes
down. Pools must treat that as a server disconnect and reconnect. Bound
`idle_in_transaction_session_timeout` on your roles, or a forgotten transaction pins the database
awake.

The first connection after an idle sleep triggers `database.wake` and waits (3.4). A manually
suspended database is not woken by connections. A database is asleep about a minute after its last
statement at a 60 s idle time: 68 s on 2026-10-18 ("Stage 5.2 sleep and wake on EU1": the sleep proof
and its report add 6 to 8 s) and 66 s on 2026-10-23, with an open idle client connection and
WebSocket pings that did not keep it awake ("Live acceptance on the slot-pool release, part 1").
The production classes sleep after 300 s by default. A database sleeps only with its WAL
archived, so after a bulk load its sleep waits for the node's archive (about one 16 MiB segment a
second, [4.4](#44-capacity-caps)).

### 3.6 Connection limits

| Limit | Value | Where |
| --- | --- | --- |
| Server sessions | the class's `max_connections` (`xs` 20, `sm` 100, `md` 200, `lg` 300); PostgreSQL reserves a few for superusers (the node agent connects as one) | PostgreSQL; refusal is `53300` |
| Sessions of one role | the role's `connection_limit` when set ([2.3](#23-roles-connection-uri-and-passwords)) | PostgreSQL; refusal is `53300` "too many connections for role" |
| Sessions per database through one gateway | 200 (2,000 per gateway), including parked HTTP-SQL backend sessions; a WebSocket connection beyond the cap fails as `08006` | fixed native gateway constants; no count override |
| New connections per database, all roles and networks | 12,000 per 60 s (**Dev value**) | Edge rate limiter `DATABASE_CONNECTION_RATE_LIMITER`; refusal is `53300` |
| New connections per database, role and source network | 6,000 per 60 s (**Dev value**) | Edge rate limiter `CONNECTION_RATE_LIMITER`; refusal is `53300` |
| New connections per database and role from a same-account Worker on a service binding (no `CF-Connecting-IP`) | 12,000 per 60 s (**Dev value**), in a limiter of its own; such a caller never counts in the two public limiters above | Edge rate limiter `BINDING_CONNECTION_RATE_LIMITER`; refusal is `53300` |
| Admissions per database per minute | 12,000 (**Dev value**) | DatabaseActor; the API Worker's `DATABASE_CONNECTION_LIMIT_PER_MINUTE` |
| Waiters during a fallback Actor wake | 32 per database | DatabaseActor |
| Held native wake connections | 32 per database, 512 per gateway; 25 s bound | native gateway wake queue |
| Simultaneous request handshakes | 128 per gateway; not a running-query concurrency limit | native gateway |
| Accounted gateway buffer bytes | 192 MiB total, 96 MiB per database on both nodes; a session reserves a 144-KiB base lease | native gateway; both environment overrides absent in the October 26 snapshot |
| HTTP-SQL idle backend pool | Four per database/role; 10 s idle and 60 s lifetime | native gateway |

**The four rate values are the Dev installation's.** They were read from its Edge and API
configuration, which holds no secret, and recorded on 2026-10-23 ("Dev connection limits recorded
(S6-03)"). The
example configurations in the repository carry 120, 120 and 1,200 new connections per 60 s and 12,000
admissions per minute; they are examples and not the installation's values. These values carry
into production acceptance (plan Stage 7) unless the operator changes them and tells you; there
is no separate set of production values yet. They are
installation configuration, and counters are per Cloudflare location and eventually consistent.

Application concurrency is bounded by the available non-reserved PostgreSQL slots, any role
limit, the 200-session per-database gateway cap and the shared 2,000-session gateway cap. The
`lg` class's 300 PostgreSQL connections do not raise the gateway's 200-session cap. These are
ceilings, not a guarantee that all slots are available. The gateway byte budget may refuse before
the count ceiling; its accounting is not a process-RSS hard cap. Both running gateways had
unlimited systemd MemoryMax/MemoryHigh, MemoryLow 128 MiB and LimitNOFILE 65,536 in the
October 26 selected snapshot. The fixed limits and their sources are unchanged in the accepted
`acb21e26` release; no saturation-derived usable-concurrency promise is made.

SQL statements on an established connection do not count against the rate limits, so keep
connections and pool them: a platform that opens a connection per request meets the per-database
limit first.

### 3.7 HTTP query mode (`neon()`)

**Measured on the live installation:** the format below is checked by the actual
`@neondatabase/serverless` 1.2.0 driver against the Edge and by the gateway's protocol tests. The
cold requests of [3.4](#34-timeouts-and-retries-for-a-sleeping-database) use this mode (p50 948 ms
and p95 1,583 ms over 59 databases asleep about 50 h, 2026-10-23). On 2026-10-19, before the slot
pool, a SaaS page request as **one `transaction()` on a database that had slept 60 to 137 minutes**
(all steps in one request) took 472 to 784 ms (median 611 ms, 8 samples) from a Worker through a
service binding to the Edge and 440 to 1,070 ms (median 648 ms, 6 samples) through the public
hostname; the first request statement by statement over a WebSocket, after at least 2 h of sleep,
took a median of 789 ms (binding) and 989 ms (public hostname) over 5 databases ("First live binary
update of EU1 and the cold request after it"). These are separate series, not a paired comparison,
and small samples, not a p95.

`POST https://<host>/sql` serves the Neon driver's HTTP query mode: `neon()`, its
`transaction()`, and `Pool.query()` with `poolQueryViaFetch`. One query or one transaction is one
HTTPS request, with no WebSocket upgrade and no SCRAM exchange by your client. The Edge admits each
request as it admits a connection; the node's gateway runs it on a PostgreSQL session it keeps
for a short time per database and role.

```ts
import { neon, neonConfig } from "@neondatabase/serverless";

// The driver's default rewrites the host to api.<domain>; PGCF serves /sql on the database host.
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;
const sql = neon(connectionUri); // postgres://<role>:<password>@<host>/<database-id>

const items = await sql`SELECT id, name FROM items WHERE owner = ${owner}`;
const [, total] = await sql.transaction(
  [
    sql`INSERT INTO items (owner, name) VALUES (${owner}, ${name})`,
    sql`SELECT count(*) FROM items`,
  ],
  { isolationLevel: "RepeatableRead" },
);
```

| Topic                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password                 | Sent in the driver's `Neon-Connection-String` header over HTTPS to Cloudflare. The Edge forwards it once, in the request body, over the tunnel to the gateway, which authenticates to PostgreSQL with SCRAM-SHA-256 on the node, with the same login and limits as a pipelined WebSocket password ([3.2](#32-what-the-gateway-does-and-does-not-support)). It is never logged or stored and is zeroized in the gateway's memory after use.             |
| Statements               | One statement per query (`a; b` is refused by PostgreSQL with `42601`). Parameters are `$1`, `$2`, ... in text; PostgreSQL infers their types. Results are text, parsed by the driver's type parsers (its `types` option), as with Neon. `arrayMode` and `fullResults` work: the driver applies them itself.                                                                                                                                                  |
| Transactions             | `transaction()` runs its statements between `BEGIN` and `COMMIT` in one request, with `isolationLevel`, `readOnly` and `deferrable`. An error rolls the whole transaction back.                                                                                                                                                                                                                                                                               |
| Session state            | None across requests: each request starts like a new session (the gateway runs `DISCARD ALL` after it). `SET`, temporary tables, advisory locks, `LISTEN` and prepared statements end with the request; a transaction a single query leaves open is rolled back. Use WebSocket mode for interactive transactions and session state.                                                                                                                           |
| Not supported            | `COPY` (`0A000`); `authToken` / `Authorization` (`0A000`); clients other than the driver must send `Neon-Raw-Text-Output: true` and `Neon-Array-Mode: true`.                                                                                                                                                                                                                                                                                                  |
| Limits                   | Request body 4 MiB, at most 256 statements per transaction, answer 10 MiB of JSON (`54000`; the session is closed and the outcome is unknown).                                                                                                                                                                                                                                                                                                                |
| Sleeping database        | The request waits for the wake as a connection does ([3.4](#34-timeouts-and-retries-for-a-sleeping-database)): at most 60 s, with the same `57P03` and `08006` answers. Set your `fetch` timeout accordingly.                                                                                                                                                                                                                                                 |
| Admission and limits     | Every request is one admission. It counts in the same Edge rate limiters as a connection (a service-binding caller in its own limiter), in buckets of its own (WebSocket handshakes are never used up by queries), and in the admissions per database per minute ([3.6](#36-connection-limits)). With the Dev values of [3.6](#36-connection-limits) that is 12,000 requests per 60 s per database and 6,000 per database, role and source network, counted per Cloudflare location. |
| Errors                   | HTTP 400 with PostgreSQL's error fields (`message`, `code`, `severity`, `detail`, `hint`, `position`, ...); the driver throws them as `NeonDbError`. Admission refusals use the codes of [A.4](#a4-sqlstate-at-connect-time).                                                                                                                                                                                                                                 |
| Unknown outcome          | `08007`: the connection to PostgreSQL ended, or the gateway's answer was lost, after the request was sent. PGCF never sends a request twice and does not know whether a write took effect; retry only idempotent requests.                                                                                                                                                                                                                                    |
| Password change          | A kept session is reused only for the password it authenticated with, and at most 60 s after its authentication: an old password can still succeed for up to 60 s after a password change.                                                                                                                                                                                                                                                                    |
| Unknown database or role | Answers `28P01` "password authentication failed" at once, while a wrong password is checked by PostgreSQL: unlike the WebSocket path, the response time differs.                                                                                                                                                                                                                                                                                              |

Choose HTTP for one-shot queries and short transactions from a Worker (one round trip each);
choose WebSocket for interactive transactions, session state, `COPY`, `LISTEN`, and many
statements in one burst (Neon puts the break-even at two to three queries).

### 3.8 Recommended patterns for Workers

PGCF has no paired measurement of what these patterns gain: the plan's bench arms for a batched
first request (S3-11) have not run live, so the effect column is qualitative. The one comparison
that exists is unpaired: the first request after sleep as one HTTP transaction had a median of
611 ms (binding) and 648 ms (public hostname), the WebSocket series 789 and 989 ms, with different
samples, sleep times and statements ([3.4](#34-timeouts-and-retries-for-a-sleeping-database),
[3.7](#37-http-query-mode-neon)).

| Pattern | How | Effect | Cost |
| --- | --- | --- | --- |
| Place the Worker near the region | `"placement": { "region": "aws:eu-central-1" }` in the Worker's Wrangler configuration (EU1) | shorter round trip for every statement when the Worker runs near the node | one more hop for users far from the EU |
| Batch writes | one `transaction()` in HTTP mode; on WebSocket, one multi-statement query or pipelined queries instead of one round trip each | saves one round trip per statement | a batch fails or commits as a whole |
| Close without waiting | `ctx.waitUntil(client.end())` instead of `await client.end()` (WebSocket mode) | one round trip of user-visible time | none |
| Connect early | on login or navigation, open the connection or send one cheap query (`SELECT 1` over HTTP) before the user's request needs data | hides the wake (the node's part had a p50 of 313 ms in the 24 h pass of 3.4) behind user think time | wakes the database and spends admissions; do it on real user intent only |
| Hold one socket for a burst | a Durable Object per database and role keeps one WebSocket `Client` open for a short idle window (5-10 s) and closes it when idle | saves the connection setup on every request after the first in a burst | uses a session while open; an idle socket does not prevent sleep and PGCF may close it, so reconnect on demand |

## 4. Capacity and limits you must enforce

PGCF refuses or delays starts that its node cannot hold, and it never buys capacity on its own
(purchases and autoscale are off until the owner's costed go). It does **not** enforce budgets,
quotas per tenant, compute autoscaling or branching in v1. The limits below are yours to keep.

### 4.1 Placement and node policy (installation configuration)

Where a new database goes is described in [2.1](#21-create). The per-database memory maximum is
4,096 MiB in steps of 256 unless the operator sets another. EU1 and US1 each have 6 vCPU and 12 GB of RAM
(11,967 and 11,966 MiB visible to the system). What a node admits is decided by the region's node policy (an
admin reads it at `GET /v1/regions/{id}/node-policy`; ask the operator for its values): the memory
rule, the memory floor and the awake-database budget, how many starts may run at once, how long a
wake may wait for room, how long after a wake the CPU quota stays off (the CPU burst), early sleep, the pool reserve, the backup concurrency and the write limits.
The plan's starting values for EU1 are an awake budget of 9,937 MiB, a floor of 600 MiB, at most 4
starts at once and a wait of up to 10 s before `57P03` with a retry hint of 5 s. EU1 runs 8 starts
at once since 2026-10-20 (a data change in its node policy). Forty sleeping databases woken within
5 ms of each other answered with p50 5,337 ms, p95 9,342 ms and a maximum of 10,009 ms at 4 starts
at once (the queue's own 10 s limit), and with p50 2,873 ms, p95 5,415 ms and a maximum of 5,814 ms
over HTTP at 8 (p50 3,765 ms, p95 7,061 ms and a maximum of 7,082 ms over WebSocket); every wake was
answered and none was refused ("Stage 5.6 wake storm, first measurement"). The node starts about 7
databases a second and its CPU, not the cap, is the limit. The other starting values are not yet
replaced by measured ones: **to be measured** (Stage 5.6).

### 4.2 Awake databases: what a sold memory size means

A database's memory is the hard ceiling of its PostgreSQL while it is awake; asleep it uses no RAM
and no CPU. The node admits every start itself, from its own facts (plan 4.6): its pool has room,
the memory rule holds and fewer than the policy's number of starts are in flight.

- **Memory rule `measured`** (the plan's default): the memory available to the node, minus every
  start in flight, minus the floor, must be at least the database's memory. Awake databases are
  not reserved against each other, so your 256 MiB is a ceiling and not a guarantee: if several
  awake databases grow at the same time, the kernel's limit on all databases together ends one
  backend, which may belong to another tenant; that database's PostgreSQL runs crash recovery, its
  sessions drop and no acknowledged commit is lost.
- **Memory rule `reserved`:** each awake database reserves its memory plus a small overhead within
  the awake budget; the memory is guaranteed while it is awake, and fewer databases can be awake at
  once (the plan counts about 37 of 256 MiB on a 12 GB node).

The operator tells you which rule is configured. Decision D3 ([11.5](../architecture/cloudflare-convergence-and-serverless-plan.md#115-decisions-open-for-the-owner))
sets the plan's default to the rule `measured` ((a): measured use, with the slice limit as
backstop); the owner has not named another. What an awake database really uses, by size, and how
often the kernel ends a backend are **to be measured** (Stage 5.6). A wake that does not fit waits in the node's queue for the policy's wait and is then
refused with `57P03` (DETAIL "node at awake capacity" and a retry hint; DETAIL "node busy starting databases" and a retry hint where the memory was there and only the node's limit of starts at once kept the wake waiting). If early sleep is enabled
(the plan's default, decision D2, not yet confirmed by the owner), the node also puts one
idle-but-awake database to sleep for each waiting wake, before its idle time: never an always-warm
database and never one with client activity in the last 30 seconds. An early sleep is a full sleep
proof, so a wake that waited for it takes seconds and misses the one-second target. `awake_seconds`
keeps reporting the truth.

What you must do: keep `sleep_after_seconds` short, avoid always-warm classes except where needed,
and shed load on `57P03` instead of retrying in a tight loop.

**Measured leaf-cgroup limits, US1, October 25:** these are the observed limits of the exercised
XS database and its SM resize, not a reservation of physical RAM against every other tenant.

| Class | MemoryMax | MemoryHigh | CPU ceiling | Write bandwidth | Write IOPS | Swap | Read limits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| XS | 256 MiB | 230 MiB | 0.25 CPU | 8 MB/s | 1,000 | 0 | uncapped |
| SM | 1,024 MiB | 921 MiB | 0.5 CPU | 32 MB/s | 4,000 | 0 | uncapped |

The SM resize, manual-suspend refusal and explicit resume passed, with the source's 100 markers
and the witness's 337 full rows subsequently verified. These observations do not close pool-full,
volume/inode-full, fault or final density acceptance.

**Statistics target and the sold memory.** PostgreSQL's `ANALYZE`, run by a session or by
autovacuum, keeps a sample of 300 × `default_statistics_target` rows in memory, each as wide as it
lies on its page: up to about 8 KB for rows that are never toasted (`STORAGE PLAIN` columns) and
about 2 KB for ordinary rows. The default target of 100 is 265 MiB for the widest rows, more than a
256 MiB database has. Each class therefore sets the target and the number of autovacuum workers by
its memory, so that the samples of a table's own columns, taken by every worker and by one
session's `ANALYZE` at once, fit in half of it: target 20 with one worker for 256 MiB, 40 with one
for 512 MiB, 60 with two for 1 GiB, 90 with three for 2 GiB, and 100 from 2,304 MiB. A lower target
gives each column fewer most-common values and histogram buckets, which the planner's estimates for
skewed columns of large tables can show. Your roles may raise the target for their session, role or
database (`SET`, `ALTER ROLE … SET`, `ALTER DATABASE … SET`), a column's target
(`ALTER TABLE … ALTER COLUMN … SET STATISTICS`, up to 10,000) and `maintenance_work_mem`; they
cannot set the autovacuum workers. The sample grows in proportion to the target, so one larger than
the class holds throttles the whole database at 90 % of its memory and, at the ceiling, ends a
backend (crash recovery; sessions drop; no acknowledged commit is lost). Raise a column's target
only on tables of narrow rows.

**Indexes on expressions are not covered by that.** While the sample lives, `ANALYZE` also keeps the
value of every index expression for every sampled row, one index at a time (the expressions of a
`CREATE STATISTICS` object the same), and a value is as wide as the expression makes it, not as
wide as the row. No setting of a class limits it; the memory is 300 × the target (or all the rows of
a smaller table) × the width of the value. The common case is full-text search: a GIN index on
`to_tsvector('simple', body)` over documents of 22 KB keeps a tsvector of 26 KB for each sampled
row. *Measured* (PostgreSQL 18.6, 2026-10-23, the real slot unit of each class, 6,000 documents):
152 MiB for one `ANALYZE` in every class. In a 256 MiB database that is 204 MiB of the 230 MiB that
the unit cannot give back, and it ends in 5 to 9 s; the autovacuum worker and a session analyzing
two such tables at once did not end in 700 s, the unit stalled for memory about 30 % of the time,
and a new connection waited more than 4 minutes to be served. For a table
with enough rows the same index holds 455 MiB at the 1 GiB class's target, 682 MiB at the 2 GiB
class's and 758 MiB at the 4 GiB class's (rows × width; the lab table has 6,000 rows). Check your
tables for expression indexes whose value is wider than about 1 KB (`to_tsvector`, a large
`jsonb` or `text` expression) and end the cost with one of two remedies, both measured:

- `ALTER INDEX index_name ALTER COLUMN 1 SET STATISTICS 0` (the number is the expression's column
  in the index). `ANALYZE` then skips the expression: the unit grew by 0.0 to 0.4 MiB in the class
  lab and by 2.2 MiB for 8,000 documents in a 256 MiB unit, where the two tables above ended in
  0.5 s. The cost is the expression's statistics. On a new index there are none and the planner
  estimates every `@@` on it with its default of 0.5 % of the rows (a lexeme in all 4,000 rows of a
  table estimated at 20 rows instead of 4,000); on an index that had statistics they stay in
  `pg_stats`, no longer refreshed, until the index is dropped and created again.
- A stored generated column, `tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED`,
  with the GIN index on the column instead of the expression, and the queries on `tsv @@ …`. The
  column is analyzed by its own type: the unit grew by 0.0 to 1.2 MiB in the class lab and by
  2.5 MiB in the 256 MiB unit (two tables at once ended in 1.1 s), and `pg_stats` keeps 10 × the
  target most-common lexemes (200 at target 20) as before. The cost is the tsvector in the table:
  95 MB became 206 MB for 4,000 documents of 22 KB (the GIN index was 5,760 kB either way), and every
  write of `body` computes it.

The class derivation and the detailed expression examples were *measured in a lab* on
2026-10-23 (plan 11.1, "ANALYZE and autovacuum stay inside every class's memory"). On US1 on
October 25, ordinary ANALYZE, actual autovacuum, expression-memory and the supported remedy passed
live. A single oversized ANALYZE reached statement timeout (`57014`, about 63 seconds) before any
kernel OOM, so it establishes no OOM result. Its inconclusive receipt is retained without another
deliberate OOM gate; actual confinement/recovery requirements remain. The reported lab values for
other classes are not converted into unmeasured regional passes.

### 4.3 Thin storage

Every database lives on its own thin LVM volume of its node's one thin pool. The volume's size is
the database's nominal volume size (`storage_mib`, or the equivalent legacy `storage_gib`), real space is taken only as the database writes (an empty database
used 68.6 MiB when it was ready on EU1, 2026-10-17, "Stage 1 Block 2: create and sleep costs"), and the pool does not grow. Sold sizes do not reserve
space: the sizes of the volumes on a node may add up to more than its disk, within a cap of four
times the pool's physical data area. Report physical pool bytes, nominal allocated volume bytes
and the sold-storage admission cap separately; the four-times cap is not additional disk or a
measured workload envelope. Chunks are zeroed before reuse, so space freed by one database is never
readable by another.

- **The pool.** Placement closes a node's pool at 80 % of its data, 50 % of its metadata or the
  cap, and the node itself at 1,000 volumes (the technical bound: the largest count measured on a
  node, raised only after a measurement at a higher count, not a sales limit): nothing new is
  created, restored or moved there, and running databases keep running. A resize creates no
  new volume and does not reserve the full nominal increase, but filesystem growth can allocate
  metadata. A node closed by the pool's data, its metadata or the volume count still grows a
  database's storage while its pool has room. Only the cap, or a pool with no
  room (below), refuses it: on a node at the cap, whatever else has closed it, raising storage gets
  `503 capacity_exhausted` (section 2.5). A region whose nodes are all closed
  holds a new database as "Waiting for verified regional capacity" until a node is added. A node
  whose pool has no room (free data below the reserve, or metadata at 75 %) refuses every create,
  restore and wake with `57P03` and the DETAIL "storage", and a storage resize with the same
  `503 capacity_exhausted`. At a physically full pool, new block allocations fail;
  already-mapped writes can still succeed. In the US live case the mapped ledger kept 41
  acknowledgements at 100% pool usage. A database needing new blocks can fail; this does not mean
  every database stopped or every write failed. After deleting only the owned filler, ordinary
  cold marker requests succeeded without manual resume/repair.
- **One volume.** Raising a database's storage is an admin call (`PUT /v1/databases/{id}/resources`,
  growth only, online); nothing grows a volume for you. `health.disk.status` becomes `warning` at
  90 % used, the threshold of the operator's critical alert (the operator is also alerted at 80 %).
  A full volume or exhausted inodes stop writes. Recovery is by explicit storage growth
  ([2.5](#25-resize)); the candidate verifies actual filesystem capacity before reporting success
  and grows before unproven crash recovery. It imposes no tenant project quota or hidden usable-space
  reserve, and does not promise arbitrary DELETE/VACUUM/TRUNCATE while no space is available.
- **Write limits.** Each database's write bandwidth and IOPS are capped by its size, which bounds
  how fast one tenant can fill the pool.
- **Measured storage acceptance (Stage 5.5).** EU1 passed byte/inode exhaustion and 2-to-5-GiB
  growth, with exact 29/109 acknowledged writes. US1 reached physical pool full, new allocations
  failed, and deleting only its owned filler restored space. All 1,789 ledger acknowledgements
  matched. Three first ordinary cold marker queries took 375.321/660.538/352.437 ms without
  preparatory resume; these are targeted recovery checks, not the six-statement G3 cold gate.
  The mapped ledger did not crash, so no damaged-filesystem recovery is claimed. All owned
  storage/fault fixtures in both regions are physically cleaned.

Watch size yourselves: `storage` and `health.disk` of the database show the newest volume figures,
sampled every minute while the database is awake and every 15 minutes while it is hibernated
(`pg_database_size()` and `storage_used_bytes_max` in usage, the largest sample of the hour,
remain the other sources). A volume can fill in a few minutes, so poll `health.disk` at least
once a minute for a database you are bulk-loading.

### 4.4 Capacity caps

What bounds a node, with the kind of each value as in the header.

| Cap | Value | Kind, date and source |
| --- | --- | --- |
| Node size | 6 vCPU, 12 GB RAM (11,967 MiB visible on EU1) and a thin pool of about 289 GiB | measured: US1 reported 11,966 MiB, 6,000 millicores and 289 GiB (2026-10-22, "US1 installed into `us-dev` from the image") |
| Placement RAM and CPU limits | Below 80 %: CPU uses the highest 30-minute average of the last 3 days; RAM uses max(three-day peak, current sample) plus pending placements and the new database's full memory. Requested CPU must fit physical cores | decided: the owner's rule of 2026-10-17 and its window of 3 days on 2026-10-23 (plan 11.3, "2026-10-17" and "2026-10-23"); see [2.1](#21-create) |
| Pool closed for placement at | 80 % of its data or 50 % of its metadata | decided: the 80 % is the owner's number, the 50 % a plan default (plan 4.3) |
| Sold storage per node | at most 4 times the pool's data (about 1,150 GiB on EU1) | decided: plan default, operator-configurable (plan 11.4, "Logical cap of 4 × pool, operator-configurable") |
| Volumes per node | 1,000 | measured on 2026-10-17: the largest count tested, `lvcreate` p50 about 270 ms at 1,000 volumes ("Stage 1 Block 1: LVM at scale"); placement closes a node at 1,000 volumes (built 2026-10-20 and in the API deployed on 2026-10-22: "Placement closes a node at 1,000 volumes, and the capacity cron reserves no order while purchases are off"; "Release of main `69d2b245` live on EU1"). It is a technical bound, raised only after a measurement at a higher count, not a sales limit |
| Volumes carried so far | up to 301 on EU1 (2026-10-19 and 2026-10-20), 167 on 2026-10-23 | measured: a count carried, not a cap ("Placement closes a node at 1,000 volumes, and the capacity cron reserves no order while purchases are off"; "Live acceptance on the slot-pool release, part 1") |
| Starts at once | 8 on EU1 | node policy, set 2026-10-20 ("Stage 5.6 wake storm, first measurement") |
| A wake storm | 40 sleeping databases woken within 5 ms of each other: all answered, none refused, p95 5,415 ms over HTTP and 7,061 ms over WebSocket at 8 starts at once | measured 2026-10-20 (same row). Later storm p95 7.9–17.2 s failed; preserve that history. The October 25 required EU path was accepted using the later 40/40 HTTP round and targeted proof recovery (dated ULTRA update); final regional cold gates remain separate. |
| Awake databases at once | no count cap; bounded by the memory rule of [4.2](#42-awake-databases-what-a-sold-memory-size-means) | **to be measured** (Stage 5.6): memory per awake database by size and the number awake at once |
| Databases per node (density) | no count limit besides the 1,000 volumes | Reuse the earlier one-hour pattern and 1,000 exact-counter cycles with the accepted October 25 EU 40/40 round and targeted proof recovery. US1 completed all 241 density targets at 21:19:40 UTC; baseline 318 nondeleted/zero awake, including 316 auto-idle and two manual suspensions. The dated ULTRA checkpoint and current capacity row state its measured envelope. Final one-hour/24-hour regional cold acceptance remains open. |
| Per-database memory | at most 4,096 MiB unless the operator sets another | configuration of the region |
| Pool reserve, node write rate and per-database write limits | starting values: a reserve of 6 GiB, 16 MB/s and 1,000 IOPS for a 256 MiB database | **to be measured** (Stage 5.5) |
| Backup jobs on a node | one base backup or restore job and 2 WAL uploads at once | measured configuration: `backup.base_backups` 1 ("Live acceptance on the slot-pool release, part 1"), `WAL_JOBS` 2 ("WAL archive throughput of a node") |
| WAL archive rate | about one 16 MiB WAL segment per second per node, shared by all its databases (about 4.5 s per call, 3 MB/s on the wire) | measured 2026-10-20 ("WAL archive throughput of a node", plan 11.2) |
| Connection rates | [3.6](#36-connection-limits) | Dev values |
| Roles per database | 100 | contract |

**Pace bulk loads and migrations.** 59 databases that each loaded 510 MB (about 1 GB of WAL) kept 50
databases awake for over an hour on 2026-10-20, because a database sleeps only with its WAL
archived ("WAL archive throughput of a node", plan 11.2). A bulk load of a few MB/s per database fills a node's archive capacity, and a database
that writes faster than the node archives, for long, fills its own volume with unarchived WAL.
Spread migrations over time and over databases, and watch `health.archiving` and `health.disk`.
The plan requires the archive path's cost per call to be measured and its bound raised before the
first integrator migrates data.

### 4.5 Your checklist

- Cap databases per tenant and per class; cap simultaneously awake databases.
- Choose `sleep_after_seconds` per database or per class; never leave transactions open.
- Watch each database's size and have it raised before it fills (4.3).
- Keep your pool `max` below `max_connections`, reuse connections and stay under the Edge
  connection-rate limits (3.6).
- Treat `capacity_exhausted`, a waiting create and `57P03` as normal overload signals.
- Do not assume automatic scale-up of CPU, memory or storage: you change classes yourselves.
- Pace bulk loads and migrations under the node's archive rate (4.4).

## 5. Metering

PGCF reports facts per database and per hour; prices, credits and wallets are yours.

```sh
pgcf -G "$PGCF_API/v1/usage" \
  --data-urlencode "project_id=<project-id>" \
  --data-urlencode "from=2026-10-14T00:00:00.000Z" --data-urlencode "to=2026-10-15T00:00:00.000Z" \
  --data-urlencode "granularity=hour" --data-urlencode "limit=100"
```

- Exactly one of `project_id` or `database_id`; `from` and `to` aligned to UTC hours (`hour`) or
  days (`day`), at most 31 days; `limit` 1 to 100 and `next_cursor` passed back as `cursor`. An
  integrator key sees its own project only. Rows also exist for deleted databases created before
  `to`.
- A row is `{database_id, project_id, start, end, final, metrics, gaps}`. `final: false` rows may
  still change; an hour becomes final two hours after it ends, so bill from final rows. A day row
  is the sum (or maximum) of its 24 hours and is final only when all of them are.
- A metric is a number or `null`; `null` is **unknown, never zero**, and its name is in `gaps`. An
  hour that is not computed yet carries `rollup_pending`.

| Metric                                                               | Meaning                                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisioned_seconds`, `awake_seconds`                               | seconds between creation and deletion, and seconds between a ready or wake event and the next hibernation or suspension                                                       |
| `memory_mib_seconds`, `cpu_millicore_seconds`                        | the class's memory and CPU **limits** times awake seconds; not measured consumption                                                                                           |
| `storage_used_bytes_max`, `storage_allocated_bytes` | maximum of the node's filesystem samples in the period (bytes used on the volume); the effective storage size |
| `backup_bytes_max`                                                   | maximum archive size in R2 measured in the period                                                                                                                             |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | gateway counters of the hour, summed over its measurement intervals (none spans two hours); `null` with `traffic_coverage` when an interval of the hour is missing or unknown |

The memory integral accumulates integer configured MiB × lifecycle milliseconds and divides
once to produce the unchanged `memory_mib_seconds` metric. An unsafe integer accumulation
remains unknown with a memory gap; it is not rounded into a billable value.

For compute time price `awake_seconds` and `memory_mib_seconds`; for storage use
`storage_allocated_bytes` and `storage_used_bytes_max`; for traffic read `ingress_bytes` and
`egress_bytes` of final rows. The retired Kubernetes runtime's three `reserved_*` metrics are gone
from the contract and from every stored row (no backwards compatibility).

**Traffic across an hour boundary.** The gateway counts cumulative totals and the node agent reads
them once a minute. When two readings enclose a UTC hour boundary, the
bytes, connections and connection time counted between them are split between the two hours pro
rata by elapsed time, in whole numbers: the earlier hour receives the rounded-down share and the
later hour the remainder, so the two hours always add up to exactly what the gateway counted.
Example: 1,000 egress bytes counted between the readings at 11:59:45 and 12:00:45 are 250 bytes in
the 11:00 row (15 of the 60 seconds) and 750 bytes in the 12:00 row (45 of the 60 seconds). The
timing error is at most the interval between the two readings, normally about a minute, and only
in the two rows around a boundary; the sum over whole hours is exact. `connection_seconds` has
millisecond resolution.

**What stays unknown.** An interval is `null`, with `traffic_coverage` in `gaps`, when the gateway
process restarted or was replaced, a counter went backwards, a report was incomplete, no reading
arrived, or two readings are more than one UTC hour boundary apart (an agent outage of about an hour or
more). A reading that shows nothing counted is a measured zero, not a gap. Only awake time has to be
covered by readings: a sleeping database emits none, so an hour or part of an hour asleep without a
reading counts as zero traffic (and traffic counted against a sleeping database, such as a refused wake,
is added), while awake time without a reading is the gap above. A day row is `null` when any of its
hours is. Hours finalized before this attribution, or before the rule on sleeping time, was deployed
keep `null` traffic and are never recomputed.

**Infrastructure cost** (`GET /v1/costs`, **admin only**, hourly, at most 31 days, one node or one
region) is per node and built from monthly amounts the owner recorded as immutable facts
(`POST /v1/costs/node-facts`); hours without a fact are `unpriced_seconds` with a `node_rate`
gap. It is not attributed to databases. Ask the operator to export it for you.

**Not reported:** measured CPU or RAM consumption per database, cost per database or per project,
query counts and latencies, node RAM, CPU and disk time series (the plan records that node samples
live minutes and only current values are readable), per-connection or per-statement data, and
any price.

### 5.1 Executions

`GET /v1/usage` measures the databases themselves. What the schedules ([2.9](#29-schedules)), events
and webhooks ([2.8](#28-webhooks)) did is counted separately, so that the usage contract stays as it
is: `GET /v1/execution-usage?project_id=…|database_id=…&from=…&to=…&granularity=hour|day` (exactly one
scope; aligned UTC boundaries, at most 31 days; the usual `limit` and `cursor`).

| Metric | Counts |
| --- | --- |
| `schedule_runs_succeeded`, `_failed`, `_timed_out`, `_outcome_unknown`, `_rejected` | the schedule runs that ended with that outcome |
| `schedule_runs_skipped` | the runs recorded as `skipped_capacity`, `skipped_suspended`, `skipped_deleted` or `skipped_missed` |
| `events_emitted`, `event_bytes` | events stored for the database (the JSON of `data`), once per event |
| `webhook_attempts` | every request sent to a receiver, retries included |
| `webhook_deliveries_delivered`, `webhook_deliveries_dead_lettered` | deliveries that ended, a replay counted again |

A period without a row had no executions; in a row, a metric that is absent from the database is 0. A
database writes each hour a minute after it ended, and a row is `final` two hours after its period
ended: bill only final rows. PGCF counts; what an execution costs is yours to decide. A scheduled run
that starts the database also shows in its `awake_seconds`.

## 6. Alerts and operations

Alerts are infrastructure alerts for the **operator**. The candidate independently sends them
to the authenticated operator webhook and configured email recipients. Integrator alert
subscriptions are not introduced; the events of your own databases are webhooks ([2.8](#28-webhooks)). The owner confirmed the recipient on 2026-10-19 and, on the evening of
2026-10-20, that the alerts arrive; the control database held delivered episodes of several kinds,
go-live gate G5 is met and every kind carries its runbook action ("G5 met: the alerts reach the
owner's webhook"). The operator reads the alerts' state in
`GET /v1/operational-health?scope=regions`.

One episode exists per region and kind. Its `event_id` names the error: the same error (same
region, kind and failing subjects) has the same `event_id` every time it occurs, also after it
cleared and came back, and a different set of subjects is a new error with a new `event_id`. An
episode is delivered at least once to each destination, with retries at least 60 s apart and a
five-second deadline (a retry repeats the `event_id`, `occurred_at` and body), and clears only when its
measurement is fresh and below the threshold. A recurrence has the same `event_id` and a new
`occurred_at`; a receiver deduplicates the pair and treats a known `event_id` with a new
`occurred_at` as a new occurrence of the incident that ID names.

Configure `notification_recipients` (up to ten additional addresses) alongside the legacy
`notification_recipient` and `notification_sender` at `/v1/infrastructure-backups/config`.
Omitting the new list on PUT preserves it; `[]` clears it. Addresses are deduplicated without
case sensitivity. Email requires `RESEND_API_KEY` and a verified sender; a webhook does not
suppress email. Each destination has its own receipt/retry, so failure of one does not repeat
an acknowledged delivery to another. Aggregate `delivered_at` means every configured destination
returned 2xx, not inbox delivery. Operational health exposes destination receipts and sanitized
failure status, without secrets or request bodies.

When an announced episode clears, a separate durable recovery outbox records `state:"resolved"`,
the resolution in `occurred_at`, and `episode_started_at` linking the warning. It survives a
new recurrence and retries independently; a warning acknowledgement arriving after resolution
still makes recovery eligible. Operational health includes the latest recovery records and
per-destination delivery status. Receivers must distinguish warning/recovery payloads and
idempotency keys, not interpret resolution as a new warning.

The optional `capacity_alert_policy` replaces the three legacy utilization warnings while set.
`{}` selects RAM/CPU/data warning at 70%, sustained action at 75% for 30 minutes, and clear below
65%; metadata uses 40/45/35%. Warning and clear use the latest fresh observation. Action needs
every minute of the configured window; stale, missing or unknown measurements neither establish
pressure nor falsely clear an existing episode. These notifications request **manual operator
action**: they do not order a node, enable autoscaling or move databases. Existing placement and
purchase authorization remain separate, and no automatic redistribution is added.

| Kind                                                          | Fires when                                                                                                                                   | Threshold (set in the capacity policy; the plan's value, 4.10, where it names one) |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `regional_node_capacity_warning`, `regional_node_capacity_action` | current pressure reaches the warning or sustained-action threshold | optional `capacity_alert_policy`; thresholds and hysteresis above |
| `regional_node_ram_warning`                                   | any node's 30-minute average of active RAM reaches the threshold                                                                             | `node_ram_warning_threshold_ppm`, 850,000 (85 %) |
| `regional_node_cpu_warning`                                   | any node's 30-minute average CPU load reaches it                                                                                             | `node_cpu_warning_threshold_ppm`, 900,000 (90 %)  |
| `regional_node_storage_warning`                               | the node's thin-pool data or metadata fill reaches it (placement closes a pool at 80 % data or 50 % metadata)                                | `node_storage_warning_threshold_ppm`; the plan names no value (placement closes the pool at 800,000 for data and 500,000 for metadata) |
| `regional_node_cap_reached`                                   | allocated nodes reach `max_nodes`                                                                                                            | `cap_warning_enabled`, off by default            |
| `regional_node_stale`                                         | a node's observation is older than 180 s, or the node is marked lost and a database is still placed on it                                                                         | fixed                                             |
| `infrastructure_backup_failed`, `infrastructure_backup_stale` | the daily D1 backup fails, or none completed for 36 h                                                                                        | fixed                                             |
| `database_archive_failing`                                    | a running, awake database reports `health.archiving: failing`                                                                                | fixed    |
| `database_base_backup_stale`                                  | an awake database has no completed base backup within 36 h of awake time; hibernated ones are excluded and a wake restarts the count         | fixed                              |
| `thin_storage_blocked`                                        | a node's newest sample says its thin pool has no room, or a node that holds databases has no sample of its pool within 180 s (`thin_pool_*`) | fixed                                             |
| `database_delete_incomplete`                                  | a database was deleted more than 10 minutes ago and its node has not removed all of it (not reported `deleted`, or a volume of it still reported) | fixed                                             |
| `regional_node_capacity_refusals`                             | a node refused 5 or more wakes for awake capacity or a full start queue (`57P03`) in 10 minutes                                                                    | fixed                                             |
| `regional_node_pool_closed`                                   | the smallest size class on offer fits no node of the region (one full node beside a qualifying node is no episode): pool data at 80 %, metadata at 50 %, sold storage plus that class past 4 times pool data, 1,000 volumes, or insufficient RAM/CPU. RAM counts max(three-day peak, current sample) plus class memory; CPU uses the three-day peak and must fit physical cores. Peaks are 30-minute averages; both loads must stay below 80 %. Transient pending placements' RAM is excluded from this alert | fixed                                             |
| `database_volume_warning`, `database_volume_critical`         | a database volume's space or inodes are at least 80 % (below 90 %), or at least 90 %, used                                                   | fixed                                             |
| `node_enrollment_refused` | a node's enrollment token was presented again with another key, or after it expired, within the last 24 h | fixed |
| `node_unexpected_reboot` | a node rebooted and no maintenance order of it asked for it, within the last 24 h | fixed |
| `control_cron_stalled`, `control_cron_step_failing`           | no minute-cron run completed for 300 s, or a step failed in each of its last 5 runs                                                          | fixed                              |

The values in the table are the plan's; the installation's own settings are read with
`GET /v1/regions/{id}/capacity-policy`. Thresholds are integer parts per million (1,000,000 = 100 %, valid 1 to 1,000,000, `null`
disables) set with `PUT /v1/regions/{id}/capacity-policy`. The alert evaluation (a Durable Object
alarm, once a minute) evaluates the first four regions that have a policy; the fixed-rule kinds
are evaluated for every region.

Every event carries a short runbook action in `action`. The database kinds are per database but
one episode per region and kind lists up to 64 databases. Each minute-cron step runs in its own
failure boundary and has 240 s, so one failing or hanging step is logged and counted; the alerts
are no step of the cron: a Durable Object alarm evaluates them every minute and judges the cron's
own heartbeat, without depending on the cron
([operator runbook](infrastructure-backups.md#minute-cron-heartbeat-and-watchdog)).

The control plane itself is protected by a daily encrypted D1 export in R2, read back in full
([infrastructure backups](infrastructure-backups.md)). Restoring it was exercised: the restore drill
passed on the provider's export on 2026-10-21 ("G6 restore drill passed on the provider's export"),
and a window test with writes and 37 wakes across an on-demand export passed on 2026-10-22 with no
failed wake ("G6 window test passed with an on-demand export"); go-live gate G6 is met. The daily
export failed from 2026-10-17 until its cause was fixed on 2026-10-19; the first complete export is
that of 2026-10-20 ("First complete infrastructure backup"). These backups are not your database
backups.

What you can watch yourselves: per database `health.archiving`, `health.backup`, `health.disk`,
`storage` and `observed_state: error` ([2.2](#22-operations-and-readiness)), connection errors by
SQLSTATE, and `GET /healthz` of the API and of the database host (both only say that the Worker
runs). The operator-only `GET /v1/operational-health?scope=databases` lists the same backup and
disk verdicts for every project at once.

## 7. Failure and recovery

### 7.1 What happens in each situation

| Situation | Effect on your database | Data | You do |
| --- | --- | --- | --- |
| Idle sleep | PostgreSQL stops after the sleep proof (every committed transaction is in R2 first); the volume stays mounted; the next connection starts PostgreSQL from it. Measured: asleep 66 s after the last statement at a 60 s idle time (2026-10-23, "Live acceptance on the slot-pool release, part 1") | in R2 and on the volume | reconnect |
| Manual suspend | refused with `57P03` until resume. Measured: asleep 2.5 s after the request (2026-10-18, "Stage 5.2 sleep and wake on EU1") | as above | `POST /resume` |
| Node maintenance cycle (new packages, a kernel update) | placement on the node is closed, so creates wait; the node holds new wakes with a bare `57P03` ([3.4](#34-timeouts-and-retries-for-a-sleeping-database)), puts every awake database to sleep with the proof and reboots only if a kernel or core library changed. A successful cycle reopens placement only if it closed it; a failed cycle leaves placement closed, although wakes can resume. **Measured:** the first live cycle took 67 s end to end, the node reported its new kernel 56 s after the call and placement was open again after 74 s (2026-10-19, "First live maintenance cycle on EU1"). **Windows (decided):** from production acceptance onward a reboot needs an announced window. Debian kernel security updates follow the owner's standing approval of 2026-10-19 (D10, plan 11.3): a cycle within 7 days of a Debian security advisory, in an announced window, one node at a time; every other reboot also needs the owner's go. **The default window is Tuesday 02:00 to 04:00 UTC (plan default D15, 11.5), until the owner names another.** You learn of a window from the operator, who forwards it over the contact channel it names at handover ([7.6](#76-escalation)): the alert webhook reaches only the operator and the owner, PGCF sends integrators no event for a window and has no alert kind for it, and the plan sets no lead time | kept | plan around the window; ask the operator for it |
| Agent restart (a node release) | running databases keep running: an agent restart never stops a database. New wakes wait for the agent. Measured: the agent was serving 5.3 s after its restart at 167 volumes (2026-10-20, "First release through the normal flow, with an agent change"); a kill -9 of the agent at 312 volumes left new connections waiting up to 46 s, with no write lost (2026-10-23, "Live acceptance on the slot-pool release, part 3: fault tests 5.4 at density, and an outage"; 36.6 s at 167 volumes on 2026-10-20, "Stage 5.4 results on EU1, runner `s5_chaos.py`"). Baseline B includes that hardening. Its later actual database-start wakes took 4.35 s quiet and 6.06–11.33 s loaded; successful client results took 4.82 s and 6.51–11.78 s, with clock uncertainty. On final `sha-eb9d0f729663`, the October 25 EU SIGKILL case served the first successful public SQL within 2,274.224501 ms, with 30/30 successful probes and exact acknowledged data. This closes the required EU Stage 5 timing check. US G9 verified two actual agent restarts/adoption as broken-agent recovery; US first SQL below 3 seconds is unmeasured and is not a separate regional timing gate. A refusal is not a served wake (dated ULTRA update) | kept | retry with backoff |
| Gateway release (a new gateway binary, or a change of the node's route keys) | the gateway on the node is replaced. It closes your idle connections at once with WebSocket close code 1012; a connection in a transaction or running a statement keeps up to 10 s. At that bound a session idle in a transaction is ended with `57P01` and its transaction is rolled back. A session with a statement running is ended with `08007` and **its statement is not stopped**: PostgreSQL finishes it, and the `COMMIT` sent behind it, and notices that the client is gone only when it writes its answer, so the work can commit after the error, up to the statement's run time later (a check made at the error finds nothing yet). An HTTP `/sql` request still running at the bound is answered `08007` in the same way (outcome unknown, not retried). Connections that arrive meanwhile wait for the new gateway, at most those 10 s and its start (and its first table from the node's agent, normally milliseconds, 5 s at most); the one connection the old gateway had accepted at the moment of the signal and not yet read gets `08006`. Designed and tested for that bound; **not yet seen on a node**, so no live outage duration is stated for it ("The gateway drains on a release swap and hands its socket over"). **One time, for the release that brings this behaviour:** the node's agent restarts the gateway before it writes the new unit files, so the first stop is of the previous gateway, which holds every WebSocket for up to 29 s (idle ones too) and keeps its port without accepting for up to 30 s, then resets the connections that waited; a new connection can fail for up to 30 s then, longer than the retry rule, and an HTTP `/sql` request still running at 30 s gets no answer from the gateway (the Edge reports its own `08007`). The restart after the unit files has the new drain but no socket handover (a connection that arrives meanwhile waits in the old process and is reset when it exits, at most 12 s later); the release after that is the first with the handover | a transaction that committed is kept; one idle in a transaction at the bound is rolled back; a statement running at the bound has an unknown outcome and can commit after the error | reconnect on 1012; retry `08006` and `57P01`; after `08007` repeat only an idempotent write, and check a write's effect only after the statement's run time has passed |
| Node reboot or crash | every awake database stops with the node; when it is back, its agent finds each database that stopped without a proof, starts it through admission, lets it archive and proves its sleep, and a connection wakes it as usual. **Measured, each with writes in flight and no acknowledged commit lost:** a hard power cut (2026-10-18, "Stage 5.4 hard power cut under writes on EU1": 3,040 of 3,040 acknowledged rows present, the node reported again 26.8 s after the start request); a VM restart through the Contabo API (2026-10-20, "Stage 5.4 results on EU1, runner `s5_chaos.py`": the writer was acknowledged again after 84.3 s); a kill -9 of the postmaster (first write again after 7.8 s) and of the gateway (served again after 3.0 s). The October 25 final-release EU combined R2/provider-hard-cut case also matched all 1,057 acknowledged writes, with five explicit refusals and the single uncertain write at sequence 809 confirmed absent, without replay. The October 25 US case also preserved its cumulative 1,875 acknowledgements across one provider stop/start under R2 denial, with complete owned cleanup. No outage duration is promised | kept (local volume) | retry with backoff; check `observed_state` |
| Archiving failing (`health.archiving: failing`, for example an R2 problem) | connections keep working; WAL accumulates on the volume until archiving works again, and a full volume stops writes (standard PostgreSQL behaviour, not tested here). Measured with R2 blocked (2026-10-20, "Stage 5.4 results on EU1, runner `s5_chaos.py`"): the first archive failure came 21.8 s after the block, the API showed archiving failing after 43.1 s, 6,465 writes were acknowledged meanwhile and none was lost, and after a reboot and the unblock the archive caught up. On October 25 the final-release EU guard persisted over one provider stop/start, recorded nine post-boot denials and was removed before verified archive coverage of pre-cut LSN `0/1D0015E0`; all acknowledged data matched and cleanup completed. The later US case recorded 11 additional post-boot denials and verified archive coverage through segment `3D` before final cleanup | recoverable window goes stale | escalate at once |
| Volume or inodes full | PostgreSQL cannot write; the required recovery is explicit growth, with success based on measured filesystem capacity. No arbitrary SQL cleanup at zero available space is promised. Common-code labs and the October 25 EU1 live byte/inode cases passed: both grew from 2 to 5 GiB before filler removal, with exact 29/109 acknowledged writes and no unknown outcome or loss. US1 full-pool acceptance subsequently passed; reuse the EU byte/inode checks for the unchanged common implementation. | no acknowledged commit may be lost; verify the recovered digest | have the size raised (admin `PUT /v1/databases/{id}/resources`) or move to a larger class ([2.5](#25-resize)) |
| Proof after PostgreSQL disappears | Before the fix, automatic PostgreSQL Ready took 604.210285 seconds and proof 609.532 seconds. The historical `sha-f0e7090629fe` deployment qualified this path, which is reused on current `sha-acb21e26e064`; root accepted it after four verified kills: automatic Ready 4.455963 seconds, proof before normal marker wake with a 7.428105-second upper bound, exact marker and fresh natural sleep. The helper safely aborted before a fifth signal (`postmaster_identity_changed`), retaining exit 1; no clean helper exit or general recovery bound is claimed | exact marker matched; owned keys/processes/faults clean | do not replay uncertain writes |
| Thin pool full | New block allocations fail. Already-mapped writes can continue: the US live ledger kept 41 acknowledged writes at 100% pool usage. Deleting only the owned filler restored space; all 1,789 acknowledgements matched and three cold marker queries succeeded without preparatory resume. This is not evidence that every write failed, that the ledger crashed or that a damaged filesystem recovered | exact acknowledged data preserved in this case | wait for space and retry admissible starts; do not replay uncertain writes |
| **A node lost (EU1 or US1)** | **all databases on it are down.** Their local volumes are gone with the server | only what reached R2 | [7.4](#74-eu1-lost) |
| Cloudflare unavailable | no path to any database: all traffic enters through Cloudflare. While the Edge still routes but the API or D1 is unavailable, awake databases keep running and wakes fail | kept | wait |

### 7.2 Recovery point

There is no synchronous replica and no zero-loss promise for a lost volume. What can be lost
depends on what happened; all four production classes (`xs`, `sm`, `md`, `lg`) have the same
`archive_timeout_seconds` of 60 and the same 7-day window. The actual recovery point depends on
the last committed WAL that reached R2, including the region's archive queue and any outage.

| Situation | Recovery point | Kind, date and source |
| --- | --- | --- |
| A database with a proven sleep (idle sleep, manual suspend) | nothing is lost: every committed transaction is in R2 before PostgreSQL stops | decided (plan 7.1 and 7.9) |
| A reboot, crash, power cut or VM reset with the disk intact | no acknowledged commit is lost | measured on EU1: a hard power cut under writes (2026-10-18, "Stage 5.4 hard power cut under writes on EU1") and, on 2026-10-20, kills of the postmaster, agent and gateway, a VM restart and an R2 block with a reboot ("Stage 5.4 results on EU1, runner `s5_chaos.py`"): every acknowledged row present and no write replayed |
| An awake database whose node is lost with its disk (host failure is treated as node loss) | the last committed WAL actually archived in R2; healthy archiving without backlog normally exposes about `archive_timeout_seconds` (60 s) plus upload time, but backlog or an outage can exceed it; unarchived commits are lost | the healthy-path expectation is decided (catalog of 2026-10-19, "Production size classes `xs`, `sm`, `md`, `lg` created"; plan 7.1). October 26 healthy native observations: EU 53.393 s / US 54.674 s conservative acknowledged-attempt-start-to-operator-positive upper bounds; not per-class guarantees. The earlier 66.7-s retired-runtime measurement is historical |
| The same, for a database on US1 | the same archived-WAL rule and backlog/outage caveat; the segments travel from US1 to the EU-jurisdiction bucket | October 26 healthy native observation: 54.674-s acknowledged-attempt-start-to-operator-positive upper bound; this does not isolate per-call upload time |
| A bulk load that writes WAL faster than the node archives | the lag grows beyond the healthy timeout-plus-upload expectation, and the database stays awake until its WAL is archived | measured 2026-10-20: a node archives about one 16 MiB segment a second ([4.4](#44-capacity-caps)) |

- A segment becomes eligible for archival when it fills or after `archive_timeout_seconds`.
  Queueing, failed uploads or an R2 outage can delay completion beyond timeout plus upload time.
  Recoverability follows completed archived WAL, not the configured timeout alone.
- A reboot with an intact volume loses no committed transaction. A clean idle or manual sleep
  archives the final WAL before PostgreSQL stops (the sleep proof), so a hibernated database is as
  recent as its last activity.
- Point-in-time recovery needs a complete base backup and the WAL needed to reach the requested
  point. `GET /v1/databases/{id}/backups` reports the window; its latest time is an upload-time
  upper bound, so a target after the archive's last commit can still fail (2.7). The window of
  the four production classes is 7 days ([2.7](#27-backups-restorable-window-and-restore));
  a restore at the edge of a full window is **to be measured**.

### 7.3 Recovery time

A restore is a base backup restore plus WAL replay on a new volume, so it depends on the database
size and on capacity being available. Per database, measured on EU1 on 2026-10-23: a point-in-time
restore was ready after 50.1 s, a full restore after 44.7 s, `xs`-sized restores after 34.5 to 50.9 s
and gate-sized ones (557 MB) after 248.7 s alone and 319.3 s, which overlapped the agent's rebuild of
a failed restore and took about 200 s without its waits
([2.7](#27-backups-restorable-window-and-restore)).

**A whole node.** The loss of a node has not been run: EU1 was not wiped. The plan extrapolates the
total from a sample of restores ("Live acceptance on the slot-pool release, part 1", 2026-10-23, G9
restore duration). **Of the 8 sample restores 7 became ready.** The eighth failed `archive_unusable`
("tar Unexpected EOF", with the base-backup job at its 256 MiB limit), and its target stayed
`provisioning` for over 13 minutes ([8](#8-not-available-yet)). The failed-build lifecycle and
report-based timeout fixes are deployed in baseline B, but final restore-batch acceptance remains
open and this sample does not establish that every archive restores. At that measurement EU1's
167 databases held 23.4 GB of archives. A node runs one base-backup or restore
job at a time, which serialises the restores, so a full node restore would take at least about 2.2
to 3.3 h (130 to 200 min: 108 `xs`-sized databases at the measured 18.2 s of slot time each, and
59 gate-sized ones at the measured 99 to 170 s each); with the fence (30 s) and the reinstall of
the server (174 to 197 s) the total would be at least about 2.2 to 3.4 h. **The figure is a floor and assumes that every restore
succeeds, which the sample did not show:** until the `archive_unusable` defect is fixed and shown
fixed, some databases of a real node loss may not restore within that total, and each stays
unrestored until you delete its failed target and restore again. It is a floor also because the
restores of the node go in batches that fit its awake memory, the next when the previous has ended
([2.7](#27-backups-restorable-window-and-restore); the 167 databases of EU1 have about 86 GiB of
class memory against a budget of 9,937 MiB, so at least 9 batches), and the end of each batch
leaves the slot idle; it assumes the
report-based operation timeout (deployed in baseline B; long-batch acceptance still open). It is an extrapolation from a sample and
not a promise. If the server itself is destroyed, ordering a replacement comes first, and the time
to order it is not measured.

### 7.4 EU1 lost

1. The operator verifies the node and declares it lost (`POST /v1/nodes/{id}/mark-lost`); its
   databases are unreachable. Fencing completes before anything moves: its Tunnel is deleted and its
   instance powered off ([recovery runbook](recovery.md#lost-node)). Measured: the Tunnel was
   deleted and the instance off within 30 s of `mark-lost` (2026-10-19,
   "G9: what is left after the 2026-10-19 loss and reinstall"). The operator can read each
   database's recovery point, the proven-sleep record and newest base backup the node last
   reported.
2. New capacity is needed before any restore can start. Reinstalling the same Contabo instance
   (AddNode `recover`) needs no purchase: EU1 was enrolled 196.5 s after the rescue request in
   Stage 4 (2026-10-18; the reinstall was repeated on 2026-10-19) and US1 173.8 s after it
   (2026-10-22, "US1 installed into `us-dev` from the image"). It is refused while a database of the node has no proven-sleep record
   for its current generation, unless the owner acknowledges that unarchived WAL is lost for good.
   Replacing a destroyed server is a purchase: the owner pre-approved a costed replacement order
   through the API purchase path on 2026-10-20 (plan 11.3), and **no replacement or second server
   has been bought** (decision D9: it is bought when it is needed).
3. For each database, restore from R2 ([2.7](#27-backups-restorable-window-and-restore)). Every
   restored database has a **new ID** (decision D4, the plan's default; the alternative of keeping
   IDs was not chosen): update your mapping, connection strings and `wsProxy` hints for each.
4. Expect the last archived commit, not the last acknowledged one.

The extrapolated total, with its sample of 7 successful restores out of 8, is in
[7.3](#73-recovery-time). The runbook with its preconditions is go-live gate G9; its restore half
was sampled on 2026-10-23. The October 25 bounded queue/restart case subsequently passed all
nine targets, including fetch and post-first-backup/Ready adoption without refetch. A full drill
marking EU1 lost and restoring its entire population has not been run; no measured whole-node
recovery duration is inferred from the bounded result.

### 7.5 Records to keep

Keep, in your own store: the ID mapping and the restore operation of each database, the
idempotency keys of unfinished operations, the role names and the password revision of each
database. Rotate role passwords with `reset-password` and re-read the URI instead of caching
passwords.

### 7.6 Escalation

The repository defines no pager, status page or SLA: your counterpart is the operator, the holder
of the admin key of this installation. The contact channel is installation-specific. Operator-contact
and maintenance-lead-time completion were waived as G11 gates on October 25; this is not a release blocker.
When reporting an incident, send:

- the UTC time, `database_id`, role, operation ID and the request;
- `X-Request-Id` and `X-PGCF-Diagnostic-Id` of the failing API call (the API logs failed requests
  under that diagnostic ID), or for a connection the SQLSTATE and message and whether it came
  immediately or after about 60 s (the Edge logs every admission with database ID, role, outcome
  and duration);
- what `GET /v1/databases/{id}` and `GET /v1/operations/{id}` returned.

## 8. Not available yet

- A first request after sleep under one second, measured at p95 (go-live gate G3). The best pass so
  far has a p95 of 1,583 ms ([3.4](#34-timeouts-and-retries-for-a-sleeping-database)).
- A second node in a region and redundancy; a drill that marks a node lost and restores all its
  databases (the restore time of a node's population is extrapolated from a sample of which 7 of 8
  restores succeeded, [7.3](#73-recovery-time)); automatic rebalancing (an operator can move a database under its ID,
  and a move has not been timed; `/restore` creates a new ID, while `/restore-in-place` preserves it).
- Final regional one-hour/24-hour cold acceptance. Required density, storage and recovery receipts
  are accepted in the dated ULTRA update; dependent test-population cleanup remains open.
- Alerts for integrators (alerts go to the operator); operator acknowledgement and test send. Operational health exposes delivery/recovery receipts, not a complete event-history API.
- Finding deleted databases: the lists exclude them, so keep the IDs you were given.
- An event stream beyond the webhooks of [2.8](#28-webhooks) (no ordering guarantee, no data-change events), an audit log of integrator keys (the administrator keys have one).
- Last-use display and key rotation as a feature; an API domain with rate limiting.
- Infrastructure metrics history and measured CPU and RAM per database.
- Changing a role after creation (expiry, limit, membership), user-chosen passwords, a grants API,
  a role-settings API (ordinary roles can set their own SQL session defaults), renaming a database.
- Cancel requests, replication connections, TCP access; in HTTP query mode, `COPY` and
  `authToken`.
- Budgets, quotas per tenant, compute and storage autoscaling, branching.
- Maintenance-window notifications: the operator announces a window, and PGCF sends no event for it.
- Importing existing databases from another provider; moving them is your task.

**Historical defects.** The October 23 acceptance found the symptoms below. Their fixes are
deployed; subsequent regional provider and bounded G9 receipts are accepted in the dated update.
The original failed receipts remain historical failures:

- After a restore ended `no_recovery_point`, the node rebuilt the same failed restore 11 times in
  5 minutes while the control database flipped between states.
- A restore that failed `archive_unusable` ("tar Unexpected EOF", with the base-backup job at its
  256 MiB limit) left its target database `provisioning` for over 13 minutes although its
  operation was `failed`. Treat a `failed` restore operation as final: delete the target and
  restore again.
- `POST /v1/databases/{id}/roles` with `valid_until` answered `500` after 12.6 s although the role
  had been created. Read the role list before you retry.

The 2026-10-24 US1 seed also exposed a 60,038 ms WAL-fetch timeout reported as
`no_recovery_point`, although the source object existed and independently passed its integrity
check. The merged candidate preserves the fetch cause and permits one extra timeout attempt
per build invocation; exhaustion or a proven required-WAL gap yields `archive_unusable`.
Required gaps are not retried. No partial Ready was published. The underlying stall is not yet
explained and live retry acceptance remains open (dated ULTRA update, "WAL-fetch timeout recovery").

A fourth historical case has no live check: a restore of a backup taken in a class with more `max_connections`
than the database's class has now (a database that was resized down after its base backup)
aborted in a test on 2026-10-21 ("Restore into a smaller class, on branch `pr-w1b`"). The fix is in
the code on main, and the plan records no live run of it (an `md` database restored into `xs` is
listed as not run in "Live acceptance on the slot-pool release, part 1"); do not rely on such a
restore until it does.

<a id="9-values-for-written-confirmation-go-live-gate-g11"></a>

## 9. Values for production acceptance and handover (go-live gate G11)

Go-live gate G11 closes when the generic PGCF contract is verified on EU1 and US1 and this
handover states the measured results and remaining operational limits. Integrator implementation,
written integrator acknowledgement and a timed canary are not requirements of this delivery
(owner decision 2026-10-24). Operator contact and maintenance lead time were also explicitly
waived as G11 gates on October 25. The kind column says whether a value is *measured*, *extrapolated*,
*decided* or *to be measured* (see the header), with its date. The source column gives the title
of the row of the plan's
[Done table](../architecture/cloudflare-convergence-and-serverless-plan.md#111-done) unless it says otherwise.

| Item | Value | Kind and date | Source | Where |
| --- | --- | --- | --- | --- |
| RPO per class | After a proven sleep: nothing lost. Reboot, crash, power cut or VM reset with the disk intact: no acknowledged commit lost. Awake database on a lost disk: only commits archived in R2 are recoverable. Healthy timeout plus upload is an expectation, not a bound during backlog or an R2 outage | healthy-path expectation decided 2026-10-19; no loss with an intact disk measured 2026-10-18 and 2026-10-20; healthy native archive-point upper bounds measured 2026-10-26: EU 53.393 s / US 54.674 s from acknowledged-attempt start to operator-positive observation; not per-class or unconditional RPO guarantees | "Production size classes `xs`, `sm`, `md`, `lg` created"; "Stage 5.4 hard power cut under writes on EU1"; "Stage 5.4 results on EU1, runner `s5_chaos.py`"; plan 7.1 | [7.2](#72-recovery-point) |
| RPO for host failure (node loss) | Treated as node loss: restore from R2 using the same actual archived-WAL recovery point and backlog/outage caveat as an awake database on a lost disk. A VM reset cannot show whether the provider's host honours disk flushes, so no more is claimed | decided (plan 7.1) | plan 7.1 | [7.2](#72-recovery-point), [7.4](#74-eu1-lost) |
| RPO on US1 | Only actually archived WAL is recoverable after disk loss. One healthy observation had an ACK-attempt-start-to-operator-positive upper bound of 54.674 s; EU was 53.393 s. These are observations, not unconditional RPO bounds during backlog or R2 outage | measured 2026-10-26, one healthy point per region; not per-class guarantees | Dated ULTRA: Healthy regional archive points | [1.2](#12-regions), [7.2](#72-recovery-point) |
| WAL archive rate | About one 16 MiB WAL segment per second per node, shared by all its databases (about 4.5 s per call, 3 MB/s on the wire) | measured 2026-10-20 | "WAL archive throughput of a node" (plan 11.2) | [4.4](#44-capacity-caps) |
| PITR window | 7 days in each of `xs`, `sm`, `md` and `lg` (`backup_retention_days`). A point-in-time restore into a new database was ready after 50.1 s (52.4 s from the new bucket) | window decided 2026-10-19; restores measured 2026-10-23; a restore at the edge of a full window is **to be measured**, not an additional G11 gate | "Production size classes `xs`, `sm`, `md`, `lg` created"; "Live acceptance on the slot-pool release, part 1"; "G8 one archive bucket: the cutover on Dev, steps 1 to 11" | [2.7](#27-backups-restorable-window-and-restore) |
| Ready only after the first base backup | Historical creates: 8/8 first DONE before Ready, 6/8 within 30.7 s. October 25: all four provider restore paths in each region have actual native first-DONE-before-Ready receipts, including exact negative rollback generation/backup ordering | measured 2026-10-23 and 2026-10-25 | Dated ULTRA update; "Live acceptance on the slot-pool release, part 1" | [2.1](#21-create), [2.7](#27-backups-restorable-window-and-restore) |
| Cold request p50 and p95 | About 50 h asleep: p50 948 ms, p95 1,583 ms over 59 (26 at or above 1 s). 1 h or more asleep: p50 1,126 ms, p95 1,814 ms over 59 (39 at or above 1 s) | measured 2026-10-23 and 2026-10-20 | "Slot pool live on EU1 and US1, and the first 24 h cold pass on it"; "Stage 5.3 cold gate, 1 h stratum, full pass of 59 samples" | [3.4](#34-timeouts-and-retries-for-a-sleeping-database) |
| Cold target (G3) and its state | Subsecond whole-request p95 remains an unproven target. The owner accepts current latency and cancels further speed tests and the final 1h/24h campaigns; this exception removes the speed gate from the go-live critical path. Preserve all failed samples; no measured pass or p95 guarantee is claimed | **Owner-accepted exception**, 2026-10-26 | Current dated ULTRA decision | [3.4](#34-timeouts-and-retries-for-a-sleeping-database) |
| What the first request may be | One HTTP `/sql` transaction of the established six statements through the public endpoint; WebSocket compatibility remains required, and the laptop path is reported separately | decided 2026-10-19 (D1), clarified in the dated scope 2026-10-24 | Dated ULTRA update; plan 11.3 | [3.4](#34-timeouts-and-retries-for-a-sleeping-database), [3.7](#37-http-query-mode-neon) |
| Warm request times | The six-statement batch against an awake database: 275 to 340 ms from a Worker. A new connection to an awake database: median 124.5 ms (service binding) and 133.5 ms (public hostname) | measured 2026-10-20 and 2026-10-18; a warm p95 is informational and **to be measured**, not an additional G11 gate | "Stage 5.3 cold gate, first pass of the 1 h stratum on the final code"; "Cloudflare Access in front of the node gateways, live on EU1" | [3.4](#34-timeouts-and-retries-for-a-sleeping-database) |
| `57P03` meanings and the retry rule | DETAIL `storage`: no room in the node's thin pool. DETAIL `node at awake capacity` with HINT `retry after <n> s`: no awake capacity within the queue wait. DETAIL `node busy starting databases` with HINT `retry after <n> s`: the node was starting as many databases as it may and the wake's turn did not come within the queue wait. A bare `57P03`: suspension, provisioning, maintenance hold, move, pending recovery, offline node and the other holds. Retry 1 s, 2 s, 4 s, then 8 s, for about 90 s | meanings decided (code and contracts); retry rule is a recommendation | "Stage 3 lanes A, D and C integrated on branch `integrate/stage3`" (the DETAIL and HINT of a refused wake); the contracts | [3.4](#34-timeouts-and-retries-for-a-sleeping-database), [A.4](#a4-sqlstate-at-connect-time) |
| Early sleep (D2) | Only while a wake waits for room, one per waiting wake, never with client activity in the last 30 s, never an always-warm database; the wake that waited takes seconds and is counted in the p95. A full sleep proof took 1,016.6 ms at p50 and 1,084.4 ms at p95 | decided: plan default D2, not named otherwise by the owner; proof time measured 2026-10-17; counts under load **to be measured** (Stage 5.6) | "Stage 1 Block 2: create and sleep costs"; plan 11.5, D2 | [3.4](#34-timeouts-and-retries-for-a-sleeping-database), [4.2](#42-awake-databases-what-a-sold-memory-size-means) |
| What a sold memory size means (D3) | A hard ceiling while awake, not a cross-tenant reservation under `measured`. Observed US1 leaf limits: XS 256/230 MiB Max/High, CPU 0.25, writes 8 MB/s and 1,000 IOPS; SM 1,024/921 MiB, CPU 0.5, writes 32 MB/s and 4,000 IOPS. Both have zero swap and uncapped reads | rule decided D3; these leaf limits measured 2026-10-25, not a complete density/OOM envelope | Dated ULTRA update; plan 11.5 D3 | [4.2](#42-awake-databases-what-a-sold-memory-size-means) |
| Volume-full and pool-full behaviour | EU1 passed growth after byte/inode exhaustion with exact 29/109 acknowledgements. US1 reached physical pool full: new allocations failed while the mapped ledger kept 41 acknowledgements. Deleting only its filler restored space; all 1,789 acknowledgements matched. No universal all-writes-fail or damaged-filesystem-recovery claim follows | required cases measured 2026-10-25; owned cleanup complete | Dated ULTRA update; plan 4.3 | [4.3](#43-thin-storage), [7.1](#71-what-happens-in-each-situation) |
| Connection limits | 12,000 new connections per 60 s per database; 6,000 per 60 s per database, role and source network; 12,000 per 60 s from a service binding; 12,000 admissions per minute per database; 32 waiters per wake; compiled native ceilings of 2,000 total / 200 sessions per database per gateway, including idle SQL sessions. Actual accounted buffer budgets are 192 MiB total / 96 MiB per database; these can refuse before count ceilings and are neither RSS limits nor usable concurrency guarantees | Dev values, recorded 2026-10-23; native source/runtime limits confirmed 2026-10-26; these carry into production acceptance unless the operator changes them and informs the integrator | "Dev connection limits recorded (S6-03)" | [3.6](#36-connection-limits) |
| Outage classes and maintenance windows | Idle sleep, suspend, maintenance, process/node failure, archive or storage failure, node loss and Cloudflare outage remain distinct. October 25 maintenance: US1 25.166 s; EU1 79 min 19.188 s with 69 due backups drained first; no reboot, exact data and signed OS pins preserved on both. These are load-specific observations. The prior operating default is Tuesday 02:00–04:00 UTC; owner waived operator-contact/maintenance-lead-time completion as a G11 gate | maintenance measured 2026-10-25; gate waiver 2026-10-25; historical window decisions retained | Dated ULTRA update; plan 11.3 D10 and 11.5 D15 | [7.1](#71-what-happens-in-each-situation) |
| Security reboots | Within 7 days of a Debian security advisory that fixes the kernel, in an announced window (default Tuesday 02:00 to 04:00 UTC), one node at a time; every other reboot also needs the owner's go | decided 2026-10-19 (D10); window: plan default D15 | plan 11.3 (D10); plan 11.5 (D15) | [7.1](#71-what-happens-in-each-situation) |
| IDs after restore, move and node loss | `/restore` creates a new ID; `/restore-in-place` retains ID and cached credentials. The four original SQL/API and native restore paths passed on both regions, including original-data recovery after a failed target. Move keeps ID; node-loss restoration uses new IDs. Bounded G9 queue/restart and US pool/R2-hard-cut acceptance passed; the owner accepted the cold-latency exception on October 26 | provider paths measured 2026-10-25; move/node-loss identity follows the existing decisions | Dated ULTRA update; plan 11.4 and D4 | [2.7](#27-backups-restorable-window-and-restore), [7.4](#74-eu1-lost) |
| Losing a node | About 2.2 to 3.4 h for EU1's 167 databases and 23.4 GB if every restore succeeds: fence 30 s, reinstall 174 to 197 s, restores about 2.2 to 3.3 h. **7 of the 8 sample restores succeeded; the total assumes the `archive_unusable` defect is fixed** (failed-build/timeout fixes are deployed and bounded G9 queue/restart acceptance passed October 25; this extrapolation is not a measured full-node recovery bound) | extrapolated 2026-10-23 from a sample of restores; fence and reinstall measured 2026-10-19 and 2026-10-22; the full drill has not been run | "Live acceptance on the slot-pool release, part 1"; "G9: what is left after the 2026-10-19 loss and reinstall"; "US1 installed into `us-dev` from the image" | [7.3](#73-recovery-time), [7.4](#74-eu1-lost) |
| Capacity caps | Placement requires CPU's three-day peak and projected RAM below 80 % (RAM includes the higher of peak and current sample, pending placements and the new class); pool closed at 80 % data or 50 % metadata; sold storage at most 4 times the pool; 1,000 volumes; 8 starts at once on EU1; a storm of 40 wakes answered in at most 5.8 s (HTTP) and 7.1 s (WebSocket) with none refused | historical figures are not universal capacity guarantees. Required EU density/proof recovery, US 241-target population and regional storage/fault acceptance are accepted in the October 25–26 ULTRA ledger; post-cleanup free pool snapshot: EU1 271.292 GiB / US1 286.259 GiB, closed minute 10:40 UTC on October 26; both current placement previews idle | "Stage 1 Block 1: LVM at scale"; "Stage 5.6 wake storm, first measurement" | [4.4](#44-capacity-caps) |
| Reserved role names | `postgres`, `pgcf_backup`, `public`, `none` and every name starting with `pg_` are refused (`400`); `streaming_replica`, `cnpg_*` and `pgcf_maintenance` are ordinary names | decided (W2-C/W2-C2), included in deployed baseline B with migration `0085`; the exercised regional role/connection receipts passed on October 25 and are reused; no new role-testing gate is added | Dated ULTRA baseline; `packages/contracts/src/ids-core.ts`; served OpenAPI `RoleName` | [2.3](#23-roles-connection-uri-and-passwords) |
| Regions and the archive bucket | Two regions, `eu-dev` (EU1) and `us-dev` (US1), and one R2 archive bucket in the EU jurisdiction for both | measured 2026-10-22 and 2026-10-23 | "US1 installed into `us-dev` from the image"; "US1 database acceptance in `us-dev`"; "G8 one archive bucket: the cutover on Dev, steps 1 to 11" | [1.2](#12-regions) |
| Placement window | 3 days (deployed in baseline B) | decided 2026-10-23 (O6, plan 11.3) | "Placement is closed for 3 days after a burst" (plan 11.2); plan 11.3 | [2.1](#21-create) |
| Role deletion | Unroutable at once; the removal is confirmed by PostgreSQL; a hibernated database applies it at its next wake | a role delete passed live in Stage 5.1 on 2026-10-23; no plan row records a live run of the hibernated-database case or of a role that owns objects | "Live acceptance on the slot-pool release, part 1" | [2.3](#23-roles-connection-uri-and-passwords) |

The operational closeout is recorded in the dated ULTRA ledger; merge of this accepted record
closes G11 with the owner-accepted latency exception. Integrator implementation, connection
rollout and customer data migration follow separately.

## Appendix A. Error reference

### A.1 HTTP

Every error body is `{"error": {"code", "message", "request_id", "details"?}}`.

| Status | `error.code`              | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Retry                        |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 400    | `invalid_request`         | validation or unknown field, malformed JSON, body above 64 KiB, wrong `Content-Type`, bad ID, cursor or `Idempotency-Key`, a missing `Idempotency-Key` on a database or role mutation, unknown or disabled class or region, class above the memory maximum, `target_time` in the future, storage shrink, usage range not aligned or over 31 days, a role `valid_until` that is not in the future, a reserved role name (`postgres`, `pgcf_backup`, `public`, `none`, `pg_*`), a `member_of` entry that is not a live role of the database (or is `app`), deleting `app` | no                           |
| 401    | `unauthorized`            | key missing, malformed, unknown, revoked, or its project deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | no                           |
| 403    | `forbidden`               | integrator key on an admin route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | no                           |
| 404    | `not_found`               | unknown ID, an ID of another project, unknown route, a role route of a deleted database                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | no                           |
| 409    | `conflict`                | the request is refused for the cause in `error.details.reason` (table below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | by reason                    |
| 409    | `idempotency_conflict`    | same key, different request; replay of a credential-creating call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | no                           |
| 409    | `idempotency_in_progress` | same key still executing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | yes, shortly (`Retry-After`) |
| 503    | `capacity_exhausted`      | resize, resources or profile assignment: the node lacks memory, CPU or storage now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | later (`Retry-After`)        |
| 500    | `internal`                | unexpected failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | yes, with the same key       |
| 429    | `rate_limited`            | defined by the contract; the API emits none today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                              |

The stable reasons of a `409 conflict` (and of `node_capacity`) come in two kinds. A **retryable**
reason clears without a change to the request and the answer carries `Retry-After`; repeat the
request under the same `Idempotency-Key`. A **terminal** reason needs a different request or a
different resource first.

| `details.reason`                                                                                       | Kind      | Cause                                                                                                                                  | `Retry-After` |
| ------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `mutation_in_progress`                                                                                 | retryable | another change to the same database holds it for the moment (a wake, an idle sleep or its compensation, a maintenance step)            | 1 s           |
| `generation_changed`                                                                                   | retryable | the database, or what a create or restore was based on, changed between the read and the write ("Database changed; retry the request") | 1 s           |
| `not_ready`                                                                                            | retryable | the database has not applied its latest generation or is not running yet ("Database configuration is not ready")                       | 5 s           |
| `node_capacity`                                                                                        | retryable | the node lacks memory, CPU or storage for a resize, or for a resume ([2.4](#24-suspend-and-resume))                                    | 30 s          |
| `name_in_use`                                                                                          | terminal  | a live database of the project already has this name (create, restore)                                                                 |               |
| `database_deleted`                                                                                     | terminal  | the database is deleted                                                                                                                |               |
| `project_not_empty`                                                                                    | terminal  | the project still holds databases that are not yet confirmed deleted                                                                   |               |
| `role_exists`                                                                                          | terminal  | the role name exists                                                                                                                   |               |
| `role_limit`                                                                                           | terminal  | the database holds 100 roles; a role awaiting its removal counts                                                                       |               |
| `role_being_deleted`                                                                                   | terminal  | a role of that name is awaiting its removal; create it again once PostgreSQL has dropped it                                            |               |
| `role_has_members`                                                                                     | terminal  | other live roles are `member_of` this role; delete the members first                                                                   |               |
| `archive_expired`, `archive_unusable`, `no_recovery_point`, `source_unavailable`, `region_unavailable` | terminal  | restore refusals ([2.7](#27-backups-restorable-window-and-restore))                                                                    |               |

A `409 conflict` of an operator route (regions, nodes, fleet, profiles, capacity) carries a reason
only where it is one of these, for example `mutation_in_progress`; otherwise the message is all
there is.

`GET /v1/databases/{id}` answers `200` for a deleted database; role routes answer `404`.

### A.2 Operation kinds

`database.create`, `database.restore`, `database.delete`, `database.resize`, `database.suspend`,
`database.resume`, `database.role.delete` are started by you; `database.hibernate`,
`database.wake` by PGCF.

### A.3 Operation error codes

| `error.code`                                                    | Meaning                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superseded`                                                    | a newer intent (resize, delete or power change) replaced it; not a platform fault                                                                                                                 |
| `operation_timeout`                                             | except for accepted `database.delete`: no report for 20 minutes after placement or the node's last repeated `building` report ("Regional operation exceeded 20 minutes"); or a create or restore still building 24 hours after placement ("Build exceeded 24 hours after its placement") |
| `power_busy`, `power_archive`, `power_unknown`, `power_timeout` | a suspend or hibernation was refused or timed out; the database returned to running                                                                                                               |
| `role_not_droppable`                                            | `database.role.delete`: the role owns objects or holds privileges, so PostgreSQL cannot drop it; it stays unable to log in until they are removed ([2.3](#23-roles-connection-uri-and-passwords)) |

### A.4 SQLSTATE at connect time

| SQLSTATE | Message                                                                                                                                                                         | Cause                                                                                                                                                                                                                                         | Action                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `3D000`  | database does not exist                                                                                                                                                         | the `database` hint is missing or not a well-formed ID                                                                                                                                                                                        | fix the configuration                                            |
| `28P01`  | authentication failed / password authentication failed                                                                                                                          | a malformed role; or an unknown database, unknown role, deleted role or deleted database (indistinguishable from a wrong password by design); or a role past its `valid_until` (it does not wake a hibernated database); or a wrong password  | check ID, role, `valid_until` and password revision; do not loop |
| `28000`  | startup does not match the authorized route                                                                                                                                     | StartupMessage `database` or `user` differs from the URL hints                                                                                                                                                                                | fix the client                                                   |
| `08P01`  | duplicate connection admission hint / protocol violation                                                                                                                        | repeated `database` or `user`, or a malformed startup                                                                                                                                                                                         | fix the client                                                   |
| `0A000`  | replication connections are not supported / unsupported frontend protocol                                                                                                       |                                                                                                                                                                                                                                               | fix the client                                                   |
| `57P03`  | database is not accepting connections                                                                                                                                           | not admissible now: manual suspension, provisioning, no capacity for a wake (DETAIL `storage`, `node at awake capacity` or `node busy starting databases` where the node names the cause), error state, more than 32 waiters, or the wake did not finish within the 60 s deadline; see the tables in [3.4](#34-timeouts-and-retries-for-a-sleeping-database) | per cause                                                        |
| `53300`  | connection rate limit exceeded / database connection rate limit exceeded / connection admission unavailable; or PostgreSQL "too many clients" / "too many connections for role" | Edge rate limiters, admission limit, `max_connections`, or the role's `connection_limit`                                                                                                                                                      | back off; pool                                                   |
| `08006`  | gateway connection failed / connection admission interrupted                                                                                                                    | the 60 s deadline passed during a wake (the usual outcome), you aborted, the per-database gateway limit was hit, or the gateway was unreachable                                                                                               | retry; the wake continues                                        |

### A.5 Closing an established connection

WebSocket close code 1000 `database sleeping` (idle hibernation); 1012 with `authentication
interrupted`, `writer changed`, `database retired` or `gateway
restarting` (a restart); 1013 `relay buffer or connection failed`; 1003
`binary frames required`. All are disconnects: reconnect; statements in flight have an unknown
outcome and are not replayed.

## Appendix B. Where each statement comes from

| Topic                                                       | Source                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes, auth, error lists, idempotency, operation metadata  | `apps/api/src/routes/*.ts`, `apps/api/src/openapi*.ts`, `apps/api/src/app.ts`, `apps/api/src/middleware/*.ts`                                                                |
| Contracts (IDs, size classes, states, usage, costs, alerts) | `packages/contracts/src/{ids,api,errors,auth,usage,costs,infrastructure-alerts,nodes,database-resources}.ts`                                                            |
| Create, resize, delete, power, restore, roles               | `apps/api/src/domain/{databases,lifecycle,restore,restore-catalog,roles,archive,retained-archives}.ts`                                                                       |
| Admission, wake, idle, `57P03` | `apps/api/src/database-actor.ts`, `apps/api/src/domain/{placement,node-observations}.ts`; the node's own admission: `apps/node-agent/src/admission.rs` |
| Edge, hints, SQLSTATE, deadline, decoy                      | `apps/edge/src/*.ts` (the Rust/Wasm port in `apps/edge-rust` applies the same policy)                                                                                        |
| HTTP query mode                                             | `apps/edge/src/sql.ts` (Rust/Wasm: `apps/edge-rust/src/sql.rs`), `apps/native-gateway/src/sql.rs`                                                                                                                     |
| Gateway limits, TLS, cancel, startup, idle close            | `apps/native-gateway/src/transport.rs`, `packages/native-protocol/src/activity.rs`, `packages/contracts/src/pg-wire.ts`, `packages/contracts/native/protocol.generated.json` |
| Sleep sequence and refusals                                 | `apps/node-agent/src/sleep.rs`, `packages/contracts/src/sleep.ts`                                                                                                            |
| PostgreSQL cluster, backup schedule, retention, `pg_hba` | `apps/node-agent/src/{settings,agent/build,agent/power}.rs`, `apps/api/src/domain/backup-retention.ts`, `infra/node-image/README.md` |
| Client configuration                                        | `scripts/e2e/probe/worker.ts`, `@neondatabase/serverless` `CONFIG.md`, [README](../../README.md)                                                                             |
| Metering                                                    | `apps/api/src/domain/{usage,usage-rollup,usage-cron,costs}.ts`; the traffic attribution across an hour boundary is `fragments` in `apps/node-agent/src/usage.rs`    |
| Alerts, health                                              | `apps/api/src/domain/{operational-health,infrastructure-alerts,cron-health}.ts`, `apps/api/src/{cron,cron-watchdog}.ts`, `docs/operations/infrastructure-backups.md`         |
| Recovery, maintenance                                       | `docs/operations/recovery.md`                                                                                                                                                |
| Measured numbers and open steps                             | the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md)                                                                                              |
| Region policy, alert thresholds (installation values)       | `GET /v1/regions/{id}/capacity-policy` of the live installation, not the repository                                                                                          |

## Appendix C. What the served OpenAPI document states in words

`GET /v1/openapi.json` is generated from the contracts and checked against their own JSON Schema:
property names, requirements, patterns, bounds, `multipleOf`, nullability and enumerations agree,
and `info.version` is the contract version. A JSON Schema cannot state the rules below, which
involve several fields, the stored state or the time of the request. The document says each in the
description of the schema or the operation; the code is authoritative.

| Rule                                                                                                                                                                                                  | Where the document says it         | Refusal |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- |
| An `integrator` key requires `project_id` and an `admin` key must omit it                                                                                                                             | `ApiKeyCreate`                     | `400`   |
| `memory_mib` of a size class is a multiple of 256                                                                                                                                                      | `SizeClass`, `SizeClassUpsert`     | `400`   |
| `postgres`, `pgcf_backup`, `public`, `none` and `pg_*` are not role names, and `app` is the owner                                                                                                      | `RoleName`                         | `400`   |
| `valid_until` must lie in the future when the request executes (not on a replay); every `member_of` entry is a live role of this database that is neither `app` nor being deleted                     | `createDatabaseRole`, `RoleCreate` | `400`   |
| A usage request names exactly one scope; both boundaries are aligned to the granularity and at most 31 days apart                                                                                     | `getUsage`                         | `400`   |
| A request body is JSON of at most 64 KiB with `Content-Type: application/json` whenever there is a body                                                                                               | `info.description`                 | `400`   |
| Idempotency keys are kept 24 hours per API key; a request that failed is not retained                                                                                                                 | `Idempotency-Key` of each mutation |         |
| A deleted database is read with `200` and `desired_state: deleted`                                                                                                                                    | `getDatabase`                      |         |
| An operator route's `409` carries a `details.reason` only where it is one of the listed reasons                                                                                                       | [A.1](#a1-http)                    |         |
