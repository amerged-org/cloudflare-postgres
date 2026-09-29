# Manual physical base-backup source checkpoint — 2026-09-29

Status: **reported gate failure corrected by targeted verification**. The
original one-time gate failure remains below. The source candidate is ready for
publication; the existing Dev Worker, 14-migration schema and regional image
remain unchanged until separately verified delivery.

The generic management API accepts one idempotent backup operation for an
existing ready environment, exposes scoped retained history and includes its
operation in ordinary recovery reads. Additive migration `0015` retains the
accepted environment/archive identity, immutable request response, winning
dispatch checkpoint and terminal observation. It creates no environment,
credential, archive bucket or payment integration.

The regional executor reuses CNPG 1.30.1 and Barman Cloud plugin 0.15.0. A fresh
acknowledged dispatch permits one fixed, owned primary Backup create attempt.
Replays and reclaimed leases observe the original resource; an uncertain create
or missing recorded CR cannot authorize another physical backup. Actual
Namespace/Cluster/ObjectStore identities and the immutable archive specification
are checked before effects and terminal publication. Unknown outcomes defer.

The public result distinguishes operator-reported base-backup completion from
verification: `remoteObjectsVerified`, `restoreVerified` and `PITRVerified` stay
false. No archive preservation, continuous WAL history, restore, PITR, retention
or archive-byte accounting evidence is claimed. The executor is disabled unless
the installation explicitly enables `PGCF_MANUAL_BACKUPS_ENABLED=true`; Dev keeps
it disabled pending provider qualification.

Manual suspension and pending backups interlock atomically, including expired
uncertain leases. Independent hard-budget stopping remains permitted. An
otherwise valid winning unexpired lease can retain only known terminal metadata
after requested budget pause, with the same ownership/spec/Cluster/run/runtime
revision; it cannot renew, dispatch, wake or grant compute authority.

Exactly three top-level cases changed: one new Worker case, one new regional
case and one expanded existing control-recovery case. Meaningful RED evidence
preceded implementation. Worker checks passed in 2.731 and 2.575 seconds; the
second followed a deterministic-name alignment. Regional check one passed in
0.171 seconds. Control recovery initially failed its SQL statement-size bound;
the second check passed in 0.344 seconds with exact four-table row custody and
one-read reconstruction. Its trusted query is 98,397 bytes; the retained 99,000
byte bound stays below [D1's 100,000-byte limit](https://developers.cloudflare.com/d1/platform/limits/).

The first read-only Dev baseline confirms 14 prior migrations, one organization,
one project and zero managed environments, roles, databases, usage facts,
reservations or open admissions. The unchanged regional baseline has 29 Running
Pods, four PVCs, five PVs, both original SQL markers and all 4,096 pending journal
facts with zero accepted facts. No existing fact is deleted or reassigned.

CLI D1 query authorization error `7403` remains unresolved. A legitimate Dev
dashboard aggregate read succeeds; it is not evidence of migration or release.
Worker delivery requires the exact new schema and migration record to be
verified first. No schema writes, migration record, deployment, new credential
or physical backup occurred.

## Final gate and mandatory stop

The frozen candidate ran the canonical full gate exactly once, in 17.975 seconds.

| Stage      | Result                                               |
| ---------- | ---------------------------------------------------- |
| Format     | Pass, 2.112 seconds                                  |
| Lint       | Pass, 2.996 seconds                                  |
| Typecheck  | Pass, 3.288 seconds                                  |
| Vitest     | Pass, 29 Worker cases, 5.932 seconds                 |
| Node tests | Fail, 44 passed and four failed of 48, 3.646 seconds |

The four existing failing cases load the command entry point directly from
TypeScript. Its new static import reaches `BackupClient`, whose constructor uses
TypeScript parameter properties unsupported by Node 24.6.0 in strip-only mode.
The compiled regional build and focused backup case passed, but do not establish
source-entry-point compatibility. The failures affect credential recovery,
provisional fact delivery and both offline usage verification cases.

The task changed one existing and added two top-level cases: the automated
inventory grows from 81 to 83, including six retained unchanged Go cases. No new
test matrix or additional case was introduced. Independent source/contract
review passed; it does not override this failed gate.

The failure was reported and the private candidate preserved without source
correction, public push or Dev mutation during that turn.

## Resumed constructor correction

After the goal continued, only `BackupClient` changed: ordinary readonly class
fields and constructor assignments replace the unsupported parameter properties.
All validations, request/response protocols, deadlines and authority guards are
unchanged. Reversing that exact edit reproduces the original frozen file hash;
every other runtime, migration, configuration and test file retains its original
gate hash. The regional build passes after the correction.

The four failed existing cases pass on correction attempt one: the named
credential-recovery case takes 1.311 seconds; the two explicitly named usage
delivery/verification files take 1.897 seconds together. No test is added or
expanded, no test suite is broadened, and the full gate is not repeated. The
original 29 Worker and 44 unaffected Node passes remain retained evidence.
This targeted verification resolves the known failure without claiming a second
full-gate pass. Independent review confirms equivalent behavior and credential-
independent read-only command entry points.

A selected-file lint invocation first used the repository root and found no
package ESLint configuration; the same file passes from its owning package.
No source change or broader lint run accompanies that tooling correction.

The existing R2 credential confirmation, physical restore gate, stopped native
qualifier and other held candidates remain unchanged. The
[contract](../contracts/manual-backups-v1.md) defines the implemented scope and
the remaining operator-resolution and recovery boundaries.
