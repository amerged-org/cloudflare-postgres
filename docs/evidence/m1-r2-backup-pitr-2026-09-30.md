# R2 physical backup, full restore and point-in-time recovery

Status: **the selected single-node physical backup/WAL/full-restore/PITR path
is qualified**. This uses Cloudflare R2 exclusively; S3 identifies its compatible
protocol, not Amazon storage. The complete platform and production reliability
remain unqualified.

## Versions, ownership and source activation

The existing installation runs PostgreSQL 18.4, CloudNativePG 1.30.1 and manual
Barman Cloud plugin 0.15.0. The sidecar's actual runtime image ID matches the
previously verified OCI index
`sha256:06c78deca670525daa35fb1e5323159092785d11cf87b86217bdd5c679a41a84`.
This records the runtime index identity, not independent inspection of every
platform manifest. The unchanged Barman operator remains Ready and its Flux
HelmRelease remains suspended; the separate ownership handoff is not repaired
or claimed complete.

The [earlier preflight](m1-backup-preflight-2026-09-29.md) remains historical.
After the user removed the fixed correction cap, the prepared exact correction
explicitly sets `plugins[0].enabled=true`, matching CNPG's admitted default.
Fresh source/operator/certificate/endpoint, node pressure, volume binding and
empty archive checks pass before effects.

One single-dispatch activation creates a private bucket-scoped Secret and one
source ObjectStore, then adds only the Barman plugin with fresh Cluster
UID/resource-version/full-spec guards. Server previews preserve the intended
spec. Activation takes 5.938 seconds. The expected source Pod replacement adds
the actual Ready sidecar; the original Cluster, all volumes, SQL markers and
29 other Running Pod identities/restarts remain unchanged.

Keys remain private in the ignored bootstrap environment and Kubernetes Secret.
R2 uses the authorized EU bucket/endpoint, region `auto` and permanent validity
requested by the user. No credential appears in process arguments, public files
or reported SQL receipts. No Secret rotation, Worker deployment, D1 migration,
operator takeover, new provider server or customer admission occurs.

## Source data, physical backup and remote evidence

A normal `app` connection uses TCP TLS with `sslmode=verify-full`, the source
CA and its service certificate hostname. Operator Exec transports the client;
loopback connection selection does not qualify external customer ingress or a
gateway. Password input uses stdin and is not printed or placed in command-line
arguments. The original application SQL marker is readable.

A unique ordinary logged table records a baseline marker with synchronous
commit and expected payload digest. A trusted operator WAL switch is observed
remotely under the source's exact archive/server identity before backup.
The source's native CNPG Backup is created exactly once and observed under the
same UID throughout. Its completed status contains a nonempty backup ID,
begin/end WAL and timestamps. Matching R2 catalog and compressed data objects
are present; the downloaded catalog is DONE and matches the recorded WAL bounds.
This proves physical backup upload, not merely R2 put/get access or a Backup CR.

After backup completion, two more marker transactions commit separately.
The selected UTC recovery time is after the earlier commit and before the later
one. A subsequent WAL switch proves that the segment covering the later marker
is present remotely. All three source rows/hashes are verified.

A retained harness failure formats the captured post-commit UTC timestamp with
literal quoted T/Z delimiters. One captured-output regression fails first and
passes after strict normalization of that actual UTC format. Continuation uses
the same completed Backup UID and marker transactions; it creates no additional
backup and never replays an uncertain marker write. The original failed
33.418-second combined harness result remains recorded.

## First restore verification stop and precise correction

The first disposable full target reaches Ready with enforced Cilium policy.
Its TLS client wrongly reuses the source app password, so authentication fails.
The admitted recovery spec already contains CNPG's default `database: app` and
`owner: app`; CNPG creates target credentials and configures them after recovery.
The failure is not evidence that R2 cannot restore data. That invocation ends
failed after 92.267 seconds; ordinary cleanup, physical capacity restoration,
source health and archive preservation all pass.

The corrected invocation authenticates with each target's own app Secret,
requiring its exact namespace/name and Cluster owner-reference UID before
privately consuming the password. Target CA/hostname verification remains
unchanged. Fresh output archive/server identities avoid reusing a prefix that
an earlier promoted target may already have populated. The original Backup,
source dataset, three expected markers and selected recovery time are unchanged.

## Full restore and PITR — actual successful results

Two independent targets are created sequentially in a fresh Restricted namespace
with a dedicated Delete clone of the qualified thick/ext4 LVM class. Source
Retain storage is unchanged. Namespace quotas bound four bootstrap/instance Pods,
two 5-GiB claims, CPU/RAM and 10 GiB total new storage. Actual node memory and
physical capacity are checked before creation.

Default-deny Cilium policy permits CNPG operator ingress on TCP8000, Kubernetes
API access, DNS proxy learning and HTTPS to the exact R2 endpoint/bucket names.
Current owned endpoint identities and native policy health/revision prove both
directions enforced before SQL acceptance. No network guard is relaxed to pass.

Each target reads the original source archive through a local recovery-source
ObjectStore and writes to its own distinct destination/server identity. The
nonempty-archive safety check remains enabled. Physical identities are separate
from each other and every original volume; both recovered databases preserve
the source PostgreSQL system identifier.

| Target | Actual selected data | Additional evidence | Observed time |
| --- | --- | --- | ---: |
| Full restore | baseline, early, late; exact hashes | Verified target TLS, writable promotion, fresh acknowledged write, own R2 WAL | 73.528 s |
| PITR | baseline and early; late wholly absent | Same TLS/write/archive evidence; correct selected backup/time | 56.237 s |

These times start after the target creation is acknowledged and include readiness,
policy, SQL and fresh-write checks; they are measurements, not production RTO
promises. Plugin 0.15.0 uses promotion as its recovery action; no invented
`targetAction` or replay-resume workaround is introduced.

The complete corrected two-target invocation passes in **169.690 seconds**,
including final ordinary cleanup and preservation. It remains within its
540-second bound with 90 seconds reserved for cleanup. Target-owned WAL objects
remain present with matching remote metadata after the target resources are
removed. Source catalog/markers and every archive are retained.

## Cleanup, custody and limits

Only the recorded fresh Namespace UID is deleted, with resource-version guards.
Normal Kubernetes/CSI reclamation removes both new claims, PVs and actual LVs.
The new class is removed only after physical VG UUID/size/free bytes/LV count
match the pre-target baseline. No original PV, Retain class, finalizer, source
Cluster or archive is deleted to obtain a pass.

Final independent readback proves the healthy source, both original SQL markers,
all selected source fixture hashes, original Node/boot and all 30 post-activation
Running Pod identities/restarts. Six original PV/five PVC full specs remain.
The usage collector's identity and full outbox hash match, with 4,096 pending
facts, zero acknowledgements and zero accepted receipts. Environment files remain
byte-identical, ignored, untracked and mode 0600; held source hashes remain exact.

The same native recovery case is corrected once for credential selection; one
private timestamp regression has red/green evidence. No matrix, new public
runtime suite or full workspace gate is introduced for unchanged upstream
behavior and installation examples. Driver/cleanup syntax, concrete server
previews and actual runtime/archive/SQL checks provide the relevant evidence.

Retention/deletion, interrupted recovery, independent credential/key disaster
bootstrap, original-source loss, fresh-infrastructure recovery, sustained load,
M1 benchmark/control-state requirements and M4/M8 production gates remain open.
Source archiving stays enabled, while managed customer admission remains closed.

References: [public backup examples](../../infra/backups/README.md),
[CNPG 1.30.1 recovery defaults](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_defaults.go),
[application Secret creation](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_create.go),
[Barman 0.15.0 recovery action](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.0/internal/cnpgi/restore/restore.go).
