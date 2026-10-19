# Integrator handover

For the engineers of an integrator who create their databases on PGCF through its API and operate
them without reading PGCF code. You know PostgreSQL and Neon.
This runbook states what is different, which limits you must enforce yourselves and what is not
available yet.

Every statement is derived from the code and contracts of this repository; Appendix B lists where,
and Appendix C lists what the served OpenAPI document states in words rather than in schema.
Behaviour without a live acceptance is marked **not yet verified**. Values that are installation
configuration rather than code (region policy, alert thresholds) were read from the live
installation on 2026-10-15 and are labelled as such. Measured numbers carry their source in the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md#111-done), which is also
where PGCF publishes new ones. The plan's
[go-live gates](../architecture/cloudflare-convergence-and-serverless-plan.md#stage-7-go-live-gates) are the
authority on what still blocks go-live; operator procedures are in the other runbooks
([recovery](recovery.md), [credentials](credentials.md),
[infrastructure backups](infrastructure-backups.md)).

## Read first

| Topic                             | State on 2026-10-15                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                           | The Kubernetes runtime this handover describes was retired on 2026-10-17. No node executes databases until the Debian node runtime passes Stage 5 of the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md); this handover is rewritten in Stage 6.                                                                                                                       |
| First SQL after a wake from sleep | **8.1–9.4 s** through Cloudflare (Gate 0 rounds of 2026-10-12, standard runtime). The sub-second goal is **not met** yet: the pool of free PostgreSQL instances that targets it is live on EU1 since 2026-10-17, and its first live hit answered the first SaaS request after 1.09 s (Go-live path: _Cold request under one second_). See [3.4](#34-timeouts-and-retries-for-a-sleeping-database). |
| Redundancy                        | One customer node (EU1), one PostgreSQL instance per database, no replica, no second node. Losing EU1 stops every database until it is restored from R2 onto new capacity ([7](#7-failure-and-recovery)).                                                                                                                                                                                          |
| Capacity numbers                  | The density test that measures how many databases may be awake has not run (Go-live path: _Density on EU1_). The numbers in [4](#4-capacity-and-limits-you-must-enforce) are the arithmetic the admission code applies, not measured capacity.                                                                                                                                                     |
| New databases                     | Thin storage is live on EU1 and new databases are placed on Thin volumes; open defects of Thin starts and idle sleeps are listed in the ULTRA plan (go-live path and after go-live). When no node qualifies, `POST /v1/databases` and restores are still accepted and the database waits unplaced ([2.1](#21-create)).                                                                             |
| Alerts                            | Recorded, not delivered: no email recipient or sender is configured (Go-live path: _Alerts_). You receive no alerts from PGCF ([6](#6-alerts-and-operations)).                                                                                                                                                                                                                                     |
| Your key                          | Project-scoped key isolation and rotation have not been exercised live (Go-live path: _Integrator access and catalog_).                                                                                                                                                                                                                                                                            |
| Maintenance                       | Fleet patches reboot the single customer node and visibly interrupt databases. From the canary on the EU stack is production (`pgcf-api-dev` and `eu-dev` are only names): such reboots then need the owner's go and an announced window, but no announcement channel is defined ([7.1](#71-what-happens-in-each-situation)).                                                                      |

## 1. The model

### 1.1 One endpoint, two identifiers

All databases share one hostname, the `host` of every connection URI. The operator gives you the
real hostname of the installation; the examples in this runbook use `db.example.com`. There is no
TCP listener. The transport is a WebSocket that carries the
PostgreSQL wire protocol, as in Neon's serverless driver:
`wss://<host>/v2?database=<id>&user=<role>`. The Neon driver's HTTP query mode is served at
`https://<host>/sql` ([3.7](#37-http-query-mode-neon)). A `postgres://` TCP connection to the
hostname and any other path do not work.

A connection names its target twice, and both must agree:

| Where                                                  | Value                                               | Checked by                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Query string of the WebSocket URL                      | `database=<id>` and `user=<role>`, exactly one each | Edge Worker: refuses an unregistered database or role before any wake; once the database is awake it signs a route token that lives 30 s |
| `database` and `user` of the PostgreSQL StartupMessage | the same two values                                 | Regional gateway: comparison with the signed route; a mismatch ends with SQLSTATE `28000` before PostgreSQL is dialled                   |

`<id>` is the 20-character database ID the API returned (`^[a-z][a-z0-9]{19}$`, random, not derived
from the name). It is also the PostgreSQL database name. The `name` you give a database is an API
label, unique among the live databases of a project, and plays no role in routing. The `user` is a
role name from `GET /v1/databases/{id}/roles`; the owner role of every database is `app`.

The StartupMessage `database` parameter defaults to the user name when absent, so set it
explicitly (drivers do). `replication` startup parameters are refused (`0A000`).

### 1.2 Regions

A database lives on one node of one region, chosen at creation (`region_id`); there is no move
(node drain and move with kept IDs are open work). The hostname is the same for every region; the
Edge finds the region from the database's record.

The installation serves one region: EU. Its region ID is `eu-dev` (the Worker and region IDs carry
the name `dev`). `GET /v1/regions` with your key lists `{id, provider_region}` of the regions that
accept placement and nothing else about them: those with a node that is ready, schedulable, not
lost and open for new databases. A `us-dev` record still exists but the US region is cancelled
and has no usable node: it is not listed, and a database created there waits unplaced
indefinitely. Customer databases run only on EU1; the EU control server takes none.

### 1.3 Size classes

A size class fixes the resources and policies of a database. The operator defines classes
(`PUT /v1/size-classes/{id}`, admin); you read them with `GET /v1/size-classes` and pass the ID at
creation or resize. Disabled classes (`enabled: false`) are listed but refused.

| Field                                      | Bounds in the contract                                 | Meaning                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_mib`                               | 256 to 1,048,576 in steps of 256                       | PostgreSQL container limit; `effective_cache_size` is half of it; `shared_buffers` is a quarter of the region's PostgreSQL memory request |
| `cpu_millicores`, `cpu_request_millicores` | 100 to 256,000; request optional and at most the limit | CPU limit and scheduling request (the request defaults to the limit)                                                                      |
| `storage_gib`                              | 1 to 65,536                                            | Hard volume size                                                                                                                          |
| `max_connections`                          | 10 to 10,000                                           | PostgreSQL `max_connections`                                                                                                              |
| `sleep_after_seconds`                      | 60 to 2,592,000, or `null`                             | Idle time before hibernation of a database that sets none of its own; `null` is always warm                                               |
| `archive_timeout_seconds`                  | 30 to 3,600                                            | PostgreSQL `archive_timeout`: bounds how old unarchived WAL can get                                                                       |
| `backup_retention_days`                    | 1 to 3,650                                             | Barman retention window; also how long a deleted database stays restorable                                                                |

A class that databases reference cannot change its resources or policies (`409`); a class that a
resource profile revision references cannot change at all. New values need a new class.

**Resources of one database.** The class supplies a database's memory, CPU and storage, and an
**admin key** may give one database its own: in `resources` on `POST /v1/databases`, or with
`PUT /v1/databases/{id}/resources` (an integrator key gets `403`). Every `Database` reports the
values it runs with in `resources` (`memory_mib`, `cpu_millicores`, `storage_gib`). A `PUT` sets all
three fields, and `null` hands one back to the class. Memory is a multiple of 256 MiB up to the
region's per-database maximum; CPU is at least 100 millicores and at most the cores of the region's
largest node; storage is at least the database's current size and never shrinks. The change is a
resize ([2.5](#25-resize)), and a change of class keeps the database's own values. A restore
creates its database with the source's resources.

The API refuses a class whose memory exceeds the region's per-database maximum (`400`; 4,096 MiB
on this installation). It does **not** refuse a class that no node can host, for example a
`storage_gib` above the node's Thin per-database quota or a CPU request above the node's capacity:
creates of such a class are accepted and then wait unplaced. Ask the operator which classes are
placeable. The plan records eight enabled classes, six of them test classes, and a 256 MiB class
that keeps backups for one day; the owner has not yet approved the production catalog (Go-live path:
_Integrator access and catalog_).

### 1.4 Projects and keys

There are two key scopes:

|                                                                                            | Integrator key                                                                                              | Admin key                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Bound to                                                                                   | exactly one project                                                                                         | nothing                                                |
| Databases, roles, operations, archive summary, usage                                       | its own project; a resource of another project is reported as `404`, never `403`                            | all projects                                           |
| Connection URI                                                                             | **includes the role password**                                                                              | never includes a password (`includes_password: false`) |
| Size classes                                                                               | list                                                                                                        | list and define                                        |
| Regions                                                                                    | list `{id, provider_region}` of those that accept placement                                                 | list the full records, create, read                    |
| Projects                                                                                   | list and read its own; delete its own once it holds no live database (this also revokes the project's keys) | create, list, delete                                   |
| API keys, nodes, capacity policy, costs, operational health, infrastructure backups, fleet | `403`                                                                                                       | yes                                                    |

A key is `pgcf_sk_<12 characters>_<43 characters>`, sent as `Authorization: Bearer <key>`. PGCF
stores only an HMAC of it; the full key appears once, in the creation response. A lost response
means revoking the key and creating another.

**Obtaining a key.** You cannot mint your own. The operator creates a project and an integrator
key bound to it and hands you the key over a private channel (`external_id` carries your own
reference and must be unique among live projects):

```sh
# Operator, with an admin key
curl -sS -X POST "$PGCF_API/v1/projects" -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: project-$STABLE_ID" \
  -d '{"name":"<display name>","external_id":"<your reference>"}'
curl -sS -X POST "$PGCF_API/v1/api-keys" -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: key-$STABLE_ID" \
  -d '{"scope":"integrator","project_id":"<project-id>","name":"<label>"}'
```

**Rotating a key.** There is no self-service rotation and no expiry. The operator follows
[credentials](credentials.md#api-keys): create a second integrator key for the same project, you
deploy it, the operator revokes the first with `DELETE /v1/api-keys/{id}`. A revoked key answers
`401` at once. Idempotency keys are scoped to the API key that used them: settle in-flight
mutations before the switch, and do not expect a new key to replay an old key's
`Idempotency-Key`. Key expiry, last-use display, a read-only scope and bounded admin minting are
open work.

## 2. Lifecycle API

The machine-readable reference is `GET /v1/openapi.json` (no key needed). Its `info.version` is
the version of the API contract (`1.2.0` for this document): it changes when the contract changes
and not with a Worker release, which is named in `info.x-worker-version`. Rules a schema cannot
state are in descriptions ([Appendix C](#appendix-c-what-the-served-openapi-document-states-in-words)).
Its operation IDs are listed below. Examples assume:

```sh
export PGCF_API='https://<management-api-origin>'   # the operator tells you; it is not the database host
export PGCF_KEY='<integrator API key>'              # keep it in a secret store
pgcf() { curl -sS -H "Authorization: Bearer $PGCF_KEY" -H 'Accept: application/json' "$@"; }
```

### 2.0 Conventions

- **Bodies.** JSON, at most 64 KiB, `Content-Type: application/json` whenever there is a body.
  Request objects are strict: unknown fields are `400`. Success responses are closed objects too,
  and PGCF's own TypeScript client validates them strictly, so it must match the deployed Worker.
  Ignore unknown response fields in your client.
- **Timestamps** have exactly one form: UTC with three fractional digits and a literal `Z`
  (`2026-10-15T09:30:00.000Z`). `…:00Z`, `…:00.0Z` and `+00:00` offsets are `400`; the served
  OpenAPI gives the pattern.
- **Lists** take `limit` (1 to 100, default 50) and an opaque `cursor`, return
  `{ "data": [...], "next_cursor": string | null }` and are ordered newest first. The role list is
  not paginated (at most 100 roles, ordered by name).
- **Request IDs.** Send `X-Request-Id` (1 to 128 characters of `A-Za-z0-9._~-`) or receive a UUID;
  it is echoed, and `error.request_id` repeats it. Every response also carries a fresh
  `X-PGCF-Diagnostic-Id`. Quote both when you escalate ([7.6](#76-escalation)).
- **Asynchronous writes** return `202` with `{database, operation}` (restore: `{target_database,
operation}`) and `Location: /v1/operations/{id}`.
- **Idempotency.** Send `Idempotency-Key` (`^[A-Za-z0-9._~-]{1,128}$`) on every mutation, generate
  it once per logical operation and persist it with your intent before sending. It is
  **required** (`400` without it) on creating, resizing, deleting, suspending, resuming and
  restoring a database, on assigning a resource profile and on creating, resetting and deleting a
  role; the served document marks it required on exactly these routes. The same key with the same
  method, path and JSON body returns the retained result (for database operations the original
  operation, read fresh); the same key with another request is `409 idempotency_conflict`; while
  the first call still runs it is `409 idempotency_in_progress`. A request that fails is not
  cached: a retry with the same key executes again. Keys are kept for 24 hours per API key. `GET`
  needs none. Never retry a mutation under a new key after an uncertain response.
- **Refusals and retries.** Every error body is `{error: {code, message, request_id, details?}}`.
  Where one code stands for several causes, `error.details.reason` names the cause from a closed
  set; switch on it and never on the message, which may change. A refusal that can clear by
  itself carries a `Retry-After` header in seconds (a hint, not a promise): the retryable reasons
  and `capacity_exhausted` and `idempotency_in_progress`. The reasons are listed in
  [A.1](#a1-http).
- **Client library.** `PgcfClient` in `packages/contracts/src/client.ts` is workspace-only (the
  package is private and not published) and strict about response shapes; call the HTTP API
  directly or vendor it. It uses a 30 s timeout by default and never retries a write.

| Operation ID                                                  | Call                                                  | Notes                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDatabase`                                              | `POST /v1/databases`                                  | 202                                                                                                                                                                                                                     |
| `listDatabases`                                               | `GET /v1/databases`                                   | filters `project_id`, `region_id`, `node_id`, `desired_state`, `observed_state` and `name` (exact, case-sensitive; unique among the live databases of a project, so one match inside your project); excludes deleted    |
| `getDatabase`                                                 | `GET /v1/databases/{id}`                              | also returns a deleted database (`desired_state: deleted`)                                                                                                                                                              |
| `resizeDatabase`                                              | `PATCH /v1/databases/{id}`                            | body `{size_class_id}` only; no rename                                                                                                                                                                                  |
| `setDatabaseResources`                                        | `PUT /v1/databases/{id}/resources`                    | admin key only (`403` otherwise); body `{memory_mib, cpu_millicores, storage_gib}`, each a value or `null` for the size class's ([1.3](#13-size-classes)); 202 with the operation, a resize; `Idempotency-Key` required |
| `setDatabaseIdleTime`                                         | `PUT /v1/databases/{id}/idle-time`                    | body `{sleep_after_seconds}`; 200 with the database, no operation ([3.5](#35-idle-sleep-and-wake-on-connect)); `Idempotency-Key` required                                                                               |
| `deleteDatabase`                                              | `DELETE /v1/databases/{id}`                           | 202                                                                                                                                                                                                                     |
| `suspendDatabase`, `resumeDatabase`                           | `POST /v1/databases/{id}/suspend`, `/resume`          | 202                                                                                                                                                                                                                     |
| `restoreDatabase`                                             | `POST /v1/databases/{id}/restore`                     | 202, creates a new database                                                                                                                                                                                             |
| `listDatabaseRoles`, `createDatabaseRole`                     | `GET`, `POST /v1/databases/{id}/roles`                | at most 100 roles; optional `valid_until`, `connection_limit`, `member_of`, `bypass_rls` ([2.3](#23-roles-connection-uri-and-passwords)); `Idempotency-Key` required                                                    |
| `resetDatabaseRolePassword`                                   | `POST /v1/databases/{id}/roles/{name}/reset-password` | `Idempotency-Key` required                                                                                                                                                                                              |
| `deleteDatabaseRole`                                          | `DELETE /v1/databases/{id}/roles/{name}`              | 202, operation `database.role.delete` ([2.3](#23-roles-connection-uri-and-passwords)); `Idempotency-Key` required                                                                                                       |
| `getDatabaseConnectionUri`                                    | `GET /v1/databases/{id}/roles/{name}/connection-uri`  | password included for integrator keys                                                                                                                                                                                   |
| `getDatabaseOperation`                                        | `GET /v1/operations/{id}`                             |                                                                                                                                                                                                                         |
| `listDatabaseOperations`                                      | `GET /v1/databases/{id}/operations`                   | newest first, the view of `getDatabaseOperation`; also the operations PGCF starts itself; a deleted database stays listable                                                                                             |
| `listRegions`                                                 | `GET /v1/regions`                                     | `{id, provider_region}` of the regions that accept placement ([1.2](#12-regions))                                                                                                                                       |
| `getDatabaseArchive`                                          | `GET /v1/databases/{id}/archive`                      | counts only                                                                                                                                                                                                             |
| `getDatabaseBackups`                                          | `GET /v1/databases/{id}/backups`                      | the restorable window and the restorable base backups ([2.7](#27-backups-restorable-window-and-restore))                                                                                                                |
| `getUsage`                                                    | `GET /v1/usage`                                       | [5](#5-metering)                                                                                                                                                                                                        |
| `listSizeClasses`                                             | `GET /v1/size-classes`                                |                                                                                                                                                                                                                         |
| `listProjects`, `getProject`, `deleteProject`                 | `/v1/projects`, `/v1/projects/{id}`                   |                                                                                                                                                                                                                         |
| `getDatabaseResourceProfile`, `assignDatabaseResourceProfile` | `GET`, `PUT /v1/databases/{id}/resource-profile`      | operator-defined profile revisions; an assignment is a resize                                                                                                                                                           |

### 2.1 Create

```sh
KEY="create-$(uuidgen)"   # persist with your intent; reuse for every retry of this creation
pgcf -i -X POST "$PGCF_API/v1/databases" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"project_id":"<project-id>","region_id":"<region-id>","name":"orders","size_class_id":"<size-class-id>"}'
```

What happens: the database record (generation 1), the owner role `app` with a server-generated
password and an internal maintenance role (`pgcf_maintenance`, reserved) are written; the
placement step picks the node that is the fullest of those that stay under 80 % active RAM and 80 %
CPU load, each as the highest 30-minute average of the last seven days, and whose thin pool is
open (data below 80 %, metadata below 50 %, sold storage within four times its data). A database
placed in the last 30 minutes counts at its full memory until its own average exists. The first base backup is
requested at once and WAL archiving starts with the first start. The idle time
(`effective_sleep_after_seconds`) counts from readiness.

- Ready means the operation is `succeeded`, the database `observed_state` is `ready` and
  `observed_generation` equals `generation`. Poll `GET /v1/operations/{id}`; the database stays
  `pending` or `provisioning` until then. Connecting earlier returns `57P03` immediately.
- Measured on EU1 (the plan's "EU acceptance" row, thick storage, standard runtime): ready in
  30.7 s, first SQL through Cloudflare 0.57 s, base backup and WAL in R2 after 20.7 s. On Thin
  storage (Go-live path: _Thin acceptance_, 2026-10-15) a create took 260.4 s to ready, first SQL
  through Cloudflare 0.93 s and base backup and WAL in R2 84.5 s.
- **No capacity.** If no node qualifies, the call still returns `202`: `node_id` is `null`,
  `observed_state` is `pending` and `status_message` is `Waiting for verified regional capacity`.
  A minute cron places it when capacity appears (for example when another database hibernates).
  This wait has no timeout of its own (every other operation fails with `operation_timeout` after
  20 minutes without progress); set your own deadline and delete the database to cancel.
- Errors: `400` for an unknown or disabled class or region, `404` for an unknown project, `409`
  with reason `name_in_use` for a name that a live database of the project already uses.
- Engine: PostgreSQL 18 (18.6 at the time of writing, unmodified engine, `pgvector` 0.8.7). Which
  other extensions the owner role may create is **not yet verified**.

### 2.2 Operations and readiness

`GET /v1/operations/{id}` returns `{id, kind, status, database_id, generation, error, ...}`.

| `status`             | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `pending`, `running` | accepted; the regional controller has not finished                             |
| `succeeded`          | the observed state matches the intent                                          |
| `failed`             | `error.code` and `error.message` say why; see [A.3](#a3-operation-error-codes) |

Poll with a short interval at first and a longer one afterwards; there is no event stream or
webhook (open work). Kinds you start: `database.create`, `database.restore` (it belongs to the new
database), `database.delete`, `database.resize`, `database.suspend`, `database.resume`,
`database.role.delete`. PGCF starts `database.hibernate` (idle sleep) and `database.wake` (a
connection) itself; they appear in `GET /v1/databases/{id}/operations` like any other.

The `Database` object: `desired_state` (`running`, `suspended`, `deleted`), `observed_state`
(`pending`, `provisioning`, `hibernated`, `ready`, `error`, `deleting`, `deleted`),
`suspension_reason` (`manual`, `idle`, `null`), `generation` and `observed_generation` (a changed
configuration is applied when they are equal), `status_message`, `node_id` (`null` while
unplaced), `health` and `storage`:

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.archiving` | `ok`, `failing`, `unknown`, with `since`                                                                                                                                                                                                                                                                                                        |
| `health.backup`    | `status` is `ok` while the last completed base backup is at most 36 h old, `stale` when older, `failing` when the region reports failing or its last failure is newer than its last completion, `unknown` without a report within 180 s or without a completed backup; `last_base_backup_at` is when that backup finished, `null` while unknown |
| `health.disk`      | `status` is `warning` from 90 % used and `unknown` without a usage sample within 180 s; `used_ratio` is used divided by allocated bytes of the newest sample, `null` when it measured nothing                                                                                                                                                   |
| `storage`          | `{used_bytes, allocated_bytes, observed_at}` of the newest sample the region's agent reported, with `null` figures where it measured nothing; the whole object is `null` before the first sample. It is not cut off by age: judge `observed_at` yourself                                                                                        |

`null` and `unknown` mean not known, never fine and never zero. These are the very figures the
operator reads in `GET /v1/operational-health?scope=databases`: one source, two views.

### 2.3 Roles, connection URI and passwords

```sh
pgcf -X POST "$PGCF_API/v1/databases/<database-id>/roles" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d '{"name":"web"}'
pgcf "$PGCF_API/v1/databases/<database-id>/roles/web/connection-uri"
# {"database_id":"...","role":"web","host":"db.example.com","database":"<database-id>",
#  "uri":"postgres://web:<password>@db.example.com/<database-id>","includes_password":true}
```

- `app` is the database owner and not a superuser (the acceptance probe asserts
  `rolsuper = false`). Roles you add are login roles without superuser, `createdb`,
  `createrole` or replication; `bypassrls` only when you ask for it (below). Grant them
  privileges with SQL as `app`. Role names match `^[a-z][a-z0-9_]{0,62}$` and may not be
  `postgres`, `streaming_replica`, `pg_*`, `cnpg_*` or `pgcf_maintenance`. There is no API to
  choose a password.
- Passwords are 43 characters of base64url, server-generated. Only an integrator key can read one,
  and only through the connection URI. `reset-password` replaces it (`password_revision` + 1).
- Creating, resetting and deleting a role require an `Idempotency-Key` (`400` without one).
- After `POST /roles` returns `201`, or `reset-password` returns `200`, the role is registered but
  the change reaches PostgreSQL with the database's next configuration pass. Wait until
  `observed_generation == generation` before connecting as the new role (earlier: `57P03`). A
  hibernated database applies it at its next wake.
- The URI has no port and no `sslmode`; see [3.1](#31-driver-configuration) for how to use it.

**Attributes at creation.** All are optional; a role created without them is the plain login role
of before. None can be changed afterwards (there is no `PATCH`): delete the role and create it
again.

```sh
pgcf -X POST "$PGCF_API/v1/databases/<database-id>/roles" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"name":"report_a1b2c3","valid_until":"2030-01-01T10:00:00.000Z","connection_limit":5,"member_of":["reader"]}'
```

| Field              | Meaning                                                                                                                                                                       | Limits                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid_until`      | PostgreSQL `VALID UNTIL`: from this time the role cannot log in                                                                                                               | a [timestamp](#20-conventions) in the future when the request executes, no maximum; PostgreSQL applies it at whole seconds, truncated, so `…:05.678Z` expires at `…:05.000Z` and a value whose whole second has already begun is refused with `400` |
| `connection_limit` | PostgreSQL `CONNECTION LIMIT`: concurrent sessions of the role; one more gets `53300` "too many connections for role"                                                         | 1 to 10,000; omitted means unlimited                                                                                                                                                                                                                |
| `member_of`        | the role is a member of these roles and inherits their privileges (`INHERIT`; `SET ROLE` to them stays possible, as for any PostgreSQL membership)                            | at most 8 distinct live roles of this database; never `app`, `pgcf_maintenance`, `pg_*`, `cnpg_*` or the role itself; otherwise `400`                                                                                                               |
| `bypass_rls`       | PostgreSQL `BYPASSRLS`: the role ignores row-level security policies, also `FORCE ROW LEVEL SECURITY`; it still needs table privileges. Typical use: an export or backup role | boolean, default `false`                                                                                                                                                                                                                            |

`GET /v1/databases/{id}/roles` returns all four on every role (`null`, `[]`, `false` when not
set). A role past its `valid_until` stays listed and counts toward the 100 roles until you delete
it; its connection URI is still readable but a connection with it is refused. Expiry stops new
logins only: **a session that is already open is not ended by it**. Delete the role to end its
sessions.

**Expired credentials.** The Edge refuses a role past `valid_until` with `28P01` before it would
wake a hibernated database or spend connection budget, exactly the SQLSTATE PostgreSQL answers an
expired password with ([A.4](#a4-sqlstate-at-connect-time)); it refuses from the start of the
whole second the expiry falls in, the instant PostgreSQL enforces for anything that reaches it.

**Deleting a role.**

```sh
pgcf -i -X DELETE "$PGCF_API/v1/databases/<database-id>/roles/report_a1b2c3" \
  -H "Idempotency-Key: del-$KEY"
# 202 {"database":{...},"operation":{"id":"op_...","kind":"database.role.delete","status":"pending",...}}
```

- **Unroutable at once.** From the moment the request is accepted the role is no longer listed, its
  connection URI is `404`, and the Edge answers `28P01` to a new connection. A route token issued
  just before lives up to 30 s. The region then sets the role to `NOLOGIN`, ends its sessions and
  drops it; the operation is `succeeded` when PostgreSQL has confirmed that. Sessions that are open
  at the time are ended once the role is `NOLOGIN`: do not rely on one surviving the deletion.
- **A role that owns objects cannot be dropped.** If it owns objects or holds privileges
  (including default privileges), PostgreSQL refuses `DROP ROLE`: the operation ends `failed` with
  `error.code` `role_not_droppable`, and the role **stays unable to log in and unroutable**. To
  prevent it, connect as the role while it is live and run `DROP OWNED BY CURRENT_USER` (or drop
  its objects as `app`, which owns the `public` schema, and `REVOKE` what it holds) before
  deleting it. Afterwards `DELETE` the role again under a new `Idempotency-Key` (the old key
  replays the failed operation): a failed removal starts a new operation, and the region drops the
  role as soon as nothing depends on it. The old operation stays `failed`.
- **The name** is free again only when the removal is confirmed; creating it earlier is `409` with
  reason `role_being_deleted`. A role awaiting its removal counts toward the 100 roles
  (`role_limit`).
- **Hibernated database.** A suspended or idle-hibernated database has no PostgreSQL running, so the
  region applies the removal at its next wake. The operation reports `succeeded` at once because
  the role is already unroutable, **before** PostgreSQL has dropped it (a removal still waiting
  when a running database goes to sleep ends the same way); if the drop then fails (the role owns
  objects) the failure is not reported through that operation. To observe the outcome,
  `resume` the database and, once it is running, `DELETE` the role again under a new key: that
  starts a new operation which succeeds when PostgreSQL has dropped the role, or fails with
  `role_not_droppable`; once the removal is complete the role is gone (`404`).
- **Repeats.** Another `DELETE` of a role whose removal is still running, or whose operation
  completed for a database that still is not running, returns the same operation, without a new
  generation. After a removal was confirmed the role is `404`.
- **Refusals.** `400` for the owner `app` and `pgcf_maintenance`; `404` for an unknown role;
  `409` for a role that other live roles are `member_of` (`role_has_members`: delete the members
  first). Deleting a database ends a pending removal with `superseded`.

### 2.4 Suspend and resume

`POST /v1/databases/{id}/suspend` is a **manual** suspension: connections are refused with `57P03`
until `POST /v1/databases/{id}/resume`. A connection never wakes a manually suspended database.
The database must be `ready` (`409 "Database configuration is not ready"` otherwise). The sequence
stops new work, closes idle sessions, forces the last WAL segment into R2 and removes the
PostgreSQL Pod; the volume stays. If sessions are busy, a prepared transaction exists or the
archive does not drain, the operation fails with `power_busy` or `power_archive` and the database
keeps running: drain your pools first. Suspending an already suspended database returns its
existing operation.

`resume` also works as a **pre-wake** of an idle-hibernated database: it is the supported way to
wake before traffic (poll the operation, then run `SELECT 1`). When the node cannot take the
start (no report within 180 s, no room in its thin pool, or less memory available than the
database's memory plus the node's 600 MiB floor), `resume` answers `409 conflict` with reason `node_capacity` and `Retry-After: 30`: retry later or
free capacity. A `409` with reason `generation_changed` is a change that raced the request and is
retried at once.

### 2.5 Resize

`PATCH /v1/databases/{id}` with `{"size_class_id": "<class>"}`.

- A running database moves to the new limits by replacing its Pod, so its sessions end. One
  earlier Dev resize to 512 MiB and 250 m took 28 s with data and volume unchanged. A
  hibernated database changes immediately and starts on the new class at its next wake.
- The target class must be enabled and within the region's memory maximum. A running database that
  grows must fit the node now, else `503 capacity_exhausted` ("Current node has insufficient
  memory, CPU or storage"): its active RAM would reach 80 % with the extra memory, its CPU would
  exceed the node's cores, or its storage would take the node's sold storage past four times its
  pool. A smaller or equal size needs no room, and a hibernated database takes any size at once and
  needs room at its next wake.
- Storage may only grow; shrinking is `400` ("Storage shrink is not supported"). Growth through the
  API is **not yet verified live**.
- The operator can roll a new revision of a resource profile out to every database assigned to
  it; that changes your database's `size_class_id` (a hibernated one at its next wake). Read it
  with `GET /v1/databases/{id}/resource-profile`.

### 2.6 Delete

`DELETE /v1/databases/{id}` returns `202`; the PostgreSQL volume is reclaimed and the database
record ends as `observed_state: deleted` (the plan's EU acceptance row measured delete and storage
reclaim in 93.3 s). The name is free at once. The backup archive is **retained** for the class's
`backup_retention_days`; the database stays restorable until `deleted_at + backup_retention_days`
(the API does not return that date). Role credentials and attributes are retained with it; a role
awaiting its removal is not. A project can be deleted only after all its databases have finished
deleting. Retained archives are removed by a cron after expiry.

A `409 conflict` from `DELETE` deletes nothing. Reason `mutation_in_progress` means another change
to the same database holds it at that moment: a wake, an idle sleep or its compensation, or a
regional maintenance step. Retry with backoff and
jitter (for example 1 s, 2 s, 4 s, up to about two minutes) under the same `Idempotency-Key`;
`Retry-After` gives the first delay. Reason `generation_changed` means another request changed the
database first (for example deleted it); the retry returns that deletion's operation.

### 2.7 Backups, restorable window and restore

**What exists.** Each database archives WAL continuously to R2 (gzip) through the Barman Cloud
plugin and takes a base backup right after creation and daily at 03:00 (cron `0 0 3 * * *` of the
CloudNativePG controller; its time zone is **not yet verified**). A hibernated database is not
backed up (CloudNativePG cannot back up a hibernated cluster); the hibernation sequence archives
its last WAL first. Retention is `backup_retention_days` as a Barman recovery window. How
retention behaves for a database that sleeps through its whole window is **not yet verified**.

**What the API shows.** `GET /v1/databases/{id}/backups` reads the window a restore can reach and
the base backups it can start from, from the very catalog the restore reads:

```sh
pgcf "$PGCF_API/v1/databases/<database-id>/backups"
# {"database_id":"...","earliest_restorable_time":"2026-10-14T03:00:41.000Z",
#  "latest_restorable_time":"2026-10-15T09:41:07.000Z",
#  "base_backups":[{"id":"20261015T030000","started_at":"2026-10-15T03:00:00.000Z",
#                   "completed_at":"2026-10-15T03:00:38.000Z"}, ...]}
```

- `earliest_restorable_time` is the end time of the oldest base backup whose data and WAL chain
  are complete: the end of the first base backup for a young database, afterwards about
  `backup_retention_days` back; no `pitr` target before it can be restored;
- `latest_restorable_time` is when the newest archived WAL segment was uploaded, an **upper
  bound**: a `pitr` target after the last commit in the archive fails recovery, and `full`
  restores everything archived;
- `base_backups` lists only restorable backups, newest first, at most 64 (the bound of the
  catalog); one without its WAL chain is not restorable and is not listed.

Both times are `null`, with no base backups, while the archive holds no complete base backup (a
database younger than its first one), cannot be read completely (the catalog reads at most 16,000
objects), or belongs to a deleted database past its retention. `null` means unknown. A deleted
database inside its retention is read like a live one.
`GET /v1/databases/{id}/archive` returns only `{base_backup_count, wal_count, bytes}`, and
`health.archiving` on the database says whether archiving works.

**Restore** never overwrites. It creates a **new database**:

```sh
pgcf -i -X POST "$PGCF_API/v1/databases/<source-id>/restore" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"mode":"pitr","name":"orders-restored","target_time":"2026-10-15T09:30:00.000Z"}'
# {"target_database":{"id":"<NEW id>", ...},"operation":{"id":"op_...","kind":"database.restore",...}}
```

`mode` is `full` (newest complete base backup plus all archived WAL) or `pitr` (`target_time`, not
in the future). `region_id` is optional; a region other than the source's own needs a source-read
relationship that the operator configures (not applicable with one region).

**The ID mapping you must keep.**

|                                                                                                     | Source        | Restored target                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database ID and PostgreSQL database name                                                            | `<source-id>` | **new** `<target-id>`                                                                                                                                                                                         |
| `name`                                                                                              | the old label | the `name` of the request; it must differ from every live database of the project (`409` otherwise)                                                                                                           |
| Project, size class, region                                                                         |               | the same (region unless `region_id` is given)                                                                                                                                                                 |
| Role names, passwords and attributes (`valid_until`, `connection_limit`, `member_of`, `bypass_rls`) |               | the same names, passwords and attributes registered at the time of the call (from the retained record for a deleted source); a role awaiting its removal is not copied, and an expired role is copied expired |
| Data, grants, sequences                                                                             |               | from the backup, as of `target_time` or the end of the archive                                                                                                                                                |

The source keeps running until you delete it. Persist `source_id -> target_id`, the restore
operation ID and its idempotency key. To switch, read the target's connection URI, make your pool
use the new ID in both the connection string and the `wsProxy` hints, drain the old pool and
delete the old database when you are done. Once writes reach the target, do not switch back to
the source without reconciling them. A stale ID fails with `28P01` ([A.4](#a4-sqlstate-at-connect-time)).

The restore is ready when its operation is `succeeded`: recovery has promoted, roles and settings
match and the temporary restore administrator is gone. Compare your markers before cutover.

| `409` reason         | Meaning                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `archive_expired`    | deleted source past `deleted_at + backup_retention_days`, or its cleanup has begun                                                         |
| `no_recovery_point`  | no complete base backup ends at or before `target_time`, or its WAL chain has a gap                                                        |
| `archive_unusable`   | the v1 catalog reads at most 16,000 objects and 64 base backups per database, and the listing was incomplete, invalid or beyond that bound |
| `name_in_use`        | a live database of the project already has the target `name`; choose another                                                               |
| `source_unavailable` | the source's class is disabled, its region record is gone or its credentials are unavailable                                               |
| `region_unavailable` | the `region_id` of the request names no region                                                                                             |
| `generation_changed` | the source, its retained archive or the placement changed under the request; retry                                                         |

A restore needs capacity like a create; without it the target waits unplaced and the operation
stays `pending`. Restore duration is **not measured**: the plan records no recovery time.

## 3. Connecting

### 3.1 Driver configuration

Use the Neon serverless driver's WebSocket mode. The driver version PGCF's own acceptance suite
runs is `@neondatabase/serverless` 1.2.0 (`scripts/e2e/probe/worker.ts` is the reference):

```ts
import { Client, Pool } from "@neondatabase/serverless";
// Outside Workers (Node) also: neonConfig.webSocketConstructor = WebSocket from the "ws" package

const target = new URL(connectionUri); // from GET .../connection-uri
const database = decodeURIComponent(target.pathname.slice(1)); // the 20-character ID
const user = decodeURIComponent(target.username);

const pool = new Pool({
  connectionString: connectionUri,
  max: 10, // well below the size class's max_connections
  connectionTimeoutMillis: 70_000, // 3.4: the Edge waits up to 60 s for a wake
  idleTimeoutMillis: 30_000,
});
pool.on("error", () => {
  /* an idle client was closed, for example "database sleeping"; the next query reconnects */
});
pool.Client = class extends Client {
  constructor(config?: ConstructorParameters<typeof Client>[0]) {
    super(config);
    this.neonConfig.useSecureWebSocket = true; // wss
    this.neonConfig.forceDisablePgSSL = true; // TLS is the WebSocket; see 3.3
    // pipelineConnect keeps its default "password" and coalesceWrites its default true; see below
    // The driver prepends wss://; return host and path only, with both hints.
    this.neonConfig.wsProxy = (host) =>
      `${host}/v2?${new URLSearchParams({ database, user })}`;
  }
};
```

Keep the driver's defaults `pipelineConnect: "password"` and `coalesceWrites: true`: the driver
then sends the StartupMessage, the password and the first query in one WebSocket message. The
gateway answers AuthenticationCleartextPassword, logs in to PostgreSQL with SCRAM-SHA-256 inside
the cluster and sends AuthenticationOk through ReadyForQuery as one message, so a new connection
needs one round trip after the upgrade instead of four, also after a wake: a sleeping database's
connection is asked for its password while it waits. The gateway decides from the message that
carries the StartupMessage, so pass the password as a string (a password function must not wait
for anything). `pipelineConnect: false` still works and authenticates with SCRAM end to end, at
three more round trips per connection. A TCP DSN with only the hostname replaced is not enough.
For HTTP query mode (`neon()`) see [3.7](#37-http-query-mode-neon).

For `psql` and migration tools build the CLI (`pnpm --filter @pgcf/cli build`) and run
`node packages/cli/dist/main.js connect --endpoint wss://db.example.com --database <id> --user <role>`;
use the printed loopback port with `host=127.0.0.1` and `sslmode=disable`. The CLI never retries
SQL and allows 16 local connections.

### 3.2 What the gateway does and does not support

- One WebSocket is one dedicated PostgreSQL backend and there is no server-side pooler: session
  state (prepared statements, temporary tables, advisory locks, `LISTEN`) is ordinary PostgreSQL
  session state and ends with the connection, also when the database sleeps. None of these is
  separately verified by PGCF's acceptance.
- Cancel requests are not supported (the gateway closes such a connection); use
  `statement_timeout` and `pg_cancel_backend()` from another session.
- `replication` connections and logical replication are refused. Frames are binary; text
  WebSocket frames are refused.
- Text-format results are what the acceptance suite verifies. Decoded binary-result assertions
  failed in the earlier Dev acceptance on WebSocket and on direct TCP with node-postgres 8.22; do
  not rely on binary result formats until that is closed.
- One WebSocket message may be up to 32 MiB; the gateway sends frames of at most 64 KiB. `COPY`
  works over the same connection (an earlier Dev acceptance passed a 105 MB binary `COPY`
  integrity check through the CLI).
- The gateway pings every 30 s and drops a connection that misses a pong; ordinary WebSocket
  stacks answer automatically.
- The StartupMessage must arrive within 10 s of the upgrade and is at most 10,000 bytes. A
  password pipelined with it is a PasswordMessage of at most 4,096 bytes; an empty, oversized or
  wrong one, an unknown role and an unknown database are all answered with the same `28P01`.
- The gateway logs in with a pipelined password (and over HTTP) only to a PostgreSQL that asks for
  SCRAM-SHA-256 with at most 100,000 iterations (PostgreSQL's default `scram_iterations` is
  4,096), or for no password; anything else answers `08006` and never receives the password.

### 3.3 TLS

Three hops, none of them optional: your client to Cloudflare over `wss` (Cloudflare terminates TLS
for the hostname); Cloudflare to the regional gateway with a signed, 30-second route
token; gateway to PostgreSQL over TLS verified against the database's own CA and its exact
service name (`pg_hba` rejects non-TLS connections). The gateway answers a PostgreSQL
`SSLRequest` or GSS request with `N`, so a client that requires protocol-level TLS (`ssl: true`,
`sslmode=require`) fails; the WebSocket is the encryption. A password pipelined with the
StartupMessage travels inside that WebSocket to the gateway, which proves it to PostgreSQL with
SCRAM-SHA-256 and continues only after PostgreSQL's server signature matches; the gateway never
logs or stores the password and zeroizes it after the login. Without a pipelined password
(`pipelineConnect: false`, the CLI) SCRAM runs between your client and PostgreSQL, and PGCF's
Edge and gateway only relay it.

### 3.4 Timeouts and retries for a sleeping database

Measured wake times through Cloudflare (standard runtime, CNPG hibernation):

| Series                                                      | First row after connect                      |
| ----------------------------------------------------------- | -------------------------------------------- |
| Gate 0, 3 cold wakes, 2026-10-12, retained 1 GiB database   | **8.1–9.4 s**                                |
| The same wake before the wake orchestration (R1.2 baseline) | 9.6–11.2 s                                   |
| Earlier 20-wake series (p50 / p95 / max)                    | 8.4 / 9.2 / 9.7 s                            |
| Already awake database, first row                           | 0.47–0.96 s (0.54–0.61 s in the warm rounds) |

**The sub-second goal is not met yet.** The path to it is the pool: a cold
database's volume is attached to an already running, free PostgreSQL instance on its node, so the
next connection does not wait for a new Pod. Its first live hit through Cloudflare (2026-10-17)
answered the first SaaS request after 1.09 s; p95, misses and databases idle for an hour are not
measured yet (Go-live path: _Cold request under one second_). A wake that finds no free instance
takes the hibernated wake above. PGCF publishes the result only in the ULTRA plan's Done table, as the
first row measured stage by stage from one start, with every run labelled hit or miss (demoted,
hibernated); update this section from that row when _Sub-second wake_ closes.

What the Edge does: it waits at most **60 s** for a wake (`ADMISSION_DEADLINE_MS`), coalesces all
connections of one database into one wake and admits at most 32 waiters per database. Giving up
removes your waiter only; the wake itself continues, so a retry soon after normally finds the
database ready.

Recommended policy (derived from those numbers, not a PGCF guarantee):

| Setting                                           | Value                                                                                                                                           | Reason                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect timeout                                   | at least 65 s; 70 s used above                                                                                                                  | 60 s Edge deadline plus login and startup (0.1–0.4 s); a cold Thin wake without a free pool instance takes about 22 s, a pool hit about 1.1 s |
| Statement timeout                                 | separate from the connect timeout                                                                                                               | a connect timeout does not bound a query                                                                                                      |
| Retry `57P03`, `08006`, `53300`                   | exponential backoff with jitter: 1 s, 2 s, 4 s, then 8 s, for about 90 s in total                                                               | transient by definition                                                                                                                       |
| Retry `28P01`, `3D000`, `28000`, `0A000`, `08P01` | never                                                                                                                                           | configuration or credentials; fix, do not loop                                                                                                |
| After a dropped connection                        | reconnect; never replay a write unless it is idempotent                                                                                         | PGCF never replays SQL; whether an in-flight `COMMIT` took effect is unknown to you and to PGCF                                               |
| Latency-sensitive paths                           | pre-wake with `POST /resume`, keep the database awake longer (`sleep_after_seconds`), or use an always-warm class (`sleep_after_seconds: null`) | removes the wake from the request                                                                                                             |

A `57P03` that arrives immediately, in well under a second, is not a wake timeout. At the 60 s
mark the Edge aborts the admission and answers `08006` ("connection admission interrupted"); the
Actor's own deadline answers `57P03` and can win that race. To tell the causes apart read
`GET /v1/databases/{id}`:

| `desired_state` / `observed_state` / `status_message`                | Cause                                                                                                                                                                                           | Action                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `suspended`, `suspension_reason: manual`                             | manual suspension                                                                                                                                                                               | `POST /resume`                |
| `running`, `pending` or `provisioning`                               | creation, restore, resize or resume in progress                                                                                                                                                 | poll the operation            |
| `running`, `node_id: null`, `Waiting for verified regional capacity` | no node fits yet                                                                                                                                                                                | wait; set a deadline          |
| `error`                                                              | the regional controller reports a failure                                                                                                                                                       | escalate                      |
| `hibernated` (idle) and `57P03` at once                              | the wake could not start: no fresh memory sample, `MemoryPressure`, no CPU, RAM or storage headroom (the usual causes), a lost node, or an admission change in flight; no wake operation starts | back off and retry; shed load |

### 3.5 Idle sleep and wake on connect

A database hibernates when it has had **no busy session and no client activity for
`effective_sleep_after_seconds`**: its own `sleep_after_seconds` (60 to 900, set on create or with
`PUT /v1/databases/{id}/idle-time`; `null` hands it back to the class), else its class's; a class
with `null` is always warm (`effective_sleep_after_seconds` is then `null`). The `PUT` is accepted
in every state but deleted, also during a resize; it creates no operation and no new generation,
and the value applies from the next idle check. A session is busy while
it is authenticating, in a transaction (including `idle in transaction`), running a statement, in
`COPY`, or when its state is uncertain; a prepared transaction also stops the sleep (`power_busy`).
A merely open, idle connection is not busy and does not keep the database awake: the gateway
closes it with WebSocket close code 1000 and reason `database sleeping` when the database goes
down. Pools must treat that as a server disconnect and reconnect. Bound
`idle_in_transaction_session_timeout` on your roles, or a forgotten transaction pins the database
awake.

The first connection after an idle sleep triggers `database.wake` and waits (3.4). A manually
suspended database is not woken by connections. The plan records that under the R2 native runtime
a woken database sleeps again after 60 s idle.

### 3.6 Connection limits

| Limit                                                                                                         | Value                                                                                                                                                                                         | Where                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Server sessions                                                                                               | the class's `max_connections`; PostgreSQL reserves a few for superusers and PGCF's own maintenance and instance-manager sessions (exact count not recorded)                                   | PostgreSQL; refusal is `53300`                                 |
| Sessions of one role                                                                                          | the role's `connection_limit` when set ([2.3](#23-roles-connection-uri-and-passwords)); PGCF's own readiness check logs in once per role for a moment and accepts a role that is at its limit | PostgreSQL; refusal is `53300` "too many connections for role" |
| Sessions per database through one gateway                                                                     | 200 (2,000 per gateway); beyond that the connection fails as `08006`                                                                                                                          | gateway constants                                              |
| New connections per database, all roles and networks                                                          | 120 per 60 s in the example Edge configuration; the plan records the same figure as the deployed handshake limit                                                                              | Edge rate limiter; refusal is `53300`                          |
| New connections per database, role and source network                                                         | 120 per 60 s in the example Edge configuration; the deployed value is installation configuration and **not recorded in this repository**                                                      | Edge rate limiter; refusal is `53300`                          |
| New connections per database and role from a same-account Worker on a service binding (no `CF-Connecting-IP`) | 1,200 per 60 s in the example Edge configuration, in a limiter of its own; such a caller never counts in the two public limiters above                                                        | Edge rate limiter; refusal is `53300`                          |
| Admissions per database per minute                                                                            | 12,000                                                                                                                                                                                        | DatabaseActor                                                  |
| Waiters during one wake                                                                                       | 32 per database                                                                                                                                                                               | DatabaseActor                                                  |

SQL statements on an established connection do not count against the rate limits, so keep
connections and pool them: a platform that opens a connection per request meets the per-database
limit first. Counters are per Cloudflare location and eventually consistent.

### 3.7 HTTP query mode (`neon()`)

**Not yet verified** against the live installation: the format below is checked by the actual
`@neondatabase/serverless` 1.2.0 driver against the Edge and by the gateway's protocol tests, but
no Dev latency has been measured.

`POST https://<host>/sql` serves the Neon driver's HTTP query mode: `neon()`, its
`transaction()`, and `Pool.query()` with `poolQueryViaFetch`. One query or one transaction is one
HTTPS request, with no WebSocket upgrade and no SCRAM exchange by your client. The Edge admits each
request as it admits a connection; the regional gateway runs it on a PostgreSQL session it keeps
for a short time per database and role.

```ts
import { neon, neonConfig } from "@neondatabase/serverless";

// The driver's default rewrites the host to api.<domain>; PGCF serves /sql on the database host.
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;
const sql = neon(connectionUri); // postgres://<role>:<password>@<host>/<database-id>

const items = await sql`SELECT id, name FROM items WHERE owner = ${owner}`;
const [, total] = await sql.transaction(
  [
    sql`INSERT INTO items (owner, name) VALUES (${owner}, ${name})`,
    sql`SELECT count(*) FROM items`,
  ],
  { isolationLevel: "RepeatableRead" },
);
```

| Topic                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password                 | Sent in the driver's `Neon-Connection-String` header over HTTPS to Cloudflare. The Edge forwards it once, in the request body, over the tunnel to the gateway, which authenticates to PostgreSQL with SCRAM-SHA-256 inside the cluster, with the same login and limits as a pipelined WebSocket password ([3.2](#32-what-the-gateway-does-and-does-not-support)). It is never logged or stored and is zeroized in the gateway's memory after use.             |
| Statements               | One statement per query (`a; b` is refused by PostgreSQL with `42601`). Parameters are `$1`, `$2`, ... in text; PostgreSQL infers their types. Results are text, parsed by the driver's type parsers (its `types` option), as with Neon. `arrayMode` and `fullResults` work: the driver applies them itself.                                                                                                                                                  |
| Transactions             | `transaction()` runs its statements between `BEGIN` and `COMMIT` in one request, with `isolationLevel`, `readOnly` and `deferrable`. An error rolls the whole transaction back.                                                                                                                                                                                                                                                                               |
| Session state            | None across requests: each request starts like a new session (the gateway runs `DISCARD ALL` after it). `SET`, temporary tables, advisory locks, `LISTEN` and prepared statements end with the request; a transaction a single query leaves open is rolled back. Use WebSocket mode for interactive transactions and session state.                                                                                                                           |
| Not supported            | `COPY` (`0A000`); `authToken` / `Authorization` (`0A000`); clients other than the driver must send `Neon-Raw-Text-Output: true` and `Neon-Array-Mode: true`.                                                                                                                                                                                                                                                                                                  |
| Limits                   | Request body 4 MiB, at most 256 statements per transaction, answer 10 MiB of JSON (`54000`; the session is closed and the outcome is unknown).                                                                                                                                                                                                                                                                                                                |
| Sleeping database        | The request waits for the wake as a connection does ([3.4](#34-timeouts-and-retries-for-a-sleeping-database)): at most 60 s, with the same `57P03` and `08006` answers. Set your `fetch` timeout accordingly.                                                                                                                                                                                                                                                 |
| Admission and limits     | Every request is one admission. It counts in the same Edge rate limiters as a connection (a service-binding caller in its own limiter), in buckets of its own (WebSocket handshakes are never used up by queries), and in the admissions per database per minute ([3.6](#36-connection-limits)). With the example configuration that is 120 requests per 60 s per database and Cloudflare location: the installation must size these limits for HTTP traffic. |
| Errors                   | HTTP 400 with PostgreSQL's error fields (`message`, `code`, `severity`, `detail`, `hint`, `position`, ...); the driver throws them as `NeonDbError`. Admission refusals use the codes of [A.4](#a4-sqlstate-at-connect-time).                                                                                                                                                                                                                                 |
| Unknown outcome          | `08007`: the connection to PostgreSQL ended, or the gateway's answer was lost, after the request was sent. PGCF never sends a request twice and does not know whether a write took effect; retry only idempotent requests.                                                                                                                                                                                                                                    |
| Password change          | A kept session is reused only for the password it authenticated with, and at most 60 s after its authentication: an old password can still succeed for up to 60 s after a password change.                                                                                                                                                                                                                                                                    |
| Unknown database or role | Answers `28P01` "password authentication failed" at once, while a wrong password is checked by PostgreSQL: unlike the WebSocket path, the response time differs.                                                                                                                                                                                                                                                                                              |

Choose HTTP for one-shot queries and short transactions from a Worker (one round trip each);
choose WebSocket for interactive transactions, session state, `COPY`, `LISTEN`, and many
statements in one burst (Neon puts the break-even at two to three queries).

### 3.8 Recommended patterns for Workers

Estimates from the plan's measurements (15-42 ms per statement round trip from a Worker,
0.47-0.53 s for an 8-statement request on an awake database); **none is measured on PGCF yet**.

| Pattern                          | How                                                                                                                               | Expected gain                                                                                                        | Cost                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Place the Worker near the region | `"placement": { "region": "aws:eu-central-1" }` in the Worker's Wrangler configuration (EU1)                                      | each statement's round trip drops toward 1-5 ms when the distance is geographic: 0.1-0.3 s on an 8-statement request | one more hop for users far from the EU                                              |
| Batch writes                     | one `transaction()` in HTTP mode; on WebSocket, one multi-statement query or pipelined queries instead of one round trip each     | 3-4 round trips (45-170 ms)                                                                                          | a batch fails or commits as a whole                                                 |
| Close without waiting            | `ctx.waitUntil(client.end())` instead of `await client.end()` (WebSocket mode)                                                    | one round trip of user-visible time                                                                                  | none                                                                                |
| Connect early                    | on login or navigation, open the connection or send one cheap query (`SELECT 1` over HTTP) before the user's request needs data   | hides up to about 0.9 s of a cold wake behind user think time                                                        | wakes the database and spends admissions; do it on real user intent only            |
| Hold one socket for a burst      | a Durable Object per database and role keeps one WebSocket `Client` open for a short idle window (5-10 s) and closes it when idle | 0.2-0.4 s on every request after the first in a burst                                                                | must close when idle, or the database never sleeps and the handshake limit is spent |

## 4. Capacity and limits you must enforce

PGCF refuses or delays starts that its node cannot hold, and it never buys capacity on its own
(purchases and autoscale are off until the owner's costed go). It does **not** enforce budgets,
quotas per tenant, compute autoscaling or branching in v1. The limits below are yours to keep.

### 4.1 Region policy (installation configuration, read 2026-10-15)

| Setting                                          | Value                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Placement mode                                   | `actual_ram`: starts are admitted against fresh measured RAM, not reservations  |
| Per-database memory maximum                      | 4,096 MiB, steps of 256                                                         |
| Node (EU1)                                       | 6 vCPU, 12 GB; the plan records 5,000 m CPU and 10,819 MiB allocatable          |
| Prestarted sandbox slots (region `compute_pool`) | one slot, 100 m and 64 MiB per slot; this overhead is charged to every database |

### 4.2 Awake databases: CPU and RAM admission

A database that is not confirmed hibernated is charged

`CPU charge = cpu_request_millicores (or cpu_millicores) + 100 m (Barman sidecar request) + the prestarted slot allowance (100 m here)`

against `allocatable CPU - platform requests P - the charges of all awake databases`. A start is
admitted only if its own charge still fits. A confirmed hibernated database
carries no charge.

Starts also need a memory sample of the node that is at most 90 s old and shows no
`MemoryPressure`, with available RAM of `memory_mib + 512 MiB` (sidecar limit) plus the prestarted
slot allowance (64 MiB here) plus the budgets of starts in flight. Running databases are not reserved:
their real memory shows in the measurement.

Worked example from the plan's density section (5,000 m allocatable, P = 650 m at the first
post-upgrade observation): a 256 MiB class with a 250 m request costs 450 m, so at most nine are
awake at once; a 1 GiB class with a 500 m limit and no request costs 700 m. P is observed per
node and changes with the release. **Treat these as arithmetic until _Density on EU1_
measures them.** Over the limit a wake gets `57P03` at once and a create waits unplaced; by design no Pod
is created without headroom.

What you must do: choose classes whose CPU charge times your peak number of simultaneously awake
databases stays below the figure the operator publishes, keep `sleep_after_seconds` short, avoid
always-warm classes except where needed, and shed load on `57P03` instead of retrying in a tight
loop.

### 4.3 Thin storage

New databases use Thin LVM volumes on EU1. The profile in force (installation configuration, read
2026-10-15; the plan records the 16 GiB data pool growing to 64 GiB and the 64-volume bound):

| Setting                                   | Value                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Quota per database (`maximum_quota_gib`)  | **32 GiB**: a class above that is never placed                                                                              |
| Thin volumes per node (`maximum_volumes`) | **64**, counting sleeping databases and volumes still being reclaimed                                                       |
| Data pool                                 | 16 GiB at first, grown automatically (steps of at least 8 GiB, when a queued start needs room) up to 64 GiB; metadata 1 GiB |
| Reserves                                  | 2 GiB data reserve, 1 GiB startup reserve, 4 GiB volume-group reserve                                                       |

A volume is sized by `storage_gib` for good: it is the logical quota, it does not shrink, and a
sleeping database keeps it. The admission rule is conservative: the pool's **free** space must be
at least the data reserve plus the **full logical size of every Thin volume on the node** plus, for
a new volume, the larger of the startup reserve and its own size. Because data already written
reduces free space as well, the sum of quotas a node accepts is about 62 GiB when volumes are
empty and falls as they fill (the plan lists sleeping overbooking as open work). So plan with

`sum(storage_gib of all databases on the node) + data stored <= pool size - 2 GiB`, at most 64
volumes, pool at most 64 GiB.

Watch size yourselves: `storage` and `health.disk` of the database show the newest volume figures
(`pg_database_size()` and `storage_used_bytes_max` in usage remain the other sources). A full
volume stops writes and nothing grows a quota for you. `health.disk.status` becomes `warning` at
90 % used, the same threshold of the operator's warning.

### 4.4 Your checklist

- Cap databases per tenant and per class; cap simultaneously awake databases.
- Choose `sleep_after_seconds` per database or per class; never leave transactions open.
- Keep the sum of `storage_gib` within 4.3 and watch each database's size.
- Keep your pool `max` below `max_connections`, reuse connections and stay under the Edge
  connection-rate limits (3.6).
- Treat `capacity_exhausted`, a waiting create and `57P03` as normal overload signals.
- Do not assume automatic scale-up of CPU, memory or storage: you change classes yourselves.

## 5. Metering

PGCF reports facts per database and per hour; prices, credits and wallets are yours.

```sh
pgcf -G "$PGCF_API/v1/usage" \
  --data-urlencode "project_id=<project-id>" \
  --data-urlencode "from=2026-10-14T00:00:00.000Z" --data-urlencode "to=2026-10-15T00:00:00.000Z" \
  --data-urlencode "granularity=hour" --data-urlencode "limit=100"
```

- Exactly one of `project_id` or `database_id`; `from` and `to` aligned to UTC hours (`hour`) or
  days (`day`), at most 31 days; `limit` 1 to 100 and `next_cursor` passed back as `cursor`. An
  integrator key sees its own project only. Rows also exist for deleted databases created before
  `to`.
- A row is `{database_id, project_id, start, end, final, metrics, gaps}`. `final: false` rows may
  still change; an hour becomes final two hours after it ends, so bill from final rows. A day row
  is the sum (or maximum) of its 24 hours and is final only when all of them are.
- A metric is a number or `null`; `null` is **unknown, never zero**, and its name is in `gaps`. An
  hour that is not computed yet carries `rollup_pending`.

| Metric                                                               | Meaning                                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisioned_seconds`, `awake_seconds`                               | seconds between creation and deletion, and seconds between a ready or wake event and the next hibernation or suspension                                                       |
| `memory_mib_seconds`, `cpu_millicore_seconds`                        | the class's memory and CPU **limits** times awake seconds; not measured consumption                                                                                           |
| `reserved_cpu_millicore_seconds`                                     | request plus sidecar (plus prestarted slot overhead) times awake seconds; zero while confirmed hibernated                                                                     |
| `reserved_memory_mib_seconds`                                        | class memory plus the 128 MiB sidecar request times **provisioned** seconds: sleeping time is included, because the hibernation snapshot does not reduce it                   |
| `reserved_storage_byte_seconds`                                      | quota times provisioned seconds; **null for Thin volumes** (their snapshot carries no physical allocation), with the gap named                                                |
| `storage_used_bytes_max`, `storage_allocated_bytes`                  | maximum of the agent's filesystem samples in the period (bytes used; PVC capacity)                                                                                            |
| `backup_bytes_max`                                                   | maximum archive size in R2 measured in the period                                                                                                                             |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | gateway counters of the hour, summed over its measurement intervals (none spans two hours); `null` with `traffic_coverage` when an interval of the hour is missing or unknown |

For compute time price `awake_seconds` and `memory_mib_seconds`; for storage use
`storage_allocated_bytes` and `storage_used_bytes_max`; for traffic read `ingress_bytes` and
`egress_bytes` of final rows.

**Traffic across an hour boundary.** The gateways count cumulative totals and the regional
controller reads them about every 15 seconds. When two readings enclose a UTC hour boundary, the
bytes, connections and connection time counted between them are split between the two hours pro
rata by elapsed time, in whole numbers: the earlier hour receives the rounded-down share and the
later hour the remainder, so the two hours always add up to exactly what the gateways counted.
Example: 1,000 egress bytes counted between the readings at 11:59:50 and 12:00:05 are 666 bytes in
the 11:00 row (10 of the 15 seconds) and 334 bytes in the 12:00 row (5 of the 15 seconds). The
timing error is at most the interval between the two readings, normally about 15 seconds, and only
in the two rows around a boundary; the sum over whole hours is exact. `connection_seconds` has
millisecond resolution.

**What stays unknown.** An interval is `null`, with `traffic_coverage` in `gaps`, when the gateway
process restarted or was replaced, a counter went backwards, the set of gateways or their signing
key changed in between, a report was incomplete, no reading arrived, or two readings are more than
one UTC hour boundary apart (a controller outage of about an hour or more). A reading that shows
nothing counted is a measured zero, not a gap. A day row is `null` when any of its hours is. Hours
finalized before this attribution was deployed keep `null` traffic and are never recomputed.

**Infrastructure cost** (`GET /v1/costs`, **admin only**, hourly, at most 31 days, one node or one
region) is per node and built from monthly amounts the owner recorded as immutable facts
(`POST /v1/costs/node-facts`); hours without a fact are `unpriced_seconds` with a `node_rate`
gap. It is not attributed to databases. Ask the operator to export it for you.

**Not reported:** measured CPU or RAM consumption per database, cost per database or per project,
query counts and latencies, node RAM, CPU and disk time series (the plan records that node samples
live minutes and only current values are readable), per-connection or per-statement data, and
any price.

## 6. Alerts and operations

Alerts are infrastructure alerts for the **operator**. You do not receive them, and delivery is not
configured yet (the Go-live path's _Alerts_ step needs a Resend key, a verified sender and a
recipient, or an alert webhook). The operator reads their state in `GET /v1/operational-health?scope=regions`.

One episode exists per region and kind. A new episode gets a new `event_id`, is delivered at least
once with retries at least 60 s apart and a five-second deadline, and clears only when its
measurement is fresh and below the threshold.

| Kind                                                          | Fires when                                                                                                                                   | Threshold (capacity policy, read 2026-10-15)      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `regional_node_ram_warning`                                   | any node's 30-minute average of active RAM reaches the threshold                                                                             | `node_ram_warning_threshold_ppm` = 850,000 (85 %) |
| `regional_node_cpu_warning`                                   | any node's 30-minute average CPU load reaches it                                                                                             | `node_cpu_warning_threshold_ppm` = 900,000        |
| `regional_node_storage_warning`                               | the node's thin-pool data or metadata fill reaches it (placement closes a pool at 80 % data or 50 % metadata)                                | `node_storage_warning_threshold_ppm` = 800,000    |
| `regional_ram_warning`                                        | regional RAM utilisation reaches it                                                                                                          | `ram_warning_threshold_ppm` = `null` (off)        |
| `regional_node_cap_reached`                                   | allocated nodes reach `max_nodes`                                                                                                            | `cap_warning_enabled` = off                       |
| `regional_node_stale`                                         | a node's observation is older than 180 s, or the node is marked lost                                                                         | fixed                                             |
| `infrastructure_backup_failed`, `infrastructure_backup_stale` | the daily D1 backup fails, or none completed for 36 h                                                                                        | fixed                                             |
| `database_archive_failing`                                    | a running, awake database reports `health.archiving: failing`                                                                                | fixed (from the release with migration `0052`)    |
| `database_base_backup_stale`                                  | an awake database has no completed base backup within 36 h of awake time; hibernated ones are excluded and a wake restarts the count         | fixed (same release)                              |
| `thin_storage_blocked`                                        | a node's newest sample says its thin pool has no room, or a node that holds databases has no sample of its pool within 180 s (`thin_pool_*`) | fixed                                             |
| `regional_node_capacity_refusals`                             | a node refused 5 or more wakes for awake capacity (`57P03`) in 10 minutes                                                                    | fixed                                             |
| `regional_node_pool_closed`                                   | a node's newest sample closes its thin pool for placement: data at 80 %, metadata at 50 % or the sold storage at 4 times its data           | fixed                                             |
| `database_volume_warning`, `database_volume_critical`         | a database volume's space or inodes are at least 80 % (below 90 %), or at least 90 %, used                                                   | fixed                                             |
| `node_enrollment_refused` | a node's enrollment token was presented again with another key, or after it expired, within the last 24 h | fixed |
| `node_unexpected_reboot` | a node rebooted and no maintenance order of it asked for it, within the last 24 h | fixed |
| `control_cron_stalled`, `control_cron_step_failing`           | no minute-cron run completed for 300 s, or a step failed in each of its last 5 runs                                                          | fixed (same release)                              |

Thresholds are integer parts per million (1,000,000 = 100 %, valid 1 to 1,000,000, `null`
disables) set with `PUT /v1/regions/{id}/capacity-policy`. The minute cron evaluates the first
four regions that have a policy; the fixed-rule kinds are evaluated for every region.

Every event carries a short runbook action in `action`. The database kinds are per database but
one episode per region and kind lists up to 64 databases. Each minute-cron step runs in its own
failure boundary, so one failing step is logged and counted and alerting still runs; the cron's
own heartbeat is judged by a Durable Object alarm that does not depend on the cron
([operator runbook](infrastructure-backups.md#minute-cron-heartbeat-and-watchdog)). Before that
release there is no alert for one database's archive or base backup or a Thin `blocked` state,
and an earlier failure in the minute cron silently skips alerting.

The control plane itself is protected by a daily encrypted D1 export in R2, read back in full
([infrastructure backups](infrastructure-backups.md)); restoring it has not been exercised. The plan records completed runs on 2026-10-13 and 2026-10-15; 2026-10-14 failed all three attempts and is
open (Go-live path: _Backups_). These backups are not your database backups.

What you can watch yourselves: per database `health.archiving`, `health.backup`, `health.disk`,
`storage` and `observed_state: error` ([2.2](#22-operations-and-readiness)), connection errors by
SQLSTATE, and `GET /healthz` of the API and of the database host (both only say that the Worker
runs). The operator-only `GET /v1/operational-health?scope=databases` lists the same backup and
disk verdicts for every project at once.

## 7. Failure and recovery

### 7.1 What happens in each situation

| Situation                                                                  | Effect on your database                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Data                            | You do                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| Idle sleep                                                                 | PostgreSQL stops after quiesce and the Pod is removed; the next connection wakes it, into a free pool instance on its node when one is free                                                                                                                                                                                                                                                                                                                                                                                                                                                  | WAL archived first, volume kept | reconnect                                                          |
| Manual suspend                                                             | refused with `57P03` until resume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | as above                        | `POST /resume`                                                     |
| Planned maintenance: fleet patch or rollout                                | new placement is closed during it, so creates wait; the single customer node reboots and its databases "may experience visible maintenance downtime"; the control node is patched after the customer node. A release that changes kernel, Thin driver or host extension is announced as an outage of all Thin databases. From the canary on, reboots of EU1 or control need the owner's go and an announced window (the plan: a reboot of EU1 or control stops every awake database and there is no region-wide maintenance lock). The announcement channel is not defined in the repository | kept                            | plan around the window; ask the operator for it                    |
| Node reboot (crash, or a patch)                                            | every database Pod on the node stops; PostgreSQL crash-recovers from the local volume when the node and the regional controller are back; Thin databases additionally wait until the node reports a fresh storage sample with pool room on the new boot; hibernated databases are not touched. No duration is measured for databases                                                                                                                                                                                                                                                         | kept (local volume)             | retry with backoff; check `observed_state`                         |
| Control node reboot or outage                                              | running databases keep running; Thin starts and wakes wait until EU1's storage sample, read through the Kubernetes API server on the control node, is fresh again. **Not yet verified live**                                                                                                                                                                                                                                                                                                                                                                                                 | kept                            | wait                                                               |
| Archiving failing (`health.archiving: failing`, for example an R2 problem) | connections keep working; WAL accumulates on the volume until archiving works again, and a full volume stops writes (standard PostgreSQL behaviour, not tested here)                                                                                                                                                                                                                                                                                                                                                                                                                         | recoverable window goes stale   | escalate at once                                                   |
| Volume full                                                                | PostgreSQL cannot write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | kept                            | free space; for Thin, resize to a larger class ([2.5](#25-resize)) |
| **EU1 lost**                                                               | **all databases are down.** Their local volumes are gone with the server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | only what reached R2            | [7.4](#74-eu1-lost)                                                |
| Cloudflare unavailable                                                     | no path to any database: all traffic enters through Cloudflare. While the Edge still routes but the API or D1 is unavailable, awake databases keep running and wakes fail                                                                                                                                                                                                                                                                                                                                                                                                                    | kept                            | wait                                                               |

### 7.2 Recovery point

- There is no synchronous replica and no zero-loss promise for a lost volume: the last
  recoverable commit is the last WAL segment that reached R2.
- WAL is archived when a segment fills or after `archive_timeout_seconds`, so the exposure is that
  timeout (the classes in the installation use 60 s, the newest 30 s) plus upload time. One
  measured run, recorded in the plan's R2b row, confirmed committed WAL in R2 after 66.7 s with a
  60 s timeout; that is a single sample.
- A reboot with an intact volume loses no committed transaction. A clean idle or manual sleep
  archives the final WAL before the Pod goes, so a hibernated database is as recent as its last
  activity (by design; not independently tested after a node loss).
- Point-in-time recovery reaches any instant between the oldest retained complete base backup and
  the last archived WAL; `GET /v1/databases/{id}/backups` states the window of a database. The
  window per class is its `backup_retention_days`: 7 days for the Dev test classes, 1 day for the
  256 MiB class (plan). It is derived, not measured per class.

### 7.3 Recovery time

**Not measured.** The recovery runbook states that no actual outage or server-loss duration has
been recorded, and a healthy-source restore does not substitute for it. A restore is a base
backup restore plus WAL replay on new capacity, so it depends on the database size and on
capacity being available; neither is quantified.

### 7.4 EU1 lost

1. The operator verifies the node and marks it lost (`POST /v1/nodes/{id}/mark-lost`); its
   databases are unreachable.
2. New capacity is needed before any restore can start. Reinstalling the same Contabo instance
   (AddNode `recover`) needs no purchase; replacing a destroyed server does and needs the owner's
   costed go (**EU2 has not been bought**). Both need the EU installation profile, which does not
   exist yet, and the manual network-proof path; no node-loss runbook with checked preconditions
   exists yet (Go-live path: _Recovery_).
3. For each database, restore from R2 ([2.7](#27-backups-restorable-window-and-restore)). Every
   restored database has a **new ID**: update your mapping, connection strings and `wsProxy`
   hints for each.
4. Expect the last archived commit, not the last acknowledged one.

No recovery time can be promised today (7.3).

### 7.5 Records to keep

Keep, in your own store: the ID mapping and the restore operation of each database, the
idempotency keys of unfinished operations, the role names and the password revision of each
database. Rotate role passwords with `reset-password` and re-read the URI instead of caching
passwords.

### 7.6 Escalation

The repository defines no pager, status page or SLA: your counterpart is the operator, the holder
of the admin key of this installation. **The contact channel is not recorded in the repository;
the operator supplies it at handover.** Send:

- the UTC time, `database_id`, role, operation ID and the request;
- `X-Request-Id` and `X-PGCF-Diagnostic-Id` of the failing API call (the API logs failed requests
  under that diagnostic ID), or for a connection the SQLSTATE and message and whether it came
  immediately or after about 60 s (the Edge logs every admission with database ID, role, outcome
  and duration);
- what `GET /v1/databases/{id}` and `GET /v1/operations/{id}` returned.

## 8. Not available yet

- Sub-second first SQL after sleep, measured at p95 (the pool is live on EU1; its first hit took 1.09 s).
- A second customer node, redundancy and a measured recovery time; node drain and moving
  databases with their IDs kept (a restore always creates a new ID).
- Alert delivery to a recipient; alert history, acknowledgement and test send.
- Finding deleted databases: the lists exclude them, so keep the IDs you were given.
- An event stream or webhooks, an audit log.
- Key expiry, last-use display, key rotation as a feature, a read-only scope; an API domain with
  rate limiting.
- Infrastructure metrics history and measured CPU and RAM per database.
- Changing a role after creation (expiry, limit, membership), user-chosen passwords, a grants API,
  per-role settings, renaming a database.
- Cancel requests, replication connections, TCP access; in HTTP query mode, `COPY` and
  `authToken`.
- Budgets, quotas per tenant, compute and storage autoscaling, branching.
- Maintenance-window notifications.
- Importing existing databases from another provider; moving them is your task.

## 9. Items for written confirmation

The Go-live path's _Handover_ step requires this document to state the following and your written
confirmation. The state column says what is measured and what is derived or open.

| Item                                                                                                                | Where                                                                                        | State                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPO per class                                                                                                       | [7.2](#72-recovery-point)                                                                    | derived: `archive_timeout_seconds` plus upload time; one measured sample (66.7 s with a 60 s timeout); no per-class measurement                         |
| PITR window per class                                                                                               | [2.7](#27-backups-restorable-window-and-restore), [7.2](#72-recovery-point)                  | derived from `backup_retention_days`; the window of each database is readable through `GET /v1/databases/{id}/backups`; no measured full-window restore |
| Pool hit and miss latency                                                                                           | [3.4](#34-timeouts-and-retries-for-a-sleeping-database)                                      | one live hit measured (1.09 s to the first answer, 2026-10-17); p95 and misses not measured; the hibernated wake is 8.1–9.4 s                           |
| `57P03` meanings and retry rule                                                                                     | [3.4](#34-timeouts-and-retries-for-a-sleeping-database), [A.4](#a4-sqlstate-at-connect-time) | stated from the code and its tests; the recommended retry policy is not a PGCF guarantee                                                                |
| Connection limits                                                                                                   | [3.6](#36-connection-limits)                                                                 | stated; the deployed per-role and per-network values are not recorded in the repository                                                                 |
| Role deletion: unroutable at once, removal confirmed by PostgreSQL, hibernated database applies it at its next wake | [2.3](#23-roles-connection-uri-and-passwords)                                                | stated from the code and its tests; **not yet run against the live cluster** (live acceptance pending)                                                  |
| Outage classes and maintenance windows                                                                              | [7.1](#71-what-happens-in-each-situation)                                                    | classes stated; no window schedule and no announcement channel is defined                                                                               |
| New IDs after restore or node loss                                                                                  | [2.7](#27-backups-restorable-window-and-restore), [7.4](#74-eu1-lost)                        | stated                                                                                                                                                  |
| Capacity caps                                                                                                       | [4](#4-capacity-and-limits-you-must-enforce)                                                 | arithmetic only; measured caps follow _Density on EU1_                                                                                                  |

## Appendix A. Error reference

### A.1 HTTP

Every error body is `{"error": {"code", "message", "request_id", "details"?}}`.

| Status | `error.code`              | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Retry                        |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 400    | `invalid_request`         | validation or unknown field, malformed JSON, body above 64 KiB, wrong `Content-Type`, bad ID, cursor or `Idempotency-Key`, a missing `Idempotency-Key` on a database or role mutation, unknown or disabled class or region, class above the memory maximum, `target_time` in the future, storage shrink or change on thick, usage range not aligned or over 31 days, a role `valid_until` that is not in the future, a `member_of` entry that is not a live role of the database (or is `app`, `pgcf_maintenance`, `pg_*`, `cnpg_*`), deleting `app` or `pgcf_maintenance` | no                           |
| 401    | `unauthorized`            | key missing, malformed, unknown, revoked, or its project deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | no                           |
| 403    | `forbidden`               | integrator key on an admin route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | no                           |
| 404    | `not_found`               | unknown ID, an ID of another project, unknown route, a role route of a deleted database                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | no                           |
| 409    | `conflict`                | the request is refused for the cause in `error.details.reason` (table below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | by reason                    |
| 409    | `idempotency_conflict`    | same key, different request; replay of a credential-creating call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | no                           |
| 409    | `idempotency_in_progress` | same key still executing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | yes, shortly (`Retry-After`) |
| 503    | `capacity_exhausted`      | resize, resources or profile assignment: the node lacks memory, CPU or storage now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | later (`Retry-After`)        |
| 500    | `internal`                | unexpected failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | yes, with the same key       |
| 429    | `rate_limited`            | defined by the contract; the API emits none today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                              |

The stable reasons of a `409 conflict` (and of `node_capacity`) come in two kinds. A **retryable**
reason clears without a change to the request and the answer carries `Retry-After`; repeat the
request under the same `Idempotency-Key`. A **terminal** reason needs a different request or a
different resource first.

| `details.reason`                                                                                       | Kind      | Cause                                                                                                                                  | `Retry-After` |
| ------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `mutation_in_progress`                                                                                 | retryable | another change to the same database holds it for the moment (a wake, an idle sleep or its compensation, a maintenance step)            | 1 s           |
| `generation_changed`                                                                                   | retryable | the database, or what a create or restore was based on, changed between the read and the write ("Database changed; retry the request") | 1 s           |
| `not_ready`                                                                                            | retryable | the database has not applied its latest generation or is not running yet ("Database configuration is not ready")                       | 5 s           |
| `node_capacity`                                                                                        | retryable | the node lacks memory, CPU or storage for a resize, or for a resume ([2.4](#24-suspend-and-resume))                                    | 30 s          |
| `name_in_use`                                                                                          | terminal  | a live database of the project already has this name (create, restore)                                                                 |               |
| `database_deleted`                                                                                     | terminal  | the database is deleted                                                                                                                |               |
| `project_not_empty`                                                                                    | terminal  | the project still holds databases that are not yet confirmed deleted                                                                   |               |
| `role_exists`                                                                                          | terminal  | the role name exists                                                                                                                   |               |
| `role_limit`                                                                                           | terminal  | the database holds 100 roles; a role awaiting its removal counts                                                                       |               |
| `role_being_deleted`                                                                                   | terminal  | a role of that name is awaiting its removal; create it again once PostgreSQL has dropped it                                            |               |
| `role_has_members`                                                                                     | terminal  | other live roles are `member_of` this role; delete the members first                                                                   |               |
| `archive_expired`, `archive_unusable`, `no_recovery_point`, `source_unavailable`, `region_unavailable` | terminal  | restore refusals ([2.7](#27-backups-restorable-window-and-restore))                                                                    |               |

A `409 conflict` of an operator route (regions, nodes, fleet, profiles, capacity) carries a reason
only where it is one of these, for example `mutation_in_progress`; otherwise the message is all
there is.

`GET /v1/databases/{id}` answers `200` for a deleted database; role routes answer `404`.

### A.2 Operation kinds

`database.create`, `database.restore`, `database.delete`, `database.resize`, `database.suspend`,
`database.resume`, `database.role.delete` are started by you; `database.hibernate`,
`database.wake` by PGCF.

### A.3 Operation error codes

| `error.code`                                                    | Meaning                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superseded`                                                    | a newer intent (resize, delete or power change) replaced it; not a platform fault                                                                                                                 |
| `operation_timeout`                                             | no progress for 20 minutes ("Regional operation exceeded 20 minutes")                                                                                                                             |
| `power_busy`, `power_archive`, `power_unknown`, `power_timeout` | a suspend or hibernation was refused or timed out; the database returned to running                                                                                                               |
| `role_not_droppable`                                            | `database.role.delete`: the role owns objects or holds privileges, so PostgreSQL cannot drop it; it stays unable to log in until they are removed ([2.3](#23-roles-connection-uri-and-passwords)) |

### A.4 SQLSTATE at connect time

| SQLSTATE | Message                                                                                                                                                                         | Cause                                                                                                                                                                                                                                         | Action                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `3D000`  | database does not exist                                                                                                                                                         | the `database` hint is missing or not a well-formed ID                                                                                                                                                                                        | fix the configuration                                            |
| `28P01`  | authentication failed / password authentication failed                                                                                                                          | a malformed role; or an unknown database, unknown role, deleted role or deleted database (indistinguishable from a wrong password by design); or a role past its `valid_until` (it does not wake a hibernated database); or a wrong password  | check ID, role, `valid_until` and password revision; do not loop |
| `28000`  | startup does not match the authorized route                                                                                                                                     | StartupMessage `database` or `user` differs from the URL hints                                                                                                                                                                                | fix the client                                                   |
| `08P01`  | duplicate connection admission hint / protocol violation                                                                                                                        | repeated `database` or `user`, or a malformed startup                                                                                                                                                                                         | fix the client                                                   |
| `0A000`  | replication connections are not supported / unsupported frontend protocol                                                                                                       |                                                                                                                                                                                                                                               | fix the client                                                   |
| `57P03`  | database is not accepting connections                                                                                                                                           | not admissible now: manual suspension, provisioning, no capacity for a wake, error state, more than 32 waiters, or the wake did not finish within the 60 s deadline; see the table in [3.4](#34-timeouts-and-retries-for-a-sleeping-database) | per cause                                                        |
| `53300`  | connection rate limit exceeded / database connection rate limit exceeded / connection admission unavailable; or PostgreSQL "too many clients" / "too many connections for role" | Edge rate limiters, admission limit, `max_connections`, or the role's `connection_limit`                                                                                                                                                      | back off; pool                                                   |
| `08006`  | gateway connection failed / connection admission interrupted                                                                                                                    | the 60 s deadline passed during a wake (the usual outcome), you aborted, the per-database gateway limit was hit, or the gateway was unreachable                                                                                               | retry; the wake continues                                        |

### A.5 Closing an established connection

WebSocket close code 1000 `database sleeping` (idle hibernation); 1012 with `authentication
interrupted`, `writer changed`, `database retired` or `gateway
restarting` (a restart); 1013 `relay buffer or connection failed`; 1003
`binary frames required`. All are disconnects: reconnect; statements in flight have an unknown
outcome and are not replayed.

## Appendix B. Where each statement comes from

| Topic                                                       | Source                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes, auth, error lists, idempotency, operation metadata  | `apps/api/src/routes/*.ts`, `apps/api/src/openapi*.ts`, `apps/api/src/app.ts`, `apps/api/src/middleware/*.ts`                                                                |
| Contracts (IDs, size classes, states, usage, costs, alerts) | `packages/contracts/src/{ids,api,errors,auth,usage,costs,infrastructure-alerts,nodes,sizing}.ts`                                                            |
| Create, resize, delete, power, restore, roles               | `apps/api/src/domain/{databases,lifecycle,restore,restore-catalog,roles,archive,retained-archives}.ts`                                                                       |
| Admission, wake, idle, `57P03`                              | `apps/api/src/database-actor.ts`, `apps/api/src/domain/{startup-admission,placement,node-observations}.ts`                                         |
| Edge, hints, SQLSTATE, deadline, decoy                      | `apps/edge/src/*.ts` (the Rust/Wasm port in `apps/edge-rust` applies the same policy)                                                                                        |
| HTTP query mode                                             | `apps/edge/src/sql.ts` (Rust/Wasm: `apps/edge-rust/src/sql.rs`), `apps/native-gateway/src/sql.rs`                                                                                                                     |
| Gateway limits, TLS, cancel, startup, idle close            | `apps/native-gateway/src/transport.rs`, `packages/native-protocol/src/activity.rs`, `packages/contracts/src/pg-wire.ts`, `packages/contracts/native/protocol.generated.json` |
| Sleep sequence and refusals                                 | `apps/node-agent/src/sleep.rs`, `packages/contracts/src/sleep.ts`                                                                                                            |
| PostgreSQL cluster, backup schedule, retention, `pg_hba`    | the retired runtime on the `archive/kubernetes-runtime` branch                                                                                                               |
| Client configuration                                        | `scripts/e2e/probe/worker.ts`, `@neondatabase/serverless` `CONFIG.md`, [README](../../README.md)                                                                             |
| Metering                                                    | `apps/api/src/domain/{usage,usage-rollup,usage-cron,costs}.ts`; the traffic attribution across an hour boundary is `fragments` in `apps/node-agent/src/usage.rs`    |
| Alerts, health                                              | `apps/api/src/domain/{operational-health,infrastructure-alerts,cron-health}.ts`, `apps/api/src/{cron,cron-watchdog}.ts`, `docs/operations/infrastructure-backups.md`         |
| Recovery, maintenance                                       | `docs/operations/recovery.md`                                                                                                                                                |
| Measured numbers and open steps                             | the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md)                                                                                              |
| Region policy, alert thresholds (installation values)       | `GET /v1/regions/{id}/capacity-policy` of the live installation, not the repository                                                                                          |

## Appendix C. What the served OpenAPI document states in words

`GET /v1/openapi.json` is generated from the contracts and checked against their own JSON Schema:
property names, requirements, patterns, bounds, `multipleOf`, nullability and enumerations agree,
and `info.version` is the contract version. A JSON Schema cannot state the rules below, which
involve several fields, the stored state or the time of the request. The document says each in the
description of the schema or the operation; the code is authoritative.

| Rule                                                                                                                                                                                                  | Where the document says it         | Refusal |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- |
| An `integrator` key requires `project_id` and an `admin` key must omit it                                                                                                                             | `ApiKeyCreate`                     | `400`   |
| `memory_mib` of a size class is a multiple of 256 and `cpu_request_millicores` does not exceed `cpu_millicores`                                                                                       | `SizeClass`, `SizeClassUpsert`     | `400`   |
| `postgres`, `streaming_replica`, `pg_*` and `cnpg_*` are not role names, and `pgcf_maintenance` cannot be created                                                                                     | `RoleName`, `RoleCreate`           | `400`   |
| `valid_until` must lie in the future when the request executes (not on a replay); every `member_of` entry is a live role of this database that is neither `app`, `pgcf_maintenance` nor being deleted | `RoleCreate`                       | `400`   |
| A usage request names exactly one scope; both boundaries are aligned to the granularity and at most 31 days apart                                                                                     | `getUsage`                         | `400`   |
| A request body is JSON of at most 64 KiB with `Content-Type: application/json` whenever there is a body                                                                                               | `info.description`                 | `400`   |
| Idempotency keys are kept 24 hours per API key; a request that failed is not retained                                                                                                                 | `Idempotency-Key` of each mutation |         |
| A deleted database is read with `200` and `desired_state: deleted`                                                                                                                                    | `getDatabase`                      |         |
| An operator route's `409` carries a `details.reason` only where it is one of the listed reasons                                                                                                       | [A.1](#a1-http)                    |         |
