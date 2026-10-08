# Existing-account installation

Current scope correction (2026-10-08): the overall product goal remains open. The accepted results
below cover the operator/database subset. All three servers must now converge through the
[unified corrective plan](../architecture/cloudflare-convergence-and-serverless-plan.md), including
central CF customer policy, actual-use capacity, standing purchase activation, patching and fast
starts. Earlier EU-upgrade deferrals and static reservation descriptions are historical current-state
constraints, not the desired final product. Follow supported data-preserving procedures.


This guide completes the operator's existing Cloudflare/Contabo installation. Preserve the first
EU control/relay node and its imported credentials. Retain the already-admitted second EU node as
customer EU1 (formerly EU2), with its installation, Node identity, data and custody unchanged.
Exactly one new US1 control-plane/customer node was purchased through the API for one month.
Both customer nodes use V159 / Cloud VPS Plus 4: 4 vCPU, 8 GiB RAM and 150 GiB NVMe. Provider
Running is not installation or admission. No new EU worker, EU1 re-adoption, reset or
decommissioning is part of this completion. Public
distribution and installation in a foreign Cloudflare account are separate release work.

For this owner's completion, run all remaining checks once read-only from the laptop using the
same implementation and existing custody, without consuming admission. Collect every mismatch
before one combined correction, CI, delivery and resume. If that one programmed attempt fails,
the owner permits one operator admission using the same checks and existing US1 operation.
Record the actual path and timing in PLAN Status; do not claim complete automatic acceptance.
Its remaining proof belongs to the next genuine authorized purchase. Immediately continue the
real database lifecycle on both customer nodes. EU upgrades and template activation are excluded
from this completion; document differences and align only a blocking incompatibility.

## Reviewed deployment inputs

Use a source commit that passed the common CI checks and fully qualified images by immutable
digest. The native bootstrap image may stay private: push the qualified amd64 image to the
deployment's Cloudflare managed registry and use its returned immutable reference. Preserve the
image's source labels and notices; registry transfer does not replace qualification.

Keep the private API configuration outside Git. It supplies D1, region-specific R2 bindings,
RegionLink/DatabaseActor/NodeBootstrap Durable Objects, the AddNode Workflow, the Container and
the fixed-source VPC relay binding. Start from `apps/api/wrangler.example.jsonc`; replace every
placeholder. Import secret values from private custody and preserve the existing four root
secrets. Export D1 before applying additive migrations and rehearse them against the export.

For console-free rescue, optionally configure the private Worker secret
`CONTABO_RESCUE_CONFIGURATION` as a JSON map keyed by exact provider instance ID. Each entry contains
`ssh_host_key`, its `ssh_host_fingerprint`, and `user_data` beginning with `#cloud-config` as plain
YAML. Retain the generated host private key in that private cloud-config and custody. The public
key must be a valid OpenSSH Ed25519 blob with its computed SHA256 fingerprint, and the configured
identity must match both the bootstrap specification and private rescue input. A configured map
requires a valid entry for the target before rescue can be dispatched. The provider receives the
exact plain YAML once under the existing persisted mutation claim. Confirm the actual rescue
host presents that retained key through strict SSH verification before any installation writes;
the provider honoring cloud-init remains a live installation check.

The EU archive uses the EU-jurisdiction binding and EU S3 endpoint. US has a separate bucket and
the account's general S3 endpoint. Choose a North America location hint when creating that bucket;
the hint does not guarantee jurisdiction. `ARCHIVE_BINDINGS` must map each exact region ID to its
actual Worker binding and bucket. A mismatching or missing binding fails closed.

## Private bootstrap transport

The relay runs on the explicitly selected first EU node using
`infra/platform/bootstrap-relay`. It listens on host loopback port 8082 and carries only public
Ed25519 verification keys. Its cloudflared sidecar uses a dedicated private Tunnel. The API's
`BOOTSTRAP_RELAY_SERVICE` VPC HTTP service targets that Tunnel and loopback port; no public relay
hostname is needed. Retain signing keys privately, with explicit issuer and allowed target regions.

Verify the real VPC-to-Tunnel identity and the relay's current process epoch before enabling
bootstrap jobs. Native SSH, Talos and Kubernetes sessions still verify their host keys or
certificates end to end. Broken transport never replays a native command.

Select and seal the provider-verified proof source association once per installation in
Cloudflare. Reuse that association across proof renewals with fresh expiring claims. Each grant
still checks the current operation, job, binding, plan, Node UID/Ready/freshness and retained
cluster custody. Native reads must confirm the actual Cluster/Node identities, addresses and
host keys or certificates before work and owned cleanup; changed or unknown identity blocks it.
Do not query Contabo for each Kubernetes/Talos command, grant, relay connection or cleanup step.
Provider reads belong to order/initial mapping, firewall/rescue, hypervisor and uncertain-outcome
reconciliation, with a fresh matching provider check before the first destructive checkpoint.
Routine signed-proof admission is also provider-free: validate the current sealed Cloudflare
plan/configuration, region membership, allocation/leases and signed R2 evidence, then atomically
fence those records without extending observation freshness. Before the first disk-write intent,
read current target addresses/hardware and exact firewall ownership, assignments, rules and
attachment state. These checks never repair provider policy; changed facts or a concurrent CF
network change block the checkpoint. Once a signed report is accepted, the Workflow consumes
only its exact stored artifact hash within the existing proof expiry, with fresh CF plan,
lease/allocation and job authority checks before and after. It does not age the original scan
again at each transition. A changed or expired artifact requires normal signature, scope and
observation-freshness validation; revoked authority blocks without a fallback. Later write chunks
retain their scoped authority and readback checks without repeating provider queries.
The first destructive checkpoint stores an immutable Cloudflare installation authorization
bound to the exact job/input, sealed network plan and verified provider facts. Continued
installation uses fresh job/scope checks and short transport grants rather than repeating a
full port scan whenever the initial preparation proof expires. Native host/certificate,
physical/cluster/node identity and acknowledged/pending-byte comparisons remain mandatory.
This authorization ends with cancellation, revocation or admission and grants no permission
to another job or to release quarantine without fresh postjoin proof.
For a partially written job created before migration0022, the programmed Workflow establishes
this record once at an explicit lifecycle boundary using a fresh preparation proof and fresh
read-only provider facts. Its CAS preserves the complete input and current acknowledged/pending
checkpoint. Routine reads/grants cannot establish the record or query Contabo. Apply0022 through
the tracked D1 migration path only after checking the exact pending migration and the paused
job; do not reset the disk or replay an uncertain write.

The provider client retains credential-scoped OAuth reuse/coalescing, early-expiry refresh and
401 invalidation. A credential change closes reuse of the old client; an uncertain mutation is
resolved through its existing claim and readback rather than replayed.

## Programmed installation path

The headless producer is implemented and has passed the common software and image checks; delivery
and fresh-node Dev acceptance are tracked in PLAN.md.
Configure `PUT /v1/regions/{id}/installation-profile` once with administrator scope. The exact
profile fields are `version:1`, `region_id`, `provider_product_id`, `relay_issuer_region_id`, `dns`,
`storage:{ephemeral_gib,lvm_gib}` and `rescue_client_private_key`. Storage is the reviewed layout;
the inspector supplies measured physical geometry and the verified official Talos image/GPT.
A first regional node additionally needs `first_region:{cluster_name,reviewed_commit,regional_image,platform}`.
Its `platform` contains `version:1`, `region_id`, `api_host`, the retained `agent_key`,
`route_keyring`, `tunnel_token` and `backup_s3:{access_key_id,secret_access_key}`. A worker uses the
existing regional join custody. Preserve the issued regional credentials; profiles and rescue
identities are encrypted in D1, and status never returns their private keys.

During pre-installation, administrators can read
`GET /v1/nodes/additions/{operation-id}/inspection`. This reads the existing native inspector
with a bounded response and returns its verified identity, status and fixed error code. It never
starts a Container, registers another inspection, requests rescue or writes a disk. A stored
`reported` result means inspection completed; it does not mean the node is installed or admitted.
An unavailable inspector remains unknown rather than being treated as healthy.
Administrators can also read
`GET /v1/nodes/additions/{operation-id}/proof/preparation/journal` for the current session
timestamps and current or unfinished source stages, UID hashes and session-match flags. Historical
cleaned journals remain in custody but are omitted from this projection after validation. Source
history is read in at most sixteen 64-entry pages, with one lookahead; malformed or excessive
history fails closed without returning partial cleanup authority. The response remains limited
to 64 entries and 32 KiB. This reads local Durable Object records only and grants no cleanup or
proof authority. It exposes neither private inputs nor credentials and does not wake or contact
a Container.
For network evidence, read
`GET /v1/nodes/additions/{operation-id}/proof/{preparation|postjoin}` with administrator scope.
This observes the retained native proof session and its fixed error code; it never starts a scan,
creates a session, registers work or refreshes its expiry. A reported proof still requires the
separate signed-artifact and admission checks.

`GET /v1/nodes/additions/{operation-id}/proof/source` is an administrator-only, read-only view of
the once-sealed source's public identity and binding/generation/plan/input hashes. It excludes
join bundles, keys, certificates and bearers. It checks current CF authority and retained source
custody before and after projection without contacting Native or Contabo, minting a session,
starting work, setting an alarm or modifying storage. Identity or authority changes refuse the
read. Use this mapping when comparing necessary provider lifecycle facts before a source-network
repair; do not infer an assigned host address from advertised provider inventory alone.

An existing source needs a stable assigned global IPv6 address and an IPv6 default route for the
full dual-stack proof. A host-network probe reporting `outside_scan_capability_gap_ipv6_eaddrnotavail`
has not completed that proof. Pause repeated attempts, read actual Talos addresses/routes under
the retained mTLS custody and the exact source Node/Cluster/boot identity, then compare the sealed
source mapping with fresh matching provider facts before a targeted configuration correction.
Preserve IPv4, credentials, identities and database data; do not reset EU or weaken the IPv6 scan.
Preview the exact format-preserving network change using the pinned client's dry run and supported
nonreboot mode. An uncertain apply requires readback of both persistent and active configurations,
plus actual address/route, identity and database health; never blindly repeat the write.

A failed owned scanner may report one of the finite `outside_scan_*` codes. Native reads at most
2KiB from its exact owned Pod before cleanup, checking current authority, source/cluster identity,
Namespace/Pod UID, sealed spec and actual image before and after. Only a single-key JSON diagnostic
with a recognized code is exposed. Missing, corrupt or mismatched output remains
`proof_source_pod_failed`; arbitrary logs remain private. Observe the error through the read-only
proof-status endpoint and correct the demonstrated cause before resuming the same operation.
The HTTPS control path may reconnect after a normal server close. Every connection must prove TLS
authorization, port443, exact local/control address, a fresh signed nonce/origin and the same
observed public source. Physical socket-object continuity is not an installation identity.

At report admission, completed scan/access observations and the final control remain bounded to
120 seconds. Historical scan starts and initial controls are bounded against scan completion,
matching Native validation; owned cleanup never rewrites their timestamps. Inventory reads use
the 13 explicit standard namespaced Kubernetes REST collections, with at most four concurrent
reads per family, the existing 30-second command bounds and a shared 256KiB output limit. Verify
each typed List and item, and refuse nonempty continuation or remaining-item metadata. Unknown,
partial or foreign children preserve the namespace; Node/Cluster checks and UID/resourceVersion
deletion preconditions remain. Observe actual cleanup/report timing before claiming readiness.
Cleanup combines the initial source/owned-Pod read and the Pod-absence/owned-Namespace read into
strict named Lists. It still refreshes the source separately immediately before each DELETE.
Only successful empty output confirms both requested resources absent; unknown readback retains
dirty ownership and never causes a blind repeat of the deletion.

If regional telemetry temporarily leaves the retained source observation older than 180 seconds,
the proof producer waits for fresh observations of that same source. It still validates current
Node/Cluster identity, Ready/lost state, profile, encrypted custody and target authority before
and after asynchronous reads. Native grants continue to reject stale authority; waiting does not
issue a session, reuse expired claims or select another source. Changed identity/custody or a
future observation timestamp remains blocking. Preserve the same original operation and job
when recovering an errored orchestration after telemetry returns.
Do not refresh timestamps manually or increase the freshness limit. Resolve an uncertain
orchestration control response through reads; never create a replacement order or adoption.

Include ICMP from the actual assigned IPv6 gateway/128 with no destination ports or IPv4 scope
in an initial provider-firewall plan, alongside its restricted TCP/UDP rules and permanent DROP.
This permits gateway neighbor discovery; it does not claim arbitrary-path PMTU acceptance.
An existing sealed plan is never silently rewritten. A necessary legacy source-firewall repair
requires exact before/after rule and attachment identity checks, one recorded mutation and
GET-only resolution of an uncertain result. Keep these lifecycle calls separate from the zero
provider-call requirement for routine transport.

US1's original purchase, profile, inspection, complete installation and admitted job are retained.
Preserve sealed inputs, credentials, proof-source association and journals; they record completed
work. Resolve uncertain control responses through observation. Do not repeat purchase, profile
import, adoption, registration or disk-write intent. EU1 is already admitted and needs no bootstrap
or adoption. The sequence below is the procedure for future authorized additions, not an
instruction to reinstall either existing customer node.

Keep automatic standing purchases and autoscaling disabled until US/recovery acceptance and
explicit finite owner limits. Individual costed orders remain separately approved. The retained
US policy uses actual RAM with a128 MiB request and4096 MiB maximum; EU remains reserved pending
its controlled data-preserving transition. Use the guarded
`PUT /v1/regions/{id}/capacity-policy` with `region_id`, `max_nodes`, `purchases_enabled`, `order`,
`placement_mode`, `maximum_database_memory_mib`, `postgres_memory_request_mib`,
`standing_cost_profile`, `autoscale_enabled` and `adopt_instance_ids`. Preserve current finite node
caps. Use `placement_mode:"actual_ram"`, 256 MiB assignment steps, maximum 4096 MiB and the reviewed
128 MiB PostgreSQL request for this installation. Changing mode or the PostgreSQL request requires
an empty assigned live cohort or a completely confirmed manually suspended/hibernated cohort
at its current observed generation, with owned succeeded suspend operations and no unsettled
startups. Preserve database, volume, role and credential identities; resume through fresh
full-peak startup admission after the policy change. Idle sleep and partially stopped cohorts
do not qualify. Configured limits must cover existing databases. Cost/node-cap updates do not
reset database state.

The exact regional `order` contains `product_id`, `provider_region`, `image_id`, `term_months` and
`location`. Use the confirmed V159 offer with `term_months:1` and omit `add_ons`. Its standing
profile must bind that exact order and explicit `id`, `owner_reference`, `approved_at`, `expires_at`,
`currency`, `monthly_amount`, `setup_amount`, `max_orders`, `max_total_monthly_amount` and
`max_total_setup_amount`. Do not infer unlimited orders or spend from a model approval. Enable
standing purchases only while these finite limits and expiry authorize the order.

The retained control server's UID-guarded new-database placement flag is already disabled;
preserve Kubernetes/platform operation and existing data. The flag excludes new placement;
existing databases must continue to serve, wake, resize and delete normally.

### API-only resource profiles and regional configuration

The corrective implementation adds these management routes; deploy the matching API/Regional
release and additive migrations before using them. No PGCF administration UI is part of the product.

| Route | Purpose |
| --- | --- |
| `PUT /v1/resource-profiles/{id}` | Create an immutable resource revision using `expected_revision` and `resources` |
| `GET /v1/resource-profiles/{id}/revisions/{revision}` | Read the exact resource snapshot, generated size-class ID and SHA256 |
| `PUT /v1/databases/{id}/resource-profile` | Assign `profile_id` and `profile_revision` using the database's `expected_generation` |
| `GET /v1/databases/{id}/resource-profile` | Read the selected/target revision and actual application state |
| `PUT /v1/resource-profiles/{id}/rollout` | Select `profile_revision` for all databases currently assigned to that profile; `expected_revision` is the previous rollout target, or0 before its first selection |
| `GET /v1/resource-profiles/{id}/rollout` | Read assigned, applied, deferred and pending counts |
| `GET/PUT /v1/regions/{id}/configuration` | Read/change the gateway URL and binding through configuration-hash CAS; the route must end in `/pg` |
| `GET /v1/nodes/{id}/storage` | Read a fresh identity-bound physical LVM observation, or `sample:null` when unavailable |

Profile creation, rollout selection and regional configuration require administrator scope.
Database assignment retains project authorization. Use `Idempotency-Key` for mutations and retain
returned operation IDs. An immutable profile revision cannot be changed through the size-class API.
An enabled revision may be selected for rollout; creating a revision alone does not promote it.
The existing cron processes at most eight assignments per invocation and resumes through existing
configuration generations and database operations. Capacity conflicts leave the current desired
state intact for retry; they are not successful application.

PostgreSQL CPU request and hard CPU limit are separate fields. An omitted request preserves the
legacy request-equals-limit behavior. Use qualified resource values; a smaller request does not
prove workload density or remove PostgreSQL/Barman startup checks. Memory remains the PostgreSQL
container limit, with backup/system overhead reported separately.

A confirmed sleeping database accepts future compute configuration while remaining suspended.
Its unchanged no-Pod fact retains zero active CPU charge. `deferred_until_wake` explicitly means
that no running PostgreSQL has yet proved the new settings. The next wake reacquires fresh hard
CPU/RAM startup admission and must report current configuration readiness before `applied:true`.
An uncertain stop or degraded observation is pending. A newer resource revision supersedes an
unfinished older resize explicitly; stale observations cannot acknowledge the current revision.

Physical storage reporting does not enable thin allocation. Current thick quotas still debit
real extents. A missing/old/mismatched sample stays unknown, and `thin_pool:null` means no thin pool
exists, not free thin capacity. Qualify pool sizing, growth, metadata exhaustion, final-volume
reclaim and existing-volume migration before changing storage admission.

Cloudflare implements the capacity-to-Ready sequence below from persisted state. The current
installation used the owner-authorized operator postjoin/admission fallback; the complete
automatic path remains to be proved by the next genuine authorized node purchase:

1. Ten fresh consecutive minute samples from the same physical Node UID reach 76% average
   working-set/physical RAM. Cloudflare reserves one regional addition, checks the exact standing
   offer and spend/node caps, then dispatches one original provider request UUID.
2. Read-only receipt/audit reconciliation establishes the actual instance. Unknown order outcomes
   never cause a second purchase. A cancellation is recorded only after fresh matching provider
   inventory confirms it and no installer job, node or destructive progress exists.
3. Allocate/read back the owned free firewall definition, create a unique retained rescue host
   identity, and request registered-key RAM rescue. Native inspection measures the actual disk,
   RAM, MAC, network and official pinned Talos image/GPT; incomplete hardware remains unknown.
4. Compose and seal the exact installation input and provider-verified source association. Actual outside-allowlist dual-stack port scans
   and allowed-source controls establish a signed preparation proof. The Workflow refreshes
   measurements when the proof has less than 60 seconds remaining; it retains all write offsets
   and immutable checkpoints.
5. Verify the target provider identity at the first destructive checkpoint, then install the
   qualified image, apply the exact network configuration and join/bootstrap the
   intended region. The release pins reviewed security patch versions. Installed Talos has no
   SSH daemon; management ports remain restricted to their reviewed sources and PostgreSQL is
   never exposed. Rescue password authentication is disabled by the generated configuration.
6. While quarantined, measure LVM/CSI capacity, write/read/reclaim an operation-owned trial volume,
   verify node identity, encrypted peer traffic and complete external port isolation. Publish the
   actual capacity and signed post-join proof; admission is the only path that releases quarantine.
7. New Ready capacity accepts placement from fresh physical headroom without waiting ten minutes
   for its utilization average. Existing regional servers remain eligible throughout rollout
   under hard RAM/CPU/storage and full PostgreSQL/Barman startup-peak admission. There is no 81%
   placement cutoff. Failed starts/timeouts do not silently release unknown peak reservations.

The following is a historical failed selection, not the current V159 offer. Contabo lists V155
as 300 GB SSD. On 2026-10-06, the owner-authorized API test submitted
`productId: "V155"`, `region: "EU"`, `period: 1` and
`addOns.extraStorage.nvme: [{ "sizeTB": 0.15, "quantity": 1 }]`. One POST returned201 and its
original-request CREATED audit matched. Final allocation was **8 vCPU, 24,576 MiB RAM and
614,400 MiB SSD (600 GiB)**, so this payload does **not** select the included 150 GB NVMe
variant. No installer or disk write ran. Do not use it for US or standing regional expansion.
The V155 free-NVMe selector remains unverified. The current owner-approved V159 offer supplies
150 GiB NVMe without a storage add-on; its one US purchase and actual allocation are verified.
Use only that confirmed offer and its reviewed costs for the current installation profile and
standing policy. Do not repeat the V155 test or order another EU worker.

## Legacy manual evidence and recovery path

The following procedure documents the earlier accepted EU2 path and explicit recovery inputs.
That same node is now retained customer EU1. Do not rerun its adoption, rescue or installation.
This historical procedure remains a reference for separately authorized recovery; it does not
authorize a loss drill or removal of EU1 during the current completion.

1. Configure `/v1/regions/{id}/capacity-policy` with the explicit node maximum. EU lists the second
   existing provider instance in `adopt_instance_ids`; US may order only its configured approved
   offer. Purchases require the specific location, term, setup amount and monthly total.
2. Create actual database demand that exhausts measured headroom, then trigger/read
   `/v1/regions/{id}/capacity-decision`. Save the immutable node addition and operation IDs.
   A pending addition holds one slot. An uncertain provider response must be reconciled by its
   existing receipt/request before another order is considered.
3. Read fresh Contabo inventory. Bind MAC, IP, prefix, gateway, DNS, physical disk and rescue RAM
   to the reserved instance. Verify the rescue SSH host key independently and keep its private
   key in custody. Select the verified Talos image checksums and installer digest. Do not guess
   disk units, interface names or rescue response fields.
4. Configure `/v1/nodes/additions/{operation-id}/bootstrap` with its exact expected revision,
   public `spec` and private `rescue`. A new control plane additionally requires public
   `spec.platform` and private `platform`: reviewed source commit, immutable regional image,
   canonical configuration hash, exact region, existing issued agent key, regional routing
   keyring, Tunnel token and scoped R2 credentials. These values are sealed, not returned in status.
   EU workers use the retained join bundle and do not install a second platform.
5. Let the Workflow verify exact owned firewall rules, assignment and current readback before
   requesting the provider's RAM rescue. RAM rescue supplies the retained host key and route
   configuration so authenticated rescue access and actual network measurements can be collected.
   Full fresh signed outside-allowlist scans and relay access controls remain required before
   native installation starts. Direct Container start, authority callbacks, transport grants and
   destructive checkpoints enforce that separate verified preparation. The node stays quarantined.
   Native checkpoints record an intent before disk writes or platform mutations; resume reads exact
   owned state and does not blindly reinstall.
6. For US, the native flow installs Cilium, Flux, the five platform releases and regional services,
   and verifies the LVM/CSI registration. Retain the issued regional identity on retries.
7. Generate actual preparation/post-join artifacts with
   `scripts/e2e/src/node-network-proof.ts` (`access`, `scan`, `prepare`, `verify`). Private inputs
   use `PGCF_NETWORK_CONFIG_JSON`, `PGCF_NETWORK_SIGNING_JWK` and `PGCF_NETWORK_OUTPUT`.
   Upload the signed artifact to the exact operation/checkpoint R2 key and submit its digest to
   `/v1/nodes/additions/{operation-id}/verify`. A known source, complete same-family scans,
   positive controls, real node capacity and actual encrypted peer traffic are required.
   An IPv6 source or loss-free capture that is unavailable remains an open check.
8. Release quarantine only through the verified admission receipt. Confirm actual placement
   and SQL on the new node, backup to the correct regional bucket, and complete test deletion.

For an interrupted native apply with missing resources, repair only the exact operation-owned
resources, then resume readback. Do not reset checkpoints, replace immutable job input, erase
receipts, rotate the agent key or repeat a disk-write intent to make the job advance.

If an audited adoption fails before any installation binding, bootstrap job, provider-host
mutation, network/checkpoint/capacity or regional seed/join progress, the revision-guarded
`/v1/nodes/additions/{id}/cancel` can close that reservation without cancelling the paid VPS.
Retain its receipt, audit and firewall claim; an unknown firewall creation remains read-only.
Confirm that the old Workflow is terminal before creating a fresh adoption with a new request
key. Once any guarded installation progress exists, cancellation is refused; resume the original
operation instead. Failed inventory reads preserve the firewall's original dispatch boundary.

Preparation proofs have a short expiry. The first destructive checkpoint verifies fresh provider
facts and the accepted proof, then stores immutable installation continuation authority in
Cloudflare. Later installation commands use that authority, current operation/binding/plan and
short transport grants with fresh physical identities; they do not repeat provider inventory or
full preparation scans whenever the original proof ages. A legacy job missing continuation
authority needs one verified lifecycle-boundary backfill. Resume with the same sealed input,
credentials and native checkpoint, including saved write offsets. Neither a renewed proof nor
continuation authority permits restarting a disk write or resetting an uncertain checkpoint.
Quarantine release keeps separate fresh post-join network, Node identity and capacity proofs.

## Acceptance

If final bootstrap verification reports `bootstrap_readback_failed`, inspect the retained
checkpoint before attributing the cause. A committed storage-trial intent identifies entry into
the storage publisher; null resource identities do not prove that a create succeeded. Use
bounded read-only observation of the exact planned objects and fresh physical/cluster identity.
Authority transport, aborted requests and invalid response JSON/schema have finite diagnostics;
raw storage aborts retain `storage_trial_aborted`, while other unknown storage errors retain
`storage_trial_failed`. These diagnostics disclose no response bodies or credentials and do not
authorize a retry. Continue the same operation with its recorded ownership
and uncertain-outcome reconciliation; never reset the image or erase trial journals.

Storage readback uses exact Kubernetes REST resources rather than repeated discovery. Each fact
snapshot keeps its fresh Cloudflare authority calls, initial and final Node/Cluster/CSI checks,
Talos disk/partition/version and physical PV/VG/LV comparisons. Independent reads settle in
batches of at most four; every sibling finishes before an error can enter cleanup. Optional
trial resources use complete typed name-filtered lists: failed, paged, malformed, duplicate or
foreign results cannot establish absence. Every separately fenced mutation retains fresh
authority, identity and physical checks, with15-second authority requests and20-second native
commands. The complete guarded Native producer has a1800-second work allowance and1815-second
outer cancellation bound. Its historical before-to-after proof is bounded to1800 seconds, while
completion remains fresh within300 seconds and publication binds the current exact physical/CSI
state. Only the internal Native caller selects this rule. The manual publisher's original
300-second start-age and duration checks remain unchanged; there is no new CLI/environment option.

For acceptance of a future authorized node, complete installation and admission, then restore an EU1 test database into a separate US
target from R2 while keeping the EU source healthy. Compare SQL data and committed markers,
verify target backup/WAL and retain the EU Node, volume, role and encrypted custody identities.
Earlier loss, deletion and decommissioning kits are withheld; any later loss drill needs a
separately reviewed scope that preserves or recovers the same customer EU1. Keep unchanged prior
proofs and record new measured results in `PLAN.md`. Approximately nine-second cold starts are accepted for v1.
Do not migrate Neon or call the product finished until EU and US plus recovery have passed.
Record measured installation/rollout time and actual Contabo calls by lifecycle phase, including
zero calls throughout repeated transport grants, Kubernetes/Talos reads and proof cleanup after
source selection. Local tests, a configured image or provider Running do not establish this live
acceptance. Use the normal Cloudflare SQL endpoint to verify actual placement, roles/TLS, committed
markers, R2 base backup/WAL and deletion through confirmed physical storage reclamation.

## Accepted EU/US checks and observed software

The owner-authorized US operator postjoin/admission completed at16:50:20 UTC in198.356 seconds.
The programmed1GiB storage trial wrote, read and physically reclaimed its volume in753.081 seconds.
Automatic postjoin admission remains unproved: a report returned HTTP409 before pause, and its
session renewed without admission. The next genuine, separately authorized node purchase must
prove that path; the operator result does not substitute for automatic acceptance.

EU1 and US1 passed real SQL through `db.ohmyho.st`, TLS1.3 and nonsuperuser application roles.
EU trial SQL took2187ms. A separate EU restore took108618ms; a healthy-source EU-to-US restore
preserved two committed markers in87988ms, including observation pacing. A third marker committed
on US. All four databases passed R2 base-backup and exact committed-WAL checks, then each released
its5GiB physical volume after deletion (20GiB total). The earlier empty timeout trial was deleted
separately without an allocation. All three existing EU databases and encrypted custody remain.

The original US region configuration omitted `/pg` from its gateway URL. Gateway WebSocket
upgrade requires this path; a healthy Tunnel and correct service binding alone are insufficient.
Region registration must use `http://pgcf-gateway.pgcf-system.svc.cluster.local:8080/pg` with the
configured private VPC binding. The observed URL was corrected once with exact configuration
comparison before/after; no runtime or database reset was needed.

Actual inventory differs as follows. EU inventory is from October7 and US from October8, with
later US Regional delivery and both actual SQL readbacks supplementing it. No EU alignment was
required for the passed database checks.

| Component | EU | US |
| --- | --- | --- |
| Talos / kernel / containerd | 1.14.1 / 6.18.51-talos / 2.3.5 | Same |
| Kubernetes API and kubelet | 1.36.3 | 1.36.5 |
| Flux source / kustomize / helm / notification | 1.9.5 / 1.9.5 / 1.6.4 / 1.9.4 | 1.9.6 / 1.9.6 / 1.6.5 / 1.9.4 |
| Additional Flux controllers | Absent from inventory | image-automation1.2.5, image-reflector1.2.5, source-watcher2.2.4 |
| Cilium / CNPG operator / Barman plugin | 1.20.2 / 1.30.1 / 0.15.1 | Same |
| CNPG / Barman Helm charts | 0.29.1 / 0.8.1 | Same |
| cert-manager / OpenEBS / LVM driver | 1.21.2 / 4.6.1 / 1.10.1 | Same |
| cloudflared | 2026.10.0 | Same |
| PostgreSQL, actual SQL | 18.6 (Debian18.6-1.pgdg13+2), server180006 | Same |
| Regional runtime source | 901b3228 | 11555215, CI37815727563 |

The following are actual workload `imageID` digests, not Helm chart or release-content digests.
Kubernetes component versions are 1.36.3 in EU and 1.36.5 in US; the repositories are
`registry.k8s.io/<component>`.

| Kubernetes component | EU actual imageID digest | US actual imageID digest |
| --- | --- | --- |
| kube-apiserver | `sha256:b4bc06c81fd76f81174e6c19ddacf477acdf1583e7a5846ebbd513493aef6e43` | `sha256:4b3e69973a1d58d3c1f670d3477a9b9f14a03a271823113e8e0c9a333eb84f48` |
| kube-controller-manager | `sha256:ed56454bf514916079a227f5765b64524fde52106dfcc52978b28634765b78b8` | `sha256:2d717af134451db77ea053c3426bc82edc0e55415eb36e1260313c636ebe9a4d` |
| kube-scheduler | `sha256:128fc07d278d64c4f2cce416ed0a9f37b23a30cdde6f97873d18c9c78e259df4` | `sha256:3804f66442962cefbe11fcd5330d5e7a797bfb3dc8535c322d005637b404a85f` |

Flux repositories are `ghcr.io/fluxcd/<controller>`. An absent entry means the controller was
not present in the retained EU inventory, rather than a failed version observation.

| Flux controller | EU version and actual imageID digest | US version and actual imageID digest |
| --- | --- | --- |
| source-controller | 1.9.5 / `sha256:6f20d232d596a758c923d2861f23511718fc303b8a2e36a1434a7c736b9f4268` | 1.9.6 / `sha256:6a6693172589f8ff26123a231d5fa6ceb194a6efb4dc647cdf057c959f76a2e3` |
| kustomize-controller | 1.9.5 / `sha256:a3a955eb2bc432c2eaa94d2d3714e3beae7fdf17586fd23aadf71ab597ac3339` | 1.9.6 / `sha256:2ebeaa341da77d52b6abbbba5efcee0450d47f8b42f0e6f33b08f9020262d606` |
| helm-controller | 1.6.4 / `sha256:8ff15409e46d354338045f483d58ca9cb35dffa2f87e4addd1f5eba1e6a9175f` | 1.6.5 / `sha256:0d52fff5c4d476277b8fcb6beb9041e269adb5db943fe69f5a806ea0c92b1511` |
| notification-controller | 1.9.4 / `sha256:840f318265ee26f0d2c48a158bf7896b22aa4e998e320a18646309f0e40b15da` | 1.9.4 / `sha256:840f318265ee26f0d2c48a158bf7896b22aa4e998e320a18646309f0e40b15da` |
| image-automation-controller | Absent from inventory | 1.2.5 / `sha256:e1a2720d3951694609c39635886d5dcb15b7dffe0b8248461c6693539c522a28` |
| image-reflector-controller | Absent from inventory | 1.2.5 / `sha256:c83ce5c06fed9ebb308cd5165bd144ee934c720f6b47e0da2180869092063c82` |
| source-watcher | Absent from inventory | 2.2.4 / `sha256:86743f5a4cd4ea76b9722eb86222d56e8253e776daa0565ecb186ec68ad1d835` |

Talos runtime versions match, but the installer configuration does not prove a shared immutable
image. The retained EU control configuration names `v1.14.1` by tag without a digest. Customer
EU1 records installer digest `sha256:d1d2fbf374cd886fdd3b2f19d3bc9e82dcefa9caeb73275810b0f71060cc986e`;
US1 records `sha256:cd4cb83e5f27cd356956cac01ed6f0c5ed2ec4343d3f46e4efa72706ed92d288`.
These are configured installer identities, distinct from the running Talos version. No EU
reinstallation, upgrade or template activation was performed to align them.

Actual Regional digests are EU `sha256:eeaa6ab0c1fc182e9e050d6f104565ec0a3dc4e7482b1950287c31b62ebe607a`
and US `sha256:1886a64e36d2b9ba45e4d876a0a9eb6bab3fb83a6b0fafcb18dbf8647ef66993`.
The US correction passed CI qualification of all10 layers and registry readback of89,782,247
compressed bytes. The configured PostgreSQL image pin is
`sha256:5495f355719f24bd56219bc46825ecfa8771515a110ceca6e4d83331868bf115`; actual SQL confirms
18.6 in both regions. A US PostgreSQL runtime imageID was not separately retained in this audit.

Shared actual controller imageIDs: CNPG `sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07`,
Barman `sha256:c75acad19a36e8176cfe2885761ff1b836c6ef977d7257e298c99a28b5c302ef`,
Cilium `sha256:2939231d0d3e3ebddcd80fffa168b7ddcc78fdf0dc864d1c8c126ff523c54f01`,
cert-manager `sha256:70f532fd9cfde0b09d55687200942399d89838bc2d5d5b45152eb799a15912b8`,
LVM `sha256:41f73aba7f31eee4a033053d9c2f203e007a838c14823f3fd472c50651a98999`, and
cloudflared `sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07`.
Chart digests and workload imageIDs identify different artifacts; do not compare them as strings.

The initial admitted-node association capture counted1 OAuth and1 provider GET. Three nonempty
30-minute routine captures counted zero provider attempts, including390 proof/transport frames
and a report HTTP409 in the final pre-operator window. Historical lifetime provider totals are
unknown. Keep lifecycle counts separate and do not sum overlapping capture windows.

## Customer migration handover

Neon migration remains a separate reviewed cutover. EU/US SQL, backup/WAL, restore, physical
reclamation and the real RAM threshold observation have passed. Preserve EU1 and its
three existing databases. Do not upgrade EU Kubernetes or activate a bootstrap template in this
scope, including after US database acceptance. Only a separately reviewed upgrade scope can
change that instruction.

Before customer data, resolve the October 5 revision-1 credential exposure through
[the credential procedure](credentials.md). Secure encrypted D1/etcd/configuration backups and SQL
markers; rehearse targeted rotation, prove replacement access and rejection of retired trust,
and preserve Node/Cluster/storage identities. API CA rotation alone does not cover etcd,
bootstrap/trustd, discovery, aggregator, service-account or Secret-at-rest material. Coordinate
live trust with Cloudflare seed/join custody; the version-template API changes metadata only.
Retire affected historical active signers and rescue/SSH bootstrap authority after replacement
verification. Retain required archive-verification/decryption material privately, including
referenced `CREDENTIAL_KEYS` IDs and old decrypt keys until rewriting/retention permits removal.
Do not reinstall nodes, overwrite revision 1 or claim rotation is complete.

Inventory source region, roles/grants/extensions, sequences, pools, timeouts and sizing. The
actual capacity snapshot has **3,000 millicores allocatable** on each customer node. US platform
reservations consume **1,510**, leaving **1,490** for database reservations. The smallest enabled
size class requests **250 PostgreSQL + 100 Barman = 350 millicores**: at most **four** such databases
by configured CPU arithmetic on an otherwise empty US node. The 22-US cohort needs at least
**7,700**, exceeding the **1,490** available database CPU. At the configured **5 GiB** minimum,
22 volumes need **110 GiB**, exceeding measured **95 GiB** node storage.

EU1 reserves **350** platform millicores: `(3,000-350)/350` admits at most **seven** minimum-class
databases if otherwise empty. Its current **1,024 MiB / 500-millicore** database reserves **600**
including Barman, leaving CPU room for at most five additional minimum-class databases before
other checks. The snapshot’s original US demand reserved 600 millicores; all trial databases are now deleted.
Refresh actual placement reservations before the separate customer cutover.
These are configuration ceilings, not a demonstrated workload density.

Ten real consecutive US minute samples from18:43:01 to18:52:04 UTC averaged **79.9062%** under
an operation-owned3968MiB allocation. Cloudflare persisted that average and its expansion trigger.
Existing eligible placement and full CPU/storage/PostgreSQL plus512MiB Barman startup checks
still passed. The dry capacity decision remained `disabled` and made no provider call: finite
standing cost/count/expiry authority is absent, caps remain EU3/US1 and autoscaling is disabled.
The first trial correctly rejected a missing18:37 sample; actual kubelet timestamps crossed
18:36:59 to18:38:00. Its load was removed and physical available RAM recovered before the
independent second trial. Never synthesize samples or weaken consecutive-minute validation.
Both disposable loads used4096MiB limits and720-second automatic deadlines. Final second-load cleanup removed the exact Namespace/Pod and recovered4,177,731,584 bytes;
fresh available RAM returned within the recorded baseline tolerance. Actual customer workload density remains unaccepted; RAM overbooking
does not remove CPU, storage or startup checks. Approve sufficient regional capacity before
committing the22-US cohort.

### Connection and cold starts

The inspected adopter uses `pg` with Neon TCP origins. PGCF’s public transport is verified WSS;
a TCP DSN hostname swap is insufficient. Use the established Neon serverless `Pool`/`Client`
WebSocket mode with `pipelineConnect=false` and a `wsProxy` URL containing
`/v2?database=<URL-encoded-PGCF-ID>&user=<URL-encoded-role>`; see
[the connection contract](../../README.md). Keep PostgreSQL authentication and TLS. Hints scope
admission; they are not credentials. Neon supports multiple transports; this recommendation
follows the inspected adopter and PGCF contracts.

For psql and logical export/import tools, use the existing CLI:

```sh
node packages/cli/dist/main.js connect --endpoint wss://db.your-domain --database <pgcf-id> --user <role>
```

Use the printed loopback port, target PGCF ID and role. `sslmode=disable` applies only to
loopback; public WSS and gateway-to-PostgreSQL TLS remain verified. Keep passwords private;
never expose a VPS database port.

Dev cold connections measured p95 **9.160 s**, maximum **9.708 s**. The adopter’s **5 s**
connect timeout can fail before wake. Its **10 s** query/statement defaults are separate from
the end-to-end request deadline; budget wake plus work explicitly.
Before cutover, verify one policy: an approved always-warm size class
(`sleep_after_seconds:null`); prewake with `POST /v1/databases/{id}/resume`, operation/readiness
polling and `SELECT 1` immediately before traffic; or bounded connection/request deadlines
covering measured wake plus query/network margin. SQL statement timeouts are separate and do
not fix shorter connection timeouts. Never retry uncertain writes. These are Dev measurements,
not accepted US application latency.

### Create, restore and rebind

Use the authorized project-scoped integrator key, persistent mutation `Idempotency-Key`s and
existing API contracts:

- `POST /v1/databases` with `{project_id,region_id,name,size_class_id}`; save the new database and
  operation IDs. Poll `GET /v1/operations/{id}` and `GET /v1/databases/{id}`.
- `POST /v1/databases/{id}/roles` with `{"name":"<role>"}`; await role readback, then obtain
  `GET /v1/databases/{id}/roles/{role}/connection-uri`. Only integrator responses include the
  password; save them privately. Administrator responses cannot supply an application password.
- PGCF archive restore: `POST /v1/databases/{source-id}/restore` with
  `{"mode":"full","name":"recovered","region_id":"<region>"}` or PITR with `target_time`.
  It returns a **new database ID** and separate storage. Reuse the same key after an uncertain
  submission; follow [recovery](recovery.md). This API restores PGCF archives, not a Neon dump.

A separately approved Neon import freezes writes and uses a consistent logical export/import
through the normal CLI, with reviewed owners, grants, extensions and sequences. For either
import or restore, rebind the adopter’s provider/database mapping to the new target ID/region,
update protected role credentials/password revision and versioned registration, drain old
connections and create a fresh authorized pool. PGCF requires current database/role registration;
stale or unregistered hints must fail. The adopter’s URL validator accepts Neon pooler hosts only,
and its durable registration includes Neon-specific target fields. PGCF adapter/registration
acceptance is therefore a cutover prerequisite: use supported scoped operations; do not bypass
checks or edit tables to make a DSN swap work.

Compare data/checksums, roles/grants, sequences and committed markers. Verify actual Cloudflare
TLS/region, target backup/WAL, application transactions and selected timeout/pool behavior.
Rehearse restore into another new ID and repeat rebinding. Once target writes begin, returning
to stale Neon requires reconciliation. Delete trials through `DELETE /v1/databases/{id}` and
confirm operation completion plus physical reclamation; R2 archive retention is separate.


## Synchronize version templates after an accepted Kubernetes upgrade

This is a separate future maintenance procedure. EU upgrades and template activation are excluded
from the current operator completion, including after database acceptance.

Use the supported Talos Kubernetes upgrade with a reviewed dry run; never reinstall the EU
nodes to align patch versions. Verify the actual API-server and every kubelet version while
preserving Node/Cluster UID, storage, roles, Secrets and certificate/key identities. Record
actual post-upgrade configuration; never reapply old machine documents that would downgrade
the components.

After migration0023, administrators can read `GET /v1/regions/{id}/bootstrap-material` and use
`POST /v1/regions/{id}/bootstrap-material` to synchronize version metadata. The write requires
expected current revision and old/new plaintext hashes, an exact hash of verified readback,
Cluster UID, complete physical Node UID/provider/name set and a fresh observation timestamp.
It accepts no new CA or key payload. The API copies existing material with only the selected
Kubernetes-version change, stages a new immutable seed/join pair, and atomically selects it
only when there are no active installation operations and all authority remains current.
Keep the verified readback within120 seconds and CF Node observations within180 seconds.

A staged revision does not change active configuration. Historic job references and revision1
remain unchanged; new jobs and current-source checks use the selected active revision. Resolve
an uncertain response by reading the active revision/provenance and exact hashes; do not
rewrite old ciphertext or dispatch another physical upgrade. The administrator's native
readback is the explicit trust boundary: this API validates its identity and provenance,
rather than claiming to perform the Kubernetes upgrade itself.

## Resume after Kubernetes bootstrap custody is sealed

After a join bundle is sealed, resume with its exact retained kubeconfig and certificate/key
material. Verify the current kube-system UID and current Cloudflare material before continuing.
Do not request replacement credentials or reseal a different bundle at the same revision.
A lost seal response is resolved by authoritative reads; equality remains mandatory.

The initial Talos reboot uses `--wait=false` because the installer separately verifies changed
boot ID and authenticated OS/storage readback before bootstrapping Kubernetes. Talos
MachineReady can depend on that later bootstrap/CNI work. A stored reboot or bootstrap intent
requires observation on resume, never blind redispatch of the mutation.

The pinned Helm4 preflight uses `helm list` without the removed `--all` flag; its default
includes every release state. Keep the exact namespace/filter and reject any existing
Cilium release before recording or dispatching a new install intent. Do not treat an old
Helm flag error as evidence that the cluster needs reset or an installation repeated.

The Native CONNECT proxy permits at most64 incoming clients, counting each tunnel once and
retaining both socket ends for cleanup. Helm's measured discovery/validation pool reached30
clients; the prior sixteen-client limit dropped valid connections. This bounded concurrency
does not change authorized addresses, ports, fresh per-connection grants, TLS or expiry.

A retained Cilium install intent normally resolves through exact authenticated release and
workload readback. The serialized Native executor may consume one persisted attempt2 only
after the prior command has closed, the pinned chart has no separate CRD/pre-install effects,
all rendered resource identities and Helm Secret/ConfigMap records are confirmed absent, and
the same quarantined Node UID and sealed Cluster UID remain fresh. Cloudflare validates the
bound receipt and consumes the claim atomically without clearing the original intent or
rewinding any disk, custody or storage progress. A lost claim acknowledgement dispatches
nothing. Once attempt2 is recorded, resume observes only; it never sends another install.
Existing, partial, foreign, stale or unknown effects block recovery. This is a programmed
no-effect resolution, not permission to clear a journal or manually repeat an uncertain write.
The pinned chart's `cilium-secrets` Namespace is a cluster-scoped install effect. Include it
and its declared namespaced resources in complete absence readback; do not skip a Namespace
or accept an already existing one to make recovery advance.

Render and validate the immutable chart before starting the fresh physical absence window.
Read exact typed REST collections with an encoded name selector, bounded concurrency and
complete-list checks; a failed read is never absence. Read the sealed Namespace and target
Node through their exact REST paths. The API's120-second receipt limit remains unchanged.
`cilium_recovery_claim_rejected` logs only a fixed reason, the owned operation ID and bounded
observation ages. A409 alone does not identify which predicate failed; retain the diagnostic
and resolve current journal state before any follow-up. A recorded attempt2 still permits
only authenticated readback, regardless of the diagnostic reason.

Kubernetes canonicalizes integral Quantity values: a ResourceQuota hard pod count of `1000`
can read back as `1k`. Compare this field numerically with the exact integral parser, while
retaining every other namespace, ownership and spec check. A representation difference does
not authorize applying Flux again or clearing its saved intent; resume the existing readback.
The same narrow numerical comparison handles Deployment container CPU limits (`1000m`/`1`);
every other field remains strict.

If the retained Flux intent has exactly the observed missing pinned Services `source-watcher`
and `webhook-receiver` or Deployment `helm-controller`, the serialized executor may record one
Flux repair intent in Cloudflare. It requires fresh complete43-object inspection, matching
physical identities, exact ownership of every existing object and their unchanged UID/spec
set. The executor rechecks Namespace UID and ownership before creating only that subset.
An uncertain claim dispatches nothing; a consumed repair never permits another create.
Resolve partial or unknown results through exact authenticated readback. Never reapply the
whole Flux manifest, erase either repair journal or reset the original installation checkpoint.

Flux adds the pinned OCI digest prefix to Cilium's chart version during handoff. Before platform
synchronization require the original `1.20.2`; afterward require only the exact pinned
`1.20.2+a7c12d330dd9`. Verify the full OCI digest, original chart-byte hash, current owned
reviewed Git/Kustomization and Ready HelmRelease, plus the referenced values ConfigMap's
ownership, exact pinned content and stable UID. Application version, deployed status,
bootstrap-operation label, exact Helm values and physical identity remain required.
Do not strip arbitrary version metadata or repeat an install to resolve this representation.

Regional readback must use the same cloudflared image digest as the reviewed regional
Kustomize manifest and version lock. A stale verifier constant does not authorize replacing
the deployed component. Confirm current ownership/readiness/replicas/tolerations and fix
only the expected pinned value, retaining the original regional installation intent.
