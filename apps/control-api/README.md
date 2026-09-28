# Control API

This Worker implements a generic `/v1` management API backed by one D1 database. It records organizations, registered regions, scoped API tokens, projects, immutable environment specifications, idempotency identities, audit operations, usage revisions, and budget/allowance authority. A project is a global logical container created immediately in D1. Its `active` status does not mean that a PostgreSQL cluster, database, credential, or connection endpoint exists. Database environments are separate resources executed through region-scoped leases. Registering a region alone neither admits environments nor provisions PostgreSQL.

## Operator setup

Create a D1 database in the adopter's Cloudflare account, copy `wrangler.example.jsonc` to `wrangler.jsonc` in this directory, and set its database name and ID to that database. `wrangler.jsonc` is ignored by Git. From this directory, apply the migrations with `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc` before serving requests. Configure a high-entropy `INSTALLATION_BOOTSTRAP_TOKEN` as a Worker Secret for this Worker, for example with `pnpm exec wrangler secret put INSTALLATION_BOOTSTRAP_TOKEN --config wrangler.jsonc`. The example configuration contains no account ID or secret. Keep all Worker configuration and any local development secret files in this directory; a parent directory's operator credentials are outside the Worker's configuration boundary. See Cloudflare's [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) documentation for operator details.

The separate `wrangler.test.jsonc` binds a disposable local D1 database. Its fixed ID and installation token are test fixtures only. Tests apply the real migrations in Miniflare through Cloudflare's Vitest plugin. Run the focused tests with `pnpm exec vitest run test/api.test.ts` from this directory.

## API behavior

Send `POST /v1/organizations` with `Authorization: Bearer <installation bootstrap token>` and JSON `{ "name": "..." }`. A successful response creates an organization and returns a random `cporg_...` API token with `projects:read`, `projects:write`, and `operations:read` scopes. D1 stores only its SHA-256 digest. The token is returned in this response only; store it securely at creation. The installation token is for organization bootstrap, not ordinary organization requests.

If the bootstrap response is lost after the database commits, use the installation token to call `GET /v1/organizations` and find the new organization. Results are newest first, with 1000 entries per page by default; `limit` accepts 1–1000. Follow each non-null `nextCursor` as the `cursor` query parameter until the target appears or `nextCursor` is null. The cursor advances by creation time and ID; concurrent creations or deletions can change later pages. Invalid pagination parameters return `400 invalid_request`. Then call `POST /v1/organizations/{organizationId}/tokens/reissue`. The response reveals a replacement token once and revokes every previously active token for that organization. A repeated reissue creates another replacement and invalidates the previous one; keep the final successful response. These installation routes never accept an ordinary organization token.

Organization, project, and environment JSON bodies are limited to 4096 UTF-8 bytes, including when the caller omits `Content-Length`. The installation-only catalog publication route allows 16384 bytes and at most 16 profiles; accounting routes allow 8192 bytes. Oversized or invalid bodies return `400 invalid_request` without buffering the full request.

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

The current slice has no public native endpoint, customer database credentials, environment listing/deletion/resize, runtime usage collector, runtime allowance enforcer, idempotency archival, or rate limiting. A reported ready environment means the regional executor observed PostgreSQL resource readiness; it does not prove backups, restore qualification, credential access, or a production service objective.

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

Catalog versions and persisted environment specs are immutable in D1, including database triggers that reject replacement. A duplicate version returns `409 catalog_version_conflict`; changing a profile requires a new version. Publishing a catalog leaves admission closed. The operator explicitly sends `PUT /v1/regions/{regionId}/admission` with `{ "catalogVersion": "...", "acceptingNewEnvironments": true }` only after the region passes qualification. `GET` on that admission route reads its current policy. Setting the flag to false closes new admission without cancelling previously accepted work. The API stores this operator decision; it does not independently prove backups or successful restore. The current lab's backup qualification remains incomplete and its admission must remain closed.

An organization token with `projects:read` can fetch `GET /v1/organizations/{organizationId}/regions/{regionId}/catalogs/{catalogVersion}`. Public catalog and environment responses omit `storageClassName`, backup endpoint/destination, and credential references. They include compute, volume limits, topology, and backup retention. Catalog/spec hashes identify the complete private execution snapshot; they cannot be recomputed from the redacted public representation.

## Environment creation and observation

Send `POST /v1/organizations/{organizationId}/projects/{projectId}/environments` with the organization's `projects:write` token, an `Idempotency-Key`, and exactly `name`, `regionId`, `catalogVersion`, `profileId`, and `volumeGiB`. Callers cannot supply an image, Kubernetes mapping, resource override, or secret reference. The project must be active and the selected version must currently admit new environments. There is no inferred region or adopter-specific default.

The `202` response contains a `pending` environment and a `queued` `environment.create` operation. A conditional D1 batch checks admission again and creates the environment, operation, and request identity atomically. It stores the complete normalized profile snapshot with `specRevision: 1` and SHA-256 of `JSON.stringify(spec)` in its persisted key order. A retry of the same request/key returns the same IDs and current state, including after a newer catalog is published or admission closes. A changed body or project path under the same organization's environment key returns `409 idempotency_conflict`. Environment keys are retained indefinitely in this slice and are separate from the logical-project key namespace.

Read `GET /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}` with `projects:read`, and use the existing organization operation GET to observe its audit state. `pending` means accepted, `provisioning` means a regional lease was claimed, and `ready` or `failed` is a fenced executor observation. The immutable requested configuration survives every transition. A foreign organization's valid token receives `404`. Recover a lost creation response through the same idempotent POST; environment collection listing is not implemented.

## Regional execution protocol

The [regional controller](../regional-controller/README.md) uses its region token for these private routes. Authorization and mutation decisions use a D1 session starting on the primary; no transaction is assumed to span D1 and Kubernetes.

1. `POST /v1/regions/{regionId}/operations/claim` with `{ "leaseSeconds": 60 }` atomically leases one queued or expired `environment.create` operation, or returns `{ "claim": null }`. Lease durations are 30–300 seconds. A successful claim includes operation/environment/region IDs, kind, a random `cplease_...` token, incrementing `leaseEpoch`, `leaseExpiresAt`, spec revision/hash, and the full private `spec`. D1 stores only the lease token's digest. Concurrent claimants cannot acquire the same active operation.
2. `POST /v1/regions/{regionId}/operations/{operationId}/renew` with `leaseToken`, `leaseEpoch`, and `leaseSeconds` extends an unexpired current lease. An expired or replaced epoch returns `409 lease_conflict`.
3. `POST /v1/regions/{regionId}/operations/{operationId}/result` submits `leaseToken`, `leaseEpoch`, `status`, `resultCode`, and `observation`. A ready result uses `status: ready`, `resultCode: cnpg_ready`, and `{ clusterUid, clusterGeneration, readyInstances }`; the count must reach the frozen profile's instance count. A failed result uses `status: failed`, `observation: null`, and `ownership_mismatch`, `spec_conflict`, or `reconcile_failed`. The operation and environment transition together in a conditional D1 batch. Stale, expired, and cross-region results cannot complete it. The identical terminal result under the same winning lease can be retried after a lost response; changing that result is a conflict.

The Worker trusts the authenticated executor's Kubernetes observations and does not independently probe Kubernetes. An executor must verify immutable ownership/spec identity, current CNPG generation, and actual owned PostgreSQL Pod readiness before reporting success. A controller restart or uncertain Kubernetes create must reconcile deterministic environment resources instead of creating another namespace. Private claims contain internal configuration and must not be returned to customer clients or written to public logs. A ready result issues no credentials or usable external endpoint in this slice.

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
