# One-use environment commissioning — v1

Status: additive source implementation candidate. No permit is issued in Dev by
this change, no region is opened, and no managed PostgreSQL environment is
claimed as qualified. Physical backup/PITR, native access, capacity, funded
runtime authority and operational cleanup remain independent acceptance gates.

## Purpose and authority

Installation operators need to commission one explicitly approved environment
while ordinary regional admission remains closed. A permit is a retained
resource identifier, not a substitute organization bearer token. Its consumer
must still hold current organization `projects:write` authority for the exact
parent. There are no consumer-specific identities or default profiles.

Commissioning authorizes acceptance of the existing create operation. It does
not reserve capacity, grant a runtime allowance, establish recovery freshness,
or authorize later resize, backup deletion, host updates or broad admission.
The ordinary resolved profile, including required backup configuration and
any opted-in execution fencing, is unchanged. An explicit project budget
requested pause prevents new admission even when a permit exists.

## Installation API

`POST /v1/environment-admission-permits` requires the installation bootstrap
bearer token, JSON content and an `Idempotency-Key` matching the usual 1–128
ASCII key syntax. Its body contains exactly:

- `organizationId`, `projectId`: existing opaque parent UUIDs.
- `name`, `regionId`, `catalogVersion`, `profileId`, `volumeGiB`: the existing
  environment-create input, with the same validation and profile bounds.
- `catalogHash`: the immutable published catalog SHA-256.
- `specHash`: SHA-256 of the platform-resolved ordinary environment specification.
- `expiresAt`: canonical `YYYY-MM-DDTHH:mm:ss.sssZ`, in the future and no more
  than one hour from issuance.

The server loads the immutable catalog, validates the selected volume/profile,
resolves the full profile and independently compares both supplied hashes.
Those hashes are assertions of the operator's intended approval; caller-supplied
hashes cannot select a different specification. Resolution uses the existing
version-one JSON representation: ordered `name`, `regionId`, `catalogVersion`,
`profileId`, `volumeGiB`, then the normalized full catalog `profile`. Operator
tooling must use that representation, including trusted backup references,
rather than the reduced public profile. No secret values are returned.

`201` returns `permit` with the exact binding, immutable issue/expiry times,
status, and nullable consumed environment/operation IDs and terminal times.
Issue requires an active exact parent, a non-disabled region and the unchanged
catalog hash, checked again in its atomic write batch.

`GET /v1/environment-admission-permits/{permitId}` uses installation authority.
`POST /v1/environment-admission-permits/{permitId}/revoke` uses the same authority,
its own idempotency key and an empty JSON object. It returns `200` after revoking
unspent authority. A consumed permit cannot be revoked; this API never deletes
the resulting database or changes admission. Expired unspent permits may be
revoked. Missing resources return `404`; terminal/concurrent conflicts return
`409`.

Installation permit idempotency keys are shared between issue and revoke.
Exact replay returns the same retained permit with its current state, even
after issue expiry or a terminal transition. Changed action, path or body
returns `409 idempotency_conflict`. Binding fields and retained request records
cannot be changed or deleted through database writes.

## Ordinary environment creation

The existing `POST /v1/organizations/{organizationId}/projects/{projectId}/environments`
body gains optional `admissionPermitId`. Omission preserves its existing
request hash and region-wide admission path. Explicit `null`, malformed IDs or
unknown body properties are invalid requests. A supplied but unavailable,
expired, consumed, revoked or mismatched permit returns a conflict and never
falls back to globally open admission.

The supplied permit is included in the ordinary environment-request hash, but
never enters the resolved specification or changes its hash. The exact binding
includes organization, project, region, catalog version/hash, profile, name,
volume and full resolved specification hash.

Before checking fresh admission, the API checks the existing organization-wide
environment idempotency identity under current scoped actor authority. An exact
retry returns the same retained environment and operation identities, even
after consumption or expiry. Changed body/permit/path under the same key
conflicts. No retained response grants renewed execution authority.

Fresh creation uses one D1 batch to assert current actor identity/scope, active
project, non-disabled region, unchanged catalog hash, absence of a requested
project budget pause and exact unspent permit authority. The batch inserts
the environment, normal queued create operation and normal idempotency request,
asserts every expected write, then consumes the permit. Any failed assertion or
constraint rolls the whole batch back. Concurrent different create keys can
therefore produce at most one environment per permit. Lost responses use the
retained normal request identity; they never re-spend the permit.

Expiry is checked using the database clock in the transactional assertion and
consume update. A slow request that passed a preliminary read cannot spend a
permit after its deadline. The terminal database trigger independently checks
the resulting immutable environment/catalog and actual create-operation
ownership before accepting consumption. Current global admission is left as
configured throughout this flow.

## Persistence and bounded verification

Migration `0017_environment_admission_permits.sql` adds two tables. The frozen
canonical `binding_json` stores name, profile, volume and catalog hash without
duplicating them in additional columns. Relational parent/catalog identities,
specification hash and expiry remain immutable. Terminal consumption/revocation
and retained operator request identities are protected by database constraints
and triggers.

The control-recovery archive remains version one and includes both tables.
With all 17 migrations, the complete ordered rowset query is 96,524 UTF-8 bytes;
the legacy snapshot query is 97,350 bytes. Both remain below the unchanged
99,000-byte project bound. The encrypted offline recovery test preserves the
exact new rows, alongside historical credentials, backup identities and resize
intentions. The archive is not a live activation protocol; recovery fencing and
off-node custody remain separate work.

Two new Worker cases cover authorization, exact binding/replay, bounded expiry,
different-key consumption races, revocation, explicit no-fallback behavior,
known project pause and actor revocation before the transactional batch. One
existing Node recovery case is expanded. All three failed first for missing
source/schema and subsequently passed targeted checks. No test matrix or
production qualification is inferred from those results.
