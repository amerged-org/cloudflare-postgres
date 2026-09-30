# Regional environment controller

## Manual physical base backups

The optional base-backup lane consumes durable customer requests for existing
environments. It reuses the existing region executor token and configured CNPG/
Barman archive, creates one fixed owned Backup resource, and retains a
whitelisted operator-reported result in D1. It performs no SQL, archive deletion,
restore, quota change or wake operation.

Set `PGCF_MANUAL_BACKUPS_ENABLED=true` only after reviewing installation archive
configuration and qualification. The default is off; `false` is also explicit.
The existing token file/kubeconfig are reused and Backup `get/create` is the only
new RBAC. A queued API request remains pending while its executor is disabled.

The [contract](../../docs/contracts/manual-backups-v1.md) defines the durable
pre-dispatch checkpoint. Only its initial positive acknowledgement permits one
creation attempt; replay/reclaim observes the same resource and cannot recreate
a missing Backup. ObjectStore UID/generation/full spec stay bound across
status-only recovery-window updates. Unknown outcomes remain explicit.

`completed` means CNPG/Barman reported a base artifact. Remote preservation,
independent restore, PITR, retention and backup-byte accounting remain separate
qualification gates with false verification flags. Source delivery does not
activate the lane or resume previously held Barman/R2 work.

## Optional private native access

A new immutable catalog profile can opt into `nativeAccess: {version: 1,
clientProfileId: "private-application"}`. The trusted regional configuration
resolves that identifier to an operator-protected namespace and ServiceAccount
with observed UID bindings. The namespace must already carry its exact
`pgcf.io/native-client-uid` marker. The controller never creates or relabels the
client principal; customers cannot supply selectors or backend addresses.

The controller creates one owned TCP5432 ingress policy, observes CNPG's actual
direct RW Service/primary/EndpointSlice and validates its public server CA/leaf.
The existing fenced ready report supplies the private connection observation to
the management API. It transmits no password, private key or whole Secret.
See the [contract](../../docs/contracts/private-native-access-v1.md) before
configuring client profiles; logical ServiceAccount-name reuse remains a trusted
operator revocation boundary.

```json
{
  "nativeClientProfiles": [
    {
      "id": "private-application",
      "namespace": "private-applications",
      "namespaceUid": "11111111-1111-4111-8111-111111111111",
      "serviceAccount": "private-client",
      "serviceAccountUid": "22222222-2222-4222-8222-222222222222"
    }
  ]
}
```

These are illustrative identifiers; configure real identity readbacks privately.
Omitting both the catalog policy and this optional configuration preserves the
previous environment path. The source path requires read-only Pod/Service/
ServiceAccount/EndpointSlice access in addition to existing permissions. It
opens no public listener and creates no Service. Its `.svc` DNS name is private;
provisioning observations do not establish packet enforcement, SQL reachability,
Cloudflare connectivity or ongoing health. Qualification and public routing
remain required before customer admission.

When a final native reference comparison changes, the existing controller log
emits at most one `native_readback_deferred_<category>` event for that reconciliation.
The category is one fixed Namespace, Cluster, Service, primary, client, certificate,
routing or policy reference comparison; no IDs, resource versions, paths,
certificates or raw errors are logged. It identifies the first rejected comparison,
not its underlying cause. Earlier ordinary readiness deferrals are not classified.
The strict comparison, null/deferred result and owned retry behavior remain unchanged;
a failing diagnostic sink cannot turn a deferred observation into readiness.

The [remote archive workflow](../../docs/guides/control-archive-v1.md) stores and
retrieves an already sealed recovery bundle using existing operator access.
Verify exact downloaded bytes and matching historical migrations before offline
restore. This does not activate recovered state or replace independent key custody.

## Durable delivery failure status

`UsageJournal.status().lastDeliveryFailure` retains one bounded private diagnostic
for the current source and original pending fact. It stores fixed failure kind,
nullable HTTP status/known code and observation time; raw error bodies, headers
and credentials are excluded. The [diagnostic contract](../../docs/contracts/usage-delivery-diagnostics-v1.md)
defines the safe pairs, exact pending match, corruption refusal and atomic clear
only after exact durable receipt acceptance.

This status supplies no permission to skip, delete, reassign, invoice or activate
pending facts. HTTP 404/409 remains an authority/state diagnosis to resolve with
canonical control records and original provenance. Existing delivery cadence,
strict acceptance, visible coverage gaps and capacity limits remain unchanged.

## Complete usage-journal snapshot

The explicit `snapshot-usage` operator mode captures a full, source-bound SQLite
usage journal without acknowledging or rewriting pending facts. It preserves
outbox/checkpoints/gaps/retained-volume and accepted-receipt history, including
committed WAL state. The [custody contract](../../docs/contracts/usage-journal-snapshot-v1.md)
defines private paths, expected identity, size/deadline limits and inactive output.

```sh
node apps/regional-controller/dist/main.js snapshot-usage --config /absolute/private/snapshot.json
```

The version-one private config has `schemaVersion`, `sourcePath`, a fresh
`targetDirectory` and exact `expectedIdentity`. Verified output is `usage.sqlite`
plus a last-published `manifest.json`; the result reports digest/bytes/pending
count and `activationSupported: false`. It starts no controller lane or network
client. Off-node transfer, authority recovery and any replay remain separate
operator responsibilities; a snapshot alone never makes a rejected fact accepted.

## Fleet inspection

The explicit `inspect-fleet` mode observes Contabo through the installation's
control API and reads authenticated Kubernetes Nodes. It detects missing or
replaced enrolled machines before maintenance. Provider matches do not prove
machine identity, spare capacity, backup recovery or upgrade eligibility.
See the [contract](../../docs/contracts/fleet-inventory-v1.md).

Build this package, then run a mode-0600 configuration in a private directory:

```sh
pnpm --filter @cloudflare-postgres/regional-controller build
node apps/regional-controller/dist/main.js inspect-fleet --config /absolute/private/fleet.json
```

```json
{
  "schemaVersion": 1,
  "regionId": "11111111-1111-4111-8111-111111111111",
  "bindings": [
    {
      "instanceId": "12345",
      "nodeName": "operator-enrolled-node",
      "nodeUid": "22222222-2222-4222-8222-222222222222",
      "regionId": "11111111-1111-4111-8111-111111111111"
    }
  ],
  "controlOrigin": "https://your-control-api.example.com",
  "installationTokenFile": "/absolute/private/installation.token",
  "kubeconfigFile": "/absolute/private/kubeconfig",
  "kubeconfigContext": "operator-context",
  "reportPath": "/absolute/private/fleet-report.json"
}
```

Keep token and kubeconfig files mode 0600. Use a verified HTTPS Kubernetes
endpoint, embedded CA and static embedded certificate/key or token. Dynamic
authentication helpers and credential-file references are outside this lane.
Real provider IDs, addresses and enrollment records belong in private adopter
configuration. The installation token stays with the operator; it is never
installed into customer Pods or sent to Contabo.

Exit 0 means observed association; exit 1 means blockers; exit 2 means observation
could not complete. The private report retains selected provider/Node details;
stdout contains only counts, codes, a digest and false authority flags. Choose a
new report path each time: existing files are preserved.

To add this guard to a maintenance preparation, include the same complete object
as the optional `fleetInventory` property in its private operator configuration.
It can invalidate stale identity evidence but cannot supply missing identity,
quorum, backup, staging or capacity proof. Existing preparation behavior stays
unchanged when the field is absent; execution remains unauthorized.

## Control recovery artifacts

The explicit `recover-control` operator mode provides capture, encryption and
verified offline reconstruction. It starts no controller lane and activates no
recovered token, lease or allowance. Read the [contract](../../docs/contracts/control-recovery-v1.md)
before treating a rebuilt artifact as control-service recovery.

Build this package, then run one private configuration:

```sh
pnpm --filter @cloudflare-postgres/regional-controller build
node apps/regional-controller/dist/main.js recover-control --config /absolute/private/config.json
```

Create a mode-0700 operator directory. Keep every configuration, keyring, recovery
key and snapshot mode 0600. The recovery key file contains a separately generated
32-byte random key in unpadded base64url, with an optional newline. Keep it in
independent custody. Nothing is read automatically from the repository's `.env`.

`capture` supports an existing authenticated Wrangler installation or an explicit
Cloudflare D1 REST read token. The Wrangler configuration and zero-byte environment
file must also live in private directories. The snapshot contains operational
identities and encrypted credentials; store it privately and seal it before
transferring it to archive custody.

The legacy Wrangler configuration remains valid:

```json
{
  "schemaVersion": 1,
  "action": "capture",
  "wranglerExecutable": "/absolute/path/to/wrangler",
  "wranglerConfigFile": "/absolute/private/wrangler.jsonc",
  "emptyEnvFile": "/absolute/private/empty.env",
  "accountId": "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID",
  "databaseName": "DB",
  "migrationDirectory": "/absolute/checkout/apps/control-api/migrations",
  "source": {
    "installationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "databaseId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  },
  "snapshotPath": "/absolute/private/control.snapshot.json"
}
```

The source database UUID must match the selected Wrangler binding; assign and
retain an installation recovery UUID. A successful capture reports its digest
and table/row counts. The remote subprocess has a 60-second bound and bounded
output; its raw stdout/stderr never enters public command output.

For the D1 REST backend, create a dedicated API token with only the necessary
`D1 Read` permission and store the bare token, optionally followed by one newline,
in a mode-0600 file inside a mode-0700 operator directory. The token never goes
in the JSON configuration, command line, or repository. The endpoint is fixed to
Cloudflare's API; the account and database UUID come only from this configuration.
Keep `installationId` in the trusted operator inventory. REST capture performs one
read-only, generated SELECT with a 60-second timeout, a 16-MiB streamed response
limit, and no redirects. The D1 response must explicitly report
`meta.served_by_primary: true`; a missing flag or replica response fails capture.
This confirms the provider's routing assertion, not concurrent-write consistency
or a production recovery-point objective.

```json
{
  "schemaVersion": 1,
  "action": "capture",
  "backend": "cloudflare-rest",
  "tokenFile": "/absolute/private/d1-read.token",
  "accountId": "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID",
  "migrationDirectory": "/absolute/checkout/apps/control-api/migrations",
  "source": {
    "installationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "databaseId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  },
  "snapshotPath": "/absolute/private/control.snapshot.json"
}
```

`seal` verifies the snapshot against the current trusted migrations and verifies
every encrypted credential before publishing its bundle. `keyringsFile` contains
exactly two string values: `ROLE_CREDENTIAL_KEYS` and `ALLOWANCE_FENCE_KEYS`, each
containing the original JSON keyring including retained historical versions.
Worker Secret names do not supply the key values.

```json
{
  "schemaVersion": 1,
  "action": "seal",
  "snapshotFile": "/absolute/private/control.snapshot.json",
  "keyringsFile": "/absolute/private/credential-keyrings.json",
  "recoveryKeyFile": "/absolute/private/recovery.key",
  "archivePath": "/absolute/private/control.bundle",
  "migrationDirectory": "/absolute/checkout/apps/control-api/migrations"
}
```

`restore` authenticates the source and bundle, reconstructs the database, checks
integrity/foreign keys/exact state and decrypts every retained credential before
reserving a new output directory. The three verified files are `control.sqlite`,
`keyrings.json` and the last-published `manifest.json`. An incomplete directory
after a crash is unverified; subsequent commands refuse to overwrite it.

```json
{
  "schemaVersion": 1,
  "action": "restore",
  "archivePath": "/absolute/private/control.bundle",
  "recoveryKeyFile": "/absolute/private/recovery.key",
  "targetDirectory": "/absolute/private/recovered",
  "migrationDirectory": "/absolute/checkout/apps/control-api/migrations",
  "expectedSource": {
    "installationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "databaseId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  }
}
```

The result and manifest state `activationSupported: false`. No command imports
state into live D1, reissues credentials, grants execution, contacts customer
PostgreSQL or orders/changes Contabo servers. Production recovery still needs
global fencing, external-state reconciliation, complete credential custody and
independent off-node archive/key recovery. The existing runtime below is separate.

Apache-2.0 first-party code. This package implements the regional half of the versioned `environment.create` protocol and an optional file-backed usage collector. It initiates HTTPS requests to the adopter's control API; it opens no inbound listener. It creates internal CloudNativePG resources, reports observed readiness, and can deliver provisional observations of owned CPU/RAM requests and data-volume capacity. External PostgreSQL endpoint discovery, gateway routing, sleep, resizing, deletion, restore, and hard runtime budget enforcement remain pending. The default controller also executes the separate restricted login-role and credential-rotation protocol. A separate operator mode adds current allowance supervision and normal CNPG stop reconciliation; it is not enabled by the default controller.

## Owned logical database execution

The default controller adds a separate [owned-database execution lane](../../docs/contracts/owned-databases-v1.md) using the existing `roleVerifier` selection and mounted executor token. It creates only the fixed owned CNPG Database CRD, with a ready restricted same-environment owner and `ensure: present`, `template: template0`, connections enabled and reclaim Retain. It never creates another password or uses an administrative SQL connection.

An exact owned CR resolves a lost create response. If the deterministic resource is absent, complete bounded namespace Database inventory must exclude competing managers and a fresh verified-TLS owner connection to `app` must prove the selected SQL name absent. Existing unmanaged databases are conflicts. Do not repair collisions by changing an owner, dropping data or setting `ensure: absent`. Privileged operators are trusted coordinated writers; a preflight read cannot atomically exclude arbitrary concurrent superuser changes.

Current CNPG application/generation and the original Namespace/Cluster/role/Secret bindings must agree. A fresh connection to the selected database verifies its SQL owner, writable primary and restricted role attributes, then exercises a generated schema/table inside a transaction. Report success only after `ROLLBACK` is acknowledged and resource identities remain stable. Unknown TLS, inventory or SQL outcomes defer without releasing the owner-rotation lock. No persistent probe objects or uncertain committed customer writes are replayed.

The deployment example adds Database get/list/create authority to the trusted regional identity. The installation must still qualify admission, tenant networking, real ownership/migration behavior and native endpoint access. An empty queue or injected verifier fixture does not prove those operational capabilities.

## Database roles and password rotation

The [role lifecycle contract](../../docs/contracts/database-role-credentials-v1.md) supplies an independent regional role-operation lane beside environment reconciliation and metering. Before updating from earlier controller releases, add this installation-owned selection to `PGCF_REGIONAL_CONFIG_FILE` and mount `PGCF_REGION_TOKEN_FILE`; both are required before any controller task starts:

```json
{
  "roleVerifier": {
    "verifierNamespace": "pgcf-system",
    "verifierPodLabels": {
      "app.kubernetes.io/name": "pgcf-regional-controller"
    }
  }
}
```

The reserved `io.kubernetes.pod.namespace` key is refused in `verifierPodLabels`;
`verifierNamespace` fixes the source namespace separately. Invalid selection stops
before Kubernetes, credential or policy access, including database execution.

Merge this field into the existing configuration rather than replacing its operator and backup settings. Select labels identifying the actual trusted verifier Pods in your installation. The [deployment example](deploy/example.yaml) includes this selection, DatabaseRole get/create/patch permissions and trusted operator Secret reads. The role client reloads the mounted executor token per request. Kubernetes RBAC cannot limit resource creation by name; admission and the trusted controller identity remain installation boundaries.

Only current leased work for a ready API-managed environment is eligible. The controller derives the namespace, CNPG RW service and role resource names; it refuses foreign ownership and a newer observed credential revision before writes. It creates immutable basic-auth Secrets per credential revision and a stable restricted CNPG DatabaseRole. Lost responses reconcile through matching readback and UID/resource-version guarded rotation. It creates no arbitrary SQL, superuser or caller-selected role memberships.

Success requires CNPG applied/current generation/exact password-Secret version, then fresh password-authenticated TLS login to the derived internal RW service, expected user/database, writable primary and restricted PostgreSQL role attributes. The CA adapter returns only the public `ca.crt` field. Rotation additionally requires the previous password to fail on a separate new connection specifically with SQLSTATE `28P01`. Timeouts, TLS failures and unknown outcomes defer; they do not establish password invalidation or reveal a credential. Identity/version readback surrounds the connection check.

[The maintained driver dependencies](THIRD_PARTY.md) are pinned and retain their licenses. This lifecycle does not automatically grant table permissions/ownership, terminate existing sessions, expose a public endpoint, enable closed regional admission or qualify backups/recovery. Real CNPG application, key recovery, image/runtime, networking and end-to-end pilot verification remain separate evidence.

## Accepted usage evidence and archival

The [accepted-usage contract](../../docs/contracts/accepted-usage-ledger-v1.md) retains strict control-plane receipts before the normal sender deletes an outbox record. Exact receipt replay is idempotent; malformed ownership/time/sequence or conflicting metadata leaves pending data intact. The bounded receipt ledger reports retained local history, including unknown legacy history, rather than finalized consumption. `provisional` and `gap` meanings remain unchanged.

Use [accepted-usage-archive.example.json](deploy/accepted-usage-archive.example.json) for an explicit operator archive batch. The actual configuration, journal and archive directory must be private. Supply the existing sealed meter identity and an absolute unique destination, then run:

```sh
node apps/regional-controller/dist/main.js archive-accepted-usage --config /private/installation/archive.json
```

The mode needs no Cloudflare/provider credential or Kubernetes connection. It publishes and verifies a bounded private full-receipt bundle before retiring exactly that batch transactionally. Conflicting/tampered paths fail; a publication-before-retirement crash recovers through the same verified file. Ledger pressure defers acknowledgement without dropping its outbox record. Archives need separately qualified off-node custody; local fsync and checksums do not establish node-loss recovery, final facts or settled budgets.

## Execution identity and stale writers

The [execution-fencing contract](../../docs/contracts/execution-fencing-v1.md) binds updated writers to the explicit epoch produced by an opted-in new profile. Required Namespace/Cluster/quota/Pooler annotations must all match; an old binding rejects any annotated resource, and a mixed transition remains closed. Stop patches test epoch alongside UID/resourceVersion, with fresh adapter checks before dispatch. Allowance and suspend journals never adopt another run from live metadata.

For a fenced allowance supervisor, add its independently verified `runEpoch` to the private runtime binding before first journal creation. A different epoch requires separately qualified authority and journal handoff; do not reset an old journal. The existing examples remain legacy/unfenced. No resume or epoch-advance writer is enabled, and older binaries with privileged Kubernetes access must be excluded operationally.

## Explicit suspend executor

The [environment suspend contract](../../docs/contracts/environment-suspend-v1.md) connects a persisted customer compute-stop intention to a separately supervised executor. It claims only `environment.suspend` work, keeps ordinary operation leases fresh, seals workload/retained-volume identities in a private operation journal before effects and reuses the same owned normal-stop primitive as allowance supervision.

This executor requires explicit installation configuration and patch authority; the default controller does not activate it.

Fill [suspend-config.example.json](deploy/suspend-config.example.json), make the real configuration owner-readable only, and supply `PGCF_CONTROL_ORIGIN`, `PGCF_REGION_ID` and `PGCF_REGION_TOKEN_FILE`. Run the built entry point:

```sh
node apps/regional-controller/dist/main.js run-suspend --config /private/installation/suspend.json
```

Each invocation claims at most one task and is bounded to five minutes. No work exits cleanly; uncertain/incomplete work keeps its journal for a later supervised invocation after lease reclaim. The selected Kubernetes identity needs complete named-namespace resource reads and narrowly authorized quota/Cluster/Pooler patches. It needs no Secret listing or new provider access. The default deployment example deliberately adds no patch grant for this mode.
It never creates a replacement database, adopts a changed UID, deletes retained storage, settles a receipt or wakes compute. Unknown state remains reclaimable. Provisioning status remains distinct from runtime state; observe the API's runtime resource to recover its desired revision and accepted regional completion. Funded resume, automatic idleness/wake, independent expiry and final accounting remain open.

The current executor establishes only Kubernetes stop convergence. It returns `physical_verification_pending`, retains its operation/volume seal and exits deferred with a nonzero code instead of publishing `suspended` or `computeAbsent: true`. Historical completion records remain unchanged but are not current physical proof. A qualified node-backed verifier remains required.

## Optional managed session pooling

The [managed-pooling contract](../../docs/contracts/managed-pooling-v1.md) enables a fixed `database-pool-rw` Pooler only for a newly accepted immutable profile. Composite namespace quotas reserve database maintenance separately, then add the Pooler main/init resource envelope without adding persistent storage. CNPG owns the actual pooler workload and certificate lifecycle; creation derives extra Cluster SANs and requires TLS on both sections. A complete owned Deployment/ReplicaSet/Pod chain is required for provisioning readiness. No native listener or customer endpoint is exposed by this controller.

The manual [pooling checkpoint](../../docs/evidence/m2-native-pooling-2026-09-29.md) has positive SQL evidence under a different, independent frontend-CA recipe. Automatic first-create SAN issuance, API-managed Pooler SQL, tenant network paths, updates and load limits still require live qualification. Both recipes reuse CNPG/PgBouncer without a fork.

## Current allowance supervision and normal stop

The separate [runtime allowance protocol](../../docs/contracts/runtime-allowance-authority-v1.md) acquires a durable reservation, refreshes its current control-plane authority and reconciles an owned normal stop. It is an explicit operator mode, not automatic `environment.create` admission or an independent workload-local budget guard. `runtimeEnforced` stays false.

Fill [allowance-config.example.json](deploy/allowance-config.example.json) with the API environment's project/region/spec identity and independently observed Namespace, Cluster and ResourceQuota UIDs. Select an explicit kubeconfig context. Replace the zero unit placeholders with reviewed resource-time allocations; at least one dimension must be positive. Keep the journal in an owner-private persistent directory. Set `PGCF_CONTROL_ORIGIN` and `PGCF_REGION_TOKEN_FILE` to the existing executor credential, then run the built package under an operator-owned process supervisor:

```sh
node apps/regional-controller/dist/main.js supervise-allowance \
  --config /private/installation/allowance.json
```

The default loop polls every five seconds, with bounded inventory and transport deadlines. `--once` performs one reconciliation and exits; it is an operator observation mode and does not supervise future expiry. SIGINT/SIGTERM ends the loop. Neither process exit nor a Kubernetes outage independently stops PostgreSQL.

Before contacting the reservation API, the private SQLite journal persists one request ID and exact units. Lost responses and restarts reuse that identity; historical receipt replay never extends its original deadline. Current authority is cached for at most 15 seconds and must match the sealed project/environment/spec and policy epochs. All limited CPU/RAM/storage dimensions participate in the funded horizon; omitted units are zero. A fully reserved account may have zero remaining balance while its existing reservation remains valid.

Loss of authority first sets the owned namespace's Pod quota to zero, then requests CNPG hibernation with UID/resource-version conditional patches. Matching readback resolves a lost patch response. For pooled environments, use [allowance-pooled-config.example.json](deploy/allowance-pooled-config.example.json) and independently bind the Pooler and Deployment UIDs. CNPG hibernation does not stop its Pooler: the supervisor also conditionally scales that exact Pooler to zero. Current zero-replica Deployment convergence, namespace Pod absence and unchanged bound Retain volumes remain Kubernetes observations. Even when these converge, the supervisor reports `stopping` with `physical_verification_pending` and records no completed stop or physical timestamp. Unknown inventory or failed patches produce no success claim. This mode does not automatically resume, release reservations, invent final usage or settle the receipt; storage allocation can continue after compute stops.

The selected Kubernetes identity needs inventory reads for the sealed namespace/Cluster/quota/Pods/PVCs/PVs and patch rights for the owned `database-resources` quota and `database` Cluster. Pooled supervision additionally reads namespaced Poolers/Deployments and patches only the bound `database-pool-rw` replicas; unbound or foreign workloads are never adopted. Do not give this mode customer or unrestricted operator credentials. Namespace/UID/spec checks remain necessary alongside RBAC. Runtime counters, ingress closure, transaction draining, workload-local expiry, overshoot bounds and real installation qualification remain pending.

## Installation maintenance preparation

The separate [maintenance preparation protocol](../../docs/contracts/maintenance-preparation-v1.md) records an installation-owned Kubernetes upgrade assessment. It does not execute maintenance. Issue a dedicated regional preparer token through the installation API, keep it in a private token file, and fill the identity, selected context and endpoints in [maintenance-config.example.json](deploy/maintenance-config.example.json). Missing recovery, quorum, staging or capacity proof remains a blocker; do not replace absent evidence with successful-looking defaults.

After building this package, set `PGCF_CONTROL_ORIGIN`, `PGCF_REGION_ID` and `PGCF_MAINTENANCE_TOKEN_FILE`, then run:

```sh
node apps/regional-controller/dist/main.js prepare-maintenance \
  --config /private/installation/maintenance.json
```

This mode is selected before normal environment reconciliation and metering. It claims one preparation, reads complete authenticated inventory, checks fresh plan-bound external evidence and reports an assessment under its lease. Pending Jobs are observed on a later claim; the deterministic operation name prevents duplicate creation after a lost response. The SDK path reads no Secret data, patches no Node and deletes no resource. A prerequisite failure creates no Job. Eligible prerequisites permit only the fixed Talos dry-run Job, which requires the existing operator ServiceAccount `pgcf-maintenance-preparer` and a named Secret containing `talosconfig`; neither is created through a customer API.

The operator configuration accepts `evidence.machineIdentity`, `etcd`, `recovery`, `staging`, `capacity` and per-database `switchover`/`volumes` proofs. Ordinary proofs contain `status`, `planHash`, epoch-millisecond `observedAt`/`expiresAt` and `evidenceHash`. Etcd adds explicit member/Node identities and health; capacity adds `scope: sequential-plan`, reservation UUID and reserved Node UIDs. Supplying a JSON certificate is not independent evidence qualification: the installation must obtain and verify the underlying observations and recovery/staging/reservation artifacts. Complete upgrade, rollback and HA qualification remain open.

Exit 0 means no queued work, a pending Job or an eligible assessment; exit 1 means a persisted blocked assessment; exit 2 means deferred/uncertain processing. Inspect the JSON status and durable API resource. Every result keeps `executionSupported: false` and `executionAuthorized: false`.

## Read-only platform inspection

Build this package and use an explicitly selected operator kubeconfig/context and reviewed version lock:

```sh
pnpm --filter @cloudflare-postgres/regional-controller build
node apps/regional-controller/dist/main.js inspect-platform \
  --kubeconfig /private/installation/kubeconfig \
  --context REPLACE_WITH_CONTEXT \
  --versions-lock infra/platform/versions.lock.json \
  --expected-source-commit REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT
```

`--namespace` defaults to `flux-system`; `--sync-name` defaults to `pgcf-platform`. The command does not require regional API tokens, controller configuration or a metering journal. It selects this mode before controller/meter startup and performs only Nodes and Flux resource reads through the existing official Kubernetes client. The optional [observer RBAC example](deploy/platform-observer.example.yaml) has no Secret or mutation privileges and is not installed automatically; review its namespace and named sync resources for your installation.

One JSON report uses `scope: platform_components` and normalized statuses. Exit **0** means the reported Node conditions/versions, deployed release history, current-generation Flux conditions, configured/fetched source pins and Git/Kustomization commit linkage match this lock. Exit **1** means a reported discrepancy or incomplete/suspended component. Exit **2** means the observation/configuration could not be completed; the error code is generic and does not echo API bodies, credentials, addresses, paths or raw condition messages.

Ready Flux observations require both top-level and Ready-condition generation equality, with suspension/deletion/stalled/reconciling states handled separately. OCI checking uses the manifest digest in the configured reference, fetched artifact revision and HelmRelease attempt linked to current Ready/deployed history; the cached artifact digest is not the manifest identity. OpenEBS's HTTP source remains a repository/version observation, not historical archive-checksum enforcement. Pinned bare digest/commit revisions and tagged/branch revisions are supported.

Lists reuse the collector's existing bounded pagination, stable resourceVersion and duplicate/continuation checks: at most ten pages per list, 32 total requests, 4096 resources and a 30-second observation budget, with a maximum 20-second request deadline. An incomplete or rejected observation cannot become a healthy empty inventory. The output contains aggregate Node counts and allowlisted component names/booleans, not live Node identities, addresses, arbitrary URLs or opaque error/version strings.

This is a point observation, not a maintenance authorization or a transaction across Kubernetes lists. SQL, backup/restore, replication, etcd, spare capacity, tenant isolation, image signatures/runtime images, effective values, Flux binary identity and fresh Node heartbeat/reachability remain explicitly unverified. Prometheus/Alertmanager/OpenTelemetry, lifecycle maintenance and operational recovery qualification remain required work in PLAN.md.

## Funding before environment provisioning

The default `environment.create` executor obtains a server-derived, durable
allowance before any Kubernetes creation. Configure
`PGCF_PROVISIONING_JOURNAL_DIRECTORY` with an existing absolute, owner-private
mode-0700 directory on persistent storage, for example
`/var/lib/pgcf/provisioning`. The operator prepares this directory without changing
existing journal permissions. Symlink paths, changed directory/file identities,
unsafe modes and missing custody fail closed. No temporary directory is used.
The deployment example wires this sibling directory but does not create it;
the trusted installer must prepare it before enabling that setting. Do not
reuse or change the existing usage journal directory.
An omitted setting preserves empty-queue startup compatibility; a claimed create
cannot make Kubernetes effects or publish readiness without it.

The separate bootstrap journal binds the create operation, environment, region,
immutable specification and initial run epoch. It durably seals a fixed
300-second funding request before HTTP, using the create operation UUID as the
reservation request identity. An uncertain response is retried with that same
identity and horizon under the new current operation lease. A reclaimed lease
without prior local request custody is refused even though the server also
deduplicates the operation. An expired receipt is retained; it is never replaced,
renewed or automatically settled.

The server supplies organization/project ownership and derives CPU, memory and
data-storage units from the same shared resource envelope used for the namespace
quota. This includes CNPG initialization/maintenance headroom, the archive
sidecar and any configured Pooler. Receipt and authority are persisted before
effects. Each creation and ready publication obtains current authority; local
checks reject paused, unavailable, insufficient, expired or stale authorization
and clock rollback. The Kubernetes client's final pre-send middleware repeats
the check after asynchronous authentication and bounds the request deadline by
remaining authorization. Long readbacks that outlive the 15-second authority
snapshot defer conservatively.

This is a pre-dispatch funding barrier, not an independent physical runtime
expiry guard. A quota ceiling does not prove fleet capacity, actual PV sizes,
complete usage or final settlement. The existing UID-bound `AllowanceJournal`
and runtime supervisor retain their separate custody requirements. Held receipts
remain held after uncertain/partial creation; normal accounting and recovery
must preserve them. Budget resources continue to report `runtimeEnforced: false`.
Runtime enforcement, positive installation qualification and physical stop/usage
completion remain required before customer admission.

## Operator configuration

Build with Node.js 24 or newer and `pnpm --filter @cloudflare-postgres/regional-controller build`. The production Dockerfile pins Node 24.21.0; local Node 24.6 executions are provisional tooling evidence and do not establish the pinned image's SQLite/runtime behavior. Supply:

| Variable                              | Meaning                                                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGCF_CONTROL_ORIGIN`                 | HTTPS origin of the adopter's control API, without path or credentials.                                                                               |
| `PGCF_REGION_ID`                      | Region ID registered by the installation operator.                                                                                                    |
| `PGCF_REGION_TOKEN_FILE`              | Preferred: a mounted owner-readable file containing only the region-scoped API token.                                                                 |
| `PGCF_REGION_TOKEN`                   | Alternative token source for a supervised process; file takes precedence.                                                                             |
| `PGCF_REGIONAL_CONFIG_FILE`           | File containing the nonsecret JSON configuration below.                                                                                               |
| `PGCF_KUBECONFIG_FILE`                | Explicit kubeconfig for local execution. Otherwise require in-cluster authentication; the user's default kubeconfig is never selected implicitly.     |
| `PGCF_LEASE_SECONDS`                  | 30–300, default 90.                                                                                                                                   |
| `PGCF_POLL_MILLISECONDS`              | 1,000–60,000, default 5,000.                                                                                                                          |
| `PGCF_READINESS_MILLISECONDS`         | 30,000–600,000, default 300,000; expiry defers the operation for reclaim.                                                                             |
| `PGCF_PROVISIONING_JOURNAL_DIRECTORY` | Existing owner-private mode-0700 persistent directory for mandatory pre-provisioning funding custody. Missing configuration refuses claimed creation. |
| `PGCF_USAGE_JOURNAL_PATH`             | Enables metering; an owner-private, persistent SQLite file such as `/var/lib/pgcf/usage/journal.sqlite`.                                              |
| `PGCF_USAGE_SOURCE_ID`                | Nonsecret source UUID returned by the installation-only regional usage-token bootstrap.                                                               |
| `PGCF_USAGE_SOURCE_EPOCH`             | Positive safe integer source epoch returned with that source ID.                                                                                      |
| `PGCF_METER_TOKEN_FILE`               | Mounted file containing the separate `cpmtr_...` token with `usage:write`; no metering token environment fallback exists.                             |
| `PGCF_USAGE_SAMPLE_MILLISECONDS`      | 1,000–30,000, default 5,000; delay between bounded inventory samples.                                                                                 |
| `PGCF_USAGE_DELIVERY_MILLISECONDS`    | 1,000–60,000, default 5,000; delay between outbox delivery passes.                                                                                    |

Example configuration, with deployment-specific operator Pod labels and an explicit allowed source Secret reference:

```json
{
  "operatorNamespace": "cnpg-system",
  "operatorPodLabels": { "app.kubernetes.io/name": "cloudnative-pg" },
  "allowedBackupSecrets": [
    {
      "namespace": "platform-secrets",
      "name": "private-backup-credentials",
      "accessKeyIdKey": "ACCESS_KEY_ID",
      "secretAccessKeyKey": "SECRET_ACCESS_KEY"
    }
  ]
}
```

Use the actual labels of the installed operator; chart and manifest labels can differ. Do not copy database credentials or `.env.local` into this configuration, a container image, logs, or the repository. Region and meter credentials are purpose-specific API tokens and must be mounted separately from each other and from provider credentials.

Run `pnpm --filter @cloudflare-postgres/regional-controller start` under an operator-owned supervisor; the compiled entry point is `apps/regional-controller/dist/main.js`. The [full deployment example](deploy/example.yaml) enables metering and supplies a restricted single-writer Pod, dedicated service account, nonsecret configuration, separate `pgcf-region-access` and `pgcf-meter-access` token Secret references, a persistent journal volume, and an explicit source-Secret read Role. Replace its origin, region ID, meter source/epoch, image, and operator labels; create the private Secrets separately. It exposes no Service or ingress.

Before using that full template, the installation operator must call `POST /v1/regions/{regionId}/usage-tokens/reissue` on the [control API](../control-api/README.md). Save its `apiToken` in the `token` key of the separate `pgcf-meter-access` Secret in `pgcf-system`; copy the returned `sourceId` and `sourceEpoch` into the ConfigMap placeholders. The existing region token belongs in `pgcf-region-access`. Neither Secret value belongs in the YAML. Meter rotation preserves the source identity; the collector reloads the projected token file before each delivery, so mount the Secret directory without `subPath`.

For backward compatibility, omit all four metering enablement variables (`PGCF_USAGE_JOURNAL_PATH`, `PGCF_USAGE_SOURCE_ID`, `PGCF_USAGE_SOURCE_EPOCH`, `PGCF_METER_TOKEN_FILE`) to run only the environment controller. Any partial combination fails startup instead of silently selecting a source, token, or ephemeral journal. The full template includes all four and therefore requires meter-source bootstrap; do not leave its source placeholders unchanged.

The template uses one `ReadWriteOnce`, 1-GiB `pgcf-lvm` PVC in `pgcf-system`, mounted writable at `/var/lib/pgcf` while the container root filesystem stays read-only. The process creates the child `usage` directory with `0700` and the journal/WAL/shared-memory files with `0600`; the journal rejects unsafe ownership, permissions, and symlink entries. Keep the configured path below that child, not directly at the group-writable PVC root. Secret volumes use `0440`, with Pod `fsGroup: 1000`, while the process runs as UID/GID 1000.

`replicas: 1` and `strategy: Recreate` prevent rolling overlap of journal writers. Do not share the same journal with another process or scale that Deployment. `fsGroupChangePolicy: OnRootMismatch` avoids recursively widening private child modes on replacement Pods when the volume root already matches. Validate mount ownership and restart behavior with the selected CSI driver; a driver handling `VOLUME_MOUNT_GROUP` owns that permission step instead of this policy. [Kubernetes volume ownership policy](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/#configure-volume-permission-and-ownership-change-policy-for-pods)

The optional [Dockerfile](Dockerfile) builds from the repository root with `docker build -f apps/regional-controller/Dockerfile .`. The root `.dockerignore` allows only named public package/configuration/source inputs into the build context; local environment files and generated credentials are excluded. The official Node 24.21.0 LTS multi-platform index is pinned by digest, read back from Docker's registry on 2026-09-28 with Linux amd64 present. [Node release](https://nodejs.org/en/blog/release/v24.21.0), [official image source](https://github.com/nodejs/docker-node). Image build and runtime acceptance remain distinct from production promotion.

The controller's Kubernetes identity is trusted infrastructure: the example ClusterRole can create namespaces and customer resources across the cluster. Kubernetes RBAC cannot restrict `create` by resource name; the broad creation grants require admission policy or an equally strong approved operational boundary before untrusted production use. The separate Role limits source-Secret reads to the explicitly named Secret, and the runtime independently checks the configured source-key allowlist. Do not share the controller's kubeconfig or service account with customers. A production installation must still qualify admission controls, token recovery/rotation, operator selectors, Cilium enforcement, and the regional release process.

Metering adds only inventory reads for namespaces, CNPG Clusters/Poolers, Deployments/ReplicaSets, Pods, PVCs, and PVs. Actual Pooler CPU/RAM requests are attributed to `platform` only after the complete owned UID chain is proven; missing or divergent lineage reports a gap. It does not add Secret listing or extra Secret API reads: the meter credential arrives through a projected Secret file. Kubernetes RBAC does not enforce the collector's label selectors; the observer must still prove ownership before assigning usage.

## Reconciliation and authority

The controller claims one operation at a time, renews its versioned lease, and uses the persisted immutable profile snapshot. It verifies `sha256(JSON.stringify(spec))`, region identity, the digest-pinned PostgreSQL image, supported integer resource quantities, volume bounds, backup HTTPS origin and explicit S3 API signing region, and the local source Secret allowlist before creating resources. The selected installation uses Cloudflare R2 through its S3-compatible API; `s3://` destinations and S3 client terminology do not select Amazon storage.

Every environment uses `pgcf-<environment UUID without hyphens>` and a `database` Cluster. Owned resource labels identify both the environment and the region; an annotation records the execution-spec hash. A name collision or changed owned configuration fails without adopting or overwriting it. Stable names and readback resolve a create whose response was lost. Unknown infrastructure/control outcomes and readiness timeouts remain retryable through lease expiry and a fresh claim; they do not assert that no database exists. SIGINT/SIGTERM stops new work.

The controller first creates a restricted namespace, CPU/RAM/storage/PVC/Pod quota, bounded default container resources, and default-deny network policy. An explicit Cilium policy permits only cluster replication/status traffic, operator health probes, kube-dns, kube-apiserver, and HTTPS to the selected backup hostname. It grants no customer/public ingress in this slice. Quotas reserve one extra instance slot for initialization or maintenance; they do not prove available fleet capacity or implement customer budgets.

Only the two explicitly selected source credential keys are copied into the environment's `archive-credentials` Secret. The catalog's nonsecret `backup.region` is added as a generated `region` key and referenced through Barman's S3 Secret selector; R2 catalogs use the explicit value `auto`. No region is inferred from the endpoint or local defaults. The `archive` ObjectStore uses the catalog's backup destination root followed by `/<environment UUID>/`, keeping the fixed `database` server name distinct across environments. A Barman WAL plugin and bounded sidecar resources are attached. No base backup, successful WAL upload, retention behavior, or recovery is inferred from PostgreSQL readiness.

Ready requires a matching current Cluster UID/generation and CNPG Ready condition, enough currently Running/Ready instance Pods controlled by that UID, and the current primary among those Pods. The Cluster is read again after listing Pods to reject replacement or revision during observation. If a condition includes `observedGeneration`, it must match the resource's current generation. The result reports only UID, generation, and ready-instance count. Exceptions are never logged because Kubernetes responses can contain Secret data; logs contain only generic event codes.

## Provisional usage observation and delivery

The optional collector runs beside operation reconciliation. Its paginated Kubernetes inventory is bounded and selects managed namespaces for the configured region, then CNPG Clusters, instance Pods, PVCs, and PVs. A partial inventory, timeout, or unsupported resource state becomes unknown coverage. Only the managed namespace/spec/Cluster ownership chain is eligible. The old manually created M1 database is outside that managed-environment scope. A qualification run with an empty managed inventory can verify access and exclusion, but cannot establish positive resource measurement or delivery.

For scheduled `Pending`/`Running` CNPG instance Pods with completed supported init work, the observer reads regular-container requests and emits exact fixed-point `cpu_millicore_ms` and `memory_byte_ms` rates. PostgreSQL containers use proven primary/replica attribution; other regular sidecars use `platform`. Unscheduled or completed Pods do not produce CPU/RAM allocation estimates. Init/restartable-init accounting, Jobs, Pod-level resources, overhead, and ephemeral-container semantics are not qualified by this slice; unsupported states record issues instead of guessed rates.

`data_storage_byte_ms` comes from an owned PVC-to-PV UID binding and the PV's actual capacity, including while the Pod is starting or completed. A proven retained-volume chain persists namespace, Cluster, PVC, and PV identities plus storage class/spec; it may continue attributing a retained PV after its PVC or namespace is removed only while the same PV UID/claim identity remains valid. Name matching, a profile request, or a ResourceQuota alone does not establish that binding. Polling observations are always provisional estimates, even when two snapshots agree; they do not prove an allocation's exact transition time or complete observation of a time window.

The journal is a source-identity-sealed, file-backed Node SQLite database. It uses `journal_mode=WAL`, `synchronous=FULL`, fsyncs a newly created file and its directory, performs transactional checkpoint/outbox changes, and checkpoints/truncates WAL at close. Its default outbox bounds are 4096 pending facts and 8 MiB of serialized pending payloads; allocation checkpoints/retained-volume snapshots are bounded at 4096 and the legacy short acknowledgement history at 1024. The accepted receipt ledger has separate explicit record/byte limits and is retired only through a verified private archive; it is not silently pruned. Those are logical record/payload bounds, not an 8-MiB cap on all database and WAL files. Disk failure, node loss, journal backup/recovery, and the selected PVC's fsync behavior still need operational qualification.

Matching the previous allocation across ordinary bounded samples produces provisional subinterval facts split at UTC-minute boundaries. A versioned continuity proof binds stable ownership, resource identity, attribution and normalized rate; changing status or resource versions remain separate observation evidence. Direct and retained observations of the same proven PV share that proof, so storage can continue while absent compute records unknown coverage. Present objects contradicting a retained binding are rejected. A legacy checkpoint without a supported continuity proof records an unknown transition interval before new proven samples can resume; existing outbox IDs, bytes and hashes are preserved. See the [allocation continuity contract](../../docs/contracts/usage-allocation-continuity-v1.md).

A restart, long sample gap, changed/missing allocation, incomplete inventory, clock anomaly, or buffer pressure preserves unknown coverage. Long unknown spans emit only the first clipped-minute gap fact when capacity permits; their full start/end range and occurrence count remain in a bounded, coalesced local gap summary. The collector does not generate unbounded minute backfill or treat the remaining span as zero. Delivering pending facts does not erase locally known gaps or imply complete coverage.

The sender keeps each durable fact ID/revision/evidence identity across uncertain HTTP outcomes. The normal sender removes a pending record only after a strict receipt matches every sent field, region/source, valid owner IDs, acceptance sequence and timestamp, and the journal stores that complete receipt transactionally. The older boolean transport/short acknowledgement API remains an incomplete compatibility path and is not used for normal collector delivery. Token files are reloaded per request. Delivery failures retain the outbox and emit generic event codes without credentials, raw resource details, or tenant data. The sealed region/source/epoch must match on reopening; changing source identity requires an explicit journal recovery/migration procedure.

This collector emits only revision-one `provisional` and `gap` facts for the three metrics above. Finalization, revision/correction production, initialization/job allocation, PostgreSQL WAL/backup storage, transfer, and complete coverage certification remain pending. It does not acquire or settle allowance reservations, supervise PostgreSQL, or enforce lease expiry/budget periods. Budget resources retain `runtimeEnforced: false` and `enforcementStatus: pending_runtime`; a provisional observation does not enable a hard runtime cap. The explicit supervision mode above supplies current-authority and normal-stop logic separately; M6 still requires the independent restart-safe expiry guard and qualified stop/overshoot behavior.

## Verification and upstream provenance

Running `pnpm test:node` requires Python 3.11 or newer for the control-recovery
regression that lowers SQLite's compound-SELECT limit. The production
controller does not use Python.

The [Dev collector runtime checkpoint](../../docs/evidence/m3-regional-usage-collector-2026-09-28.md) verifies the pinned Node 24.21.0 image, both scoped client paths, exclusion of the manual lab database, and the private persistent journal across one Pod replacement on the selected CSI driver. It covers an empty managed inventory, not positive usage delivery or complete/final accounting.

The bounded Node lifecycle regression is `test/reconcile.node.test.mjs`. It first failed on trusting a completed Pod with a stale Cluster Ready condition, then passed after the current-Pod check. It also exercises a lost committed-create response, restart reconciliation without duplicate resources, real API-added Namespace finalizers and canonical quantities, explicit S3 region and backup key selection, boundaries, and refusal to adopt another owner. The collector's bounded regressions are `test/usage-observer.node.test.mjs`, `test/usage-journal.node.test.mjs`, and `test/usage-delivery.node.test.mjs`, covering owned request/PV observation, crash-recoverable replay with bounded unknown coverage, and matching acknowledgements with credential reload. Local Node 24.6 execution is provisional evidence; qualify the pinned production Node 24.21.0 image and real journal mount independently. Actual Cilium admission/enforcement, CNPG defaults, resource capacity, managed-environment collection/delivery, and end-to-end API-to-CNPG provisioning still require target-installation evidence.

The maintained official [Kubernetes JavaScript client](https://github.com/kubernetes-client/javascript) is pinned as `@kubernetes/client-node@2.0.0`. npm records upstream commit [`f72cc23ed378cb8e7f09129ee6e55aa531a2b9ba`](https://github.com/kubernetes-client/javascript/tree/f72cc23ed378cb8e7f09129ee6e55aa531a2b9ba); its [license](https://github.com/kubernetes-client/javascript/blob/f72cc23ed378cb8e7f09129ee6e55aa531a2b9ba/LICENSE) and package metadata declare Apache-2.0. The workspace lock records the exact distribution integrity and transitive dependency graph. No upstream source is vendored or modified.

Resource construction follows the primary [CNPG security](https://cloudnative-pg.io/docs/1.28/security/), [Barman plugin 0.15 usage](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/), and [Cilium 1.20 policy](https://docs.cilium.io/en/stable/security/policy/index.html) contracts. CNPG owns instance security defaults, application role credentials, replication, and lifecycle; the controller disables superuser access and does not expose those private credentials. Passing this package's test does not establish production tenant isolation.

## Pre-execution node provenance

An optional immutable `nodeTracking: {"version": 1}` profile requires execution fencing and a private absolute `nodeTrackingJournalPath` in regional configuration. The [cohort contract](../../docs/contracts/execution-node-cohort-v1.md) reserves original Node identity/boot records before any Namespace effect, binds Namespace and ConfigMap identity once, and confines CNPG/Pooler placement to original names. The journal is bounded to 4096 private records, each at most 65 KiB. It stores operational provenance rather than Cloudflare's authoritative management state.

Tracked stop claims carry the exact ready ConfigMap UID/hash; the journal retains the full original node set before owned stop effects. Missing/recreated objects, changed Node birth or absent Running-Pod placement fail conservatively. Legacy profiles create no new journal and receive no inferred history. Runtime stop completion remains `physical_verification_pending`; authenticated runtime observations, final accounting and node-loss recovery remain required.
