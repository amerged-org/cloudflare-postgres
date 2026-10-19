# Daily infrastructure backups and alerts

Daily infrastructure backups protect the Cloudflare control database (D1). They
complement the Barman database base backups and WAL; they do not replace them. All
storage uses the installation's existing, region-bound R2 archive buckets. No Contabo
API call or server purchase occurs during capture.

## Installation configuration

Apply every API migration in order (the backup tables come from
`0039_infrastructure_backups.sql` and `0043_infrastructure_backup_attempts.sql`) and deploy
the `InfrastructureBackup` Workflow binding and the `nodejs_compat` compatibility flag
shown in `apps/api/wrangler.example.jsonc`. The existing minute Cron dispatches one
persisted run per UTC calendar day and retries a failed day: the next attempt starts
at least 90 minutes after the failed attempt ended, at most three attempts per UTC
day, and never while another run is pending or running. The spacing makes the three
attempts of a day cover several hours, so one disturbance cannot use them all. Fresh
installations have backups disabled and no email addresses configured.

Set the private Worker secret `INFRASTRUCTURE_BACKUP_CF_TOKEN` to an operator-owned
Cloudflare API token with D1 export permission for the actual control database.
The token stays in the management Worker.

Apply migration `0053_cron_heartbeat_and_alert_kinds.sql` with the Worker that
introduces it, and keep the `CRON_WATCHDOG` Durable Object binding and its migration
(`new_sqlite_classes: ["CronWatchdog"]`, tag `v4` in `apps/api/wrangler.example.jsonc`;
use the next unused tag of the deployed configuration) in every deployed configuration:
the [cron watchdog](#minute-cron-heartbeat-and-watchdog) reports a stopped or failing
cron from that class's alarm. A Worker without the binding keeps running and logs
`cron_watchdog_unavailable` once per run; a Worker without the table logs
`cron_heartbeat_failed` and still runs every step. After the deploy, read
`GET /v1/operational-health?scope=regions`: `cron.last_completed_at` must advance each
minute and `cron.watchdog_checked_at` must follow. The watchdog is armed by the first cron
run after the deploy, so a cron that never runs again after it is not reported. Rolling the
Worker back below this release first needs
`DELETE FROM infrastructure_alerts WHERE kind IN ('database_archive_failing','database_base_backup_stale','thin_storage_blocked','control_cron_stalled','control_cron_step_failing')`,
because the earlier release's health route does not parse those kinds.

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
encryption key. Earlier attempts of that day stay in D1 only. Disabling backups, or
changing the D1 account, database or archive region, revokes an unfinished run's
capability. Changing only the alert sender or recipient never does: the update carries
every valid pending or running run to the new revision in the same transaction, and a
run the cron creates while the update is in flight takes the revision in the statement
that inserts it.

## Capture and acceptance

Cloudflare [documents query unavailability during D1 export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/).
The exporter polls that same provider job within its authorized deadline without querying the
locked database, then rechecks current run/configuration authority before using the export URL.
Control-plane requests may wait during this export window; [what is known about its
length](#the-d1-export-window) and what is not is recorded below, and every run stores
its own window.

The `InfrastructureBackup` Workflow of the API Worker captures the D1 export itself; no
container or node takes part. Encryption uses a purpose-derived AES-256-GCM key from the
existing active `CREDENTIAL_KEYS` version. No credential key is generated or rotated. The
plaintext is never stored and never held whole: the Worker reads the signed export once to
count and hash it, then reads it a second time and streams it through the cipher. A second
read that differs from the first fails the run before the upload completes.

The Worker uploads ciphertext using bounded 8 MiB R2 multipart parts, then reads the
entire committed object back (the GCM tag first, by a suffix read of the same object version). Completion requires matching object ownership, encrypted byte count,
SHA-256, authenticated run/source identity, GCM tag, plaintext byte count and
SHA-256. The receipt is persisted in D1 only after this full readback. Unique keys
are `infrastructure/v1/<UTC-day>/<run-UUID>/<artifact-id>.pgcfenc`.

A lost multipart completion response is resolved by reading that exact object.
An existing unique object is verified, never overwritten. An uncertain Workflow
creation is resolved using its persisted run UUID. Failed capture, lost transient
capture state, expired authority, or mismatching readback produces a durable
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
run contains the D1 artifact with `status: complete`.
Record the real artifact byte counts, full readback results, duration and recovery
proof in the ULTRA plan; targeted tests alone are not live backup acceptance.

## The D1 export window

While the provider's export job runs, the control database stops answering requests. Cloudflare
documents the unavailability and states no duration. The exporter sends no D1 request of its own
meanwhile. No running database needs D1 to keep writing. A wake that arrives during the window
needs D1.

Measured on the retired Kubernetes runtime from the usage samples of the six runs that reached or
passed the export. The regional agent posted one sample every 15 s per emitting database; a gap in `usage_samples.observed_at` of
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
itself is up to 30 s shorter than the gap: in three runs it lasted at least 37 s, and in the fourth
between 7 and 37 s. It does not follow the database size, and in
two runs no stall is visible at all. The gateway's samples show the same gap as one longer interval.

Unknown:

- Why two runs show no stall, and what the 20 to 126 s before the window are (initialization,
  image manifest reads and the provider's job start are the code's steps there; none is timed).
- The effect on a wake during the window: no wake arrived in any nightly window.
- Whether a request during the window waits or is rejected: the code tolerates both.

The raw samples this relies on are being reduced (pruned once their hourly rollup is final, none
from idle databases), so read the derivation while they exist. Go-live gate G6 also needs a night
with an awake database under writes and one wake during the export that shows no failed wake.

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
policy region each minute:

- RAM uses the node's own fresh ten-minute window.
- CPU averages reported CPU usage over the same ten minutes against node CPU capacity.
  Only reporters that send the optional CPU sample fields supply it (the node agent,
  Stage 3); otherwise CPU stays unknown and sends nothing.
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

## Alert kinds and runbook actions

One durable episode exists per region and kind. Every event's `action` field carries the
action below (`INFRA_ALERT_ACTIONS` in `packages/contracts`), and
`GET /v1/operational-health?scope=regions` lists each region's episodes and the cron
heartbeat. An unknown measurement never starts an episode and never clears an active
one: a missing or stale sample, an unknown archive or backup state and a node that has not
reported keep things as they are. A new episode is delivered once and retried with the
same event ID while it stays active; a cleared episode sends nothing.

| Kind | Fires when | Rule | Action |
| --- | --- | --- | --- |
| `regional_ram_warning` | regional ten-minute RAM utilization reaches the threshold | `ram_warning_threshold_ppm`, off by default | Read `GET /v1/regions/{id}/capacity-decision`; add a node or reduce awake databases |
| `regional_node_cap_reached` | allocated nodes reached `max_nodes` | `cap_warning_enabled` with a finite `max_nodes` | Raise `max_nodes` in the capacity policy or free a slot |
| `regional_node_ram_warning` | a node's 30-minute average of active RAM, (MemTotal - MemAvailable) / MemTotal, reaches the threshold | `node_ram_warning_threshold_ppm`; judged from at least ten minutes of samples | Reduce awake databases on the listed node or add capacity |
| `regional_node_cpu_warning` | a node's 30-minute average CPU load, busy time over all its cores, reaches the threshold | `node_cpu_warning_threshold_ppm`; judged from at least ten minutes of samples | Reduce awake databases on the listed node or add capacity |
| `regional_node_storage_warning` | the fuller of the node's thin-pool data and metadata reaches the threshold | `node_storage_warning_threshold_ppm`; placement closes a pool at 80 % data or 50 % metadata, so 500,000 warns first | Free space by deleting databases on the node; the pool does not grow. See Thin storage admission in [recovery](recovery.md) |
| `regional_node_stale` | a node's observation is older than 180 s, or the node is marked lost | fixed; never-observed nodes are ignored | Check the server and its node agent; if it is gone follow the lost-node runbook |
| `infrastructure_backup_failed` | the latest daily D1 attempt failed | fixed | Read `GET /v1/infrastructure-backups` for the artifact's `error_code`; same-day retries run by themselves |
| `infrastructure_backup_stale` | no complete daily backup for 36 h | fixed | Read the same route and the cron heartbeat; fix the cause before the next 00:00Z run |
| `database_archive_failing` | a running, awake database reports `health.archiving: failing` | fixed | Check R2 reachability and archive credentials; WAL accumulates on the volume meanwhile |
| `database_base_backup_stale` | an awake database has no completed base backup within 36 h of awake time | fixed | Check its scheduled backup and R2 access; `backup.status` in `GET /v1/operational-health?scope=databases` |
| `thin_storage_blocked` | a node's newest sample says its thin pool has no room, or a node that holds databases has no sample of its pool within 180 s | fixed | With `thin_pool_no_room`, free space by deleting databases on the node; with `thin_pool_unobserved`, fix the node's samples |
| `regional_node_capacity_refusals` | a node refused 5 or more wakes for awake capacity (`57P03` "node at awake capacity") in the last 10 minutes | fixed | Move the node's most active databases to another node, or add a node |
| `regional_node_pool_closed` | a node's newest sample closes its thin pool for placement: data at 80 % or more, metadata at 50 % or more, or the storage sold (its reported volumes plus the databases it has not finished) at 4 times its data | fixed | Nothing is created or restored there; running databases keep running. Free space by deleting databases on the node, or add a node |
| `database_volume_warning` | a database volume's space or inodes are at least 80 % used and below 90 % | fixed; the volume's newest report of at most 180 s | Raise its storage with `PUT /v1/databases/{id}/resources`, or have the integrator free space |
| `database_volume_critical` | a database volume's space or inodes are at least 90 % used | fixed; same report | Raise its storage now: a full volume stops the database |
| `node_enrollment_refused` | a node's enrollment token was presented again with another key, or after it expired, within the last 24 h | fixed; the episode lists the nodes in `node_ids` | If you did not retry the install, treat the token as leaked: read the `node_enrollment_refused` log and reinstall the node, which issues new tokens |
| `node_unexpected_reboot` | a node sent the journal of its previous boot after a reboot, and no maintenance order of it was open when its last sample of the previous boot arrived, or closed after it, within the last 24 h | fixed; the episode lists the nodes in `node_ids`; a report of an agent that knew no earlier boot claims no reboot | Read the report in `GET /v1/nodes/{id}/diagnostics`: the kernel, agent, gateway, cloudflared, networkd and PID 1 lines of the boot that ended show whether it panicked, ran out of memory or lost power |
| `control_cron_stalled` | no run of the minute cron completed for 300 s | fixed | Check the Worker's cron trigger and logs; see the cron heartbeat below |
| `control_cron_step_failing` | a cron step failed in each of its last 5 completed runs | fixed | Read the Worker logs for `cron_step_failed` with the step named in `cron.failing_steps` |

Rules of the database and Thin storage kinds:

- **WAL archive.** Only a database that is running, awake and `ready` is judged; its
  `health.archiving` must be `failing` (the node reports that for a stalled queue or a
  backlog of 32 or more segments). `unknown` and
  `ok` never fire. A database that is asleep, suspended or deleted cannot archive
  and is left out.
- **Base backup.** The 36 h count starts at the latest of the last completed base backup,
  the database's placement (`created`) and its last wake (`woke`, written by every resume
  and wake). A `ready` event is not a wake: any generation bump, such as a role change or a
  resize, writes one. The daily 03:00 UTC backup skips a sleeping database, so a database
  that slept through it is not reported until it has been awake 36 h without a backup. The
  agent's backup report must be fresh (at most 180 s old) and `ok` with a completion time,
  or `failing`; a sleeping database and an unknown report are excluded.
- **Thin storage.** From the node's fresh physical sample (at most 120 s old),
  `thin_pool_no_room` means no database starts on the node: its free data is under the
  profile's `data_reserve_bytes` or its free metadata under `metadata_reserve_bytes`. The pool
  does not grow; `regional_node_storage_warning` reports it filling before that.
  `thin_pool_unobserved` means a node with a bound thin volume has no physical sample of its
  pool at most 120 s old, so neither the room rule nor this alert sees the pool fill. Running
  databases are never stopped for storage; a pool that does fill fails the write and
  PostgreSQL stops without acknowledging it.
- **Subjects.** An episode lists at most 64 databases (longest-standing first) or nodes,
  16 for Thin storage (by ID). A subject that fails and is not listed yet replaces the
  episode with a new event that lists the current subjects (this also holds for
  `regional_node_stale`, so a lost node does not hide a node that goes stale later); a
  listed subject that recovers and fails again adds none.
- **Unknown backup health.** `infrastructure_backup_failed` and
  `infrastructure_backup_stale` keep an active episode while an artifact's health is
  unknown (for example its custody could not be read) and while the backup health cannot
  be read at all.

## Minute cron heartbeat and watchdog

The minute cron runs these steps in order: `health_alerts`, `capacity_alerts`,
`infrastructure_backup_dispatch`, then `admission_recovery`, `node_fencing`,
`resource_profile_rollouts`, `power_timeouts`, `operation_timeouts`, `role_deletion_timeouts`,
`idempotency_purge`, `node_hints`, `database_actors`, `usage`, `node_capacity`,
`retained_archives` and `backup_retention`. Alerting needs only D1 and a bounded send, so it
leads, and the daily backup dispatch follows ahead of the steps that call out to other
systems: a step that fails, is slow or exhausts the invocation's D1 statement budget cannot
starve them. A step that hangs still holds back the steps after it in that run; the stall
alarm reports it.

Each step runs in its own failure boundary. A step that throws is logged as
`cron_step_failed` (`step`, `error_code` and a redacted `message`; the heartbeat and the
alerts carry the code only), counted in the heartbeat and returned in the run's
`step_failures`, and the steps after it still run. A region whose capacity decision or
alert evaluation fails does not stop the other regions, and one kind that fails to evaluate
does not stop the other kinds of its region. A run spends at most 20 s sending
notifications; the rest stay unclaimed, are logged as `infrastructure_alert_deferred` and
are sent by the next run. The Worker's own cron outcome stays successful when steps fail:
read `cron` in the health route and the alarms, not the cron trigger's error rate.

The run records its heartbeat in D1 (`cron_heartbeat`, one row): `started_at` when it
begins and `completed_at` once every step was attempted, with each failing step's
consecutive failed runs. `cron` in `GET /v1/operational-health?scope=regions` shows it
with a `status`:

| `status` | Meaning |
| --- | --- |
| `ok` | a run completed within 300 s and no step failed in each of its last 5 runs |
| `failing` | a step failed in each of its last 5 completed runs (`failing_steps`) |
| `stalled` | no run completed for more than 300 s |
| `unknown` | no run has been recorded yet |

The `CronWatchdog` Durable Object judges that heartbeat once a minute from its own alarm
and raises `control_cron_stalled` and `control_cron_step_failing` in every region. It is
independent of the cron because the cron does not schedule it: the cron only arms the
alarm (idempotently, at the start of each run), and every alarm schedules the next one
before it evaluates anything. It therefore keeps firing when the Worker's cron trigger is
removed by a deployment, when a step hangs and runs never complete, and when every step
fails. It does not cover the Worker being undeployed or D1 being unreachable. Its
evaluations are visible as `watchdog_checked_at`; a value that stops advancing means the
alarm chain is not running (check the `CRON_WATCHDOG` binding and its `v4` migration).
While the cron is stalled its step counters are those of its last completed run, so a
`control_cron_step_failing` episode is kept and neither started nor cleared.

Reading a stall: `last_started_at` recent with `last_completed_at` old means runs begin
but do not finish (a step hangs; the invocation's trace shows which call is pending, and
alerting and backup dispatch keep running because they come first), both old means no run
starts (the cron trigger or the deployment).

## Proving delivery

The notification path is proven by one real alarm rather than a test endpoint. Set
`RESEND_API_KEY` as a Worker secret, `notification_sender` on a domain verified in the
Resend account and `notification_recipient` through `PUT /v1/infrastructure-backups/config`
(this does not touch a running backup), then let any episode arm: an existing active
undelivered one is sent by the next minute run, or read a region's complete policy with
`GET /v1/regions/{id}/capacity-policy`, send it back with `node_ram_warning_threshold_ppm`
set to `1`, wait for the email and send the original object back (a PUT resets omitted
fields that have a default). `delivered_at` in
`GET /v1/operational-health?scope=regions` then shows the Resend API's 2xx acceptance. A refused or timed-out attempt is logged as
`infrastructure_alert_delivery_failed` with the HTTP status or a `timeout`/`transport`
reason: 401 is usually an invalid API key, 403 or 422 a sender that is not on a verified
domain or is malformed, and 429 Resend's rate limit; the episode is retried with the same
event ID at least 60 s later.

## Offline recovery custody

Keep all referenced `CREDENTIAL_KEYS.keys[kid]` versions in protected offline
custody, separate from R2 and D1. A D1 export contains encrypted role custody;
it cannot recover those credentials if the matching master key versions were lost.
Never upload a plaintext keyring alongside these objects. Disabling capture or
changing the active key does not retire keys needed by existing archives.

The `PGCFINF1` envelope contains: eight-byte magic, four-byte big-endian JSON AAD
length, UTF-8 authenticated JSON identity, 12-byte nonce, AES-GCM ciphertext, and a
16-byte authentication tag. Derive its 32-byte key with HKDF-SHA256 from the retained
master version: salt UTF-8 `pgcf-infrastructure-backup-v1`, info UTF-8 the `kid`.
AAD binds the run/artifact/source/day/region, `kid`, plaintext SHA-256 and byte count.
Its node, cluster and custody-revision fields named the etcd sources of earlier runs; they
stay null so that the layout every existing archive was written with is kept. Verify the complete encrypted
SHA-256/length from the API receipt and GCM/AAD/plaintext hash before writing or
restoring recovered SQL. Never restore an unverified or partial object.
Use the existing [recovery runbook](recovery.md) for controlled D1 restoration;
restoration changes live state and requires explicit operator authorization.
