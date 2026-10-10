# ULTRA — one image, automatic fleet patches, fast PostgreSQL

**Owner reset, 2026-10-10. Canonical plan/status; customer readiness remains open.**
Reuse US1 and existing code.

## Done

| Date | Reusable result | Evidence / limit |
| --- | --- | --- |
| Oct 8 | API, lifecycle, backup/restore/PITR, sleep/wake | Historical PostgreSQL 18.6/TLS 1.3; four base/WAL checks; 20 GiB reclaimed; EU→US restore 87,988 ms. Older thick-storage baseline. |
| Oct 10 | Three nodes registered/Ready | Observed 08:08 UTC: EU control + EU1 + US1. EU Talos/Kubernetes 1.14.1/1.36.3; US 1.14.2/1.36.5. Not uniform. |
| Oct 9 | Threshold, purchase switch, optional notification configuration | Trial 124.523 s; defaults 103.865 s, zero purchases/mail. |
| Oct 9 | US keys rotated | Custody revision 2; seven old/new access pairs checked in 154.466 s. |
| Oct 10 | US supported patch | Original operation complete/confirmed at revision 38. Subsequent inventory drift and null RAM remain. |
| Oct 10 | Daily D1/etcd backup implementation deployed | API 85918cb6/D1 0039; disabled, no accepted daily run. |
| Oct 10 | CLI stdin class fixed; gateway watch correction built | CI 38031252627: code check + Regional/Bootstrap passed; installer publication failed. Gateway not deployed. |
| Oct 10 | Golden installer + matching raw published to R2 | Five original objects, 396,907,240 B fully read back; raw 245,551,396 B compressed. Public digest retrieval awaits API delivery/release approval. |
| Oct 9–10 | Rust artifacts built | Five native images qualified by CI 37972707745; live runtime/pool acceptance pending. |
| Oct 10 | Final integrated CI and API delivery | CI 38048525921 passed at source 5c3b03b. API module SHA d5a76c6e… is deployed at 100%; container 44/D1 0040. Three hosts and four database records preserved. Bootstrap mirror: 18 layers, 163,193,295 compressed bytes fully verified. |
| Oct 10 | Public Golden distribution verified | Two original installer layers and 245,551,396 raw-image bytes verified through the Cloudflare API's public digest endpoints. Common release r1-ultra-5c3b03b approved. |
| Oct 10 | One fleet intent persisted | op_f9shyukodjb1b8vs54gr selects US1/customer → EU1/customer → EU/control_relay. US patch op_h6j47nsw7pz6wljscpdr is pending in preflight at revision 0; no host write has started. EU authority changes wait for the required accepted snapshot. Zero Contabo calls in these actions. |
| Oct 10 | Complete US preflight readback | All 59 reads and semantic checks passed in 218.640 s. The initial runtime measurement was then 178.383 s old, exceeding the API's 60 s freshness gate. The batch preserves original timestamps and gives checkpoint proofs a bounded 600 s window, exceeding twice the measured collection time; transport authorization and identity checks remain unchanged. |
| Oct 10 | Observed-error correction batch verified locally | API 898/898 tests (104.78 s), Bootstrap 378/378, contracts 195/195 and image-input selection 14/14 passed. Independent source review clear; all nine native generators unchanged. Final CI/publication pending. |

## Open

| Work | Missing customer-readiness result |
| --- | --- |
| Golden R1 | Public immutable delivery and release approval passed; actual host convergence remains open. |
| Automatic convergence | Existing fleet intent retained. Batch corrections cover legacy agent schema projection, historical Talos STATE provenance, command budgets, parallel Flux reads and checkpoint freshness; reviewed delivery and live completion pending. |
| Functional baseline | Integrated API delivered; three-node live convergence and functional acceptance pending. |
| Operations/capacity | Daily R2 backups/alerts, thin storage, sleeping CPU release, startup bounds, restore and measured density. |
| R2/handover | Rust/shared pool, subsecond first SQL/refill, automatic R1→R2, migration instructions. |
| First daily backup | Run 1ebb9c1e-e353-4c31-b394-863d825a9440 failed in 86.476 s before export/native capture. Workerd rejects redirect:error; the three Worker-side sites are being corrected together. No accepted D1/etcd artifact yet. |
| Routing credential retirement | A historical route master was accidentally printed during private inspection. Identity-bound reads confirm its derived key remains active in both gateways; the US encrypted installation profile also retains it. Owner exception to the no-further-key-rotation instruction is pending. No key changed. |

## Delivery architecture

**A — Golden image.** R1 reuses US1's Talos 1.14.2/Kubernetes 1.36.5 baseline, adding the
sandbox extension, `dm_thin_pool` and base kernel arguments now. Installer/raw image share one
recipe; `versions.lock.json` supplies Kubernetes/Flux/platform/PGCF pins. Reuse qualified bytes;
build changes once in CI. Publish original OCI bytes to Cloudflare by digest-preserving registry
copy, replacing Docker push; publish raw bytes by hash. IP/hostname/route/role stay configurable;
unavoidable retained-node network schematic variants are documented parameters.

**B — Secrets.** Generate fresh cluster authority for new clusters and scoped node credentials;
joiners use destination-cluster authority. Encrypt custody in Cloudflare, outside images;
log only safe metadata/hashes. Activate prepared EU replacements during patching, combining
restarts. Verify new access/old rejection. This supersedes the rotation pause; retain US revision 2.

**C — New node.** AddNode: Contabo API purchase → Rescue → golden image → protected configuration
→ join → PGCF. Cloudflare persists one order/progress; uncertain writes require readback.
Provider calls stay at lifecycle boundaries, outside routine management transport.

**D — Existing nodes.** One Cloudflare target-release request selects region/fleet. Extend
assignment/PatchNode to start untouched members and resume serially: US1 → EU1 → control,
respecting Kubernetes dependencies. Automatically upgrade Talos/Kubernetes and converge Flux;
skip current components. No second journal, laptop/private helper or operator step after the
request. Every new release follows this process.

**E — PGCF.** Flux installs platform/Regional services from the release. Fresh authenticated
RAM/inventory enrolls nodes; functional acceptance opens placement. Control retains its role.
Cloudflare handles database ingress; management ports are restricted, public PostgreSQL closed,
Talos SSH absent. All nodes share release/policy semantics.

**F — Parallel Rust/pool.** One owner completes native regional components, Rust/Wasm Edge and
prestarted unassigned compute alongside A–E. Preserve CNPG, volumes, exclusive ownership and
isolation. Ship integration as R2 through the same workflow; R1→R2 proves automatic patching
before migration.

## Node acceptance

Exactly six checks per node:

1. Release Talos/Kubernetes versions; Node Ready.
2. Flux HelmReleases/Kustomizations Ready at selected revision.
3. Cloudflare receives fresh, nonempty RAM/inventory.
4. Create DB → SQL/TLS through `db.ohmyho.st` → delete → physical storage reclaimed.
5. Real database base backup and WAL in R2.
6. Existing databases answer SQL; record deliberate test-data replacements.

A control-node acceptance DB is temporary; ordinary customer placement stays disabled there.
EU test databases may be deleted/recreated if obstructive. Checks 4–5 share a DB; backup precedes deletion.

## Execution

Owner target: October 10–11.

| Step | Owner / timing | Finished when |
| --- | --- | --- |
| 1 — done | Integrator, Saturday, ≤1 hour | Concise plan replaces contradictions; Done/Open evidence checked. |
| 2 | Image owner, Saturday | R1 installer/raw image retrievable by immutable reference; manifest published. |
| 3 | Patch owner + parallel node readers, Saturday | Full three-node read-only preflight; all fixes in one reviewed batch, one CI/delivery; preflight passes. |
| 4 | Integrator, Saturday | One API request completes US1→EU1→control and EU key activation; six checks pass without intervention. |
| 5 | Operations owner, Sunday | API enables daily backups; D1 + both etcd artifacts verified in R2; owner configures sender/recipient, test alarm received. |
| 6 | Capacity owner, Sunday | Thin DB, one backup/restore/delete; sleeping CPU released; DBs/node and fit for 22 projects measured. |
| 7 | Rust/pool owner from Saturday, integrate Sunday | Automatic R2 on all three; sleeping DB's genuine pool-hit first SQL <1 s; pool refills. |
| 8 | Integrator, Sunday | Handover: API, WS/TCP adapter, timeouts, restore/new DB ID, capacity and recovery. Neon migration separate. |

One integrator combines image/patch, Rust/pool and operations/capacity owners. Read all nodes
in parallel; collect failures and fix whole observed classes. Compare values semantically and
use controller Ready/revision. Preserve identity, authorization and uncertain-write protections.
Target toolchain; focused tests, one review/CI per batch, reuse unchanged artifacts. No added
proof/approval/diagnostic layers or long monitors/soak series. Report completion with numbers;
explain overruns by error class.

API-only policy: 256 MiB PostgreSQL steps through 4 GiB; configurable actual-RAM threshold
(here 76%) over ten fresh consecutive minutes/stable Node UIDs; purchase switch. No 81% stop or
fixed cap. Suitable nodes remain available during expansion; hard resource/startup/backup-peak
checks apply. V159/monthly; fresh installs buy/send nothing until configured.
[Runtime detail](rust-runtime-and-cold-starts.md) and [runbooks](../operations) support this plan.
