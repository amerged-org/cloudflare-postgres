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

## Programmed installation path

The headless producer is implemented and has passed the common software and image checks; delivery
and fresh-node Dev acceptance are tracked in PLAN.md.
Configure an authenticated regional `/v1/regions/{id}/installation-profile` once, with the reviewed
Talos image source, measured storage geometry, DNS, retained rescue client key and issuer region.
The first node of a region additionally needs its reviewed platform source/image and protected
regional credentials; an EU worker uses the retained cluster join custody. Profiles and per-node
rescue identities are encrypted in D1. Status never returns their private keys.

For the current deployment, bind US1's existing original-request-correlated purchase receipt
before preparing its bootstrap; do not issue another order. EU1 is already admitted and needs no
bootstrap or adoption operation. The installation sequence below applies to US1 and future
authorized additions, not to the retained EU nodes.

For actual-RAM placement, configure the policy explicitly: 256 MiB assignment steps, maximum
4096 MiB, and the reviewed PostgreSQL request (128 MiB in this installation). Keep CPU and storage
checks enabled. Changing reservation geometry requires an empty assigned live cohort and no
unsettled startups; a normal cost/node-cap change does not reset existing database state. Mark the
retained control server ineligible through its UID-guarded database-placement endpoint, while
preserving Kubernetes/platform operation and existing data. The flag excludes new placement;
existing assigned databases must continue to serve, wake, resize and delete normally.

The automatic sequence is:

1. Ten fresh consecutive minute samples from the same physical Node UID reach 76% average
   working-set/physical RAM. Cloudflare reserves one regional addition, checks the exact standing
   offer and spend/node caps, then dispatches one original provider request UUID.
2. Read-only receipt/audit reconciliation establishes the actual instance. Unknown order outcomes
   never cause a second purchase. A cancellation is recorded only after fresh matching provider
   inventory confirms it and no installer job, node or destructive progress exists.
3. Allocate/read back the owned free firewall definition, create a unique retained rescue host
   identity, and request registered-key RAM rescue. Native inspection measures the actual disk,
   RAM, MAC, network and official pinned Talos image/GPT; incomplete hardware remains unknown.
4. Compose and seal the exact installation input. Actual outside-allowlist dual-stack port scans
   and allowed-source controls establish a signed preparation proof. The Workflow refreshes
   measurements when the proof has less than 60 seconds remaining; it retains all write offsets
   and immutable checkpoints.
5. Install the qualified image, apply the exact network configuration and join/bootstrap the
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
