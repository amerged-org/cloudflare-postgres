# ULTRA — customer-ready PostgreSQL

Canonical scope and status. The owner decision of **11 October 2026** makes the fleet EU-only. On
**15 October 2026** the owner approved going live: the first integrator creates its new databases
on PGCF once the [go-live path](#go-live-path) is complete.

## Fixed scope

Cloudflare is the global control plane: it owns configuration, placement, progress, releases and
provider actions for every region. The fleet is **EU control** (relay host, no customer databases)
and **customer EU1**. Preserve both servers, existing data and keys; no EU reinstall. The US region
is cancelled at Contabo (contract ends 2026-11-04); US1 was marked lost on 2026-10-11 and is no longer patched.
US and Oceania return later from the same region configuration. Purchases and autoscale stay off
through go-live; enabling them, or any new paid resource, requires the owner's explicit, costed go.

**R1-final is frozen:** the qualified Golden image containing the sandbox DNS/hostname fix,
Talos 1.14.2 and Kubernetes 1.36.5. Its installer and raw image are privately distributed and
fully verified. Further Golden changes require an observed boot or data blocker; other work
belongs to R2. Runtime/platform references are immutable release inputs from the verified lock.

**Runtime.** Databases run on CloudNativePG. The native controller and gateway are deployed; EU's region switch (`compute_pool`) is on and EU1 keeps one prestarted sandbox slot. A measured first query below one second after idle through Cloudflare, delivered by the [parked sleep tier](parked-instances.md), is required **before go-live**. The parked tier replaces the shared warm PostgreSQL pool (alternative 8), which is deleted from the code (owner decision 2026-10-15); the Rust/Wasm Edge and the native bootstrap relay follow after go-live.

**New nodes require thin storage**; there is no thick fallback for them. Retained thick volumes
keep their backend and data. Thin activation needs a release-bound receipt from the
[qualification gates](#thin-storage-qualification-gates); EU1's run 14 produced one on 2026-10-13,
carried by R2.7 through R2.11.

**From the canary on, the EU stack is production.** `pgcf-api-dev` and `eu-dev` are only names;
there is no separate test environment. Fleet rollouts that reboot EU1, thin qualification runs,
failure and density tests and material rotations then need the owner's go and an announced
maintenance window, because a reboot of EU1 or control stops every awake database and the fleet has
no region-wide maintenance lock; later acceptance uses dedicated test projects with stated limits.

**Owner priority (2026-10-14):** deliver a sleeping Thin database's first SQL below one second through Cloudflare on a runtime that already exists (a parked Pod; the shared pool this text first named is deleted). Finish the required execution and data-preservation guards, deploy, and measure this path before broad acceptance repeats, density work or independent administrative features. Reuse valid completed checks; repeat tests only for relevant changes, concrete failures or required CI. A thick-only hit or an already-awake connection does not complete the goal. The full customer-ready scope remains required afterwards.

**Owner priority update (2026-10-15):** the first query after idle must answer in 1–2 s, measured live and tested; this is the most important goal for going live. The parked sleep tier is the vehicle (a sleeping database keeps its Pod warm), the shared pool code is deleted, and the parked capacity per server is measured and reported.

## Delivery architecture

- **One Golden image.** New nodes, control or customer, install the selected release's Golden raw
  image and installer through `AddNode`; retained nodes upgrade to the same installer through
  fleet patches. Roles differ only in generated machine configuration and release role pins
  (`control_relay`, `customer`). Network settings, keys and cluster custody stay outside the image.
- **Cloudflare is global.** One API, D1, Durable Objects and Workflows manage every region.
  `AddNode` installs new nodes. An approved fleet release plus one `POST /v1/fleet/rollouts`
  request patches every listed node automatically, customer members before their region's
  control server, without operator steps.
- **A region is one control server plus N identical customer workers.** The control server
  follows the documented
  [per-region configuration](../../infra/talos/README.md#control-server-configuration-per-region):
  Talos role `controlplane`, fleet role `control_relay`, database placement disabled, operator
  sources and the generated provider firewall, and material rotation through Cloudflare custody.
  Customer workers join it through `AddNode` from the Golden image and take all customer
  databases. EU1 predates the Golden image; it converges in place and is not reinstalled.
- **One relay for the whole fleet.** The bootstrap relay is a singleton add-on on EU control.
  It carries Cloudflare's native transport to every region; no other control server runs it.
  `AddNode` never targets the relay host. EU control predates the programmed installer: fleet
  releases converge its software, and only the manual Talos recipe can rebuild it.
- **US and Oceania later.** A new region follows the
  [new-region runbook](../operations/operator-installation.md#control-server-of-a-new-region):
  `POST /v1/regions` with a new region ID, the Cloudflare prerequisites, an installation profile
  with `first_region`, then `AddNode` for the control server (a region's first node becomes its
  control plane), placement off and role `control_relay`, then workers. The cancelled US records
  stay dormant and are not reused.
- **Current constraints.** EU selects a receipt-bearing release (R2.11) with matching `compute_pool`
  and `thin_storage` templates, so the R2b gate is met. `AddNode` still needs every live EU member
  converged, and EU1 reports `pending` while Thin is blocked (go-live step 3). An EU addition also
  lacks the write-once EU installation profile, and its outside network proof needs a Ready node in
  another Contabo region; while EU is the only region it needs the manual network-proof path. The
  purchase itself checks neither, so purchases stay off.

## Done

| Completed step | Measurement / boundary |
| --- | --- |
| Generic API controls | RAM threshold and purchase switches accepted live; fresh installations buy/send nothing. |
| Frozen R1-final image | One installer/raw composition: 11.5/28.0 s; five private immutable objects fully read back; public eligibility is listed under [after go-live](#after-go-live). |
| EU-only fleet | US1 marked lost 2026-10-11; EU material revision 3 (Talos 1.14.2, Kubernetes 1.36.5) active with retired authority rejected; R1.2 converged on EU1 and control without operator intervention. |
| EU acceptance (standard runtime) | New database ready in 30.7 s, SQL through Cloudflare 0.57 s, base backup and WAL in R2 after 20.7 s, delete and storage reclaim 93.3 s. |
| Wake path | Cold wake to first row 8.1–9.4 s (Gate 0, 2026-10-12, no RuntimeClass); awake first row 0.47–0.96 s (0.54–0.61 s in the Gate 0 warm rounds); Pod Ready → Edge admission about 1.1–2.9 s after the wake orchestration (was 4–5 s; Pod Ready at one-second resolution). |
| R2 native runtime | R2.11's native controller and gateway patches completed on EU1 (09:45Z) and control (09:51Z) on 2026-10-14; since the Thin block (go-live step 3) EU1 and the R2.11 rollout report `pending`. The usage outbox drains and a woken database sleeps after 60 s idle. |
| EU1 upgrade | 6 vCPU and 12 GB (11,943 MiB visible); the reboot's configuration proof and kubelet pin were renewed through the fleet path; idle node CPU 3.23 %, RAM 8.72 %. |
| Thin qualification | Run 14 passed all seven gates; `startup_bound` maximum sample gap 3,574 ms < 5,000 ms; cleanup restored the volume group byte-exactly. |
| Thin authority renewal | Option 1 deployed: native sampling every 2 s, capability gating and composed authority; scrape p99 119–134 ms in the qualification windows. |
| R2b activation | R2.11 carries the run-14 receipt; the EU `thin_storage` template and the EU1 Thin selection (revision 9, new databases allowed) are installed; pool 16 GiB data and 1 GiB metadata, growing to 64 GiB. |
| Thin database, first pass | Under R2.9 a new Thin database committed 1,000 rows through Cloudflare (its first start went through a protective sleep after a withdrawn startup authority), a manually started base backup and WAL reached R2, a restore returned the same digest and delete reclaimed both volumes. |
| Daily infrastructure backup | D1 and EU etcd verified in R2; complete on 2026-10-13 (148.3 s) and 2026-10-15 (331.8 s). |
| API reads | Database placement and conjunctive filters, node and region reads, paginated release and patch history verified live; the three OpenAPI documents (public 112, agent 13, internal 21) cover all 146 operations of the deployed Worker (`22c0164`). |
| Shared warm pool | Owner approved alternative 8 (PGCF-supervised PostgreSQL in pre-created pool Pods) on 2026-10-12 and decided on 2026-10-15 that the parked tier replaces it. It was never live: no release, switch, namespace or deployed binary had it. Its supervisor crate and image profile, sandbox-controller modules, controller and gateway paths, API domain and routes, contracts and CI steps are deleted from main (API deployed 2026-10-16 with migration 0056 applied) (git history is the archive); migration 0056 drops its 14 empty D1 tables. |
| Role lifecycle | Live acceptance on R2.14 (2026-10-16, EU1 Thin, pool-free API): database ready 32.5 s; two roles with membership, connection limit and `valid_until` applied in 5.7 s and verified in PostgreSQL (`pg_has_role`, `rolconnlimit`, `rolvaliduntil`) through Cloudflare 0.7 s; password reset 8.8 s with the old password refused and the new accepted; deleting a role that others are members of refused (409); a deleted role refused at once (0.9 s) and dropped in PostgreSQL 5.9 s; the name re-created. |
| Rollout-safe thin write authority | Merged and deployed 2026-10-16 (API `32e43db`, migration `0057`, NodeBootstrap executor): a `continuing` qualification class keeps thin samples, tokens, the desired page and identity turns through a rollout that pins the same thin facts, and strict admissions stay strict ([design](thin-authority-renewal.md)). An independent review found five problems before the merge (a rollback or a superseded halt kept tokens flowing on a node with other pins, a proof from before a pin change, the D1 expression depth limit, the wire gate, the `postgres` stage counts); all fixed with tests. Live acceptance on R2.19 (controller-only rollout, both nodes patched, controllers restarted, 38 minutes): one open psql session on an awake Thin database inserted 2,249 rows with a maximum gap of 1.38 s and was never disconnected, write authority stayed on (`write_allowed` 1), the Pod never restarted, and the rollout's own preflight passed with the database awake. Before it, an awake Thin database lost its tokens at rollout start, could not finish its sleep and held the rollout's preflight (`patch_preflight_unhealthy_databases_ready`) closed for 12 minutes. Open: a rollout that changes the extension, kernel or OS still pauses authority from the assignment; the controller `Recreate` gap longer than the 10 s guard did not occur in this run (EU1 controller restart under write load, no gap above 1.4 s). |
| Green main | CI on `2bc6e55` passed every job and published all images (2026-10-15 13:47–14:33Z) after six fixes: the kernel and IO fixtures of the pool supervisor, the storage image built in `check`, the sandbox proof and node-runtime test images, the Cilium values pin, a scanner finding from a fixture field name, and the exporter-only driver kept as the qualified one. |
| Wake floor on EU1 | PostgreSQL 18.6 clean start reaches ready in 111–117 ms (first SQL 136–169 ms); CNPG fence/unfence reaches accepting connections 226–305 ms after the annotation, Pod recreation takes 4.1–5.2 s; a fenced instance manager holds about 62 MB; in-place resize of requests keeps the Pod. |

## Go-live path

Owner approval of 2026-10-15. One row per step in dependency order; a step moves to Done only with
its measured result. Steps 8–13 run in parallel with 2–7; the canary starts when 1–13 are done.

| # | Step | Status | Finished when |
| --- | --- | --- | --- |
| 1 | Green main | Done: CI on `2bc6e55` passed every job and published all images (2026-10-15 13:47–14:33Z); see [Done](#done). | One CI run on main passes every job and publishes all images. |
| 2 | Parked sleep tier | Implemented test-first ([design](parked-instances.md)) and deployed since R2.12 (2026-10-15), measured in rows 5 and 6: an idle sleep fences the database's CNPG instance (PostgreSQL stops, the Pod, volume, sidecar and Lease stay), the Pod's requests shrink in place, and the next connection unfences it; a time-to-live (default 600 s), a per-node cap (default 8) and any drift while parked demote to real hibernation. Public state stays `hibernated`; the region policy `parked_tier` is the only switch. Parked Pods keep the class CPU and memory requests (CNPG's `bootstrap-controller` init container carries the cluster resources); parking frees the sidecar's request delta and the RAM the stopped PostgreSQL used. Measured on EU1 (throwaway namespaces, 2026-10-15): unfence to PostgreSQL accepting 226–305 ms including a 160–207 ms laptop round trip (Pod recreation 4.1–5.2 s); a fenced instance manager holds about 62 MB. No host extension, driver or kernel change. | Controller and API deployed in a release without a Talos change; the live acceptance L0–L7 of the spec passes on a throwaway Thin database; a woken parked database's marker is intact; demotion returns its Pod and charge. |
| 3 | Go-live release | Rolled out 2026-10-15: release `r2.12-golive-3305f99` (the R2.11 spec with the parked-tier controller and API migrations 0047–0051) in 49 minutes, control first then EU1, without a reboot; both nodes `converged`, EU1 Thin `ready` with placement open (Thin was re-selected beforehand: revision 9 `blocked` → 10 → 11). Its acceptance failed: a controller bug kept every database from becoming ready, thick and thin — `inet_server_addr()::text` carries a `/32` suffix that the role identity check rejected (`postgres.rs:243,301`; the check arrived with the pool holders and had never run live). The next release, `r2.13-inet-2b5637b` (the same spec with the fixed controller), completed its rollout 2026-10-15 22:23Z and passed the create, SQL, archive and delete acceptance on EU1 Thin: create to ready 62.7 s, first SQL 0.55 s, base backup and 3 WAL files readable 0.4 s later, delete to storage reclaimed 235.7 s (the deletion waits for a fresh identity proof), integrator key revoked. Release `r2.14-5bd354f` (the R2.13 spec with the trimmed controller, gateway G-1 hardening, direct readiness, roles and the loop fix) rolled out 2026-10-16 01:07–01:45Z, control first, without a reboot; its EU1 acceptance on Thin: create to ready 51.6 s, first SQL 0.56 s, base backup and 3 WAL files 0.5 s, delete with reclaim 288 s. The API (migration 0055) and Edge followed from `699e685`. During the rollout no thin sample was accepted from 01:07:16Z until convergence (see the operations finding in [speed and scale](#speed-and-scale-decisions-2026-10-16)). | A release whose acceptance (create, SQL, delete; idle sleep and wake) passes on EU1, with both nodes `converged` and EU1 Thin `ready` with placement open. |
| 4 | Thin acceptance | Base pass on R2.11 (2026-10-15): create to ready 260.4 s (thick on R1.2: 30.7 s), SQL through Cloudflare 0.93 s, base backup and WAL 84.5 s, delete with reclaim. An idle sleep failed live: the host guard stopped the Pod's tasks 7 s after the sleep intent (restartCount 1), PostgreSQL restarted while D1 stayed `suspended`, and the controller's reconcile failed in a loop; the API fix keeps a stopping Pod's token until the controller's stop observation commits ([design](parked-instances.md) 3.3). Open as well: a new database's first start went through a protective sleep while the node authority flipped to `blocked` for one sample, the guard's LV suspend is unconfirmed in a loop, and thin accounting reserves each LV's full logical size. New thick databases are not an alternative: the native gateway admits thick storage only from the list a fleet patch writes. Measured on R2.13 (2026-10-15/16, EU1): create to ready 49 s on an existing pool with headroom and 160–246 s when the create needs a pool growth step (24 to 32 GiB; the growth itself did not disturb running databases). Every 10–14 minutes all thin Pods on the node had their containers killed with SIGKILL within one second by the host guard (exit 137; parked Pods then demote with `identity`, the API resumes the stopped ones): the guard's lease fetch (`hostStorageLease`) takes 1.6–2.5 s (p50 1.9 s) because it runs sequential D1 queries per database row and keeps a row for every database ever deleted (18 entries, 15 of them tombstones), while a runtime token lives 10 s from its sample's nonce issue and is 4.7 s old (max 5.9 s) when received, a margin of about 2 s. Bulk reads, tombstone retirement and the continuity of a running database's token across role changes (migration 0055) are deployed since 2026-10-16 (API `699e685`; a lease is 6 statements in 4 round trips instead of hundreds); after the deploy the lease handler takes 50–100 ms and tokens have 6–8 s of 10 s left at serve, but a parked Pod was still SIGKILLed with a valid token at 02:00:57Z while no lease request from EU1 reached the API for 5 s (a stall inside the host extension): the next host-extension release (fsync-free fetch loop, per-entry accept, no reclaim poller) is needed for stable thin databases. Written test-first on branch `golive/host-guard-r3` (not yet released, no numbers yet): the lease intake is a thread of its own that accepts first and records afterwards, a request that hangs no longer delays the next fetch, the reclaim poller is deleted, a token for an unassigned Pod no longer drops the lease, and scopes that the lease stopped naming retire; per-entry accept and the sticky stop remain design only. A second cause, measured with persisted Workers Logs: the nightly D1 export makes D1 refuse every query for about 4 s (`D1_ERROR: Currently processing a long-running export.`, 50 failed requests, kill 5 s after the first), which a 10 s token cannot outlast. A longer guard is not available with the current gate: a qualification sample counts only when its nonce was issued inside the gate's journaled window and the next sample arrives inside it, and the `startup_bound` window (`ready` to `loaded`) is 4.7 s on EU1, so a 30 s guard (6 s period) recorded no sample there and failed `thin_qualification_startup_bound_failed` on 2026-10-16 (run `op_t0pl0oadw57ss3ti0oz9`; data_full, metadata_full, noflush_quiescence and resume_marker passed; cleanup verified the volume group back at its baseline). The guard stays at 10 s (2 s period) until the evidence rule is changed deliberately. | On the go-live release: create, SQL through Cloudflare, automatic base backup and WAL, restore with the same digest, delete with reclaim, idle sleep and wake (parked and hibernated); a control reboot while a Thin database is awake under writes shows the protective stop, resume and no lost acknowledged commit; the checks of section 11 of the [renewal proposal](thin-authority-renewal.md) pass. |
| 5 | Sub-second wake | Top priority (owner, 2026-10-15): the first query after idle must answer in 1–2 s, tested live. Measured on R2.13 (2026-10-16, parked tier before direct readiness, gateway G-1 and the Actor trims), from a Cloudflare Worker through the public endpoint, WebSocket open to PostgreSQL ready included: thick parked 2.9, 2.9 and 3.9 s (cold hibernated 8.8 s), thin parked 3.0 and 2.3 s; PostgreSQL's startup protocol over the open socket is 57–77 ms of that. The split of a parked wake: request to the controller's hint 0.6–1.6 s, hint to the completed verification chain 1.1–1.9 s (`desired_pull` 0.3–0.4 s, `desired_apply` 0.14–0.7 s, `fence_release` 0.07–0.17 s), then 0.3–0.8 s from the chain's end to the open socket (the observation POST alone 0.25–0.65 s). Two of the six parked wakes failed for reasons that are not latency: one went through `demotion_in_progress` to a cold start of more than 30 s and was refused after the 30 s admission deadline, one received `57P03` after 0.9 s with no wake operation created (an optimistic-lock race of the claim with the controller's periodic observation write, `updated_at`). Direct readiness is implemented test-first on the controller (a resumed Pod is published on its attestation without the kubelet's Ready bit, [spec](parked-instances.md) 2.2.1) and needs the gateway change G-1 on the same node, so the fleet patch applies the gateway first and the controller second in one release; both shipped in R2.14. The controller also stopped ending the first pass of every generation in `runtime proof changed before target publication` (the completed generation was written to the namespace after the proof named it). Budget (spec 6.1): the awake path is 0.47–0.96 s (0.54–0.61 s warm) from a laptop; the first parked implementation is expected at 1.3–2.2 s with kubelet readiness in the loop, about 1.1–1.2 s with direct SQL readiness, a gateway change that routes to the attested Pod before its Ready condition, and the trims of spec 6.4; below 1 s needs a further 130–200 ms. PostgreSQL's clean start is 111–117 ms on EU1. Measure from a Cloudflare Worker as well as a laptop. **R2.14 (2026-10-16, controller trims, direct readiness, gateway G-1, Actor trims; from the probe Worker, thin parked): 1.24 s, 1.54 s, 1.24 s; split and next steps (W1–W7) in [speed and scale](#speed-and-scale-decisions-2026-10-16). The p50 is at the 1–2 s goal; below 1 s needs W2 and W3 (0.84 s of the 1.16 s are Cloudflare terms).** | A woken parked database's first SQL through Cloudflare is measured stage by stage in milliseconds, five times with a 2 minute gap, and its p50 is below 1 s; misses (demoted, hibernated) are labelled; data and archive continuity hold. |
| 6 | Parked tier acceptance | Run partially on R2.13 (thick and thin databases; see row 5 for wake latencies): a woken parked database's marker is intact; TTL demotion fired on schedule for the thick database (600 s after parking, `park_demotion` `ttl`). Found: after every wake the controller re-reconciles an awake database back to back, about 1.5 full passes per second (89 Kubernetes requests and one accepted observation, a D1 write, per pass) until the next sleep; design item 6.4 #9 described 3–4 extra passes. Still to run: includes TTL and cap demotion, controller and CNPG-operator restarts, an instance manager killed, a Pod deleted by hand, role password reset and resize while parked, manual suspend, delete with reclaim, and the cost of the sidecar's catalog maintenance while parked. | Spec 7.3 L0–L7 and live checks V-1…V-13 pass on EU1; RAM and CPU per parked database and the CNPG operator load are measured; the per-node cap is set from them. |
| 7 | Density on EU1 | Defined [below](#density-load-test-12-gb-node); runs after steps 5–6 because parked databases change idle RAM and the awake budget. | Awake limit K, sleep release and storm admission match the code for the class mix; maximum databases per class and the memory-start bound are recorded; caps integrators must enforce are stated. |
| 8 | Alerts | Implemented test-first, not deployed; delivery waits for the owner's Resend secret (`RESEND_API_KEY`) in Cloudflare, a sender on a Resend-verified domain and a recipient. RAM, CPU, node-storage and infrastructure-backup alarms already existed and are verified. New kinds, each with a runbook `action` in its event ([rules](../operations/infrastructure-backups.md#alert-kinds-and-runbook-actions)): `database_archive_failing`, `database_base_backup_stale` (36 h of awake time; hibernated excluded, a wake restarts the count), `thin_storage_blocked` with its `thin_storage_*` code, `database_storage_protected` (5 minutes) and the cron kinds `control_cron_stalled` and `control_cron_step_failing`. Every cron step runs in its own failure boundary with alerting first and backup dispatch next; the `CronWatchdog` Durable Object alarm (binding `CRON_WATCHDOG`, tag `v4`, D1 migration 0052) judges the heartbeat independently of the cron trigger. A sender or recipient change never revoked a running daily run; the one gap, a run created while the PUT is in flight, is closed. Live read on 2026-10-15: both EU databases report archive `unknown` and EU1 Thin is `ready`; the lost US node keeps `regional_node_stale` active and undelivered, so it is the first message once a destination exists. | One real alarm arrives at the named recipient; the infrastructure and per-database kinds above are delivered, each with its runbook action; a stopped or failing cron raises an alarm that does not depend on the cron; the Worker is deployed with migration 0052 and the `CRON_WATCHDOG` binding. |
| 9 | Backups | Implemented test-first, not deployed (API migration 0052, [runbook](../operations/infrastructure-backups.md)): a due attempt waits, without taking an attempt number, while a fleet patch operation is unfinished or changed in the last 15 minutes or a thin start granted in the last 15 minutes is not ready (the export request checks the start again); a failed attempt is retried after 90 minutes, at most three a day. 2026-10-14 failed all three attempts, ten minutes apart, with `infrastructure_backup_operator_portforward_timeout` during the R2.8 rollout (23:47–00:31Z; the third began 86 s after it), which rebooted neither node; the stalled link is not known. Replayed over the ten recorded runs the rule holds the four failures that met a patch and none of the four completed runs. Measured from the regional agent's 15 s samples, the export stalled D1 requests for at least 37 s in three of six runs (gaps of 68–72 s), for up to 37 s in a fourth and not visibly in two, against the 10 s write-authority guard. Daily artifacts have only been read back, never restored. | A rollout no longer uses the day's attempts (the first nightly run after one completes on attempt 1); one D1 artifact is decrypted with the offline key copy and imported into a scratch D1 with integrity checks, and the etcd artifact passes a snapshot status check; a night with an awake Thin database under writes and one wake during the export shows no protective stop and no failed wake, otherwise method or schedule change (the measured stalls say the export as it is will stop awake Thin databases). |
| 10 | Control database growth | Raw `usage_samples` are pruned in bounded batches since the usage cron change (47,588 rows on 2026-10-16 against 636,689 on 2026-10-14); D1 is 47 MB and its nightly export still blocks every query for about 4 s (an awake thin database's tokens cannot outlast it; see row 4). Before pruning the hibernated retained database alone wrote 17,456 rows (9 MB) in 24 h. Usage ingestion costs about 5.5 rows and USD 2.85 per database and month; at 100 databases per node the control D1 saturates (model in [speed and scale](#speed-and-scale-decisions-2026-10-16)). | Idle hibernated databases emit no samples; raw samples covered by finalized hourly rollups are pruned in bounded batches; D1 bytes per database per day and the headroom to 10 GB are recorded. |
| 11 | Credential hygiene | Revoked 2026-10-15: the two unused US-era Cloudflare tokens (`pgcf-dev-eu-read-…`, `pgcf-dev-us-write-…`, never used), the cancelled US data tunnel `pgcf-us-dev-data`, and the pending US database record; EU archive reads still work (5 base backups, 76 WAL files on the retained database). Two US database rows stay in `deleting` on the lost node until lost-node closure (step 12). US1 was powered off by the owner on 2026-10-16 (it had polled the API about five times a second) and its configuration is treated as compromised; the Cloudflare account that holds PGCF's D1 and R2 is shared with unrelated projects whose account-wide tokens can read or change them (owner decision, see After go-live). | No US credential remains; EU archive reads and writes work; `ARCHIVE_US` is kept; the two `deleting` rows are closed with the lost-node closure. |
| 12 | Recovery | Per-database restore returns a new ID. Replacing a lost EU1 needs a purchase, `AddNode` recover, the EU installation profile and the manual network-proof path; control (relay, API server, sampling source) has no loss procedure; lost-node patch closure is open, so an unfinished patch on a lost EU1 blocks the region's rollout guard. | The EU installation profile exists; the owner has pre-approved a costed replacement order for an EU1 loss (or EU2 exists); lost-node patch closure is delivered; the runbooks for EU1 loss and control loss are written with their preconditions checked and state the measured control-reboot impact; no purchase is made. |
| 13 | Integrator access and catalog | Project-scoped credential isolation has not been exercised live. Eight size classes are enabled, six of them test classes, and the 256 MiB class keeps backups for one day. | The integrator has its own key whose scope and rotation are verified live; the owner approves the production class catalog (memory, CPU, storage, `max_connections`, `sleep_after_seconds`, `archive_timeout`, `backup_retention_days`) and test classes are disabled; the deployed handshake limit (120 new WebSocket connections per 60 s per database) is stated. |
| 14 | Handover | Open | The [integrator handover](../operations/integrator-handover.md) states measured values: RPO and PITR window per class, parked hit and miss latency, 57P03 meanings and retry rule, connection limits, outage classes and maintenance windows, new IDs after restore or node loss, capacity caps; the first integrator confirms it in writing. |
| 15 | Canary | Open | At least five internal databases of the first integrator run on the go-live release for at least 72 h including two nightly backup windows: each shows a completed base backup younger than 36 h and continuous WAL, no `53300` refusals, one PITR restore is rebound by the integrator and no acknowledged commit is lost; then the integrator creates all new databases on PGCF. |

## Speed and scale decisions (2026-10-16)

Seven read-only research passes (Neon, Xata, the wider field, the controller's Kubernetes work,
instant-resume techniques, control-plane scaling) fed these decisions; evidence, design and experiments
are kept in [wake-path-v2-and-scale.md](wake-path-v2-and-scale.md). Numbers are quoted from primary
sources (repositories at the named commits, vendor engineering blogs, an independent benchmark) or
measured on EU1; everything else is marked as an estimate.

**Measured on R2.14 (2026-10-16, thin database, parked tier, from a Cloudflare Worker):** first query
after idle 1.24 s, 1.54 s, 1.24 s (was 2.3–3.9 s on R2.13). Of the 1.16 s to the open socket, 0.84 s
are three Cloudflare terms (Edge, claim and hint 0.37 s; pull 0.21 s; observation POST 0.26 s) and
0.30 s is the node (unfence to fence release; PostgreSQL accepting 0.12 s after the unfence). Found in
the same run: two of five parked connects were refused with 57P03 (a claim lost to another predicate,
probably a stale thin inventory after a failed identity turn), a cold wake of a thin database took 44 s
(37 s waiting for the next identity proof; the Edge gives up at 30 s), and an awake thin database still
re-reconciles every 2 s.

**Measured on R2.15 (2026-10-16, same database, controller W1 and API with W7 and W9, from a Cloudflare Worker):**
database create to ready 21.3 s (R2.14: 51.6 s), first SQL 0.71 s, base backup and WAL in R2, delete and
reclaim 321 s (live acceptance PASS). Parked first query in five rounds: 1.40 s, 1.94 s, 3.67 s, 4.34 s,
4.55 s. The node chain is 0.27 s when the pass finishes in one go; in three of five rounds it did not:
the pass cannot publish the runtime attestation (`wake_path` logs why from R2.16), waits for the kubelet
Ready bit, and the next pass dials the tenant Service before its endpoint exists
(`postgres_io_host_unreachable`) and waits the 2 s retry timer. Fixed for R2.16 (`a0d37de`): the first
retry after a failed pass is 250 ms, and the lean-path blocker is logged. The cold thin wake (database
asleep longer than the parked TTL) still missed the Edge's 30 s deadline (08006): a regular identity turn
was in flight when the start hold arrived, its callback was refused and the 5 s backoff delayed the next
turn (`3b1a7cc`, API only: the first failure of a turn with demand retries at the 10 s spacing); the turn
itself takes 18.8 s (6 relay connections), so the floor of a cold thin wake stays near 25 s until the
identity proof is read inside the cluster.

**Measured on R2.16 (2026-10-16, controller with the 250 ms first retry and the identity-turn retry; same database):**
parked first query 1.51 s, 1.56 s, then a 30 s failure (08006), 10.6 s and 4.9 s. The 2 s stall of R2.15 is
gone from the rounds that met a parked Pod (1.5 s, of which the node chain is 0.27 s). The bad rounds met a
database whose parked Pod the controller had demoted about 80 s after parking (`park_demotion` reason
`identity`, which makes the next wake a cold one; the event carries the failing fact from the next release).
The cold thin wake has a second cause: after `volume_identity` went pending the controller ran no pass for
exactly 30 s although the identity proof was accepted 18 s into the wait, because the passes that CNPG's Pod
changes cause while the Pod is created had used up the not-ready backoff (fixed: a pending wake polls each
second for its first minute). And the new `wake_path` event says why the wake never takes the lean path
(publishing on the barrier, no wait for the kubelet): `blocked_by: no_admission`. The release specs since R2.11
declare only `route_token_version: 3`; route token v4, runtime attestation v2 and the admission snapshot
(`docs/operations/operator-installation.md`, Route tokens) have never been active live, so the controller's
barrier publication and the Actor's verified-target admission are untested outside the in-process world.
R2.17 declared them (`route_token_version: 4`, `runtime_attestation_version: 2`,
`admission_snapshot_version: 1`) and broke on first contact: a new database was ready after 83 s (21 s
before) and its first connection was refused (`FATAL: gateway connection failed`, the gateway's `conn_stages`
said `route_stale`), a cold wake finished its controller chain at 20.9 s and was refused at 20.5 s. R2.18
rolled the region back to route token v3. Root cause (found by reading the path and reproduced in the
in-process world): the controller built the `ca-<db>` ConfigMap with the annotations that name its source
Secret (`pgcf.io/source-ca-secret-uid` and `-resource-version`) but `apply_to` replaced every annotation
with the generation stamp, so the gateway never found a CA for the target and refused every v4 route
(fixed in `cd63a0b`). Not explained yet: the extra 60 s of the creation (one pass is certainly redone after
`bind_fence` writes the storage ConfigMap that the runtime proof names). Three v4 hazards to accept or fix
before the markers go live again: a controller restart or watch gap gives every ready database a new
route revision (57P03 until it is attested again), a rewrite of the CA Secret is two writes (CA map, then
target), and gateways do not acknowledge a new target before the report goes out.
Tried and reverted: constraining the NodeBootstrap container to `WEUR` (`containers[].constraints.regions`)
made the identity turn slower (20.9 to 22.3 s, 7 turns, against 17.9 to 18.8 s in the default placement), so
the 18 s is not distance to the container; the floor of a turn is its four sequential relay steps.

**Measured on R2.20 (2026-10-16, route token v4, runtime attestation v2 and the admission snapshot live for the first
time, controller `cd63a0b`; parked Thin database from a Cloudflare Worker):** create to ready 145.9 s with the
pool initialised (28 s with the pool present; the 83 s of R2.17 was the missing CA), first SQL 0.72 s, awake
first query 0.74–0.84 s, base backup and WAL in R2. Parked first query in six rounds: 1.35 s, 1.73 s, 2.11 s,
2.52 s, 2.54 s, 3.13 s (p50 2.5 s), no failure and no stall; `wake_path` now says `lean: true`, so a parked
wake is published on the barrier without waiting for the kubelet; from the pull to the released fence the
node takes 0.19 s. What is left of the wake is Cloudflare time: the Edge's `ensure_awake_ms` 1.4–1.6 s (claim
and hint 0.49 s, pull 0.2–0.5 s, the controller's chain, the observation POST 0.3 s) and 0.6–1.2 s before the
hint reaches the controller (Worker start, TLS and upgrade). W2 (the desired row on the hint) takes the pull
off the path; W3 (local admission) the POST.
A cold Thin wake (database asleep past the parked TTL) answers the first query in 21.8 s from the same
Worker (it was 44 s at R2.14 and then a failure at the Edge's 30 s deadline): the identity turn is requested
0.5 s after the hint and takes 18–19 s, the controller polls each second and finishes 0.1 s after the proof
is read. Its floor is the turn's four sequential relay steps; below it only an identity read inside the
cluster (owner review of what the control plane then trusts) or a longer parked TTL changes the cold case.

**Language.** It is not what limits the wake. A parked wake issues about 100–145 Kubernetes requests,
which cost 11–14 ms of CPU in Rust, 22 ms in Go and 28 ms in Node on a laptop (at most 3–5 % of
0.8–1.9 s); Xata's Go gateway and operators show the same 1.1–1.25 s mode as PGCF's projection, and
Neon's Rust proxy is not what makes Neon fast either. The cost is rounds (quorum reads, writes behind
two webhooks, kubelet probes) and Cloudflare hops. Decision: Rust for controller, gateway and host
extension (no GC on the safety path), TypeScript for Workers, Durable Objects and Workflows; kube-rs is
not adopted (HTTP/1.1 only, no latency gain); the Rust/Wasm edge Worker stays planned for shared
contracts, not for speed, and needs its `startup_time_ms` measured before it replaces the TypeScript one.

**What the field does.**

| System | Wake from zero | How | Source |
| --- | --- | --- | --- |
| Neon, pool hit | median 568–593 ms, p95 1.06–1.56 s (independent, N=20, same region); vendor "a few hundred ms" | pre-created empty computes, configure on assignment, Postgres start 55–185 ms, proxy retries connects while the control plane works | neon `fa504217` `compute_ctl`, blog cold-starts-just-got-hot (2023-07-25), neon-ga (2024-04-15), serverless-postgres-benchmarks |
| Neon, pool miss | median 6–15 s, tails 45–83 s | Pod/VM creation, init containers | neondatabase/autoscaling #711, #747 |
| Xata (OSS) | mode 1–1.25 s, second mode 10–30 s | pre-created CNPG Cluster claimed from a pool, volume attached by a CSI call, instance manager polls PGDATA every 30 ms; Postgres start 350 ms | xataio/xata `branch-operator/pkg/wakeup`, `services/gateway/metrics/metrics.go` |
| Aurora Serverless v2 | about 15 s | resume | AWS docs |
| PGCF parked (projection) | 1.1–1.2 s | unfence of a resident CNPG instance | measured parts, see step 5 |

The leaders wake in one hop beside the compute and admit on a local fact; PGCF's wake crosses
Cloudflare at least four times and learns readiness through an observation POST (0.25–0.65 s).

**Decisions (work packages, in order).**

| # | Package | Class | Expected effect on the parked wake p50 | Status |
| --- | --- | --- | --- | --- |
| W1 | Controller critical path: `resourceVersion=0` reads, no wait for resize actuation, retried gateway release, one write wave, version memo, barrier read, `system_identifier` in the SQL proof, watch baseline beyond 512 objects, no hot loop while a Pod is created, no 2 s re-reconcile of an awake thin database | controller + gateway release | controller path 0.30 s now (R2.14) to about 0.24 s with 4 dependent rounds (from 43) and no wasted passes | deployed in R2.15 (2026-10-16 06:20Z) and measured live (R2.15 paragraph above; the first retry after a failed pass was the missing piece, fixed for R2.16); tested in the in-process world: a parked wake after a periodic pass is 4 reads + 6 writes in 5 sequential rounds (100 + 19 in 43 on origin/main); the version memo, the barrier publication with the checks left to the pass after the wake, `system_identifier` in the SQL proof, the paged watch baseline, the hot-loop and 2 s re-reconcile fixes, `TCP_NODELAY` and the early dial in the gateway ([status and what to measure](wake-path-v2-and-scale.md#42-w1-controller-critical-path-rust-controller--gateway-release)); needs `watch` rights for seven kinds (`regional-native/rbac.yaml`) |
| W2 | Cut the pull (row or delta on the hint), keep the 60 s pull as repair | API + controller | 0.2–0.35 s | after W1 and the measurement of the pull split |
| W3 | Local admission: gateway holds the client on its own attested fact; observation POST and Actor release leave the critical path; Edge calls the Actor and the gateway in parallel | Edge + API + gateway | 0.3–0.8 s; the largest remaining term | design needs the owner's review of the admission invariant |
| W4 | Placement and hops: `locationHint` for the Actor and RegionLink, D1 region, service bindings instead of public fetches, `TCP_NODELAY`, pipelined PostgreSQL startup in the CLI | API + Edge + gateway | unmeasured; first measure the 0.45 s client-to-Edge term, which the repo's own design table puts at 45–113 ms | measure first |
| W5 | Hot idle tier: stop nothing, `memory.reclaim` into zswap while idle, request shrink in place; first query equals the awake path plus 5–50 ms page-in, no wake at all, 2–4x parked density | Talos host configuration + reclaim consumer | removes the transition for the common case | experiment E1 on EU1 (swap volume, zswap, kubelet `LimitedSwap`), needs a maintenance window |
| W6 | Cold path (hibernated, 9–14 s): `fsGroupChangePolicy: OnRootMismatch`, relax the sidecar's 1 s startup gate, manager binary from an image volume | CNPG/pod spec | 9 s toward 4–6 s (estimate) | experiments on EU1 |
| W8 | Client handshake after the wake: SSLRequest answered locally, startup + first SCRAM message in one flight, optional gateway-side cleartext auth (verifier custody is an owner decision) | CLI, driver, gateway | 0.3–0.5 s on a 100 ms path (laptop p50 2.5 s today, Worker 1.24 s) | to start |
| W9 | Wake predicate after a pure sleep: accept the node proof's volume entry at the newest start generation while every generation since is a power transition that kept Pod and volume (`thin_identity_behind` holds every parked wake right after a sleep for 15–17 s) | API | restores 1.2 s for wakes within a minute of a sleep | deployed 2026-10-16 06:27Z (API `4269151`); no `actor_claim_refused` event in the parked rounds or the cold wake that followed |
| W7 | Thin identity turn: batch the inventory commands, request a turn when a cold start waits for `volume_identity`, let a refused claim wait for the next inventory and log the refusing predicate | NodeBootstrap + API | turn 47 s to 19–29 s (6 sequential relay connections, 22 commands, same report); cold thin wake 44 s to 20.5 s; the rest is the relay's 2–6 s per connection, so the next step is an in-cluster inventory (the controller already scrapes the node) | done and deployed 2026-10-16 (API `d4cff9f`; claim wait and refusal log `actor_claim_refused`, `actor_claim_waited`; turn on demand `thin_storage_turn_requested`; `turn_ms` in `thin_storage_turn_accepted`) ([details](wake-path-v2-and-scale.md#48-w7-thin-identity-turn-nodebootstrap--api)) |

Not built: CRIU/container checkpoint (beta in 1.36, no native restore, no `criu` on Talos), microVM
snapshots (need KVM; Contabo allows nested virtualization only on VDS/dedicated, EUR 39.20/month for
6 vCores), a shared warm pool (deleted; Neon's works only with remote storage, Xata's is a density tool).

**Scale.** Measured per node on 2026-10-16: the host extension polls `GET /agent/v1/nodes/{id}/reclaim`
at 3.0–3.2 requests/s per node for a feature with no state (about 85–90 % of all API requests), a thin
customer node adds thin samples 0.4–0.6/s, lease 0.5–0.8/s, identity proof 0.08/s. Model (10 databases
per node, handler statement counts read from code, D1 service time assumed): 4 customer nodes 24 req/s
and 128 D1 statements/s (21 % busy, 59 % pessimistic), 10 nodes 57 and 315 (52 %), 100 nodes 547 and
3,072 (510 %). First limits in order: one always-on NodeBootstrap container per thin node (about
USD 27–28 per node and month; `max_instances` unchecked), D1 size and the nightly export (a stall of
about 4 s, longer as D1 grows), then D1's single thread near 12–19 nodes.

| Stage | Change | Class | D1 statements/s at 10 / 100 nodes |
| --- | --- | --- | --- |
| today | | | 315 / 3,072 |
| A | hold the reclaim answer 3–4 s, cache the region row, batched usage insert, sampled high-rate logs | API deploy | 140 / 1,371 |
| B | usage in its own store, authority read cache with guarded CAS, retention | API deploy | 58 / 550 |
| C | idle suppression, change-triggered observations, revision-gated desired, batched samples, jitter and backoff | controller release | 36 / 328 |
| D | delete the reclaim poller, lease over a WebSocket, server hints | host extension (expensive) | 34 / 313 |
| E | per-node authority actor with D1 write-behind | API, safety review | n/a / 128 |

Stage A is implemented test-first and merged (deploy pending). A Worker isolate holds
the region's agent row for 5 s, so a rotated key is refused everywhere within that bound. An
unqualified node's reclaim poll is answered from memory after a 3.5 s hold (one request per 3.75 s
instead of 3 to 4 per second; a qualification is never cached). Usage ingestion is one read batch and
one insert batch per request with the hour's limit still exact, a sample reads its node once, and the
lease and accepted-sample lines are written one in thirty per node. D1 statements per request on the
local harness: reclaim poll 2 to 0, a usage request of 25 samples over 10 databases 86 to 27 (77 round
trips to 2), thin sample 13 to 10 (11 round trips to 8), lease 6 to 5. To measure after the deploy:
requests per second per route and node (Workers Logs), D1 `readQueries` and `queryBatchTimeMs` per
second, and `handler_ms` and `d1_update_sql_milliseconds` of `thin_storage_sample_accepted` (now
sampled; filter `write_allowed` true).

Stage D rides on the next host-extension release, because each host release rebinds the thin
qualification receipt and reboots. Its source is written and merged (reclaim poller deleted; lease
intake on its own thread with hedged fetches and latest-wins record writes; tokens naming unassigned
Pods no longer drop the lease; retained scopes retire after 30 leases over 60 s when the device is gone);
per-entry acceptance and un-sticking a stopped Pod are designed, not built (decision: whether a
restarted container of the same sandbox may continue without a new startup hold).

**Laptop path.** The same parked wake takes 1.79–3.16 s (p50 2.5 s) from a laptop through the CLI
proxy against 0.41–0.54 s awake: the server-side wake adds about 1.2 s and the PostgreSQL handshake
after it costs about five client round trips; W8 pipelines it.

**Operations finding.** A fleet rollout pauses thin write authority for the whole region from its start
until every node confirmed: on 2026-10-16 the last accepted sample was 01:07:16Z, the rollout began
01:07:19Z and sampling resumed at convergence (about 01:45Z). With thin databases awake their 10 s
tokens expire and the host guard kills their Pods, so every rollout needs a maintenance window until
authority continuity across patches that change no qualification fact exists. The design is complete (a `continuing` qualification class keyed on facts instead of release labels, 17 failing tests listed, stages shipped together; see [wake-path-v2-and-scale.md](wake-path-v2-and-scale.md) section 7); implementation is next after the identity-turn and claim work.

## After go-live

Not gating go-live; ordered by expected need.

- **Account separation (owner decision):** the Cloudflare account that holds PGCF's D1 and R2 is
  shared with unrelated projects; moving PGCF to its own account, or at least listing and pruning
  every token with D1, R2 or Workers write scope, removes that exposure.
- **Capacity:** EU2 (owner's costed go) for redundancy and capacity; sleeping Thin overbooking,
  which needs an all-write bound beyond `io.max`; node drain, move with kept IDs and decommission.
- **Operations:** alert history, acknowledgement, test send and evaluation of every region;
  backup run history; control-plane self-health; infrastructure metrics history; audit and events;
  restore UX; durable rollout history.
- **Access security:** read-only scope, key expiry, last use and rotation including region agent
  keys, bounded admin minting, the frontend behind Cloudflare Access and an API domain with rate
  limiting.
- **Fleet:** relay-host material reboots, relay transport cost, the
  [region controller](region-controller.md), Flux object selection, Secret rewrite robustness and
  EU control identity labels.
- **Public release:** public Golden image eligibility (anonymous manifest, config, layer and raw
  readback) and installation polish for new operators.
- **Cleanup and decisions:** Cloudflare US resources (keep `ARCHIVE_US` until the US archives
  expire); the OpenEBS exporter patch upstream (owner go, outward-facing); the Thin `discard`
  decision below.
- **Old code (owner rule 2026-10-15: no backwards compatibility, only the newest release and
  protocol):** an inventory against the live fleet (R2.11: route token 3, attestation V1, native
  controller and gateway, TypeScript relay and edge) orders the deletions:
  1. Optional fields, fallbacks and unused tools with no live dependency.
  2. Retire us-dev; its cancelled US1 still posts observations with its agent key.
  3. Route token v2, then v3 and attestation V1 after a release with v4 and a v4 edge.
  4. The TypeScript agent and gateway, then the TypeScript relay and edge once their native
     replacements are released.
  Host-extension items wait for the next unavoidable extension change.

## Restart class

| Changed fact | Required programmed behavior |
| --- | --- |
| Host files | Apply declarations, activate at the supported boot, verify both actual files. |
| Kubelet serving leaf | Refresh the public pin through authenticated identity-bound Talos/Kubernetes; keep strict TLS. |
| Bootstrap taint | Remove only its owned persisted entry for admitted nodes; wait for vendor reconciliation. |
| Boot/Node/cluster identity | Verify fresh boot while retaining Node, cluster, hardware and volume identities. |
| Pool slots / Pod IPs | Respect the region runtime switch, refill only enabled pools, refresh actual routes and observations. |
| Operation deadlines | Preserve original orders/storage and uncertain writes; handle maintenance without expiring valid work. |

## Node acceptance

Six checks per node:

1. Selected Talos/Kubernetes release and Node Ready.
2. Flux/Helm/platform Ready at the selected immutable revision.
3. Fresh actual RAM and inventory in Cloudflare.
4. Real SQL through the database hostname, correct roles/TLS, deletion and physical storage reclamation.
5. R2 base backup, archived WAL and real restore into a separate target.
6. Existing databases and committed markers preserved.

EU has no operator exception. No server purchase is part of the go-live path.

The installation selects actual RAM at 76% over ten fresh consecutive minutes/stable physical
Node UID; threshold and automatic purchasing are API configurable. Eligible nodes remain available
during expansion under hard startup/CPU/storage/PostgreSQL/Barman bounds. There is no 81% cutoff,
personal email default or fixed purchase cap. Historical real ten-minute RAM acceptance is reused;
new workload density still requires measurement.

## Density load test (12 GB node)

Go-live step 7's density and sleeping-CPU-release measurement: EU1 (6 vCPU, owner-upgraded 12 GB
RAM; 11,943 MiB visible after the upgrade) runs
16 × 256 MiB and 1 × 1 GiB thin databases (`sleep_after_seconds` 60) through Cloudflare.

After the configuration-persistence repair, ten consecutive current-boot samples with the retained
database hibernated reported both CPU and RAM. Mean node CPU was 3.23% of six cores and mean
working-set RAM was 8.72% of 11,943 MiB. The node was Ready without MemoryPressure; the RAM
measurement window was valid. These are idle baseline measurements, not density acceptance.

**System reservation.** Both roles reserve 512 Mi system and 512 Mi kube; with the kubelet's 100 Mi
default hard-eviction threshold. Read actual allocatable memory, available memory and platform
requests again before the run; the earlier 8 GB baseline does not establish the upgraded node's
memory-admission bound. The upgraded node reports 5,000m CPU and 10,819 MiB memory allocatable
(`apps/node-bootstrap/src/bootstrap.ts:1364-1376`). Measure platform, non-Pod and kernel memory
alongside database memory. After the run, change the
reserve only if non-Pod plus kernel memory exceeds 1 GiB; add eviction thresholds only if a kernel
OOM precedes kubelet eviction, then with a fleet-patch path, because fleet patches change only the
kubelet image (`apps/node-bootstrap/src/fleet-kubernetes-images.ts:48-62`).

| Per awake database, pool runtime | 256 MiB class | 1 GiB class |
| --- | --- | --- |
| Pod requests / limits: PostgreSQL + Barman + RuntimeClass (`apps/native-controller/src/manifests.rs:73-76,341`, `infra/talos/sandbox/runtime-admission.ts:71-76`) | 450m, 320 MiB / 850m, 832 MiB | 700m, 320 MiB / 1,100m, 1,600 MiB |
| API CPU charge / start RAM hold (`apps/api/src/domain/startup-admission.ts:34-97,126-143`) | 450m / 832 MiB | 700m / 1,600 MiB |
| `shared_buffers` / one volume for data and WAL (`apps/native-controller/src/manifests.rs:77-82,341`) | 32 MB / 1 GiB | 32 MB / 5 GiB |

A confirmed hibernated database has no Pod, charge or RAM. All 17 awake need 7,900m against
5,000m minus platform requests P. The first post-upgrade observation has P = 650m, giving CPU
upper bounds of nine 256 MiB databases or one 1 GiB plus eight 256 MiB databases; read P again
before the run. Total memory requests are 5,440 MiB and limits are 14,912 MiB;
calculate the memory-start bound from fresh available memory and the class start holds.
This run proves density on the upgraded 12 GB node.

| Scenario | Action | Expected from code |
| --- | --- | --- |
| S1 Create | 17 creates at once | K placed, the rest `Waiting for verified regional capacity` until others sleep; immediate base backups |
| S2 Awake limit | Wake one by one, each kept awake by a periodic query | Capacity 57P03 (no new wake operation) right after K; no Pending Pod |
| S3 Sleep | Stop the queries | Hibernation after 60 s idle and an archived WAL segment; charge 0; a refused wake is then admitted |
| S4 Wake storm | All asleep, one connection each at one instant | K admitted (at most one `prestarted`), the rest immediate 57P03; `connect_ms`/`first_read_ms` labelled |
| S5 Load | K databases, read-mostly pgbench plus a ledger writer, ten complete minutes | RAM/CPU per container and node; warning episodes only when their windows cross |
| S6 Overcommit | An 18th create; one session exceeds a 256 MiB limit; with the owner's go a bounded memory hog to MemoryPressure | Create waits; container OOM and crash recovery; no start under pressure |

**Passes when** K, sleep release and storm admission match the code; every acknowledged commit and
marker survives without replay and a restore shows them; no platform Pod is evicted, OOM-killed or
restarted; nothing is bought; databases, thin volumes and policy return to baseline. **Stop on** a
platform Pod eviction, OOM or restart; MemoryPressure outside S6; EU1 NotReady; two missing minute
samples; a node addition; a volume at 80 % or thin data at its reserve; a data-safety violation; a
retained database changing state; overlap with thin qualification, a rollout or the 03:00 backups.

**Prerequisites.** Go-live steps 2–6; retained databases suspended; `autoscale_enabled` false, no
held node addition, purchases off. The run follows the parked tier, which changes P and idle RAM.

## Thin storage qualification gates

A receipt (`thin_storage_qualification` in an approved fleet release) states that all seven gates
passed for one complete thin profile hash, `openebs-lvm` driver image, `pgcf-sandbox-controller`
host extension image and exact `nodeInfo.kernelVersion` string. Activation compares exactly these
values, so a change to any of them needs a new run. The receipt comes only from a completed
`POST /v1/nodes/{id}/thin-qualifications` run (ThinQualification Workflow): release approval
refuses any other receipt, and gate flags typed into a release are not a qualification. Run 14
completed all seven gates on EU1 and produced the release-bound receipt.

The run is scratch-first on EU1 after R2: it creates `pgcf_thinpool` with the product command and
the exact profile geometry from free extents, uses a fenced deny-all namespace with a quota, scratch
volumes and a PostgreSQL Pod from the release's `postgres` pin, then deletes its volumes and pool.
It creates no node thin selection, because a selection cannot be undone. It records the node
identity at setup and the measured evidence of every gate; Cloudflare computes each pass decision
from that evidence. Preconditions: R2 accepted with the EU pool switch on. The run needs a release
that pins the thin guard, as R2 does; such a release configures and requires `dm_thin_pool` on
every role, so R2's own patch loads the module on EU1 and control without a receipt. A
receipt-bearing release requires thin write authority only from members that take databases or
already have a selection, so control/relay converges without a pool.

The [qualification runbook](../operations/recovery.md#thin-storage-qualification-run) is the single
definition of the complete preconditions, the procedure and the pass criteria computed by code.

| Gate | Proves |
| --- | --- |
| `data_full` | A full data pool fails writes fast and recovers by growth without losing commits. |
| `metadata_full` | Metadata never runs out before data, and metadata exhaustion fails closed. |
| `noflush_quiescence` | A noflush suspend freezes writers, also on a full pool, and resume drains within budget. |
| `resume_marker` | Resuming the exact volume keeps committed data and drops uncommitted work. |
| `startup_bound` | A cold start (initdb plus bulk load) stays inside the profile's startup and IO bounds. |
| `trim_delete_recreate` | Deleting a volume returns its extents, and a recreated volume starts clean. |
| `retained_thick_preservation` | Thin work leaves retained thick volumes and databases with the same identities, readiness and WAL archiving. |

The thin class sets no filesystem `discard` option, so the run qualifies extent return only on
volume deletion, not for deletes inside a running filesystem; requiring them is an open owner
decision.

Keep Done to one row per completed step, at most one measurement line and roughly 15 lines.
Record only final customer-readiness results here; detailed hashes, bytes and intermediate
corrections remain in Git history and protected receipts. Runbooks are English and API-only.
[Runtime design](rust-runtime-and-cold-starts.md) and [operations](../operations) supply procedures.
