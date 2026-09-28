# M4 installation maintenance preparation — 2026-09-28

The installation can now queue an immutable Kubernetes maintenance plan, issue a separate regional preparer credential, lease preparation work and store a durable assessment. The regional CLI reads authenticated inventory and fresh external evidence. Actual execution remains unsupported and unauthorized, including for an eligible assessment.

The [source integration](https://github.com/amerged-org/cloudflare-postgres/commit/c3fd741038ace55ca3a24220c42adbef4081295b), [protocol contract](../contracts/maintenance-preparation-v1.md), [control API](../../apps/control-api/README.md) and [regional CLI](../../apps/regional-controller/README.md) supply the generic software. No customer organization/project is used as a privileged host-maintenance container.

## Implemented boundary

- Additive migration `0008_maintenance_preparation.sql`: separate hashed preparer credentials, immutable plan/result history and region-scoped idempotency identities.
- Installation-only submission/read/token issuance; preparer-only claim/renew/result. Existing customer, region executor, meter and budget tokens receive no new privileges.
- Conditional primary D1 writes fence active token identity, enabled region, lease hash/epoch/expiry and immutable plan hash. Exact terminal replay preserves an uncertain completed result.
- A cluster-wide plan binds the actual `kube-system` Namespace UID, canonical Node UID inventory, exact versions, pinned tool image and reviewed target-artifact hash.
- Each planned node's sequential disruption is assessed for quorum, surviving database instances/PDBs/volume identity and reserved capacity. Missing/stale recovery, staging or machine identity proof blocks.
- A deterministic owned Job is permitted only after prerequisites and lease checks. Lost create responses use matching readback. Its fixed `/talosctl` command includes explicit versions, `--dry-run` and `--pre-pull-images=false`, a named configuration Secret, no service-account token and bounded resources/deadline.

The SDK adapter uses complete bounded lists and observes real Node heartbeat/pressure/version, CNPG ownership/readiness, PDB status and PVC/PV UID binding. External quorum, machine identity, restore, staging and reservation certificates still require independently qualified provenance. Count limits do not establish an HTTP response-byte bound.

## Bounded verification

Exactly three top-level cases failed first: one Worker lifecycle and two regional Node cases. The Worker initially returned `404` for the required preparer route; the regional scaffold did not block standalone maintenance or create/reconcile the owned Job.

The Worker case passed its first implementation in 1.958 seconds. Review then found asynchronous D1 errors escaping the router's catch. A deliberate failure in the same case reproduced this; awaited dispatch and session creation inside `try` passed correction two in 1.957 seconds. Independent SQL/authorization/error-path review passed.

Both regional cases passed the first implementation. Required artifact compilation found two unsupported `toSorted()` calls under the existing ES2022 library. Copy-and-sort preserved behavior and passed the same two cases in 0.133 seconds and build in 1.668 seconds. Compiler settings and package dependencies were unchanged.

The one-time canonical gate passed format and stopped at one `prefer-const` lint error in 3.850 seconds. Its failed record remains intact. After reporting the stop, the one-word binding repair received focused format/lint checking; previously unrun typecheck/build/Vitest/Node stages passed once in 11.344 seconds, with 16 Worker and nine Node cases. This is documented interrupted qualification, not a second full gate. Integration used only the named changed regional files and a build.

Anonymous upstream metadata verified the official Talos CLI v1.14.1 index and Linux AMD64 manifest. A client-only version check ran as UID/GID 1000 with read-only filesystem, no network and dropped capabilities in 4.423 seconds. Mounted credentials, cluster-connected dry run, target digest execution and an upgrade are not established by this check.

## Dev deployment and real blocked assessment

The same Dev Worker received the new API and additive migration `0008`. Bundle dry run, migration, deployment and readback completed in 18.017 seconds. Existing organization/project/environment/usage/allowance counts were unchanged and foreign-key checks stayed clean. Admission was not opened.

The first Python request received Cloudflare `403`/`1010` before reaching the Worker. Read-only Node HTTP returned `200`, and authoritative preparation/token counts remained zero before using that client. No security setting was relaxed.

One dedicated preparer token and one current-version rehearsal plan were then created. The generated Talos context has no stored endpoints; the first private CLI configuration was rejected before claiming work. An installation GET confirmed the same operation remained queued, and direct authenticated SDK inventory completed with one Node and one database. Adding the endpoint from the previously authenticated import target allowed the same operation to proceed; no new token or preparation was created for that correction.

The compiled CLI returned and persisted `blocked` in 0.931 seconds, with:

```text
capacity_unreserved
database_availability_unproven
identity_changed
quorum_unproven
recovery_unproven
staging_unqualified
```

`identity_changed` includes absent independently verified machine identity. The other missing certificates and observed standalone availability do not become successful defaults. The dry-run status is `not_run`, its Job UID is null, and execution authorization remains false. The rehearsal uses the currently installed Kubernetes version as both source and target; it is not an upgrade attempt.

The raw attempts, private configuration, receipts and credentials remain ignored local evidence. Independent installation/D1/Kubernetes readback verifies the exact persisted assessment, one Ready Node with no pressure, the same Node UID/boot ID, all 31 non-collector Pod identities and regular/init restart maps, four Bound PVC identities/bindings and zero Jobs. D1 still has one organization/project and zero environments, usage facts/versions and allowances; there is exactly one active preparer, one assessed blocked preparation and one idempotency request, with no unfinished/eligible preparations, foreign-key violations or open admission/catalogs. This proves observed counts and runtime identities, not byte identity of every legacy D1 row. The permitted collector image replacement is the only excluded Pod transition.

## Remaining M4 work

This does not patch Contabo guests, drain nodes, upgrade Kubernetes/PostgreSQL, reboot machines or prove recovery. Qualified backup/restore, spare capacity, staging, endpoint/machine enrollment, a connected dry-run Job, actual upgrade dispatch/recovery and unattended fleet policies remain required. The actual executor must bind fresh authorization/artifacts and persist intent before RPCs; preparation eligibility cannot be reused as execution authority. SDK/OpenAPI qualification, Barman/R2 and the other roadmap gates remain open.
