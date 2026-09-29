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
