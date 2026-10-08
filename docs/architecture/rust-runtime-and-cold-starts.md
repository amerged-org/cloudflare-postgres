# Rust runtime and cold-start architecture

Approved: **2026-10-05**. **The target architecture is approved; implementation and live acceptance are pending.**

Owner correction (2026-10-08): the [unified control/capacity/release plan](cloudflare-convergence-and-serverless-plan.md)
now requires the actual-use resource model and uniform three-server patching as part of completion.
Earlier clauses preserving full sleeping CPU and logical disk reservations are superseded below.
The Rust implementation and its measured first-read target remain required and unaccepted.
The owner also explicitly requires Neon's **shared pool of prestarted, unassigned compute**.
Per-database warm reclaim is an additional mode; it cannot substitute for that pool or satisfy
its acceptance. The earlier database-bound-only interpretation is withdrawn.

[PLAN.md](../../PLAN.md) remains the canonical scope, roadmap and phase-status record. This document describes the approved architecture and its migration boundaries. It does not claim that the Rust components, routing caches, Actor snapshots or warm-reclaim runtime already exist. Completed Dev results and measured limits belong in PLAN.md Status, not in separate per-change evidence documents.

## 1. Decision and purpose

Rust is the chosen implementation language for the first-party regional server applications: the PostgreSQL gateway, the entire lifecycle controller, the bootstrap byte relay and a separate node-local memory reclaimer. The entire Edge Worker also moves to Rust compiled to WebAssembly. TypeScript remains the language of the management API, DatabaseActor, RegionLink and Workflows. The CLI and node-bootstrap orchestration remain Node.js initially. No first-party Go implementation is planned.

The migration combines a native runtime with changes to the connection and lifecycle paths. It does not consist only of translating the existing reconciliation loop. The controller becomes event-driven, publishes ready database observations immediately, retains verified runtime state, and keeps inventory and metering work outside the wake path. The gateway connects through an identity-bound direct target cache. The Actor provides a versioned admission snapshot without a D1 read on every ordinary warm connection.

Measurements validate this chosen architecture, establish its operating limits and guide subsequent improvements. Profiling is not a prerequisite for the Rust decision. Rust itself does not remove PostgreSQL startup, Kubernetes scheduling, network round trips or the memory occupied by a running database.

The latency objective is **a first successful read below one second when a sleeping database
is assigned a prestarted unassigned compute from the shared pool**, including ordinary client
connection and authentication. Already-running warm connections, optional warm reclaim and pool
miss/on-demand startup are separate measurements. Warm-only success does not satisfy the pool-hit
target. This is a required Dev acceptance target, not an existing service guarantee.

## 2. Current implementation and evidence

The current Edge, regional agent and regional gateway are TypeScript. The agent and gateway use the pinned Node runtime and remain running while an individual database hibernates. CNPG hibernation removes PostgreSQL Pods and retains the database's local LVM-backed PVC. Waking that database therefore recreates PostgreSQL runtime state; it does not start a new regional Node process.

The last complete historical series measured twenty independent wakes at p50/p95/max **8.412/9.160/9.708 seconds**. All twenty used distinct Pods with unchanged Cluster and PVC identities, one wake and one configuration revision per sample, preserved committed data and no rolled-back marker. The owner accepted these times for current v1. That series used an earlier regional image; subsequent four-run diagnostics do not replace it or establish the latency of every later change.

An always-warm diagnostic measured new connection plus first read at p95 **734.438 ms**. The historical cold series measured `Client.connect()` and validated the marker query afterwards, outside that timer. These values have different endpoints and must not be subtracted to estimate orchestration overhead. Future acceptance records connect and first-read durations for both warm and cold samples.

The existing agent already has an interruptible hint and a compensated one-second pending-wake cadence. The existing PostgreSQL startup/readiness probes are already configured at one second. The approved changes replace discovery polling and unnecessary serialized work; they do not assume an unchanged five-second loop or ten-second probe default.

## 3. Component ownership and build boundaries

| Component | Approved target | Responsibility |
| --- | --- | --- |
| Management API | TypeScript Worker | Management, authorization, authoritative D1 state and installation policy |
| DatabaseActor | TypeScript Durable Object | Admission snapshots, mutation barriers, wake coalescing, idle policy and lifecycle decisions |
| RegionLink | TypeScript Durable Object | Authenticated regional connection and non-authoritative desired-state hints |
| Workflows | TypeScript | Provisioning, restore and other long operations |
| Edge Worker | Full Rust/Wasm Worker | Request validation, admission orchestration, routing-token signing, transport selection and bounded refusals |
| Regional gateway | Native Rust binary | WebSocket/PostgreSQL transport, token/startup validation, TLS, activity and persisted fences |
| Regional controller | Native Rust binary | Desired-state execution, readiness, watches, configuration/runtime proofs, health and observations |
| Bootstrap byte relay | Native Rust binary | The existing authorized byte-relay function with bounded streams and independent workload rights |
| Node reclaimer | Separate native Rust binary | Narrowly authorized reclaim of a bound PostgreSQL container on an approved node |
| CLI and node-bootstrap tooling | Node.js initially | Local client bridge and long-running provisioning orchestration; optional later native work |
| PostgreSQL, CNPG, Barman, Talos and Kubernetes platform | Unmodified pinned upstream components | Database engine, backup, operating system and orchestration |

Use one Rust workspace with a portable protocol/contract core and separate host implementations. Produce separate binaries and images for gateway, controller, relay and node reclaimer. Separate images permit independent deployment and retain separate service accounts, host access and resource limits. A common workspace is not a reason to grant the controller the reclaimer's privileges or to run every mode in one process.

The portable core is shared by native applications and the Wasm Edge. It contains bounded protocol parsing, routing-token primitives, generated contract types/constants and related validation. Kubernetes clients, native sockets, Cloudflare host bindings and node filesystem access stay outside it. Do not add per-frame Node/Rust IPC or a Rust sidecar behind a Node data relay.

Pin the Rust toolchain, dependency lockfile, build inputs and runtime-image digests when implementing the components. Retain upstream notices in THIRD_PARTY.md. Extend the existing single CI workflow with Rust build, conformance, tests and image qualification rather than introducing a second workflow or a language/load test matrix.

## 4. Required shared prestarted compute pool

The target follows the three mechanisms described in Neon's
[Cold starts just got hot](https://neon.com/blog/cold-starts-just-got-hot): start unassigned
compute before demand, apply configuration only when needed, and shorten routing/readiness work.
Neon described a pool of empty computes receiving an endpoint configuration on assignment, with
replenishment/recycling and slower on-demand fallback on a pool miss. Its historical latency
results are reference measurements, not a guarantee for PGCF.

**PGCF must implement a shared pool.** Keeping one PostgreSQL process or Pod alive for every idle
database is not this mechanism. Neither an image cache, spare CPU, pre-pulled containers nor a
pool of database client connections counts as a prestarted compute pool.

### Pool and assignment contract

- Cloudflare owns desired ready-slot count, a hard maximum idle-pool resource budget, supported
  resource/release profiles, maximum slot age, refill policy and observed inventory per region.
  The regional Rust controller prepares actual isolated runtime environments before any customer
  request. Each ready slot has an immutable identity and selected release, and is unassigned to
  any customer or database. Pool size follows bounded regional demand, not the number of sleeping DBs.
- On a request for an idle database, the existing Actor/lifecycle path atomically claims one
  compatible ready slot and coalesces other requests for that database. The claim binds region,
  node, runtime identity, database ID, storage generation, configuration revision and expiry.
  An uncertain claim is reconciled; two databases cannot own one runtime or one writer volume.
- The assigned runtime receives the current effective configuration and scoped credentials,
  connects to the database's actual persistent storage, starts/activates its PostgreSQL instance,
  and publishes readiness only after the existing storage, TLS, role and fence checks pass.
  Pool readiness is distinct from database readiness. Unchanged persistent configuration is not
  reapplied; a new runtime still receives and validates its own identity-bound configuration.
- Refill happens outside the request's critical path. Empty old-release or aged slots are retired
  and replaced automatically. Idle pool memory/CPU is real node usage, included in physical
  capacity and76% calculations; it is not a permanent per-customer reservation.
- After tenant use, destroy the tenant-bound execution instance before preparing a clean slot.
  Never return a process with another tenant's memory, credentials, mounts or PostgreSQL state
  to the unassigned pool. A VM/snapshot optimization may later be accepted only with equivalent
  proven reset isolation. No shared customer PostgreSQL process is introduced by this requirement.
- A pool miss follows the bounded ordinary start path and is explicitly measured as a miss.
  Do not conceal miss rate, add a new VPS merely to fill an idle pool, or present its latency as
  a pool hit. Explicit suspension continues to require an authorized resume.

### Required storage and CNPG integration work

Neon's storage/compute separation is an enabling architecture, described in its
[architecture decisions](https://neon.com/blog/architecture-decisions-in-neon). PGCF currently has
unmodified PostgreSQL with CNPG-owned lifecycle and local PGDATA/PVCs. That is a real integration
constraint to solve, not a reason to replace the requested pool with per-database warm reclaim.

The first implementation stage must produce a working late-binding contract between a prestarted,
unassigned runtime and a retained database volume. With local data, candidate slots must be on
nodes eligible to access that data; a regional pool can have node-affine subsets. No arbitrary US
slot can use EU local storage. Do not hot-swap PGDATA beneath a running PostgreSQL process, attempt
to mutate an already running Pod's volume specification, or create an empty replacement database. Kubernetes documents the
[Pod update restrictions](https://kubernetes.io/docs/concepts/workloads/pods/#pod-update-and-replacement);
CNPG documents its [instance-manager ownership](https://cloudnative-pg.io/docs/devel/instance_manager/).
Verify the exact pinned versions during integration; these constraints cannot be waived by a pool label.

Prove which runtime boundary can be prepared before assignment and how CNPG owns the resulting
PostgreSQL process, Pod identity, storage, backup and recovery throughout that binding. Merely
creating the ordinary database Pod after a cache hit is insufficient unless the claimed prepared
runtime actually removes the expensive preparation and passes the pool-hit timing gate.

Unmodified PostgreSQL, customer isolation, retained data, CNPG ownership and no EU reinstall remain
constraints. If the current CNPG/local-volume integration cannot support the required assignment,
record the concrete incompatibility and the required runtime/storage architecture change as
blocking implementation work. Do not silently retain incompatible constraints while marking the
pool complete, and do not replace the pool target with an easier warm-only benchmark. A wholesale
Neon Pageserver/Safekeeper deployment is not presumed necessary or already authorized by this plan.

### Pinned runtime-boundary findings

The pinned CNPG1.30.1/[CNPG-I0.6.0](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/go.mod)
integration has no supported operation that assigns an already running generic Pod to a Cluster.
[Instance Pods](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go)
are created with Cluster-derived names, namespace, environment and the retained instance PVC.
[Hibernation resume](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_create.go)
creates a new instance Pod; an existing name causes reconciliation rather than adoption.
The [instance manager](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/cmd.go)
starts with a fixed Cluster/Pod/namespace/PGDATA identity. CNPG-I's
[operator lifecycle hook](https://github.com/cloudnative-pg/cnpg-i/blob/v0.6.0/proto/operator_lifecycle.proto)
can patch a proposed Pod, including its RuntimeClass, before normal Kubernetes creation. It does
not provide a late PVC-attachment or instance-manager rebinding RPC. Kubernetes1.36.5 also
[waits for attachment and mounting before invoking its container runtime](https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet.go#L2195-L2241).
A generic Pod waiting for an unbound tenant PVC therefore cannot be counted as a running slot.

The smallest compatible candidate puts the prepared runtime **below Pod identity**, at the CRI
sandbox/VM boundary. CNPG still creates the actual database Pod and owns its unchanged instance
manager, PVC and backup sidecar. A qualified runtime would exclusively assign a previously
booted, tenant-free sandbox to that Pod, then accept its exact mounts and configuration before
starting PostgreSQL. [Kata3.32.0 QEMU VMCache](https://github.com/kata-containers/kata-containers/blob/3.32.0/docs/how-to/what-is-vm-cache-and-how-do-I-use-it.md)
is an upstream example of this boundary; its
[factory implementation](https://github.com/kata-containers/kata-containers/blob/3.32.0/src/runtime/virtcontainers/factory/factory_linux.go)
resumes and assigns a blank VM and refills the cache separately. This is a candidate to qualify,
not an accepted implementation or a latency result. Its empty-cache receive is blocking, so
PGCF's bounded miss fallback and claim/slot observation contract still need implementation.

The [Talos1.14.1 extension source](https://github.com/siderolabs/extensions/blob/515779a55c15b43088e89b17432181891115cbdf/container-runtime/kata-containers/pkg.yaml)
provides `kata` and `kata-qemu` handlers, but installs the containerd shim rather than the
`kata-runtime factory` executable and supervised cache service. A qualified data-preserving
extension/configuration upgrade is required for that candidate. QEMU VMCache requires KVM;
the newer Kata Rust runtime's feature support must be checked independently, rather than
assuming the Go-runtime factory is present. First-party PGCF runtime components remain Rust.

The bounded October8 capability observation found no `/dev/kvm` character device through verified
host `/dev` mounts on any of the three retained nodes. A separate read of guest-visible
`/proc/cpuinfo` in those existing node-driver containers found neither `vmx` nor `svm`; each reported
four CPUs matching its Node capacity. Node/Cluster/driver/DaemonSet identities and template images
remained stable before and after; no workload, host or provider write occurred. Contabo's
[Cloud VPS documentation](https://docs.contabo.com/docs/servers-hosting/vps/) and
[nested-virtualization support policy](https://help.contabo.com/en/support/solutions/articles/103000271595-can-i-setup-nested-virtualization-on-my-server-)
explicitly exclude nested virtualization for VPS, including the Plus family. Installing a Talos
extension therefore cannot make this KVM-based candidate work on the retained V159 fleet.

Retaining those VPS requires a software-only prestarted sandbox factory below the CNPG Pod
boundary, with an actual CRI/network/storage late-binding integration and the same isolation and
latency proof. The pinned
[containerd2.3.5 RunPodSandbox path](https://github.com/containerd/containerd/blob/v2.3.5/internal/cri/server/sandbox_run.go#L52-L165)
requires Pod metadata, generates a new sandbox ID and persists that Pod configuration before
starting the sandbox; calling it for placeholder Pods is not a later-assignment operation.
The software-only factory is required research/implementation work, not an existing
containerd/runc capability or an accepted design. The other direction requires a separately
approved move to virtualization-capable hardware; the current V159 purchase authorization does
not authorize it. Neither direction permits silently replacing the shared pool with per-database
warm retention. No pool state may be reported ready from these findings.

### Required pool acceptance

Start real unassigned slots before requests, then take at least two different hibernated databases
with no running per-database compute and assign them distinct slots from the shared inventory.
Preserve their committed data and isolation. Prove refill, assignment after a configuration change,
concurrent claims, controller restart, expired/uncertain claim, mixed-release rejection, exhaustion
fallback and clean destruction after use. The data path must never point to a previous tenant.

Measure twenty independent five-minute-idle pool-hit activations through normal Cloudflare SQL,
with connect_ms and first_read_ms from the same initial timestamp, plus separate30/120-minute
idle soaks. Show slot creation/readiness timestamps preceding the request, actual per-database
compute absence before assignment, slot/volume identities, resource use, hit/miss rate and refill
time. The subsecond first-read target applies to this path. A same-Pod warm/reclaim result cannot
replace it. Implementation and these real checks are required to complete the workstream.

## 5. Runtime states and idle policy

| State or policy | Physical state | Connection behavior |
| --- | --- | --- |
| `active` | PostgreSQL, its bound Pod and Barman run | Normal authenticated work |
| Always warm | The same running runtime remains available during idle periods | Normal warm connection; no reclaim or automatic hard sleep |
| `warm_idle` | The same PostgreSQL process and Pod run; selected cold memory pages may be reclaimed | Admission revokes further reclaim; the kernel brings back the pages actually needed |
| `waking` | A compatible prestarted pool slot is being claimed/bound, or the measured on-demand fallback is starting | Wait for the matching verified database-ready observation |
| `hibernated` | No per-database compute runs; persistent volume/data remains | Claim an eligible shared pool slot; use bounded on-demand fallback on a recorded pool miss |
| Explicitly `suspended` | Integrator/owner admission block with real CNPG hibernation | Refuse connections until an explicit authorized resume |

`warm_idle` is not a stopped database, a frozen process or zero resident memory. Kernel page-in on access is not restoration of a process snapshot. Host filesystem cache may survive real hibernation, but no cache-retention guarantee is made.

Retain `sleep_after_seconds: null` as always warm. For a finite idle threshold, add an explicit generic idle action: `hibernate` or `warm_reclaim`. The established behavior remains the default for existing policies; warm reclaim is enabled only for an approved compatible resource class and node. An optional later threshold may move a warm-idle database into real hibernation through the existing safe shutdown path.

Idle eligibility comes from authenticated activity and absence of running work. WebSocket pings and unauthenticated transports do not fabricate user activity. Open transactions, prepared work, uncertain activity history and incomplete gateway inventory continue to prevent unsafe sleep. Explicit suspend always preserves its admission block and the quiescence/WAL/R2/CNPG safety sequence. Warm wake or application early wake must never implicitly resume an explicitly suspended database.

## 6. Verified target publication and the gateway's warm cache

The controller publishes a versioned connection target only after it is bound to verified runtime state. The target includes:

- database and region identities;
- configuration revision, storage generation and route revision;
- Cluster identity and primary Pod/container identity;
- verified Pod IP and PostgreSQL port 5432;
- the independent TLS server name and current trusted CA identity/material;
- lifecycle operation and the execution/fence identity needed to reject stale targets.

The gateway caches this target and dials the verified Pod IP directly. **The dial address and TLS identity are independent.** Connecting by IP does not mean validating the certificate against that IP, omitting SNI or disabling hostname checks. Use the published expected TLS name, CNPG CA and verified identity even when Kubernetes Service DNS is avoided.

Invalidate the cache on primary Pod replacement, container replacement, storage-generation change, CA change, route/lifecycle change, deletion, node loss or a broken observation/watch continuity window. An IP can be reused by a different Pod; it is not sufficient proof of database identity. A connection failure does not authorize selecting an arbitrary Pod or replaying previously sent SQL.

The gateway retains a bounded cache and bounded refresh work. A missing or invalid target follows the authoritative preparation path. It must not dial a stale IP while pretending that a target refresh succeeded. New targets cannot become admissible until the corresponding lifecycle and Actor snapshot publication sequence completes.

## 7. Configuration fingerprints and runtime attestations

Separate configuration revision from power transitions and ordinary activity changes. Entering warm idle, canceling reclaim or recording activity must not cause a full configuration reapply, unchanged Secret replacement or resource patch that recreates the Pod.

The configuration fingerprint covers the PostgreSQL configuration, resource policy, pinned image, role revisions and storage generation/identity. It is built from authoritative desired state and stored with the applied proof. Use role revisions or non-secret credential bindings; do not publish plaintext credentials or reversible fingerprints of passwords in diagnostics.

A runtime attestation binds that applied configuration to the actual Cluster, primary Pod and container, applied role revisions, storage identity and TLS/CA identity. It also binds the relevant observation/watch continuity and lifecycle/route revision. A fingerprint match proves configuration sameness; it does not on its own prove that the same process, volume or certificate is still in use.

For an unchanged same-process warm wake, the short path verifies the current route and valid runtime attestation, revokes the reclaim intent and preserves the applicable fence/admission guards. It does not repeat every unchanged configuration write and every full role/configuration scan on each connection. Full verification runs after configuration, role, image, storage, CA or runtime identity changes and as background reconciliation. A new Pod/container always obtains fresh runtime checks before admission.

This is an approved change to the guard model: identity-bound applied proofs and current runtime attestations replace repeated full checks on the unchanged warm path. It is not permission to treat an unbound hash, old Ready condition or missed watch event as a valid proof. Watch gaps and contradictory state invalidate the fast proof until fresh verification restores continuity. Archive-health reporting retains its existing distinction between initial creation/restore gates and established database availability.

## 8. Native gateway transport and activity

The Rust gateway owns token verification, StartupMessage parsing, actual database/user matching, PostgreSQL TLS, raw stream forwarding, cancellation, connection activity and control/fence handling. The initial Rust version preserves SCRAM passthrough to PostgreSQL.

Use asynchronous bounded tasks and reusable buffers with explicit connection/database/gateway budgets. Combine framing and PostgreSQL activity observation so the same stream is not repeatedly parsed or retained by independent observers. Track only the bounded protocol state needed for authentication, transactions and pipeline safety; do not retain SQL or password bodies for diagnostics.

Preserve SSL/GSS preludes, startup deadlines, CancelRequest, authentication results, prepared statements, transactions, binary COPY fidelity, frame fragmentation limits, slow-reader backpressure and drain/close behavior. TLS and WebSocket framing can require copies; the design seeks controlled allocation and avoids promising a universally zero-copy stream.

Only actual AuthenticationOk starts authenticated activity. Unknown pipelined outcomes become transport failure. Neither a target refresh, a gateway restart nor a new implementation is allowed to replay a write whose outcome is uncertain.

The gateway loads persisted fences before accepting new database traffic. A partial list, watch discontinuity, fence UID replacement or stale operation/revision cannot silently reopen a database. Replacement processes publish new activity epochs; absent prior counters remain a measurement gap, not invented zero usage. Drain existing sessions during gateway deployment and retain bounded actual-close evidence for quiescence and retirement.

## 9. Event-driven lifecycle controller

The Rust controller replaces the entire first-party Node regional lifecycle implementation, including its safety, backup-health and usage behavior. Its connection/lifecycle path is:

1. Receive authenticated RegionLink hints containing database IDs.
2. Fetch authoritative desired state for those IDs through an authenticated regional API.
3. Put work into a bounded wake-priority queue with one serialized state machine per database.
4. Execute the current revision and observe Kubernetes changes through List/Watch.
5. Verify the applicable configuration/runtime proof and publish the completed database observation immediately.

Hints are not executable desired state. Targeted pulls remain region/identity/revision checked; periodic complete desired pulls repair missed hints. Complete relists recover expired resource versions and broken watches. Absence from a partial pull or relist never means delete.

Node inventory, capacity, orphan discovery, backup-size walks, archive telemetry and usage metering run as separate bounded background work. A completed database wake does not wait behind unrelated database reconciliation, a full node inventory or R2 listing.

Immediate database observations need a contract that explicitly distinguishes partial database updates from a complete regional inventory. Omitted coverage means unchanged/unknown, not an empty inventory. In particular, posting one ready database with no orphan scan must not replace a previously recorded orphan report with an empty list. Only a completed, authenticated, identity-checked inventory snapshot may update that inventory's coverage. Add this distinction to the shared contract before using the new fast publication path.

The controller resumes persisted storage ledgers, power progress, fence UIDs, archive timers and metering outboxes across deployment. It does not regenerate role Secrets or create empty storage because an older process stopped. Regional state remains execution progress and observations; Cloudflare remains authoritative for desired state, placement and admission policy.

## 10. Full Rust/Wasm Edge and Actor admission snapshots

The complete Edge application moves to Rust/Wasm, using Cloudflare's host bindings. Cloudflare documents [Rust Workers](https://developers.cloudflare.com/workers/languages/rust/); this is a Wasm Worker, not a native regional daemon.

Keep the existing DatabaseActor binding and RPC boundary for wake/admission and cancellation. Keep VPC HTTP through the regional Tunnel as the accepted transport seam and the signed Tunnel alternative where configured. The Rust host adapter calls the actual binding with the runtime Request, deadlines, cancellation and upgrade headers.

On a successful upgrade, return the **unopened upstream WebSocket** to Cloudflare. Do not accept it in application code, attach a Wasm SQL relay, or forward every byte through a JavaScript wrapper. Generated Wasm binding glue is part of the Rust build; a separately maintained TypeScript Edge wrapper is not the target.

The Actor keeps a versioned admission/route snapshot for known databases and roles. Ordinary warm connections can use that current snapshot without a D1 read per connection. Preserve current network/database admission limits, unknown-ID refusal and bounded failure sockets. The snapshot is seeded and updated through trusted control-plane paths; untrusted hints cannot repair authoritative state or allocate unrestricted persistent records.

### Mutation barrier

Every control-plane mutation that can invalidate admission or routing must pass through the affected Actors' mutation barrier. This includes role/configuration changes, suspension/deletion and relevant project, node, storage and route changes.

The required order is:

1. Enter the affected Actor barrier and stop admission from the old snapshot.
2. Perform the guarded authoritative D1 commit.
3. Execute the resulting regional desired state where needed and obtain the verified target for the new revision.
4. Publish the matching versioned Actor snapshot.
5. Reopen admission only after the barrier and snapshot refer to the committed current state.

Barrier state survives Actor/process interruption. If execution or snapshot publication is interrupted, reconcile from D1 and current regional proof before reopening. A timeout or lost response must not reopen the old snapshot merely because a mutation's outcome is unknown. Keep barriers limited to affected identities rather than installation-wide admission.

Routing tokens carry the route revision, and the gateway checks it against the current admitted target/fence. Version the internal token contract and use an explicit temporary compatibility rollout when adding this field; the final native path does not silently accept a missing revision. Do not equate the new route revision with unchanged configuration or fabricate ready state from a requested wake.

## 11. Authentication sequence

The first Rust gateway preserves PostgreSQL SCRAM passthrough. This gives a direct compatibility boundary for the transport and lifecycle migration.

A later, separately accepted authentication module may validate a client while compute preparation proceeds, using a versioned SCRAM contract bound to the same verifier, salt and role revision as PostgreSQL. Neon's pinned [classic authentication backend](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/auth/backend/classic.rs#L13-L55) is a reference for that separation, not a drop-in implementation for unmodified PostgreSQL.

The later module must define and verify both client-facing and backend authentication against unmodified PostgreSQL. A cached verifier is not a blanket authorization to open a backend connection. Role rotation, revocation, a stale verifier, wrong password, unknown role and backend mismatch must fail consistently before admission. Retain least-privilege custody of authentication material and never log it.

Successful proxy-side authentication cannot bypass PostgreSQL's authentication or the target/fence guards. No authentication change is bundled into the first gateway port, and no connection pooling or uncertain-write replay is introduced as an incidental consequence.

## 12. Additional warm reclaim and the node-local reclaimer

This mode is additional to the required shared compute pool in section4. It may optimize an
already assigned idle runtime; it is not pool implementation or evidence for pool-hit latency.

Warm reclaim retains the same database Pod and PostgreSQL process while asking the kernel to recover selected cold memory pages. Talos encrypted swap and optional zswap provide the approved OS path. Do not assume that a custom zram service is available or required. See the pinned [Talos SwapVolumeConfig](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/config/types/block/swap_volume_config.go) and [ZswapConfig](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/config/types/block/zswap_config.go).

The reclaimer is a separate DaemonSet/binary on explicitly approved worker nodes. It is not part of the regional controller Pod and does not give the controller a writable host cgroup mount. The current control-plane/worker baseline remains outside the swap/reclaim trial; enable the trial only on a separately accepted, isolated Dev worker.

### Authorization and scope

A short-lived reclaim authorization binds database ID, operation/revision, node UID, namespace/Cluster/Pod UID, container identity, storage generation, permitted reclaim budget and expiry. The reclaimer verifies local identity and derives the target cgroup from trusted local workload inventory. The caller cannot supply an arbitrary filesystem path.

Reclaim is restricted to the authorized PostgreSQL container and bounded reclaim interface. Exclude the node's system/control-plane services and unrelated containers. The reclaimer receives no PostgreSQL password, no D1 write authority and no general container-runtime control capability. Host access and the service account remain separate from gateway/controller rights.

Use small bounded reclaim steps and report their actual results. An expired lease, identity change, controller loss or revoked intent stops further steps. A reclaim failure is neither proof of hibernation nor proof of database failure. PostgreSQL remains running.

The next admitted connection or authenticated early wake revokes the reclaim intent and stops scheduling more steps before using the warm path. A kernel reclaim call already in progress may finish; cancellation does not promise immediate interruption of that call. Its effect on first-read latency is part of acceptance.

### Resource configuration

Warm-reclaim classes explicitly configure **PostgreSQL memory request below its memory limit**. Set this resource policy once when creating or deliberately converting the class. Do not patch requests on every idle entry/exit: CNPG resource changes can replace the Pod and defeat same-runtime warm wake.

The PostgreSQL memory ceiling remains explicit. Under the current owner-approved actual-use model,
placement uses fresh physical headroom and bounded simultaneous-start admission. CPU request and
burst limit are separate; confirmed Pod-cold hibernation releases active compute accounting.
Warm-idle PostgreSQL/Barman Pods remain alive and retain honest scheduling demand and measured
usage. Lower requests alone do not implement safe wake admission or resource accounting.

The total Pod already includes a Barman sidecar whose request and limit differ; Pod QoS alone does not establish that the PostgreSQL container can use the intended swap allowance. Verify the actual PostgreSQL request/limit, kubelet LimitedSwap policy, container swap limits and exclusions. The pinned [Kubernetes 1.36 swap documentation](https://v1-36.docs.kubernetes.io/docs/concepts/cluster-administration/swap-memory-management/) is the baseline for this verification.

Before enabling reclaim, verify encrypted swap, free disk capacity, actual node/container configuration, zswap behavior if enabled, and unaffected system/control-plane services. Keep PostgreSQL, CNPG probes and Barman operational. Do not suppress their health/backup work to obtain an artificial idle-memory result.

### Metrics and economic limits

Warm idle continues to count as awake/running compute. Report active, warm-idle and hibernated durations separately alongside reserved resources, actual resident memory, swap/zswap observations, page-in behavior and named measurement gaps.

Reduced resident memory does not mean zero RAM or accepted higher density. The owner has now
required removal of permanent sleeping compute and blanket logical-disk reservations; implement
that model with atomic wake admission, physical storage headroom and real density evidence.
Prices and billing remain integrator concerns. Encode the explicit owner-selected76% regional V159
policy with the latest3-managed-VPS ceiling per region and75%/cap notifications; monetary/order
ceilings remain optional. Keep the operator-selected cap intact during runtime migration.

## 13. Early wake and readiness

Authenticated early wake may overlap preparation with a real application-entry action. It uses the same lifecycle/coalescing path and may cancel idle reclaim or wake idle hibernation. It does not undo explicit suspension.

Accepted request, delivered hint, revoked reclaim, removed hibernation annotation and started Pod are distinct from **ready**. Release connection waiters only when the current route, configuration/runtime proof, storage/TLS/role identity and required fence state match the current committed lifecycle revision.

Report actual runtime activation separately from time between the user's application action and the first database-dependent response. Starting work earlier can improve the latter without making a true cold Pod wake subsecond. For warm reclaim, do not preload all database memory before declaring readiness; validate the current process and measure the pages required by the real first query.

## 14. Migration and deployment

Implement the approved architecture in this order:

0. **Shared pool/storage integration:** prove and implement the prestarted unassigned-runtime
   boundary and data/CNPG late binding from section4. Resolve incompatibilities explicitly; the
   pool must not be dropped or replaced by warm reclaim. This informs the controller contract.
1. **Rust gateway:** preserve current contracts, authentication passthrough, protocol behavior and persisted fences; qualify the image and live Dev route.
2. **Rust controller and bootstrap relay:** replace the full regional Node server implementation; implement shared-slot preparation, exclusive assignment, refill, retirement and observations alongside targeted desired-state execution; preserve persisted progress.
3. **Warm routing and fingerprints:** publish identity-bound direct targets, separate configuration and activity/power revisions, and implement same-runtime attestations.
4. **Rust/Wasm Edge and Actor snapshots:** preserve real VPC HTTP/unopened-WebSocket forwarding and add the mutation barrier plus versioned route snapshots/tokens.
5. **Shared-pool Dev acceptance:** execute the section4 multi-database, isolation, refill, restart, exhaustion and subsecond pool-hit first-read checks.
6. **Additional warm-reclaim acceptance:** configure an approved resource/node policy and measure its separate same-runtime behavior; it cannot close the pool gate.
7. **Later independent work:** proxy SCRAM, process/VM snapshot research and optional native CLI stream handling.

The controller handoff retains a single reconciler per region. Use the existing `Recreate` ownership model, stop the previous process and confirm termination on a reachable node before starting its replacement. Do not force-delete an uncertain old Pod and allow two executors during a partition. Resume from current Cloudflare desired state and the existing storage/power/fence records; preserve credential Secret UIDs and versions when unchanged.

Gateway deployments drain actual sessions. New replicas load complete persisted fence state before readiness. During mixed implementation rollout, both versions follow the same control/activity contracts and gateway inventory rules; an incomplete or changing inventory cannot authorize hibernation. Watch gaps invalidate current proofs until recovery, rather than silently accepting stale cache state.

After each native replacement is accepted in Dev, remove its unused TypeScript server implementation and deployment/build path. Retain rollback through Git history and qualified pinned images, not parked code or branches. The management TypeScript applications and initial Node tooling remain intentional components.

## 15. Acceptance and measurements

All acceptance uses real harness-owned Dev systems through the normal Cloudflare-to-gateway-to-PostgreSQL path. No product mocks, synthetic product data, new paid resources or production deployment is authorized by this document.

### Compatibility and safety

- Preserve negative authentication, unknown hints and startup database/user mismatch rejection before PostgreSQL dial; verify routing-token and TLS interoperability.
- Run real commit/rollback, prepared statements, transactions, cancellation and binary COPY integrity; verify slow readers, bounded buffers, close/drain and no replay of uncertain writes.
- Rotate roles and CA/target state, replace the primary Pod, and prove stale route/fingerprint/attestation rejection, unchanged-storage protection and fresh checks for a new runtime.
- Restart gateway, controller and reclaimer; break/recover watches and desired-state hints; preserve fence, storage, Secrets, progress, usage gaps and one-reconciler behavior.
- Exercise Actor mutations, interrupted guarded D1 commits and interrupted snapshot publication; prove no stale snapshot reopens admission, explicit suspension stays blocked and partial observations do not clear unrelated inventory/orphan state.
- Re-prove real CNPG hibernation/wake, quiescence, closed-WAL/R2 acknowledgement and backup behavior. Ten concurrent connections coalesce to one activation/reclaim revocation as appropriate.

### Comparable timings

Use the same pinned driver/client settings, source region, database class and endpoint for comparable samples. Record `connect_ms` from immediately before `Client.connect()` to successful connection and `first_read_ms` from that same start through the complete validated marker result. Record an established-session read separately. Label the physical precondition: always warm, warm idle with reclaim, or truly hibernated.

Record p50/p95/max, all sample outcomes and the exact versions/digests. Twenty samples use the existing nearest-rank percentile definition; they are bounded Dev acceptance, not a production p99 or latency guarantee.

The mandatory shared-pool series is specified in section4. Pool hits, pool misses, already-warm
and warm-reclaim activations have separate labels and results.

For the additional warm-reclaim series, run **twenty independent cycles with five minutes of idle time before each first connection/read**. Each cycle proves the intended idle/reclaim state, same Pod/container/process and Cluster/PVC/storage identities, committed-marker preservation, rollback absence and actual memory/swap observations. Close the client and independently re-establish the next idle cycle. Compare with twenty always-warm fresh connections using the same connect/first-read definitions.

Add separate **30-minute and 120-minute idle soaks**, followed by the same first connection/read and safety checks. These longer soaks expose pages brought back by probes, Barman, background activity and kernel behavior; they are not a concurrency/class/language matrix. Keep true Pod-cold samples separate and independently prove removed/replaced Pods.

Measure resident memory and swap/zswap before reclaim, after idle and after the first query; page-in activity, CPU, gateway/controller memory, relevant throttling, backup/WAL progress and the effect of an in-progress reclaim call. Report explicit unknowns rather than equating missing telemetry with zero consumption.

### Attribution and outcome

Correlate client, Edge/Actor, controller, Kubernetes/PostgreSQL and gateway stages by database, operation, revision and Pod identity. Use local monotonic durations and retain explicit gaps between different clocks. Distinguish configuration work, runtime verification, publication, network/TLS/authentication and memory page-in; do not add phase percentiles or compare different timer endpoints.

The first successful read below one second after assigning a shared prestarted compute remains
the required pool-hit target. Already-warm/reclaim measurements are additional evidence. If a run misses it, retain the chosen Rust architecture, record the measured result and identify the remaining constraint. Do not relabel Pod-cold activation, omitted query time or a preload-only result as a successful warm-path measurement. Completed outcomes are recorded in PLAN.md Status.

## 16. Later research boundaries

Freezing a process, CRIU/container checkpoints and microVM snapshots are separate compute-lifecycle research. Warm reclaim does not require them and does not imply that their socket, storage, credential, WAL or runtime-restoration problems have been solved.

The shared prestarted compute pool is required work in section4, not later research. Its local
storage/CNPG assignment constraints must be resolved as part of implementation. A complete Neon
Pageserver/Safekeeper storage replacement, branching, a shared tenant PostgreSQL process and
per-database automatic compute resizing are not implied by the pool requirement. Any additional
architecture change required for correct late binding must be identified and resolved explicitly.

The approved target is a native Rust regional stack and full Rust/Wasm Edge, with a shared pool
of prestarted unassigned compute, configuration-aware assignment, cached verified routing and
safe hibernation. Warm reclaim remains an additional optimization for an assigned runtime.
