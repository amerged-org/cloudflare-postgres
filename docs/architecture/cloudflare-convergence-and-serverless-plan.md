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
| Oct 10 | Observed-error correction batch verified | API 898/898 tests (104.78 s), Bootstrap 378/378, contracts 195/195 and image-input selection 14/14 passed. Source ffcc617 passed CI 38058588439: check 18m45s, Regional and Bootstrap images 1m52s each. Native five, PostgreSQL and storage images reused; publication pending. |
| Oct 10 | Scoped route authority retired | All four current gateway Pods reject freshly signed old tokens with HTTP/WS 401 and accept new WebSockets with 101. Edge and API use only route-20261010; modules, bindings and other secrets preserved. Current private custody updated. All three EU databases still pass SQL/TLS 1.3/app-role checks in 590–767 ms; two marker rows and their hash unchanged. |
| Oct 10 | Management latency correction delivered and measured | b793273/CI 38063853988/API 2e9e762a at 100%; all images and Bootstrap version 45 reused. All ten targeted reads passed in 20.414 s under backup load. Grant authorization 2.8–4.6 s versus 14–16 s; Talos 9.9–11.0 s, machine configuration 6.9 s. Same US patch confirmed preflight/revision 1 at 16:03:47 UTC. |
| Oct 10 | Same daily backup independently verified | Run 1ebb9c1e-e353-4c31-b394-863d825a9440 completed at 15:59:56 UTC; successful Workflow 232.720 s. R2 ciphertext: D1 316,307,388 B; EU etcd 28,471,850 B; US etcd 32,530,986 B. All hashes/GCM identities verified; D1 integrity OK, zero FK violations, 56 tables/410,685 rows; etcd 982/821 keys. Temporary plaintext removed. No new run ID/object keys or Contabo calls. |
| Oct 10 | Isolated Golden EU-role boot passed | Corrected lab attempt2 passed in125.696 s:control etcd/trustd/kubelet healthy; customer kubelet healthy (worker has no etcd/trustd). Both authenticated Talos1.14.2/Golden762c…/sandbox3b6…, one boot each, no fallback. Same target/raw hashes; one empty local bootstrap. First604.937 s attempt had a lab /24-versus-real-/23 routing error. Lab time/cache/identity overrides explicit; no production network/data/pool claim. All VM/config/ISO/overlay resources removed. |
| Oct 10 | All-role manifest validation passed | Actual R1 program targets passed strict server-side dry-run:US91 objects/6 categories; EU customer/control94 each/7. Logical279 role documents,21 final CLI invocations; HTTP count unmeasured. Identical EU platform20 validated once with the actual Kustomize field manager. Retained relay six-string data hash acbebad3… unchanged; zero resource/provider writes. |
| Oct 10 | US Golden runtime accepted by the same operation | H6 confirmed Golden762c655d…/bootc74415e8…: Talos1.14.2, Kubernetes1.36.5, NodeReady, loaded/running sandbox extension, healthy etcd/trustd; physical/cluster/volume identities preserved. Readback3.628 s; programmed runtime verification139.457 s. Fresh RAM3,687,542,784/8,308,830,208 B (44.381%), pressure0. Bounded operator recovery was required; final release acceptance remains open. |
| Oct 10 | Admission freshness correction delivered | db7644e/CI38076538637 passed; API7cc2cdfc… at100%, modulec5edf272…, Bootstrap48/c06e529c…/max2. Publication333.586 s, one mirror/one publication, zero Contabo calls. The same H6 created its three admission objects; EU hold and retained databases preserved. |
| Oct 10 | Actual normalized admission readbacks checked | Two targeted server-side dry-runs returned US/EU admission and Node-label JSON; zero writes/provider calls/grants. The only old-target difference was Binding matchResources.matchPolicy absent→Equivalent. Declaring that default makes all semantic comparisons pass; Policy Exact and wrong-binding rejection remain. Failing-first runtime9/9 and image-selection14/14 tests passed. Only Bootstrap needs rebuilding; Golden/sandbox bytes unchanged. |
| Oct 10 | Binding-default final CI and delivery passed | 4cc3d3d/CI38080065517 passed: check23m54s, Bootstrap2m8s; other image jobs skipped. Publication250.682s: API7e9b6652… at100%, unchanged modulec5edf272…, Bootstrap49/a0e3f1ea…/max2. One mirror/publication, zero Contabo/DB/resume/EU-server actions. Same H6/revision28 and EU hold retained for the live runner. |
| Oct 10 | R1→R2 compatibility batch prepared | A completed multi-node fleet's immutable confirmed host_ready history incorrectly caused409 on the next release. Failing-first D1 regression now passes202; affected suite14/14, types/lint/format passed. Both precheck/CAS exclude only confirmed host_ready; previous-fleet completion and unknown-write rejection remain. Three native workload descriptors added to the private candidate. Final publication bindings and live R2 acceptance remain open. |
| Oct 10 | US main patch completed | H6 complete/confirmed34 at20:20:21 UTC, Workflow complete20:20:43. Admission29 and PostgreSQL32 passed with zero errors; original cf5 remained queued/gen3. Programmed software-metadata sync advanced custody2→3 with all six CA/client/key identities unchanged. One existing finalization7vpr… owns current host activation; final Ready remains open. |
| Oct 10 | Physical host-file activation bug reproduced | Talos1.14.2 no-reboot/auto persists declarations but writes machine.files only at boot. Declared Mat3/actual Mat2 incorrectly matched. Focused Native41/41 and contracts200/200 now pass: exact two-file readback, existing host-only service-stage fenced reboot, unchanged-file no-op, unknown reboot read-resolution and full same-OS physical proof. No live reboot or image rebuild yet; independent review/CI/delivery remain gates. |
| Oct 10 | Host activation correction delivered and US1 released | e713274/CI38085205120 passed: check21m51s, Bootstrap2m9s, Regional1m38s qualified but not deployed. API05cdf4e9…/module2ab836db… at100%, Bootstrap50/c2fb8c82…/max2; publication274.599s. Same7v complete/confirmed12 at21:35:28 UTC, placement reopened. One programmed activation reboot be0e25eb…; both physical Mat3 files, service and two fresh pool slots verified. Finalization4490s, publication→Ready1027s; three earlier manual US interventions retained honestly, zero routine Contabo calls. US six-check database acceptance and both EU members remain open. |
| Oct 10 | Remaining US read-only preflight passed | Eight Native reads/44 D1 SELECTs in6.758s, zero writes/grants/provider calls; all26 components and Flux/platform/regional matched. Admission remained valid. The known preactivation Mat3 pool absence was later closed by the programmed activation. |
| Oct 10 | Periodic inventory failure reproduced and raw-report path proved live | TS Pod-side OCI requests were denied by API-only egress; live quay.io timeout2153ms. Laptop collector20.973s/43Kube+11registry returned0; raw source inside the existing Agent performed90 realKube reads in1.236s, zero registry calls, one real report at21:55:16 UTC. Existing authenticated POST200 made US release CONVERGED with no mismatches. One authorized operator observation write, zero host/deployment/provider writes. Failing-first blocked-metadata regression and14 inventory tests/types/lint/format pass. Existing CF verifies raw OCI aliases; no wider egress, new API, lock/native/Golden change. Qualified source CI and automatic periodic acceptance remain open. |
| Oct 11 | Post-boot serving-pin gap proved and original canary placed | Actual statsSummary failed kubelet_tls_failed after host-only activation bypassed verify's existing trust refresh. Same-format PEM/DER hashes proved a stale public leaf pin. Existing identity-fenced helper made one same-UID ConfigMap CAS984158→1051870, no keys/reboot/provider action. Normal sampler recovered22:05:23 UTC: capacity8,308,834,304B, working3,665,113,088B, available4,643,721,216B, pressure0. Original cf5/H4/gen3 placed on original US node22:06:26 UTC, without recreation. Future two-file fix reuses that helper before host-service confirmation/successor; failing-first regression and27 affected tests/types/lint/format pass. Completed7v stays immutable; qualification/delivery and SQL acceptance remain open. |
| Oct 11 | Initial-create generation mismatch reproduced as one class | Qualified queued release updates advanced cf5 desired1→3 while original H4/create1 remained running. Existing contract allows historical creation, but TS namespace/power and Rust power added equality checks. Three redundant predicates corrected; original op/archive/storage1/never-ready and CA/PV/Namespace/Cluster/tombstone/uncertain-write protections remain. Failing-first130 TS and22 Rust tests, types/lint/Clippy/rustfmt pass. Actual first-create producer built13 manifests with real US inputs and no further builder/credential errors; zero writes. One final combined qualification is next; source DB stays untouched. |
| Oct 11 | Corrected consumer qualified; original create resources preserved | 6fd9163/CI38090925191 passed: check24m, Regional1m41s, Bootstrap1m42s plus selected controller/reclaimer. APIb4cb31c7… at100%, unchanged module2ab836db…, Bootstrap51/34cac915…/max2; publication269.318s. One guarded H4 timeout reactivation preserved18 immutable fields, gen1/archive/storage1; two qualified source-consumer cycles2.415/3.063s created original Namespace/Cluster/PVC/fence then verified them. One no-reboot operator removal of the sole persisted bootstrap taint plus conditional public-pin refresh retained bootbe0e25eb… and all31 other config documents. CNPG is Ready; no SQL seed. First-ready remains closed on failing WAL archive. H4 timed out again at23:27:04 UTC and was not retried. |
| Oct 11 | Native sandbox file omission proved and corrected | Healthy DNS/network, both actual OCI specs lacked resolver/hostname mounts; sidecar files absent, main image-layer fallback unreliable. Actual containerd root/default and missing source files proved. Custom sandbox omitted upstream setupSandboxFiles. Minimal four-file fix creates the received CRI DNS/hostname pair0644 beforeReady and cleans only owned files after children stop; no newSettings/node-runtime/devshm/PVC/Secret change. Baseline real containerd2.3.6/runc1.5.2 failsNotFound; fixed proof37.812s passes resolver/hostname child mounts/exec, SQL/PVC, isolation/restart/refill and foreign-file failure cleanup. Claims26.046/26.667ms, miss1985.886ms are local runtime timings, not DB cold-start acceptance.18 units/Clippy/rustfmt and independent review pass. Dev automatic CRI mounts/R2/WAL remain open. |
| Oct 11 | Safe held-target replacement implemented and tested | Existing rollout POST accepts explicit expected_previous_rollout_id only for exact unchanged ordered physical members, approved different immutable release and quiescent native/bootstrap/provider states; untouched EU snapshot hold0/staged2 is copied. Atomic first-anchor repeats oldJSON/revision/material/hold/quiescence checks. One bounded predecessor snapshot lives in existing desired metadata; old GET is blocked and old capabilities cannot advance. No table/journal/newstatus or completed-receipt rewrite. Failing-first scenario plus15 API/3 contracts/types/lint/format and independent review pass; no live replacement yet. |
| Oct 11 | Native AMD64 CI failure bounded and diagnosed honestly | 0ff4393/CI38097359321 passed product and Linux-runtime tests, then shared sandbox step failed proof_runtime/exit1 after246.355s; image jobs skipped, zero publication. Exact original-limit local harness passed216.466s total/25.319s runtime onARM64, exit0; this does not explainAMD64. Observed harness lost exit/signal detail. Minimal correction preserves child exit/signal/timeout/elapsed and scoped Docker exit/OOM/status, hashes the complete existing private log with bounded8MiB classification, and retains only safeJSON on failure. Failing-first3/3 tests/types/lint/format and independent review pass; no runtime/resource/deadline changes or raw-output artifact. One corrected CI remains required before any new Golden composition. |

## Open

| Work | Missing customer-readiness result |
| --- | --- |
| Golden R1 | Public immutable delivery and release approval passed; actual host convergence remains open. |
| Automatic convergence | Existing F9/H6→7v released US1 at21:35:28 UTC with current Mat3, exact host files and fresh two-slot pool. US six-check database acceptance is next; both EU members remain held. US counts three historical manual actions, plus one programmed activation reboot. |
| Functional baseline | Integrated API delivered; three-node live convergence and functional acceptance pending. |
| Operations/capacity | Daily R2 backups/alerts, thin storage, sleeping CPU release, startup bounds, restore and measured density. |
| R2/handover | Rust/shared pool, subsecond first SQL/refill, automatic R1→R2, migration instructions. |
| Backup alarms | The daily D1/etcd R2 run passed full independent verification. Optional sender/recipient configuration remains unset; a real notification test remains open. |
| Routing template authority | Live retirement and b793273 API delivery passed. The immutable US profile keeps historical custody; current composition derives the live route authority from Cloudflare. R2 native gateway acceptance remains open. |
| US post-reboot host-file correction | Talos1.14.2 requires existing files for overwrite. Our two new /var files were declared overwrite, blocking WriteUserFiles before etcd/trustd registration. The failing regression and32 affected tests now pass with create; unrelated configuration and identity/write guards remain. The supported no-reboot US repair was accepted once and changed only those two operations (full configuration a67c450c… →3adc946d…). The paused boot task did not rerun after apply; one identity-bound corrective reboot was accepted once. Fresh boot68a54885-4527-40f0-a31f-e1d011ea8fa5 retains the repaired configuration and both files exactly match the declared bytes. Ten direct authenticated reads passed in1.603 s: etcd/trustd healthy, Kubernetes1.36.5 responds, Node/Cluster/DMI unchanged. Node readiness/platform acceptance remains open. Source b5c050c passed CI38068917261; only Bootstrap rebuilt. Talos reverted the failed Golden boot to its retained slot. A single supported rollback was accepted to select the already written Golden slot, preserving the same H6 operation/installer receipt; no EU change, new installation or provider action. |
| Admission default correction | Fresh-report and explicit Binding Equivalent corrections are delivered. Real normalized readback and strict altered-value regression passed; the live runner must complete the same H6 and US six-check acceptance before releasing EU. |
| Management transport latency | Reproduced TLS setup failure is closed by the measured b793273 correction. Existing US patch passed preflight; host convergence remains open. No further timeout increases. |
| Thin-storage admission correction | Source 66aedf passed CI38067216773 and nine focused tests. It requires the actual pgcf-sandbox-controller Talos extension instead of a nonexistent Pod. It joins the observed host-file correction below in one delivery; existing images are reused except the changed Bootstrap executor. |
| EU host activation acceptance | US same-job activation passed with physical files/new boot/current pool and no manual restart. EU must now prove the corrected existing workflow after US database acceptance; its hold is still retained. No new installer, key rotation beyond prepared EU authority, journal or privileged file writer. |
| Periodic inventory | R1's legacy collector duplicates OCI metadata IO outside its permitted Pod egress and cannot refresh reports. The minimal raw-report correction passed actual US operator acceptance; old immutable R1 pins remain untouched. R2 native already uses raw inventory and must prove automatic periodic refresh. US counts one operator observation POST separately; no equivalent EU exception is assumed. |
| Post-boot Kubelet trust | Current US public serving pin is repaired through the existing guarded helper, with real RAM/placement recovery. Future host-only workflow correction awaits one CI/delivery; both controllers retain strict TLS validation. EU remains held until US six-check acceptance and the correction's delivery. |
| Original US create | Historical-generation correction is qualified and created the original Namespace/Cluster/PVC/fence. H4 remains the original generation1/storage1/archive authority; it timed out again while first-ready archive was blocked. Resolve that actual owned-resource state after the native fix; do not roll back generations, recreate the DB or manufacture readiness. |
| Current US database acceptance | Corrected original CREATE produced actual CNPG/PVC resources; first-ready is closed because Barman's resolver/hostname mounts are missing. Source H4 failed operation_timeout again; no repeated retry, SQL seed or resource replacement. Qualify/deploy the corrected immutable sandbox image, prove real generated mounts/archive, then resolve same-order authority with retained owned storage witnesses. |
| Corrected immutable fleet target | Combine sandbox files, admitted-node persistent quarantine and safe held-target replacement in one qualification. Actual sandbox bytes require one new Golden installer/raw recipe. Replace only the quiescent held target through the corrected API; preserve EU hold until US six-check acceptance and rebind its helper to the actual successor. Existing VPS/data/keys and historic F9/H6/7v receipts remain; no false completed-old-rollout claim. |

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

Owner target: October10–11; October10 19:45 coaching supersedes the earlier order.
US1 required **three operator interventions**: two-file configuration repair, corrective
reboot and supported return to the written Golden slot. Its six-check acceptance is still open;
record it as accepted with interventions only after those checks pass. EU must demonstrate zero interventions.

Before any EU write: finish US's six checks; render all three actual role projections and run
server-side dry-run; perform one isolated AMD64 Golden boot scenario for the rendered EU customer
and control configurations; retain current configs/hashes, the accepted R2 snapshot and direct
control Talos access. F9's existing EU rotation checkpoint is held at snapshot/halted with
operator_hold_us_acceptance; only explicit release after these gates may continue EU.
Sunday12:00 target: genuine shared-pool sleeping-DB first SQL plus refill, or an exact observed
blocker. Capacity/thin density and the common R2 rollout/handover follow. No additional test series.

| Step | Owner / timing | Finished when |
| --- | --- | --- |
| 1 — done | Integrator, Saturday, ≤1 hour | Concise plan replaces contradictions; Done/Open evidence checked. |
| 2 | Image owner, Saturday | R1 installer/raw image retrievable by immutable reference; manifest published. |
| 3 | Patch owner + parallel node readers, Saturday | Full three-node read-only preflight; all fixes in one reviewed batch, one CI/delivery; preflight passes. |
| 4 | Integrator, Saturday | Same F9 completes US1, then gated EU1→control and prepared EU authority. US counts three physical operator actions; EU six-check acceptance requires zero interventions. |
| 5 | Operations owner, Sunday | API enables daily backups; D1 + both etcd artifacts verified in R2; owner configures sender/recipient, test alarm received. |
| 6 | Capacity owner, Sunday after pool | Thin DB, one backup/restore/delete; sleeping CPU released; DBs/node and fit for22 projects measured. |
| 7 | Rust/pool owner, Sunday12:00 milestone | Sleeping DB's genuine pool-hit first SQL <1 s and refill, or concrete blocker; same programmed R2 rollout then converges all three. |
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
