# Control API

## Installation provider inventory

`GET /v1/installation/providers/contabo/instances` uses the installation bootstrap
token and the four Contabo API Worker Secrets. It performs only authentication
and bounded provider GETs; it accepts no backend URL, query, body or server action.
Organization/regional credentials do not gain this access. Its selected instance
metadata is for the installation operator and must remain private.

The [fleet contract](../../docs/contracts/fleet-inventory-v1.md) defines observed
scan consistency, limits and safe failure. The [regional inspector](../regional-controller/README.md#fleet-inspection)
compares explicit enrollment with authenticated Node identity. No nominal provider
resource total creates spare capacity, physical-host guarantees or upgrade
authorization. Existing D1 schema, customer admission and default controller
behavior are not changed by this read API.

This Worker implements a generic `/v1` management API backed by one D1 database. It records organizations, registered regions, scoped API tokens, projects, immutable environment specifications, idempotency identities, audit operations, usage revisions, and budget/allowance authority. A project is a global logical container created immediately in D1. Its `active` status does not mean that a PostgreSQL cluster, database, credential, or connection endpoint exists. Database environments are separate resources executed through region-scoped leases. Registering a region alone neither admits environments nor provisions PostgreSQL.

## Operator setup

Create a D1 database in the adopter's Cloudflare account, copy `wrangler.example.jsonc` to `wrangler.jsonc` in this directory, and set its database name and ID to that database. `wrangler.jsonc` is ignored by Git. From this directory, apply the migrations with `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc` before serving requests. Configure a high-entropy `INSTALLATION_BOOTSTRAP_TOKEN` as a Worker Secret for this Worker, for example with `pnpm exec wrangler secret put INSTALLATION_BOOTSTRAP_TOKEN --config wrangler.jsonc`. The example configuration contains no account ID or secret. Keep all Worker configuration and any local development secret files in this directory; a parent directory's operator credentials are outside the Worker's configuration boundary. See Cloudflare's [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) documentation for operator details.

The separate `wrangler.test.jsonc` binds a disposable local D1 database. Its fixed ID and installation token are test fixtures only. Tests apply the real migrations in Miniflare through Cloudflare's Vitest plugin. Run the focused tests with `pnpm exec vitest run test/api.test.ts` from this directory.

## API behavior

Send `POST /v1/organizations` with `Authorization: Bearer <installation bootstrap token>` and JSON `{ "name": "..." }`. A successful response creates an organization and returns a random `cporg_...` API token with `projects:read`, `projects:write`, and `operations:read` scopes. D1 stores only its SHA-256 digest. The token is returned in this response only; store it securely at creation. The installation token is for organization bootstrap, not ordinary organization requests.

If the bootstrap response is lost after the database commits, use the installation token to call `GET /v1/organizations` and find the new organization. Results are newest first, with 1000 entries per page by default; `limit` accepts 1–1000. Follow each non-null `nextCursor` as the `cursor` query parameter until the target appears or `nextCursor` is null. The cursor advances by creation time and ID; concurrent creations or deletions can change later pages. Invalid pagination parameters return `400 invalid_request`. Then call `POST /v1/organizations/{organizationId}/tokens/reissue`. The response reveals a replacement token once and revokes every previously active token for that organization. A repeated reissue creates another replacement and invalidates the previous one; keep the final successful response. These installation routes never accept an ordinary organization token.

Organization, project, and environment JSON bodies are limited to 4096 UTF-8 bytes, including when the caller omits `Content-Length`. The installation-only catalog publication route allows 16384 bytes and at most 16 profiles; environment execution results allow 16384 bytes for bounded public CA metadata; accounting routes allow 8192 bytes. Oversized or invalid bodies return `400 invalid_request` without buffering the full request.

Send `POST /v1/organizations/{organizationId}/projects` with the organization token, JSON `{ "name": "..." }`, and an `Idempotency-Key` of 1–128 ASCII letters, digits, `.`, `_`, `~`, or `-`. A successful `201` response contains an `active` logical project and a `succeeded` `project.create` audit operation, with `observedAt` and `resultCode: logical_container_created`. The same key and same request return the same IDs and `201` response for a completed pair. An unmatched legacy `pending`/`queued` pair instead returns `202` with its original IDs and requires operator review. Reusing the key with a different name returns `409 idempotency_conflict`. Idempotency records currently have no expiry. D1 inserts the project, completed operation, and idempotency identity in one atomic batch, so a failed insert does not leave an orphan.

Migration `0004_logical_projects.sql` updates only legacy name-only `project.create` pairs in `pending`/`queued` state with exactly one operation per project. It preserves IDs and creation timestamps, and records when the pre-existing D1 container was observed. Rows with other states or multiple operations remain unchanged for operator review. No region is inferred or provisioned.

The rollout has two phases because an older Worker could write another legacy pair after migration. Pause all project-creation clients, review unexpected legacy states, and apply `0004` before deploying the new Worker. After deployment, run `pnpm exec wrangler d1 execute DB --remote --config wrangler.jsonc --file scripts/reconcile-logical-projects.sql`. This repeatable script contains only the guarded backfill updates, not schema changes or runtime auto-repair. Verify that the following query returns zero eligible legacy pairs, then resume project clients:

```sql
SELECT COUNT(*) AS eligible_legacy_projects
FROM projects AS project
WHERE project.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM operations AS operation
    WHERE operation.project_id = project.id
      AND operation.organization_id = project.organization_id
      AND operation.kind = 'project.create'
      AND operation.status = 'queued'
  )
  AND (
    SELECT COUNT(*) FROM operations AS related
    WHERE related.project_id = project.id
      AND related.organization_id = project.organization_id
  ) = 1;
```

This zero-count check is separate from the preflight review of unmatched states; it does not make those records safe to convert.

Use the organization token to read `GET /v1/organizations/{organizationId}/projects/{projectId}` and `GET /v1/organizations/{organizationId}/operations/{operationId}`. Token lookup and resource reads use the D1 primary. Missing or invalid tokens return `401`; a valid token for another organization receives `404`. All API responses set `Cache-Control: no-store`. The [OpenAPI contract](openapi.yaml) records request and response shapes.

The current slice has no public native endpoint, environment deletion, physical resize, integrated runtime allowance enforcer, idempotency archival, or rate limiting. Opted-in private endpoint discovery and scoped credentials are separate metadata and credential paths. A reported ready environment means the regional executor observed PostgreSQL resource readiness; it does not prove backups, restore qualification, credential access, or a production service objective.

## Approved manual resize intention

An immutable regional profile may include the [approved size policy](../../docs/contracts/compute-scaling-v1.md). `GET .../environments/{environmentId}/compute` requires `projects:read` and exposes requested/effective size IDs, phase and compute revision. Before any resize, revision `0` and the original nonminimum `initialSizeId` are implicit; a profile without `computeScaling` returns `409 compute_scaling_unavailable`.

`POST .../environments/{environmentId}/resize` requires `projects:write`, `Idempotency-Key`, and exactly `{ "sizeId": "<approved-id>", "expectedRevision": 0 }` for the initial request. D1 atomically checks the ready owned environment, frozen profile and Cluster/run identity, running runtime, requested budget state, current compute revision, and absence of pending suspend, backup, role, database or other resize work. A changed body under the same scoped key conflicts; an identical retry returns the accepted response. The first accepted operation stores revision `1`, retains the original effective size, and reports `requested` and `queued` with `resultCode: awaiting_authority`. The ordinary organization operation read recovers its nonsecret metadata. Normal suspend and backup admission interlock against a pending resize; hard budget stopping is independent.

Migration `0016_environment_resize.sql` adds immutable operation/request history and the separate compute-state row. Apply it before deploying this Worker: both normal operation recovery and existing lifecycle checks now read its tables. **This is a queued intention only.** There is no regional resize claim, dispatch, capacity reservation, target funding, CNPG resource patch, Pod-size observation or effective-size transition in this slice. Requested budgets alone and an approved catalog size do not grant resource-time authority. Do not present `requested` as applied compute or enable an executor based on this API alone. Automatic scaling, timeout/cancellation policy, and physical qualification remain separate gates.

## Opt-in execution fencing

A new immutable operator profile may include exactly `executionFencing: {version: 1}`. The [execution-identity contract](../../docs/contracts/execution-fencing-v1.md) defines the server-assigned initial `runEpoch: "1"`, its required readiness/suspend propagation and protected regional mutations. Existing unfenced profiles/rows are not backfilled. Deploy every writer with these checks and exclude older privileged writers before enabling the profile; this is not Kubernetes admission enforcement or funded resume.

## Explicit compute suspension

Use the [suspend contract](../../docs/contracts/environment-suspend-v1.md) to request an immediate owned compute stop with `POST .../environments/{environmentId}/suspend`, `Idempotency-Key` and `{expectedRevision}`. Read desired/observed runtime state separately at `GET .../runtime`; provisioning status and immutable specification remain unchanged. The ordinary operation endpoint recovers the task. Active database work conflicts, while suspended desired state blocks new work/credential disclosure and current execution funding.

The regional executor seals workload/volume identities before quota/Pooler/Cluster changes and reports completion through a fenced lease. It does not settle allowances, finalize usage, delete data or resume compute. Automatic idle detection, funded wake, ingress/draining and independent expiry remain separate v1 gates.

## Optional managed pooling

An installation operator may append the exact version-one session `pooling` policy to a new immutable catalog profile. It is exposed publicly as nonsecret configuration and frozen in the environment specification; historical unpooled profiles and hashes remain unchanged. The [managed-pooling contract](../../docs/contracts/managed-pooling-v1.md) defines image/resource/connection/timeout bounds, derived CNPG certificate names and a single RW/Recreate Pooler.

A pooled environment result requires the additional owned Pooler/Deployment readiness observation. The existing role API accepts that observation without changing ordinary credential or privilege rules. This describes internal provisioning, not an external endpoint or successful SQL connection. Normal Pooler accounting/stopping needs the separately configured regional modes and independently bound resource identities. API-managed TLS/SQL, network isolation and integrated budget enforcement remain qualification gates.

## Optional private native connection discovery

An installation-owned catalog profile can opt into exactly
`nativeAccess: {version: 1, clientProfileId: "private-application"}`. The regional
configuration independently binds that opaque ID to an existing approved client
Namespace and ServiceAccount, including their UIDs. Customers select only the
catalog/profile; they cannot provide network selectors or backend URLs. Omitted
legacy profiles, serialized specifications and hashes remain unchanged.

`GET /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/connections`
requires the owner's `projects:read` token and accepts no query parameters. It
returns a direct private service host, port 5432, `sslmode: verify-full`, public CA
and bound provisioning identities. Passwords and Secret references are omitted;
roles/databases continue using their existing separate credential routes. The
response uses `Cache-Control: no-store`. Legacy/unconfigured profiles, malformed
proofs, unavailable reported CA validity, inactive projects/regions, nonrunning
runtime, and requested budget pause return `409 native_connection_unavailable`.
Foreign resources return 404. Current actor and scope/state are rechecked in a
primary transaction before disclosure.

The authenticated regional executor verifies the owned RW Service, ready primary,
EndpointSlice, CA/server certificate chain, server purpose/host and exact client
policy resources before reporting its existing fenced provisioning result. The
Worker validates the bounded public proof, derived host, frozen spec/profile and
cluster identity, CA hash and reported validity intervals. It does not independently
query Kubernetes or parse/verify X509 signatures. `observedAt` and
`observationScope: provisioning` explicitly describe historical provisioning
material, not current SQL availability, policy realization or permission to wake.
The CA must remain valid; `serverCertificateSha256` and `serverValidUntil` record
the leaf observed at provisioning. CNPG leaf renewal does not change authority,
and the client must verify the live server certificate with the returned CA and
host on each connection. No freshness TTL turns this one-time observation into a
permanently unavailable endpoint.

This slice exposes no public TCP gateway and does not change admission, budget
`runtimeEnforced`, or physical stop/expiry qualification. The approved client must
already possess private network access; actual managed TLS/SQL and policy
realization remain separate evidence gates.

## Manual physical base backups

`POST .../environments/{environmentId}/backups` accepts exactly `{}` and an
`Idempotency-Key` with `projects:write`. It retains one immutable backup and
`environment.backup` operation bound to the ready environment, frozen specification,
Cluster, execution epoch, runtime revision and archive configuration. Customers
cannot select paths, credentials, a target instance or arbitrary Kubernetes fields.
An identical request replays its accepted response. Normal suspend and pending
backup intents interlock atomically, including expired uncertain leases. Hard budget
stop/expiry does not consult or extend this ordinary maintenance interlock.

Read the item or signed-cursor collection with `projects:read`; recover its task
through the ordinary organization operation endpoint with `operations:read`.
Metadata remains readable after completion, pause and source state changes. Public
responses omit archive URLs, Secret references, resource UIDs and raw operator
errors. `completed` means a trusted operator base-backup artifact observation;
`remoteObjectsVerified`, `restoreVerified`, and `PITRVerified` remain false.

The private `/v1/regions/{regionId}/backup-operations` lane claims and renews work
with existing executor scopes. Before any Backup CR create, `/{operationId}/dispatch`
retains an immutable Namespace/Cluster/ObjectStore/spec binding plus a fresh process
nonce under the winning lease. Only a positively acknowledged `created: true` for
that same fresh process allows its one create attempt. Exact dispatch replay returns
`created: false`; reclaimed claims carrying a checkpoint only observe the original
owned resource. A missing CR after dispatch remains uncertain and never permits
recreation, name adoption or a guessed terminal result.

Enqueue, claim, renewal and dispatch require running runtime and requested budgets.
Terminal custody is a separate narrow exception: an unexpired winning lease can
record already observed whitelisted completion/failure after requested budget pause
while the original environment/spec/Cluster/run epoch/runtime revision and actor
remain current. It grants no renewal, create, wake or funding. Runtime/epoch changes
or expiry still refuse the report. Successful completion normalizes the actual
CNPG/Barman timestamp, WAL/LSN and six plugin metadata fields, including source
Cluster UID and pinned plugin identity. Unknown/malformed results remain reclaimable.

Migration `0015_environment_backups.sql` is additive and must be installed before
this Worker writer is deployed. This API adds no schedule, restore, remote deletion
or payment flow. The regional lane remains separately opt-in; source tests and a
completed resource do not qualify R2 objects, restore or PITR. Customer admission
and the pending backup-access confirmation remain separate gates.

## Customer role and database lifecycle

The [generic adopter workflow](../../docs/guides/database-lifecycle-v1.md) explains
role creation, current metadata/credentials, owned database creation and password
rotation. The [OpenAPI contract](openapi.yaml) includes all seven existing methods,
exact bodies/scopes and immutable operation responses. An accepted intent is not
an external endpoint or a production qualification; closed admission and the
independent native/backup/usage/isolation gates remain in force.

## Customer recovery reads

The [recovery-read contract](../../docs/contracts/recovery-reads-v1.md) adds organization-scoped project, project-scoped environment, and environment-scoped role/database collection reads. Each entry contains the existing public resource plus `currentOperationId`; the page returns `nextCursor`, `consistency: observed-page` and `observedAt`. These reads require `projects:read` and do not disclose passwords or full operation status. Page limits default to 50 and are capped at 100; signed cursors bind the collection, parent and limit. Only one `limit` and `cursor` are accepted.

Poll `GET /v1/organizations/{organizationId}/operations/{operationId}` with `operations:read`. It resolves project/environment and separate role/database operation stores, including historical credential revisions, without credentials, lease authority or private evidence. Missing/foreign parents return 404; owned empty lists return 200. Pending/failed resources and disabled-region metadata remain recoverable. Pages report observed control state, not a frozen snapshot or SQL availability. Ambiguous persisted operation identities fail explicitly.

## Owned logical databases

The [owned-database contract](../../docs/contracts/owned-databases-v1.md) creates a named SQL database under a verified restricted role in the same API-managed environment. Use `/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/databases`: `POST` requires write scope, `Idempotency-Key` and exactly `{name, ownerRoleId}`. It returns asynchronous database/operation metadata without a password. Read metadata with `GET /{databaseId}`; write-scoped `GET /{databaseId}/credentials` supplies the selected database name and the owner's currently applied credential. It provides no public endpoint.

The separate `/v1/regions/{regionId}/database-operations` lane uses executor claim/report scopes. Initial work binds accepted environment, Namespace, Cluster, role and credential identities. Queued/running creation holds owner rotation through lease expiry and uncertain outcomes; the same task is reclaimed. Rotation resumes after creation finishes, and credential disclosure follows its newest applied revision. `observedAt` and `credentialVerifiedAt` describe different observations. No extra password or cryptographic key is created for a logical database.

CNPG can adopt an existing SQL database when applying its Database CRD. First creation therefore requires a complete competing-resource check and a fresh SQL-name absence check; an unmanaged database is a conflict. Customers retain `NOCREATEDB`; independent privileged administrators must coordinate with the platform because these checks are not an atomic database-create-only primitive. Bootstrap/system names and arbitrary CR fields are rejected. Fresh TLS SQL ownership and rollback-confirmed migration probes are required before success. Physical provisioning, external connectivity and backup/restore qualification remain separate gates.

## Database roles and credentials

The [role lifecycle contract](../../docs/contracts/database-role-credentials-v1.md) defines tenant-scoped login-role creation, credential disclosure and conditional password rotation. Set the dedicated `ROLE_CREDENTIAL_KEYS` Worker Secret before using it; the keyring contains an active key ID and retained base64url 32-byte AES keys. Do not reuse allowance keys or provider credentials. Missing keys cannot issue a credential operation. Passwords are generated server-side, authenticated-encrypted before D1 persistence and disclosed only after the current revision is verified by the regional executor.

Use the ready environment's `/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/roles` collection with the existing organization token. `POST` requires `Idempotency-Key` and exactly `{name, connectionLimit}`; its asynchronous response contains metadata and an operation, never a password. `GET /{roleId}` reads metadata; `GET /{roleId}/credentials` requires write scope and returns only the latest applied credential. `POST /{roleId}/rotate` requires an idempotency key and `{expectedCredentialRevision}`. Reserved role names and privileged attributes are not exposed. A login role receives no automatic table privileges or database ownership.

The separate regional `/v1/regions/{regionId}/role-operations` claim/renew/result lane leaves the existing environment-create protocol unchanged. Region executor tokens can receive only bound current leased work; they cannot use the customer credential-disclosure route. Claims contain the exact new and, for rotation, previous password for the trusted executor's fresh TLS checks. Successful results must match current intent and exact CNPG role/Secret application plus connection observations. Historical replay never publishes a newer credential or rolls role state back.

See [provider secret custody](../../docs/operations/provider-secret-custody.md) for Cloudflare/D1/regional responsibility boundaries. Provider secrets existing in the Dev Worker do not establish fleet operations. Public endpoints, role ownership/grants, key recovery and live installation qualification remain distinct gates.

## Current allowance execution authority

The [current authority and normal-stop contract](../../docs/contracts/runtime-allowance-authority-v1.md) adds `GET /v1/regions/{regionId}/allowance-reservations/{reservationId}/authority` for the ordinary regional executor. It returns a consistent, fresh decision bound to the receipt, environment specification, current policy/account/epoch state and funding. An already funded reservation remains valid at zero free balance; pause, changed epoch/account, expiry or inconsistent evidence cannot be converted into continued authority by replaying its historical receipt.

Allow decisions are cached for at most 15 seconds and never beyond receipt/policy expiry. Changes after the sampled transaction have that bounded revocation delay. Historical receipt/settlement APIs retain their original behavior and credentials; the authority endpoint exposes no fence token and creates no new reservation. Regional normal stop uses owned quota/hibernation reconciliation. Independent expiry enforcement, ingress/session controls, final accounting and overshoot qualification remain open; `runtimeEnforced` stays false.

## Installation maintenance preparation

Migration `0008_maintenance_preparation.sql` adds a separate installation-owned maintenance history, regional preparer credentials and fenced preparation leases. The installation token may submit/read an immutable Kubernetes upgrade plan and issue a dedicated `cpmtp_` preparer token. Existing customer, environment, usage and budget credentials receive no host privileges. Exact idempotency/result replay survives uncertain responses, while stale leases and inactive preparer credentials cannot report a result.

The [maintenance preparation contract](../../docs/contracts/maintenance-preparation-v1.md) documents the `/v1/regions/{regionId}/maintenance` routes, plan, assessment and credential boundaries. Results distinguish `blocked` from `eligible` and always report `executionSupported: false` and `executionAuthorized: false`. This is preparation, not an upgrade, drain, reboot or provider order. Complete recovery, staging, quorum and reservation evidence remain required before actual maintenance. These additive routes are documented separately while the stopped OpenAPI/SDK candidate remains held.

## Region registration

An installation operator sends `POST /v1/regions` with the installation bearer token and JSON `{ "name": "..." }`. Region names are unique under exact, case-sensitive matching; registering an existing name returns `409 region_name_conflict`. The response contains an opaque region UUID, `registered` status, and a random `cprgn_...` executor token with `operations:claim` and `operations:report` scopes. D1 stores only the token's SHA-256 digest. Store the token in the regional controller's secret store, never in a public configuration file.

If the creation response is lost, `GET /v1/regions` pages through registered regions with `limit` 1–1000 and `nextCursor`; `GET /v1/regions/{regionId}` reads one registration. Neither route reveals tokens. Call `POST /v1/regions/{regionId}/tokens/reissue` with the installation token to revoke the prior token and receive a replacement once. A repeated reissue invalidates the previous replacement, so retain the final successful response. These routes reject organization tokens. Projects have no region; each database environment selects one explicitly.

## Immutable regional profiles and admission

The installation operator publishes `POST /v1/regions/{regionId}/catalogs` with `{ "version": "...", "profiles": [...] }`. Each profile has an opaque `id`, a digest-pinned `postgresImage`, `compute: { cpuMilli, memoryMiB }`, `instances`, and `storage: { classId, storageClassName, minGiB, maxGiB, stepGiB }`. The public `classId` is not a Kubernetes StorageClass name. Allowed volume sizes are `minGiB + n * stepGiB` within the maximum. Backup configuration is mandatory: `backup: { region, endpointURL, destinationPath, retentionPolicy, credentialSecret: { namespace, name, accessKeyIdKey, secretAccessKeyKey } }`. The signing region is explicit (R2 uses `auto`); the executor supplies no default. The endpoint must be an HTTPS origin with a root path and default port; the destination is an S3 root. These are trusted references, never secret values. The regional executor checks its independent local secret allowlist and creates an environment-specific archive below that root.

An operator may also publish `computeScaling: { version: 1, initialSizeId, sizes }` on a profile. `sizes` contains 2–8 distinct lowercase ASCII IDs with CPU and RAM values that strictly increase together; each value uses the same bounds as `compute`. The selected initial size must exactly match `compute`, including when it is not the smallest size. This nonsecret policy is returned in the public catalog and frozen in new environment specs. It defines supported sizes only; runtime resize and automatic scaling require separate execution and funding protocols and are not enabled by publishing it.

Catalog versions and persisted environment specs are immutable in D1, including database triggers that reject replacement. A duplicate version returns `409 catalog_version_conflict`; changing a profile requires a new version. Publishing a catalog leaves admission closed. The operator explicitly sends `PUT /v1/regions/{regionId}/admission` with `{ "catalogVersion": "...", "acceptingNewEnvironments": true }` only after the region passes qualification. `GET` on that admission route reads its current policy. Setting the flag to false closes new admission without cancelling previously accepted work. The API stores this operator decision; it does not independently prove backups or successful restore. The current lab's backup qualification remains incomplete and its admission must remain closed.

An organization token with `projects:read` can fetch `GET /v1/organizations/{organizationId}/regions/{regionId}/catalogs/{catalogVersion}`. Public catalog and environment responses omit `storageClassName`, backup endpoint/destination, and credential references. They include compute, volume limits, topology, and backup retention. Catalog/spec hashes identify the complete private execution snapshot; they cannot be recomputed from the redacted public representation.

## One-use environment commissioning

The installation operator can issue `POST /v1/environment-admission-permits`
with the exact organization, project, ordinary environment input, known
`catalogHash`, known resolved `specHash`, and a canonical UTC `expiresAt` at
most one hour ahead. The server independently resolves the immutable catalog
and compares both hashes. Issuance requires the installation bearer token and
an installation-wide `Idempotency-Key`. `GET /v1/environment-admission-permits/{permitId}`
reads the binding and terminal state; `POST .../{permitId}/revoke` accepts `{}`
and its own idempotency key to revoke unspent authority.

An ordinary organization client with `projects:write` may add optional
`admissionPermitId` to its existing environment-create input. The permit is
exactly bound to organization, project, region, catalog version/hash, profile,
name, volume and resolved specification. It is consumed atomically with the
environment, queued operation and normal request identity. The resolved
specification and existing clients' request hashes remain unchanged when no
permit is supplied. Invalid explicit permits never fall back to open regional
admission. Current actor, project, catalog, region and requested project budget
pause are rechecked inside the same batch. Database-clock expiry prevents a
request delayed before the batch from spending stale authority.

Exact environment retries retain IDs after consumption or expiry. Operator
issuance/revocation retries retain their permit identity; changed content under
the same key conflicts. A permit supplies commissioning admission only. It
does not prove capacity, fund runtime, bypass backup requirements, qualify
native access or recovery, or open regional admission. This source addition
has no live permit or managed-environment delivery evidence yet. See the
[commissioning contract](../../docs/contracts/environment-admission-permits-v1.md).

## Environment creation and observation

Send `POST /v1/organizations/{organizationId}/projects/{projectId}/environments` with the organization's `projects:write` token, an `Idempotency-Key`, required `name`, `regionId`, `catalogVersion`, `profileId`, and `volumeGiB`, and optional `admissionPermitId`. Callers cannot supply an image, Kubernetes mapping, resource override, or secret reference. The project must be active and unpaused; the selected version must currently admit new environments or the request must consume its exact installation-issued commissioning permit. There is no inferred region or adopter-specific default.

The `202` response contains a `pending` environment and a `queued` `environment.create` operation. A conditional D1 batch checks admission again and creates the environment, operation, and request identity atomically. It stores the complete normalized profile snapshot with `specRevision: 1` and SHA-256 of `JSON.stringify(spec)` in its persisted key order. A retry of the same request/key returns the same IDs and current state, including after a newer catalog is published or admission closes. A changed body or project path under the same organization's environment key returns `409 idempotency_conflict`. Environment keys are retained indefinitely in this slice and are separate from the logical-project key namespace.

Read `GET /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}` with `projects:read`, and use the existing organization operation GET to observe its audit state. `pending` means accepted, `provisioning` means a regional lease was claimed, and `ready` or `failed` is a fenced executor observation. The immutable requested configuration survives every transition. A foreign organization's valid token receives `404`. Recover a lost creation response through the same idempotent POST or the bounded environment collection read, then poll its current operation identifier.

## Regional execution protocol

The [regional controller](../regional-controller/README.md) uses its region token for these private routes. Authorization and mutation decisions use a D1 session starting on the primary; no transaction is assumed to span D1 and Kubernetes.

1. `POST /v1/regions/{regionId}/operations/claim` with `{ "leaseSeconds": 60 }` atomically leases one queued or expired `environment.create` operation, or returns `{ "claim": null }`. Lease durations are 30–300 seconds. A successful claim includes operation/environment/region IDs, kind, a random `cplease_...` token, incrementing `leaseEpoch`, `leaseExpiresAt`, spec revision/hash, and the full private `spec`. D1 stores only the lease token's digest. Concurrent claimants cannot acquire the same active operation.
2. `POST /v1/regions/{regionId}/operations/{operationId}/renew` with `leaseToken`, `leaseEpoch`, and `leaseSeconds` extends an unexpired current lease. An expired or replaced epoch returns `409 lease_conflict`.
3. `POST /v1/regions/{regionId}/operations/{operationId}/result` submits `leaseToken`, `leaseEpoch`, `status`, `resultCode`, and `observation`. A ready result uses `status: ready`, `resultCode: cnpg_ready`, and `{ clusterUid, clusterGeneration, readyInstances }`; the count must reach the frozen profile's instance count. A failed result uses `status: failed`, `observation: null`, and `ownership_mismatch`, `spec_conflict`, or `reconcile_failed`. The operation and environment transition together in a conditional D1 batch. Stale, expired, and cross-region results cannot complete it. The identical terminal result under the same winning lease can be retried after a lost response; changing that result is a conflict.

Provisioning mutations and their readback/replay require current regional token
identity, owner, scope and an enabled region. Token revocation during request-body
delivery cannot issue or extend a lease, publish a result, or disclose its
observation. Newly claimed or reclaimed leases bind the exact token ID; rotating
that token does not transfer its lease to the replacement. Replacement credentials
wait for unchanged lease expiry before reclaim. Historical provisioning leases
whose actor ID is null retain exact lease/epoch/deadline handling under current
regional authorization, including exact terminal recovery; no legacy owner is
inferred or backfilled. An authorized same-region executor can still renew an
unexpired legacy lease normally; reclaim records the new actor identity. These
checks govern API authority, not immediate physical termination of work already
authorized under an earlier valid lease. Empty claim polling persists no
accounting guard row.

The Worker trusts the authenticated executor's Kubernetes observations and does not independently probe Kubernetes. An executor must verify immutable ownership/spec identity, current CNPG generation, and actual owned PostgreSQL Pod readiness before reporting success. A controller restart or uncertain Kubernetes create must reconcile deterministic environment resources instead of creating another namespace. Private claims contain internal configuration and must not be returned to customer clients or written to public logs. A ready result issues no credentials or public endpoint; an opted-in native profile can supply separately discoverable private endpoint metadata.

## Usage ledger and exports

The [usage and budget authority contract](../../docs/contracts/usage-budget-authority-v1.md) describes the accounting request/response fields and invariants. Installation-only `POST /v1/regions/{regionId}/usage-tokens/reissue` issues a separate `cpmtr_...` token with `usage:write`, preserving the source ID and integer epoch on rotation. Only that purpose-specific meter token may append `POST /v1/regions/{regionId}/usage-facts`; a regional executor token does not grant metering authority.

Facts report one of seven resource metrics, attribution, an immutable environment/source identity, an interval wholly within one UTC minute, a safe integer revision/predecessor, and a retained evidence digest. Quantities are exact unsigned decimal strings rather than floating-point JSON numbers. `provisional` and `final` require a quantity, including explicit `"0"`; `gap` requires null. Revisions are append-only. Exact revision replays are deduplicated, and corrections append a conditional next revision.

Organization read or budget-grantor tokens can query `GET /v1/organizations/{organizationId}/usage` or `/usage/export`. The required UTC-minute-boundary window is at most 31 days; optional project/environment filters stay tenant scoped. JSON and NDJSON use the same fixed acceptance-watermark snapshot and `nextCursor` pagination, with limits 1–100. Decimal-string `pageTotals` and `pageTotalsByStatus` are page-local; coverage remains unknown, explicit gap records are counted, and absent observations never become complete zero usage. The current development ledger retains accepted facts indefinitely; production archival and retention remain pending.

## Budget grants and allowance receipts

Installation-only `POST /v1/organizations/{organizationId}/budget-tokens/reissue` issues `cpbgt_...` with `budgets:read`, `budgets:write`, and `usage:read`. Ordinary organization `projects:write` authority cannot create allowances or raise budgets. The grantor may `PUT` a project or environment `/budget`, or `POST` its `/pause` or `/resume`, using a decimal-string `expectedRevision`. Resource grants are explicit metric vectors and immutable periods; omitted dimensions are unlimited. Policy revisions and execution epochs are exact decimal strings. Pause/resume records requested state and does not stop/start PostgreSQL.

Regional executor tokens request `/v1/regions/{regionId}/allowance-reservations` with a stable request UUID, environment UUID, 30–300-second lease, and resource-unit vector. The API reserves against every applicable project/environment policy atomically, retains expired holds until evidence settlement, and blocks new project authority when historical receipts or applicable active accounts have unresolved gaps. Receipts are bound to spec identity, epoch, and a secret `cprsv_...` fence. Settlement needs explicit current final fact references for every positively reserved metric, including zero evidence when actual usage is zero. Facts must lie after issuance and no later than the declared stop. Actual overruns are recorded rather than clipped; accepted corrections and gap counters update bound accounts atomically. This is accounting authority, not a hard runtime cap.

Budget resources and allowance summaries always report `runtimeEnforced: false` and `enforcementStatus: pending_runtime`. M6 still requires a runtime supervisor, durable regional journal, restart-safe expiry guard, collector, and qualified stop/overshoot behavior. The accounting control API is deployed in Dev; live runtime accounting qualification remains pending. Region admission stays closed; these endpoints do not enable it.

Before issuing/replaying receipts, provision the dedicated `ALLOWANCE_FENCE_KEYS` Worker Secret with an AES-256-GCM keyring: `{ "active": "v1", "keys": { "v1": "<base64url encoding of 32 random bytes>" } }`. Use `pnpm exec wrangler secret put ALLOWANCE_FENCE_KEYS --config wrangler.jsonc` and keep required old key versions for retained receipt decryption. Never reuse provider credentials, the installation secret, or a public test-fixture key. Missing keys cause `503 fence_key_unavailable`; this secret is optional in generated bindings because unrelated API routes do not require it.

Use Workers Paid for supported larger settlements, or qualify an explicitly lower reference limit on Workers Free before deployment. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) currently permit 1000 queries per paid Worker invocation, 50 on Free, and 100 bound parameters per query; settlement reads and atomic guards grow with the accepted reference count, currently at most 32. This checkpoint does not establish full settlement-size compatibility on Free.

## Accounting development checkpoint

The [verified Dev checkpoint](../../docs/evidence/m3-usage-budget-authority-2026-09-28.md) records migrations `0006`–`0007` and the updated Worker deployment, preserved existing data, zero foreign-key violations, and closed regional admission. Live probes verified unknown-coverage empty JSON/NDJSON pages, separate meter/grantor issuance, rejection of ordinary budget writes, exact decimal grants, stale revision rejection, and requested pause/resume with runtime enforcement still false. The dedicated fence-key Worker Secret is configured privately.

No API-managed environment, accepted usage fact, or allowance receipt exists in this checkpoint. The live probes did not exercise actual usage ingestion, receipt encryption/decryption, settlement, correction, or PostgreSQL stopping. The local suite has 15 Worker cases and one Node case; the evidence records the initial typecheck failure and limited continuation rather than claiming a repeated or uninterrupted full gate. The full open-source v1 and M6 enforcement scope remains required.
