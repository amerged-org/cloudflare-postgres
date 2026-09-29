# Restricted PostgreSQL role boundary and CNPG readback compatibility

One native manual CNPG/PgBouncer qualification verifies a fresh restricted role's
selected PostgreSQL privileges through verified TLS. It exposes and fixes a real
CNPG JSON-readback incompatibility in the product's role and database-owner
comparators. This is selected privilege evidence, not full API-managed customer
provisioning or complete production tenancy.

## Observed source defect and bounded correction

CloudNativePG 1.30.1 serializes its default-false `superuser`, `createdb`,
`createrole`, `replication` and `bypassrls` booleans with `omitempty`, and omits an
empty `inRoles` list. The product required explicit false/empty fields and thus
rejected valid typed API readback. A shared helper now normalizes only truly
absent values for those documented defaults. Null, present undefined/wrong types,
true privileges and nonempty memberships are retained for rejection. Inherit
has a default-true pointer representation: the required explicit false is never
normalized. Name, Cluster, login, ensure, connection limit, password Secret,
ownership, revision, readiness and SQL verification remain strict.

The role lifecycle's created/stable/rotation comparisons and the database owner's
restricted-role check reuse that helper. Two existing top-level cases reproduce
the observed omission and fail meaningfully in 0.182 seconds. They pass in
0.181 seconds on implementation attempt one while retaining explicit privilege,
membership and missing-inherit refusal without extra writes. No new top-level
test or matrix is added. Independent bounded review passes.

One frozen canonical gate passes in 20.885 seconds: 27 Worker and 41 Node cases,
with six unchanged Go cases retained as prior source-valid evidence, so the
existing 74-case total is unchanged. No full gate is repeated.

## Native fixture and exact SQL evidence

Only one fresh immutable basic-auth Secret, one DatabaseRole and one restricted
client Pod are created in the existing manual lab namespace. The existing trusted
controller generates a 32-byte random password directly in Kubernetes; it is never
printed, persisted locally or embedded in command arguments. Secret reads project
only fixed identity/type/immutable fields and discard raw failure output. Clients
use Secret references and mount only the existing public frontend CA certificate.

The role's explicit restricted attributes and empty memberships match the product
contract. Explicit `databaseRoleReclaimPolicy: delete` applies only to this fresh
absent ephemeral role. The normal API's lifecycle/retention policy is unchanged.
Before creation, exact SQL absence, original Namespace/Cluster identities and
absence of the three resource names are verified. The cached official PostgreSQL
18.4 client is nonroot, has no service-account token or data volume, uses a read-only
root and a bounded temporary directory. No new image or PostgreSQL storage is made.

The first actual case stops before SQL: its private observer repeats the explicit
false-field error and records a transient Secret access denial while the operator
has not yet converged its named permissions. Exact cleanup passes in 8.752 seconds;
no privilege success is claimed from that run. Reports and original command
outputs stay archived. The corrected same case uses documented default semantics
and waits for the operator-owned Role to grant get/watch for the exact new Secret,
then requires applied/current generation and the exact password Secret version.
There is no manual RBAC patch or broad Secret access.

An owner reference is added to align fixture ownership with the product. It is
not the RBAC mapper's cause: pinned upstream maps DatabaseRole events by Cluster
reference and namespace and derives resourceNames from password Secret references.
The transient initial denial alone is not an operator defect.

The same case passes on actual attempt two in 14.466 seconds, with one observer
correction and seven fixed checks:

- Fresh session/current user, correct database, writable primary, verified TLS,
  restricted flags/connection limit, zero memberships and no dangerous predefined
  file/program role membership.
- TEMP-table insert/read inside a transaction, acknowledged rollback and object
  absence afterward.
- Four exact SQLSTATE `42501` refusals: transactional SET ROLE postgres,
  transactional CREATE ROLE of a fresh NOLOGIN name, zero-byte server-file read of
  a nonexistent nonce path, and COPY to the harmless PROGRAM `true`.
- Fresh restricted reconnect after those refusals.

Unexpected success fails the case. Transactional role/identity changes roll back;
no database is created, existing table is modified or real server file is read.
These checks do not establish every extension, SECURITY DEFINER, grant or kernel
escape boundary.

## Cleanup and actual controller delivery

Client cleanup precedes exact UID/resource-version Role deletion. CNPG's finalizer
removes the owned SQL role; CR and SQL absence are verified before deleting the
Secret. No `ensure: absent`, forced finalizer, direct DROP of another role or
ownership adoption is used. Lost create responses recover only sealed intent and
exact private metadata for cleanup, never resume the probe or retry creation.
All three resources and the fresh SQL role disappear. All 21 original SQL-role
OIDs/attributes and original operator-owned Role rules return exactly to baseline.

Source commit `02aef0ba515383ea616ddca6994c393bf0092d63` supplies one sealed 72-file
public-only nonroot Linux/AMD64 build, completed in 33.030 seconds. All GitHub blobs,
archive/index/architecture/configuration digests are verified. No environment,
credential or private artifact enters that context.

The first authenticated image transfer reaches its 45-second deadline and fails
in 45.101 seconds. Same-reference readback establishes absence, Node/API remain
healthy and server logs explicitly record canceled Write. That terminal evidence
precedes one retry of the exact unchanged archive/reference under a 120-second
bound. It succeeds in 48.222 seconds; no new image/build/ref or third retry is used.
The failed import remains recorded. Exact cached digest precedes one guarded
image-only patch in 0.200 seconds and Ready rollout in 0.940 seconds.

All 64 compiled module hashes and the actual normalizer's documented omissions/
strict invalid-value behavior match the frozen source. The Node UID/boot stays
Ready, all 28 other Running Pod identities/restarts, four PVC and five PV specs,
source Cluster UID/spec/Ready state and both SQL markers are preserved. All 4,096
usage facts/evidence hashes, source identity, schema-two journal and existing safe
404 diagnostic remain exact. No usage is accepted, finalized or reassigned.

## Remaining qualification

The manual role/psql path does not invoke the product's fresh-password verification
functions or establish an API-managed environment. Positive API-to-CNPG role,
rotation/old-password invalidation, owned database and native endpoint acceptance
remain separate requirements. The stopped standalone SQL verifier is not resumed.
No D1 environment, customer credential, budget authority, policy admission or
Cloudflare provider resource is created by this exercise.

Backups/PITR, the pending scoped S3 credential approval, public/native gateway,
complete isolation, final accounting, enforced stop/wake and autoscaling remain
open in [PLAN.md](../../PLAN.md). Local environment files stay unchanged/private
and outside Git. Raw passwords, Secret payloads and private role/Pod identities
are never published.

Sources: [CNPG role fields](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_types.go#L2398-L2482),
[operator named Secret access](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/roles.go),
[PostgreSQL file privileges](https://www.postgresql.org/docs/18/functions-admin.html),
[COPY program privilege](https://www.postgresql.org/docs/18/sql-copy.html).
