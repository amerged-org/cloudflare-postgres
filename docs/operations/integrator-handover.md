# Integrator handover

For the engineers of an integrator who create their databases on PGCF through its API and operate
them without reading PGCF code. You know PostgreSQL and Neon.
This runbook states what is different, which limits you must enforce yourselves and what is not
available yet.

Every statement is derived from the code and contracts of this repository; Appendix B lists where,
and Appendix C lists what the served OpenAPI document states in words rather than in schema.
Behaviour without a live acceptance is marked **not yet verified**. Values that are installation
configuration rather than code (node policy, alert thresholds) are labelled as such; the operator
reads them from the live installation. Measured numbers carry their source in the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md#111-done), which is also
where PGCF publishes new ones. The plan's
[go-live gates](../architecture/cloudflare-convergence-and-serverless-plan.md#stage-7-go-live-gates) are the
authority on what still blocks go-live; operator procedures are in the other runbooks
([recovery](recovery.md), [credentials](credentials.md),
[infrastructure backups](infrastructure-backups.md)).

## Read first

| Topic                             | State on 2026-10-19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                           | Databases run on EU1, a Debian node installed from the PGCF image: one sandboxed systemd PostgreSQL 18 service per database on its own thin LVM volume, one Rust node agent, no Kubernetes. The Stage 5 acceptance of the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md) (cold-request p95, density, storage and crash tests) is not finished; its gates decide what still blocks go-live.                                                                                  |
| First request after a wake        | A sleeping database starts PostgreSQL from its own volume on the next connection. On EU1 on 2026-10-19 the first request as one HTTP `/sql` transaction, after 60 to 137 minutes asleep, took a median of 611 ms through a service binding (8 samples, all under 1 s) and 648 ms through the public hostname (6 samples). The first request statement by statement over a WebSocket, after at least 2 h asleep, took a median of 789 ms through a service binding and 989 ms through the public hostname (5 databases each). The series differ in sample size, sleep time and request. These are small samples, not a p95: the sub-second gate is not yet claimed ([3.4](#34-timeouts-and-retries-for-a-sleeping-database), [3.7](#37-http-query-mode-neon)). |
| Redundancy                        | One customer node (EU1), one PostgreSQL instance per database, no replica, no second node. Losing EU1 stops every database until it is restored from R2 onto new capacity ([7](#7-failure-and-recovery)).                                                                                                                                                                                                                                                                                                |
| Capacity numbers                  | The density test that measures how many databases a node may carry has not run (Stage 5.6). The numbers in [4](#4-capacity-and-limits-you-must-enforce) are the plan's admission rules and starting values, not measured capacity.                                                                                                                                                                                                                                                                       |
| New databases                     | Every database lives on a thin LVM volume of its node, placed by the 80 % rule of [2.1](#21-create). When no node qualifies, `POST /v1/databases` and restores are still accepted and the database waits unplaced.                                                                                                                                                                                                                                                                                       |
| Alerts                            | Infrastructure alerts go to the operator's alert webhook (configured 2026-10-19); you receive none from PGCF ([6](#6-alerts-and-operations)).                                                                                                                                                                                                                                                                                                                                                            |
| Your key                          | Project-scoped key isolation and rotation have not been exercised live (go-live gate G10).                                                                                                                                                                                                                                                                                                                                                                                                               |
| Maintenance                       | A maintenance cycle (new packages, a new kernel) closes placement on the node, holds wakes with `57P03`, puts every awake database to sleep with the proof and reboots the node if the kernel changed; the first live cycle took 67 s end to end. From the canary on the EU stack is production (`pgcf-api-dev` and `eu-dev` are only names): reboots then need an announced window, Debian kernel security reboots are pre-approved within 7 days of an advisory, and no announcement channel is defined ([7.1](#71-what-happens-in-each-situation)). |

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
| `database` and `user` of the PostgreSQL StartupMessage | the same two values                                 | The node's gateway: comparison with the signed route; a mismatch ends with SQLSTATE `28000` before PostgreSQL is dialled                   |

`<id>` is the 20-character database ID the API returned (`^[a-z][a-z0-9]{19}$`, random, not derived
from the name). It is also the PostgreSQL database name. The `name` you give a database is an API
label, unique among the live databases of a project, and plays no role in routing. The `user` is a
role name from `GET /v1/databases/{id}/roles`; the owner role of every database is `app`.

The StartupMessage `database` parameter defaults to the user name when absent, so set it
explicitly (drivers do). `replication` startup parameters are refused (`0A000`).

### 1.2 Regions

A database lives on one node of one region, chosen at creation (`region_id`). The operator can move
it to another node of the region under the same ID (`POST /v1/databases/{id}/move`, admin): the
source proves the sleep, your connections get `57P03` while the move runs, and a move that fails
leaves the database where it was. The target may be the database's own node (a move from one
volume to another); a move to another node needs a second node in the region, and a region has
only one node until the owner approves EU2 (plan 1.11). Automatic rebalancing comes after go-live.
The hostname is the same for every region; the Edge finds the region from the database's record.

The installation serves one region: EU. Its region ID is `eu-dev` (the Worker and region IDs carry
the name `dev`). `GET /v1/regions` with your key lists `{id, provider_region}` of the regions that
accept placement and nothing else about them: those with a node that is ready, schedulable, not
lost and open for new databases. There is no US node yet: the plan installs US1 from the same
image once EU1 has passed its acceptance (plan 9.6). A region without such a node is not listed,
and a database created in a region record that has none waits unplaced ("Waiting for verified
regional capacity") until a node there opens. Customer databases run only on EU1.

### 1.3 Size classes

A size class fixes the resources and policies of a database. The operator defines classes
(`PUT /v1/size-classes/{id}`, admin); you read them with `GET /v1/size-classes` and pass the ID at
creation or resize. Disabled classes (`enabled: false`) are listed but refused.

| Field                                      | Bounds in the contract                                 | Meaning                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_mib`                               | 256 to 1,048,576 in steps of 256                       | The database's hard memory ceiling while it is awake; PostgreSQL's settings follow it (`shared_buffers` an eighth, `effective_cache_size` three quarters of it) |
| `cpu_millicores`                           | 100 to 256,000                                         | CPU size: the database's CPU weight is proportional to it and a quota of it applies once PostgreSQL has started; after a wake the quota comes only after the region's CPU burst (the node policy's `cpu_boost_ms`, 5 s at first), during which the database is not held to its size: it takes its weight's share of contested CPU and what is idle. Each wake has such a burst, so frequent suspend and resume cycles repeat it |
| `storage_gib`                              | 1 to 65,536                                            | The thin volume's size; the pool hands out real space only as the database writes. It grows online and never shrinks |
| `max_connections`                          | 10 to 10,000                                           | PostgreSQL `max_connections`                                                                                                              |
| `sleep_after_seconds`                      | 60 to 2,592,000, or `null`                             | Idle time before hibernation of a database that sets none of its own; `null` is always warm                                               |
| `archive_timeout_seconds`                  | 30 to 3,600                                            | PostgreSQL `archive_timeout`: bounds how old unarchived WAL can get                                                                       |
| `backup_retention_days`                    | 1 to 3,650                                             | Recovery window: after each DONE backup the Worker deletes older base backups and the WAL only they need, never the newest DONE backup; also how long a deleted database stays restorable |

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
unless the operator sets another). It does **not** refuse a class that no node can host, for
example a `storage_gib` that would take a node's sold storage past four times its pool, or a CPU
size above the node's cores: creates of such a class are accepted and then wait unplaced. Ask the
operator which classes are placeable. The owner has not yet approved the production class catalog
(go-live gate G10); test classes are disabled before the canary.

### 1.4 Projects and keys

There are three key scopes. You hold an integrator key; the table compares it with the operator's
`admin` key:

|                                                                                            | Integrator key                                                                                              | Admin key                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Bound to                                                                                   | exactly one project                                                                                         | nothing                                                |
| Databases, roles, operations, archive summary, usage                                       | its own project; a resource of another project is reported as `404`, never `403`                            | all projects                                           |
| Connection URI                                                                             | **includes the role password**                                                                              | never includes a password (`includes_password: false`) |
| Size classes                                                                               | list                                                                                                        | list and define                                        |
| Regions                                                                                    | list `{id, provider_region}` of those that accept placement                                                 | list the full records, create, read                    |
| Projects                                                                                   | list and read its own; delete its own once it holds no live database (this also revokes the project's keys) | create, list, delete                                   |
| API keys, nodes, capacity policy, costs, operational health, infrastructure backups, fleet | `403`                                                                                                       | yes                                                    |

The third scope, `admin_read`, is the operator's read-only administrator key, for monitoring and
dashboards: it reads what an admin key reads, and every request that is not a GET is refused with
`403` before it runs. You are never given one. The operator's keys leave an audit log
(`GET /v1/audit-events`, administrator keys only); yours do not.

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

**Rotating a key.** There is no self-service rotation. An integrator key never expires unless the
operator gave it an `expires_at` when making it (the key's resource shows it; it cannot be
changed): from that time the key answers `401` like a revoked one, so ask for the replacement
before it. The operator follows [credentials](credentials.md#api-keys): create a second integrator
key for the same project, you deploy it, the operator revokes the first with
`DELETE /v1/api-keys/{id}`. A revoked key answers `401` at once. Idempotency keys are scoped to the
API key that used them: settle in-flight mutations before the switch, and do not expect a new key
to replay an old key's `Idempotency-Key`. Last-use display and bounded admin minting are open
work.

## 2. Lifecycle API

The machine-readable reference is `GET /v1/openapi.json` (no key needed). Its `info.version` is
the version of the API contract (`1.3.0` for this document): it changes when the contract changes
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

What happens: the database record (generation 1) and the owner role `app` with a server-generated
password are written (`pgcf_maintenance` is only a reserved name); the
placement step picks the node that is the fullest of those that stay under 80 % active RAM and 80 %
CPU load, each as the highest 30-minute average of the last seven days, and whose thin pool is
open (data below 80 %, metadata below 50 %, sold storage within four times its data). A database
placed after the node's newest sample counts at its full memory until that sample exists, and the
newest sample's active RAM counts when it is above the average. The node then creates the volume
and the cluster, applies the roles, starts PostgreSQL through its own admission and takes the first
base backup; WAL archiving starts with the first start. The database is ready only when that backup
is DONE, so it is never writable before it is restorable. The idle time
(`effective_sleep_after_seconds`) counts from readiness.

- Ready means the operation is `succeeded`, the database `observed_state` is `ready` and
  `observed_generation` equals `generation`. Poll `GET /v1/operations/{id}`; the database stays
  `pending` or `provisioning` until then. Connecting earlier returns `57P03` immediately.
- Measured on EU1 under the node runtime (2026-10-18, the plan's Stage 5 rows): a create took 16.8 s
  to ready, and a database loaded with a SaaS dataset of about 2.5 million rows (74.1 s through
  Cloudflare) held one base backup and 49 WAL segments in R2 afterwards.
- **No capacity.** If no node qualifies, the call still returns `202`: `node_id` is `null`,
  `observed_state` is `pending` and `status_message` is `Waiting for verified regional capacity`.
  A minute cron places it when a node qualifies.
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
| `pending`, `running` | accepted; the node has not finished                                            |
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
| `health.backup`    | `status` is `ok` while the last completed base backup is at most 36 h old, `stale` when older, `failing` when the node reports failing or its last failure is newer than its last completion, `unknown` without a report of the database within 45 min (a node names an unchanged database once in 15 min) or without a completed backup; `last_base_backup_at` is when that backup finished, `null` while unknown |
| `health.disk`      | `status` is `warning` from 90 % used and `unknown` without a usage sample within 180 s; `used_ratio` is used divided by allocated bytes of the newest sample, `null` when it measured nothing. An awake database is sampled every minute; a hibernated one cannot grow and is sampled once in each quarter hour, so it reads `unknown` between samples                                                                                                                                                   |
| `storage`          | `{used_bytes, allocated_bytes, observed_at}` of the newest sample the node's agent reported (at most a minute old for an awake database, at most 15 minutes for a hibernated one), with `null` figures where it measured nothing; the whole object is `null` before the first sample. It is not cut off by age: judge `observed_at` yourself                                                                                        |

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
  just before lives up to 30 s. The node then sets the role to `NOLOGIN`, ends its sessions and
  drops it; the operation is `succeeded` when PostgreSQL has confirmed that. Sessions that are open
  at the time are ended once the role is `NOLOGIN`: do not rely on one surviving the deletion.
- **A role that owns objects cannot be dropped.** If it owns objects or holds privileges
  (including default privileges), PostgreSQL refuses `DROP ROLE`: the operation ends `failed` with
  `error.code` `role_not_droppable`, and the role **stays unable to log in and unroutable**. To
  prevent it, connect as the role while it is live and run `DROP OWNED BY CURRENT_USER` (or drop
  its objects as `app`, which owns the `public` schema, and `REVOKE` what it holds) before
  deleting it. Afterwards `DELETE` the role again under a new `Idempotency-Key` (the old key
  replays the failed operation): a failed removal starts a new operation, and the node drops the
  role as soon as nothing depends on it. The old operation stays `failed`.
- **The name** is free again only when the removal is confirmed; creating it earlier is `409` with
  reason `role_being_deleted`. A role awaiting its removal counts toward the 100 roles
  (`role_limit`).
- **Hibernated database.** A suspended or idle-hibernated database has no PostgreSQL running, so the
  node applies the removal at its next wake. The operation reports `succeeded` at once because
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
The database must be `ready` (`409 "Database configuration is not ready"` otherwise). The node
runs the sleep proof: it stops new work, closes idle sessions, checkpoints, switches the WAL
segment, waits until every committed segment is in R2 and only then stops PostgreSQL; the volume
stays mounted. If sessions are busy, a prepared transaction exists or the
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

- A running database takes new memory and CPU limits as live limits on its unit, without ending its
  sessions; PostgreSQL's own settings follow the new memory at its next start, and storage grows
  online. A hibernated database changes immediately and starts on the new class at its next wake:
its memory and CPU are admitted by its node then, while its storage growth must fit the node now
(see below).
- The target class must be enabled and within the region's memory maximum. A running database that
  grows must fit the node now, else `503 capacity_exhausted` ("Current node has insufficient
  memory, CPU or storage"): the node has no observation from the last 180 s, its active RAM would
  reach 80 % with the extra memory, its CPU would exceed the node's cores, or, for extra storage,
  the node reports no thin pool or no room in it, or its sold storage would pass four times its
  pool. A smaller or equal size needs no room. A hibernated database waits for its next wake only for
  memory and CPU; growth of its storage is sold from now on and is refused with the same `503` on
  the same storage test.
- Storage may only grow; shrinking is `400` ("Storage shrink is not supported"). Growth through the
  API is **not yet verified live**.
- The operator can roll a new revision of a resource profile out to every database assigned to
  it; that changes your database's `size_class_id` (a hibernated one at its next wake). Read it
  with `GET /v1/databases/{id}/resource-profile`.

### 2.6 Delete

`DELETE /v1/databases/{id}` returns `202`; the node stops PostgreSQL, removes the volume (its chunks
return to the pool) and the Linux user, and the database record ends as `observed_state: deleted`
(on EU1 the volume left the node's report 37.9 s after the request, plan 11.1). The name is free at once. The backup archive is **retained** for the class's
`backup_retention_days`; the database stays restorable until `deleted_at + backup_retention_days`
(the API does not return that date). Role credentials and attributes are retained with it; a role
awaiting its removal is not. A project can be deleted only after all its databases have finished
deleting. Retained archives are removed by a cron after expiry.

A `409 conflict` from `DELETE` deletes nothing. Reason `mutation_in_progress` means another change
to the same database holds it at that moment: a wake, an idle sleep or its compensation, a move or a
node maintenance step. Retry with backoff and
jitter (for example 1 s, 2 s, 4 s, up to about two minutes) under the same `Idempotency-Key`;
`Retry-After` gives the first delay. Reason `generation_changed` means another request changed the
database first (for example deleted it); the retry returns that deletion's operation.

### 2.7 Backups, restorable window and restore

**What exists.** Each database archives WAL continuously to R2 (gzip) with Barman Cloud tools that
its node runs, and takes a base backup when it is created (it is ready only when that backup is
DONE), after a restore, before an idle sleep when one is due (none on the current timeline, or the
newest is older than 24 h) and, for an always-warm database, once the newest is older than 24 h. A
sleeping database is never woken to be backed up, and the sleep proof archives its last WAL first.
The Worker applies `backup_retention_days` as the recovery window: after each DONE backup it deletes
older base backups and the WAL only they needed, and it never deletes the newest DONE backup, so a
database that sleeps through its whole window keeps its last backup (plan 7.7).

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
in the future). `region_id` is optional and, when given, must be the source's own region: a node
reads only its own region's archives, so another region is refused with `region_unavailable`.

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

The restore is ready when its operation is `succeeded`: recovery has promoted the database onto a
later timeline, its roles are reset and the first base backup of the new timeline is DONE. Compare
your markers before cutover.

| `409` reason         | Meaning                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `archive_expired`    | deleted source past `deleted_at + backup_retention_days`, or its cleanup has begun                                                         |
| `no_recovery_point`  | no complete base backup ends at or before `target_time`, or its WAL chain has a gap                                                        |
| `archive_unusable`   | the v1 catalog reads at most 16,000 objects and 64 base backups per database, and the listing was incomplete, invalid or beyond that bound |
| `name_in_use`        | a live database of the project already has the target `name`; choose another                                                               |
| `source_unavailable` | the source's class is disabled, its region record is gone or its credentials are unavailable                                               |
| `region_unavailable` | the `region_id` of the request is not the source's own region (a restore stays in the source's region)                                     |
| `generation_changed` | the source, its retained archive or the placement changed under the request; retry                                                         |

A restore needs capacity like a create; without it the target waits unplaced and the operation
stays `pending`. Measured on EU1 (2026-10-18, a SaaS dataset of about 100,000 users and 600,000
tasks): a point-in-time restore was ready 154.6 s after the request when alone and 309.5 s with
three at once. That is not a recovery-time promise, and no node-loss recovery has been timed.

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
gateway answers AuthenticationCleartextPassword, logs in to PostgreSQL with SCRAM-SHA-256 on
the node and sends AuthenticationOk through ReadyForQuery as one message, so a new connection
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
  failed in an earlier acceptance under the retired runtime, on WebSocket and on direct TCP with
  node-postgres 8.22, and have not been run since; do not rely on binary result formats.
- One WebSocket message may be up to 32 MiB; the gateway sends frames of at most 64 KiB. `COPY`
  works over the same connection (a 105 MB binary `COPY` integrity check through the CLI passed
  under the retired runtime and has not been run on the node runtime).
- The gateway pings every 30 s and drops a connection that misses a pong; ordinary WebSocket
  stacks answer automatically.
- The StartupMessage must arrive within 10 s of the upgrade and is at most 10,000 bytes. A
  password pipelined with it is a PasswordMessage of at most 4,096 bytes; an empty, oversized or
  wrong one, an unknown role and an unknown database are all answered with the same `28P01`.
- The gateway logs in with a pipelined password (and over HTTP) only to a PostgreSQL that asks for
  SCRAM-SHA-256 with at most 100,000 iterations (PostgreSQL's default `scram_iterations` is
  4,096), or for no password; anything else answers `08006` and never receives the password.

### 3.3 TLS

Two hops carry your data over a network, and both are protected: your client to Cloudflare over
`wss` (Cloudflare terminates TLS for the hostname), and Cloudflare to the node's gateway through the
node's Tunnel and Cloudflare Access with a signed, 30-second route token. The last hop, gateway to
PostgreSQL, is a Unix socket on the node: PostgreSQL has no network address at all, and its unit has
no network. The gateway answers a PostgreSQL `SSLRequest` or GSS request with `N`, so a client that
requires protocol-level TLS (`ssl: true`, `sslmode=require`) fails; the WebSocket is the
encryption. A password pipelined with the StartupMessage travels inside that WebSocket to the
gateway, which proves it to PostgreSQL with SCRAM-SHA-256 and continues only after PostgreSQL's
server signature matches; the gateway never logs or stores the password and zeroizes it after the
login. Without a pipelined password (`pipelineConnect: false`, the CLI) SCRAM runs between your
client and PostgreSQL, and PGCF's Edge and gateway only relay it.

### 3.4 Timeouts and retries for a sleeping database

A sleeping database has no process: its volume stays mounted, and the next connection starts
PostgreSQL from it through the node's own admission. Measured on EU1 on 2026-10-19 (the plan's Done
rows; the first request is the SaaS page request, which the plan's rows record as 6 to 8
statements; the series differ in sample size, sleep time and statements, and the sample sizes are
too small for a p95):

| Series | First request |
| --- | --- |
| Worker through a service binding, asleep at least 2 h (5 databases) | 556 / 627 / 789 / 1,074 / 1,252 ms (median 789 ms) |
| Worker through the public hostname, asleep at least 2 h (5 databases) | 688 / 933 / 989 / 1,072 / 1,182 ms (median 989 ms) |
| Laptop, plain statements, asleep at least 2 h (5 databases) | 0.652 / 0.680 / 0.796 / 1.021 / 1.133 s (median 0.796 s) |
| The same request as one HTTP `/sql` transaction, asleep 60 to 137 min ([3.7](#37-http-query-mode-neon)) | median 611 ms through a binding (8 samples, all under 1 s), 648 ms through the public hostname (6 samples) |

The node's own part of a wake (admission, start to ready, release) had a median of about 220 ms; the
rest is the Cloudflare path. **The sub-second goal at p95 is not claimed yet**: it is go-live gate
G3 and needs at least 59 cold samples per stratum from a Worker and a laptop. PGCF publishes the
result only in the ULTRA plan's Done table; update this section from that row when G3 closes.

What the Edge does: it waits at most **60 s** for a wake (`ADMISSION_DEADLINE_MS`), coalesces all
connections of one database into one wake and admits at most 32 waiters per database. Giving up
removes your waiter only; the wake itself continues, so a retry soon after normally finds the
database ready.

Recommended policy (derived from those numbers, not a PGCF guarantee):

| Setting                                           | Value                                                                                                                                           | Reason                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect timeout                                   | at least 65 s; 70 s used above                                                                                                                  | 60 s Edge deadline plus login and startup (0.1–0.4 s); a wake that waits in the node's queue takes seconds, not milliseconds                 |
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
| `error` | the node reports a failure | escalate |
| `hibernated` (idle) and `57P03` | the wake could not start: the node is offline, lost or closed, or an admission change is in flight (at once); or the node refused the start after its queue wait, for want of room in its thin pool (DETAIL "storage") or because its awake capacity is full (DETAIL "node at awake capacity", with a retry hint); no wake operation starts | back off and retry; shed load |

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
suspended database is not woken by connections. On EU1 with a 60 s idle time a database was asleep
68 s after its last statement (the sleep proof and its report add 6 to 8 s), and an open idle
client connection did not keep it awake (plan 11.1, Stage 5.2).

### 3.6 Connection limits

| Limit                                                                                                         | Value                                                                                                                                                                                         | Where                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Server sessions                                                                                               | the class's `max_connections`; PostgreSQL reserves a few for superusers (the node agent connects as one) | PostgreSQL; refusal is `53300`                                 |
| Sessions of one role                                                                                          | the role's `connection_limit` when set ([2.3](#23-roles-connection-uri-and-passwords)) | PostgreSQL; refusal is `53300` "too many connections for role" |
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

**Measured on the live installation (EU1, 2026-10-19):** the format below is checked by the actual
`@neondatabase/serverless` 1.2.0 driver against the Edge and by the gateway's protocol tests. A
SaaS page request as **one `transaction()` on a database that had slept 60 to 137 minutes** (all
steps in one request) took 472 to 784 ms (median 611 ms, 8 samples) from a Worker through a service
binding to the Edge and 440 to 1,070 ms (median 648 ms, 6 samples) through the public hostname. The
first request statement by statement over a WebSocket, after at least 2 h of sleep, took a median
of 789 ms (binding) and 989 ms (public hostname) over 5 databases. These are separate series, not
a paired comparison, and small samples, not a p95.

`POST https://<host>/sql` serves the Neon driver's HTTP query mode: `neon()`, its
`transaction()`, and `Pool.query()` with `poolQueryViaFetch`. One query or one transaction is one
HTTPS request, with no WebSocket upgrade and no SCRAM exchange by your client. The Edge admits each
request as it admits a connection; the node's gateway runs it on a PostgreSQL session it keeps
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
| Password                 | Sent in the driver's `Neon-Connection-String` header over HTTPS to Cloudflare. The Edge forwards it once, in the request body, over the tunnel to the gateway, which authenticates to PostgreSQL with SCRAM-SHA-256 on the node, with the same login and limits as a pipelined WebSocket password ([3.2](#32-what-the-gateway-does-and-does-not-support)). It is never logged or stored and is zeroized in the gateway's memory after use.             |
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

The "Expected gain" column is an estimate, built on round-trip figures of earlier measurements
(15-42 ms per statement from a Worker, 0.47-0.53 s for an 8-statement request on an awake
database) that are not in the plan's current rows and were not re-measured on the node runtime.
PGCF has no paired measurement of the batching gain yet: the first request after sleep as one HTTP
transaction had a median of 611 ms (binding) and 648 ms (public hostname), the WebSocket series
789 and 989 ms, but the series differ in samples, sleep time and statements (3.4, 3.7).

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

### 4.1 Placement and node policy (installation configuration)

Where a new database goes is described in [2.1](#21-create). The per-database memory maximum is
4,096 MiB in steps of 256 unless the operator sets another. EU1 has 6 vCPU and 12 GB of RAM
(11,967 MiB visible to the system). What a node admits is decided by the region's node policy (an
admin reads it at `GET /v1/regions/{id}/node-policy`; ask the operator for its values): the memory
rule, the memory floor and the awake-database budget, how many starts may run at once, how long a
wake may wait for room, how long after a wake the CPU quota stays off (the CPU burst), early sleep, the pool reserve, the backup concurrency and the write limits.
The plan's starting values for EU1 are an awake budget of 9,937 MiB, a floor of 600 MiB, at most 4
starts at once and a wait of up to 10 s before `57P03` with a retry hint of 5 s; Stage 5 replaces
them with measured values.

### 4.2 Awake databases: what a sold memory size means

A database's memory is the hard ceiling of its PostgreSQL while it is awake; asleep it uses no RAM
and no CPU. The node admits every start itself, from its own facts (plan 4.6): its pool has room,
the memory rule holds and fewer than the policy's number of starts are in flight.

- **Memory rule `measured`** (the plan's default): the memory available to the node, minus every
  start in flight, minus the floor, must be at least the database's memory. Awake databases are
  not reserved against each other, so your 256 MiB is a ceiling and not a guarantee: if several
  awake databases grow at the same time, the kernel's limit on all databases together ends one
  backend, which may belong to another tenant; that database's PostgreSQL runs crash recovery, its
  sessions drop and no acknowledged commit is lost.
- **Memory rule `reserved`:** each awake database reserves its memory plus a small overhead within
  the awake budget; the memory is guaranteed while it is awake, and fewer databases can be awake at
  once (the plan counts about 37 of 256 MiB on a 12 GB node).

The operator tells you which rule is configured. The owner has not yet confirmed the default (plan
decision D3). A wake that does not fit waits in the node's queue for the policy's wait and is then
refused with `57P03` (DETAIL "node at awake capacity" and a retry hint). If early sleep is enabled
(the plan's default, decision D2, not yet confirmed by the owner), the node also puts one
idle-but-awake database to sleep for each waiting wake, before its idle time: never an always-warm
database and never one with client activity in the last 30 seconds. An early sleep is a full sleep
proof, so a wake that waited for it takes seconds and misses the one-second target. `awake_seconds`
keeps reporting the truth.

What you must do: keep `sleep_after_seconds` short, avoid always-warm classes except where needed,
and shed load on `57P03` instead of retrying in a tight loop.

### 4.3 Thin storage

Every database lives on its own thin LVM volume of its node's one thin pool. The volume's size is
the database's `storage_gib`, real space is taken only as the database writes (an empty database
used about 69 MiB when it was ready on EU1), and the pool does not grow. Sold sizes do not reserve
space: the sizes of the volumes on a node may add up to more than its disk, within a cap of four
times the pool's data. Chunks are zeroed before reuse, so space freed by one database is never
readable by another.

- **The pool.** Placement closes a node's pool at 80 % of its data, 50 % of its metadata or the
  cap: nothing new is created or restored there, and running databases keep running. A node whose
  pool has no room refuses every create, restore and wake with `57P03` and the DETAIL "storage". A
  pool that does fill fails writes at once, with no commit acknowledged without durable WAL; the
  affected databases stop, and the node recovers them by itself once space is back.
- **One volume.** Raising a database's storage is an admin call (`PUT /v1/databases/{id}/resources`,
  growth only, online); nothing grows a volume for you. `health.disk.status` becomes `warning` at
  90 % used, the threshold of the operator's critical alert (the operator is also alerted at 80 %).
  A full volume stops the database's writes; the node frees the filesystem's last reserve once so
  that PostgreSQL can recover and you can delete data or have the size raised.
- **Write limits.** Each database's write bandwidth and IOPS are capped by its size, which bounds
  how fast one tenant can fill the pool.

Watch size yourselves: `storage` and `health.disk` of the database show the newest volume figures,
sampled every minute while the database is awake and every 15 minutes while it is hibernated
(`pg_database_size()` and `storage_used_bytes_max` in usage, the largest sample of the hour,
remain the other sources). A volume can fill in a few minutes, so poll `health.disk` at least
once a minute for a database you are bulk-loading.

### 4.4 Your checklist

- Cap databases per tenant and per class; cap simultaneously awake databases.
- Choose `sleep_after_seconds` per database or per class; never leave transactions open.
- Watch each database's size and have it raised before it fills (4.3).
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
| `storage_used_bytes_max`, `storage_allocated_bytes` | maximum of the node's filesystem samples in the period (bytes used on the volume); the effective storage size |
| `backup_bytes_max`                                                   | maximum archive size in R2 measured in the period                                                                                                                             |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | gateway counters of the hour, summed over its measurement intervals (none spans two hours); `null` with `traffic_coverage` when an interval of the hour is missing or unknown |

For compute time price `awake_seconds` and `memory_mib_seconds`; for storage use
`storage_allocated_bytes` and `storage_used_bytes_max`; for traffic read `ingress_bytes` and
`egress_bytes` of final rows. The retired Kubernetes runtime's three `reserved_*` metrics are gone
from the contract and from every stored row (no backwards compatibility).

**Traffic across an hour boundary.** The gateway counts cumulative totals and the node agent reads
them once a minute. When two readings enclose a UTC hour boundary, the
bytes, connections and connection time counted between them are split between the two hours pro
rata by elapsed time, in whole numbers: the earlier hour receives the rounded-down share and the
later hour the remainder, so the two hours always add up to exactly what the gateway counted.
Example: 1,000 egress bytes counted between the readings at 11:59:45 and 12:00:45 are 250 bytes in
the 11:00 row (15 of the 60 seconds) and 750 bytes in the 12:00 row (45 of the 60 seconds). The
timing error is at most the interval between the two readings, normally about a minute, and only
in the two rows around a boundary; the sum over whole hours is exact. `connection_seconds` has
millisecond resolution.

**What stays unknown.** An interval is `null`, with `traffic_coverage` in `gaps`, when the gateway
process restarted or was replaced, a counter went backwards, a report was incomplete, no reading
arrived, or two readings are more than one UTC hour boundary apart (an agent outage of about an hour or
more). A reading that shows nothing counted is a measured zero, not a gap. Only awake time has to be
covered by readings: a sleeping database emits none, so an hour or part of an hour asleep without a
reading counts as zero traffic (and traffic counted against a sleeping database, such as a refused wake,
is added), while awake time without a reading is the gap above. A day row is `null` when any of its
hours is. Hours finalized before this attribution, or before the rule on sleeping time, was deployed
keep `null` traffic and are never recomputed.

**Infrastructure cost** (`GET /v1/costs`, **admin only**, hourly, at most 31 days, one node or one
region) is per node and built from monthly amounts the owner recorded as immutable facts
(`POST /v1/costs/node-facts`); hours without a fact are `unpriced_seconds` with a `node_rate`
gap. It is not attributed to databases. Ask the operator to export it for you.

**Not reported:** measured CPU or RAM consumption per database, cost per database or per project,
query counts and latencies, node RAM, CPU and disk time series (the plan records that node samples
live minutes and only current values are readable), per-connection or per-statement data, and
any price.

## 6. Alerts and operations

Alerts are infrastructure alerts for the **operator**. You do not receive them: they go to the
operator's alert webhook, which was configured on 2026-10-19. Four active episodes were delivered
that day and the receiver acknowledged them (plan 11.2); go-live gate G5 is met on the receiver
side, and every kind of alert carries its runbook action. The plan keeps the gate open until the
owner confirms the recipient. The operator reads the alerts' state in
`GET /v1/operational-health?scope=regions`.

One episode exists per region and kind. Its `event_id` names the error: the same error (same
region, kind and failing subjects) has the same `event_id` every time it occurs, also after it
cleared and came back, and a different set of subjects is a new error with a new `event_id`. An
episode is delivered at least once with retries at least 60 s apart and a five-second deadline
(a retry repeats the `event_id`, the `occurred_at` and the body), and clears only when its
measurement is fresh and below the threshold. A recurrence has the same `event_id` and a new
`occurred_at`; a receiver deduplicates the pair and treats a known `event_id` with a new
`occurred_at` as a new occurrence of the incident that ID names.

| Kind                                                          | Fires when                                                                                                                                   | Threshold (set in the capacity policy; the plan's value, 4.10, where it names one) |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `regional_node_ram_warning`                                   | any node's 30-minute average of active RAM reaches the threshold                                                                             | `node_ram_warning_threshold_ppm`, 850,000 (85 %) |
| `regional_node_cpu_warning`                                   | any node's 30-minute average CPU load reaches it                                                                                             | `node_cpu_warning_threshold_ppm`, 900,000 (90 %)  |
| `regional_node_storage_warning`                               | the node's thin-pool data or metadata fill reaches it (placement closes a pool at 80 % data or 50 % metadata)                                | `node_storage_warning_threshold_ppm`; the plan names no value (placement closes the pool at 800,000 for data and 500,000 for metadata) |
| `regional_node_cap_reached`                                   | allocated nodes reach `max_nodes`                                                                                                            | `cap_warning_enabled`, off by default            |
| `regional_node_stale`                                         | a node's observation is older than 180 s, or the node is marked lost and a database is still placed on it                                                                         | fixed                                             |
| `infrastructure_backup_failed`, `infrastructure_backup_stale` | the daily D1 backup fails, or none completed for 36 h                                                                                        | fixed                                             |
| `database_archive_failing`                                    | a running, awake database reports `health.archiving: failing`                                                                                | fixed    |
| `database_base_backup_stale`                                  | an awake database has no completed base backup within 36 h of awake time; hibernated ones are excluded and a wake restarts the count         | fixed                              |
| `thin_storage_blocked`                                        | a node's newest sample says its thin pool has no room, or a node that holds databases has no sample of its pool within 180 s (`thin_pool_*`) | fixed                                             |
| `regional_node_capacity_refusals`                             | a node refused 5 or more wakes for awake capacity (`57P03`) in 10 minutes                                                                    | fixed                                             |
| `regional_node_pool_closed`                                   | a node's newest sample closes its thin pool for placement: data at 80 %, metadata at 50 % or the sold storage at 4 times its data           | fixed                                             |
| `database_volume_warning`, `database_volume_critical`         | a database volume's space or inodes are at least 80 % (below 90 %), or at least 90 %, used                                                   | fixed                                             |
| `node_enrollment_refused` | a node's enrollment token was presented again with another key, or after it expired, within the last 24 h | fixed |
| `node_unexpected_reboot` | a node rebooted and no maintenance order of it asked for it, within the last 24 h | fixed |
| `control_cron_stalled`, `control_cron_step_failing`           | no minute-cron run completed for 300 s, or a step failed in each of its last 5 runs                                                          | fixed                              |

The values in the table are the plan's; the installation's own settings are read with
`GET /v1/regions/{id}/capacity-policy`. Thresholds are integer parts per million (1,000,000 = 100 %, valid 1 to 1,000,000, `null`
disables) set with `PUT /v1/regions/{id}/capacity-policy`. The minute cron evaluates the first
four regions that have a policy; the fixed-rule kinds are evaluated for every region.

Every event carries a short runbook action in `action`. The database kinds are per database but
one episode per region and kind lists up to 64 databases. Each minute-cron step runs in its own
failure boundary, so one failing step is logged and counted and alerting still runs; the cron's
own heartbeat is judged by a Durable Object alarm that does not depend on the cron
([operator runbook](infrastructure-backups.md#minute-cron-heartbeat-and-watchdog)).

The control plane itself is protected by a daily encrypted D1 export in R2, read back in full
([infrastructure backups](infrastructure-backups.md)); restoring it has not been exercised
(go-live gate G6). The daily export failed from 2026-10-17 until its cause was fixed on 2026-10-19;
the plan records the state. These backups are not your database backups.

What you can watch yourselves: per database `health.archiving`, `health.backup`, `health.disk`,
`storage` and `observed_state: error` ([2.2](#22-operations-and-readiness)), connection errors by
SQLSTATE, and `GET /healthz` of the API and of the database host (both only say that the Worker
runs). The operator-only `GET /v1/operational-health?scope=databases` lists the same backup and
disk verdicts for every project at once.

## 7. Failure and recovery

### 7.1 What happens in each situation

| Situation | Effect on your database | Data | You do |
| --- | --- | --- | --- |
| Idle sleep | PostgreSQL stops after the sleep proof (every committed transaction is in R2 first); the volume stays mounted; the next connection starts PostgreSQL from it | in R2 and on the volume | reconnect |
| Manual suspend | refused with `57P03` until resume | as above | `POST /resume` |
| Node maintenance cycle (new packages, a kernel update) | placement on the node is closed, so creates wait; the node holds new wakes with `57P03`, puts every awake database to sleep with the proof and reboots only if a kernel or core library changed; the first live cycle took 67 s end to end. Kernel security updates follow the owner's standing approval: within 7 days of a Debian advisory, in an announced window, one node at a time; other reboots need the owner's go and an announced window from the canary on. The announcement channel is not defined in the repository | kept | plan around the window; ask the operator for it |
| Node reboot or crash | every awake database stops with the node; when it is back, its agent finds each database that stopped without a proof, starts it through admission, lets it archive and proves its sleep, and a connection wakes it as usual. A hard power cut under writes on EU1 lost no acknowledged commit; the node reported again 26.8 s after the start request. No outage duration is promised | kept (local volume) | retry with backoff; check `observed_state` |
| Archiving failing (`health.archiving: failing`, for example an R2 problem) | connections keep working; WAL accumulates on the volume until archiving works again, and a full volume stops writes (standard PostgreSQL behaviour, not tested here) | recoverable window goes stale | escalate at once |
| Volume full | PostgreSQL cannot write; the node frees the filesystem's last reserve once so that it can recover | kept | free space, or have the size raised (admin `PUT /v1/databases/{id}/resources`) or move to a larger class ([2.5](#25-resize)) |
| Thin pool full | writes fail at once and the databases on the pool stop; the node recovers them by itself once space is back | kept | wait; retry `57P03` |
| **EU1 lost** | **all databases are down.** Their local volumes are gone with the server | only what reached R2 | [7.4](#74-eu1-lost) |
| Cloudflare unavailable | no path to any database: all traffic enters through Cloudflare. While the Edge still routes but the API or D1 is unavailable, awake databases keep running and wakes fail | kept | wait |

### 7.2 Recovery point

- There is no synchronous replica and no zero-loss promise for a lost volume: the last
  recoverable commit is the last WAL segment that reached R2. A database whose sleep was proven
  loses nothing.
- WAL is archived when a segment fills or after `archive_timeout_seconds`, so the exposure of an
  awake database is that timeout plus upload time. One measurement under the retired runtime
  confirmed committed WAL in R2 after 66.7 s with a 60 s timeout; that is a single sample and has
  not been repeated on the node runtime.
- A reboot with an intact volume loses no committed transaction. A clean idle or manual sleep
  archives the final WAL before PostgreSQL stops (the sleep proof), so a hibernated database is as
  recent as its last activity.
- Point-in-time recovery reaches any instant between the oldest retained complete base backup and
  the last archived WAL; `GET /v1/databases/{id}/backups` states the window of a database. The
  window per class is its `backup_retention_days`. It is derived, not measured per class.

### 7.3 Recovery time

A restore is a base backup restore plus WAL replay on a new volume, so it depends on the database
size and on capacity being available. Measured on EU1 (2026-10-18, a SaaS dataset of about 100,000
users and 600,000 tasks): a point-in-time restore was ready 154.6 s after the request when alone
and 309.5 s with three at once. **No node-loss recovery has been timed**, and a healthy-source
restore does not substitute for it.

### 7.4 EU1 lost

1. The operator verifies the node and declares it lost (`POST /v1/nodes/{id}/mark-lost`); its
   databases are unreachable. Fencing completes before anything moves: its Tunnel is deleted and its
   instance powered off ([recovery runbook](recovery.md#lost-node)). The operator can read each
   database's recovery point, the proven-sleep record and newest base backup the node last
   reported.
2. New capacity is needed before any restore can start. Reinstalling the same Contabo instance
   (AddNode `recover`) needs no purchase, but it is refused while a database of the node has no
   proven-sleep record for its current generation unless the owner acknowledges that unarchived
   WAL is lost for good; replacing a destroyed server is a purchase and needs the owner's costed go
   (**EU2 has not been bought**). The EU1-loss runbook with its preconditions checked is go-live
   gate G9 and is not finished.
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

- A first request after sleep under one second, measured at p95 (go-live gate G3; the first
  measured medians are in [3.4](#34-timeouts-and-retries-for-a-sleeping-database)).
- A second customer node, redundancy and a measured node-loss recovery time; automatic
  rebalancing (an operator can move a database under its ID; a restore always creates a new ID).
- Alerts for integrators (alerts go to the operator); alert history, acknowledgement and test send.
- Finding deleted databases: the lists exclude them, so keep the IDs you were given.
- An event stream or webhooks, an audit log of integrator keys (the administrator keys have one).
- Last-use display and key rotation as a feature; an API domain with rate limiting.
- Infrastructure metrics history and measured CPU and RAM per database.
- Changing a role after creation (expiry, limit, membership), user-chosen passwords, a grants API,
  per-role settings, renaming a database.
- Cancel requests, replication connections, TCP access; in HTTP query mode, `COPY` and
  `authToken`.
- Budgets, quotas per tenant, compute and storage autoscaling, branching.
- Maintenance-window notifications.
- Importing existing databases from another provider; moving them is your task.

## 9. Items for written confirmation

Go-live gate G11 requires this document to state the following and your written confirmation. The
state column says what is measured and what is derived or open.

| Item | Where | State |
| --- | --- | --- |
| RPO per class (including host failure as node loss) | [7.2](#72-recovery-point) | derived: `archive_timeout_seconds` plus upload time for an awake database, nothing lost after a proven sleep; one measured sample under the retired runtime (66.7 s with a 60 s timeout); no per-class measurement |
| PITR window per class | [2.7](#27-backups-restorable-window-and-restore), [7.2](#72-recovery-point) | derived from `backup_retention_days`; the window of each database is readable through `GET /v1/databases/{id}/backups`; no measured full-window restore |
| Ready only after the first base backup | [2.1](#21-create) | stated from the code; a create took 16.8 s on EU1 |
| Cold latency p50 and p95 | [3.4](#34-timeouts-and-retries-for-a-sleeping-database) | first medians measured on small samples; p95 not claimable until go-live gate G3 |
| `57P03` meanings, early sleep and retry rule | [3.4](#34-timeouts-and-retries-for-a-sleeping-database), [4.2](#42-awake-databases-what-a-sold-memory-size-means), [A.4](#a4-sqlstate-at-connect-time) | stated from the code and its tests; early sleep is the plan's default and not yet confirmed by the owner; the recommended retry policy is not a PGCF guarantee |
| What a sold memory size means | [4.2](#42-awake-databases-what-a-sold-memory-size-means) | a ceiling while awake; whether it is also guaranteed depends on the node policy's memory rule (plan decision D3, open) |
| Volume-full behaviour | [4.3](#43-thin-storage), [7.1](#71-what-happens-in-each-situation) | stated from the code; the full-pool and full-volume tests (Stage 5.5) have not run |
| Connection limits | [3.6](#36-connection-limits) | stated; the deployed per-role and per-network values are not recorded in the repository |
| Role deletion: unroutable at once, removal confirmed by PostgreSQL, hibernated database applies it at its next wake | [2.3](#23-roles-connection-uri-and-passwords) | stated from the code and its tests; **not yet run against the live node** |
| Outage classes and maintenance windows, including security reboots | [7.1](#71-what-happens-in-each-situation) | classes stated; no window schedule and no announcement channel is defined |
| IDs after restore, move and node loss | [1.2](#12-regions), [2.7](#27-backups-restorable-window-and-restore), [7.4](#74-eu1-lost) | stated: a restore and a node-loss recovery give new IDs; a move keeps the ID |
| Capacity caps | [4](#4-capacity-and-limits-you-must-enforce) | the plan's starting values only; measured caps follow Stage 5.6 |

## Appendix A. Error reference

### A.1 HTTP

Every error body is `{"error": {"code", "message", "request_id", "details"?}}`.

| Status | `error.code`              | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Retry                        |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 400    | `invalid_request`         | validation or unknown field, malformed JSON, body above 64 KiB, wrong `Content-Type`, bad ID, cursor or `Idempotency-Key`, a missing `Idempotency-Key` on a database or role mutation, unknown or disabled class or region, class above the memory maximum, `target_time` in the future, storage shrink, usage range not aligned or over 31 days, a role `valid_until` that is not in the future, a `member_of` entry that is not a live role of the database (or is `app`, `pgcf_maintenance`, `pg_*`, `cnpg_*`), deleting `app` or `pgcf_maintenance` | no                           |
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
| Contracts (IDs, size classes, states, usage, costs, alerts) | `packages/contracts/src/{ids,api,errors,auth,usage,costs,infrastructure-alerts,nodes,database-resources}.ts`                                                            |
| Create, resize, delete, power, restore, roles               | `apps/api/src/domain/{databases,lifecycle,restore,restore-catalog,roles,archive,retained-archives}.ts`                                                                       |
| Admission, wake, idle, `57P03` | `apps/api/src/database-actor.ts`, `apps/api/src/domain/{placement,node-observations}.ts`; the node's own admission: `apps/node-agent/src/admission.rs` |
| Edge, hints, SQLSTATE, deadline, decoy                      | `apps/edge/src/*.ts` (the Rust/Wasm port in `apps/edge-rust` applies the same policy)                                                                                        |
| HTTP query mode                                             | `apps/edge/src/sql.ts` (Rust/Wasm: `apps/edge-rust/src/sql.rs`), `apps/native-gateway/src/sql.rs`                                                                                                                     |
| Gateway limits, TLS, cancel, startup, idle close            | `apps/native-gateway/src/transport.rs`, `packages/native-protocol/src/activity.rs`, `packages/contracts/src/pg-wire.ts`, `packages/contracts/native/protocol.generated.json` |
| Sleep sequence and refusals                                 | `apps/node-agent/src/sleep.rs`, `packages/contracts/src/sleep.ts`                                                                                                            |
| PostgreSQL cluster, backup schedule, retention, `pg_hba` | `apps/node-agent/src/{settings,agent/build,agent/power}.rs`, `apps/api/src/domain/backup-retention.ts`, `infra/node-image/README.md` |
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
| `memory_mib` of a size class is a multiple of 256                                                                                                                                                      | `SizeClass`, `SizeClassUpsert`     | `400`   |
| `postgres`, `streaming_replica`, `pg_*` and `cnpg_*` are not role names, and `pgcf_maintenance` cannot be created                                                                                     | `RoleName`, `RoleCreate`           | `400`   |
| `valid_until` must lie in the future when the request executes (not on a replay); every `member_of` entry is a live role of this database that is neither `app`, `pgcf_maintenance` nor being deleted | `RoleCreate`                       | `400`   |
| A usage request names exactly one scope; both boundaries are aligned to the granularity and at most 31 days apart                                                                                     | `getUsage`                         | `400`   |
| A request body is JSON of at most 64 KiB with `Content-Type: application/json` whenever there is a body                                                                                               | `info.description`                 | `400`   |
| Idempotency keys are kept 24 hours per API key; a request that failed is not retained                                                                                                                 | `Idempotency-Key` of each mutation |         |
| A deleted database is read with `200` and `desired_state: deleted`                                                                                                                                    | `getDatabase`                      |         |
| An operator route's `409` carries a `details.reason` only where it is one of the listed reasons                                                                                                       | [A.1](#a1-http)                    |         |
