# M3 logical-project checkpoint — 2026-09-28

Status: **partial development deployment**. Projects are now global logical containers. Creating one is a completed D1 operation, not a PostgreSQL provisioning request. The registered lab region still has no operation claim/report path, and the [M1 PostgreSQL lab](m1-2026-09-28.md) remains manually created.

## Verified rollout

- The Dev D1 preflight found exactly one legacy pending project with exactly one queued `project.create` operation, and no unexpected legacy states or other operation kinds. Its original GET responses were saved privately before the change.
- Project clients were paused while migration `0004` added operation observation fields and converted only the matching legacy pair. IDs and creation timestamps were preserved; observation time was recorded at migration time with `logical_container_created` as the result code.
- The new Worker was deployed, then the guarded reconciliation script was executed to close the old-Worker write window. A remote readback found zero eligible legacy pairs. The known project and operation returned `active`/`succeeded`, the same IDs and original creation timestamps, and the expected observation/result fields before clients resumed.
- An identical live project POST replay returned `201` with the same project and operation IDs. New logical-project creation and completed replays use `201`; an unmatched legacy pending/queued replay uses `202`. Mixed states return an inconsistency error instead of claiming completion.
- Three existing top-level tests were red before the logical-project change. A further red-first assertion in an existing test checked truthful legacy replay. The focused file passed 10 tests, and the frozen candidate passed format, lint, typecheck, Vitest, and `test:node` once. The public Git head and remote D1 migration state were read back; private environment files were absent from the GitHub tree.

## Product boundary

An `active` project means its logical container exists. It has no implied region, PostgreSQL cluster, database, role, credential, or connection endpoint. A future independently managed database environment selects a region and a versioned profile explicitly and creates the genuine asynchronous `environment.create` operation.

The catalog/admission model, regional leasing/reconciliation, usage and budget APIs, and database recovery remain separate work. This checkpoint does not complete M3 or establish an operational hosted database service.

See the shipped [OpenAPI contract](../../apps/control-api/openapi.yaml), [rollout instructions](../../apps/control-api/README.md), and [reconciliation script](../../apps/control-api/scripts/reconcile-logical-projects.sql). The [earlier region checkpoint](m3-control-api-dev-2026-09-28.md) records the prior pending/queued development state.
