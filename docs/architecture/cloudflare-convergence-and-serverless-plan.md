# Unified Cloudflare control, fleet releases and serverless capacity

Status: **all 13 final acceptance gates remain open**. Owner direction: 2026-10-09, 17:00.

[PLAN.md](../../PLAN.md) is the canonical scope and status record. Historical operator-assisted
US admission, database lifecycle and RAM measurements remain partial evidence.

The owner's execution order in section10 supersedes earlier dependencies and permission to
develop large work packages in parallel. Execution gate1 passed live; current work is gate2:
R1 retained-fleet preflight and supported upgrades. Existing later-gate code remains unchanged;
this sequencing decision does not discard it.

R1 is the official Image Factory Talos1.14.2 / Kubernetes1.36.5 fleet release without a custom
OS image. R2 adds the sandbox extension and proves interrupted upgrade/resume. Upstream bytes
use digest and official signature/SBOM verification; scan/review first-party builds only.
This document authorizes no reinstallation or customer migration and records no new live result.

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

Ordinary expansion uses an operator-configured actual regional physical RAM threshold over ten fresh consecutive
aligned minutes. Every eligible customer node must retain its own physical Node UID throughout
that window; sum actual working-set bytes against physical capacity rather than averaging unlike
node percentages. Existing suitable nodes remain eligible while another node is provisioned.
There is no81% placement stop. The latest owner decision removes the fixed three-server ceiling
and the personal notification setup. The authenticated Cloudflare management API exposes the
RAM threshold and automatic-purchase on/off setting per region. The operator must configure and
enable purchases explicitly;76% is this installation's selected value, not an immutable product
rule. Optional email requires operator-provided delivery credentials and recipient settings.
Public defaults contain no recipient, provider secret or automatically enabled purchase authority.

The CPU and disk models must support many small or hibernated databases. A logical customer limit
is not a permanently consumed allocation. Actual live work, simultaneous starts, persistent data
and necessary system headroom still count. No implementation may make capacity appear free by
discarding measurements, treating unknown state as zero or deleting persistent data.

Uniform programmed patch management and the Rust/fast-start architecture with a mandatory shared
pool of prestarted unassigned computes are part of the completion scope. Per-database warm reclaim
is an additional mode and cannot substitute for that pool. The subsequent Neon customer cutover remains a separate operation.

## 2. What is proved, what is not

The live API isdb130cb after successful main CI38002576199; D1 remains at0038. Execution gate1
passed live configuration/defaults and retained SQL checks. The fixed node ceilings and personal
notification setup are removed. US custody revision2 is active after live authority rotation;
EU rotation remains required before customer data. Measured results are recorded in PLAN.md Status.

Historical live evidence includes operator-assisted US1 Ready in198.356s, EU/US SQL/TLS and
nonsuperuser roles, four R2 base/WAL checks, healthy-source EU-to-US restore in87,988ms,
four5GiB volume deletions reclaiming20GiB, and ten fresh minute samples averaging79.9062% RAM.
The expansion decision was disabled. These results do not close any complete gate in section11
or replace retesting after the storage/runtime changes.

Uniform releases, unattended purchase-to-Ready, thin storage, EU rotation, CNPG-compatible
shared compute and representative density remain unaccepted. Local builds, unit tests,
artifact checks and isolated mechanisms remain distinct from live Dev acceptance.
The refused local privileged preflight is unvalidated and is not retried.

## 3. Observed fleet differences

This inventory records October7/8 observations, with the Regional/RAM rows updated for the
reported6978033 convergence. Refresh the required facts once for the current live gate; this
table is not a continuously enforced release observation.

| Layer | EU control/relay and EU1 | US1 | Required correction |
| --- | --- | --- | --- |
| Talos runtime | 1.14.1, kernel6.18.51-talos, containerd2.3.5 | Same reported versions | Verify immutable artifact/schematic/extensions, not only version text |
| Installer provenance | Control uses a tag; customer EU1 digest d1d2fb… | Digest cd4cb8… | One release declares exact supported installer artifacts and role/platform parameters |
| Kubernetes | 1.36.3 | 1.36.5 | Supported, data-preserving convergence of both clusters |
| Flux source/kustomize | 1.9.5/1.9.5 | 1.9.6/1.9.6 | Same approved component versions/digests |
| Flux helm | 1.6.4 | 1.6.5 | Same approved version/digest |
| Flux component set | No image-automation/image-reflector/source-watcher in retained inventory | Those three additional controllers installed | Declare a justified common/role-specific set; remove accidental extras |
| Regional runtime | Reported source6978033 | Reported source6978033 | Preserve this accepted baseline while qualifying R1; complete release convergence remains open |
| Release/configuration baseline | Individual component convergence is recorded | Individual component convergence is recorded | R1 must bind the checked-in release and all actual shared components/role parameters |
| RAM policy | actual_ram, request128MiB, maximum4096MiB | Same reported policy | Preserve the accepted135s EU conversion; prove full profile changes through the API |
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
US1 also hosts its regional control plane. It does not justify divergent customer policy or future
runtime drift. Three existing servers also do not constitute replicated HA: one local
database volume and a single regional control-plane node can experience maintenance downtime.

## 4. Findings and consequences

These identifiers retain the original audit's corrective scope, not a claim that every defect
is unchanged in source or Dev. Source fixes and partial operational corrections do not close the
associated live gate; current status is the13-row table in PLAN.md.

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

PGCF is generic open-source software. Each operator configures the per-region RAM threshold,
automatic-purchase switch, provider credentials and purchase profile through the management API
and protected secret configuration. Fresh installations keep automatic purchasing off. Validate
the threshold and persist it in Cloudflare; every capacity decision, reservation and first
dispatch uses the current configured value. A policy change invalidates stale purchase authority;
it does not create a second order or discard an uncertain provider result.

For this installation, the standing selection remains V159/4vCPU/8GiB/150GiB NVMe, one month,
no storage add-on, with76% selected. The owner removes the three-VPS ceiling and its cap notices.
Remove that active limit without substituting a huge sentinel value. Existing optional generic
limits may remain operator-configurable, but none is mandatory or silently imposed. Enabling
automatic purchasing is explicit; a fresh adopter receives no inferred authority from this
installation's permission. The already granted owner authority does not need another approval.

The region must have ten fresh consecutive aligned minutes for every Ready, schedulable eligible
customer node, with each node's physical UID and capacity stable. The regional ratio uses summed
actual working-set bytes and physical capacity across those samples. Missing/new/unaligned
capacity stays unknown. A hot older node plus an empty ready spare must not cause repeated orders.
Control/relay nodes excluded from customer capacity remain excluded. A new-placement closure
timestamp alone does not hide RAM use of an otherwise eligible customer node.

Keep one active regional addition and a window-bound idempotency key. Re-evaluate current regional
pressure before the first purchase attempt; a queued operation can continue across minutes while
its current region/order/authority and fresh pressure remain valid. Do not abandon its identity
merely because the sample minute changed. CPU/storage shortage below the configured RAM threshold waits or alerts; it is not
another automatic purchase cause. Existing placement retains hard RAM/CPU/storage/startup checks.

Email is optional and off until the operator configures it. Remove this installation's personal
notification binding and sender token; preserve other adopter mail functions and shared Resend
credentials. A configured Resend delivery integration may remain supported, with explicit sender,
recipient and warning policy rather than a mandatory75% owner email. Keep the generic authenticated
webhook/service-binding transport, bounded requests and persistent event-ID dedupe. Missing mail
configuration must neither send email nor block capacity decisions. Document the minimal opt-in
setup alongside other API features; callback acceptance and provider delivery remain distinct.

If an operator elects to configure a separate optional allocation limit, count retained control,
lost allocations and unpaid reservations correctly. Same-provider recovery never counts as a
new VPS. Removing the owner-specific ceiling does not remove identity or duplicate-order checks.

Retain provider request identity, OAuth reuse and uncertain-order reconciliation. Once a provider
write is recorded or uncertain, resolve its result through reads even if RAM later falls or a
short-lived derivative authorization expires; never blindly repost. The public Contabo API has
no supported new-order quote/max-price parameter. Record unknown prices as unknown, not zero or
verified invoice limits. The owner-selected threshold-only policy does not require a monetary
ceiling. Demonstrate threshold→one purchase→approved release→Ready without an agent or laptop.

## 7. Common release and patch management for all three servers

Use one immutable release contract for Talos artifacts/schematics/extensions, Kubernetes,
Flux/platform charts and workload digests, PostgreSQL/Barman, first-party runtime artifacts and
configuration schema compatibility. Roles, regions, networking and credentials remain explicit
parameters; initialized disks and cluster credentials are never copied to make servers identical.

**R1:** official Image Factory Talos1.14.2, Kubernetes1.36.5 and the pinned platform on all three
retained servers. Use supported in-place upgrades, preserve databases/volumes/identities and
observe actual versions and imageIDs. R1 contains no custom OS image and does not depend on
the composed boot-image qualification chain. It closes Uniform3-server release only after the
complete three-server runtime/configuration readback succeeds.

**R2:** the same baseline plus the first-party sandbox extension, delivered through a supported
Talos upgrade. Deliberately interrupt and resume the programmed operation, resolve any uncertain
write through the same intent, and prove final runtime/configuration and data preservation.
This closes the Patch management row and establishes the extension baseline for later pool work.
It does not by itself qualify thin storage or shared-pool fast start.

For upstream Talos and other upstream images, verify immutable digest and official
signature/SBOM provenance. Scan and review only first-party extension, recipe and binary bytes.
Delete upstream finding lists and code used solely for vendor-byte scanning; do not recreate
that dependency under another name. Track actual advisories separately from secret scanning.
Reuse already qualified immutable first-party artifacts when their inputs have not changed.
Existing Talos/Kubernetes SBOM verification does not assert that every platform image is signed
or that an empty image-SBOM file constitutes dependency evidence.

Cloudflare owns desired/observed release and rollout state. Existing Workflows and PatchNode
perform serial upgrades and drift correction with checkpoints and bounded readback. New nodes
install the selected release directly. Synchronize bootstrap version metadata only after actual
runtime acceptance; metadata updates never count as OS upgrades. Terminal AddNode jobs remain
terminal.

Patch policy retains maintenance windows, critical-security urgency, candidate rejection,
observed-deadline reporting and explicit rollback boundaries. A container rollback does not
automatically undo PostgreSQL catalogs, Kubernetes compatibility changes or CRD migrations.
The retained single-node control/data topology can have visible maintenance downtime.

## 8. Close the headless installation and operations gaps

Execute these requirements only at their corresponding gate in section10. Operational access
uses the existing Cloudflare relay; stop adding changing laptop addresses to the Contabo firewall.
Remove temporary operator exceptions once the relay supports the required checks. Necessary
provider lifecycle actions remain distinct from routine relay transport and observation.

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

Keep [the approved architecture](rust-runtime-and-cold-starts.md); section10 governs when this
work starts. At gate7, first prove the actual CNPG/local-volume late-binding boundary on US1,
then extend the remaining gateway/controller/pool integration. Earlier gates do not authorize
more large Rust/pool/reclaimer packages. Existing implementation remains unchanged in the meantime.
Rust is the chosen runtime; measurements validate it.

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
ordinary start path with honest latency/miss reporting; refill alone never bypasses the configured VPS
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

Current execution gate: **2**. Gate 1 passed live; the US authority rotation is also accepted.
Close each gate live before beginning the next large package.
These eight execution packages organize work; the thirteen rows in section11 remain the final
acceptance checklist. Existing later-gate source is retained unchanged, not discarded.

| Order | Work package | Required closure |
| --- | --- | --- |
| 1 — passed live | CI parity and current delivery | Reproduce CI on native Linux/AMD64 with Node24.21, the same Docker version and Rust targets. Fix collected wall-clock, inspect-capability and architecture-pin failures; obtain green CI and deliver no-ceiling, configurable threshold/purchase-switch and generic optional-email behavior. |
| 2 — current | R1: uniform retained fleet | Official Image Factory Talos1.14.2, Kubernetes1.36.5 and pinned platform on all three servers, using supported upgrades without reinstallation. Prove actual common release and preserved data/identities. |
| 3 | R2: extension and patch management | The same baseline plus the sandbox extension. Interrupt/resume its supported Talos upgrade; prove all retained roles, exact final configuration/runtime and preserved data. |
| 4 | Thin storage, then backup/recovery lifecycle | Qualify actual physical storage and startup bounds, then repeat SQL/TLS/roles, R2 base/WAL, PITR/restore and physical deletion on the new model. |
| 5 | Configurable expansion and Headless Ready | One real threshold-driven, already-authorized V159 purchase reaches Ready with no operator. Resolve postjoin409, prove exactly-once purchase, current-policy dispatch and continued eligible placement. |
| 6 | Real EU key rotation | New authority works, retired authority is rejected and retained data/custody/archive recovery survive the coordinated operation. |
| 7 | Rust runtime and shared pool | First obtain the real US1 CNPG late-binding proof; then finish Rust gateway/controller/Edge/relay and shared-pool integration, isolation, interruption and first-read acceptance. |
| 8 | Density and operational ownership | Measure22 representative US projects and their actual workload/backup mix; complete ordinary operation without private scripts, an AI agent or laptop access. |

Before a push, reproduce the actual CI toolchain on native Linux/AMD64, not an emulated Mac with
different Node/Docker versions. Collect and fix related clock, inspect and package-pin failures
once. The goal is a green next push, not repeated discovery of another environment difference.

Use one implementation owner per subsystem, one reviewable commit per package/fix batch and
one independent review per batch. Use the existing single CI; retain valid immutable artifact
qualification instead of rebuilding unchanged images. No documentation change authorizes
another installer run, and no refused local validation is retried.

Owner-facing progress reports occur when a live gate closes: one line naming the gate, measured
result and next gate. PLAN.md Status contains the13 gate rows; per-fix narratives belong in Git.

## 11. Final acceptance: every row must have direct evidence

| Gate | Required live evidence |
| --- | --- |
| Uniform3-server release | R1: official Image Factory Talos1.14.2, Kubernetes1.36.5 and pinned platform on all three retained servers; actual shared versions/imageIDs/schema match, role differences are explicit and no unknown override remains |
| Central customer control | Assign256MiB, change to a selected256MiB step and4096MiB ceiling through the PGCF management API; both regions report matching applied revision/Pod/SQL limits after interruption/resume |
| Compute overbooking | Confirmed cold-sleep removes CPU debit; warm idle reports real use; concurrent starts reacquire bounded CPU/RAM headroom; noisy neighbor cannot consume an entire host |
| Disk overbooking | Logical quotas are not fully preallocated; real block use and pool metadata drive admission; quota/growth/full-pool/trim/delete/restore behavior is proved |
| Configurable expansion | API changes to the RAM threshold and auto-purchase switch are reflected at reservation/dispatch; this installation's76% over ten fresh aligned minutes triggers one approved V159 order, without a fixed three-node ceiling; suitable old nodes still place DBs; disabled or below-threshold purchasing orders nothing |
| Optional email | Fresh/unconfigured installations send no email; operator-configured delivery credentials and recipient enable deduplicated notifications; the removed personal setup is absent |
| Headless Ready | Purchase, image, network, K8s/platform/secret configuration, storage, proof and admission complete with the laptop disconnected; interrupted uncertain actions are resolved |
| Patch management | R2 adds the sandbox extension to the R1 baseline through a supported Talos upgrade; all retained roles preserve data/UIDs/configuration, with controlled interruption/resume and bounded skew |
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
- Preserve this installation's V159 permission, chosen76% threshold, removed node ceiling and
  removed personal email setup; deliver generic threshold/purchase controls at gate1. Generic
  users must configure their own provider and optional email credentials before activation.
- Define storage quota offerings separately from physical allocation and a supported stable-ID or
  explicit rebind procedure for converting existing thick volumes. No silent customer-ID switch.
- Define measured CPU baseline/burst and backup concurrency profiles; no arbitrary fixed per-tenant
  slot count or claimed22-project fit before the density experiment.
- Declare maintenance downtime for the current topology. HA would be a separate explicit topology
  decision; two gateway Pods on one server do not create node-level availability.

Implementation proceeds with the explicit policy above. Do not request the same permission again
or silently substitute a different economic model to make an existing test pass.

## 13. Primary implementation references

- [Placement](../../apps/api/src/domain/placement.ts), [atomic database mutations](../../apps/api/src/domain/databases.ts), [startup admission](../../apps/api/src/domain/startup-admission.ts), [capacity expansion](../../apps/api/src/domain/node-capacity.ts).
- [Sizing](../../packages/contracts/src/sizing.ts), [profile API](../../apps/api/src/platform/size-classes.ts), [desired state](../../apps/api/src/domain/desired.ts), [resource builder](../../apps/regional/src/agent/builders/index.ts).
- [Release lock](../../infra/platform/versions.lock.json), [tracked Regional pin](../../infra/platform/regional/kustomization.yaml), [storage class](../../infra/platform/base/storageclass.yaml), [Talos disk geometry](../../infra/talos/single-disk-lab-storage.patch.yaml).
- [Memory collector](../../apps/regional/src/agent/node-memory.ts), [window evaluator](../../apps/api/src/domain/memory-capacity.ts), [controller loop](../../apps/regional/src/agent/loop.ts), [gateway dial](../../apps/regional/src/gateway/postgres.ts), [Actor](../../apps/api/src/database-actor.ts).
- [Talos1.14 supported upgrades](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/lifecycle-management/upgrading-talos): API-based OS upgrades and supported recovery; Kubernetes upgrade is separate.
- [Kubernetes requests/limits](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/): scheduling requests and runtime resource limits have distinct functions.
- [Pinned OpenEBS1.10.1 StorageClass](https://raw.githubusercontent.com/openebs/lvm-localpv/v1.10.1/docs/storageclasses.md) and [thin-pool design](https://raw.githubusercontent.com/openebs/lvm-localpv/v1.10.1/design/lvm/storageclass-parameters/thin_provision.md): module and pool-lifecycle requirements; enabling a flag does not supply complete capacity management.
