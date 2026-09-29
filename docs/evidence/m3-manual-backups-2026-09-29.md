# Manual physical base-backup source and Dev checkpoint — 2026-09-29

Status: **source published and control API delivered in Dev**. The original
one-time gate failure and its targeted correction remain below. The regional
executor is present but disabled; no physical backup has been qualified.

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

At that first checkpoint, CLI D1 query authorization error `7403` prevented
delivery through Wrangler. A dashboard aggregate read alone was not evidence of
migration or release. The source and Dev delivery were performed later in the
sequence recorded below. CLI error `7403` remains unresolved.

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

## Published source and Dev delivery

Commit [`c44fa1d`](https://github.com/amerged-org/cloudflare-postgres/commit/c44fa1dbd06b3b6bec003c965308b5292bc8ae62)
contains the 23-file public source/documentation change. Before publication,
the known-secret scan checked 418 public files against 105 raw/encoded variants
with zero matches. The two local environment files remained byte-identical,
ignored and mode 0600; `AGENTS.md` remained exactly 25 lines. The constructor
repair changed one runtime file, and independent review confirmed its narrowed
scope. The original failed full gate remains part of the record.

The Dev D1 baseline had the original 14 migration names, one organization and
one project, with zero managed environments, roles, logical databases, usage
facts, reservations or open admissions. The authorized dashboard applied
`0015_environment_backups.sql` once. Its four tables, two indexes and ten
triggers were read back and matched the published statements exactly after
replacing line feeds with spaces for the console's single-line input. All four
new tables were empty and `pragma_foreign_key_check` returned zero rows. The
normal migration-history insert came **after** schema verification; all 15
migration names were then read back in order. No atomicity claim is made for the
dashboard's multi-statement execution. The later read, after deployment, still
showed one organization, one project, 15 migrations, zero managed environments,
zero backup rows and no foreign-key violations.

One Wrangler dry run and one Worker deployment used the existing Dev account,
D1 binding and `--keep-vars`. The new version received 100% of Worker traffic;
all eight pre-existing Secret names/types were still present. Their values were
not read or changed. Four scoped read-only HTTP probes succeeded: the known
owned project, anonymous and regional-token denials, and an owned absent backup
environment. No backup was created by these probes.

The regional image was built once from 79 public Git blobs and verified against
the published commit and an eight-layer OCI archive. Its first local module
extraction preflight stopped before launching a container because it compared
Docker's image ID with the platform config digest. A read-only check showed the
ID equalled the independently verified OCI index digest. One corrected bounded
extraction then verified 71 compiled modules as non-root without network,
published ports or a rebuild. The original failed preflight remains recorded.

The exact image archive was imported to the existing Talos node once and only
the regional Deployment's image field was conditionally changed. The single
replacement reached Ready. Its 71 module hashes, unchanged Deployment settings,
16 RBAC rules, 28 other Running Pod identities/restart counts, node boot identity,
four PVC specs, five PV specs, CNPG Cluster UID/spec/readiness and both SQL markers
were checked after the rollout. All 4,096 original provisional journal facts
and their hashes/sequence remained pending with zero receipts; the pre-existing
404 delivery diagnostic remained. None was acknowledged, reassigned or deleted.

`PGCF_MANUAL_BACKUPS_ENABLED` is absent from the Dev Deployment. No Backup CR,
archive upload, R2 restore, WAL continuity, PITR, retention or recovery-time
evidence results from this delivery. The new API cannot serve an actual customer
backup while no managed customer environment exists. The separate regional
archive qualification and positive API-managed environment gates remain open.
The image context also omits the standalone `THIRD_PARTY.md` inventory; external
image distribution needs its own packaging review.

The existing R2 credential confirmation, physical restore gate, stopped native
qualifier and other held candidates remain unchanged. The
[contract](../contracts/manual-backups-v1.md) defines the implemented scope and
the remaining operator-resolution and recovery boundaries.
