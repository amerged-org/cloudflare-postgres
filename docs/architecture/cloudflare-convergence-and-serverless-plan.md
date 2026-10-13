# ULTRA — customer-ready PostgreSQL

Canonical scope and status. The owner decision of **11 October 2026** makes the fleet EU-only and
supersedes the earlier execution order, including the 03:30 Europe/Amsterdam coaching of the same
day. Customer migration is not yet authorized.

## Fixed scope

Cloudflare is the global control plane: it owns configuration, placement, progress, releases and
provider actions for every region. The fleet is **EU control** (relay host, no customer databases)
and **customer EU1**. Preserve both servers, existing data and keys; no EU reinstall. The US region
is cancelled at Contabo (contract ends 2026-11-04); US1 was marked lost on 2026-10-11 and is no longer patched.
US and Oceania return later from the same region configuration. Automatic EU purchases stay
enabled under the configured policy; US purchases are off.

**R1-final is frozen:** the qualified Golden image containing the sandbox DNS/hostname fix,
Talos 1.14.2 and Kubernetes 1.36.5. Its installer and raw image are privately distributed and
fully verified. Further Golden changes require an observed boot or data blocker; other work
belongs to R2. Runtime/platform references are immutable release inputs from the verified lock.
R1.1 is the fleet release that carries these frozen bytes.

**R1 uses standard PostgreSQL runtime.** A region API switch selects the pool runtime; it stays
off for R1 acceptance and turns on for EU with R2. The shared prestarted pool, Rust runtime and
measured first SQL below one second remain mandatory **before migration**. Pool tests must not
block the standard-runtime fleet acceptance.

**New nodes require thin storage**; there is no thick fallback for them. Retained thick volumes
keep their backend and data. Thin activation needs a release-bound receipt from the
[qualification gates](#thin-storage-qualification-gates).

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
- **Current constraints.** `AddNode` refuses before any provider order until the region selects a
  thin-qualified release with matching `compute_pool` and `thin_storage` templates, so every new
  node waits for R2b. Its outside network proof scans from a Ready, uncancelled node in another
  Contabo region; while EU is the only region, an EU addition has no automatic scan source and
  needs the manual network-proof path. EU also lacks its write-once installation profile, which an
  EU addition needs before it can install. The purchase itself checks neither, so an automatic EU
  order after R2b would buy a server that waits for both.

## Done

| Completed step | Measurement / boundary |
| --- | --- |
| Generic API controls | RAM threshold and purchase switches accepted live; fresh installations buy/send nothing. |
| Credential retirement | US authority and route signer checked; current US custody metadata retains the same keys. EU replacement is prepared. |
| Daily infrastructure backup | D1 and both etcd artifacts fully verified in R2; successful run 232.7 s. Email remains operator-configured. |
| EU read-only preparation | 279 role documents validated; isolated role boot passed in 125.7 s; direct rescue/config/snapshot custody ready. |
| US technical release | Ready at 21:35 UTC via Cloudflare; later operator repairs are counted separately. US database acceptance is no longer pursued. |
| Corrected sandbox runtime qualification | AMD64 proof passed: pool claims 10.4/11.5 ms. These are runtime timings, not first-SQL results. |
| Frozen R1-final image | One installer/raw composition: 11.5/28.0 s. Five private immutable objects fully read back; public eligibility remains open. |
| Observed-error class corrections | Generation, host-file activation, Kubelet pin, persistent taint and safe held-target replacement tested; qualified/current delivery varies below. |
| Batch A deploy | API and NodeBootstrap from `1de03f2` deployed; successors drop lost members and `operator_hold_` holds. |
| US1 retired | Marked lost at 12:01 UTC on 2026-10-11; one pending US test database record remains for the Cloudflare US cleanup. |
| EU hold release | EU-only R1.2 successor `op_3ts0qw8s0tey6u7wvdkn` started the rotation; snapshot through discovery-secret confirmed, after list-kind and binding-order fixes found live. |
| EU rotation | Material revision 2 active at 23:32 UTC on 2026-10-11, 21 s after a fresh verification; revision 3 records Talos 1.14.2 / Kubernetes 1.36.5. Both encryption rewrites (50 Secrets each) and the paged ciphertext proof passed; retired authority is rejected. |
| EU1 | R1.2 converged (Talos 1.14.2, Kubernetes 1.36.5) without operator intervention; Flux turns take about 3 min after read batching instead of exceeding the 600 s turn. |
| Control | R1.2 converged; the relay answered 5 min after the etcd-CA reboot and 4 min after each host-service reboot; the operator-published kubelet trust map was adopted through code. |
| EU acceptance | New database ready in 30.7 s, SQL through Cloudflare 0.57 s (PostgreSQL 18.6), base backup and 3 WAL files in R2 after 20.7 s, delete and storage reclaim 93.3 s; existing databases answered in 0.69–0.93 s; RAM window valid on both nodes. |
| Cold-start baseline | Standard runtime on EU1 (R1.2): first SQL after wake 9.6–11.2 s through Cloudflare; connect → database Pod Ready 4.9–6.6 s; Pod Ready → admission 4–5 s (agent cadence, role and archive probes, fence, observation, Actor D1 poll). |
| Sandbox proof storage-expiry stop | The proof raised the material revision before the guard held the new lease, so the guard refused it and nothing stopped; it now waits for the guard (`5314d95`). The other failures of 2026-10-11 are a separate shim transport defect. |
| Thin qualification | Run 14 passed all seven gates on EU1 and produced the receipt; normal cleanup restored exactly **97,706,311,680 free bytes**. `data_full` grew 16→24 GiB with the same pool UUID, preserved all 4,160 acknowledged commits and restarted PostgreSQL in 5,137 ms. With option 1 sampling every 2 s, `startup_bound` had 2 accepted samples, scrape p99 119 ms and maximum accepted gap 3,574 ms < 5,000 ms; `noflush_quiescence` had 8 samples, p99 134 ms and maximum gap 2,737 ms. Both windows had complete native coverage and zero unknown samples; the identity cycle took 32,092 ms < 60,000 ms. Noflush froze 567,283,712 dirty bytes with zero new sectors or blocks, drained in 4,700 ms and passed fsck with exit 0. |

## Open

One row per step, in dependency order. A step moves to Done only with its measured result.

| Step | Status | Finished when |
| --- | --- | --- |
| Cloudflare US cleanup | Open | The pending US test database record is removed; US Tunnel, VPC binding, firewall/rescue entries and tokens removed; `ARCHIVE_US` kept until retained US archives expire. |
| Terminal Pods after reboots | Fixed in code | R1.2 carries the fixed regional agent, and after its reboot EU1 databases wake, suspend and delete. Failed or Succeeded Pods left by a reboot made these power transitions fail. |
| CNPG in-place restart | Fixed in code | The pool runtime switch yields a primary Pod with the selected RuntimeClass, and the EU rotation's consumer renewal yields new database Pods. CNPG's default restart method applies `kubectl.kubernetes.io/restartedAt` inside the running Pod, but both need a new Pod. NodeBootstrap carries the fix before the EU rotation; the native controller carries it with R2. |
| Notifier | Open: the owner provides a Resend API key (Worker secret `RESEND_API_KEY`), a sender on a Resend-verified domain and a recipient. The OpenAPI document describes email, thresholds and alert status. Alerts evaluate at most four regions; a config PUT fails a running backup. | RAM, CPU and storage warning thresholds are delivered; one real alarm arrives after the owner sets recipient and sender through the API. CPU values arrive only from R2's native controller. |
| R2 | In progress: R2.1 (`65350a4`: CA roots, list TypeMeta), R2.2 (`dc635b2`: OpenEBS node affinity) and R2.3 (controller `d8aa83b`, gateway `fea5fc6`, route token v3) converged on EU1 and control; the Edge signs v3 since 2026-10-12 16:10Z. R2.4 (`r2.4-ultra-fb5b8ed`: controller and gateway `fb5b8ed`, no thin receipt) rolled out with `op_cbf4t1p9g1hnwftapbk2` (complete 21:24Z; checks 1–3 and 6 pass, the retained database keeps 8 base backups and 95 WAL files in R2, check 4 waits for the thin decision); once its controller ran on EU1 (20:45Z) the retained database's outbox drained and it slept again after 60 s idle (20:46Z). Found live on the way: the measurement checkpoint identity compared raw strings (fixed `ef83c96`), and late usage samples for finalized hours got 409 forever, wedging the outbox and retrying every 250 ms (fixed `eb4b98f`; the API acknowledges them as refused). | The controller from `eb4b98f` converges on EU1 and control, six checks pass, and a woken database sleeps after `sleep_after_seconds`. |
| Pool cold-start test | Open | A sleeping database's pool-hit first SQL is measured from one start (<1 s target, unproven), data is preserved and refill is observed; a miss is labelled a miss. |
| Thin authority renewal | In progress: owner-approved option 1. Capability gating, composed authority, inventory/protection fences, retry cadence and the native fast loop are deployed in Dev; R2.6 converged on EU1 and control, and run 14 passed qualification. Live acceptance in section 11 of the [proposal](thin-authority-renewal.md) remains pending and requires R2b activation. Purchases, autoscaling and placement remain disabled; the retained database stays suspended/hibernated at generation 32. | R2b is active and all live acceptance checks in section 11 of the [proposal](thin-authority-renewal.md) pass. |
| R2b | In progress: the receipt-bearing successor is approved and the region thin template is configured. The approved EU1 selection is set with `allow_new_databases:false`. The ordinary Fleet patch has now confirmed the upgraded node and persisted configuration through a controlled reboot. A guarded disabled-selection retry was accepted, but pool initialization remains undispatched while the initializer refusal is diagnosed. Activation enables live authority-renewal acceptance. Requalification after R2b (runbook: recovery.md): the control node's volume group `pgcf` has 98,300 MiB free and no LVs, enough for a run (about 82 GiB); default path is a qualification run on the control node, which the code refuses today and must allow before the first release after R2b that changes the Talos kernel, `openebs-lvm` or `pgcf-sandbox-controller` (such as the sandbox shim fix `2d595a8`); the owner may choose otherwise. | An R2 successor carries the receipt; EU `thin_storage` template and EU1 thin selection are active; thin create, backup, restore and delete pass; density and sleeping CPU release are measured. |
| Density load test (12 GB node) | Open: owner-confirmed EU1 RAM upgrade to 12 GB; the same 17-database workload runs after Thin qualification and R2b. Needs `ef83c96` delivered, retained databases suspended, `autoscale_enabled` false, no held node addition and purchases off; storm latency after Wake orchestration; repeated once after the warm pool ([definition](#density-load-test-12-gb-node)) | On EU1, 16 × 256 MiB and 1 × 1 GiB thin databases are created, sleep and wake through Cloudflare; the observed awake limit equals the CPU-admission arithmetic, excess starts get 57P03 or wait unplaced, and no database Pod stays Pending; sleeping CPU release, per-database and node RAM/CPU idle and under load, non-Pod memory and one 256 MiB OOM recovery are measured; no acknowledged commit is lost or replayed, no platform Pod is evicted, nothing is bought; storage is reclaimed and the kubelet reservation is confirmed or changed. |
| Daily infrastructure backup | In progress: 2026-10-11 failed (US snapshot source, since fixed) and 2026-10-12 failed because two fleet-patch containers held both NodeBootstrap instances. `max_instances` is 8 and failed days now retry up to three times. 2026-10-13 completed on attempt 1 in 148.3 s (D1 413 MB, EU etcd 59 MB); a same-day retry after a failure is not yet shown. | The next run completes D1 and EU etcd, and a forced failure retries the same day. |
| Lost-node patch closure | Open | Marking a node lost closes its unfinished patch operations, so they no longer block its region's patch, rollout and placement guards. |
| Relay-host material reboots | Open | Version-metadata material synchronization does not reboot the relay host again when its host files are unchanged (revision 3 caused a second host-service reboot). |
| Relay transport cost | In progress | Every relay connection needs its own 2–6.6 s single-use transport; transports are issued in batches so long stages stay inside the 600 s turn by design. |
| NodeBootstrap turn delivery | Fixed in code (`525b316`): turns are registered with 202 and followed by the container's own record; run 11 ran 13 turns without a lease wait. A lost request has not recurred since. | A Durable Object's request to its NodeBootstrap container that is lost before the container accepts it no longer holds the turn until its timeout: thin qualification run 9 lost 11 minutes on a held lease and the R2.4 control patch 13 minutes in `runtime_admission` (2026-10-12). |
| Region controller | Design ([proposal](region-controller.md)) | Customer worker patches run on the control server against local Talos and Kubernetes APIs with checkpoints in Cloudflare; the relay path stays for AddNode, the control server itself and material rotation. |
| Fleet inventory API | In progress: node inventory source is complete. The bounded admin list and individual node/region reads expose roles, fenced observed Talos/Kubernetes and controller artifact versions, release state and the current Node UID's latest patch. Stale observations are labeled; unbound observations remain unknown. API delivery and live validation are pending. Release, rollout and patch history lists remain open. | One call lists every node with region, role, Talos/Kubernetes versions, release state and latest patch; releases, rollouts and patch operations can be listed; `GET /v1/nodes/{id}` and `GET /v1/regions/{id}` exist; the agent version is stored and shown. |
| Database placement and filters | In progress: nullable `node_id` responses and conjunctive region, node, desired-state and public observed-state filters are implemented; project scope, pagination and deleted-record exclusion are preserved. Live validation awaits API delivery. The strict SDK and API must use the matching contract revision. | Database lists filter by region, node and state and show the node; the node-to-database mapping is readable. |
| Infrastructure metrics history | Open | Node RAM, CPU and disk time series are readable (node samples live 12 min and only current values are returned). Per-database usage already has hourly/daily history; measured CPU and RAM per database are added. |
| Node lifecycle | Open | A node can be drained, its databases moved with their IDs kept, and decommissioned with the provider instance cancelled and its slot freed; today only placement close and mark-lost exist, and restore creates a new ID. |
| Audit, events and operations | Open | Admin mutations record the acting key; long-running operations can be listed through one shape; state changes can be consumed without per-resource polling. |
| Access security | Open | A read-only scope exists; keys expire, show last use and rotate, region agent keys included; admin key minting is bounded; the frontend runs behind Cloudflare Access with a proxy Worker that holds the key (the API has no CORS); the API has its own domain with rate limiting. |
| OpenAPI completeness | Open | All /v1 operations have summaries (79 of 103 lack them), operationIds and accurate headers and errors; `/agent` and `/internal` are published separately; `info.version` is real. |
| Alert operations | Open | Alerts keep history and node details, can be acknowledged, cover database archiving and disk, show their delivery configuration and offer a test send; every region is evaluated (today the first four policy regions, which also limits capacity retries and autoscale). |
| Infrastructure backup operations | Open | Run history is readable, a failed run can be retried the same day, and changing the alert email no longer fails a running backup. |
| Control-plane self-health | Open | The minute cron stores and exposes each step's outcome; one failing region or step no longer stops the steps after it unnoticed. |
| Restore UX | Open | Backups and the restorable time window are listable, deleted databases can be found and restore refusals are explicit. |
| EU2+ prerequisites | Open | EU installation profile, a network-proof source while EU is the only Contabo region, and the thin receipt (R2b) exist; AddNode installs EU2 from the Golden image and patches it to EU1's level. |
| Sub-second decision | Owner direction 2026-10-12: prestarted PostgreSQL in warm Pods, X per node, a database bound on connect and detached after `sleep_after_seconds` (60–900 s for 1–15 min). The [warm pool proposal](warm-postgres-pool.md) recommends PGCF-supervised PostgreSQL in pre-created pool Pods (alternative 8), the only design that removes Pod creation from a wake. Gate 0 assessment: a pool hit removes Pod creation through Pod Ready (about 6 s); the remaining orchestration after PostgreSQL is ready (1.2–2.2 s today), the pool Pod's PostgreSQL start and the 0.5–0.6 s awake path must together stay under 1 s, so 1–2 s is the realistic first result and under 1 s is not structurally excluded. | The design for archiving, backups, single writer, TLS custody and network identity is written and accepted. |
| Wake orchestration | Delivered 2026-10-12: Actor push and route token target (API `fea5fc6`, migration 0045), immediate controller publication (controller `d8aa83b`), v3 route verification and direct dial (gateway `fea5fc6`), v3 signing (Edge version `bfc0ab53`). Measured by Wake stage measurement. Measured 2026-10-12 (Gate 0, retained 1 GiB database, 3 wakes): Pod Ready → Edge admission complete 1.2–2.2 s, down from 4–5 s; connect → Pod created 0.08–0.83 s. | Pod Ready → admission falls well below the measured 4–5 s through immediate controller publication, Actor push instead of the 250 ms D1 poll and direct gateway routing. |
| Wake stage measurement | Measured 2026-10-12 through Cloudflare from a laptop, v3 routes, gateway stage log (`fb5b8ed`). Cold wake of the retained database (Gate 0, 3 rounds, marker complete): first row 8.1–9.4 s (was 9.6–11.2 s); Pod created 0.08–0.83 s, PodReadyToStartContainers +1.0 s (sandbox, CNI, volume and fsGroup), init container 2.0–2.2 s, barman sidecar 2.8–3.2 s, postgres first log 4.0–5.2 s, PostgreSQL ready 4.7–6.0 s with pg_control `shut down`, Pod Ready 6.1–6.8 s, Edge admission complete 7.8–9.0 s, first server message +0.2–0.4 s, SCRAM and query +0.1 s. Awake path: first row 0.47–0.96 s (warm rounds 0.54–0.61 s); client → Edge 45–113 ms, Edge admission including the Actor and the Tunnel WebSocket 117–217 ms, gateway accept → StartupMessage 24–101 ms, PostgreSQL dial 3–12 ms, first backend byte 0–2 ms, round trip 23–43 ms. The rest of the 177–313 ms between admission and the first server message lies in Cloudflare between the Edge's 101 and the client's first bytes. | Every wake stage from connect to first row is measured in milliseconds on EU1, including the `fsGroup` change time, the pg_control state and the split of the 0.69–0.93 s awake path. |
| Sandbox shim transport | Fixed in code | The CI proof passes on main without the early `shim_request_failed` of runs of `e7a4503`, `ac2cacc` and `fea5fc6` (attempt 1). A shim that received `Shutdown` removes its socket before it exits (2–1027 ms later here) and may exit before it replies; `Slot::destroy` reported that ENOENT, ECONNRESET or EOF as a failed release. The proof's refused claim sends one `Shutdown` and its CRI `Shutdown` a second; under build load a pool retirement's only `Shutdown` lost its reply. Destroy now waits up to 3 s for the exact shim exit through its pidfd and returns the request error only while the shim stays alive. Local arm64 proof: unchanged, 8 of 18 runs failed with the byte-identical CI log; fixed, 14 of 14 passed, 4 of them under build load. |
| Flux object selection | Open | Fleet patches install only the selected Flux components, without image-automation or source-watcher objects whose controllers are not installed. |
| Secret rewrite robustness | Open | A Secret created, changed or deleted during the encryption phases no longer stalls the rotation. |
| EU control identity labels | Open | EU control's Node carries `pgcf.io/region` through its machine configuration, and the retained-node tolerance for the missing label is removed. |
| Handover | Open | Client adapter, timeout policy, restore/new ID mapping, capacity and recovery are documented. Neon migration is a separate task. |

## Restart class — one pre-EU gate

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
4. Real SQL through `db.ohmyho.st`, correct roles/TLS, deletion and physical storage reclamation.
5. R2 base backup, archived WAL and real restore into a separate target.
6. Existing databases and committed markers preserved.

US intervention accounting retains three historical OS actions, one later operator configuration
apply, public-pin/inventory repairs, one create retry and qualified consumer cycles. A programmed
activation reboot is separate. Do not claim fully automatic US acceptance from those results.
EU has no operator exception. No new server purchase is part of this corrective rollout.

The installation selects actual RAM at 76% over ten fresh consecutive minutes/stable physical
Node UID; threshold and automatic purchasing are API configurable. Eligible nodes remain available
during expansion under hard startup/CPU/storage/PostgreSQL/Barman bounds. There is no 81% cutoff,
personal email default or fixed purchase cap. Historical real ten-minute RAM acceptance is reused;
new workload density still requires measurement.

## Density load test (12 GB node)

R2b's density and sleeping-CPU-release measurement: EU1 (6 vCPU, owner-upgraded 12 GB RAM;
11,943 MiB visible after the upgrade) runs
16 × 256 MiB and 1 × 1 GiB thin databases (`sleep_after_seconds` 60) through Cloudflare.

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

**Prerequisites.** Thin qualification finished (it forbids creates in the region); R2b active,
because the native gateway refuses databases without thin authority
(`apps/native-gateway/src/targets.rs:336-340`); `ef83c96` delivered, else a woken retained database
never sleeps; retained databases suspended; `autoscale_enabled` false, no held node addition,
purchases off. Storm latency follows Wake orchestration; repeat once after the
warm pool, which changes P and idle RAM.

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
