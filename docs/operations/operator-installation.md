# Existing-account installation

This guide completes the operator's existing Cloudflare/Contabo installation. Preserve the first
EU control/relay node and its imported credentials. Retain the already-admitted second EU node as
customer EU1 (formerly EU2), with its installation, Node identity, data and custody unchanged.
Exactly one new US1 control-plane/customer node was purchased through the API for one month.
Both customer nodes use V159 / Cloud VPS Plus 4: 4 vCPU, 8 GiB RAM and 150 GiB NVMe. Provider
Running is not installation or admission. No new EU worker, EU1 re-adoption, reset or
decommissioning is part of this completion. Public
distribution and installation in a foreign Cloudflare account are separate release work.

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
timestamps and bounded retained source stages, UID hashes and session-match flags. This reads
local Durable Object records only and grants no cleanup or proof authority. It exposes neither
private inputs nor credentials and does not wake or contact a Container.
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

US1's purchase, profile, installation binding and reported inspection are already retained; its
original authorized job is still `created`, before disk writes. Continue that same addition and
AddNode Workflow through its existing pause/resume control, preserving sealed inputs, credentials,
proof-source association and journals. Resolve an uncertain control response through observation.
Do not repeat the purchase, profile import, adoption, registration or disk-write intent. EU1 is
already admitted and needs no bootstrap or adoption operation. The sequence below describes US1's
remaining programmed work and future authorized additions; it does not authorize reinstalling EU.

Keep actual-RAM mode, automatic purchases and autoscaling disabled until US/recovery acceptance,
reviewed test cleanup and explicit finite owner limits. Then use the guarded
`PUT /v1/regions/{id}/capacity-policy` with `region_id`, `max_nodes`, `purchases_enabled`, `order`,
`placement_mode`, `maximum_database_memory_mib`, `postgres_memory_request_mib`,
`standing_cost_profile`, `autoscale_enabled` and `adopt_instance_ids`. Preserve current finite node
caps. Use `placement_mode:"actual_ram"`, 256 MiB assignment steps, maximum 4096 MiB and the reviewed
128 MiB PostgreSQL request for this installation. Changing mode or the PostgreSQL request requires
an empty assigned live cohort and no unsettled startups; configured limits must cover existing
databases. Cost/node-cap updates do not reset database state.

The exact regional `order` contains `product_id`, `provider_region`, `image_id`, `term_months` and
`location`. Use the confirmed V159 offer with `term_months:1` and omit `add_ons`. Its standing
profile must bind that exact order and explicit `id`, `owner_reference`, `approved_at`, `expires_at`,
`currency`, `monthly_amount`, `setup_amount`, `max_orders`, `max_total_monthly_amount` and
`max_total_setup_amount`. Do not infer unlimited orders or spend from a model approval. Enable
standing purchases only while these finite limits and expiry authorize the order.

The retained control server's UID-guarded new-database placement flag is already disabled;
preserve Kubernetes/platform operation and existing data. The flag excludes new placement;
existing databases must continue to serve, wake, resize and delete normally.

Cloudflare executes the automatic capacity-to-Ready sequence from persisted state:

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

Preparation proofs have a short expiry. A multi-minute install can pause when its proof expires;
collect fresh measurements and a signed artifact for the same operation and immutable network
plan, then let normal verification renew the recorded proof. Resume with the same sealed input,
credentials and native checkpoint, including saved write offsets. A renewed proof does not
authorize restarting a disk write or resetting an uncertain checkpoint. Quarantine release keeps
its separate fresh post-join network, Node identity and capacity proofs.

## Acceptance

Complete US1 installation and admission, then restore an EU1 test database into a separate US1
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

After operator acceptance, inventory the adopter's databases, roles/extensions, client pooling,
timeouts and required capacity in its own repository. Keep its Neon databases separate until
each reviewed migration freezes writes, restores and compares data/roles/sequences, verifies the
Cloudflare target's TLS and backup/WAL, and accepts the connection cutover. Do not switch back to
a stale Neon source after target writes without reconciling them. Credential changes follow the
separate custody runbook; this completion does not authorize an uncoordinated rotation.
