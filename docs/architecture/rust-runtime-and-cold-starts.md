# Rust runtime and cold-start architecture

Approved: **2026-10-05**. **The target architecture is approved. The native regional controller
and gateway are implemented and deployed on the EU fleet; the Rust/Wasm Edge and the native
bootstrap relay are built and not deployed, and the shared pool of prestarted compute is not built.**

Owner correction (2026-10-08): the [unified control/capacity/release plan](cloudflare-convergence-and-serverless-plan.md)
requires the actual-use resource model and uniform automatic fleet patching as part of completion.
Earlier clauses preserving full sleeping CPU and logical disk reservations are superseded below.

The texts of 2026-10-05 and 2026-10-08 required Neon's **shared pool of prestarted, unassigned
compute** before go-live. The owner decided on 2026-10-15 that the go-live path reaches a sub-second
wake through the parked sleep tier, which keeps the database's instance Pod
and stops only PostgreSQL, and that the shared pool is deleted. Section 4 records why the pool is
not built.

The [ULTRA plan](cloudflare-convergence-and-serverless-plan.md) is the canonical delivery sequence and Done/Open status, linked from [PLAN.md](../../PLAN.md). This document describes the architecture and its migration boundaries; the table in section 3 states which component is deployed. Completed results belong in the ULTRA Done/Open tables.

## 1. Decision and purpose

Rust is the chosen implementation language for the first-party regional server applications: the PostgreSQL gateway, the entire lifecycle controller and the bootstrap byte relay. The entire Edge Worker also moves to Rust compiled to WebAssembly. TypeScript remains the language of the management API, DatabaseActor, RegionLink and Workflows. The CLI and node-bootstrap orchestration remain Node.js initially. No first-party Go implementation is planned.

The migration combines a native runtime with changes to the connection and lifecycle paths. It does not consist only of translating the existing reconciliation loop. The controller becomes event-driven, publishes ready database observations immediately, retains verified runtime state, and keeps inventory and metering work outside the wake path. The gateway connects through an identity-bound direct target cache. The Actor provides a versioned admission snapshot without a D1 read on every ordinary warm connection.

Measurements validate this chosen architecture, establish its operating limits and guide subsequent improvements. Profiling is not a prerequisite for the Rust decision. Rust itself does not remove PostgreSQL startup, Kubernetes scheduling, network round trips or the memory occupied by a running database.

The latency objective is **a first successful read below one second when a sleeping database
is woken onto a runtime that already exists**, including ordinary client connection and
authentication: its parked instance Pod. Already-running warm connections, optional warm reclaim and the ordinary wake of a fully
hibernated database are separate measurements. An already-warm connection does not satisfy the
target. This is a required Dev acceptance target, not an existing service guarantee.

## 2. Current implementation and evidence

The regional controller and gateway are the native Rust binaries and run on the EU fleet
(Deployments `pgcf-agent` and `pgcf-gateway`); both remain running while an individual database
hibernates. The Edge Worker is the TypeScript `apps/edge`, and the bootstrap relay on EU control is
the TypeScript relay of `apps/regional`; their Rust replacements are built and not deployed. CNPG
hibernation removes PostgreSQL Pods and retains the database's local LVM-backed PVC. Waking that
database therefore recreates PostgreSQL runtime state; it does not start a new regional process.
The [pool](cloudflare-convergence-and-serverless-plan.md#pool-design) instead attaches the
volume to an already running, free PostgreSQL instance on the node.

The ULTRA plan's Done table holds the measured wake and awake numbers. The cold series measured
`Client.connect()` and validated the marker query afterwards, outside that timer, while an
always-warm diagnostic measured new connection plus first read (p95 734.438 ms); these values have
different endpoints and must not be subtracted to estimate orchestration overhead. Future
acceptance records connect and first-read durations for both warm and cold samples.

The native controller is driven by RegionLink hints and a bounded wake-priority queue, and the
PostgreSQL startup/readiness probes are configured at one second.

## 3. Component ownership and build boundaries

| Component | Approved target | Deployed on the EU fleet | Responsibility |
| --- | --- | --- | --- |
| Management API | TypeScript Worker | TypeScript Worker | Management, authorization, authoritative D1 state and installation policy |
| DatabaseActor | TypeScript Durable Object | TypeScript Durable Object | Admission snapshots, mutation barriers, wake coalescing, idle policy and lifecycle decisions |
| RegionLink | TypeScript Durable Object | TypeScript Durable Object | Authenticated regional connection and non-authoritative desired-state hints |
| Workflows | TypeScript | TypeScript | Provisioning, restore and other long operations |
| Edge Worker | Full Rust/Wasm Worker | TypeScript `apps/edge`; `apps/edge-rust` is built, not deployed | Request validation, admission orchestration, routing-token signing, transport selection and bounded refusals |
| Regional gateway | Native Rust binary | Native Rust (`apps/native-gateway`) | WebSocket/PostgreSQL transport, token/startup validation, TLS, activity and persisted fences |
| Regional controller | Native Rust binary | Native Rust (`apps/native-controller`) | Desired-state execution, readiness, watches, configuration/runtime proofs, health and observations |
| Bootstrap byte relay | Native Rust binary | TypeScript relay (`apps/regional`); `apps/native-bootstrap-relay` is built, not deployed | The existing authorized byte-relay function with bounded streams and independent workload rights |
| CLI and node-bootstrap tooling | Node.js initially | Node.js | Local client bridge and long-running provisioning orchestration; optional later native work |
| PostgreSQL, CNPG, Barman, Talos and Kubernetes platform | Unmodified pinned upstream components | Unmodified pinned upstream components | Database engine, backup, operating system and orchestration |

Use one Rust workspace with a portable protocol/contract core and separate host implementations. Produce separate binaries and images for gateway, controller and relay. Separate images permit independent deployment and retain separate service accounts, host access and resource limits. A common workspace is not a reason to grant the controller host privileges or to run every mode in one process.

The portable core is shared by native applications and the Wasm Edge. It contains bounded protocol parsing, routing-token primitives, generated contract types/constants and related validation. Kubernetes clients, native sockets, Cloudflare host bindings and node filesystem access stay outside it. Do not add per-frame Node/Rust IPC or a Rust sidecar behind a Node data relay.

Pin the Rust toolchain, dependency lockfile, build inputs and runtime-image digests when implementing the components. Retain upstream notices in THIRD_PARTY.md. Extend the existing single CI workflow with Rust build, conformance, tests and image qualification rather than introducing a second workflow or a language/load test matrix.

## 4. Shared pool of prestarted compute (not built)

Neon starts unassigned compute before demand, applies configuration only when a connection needs
it, and shortens routing and readiness work
([Cold starts just got hot](https://neon.com/blog/cold-starts-just-got-hot)). PGCF answers the same
question for a database that slept recently with the parked sleep tier: the
instance Pod, volume and sidecar stay and only PostgreSQL stops, so the next connection unfences a
Pod that already exists. A database that is demoted, or that has been hibernated, takes the ordinary
CNPG wake. The owner decided on 2026-10-15 that this replaces a shared pool of unassigned compute
(alternative 8), whose code, tables and image were deleted; git history is the archive.

The platform facts that made the pool expensive stay true and bound any later design:

- The pinned CNPG 1.30.1 and CNPG-I 0.6.0 have no operation that assigns an already running generic
  Pod to a Cluster. Instance Pods are created with Cluster-derived names, namespace, environment
  and the retained instance PVC, hibernation resume creates a new Pod, and the instance manager
  starts with a fixed Cluster/Pod/namespace/PGDATA identity
  ([pods.go](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go),
  [cluster_create.go](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_create.go),
  [instance manager](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/cmd.go)).
  Kubernetes 1.36.5 waits for attachment and mounting before it invokes the container runtime, so
  a generic Pod waiting for an unbound tenant PVC is not a running slot
  ([kubelet.go](https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet.go#L2195-L2241)).
- Prepared compute would therefore have to sit **below Pod identity**, at the CRI sandbox boundary.
  VM-cache designs such as [Kata 3.32.0 QEMU VMCache](https://github.com/kata-containers/kata-containers/blob/3.32.0/docs/how-to/what-is-vm-cache-and-how-do-I-use-it.md)
  need KVM. The 2026-10-08 observation found no `/dev/kvm` and no `vmx` or `svm` flag on the three
  retained nodes, and Contabo's
  [nested-virtualization policy](https://help.contabo.com/en/support/solutions/articles/103000271595-can-i-setup-nested-virtualization-on-my-server-)
  excludes VPS, so a software-only factory or virtualization-capable hardware would be required.
- containerd's RunPodSandbox path requires Pod metadata and generates a new sandbox ID, so it is
  not a later-assignment operation
  ([sandbox_run.go](https://github.com/containerd/containerd/blob/v2.3.5/internal/cri/server/sandbox_run.go#L52-L165)).
  The region's `compute_pool` slots prepare only namespace holders and runc task services under
  ordinary CNPG-created Pods; they never hold PostgreSQL data or a database identity.

A same-Pod parked, warm or reclaim result is the tier that is built; label it as such and never
present it as a hit of a pool.

## 5. Runtime states and idle policy

| State or policy | Physical state | Connection behavior |
| --- | --- | --- |
| `active` | PostgreSQL, its bound Pod and Barman run | Normal authenticated work |
| Always warm | The same running runtime remains available during idle periods | Normal warm connection; no reclaim or automatic hard sleep |
| `warm_idle` | The same PostgreSQL process and Pod run; selected cold memory pages may be reclaimed | Admission revokes further reclaim; the kernel brings back the pages actually needed |
| `waking` | The volume is attached to a free pool instance, or CNPG creates a new instance Pod | Wait for the matching verified database-ready observation |
| `hibernated` | No per-database compute runs; persistent volume/data remains | Ordinary CNPG wake: a new instance Pod starts on the retained volume |
| Explicitly `suspended` | Integrator/owner admission block with real CNPG hibernation | Refuse connections until an explicit authorized resume |

`warm_idle` is not a stopped database, a frozen process or zero resident memory. Kernel page-in on access is not restoration of a process snapshot. Host filesystem cache may survive real hibernation, but no cache-retention guarantee is made.

A database sleeps after its own `sleep_after_seconds` (60–900 s), else its size class's;
`sleep_after_seconds: null` on the class is always warm. A finite idle threshold puts the database to
sleep as CNPG hibernation. Warm reclaim is a separate per-database policy (`PUT /v1/databases/{id}/warm-reclaim`)
for an approved compatible resource class and a qualified node; a database with a qualified warm
policy never takes the idle-sleep path. An optional later threshold may move a warm-idle database
into real hibernation through the existing safe shutdown path.

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

Routing tokens carry the database generation and the verified primary Pod (v3) and, where the region's release
declares the admission snapshot, the independent route revision (v4); the gateway checks them against the current
admitted target and persisted fence. Do not equate the route revision with unchanged configuration or fabricate
ready state from a requested wake.

## 11. Authentication sequence

The first Rust gateway preserves PostgreSQL SCRAM passthrough. This gives a direct compatibility boundary for the transport and lifecycle migration.

A later, separately accepted authentication module may validate a client while compute preparation proceeds, using a versioned SCRAM contract bound to the same verifier, salt and role revision as PostgreSQL. Neon's pinned [classic authentication backend](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/auth/backend/classic.rs#L13-L55) is a reference for that separation, not a drop-in implementation for unmodified PostgreSQL.

The later module must define and verify both client-facing and backend authentication against unmodified PostgreSQL. A cached verifier is not a blanket authorization to open a backend connection. Role rotation, revocation, a stale verifier, wrong password, unknown role and backend mismatch must fail consistently before admission. Retain least-privilege custody of authentication material and never log it.

Successful proxy-side authentication cannot bypass PostgreSQL's authentication or the target/fence guards. No authentication change is bundled into the first gateway port, and no connection pooling or uncertain-write replay is introduced as an incidental consequence.

## 12. Additional warm reclaim

**Status.** The API policy is implemented; the node reclaimer binary was deleted (2026-10-15) and so
was the host extension's publisher (source; the deployed extension keeps publishing until the next
host release). No node is qualified and no database carries a policy. This mode is additional to
the pool. It may optimize an already assigned idle runtime.

Warm reclaim retains the same database Pod and PostgreSQL process while asking the kernel to recover selected cold memory pages. Talos encrypted swap and optional zswap provide the approved OS path. Do not assume that a custom zram service is available or required. See the pinned [Talos SwapVolumeConfig](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/machinery/config/types/block/swap_volume_config.go) and [ZswapConfig](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/machinery/config/types/block/zswap_config.go).

**Status (2026-10-15).** The node-local reclaimer binary and its image were deleted; no release contained it and nothing deployed it. The control-plane half remains: the API's per-database policy and per-node qualification endpoints, the signed reclaim scopes and the Actor's revoke barrier. The host extension's publisher is gone as well: it polled `GET /agent/v1/nodes/{id}/reclaim` about three times a second and published a task snapshot that no process read. Qualification requires a `node-reclaimer` image component in the release specification, so no node can qualify until a consumer and its publisher are built again and pass their own Dev acceptance.

A node-local reclaimer is a separate DaemonSet/binary on explicitly approved worker nodes. It is not part of the regional controller Pod and does not give the controller a writable host cgroup mount. The current control-plane/worker baseline remains outside the swap/reclaim trial; enable the trial only on a separately accepted, isolated Dev worker.

### Authorization and scope

A short-lived reclaim authorization binds database ID, operation/revision, node UID, namespace/Cluster/Pod UID, container identity, storage generation, permitted reclaim budget and expiry. The consumer verifies local identity and derives the target cgroup from trusted local workload inventory. The caller cannot supply an arbitrary filesystem path.

Reclaim is restricted to the authorized PostgreSQL container and bounded reclaim interface. Exclude the node's system/control-plane services and unrelated containers. The consumer receives no PostgreSQL password, no D1 write authority and no general container-runtime control capability. Host access and the service account remain separate from gateway/controller rights.

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
Prices and billing remain integrator concerns. This installation selects a76% regional RAM
threshold and V159; the threshold and automatic-purchase switch are management API configuration.
The owner removed the fixed three-node ceiling and personal notifications. Fresh defaults do
not purchase or send email. Optional operator-configured limits and generic notification delivery
remain configurable and must retain their selected values during runtime migration.

## 13. Early wake and readiness

Authenticated early wake may overlap preparation with a real application-entry action. It uses the same lifecycle/coalescing path and may cancel idle reclaim or wake idle hibernation. It does not undo explicit suspension.

Accepted request, delivered hint, revoked reclaim, removed hibernation annotation and started Pod are distinct from **ready**. Release connection waiters only when the current route, configuration/runtime proof, storage/TLS/role identity and required fence state match the current committed lifecycle revision.

Report actual runtime activation separately from time between the user's application action and the first database-dependent response. Starting work earlier can improve the latter without making a true cold Pod wake subsecond. For warm reclaim, do not preload all database memory before declaring readiness; validate the current process and measure the pages required by the real first query.

## 14. Migration and deployment

The dependent runtime pieces below are delivered through R1/R2 of the [ULTRA plan](cloudflare-convergence-and-serverless-plan.md#delivery-architecture). Status:

1. **Rust gateway:** implemented and deployed; it preserves the current contracts, authentication
   passthrough, protocol behavior and persisted fences.
2. **Rust controller:** implemented and deployed; it replaced the full regional Node server
   implementation and preserves persisted progress. **Bootstrap relay:** the native replacement is
   built and not deployed; a release that pins `native-bootstrap-relay` selects it.
3. **Warm routing and fingerprints:** implemented in controller, gateway and API: identity-bound
   direct targets, separate configuration and activity/power revisions and runtime attestations.
   Route token v3 and attestation V1 run today; attestation V2, the admission snapshot and route
   token v4 ship with the go-live release.
4. **Rust/Wasm Edge and Actor snapshots:** the Actor's mutation barrier and versioned route snapshots
   are implemented in the API; the Rust/Wasm Edge preserves real VPC HTTP/unopened-WebSocket
   forwarding, is built and is not deployed.
5. **Sub-second wake acceptance:** the go-live acceptance is a pool hit through the normal
   Cloudflare path (go-live path: cold request under one second).
6. **Optional later warm reclaim:** evaluate separately; it is not a customer-readiness gate.
7. **Later independent work:** proxy SCRAM, process/VM snapshot research and optional native CLI stream handling.

The controller handoff retains a single reconciler per region. Use the existing `Recreate` ownership model, stop the previous process and confirm termination on a reachable node before starting its replacement. Do not force-delete an uncertain old Pod and allow two executors during a partition. Resume from current Cloudflare desired state and the existing storage/power/fence records; preserve credential Secret UIDs and versions when unchanged.

Gateway deployments drain actual sessions. New replicas load complete persisted fence state before readiness. An incomplete or changing inventory cannot authorize hibernation, and watch gaps invalidate current proofs until recovery, rather than silently accepting stale cache state.

After each native replacement is accepted in Dev, remove its unused TypeScript server implementation and deployment/build path. The TypeScript agent and gateway sources remain only as the reference of the native conformance generators and test harnesses until their constants move into the contracts; the TypeScript relay and Edge remain until their replacements are deployed. Retain rollback through Git history and qualified pinned images, not parked code or branches. The management TypeScript applications and initial Node tooling remain intentional components.

## 15. Acceptance and measurements

The [ULTRA plan](cloudflare-convergence-and-serverless-plan.md#node-acceptance) defines the six
functional node checks. Its sub-second wake step requires a woken parked database's first SQL
below one second through the normal Cloudflare path. Run these on Dev.
Focused regression tests cover changed authentication, TLS, fencing, claims, isolation and
uncertain-write behavior. Reuse valid unchanged results; do not introduce a second live test matrix.

Record the physical starting state and selected release. Measure `connect_ms` and `first_read_ms`
from the same instant before connection; the latter includes the complete validated marker query.
Label parked hits, demoted or hibernated misses and already-warm connections separately. Retain observed failures and unknowns. A slot-assignment duration alone is not SQL
latency. No fixed repeated-cycle count,
long laptop monitor or mandatory idle-soak series remains. If the target is missed, document the
actual limiting stage and fix that observed class. Record completion in the ULTRA plan.

## 16. Later research boundaries

Freezing a process, CRIU/container checkpoints and microVM snapshots are separate compute-lifecycle research. Warm reclaim does not require them and does not imply that their socket, storage, credential, WAL or runtime-restoration problems have been solved.

A shared pool of prestarted unassigned compute is not built (section 4). A complete Neon
Pageserver/Safekeeper storage replacement, branching, a shared tenant PostgreSQL process and
per-database automatic compute resizing are not planned either; each would be a separate
architecture decision.

The approved target is a native Rust regional stack and full Rust/Wasm Edge, with cached verified
routing and safe hibernation and a parked sleep tier for the first sub-second wake. Warm reclaim
remains an additional optimization for an assigned runtime.
