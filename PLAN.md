# cloudflare-postgres — Plan

**Status, 2026-10-09: overall goal open; none of the 13 final acceptance gates is closed.**

**Current work: execution gate 2 — R1 fleet preflight and supported upgrades. Immediate US
cluster-authority rotation passed live; Cloudflare custody revision 2 is active. Execution gate 1 passed live.**
The [corrective plan, §10](docs/architecture/cloudflare-convergence-and-serverless-plan.md#10-execution-order-and-release-gates)
defines the owner's ordered work packages; its §11 defines the 13 acceptance rows in [Status](#11-status).

The live API is db130cb after successful main CI (38002576199); D1 remains at 0038.
The qualified Bootstrap image e54fd0a4 is fully mirrored in Cloudflare; no migration was rerun.
The EU/US database lifecycle, measured RAM trigger and 135-second EU policy transition are valid partial evidence.
They do not establish uniform releases, unattended purchases, thin storage, key rotation or fast start.

The owner approved native Ubuntu/AMD64 validation on a GitHub review branch. Main publication
and Dev delivery follow successful validation; the retained Talos fleet remains a database fleet.
Existing later-gate implementation remains unchanged while gate 1 is completed.

R1 uses official Image Factory Talos 1.14.2, Kubernetes 1.36.5 and the pinned platform on all three
retained servers, through supported upgrades without reinstallation. R2 adds the sandbox extension
and proves interrupted upgrade/resume. Upstream artifacts use digest and signature/SBOM verification;
byte scanning and finding review apply only to first-party builds. Per-fix history belongs in Git.

## 1. Goal

Provide an open-source, Neon-style serverless PostgreSQL service operated through Cloudflare and
Contabo VPS:

- Create, resize, suspend, resume, restore and delete databases through a versioned management API.
- Run unmodified PostgreSQL under CloudNativePG on Talos/Kubernetes with local LVM storage.
- Route every database connection through Cloudflare; expose no PostgreSQL port on a VPS.
- Sleep idle databases and wake them safely on connect, without losing committed data or replaying
  uncertain writes.
- Continuously archive WAL and take base backups in R2, with point-in-time recovery.
- Place databases and add regional capacity through Cloudflare-owned policy and Workflows.
- Report usage and infrastructure cost. Integrators own prices, credits, wallets and customer budgets.

Management is API-only; a PGCF administration UI or dashboard is out of scope. Adopter adapters,
commercial policy, connection-pool settings and customer cutover live in adopter repositories.
The first adopter is ohmyho.st; US is its default and EU remains selectable.
No per-database compute autoscaling, branching or transaction pooler is part of v1.

## 2. Principles

1. Cloudflare owns desired state, placement, capacity policy, operation progress and observations.
   Regional components execute that state; PostgreSQL data is the persistent authority on VPS.
2. Preserve the retained EU control/relay node, customer EU1, US1, their physical identities and all
   existing data/custody. The control/relay role remains excluded from new customer placement.
3. A supported upgrade is not a reinstall. A changed version field is not evidence of an upgrade.
4. Missing, stale, incomplete or identity-mismatched observations remain unknown, never zero use
   or successful execution. Resolve uncertain writes by reads of the same intent.
5. Public APIs and defaults are generic. Fresh installations neither buy servers nor send email.
   Operators explicitly configure provider credentials, profiles, thresholds and optional delivery.
6. Build only what the current live gate needs. Complete that gate before beginning another large
   package; retain existing later-gate work without extending or discarding it.
7. Product code contains no mocks, stubs or fabricated success. Local tests and artifact checks
   are not live Dev acceptance.
8. Delete unused code and superseded alternatives; Git history is the archive. First-party code
   is Apache-2.0; pinned upstream versions, licenses and notices are in [THIRD_PARTY.md](THIRD_PARTY.md).

## 3. Architecture

[README.md](README.md#architecture) contains the overview. The approved runtime migration is defined
in [Rust runtime and cold starts](docs/architecture/rust-runtime-and-cold-starts.md).
Rust is an owner-approved architecture choice; measurements validate its implementation.

| Component | Location | Responsibility and approved runtime |
| --- | --- | --- |
| Management API | Cloudflare Worker | TypeScript; authenticated configuration, operations, D1 state and OpenAPI/client contracts |
| DatabaseActor | Durable Object per database | TypeScript; admission, wake coalescing, idle lifecycle, activity and mutation barriers |
| RegionLink | Durable Object per region | TypeScript; authenticated outbound regional link carrying hints; D1 desired state remains authoritative |
| Workflows and Native bootstrap | Cloudflare | Long operations, purchases, installation and retained-node patches; provisioning orchestration initially Node.js |
| Edge | Cloudflare Worker | One database hostname, admission and signed routing; full Rust/Wasm is the approved target |
| Regional gateway | Kubernetes | PostgreSQL/WebSocket transport, verified PostgreSQL TLS, activity and writer fences; native Rust target |
| Regional controller | Kubernetes | Desired-state reconciliation, observations, backup health and lifecycle; native Rust target |
| Bootstrap relay and node reclaimer | Regional/node scope | Separate native Rust binaries and narrowly scoped rights |
| Platform | Talos/Kubernetes | Pinned Flux, Cilium, OpenEBS LVM, cert-manager, CloudNativePG, Barman plugin and cloudflared |
| Contracts | Shared package | zod remains authoritative; Rust uses generated schemas/constants and behavioral conformance |

The deployed regional/Edge runtime remains the accepted baseline until each replacement passes
its required Dev gate. One controller owns a region during handoff.

### Database resources and credentials

Each database has a restricted namespace, resource quota, default-deny policies, one CNPG Cluster
and one placed PostgreSQL instance. The random database ID is also its PostgreSQL database name.
The application owner is app, additional roles use managed roles, and superuser access is disabled.
CPU requests, CPU limits, memory requests, memory limits and Barman overhead are separate quantities.

Storage generation identifies the physical/archive lineage independently of configuration generation.
Barman uses an ObjectStore under the database's unique region/ID/storage-generation/operation prefix,
continuous WAL archiving and daily base backups. EU uses an EU-jurisdiction R2 bucket; the separate
US bucket uses the general endpoint with a North America location hint, not a jurisdiction guarantee.

The Worker generates credentials, encrypts them with AES-GCM in D1 using versioned Worker Secrets,
and delivers them only through authenticated desired state into regional Kubernetes Secrets.
Retained archives keep the decryption material they require.
Archive health and established database availability are separate; initial creation still requires
working archiving. An archive alarm must not fabricate a recovery point or a safe sleep boundary.

### Lifecycle and transport

- Create atomically records desired state, placement/startup reservations and an operation.
  Hints accelerate the controller's authoritative pull. Accepted observations complete operations.
- A client opens PostgreSQL over WebSocket at the single db.<domain> endpoint using
  /v2?database=<id>&user=<role>. URL hints are untrusted. The connection URI retains PostgreSQL
  syntax; WebSocket clients disable pipelined authentication. Native tools use the CLI adapter.
- Edge admission rejects invalid or unavailable routes before gateway/PostgreSQL dial. It signs
  a short-lived, single-use regional route token binding the database and role, then uses unopened
  native WebSocket forwarding. The gateway checks the actual StartupMessage against those claims
  and negotiates verified TLS to PostgreSQL. SCRAM authentication remains end to end.
- DatabaseActor coalesces wakes. Hibernate only after authenticated activity and PostgreSQL
  quiescence checks, including prepared transactions and closed-WAL archive acknowledgement.
  Explicit suspension remains closed until authorized resume.
- Resize applies an admitted class/profile revision with sufficient startup headroom. A reconnect
  or visible maintenance interruption is permitted; unproved zero-downtime behavior is not promised.
- Delete uses an explicit tombstone. Missing desired-state entries never authorize deletion.
  Completion requires removal of owned namespace/PVC/PV/LVM resources and physical reclamation;
  ordinary backup retention remains in effect.
- Full restore or PITR creates a distinct target ID and archive lineage, preserving the source.
  Publish it only after SQL, roles, storage checks and removal of temporary restore administration.
  The adopter explicitly rebinds its connection.
- AddNode owns one regional purchase/install intent through verified provider association,
  supported Talos/Kubernetes setup, platform/network/storage proof and Ready admission.
  PatchNode owns upgrades and interrupted readback; terminal AddNode jobs are not reopened.

## 4. Data model and API v1

D1 holds projects and API-key scopes; classes/profiles and assignments; regions/nodes and physical
capacity samples; databases, roles and generation state; operations and idempotency reservations;
lifecycle/usage/cost records; fleet releases, policies, candidates and observations. Configuration,
power, storage and credential revisions remain distinct.
API keys have administrator or project-bound integrator scope. The bootstrap credential may create
the first administrator only while none exists; API and agent credentials are returned once.

The versioned API includes:

- Projects and keys: /v1/projects and /v1/api-keys.
- Databases: /v1/databases, individual reads/resizes/deletes, and suspend/resume/restore operations.
- Roles: list/create/reset-password and connection-uri under the database. Password-bearing URIs
  are restricted to the owning integrator scope.
- Operations, archives, usage and cost: /v1/operations, database archive reads, /v1/usage and /v1/costs.
- Administrator controls: regions, nodes, classes/resource profiles, capacity policy, release
  selection, patch/update operations and supported custody/rotation procedures.
- Regional execution: authenticated /agent/v1/link, desired-state and observation interfaces.

Hono/zod contracts generate OpenAPI and the TypeScript client. Mutations support Idempotency-Key;
replays preserve the original intent and do not reissue one-time credentials. Supported API changes
replace private D1 edits and hand-built Kubernetes secret maps. See the [operations runbooks](docs/operations).

## 5. Metrics and cost tracking

Report per-database UTC-hour lifecycle time, awake/provisioned resource accounting, physical and
logical storage, backup bytes, connections, connection duration and stream bytes. Separate
configured reservations/limits from measured use. Rows remain provisional until their finalization
window closes; missing samples remain explicit gaps.

Infrastructure cost uses observed purchase price/currency and configured R2 costs, with unused
capacity visible. Unknown provider prices remain unknown. Cost allocation is not an integrator
price list or wallet. Connection creation, established SQL traffic and pool hit/miss latency are
different measurements.

Integrators use bounded reusable session pools and queues. Admission combines database, role and
normalized source network, with an additional database-wide handshake bound. A shared proxy address
must not collapse unrelated tenants into one global bucket. Limits are operator configuration,
not claims of measured throughput.

## 6. Security and isolation

- All database traffic enters through Cloudflare and the regional outbound Tunnel/VPC path.
  PostgreSQL has no public VPS listener.
- Operational access uses the existing Cloudflare relay, not changing laptop IP addresses.
  Remove temporary operator firewall exceptions once relay coverage is verified. Keep only the
  necessary provider/bootstrap and exact peer rules; never expose cluster ports to the world.
- Preserve authenticated Talos/Kubernetes transport, exact Node/Cluster/boot/storage identity and
  operation authority. Provider calls are for purchase, association, necessary lifecycle changes
  and uncertain-action resolution, not routine observation or cleanup.
- Inter-node Pod traffic uses the selected Cilium encryption configuration; host management uses
  its native TLS. Verify the actual peer/network boundary before admission.
- Per-database namespaces, restricted Pods, network policy, logical quotas and runtime resource
  limits isolate tenants. The regional controller does not gain general pods/exec access.
- Routing tokens bind user/database/region and expiry. The gateway checks startup identity before
  dialing, enforces replay/fence rules, bounded buffering and deadlines, and never replays SQL.
  Unknown identities use bounded decoy authentication; unauthenticated traffic is not activity
  that may keep a database awake.
- Rotate exposed EU and US authority through supported operations; prove new access works and old access
  fails while preserving data, cluster identity and required archive decryption.
- Never print or commit secrets, .env files, kubeconfigs, Talos configurations or private evidence.
  No machine credentials belong in a public image or schematic.
- Verify upstream artifacts by immutable digest and official signature/SBOM provenance. Scan and
  review first-party extension, recipe and binary bytes. Remove upstream finding lists and code
  used solely to rescan/review vendor payloads. Vulnerability review remains separate from secret
  scanning, and a green build alone is not complete security acceptance.

## 7. Phases

The following execution order is the owner's 2026-10-09 decision. Each package must pass its live
gate before the next large package begins. Existing later work remains available unchanged.
The 13 final acceptance rows in section 11 remain the completion criteria.

| Order | Work package | Required result before advancing |
| --- | --- | --- |
| 1 — passed live | CI parity and current delivery | Reproduce the single CI on native Linux/AMD64 with Node 24.21, the same Docker version and Rust targets; fix the collected clock/inspect/package-pin failures; green CI, then deliver the current no-ceiling, configurable threshold/purchase switch and generic optional-email behavior |
| 2 — current | R1: uniform retained fleet | Official Image Factory Talos 1.14.2, Kubernetes 1.36.5 and pinned platform on all three servers through supported upgrades; preserve data/identities and prove actual common release |
| 3 | R2: extension and patch management | The same baseline plus the sandbox extension; supported Talos upgrade with deliberate interruption and resume, exact final runtime/configuration and preserved data on retained roles |
| 4 | Thin storage, then lifecycle | Qualify the physical storage model and its safety bounds; repeat SQL/TLS/roles, R2 base/WAL, PITR/restore and physical deletion on that model |
| 5 | Configurable expansion and headless Ready | The configured threshold triggers one already-authorized V159 purchase through Ready with no operator; resolve the postjoin 409, preserve exactly-once purchase and continued safe placement |
| 6 | EU key rotation | Execute the real coordinated rotation; new authority succeeds, retired authority is rejected and data/custody remain intact |
| 7 | Rust and shared pool | First prove CNPG/local-volume late binding on US1; then complete the Rust gateway/controller/Edge/relay and shared prestarted pool integration and live latency/isolation gates |
| 8 | Density and operations | Measure the representative 22-project US workload; complete ordinary policy, recovery and lifecycle operations without private scripts, an AI agent or laptop access |

R1 does not depend on a custom OS-image qualification chain. R2 scans first-party additions and
verifies its official base; it must not reinstate upstream byte-scan finding review as a gate.
Gate 1 requires the matching native Linux/AMD64 environment; Mac emulation or another Node/Docker
version does not close that prerequisite. No refused local validation is retried.

Public-release polish and fresh foreign-account installation follow operator readiness.
Customer migration remains a separate operation after the required security and capacity gates.

## 8. Resource and acceptance boundaries

### CPU, RAM and expansion

Cold hibernation must release compute accounting; warm idle retains measured live demand.
Separate small scheduling requests from hard runtime limits. Create, restore, wake, resume and
running resize reacquire atomic startup CPU/RAM/storage headroom; uncertain work keeps its hold
until real observations settle it. Report PostgreSQL and Barman budgets separately.

Regional purchase pressure uses ten fresh consecutive aligned minutes from every eligible node,
with stable physical Node UIDs. Sum working-set bytes against physical capacity. Missing or
gapped windows remain unknown; a new empty node must not trigger another order from an older
hot node. Existing suitable nodes continue placement while expansion runs. There is no 81% stop.

The threshold and purchase switch are operator-owned API settings. For this installation the
standing choice is 76%, V159 / 4 vCPU / 8 GiB / 150 GiB NVMe, one month, no storage add-on.
The fixed three-node ceiling is removed; there is no mandatory replacement cap or standing-expiry
limit. Generic optional caps may be configured. This authorization is already granted; it must
be implemented, not requested again. Other operators receive no inferred purchase authority.

Keep one active regional addition. Recheck current policy and pressure before first dispatch.
A missing provider reply is resolved against the same order identity, even if RAM later falls.
CPU/storage shortage below the RAM threshold waits or alerts rather than silently buying.
Provider prices without an authoritative quote are unknown, not guaranteed invoice ceilings.

### Physical storage and recovery

Logical quotas must not reserve their entire size permanently. Admission uses actual LVM/thin-pool
data and metadata, safety reserves, write exposure and bounded startup work. A flag change or
removing a D1 sum does not create physical thin capacity.

Qualify data-full and metadata-full behavior, noflush quiescence, marker-preserving resume,
startup bounds including filesystem formatting, trim/delete/recreate and retained thick data.
Bind qualification to the actual kernel, host extension, driver/tools and profile; no old-kernel
receipt or fabricated gate flags may qualify a changed physical implementation.

Existing thick volumes use a supported data-preserving transition. Preserve IDs where supported;
otherwise expose a distinct restore target and explicit adopter rebind. Never silently switch
customer identity. Repeat affected backup/recovery acceptance after changing storage or runtime.

### Rust, CNPG and shared prestarted compute

At execution gate 7, first prove CNPG-compatible late binding on US1: actual unassigned prestarted
compute, the retained volume on its correct node, no cross-tenant mount and one writer. A cached
image, warm database or arbitrary running-Pod PVC change cannot substitute for this proof.
Only then extend the remaining integration.

Cloudflare owns compatible slot inventory, exclusive claims, bounded idle resources, refill and
retirement. Used tenant runtimes are destroyed before reuse. Preserve one controller, current
configuration/credentials, route invalidation and writer fences through interruption and watches.

Measure twenty independent five-minute-idle pool hits across at least two databases, plus 30- and
120-minute idle soaks. The target is a validated first read below one second after assignment.
Record connect and first-read times from the same connection start, plus resource use and
assignment/refill/hit/miss metrics. Always-warm, warm-reclaim and pool-miss results stay separate.

The initial single-control-plane/local-volume topology permits maintenance downtime. Two gateway
Pods do not provide node-level HA. Do not claim zero-loss failover beyond the actual R2 recovery
point or infer 22-project density from nominal host RAM or permanent class-reservation sums.

## 9. Decisions (owner-approved changes or a measured reason)

| Topic | Decision |
| --- | --- |
| Authority | Cloudflare control plane; regional desired-state execution and observations |
| Runtime target | Native Rust gateway/controller/relay/reclaimer; full Rust/Wasm Edge; TypeScript API/DOs/Workflows; CLI/provisioning initially Node |
| Database | Unmodified PostgreSQL, one CNPG instance and namespace per database, local LVM data |
| Transport | One public hostname, PostgreSQL over WebSocket, signed routing and verified PostgreSQL TLS; native forwarding through the accepted Cloudflare path |
| Backup | Barman Cloud, continuous WAL, daily base backups, R2 retention and new-ID full/PITR recovery |
| Resource policy | Distinct requests/limits and actual-use admission; cold sleep releases compute debit, physical data remains |
| Purchase policy | Configurable regional RAM threshold and explicit enablement; current standing V159 choice retained |
| Email | Optional, operator-configured and deduplicated; no personal recipient or enabled default |
| Releases | R1 official Talos 1.14.2 / Kubernetes 1.36.5 first; R2 adds the sandbox extension and interruption/resume proof |
| Qualification | Digest/signature/SBOM for upstream; byte scanning of first-party builds only |
| Operations | Cloudflare relay and supported API/Workflows; no routine laptop-IP firewall edits or private-script dependency |
| Out of scope in v1 | Customer pricing/wallets/budgets, per-database compute autoscaling, branching, transaction pooler and PGCF administration UI |

## 10. Working rules and repository layout

- Complete the current execution gate before extending later work. Do not discard already-written
  later-gate implementation merely to change the order.
- Before pushing, reproduce the actual CI toolchain on native Linux/AMD64. Audit wall-clock tests,
  Docker inspect capability use and architecture-specific package pins as one observed-failure batch.
- One reviewable commit per work package or fix batch; one independent review per batch and one
  existing CI workflow. Do not repeat unchanged builds, scans or deployments without a new reason.
- Reuse qualified immutable artifacts. R1 must not wait for the custom boot-image chain.
- Bug fixes begin with a failing reproduction. Test changed logic and use real Dev acceptance for
  gate closure; test counts, local boot proofs and documentation edits do not close live gates.
- Preserve unknown write outcomes and original operation identities. No blind SQL, provider,
  installation, rotation or upgrade retries.
- New paid resources and production writes require explicit owner authority; the existing
  V159 standing approval is retained. No reset/reinstall of retained EU nodes is authorized.
- Put phase results and measurements only in the 13 Status rows. Per-fix narratives remain in Git.
  Repository documentation is English; discussion with the owner may be German.
- Owner reports are one line when a live gate closes: gate, measured result, next gate. Do not
  replace that with a running fix log or claim completion from a partial test.

| Path | Purpose |
| --- | --- |
| apps/api, apps/edge | Management/control and deployed TypeScript edge |
| apps/regional, apps/node-bootstrap | Existing regional and provisioning implementations |
| apps/native-gateway, apps/native-controller, apps/native-bootstrap-relay, apps/native-reclaimer | Approved native runtime components |
| apps/edge-rust, apps/node-runtime, apps/sandbox-controller | Rust Edge and shared-runtime/host components |
| packages/contracts, packages/native-protocol | Authoritative contracts and native protocol/conformance |
| infra/platform, infra/talos, infra/backups, infra/storage | Pinned platform, OS, backup and storage assets |
| scripts/ci, scripts/e2e | The single CI's tools and real Dev acceptance |
| docs/operations, docs/architecture | Supported runbooks and approved architectural detail |

## 11. Status

| Gate | Stand | Messwert | Datum |
| --- | --- | --- | --- |
| Uniform3-server release | Open — R1 pending | Retained Talos 1.14.1; Kubernetes EU 1.36.3 / US 1.36.5. No accepted all-three-server R1 on official Talos 1.14.2 / Kubernetes 1.36.5. | 2026-10-09 |
| Central customer control | Open — partial live evidence | Shared actual-RAM policy: 128 MiB PostgreSQL request, 4096 MiB maximum. EU transition 135 s preserved all 3 database hashes; complete profile-change/interruption acceptance in both regions remains open. | 2026-10-09 |
| Compute overbooking | Open | A 256 MiB PostgreSQL trial worked; backup peak, cold-sleep CPU release and concurrent startup/neighbor bounds are not accepted on the corrected model. | 2026-10-09 |
| Disk overbooking | Open | Thick storage is the accepted baseline. Last measured VG total was 103,075,020,800 B per node; no complete live thin-profile quota/full-pool/startup/reclaim acceptance. | 2026-10-09 |
| Configurable expansion | Open — gate 1 configuration passed live; purchase path incomplete | API 3b6baeb / D1 0038: threshold/switch/remove-cap trial 124.523 s; fresh defaults 103.865 s and 1 real Cron, 0 purchases/mail. Both policies restored (760000 PPM, max_nodes null). All 3 retained SQL/TLS/table hashes and 9 relay connections passed, 0 Contabo calls. Historical 10-minute RAM mean 79.9062%; unattended V159-to-Ready remains open. | 2026-10-09 |
| Optional email | Open — partial historical evidence | A configured warning delivered once at 77.2919% RAM with dedupe. Personal setup was removed; generic clean-install/opt-in behavior still needs acceptance of the current release. | 2026-10-09 |
| Headless Ready | Open | US1 reached Ready in 198.356 s through the operator fallback; the programmed 1 GiB storage trial took 753.081 s. Automatic postjoin 409 and laptop-independent completion remain unresolved. | 2026-10-08 |
| Patch management | Open — R2 pending | No live all-role sandbox-extension upgrade with controlled interruption/resume is accepted. Source implementation and local checks are not that measurement. | 2026-10-09 |
| Backup/recovery | Open — thick-baseline regression evidence only | EU/US SQL used PostgreSQL 18.6, TLS 1.3 and nonsuperuser roles; 4 R2 base/WAL checks and 4 × 5 GiB deletions reclaimed 20 GiB. EU restore 108,618 ms; EU-to-US restore 87,988 ms. Repeat on the corrected model. | 2026-10-08 |
| Shared-pool fast start | Open | Local-only proof prepared 2 unassigned holders; 4.954/2.455 ms were runtime assignment observations, not SQL latency. US1 CNPG late binding and subsecond pool-hit first reads remain unproved. | 2026-10-09 |
| Capacity and economics | Open | No representative 22-project US workload measurement; no accepted node-count or cost conclusion from nominal RAM or class sums. | 2026-10-09 |
| Security | Open — US rotation passed; EU rotation pending | US custody revision 2 active: 22 configuration phases, 20 controller renewals, 7/7 old/new access pairs (154.466 s), all 19 Secrets preserved and encrypted under the new canonical key2 after 38 guarded writes. First configuration write to custody activation 4258.061 s; 1 same-disk reboot and 1 supported kubelet recovery; 0 Contabo calls, purchases, reinstalls or EU writes. Node/Cluster/filesystem/VG identities preserved; VG 103,075,020,800 B. EU revision 1 retirement and complete release security acceptance remain mandatory before customer data. | 2026-10-09 |
| Operational ownership | Open — relay access measured | Historical 30-minute window: 390 proof/transport requests, 0 provider attempts. Current CF preview verified the retained US Cluster/Node UIDs through 3 mTLS relay connections with 0 provider calls and 0 cluster writes. Permanent operator delivery and routine operation without private scripts remain open. | 2026-10-09 |
