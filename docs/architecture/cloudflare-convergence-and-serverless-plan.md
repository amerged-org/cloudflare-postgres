# Unified Cloudflare control, fleet releases and serverless capacity

Status: **implementation and full live acceptance remain open**. Owner direction: 2026-10-08.

This is the corrective implementation plan for the complete PGCF product, not another declaration
of completion. [PLAN.md](../../PLAN.md) remains the canonical scope/status record. The prior
operator-assisted US admission and database lifecycle results remain valid, but do not prove
automatic installation, uniform configuration, fleet patching or the approved fast-start design.

This plan supersedes the earlier deferral of EU alignment, permanent sleeping CPU reservations,
blanket logical-volume reservations, and the reservation-preserving clauses in the Rust proposal.
It specifies work; it does not report that this work is already deployed. No VPS purchase,
reinstallation, live policy change or customer migration is performed by writing this plan.

## 1. Required outcome

All three retained servers follow one approved, immutable software release and the same resource
policy semantics. Cloudflare owns desired state, policy changes, rollout progress and observations.
The existing EU control/relay server keeps that role and remains excluded from customer placement.
Customer EU1 and US1 retain their data and identities. Different roles are explicit parameters of
the same release; they are not permission to run unrelated fixes or resource rules.

PGCF owns the customer-resource configuration and its application through its authenticated
management API hosted on Cloudflare. Management is API-only. A PGCF administration UI or dashboard
is out of scope; configuration, status and operation control are exposed through the API.
OMH selects entitlements and consumes PGCF; it must not implement a second placement, resource,
backup, patch or VPS-provisioning controller.

Ordinary expansion uses at least76% actual physical RAM averaged over ten fresh consecutive minute
buckets of the same physical Node UID. Existing suitable nodes remain eligible while another node
is provisioned. There is no81% placement stop. The owner has granted V159 purchase authority;
PGCF must persist and execute that authority with its actual configured finite limits.

The CPU and disk models must support many small or hibernated databases. A logical customer limit
is not a permanently consumed allocation. Actual live work, simultaneous starts, persistent data
and necessary system headroom still count. No implementation may make capacity appear free by
discarding measurements, treating unknown state as zero or deleting persistent data.

Uniform programmed patch management and the Rust/fast-start architecture with a mandatory shared
pool of prestarted unassigned computes are part of the completion scope. Per-database warm reclaim
is an additional mode and cannot substitute for that pool. The subsequent Neon customer cutover remains a separate operation.

## 2. What is proved, what is not

Evidence base: source commit8af3ab5; retained EU/US inventories from October7/8; actual D1 policy
and size-class reads; accepted Regional115 release; existing live SQL/backup/recovery receipts.
Inventory dates matter: refresh the full fleet observation once before implementation; do not
describe a historical inventory as a continuously enforced current release.

Proved: US1 Ready through an operator fallback; normal Cloudflare SQL/TLS and nonsuperuser roles
in EU and US; R2 base/WAL checks; healthy-source cross-region restore; four5GiB test-volume deletions
with20GiB physical reclamation; an actual79.9062% ten-minute RAM window and continued eligible
placement. The expansion decision in that test was disabled. Existing EU data was preserved.

Not proved: autonomous threshold-to-purchase-to-Ready completion; identical fleet software/policy;
central profile changes converging across assigned databases; no-static-allocation density;
programmed day-two patching; the Rust/shared-prestarted-compute-pool design and additional warm
reclaim; safe first customer migration after
credential rotation. None of these can be inferred from the successful database lifecycle tests.

## 3. Observed fleet differences

| Layer | EU control/relay and EU1 | US1 | Required correction |
| --- | --- | --- | --- |
| Talos runtime | 1.14.1, kernel6.18.51-talos, containerd2.3.5 | Same reported versions | Verify immutable artifact/schematic/extensions, not only version text |
| Installer provenance | Control uses a tag; customer EU1 digest d1d2fb… | Digest cd4cb8… | One release declares exact supported installer artifacts and role/platform parameters |
| Kubernetes | 1.36.3 | 1.36.5 | Supported, data-preserving convergence of both clusters |
| Flux source/kustomize | 1.9.5/1.9.5 | 1.9.6/1.9.6 | Same approved component versions/digests |
| Flux helm | 1.6.4 | 1.6.5 | Same approved version/digest |
| Flux component set | No image-automation/image-reflector/source-watcher in retained inventory | Those three additional controllers installed | Declare a justified common/role-specific set; remove accidental extras |
| Regional runtime | Source901b3228, digest eeaa6a… | Source11555215, digest1886a6… | Converge the accepted fix before enabling equivalent policy in EU |
| Checked-in Regional baseline | Git pins14191e… | Neither live regional runtime matches that pin | Eliminate the third baseline and independent overlay drift |
| RAM policy | reserved | actual_ram, request128MiB, maximum4096MiB | Same centrally declared customer policy and supported conversion |
| Customer-node platform CPU requests | EU1 worker350m; control1110m | Combined control/platform/customer node1510m | Explain role cost, measure actual consumption, remove unnecessary footprint |
| PostgreSQL | SQL18.6; retained configured/runtime evidence | SQL18.6; configured pin matches, separate runtime imageID was not retained | Record actual imageID for each workload; missing evidence is not proof of different bytes |

Cilium1.20.2, CNPG operator1.30.1, Barman0.15.1, cert-manager1.21.2, OpenEBS4.6.1/LVM1.10.1,
cloudflared2026.10.0 and Flux notification1.9.4 match in the retained evidence. Do not report
everything as different. Full observed digests are in the
[operator runbook](../operations/operator-installation.md#accepted-euus-checks-and-observed-software).

“All three uniform” means identical approved versions/digests for each shared component, explicit
role composition and the same customer-facing semantics. IP/MAC, region, node/cluster UID, host
keys, certificates and customer data must remain distinct. Copying entire initialized disks or
cluster credentials to obtain byte equality would violate isolation and destroy identity.

The current topology explains some overhead: EU1 is a worker behind the retained EU control node;
US1 also hosts its regional control plane. It does not justify different RAM rules or an older
Regional implementation. Three existing servers also do not constitute replicated HA: one local
database volume and a single regional control-plane node can experience maintenance downtime.

## 4. Findings and consequences

| ID | Priority | Proven problem / gap | Why it fails the intended product | Primary source |
| --- | --- | --- | --- | --- |
| F01 | P0 | Overall completion was inferred from narrower operator/database acceptance | Operator intervention and remaining planned requirements were hidden by the completion claim | PLAN opening status and operator runbook |
| F02 | P0 | EU/US/Git have three Regional baselines; Kubernetes/Flux differ | A fresh install and two regions do not reproduce the same behavior or fixes | infra/platform/regional/kustomization.yaml; runbook inventory |
| F03 | P0 | EU still uses reserved RAM; US actual RAM | Same customer setting means different admission behavior by region | node_region_policies; domain/desired.ts |
| F04 | P0 | No configured256MiB class; smallest enabled test class is512MiB/250m/5GiB | Schema support is not an accepted Free256 product | Live size_classes; contracts/api.ts |
| F05 | P0 | CPU request and limit share one class value | No independently tuned small scheduling share and bounded burst ceiling | contracts/api.ts; regional agent builders |
| F06 | P0 | All undeleted DBs consume full class CPU plus100m Barman in admission, even with no Pod | Hibernation frees physical compute but not placement capacity; idle tenants can block signups and cause unnecessary purchases | domain/placement.ts; databases.ts; node-capacity.ts |
| F07 | P0 | Wake admission assumes that permanent CPU reservation; only RAM has temporary startup holds | Deleting the sleeping CPU sum alone creates simultaneous-wake races | domain/startup-admission.ts; lifecycle.ts |
| F08 | P0 | StorageClass uses thick LVM; all quotas are summed against capacity | An empty5GiB DB physically allocates5GiB; “actual usage” cannot be implemented by removing a D1 SUM | base/storageclass.yaml; builder; placement.ts |
| F09 | P1 | Actual usedBytes exists for reporting, not physical-pool admission; API rejects storage-changing resize | No complete usage-driven capacity/growth path | regional/agent/measurements.ts; databases.ts |
| F10 | P1 | Lab disk recipe assigns40GiB EPHEMERAL and96GiB LVM, yielding95GiB usable capacity | 150GiB NVMe does not mean150GiB available for DBs; current geometry needs explicit justification | infra/talos/single-disk-lab-storage.patch.yaml |
| F11 | P0 | Referenced size classes are immutable; no revisioned profile rollout | Existing API supports configuration, but cannot edit one shared customer policy and converge all assigned DBs | platform/size-classes.ts; routes/platform.ts |
| F12 | P1 | Barman is separate per-instance overhead:128MiB request/512MiB limit,100m/500m CPU | “256MiB database” is currently a PostgreSQL limit, not the total stack footprint | contracts/sizing.ts |
| F13 | P1 | Common128MiB request produces32MB shared_buffers even for a4096MiB class | The webhook fix is correct for startup validation, but not a demonstrated optimal Paid policy | contracts/sizing.ts; readiness.ts |
| F14 | P0 | autoscale disabled; standing profile absent; US node cap1 | Existing human purchase permission has not been turned into executable fleet policy | capacity policy; node-state.ts |
| F15 | P0 | Pending unplaceable DB may trigger an order below76% through CPU/storage fallback | The actual purchase condition differs from the agreed ordinary RAM trigger | domain/node-capacity.ts |
| F16 | P1 | Stored price/cap arithmetic lacks a provider-enforced maximum-price field or live quote check in dispatch | Configured estimates must not be represented as verified current invoice caps | workflows/add-node.ts; domain/costs.ts |
| F17 | P0 | Automatic postjoin returned409/session turnover; operator path completed Ready | End-to-end agent-free provisioning is not accepted; exact first409 cause remains unresolved | PLAN live evidence; node-proof-artifacts.ts |
| F18 | P1 | Layered proof budgets540s/120s versus separate1800s storage budget; operation timeout20min | Slow progress can expire authority or a create operation; blindly increasing each timeout is not a design | node-proof-session.ts; cron.ts |
| F19 | P0 | Region URL accepted without required/pg; no supported region update endpoint | One-off D1 configuration repair was required for ordinary routing | platform/regions.ts; edge/gateway.ts |
| F20 | P0 | Cross-region source-read credentials installed manually in Kubernetes | A fresh region cannot reproduce recovery solely from Cloudflare desired configuration | operations/credentials.md |
| F21 | P0 | Fleet patching is only specified; bootstrap-material endpoint changes version metadata | Publishing an image does not upgrade existing servers or prevent drift | PLAN patch section; region-material-revisions.ts |
| F22 | P0 | Rust runtime, target cache, complete Actor snapshot and warm reclaim are unimplemented | The approved fast-start architecture is absent, not merely untuned | rust-runtime-and-cold-starts.md; current TS apps |
| F23 | P1 | Current wake waits behind full-region reconcile/inventory; timing names mix connect and first read | Latency comparison is misleading and the hot path includes unrelated work | agent/loop.ts; e2e/probe/worker.ts |
| F24 | P0 | Exposed revision1 authority remains; coordinated rotation is incomplete | No customer data should be admitted while known retired authority still works | operations/credentials.md |
| F25 | P1 | Qualified layers/Gitleaks are presented too broadly as security/patch assurance | No full CVE/SBOM/signature/history/permission assurance follows from a green build | ci.yml; versions.lock verificationScope |
| F26 | P1 | Some chart workload references remain tags; OpenEBS follows a current HTTP chart index | An immutable-looking release does not pin every shipped byte | versions.lock.json; platform README |
| F27 | P1 | Node observations lack desired/actual complete release and customer-policy drift | Operators cannot see that nominally Ready nodes are different | contracts/agent.ts; operational-health.ts |
| F28 | P1 | A real kubelet sample skipped a minute at the boundary | Correctly unknown window, but repeated sampling gaps can postpone expansion | Accepted RAM test and node-memory.ts |
| F29 | P0 | Previous fast-start plan substituted one warm runtime per DB for Neon's shared prestarted compute pool | The chosen implementation target diverged from the explicit requirement; warm-only measurements cannot close it | rust-runtime-and-cold-starts.md section4, now corrected |

F06 is an accounting/admission error, not a claim that sleeping PostgreSQL burns250m CPU. Platform
1510m is a sum of requested scheduling resources, not measured continuous CPU use. F08 is different:
the current thick volume really allocates physical extents. Both need correction at the right layer.

## 5. One Cloudflare configuration model

Use the existing management API, D1, DatabaseActor, RegionLink and regional desired-state pipeline.
Extend these contracts; do not add an independent configuration service or parallel operator journal.

| Configuration | Owner and authority | Propagation / enforcement |
| --- | --- | --- |
| Commercial Free/Paid entitlement, prices | Integrator such as OMH | Selects an allowed PGCF resource profile; no pricing engine in PGCF |
| Resource profile revisions | PGCF management API on Cloudflare | D1 immutable revision, explicit rollout to assigned databases |
| Per-customer/project/database assignment | PGCF management API, scoped caller | Effective revision/hash in desired state and observed acknowledgement |
| PostgreSQL memory/CPU ceiling, baseline request, connections, idle policy | PGCF resource profile | Controller/CNPG/Kubernetes plus SQL readiness |
| Backup policy and resource budget | PGCF | R2/WAL configuration, actual backup observations and bounded simultaneous work |
| Logical disk quota and physical allocation policy | PGCF | Thin volume/filesystem enforcement, measured pool free/metadata and usage |
| Region routing, credentials references, release, capacity/order policy | PGCF | Validated API updates; regional execution and observed convergence |

Initial profile semantics: PostgreSQL memory256MiB for the entry profile, configurable in256MiB
steps up to4096MiB. A ceiling permits usage; it does not immediately allocate the ceiling. Profile
labels are configurable. CPU request and CPU limit become distinct fields. Storage quota becomes
distinct from physical allocated blocks. Do not hardcode OMH-specific commercial labels in PGCF.

The existing meaning of memory_mib is PostgreSQL-container memory. Show backup/system overhead
separately and accept a real256MiB instance with backup, WAL and maintenance. If the product instead
requires256MiB for PostgreSQL plus all per-DB backup work, the current512MiB Barman limit cannot
silently fit that envelope: establish a measured smaller backup profile or redesign its execution.
This is an explicit resource-contract decision, not a naming change.

Editing a referenced profile creates a new revision. A rollout chooses affected assignments and
uses existing database operations/generation checks. The old effective state remains recorded until
the region reports the new Pod resources and SQL settings. Expose desired/applied revision, pending
reason, error, progress and rollback/forward-recovery choice. Sleeping DBs can accept a future
configuration without waking unnecessarily; the next wake must enforce it before admission.

Expose profiles, customer assignments, regional/node release and policy status, actual resource
usage and limits, rollout control and purchase history through the PGCF management API.
Use existing scoped authorization and consistent request, operation and status contracts.
No direct D1 console editing is a supported customer-management workflow.

Replication here means authoritative configuration reaches each responsible regional controller.
It does not mean copying every customer's data, credentials or cluster identity onto all servers.

## 6. Resource and capacity correction

### CPU and RAM

| Physical state | CPU accounting | Memory accounting | Persistent storage |
| --- | --- | --- | --- |
| Hard hibernated, zero DB Pods confirmed | No PostgreSQL/Barman active scheduling debit | Actual remaining node/cache usage; no fictitious full class RAM debit | Real allocated blocks remain |
| Starting/restoring/resizing | Bounded in-flight admission plus existing old runtime until gone | Fresh available RAM plus finite startup/backup peak and concurrent holds | Measured allocation and restore/write headroom |
| Active | Active/in-flight scheduler requests govern scheduling admission; actual CPU/throttling inform pressure separately; independent burst limit | Actual working set with enforced customer ceiling | Actual bytes/blocks with logical quota |
| Warm idle/reclaim | Process remains alive; honest small scheduling share | Actual resident/reclaimed/swap observations, not zero | Same retained volume |
| Shutdown or observation uncertain | Retain necessary old admission state until confirmed | Unknown is not free | Preserve ownership and data |

Update selector, atomic create, resize, pending placement, wake/resume, hibernation and usage
reporting together. Use existing lifecycle observations and startup-admission records. Releasing
sleeping CPU without reacquiring it atomically on wake would introduce a new failure. The same
database's concurrent waiters coalesce; distinct database starts queue within real headroom.

Tune minimum CPU requests and Barman concurrency from a representative256MiB/4096MiB workload;
do not replace350m with an arbitrary overbooking multiplier. Keep kernel-enforced RAM isolation
and database/query limits so one database cannot allocate the whole server. An assigned4096MiB
ceiling can still be refused or queued at wake when physical headroom cannot support it.

### Disk

The current thick LVM implementation must change before logical quotas stop reserving physical
capacity. Use a qualified thin-volume profile with the existing OpenEBS engine, subject to proving
Talos module support, physical pool data/metadata management and reclaim. A new StorageClass and
revised existing verifiers are required; merely setting a flag or deleting SUM(storage_gib) fails.

PGCF reports logical quota, filesystem used bytes, physical allocated blocks, pool data/metadata
free and outstanding growth/restore work separately. Admission follows physical headroom, not the
sum of customer quota ceilings. Enforce the individual logical cap and bound writes before shared
pool exhaustion; WAL, backup, filesystem metadata and recovery need visible physical safety margins.
No automatic purchase may be disguised as a RAM event because a static disk quota was exhausted.

Pin pool creation/sizing and supported growth. Upstream thin provisioning does not supply a complete
automatic pool-extension policy. Verify discard/reclaim and prevent one tenant filling the shared
pool or metadata. Storage growth becomes a supported operation; shrink remains rejected unless a
separate verified migration can accomplish it safely.

Existing thick volumes remain readable and intact. Convert with a supported data-preserving volume
migration or verified restore/cutover, never by relabeling a PV or rebuilding the VG. Preserve stable
logical customer assignments; expose any necessary new DB-ID mapping explicitly. If the existing
restore creates a new ID, do not silently change the client's database identity. Reserve actual
temporary copy space; remove the source only after verified cutover. Do not shrink EU EPHEMERAL
or reinstall EU to recover the lab partition allocation. Measure geometry and improve future-node
partition sizing first; existing-node conversion must have its own proven safe procedure.

### Expansion and standing purchases

The owner's permission is recorded as present. What remains incomplete is activation of concrete
machine-readable policy. Reconcile the already approved V159/4vCPU/8GiB/150GiB NVMe/one-month/no
storage-add-on model and regional price with finite node/count/cumulative-cost/expiry settings.
Existing test caps EU3/US1 are not silently treated as the owner's intended permanent fleet limits.
Do not invent numeric unlimited authority; present only genuinely unresolved numeric policy values
for one configuration decision, without asking again whether V159 purchasing is permitted.

Make76%/ten-minute actual RAM the explicit ordinary automatic expansion cause. Remove or separately
disable the pending-DB CPU/storage fallback that can buy below that threshold. Physical CPU/disk
pressure still produces visible waits/alerts and protected refusal; additional automatic purchase
causes need an explicit owner policy rather than hidden fallback behavior.

Retain one active regional addition, original provider request identity, OAuth reuse and uncertain
order reconciliation. Verify current tariff validity before dispatch through supported provider
facts; where no binding quote/max-price exists, disclose that limitation, bound allowed products
and quantities, and reconcile actual invoice/charge data. Stored estimates are not provider-enforced
price guarantees. Demonstrate threshold→one purchase→approved release→Ready with no agent or laptop.

## 7. Common release and patch management for all three servers

Complete the existing versions.lock into one approved release contract. Generate component
references/templates from it rather than maintaining second constants and private permanent
overrides. Include Talos artifacts/schematics/extensions, Kubernetes, exact Flux component set,
platform chart and workload digests, PostgreSQL/extensions/Barman, API/Edge/Native/Regional artifacts
and configuration schema compatibility. Component artifacts may have different source commits,
but the release explicitly selects one compatible set for the whole fleet.

Cloudflare stores desired release, actual observed release/configuration hash, role and rollout
state. New nodes install that approved release directly. Existing nodes use supported in-place
Talos/Kubernetes/Flux/CNPG/first-party upgrades. Bootstrap version metadata is synchronized only
after actual runtime readback; changing metadata alone never counts as patching a server.

Program the lifecycle in the existing Workflows/control mechanisms: detect candidate update;
assemble pinned release and changelog/security evidence; qualify in the single CI; canary;
promote; upgrade one affected node/region at a time; check actual versions and database health;
finish or stop with an explicit reason. An interrupted operation resumes from observed state.
Resolve unknown writes; do not blindly rerun installation, patch or reboot commands.

Converge the shared Regional startup-memory fix to EU before changing EU resource geometry.
Then align Kubernetes/Flux and declared role composition through supported maintenance. Current
EU policy conversion requires a fully suspended/hibernated cohort; either use a controlled window
with verified resumes or implement a supported per-database revision transition. Never bypass
that guard through direct D1 edits. No existing EU node is reinstalled.

Patch policy includes normal maintenance windows and a separate critical-security urgency rule,
candidate rejection and observed-deadline alerts. Select patch targets from supported upstream
compatibility information rather than “latest” tags. Track SBOM/dependencies and actual advisories;
Gitleaks/integrity checks do not establish that an image has no known vulnerabilities.

Each release declares rollback boundaries: restoring a previous container can be supported;
PostgreSQL major/catalog changes, CRD migrations and Kubernetes changes are not generically undone
by changing Git. Use a qualified rollback or forward-fix/restore path. Single-node control/data
topology entails visible maintenance interruption; do not promise zero downtime without replicas.

## 8. Close the headless installation and operations gaps

1. Resolve the actual postjoin409 predicate from retained request/report/state evidence. Reproduce
   that predicate before correcting it; do not assert it was a timeout solely because sessions
   renewed. Run all remaining real readbacks together before one coherent correction release.
2. Set whole-operation, individual-call and proof-freshness budgets from measured work. Historical
   collection duration and fresh completion are different concepts. Bound calls, retain fresh
   identity checks, and avoid repeatedly scanning unchanged facts because another step consumed
   the proof lifetime.
3. Add supported validated region configuration updates. Generate/check the required gateway/pg
   route and prove actual upgrade/SQL connectivity before accepting it. No ordinary config repair
   should require a private D1 CAS.
4. Make cross-region archive-read relationships and secret references Cloudflare desired state.
   Reconcile the scoped read-only source credentials through the existing regional secret path.
   A fresh region must restore without a laptop-created Kubernetes secret map.
5. Distinguish waiting for purchased capacity, bounded runtime work, known failure and uncertain
   writes in the existing operation lifecycle. Correct20-minute expiration semantics using real
   progress rather than arbitrary heartbeat extension. A terminal create is not secretly reopened;
   provide a supported explicit continuation/new operation where safe and required.
6. Remove required behavior from private one-off helpers by putting the minimal reusable operation
   into existing product paths. Keep secrets and raw evidence private. Delete obsolete helper-driven
   implementation alternatives; Git remains the archive. Do not check in a second orchestrator.
7. Complete coordinated exposed-key rotation and prove both new authority works and old authority
   is rejected, including bootstrap custody and recovery. Do not remove decryption material still
   referenced by retained archives. Public repository/security review is a separate evidence gate.

## 9. Fast start and Rust: implement the approved plan

Keep [the approved architecture](rust-runtime-and-cold-starts.md) and its single-CI migration order.
Update its obsolete reservation clauses to the resource model in this document. Rust is the chosen
runtime; measurements validate it. Do not substitute a token Node polling tweak for this scope.

The **shared pool of prestarted, unassigned compute is mandatory**, following Neon's documented
[compute-pool approach](https://neon.com/blog/cold-starts-just-got-hot). Cloudflare configures and
observes regional pools; the Rust controller prepares runtime before demand, exclusively assigns
a compatible slot on wake, delivers current configuration and data access, then refills/recycles
outside the connection path. Per-database warm reclaim and cached container images do not meet
this requirement.

Pool policy defines ready target, maximum idle CPU/RAM, compatibility/release, maximum age and
refill behavior. These resources count as shared platform use, not permanent per-customer slots.
Used tenant runtimes are destroyed before clean replenishment. Concurrent claims, interruption,
wrong-tenant binding and pool exhaustion are explicit acceptance cases. Pool misses use a bounded
ordinary start path with honest latency/miss reporting; refill alone never bypasses the76% VPS
purchase policy.

Resolve the local PGDATA/CNPG late-binding prerequisite first: prestarted slots must be eligible
for the retained volume's node, must not mount another tenant's data, and must retain one writer
and CNPG lifecycle ownership. Prove the actual prestarted execution boundary rather than merely
pre-pulling an image. A running Pod cannot simply receive an arbitrary different PVC, and running
PostgreSQL cannot switch PGDATA by changing a label. Any required supported runtime/storage change
is part of the implementation work; incompatibility does not authorize substituting warm reclaim.
The concrete contract and mandatory live proof are in
[the detailed pool design](rust-runtime-and-cold-starts.md#4-required-shared-prestarted-compute-pool).

1. Rust gateway plus generated/shared protocol contracts: preserve WebSocket/PostgreSQL startup,
   SCRAM passthrough, TLS, COPY, cancellation, backpressure, activity and persisted fences. Drain
   sessions on replacement. No uncertain SQL replay or new proxy-auth design in this port.
2. Rust regional controller and bootstrap relay as separate binaries/images/rights. One controller
   owns a region during handoff. Use targeted authoritative desired pulls, per-DB serialized work,
   priority wake queues and Kubernetes watches. Implement shared compute preparation, exclusive
   assignment, refill and retirement. Publish readiness immediately; move inventory,
   metering and unrelated DB reconciliation out of the connection-critical path.
3. Identity-bound direct target cache with distinct dial address and TLS identity. Configuration
   fingerprint is separate from power/activity revision. Pod/container/storage/role/CA changes or
   watch gaps invalidate runtime proof; unchanged configuration does not need reapplication.
4. Full Rust/Wasm Edge and versioned Actor admission snapshots. Preserve real Cloudflare VPC HTTP
   and native unopened WebSocket behavior. Mutation barriers block stale snapshots, commit D1,
   obtain current regional proof and publish a matching revision before reopening admission.
5. Implement and accept shared-pool activation for actually hibernated databases, including
   configuration changes, isolation, refill, restart and bounded miss fallback.
6. Additional scoped Rust reclaimer and per-database warm idle. Verify encrypted Talos swap/zswap,
   same process/Pod/PVC, bounded reclaim and cancellation. Keep probes, PostgreSQL and backups
   operational. A live warm-idle database has real resource usage; hard hibernation has no DB Pods.
7. Explicit suspension remains closed until an authorized resume. Automatic prewake may revive
   idle sleep, but must not undo an administrator's suspension. The adopter's timeout adjustment
   is a compatibility measure, not proof that PGCF has achieved the fast-start objective.

Latency evidence must be comparable: connect_ms and first_read_ms both start immediately before
client connection; first_read ends after a validated result. Also record established-session SQL.
The historical8.412/9.160/9.708s cold series measured connection only; warm734.438ms p95 included
first read. Do not subtract these numbers. Fix mislabeled probe output before comparing releases.

The required target is subsecond first successful read after a sleeping database receives an
unassigned prestarted compute. Measure twenty independent five-minute-idle pool-hit activations
plus30/120-minute idle soaks. At least two database identities must draw from shared inventory;
prove no per-database compute was already running and slots were ready before their requests.
Record actual resource cost, assignment/refill time and hit/miss rates. Always-warm, optional
warm-reclaim and pool-miss/on-demand results are separate series. None replaces the pool test.
If a path misses its target or late binding is not solved, the gate stays open.

## 10. Execution order and release gates

| Work package | Depends on | Concrete output | Gate |
| --- | --- | --- | --- |
| A. Correct scope and freeze facts | None | This plan, corrected status, fresh fleet/config inventory | Every difference classified as intended role parameter, defect or missing evidence |
| B. Central configuration/release contracts | A | Revisioned profiles/assignments, release selection and desired/observed status through the existing CF management API | One API change converges on both customer regions, with data preserved and queryable failure |
| C. Shared runtime and credential baseline | B | Accepted shared Regional fix, declared components, coordinated authority rotation | All3 nodes on the approved compatible release; retired keys rejected; no reinstall |
| D. CPU/RAM capacity model | B,C | Separate request/limit, no sleeping CPU debit, atomic wake admission, real256/4096 profiles | Hibernation frees compute accounting; simultaneous wake/create cannot exceed actual safe headroom |
| E. Usage-driven disk | B,C | Qualified thin profile, measured pool state, logical quota/growth and supported old-volume transition | Empty quotas do not preallocate full disk; quota/full-pool/reclaim/restore tests preserve other data |
| F. Headless completion and purchase activation | B,C,D,E | Supported region/restore-secret setup, postjoin fix, exact76% cause, installed finite standing policy | One normal authorized addition reaches Ready without operator execution; interruption buys exactly once |
| G. Programmed patch lifecycle | B,C | Candidate promotion, rollout, drift repair and supported recovery | Install releaseR, upgrade retained nodes toR+1, interrupt/resume, prove runtime convergence and DB lifecycle |
| H. Rust and shared prestarted compute | B,D,E integration contract; gateway work may proceed with E–G | Late binding, real shared pool, native components, targeted controller, routing snapshots; warm reclaim additional | Multi-database pool-hit first-read target, exclusive assignment, isolation/refill/restart/miss evidence; separate warm/reclaim/cold results |
| I. Density, operations and migration handover | D–H | Representative tenant workload, finite expansion policy, customer/operator runbooks | Actual resource/latency/backup limits established; all required gates below pass |

Use one implementation owner per touched subsystem; independent reviews consume concrete changes,
not repeated unbounded audit loops. Gather related observed failures before releasing a batch.
Bug fixes get a failing reproduction, then affected tests. One existing CI run per final code stand;
qualify changed artifacts once and reuse immutable evidence. No unchanged image rebuild/deployment
without a specific reason. Documentation is not a reason to rerun an installer.

## 11. Final acceptance: every row must have direct evidence

| Gate | Required live evidence |
| --- | --- |
| Uniform3-server release | Actual shared component versions/imageIDs and config schema match one approved release; role differences explicitly rendered; no unknown persistent override |
| Central customer control | Assign256MiB, change to a selected256MiB step and4096MiB ceiling through the PGCF management API; both regions report matching applied revision/Pod/SQL limits after interruption/resume |
| Compute overbooking | Confirmed cold-sleep removes CPU debit; warm idle reports real use; concurrent starts reacquire bounded CPU/RAM headroom; noisy neighbor cannot consume an entire host |
| Disk overbooking | Logical quotas are not fully preallocated; real block use and pool metadata drive admission; quota/growth/full-pool/trim/delete/restore behavior is proved |
|76% expansion | Ten actual fresh consecutive minutes/sameUID→one approved V159 order; suitable old nodes still place DBs; no81% cutoff or hidden below-threshold static-allocation purchase |
| Headless Ready | Purchase, image, network, K8s/platform/secret configuration, storage, proof and admission complete with the laptop disconnected; interrupted uncertain actions are resolved |
| Patch management | A second release upgrades all retained roles through supported procedures; data/UIDs/configuration remain valid; controlled interruption/recovery and bounded skew are observed |
| Backup/recovery | SQL/TLS/roles/R2 base/WAL/PITR/restore/deletion with actual physical reclaim pass on the corrected release/storage model, not merely the old thick baseline |
| Shared-pool fast start | Native Rust components/full Rust-Wasm Edge selected and deployed; actual unassigned slots ready before requests, at least two hibernated DBs assigned safely; subsecond pool-hit first read, refill/isolation/restart/miss metrics; warm-only/reclaim/pre-pulled images cannot substitute |
| Capacity and economics | Representative22-project US workload with realistic sleeping/active/backup mix measured; derive required nodes from real limits, not8GiB division or old permanent CPU sums |
| Security | Coordinated exposed-key rotation accepted; exact release vulnerability/provenance/secret/permission review; public repository/history exposure separately assessed |
| Operational ownership | Operator can change policy, inspect drift/failure and resume supported operations through PGCF; no private script/AI agent needed for normal operation |

The prior database tests remain useful regression evidence, but changing storage, runtime or
resource policy requires the affected live checks again. Passing an unaffected test repeatedly
does not close a different gate. Do not mark the overall goal complete while any required gate
is pending or supported only by an operator workaround.

## 12. Explicit decisions to resolve without losing progress

The shared compute pool itself is decided and required. The work must select and prove the
runtime/storage binding mechanism compatible with retained data and CNPG, rather than reopen
whether to implement the pool or silently substitute per-database warm retention.

- Confirm whether256MiB names the PostgreSQL limit (current contract and this plan's baseline) or
  the entire per-database PostgreSQL/backup envelope. Show both values in PGCF in either case.
- Encode actual finite regional fleet/cost/count/expiry values from existing owner authorization;
  the V159 purchase permission itself is already given. Do not invent caps or keep test cap1 forever.
- Define storage quota offerings separately from physical allocation and a supported stable-ID or
  explicit rebind procedure for converting existing thick volumes. No silent customer-ID switch.
- Define measured CPU baseline/burst and backup concurrency profiles; no arbitrary fixed per-tenant
  slot count or claimed22-project fit before the density experiment.
- Declare maintenance downtime for the current topology. HA would be a separate explicit topology
  decision; two gateway Pods on one server do not create node-level availability.

Independent API contract, runtime and reproduction work can proceed while these finite policy
values are settled. Do not repeatedly request already granted permission or silently substitute
a different economic model to make an existing test pass.

## 13. Primary implementation references

- [Placement](../../apps/api/src/domain/placement.ts), [atomic database mutations](../../apps/api/src/domain/databases.ts), [startup admission](../../apps/api/src/domain/startup-admission.ts), [capacity expansion](../../apps/api/src/domain/node-capacity.ts).
- [Sizing](../../packages/contracts/src/sizing.ts), [profile API](../../apps/api/src/platform/size-classes.ts), [desired state](../../apps/api/src/domain/desired.ts), [resource builder](../../apps/regional/src/agent/builders/index.ts).
- [Release lock](../../infra/platform/versions.lock.json), [tracked Regional pin](../../infra/platform/regional/kustomization.yaml), [storage class](../../infra/platform/base/storageclass.yaml), [Talos disk geometry](../../infra/talos/single-disk-lab-storage.patch.yaml).
- [Memory collector](../../apps/regional/src/agent/node-memory.ts), [window evaluator](../../apps/api/src/domain/memory-capacity.ts), [controller loop](../../apps/regional/src/agent/loop.ts), [gateway dial](../../apps/regional/src/gateway/postgres.ts), [Actor](../../apps/api/src/database-actor.ts).
- [Talos1.14 supported upgrades](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/lifecycle-management/upgrading-talos): API-based OS upgrades and supported recovery; Kubernetes upgrade is separate.
- [Kubernetes requests/limits](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/): scheduling requests and runtime resource limits have distinct functions.
- [Pinned OpenEBS1.10.1 StorageClass](https://raw.githubusercontent.com/openebs/lvm-localpv/v1.10.1/docs/storageclasses.md) and [thin-pool design](https://raw.githubusercontent.com/openebs/lvm-localpv/v1.10.1/design/lvm/storageclass-parameters/thin_provision.md): module and pool-lifecycle requirements; enabling a flag does not supply complete capacity management.
