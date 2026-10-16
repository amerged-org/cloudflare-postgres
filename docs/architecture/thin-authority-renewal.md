# Thin write authority from in-region observations

Status: **option 1 approved by the owner on 2026-10-13, including the EU1 thin selection, and
deployed**: native sampling, capability gating and the composed authority run on the EU fleet.
The live acceptance checks of section 11 remain required on the go-live release. The
[ULTRA plan](cloudflare-convergence-and-serverless-plan.md) records the current Done/Open state.
Options 2 and 3 (section 12) were not pursued.

Implementation correction, 2026-10-14: the pinned kernel exempts metadata and swap bios from
ordinary `io.max` throttling. The rate-window formulas below do not establish a hard bound on
all physical allocation and are superseded for admission and renewal by conservative accounting:
reserve each retained Thin LV's full measured logical size, deduplicate only exact matching
volume reservations by their maximum, and retain unmatched obligations additively. Missing or
ambiguous physical identities fail closed. An expired write permission does not erase an LV's
exposure; retained inventory may inform conservative accounting without granting write authority.

Suspension flags, Pod absence and per-LV used bytes do not release this reserve. Release currently
requires exact physical reclamation. This is a temporary safety constraint: sleeping overbooking
still needs a proven global no-write state and fenced resumption before its reserve can be released.
Cloudflare remains the sole signer and the two-proof renewal design remains unchanged.

Citations: `path:line` refer to origin/main `ab07c82`. `plan` is the
[ULTRA plan](cloudflare-convergence-and-serverless-plan.md) and `ops` is
[recovery.md](../operations/recovery.md); `api/` is `apps/api/src/`, `dom/` is
`apps/api/src/domain/`, `nb/` is `apps/node-bootstrap/src/`, `nc/` is
`apps/native-controller/src/`, `gw/` is `apps/native-gateway/src/`, `sc/` is
`apps/sandbox-controller/src/`, `np/` is `packages/native-protocol/src/` and `ct/` is
`packages/contracts/src/`. Upstream sources [O1]–[O5] are OpenEBS LocalPV LVM 1.10.1 at the source
commit pinned in `infra/storage/sources.lock.json`; they are listed at the end.

## 1. Decision

Cloudflare stays the only party that decides. It alone signs the `sa1` write authority that the
gateway and the host guard enforce, chooses its expiry, admits starts and orders pool growth.
Option 1 changes where the facts behind a renewal come from.

| Concern | Before option 1 | Option 1 (deployed) |
| --- | --- | --- |
| Pool and VG headroom | Relay readback by the NodeBootstrap executor, every `guard/2` | Native controller samples the OpenEBS exporter every `guard/5` (2 s at the 10 s guard) and posts each sample against a Cloudflare nonce |
| Identity, inventory, per-writer IO limits, receipts, protections, pool actions | The same relay readback | The same relay readback, as an identity proof valid 300 s, refreshed every 60 s and on demand |
| Authority expiry | Lease issue + `guard_seconds` | Nonce issue + `guard_seconds`, never after the identity proof expires |
| `sa1` claims and signer, gateway, host guard, profile, admission arithmetic | — | Unchanged |

The same change set must also deliver each renewal into the controller's own view (section 4.5),
without which no guard up to the 120 s maximum holds, and let a failed slow turn retry instead of
blocking the node (section 5). Section 8 adds first tokens for new writers from their startup hold;
without it every thin wake waits for a relay turn.

## 2. The problem in code terms

This section describes the code before option 1; its citations are to the commit named above.

Run `op_zsvnvfpzv4o2jb6ha9wi` (Dev EU1, 2026-10-12) measured the product-equivalent readback at
27.5 s against `guard_seconds / 2` = 5 s; each relayed connection costs 2–6.6 s (plan:100,
plan:106). In the code this means more than lapses between renewals:

- A lease lives exactly `guard_seconds` (dom/node-thin-storage-execution.ts:339-341). The executor's
  whole budget is the lease's remainder, at most 90 s (nb/thin-storage.ts:1058). Every callback,
  relay transport issuance included, needs the live lease
  (dom/node-thin-storage-execution.ts:117-131), and the report must carry the lease's issue and
  expiry as `observed_at` and `expires_at` and arrive before that expiry
  (nb/thin-storage.ts:1423-1425, dom/node-thin-storage-execution.ts:587-589). With the 10 s profile a
  27.5 s turn aborts at most 10 s after its lease was issued: **no authority is ever recorded**, not
  even a first one.
- A failed turn marks the node `blocked` (api/bootstrap-container.ts:409-424). `alarm()` then
  destroys the container without rescheduling (api/bootstrap-container.ts:1691-1695, 1709-1712), and
  no lease is reserved while `error_code` is set (dom/node-thin-storage-execution.ts:231). Transient
  relayed failures stopped runs 5, 8 and 9 before `a262070` added repeats; a failure that outlasts
  those repeats still ends renewals until an operator repeats the selection (ops:279-281).
- Continuity needs each turn inside `guard/2`: the next lease starts at issue + `guard/2`
  (api/bootstrap-container.ts:426-432) and only after the previous one ended
  (dom/node-thin-storage-execution.ts:232-233). At 27.5 s that needs a guard of at least 55 s plus
  retry room, and the contract maximum is 120 s (ct/database-storage.ts:27, 122). That is option 2.
- The native controller takes the authority and the tokens from the desired snapshot, which it pulls
  in full every 60 s (nc/main.rs:587-593); no renewal triggers a pull. Its `guard()`
  (nc/reconcile.rs:1197-1215) and `storage_protection_due` (nc/main.rs:173-223) treat an expired
  snapshot authority as lost and hibernate the database (nc/power.rs:2662-2689), and the gateway's
  ledger token (nc/reconcile.rs:543-560) ages the same way. With turns of length T every `guard/2`,
  the snapshot stays valid only if `guard/2 > 60 s + T`, which no guard up to 120 s satisfies. Today
  the controller would stop thin databases between pulls whatever renews the authority in Cloudflare.

## 3. Two proofs, one authority

| Fact | Observer | Cadence | Used by |
| --- | --- | --- | --- |
| VG `pgcf` total and free, writable, one PV, none missing; pool `pgcf_thinpool` data and metadata size and used upper bounds, `error` when full, healthy, writable; visible LV names, segtypes and sizes | Native controller, OpenEBS exporter | `guard/5` | Renewal, admission headroom, growth trigger |
| Node UID and `bootID`, cluster and `openebs` namespace UIDs, LVMNode VG UUID, driver Pod UID and image digest | Native controller, Kubernetes API around the scrape | `guard/5` | Witnesses binding a sample to the identity proof |
| Talos boot ID, system UUID, kernel, host extension version and service, host configuration hash, `dm_thin_pool`, cgroup `io` controller, driver/LVM/thin-tools hashes and version | NodeBootstrap executor through the relay | 60 s and on demand | Identity proof |
| VG, pool and LV UUIDs, kernel DM inventory, pool tags, StorageClass/VAC identity, database volume identities, per-writer `io.max`, protection proofs, data-accounting completeness, receipts | NodeBootstrap executor | 60 s and on demand | Identity proof, receipts, hold release, protection, deletion |
| Pool initialization and growth | NodeBootstrap executor, journaled before dispatch | On Cloudflare's action | Unchanged |

Cloudflare composes the authority it signs:

```text
identity proof  I: inventory_observed_at = issue of the slow lease (Cloudflare clock)
                   inventory_expires_at  = inventory_observed_at + 300 s
headroom sample H: observed_at = issue of the nonce the sample answers (Cloudflare clock)
authority       A: identity fields of I; physical of the fresher reading of H and I;
                   observed_at   = that reading's time
                   expires_at    = min(observed_at + guard_seconds, inventory_expires_at)
                   write_allowed = computed by Cloudflare (section 4.4); revision = previous + 1
```

`sa1` tokens keep `exp = expires_at` and `exp <= observed_at + guard_seconds`
(dom/node-thin-storage.ts:211-235, ct/storage-write-authority.ts:68-83), so the gateway and the host
guard verify exactly what they verify today.

## 4. The fast loop

### 4.1 Observation

The controller keeps today's bracketed read (nc/node_storage.rs:338-429): Node, namespaces,
LVMNode, the single Ready driver container of the release-pinned image and its DaemonSet, the
exporter text through the API-server Pod proxy (nc/kubernetes.rs:660-681), then the same identities
again. It adds the Node's `status.nodeInfo.bootID` (already read for fleet facts,
nc/fleet.rs:414-415), returns the driver Pod UID and image digest and the visible LVs, and checks
completeness: the `lvm_lv_total_size_bytes{vg="pgcf"}` series must number exactly
`lvm_vg_lv_count{name="pgcf"}`. The exporter emits no LV series at all when one LV path does not
resolve [O3], and today's `physical()` reads that as a VG without LVs or pool
(nc/node_storage.rs:156-244). Every rejected parse remains an unknown sample, never zero use.

### 4.2 Exporter cost and cadence

Each exporter request gathers three collectors concurrently, without caching or rate limit [O4]:
`vgs --options vg_all` [O1]; `lvs --options lv_all,vg_name,segtype` over all VGs with one symlink
resolution per LV [O2][O3]; and `pvscan --cache` followed by `pvs --options pv_all,vg_name`
[O2][O3]. The platform values (infra/platform/base/values/openebs.yaml) keep the chart's
`metricsPort: 9500`, which sets `--listen-address=:9500` [O5], and configure no other scraper. A
scrape therefore costs four LVM processes reading metadata under LVM's locks: independent of the
data written, growing with LV and device count, and contending with the driver's own `lvcreate` and
`lvremove` and with our `lvextend`. Nothing in the exporter rules out a 2 s cadence; only its cost
can, and that cost has not been measured: the existing sampler runs every 60 s with a 45 s bound
(nc/main.rs:569-586) and records no duration.

The period is `guard_seconds × 200 ms` (2 s at 10 s), published by Cloudflare per node in the desired
snapshot. Each node gets its own task with one scrape in flight; today's loop reads nodes one after
another (nc/node_storage.rs:460-469). The live bound is a scrape p99 of at most `period / 4` under
the `startup_bound` load and while a thin LV is noflush-suspended (section 11). If it fails, the
period may rise to `guard / 4`; beyond that the guard must grow, and with it the profile and its
receipt.

### 4.3 Transport, authentication, freshness and clocks

- `POST /agent/v1/nodes/{id}/storage-headroom`, authenticated with the region agent key the
  controller already presents (nc/api.rs:194-205, dom/agent-auth.ts). Body: nonce, node UID,
  `qualification_run` (the exact run ID, or absent/null for product sampling), `captured_at`
  (controller clock), `physical` (`NodePhysicalStorage`), visible LVs, `lv_count`,
  witnesses and scrape milliseconds. Response: the next nonce and period, the composed authority
  (the node's `storage_nodes` entry of the desired snapshot) and the current `sa1` token of every
  thin database on the node. Cloudflare matches the request's run context to the current running
  qualification before issuing a nonce or changing authority; a stale qualification target cannot
  become a product sampler when its run ends.
- The nonce is 128 random bits stored with its Cloudflare issue time in `node_thin_storage`. It is
  bound to node ID and UID, used once (consumed by the compare-and-set that writes the authority) and
  refused when older than `guard/2` at receipt. A request without a valid nonce gets a fresh one and
  renews nothing.
- `observed_at` is the nonce's issue time. The scrape provably started after it, so the bound holds
  without trusting the controller's clock, and a controller that waits before scraping only shortens
  its authority. `captured_at` stays audit data, as for the executor today
  (ct/database-storage.ts:281-284).
- Enforcement clocks are unchanged. The gateway and the host guard accept `iat` and `observed_at` up
  to 5 s ahead and compare `exp` with their own clock (ct/storage-write-authority.ts:13, 68-83;
  np/storage.rs:191-205; sc/storage.rs:269-292). A node clock behind Cloudflare by δ lets a token run
  δ longer there, as today; the drain allowance and Talos time synchronization carry that assumption.

### 4.4 Cloudflare's decision per sample

Cloudflare accepts a sample only if all of the following hold. Otherwise it records the reason
code, renews nothing and starts a slow turn at once (section 5).

- The nonce is current. Node UID, cluster UID, boot ID, VG UUID, driver Pod UID and image digest
  equal the identity proof's. The identity proof is unexpired and the node `ready` and qualified
  (`qualifiedThinStorageSql`, dom/node-thin-storage.ts:49-69).
- `physical` parses as `NodePhysicalStorage` with a pool whose metadata size equals the profile's and
  whose data size lies between the identity proof's and the profile maximum.
- Every linear LV is one of the identity proof's. Every thin LV is one of its thin LVs or one of at
  most as many new names as there are current startup holds without a known volume (the
  `new_volumes` of dom/storage-capacity.ts:277-285). The thin count stays within `maximum_volumes`.

It then computes `write_allowed` exactly as the slow report does today, on the fresh reading: data
accounting complete, pool geometry within the profile, and free data and metadata of at least
`minimumHeadroom`, i.e. the live writers' measured `io.max` over `guard + drain` plus all holds
(dom/node-thin-storage-execution.ts:199-222, 627-641). It writes the composed authority with a
compare-and-set on revision and nonce, signs the node's tokens with `storageWriteAuthorityForDatabase`
(dom/node-thin-storage.ts:151-236) and evaluates the existing growth rule
(dom/node-thin-storage-execution.ts:311-337) on the fresh reading; a needed growth sets the
NodeBootstrap alarm to now instead of waiting for the cadence.

### 4.5 Delivery to the enforcement points

- **Host guard:** unchanged. It fetches `/agent/v1/nodes/{id}/storage-guard` every second
  (sc/storage.rs:563-603, sc/policy.rs:251-253), and `hostStorageLease` signs from the current
  composed authority (dom/node-thin-storage.ts:239-432). A token lives `guard_seconds` from the
  nonce issue of the sample it was signed from, and a fetch's duration comes out of that life, so
  the lease has to be cheap. It reads the node once and every database's rows and inputs (startup
  holds, wake operations) in one batch, whatever their number, and computes each entry in memory
  with the function the fast sample's token loop and the desired page use: the Worker's local D1
  harness counts six statements in four round trips for a node with three live databases and for
  one with forty live and a hundred deleted ones (570 statements before). Each
  lease and each accepted sample logs its own time (`storage_guard_served` with `elapsed_ms`, the
  entry and tombstone counts and one compact line per live entry; `handler_ms` on
  `thin_storage_sample_accepted`).
- **Deleted databases leave the lease.** The guard forgets a retained signed scope only from an
  accepted lease that names its database deleted, writable and without a volume
  (`retirement_scope`, sc/storage.rs@e4b8873:500-529), and acts on it within its next 100 ms tick; it
  fetches every 6 s at most (5 s client timeout, 1 s sleep) and keeps a lease for at most 120 s. A
  tombstone is therefore served for one hour from the row's confirmation, which a fresh complete
  absence read gates, and then no longer: a guard that fetches at all within that hour still gets
  the entry it needs, and one cut off for longer has stopped every Pod already. A deleted database
  that never had a volume receipt never had a token, so no scope exists for it and it is not named
  at all; an unconfirmed deletion keeps its entry, which blocks writes and carries the drain. The
  contract caps a lease at 4096 databases and the guard refuses a body over 2 MiB, which the
  previously unbounded tombstones would have reached.
- **Gateway:** the controller writes each returned token into `storage-<id>`
  (nc/reconcile.rs:543-560). Writes are monotonic: a token never replaces one with a higher
  `authority_revision`, because the gateway disconnects on a regression (np/storage.rs:234-256) and a
  60 s snapshot can still carry an older token.
- **Controller:** each response replaces the node's cached authority. `guard()`,
  `storage_protection_due` and `host_write_state` (nc/main.rs:161-223) read it instead of the
  snapshot entry whenever its revision is higher.

### 4.6 Timing

Each response carries the next nonce, and the controller scrapes once the period P has passed since
its previous scrape. A token is therefore anchored up to one period before its scrape and reaches
the enforcement points one period plus at most d (one host-guard poll, 1 s) after its nonce. Writes
continue while the newest delivered token is unexpired, so k consecutive lost samples are tolerated
while `(k + 2)·P + d < guard`: at the 10 s guard and P = 2 s, k = 2. In steady state the gateway's
write budget (gw/targets.rs:488-504) stays at `guard − 2P − d` (5 s) or more. Fetching the nonce
just before each scrape would add one period of validity at the cost of a second request per period.

## 5. The slow identity loop

The executor's reads stay as they are (nb/thin-storage.ts:834-1013, 1115-1395). What changes is the
meaning of its report and how the loop is driven.

- **Report.** The authority it builds becomes an identity proof with `inventory_observed_at` (the
  lease's issue), `inventory_expires_at` (300 s later) and its own `inventory_revision`. It no longer
  claims `revision = lease.authority_revision + 1` (nb/thin-storage.ts:1415), which fast renewals
  would always overtake. The API accepts it while `inventory_expires_at` lies ahead, even when the
  composed authority it yields has already expired; the next fast sample renews that.
- **Lease.** It covers the executor's existing 90 s budget instead of `guard_seconds`
  (dom/node-thin-storage-execution.ts:339-341).
- **Cadence.** The next turn is due 60 s after the last accepted proof. Cloudflare sets the alarm to
  now on a refused fast sample, a needed growth or a thin database that is ready without a receipt.
  The Durable Object keeps serializing turns.
- **Failures.** Identity and qualification codes (`*_identity_changed`, `*_unqualified`,
  `*_owner_changed`, an uncertain pool action) block the node as today. Transient ones (relay
  transport, a command that still fails after its existing repeats, an unconfirmed executor, a lost
  delivery) keep the node `ready`, record the code and reschedule with backoff up to the cadence.
- **Validity.** 300 s covers one lost delivery that holds its lease to expiry plus a retry
  (60 s cadence + 95 s lease + a 27.5 s turn) with room for one more attempt. The facts only the slow
  proof sees change only with events the fast witnesses expose (reboot, driver Pod or image change,
  VG replacement), with two exceptions: host-root tampering, which defeats any guard, and an `io.max`
  change on an established writer, which only host root or the privileged driver can make.
- **Composition.** Accepting a proof replaces the identity fields and takes `physical` from the
  fresher reading. On a compare-and-set conflict with a fast renewal the API recomposes, a bounded
  number of times.
- **Consistency check.** The proof's own LVM reading must not show more data used than the newest
  earlier fast sample's upper bound plus what Cloudflare allowed since then: the live writers'
  exposure over the elapsed time plus drain, and the current hold bytes. A violation blocks the node
  with `thin_storage_headroom_inconsistent`, because the sampler or a writer's limit was wrong.

Predicates that need a read **after** an event move from `observed_at` to `inventory_observed_at`
and keep their windows: hold readiness and coverage (dom/storage-capacity.ts:425-434, 463-507),
protection proofs and current protection (dom/storage-capacity.ts:518-524, 658-699), deletion
confirmation (dom/storage-capacity.ts:702-734) and LV reclamation (ct/database-storage.ts:382-403).
A fast renewal must not make an old inventory look like a read taken after a deletion. Renewal,
admission, token signing and the controller keep `observed_at` (dom/node-thin-storage.ts:98-120,
dom/storage-capacity.ts:265-270, ct/database-storage.ts:353-379, nc/reconcile.rs:1197-1215).

## 6. Failure behaviour

| Event | Behaviour |
| --- | --- |
| Samples stop (controller down, exporter or API-server proxy failing) | Authority ends at the last nonce + guard. The gateway refuses further frontend bytes (gw/transport.rs:877-881); the host guard suspends the LV with `NOFLUSH` and `SKIP_LOCKFS` and stops the Pod's tasks (sc/storage.rs:806-838, sc/storage_dm.rs:193-204); the controller writes its protection marker and hibernates the Cluster with `stopDelay = drain_seconds` (nc/power.rs:2662-2689). The next slow proof records the protection, and once authority is current again the capacity turn resumes the database at a new generation (ops:314-319). Committed data survives; uncommitted work is dropped and never replayed (`resume_marker`, `noflush_quiescence`). |
| Controller restart or rollout | The controller is one `Recreate` replica (infra/platform/regional/agent.yaml:10-13). A gap longer than the remaining validity acts as above on every awake thin database of the region. |
| Cloudflare API or D1 unavailable while the Edge still routes | As above, within one guard. Thick and standard-runtime databases are unaffected. |
| A witness or the LV set differs from the identity proof | Sample refused with its code; slow turn at once; no renewal until a proof matches. |
| Headroom below the minimum | Renewal with `write_allowed=false`: no tokens, protective stops as above, growth requested while the pool can grow. |
| Unknown sample (vgs/lvs race, incomplete LV series, a full pool's non-zero health status) | No renewal from it; the next period retries. |
| Pool growth | The executor's journaled `lvextend` is unchanged. The fast loop sees the larger pool within one period and admission uses it; only the slow proof confirms the action (pool UUID, target sizes). A smaller or missing pool is an identity mismatch. |
| Node reboot | New boot ID: samples refused, and the host guard rejects leases of the old boot (sc/storage.rs:183-187). Authority returns only after the fleet path confirms the fresh boot (plan:130-139) and a slow proof on that boot. |
| Driver Pod replaced (patch, eviction) | New driver Pod UID: samples refused until a slow proof re-reads binaries and identity. |
| Slow turns failing transiently | Identity stays valid until its expiry while turns retry; writes stop only if no proof succeeds within 300 s. |
| A lease that is slow or fails (D1 queueing, a Worker restart, the guard's 5 s timeout) | The guard keeps its last accepted lease and each entry runs down to its own token's expiry, at most `guard_seconds` after the nonce it was signed from, minus the lease's age at receipt; then it stops the Pod's tasks and freezes the volume (sc/storage.rs@e4b8873:579-595, 764-877). Every thin database of the node is affected alike, and the controller stops one whose token its samples stopped renewing. The lease's cost does not depend on the number of databases. |
| One entry of a lease the guard refuses | The guard accepts a lease whole or not at all (sc/storage.rs@e4b8873:182-365): a token that fails verification, names another Pod at the same or a lower generation than the one accepted before, or differs at an authority revision it already holds refuses every entry, and a token for a Pod the sandbox runtime has not assigned is dropped by the persistence step before acceptance (sc/storage.rs@e4b8873:701-708, sc/controller.rs@e4b8873:779-806). The other entries then run down as above. |

## 7. Trust argument

Today the native controller (`pgcf-agent`, infra/platform/regional/rbac.yaml:30-95) can create and
delete namespaces, CNPG Clusters and Secrets, delete Pods, and patch and delete PVs, and it writes
every `storage-<id>` ledger and protection marker (ops:264-266). With the region agent key it
reports the runtime attestation the Actor routes by (api/database-actor.ts:103-119), the RAM samples
behind actual-RAM admission, and the fleet observation whose boot ID and freshness every thin
authority already requires (dom/node-thin-storage.ts:52-59). It cannot sign or extend an `sa1` token:
the key stays in Cloudflare and both enforcement points pin the public set
(apps/native-gateway/README.md:56-60, np/storage.rs:37-72). It cannot make the host guard run a Pod
past its token, whose deadline is local and monotonic (sc/storage.rs:269-292, 546-561). It has no
`pods/exec` into the privileged driver and no Talos or Kubernetes admin material.

Option 1 adds one power: the controller supplies the headroom facts Cloudflare renews from. A
controller that reports more free pool space than exists keeps renewals and admissions going while
the pool fills.

- **Bounded outcome.** The pool is created with `--errorwhenfull y` (nb/thin-storage.ts:486-504).
  `data_full` proved fast ENOSPC/EIO, every acknowledged commit and the marker preserved, and recovery
  by growth; `metadata_full` proved that metadata exhaustion fails closed (plan:100, ops:392-393).
  The worst case is an availability incident, not a lost commit.
- **No new reach.** The controller can already fill the pool without lying, for example with a CNPG
  Cluster and a thin claim outside the `pgcf-db-*` namespaces the host guard scopes
  (sc/storage.rs:389-394, 503-507), and it can already stop or delete any database.
- **Bounded scope.** It cannot backdate a sample (the nonce time is Cloudflare's), renew beyond the
  nonce plus one guard, renew across a reboot or a driver or VG change its witnesses expose, or renew
  past the identity proof. It cannot supply LV UUIDs, IO limits, receipts or protections.
- **Detection.** Every slow proof reads LVM itself, and section 5's consistency check blocks the node
  when that reading contradicts the samples.
- **Shared key.** Every node's host guard holds the same region agent key
  (dom/node-host-configuration.ts:270), so host root on any node could post samples for any node of
  the region, as it can already post observations and RAM samples. Per-node keys belong to the
  "Access security" row (plan:114).

What stays: Cloudflare alone signs; identity remains a Cloudflare-driven readback with
Cloudflare-held credentials; the exporter is read over the authenticated API-server Pod proxy, the
path today's metrics already use (infra/platform/regional/rbac.yaml:150-166).

## 8. New writers

The gateway forwards a byte only under a token naming the exact Pod (gw/targets.rs:313-405, 467-484;
np/storage.rs:207-224). Cloudflare signs such a token only from slow-proof `io.max` evidence of that
Pod (dom/node-thin-storage.ts:184-209), and every wake runs a new Pod at a new generation
(dom/lifecycle.ts:35). Without the rule below every thin wake waits for a complete relay turn after
Pod Ready. The host guard's startup grant (dom/node-thin-storage.ts:410-411) lets PostgreSQL start;
it does not let clients connect.

Rule (implemented): Cloudflare may sign a token for (database, generation, Pod) without IO
evidence of that Pod while

1. a thin startup hold of this generation and node is current. It debits
   `max(startup_reserve_bytes, quota)` and is released only after a later slow proof shows the Pod's
   `io.max` within the profile (dom/storage-capacity.ts:463-507, dom/startup-admission.ts:256-279);
2. the immutable receipt exists and its LV is a thin LV of the identity proof;
3. the controller's runtime attestation names the Pod together with the receipt's storage, claim,
   volume, namespace and CNPG Cluster UIDs, the Kubernetes cluster UID and the identity proof's
   boot, for the start's generation or a later one. The Actor already routes by that attestation,
   and hold release already cross-checks it (dom/storage-capacity.ts:430-432). A ready report
   without an attestation clears the row's attestation, so the hold remembers the one of the last
   accepted ready report (`database_start_admissions.attested_json`), used only while the row has
   none;
4. the composed authority is current with `write_allowed`.

A thin LV maps at most its virtual size, and the hold debits at least that from admission until IO
evidence exists (dom/storage-capacity.ts:277-305). An unverified rate therefore cannot consume
headroom that admission handed to anyone else. The guard still bounds the writer's time, and a later
proof that finds `io.max` above the profile blocks the node (nb/thin-storage.ts:1357-1362). The token
reaches the host guard on its next poll and the gateway with the next renewal; returning it in the
response to the ready observation removes that period from the first SQL.

A create still needs one slow turn after its claim binds, because only the slow readback establishes
the receipt's LV UUID (dom/node-thin-storage-execution.ts:691-725); Cloudflare starts that turn at
once. The rule does not depend on the renewal source.

**A generation that starts nothing.** A role creation, a password reset and a role removal advance
the row's generation while the Pod keeps running, and the identity proof names the database at the
generation it was prepared for, up to a minute and a half behind. Every start of a Pod has a
startup hold of its generation, so while no hold is newer than the one the Pod was started for,
that hold, the controller's attestation of that start or a later generation, and the node's
reading of an earlier generation (exactly one Pod on the receipt's volume, inside the profile's
limits, not frozen) still name the writer, and the token of the new generation is signed for it.
The grant of a start under way follows the newest start at or below the row's generation in the
same way, and so does the fast wake's token for a parked Pod, whose operation is the generation
after the parked one. The hold's volume receipt is bound by the proof of the generation after the
change, and the identity lease the executor reads carries the start's hold at the row's
generation, the only hold under which it accepts a cgroup that cannot be read yet. When the node's
reading and the controller's attestation name different Pods, or a protective stop's marker is
set or the earlier reading found the volume frozen, nothing is carried: a protective stop is
released only by a start of its own. The identity proof prepared at the new generation takes over
unchanged.

## 9. Delivery

Option 1 is deployed. The contracts and API carry the headroom sample route, the identity proof
and the composed authority; the native controller runs the per-node fast loop; the NodeBootstrap
executor's slow report is the identity proof; held writers get their first token as section 8
describes. The sampling capability (`thin_storage_sampling_version` in the release) keeps the
strict desired schemas back until every assigned controller has converged.

## 10. Qualification and receipt

A receipt comes only from one completed run whose gates the current code computed. With option 1
`startup_bound` compares the longest interval between accepted fast samples during the bulk load
with `guard_seconds / 2` instead of the relay readback, and `noflush_quiescence` also requires an
accepted sample while the writer's LV is suspended, which proves that a protective quiesce cannot
stall every renewal on its node. The product identity turn still has to stay below the 60 s
cadence. The run and its pass criteria are in the
[qualification runbook](../operations/recovery.md#thin-storage-qualification-run); run 14
produced EU1's receipt, and any change of kernel, driver image or host extension needs a new run.

## 11. Live acceptance on Dev EU1

1. **Continuous renewal.** Awake thin databases under write load over an observation window: the
   longest accepted-sample interval stays below `guard/2` by Cloudflare timestamps, with no protective
   stop and no `write_authority_expired`. Record the period, scrape p50 and p99, post latency, D1
   write time, ledger patches per second and driver CPU.
2. **Exporter under stress.** Scrape p99 of at most `period/4` during concurrent creates, a pool
   growth and a noflush-suspended thin LV.
3. **Samples stopped.** Scale the controller to zero. Within one guard plus one host-guard poll the
   gateway refuses writes and the host guard suspends and stops. After restoring, protections are
   recorded and resumes issued; the marker and every acknowledged commit are present, uncommitted
   rows absent.
4. **Controller rollout.** Measure the sampling gap of a `Recreate` rollout: either no lapse, or one
   handled as in test 3.
5. **Witness change.** Delete the OpenEBS node Pod. The next sample is refused with its code, a slow
   turn runs at once, and renewals resume under the new Pod.
6. **Growth.** Fill towards the trigger: a growth action, the larger pool in the next samples,
   admission reopened, no ENOSPC, the same pool UUID.
7. **Reboot.** Through the fleet path: samples refused on the new boot, authority back after the
   fresh-boot confirmation and a slow proof, data intact.
8. **Wake.** A sleeping thin database wakes through Cloudflare with its first SQL independent of a
   slow turn; the next proof releases its hold.
9. **Transient relay failure.** Restart the relay during a slow turn: the turn retries, the node stays
   `ready` and writes continue.

## 12. Rejected options

Option 2, a 120 s guard with lower write limits, fits the 27.5 s relay turn inside `guard/2` but
charges every awake database for a 130 s write window instead of 20 s (about 6.5 times the
headroom at the same limits) and keeps every relay dependency. Option 3, new thick databases as a
bridge, needs a second Cloudflare-signed authority and leaves a permanent second cohort of
databases that never convert in place. Neither was pursued; their comparison is in Git history.

## 13. Open questions that need live proof

- Scrape duration and driver CPU at a 2 s period on EU1, and LVM lock contention with `lvcreate` and
  `lvextend` (section 4.2).
- Whether `lvs`, `pvscan --cache` and `pvs` stay responsive while a thin LV is noflush-suspended and
  while the pool is out of data space. A hang would stall every renewal on the node.
- The `Recreate` gap of a controller rollout against the guard.
- D1 write time and volume of a composed authority per node and period; if it matters, keep the
  headroom in its own columns and compose in SQL.
- The race between the ledger write and the first routed connection after a thin wake.
- Whether every `pgcf` LV is active after a reboot before the first renewal; otherwise the exporter
  drops all LV series.
- The node clock offset against Cloudflare on EU1.

## Upstream sources

All at `https://github.com/openebs/lvm-localpv/blob/e8a234cbfeef5fa16fde1330c8de2d91e31831f1/`.

- [O1] `pkg/collector/vg_collector.go:124-125`: `Collect` runs `ListLVMVolumeGroup(false)`.
- [O2] `pkg/collector/lv_collector.go:121-122` and `pkg/collector/pv_collector.go:76-77`: `Collect`
  runs `ListLVMLogicalVolume()` and `ListLVMPhysicalVolume()`.
- [O3] `pkg/lvm/lvm_util.go`: `ReloadLVMMetadataCache` runs `pvscan --cache` (1086-1095);
  `ListLVMVolumeGroup` runs `vgs --options vg_all` (1101-1120); `decodeLvsJSON` returns an error for
  the whole list when one LV path does not resolve (1269-1299); `ListLVMLogicalVolume` runs
  `lvs --options lv_all,vg_name,segtype` and `ListLVMPhysicalVolume` reloads the cache and runs
  `pvs --options pv_all,vg_name` (1302-1335).
- [O4] `pkg/driver/agent.go:104-190`: one registry with the three collectors served by
  `promhttp.HandlerFor`, without caching.
- [O5] `deploy/helm/charts/values.yaml:207-210` (`metricsPort: 9500`) and
  `deploy/helm/charts/templates/lvm-node.yaml:85-87, 117-120` (`--listen-address`).
