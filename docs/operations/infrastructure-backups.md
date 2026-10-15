# Daily infrastructure backups and alerts

Daily infrastructure backups protect the Cloudflare control database and each
existing regional Kubernetes control plane. They complement CNPG/Barman database
base backups and WAL; they do not replace them. All storage uses the installation's
existing, region-bound R2 archive buckets. No Contabo API call, server purchase,
cluster credential rotation, or Kubernetes mutation occurs during capture.

## Installation configuration

Apply migrations `0039_infrastructure_backups.sql`,
`0043_infrastructure_backup_attempts.sql` and
`0052_infrastructure_backup_deferrals.sql` (the status route of the Worker reads the
last one, so apply it first), deploy the `InfrastructureBackup`
Workflow binding shown in `apps/api/wrangler.example.jsonc`, and deploy the matching
NodeBootstrap image. The existing minute Cron dispatches one persisted run per UTC
calendar day and retries a failed day: the next attempt starts at least 90 minutes
after the failed attempt ended, at most three attempts per UTC day, and never while
another run is pending or running. The spacing makes the three attempts of a day
cover several hours, so one disturbance cannot use them all. An attempt that is due
waits, without taking an attempt number, while a fleet patch is running or a thin
database is starting ([held-back attempts](#held-back-attempts)). Fresh
installations have backups disabled and no email addresses configured.

Set the operator-configurable `containers[].max_instances` high enough for a backup
to run alongside node patches and installations. The example uses eight because a
fleet patch keeps its container for the inactivity window after it finishes. These
operations share the existing NodeBootstrap application; a full limit rejects the
next container before native capture starts. Size this limit for the maintenance
concurrency your installation allows, and keep it in the saved deployment
configuration so a later publication does not restore an older limit.

Set the private Worker secret `INFRASTRUCTURE_BACKUP_CF_TOKEN` to an operator-owned
Cloudflare API token with D1 export permission for the actual control database.
The token stays in the management Worker. The container receives only the temporary
HTTPS export URL. Set `NODE_BOOTSTRAP_CALLBACK_URL` to the management API's public
HTTPS origin and retain the existing protected relay binding, signing keys and
sealed regional join material. Control nodes must report fresh signed fleet facts,
including their Kubernetes control-plane role and configured/runtime Cilium image
pins. Missing or changed authority fails the daily run rather than choosing an
unverified source. Backups use the existing administrator relay capability; this
change grants no new regional Kubernetes RBAC or Talos credentials to Pods.

Use the administrator API, replacing every placeholder with this installation's
actual values:

```http
PUT /v1/infrastructure-backups/config
Authorization: Bearer <ADMIN_API_KEY>
Content-Type: application/json

{
  "enabled": true,
  "d1_account_id": "<CLOUDFLARE_ACCOUNT_ID>",
  "d1_database_id": "<CONTROL_D1_DATABASE_UUID>",
  "d1_region_id": "<EXISTING_R2_REGION_ID>",
  "notification_recipient": null,
  "notification_sender": null
}
```

`GET /v1/infrastructure-backups/config` reads this configuration.
`GET /v1/infrastructure-backups` returns the latest attempt of the latest UTC day
with its per-artifact hashes/byte counts, R2 object keys and error codes, and current
backup freshness. It returns no private client configuration, signed export URL or
encryption key. Earlier attempts of that day stay in D1 only. Changing the
configuration revision or disabling backups revokes an unfinished run's capability.
The existing operator Kubernetes API still requires administrator authorization.
The internal backup WebSocket instead accepts only an expiring capability bound to
one current run, artifact, node UID, cluster UID and custody revision. Both paths
recheck current Cloudflare authority and the operator checks actual Kubernetes,
Talos, boot and Cilium carrier identities before and after capture.

## Capture and acceptance

Cloudflare [documents query unavailability during D1 export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/).
The exporter polls that same provider job within its authorized deadline without querying the
locked database, then rechecks current run/configuration authority before using the export URL.
Control-plane requests may wait during this export window; [what is known about its
length](#the-d1-export-window) and what is not is recorded below, and every run stores
its own window.

One Workflow captures D1 and one etcd snapshot per existing regional cluster in a
private NodeBootstrap container. A region whose nodes are all marked lost, or that
has no node, is skipped: the run captures no etcd snapshot there and backup
freshness expects none. Files are streamed and hashed; the complete run's
private payload workspace is bounded to 1 GiB. Encryption uses a purpose-derived
AES-256-GCM key from the existing active `CREDENTIAL_KEYS` version. No cluster key
or credential key is generated or rotated. Plaintext files are removed immediately
after encryption; the ephemeral workspace is removed when the run closes.

The Worker uploads ciphertext using bounded 8 MiB R2 multipart parts over private
container/R2 bindings, then reads the entire committed object back through the
container. Completion requires matching object ownership, encrypted byte count,
SHA-256, authenticated run/source identity, GCM tag, plaintext byte count and
SHA-256. The receipt is persisted in D1 only after this full readback. Unique keys
are `infrastructure/v1/<UTC-day>/<run-UUID>/<artifact-id>.pgcfenc`.

A lost multipart completion response is resolved by reading that exact object.
An existing unique object is verified, never overwritten. An uncertain Workflow
creation is resolved using its persisted run UUID. Failed capture, lost transient
container state, expired authority, or mismatching readback produces a durable
failed run; it does not repeat an uncertain write or regenerate a different archive
under the same object identity. A same-day retry or the next UTC day creates a fresh
run with its own UUID and object keys.

Backups become stale after 36 hours without an artifact of a complete attempt. The
first failed run is failing even when no earlier backup exists; it stays failing
while a retry runs, even after that retry completes some artifacts, and only a later
complete attempt clears it. Deadline expiry records failure at two hours. Backup
failed/stale episodes and stale/lost node observations appear in the existing
operational infrastructure alerts independently of database availability. Node
alarms reuse the existing heartbeat freshness rule. Never-observed new nodes do not
trigger a stale-node alarm.

Before accepting customer data, enable this configuration and verify a real daily
run contains D1 and every expected regional etcd artifact with `status: complete`.
Record the real artifact byte counts, full readback results, duration and recovery
proof in the ULTRA plan; targeted tests alone are not live backup acceptance.

## Held-back attempts

The capture reaches each regional Kubernetes API through the bootstrap relay and uses the control
database, both of which a fleet patch is using, and the D1 export makes the control database
unavailable for the whole of its job, which a thin database start in flight must not meet. A due
attempt therefore waits, without taking an attempt number and so without using one of the day's
three, while one of these holds. The Cron checks every minute:

| Reason | Holds while |
| --- | --- |
| `deferred_by_patch` | any fleet patch operation of any region is unfinished (stage not `complete` or `host_ready`, state not `halted`, deadline not passed, node not marked lost), or changed within the last 15 minutes |
| `deferred_by_thin_start` | a thin database start (an admission that holds thin storage and has no `ready_at`) was granted within the last 15 minutes |

The 15 minutes bridge the seconds between the operations of one rollout and the minutes after its
last one. A halted patch, a patch past its deadline and a patch of a lost node hold an attempt back
for those 15 minutes at most, so a stuck operation cannot stop backups; a start older than 15
minutes counts as stuck, not as in flight.

Each check that holds an attempt back is recorded in `infrastructure_backup_deferrals`: one row per
UTC day and reason with the first and the latest check and their number. `GET
/v1/infrastructure-backups` returns the latest row as `deferral`; it is current while `last_at` is
at most a few minutes old. A day held back by maintenance has no run until the maintenance ends;
when no backup completes for 36 hours the existing stale alarm fires. A run that is already running
is not stopped by a patch that starts: it may fail and takes its attempt, and the 90 minutes then
separate it from the next.

The export request repeats the thin-start check right before it asks the provider, because the
Cron's check is a minute or more older (the first stall of a run was seen 20 to 126 s after its
creation). It polls every 5 s for at most 5 minutes for a start in flight to become ready and then
goes on, so neither a start that never becomes ready nor a check that fails can stop the backup.

Not detectable: a thin start or a wake that begins after the export request (the export then
overlaps it), an awake thin database under writes (see the export window below), a node addition
and a material rotation (a run that overlaps either may fail its authority check and is retried).

## The operator path and its timeout

The etcd snapshot goes through the operator path. The container opens one WebSocket to the Worker
per TCP connection of kubectl (`/internal/v1/infrastructure-backups/{run}/{artifact}/kubernetes`).
For each connection the Worker checks the run capability and the node authority (the node must have
been observed within 180 s) in 36 sequential D1 round trips, 13 of them inside the relay request's
10 s budget, and connects through the relay to the Kubernetes API server. The container reads the
node, namespace, DaemonSet and Pods with four `kubectl get` calls, starts `kubectl port-forward` to
the verified host-network Cilium Pod and waits 20 s for it to print its listening address; talosctl
then reaches the Talos API behind that port and takes the etcd snapshot. Without the address the run
fails with `infrastructure_backup_operator_portforward_timeout`
(`apps/node-bootstrap/src/talos-operator.ts`). kubectl retries a refused read before it fails, so a
refused or slow connection ends as this timeout and not as a relay error.

Observed on 2026-10-14: all three attempts failed with this code while a fleet rollout patched the
region (23:47 to 00:31 UTC). The attempts were ten minutes apart, and the third began 86 seconds
after the last patch operation. The rollout did not reboot either node and changed only the native
controller image, so the control plane kept running. Which link stalled is not known: no per-phase
record of a failed run survives (the container's port-forward log is removed with its workspace).
The candidates, each made worse by a running patch: the node's observation lapsing while the
controller is replaced (older than 180 s refuses every connection), the relay's 32 concurrent
sessions that the patch's parallel kubectl reads share, the control database answering slowly, and
the 20 s limit itself, which is thin against the two or three relayed connections the port-forward
needs when one connection cost 2 to 6.6 s for the thin executor on 2026-10-12. Holding attempts
back during a patch removes the shared cause whichever link it was; a timeout without a patch is a
new observation to diagnose, and widening that limit or repeating the port-forward once is the
next change to consider.

Replayed over the ten recorded runs, the patch rule holds exactly the four failures that overlapped
or trailed a patch (the three of 2026-10-14 and the first of 2026-10-12) and none of the four
completed runs. The other two failures did not meet a patch: 2026-10-11 ended with
`infrastructure_backup_snapshot_source_unavailable` and the second of 2026-10-12 with
`infrastructure_backup_prepare_failed`, the code a failure without a recorded cause had then.

## The D1 export window

While the provider's export job runs, the control database stops answering requests. Cloudflare
documents the unavailability and states no duration. The exporter sends no D1 request of its own
meanwhile. Thin write authority renews against D1 and ends at the Thin profile's 10 s guard, so an
awake thin database under writes takes the protective stop when the window is longer: committed
data stays, uncommitted work is dropped and PGCF resumes the database. A wake that arrives during
the window needs D1 too. Thick and standard-runtime databases are unaffected.

Measured from the usage samples of the six runs that reached or passed the export. The regional
agent posts one sample every 15 s per emitting database; a gap in `usage_samples.observed_at` of
source `agent` inside a run (`SELECT DISTINCT observed_at FROM usage_samples WHERE source='agent'
AND observed_at BETWEEN <created_at> AND <completed_at> ORDER BY observed_at`, spacings above 25 s)
is the time its posts did not complete:

| Run | D1 plaintext | Sample gap | Last stored sample before it, after run creation |
| --- | --- | --- | --- |
| 2026-10-12, attempt 3 | 396 MB | none (one spacing of 20.9 s) | not visible |
| 2026-10-13 | 413 MB | 00:00:48 to 00:01:56 (68 s) | 20 s |
| 2026-10-14, attempt 1 | not read back | 00:04:04 to 00:05:13 (69 s) | 126 s |
| 2026-10-14, attempt 2 | not read back | none | not visible |
| 2026-10-14, attempt 3 | not read back | 00:35:00 to 00:36:12 (72 s) | 121 s |
| 2026-10-15 | 468 MB | 00:02:21 to 00:02:58 (37 s) | 70 s |

The gap runs from the last sample that was stored to the first one stored afterwards, so the stall
itself is up to 30 s shorter than the gap: in three runs it lasted at least 37 s, more than three
times the guard, and in the fourth between 7 and 37 s. It does not follow the database size, and in
two runs no stall is visible at all. The gateway's samples show the same gap as one longer interval.

Unknown:

- Why two runs show no stall, and what the 20 to 126 s before the window are (initialization,
  image manifest reads and the provider's job start are the code's steps there; none is timed).
- The effect on an awake thin database under writes, or on a wake, during the window: no such
  database was awake in any nightly window. With stalls of this length in four of six runs, a
  protective stop of every awake thin database on those nights is the expected result, not a
  measured one.
- Whether a request during the window waits or is rejected: the code tolerates both.

The raw samples this relies on are being reduced (pruned once their hourly rollup is final, none
from idle databases), so read the derivation while they exist. Go-live step 9 is met when a night with an
awake thin database under writes and one wake during the export shows no protective stop and no
failed wake. The measured stalls say this needs a method or schedule change first: for example
exporting only while no thin database is awake, or protecting the control database by another
means than a locking export. That choice belongs to the owner.

## Optional email or webhook delivery

Email is optional. Import `RESEND_API_KEY` as a private Worker secret and configure
`notification_recipient` plus `notification_sender` through the same API. The sender
must be an address on a domain verified in the operator's Resend account. No personal
recipient, sender or API key is included in the repository. Recipient and sender may
also be configured while daily backups are disabled; this enables delivery of node
and separately configured regional capacity alarms.

Per-node threshold warnings use the same delivery. Set `node_ram_warning_threshold_ppm`,
`node_cpu_warning_threshold_ppm` or `node_storage_warning_threshold_ppm` through
`PUT /v1/regions/{id}/capacity-policy` to an integer from 1 to 1000000 parts per
million (`850000` means 85%); `null` disables one. The cron checks every node of a
policy region each minute, including control:

- RAM uses the node's own fresh ten-minute window.
- CPU averages kubelet CPU usage over the same ten minutes against node CPU capacity.
  Only reporters that send the optional CPU sample fields supply it (the native
  controller shipped with R2); otherwise CPU stays unknown and sends nothing.
- Storage uses the fresh LVM sample: thin-pool data or metadata fill, otherwise
  volume-group allocation.

The email subject is `PGCF infrastructure: <kind> (<region>)` and its body is the
event JSON, including `node_ids`, `threshold_ppm` and the highest `utilization_ppm`.
A node crossing during an active episode adds no message only while a listed node
still exceeds; otherwise it replaces the episode with a new event. The episode clears
only when every listed node is fresh and below the threshold, or lost.

The existing authenticated infrastructure webhook remains supported and takes
precedence when configured. Without a webhook or both email addresses plus the
Resend secret, alarms remain visible through the API and no notification is sent.
Delivery uses the durable event UUID as the idempotency key, a five-second deadline,
and a minimum one-minute retry interval. A continuously active episode retains its
UUID and payload. Recovering clears the episode; a new failure creates a new UUID.
Webhook receivers must deduplicate this identifier durably. Email delivery follows
Resend's idempotency retention; an unresolved delivery must be investigated through
the API and the operator's mail account.

## Offline recovery custody

Keep all referenced `CREDENTIAL_KEYS.keys[kid]` versions in protected offline
custody, separate from R2 and D1. A D1 export contains encrypted cluster/role custody;
it cannot recover those credentials if the matching master key versions were lost.
Never upload a plaintext keyring alongside these objects. Disabling capture or
changing the active key does not retire keys needed by existing archives.

The `PGCFINF1` envelope contains: eight-byte magic, four-byte big-endian JSON AAD
length, UTF-8 authenticated JSON identity, 12-byte nonce, AES-GCM ciphertext, and a
16-byte authentication tag. Derive its 32-byte key with HKDF-SHA256 from the retained
master version: salt UTF-8 `pgcf-infrastructure-backup-v1`, info UTF-8 the `kid`.
AAD binds the run/artifact/source/day/region, node and cluster identities, custody
revision, `kid`, plaintext SHA-256 and byte count. Verify the complete encrypted
SHA-256/length from the API receipt and GCM/AAD/plaintext hash before writing or
restoring recovered SQL/snapshots. Never restore an unverified or partial object.
Use the existing [recovery runbook](recovery.md) for controlled D1 and etcd restoration;
restoration changes live state and requires explicit operator authorization.
