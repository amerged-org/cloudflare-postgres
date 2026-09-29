# One-use environment commissioning checkpoint — 2026-09-29

The installation API can now issue an exactly bound, short-lived permit for
one ordinary environment-create request while regional admission remains
closed. This is generic commissioning authority. It does not reserve physical
capacity, supply a runtime allowance, prove native PostgreSQL access or complete
backup/PITR qualification.

The permit freezes organization/project, region, catalog version/hash, name,
profile, volume and independently resolved specification hash. Ordinary current
organization `projects:write` authorization is still required to consume it.
The permitted request retains the ordinary resolved specification, create
operation and idempotency identities. Omitted-permit request hashes remain
compatible with earlier clients.

One D1 batch rechecks actor authority, project/region/catalog, requested project
budget pause and unspent permit expiry using the database clock. It creates the
environment, operation and normal request identity, then consumes the permit.
Every expected mutation has a rollback-enforced single-row assertion. Explicit
invalid permits never fall back to globally open admission. Exact retries
recover their original identities without renewing execution permission.
Installation-only issue/read/revoke operations retain immutable bindings and
replay records; revocation does not stop or delete a consumed environment.

Migration `0017_environment_admission_permits.sql` adds two tables and five
triggers. The [contract](../contracts/environment-admission-permits-v1.md)
records expiry, authority, recovery and the operational activation boundaries.
With 17 migrations, full multirow capture is 96,524 UTF-8 bytes and the legacy
capture statement is 97,350 bytes, below the unchanged 99,000-byte guard. This
leaves limited schema headroom; it is not a reason to silently omit tables or
raise the provider limit.

Exactly two new Worker cases and one expanded existing Node recovery case
failed first for the missing API/schema. Named iteration files subsequently
passed 15 Worker cases and five recovery cases. Tests cover exact binding,
authorization, original response identity, same-key concurrent replay,
different-key one-use consumption, revocation, database-clock expiry after a
preliminary read, known requested pause and actor revocation before the write
batch. They do not directly interleave permit revocation or budget pause with
consumption. The existing recovery case preserves both new tables exactly
alongside historical credentials, backup and resize records.

The frozen source passed the canonical format/lint/typecheck/Vitest/Node gate
exactly once in **26.200 seconds**, with **33 Worker and 55 Node cases** passing.
Unchanged Go code retains its prior evidence. OpenAPI parses, all 787 local
references and path parameters resolve, and all 65 operation IDs are unique.

Before any Dev schema delivery, one current 16-migration control snapshot was
captured, sealed and independently rebuilt offline: 47 tables, 49 rows,
integrity `ok`, zero foreign-key errors. Its temporary admin-token file was
removed. The live baseline has one organization, one project, zero managed
environments, zero resize/backup rows and no open admission record. No permit
or catalog was issued by this qualification; actual capacity, PostgreSQL,
funding and operational cleanup remain acceptance gates.

## Public source and Dev delivery

Source commit `54ddda5` and its migration were published and read back from
GitHub with matching blob identities before delivery. The selected Dev D1
received the additive migration once through the authenticated API. Its two
tables and five triggers matched all seven pinned SQL definitions; new table
counts were zero and the foreign-key check was empty. Migration history was
recorded only after schema verification and then read back as all 17 names.

One Wrangler 4.142.0 dry run passed, with no known credential values in its
bundle. One `--keep-vars` deployment completed in 9.310 seconds. Provider
readback confirms version `90bdb453-118d-40b6-8e4c-48630f1fcaf7` serves 100%
and all eight existing Secret names/types are unchanged. No Secret value was
queried from the provider. Four read-only HTTP probes verify an authorized
unknown permit returns 404, unauthorized access 401, the existing project 200
and closed admission 200. The original Python User-Agent rejection is retained;
the maintained Node fetch transport passed without changing a security rule.

Fresh post-delivery capture, sealing and independent offline restore each ran
once against the actual 17-migration Dev D1. They preserve **49 tables and 50
rows**, with integrity `ok`, zero foreign-key errors and activation disabled.
The 96,524-byte statement returned an 83,016-byte snapshot, sealed into a
111,422-byte bundle. All prior table counts are preserved except the one new
migration-history row; both permit tables remain empty. The original oversized
compound count-query diagnostic is retained; bounded scalar counts and the
complete rowset capture passed. Pre-migration snapshot/bundle hashes remain
unchanged, and temporary capture tokens were removed.

The installation still has one organization and project, zero API-managed
environments, zero permits and permit requests, and closed admission. No
commissioning permit, catalog or new regional execution authority was issued.
The regional workload image is unchanged. The new API path needs its positive
PostgreSQL and recovery/cleanup qualification before commissioning a real pilot.
