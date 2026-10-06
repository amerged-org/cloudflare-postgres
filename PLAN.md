# cloudflare-postgres — Plan

Status (2026-10-06): **Phases 0 and 1 accepted in Dev; operator completion is in progress.**
The first EU node and five Flux platform releases are Ready, with 95 GiB measured storage.
Its node identity, storage and protected cluster custody are preserved. The second existing EU
VPS has passed signed network verification and admission, with 95 GiB measured capacity.
Actual capacity demand placed databases on both EU nodes and SQL passed through Cloudflare.
No US VPS has been bought and no customer or platform
production database has been migrated. The initial topology remains two EU VPS and one US VPS.
The US Cloudflare region, separate archive bucket, scoped S3 credentials, private data Tunnel
and gateway VPC service are configured. The private bootstrap relay now allows both EU and US.

The current regional image is
`sha256:53f9aaafdbda2f776a3ba20691f01a6ed6376638f02dcf436332b5056f54f735`
from `ab678993`, CI `37419289338`. Qualification covered 658,584,124 bytes and ten layers with
zero unresolved findings. Anonymous manifest, configuration and every compressed/uncompressed
layer verification passed, with 89,764,233 compressed bytes read back. Agent, both gateways and
five platform releases remained Ready for 69.78 s. Both EU Node UIDs, all three test databases'
namespace/Cluster/PVC/PV/Secret identities and three EU encrypted custody records are preserved.
The management API and Edge use `ab678993`; the private bootstrap
Workflow, Container and VPC bindings are activated. EU firewall/rescue/operator-source
inputs are now bound. The current native bootstrap image is
`sha256:1b9a38a4e43ba87ef997eab71ed6799a3c4377cca00485f842e693ebac371923`
from `cf6d5d55`: qualification covered 711,913,354 bytes and 18 layers with zero unresolved
findings, followed by exact private-registry manifest, configuration and layer readback.
The exact application/namespace binding and completed rollout retain that image. Its running
instance was verified during EU2 admission; the application is currently inactive with zero
instances. Latest complete CI `37419289338` is green. US installation and cross-region node-loss
recovery remain outstanding.
Release image signing remains Phase 5 work.

Phase 1's earlier real E0–E6, five create/delete cycles and ten agent restarts passed the complete
API/D1/RegionLink/agent/Tunnel/VPC HTTP/gateway path through `db.ohmyho.st`, with verified
PostgreSQL TLS and no public PostgreSQL port. Backup alarms, source-preserving R2 restore,
missing-ready-namespace protection and full storage reclamation passed. Ordinary deletion retains
archives; the harness purges only its own test objects. API PITR and restore after source deletion
have since passed as recorded below; node-loss and regional disaster recovery remain outstanding.

Phase 2's last complete cold series measured p50/p95/max 8.412/9.160/9.708 s across twenty
independent wakes, twenty distinct Pods and the same cluster/PVC. Each caused one wake and one
configuration revision, preserving data, rollback absence and role Secret identities. On 2026-10-05
the owner accepted the current cold-start times for v1. The original ≤8 s p95 target no longer
blocks current acceptance. The approved Rust runtime and cold-start workstream is described below
and in [the architecture proposal](docs/architecture/rust-runtime-and-cold-starts.md).
Ten simultaneous cold connections coalesced to one wake. A real
read-only transaction prevented idle sleep for 74 s. An always-warm diagnostic measured new
connection plus first read p95 734.438 ms; it is not an application or load-capacity guarantee.
Suspend/resume secured the closed WAL in R2. Hourly awake-time deviation was at most 19.748 s,
below the 60 s target. Resize preserved storage/data in 28.046 s; held-client reconnect counts
remain unmeasured. RAM/storage allocation and connection usage are measured. The new authenticated
kubelet collector measured 185,159,680 used bytes of a 5,368,709,120-byte volume on the recovery
source; missing volume observations remain unknown. Cost attribution is deferred: the owner supplied 13.55 EUR per existing
VPS per month. PGCF supplies resource/consumption metrics; adopter pricing and billing remain
exclusively in the adopter repository.

`pgcf connect` passed actual psql transactions, rollback and 105,216,021 identical binary COPY
bytes. The bridge now refuses MD5 and unknown authentication methods; all 30 CLI tests passed.
Unknown hints avoid D1 and gateway work. A shared Worker source address has no installation-wide
connection limit. Raw 100 MiB/1 GiB integrity, slow reception and 600 s idle passed. The earlier
735.604 SQL/s read test is a bounded measurement, not maximum throughput or customer density.
Decoded binary-result mode remains unsupported; raw COPY and default-text clients pass.

The current image's first fresh E3 failed its required Tail event and was cleaned up. A second
trial passed E0–E5, including exact 28P01 negative authentication, both correlated startup
mismatches, real R2 backup and zero remaining volumes/archives. Deletion took 103.498 s;
separate run cleanup passed. The earlier missing Tail event remains unexplained; bounded failure
diagnostics now retain counts and stages without trace content. Four diagnostic cold starts took
8.645/9.772/9.057/9.695 s with one wake and preserved data. Two initial Cluster PATCH failures
reported Invalid, unchanged UID and changed resource version; a server-only stale-version dry-run
also returned generic Invalid. The exact live rejection cause remains unproven. These four runs
do not replace the historical twenty-run measurement; its current latency is accepted for v1.

Archive-availability and authenticated-idle fixes are integrated and pass local checks, with API
delivery required before the new regional producer. Established readiness keeps every physical,
configuration, TLS, role and post-authentication identity guard but no longer depends on available
archive telemetry. Unknown health remains explicit and alarms after ten minutes across restart.
Only AuthenticationOk starts idle activity; quiescence drains pre-auth transports through bounded
actual close, preserving raw transport counts, authenticated transactions and SQL/WAL safety.
Unknown pipelined outcomes surface as transport failure and are never replayed. Backup metering
now walks up to 16 pages/16,000 objects within one two-second deadline and a 4 MiB key budget;
incomplete or oversized walks remain unknown. The scan is an interval observation, not an atomic
R2 snapshot. Tests pass: contracts 129, API 302, Edge 78, regional 385, native 27, CLI 30, harness
204, infrastructure 21 and CI logic 68, with zero skipped tests. API and regional delivery are
complete; their fresh E0–E5 passed, with deletion in 101.563 s and zero trial volumes/archives.
Two actual unknown archive-health observations preserved ready state and successful SQL;
the temporary metrics-only deny was removed and health recovered. An unauthenticated SCRAM
session with WebSocket pings did not prevent idle hibernation (82.635 s; no password or
AuthenticationOk). The ten-minute unknown alarm is locally tested, not yet live-proven. The later lazy
Actor schema patch passed all 304 API tests: unknown hints create no application tables, while
validated management seeding preserves existing persistent state. Its live delivery remains pending.

Phase 3 software and native images are delivered, not live-accepted. The Dev D1 export restored
locally with clean integrity/foreign-key checks; four additive bootstrap migrations rehearsed
against that export and applied in Dev. The existing first-node provider/Kubernetes identity and
three encrypted agent/seed/join custody records are now imported with fresh provider checks,
exact ciphertext readback and UID-guarded node labels. The existing agent key was retained;
no provider mutation, order or VPS bootstrap was triggered. The native
bootstrap image is qualified and mirrored into the private Cloudflare registry with a complete
readback comparison. A real Worker reached the first-node relay through the dedicated private
Tunnel/VPC service; anonymous calls were refused and the temporary probe was deleted.
The additive recovery migrations and API Workflow/Container bindings are delivered. All five
HelmReleases remain Ready on the preserved first node. Signed network evidence, real EU2 join
and new-region platform installation remain outstanding. The latest CI is green; fixed-port
regional test files now run serially with their original assertions.

API recovery now passes in Dev. Full restore recovered both confirmed markers in 82.531 s;
PITR recovered only the earlier marker in 65.562 s. After ordinary source deletion, another full
restore recovered both markers in 75.328 s from retained R2 data. All three targets have separate
PVCs, storage generation 2 and configuration revision 1, the correct SQL database mapping, a
nonsuperuser app role and no temporary administration Secret. The namespace quota and Barman
recovery-sidecar limits remain enforced. Earlier failed targets were deleted with the source
preserved before the final successful sequence. Node-loss recovery and regional installation
remain outstanding.

An isolated real Cloudflare Durable Object using the deployed DatabaseActor implementation and
real Dev D1 reads passed a two-attempt admission probe. The third registered-role attempt returned
53300 with zero D1 prepares; an unknown role returned 28P01 with zero D1 prepares. There were no
D1 writes, wake operations or lifecycle changes. This exercises the actual algorithm in a separate
namespace, not saturation of the main 12,000-attempt limit. The temporary Worker was deleted and
its absence verified. A fresh D1 export rehearsed the node-recovery migration locally: 31 tables
and 38,154 rows were preserved, including first-node identity, with clean integrity and foreign keys.

The operational failure/placement checks passed: a naturally 351.928-second-old report excluded
an otherwise physically Ready node from a new reservation; after the agent resumed, the same
pending database was placed and became Ready. A real Barman invalid-option failure appeared as
`failing` with the previous completed backup retained. Original archive configuration, agent and
Flux reconciliation were restored, fault Backup removed, and all recovery/stale trial namespaces
were deleted. The disposable integrator key was revoked. API capacity-policy response and private
rescue host-identity checks pass reproducing local tests and are deployed in Dev.

The EU capacity path now has two actual small databases on the first node and one unplaced request:
three 600-millicore reservations exceed the first node's 1,640-millicore headroom. An adoption of
the existing second VPS is audited, with purchases disabled and the two-node cap. The provider's
duplicate TCP/UDP display-name rejection is repaired with cosmetic wire labels; both firewall
assignments and exact rule readbacks now pass without changing the immutable security plan.
RAM rescue started, with strict verification of the pre-established host key and registered client
key. It reports one unmounted 161,061,273,600-byte disk, 8,326,418,432 bytes of RAM and no swap.
The first node's same-subnet peer /32 route was applied without reboot, preserving its identity
and readiness. The Talos image now includes the measured nonsecret early peer route while keeping
the provider's actual prefix. Its image hashes, GPT CRCs and installer digest are pinned; the
factory's published checksum service requires a paid tier, so these remain official-HTTPS
download measurements. The rescue root is an overlay with measured RAM-backed upper/work
directories, but its 832,643,072-byte `/run` cannot hold the 4,685,444,428 compressed/raw installer
bytes. Native portable-swap, overlay verification and operation-specific RAM scratch fixes pass
actual strict-SSH preflight. The isolated tmpfs measured 5,222,318,080 bytes with 5,222,313,984
bytes free; fresh setup, matching resume and pre-write guards passed before guarded unmount.
The corrected runtime is qualified, deployed and exactly bound in Cloudflare. The immutable
EU2 job is configured and has begun checkpointed image writes; join remains outstanding. Signed HTTPS source controls passed real
IPv4/NAT and direct IPv6 checks. Hosted runner assignment has recovered and current CI is green;
full 65,535-port IPv6 scans on both EU members and allowed-source management access passed.
The hosted IPv4 trials exposed masked control failures. Bounded diagnostics now retain the
control phase and safe timeout/status/socket reasons. Three actual HTTPS controls measured the
signed server clock 30/33/30 ms ahead of local receipt; control ordering now uses actual local
receipt after validating signed server freshness. A pinned control connection with fresh signed
heartbeats addresses the observed after-scan reconnection timeout. Focused regressions pass;
the combined proof passed in hosted run `37389964563`, with complete IPv4/IPv6 coverage,
attestation, actual access and current firewall readbacks. The proof was published and the native
job downloaded the exact 232,142,156-byte compressed image. Rescue has no `xz` executable;
Python 3.11.2 with its LZMA module is available. The job stopped before decompression or any disk
write. The portable xz/Python decoder passes 61 native tests; actual Python/LZMA decoding
produced the exact 4,453,302,272-byte RAW hash in RAM in 52.403 s with zero disk writes.
The decoder runtime is qualified and deployed with completed Cloudflare rollout and exact
instance image readback. Fresh full proofs resumed the same job through 536,870,912 acknowledged
disk bytes. Proof expiry paused it safely; every resume rechecked prior chunks through separate
connections. A single full-prefix comparison now preserves all-byte verification and passes 64
native tests plus actual 536,870,912-byte readback in 0.917 s with zero extra disk writes.
Its `bc04153d` runtime is qualified and delivered, with completed Cloudflare rollout and exact
instance image readback. The same job has acknowledged all 4,453,302,272 disk bytes, verified
every partition and GPT, and recorded the rescue reboot. Actual operator maintenance reads
confirm Talos 1.14.1, the exact disk and the intended peer route. The pinned client rejected
the original command-local `--insecure` flag before the subcommand; corrected ordering passes
all 65 native tests and is qualified and delivered from `da004fd6`, with exact registry and
Container image readback. The relay reaches genuine Talos port 50000 in 4 ms, while inactive
22/6443 time out despite the correct route and captured outbound resets. A narrow signed
maintenance observation and authoritative image/checkpoint binding preserve these outcomes
honestly; 17 API, 23 proof/hosted and five contract tests pass, with independent review.
This runtime is qualified and delivered with complete private-registry readback and exact live
instance image/completed rollout. Real relay observation and full dual-stack signed preparation
passed; the same job applied its configuration, confirmed authenticated reboot and joined
Kubernetes. EU2 is Ready under quarantine, with the unchanged first node and platform healthy.
A real 1 GiB allocation/reclamation restored all free space and measured 95 GiB total, but its
publication proof expired; no storage annotation was published. A fresh warm cycle is pending.
Native kubelet trust-map creation is unconfirmed: exact Linux Node child stdin reproduces
`/dev/stdin` reopening failure, while actual Dev server dry-run validates the manifest. Manifest
`-` and private regular patch-file corrections pass four reproducing regressions and all 65
native tests; the qualified correction is delivered and the exact trust map is read back.
Bootstrap is at `awaiting_verification`, revision 504. A warm 1 GiB allocation/reclamation cycle
completed and published actual 95 GiB in 124.433 s, with 178.9 s freshness headroom and all
trial resources removed. Unfiltered eight-second capture initially streamed 159,726,343 bytes,
99.67211% TCP 10250, exceeding the existing 32 MiB cap. Spooling before transfer preserves the
capture and cap: actual preflight measured 572,252 bytes, 498 encrypted peer packets, zero
plaintext Pod packets and zero kernel drops; all three kernel WireGuard projections passed.
The final collector's before-scan Node resource version rejects a harmless heartbeat update
with unchanged UID, labels, spec and capacity. A reproducing test and local observation-time
version binding pass 24 proof/hosted tests and independent review, retaining original scan
identity scopes and strict before/after capture plus native admission UID/version preconditions.
Fresh full verification passed in hosted run `37415715455`. Native admission released quarantine
at bootstrap revision 506; the addition reached Ready at revision 15 with the original EU2 Node
UID. All three actual capacity databases are Ready: two on EU1 and one on EU2. SQL over the normal
Cloudflare path verified their database identities and nonsuperuser application roles. The last
temporary capture Pod was removed and its absence verified. Expired preparation pauses progress
and fresh full outside proofs resume it. The unchanged first node, agent, both gateways and five
platform releases remain Ready. EU expansion is accepted; US installation and lost-worker recovery
are not yet accepted. The owner approved one automatic US1 purchase at a maximum of €20.09 gross
per month and €0 setup on 2026-10-06; the actual order and first-region installation remain pending.

The disposable EU2 recovery source has two confirmed commits, a completed real Barman base backup
and the post-commit WAL segment in the EU R2 archive. Both markers passed SQL readback. Its source
Cluster, PVC/PV and physical LV/volume-group identities were captured before the planned loss.
EU2 remains healthy; no failure intent, provider stop, loss record or source deletion has been
performed. The approved drill restores this source onto US1 after US admission. Cross-region
target selection and separate source archive access are implemented and locally checked:
contracts 148, API 379 and regional 417 tests pass, with package type checks. The source-read
credential map binds the exact original region, bucket and endpoint; target backups and temporary
administration retain the target's own credentials. API, Edge and the qualified regional image
are delivered; all existing bindings and secrets are preserved with only US archive/gateway
bindings added. Normal Cloudflare SQL still verifies all three capacity databases and both source
markers. Cross-region live acceptance remains pending.

US setup now has a default-jurisdiction archive with a North America location hint, separate
non-expiring bucket-scoped US write and EU read-only S3 credentials, a private Tunnel and a
hostname-based VPC HTTP gateway. The region's once-issued agent/route material is retained
privately. The original relay ConfigMap/deployment and first-node identity are preserved; its
new Pod/process epoch reports the same issuer and capabilities with EU and US targets allowed.
No provider order, US installation or EU2 failure action has been performed. A fresh public
one-month US quote shows €19.76 gross/month with 19% VAT and €0 setup; account billing country/VAT
remains unverified, so the purchase stays pending within the already-approved €20.09 gross cap.

Operational Cloudflare, Barman R2 and PGCF admin/agent credentials have no configured expiry.
Routing/control tokens retain their short security deadlines. Read-only adopter inventory remains
private; ownership mapping, remaining extensions, peak connection rates and migration timing must
be verified before migration. Coordinated cluster credential rotation before Neon migration is
outstanding. Operator readiness remains incomplete; adopter migration and public release follow
separately.

On 2026-10-05 the owner approved native Rust for the regional gateway, controller, bootstrap relay
and node reclaimer, and Rust/Wasm for the Edge Worker. TypeScript remains the Cloudflare management
and orchestration language. This is the accepted target architecture; runtime migration and its
Dev acceptance are pending. The existing deployed TypeScript runtime and measured v1 acceptance
remain the current implementation. See the [Rust runtime and cold-start proposal](docs/architecture/rust-runtime-and-cold-starts.md).

This file is the canonical scope, architecture, roadmap and status. README.md summarizes it,
AGENTS.md is the contributor brief and THIRD_PARTY.md records component licenses. Detailed
architecture proposals live in `docs/architecture/`; measured phase results remain in this file.

## 1. Goal

An open-source, Neon-style serverless PostgreSQL service that anyone with a **Cloudflare account**
and **Contabo VPS** can run and scale horizontally:

- Databases are created, resized, suspended, restored and deleted through a versioned API.
- Every database is real, unmodified PostgreSQL (CloudNativePG on Talos/Kubernetes, local NVMe).
- All database traffic enters through Cloudflare. The VPS expose no PostgreSQL port.
- Databases sleep when idle and wake on the next connection.
- Every database is backed up to R2 continuously, with point-in-time recovery.
- Usage and the operator's own infrastructure cost are reported as **metrics**. The integrator
  (for example ohmyho.st) turns them into prices and credits. PGCF contains no pricing or wallets.
- Cloudflare places databases, watches capacity and adds Contabo VPS through the Contabo API.

First adopter: **ohmyho.st** replaces Neon with PGCF. Its provider adapter and commercial logic
live in the adopter repository. Customer databases and internal platform databases are both in
scope, first in Dev and then in production. US remains the default and EU remains selectable.

## 2. Principles

1. **Cloudflare is the control plane.** Workers (API, edge proxy), D1 (state), Durable Objects
   (per-region link, per-database lifecycle), Workflows (long operations), R2 (backups), Secrets
   and Containers (node bootstrap jobs). Nothing on a VPS is authoritative except the PostgreSQL
   data. Regional components execute desired state and report observations.
2. **Cloudflare is the only way in.** Clients connect to an edge Worker. The region keeps an
   outbound Cloudflare Tunnel. No inbound PostgreSQL port exists on any VPS.
3. **Real PostgreSQL.** Upstream PostgreSQL images managed by CloudNativePG, one CNPG Cluster per
   database, local LVM volumes, Barman Cloud to R2.
4. **Metrics, not money.** PGCF reports usage and its own cost. There is no budget enforcement:
   integrators call `suspend`/`resume`.
5. **Generic.** No adopter names, plans or defaults in code. Size classes and policies are
   installation configuration.
6. **Initial topology and recovery.** Two existing EU VPS and one new US VPS. EU has one
   control-plane/worker node and a second worker; US has one control-plane/worker node. Both
   control-plane/worker nodes host customer databases after reserving system and platform
   resources. Recover a lost node and its databases from R2.
7. **Smallest thing that works end to end.** Add machinery only for an observed problem.
8. **Delete, don't park.** Unused code, files and branches are deleted. Git history is the archive.
9. **Real systems.** No mocks or hardcoded data in product code. A phase passes only through its
   live acceptance run in Dev.

## 3. Architecture

The diagrams are in [README.md](README.md#architecture). The component table and flows below
describe the current implementation. The owner-approved Rust target replaces the regional
gateway, agent/controller and bootstrap relay with native services, adds an isolated node
reclaimer, and moves the Edge Worker to Rust/Wasm. Management APIs, Durable Objects and Workflows
remain TypeScript. The [architecture proposal](docs/architecture/rust-runtime-and-cold-starts.md)
defines the warm route cache, direct Pod-IP/TLS path, configuration fingerprints and migration.

| Component                 | Runs on                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                | Cloudflare Worker                    | `/v1` management API, API keys, D1 state. Durable Object `RegionLink` (one per region; holds the agent WebSocket); `DatabaseActor` (one per database; lifecycle, wake coalescing, idle timer, traffic counters) arrives in Phase 2. Workflows for restore and add-node arrive in Phase 3 and later. Phase 1 has neither `DatabaseActor` nor Workflows: an operation closes when the agent's observation arrives, and a cron marks stuck operations failed. Cron also covers usage rollups and capacity checks from their phases on. |
| `apps/edge`               | Cloudflare Worker                    | Data plane on **one endpoint hostname**, `db.<domain>`: PostgreSQL wire protocol over WebSocket. The approved path admits untrusted `database` and `user` URL hints against D1, signs a v2 routing token with mandatory `user`, and returns the unopened upstream WebSocket for native forwarding. Phase 1 routes only databases observed `ready`. `ensureAwake` through `DatabaseActor` is Phase 2. Records admission and upgrade events; the gateway measures stream bytes.                                                       |
| `apps/regional` `agent`   | Kubernetes Deployment (1 per region) | Holds an outbound WebSocket to `RegionLink` that only carries hints, and pulls full desired state (every 5 s while an operation is open, otherwise every 60 s, or immediately on a hint). Reconciles each database into Kubernetes resources (below) and reports observed state, node capacity and archive health. Hibernate/wake with safety checks and storage samples arrive in Phase 2.                                                                                                                                         |
| `apps/regional` `gateway` | Kubernetes Deployment (2 replicas)   | WebSocket-to-PostgreSQL bridge reached through the edge-to-region transport (section 6). Verifies the signed v2 token; handles SSL/GSS preludes, CancelRequest, startup parsing and the startup deadline; requires the actual StartupMessage database and user to match the token before dialing PostgreSQL. Negotiates TLS with the database's `-rw` Service (SSLRequest, then TLS with the CNPG CA), relays the raw stream, and measures bytes and connection events.                                                             |
| `cloudflared`             | Kubernetes Deployment (2 replicas)   | The region's outbound Cloudflare Tunnel; the only path from Cloudflare into the cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/node-bootstrap`     | Cloudflare Container image           | Turns a Contabo VPS into a Talos node: rescue mode, verified Talos image, protected network, machine config, and worker join for an existing region or control-plane/worker bootstrap for a new region. Started by the add-node Workflow.                                                                                                                                                                                                                                                                                           |
| `packages/contracts`      | shared                               | zod schemas for the API, the agent protocol and the edge routing token.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Platform (Flux)           | Kubernetes                           | Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin, cloudflared and the regional image, pinned in `infra/platform`.                                                                                                                                                                                                                                                                                                                                                                                      |

### Per-database Kubernetes resources (agent mapping)

- Namespace `pgcf-db-<id>` with PodSecurity `restricted`, a ResourceQuota, a default-deny
  NetworkPolicy and a `CiliumNetworkPolicy`. Ingress is allowed only from the gateway and the CNPG
  operator and plugin, plus the agent on authenticated readiness port 5432 and metrics port 9187; egress only to DNS, the Kubernetes API and the R2 host on 443 (the R2 rule
  needs an FQDN match, which plain NetworkPolicy cannot express).
- CNPG `Cluster`:
  - 1 instance, pinned PostgreSQL 18 image.
  - StorageClass `pgcf-lvm` with the size class storage.
  - Current memory requests = limits from the size class. The approved warm-reclaim design
    introduces an explicit class policy with a PostgreSQL memory request below its limit,
    configured before idle transitions; full placement reservations remain in force initially.
  - `nodeSelector` on the placed node; `enableSuperuserAccess: false`.
  - `initdb` database named after the database ID (the PostgreSQL database name equals the ID),
    owned by role `app`; additional roles via `managed.roles`.
  - PostgreSQL parameters derived from the size class.
  - Barman Cloud plugin as WAL archiver.
  - Sleep uses the CNPG hibernation annotation.
- Barman `ObjectStore` writing to `s3://<bucket>/<region>/<db-id>/g<storage-generation>-<opid>` on the region's R2
  endpoint (storage generation is 1 until a Phase 4 restore; `<opid>` is the operation that created
  that storage generation), plus a daily
  `ScheduledBackup`.
  EU backups use an EU-jurisdiction bucket and EU endpoint. US backups use a separate bucket on
  the general endpoint with a North America location hint; a hint is not a jurisdiction guarantee.
- Credentials: generated in the API Worker, stored AES-GCM-encrypted in D1 (key in a Worker
  Secret), delivered in the agent's authenticated desired-state pull and written as Kubernetes
  Secrets.

### Flows

- **Create:** `POST /v1/databases`
  1. The API writes the database row (desired `running`, configuration revision 1) and an operation.
  2. Placement picks a node.
  3. `RegionLink` sends a hint, the agent pulls the desired state and creates the resources.
  4. The agent reports `ready` (cluster ready and continuous archiving working), and the operation
     completes.
- **Connect:**
  1. The client opens `GET /v2?database=<id>&user=<role>` on `wss://db.<domain>` with the Neon
     serverless driver (`Pool`/`Client`, WebSocket mode). Its `wsProxy` configuration supplies
     these URL-encoded hints from the connection settings. The connection URI remains
     `postgres://<role>:<password>@db.<domain>/<db-id>`. Customers must set
     `pipelineConnect=false`. `pgcf connect` for psql and migration tools is Phase 2.
  2. The edge treats the hints as untrusted, applies connection admission, and looks up the role
     and database in authoritative D1 state. Unknown roles and unknown, deleted or unavailable
     databases are refused before any gateway upgrade or PostgreSQL dial. Admission failures
     return a small failure-only `101` WebSocket carrying a PostgreSQL SQLSTATE error. Both hints
     are required; missing or invalid hints are refused, and the bare `/v2` endpoint is
     unsupported. Phase 2 inserts `DatabaseActor.ensureAwake()` here.
  3. It signs a v2 routing token binding the admitted database and user, opens the regional
     WebSocket through the transport seam (section 6), and returns that WebSocket unopened.
     Cloudflare forwards the stream natively; Edge does not accept it for a JavaScript relay.
  4. The gateway verifies the token and reads the actual PostgreSQL StartupMessage. Its database
     and user must exactly match the signed claims before any PostgreSQL dial. SSL/GSS preludes,
     CancelRequest, startup parsing and the startup deadline belong to the gateway.
  5. The gateway negotiates verified TLS to PostgreSQL and forwards the original startup and raw
     stream. SCRAM authentication runs end to end with PostgreSQL; uncertain writes are never
     replayed. Stream bytes and connection lifecycle measurements come from the gateway.
- **Sleep (Phase 2):**
  1. `DatabaseActor` uses gateway client-activity measurements and the size class
     `sleep_after_seconds` to ask the agent to hibernate after the idle window.
  2. The agent refuses if `pg_stat_activity` shows active backends or prepared transactions.
     Otherwise it runs `pg_switch_wal()`, waits for the archive, sets hibernation and reports.
  3. Open idle connections are closed. Clients reconnect, which wakes the database.
- **Wake (Phase 2):**
  1. `ensureAwake()` coalesces all waiters into one wake.
  2. `RegionLink` tells the agent to remove the hibernation annotation.
  3. The agent reports ready, and the waiters continue. The server-side wake timeout is 30 s.
- **Suspend/resume (Phase 2):** an integrator call sets desired `suspended`. The edge refuses new
  connections and the database is hibernated. `resume` reverses it.
- **Resize (Phase 2):** `PATCH` the size class. The agent patches resources and CNPG restarts the instance
  (one reconnect). Placement must still fit, otherwise the request is refused.
- **Delete:**
  1. The API sets desired `deleted` (an explicit tombstone; absence from a pull never deletes).
  2. The agent patches the PersistentVolume reclaim policy to `Delete`, because `pgcf-lvm` is
     `Retain`.
  3. It deletes the namespace, then waits until the PV and the `LVMVolume` are gone, so the logical
     volume is not leaked, and reports `deleted`. R2 objects follow the retention policy.
- **Restore (PITR, Phase 4):** `POST /v1/databases/{id}/restore` accepts `{mode:"full",name}` or
  `{mode:"pitr",name,target_time}`. It creates a separate target ID in the source's project and region,
  with storage generation g+1 and its own archive path; the source remains unchanged. Publish the
  target only after SQL, role and storage checks and removal of temporary restore administration.
  The caller then changes its connection explicitly. Configuration revision is separate.
- **Add node (Phase 3):**
  1. The cron sees region headroom below the threshold. Autoscaling must be enabled and within the
     caps for maximum nodes and maximum monthly spend.
  2. The `AddNode` Workflow orders a Contabo instance, or adopts an existing instance ID.
  3. The `node-bootstrap` Container installs Talos, applies peer-only network protection and
     ensures the encrypted Cilium overlay is configured before joining. It applies the worker
     configuration for an existing region or bootstraps a control-plane/worker for a new region.
  4. The agent sees the Node `Ready` and reports allocatable resources. The node becomes
     schedulable after network verification and system/platform reservations.

### Capacity and placement

A node's allocatable resources are the Kubernetes allocatable values minus a measured platform
reservation. Each database reserves:

- **Storage:** its size class storage.
- **Memory and CPU:** full size-class and sidecar reservations, including sleeping databases.
  A sleeping reservation factor is not implemented. Reducing reservations requires measured
  density and an explicit capacity check before wake; it must not silently overcommit a node.

Placement picks the node with the most free memory in the region that fits. Contabo contracts are
monthly, so scale-in only cancels at the end of a term, and autoscaling uses hysteresis.

### Scaling and adopter connection capacity

The public data plane keeps one hostname. Regional routing and additional nodes provide
horizontal capacity behind it; extra public hostnames are not required for Worker throughput.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify no general
requests-per-second cap. A new connection needs D1 admission and routing; SQL on an admitted
stream does not query D1. Measure connection creation separately from SQL requests and respect
[D1 throughput limits](https://developers.cloudflare.com/d1/platform/limits/).

Admission keys combine database, role and normalized source network; a separate database-wide
counter bounds aggregate handshakes. A shared source address from cross-zone Workers never
creates one installation-wide connection bucket. The current Dev starting limits are 6,000
handshakes/minute for each combined key and 12,000/minute per database. The binding counters
apply per Cloudflare location and are eventually consistent, as described in the
[Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
They are configuration,
not a measured service throughput. The gateway budgets 192 MiB aggregate and 96 MiB per database,
including fragmented and control traffic, with 16 MiB reserved for healthy traffic. The settings
are `PGCF_GATEWAY_MEMORY_BYTES` and `PGCF_GATEWAY_DATABASE_MEMORY_BYTES`.

Integrators use bounded reusable pools and waiting queues. PGCF currently provides session
forwarding; it has no transaction pooler. Measure backend reuse, connection creation and actual
application compatibility before changing an adapter. Adopter-specific inventory and pool
settings belong in the adopter repository, not the generic platform plan.

The initial density decision must follow measured active-memory and storage capacity. An adopter
goal of 1,000 customers is not an assertion that the three initial VPS can host 1,000 simultaneously
active databases. The current Dev node has 6,799 MiB allocatable memory, a measured 1,878 MiB
platform reservation and a 1,152 MiB reservation for each small database including its sidecar.
RAM alone admits four reservations, but the measured 1,260-millicore platform CPU reserve leaves
only two 600-millicore small reservations. The atomic placement path now checks CPU too. Full migration inventory, connection rates and downtime measurements remain pending.

## 4. Data model and API v1

D1 tables:

- `api_keys`: scope `admin` or `integrator`; SHA-256 hash with pepper.
- `projects`: integrator grouping with an optional `external_id`.
- `size_classes`:
  - Resources: memory MiB, CPU millicores, storage GiB, max connections.
  - Policies: `sleep_after_seconds` (null = never), `archive_timeout_seconds`,
    `backup_retention_days`, enabled.
- `regions`: provider, provider region, gateway URL and optional gateway binding, backup bucket and
  endpoint, agent key hash and last-seen time, autoscale policy JSON. A region has no database
  domain; the single endpoint hostname is installation configuration and the region is routing
  data behind it.
- `nodes`: provider instance and product, monthly price and currency, status, allocatable
  resources, Kubernetes node name.
- `databases`:
  - Ownership and placement: project, region, node, name, size class, PostgreSQL major version.
  - State: desired and observed state, configuration revision (`generation`) and observed
    configuration revision (`observed_generation`), status message, timestamps. Storage generation
    is separate and remains 1 until Phase 4 restores.
- `roles`: encrypted password with key version; unique on `(database_id, name)`, which is the
  edge's routing index.
- `operations`: kind, subject, configuration revision, status, error, timestamps.
- `idempotency_keys`: API-key-scoped request hash, state, resulting resource ID and response status;
  never credential-bearing response bodies.
- `lifecycle_events`: created, ready, hibernated, woke, resized, suspended, deleted; each with
  node, size class and generation.
- `usage_hourly`: one row per database and hour.

Endpoints:

- Projects: `POST/GET/DELETE /v1/projects[/{id}]`.
- Databases:
  - `POST /v1/databases` (asynchronous; returns an operation), `GET /v1/databases[/{id}]`,
    `PATCH /v1/databases/{id}` (size class), `DELETE /v1/databases/{id}`.
  - `GET /v1/databases/{id}/archive` lists base backups and WAL in R2 through the Worker's R2
    binding.
  - `POST /v1/databases/{id}/suspend|resume|restore`.
- Roles: `GET|POST /v1/databases/{id}/roles`, `POST .../roles/{name}/reset-password` and
  `GET /v1/databases/{id}/roles/{name}/connection-uri`. The connection URI includes the password
  only for the `integrator` scope.
- Operations: `GET /v1/operations/{id}`.
- Metrics: `GET /v1/usage` and `GET /v1/costs` (section 5).
- API keys: `POST|GET /v1/api-keys` and `DELETE /v1/api-keys/{id}`. The bootstrap token creates the
  first `admin` key and works only while no admin key exists. API and agent credentials are returned
  once; idempotency replays neither reissue nor replace them.
- Admin: `GET /v1/size-classes`, `PUT /v1/size-classes/{id}`, `GET /v1/regions`,
  `POST /v1/regions`, `GET /v1/nodes` and `POST /v1/regions/{id}/nodes`.
- Agent: `/agent/v1/link` (WebSocket), `/agent/v1/desired` and `/agent/v1/observations`.

The OpenAPI document and the TypeScript client are generated from code: Hono with
`@hono/zod-openapi`. Writes accept an `Idempotency-Key`.

## 5. Metrics and cost tracking

Usage is reported per database per UTC hour (`GET /v1/usage?project_id|database_id&from&to&granularity=hour|day`):

| Metric                                                               | Source                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `provisioned_seconds`, `awake_seconds`                               | lifecycle events                                                 |
| `memory_mib_seconds`, `cpu_millicore_seconds`                        | size class × awake time; a separate reserved figure covers sleep |
| `storage_used_bytes_max`, `storage_allocated_bytes`                  | agent samples (hourly)                                           |
| `backup_bytes_max`                                                   | R2 listing of the database prefix (hourly)                       |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | gateway stream counters and connection events; Phase 2 rollups   |

Rows can change until `final: true`, which is set two hours after the hour ends. Missing samples
are reported as gaps, never as zero.

`GET /v1/costs` shows the operator's own cost:

- Node cost per hour (the Contabo price recorded at purchase) is attributed to databases by their
  share of reserved memory.
- R2 storage cost covers backup bytes. Prices are installation config.
- Unreserved capacity appears as `idle_capacity_cost`.

The cost view answers "what does each database cost us" and shows utilization. Integrators keep
their own price lists and billing logic.

## 6. Security and isolation

- The VPS firewall denies inbound traffic by default. Operator and bootstrap addresses may reach
  the Talos API (TCP 50000) and Kubernetes API (TCP 6443) only. From Phase 3, exact peer-node
  addresses may additionally reach the required Kubernetes API, Talos (TCP 50000/50001), kubelet
  (TCP 10250), control-plane etcd ports and CNI ports. No cluster port becomes world reachable.
  Apply the peer allowlist before joining a node. Cilium 1.20.2 uses WireGuard transparent
  encryption for inter-node Pod traffic (`encryption.enabled: true`, `encryption.type: wireguard`),
  with UDP 51871 reachable only between peers; the VXLAN overlay and health paths are peer-only
  too. Configure encryption before join, then verify it before placing databases on the new node.
  Host control-plane traffic still uses its native TLS; Pod encryption is not a claim that all
  host traffic uses WireGuard. These are Phase 3 requirements, not deployed evidence.
  See [Cilium WireGuard](https://docs.cilium.io/en/stable/security/network/encryption-wireguard/),
  [Cilium firewall requirements](https://docs.cilium.io/en/stable/operations/system_requirements/#firewall-rules)
  and the [pinned Talos port constants](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/constants/constants.go).
  Moving operator access behind the Tunnel or Access is a Phase 4 item.
- Database IDs are random 20-character strings (`^[a-z][a-z0-9]{19}$`, a letter first) and are
  also the PostgreSQL database name. There is no per-database hostname. The edge refuses unknown,
  deleted, suspended and not-ready databases and rate-limits connections per database.
- The edge admits URL hints against D1 before any gateway upgrade or PostgreSQL dial. Admission
  failures use a small failure-only `101` WebSocket carrying a PostgreSQL SQLSTATE error. The
  gateway parses the actual
  StartupMessage and rejects a database or user mismatch before a PostgreSQL dial. Startup
  protocol majors other than 3 and replication requests receive SQLSTATE `0A000`; a missing
  startup user receives `28000`. The gateway declines client SSL/GSS requests and silently closes
  CancelRequest connections without dialing PostgreSQL. Phase 2 adds the decoy SCRAM exchange.
- **Edge to gateway:**
  - A v2 HMAC-SHA256 routing token with a per-region key: database ID, mandatory user, connection
    ID, region, key ID, issued-at and expiry, with expiry minus issued-at ≤ 30 s. It is single use
    per gateway replica: each gateway keeps a connection-ID replay cache and rejects a reused
    token.
  - The gateway derives the target only from the admitted database ID, after the actual startup
    database and user exactly match the token. The token admits a route; PostgreSQL still
    authenticates the user's password through SCRAM.
  - The transport is chosen by a Phase 1 spike behind one seam, preferring the existing path with
    the fewest parts that keeps TLS to PostgreSQL: Workers VPC TCP (`vpc_networks` binding), else
    a Workers VPC HTTP service to the gateway, else a Tunnel hostname with the routing token.
    The selected Dev path is a VPC HTTP service with unopened native forwarding, measured at
    235 ms in the capability check. VPC TCP was rejected because its raw streams did not expose
    the required native WebSocket. Tunnel with signed routing remains the fallback. An Access
    service token on a public Tunnel hostname needs the owner's consent to a Zero Trust
    organization first.
- PostgreSQL:
  - Customer roles are non-superusers; superuser access is disabled.
  - `scram-sha-256`; extensions limited to the image allowlist.
  - TLS only (`hostnossl` is rejected); the gateway negotiates it itself.
  - Gateway Pods carry customer connections. The agent verifies desired role credentials through
    authenticated TLS readiness probes before reporting ready.
- Kubernetes: one namespace per database, default-deny NetworkPolicy plus a
  `CiliumNetworkPolicy`, hard LVM volume limits, CPU and memory limits, PodSecurity `restricted`.
  The agent has no `pods/exec` permission.
- Secrets:
  - Worker Secrets hold the API key pepper, the credential encryption keys, the region route
    master keys and the bootstrap token. Contabo API credentials and the encrypted Talos secrets
    bundle follow in Phase 3.
  - Workers reach R2 through bindings, so no R2 S3 credentials are stored in Workers. The S3
    credentials Barman needs exist only as Kubernetes Secrets in the region.
  - Nothing secret is committed, printed or placed in Image Factory schematics.
- **Wake before authentication:** in Phase 1 databases always run, so no connection wakes
  anything. From Phase 2 an unauthenticated client that knows a database ID and a role name could
  wake a sleeping database. That is bounded by unguessable IDs, the D1 role lookup before any wake,
  and per-database rate limits. The integrated idle fix counts activity only after `AuthenticationOk`
  and drains pre-auth sessions at quiescence. Live unauthenticated pings did not prevent sleep.
  Known-hint wake abuse
  still requires explicit measured admission protection. Unknown databases and roles use decoy
  SCRAM and return the same 28P01 error form as a wrong password; their timing is not equal. Edge-side
  SCRAM verification before a wake is a Phase 4 decision.

## 7. Phases

### Current operator-ready scope (owner decision, 2026-10-05)

Finish PGCF for our own Cloudflare account and two EU/one US VPS first. Neon migration and public
release are separate later steps. Retain the accepted core, first node, custody and platform;
do not rebuild them or repeat their unchanged acceptance suites.

Three implementation tracks run in parallel, with one serial Git lane and one serial live lane:

- Installation: private relay/Tunnel/VPC, complete Workflow/Container wiring, actual bootstrap
  inputs and signed network-evidence production; EU2 adoption and first-region platform setup.
- Recovery: API full restore/PITR into a separate target database, distinct physical storage
  generation, actual SQL/role/config verification before route publication, deleted-source
  retention and validated regional R2 binding selection.
- Operations: observation freshness in placement and allocation guards, explicit lost-node and
  recovery authority, pre-D1/wake admission for registered hints, real backup/disk health and
  short control-state/credential recovery and rotation procedures.

Completion requires the real EU capacity/adoption path and US first installation, database
lifecycle per region, PITR and deleted-source restore, one existing-resource node-loss recovery,
and targeted health/overload checks. Record recovery time and last recoverable transaction.

- Owner decision (2026-10-06): paid automatic Contabo API purchase of US1 is approved.
- Cost cap: €20.09 gross/month, €0 setup; Cloudflare orchestrates purchase and installation.
- Test automatic purchase and full US1 installation, including safe interruption/resume.
- Test EU2 loss: restore its disposable database from real R2 backups onto US1; verify SQL/data.
- Supersedes pending approval/same-instance drill; preserve EU1 and record RTO/recovered state.

Use regression tests for changes, scoped package checks and one composed CI; repeat old live
checks only when their behavior changed. No additional cold-start optimization or twenty-start
series is required. Current approximately nine-second starts are accepted for v1.

Before customer data, document measured capacity and visible metric gaps; do not promise the
initial three VPS can host 1,000 simultaneously active databases. Cost attribution is deferred;
commercial RAM/storage prices, wallets and billing remain with the adopter.

There is no PGCF SaaS account. A self-hoster supplies Cloudflare/Contabo accounts, installs the
Cloudflare components and uses the images for the regional/native components. Public signing,
release/version polish, a convenient install CLI, detailed API publication and a blank foreign
Cloudflare-account installation proof belong to the later public-release gate.

The historical phases below preserve the implementation roadmap. Their migration, public-release,
density/performance and week-long adopter checks are not extra prerequisites for the initially
customer-free operator deployment. Phase results and measured numbers remain in section 11.

### Phase 0 — Reset

1. **Completed:** the old implementation was removed in commit `77ac865` and the new TypeScript
   workspace was scaffolded. Do not repeat the removal command: it would delete the new workspace.

2. Remove completed implementation worktrees and branches; only `main` remains after integration.
   Keep any local recovery bundle outside tracked files.
3. Decommission the old Dev deployment after a complete inventory and the required approval.
   Operate only on inventory-bound PGCF Dev resources; remove obsolete Workers, D1 databases,
   backup prefixes and Worker Secrets according to that reviewed inventory.
   Preserve the regional backup bucket selected for the new installation.
4. Rebuild the lab Talos node from the repository recipes: Talos, Cilium, then the Flux platform.
   This removes the old controller, collectors, telemetry and adoption overlays, and proves the
   recipe on fresh infrastructure. The second VPS stays untouched for Phase 3.

Acceptance:

- `git ls-files` shows only the target layout (section 10).
- `git worktree list` and `git branch` show only `main`.
- No stale `pgcf-*` Dev resources remain.
- The fresh lab node is Ready and all five Flux releases are Ready.

### Phase 1 — One database through the whole chain

Build:

- `apps/api`: keys, projects, size classes, regions, databases, roles, operations, the archive
  endpoint, agent routes; D1 migrations; `RegionLink`; a cron that sweeps stuck operations. No
  `DatabaseActor` and no Workflows: databases always run.
- `apps/regional`: agent create/delete reconcile with Barman to R2 from creation, plus the
  gateway. `ready` requires `ContinuousArchiving=True`; if archiving stays failed for more than
  10 minutes, the agent reports `health.archiving=failing`, which `GET /v1/databases/{id}` shows.
  The agent has no `pods/exec`.
- Backup objects survive ordinary API deletion within retention; the acceptance harness
  explicitly purges its own trial archives. Complete retention enforcement and restore after
  source deletion are Phase 4 work.
- Once a database has been ready, a measured archive alarm does not revoke connections when
  its physical identity, current configuration, certificates and role authentication still pass.
  Report `ready` with `health.archiving=failing`. Initial creation still requires verified
  archiving; unavailable or invalid measurements never establish healthy status.
- `cloudflared` and the regional image in the Flux platform; public GHCR images.
- `apps/edge` on the single endpoint: D1 admission of URL hints, signed v2 database/user route,
  and unopened-WebSocket native forwarding. The gateway owns startup validation, preludes and
  the startup deadline. `CancelRequest` is not routed in Phase 1; the gateway closes it silently
  without a PostgreSQL dial.
- `scripts/e2e` (TypeScript).

Live acceptance (`scripts/e2e` against Dev):

1. Create a project and a `small` database through the API with an `Idempotency-Key`. Measure
   ready time.
2. Fetch the connection URI (`postgres://<role>:<password>@db.<domain>/<id>`; the password only
   for the `integrator` scope).
3. From a deployed test Worker using `@neondatabase/serverless` (`Pool`, WebSocket mode,
   `pipelineConnect=false`), run DDL, a transaction, a rollback and reads through
   `wss://db.<domain>/v2?database=<id>&user=<role>`. A wrong password, database ID and user are
   each refused. A StartupMessage database or user that differs from the admitted hints is
   rejected before a PostgreSQL dial.
4. Find the base backup and WAL objects in R2.
5. Delete the database. D1 shows `deleted`; the namespace, PVC, PV and `LVMVolume` are gone, the
   volume group's free space is back to its baseline and the edge refuses the ID.
6. A TCP port scan of every node address from a source outside the firewall allowlist finds no
   reachable port; from the operator address only the Talos (50000) and Kubernetes (6443) APIs
   answer. The cluster has no PostgreSQL listener, NodePort, LoadBalancer, `hostPort` or
   `hostNetwork`.
7. The credential expiry inventory lists the expiry date of every credential the run depends on,
   by variable name and without values.
8. Create and delete five databases with the agent killed mid-run: no released PV or `LVMVolume`
   remains. An empty, stale or failed pull never deletes anything and no generation decreases.

### Phase 2 — Serverless behavior and metrics

For v1, integrators keep platform databases and latency-sensitive applications running with
`sleep_after_seconds: null`, and choose longer idle windows for frequently used databases.
Where the application provides enough lead time, authenticated early wake belongs in the
adopter's application flow. A first-user-action target below one second must be measured in that
flow; it is not a subsecond cold-start guarantee. CNPG hibernation removes Pods and retains
volumes. The approved Rust runtime workstream below adds per-database warm idle with bounded
memory reclaim while keeping the same PostgreSQL process and volume. Warm idle remains awake
for metering. Shared PostgreSQL processes and process/VM snapshots remain separate later research.

Build:

- `DatabaseActor`: idle timer, coalesced wake, traffic counters.
- Agent hibernate/wake with safety checks; suspend/resume.
- `pgcf connect` local TCP bridge.
- Lifecycle event log, agent samples, hourly rollups, `/v1/usage`, `/v1/costs`.
- Manual resize.
- Decoy SCRAM for unknown databases and roles.

Live acceptance:

- The database hibernates after its idle window.
- Record p50/p95/max for 20 cold connects. The owner accepted the measured current startup
  times for v1 on 2026-10-05: p95 9.160 s in the completed series, with subsequent diagnostics
  at 8.645–9.772 s. The historical cold timer ends at connection completion; the warm diagnostic
  includes the first read, so their percentiles are not interchangeable. The approved Rust runtime
  workstream measures both endpoints explicitly; ≤8 s remains a future cold-connect target.
  Integrators must choose connection timeouts covering cold starts or use early wake/warm classes.
- 10 parallel connects to a sleeping database cause exactly one wake.
- Usage `awake_seconds` matches the lifecycle within 60 s per hour.
- Resource/consumption metrics retain explicit gaps. Cost attribution is deferred by the owner;
  commercial resource prices and billing remain solely in the adopter.
- Resize applies with one reconnect.
- psql works through `pgcf connect`.

### Phase 3 — Horizontal scaling across VPS

Build:

- Node inventory and placement.
- The `AddNode` Workflow: adopt an existing instance or order a new one.
- The `node-bootstrap` Container. It runs the verified rescue path: per-node Image Factory
  schematic with static network arguments, checksum-verified NoCloud raw image, GPT relocation,
  `apply-config` worker for an existing region, or bootstrap a control-plane/worker for a new region.
  Control-plane/worker nodes host customer databases with measured system/platform reservations.
- Before join, apply the peer-address firewall allowlist for API, Talos, kubelet, control-plane
  etcd and CNI traffic, and configure Cilium WireGuard Pod encryption. Keep the new node out of
  database placement until the encrypted inter-node path and network isolation are verified.
- Capacity cron with an autoscale policy and hard caps. Initial node caps are EU = 2 and US = 1.
- Reconcile uncertain provider responses before retrying; a replay must never buy another node.
- Node caps count live nodes. Marking a node lost frees its slot for a replacement; the replacement
  order still needs the owner's costed approval. Reinstalling the same VPS in place needs no purchase.

Live acceptance:

- Real database reservations exhaust EU headroom and the second existing VPS joins through the
  capacity path and API, with no manual console step.
- New databases are placed on it.
- Databases on both nodes are reachable.
- Inter-node Pod traffic between the two EU nodes is proven encrypted on the public network;
  WireGuard peers and handshake health match the inventory. An outside-allowlist IPv4/IPv6 scan
  proves that joining added no world-reachable cluster port.
- An autoscale dry run logs the decision.
- A pending US database with no allocatable capacity triggers a real US VPS order and the full
  install/bootstrap path, after the owner's costed go. Interrupt and resume without a duplicate order.

### Phase 4 — Operator readiness and subsequent adopter migration

- PITR restore through the API, retention enforcement, backup freshness checks.
- Health reporting and alerting through Cloudflare: WAL archive age, disk usage, failed backups,
  node down.
- Production uses the initial two-EU/one-US topology. Keep etcd snapshots, regular D1 exports to
  R2 and documented recovery of Worker Secrets and regional infrastructure.
- Restore creates a separate target and storage generation; configuration revision and storage
  generation are distinct. Verify the target before the adopter changes its active connection.
- Isolation tests: cross-tenant network and SQL, disk-full containment, CPU noisy neighbor.
- Credential and API key rotation.
- Keep full, measured placement reservations for v1. Density optimization, sleeping reservation
  factors and relocation are later work.
- Bound registered-hint admission before D1/wake. Edge-side SCRAM before wake is later work.
- Qualify deployment images and the changed security boundaries; public signing is Phase 5.

Second step, after operator product acceptance:

- OMH Dev on PGCF (adapter in the OMH repository) for one week, then migrate customer and internal
  platform databases during a maintenance window: stop writes, dump/restore, compare data and roles,
  verify the target, switch connections, then reopen writes. Preserve US/EU and shared/isolated data
  scopes. Retire Neon only after successful verification; never switch back to an older source after
  the target has accepted writes.
- The provider adapter lives only in the adopter repository and replaces database and role
  provisioning, resize, suspend/resume, deletion, usage import and customer/platform connections
  with PGCF contracts. The MIT WebSocket driver may remain as a client library without a Neon
  service dependency.

Acceptance:

- PITR to a timestamp through the API, including after the source is deleted.
- Recover a database and its regional infrastructure from R2 after a node-loss exercise; record
  recovery time and the last recoverable transaction.
- OMH Dev stability belongs to the subsequent migration gate, not the customer-free product gate.

### Phase 5 — Open-source release

Build:

- An install path (`pgcf install` or a scripted guide): a Cloudflare account with a zone, plus
  Contabo API credentials, give a first region.
- Generated API reference and operator runbooks in `docs/operations/`.
- Versioned release metadata on main and signed public images pinned by digest; no extra Git refs.
- Reuse the new US VPS before production data for the fresh-account installation acceptance.
- Remove unused Neon code, credentials, connections and provider resources after verified cutover.

Acceptance: a fresh Cloudflare account and a fresh VPS reach Phase 1 acceptance by following only
the docs.

### Rust runtime and fast compute lifecycle — approved architecture (2026-10-05)

The owner selected Rust as the target for the regional server applications and the Edge data
path. Measurements validate the resulting implementation and latency; a CPU profile is not an
entry gate for this architecture choice. The detailed design is in
[docs/architecture/rust-runtime-and-cold-starts.md](docs/architecture/rust-runtime-and-cold-starts.md).

Implement in this order, with separate binaries/images in a shared Rust workspace:

1. Replace the regional gateway while preserving routing, PostgreSQL/TLS, bounded streams,
   authenticated activity, quiescence and persistent fence contracts.
2. Replace the regional controller and bootstrap relay. Use targeted desired-state pulls,
   serialized per-database reconciliation, wake-priority queues, Kubernetes watches and immediate
   database observations; collect inventories, backup statistics and usage independently.
3. Publish verified versioned Pod-IP routes with separate TLS identities. Cache them in the
   gateway, bind admission to route revisions, and avoid configuration reapplication when its
   fingerprint and runtime identity are unchanged. A new Pod receives fresh runtime verification.
4. Move the full Edge Worker to Rust/Wasm while preserving Durable Object bindings, VPC HTTP and
   unopened native WebSocket forwarding. Versioned Actor snapshots and mutation barriers keep D1
   authority while shortening warm admission.
5. Add a scoped Rust node reclaimer and test `warm_reclaim` on an isolated accepted Dev worker
   using encrypted Talos swap/zswap. PostgreSQL, CNPG probes and Barman continue running. Explicit
   suspend still requires resume; full placement reservations remain unchanged initially.
6. Separately develop proxy-side SCRAM, snapshot/freezing research and native CLI connection reuse.

Keep one controller during handoff, preserve persisted execution state and Secrets, and delete
replaced TypeScript code after successful Dev acceptance. Initial SCRAM remains end to end;
proxy authentication requires its own versioned credential contract. Partial database observations
must preserve complete node/orphan inventory; ready notifications follow guarded D1 acceptance.

Acceptance covers actual Dev SQL, transactions, COPY, role and Pod changes, watch loss, restarts,
fences and hibernation in the existing single CI/Dev workflow. Measure connection completion and
first successful read separately. Warm-reclaim acceptance uses twenty independent five-minute
idle runs and separate thirty-/120-minute soaks. The prepared/warm path targets a first successful
read below one second; true Pod cold starts are reported separately. This workstream does not
reopen the accepted v1 latency or claim that the target runtime is already deployed.

### Later

Density tuning/additional classes/sleeping factors,
maximum-throughput stress matrices, an additional pooler, cost attribution and scheduled rotation.
Public release polish and blank foreign-account installation acceptance follow operator readiness.

Later, extend backups and replication so that losing a server does not lose acknowledged transactions.
Relocation of sleeping databases, branching, other VPS providers, an HTTP SQL endpoint, PostgREST,
a Studio workbench.

## 8. Known facts from the lab (2026-09-27 to 2026-10-01)

**Hardware:**

- Two Contabo Cloud VPS Plus 4 (4 vCPU, 8 GiB RAM, ~150 GB disk, EU 2, €13.07/month each).
- No nested virtualization.
- No custom-image storage in the account. Talos was installed with Contabo rescue mode and `dd`
  of a checksum-verified Image Factory NoCloud raw image, followed by backup-GPT relocation. Static
  network kernel arguments are needed (`net.ifnames=0`, `eth0`).

**Versions that worked together:**

- Talos 1.14.1, Kubernetes 1.36.3, Cilium 1.20.2.
- OpenEBS 4.6.1 (LocalPV LVM 1.10.1 only), cert-manager 1.21.2.
- CNPG 1.30.1 (chart 0.29.1), Barman Cloud plugin v0.15.0 (chart 0.8.0).
- Flux 2.9.5, PostgreSQL 18.4.

**Storage:**

- A raw partition holds the LVM volume group `pgcf`. StorageClass `pgcf-lvm` is thick, uses
  `WaitForFirstConsumer` and has `Retain`. Volume limits are hard.
- Cap the Talos EPHEMERAL volume before first provisioning.
- A WAL-full PANIC was recovered by online volume expansion without losing committed transactions.
  Failed archiving fills the disk, so alert on archive age and disk use.

**Backups:**

- Base backup, WAL archiving, full restore and PITR passed: CNPG plus Barman plugin to R2 at the
  EU endpoint `https://<account>.eu.r2.cloudflarestorage.com`, region `auto`.
- Every restore target needs its own archive path and `serverName`; reused names break restore
  (plugin issue #411).
- The plugin's `enabled: true` default matters.
- The lab sidecar used 128 MiB request / 512 MiB limit. Size it for 512 MiB databases.

**Images:** private GHCR packages forced `imagePullPolicy: Never` with Talos image import.
Publish public images instead.

**Cloudflare:**

- Workers VPC HTTP through the regional Tunnel is the accepted Dev transport, with native
  WebSocket forwarding. VPC TCP was rejected for this path because the tested interface exposes
  raw streams rather than a native WebSocket handoff. The gateway independently verifies
  PostgreSQL TLS; the public PostgreSQL port remains closed. Tunnel routing tokens are the fallback.
- Hyperdrive allows 25 configurations per account, so there is no Hyperdrive per database.
- D1 strings and rows are limited to 2 MB.
- Some tokens failed Wrangler D1 queries with error 7403 while REST and the dashboard worked.

**Tooling:**

- `@cloudflare/vitest-pool-workers` was replaced by `@cloudflare/vitest-plugin`; the workspace uses
  vitest 4.1.x with the plugin.
- Node 24 enters maintenance on 2026-10-20 and stays supported; images pin a Node 24 release by
  digest.

**Upstreams:**

- The public Neon repository is effectively dormant (last code change May 2026). Neon storage,
  proxy and NeonVM are not used.
- The Neon serverless driver (MIT) speaks PostgreSQL over WebSocket. Use `Pool`/`Client` mode with
  `pipelineConnect = false` for SCRAM; its documented default (`"password"`) pipelines the startup
  and only works with cleartext password authentication. Its HTTP `neon()` query mode needs Neon's proxy and is not
  supported.
- Xata OSS (Apache-2.0, CNPG-based) is active. Its SNI gateway is not needed in this design.

## 9. Decisions (owner-approved changes or a measured reason)

The runtime target was explicitly approved by the owner on 2026-10-05. Current deployed behavior
is distinguished from that target below; selecting Rust is not conditional on a profiling result.

| Topic               | Decision                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language            | Approved target: native Rust regional gateway/controller/relay/reclaimer and Rust/Wasm Edge; TypeScript API, Durable Objects and Workflows; CLI/provisioning initially Node; shared zod contracts with Rust conformance. Runtime migration pending. |
| API                 | Hono + `@hono/zod-openapi`; OpenAPI and client generated from code                                                                                                                |
| Region link         | Agent opens an outbound WebSocket to `RegionLink`, plus a 60 s full-state pull; desired state in D1 is the truth                                                                  |
| Endpoint            | One hostname, `db.<domain>` (Worker custom domain). No per-database or per-region hostnames, no wildcard DNS; the region is routing data in D1                                    |
| Routing             | Edge admits untrusted `database`/`user` URL hints against D1 and signs a v2 token with mandatory user; gateway requires the actual StartupMessage to match before PostgreSQL dial |
| Client protocol     | PostgreSQL over WebSocket (`GET /v2?database=<id>&user=<role>`) via native Edge forwarding with `pipelineConnect=false`; native tools through `pgcf connect` (Phase 2)            |
| Archive alarm       | Separate archive health from established database availability after current physical/configuration/role checks; initial creation remains gated                                   |
| Edge to region      | VPC HTTP service with unopened native WebSocket forwarding selected in Dev (235 ms capability check); VPC TCP raw streams rejected; signed Tunnel route remains fallback          |
| Desired state       | Deletion is an explicit tombstone; absence from a pull never deletes; generations only increase and the agent ignores older ones                                                  |
| Database topology   | One CNPG Cluster with 1 instance per database, namespace per database, pinned to a node                                                                                           |
| Sleep               | Current: CNPG declarative hibernation. Approved addition: per-database warm reclaim with PostgreSQL running; explicit suspend remains gated until resume.                            |
| Backups             | Barman Cloud plugin to R2; daily base backup, continuous WAL, retention per size class                                                                                            |
| Metering            | Hourly; derived from lifecycle events, samples and gateway stream counters; no per-minute billing                                                                                 |
| Budgets             | None in PGCF; integrators suspend and resume                                                                                                                                      |
| Compute autoscaling | None; manual resize by size class                                                                                                                                                 |
| Cluster             | One Talos/Kubernetes cluster per region                                                                                                                                           |
| Initial topology    | Two EU VPS (control plane + worker, plus worker) and one US VPS (control plane + worker); recovery from R2                                                                        |
| Tests               | Current: Workers vitest and regional `node:test`; Rust unit/conformance checks join the existing single CI as services migrate; `scripts/e2e` provides live Dev acceptance.         |

Open questions with defaults:

- **Wake time:** current v1 cold-connect latency is accepted. The Rust workstream measures
  connect and first read separately, targeting subsecond prepared/warm reads.
- **`archive_timeout`:** default 300 s for the smallest class and 60 s for larger ones. R2 Class A
  operations scale with WAL segments.
- **Sleeping reservation factor:** 1.0 until Phase 4 measurement.
- **Production control plane:** one per region in the initial two-EU/one-US topology.

## 10. Working rules and repository layout

- Work phase by phase. Make the smallest change that moves the current phase.
- Test the logic you write: state machines, placement, metering math, token signing and resource
  mapping. Write the test first when fixing a bug.
- Run `scripts/e2e` against Dev for anything that touches infrastructure.
- One CI workflow: lint, typecheck, unit tests, image build.
- No per-change evidence documents, contracts or "held" work. Record phase results in section 11.
- No mocks, stubs or hardcoded data in product code. Never claim a phase passed without its live
  run.
- The repository is public. Never print or commit secrets, `.env*`, kubeconfigs or Talos configs.
- New paid resources (VPS, plans) and production writes need the owner's explicit, costed go.
- Repository documentation is written in English; owner discussions may be in German.
- Documentation lives in PLAN.md, README.md, AGENTS.md, THIRD_PARTY.md, the infra READMEs,
  `docs/operations/` runbooks and `docs/architecture/` proposals. Architecture proposals describe
  approved targets; phase results and measured numbers remain in section 11.

Current implementation layout (the approved Rust workspace/binaries follow the architecture proposal):

```text
apps/api              Cloudflare Worker: /v1 API, Durable Objects, Workflows, cron
apps/edge             current TypeScript Worker; approved target is full Rust/Wasm Edge
apps/regional         current Node image; regional services migrate to separate Rust binaries/images
apps/node-bootstrap   Cloudflare Container image: Contabo → Talos node bootstrap (Phase 3)
packages/contracts    shared zod schemas
scripts/ci            image qualification, scanner and registry CI helpers
scripts/e2e           live end-to-end acceptance
infra/talos           Talos patches and Contabo rescue install recipe
infra/platform        Flux platform baseline (pinned)
infra/backups         CNPG/Barman/R2 backup and restore reference
docs/architecture     approved architecture proposals, including Rust runtime and cold starts
docs/operations       operator installation, recovery and credential runbooks
```

## 11. Status

Only completed real runs establish phase acceptance. Local checks are identified separately.
Earlier failed attempts and corrections remain in Git history.

| Date       | Phase                     | Result and measured limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-03 | 0 accepted                | Fresh first EU Talos/Kubernetes node, five Ready Flux releases, 95 GiB storage. Formal foundation checks passed; second EU node unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-04 | 1 accepted                | E0–E6 passed. Latest E0–E5 run: Ready 27,644 ms, cold SQL connection 486 ms, commit/rollback 46/49 ms, one base backup and four WAL objects; delete 53,128 ms and zero trial volumes/archives after harness cleanup. Five distinct create/delete ledgers and ten agent restarts passed. Real fault responses preserved storage and generations; a missing ready namespace reported recovery required rather than creating empty storage. The complete 65,535-port scans exposed only operator Talos/Kubernetes APIs and no Cloudflare-accessible port. The observed Kubernetes node publishes one IPv4 and no IPv6; the all-port result covers that IPv4. The separate earlier provider IPv6 refusal check passed; no new all-port IPv6 claim is made. Credential names and independently known expiry dates are inventoried privately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-10-04 | 1 backup and availability | A real R2-only outage reproduced a committed marker unarchived for 1,002 s. The corrected persistent timer survived an agent restart and alarmed after 619,301 ms. The subsequent availability proof obtained two distinct failing observations under the active policy and a fresh read connection in 437.681 ms; lifting the exact policy drained WAL, preserved the marker and cleared the timer. Separate restore drill: maximum measured WAL-object delay 52,427 ms after COMMIT, restore verification 304,128 ms including operator pacing, committed markers present, rollback absent, exact 5 GiB reclaimed. These are individual measurements, not a zero-loss or full Phase 4 guarantee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-10-04 | 1 transport and scale     | VPC TCP returned raw streams and could not supply the native WebSocket; VPC HTTP native forwarding passed in 235 ms, with the signed Tunnel path retained as fallback. Across 1,000 paired SELECTs, verified-TLS Kubernetes port-forward p95 was 29.093 ms and WebSocket p95 35.541 ms. 100 MiB/1 GiB COPY and SELECT integrity, 103.804 s slow reception and 600,002 ms idle passed. Fifty warmed sessions returned 7,403 exact parameterized SELECTs in 10,063.836 ms: 735.604 SQL/s, p95 75.368 ms, zero errors, all clients closed. Sustained ramps, connection-rate limits, backend density and the bottleneck remain unmeasured. The corrected actual local Actor/Edge probe counted zero D1 prepares for 1,000 unregistered IDs; the deployed endpoint refused all 1,000 hints and closed every socket in 41.275 s at concurrency 20. This does not establish a sustained connection-rate ceiling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-04 | 1 client and isolation    | Deployed Workers clients passed bounded pool/backend reuse, default-text byte fidelity, prepared statements, transactions, authentication, startup mismatch rejection and isolation across two real databases/users, with zero outstanding leases after cleanup. Decoded binary assertions remain failed on direct TCP and WebSocket due to upstream parsing; no assertion was removed. D1/Tail secret canaries were absent. Actual failed API requests emitted a generated diagnostic ID and a bounded route-template log without plaintext credentials. Intermittent Tail correlation remains unresolved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-04 | 2 in progress             | Installable CLI passed 28 local checks and real psql commit/rollback plus 105,216,021 raw binary COPY bytes in 2,614.726 ms with control checksum equality. CPU placement, bounded metering and local lifecycle logic are implemented; full hibernation/wake, collector and cost acceptance remains pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-04 | 2 admission / density     | Deployed Actor admission, external Edge binding and immutable usage snapshots passed a fresh E0–E5: Ready 23,989 ms, cold connect 645 ms, commit/rollback 41/46 ms, one base backup and nine WAL objects; delete 35,140 ms, agent restarts at create/delete and complete cleanup. Stable node: 3,000 CPU millicores, 1,260 platform reserve, 6,799 MiB RAM and 1,878 MiB platform reserve; small fits twice by CPU and four times by RAM. On one real small database, sampled PSS maxima for PostgreSQL/Barman were 116.442/49.832 MiB idle, 127.419/49.832 MiB under 20 s paced read load and 131.351/173.293 MiB during a completed base backup, with no Pod restart. RSS sums double-count shared pages; these sampled PSS maxima exclude the sampler, while cgroup values include it. No smaller class, exact backup-only peak or 1,000-customer density is accepted from this workload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-04 | 2 local safety / metering | Real local PostgreSQL 18 proved transaction/prepared-work guards, exact closed-WAL acknowledgement, and gateway pipeline/transaction quiescence. The actual gateway replacement drill preserved the fence UID, loaded the persisted quiesce intent on the replacement, acknowledged release on both replicas and rejected stale begin on both. Readiness remained stable through two relists after correcting actual Kubernetes list-item metadata handling. A bounded one-minute metering cron is implemented and locally checked. A 1,000-DB local D1 fixture bounded metering to 600 submitted statements and the whole cron to 850. Uncomputed hours remain pending; missing samples stay null with named gaps. API/Actor lifecycle tests cover ten-waiter wake coalescing, exact observations, role changes, cancellations and timeout compensation. Real resize to 512 MiB/250 millicores completed in 28,046 ms with unchanged storage and data, one Pod replacement and idempotent replay; held-client reconnects were not counted. A fresh Dev database verified internal maintenance-role TLS, authentication and minimal grants, then complete trial cleanup passed. The manual shutdown/WAL/resume drill passed with preserved data and storage, but its 19,830 ms resume connection exceeds the ≤8 s target. Automatic idle/coalesced cold-wake acceptance, real collectors and infrastructure costs remain incomplete. |
| 2026-10-05 | Operator recovery | CI `37360915487` and the fully qualified regional `e9569169` image are delivered; agent/two gateways and five platform releases stayed Ready for 62.768 s on the unchanged first EU node. API full restore / PITR / restore after source deletion passed in 82.531 / 65.562 / 75.328 s. Targets retained separate volumes, storage generation 2, configuration revision 1, SQL identity and nonsuperuser app access; temporary administration was removed. An isolated real DO admission probe refused registered excess with 53300 and unknown role with 28P01 before D1, with no writes/wake/state change; probe deleted. Fresh D1 export plus local migration rehearsal preserved 31 tables / 38,154 rows with clean integrity and foreign keys. EU2, US, lost-worker recovery and final operational protection acceptance remain pending. |
| 2026-10-05 | Operator protection / EU expansion | Natural 351.928 s stale heartbeat excluded a physically Ready node; fresh observations placed the same pending database and it became Ready. A genuine Barman option rejection reported failing backup health while retaining the last completed backup; configuration and agent/Flux state restored, fault object and all recovery/stale namespaces removed, disposable API key revoked. Fresh migration rehearsal preserved 38,547 rows and three custody records; migration 0017 and capacity-policy/rescue-identity API fixes delivered. Live signed IPv4/NAT and direct IPv6 controls passed. EU has two real small reservations on EU1 and one pending demand; existing EU2 adoption audited under cap 2 with purchases disabled. Duplicate provider display-name rejection reproduced; cosmetic wire-label/readback fixes pass 44 tests. EU2 installation, dual-stack network proof, node-loss recovery and US remain unaccepted. Hosted CI/native runner jobs fail assignment during the reported GitHub Actions incident; US purchase approval pending. |
| 2026-10-06 | EU2 rescue / installation preparation | Management API `00619393`, Edge `b196fbaa` and regional `e9569169` are deployed; CI `37378985882` is green and hosted runner assignment has recovered. Native bootstrap `sha256:a46d6824c342f9068af103558981ca1b0a033fedd2ccf0822f80a3f70df5d8d4` is qualified from `00619393`: 711,899,012 bytes, 18 layers, zero unresolved findings and complete registry readback. Cosmetic firewall labels were applied with exact assignment/rule readback. EU2 RAM rescue passed strict known-host/client-key verification and measured one unmounted 161,061,273,600-byte disk, 8,326,418,432 bytes RAM and no swap; the disk is untouched. EU1 peer /32 routing was applied without reboot, preserving node identity, custody and readiness; a corresponding early Talos image route is measured and pinned. The RAM-backed rescue overlay has only 832,643,072 bytes in `/run` for 4,685,444,428 installer bytes; portable-swap, overlay and operation-specific RAM scratch fixes passed actual strict-SSH inspection, fresh setup, matching resume and pre-write guards. The isolated tmpfs measured 5,222,318,080 total / 5,222,313,984 free bytes and was removed with source/identity guards; disk writes remained zero. Corrected runtime qualification/delivery, fresh full outside scans/signed preparation, EU2 join, US installation, lost-worker recovery and coordinated cluster credential rotation before Neon migration remain outstanding. US purchase requires the pending costed approval. |
| 2026-10-06 | Native rescue runtime / network proof | Bootstrap source `269ca6c6` passes all 59 native tests and actual strict-SSH RAM staging/guard preflight. Qualified image `sha256:c4a0fc39989dcdee33854ce1dbfc2d60ae4e92a7bc1334f558f64bd05b1ed1f7` covers 711,909,770 bytes / 18 layers with zero unresolved findings; private-registry readback verified 161,610,900 compressed bytes. API and exact Container image/namespace binding are deployed, original secret names retained, CI `37384157373` green. EU2 immutable input is configured at checkpoint zero with zero downloaded/written bytes. Full 65,535-port IPv6 scans passed for both members; actual relay access passed all three management ports per member using bounded RAM-only rescue listeners, which were removed. Hosted IPv4 run `37384991932` failed with a masked scanner reason; reproducing tests pass for bounded diagnostic propagation. Combined signed preparation and installation remain pending. |
| 2026-10-06 | EU expansion accepted | API/native `cf6d5d55` delivered; full CI `37415049259` green. Qualified native image `sha256:1b9a38a4e43ba87ef997eab71ed6799a3c4377cca00485f842e693ebac371923`: 711,913,354 bytes / 18 layers, zero unresolved findings and 161,611,765 compressed bytes verified from the private registry; completed rollout and exact running instance readback. Real 1 GiB allocation/reclamation published 95 GiB on EU2 in 124.433 s and removed all trial storage. Full signed dual-stack proof passed in hosted run `37415715455`; native admission reached released revision 506 and addition Ready revision 15 with unchanged EU2 Node UID. Two real 600-millicore capacity databases run on EU1 and a third on EU2; all passed normal Cloudflare SQL identity and nonsuperuser role checks. Real unfiltered capture confirmed encrypted peer traffic, zero plaintext Pod traffic and zero kernel drops; the final capture Pod is absent. EU1 identity, three custody records, agent, two gateways and five platform releases remain healthy. The disposable EU2 recovery source has two confirmed commits, a completed R2 base backup and the post-commit WAL segment; source physical volume identities are retained. US purchase at at most €20.09 gross/month and €0 setup is owner-approved, but US installation and EU2-to-US1 loss recovery remain pending. |
| 2026-10-06 | Cross-region delivery / US control plane | Cross-region target selection and distinct source archive credentials are delivered from `ab678993`; full CI `37419289338` is green. Regional image `sha256:53f9aaafdbda2f776a3ba20691f01a6ed6376638f02dcf436332b5056f54f735` qualified 658,584,124 bytes / ten layers with zero unresolved findings; anonymous registry readback verified all layer/configuration identities and 89,764,233 compressed bytes. One Recreate agent and two gateways plus five platform releases stayed Ready for 69.78 s. Both EU Node UIDs, three database namespace/Cluster/PVC/PV/Secret identities and three EU encrypted custody records remained exact. Normal Cloudflare SQL verified all three placements and both disposable EU2 source markers. API/Edge publish preserved every existing binding/secret and added only US archive/gateway bindings. US has a real default-jurisdiction R2 archive with North America hint, separate bucket-scoped non-expiring US write/EU read credentials, private Tunnel/VPC and once-issued region custody. The retained first-node relay restarted under UID/version guards; its actual new epoch confirms the same issuer/capabilities and EU/US scope. Native bootstrap remains qualified `cf6d5d55`, exact application/namespace and completed rollout; currently inactive with zero instances, with running-image proof retained from EU2 admission. No US order or EU2 failure action occurred. Public one-month quote is €19.76 gross with 19% VAT / €0 setup; owner account VAT/country verification is pending within the approved €20.09 cap. US installation and EU2-to-US1 recovery remain unaccepted. |
