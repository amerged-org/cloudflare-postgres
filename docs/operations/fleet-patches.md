# Retained-node fleet patches

These per-node endpoints are existing building blocks. The one-request fleet coordinator is
implemented; its live acceptance remains open in the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md#open).
Manual orchestration of these endpoints does not establish automatic fleet acceptance.

The management API provides an assignment-bound `PatchNode` Workflow and a separate Native
container identity. A terminal admitted AddNode job stays terminal. Patches use authenticated
Talos/Kubernetes transport without Contabo, Rescue, disk reinstallation or SSH.

## Start, inspect and resume

When migrating an older strict-contract controller, install its compatible qualified TypeScript
bridge before selecting a fleet release or enabling pool/thin policy. Until then, leave those
optional settings unset. Create the owned thick-volume canary before release activation so the
gateway-first patch can bind its retained storage and prove real SQL before controller replacement.

1. Qualify immutable artifacts through the single CI and approve their release through
   `PUT /v1/fleet/releases/{id}`. Select the release for the region and assign it to every current
   member with the existing region/node release APIs. The reviewed `platform_source_commit` pins
   the fixed public lock, Flux artifact and platform manifests; the lock never embeds its own Git
   commit. Declare cluster-scoped platform workloads explicitly. PostgreSQL, Barman and the sandbox
   controller artifact are globally qualified; actual database runtimes and host extensions are
   proved separately. The pinned cert-manager startup API check is an installation hook, so its
   owning chart must be Ready at the exact qualified revision; a deleted hook Job is not a
   permanent per-node Pod requirement.
2. If the role requires the sandbox extension, assign its compatible compute-pool policy. The
   patch seals the two fixed0600 host files in current Cloudflare custody before OS activation.
   The two managed paths under `/var` use Talos `op:create`, which creates missing files and
   updates existing contents. `overwrite` requires a preexisting file and can pause boot before
   etcd/trustd start. No private machine configuration or agent key belongs in the image or a ConfigMap.
3. Start one canary using `POST /v1/nodes/{id}/patches`, an administrator key and
   `Idempotency-Key`. Supply current `node_uid`, `assignment_revision`, `release_id`, approved
   IPv4 `address` and `maintenance_acknowledged:true`.
4. Poll `GET /v1/fleet/patches/{operation_id}`. Public responses contain progress/identities,
   never kubeconfigs, Talos configurations, callback credentials or host-file contents.
5. Resume an interrupted operation with `POST /v1/fleet/patches/{operation_id}/resume`.
   This renews the bounded one-hour deadline while retaining every dispatch outcome. Do not
   create another operation to bypass uncertainty.

One active patch owns regional maintenance. New placement is closed on the current regional
members; existing exclusions remain. Existing databases retain data and may experience visible
maintenance downtime in this single-node topology. Completion restores only operation-owned
closures with unchanged physical identities only after every member finishes its final pass.
An operator closure change blocks authority. This
maintenance rule is separate from continued placement while a76% capacity expansion is prepared.

## Programmed stages and readbacks

The operation runs preflight, protected host configuration/service consumption, supported Kubernetes orchestration,
fixed Kubernetes image configuration, Talos install/reboot, intermediate runtime verification,
Flux, platform charts, regional services, runtime admission, node-scoped PostgreSQL generation/image
convergence and final release verification. Pinning Kubernetes before the common OS reboot avoids
a redundant reboot. On an already common OS, changed Kubernetes pins use the same fenced reboot.

In a multi-node region, the first members finish at immutable `host_ready`, which is intermediate
and keeps product release status Pending. Existing operation-owned placement closures remain.
Only after every current physical member has the selected host/profile receipt, the same current
boot and fresh compatible pool observations may the last member activate the shared RuntimeClass
and CNPG admission policy. That member checks only its assigned databases. Its completion starts
one distinct, idempotently selected finalization operation for each earlier host-ready member.
Each final pass reloads current sealed custody, revalidates identities/profile, checks shared
admission and its own database runtime, then completes without another OS installation. The
original host-ready operation is never reopened. Only all-member final acceptance restores owned
placement closures and synchronizes version metadata. A future owned profile update uses UID and
exact previous owned fields; unrelated scheduling and controller status are preserved.

Talos is upgraded through the official no-reboot lifecycle command using the exact qualified
installer digest. Positive CLI completion is persisted before a separately fenced reboot.
An unknown install resolves only from the pinned vendor's authenticated `machined` lifecycle
records with the exact image and zero exit code. Records are console-framed with scoped JSON
fields; absent records never prove success. The current boot, DMI, Node/Cluster identities,
version and schematic remain fresh requirements. Installer digest provenance is explicitly a
**deployment receipt**, not a raw-memory hash or TPM attestation. A prior completed receipt can
be rebound only when the same physical boot, version, schematic and exact installer are freshly
proved; unchanged OS bytes then need no redundant upgrade/reboot. Loaded extension metadata is
checked against that qualified receipt and recipe, never inferred from desired configuration alone.

Kubernetes uses the supported cluster upgrade on the sealed control-plane endpoint. API and every
bound member's kubelet must report the target with healthy nodes/databases. The supported range is
non-decreasing patch versions within the same major/minor; a different compatibility transition
needs an implemented supported procedure. Exact configured image references are checked in the
vendor's active and persistent machine resources. Kubelet provenance is explicitly
`pinned_configuration_boot`: the qualified configuration preceded the current boot, the vendor
projects that image and the service/Node version is fresh. It is not a raw kubelet container hash.
Static control-plane images additionally require actual owned mirror-Pod imageIDs.

Flux's active controller composition comes from `lock.flux.components`. Shared pinned vendor
CRDs/RBAC remain. Removal of accidental optional controllers requires their original admitted
bootstrap owner, baseline UID and exact verified vendor spec. Conditional UID/resource-version
DeleteOptions and fresh reads resolve outcomes; a replacement resource is never deleted.
An upgrade may introduce a fixed vendor resource absent from the retained cluster. Only a real
NotFound observation permits its fixed-name creation from the qualified artifact. The operation
records the returned/read-back UID before another creation; lost replies are resolved against
the same operation-owned spec. A denied or failed read never means absence, and a recorded UID
may not disappear or change.

Flux/Helm acceptance uses current Ready conditions and immutable source/applied revisions. Chart
versions allow the vendor's OCI build suffix, while current Helm history must carry the full
selected OCI digest. Pod specs and running imageIDs prove selected architecture manifests.
Declarative updates compare the bound UID and exact previous desired fields; unrelated controller
status/resource-version changes do not invalidate a configuration CAS. The selected OpenEBS wrapper and cgroup mount override are applied through the existing platform
Kustomization while preserving unrelated values. The reviewed source chooses
separate `native-controller` and `native-gateway` images when present, with `regional` only as the
legacy composition. Do not activate unqualified Rust binaries by changing an image label.

The approved release's `openebs-lvm` image selects the qualified wrapper independently of its
build-source lock. Pin its tag and digest; if the role also lists `image/openebs/lvm-driver`,
supersede that stock alias with the same wrapper reference/digest/version. Retaining the stock
digest would demand both old and new runtime images and prevent convergence. Preserve the hash
of the actual public source lock; never substitute a privately modified lock under that hash.

The native gateway's retained thick exemption comes only from the current CF-owned cohort.
Native checks its physical Node assignment, archive generation, Namespace/CNPG/ledger/power-anchor
UIDs and bound PV/PVC/LVM identity before publishing the exact immutable Deployment environment.
The initial observation owns the binding; replacements stop the patch. Unlisted databases require
a CF-signed thin write lease. Public signing keys and their canonical hash are literal high-trust
Deployment inputs, never keys supplied by an agent ledger or mutable `substituteFrom` ConfigMap.
A loaded sandbox extension also needs a running vendor service; this is separate from the real
CF policy/NodeUID-bound slot observations required for pool readiness.

The existing PostgreSQL desired-generation path applies the selected immutable image with
same-major/schema checks. Assigned databases are scoped to the current physical patch node; queued
unassigned pins remain regional. Assigned Ready databases need the actual primary Pod imageID.
Confirmed cold databases remain cold and report deferred application until their admitted wake;
queued databases inherit the pin without a fabricated running Pod. Bounded turns do not finish
while any queued pin remains pending. Final runtime facts and image provenance are stored in CF.
Only when every regional member has current qualified release observations does the existing
seed/join synchronizer copy unchanged private material into a new revision with observed Talos and
Kubernetes version metadata. Metadata synchronization never counts as an OS upgrade and is
idempotent when the observed target versions are already current. Because protected sandbox
settings bind the material revision, an actual revision advance starts one current-custody
host-config-only final pass for each affected member. This path cannot enter an OS or Kubernetes
write stage. It applies the fixed files without reboot. The protected host watcher consumes only the supported
material-only change in the same process while retaining storage deadlines and writer fences.
The read-only host-service stage waits for fresh current-revision/profile pool observations; it
never restarts a controller around active thin writers.
A confirmed configuration waiting for a kernel module never triggers another identical apply.
Final Ready and operation-owned placement reopening wait for every current-material host/pool and
selected storage qualification. The previous completed operations remain immutable.
Roles without protected host settings use a distinct current-custody runtime/database final pass
after a material revision changes. It cannot enter OS or Kubernetes write stages; placement stays
closed until that pass completes with fresh identities and release observations.

## Identity, interruption and remaining acceptance

Authority binds the selected immutable release, assignment revision, Node/Cluster UID, current
sealed material, optional host-file revision/hash and exact regional member set. Routine grants
and checks make no provider calls. Identity, permission, expiry or desired-state changes stop the
operation. The persisted dispatch is acknowledged before an OS/configuration command. A lost CF
checkpoint reply is resolved by exact status readback in the same execution. If that same execution
proves the command was never attempted, it may record that finite outcome; a resumed uncertain
write cannot infer it from an unchanged boot/version or missing response.

Before delivery, run the same read-only parsers against the actual retained fleet and collect all
deviations together. Deliver the API/Native changes with `PATCH_NODE` configured, then prove the
canary and interruption/recovery through this path. Record actual elapsed time, provider calls,
versions and release digests in the ULTRA plan. SQL/TLS/roles, R2 base/WAL backup, restore and
physical deletion acceptance remain live gates. A source/unit-test pass is not live acceptance.

Cloudflare policy configuration, the administrator candidate catalog and bounded official-feed
discovery are implemented in source. No configured policy means no work. Current candidates
honestly remain `awaiting_ci` with `qualification_channel_unavailable`; discovery cannot execute
patches or fabricate CI/canary receipts. The automatic discovery-to-CI qualification channel, security-alert integration and complete
Dev fleet acceptance remain open. Use the canonical ULTRA acceptance scope; long soak series
are not a prerequisite. Scoped route retirement is verified; prepared EU authority follows
the selected supported patch window. These source APIs are not automatic patch completion. Advance regions only after the
canary's required gates pass, including an actual thin-database material-revision transition.

## One-request fleet convergence

After approving the immutable release, send `POST /v1/fleet/rollouts` with an administrator
credential and an `Idempotency-Key`. The request contains `release_id`,
`maintenance_acknowledged: true`, and an ordered `regions` array. Each region specifies
`region_id`, the current release-assignment `expected_revision`, `cluster_uid`, current
`material_revision`, and every live physical member in the desired maintenance order.
Each member specifies `node_id`, `node_uid`, current node-assignment `expected_revision`,
`role`, and its management IPv4 `address`. Read revisions from the existing region/node
release endpoints; a missing assignment has revision zero. Select US first, then the EU
customer member before the EU control/relay member. Required Kubernetes control-plane
updates remain part of the existing PatchNode dependency handling.

For a release that requires protected host configuration, each member must already have
its release-pinned compute policy, or include `compute_pool: { expected_revision, policy }`
in this request. The policy uses the existing compute-pool schema and exact approved
sandbox-controller image. Assignment and policy selection commit atomically; PatchNode
creates protected host files from current encrypted custody. A prepared authority
replacement is selected with the region's `staged_material_revision` (current + 1).
Staging alone does not authorize live key activation: the fleet waits for the programmed
rotation and its verified custody handoff.

The response is `202` with `rollout_id`, member release observations and existing patch
states. Read `GET /v1/fleet/rollouts/{rollout_id}` for progress. Region desired assignments
hold this ordering metadata; `fleet_patch_operations` remains the sole mutation journal.
Terminal PatchNode turns and the existing Cron continue untouched hosts and later regions.
The next region waits for predecessor convergence and regional finalization. A current
component is skipped; an interrupted patch resumes its original operation and dispatch
state. A halted write or changed Node/Cluster UID remains blocked. Repeating the original
request with the same idempotency key reads and resumes its committed intent rather than
creating another patch. This endpoint does not purchase a server or reinstall a node.

Example with a reviewed JSON request saved locally:

```sh
curl --fail-with-body --request POST "$PGCF_API_URL/v1/fleet/rollouts" \
  --header "Authorization: Bearer $PGCF_ADMIN_KEY" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: $PGCF_ROLLOUT_KEY" \
  --data-binary @fleet-rollout.json
```

The API's `complete` state proves current software convergence. Customer readiness also
requires the six live node checks in the ULTRA plan; an assignment or unit-test result does
not replace SQL, archive and physical deletion acceptance.
