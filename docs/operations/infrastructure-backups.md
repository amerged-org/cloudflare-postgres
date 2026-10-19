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
meanwhile, and no running database needs D1 to keep writing. **How long D1 stops is not
established.** ULTRA plan 9.10 states about 4 s, tagged as measured on EU1, which the plan's legend
defines as the retired Kubernetes runtime; the plan does not say how it was taken. The earlier
sampling of that runtime (usage posts of the regional agent, one per 15 s) showed gaps of 37 to 72 s
in four of six nightly runs, a stall of at least 37 s in three of them and none in two, and so
contradicts it. Nothing on the node runtime has measured the length yet, and gate G6 does not ask
for it: record the stall of a nightly run in the plan when one is measured. A wake admits from the
DatabaseActor's own state and commits its claim to D1 after the answer, so it is not expected to
wait for the export. That is not yet observed: go-live gate G6 needs a night with an awake database
under writes and one wake during the export that shows no failed wake.

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

- RAM is the 30-minute average of the node's active RAM, (MemTotal - MemAvailable) / MemTotal,
  over its own samples.
- CPU is the 30-minute average of the node's CPU load, busy time over all its cores.
  RAM and CPU need samples that span at least ten minutes and a newest sample at most 180 s old;
  otherwise they stay unknown and send nothing.
- Storage is the fuller of the thin pool's data and metadata in the node's newest sample.

The email subject is `PGCF infrastructure: <kind> (<region>)` and its body is the
event JSON, including `node_ids`, `threshold_ppm` and the highest `utilization_ppm`.
A node crossing during an active episode adds no message only while a listed node
still exceeds; otherwise it replaces the episode with a new event. The episode clears
only when every listed node is fresh and below the threshold, or lost.

The existing authenticated infrastructure webhook remains supported and takes
precedence when configured. Without a webhook or both email addresses plus the
Resend secret, alarms remain visible through the API and no notification is sent.
Delivery uses a five-second deadline and a minimum one-minute retry interval. The event UUID
(`event_id`) names the error, not the delivery: it is a version 5 UUID made from the SHA-256 of a
fixed domain string, the region, the kind and the sorted IDs of the subjects the event lists
(nodes or databases; a kind without subjects has the ID of region and kind alone). The same
error therefore has the same `event_id` every time, also after it cleared and came back, and
another set of subjects is another error with another ID. A continuously active episode keeps
its UUID and payload, and a retry sends both unchanged. Recovering clears the episode; the
same failure later reopens the same row with the same UUID, a new `occurred_at` (the start of
the new episode) and a fresh delivery.

The `Idempotency-Key` is `<event_id>:<occurred_at>`: one value for an episode and all its
retries, a new one for a recurrence. Resend keeps an idempotency key for 24 hours and refuses a
different body under a key it knows, so the key of a recurrence has to differ. Webhook receivers
must deduplicate the pair `event_id` and `occurred_at` (or the key together with the exact body)
durably: a known pair is a retry, to acknowledge and ignore; a known `event_id` with a new
`occurred_at` is a recurrence of the same error, to handle as a new occurrence of the incident
that ID names (reopen it, notify again). Email delivery follows Resend's idempotency retention;
an unresolved delivery must be investigated through the API and the operator's mail account.

## Alert kinds and runbook actions

One durable episode exists per region and kind. Every event's `action` field carries the
action below (`INFRA_ALERT_ACTIONS` in `packages/contracts`), and
`GET /v1/operational-health?scope=regions` lists each region's episodes and the cron
heartbeat. An unknown measurement never starts an episode and never clears an active
one: a missing or stale sample, an unknown archive or backup state and a node that has not
reported keep things as they are. A new episode is delivered once and retried with the
same event ID and body while it stays active; a cleared episode sends nothing. A recurrence of
the same error has the same event ID and a new `occurred_at`.

| Kind | Fires when | Rule | Action |
| --- | --- | --- | --- |
| `regional_ram_warning` | regional ten-minute RAM utilization reaches the threshold | `ram_warning_threshold_ppm`, off by default; it needs a regional RAM window of ten fresh one-minute samples from every node, which no node reports yet, so it stays unknown | Read `GET /v1/regions/{id}/capacity-decision`; add a node or reduce awake databases |
| `regional_node_cap_reached` | allocated nodes reached `max_nodes` | `cap_warning_enabled` with a finite `max_nodes` | Raise `max_nodes` in the capacity policy or free a slot |
| `regional_node_ram_warning` | a node's 30-minute average of active RAM, (MemTotal - MemAvailable) / MemTotal, reaches the threshold | `node_ram_warning_threshold_ppm`; judged from at least ten minutes of samples | Reduce awake databases on the listed node or add capacity |
| `regional_node_cpu_warning` | a node's 30-minute average CPU load, busy time over all its cores, reaches the threshold | `node_cpu_warning_threshold_ppm`; judged from at least ten minutes of samples | Reduce awake databases on the listed node or add capacity |
| `regional_node_storage_warning` | the fuller of the node's thin-pool data and metadata reaches the threshold | `node_storage_warning_threshold_ppm`; placement closes a pool at 80 % data or 50 % metadata, so 500,000 warns first | Free space by deleting databases on the node; the pool does not grow. See Thin storage admission in [recovery](recovery.md) |
| `regional_node_stale` | a node's observation is older than 180 s, or the node is marked lost and a database is still placed on it | fixed; never-observed nodes are ignored | Check the server and its node agent; if it is gone follow the lost-node runbook |
| `infrastructure_backup_failed` | the latest daily D1 attempt failed | fixed | Read `GET /v1/infrastructure-backups` for the artifact's `error_code`; same-day retries run by themselves |
| `infrastructure_backup_stale` | no complete daily backup for 36 h | fixed | Read the same route and the cron heartbeat; fix the cause before the next 00:00Z run |
| `database_archive_failing` | a running, awake database reports `health.archiving: failing` | fixed | Check R2 reachability and archive credentials; WAL accumulates on the volume meanwhile |
| `database_base_backup_stale` | an awake database has no completed base backup within 36 h of awake time | fixed | Check its scheduled backup and R2 access; `backup.status` in `GET /v1/operational-health?scope=databases` |
| `thin_storage_blocked` | a node's newest sample says its thin pool has no room, or a node that holds databases has no sample of its pool within 180 s | fixed | With `thin_pool_no_room`, free space by deleting databases on the node; with `thin_pool_unobserved`, fix the node's samples |
| `regional_node_capacity_refusals` | a node refused 5 or more wakes for awake capacity (`57P03` "node at awake capacity") in the last 10 minutes | fixed | Move the node's most active databases to another node, or add a node |
| `regional_node_pool_closed` | a node's newest sample closes its thin pool for placement: data at 80 % or more, metadata at 50 % or more, or the storage sold (its reported volumes plus the databases it has not finished) at 4 times its data | fixed | Nothing is created or restored there; running databases keep running. Free space by deleting databases on the node, or add a node |
| `database_volume_warning` | a database volume's space or inodes are at least 80 % used and below 90 % | fixed; the volume's newest report of at most 180 s (the node posts one every 60 s) | Raise its storage with `PUT /v1/databases/{id}/resources`, or have the integrator free space |
| `database_volume_critical` | a database volume's space or inodes are at least 90 % used | fixed; same report | Raise its storage now: a full volume stops the database |
| `node_enrollment_refused` | a node's enrollment token was presented again with another key, or after it expired, within the last 24 h | fixed; the episode lists the nodes in `node_ids` | If you did not retry the install, treat the token as leaked: read the `node_enrollment_refused` log and reinstall the node, which issues new tokens |
| `node_unexpected_reboot` | a node sent the journal of its previous boot after a reboot, and no maintenance order of it was open when its last sample of the previous boot arrived, or closed after it, within the last 24 h | fixed; the episode lists the nodes in `node_ids`; a report of an agent that knew no earlier boot claims no reboot | List `GET /v1/nodes/{id}/diagnostics` for the report with `expected_reboot` false, then read it at `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}`: the kernel, agent, gateway, cloudflared, networkd and PID 1 lines of the boot that ended show whether it panicked, ran out of memory or lost power |
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
  resize, writes one. The node takes a base backup when a database is created and after a
  restore, before an idle sleep when one is due (none on the current timeline, or the newest is
  older than 24 h) and, for an always-warm database, once the newest is older than 24 h; it never
  wakes a sleeping database for a backup, so a database that slept through its due time is not
  reported until it has been awake 36 h without a backup. The agent's backup report must be fresh
  (at most 180 s old) and `ok` with a completion time, or `failing`; a sleeping database and an
  unknown report are excluded.
- **Thin storage.** From the node's newest pool sample (at most 180 s old), `thin_pool_no_room`
  means the node's own room rule says no room: free data under the region node policy's
  `reserve_bytes` or metadata at or above its `metadata_no_room_percent`, so no database starts, is
  created or is restored there. The pool does not grow; `regional_node_storage_warning` reports it
  filling before that. `thin_pool_unobserved` means a node that holds a database has no pool sample
  at most 180 s old, so neither the room rule nor this alert sees the pool fill. Running databases
  are never stopped for storage; a pool that does fill fails the write and PostgreSQL stops without
  acknowledging it ([recovery](recovery.md#thin-storage-admission-and-recovery)).
- **Database volumes.** `database_volume_warning` and `database_volume_critical` read the node's
  newest volume report (posted every 60 s, at most 180 s old), not the stored storage sample, so
  a crossing is seen at the next report and the next minute run raises it. A volume that crosses
  both 80 % and 90 % between two reports raises only the critical alert; the warning is for
  growth slower than the report interval. The stored samples, one per minute for a database
  that can grow and one per quarter hour for a hibernated one, feed `health.disk`, `storage` and
  the usage rollup, not these alerts.
- **Subjects.** An episode lists at most 64 databases (longest-standing first) or nodes,
  16 for Thin storage (by ID). A subject that fails and is not listed yet replaces the
  episode with a new event that lists the current subjects (this also holds for
  `regional_node_stale`, so a lost node does not hide a node that goes stale later); a
  listed subject that recovers and fails again adds none.
  The event ID is derived from the subjects that are listed, so a replacement has a new ID and
  a subject that merely recovers leaves the ID of the announced set. When more subjects fail
  than are listed, the ID is that of the listed ones; a listed subject that recovers lets the
  next one in the listing order enter, and a subject that sorts before the listed ones displaces
  the last: each is a new set, announced with a new ID, and a set that comes back has its
  earlier ID again with a new `occurred_at`. Subjects an active episode still names but cannot
  yet judge (`unresolved`) are neither listed nor part of the ID.
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
event ID, start and body at least 60 s later.

## Offline recovery custody

Keep all referenced `CREDENTIAL_KEYS.keys[kid]` versions in protected offline
custody, separate from R2 and D1. A D1 export contains encrypted role custody;
it cannot recover those credentials if the matching master key versions were lost.
Never upload a plaintext keyring alongside these objects. Disabling capture or
changing the active key does not retire keys needed by existing archives. The
[restore drill](#restore-drill) opens an artifact with the complete keyring.

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

## Restore drill

An artifact is a backup only once it has been opened. The drill decrypts one artifact with the
offline keyring and imports it into a new, empty scratch D1 database. It reads one R2 object and
writes only that scratch database; the control database is never touched. Run it for the first
complete artifact (go-live gate G6 of the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md)), after any change of
the keyring or of the envelope code, and before relying on the backup in a recovery.

The tool is `scripts/operations/restore-infrastructure-backup.ts` (Node, no packages beyond the
repository's). It does not share code with the Worker: it reads the layout documented under
[offline recovery custody](#offline-recovery-custody), so a restore needs nothing of the Worker.
It uses wrangler for Cloudflare (`apps/api/node_modules/.bin/wrangler` after `pnpm install`, or any
wrangler on `PATH`), which is logged in or has `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` set to an account token that can read the archive bucket and edit D1.

1. **Receipt (optional, recommended).** `GET /v1/infrastructure-backups` returns only the latest
   run, so save the answer on the day of the artifact you will open. Send the administrator key
   without putting it on a command line:

   ```sh
   printf 'header = "Authorization: Bearer %s"\n' "$PGCF_API_KEY" \
     | curl --fail --silent --show-error --config - \
         "$PGCF_API_URL/v1/infrastructure-backups" > receipt.json
   ```

   Without a receipt (the control database may be the thing that was lost) the artifact still
   authenticates its own identity and plaintext hash; the tool then prints `receipt: not given`.

2. **Download the object.** The key is `latest.artifacts[0].object_key` of the receipt, in the
   archive bucket of the configured `d1_region_id`. The EU archive bucket is in the EU
   jurisdiction (the `jurisdiction` of its `r2_buckets` entry in the Worker configuration), and
   wrangler looks a bucket up in the default jurisdiction unless told otherwise, so name it:

   ```sh
   wrangler r2 object get "<ARCHIVE_BUCKET>/<object_key>" --file d1-control.pgcfenc --remote --jurisdiction eu
   ```

   Leave `--jurisdiction` out only for a bucket the configuration lists without one.

3. **Create the scratch database**, from an empty directory so that wrangler reads and changes no
   configuration:

   ```sh
   (cd "$(mktemp -d)" && wrangler d1 create pgcf-restore-drill --jurisdiction eu)
   ```

4. **Load the keyring.** It is the complete `CREDENTIAL_KEYS` JSON from offline custody
   (`{"active":"<id>","keys":{"<id>":"<base64url, 32 bytes>"}}`). Put it in an environment
   variable without echoing it; the tool takes the variable's name, never its value, and uses the
   key version the artifact names, whichever version is active:

   ```sh
   read -rs PGCF_RESTORE_KEYS && export PGCF_RESTORE_KEYS
   ```

5. **Import.**

   ```sh
   node scripts/operations/restore-infrastructure-backup.ts import \
     --input d1-control.pgcfenc --keys-env PGCF_RESTORE_KEYS --receipt receipt.json \
     --database pgcf-restore-drill --wrangler apps/api/node_modules/.bin/wrangler
   ```

   The tool first reads the artifact's header, then:
   - resolves `--database` by its exact name to one D1 database ID, and refuses a name that
     matches none or several, the database the artifact was exported from (the AAD names it), and
     any database that already holds a schema object (a table, index, trigger or view);
   - decrypts into a `0600` file in a `0700` temporary directory, authenticating the GCM tag, the
     AAD and the plaintext hash and length, and holds the artifact to the receipt (run, key
     version, hashes, sizes, object key) when one is given; a flipped or missing byte, a truncated
     file or another key stops it with nothing written;
   - writes every `CREATE TABLE` statement ahead of the rest, byte for byte (see below), and runs
     `wrangler d1 execute <database ID> --remote --yes --file` from that directory, which holds no
     wrangler configuration, so a configured binding cannot redirect the import;
   - removes the directory, and counts the tables of the scratch database (tables only; the
     indexes, triggers and views the dump also creates are not in that number).

   It prints the artifact's day, region and key version, the plaintext and encrypted byte counts
   and SHA-256, the scratch database's ID, and the counts. It never prints SQL, the keyring, the
   control database's ID or wrangler's own text about the import, which can quote a statement; if
   an import fails, it reports wrangler's exit code. wrangler's output says that a failed import
   returns the database to its original state; check with step 6's queries before reusing it, or
   create a new scratch database. To read wrangler's message, write the verified SQL with
   `decrypt --input FILE --output FILE --keys-env NAME` (mode `0600`, never over an existing
   file), run the import by hand, and delete the file afterwards.

   Ctrl-C, `kill` and a closed terminal (SIGINT, SIGTERM, SIGHUP) stop wrangler, remove the
   decrypted SQL and end the run with exit code 130, 143 or 129. A run killed with SIGKILL, or by a
   power cut, cannot clean up: delete `$TMPDIR/pgcf-restore-*` (for `import`) or `<output>.partial`
   (for `decrypt`) by hand.

   **Unverified until the first drill:** that D1 runs the imported file as one transaction. The
   reordered file only imports in one transaction, because the dump's `PRAGMA
   defer_foreign_keys=TRUE` lasts for one transaction and the rows of a table can precede its
   parent's rows. If the drill fails with `FOREIGN KEY constraint failed`, the data statements
   need an order by foreign key as well; record that in the plan instead of working around it
   by hand.

6. **Check the scratch database** against the live one. `d1_migrations` and `regions` must match;
   the other counts may have moved since the export began. Name the database by the ID the tool
   printed on its `importing into` line, and run wrangler from an empty directory as in step 3,
   so that a wrangler configuration cannot redirect the query to another database:

   ```sh
   (cd "$(mktemp -d)" && wrangler d1 execute <scratch-database-id> --remote --command "PRAGMA foreign_key_check")
   (cd "$(mktemp -d)" && wrangler d1 execute <scratch-database-id> --remote --command \
     "SELECT (SELECT count(*) FROM d1_migrations) AS migrations, (SELECT count(*) FROM regions) AS regions, (SELECT count(*) FROM nodes) AS nodes, (SELECT count(*) FROM databases) AS databases")
   ```

7. **Clean up.** Delete the scratch database by the same ID, from an empty directory (a name is
   looked up in a wrangler configuration first, and this step cannot be undone), then
   `rm d1-control.pgcfenc receipt.json` and `unset PGCF_RESTORE_KEYS`. `--skip-confirmation`
   removes the only prompt, which shows no more than the ID, so first read what the ID names and
   delete only if `d1 info` answers `pgcf-restore-drill`:

   ```sh
   (cd "$(mktemp -d)" && wrangler d1 info <scratch-database-id>)
   (cd "$(mktemp -d)" && wrangler d1 delete <scratch-database-id> --skip-confirmation)
   ```

8. **Record** in the ULTRA plan only: the artifact's day, its plaintext and encrypted byte counts
   and SHA-256, the table count and the results of step 6. Not the IDs the tool prints (the run,
   the artifact, the scratch database), not the control database's ID, and nothing else of the
   content.

**Why the tool reorders the SQL.** D1's export lists each table's rows right after its
`CREATE TABLE`, and the tables in the order they were created. A migration that rebuilt a table
puts it after the tables that reference it: in this repository's migrations `regions` comes after
`nodes`, `databases` and others. SQLite refuses the first row of a table whose referenced table
does not exist yet (`no such table: main.regions`), even under `PRAGMA defer_foreign_keys`, which
defers constraint violations only. The local export of the repository's migrations (wrangler's
local D1) fails to import this way; with every `CREATE TABLE` first it imports as one
transaction, and a second export holds the same statements as the first. The drill is where the
provider's own export and the provider's import are first tried (see the unverified premise
under step 5). The same holds for a restore of the control database: do not import a decrypted
file by hand; use `import`.

| The tool says | Meaning |
| --- | --- |
| `authentication failed` | The file was changed or cut, or the key is not the one that wrote it. Check the key version the artifact names and the keyring in custody. |
| `not a complete PGCFINF1 envelope` | The download is truncated, empty or not an artifact of this layout. Download it again. |
| `the keyring has no usable key version` | The keyring lacks the version the artifact names. Find the custody copy that holds it. |
| `differs from the API's receipt` | The artifact is not the one the receipt describes, or it was replaced in R2. Treat it as unverified. |
| `is the database this artifact was exported from` | The name resolves to the control database. Create a new scratch database. |
| `already has N schema objects` | The target is not empty. Create a new scratch database. |

