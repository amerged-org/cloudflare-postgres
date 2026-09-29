# Native readback shapes and stopped operator qualification

The first real operator-lab native-access attempt identifies two mismatches in
the deployed readback contract. A read-only audit of the existing manual CNPG
database confirms its RW Service port name is `postgres`, while the product and
mock fixtures expected `postgresql`. The actual JavaScript SDK also returns Pod
list items without `kind`/`apiVersion`, unlike the mocked Pod objects.

Source commit `c4f7cc0`, integrated as `6daa265`, corrects both representations.
The Service and EndpointSlice checks require the verified exact name `postgres`;
the client port remains 5432. Pod listing reuses the existing bounded inventory
projection to add only the trusted endpoint's omitted `Pod`/`v1` metadata.
Explicit null/foreign types, duplicate identities, excessive items and incomplete
pages remain refusals. No second page or weaker ownership/TLS check is introduced.

## Bounded source verification and delivery

One existing native convergence case is expanded and one SDK case is added. The
SDK case uses the actual installed client against an explicit loopback-only HTTP
fixture, without credentials or production TLS changes. Its first transport setup
failure is not meaningful red evidence. The narrowly corrected fixture supplies
both intended failures in 0.542 seconds: omitted Pod type information and rejection
of the real stock port name.

Implementation check one passes native behavior but exposes an SDK-model/literal
prototype comparison in the fixture. A value-preserving test correction passes
all three named cases on check two in 0.490 seconds. No matrix, permutation or new
negative suite is added. The source change stays within five files, including the
contract correction.

The isolated dependency setup also records a parent-path preparation failure and
a refused unsafe symlink removal, before changing dependencies. One subsequent
offline frozen-lockfile installation succeeds without changing main dependencies
or package configuration. The regional package is built before checking compiled
artifact consumers.

The frozen canonical gate passes exactly once in 33.349 seconds: format, lint,
typecheck, 28 Worker cases and 46 Node cases. Six unchanged Go cases retain their
earlier source-valid evidence. The task baseline increases from 79 to 80 through
exactly one new case; the other relevant case is an existing expansion.

The public source and exact five GitHub blobs are read back. One nonroot AMD64
image builds in 34.742 seconds from 74 public inputs, with no private environment
or artifact in its context. One authenticated 120-second-bounded import succeeds
in 7.834 seconds; exact cache/OCI identities precede one guarded image-only patch
in 0.200 seconds and Ready rollout in 0.937. All 66 compiled modules and actual
configuration digest match the verified image.

Node boot, 28 other Running Pods, four PVC/five PV specs, source Cluster, both SQL
markers and all 4,096 journal rows are preserved across that delivery. Configuration
and the already-qualified 16 RBAC rules stay exact; native profiles remain absent.
Worker, Cloudflare/D1/Secrets, admission and budget flags are not changed.

## Operator fixture scope and preparation

One disposable, independently tagged CNPG database exercises the shipped native
helpers through a trusted operator adapter. It is not a Cloudflare claim or an
API-managed customer. The whole environment reconciler and stopped credential
verifier are never called. No control-plane customer, catalog or allowance record
is fabricated. Fixture namespaces/workloads carry no tenant billing labels.

The measured capacity before preparation is 2,245m unreserved CPU, 4,150 MiB
unreserved RAM, a fresh five-minute minimum of 4,306 MiB available memory and
76.496 GiB free thick LVM storage. Quotas bound the fixture to one five-GiB volume,
two database/bootstrap Pod slots and two small client slots without client PVCs.
Both official PostgreSQL and CNPG init images are already cached.

Image preparation preserves the original full-tag alias lookup absence. Cache
identity uses the canonical digest reference, while CNPG's upgrade detection
requires the version tag plus the same digest in the Cluster spec. An initial CRD
enum assumption and a later SHA-only rejection remain recorded; the second narrow
preparation correction passes server dry-run before any object creation.

The intended single case requires one allowed client with fresh `verify-full`,
temporary transaction rollback and reconnect, plus a different ServiceAccount in
the same protected namespace with exact ingress PolicyDenied evidence. Passwords
would be copied only inside the trusted controller to immutable Secret references;
the parent never receives their bytes. Neither actual attempt reaches that copy
or the client/SQL phase.

## Two actual failures: qualification remains stopped

Attempt one stops in the native helper before creating its grant. Its generic
safe error conceals the exact failed source predicate. The entire run and cleanup
complete in 45.849 seconds. The subsequent read-only audit supplies the two concrete
shape defects above; no positive connection evidence is claimed from the attempt.

After deploying the source correction, attempt two reaches the native grant
creation but withholds the final proof: `native_proof_unavailable`, phase
`native_readback`, `createAttempted: true`, `createUncertain: false`. The helper
fails before credential copying, client Pods or SQL. The run and guarded cleanup
complete in 120.817 seconds. No particular identity/resource-version race is
asserted without evidence identifying the changed comparison.

This is the same physical case with two actual attempts. Its mandatory stop remains
in force: no third probe, replay, assertion weakening, broader source change or
successful private-client qualification is claimed. The smallest proposed next
step is a read-only diagnosis of the specific final identity/version comparison,
not another qualification attempt.

## Cleanup boundary

Only sealed fresh Namespace/Cluster/Pod/policy/PVC/PV identities are eligible for
cleanup. Unknown create/delete outcomes recover metadata or wait under the same
intent, without blind retries or adoption. The original five PV identities,
including the pre-existing Released/Retain fixture volume, are excluded.

For the fresh Retain volume only, after its exact PVC/Namespace disappear, a guarded
Retain-to-Delete transition coordinates CSI reclamation. Actual LVM absence/free
space must be checked independently; deleting a PV object alone is insufficient.
No finalizer is forced and no manual LV deletion is used.

Independent verification after attempt one proves the original 29 Pods, four PVCs,
five PVs, two SQL markers, all 4,096 entries and exact original five LV identities
and free bytes restored. Independent verification after attempt two completes
once in 4.242 seconds and proves the same original state, with both fresh
namespaces, Cluster, recovered native policy, PVC/PV and LVMVolume CR absent.
The actual Talos LV list again contains exactly the original five identities,
sizes and active states, with original VG UUID/free bytes restored. A separate
read-only source check confirms the 66-module controller and corrected native
module hash remain unchanged. Both native failures remain failures.

Packet/TLS/SQL, API-to-CNPG pilot acceptance, backups/PITR and the rest of
[PLAN.md](../../PLAN.md) remain open. Pending R2 and other held workflows are not
resumed by this operator fixture.
