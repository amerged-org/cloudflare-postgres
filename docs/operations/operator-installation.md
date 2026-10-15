# Existing-account installation

Follow the canonical [ULTRA delivery plan](../architecture/cloudflare-convergence-and-serverless-plan.md)
and record measured completion there. Keep the existing EU control/relay and customer EU1
servers; do not reset, re-adopt or reinstall either of them to resume a stalled operation. The US
region is cancelled and US1 is marked lost.

EU1 is a Contabo Cloud VPS with 6 vCPU and 12 GB RAM. Talos 1.14.2/Kubernetes 1.36.5 is the
release baseline. Golden R1 includes the sandbox extension and common release pins;
`dm_thin_pool` is loaded through Talos machine configuration, not the image recipe.

New nodes use the golden raw image through AddNode; existing nodes use supported Talos/Kubernetes
upgrades followed by Flux platform/PGCF convergence. One `POST /v1/fleet/rollouts` request drives
the whole selected fleet serially without laptop helpers or operator steps
([fleet patches](fleet-patches.md)). Use the six functional checks in the ULTRA plan. Use Contabo
only at provider lifecycle boundaries. A future real expansion uses the configured
threshold/purchase policy and the same golden release; a new region starts with its
[control server](#control-server-of-a-new-region).

## Reviewed deployment inputs

Use a source commit that passed the common CI checks and fully qualified images by immutable
digest. The native bootstrap image may stay private: push the qualified amd64 image to the
deployment's Cloudflare managed registry and use its returned immutable reference. Preserve the
image's source labels and notices; registry transfer does not replace qualification.

Keep the private API configuration outside Git. It supplies D1, region-specific R2 bindings,
RegionLink/DatabaseActor/NodeBootstrap/CronWatchdog Durable Objects, the AddNode, PatchNode, ThinQualification
and InfrastructureBackup Workflows, the Container and the fixed-source VPC relay binding. Start from `apps/api/wrangler.example.jsonc`; replace every
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

The EU archive uses the EU-jurisdiction binding and EU S3 endpoint. Every other region has a
separate bucket on the account's general S3 endpoint. Choose that region's location hint when
creating its bucket; the hint does not guarantee jurisdiction. `ARCHIVE_BINDINGS` must map each
exact region ID to its actual Worker binding and bucket. A mismatching or missing binding fails
closed.

Route tokens are versioned. The Edge signs a token that the regional gateway verifies before it
dials PostgreSQL. A v3 token binds the database generation and the verified primary Pod. A v4
token adds the independent admission route revision from the Actor's admission snapshot and
needs the release markers `route_token_version: 4`, `runtime_attestation_version: 2` and
`admission_snapshot_version: 1`. The native gateway refuses a stale revision or another Pod
before dialling. A region gets a token with a target only when its assigned release declares
the version and every current assigned member confirmed that release's patch at the current
region revision; an admission without the verified target of the observed revision is refused as
not ready (57P03).

Approval checks only that a declaring release runs the native gateway and controller on every
role; the API holds no image provenance. Declare a route token version only in a release whose
pinned `native-gateway` and `native-controller` images CI built from the source that implements
it.

## Edge Worker

The deployed Edge Worker is the TypeScript `apps/edge`; the management API and DatabaseActor stay
in TypeScript. Start the private deployment configuration from `apps/edge/wrangler.example.jsonc`
and preserve the existing Worker name, hostname, DatabaseActor binding, rate-limit namespaces,
regional VPC/service bindings and `ROUTE_MASTER_KEYS` secret.

The Rust/Wasm replacement lives in `apps/edge-rust`. The common CI workflow builds it; it is not
deployed. Build the selected source once using the Rust toolchain and `rustEdge` tools from
`infra/platform/versions.lock.json`. Verify the pinned tool archives and exact members before
using `WASM_BINDGEN_BIN`, `WASM_OPT_BIN` and `ESBUILD_BIN`. The common CI workflow performs this
preparation.

`pnpm --filter @pgcf/edge-rust build` creates `build/index.js`, `build/index_bg.wasm`
and the compatibility entry `build/worker/shim.mjs`. Preserve their checksums and upstream
notices with the release artifact. `pnpm --filter @pgcf/edge-rust test` loads those already
built bytes in real local workerd instances with the actual DatabaseActor, D1, rate-limit
and Fetcher bindings; it does not rebuild the Worker. Local fixtures prove binding and
protocol behavior. They do not replace Dev PostgreSQL/TLS and VPC transport acceptance.

Start the replacement's private configuration from `apps/edge-rust/wrangler.example.jsonc`;
it has the same bindings and secret as the TypeScript example. The example intentionally has no
custom build command: delivery uses the qualified artifact instead of compiling again. Do not
activate the replacement until the selected bytes pass Dev database acceptance. Record the
actual Worker version and result in the ULTRA plan.

Both editions return the unopened upstream WebSocket directly to Cloudflare. PostgreSQL bytes
are not relayed through a TypeScript or Wasm application loop. Only bounded local refusal sockets
parse their own startup/SCRAM exchange. Request aborts and the absolute admission deadline cancel
the exact Actor waiter; a cancellation never retries the gateway connection or application SQL.

## Private bootstrap transport

The relay runs on the explicitly selected first EU node using
`infra/platform/bootstrap-relay`. It listens on host loopback port 8082 and carries only public
Ed25519 verification keys. Its cloudflared sidecar uses a dedicated private Tunnel. The API's
`BOOTSTRAP_RELAY_SERVICE` VPC HTTP service targets that Tunnel and loopback port; no public relay
hostname is needed. Retain signing keys privately, with explicit issuer and allowed target regions.

Verify the real VPC-to-Tunnel identity and the relay's current process epoch before enabling
bootstrap jobs. Native SSH, Talos and Kubernetes sessions still verify their host keys or
certificates end to end. Broken transport never replays a native command.

An administrator can open `GET /v1/nodes/{id}/operator/kubernetes?node_uid=<UUID>`
with its administrator Bearer key and a WebSocket upgrade. This uses the existing Cloudflare
relay and only the node's sealed Kubernetes endpoint on port 6443; it returns no relay capability,
cluster credentials or kubeconfig. `PgcfClient.operatorKubernetesRequest` prepares the private
WSS URL and Authorization header for a caller-owned WebSocket connector; do not log its headers
or follow redirects. Validate the upgrade's `X-PGCF-Node-UID`, `X-PGCF-Cluster-UID`,
`X-PGCF-Node-Name` and `X-PGCF-Material-Revision` with
`PgcfClient.parseOperatorKubernetesResponse`. These headers are Cloudflare's expected identity.
The operator retains Kubernetes mTLS credentials and CA validation client-side, then independently
reads `/api/v1/namespaces/kube-system` and `/api/v1/nodes/{node_name}` through the tunnel before
any write. Their actual UIDs must match the expected cluster and Node UIDs. Missing or different
identities stop the operation. This endpoint does not reopen terminal AddNode jobs.

For bounded Talos reads, use `scripts/operations/talos-via-kubernetes.mjs` with the administrator
key supplied by `--api-key-env`, private `--kubeconfig`/`--talosconfig`, the expected Node ID/UID
and literal address, the current Cilium spec image and running image-ID pins, pinned native
`--kubectl`/`--talosctl` paths, and a new private `--output-dir`. Put the Talos command after `--`.
The helper checks actual cluster, Node, DMI and carrier identities before and after forwarding
through an existing host-network Cilium Pod; Talos mTLS retains the real-IP endpoint. It supports
`get`, `read`, `version`, `image list` and `etcd snapshot <basename>` into the private output directory.
All `upgrade-k8s` commands are refused because even `--dry-run` can write machine configuration.
Target/context/configuration and insecure overrides are refused; processes and sockets are cleaned
on completion or timeout. The helper creates no Pod or provisioning job.

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

The provider client retains credential-scoped OAuth reuse/coalescing, early-expiry refresh and
401 invalidation. A credential change closes reuse of the old client; an uncertain mutation is
resolved through its existing claim and readback rather than replayed.

## Programmed installation path

The headless producer is implemented and has passed the common software and image checks; its
fresh-node live acceptance is tracked in the ULTRA plan.
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

Completed AddNode jobs retain their original purchase, profile, inspection, installation and
admission records. Preserve sealed inputs, credentials, proof-source association and journals;
they record completed work. Resolve uncertain control responses through observation. Do not
repeat purchase, profile import, adoption, registration or disk-write intent. EU1 is already
admitted and needs no bootstrap or adoption. The sequence below is the procedure for future
authorized additions, not an instruction to reinstall an existing node.

The live node ceiling is removed (`max_nodes:null`) and no capacity-mail credentials or
recipient are configured. Purchases and autoscale stay off through go-live; enabling them, or
any new paid resource, needs the owner's explicit, costed go, and every addition waits for a
thin-qualified release (see the [new-region runbook](#control-server-of-a-new-region), step 4).
The missing EU installation profile is configuration work, not a missing owner permission.

### Operator-configured capacity and optional notifications

Management is API-only and requires an administrator key; an integrator's project key does not
control infrastructure purchases. Read `GET /v1/regions/{id}/capacity-policy`, then PUT the
intended complete policy to the same route. Existing fields retain their documented
full-replacement semantics; omitting newly added settings or `max_nodes` preserves stored values
for existing callers. Explicit `null` removes an optional value. No large sentinel count
represents an absent limit.

| Setting | Meaning |
| --- | --- |
| `ram_expansion_threshold_ppm` | Required actual-RAM threshold for automatic paid expansion;760000 means76%. Fresh policy is null/unconfigured. |
| `autoscale_enabled` | Enables automatic capacity selection, including configured adoption; false by default. |
| `purchases_enabled` | Permits purchase authorization/first dispatch; false by default. Automatic buying requires both switches and a complete configured order/authority. |
| `max_nodes` | Optional managed-allocation ceiling; null removes it. No fixed three-node limit is imposed. |
| `ram_warning_threshold_ppm` | Optional mail/webhook warning threshold; null disables this warning. |
| `node_ram_warning_threshold_ppm` | Optional warning when any node's own ten-minute RAM window reaches it, control included; null disables it. |
| `node_cpu_warning_threshold_ppm` | Optional warning when any node's ten-minute average CPU usage reaches it against node CPU capacity; null disables it. Needs a reporter that sends the CPU sample fields: the native controller shipped with R2. Otherwise CPU stays unknown. |
| `node_storage_warning_threshold_ppm` | Optional warning when any node's fresh LVM sample reaches it: thin-pool data or metadata fill, otherwise volume-group allocation; null disables it. |
| `cap_warning_enabled` | Opt-in notice for an operator-selected finite cap; false by default. |
| `parked_tier` | Optional [parked sleep tier](../architecture/parked-instances.md): `enabled`, `ttl_seconds` (how long a database stays parked), `max_per_node` (the oldest demote to full hibernation first) and the parked requests. Omitted keeps it, `null` removes it, `enabled:false` demotes every parked database. |

The configured RAM threshold applies to automatic new paid orders in both placement modes.
Retain ten fresh aligned consecutive minutes for every eligible customer node, each with stable
physical Node UID and capacity. Sum actual working-set bytes against physical bytes. Unknown or
unaligned capacity is not zero; an empty newly admitted spare must prevent repeated expansion
from an old hot node. Keep one active regional addition and revalidate current policy and pressure
before first dispatch. Policy changes invalidate stale undispatched approval while retaining the
same intent and ledger charge. Once a provider write is recorded or uncertain, reconcile its
saved request identity through reads, even if the threshold or purchase switches subsequently
change. Never repeat an uncertain order. Adoption of already allocated nodes and explicit manual
costed orders remain distinct paths.

Operators configure an exact `order` (`product_id`, `provider_region`, `image_id`, `term_months`,
`location`, and any explicitly selected add-ons) and their own standing authority. New generic RAM
profiles use `trigger:"regional_actual_ram"`; old serialized `ram_76_percent` authorities remain
readable. Profiles bind the exact order, owner reference, approval time and optional monetary,
order-count and expiry limits. Unknown prices stay null, never zero or an invented provider quote.
This installation's owner selects V159, one month, no add-on and760000PPM; those are installation
settings, not fixed product requirements. Provider credentials are protected operator secrets.
Fresh adopters receive neither these credentials nor this owner's purchase authority.

The retained EU placement settings remain actual RAM,256MiB assignment steps, maximum4096MiB
and the reviewed128MiB PostgreSQL request. Changing placement mode or the PostgreSQL request
requires an empty live cohort or complete current-generation manual suspension with no unsettled
starts. Preserve database/volume/role/custody identities and resume through fresh full-peak startup
admission. Threshold, optional-cap and notification changes do not reset databases. If an operator
selects a finite cap, count control nodes, lost paid allocations and unpaid reservations; recovery
on the same provider allocation does not consume another slot.

Email is opt-in. Configure a warning policy plus `INFRASTRUCTURE_ALERT_WEBHOOK` (service Fetcher)
or `INFRASTRUCTURE_ALERT_WEBHOOK_URL`, authenticated with the private
`INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN`. A Fetcher takes precedence; never try a second destination
after an uncertain response. The adopter's receiver owns its explicit sender, recipient and mail
provider key, for example Resend. PGCF has no hardcoded recipient or mandatory mail vendor.
Missing delivery configuration sends nothing and does not block capacity decisions.

Warning events use stable IDs and stored payloads; receivers must retain event/payload dedupe
beyond provider idempotency windows. Explicitly disabling a warning deactivates pending episodes
even when RAM is unknown; delivery also checks current policy. Unknown measurements alone do not
rearm an enabled warning. Operational health records callback acceptance; provider acceptance
and actual delivery are separate evidence.

The retained control server's UID-guarded new-database placement flag is already disabled;
preserve Kubernetes/platform operation and existing data. The flag excludes new placement;
existing databases must continue to serve, wake, resize and delete normally.

### API-only resource profiles and regional configuration

These management routes are API-only; no PGCF administration UI is part of the product.

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

PostgreSQL CPU request and hard CPU limit are separate fields. An omitted request equals the
limit. Use qualified resource values; a smaller request does not prove workload density or
remove PostgreSQL/Barman startup checks. Memory remains the PostgreSQL container limit, with
backup/system overhead reported separately.

A confirmed sleeping database accepts future compute configuration while remaining suspended.
Its unchanged no-Pod fact retains zero active CPU charge (a parked database keeps its instance
Pod and holds the parked charge instead). `deferred_until_wake` explicitly means
that no running PostgreSQL has yet proved the new settings. The next wake reacquires fresh hard
CPU/RAM startup admission and must report current configuration readiness before `applied:true`.
An uncertain stop or degraded observation is pending. A newer resource revision supersedes an
unfinished older resize explicitly; stale observations cannot acknowledge the current revision.

Physical storage reporting does not enable thin allocation: Thin storage is selected per node
and needs a release-bound qualification receipt
([recovery](recovery.md#thin-storage-admission-and-protective-recovery)). Retained thick
volumes keep their backend and quota debit. A missing/old/mismatched sample stays unknown, and
`thin_pool:null` means no thin pool exists, not free thin capacity.

Cloudflare implements the capacity-to-Ready sequence below from persisted state. Earlier
installations used the owner-authorized operator postjoin/admission fallback; the complete
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

Use only the confirmed V159 offer (150 GiB NVMe, no storage add-on) and its reviewed costs for the
installation profile and standing policy. Do not select a V155 NVMe add-on
(`addOns.extraStorage.nvme`): the one test allocated an 8 vCPU, 24 GiB RAM, 600 GiB SSD server
and not the NVMe variant. Do not repeat that test; EU additions follow the configured purchase
policy.

## Control server of a new region

Use this sequence for every new region, for example US or Oceania. It installs the region's
control server from the selected Golden release through AddNode; customer workers then join
through the same path. The parameters are listed in the
[control-server configuration](../../infra/talos/README.md#control-server-configuration-per-region)
and the model in the [ULTRA delivery architecture](../architecture/cloudflare-convergence-and-serverless-plan.md#delivery-architecture).
Every call needs an administrator key; send each mutation with its own persistent
`Idempotency-Key`. A new region needs no code change and no relay of its own.

1. **Region.** `POST /v1/regions` with a new `id`, `provider:"contabo"`, the exact Contabo
   `provider_region`, `gateway_url` `http://pgcf-gateway.pgcf-system.svc.cluster.local:8080/pg`,
   the Edge VPC binding name `gateway_binding`, `backup_bucket` and `backup_endpoint_url`. Write
   the returned agent key and route keyring directly to private custody; a replay never returns
   them again. Do not reuse the cancelled US region ID: its write-once profile and revision-1
   custody belong to the old cluster.
2. **Cloudflare prerequisites.** In the private deployment configuration, create the region's
   R2 bucket, bind it as `ARCHIVE_<NAME>` and add its `ARCHIVE_BINDINGS` entry; create a
   bucket-scoped R2 S3 write credential; create the regional Tunnel and the Edge VPC service
   binding named by `gateway_binding`. Keep `BOOTSTRAP_OPERATOR_SOURCES` at the current operator
   CIDRs, add the provider instance to `BOOTSTRAP_FIREWALL_BINDINGS` or let AddNode allocate an
   owned firewall, and add the region ID to `PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS` in the
   EU relay configuration. Deploy the changed Worker configuration between fleet patches and
   compare binding and secret names, never values.
3. **Installation profile.** `PUT /v1/regions/{id}/installation-profile` once with `version:1`,
   `region_id`, `provider_product_id`, `relay_issuer_region_id` set to the relay's issuer region,
   `dns`, `storage`, `rescue_client_private_key` and
   `first_region:{cluster_name,reviewed_commit,regional_image,platform}`. Its `platform` holds
   `version:1`, `region_id`, `api_host`, the issued `agent_key`, `route_keyring`, `tunnel_token`
   and `backup_s3`. The profile is write-once and its agent key must match the issued key.
4. **Release and templates.** Select the fleet's current approved release with
   `PUT /v1/regions/{id}/release`. Read `GET /v1/regions/{id}/capacity-policy`, then PUT the
   complete policy with a release-pinned `compute_pool` template, a `thin_storage` template
   byte-identical to the release's qualified profile and purchases off unless the owner approved
   a costed order. A non-null `compute_pool` also switches the region's pool runtime on. AddNode
   refuses before any provider order until these match a release with a thin qualification
   receipt, so no region can add a node without a receipt-bearing release.
5. **Control server.** `POST /v1/nodes/additions` with
   `{"region_id":"<region>","mode":"adopt","provider_instance_id":"<instance>"}` for an allocated
   VPS, or `mode:"order"` with the configured `order` and the owner's costed approval. The
   region's first live node becomes its Talos control plane, installs Cilium, Flux, the platform
   and regional services from `first_region`, and seals the region seed and join bundle. Its
   outside network proof scans from a Ready, uncancelled node of another Contabo region (EU1 for
   a non-EU region); the relay host never serves as source or target. Follow
   `GET /v1/nodes/additions/{operation-id}` and the read-only inspection and proof views above.
   Only admission releases the quarantine taint.
6. **Placement off.** When `GET /v1/nodes` lists the node with its UID, send
   `PUT /v1/nodes/{id}/database-placement` with `expected_node_uid` and
   `database_placement_enabled:false`. Create no database in the region before this; customer
   databases belong on its workers.
7. **Fleet role.** Assign `control_relay` through `PUT /v1/nodes/{id}/release`
   (`expected_revision`, `release_id`, `node_uid`, `role`) or as its member role in the next
   `POST /v1/fleet/rollouts`. When that role requires host configuration, the node also needs a
   release-pinned compute-pool policy with `target_slots:0`.
8. **Firewall and operator sources.** AddNode writes every member's provider firewall from
   `BOOTSTRAP_OPERATOR_SOURCES`, the relay addresses and the exact region peers; PostgreSQL stays
   closed. Each later addition rewrites all members' rules, so change operator access only through
   `BOOTSTRAP_OPERATOR_SOURCES`.
9. **Material rotation.** Replace cluster authority only through
   [staged custody](credentials.md#stage-and-activate-replacement-cluster-custody) and a fleet
   rollout's `staged_material_revision`.
10. **Acceptance and workers.** Run the ULTRA node acceptance checks, then add identical customer
    workers through AddNode; they join with the region's custody and take customer placement
    after admission.

Region registration must use `http://pgcf-gateway.pgcf-system.svc.cluster.local:8080/pg` with the
configured private VPC binding. Gateway WebSocket upgrade requires this path; a healthy Tunnel
and correct service binding alone are insufficient. Correct a wrong URL once with exact
configuration comparison before and after; no runtime or database reset is needed.

## Manual installation and recovery path

The following procedure is the manual path with explicit recovery inputs that installed the node
now retained as customer EU1 (then EU2). Its step 7 is also the manual network-proof path that an
EU addition needs while EU is the only region, because the programmed outside proof scans from a
Ready node of another Contabo region. Do not rerun EU1's adoption, rescue or installation. This
procedure remains the reference for separately authorized recovery; it does not authorize a loss
drill or removal of EU1.

1. Configure `/v1/regions/{id}/capacity-policy` with the explicit node maximum. A region lists
   existing provider instances in `adopt_instance_ids` or orders only its configured approved
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
   Workers use the region's retained join bundle and do not install a second platform.
5. Let the Workflow verify exact owned firewall rules, assignment and current readback before
   requesting the provider's RAM rescue. RAM rescue supplies the retained host key and route
   configuration so authenticated rescue access and actual network measurements can be collected.
   Full fresh signed outside-allowlist scans and relay access controls remain required before
   native installation starts. Direct Container start, authority callbacks, transport grants and
   destructive checkpoints enforce that separate verified preparation. The node stays quarantined.
   Native checkpoints record an intent before disk writes or platform mutations; resume reads exact
   owned state and does not blindly reinstall.
6. For a region's first node, the native flow installs Cilium, Flux, the five platform releases
   and regional services, and verifies the LVM/CSI registration. Retain the issued regional
   identity on retries.
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
full preparation scans whenever the original proof ages. Resume with the same sealed input,
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

For acceptance of a future authorized node, complete installation and admission, then restore a
test database from R2 into a separate target in that node's region while keeping the source
healthy. Compare SQL data and committed markers, verify target backup/WAL and retain the source
Node, volume, role and encrypted custody identities.
Earlier loss, deletion and decommissioning kits are withheld; any later loss drill needs a
separately reviewed scope that preserves or recovers the same customer EU1. Keep unchanged prior
proofs and record new measured results in the ULTRA plan. The ordinary wake of a fully hibernated
database is the fallback baseline. The ULTRA scope additionally requires a measured first SQL
below one second for a woken parked database; its acceptance remains open in the go-live path.
Do not move production databases onto PGCF or call the product finished until the open ULTRA
steps, including recovery, have passed.
Record measured installation/rollout time and actual Contabo calls by lifecycle phase, including
zero calls throughout repeated transport grants, Kubernetes/Talos reads and proof cleanup after
source selection. Local tests, a configured image or provider Running do not establish this live
acceptance. Use the normal Cloudflare SQL endpoint to verify actual placement, roles/TLS, committed
markers, R2 base backup/WAL and deletion through confirmed physical storage reclamation.

## Customer migration handover

Moving an integrator's existing databases into PGCF is the integrator's task and a separate
reviewed cutover. Preserve EU1 and its existing data. Neither version alignment nor template
selection authorizes an EU reinstall or a customer cutover.

Inventory source region, roles/grants/extensions, sequences, pools, timeouts and sizing. Resource
classes are configured through the management API in 256 MiB PostgreSQL increments, with an
operator maximum of 4 GiB. A limit is not a permanent physical reservation. Actual-RAM placement,
sleeping CPU release and thin physical storage must be measured together with hard startup and
backup-peak admission; the density test in the ULTRA plan records the result. Customer placement
excludes the control/relay host. RAM overbooking does not remove CPU, storage or startup checks:
approve sufficient regional capacity before committing an integrator's databases to a region.

### Connection and cold starts

PGCF’s public transport is verified WSS; a TCP DSN hostname swap is insufficient. Use the
established Neon serverless `Pool`/`Client` WebSocket mode with `pipelineConnect=false` and a
`wsProxy` URL containing `/v2?database=<URL-encoded-PGCF-ID>&user=<URL-encoded-role>`; see
[the connection contract](../../README.md). Keep PostgreSQL authentication and TLS. Hints scope
admission; they are not credentials.

For psql and logical export/import tools, use the existing CLI:

```sh
node packages/cli/dist/main.js connect --endpoint wss://db.example.com --database <pgcf-id> --user <role>
```

Use the printed loopback port, target PGCF ID and role. `sslmode=disable` applies only to
loopback; public WSS and gateway-to-PostgreSQL TLS remain verified. Keep passwords private;
never expose a VPS database port.

A hibernated database wakes in 8.1–9.4 s through Cloudflare (the ULTRA plan's wake-path
measurement, standard runtime). A client connect timeout shorter than the wake can fail before the
database is awake. Query and statement timeouts are separate from the end-to-end request deadline;
budget wake plus work explicitly. The parked sleep tier (region policy `parked_tier`) is the path to
a first SQL below one second and must pass its own acceptance (go-live path: sub-second wake) before
customer readiness; a database demoted to full hibernation always takes the ordinary wake. Before
cutover, verify one fallback policy: an approved always-warm size class
(`sleep_after_seconds:null`); prewake with `POST /v1/databases/{id}/resume`, operation/readiness
polling and `SELECT 1` immediately before traffic; or bounded connection/request deadlines
covering measured wake plus query/network margin. SQL statement timeouts are separate and do
not fix shorter connection timeouts. Never retry uncertain writes. These are Dev measurements,
not accepted application latency.

### Create, restore and rebind

Use the authorized project-scoped integrator key, persistent mutation `Idempotency-Key`s and
existing API contracts:

- `POST /v1/databases` with `{project_id,region_id,name,size_class_id}`; save the new database and
  operation IDs. Poll `GET /v1/operations/{id}` and `GET /v1/databases/{id}`.
- `POST /v1/databases/{id}/roles` with `{"name":"<role>"}`; await role readback, then obtain
  `GET /v1/databases/{id}/roles/{role}/connection-uri`. Only integrator responses include the
  password; save them privately. Administrator responses cannot supply an application password.
  The body may also carry `valid_until`, `connection_limit`, `member_of` and `bypass_rls`.
  `DELETE /v1/databases/{id}/roles/{role}` makes a role unroutable at once and returns an
  operation that ends when PostgreSQL has dropped it; both need an `Idempotency-Key` and are
  described in the [integrator handover](integrator-handover.md#23-roles-connection-uri-and-passwords).
  Release the regional controller that understands role attributes and removals before the API
  that accepts them: an older controller refuses a desired record that carries either, and only
  such databases are affected.
- PGCF archive restore: `POST /v1/databases/{source-id}/restore` with
  `{"mode":"full","name":"recovered","region_id":"<region>"}` or PITR with `target_time`.
  It returns a **new database ID** and separate storage. Reuse the same key after an uncertain
  submission; follow [recovery](recovery.md). This API restores PGCF archives, not a dump from
  another provider.

An import from another provider is the integrator's task: it freezes writes and uses a consistent
logical export/import through the normal CLI, with reviewed owners, grants, extensions and
sequences. For either import or restore, the integrator rebinds its own provider/database mapping
to the new target ID/region, updates protected role credentials/password revision and its
versioned registration, drains old connections and creates a fresh authorized pool. PGCF requires
current database/role registration; stale or unregistered hints must fail. Acceptance of the
integrator's own adapter and registration is therefore a cutover prerequisite: use supported
scoped operations; do not bypass checks or edit tables to make a DSN swap work.

Compare data/checksums, roles/grants, sequences and committed markers. Verify actual Cloudflare
TLS/region, target backup/WAL, application transactions and selected timeout/pool behavior.
Rehearse restore into another new ID and repeat rebinding. Once target writes begin, returning
to the stale source requires reconciliation. Delete trials through `DELETE /v1/databases/{id}` and
confirm operation completion plus physical reclamation; R2 archive retention is separate.


## Synchronize version templates after an accepted Kubernetes upgrade

Fleet rollouts ([fleet patches](fleet-patches.md)) upgrade Talos and Kubernetes in place and
synchronize this version metadata themselves once every member has converged. Use the endpoint
below only after an upgrade performed outside a rollout. It does not implement an
OS/Kubernetes upgrade or credential rotation. Qualify the complete release and affected
database checks before maintenance.

Use the supported Talos Kubernetes upgrade with a reviewed dry run; never reinstall the EU
nodes to align patch versions. Verify the actual API-server and every kubelet version while
preserving Node/Cluster UID, storage, roles, Secrets and certificate/key identities. Record
actual post-upgrade configuration; never reapply old machine documents that would downgrade
the components.

Administrators can read `GET /v1/regions/{id}/bootstrap-material` and use
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
