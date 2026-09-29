# Managed role and database lifecycle v1

Create a restricted login role, create a database owned by that role, retrieve
the applied credential and rotate its password through the existing management
API. These are generic adopter operations for restricted roles and database
ownership. Table-grant administration, billing, public endpoint setup and database
deletion are outside this workflow.

The [OpenAPI contract](../../apps/control-api/openapi.yaml) describes the seven
customer methods below. Their detailed behavior is defined by the
[role contract](../contracts/database-role-credentials-v1.md) and
[owned-database contract](../contracts/owned-databases-v1.md). The contract describes
implemented API behavior; it does not establish a qualified production installation.
The current Dev lab has closed admission and no API-managed environment.

## Before making a request

Use the adopter's HTTPS management origin and replace every angle-bracket
placeholder with the corresponding real identifier or organization token. An
operator must already have configured the dedicated credential keyring, qualified
and admitted the region, and provisioned an environment in your project. A logical
project's `active` status is insufficient: new role/database work requires a ready,
running environment in an active project and enabled region.

Use an organization token with `projects:read` for metadata,
`projects:write` for create/rotate/credential disclosure and `operations:read` for
operation polling. Installation, region, meter and budget-grantor credentials do
not substitute for this customer authority. Do not put credentials in URLs or log
credential-response bodies; responses carry `Cache-Control: no-store`.

The examples are HTTP request templates. Their names and connection limit are
examples, not platform defaults. Each mutation has a stable `Idempotency-Key` for
one logical request at its exact path. After a lost HTTP response, retry that
same path, body and key. A different body with the same key returns
`409 idempotency_conflict`; minting a new key does not resolve an uncertain outcome.

## 1. Create and observe the role

```http
POST /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/roles
Authorization: Bearer <ORGANIZATION_TOKEN>
Content-Type: application/json
Idempotency-Key: role-create-01

{"name":"application_owner","connectionLimit":20}
```

The body accepts exactly `name` and `connectionLimit`. The name is a lowercase
identifier of at most 63 characters; reserved system/bootstrap names and
`pg_`/`cnpg_` prefixes are refused. The connection limit is an integer from 1 to 1000. The server generates the password; callers supply no privileges, memberships,
password, backend URL or namespace.

`202` contains `{role, operation}`. Save `role.id` and `operation.id`. The operation
kind is `database.role.apply` for both creation and rotation. The accepted response
is immutable and an exact POST replay can still contain its original pending
state after execution finishes. Read current progress explicitly:

```http
GET /v1/organizations/<ORGANIZATION_ID>/operations/<OPERATION_ID>
Authorization: Bearer <ORGANIZATION_TOKEN>
```

Queued/running operations are pending; `applied` and `failed` are terminal for
this role/database lifecycle. Inspect a failed operation's stable `resultCode`.
Use your own finite operation deadline and stop on unresolved failure; do not
blindly repeat SQL or create another intention to bypass an uncertain task.

```http
GET /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/roles/<ROLE_ID>
Authorization: Bearer <ORGANIZATION_TOKEN>
```

The response is `{role}` with status and desired/applied credential revisions,
without a password. Continue only when the current role is applied and both
revisions match. Metadata is observed control state, not continuous SQL reachability.

## 2. Retrieve the role credential when needed

```http
GET /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/roles/<ROLE_ID>/credentials
Authorization: Bearer <ORGANIZATION_TOKEN>
```

This read requires write scope. Its `{credential}` contains `roleId`,
`credentialRevision`, `username`, `password`, `database: "app"` and `observedAt`.
Disclosure waits for the latest desired revision to be applied and verified;
pending, failed, superseded or unavailable execution state returns a conflict.
There is no selector for an older password.

The bootstrap `app` credential supplies a restricted login. It does not itself
grant ownership of an application database or access to existing application
tables. Use the owned-database credential in the next step for that database.

## 3. Create and observe the owned database

```http
POST /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/databases
Authorization: Bearer <ORGANIZATION_TOKEN>
Content-Type: application/json
Idempotency-Key: database-create-01

{"name":"application","ownerRoleId":"<ROLE_ID>"}
```

The body accepts exactly `name` and `ownerRoleId`. The owner must be an applied
role from this same environment. Database names follow the lowercase identifier
rules and exclude `app`, `postgres`, `template0`, `template1` and system prefixes.
The server selects the fixed retained database specification; the request accepts
no SQL, arbitrary backend, password or administrative privilege.

`202` contains `{database, operation}` with operation kind `database.create`.
Save both IDs and poll the organization operation route until this operation is
applied or failed. A queued/running creation holds its owner's rotation lock,
including while an expired lease awaits reconciliation.

```http
GET /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/databases/<DATABASE_ID>
Authorization: Bearer <ORGANIZATION_TOKEN>
```

This returns `{database}` and the last accepted non-secret database observation.
An applied observation includes the regional ownership/migration-verification
result; it does not promise continuous availability, backups or an external endpoint.

## 4. Retrieve the application database credential

```http
GET /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/databases/<DATABASE_ID>/credentials
Authorization: Bearer <ORGANIZATION_TOKEN>
```

Write scope is required. The `{credential}` contains `databaseId`, `ownerRoleId`,
the owner's latest applied `credentialRevision`, `username`, `password`, the
application database name, `observedAt` and `credentialVerifiedAt`. The first
timestamp belongs to the database observation; the second belongs to the owner
credential observation. The database's original create operation does not select
the password returned after a later owner rotation.

Keep this response private and pair it only with the separately configured,
verified PostgreSQL endpoint and public CA from your operator's connection setup.
The API returns no host, port, CA certificate or connection URL. Do not infer a
public endpoint from a project, environment, applied role or database alone.

## 5. Rotate without replaying an old credential

Read the role's current applied revision, then submit that exact integer:

```http
POST /v1/organizations/<ORGANIZATION_ID>/projects/<PROJECT_ID>/environments/<ENVIRONMENT_ID>/roles/<ROLE_ID>/rotate
Authorization: Bearer <ORGANIZATION_TOKEN>
Content-Type: application/json
Idempotency-Key: role-rotate-01

{"expectedCredentialRevision":1}
```

The revision `1` is an example: replace it with the value you just observed.
The body accepts only `expectedCredentialRevision`. `202` creates the next
credential/apply operation and returns no password. A stale revision, competing
rotation, owner-locked database creation or unavailable environment conflicts.
Poll the operation and role metadata, then retrieve the database credential again.
During rotation its disclosure waits; after successful application it returns
the new current owner password. Exact replay of an earlier rotation request does
not reveal or restore an old password. Existing PostgreSQL sessions may survive
rotation, so update client credential custody and reconnect deliberately.

## Responses and recovery

Only creation and rotation take JSON bodies and require `Idempotency-Key`; the
seven lifecycle methods accept no query parameters. Metadata requires read scope,
while disclosure is deliberately write-scoped. Missing/foreign resources return
`404`; malformed requests return `400`; missing/invalid authorization returns
`401` and insufficient scope returns `403`. `409` means the stated intent or
current execution/credential prerequisites conflict. `503` can indicate missing
credential-key custody, and `500` indicates unavailable state/processing.

Read current metadata/operation before handling a conflict. If an accepted-create
response was lost, the existing paginated role/database collections can recover
resource IDs and `currentOperationId`; use the same logical request key for its
immutable accepted response. Collection reads have their own documented
`limit`/`cursor` parameters in the [recovery-read contract](../contracts/recovery-reads-v1.md).

Native provisioning, migrations, public connectivity, backup/PITR, tenant
isolation and runtime budget enforcement still require their own installation
evidence. The production gates remain in [PLAN.md](../../PLAN.md).
