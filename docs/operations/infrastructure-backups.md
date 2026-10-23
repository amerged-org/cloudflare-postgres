# Daily infrastructure backups and alerts

Daily infrastructure backups protect the Cloudflare control database (D1). They
complement the Barman database base backups and WAL; they do not replace them. All
storage uses the installation's one R2 archive bucket. No Contabo
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
the [cron watchdog](#minute-cron-heartbeat-and-watchdog) is the clock of every alert: its
alarm evaluates all alerts of all regions once a minute and reports a stopped or failing
cron. A Worker without the binding keeps running its cron steps and logs
`cron_watchdog_unavailable` once per run, but evaluates no alert at all; a Worker without
the table logs `cron_heartbeat_failed` and still runs every step. After the deploy, read
`GET /v1/operational-health?scope=regions`: `cron.last_completed_at` must advance each
minute and `cron.watchdog_checked_at` must follow, and the Worker's logs hold one
`alert_evaluation` line a minute. The watchdog is armed by the first cron
run after the deploy, so a cron that never runs again after it is not reported. Rolling the
Worker back below this release first needs
`DELETE FROM infrastructure_alerts WHERE kind IN ('database_archive_failing','database_base_backup_stale','thin_storage_blocked','control_cron_stalled','control_cron_step_failing')`,
because the earlier release's health route does not parse those kinds. Migration
`0082_drop_dead_capacity_fields.sql` is not undone by rolling the Worker back either: an older
Worker reads columns and a table it dropped. A rollback below it needs the forward migration of
[Rolling back below migration 0082](#rolling-back-below-migration-0082) before the older Worker is
deployed and its two usage statements again as a second migration right after the older Worker is
live; the export taken before the migration is not a substitute for it.

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
  "d1_region_id": "<EXISTING_REGION_ID>",
  "notification_recipient": null,
  "notification_sender": null
}
```

`GET /v1/infrastructure-backups/config` reads this configuration.
`GET /v1/infrastructure-backups` returns the latest attempt of the latest UTC day
with its per-artifact hashes/byte counts, R2 object keys and error codes, and current
backup freshness. It returns no private client configuration, signed export URL or
encryption key. Earlier attempts of that day stay in D1 only. Disabling backups, or
changing the D1 account, database or the region the export is recorded under, revokes an unfinished run's
capability. Changing only the alert sender or recipient never does: the update carries
every valid pending or running run to the new revision in the same transaction, and a
run the cron creates while the update is in flight takes the revision in the statement
that inserts it.

## Rolling back below migration 0082

Migration `0082_drop_dead_capacity_fields.sql` removes the node RAM window, fields of the capacity
policy and of the size classes, and the three `reserved_*` usage keys. A Worker of an earlier release
that runs over the migrated database fails: its SQL names the dropped columns and the dropped
`node_memory_samples` table, and its strict usage contract requires the three keys that the migration
removed from every hourly usage row and every lifecycle resource snapshot. `GET /v1/usage` answers 500
for a range that covers a stored hour, and the rollup reads a snapshot without them as a gap.

**A rollback below `0082` is a forward migration, and without it is unsupported.** Restoring the D1
export taken before `0082` is not a rollback of the migration: it replaces the control database with
its state at the time of the export and loses every control-plane write since. That includes the
databases created since (D1 forgets them and the Edge stops routing them, while their volumes stay on
the node), deletions (the databases come back), resizes, storage generations (they move backwards
under the fencing invariants), API keys, approvals, enrollments and usage. It needs the owner's
explicit go, and switching the Worker bindings to a restored database is the separate,
explicitly authorized step of [recovery](recovery.md#control-plane).

The forward migration adds back what `0082` dropped, with the definitions of migrations `0018`,
`0024`, `0038` and `0041`. The columns held only dead data with no producer, so the restored values
are the old defaults (none, `reserved`, `0`) and the older Worker reads them as it did before. The
usage keys need a second run, because the newer Worker keeps writing the newer shape until the older
Worker is live. The order is:

1. Save the three blocks below as one migration file in `apps/api/migrations`, numbered after the
   highest migration the installation has applied, and apply it with `wrangler d1 migrations apply`,
   which runs it as one transaction.
2. Deploy the older Worker straight after: it fails without this migration.
3. Right after the older Worker is live, apply the usage block and the lifecycle block again,
   unchanged, as a second migration file numbered after the first. Both statements select only the
   rows that lack the keys, so the second run leaves every row the first one repaired as it is.

Between the first migration and the deploy, the newer Worker writes rows that the first migration has
already passed. Its rollup stores hourly usage rows without the three `reserved_*` metrics, including
for the hours it finalizes, and every wake and every sleep stores a lifecycle snapshot of
`memory_mib` and `cpu_millicores` only. The older Worker's strict usage contract refuses both. For
any range that covers such an hour `GET /v1/usage` answers 500 and keeps answering it, because a
final hour is never recomputed. Its rollup reads such a snapshot as a `resource_snapshot` gap, so
`memory_mib_seconds` and `cpu_millicore_seconds` of that database are null until its next lifecycle
event, and are lost for good once those hours finalize. The second migration gives those rows the
keys, which is what makes the older Worker work again.

A short window remains: from the moment the older Worker is live until the second migration has run.
In it `GET /v1/usage` still answers 500 for a range that covers a newer-shape hour, and an hour that
finalizes in it (two hours after the hour ends) while its resource snapshot is still the newer shape
keeps null `memory_mib_seconds` and `cpu_millicore_seconds` for good. An hour that is still open is
computed again from the repaired snapshots. Keep the second migration file ready before the deploy
and apply it without a pause.

The newer Worker that runs between steps 1 and 2 writes statements that name none of the restored
columns and reads the restored usage shape. It fails one route family while
`size_classes.cpu_request_millicores` exists: it parses a whole size class row with a strict schema
that does not know the column, so `GET /v1/size-classes` and `PUT /v1/size-classes/{id}` (after it
stored the class) answer 500 until the older Worker runs.

```sql
-- The dropped columns and the empty RAM sample table, as 0018, 0024, 0038 and 0041 created them.
ALTER TABLE node_region_policies ADD COLUMN ram_expansion_threshold_ppm INTEGER
  CHECK(ram_expansion_threshold_ppm IS NULL OR
    (typeof(ram_expansion_threshold_ppm)='integer' AND ram_expansion_threshold_ppm BETWEEN 1 AND 1000000));
ALTER TABLE node_region_policies ADD COLUMN ram_warning_threshold_ppm INTEGER
  CHECK(ram_warning_threshold_ppm IS NULL OR
    (typeof(ram_warning_threshold_ppm)='integer' AND ram_warning_threshold_ppm BETWEEN 1 AND 1000000));
ALTER TABLE node_region_policies ADD COLUMN placement_mode TEXT NOT NULL DEFAULT 'reserved'
  CHECK(placement_mode IN('reserved','actual_ram'));
ALTER TABLE node_region_policies ADD COLUMN postgres_memory_request_mib INTEGER
  CHECK(postgres_memory_request_mib>0);
ALTER TABLE nodes ADD COLUMN memory_window_observed_at TEXT;
ALTER TABLE nodes ADD COLUMN memory_window_valid INTEGER NOT NULL DEFAULT 0
  CHECK(memory_window_valid IN(0,1));
ALTER TABLE nodes ADD COLUMN memory_utilization_ppm INTEGER
  CHECK(memory_utilization_ppm BETWEEN 0 AND 1000000);
ALTER TABLE nodes ADD COLUMN memory_expansion_triggered_at TEXT;
ALTER TABLE size_classes ADD COLUMN cpu_request_millicores INTEGER
  CHECK(cpu_request_millicores IS NULL OR
    (typeof(cpu_request_millicores)='integer' AND cpu_request_millicores>0
      AND cpu_request_millicores<=cpu_millicores));
CREATE TABLE node_memory_samples(
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  minute INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  working_set_bytes INTEGER CHECK(working_set_bytes>=0),
  capacity_memory_bytes INTEGER CHECK(capacity_memory_bytes>0),
  available_bytes INTEGER CHECK(available_bytes>=0),
  memory_pressure INTEGER CHECK(memory_pressure IN(0,1)),
  capacity_cpu_millicores INTEGER
    CHECK(capacity_cpu_millicores IS NULL OR
      (typeof(capacity_cpu_millicores)='integer' AND capacity_cpu_millicores>0)),
  cpu_usage_nano_cores INTEGER
    CHECK(cpu_usage_nano_cores IS NULL OR
      (typeof(cpu_usage_nano_cores)='integer' AND cpu_usage_nano_cores>=0 AND capacity_cpu_millicores IS NOT NULL)),
  PRIMARY KEY(node_id,node_uid,minute),
  CHECK(working_set_bytes IS NULL OR working_set_bytes<=capacity_memory_bytes),
  CHECK(available_bytes IS NULL OR available_bytes<=capacity_memory_bytes)
);
```

```sql
-- Every hourly usage row has the three reserved_* metrics again, unknown (null) and listed in gaps as
-- the rollup lists a metric it could not measure. A row that has them is not touched.
UPDATE usage_hourly
SET metrics=json_set(metrics,'$.reserved_memory_mib_seconds',json('null'),
    '$.reserved_cpu_millicore_seconds',json('null'),'$.reserved_storage_byte_seconds',json('null')),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps)
    UNION SELECT 'reserved_cpu_millicore_seconds' UNION SELECT 'reserved_memory_mib_seconds'
    UNION SELECT 'reserved_storage_byte_seconds' ORDER BY value))
WHERE json_type(metrics,'$.reserved_memory_mib_seconds') IS NULL;
```

```sql
-- Every lifecycle resource snapshot has its three fields again. The limits stand in for the reserved
-- figures, which the older release wrote equal to them; the allocated storage is unknown (null).
-- The immutability trigger is dropped for the update and created again, unchanged.
DROP TRIGGER lifecycle_events_immutable;
UPDATE lifecycle_events
SET resource_snapshot=json_set(resource_snapshot,
  '$.reserved_memory_mib',json_extract(resource_snapshot,'$.memory_mib'),
  '$.reserved_cpu_millicores',json_extract(resource_snapshot,'$.cpu_millicores'),
  '$.storage_allocated_bytes',json('null'))
WHERE json_type(resource_snapshot,'$.reserved_memory_mib') IS NULL
  AND json_type(resource_snapshot,'$.memory_mib')='integer'
  AND json_type(resource_snapshot,'$.cpu_millicores')='integer';
CREATE TRIGGER lifecycle_events_immutable BEFORE UPDATE ON lifecycle_events
BEGIN SELECT RAISE(ABORT, 'lifecycle events are immutable'); END;
```

On an installation with many hourly rows or lifecycle events, run each of the two `UPDATE`
statements once for each first letter of the database ID, as `0082` does: add
`AND database_id>='a' AND database_id<'b'` to its `WHERE`, then the same for `'b'` and `'c'` up to
`'y'` and `'z'`, and `AND database_id>='z'` alone for the last, all inside the same migration, in the
second file as in the first.

What the migrations do not restore, and why the older Worker works once the second one has run:

- **Approval hashes.** The hashes that `0082` cleared stay cleared, and the older Worker reads the
  restored threshold as none, so a standing profile with a trigger no longer matches its stored hash.
  Both only fail safe: an order waits for `POST /v1/nodes/additions/{id}/approve` until
  `PUT /v1/regions/{id}/capacity-policy` stores the profile again through the older Worker (which
  demands `ram_expansion_threshold_ppm` there when autoscaling, purchases and an `order` are all set).
- **The alert kind `regional_ram_warning`.** Its CHECK stays narrowed and its rows stay deleted. The
  older Worker raises it only for a non-null `ram_warning_threshold_ppm` and a measured window, and
  the restored threshold is none and the restored table empty.
- **Reserved usage figures.** They stay unknown for every hour and snapshot written before the
  second migration, those of the newer Worker included; the older Worker meters new hours from the
  limits as before.

To roll forward again, deploy the newer Worker and then run the statement below; the size-class
routes answer 500 as above until it has run. It drops the one restored column that the newer Worker's
strict parse refuses. The other restored columns and the table stay unread, and the newer Worker reads
the restored usage shape as it reads the shape the older Worker wrote after `0082`. The statement
discards the CPU request the older Worker may have stored, a value no placement or admission code
reads.

```sql
ALTER TABLE size_classes DROP COLUMN cpu_request_millicores;
```

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
meanwhile, and no running database needs D1 to keep writing. **How long D1 itself stops is not
established.** ULTRA plan 9.10 states about 4 s, tagged as measured on EU1, which the plan's legend
defines as the retired Kubernetes runtime; the plan does not say how it was taken. The earlier
sampling of that runtime (usage posts of the regional agent, one per 15 s) showed gaps of 37 to 72 s
in four of six nightly runs, a stall of at least 37 s in three of them and none in two, and so
contradicts it. On the node runtime the export of the window test below ran 6.1 s from start to
completion; that is the length of the job and not a measurement of the stall inside it, which no
test has timed. A wake through a wake ticket admits from the DatabaseActor's own state and commits
its claim to D1 after the answer, so by design it does not wait for the export. A wake on the
`ensure_awake` path does: the actor has no snapshot that says whether the database is wakeable, or
its snapshot shows it neither ready to serve nor an idle sleeper (resuming, being created,
restarting at a generation the controller has not reported), and then the actor reads D1 before it
answers, unless its snapshot already admits the connection, and its claim reads D1 under the
actor's gate. Such a wake can wait for the export. The `path` of the `actor_admit` log line names
which path answered a connection (`snapshot`, `ticket`, `ensure_awake` or `refused`). The
window test below found no failed wake; its record has 37 wakes but 32 ticket claims and does not
say how the other five were admitted, and whether a wake that fell inside the export was slower than
the others was not measured.

**Window test (go-live gate G6), passed 2026-10-22.** The test does not wait for the nightly run: a
private operator tool starts the same raw D1 export of the control database that the nightly backup
makes (`output_format: polling`, the nightly dump options; no Workflow, no backup row, and the signed
URL is never read), and the traffic around it runs from 60 s before to 120 s after its start. On
2026-10-22 (12:30:25.9 UTC, export completed in 6.1 s):

- one new `xs` test database took one committed `INSERT` a second: 181 acknowledged, 181 found
  afterwards, 0 lost, 0 refused, the slowest write 1,767 ms;
- 37 sleeping small test databases, never the databases of the cold-path measurement, were woken one
  every 5 s with one HTTP `/sql` request each under the integrators' retry rule: 37 answered, 0 failed,
  0 retries, WAKE plus request p50 750 ms and p95 1,486 ms. The record has no maximum and no time of
  each wake against the 6.1 s of the export. At one wake every 5 s, one or two of the 37 fell inside
  the export, and those may be among the samples above p95;
- the API Worker's logs in the window: 32 ticket claims, the longest actor gate held 3.3 s (the limit
  is 30 s), no `admission_refused`. A gate of 3.3 s fits a D1 commit that the export stalled; the
  logs do not say whether it was one.

The test database and its temporary key were removed afterwards. The pass rule is no failed wake
after the integrators' 1/2/4/8 s retry rule and no actor gate held above 30 s; the test meets it, and
it does not show that a wake inside the export is as fast as any other. Together with the
[restore drill](#restore-drill) of 2026-10-21 this meets gate G6; the full record is in the ULTRA
plan (11.1).

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
million (`850000` means 85%); `null` disables one. The alert evaluation of the `CronWatchdog`
alarm checks every node of a policy region once a minute:

- RAM is the 30-minute average of the node's active RAM, (MemTotal - MemAvailable) / MemTotal,
  over its own samples.
- CPU is the 30-minute average of the node's CPU load, busy time over all its cores.
  RAM and CPU need samples that span at least ten minutes and a newest sample at most 180 s old;
  otherwise they stay unknown and send nothing.
- Storage is the fuller of the thin pool's data and metadata in the node's newest sample.

The email subject is `PGCF infrastructure: <kind> (<region>)` and its body is the
event JSON, including `node_ids`, `threshold_ppm` and the highest `utilization_ppm`. The JSON also
carries `regional_ram_utilization_ppm`, always `null` since the regional RAM window was removed
(migration `0082`); it stays so that a receiver that reads it keeps working, and a receiver may
ignore it.
A node crossing during an active episode adds no message only while a listed node
still exceeds; otherwise it replaces the episode with a new event. The episode clears
only when every listed node is fresh and below the threshold, or lost.

The existing authenticated infrastructure webhook remains supported and takes
precedence when configured. Without a webhook or both email addresses plus the
Resend secret, alarms remain visible through the API and no notification is sent.
Delivery uses a five-second deadline and a minimum one-minute retry interval. The event UUID
(`event_id`) names the error, not the delivery: it is a version 8 UUID (RFC 9562; a name-based
UUID from SHA-256 is no version 5, which is SHA-1) made from the first 16 bytes of the SHA-256 of
the lines `pgcf.infrastructure-alert.v1`, the region, the kind and the sorted subjects, with the
version and variant bits set. The subjects are the IDs of the nodes or databases the event lists
or, for `control_cron_step_failing`, the names of the steps in `cron.failing_steps` with at least
five consecutive failures (a step that failed once is not part of the error); every other kind
has the ID of region and kind alone. The same error therefore has the same `event_id` every
time, also after it cleared and came back, and another set of subjects, another failing step
or another region is another error with another ID. The cron kinds are raised in every region,
so one cron stall is announced once per region, each with its own ID. A continuously active episode keeps
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
| `regional_node_capacity_refusals` | a node refused 5 or more wakes for awake capacity or for a full start queue (`57P03` "node at awake capacity" or "node busy starting databases") in the last 10 minutes | fixed | Move the node's most active databases to another node, or add a node |
| `regional_node_pool_closed` | the region cannot place the smallest size class on offer (the enabled class with the least memory, CPU and storage): no node that reports and is open for new databases takes it, by the rule of placement. One node that is full beside a node that takes the class is no episode. The event lists the nodes whose newest sample refuses the class, with thin pool data at 80 % or more, metadata at 50 % or more, the storage sold (its reported volumes plus the databases it has not finished) plus that class past 4 times its data, or 1,000 volumes or more, and, when the nodes that report, are open and have a pool with room have no RAM or CPU for that class, every one of those. RAM counts max(three-day peak, current sample) plus class memory, excluding transient pending placements; CPU counts the three-day peak and the class must fit physical cores. Peaks are 30-minute averages; both loads must stay below 80 % | fixed; ends as soon as one node takes the class again | Nothing is created, restored or moved in the region; running databases keep running. Delete databases on the listed nodes, or add a node |
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
  reported until it has been awake 36 h without a backup. The database's backup report must be fresh
  (at most 45 min old: a node names a database that did not change once in 15 min) and `ok` with a
  completion time, or `failing`; a sleeping database and an
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
  a crossing is seen at the next report and the next alert evaluation of the `CronWatchdog` alarm
  (once a minute) raises it. A volume that crosses
  both 80 % and 90 % between two reports raises only the critical alert; the warning is for
  growth slower than the report interval. The stored samples, one per minute for a database
  that can grow and one in each quarter hour (from its first report of it) for a hibernated one, feed `health.disk`, `storage` and
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

The minute cron runs these steps in order: `infrastructure_backup_dispatch`, then
`admission_recovery`, `node_fencing`, `resource_profile_rollouts`, `power_timeouts`,
`operation_timeouts`, `role_deletion_timeouts`, `idempotency_purge`, `node_hints`,
`database_actors`, `actor_warmers`, `usage`, `node_capacity`, `retained_archives` and
`backup_retention`. **The alerts are no step of the cron.** The `CronWatchdog` Durable Object
evaluates every alert of every region from its own alarm once a minute (the health alarms, the
capacity alarms and the judgement of the cron's heartbeat), so a step that is slow or hangs, a
run that does not start and a cron trigger that is gone cannot hold an alert back.

**What the platform does with the trigger (measured on 2026-10-23, 11:00 to 19:50 UTC, EU1 under
test load, from Cloudflare's invocation analytics and the Worker's log lines).** The cron trigger
is not reliable in time or place, and the Worker's own log lines mislead about it:

- *Late triggers.* No trigger was delivered on time from 14:41 to 14:54 or from 16:03 to 16:21.
  The analytics list no start from 14:41 to 14:54 (848 s between the starts of 14:40:54 and
  14:55:02) and none from 16:03 to 16:21 (1,156 s between the starts of 16:02:46 and
  16:22:02); the logs hold no scheduled invocation from 14:42:20 to 14:57:45. In the second window
  two re-deliveries of old triggers ran from about 16:06 (request `dead0744`, scheduled time
  14:27:02: `cron_step_failed` `actor_warmers` at 16:07:58 and `node_capacity_decision` at 16:08:31;
  request `04be5dbc`, 14:28:02: `node_capacity_decision` at 16:09:29; neither logged
  `cron_completed`); the analytics do not list them, because that minute was sampled (the 16:06:33
  row of FRA has `sampleInterval` 4). Once the delivered triggers arrived bunched: four starts
  within 50 s from 17:07:52 (each `sampleInterval` 1) after 350 s without one. Everything the cron
  does waits meanwhile: the keep-warm leases of the `ActorWarmer` objects last 180 s and lapsed in
  20 minutes of that day (`actor_warm_stopped`).
- *A far colo.* The 351 rows of 11:00 to 18:15 that the recipe below lists ran in Asia-Pacific
  colos (296) and US colos (55), none in Europe, while D1's primary is in WEUR: 97 s at the median,
  166 s at the 90th percentile, 340 s at most, with CPU at 310 ms at the median and 947 ms at
  most. The platform did not move the cron to Europe later; it ran some invocations there. Of the
  78 rows from 18:35 to 19:50, 22 ran in European colos (21.5 s at the median, 11.7 to 34.0 s), 39
  in US colos (66.8 s) and 17 in Asia-Pacific colos (89.3 s): inside one window, the run time
  follows the distance to D1. A run is long because each of its statements crosses to D1, not
  because a step is slow.
- *The alarm is steady.* The `CronWatchdog` alarm fired in 435 of the 435 minutes (435 rows, each
  `sampleInterval` 1; longest gap between two alarms 61 s), every minute of both windows included,
  in SIN, in 1.0 s at the median and 4.6 s at most.
- *`scheduledTime` is not a start.* `$workers.event.scheduledTime` of a log line repeats (14:27:02
  is the scheduled time of four invocations that logged at 15:05:08, 16:08:31, 17:15:12 and
  18:51:54, the last on a script version that did not exist at 14:27), so a duration computed from
  it is wrong.
- *The analytics are sampled and incomplete.* GraphQL `workersInvocationsAdaptive` for the Worker
  (an API token with Account Analytics: Read, read-only) is the only place that names a colo and a
  start, and it needs care. Read `avg{sampleInterval}` with every row: a row with `requests` above
  1 can be one invocation weighted by its `sampleInterval` (the rows of 14:07:02 in HKG and
  14:23:02 in SIN have `requests` 10, `sampleInterval` 10 and a maximum wall time equal to the
  mean, 81.7 and 119.4 s; the logs hold one `cron_completed` for the second and none for nine
  others, so they are no burst of ten starts). `subrequests` stops at 255 for an invocation (245
  of the 351 rows show exactly 255) and can be far below what a run made (16:35:02 in SIN shows 47;
  its `cron_completed` of 16:37:01 reports 435 usage statements), so a filter on many subrequests
  drops real runs (12:01:02 in NRT: 249 s, 8 subrequests). And invocations the logs show are
  missing (the two of 16:06).

  The recipe: fields `datetime` (the start of an invocation), `coloCode`, `status`,
  `sum{requests subrequests wallTime cpuTimeUs}` (`wallTime` in microseconds),
  `avg{sampleInterval}`, `max{wallTime}` and `quantiles{requestDurationP50}`, in slices of 10
  minutes (a query returns at most 10,000 rows). A cron run is a row whose `requestDurationP50` is 0
  (a scheduled invocation has no request) and that has at least 5 subrequests per request (HTTP
  streams that ended as `clientDisconnected` or `responseStreamDisconnected` also show 0, with one
  subrequest or none). A run delivered on time starts in second 02 of the minute (247 of the 351
  rows); the others are late deliveries. Then cross-check against the logs: of the 418
  `cron_completed` lines of 11:00 to 19:50, 372 have such a row ending (start plus wall time) within
  25 s of the line, and 376 of the 447 rows have a line, so the analytics miss runs and the logs
  miss runs that did not end; neither is the whole truth. An earlier filter (one request, at least
  100 subrequests, 10 s or more) listed 335 rows to 18:15, 16 fewer than the recipe.

The inode alert of that afternoon was this gap. The log of the volume-full run has the refusal at 14:49:48 (53100 `could not create file`, 31,400 tables) and, before it, the `database_volume_warning` episode with `occurred_at` 14:49:11.328. An episode is stamped with `now` of the cron run that evaluated it, so a run began at 14:49:11; neither the analytics nor the logs list it (see above: the analytics are sampled and incomplete, and the logs hold no scheduled invocation from 14:42:20.518 to 14:57:45.796). At 14:53:50 the run logged that the `database_volume_critical` episode had not come in 240 s (its last `occurred_at` was 14:38:07.122 of an earlier phase), and `control_cron_stalled` was active since 14:48:13.451. The analytics list no cron start from 14:40:54 to 14:55:02; the first on-time run began at 14:55:02, evaluated the alerts first and raised the critical episode at about 14:55:03, which is 315 s after the refusal. So no evaluation ran from 14:49:11 to 14:55:02 while the `CronWatchdog` alarm fired in every minute of it: the cron was the only place that evaluated the health and capacity alerts, and the alarm judged the heartbeat alone. The alarm evaluates them now, so a gap in the trigger cannot hold an alert back, and each episode it opens logs `alert_episode_opened`, so that a late alert can be attributed to the node's report, the evaluation or the delivery.

Each step runs in its own failure boundary and has 240 s. A step that throws is logged as
`cron_step_failed` (`step`, `error_code`, a redacted `message` and `ms`; the heartbeat and the
alerts carry the code only), counted in the heartbeat and returned in the run's
`step_failures`, and the steps after it still run. A step that has not answered after 240 s is
abandoned the same way with the `error_code` `step_timeout`: what it left unfinished is picked up
by the next run. A region whose capacity decision or alert evaluation fails does not stop the
other regions, and one kind that fails to evaluate does not stop the other kinds of its region.
The Worker's own cron outcome stays successful when steps fail: read `cron` in the health route
and the alarms, not the cron trigger's error rate.

The run logs one `cron_completed` line with `step_ms`, the milliseconds of each step in the order
they ran. It does not name the colo (that would take a trace request in every run): read it
from the analytics above, and cross-check it against these lines.

The alarm logs one `alert_evaluation` line a minute: `duration_ms`, `phase_ms` for its three
phases (`health_alerts`, `capacity_alerts`, `cron_watchdog`) and `failed`, the phases that threw or
did not answer within 30 s (`alert_phase_failed` names the phase, the `error_code` and a redacted
message). A phase that fails does not stop the phases after it. An evaluation spends at most 20 s
sending notifications; the rest stay unclaimed, are logged as `infrastructure_alert_deferred` and
are sent by the next evaluation. A line a minute, with `cron.watchdog_checked_at` following it,
is the proof that the alerts are judged every minute. Each episode an evaluation opens (or opens
again) logs an `alert_episode_opened` line (`region_id`, `kind`, `event_id`, `occurred_at`) in the
same invocation: with the time of the node's report in D1 (`node_volumes.observed_at` for a
volume) it says whether a late alert was late in the report, the evaluation or the delivery.

The run records its heartbeat in D1 (`cron_heartbeat`, one row): `started_at` when it
begins and `completed_at` once every step was attempted, with each failing step's
consecutive failed runs. Both heartbeat writes use the same 240 s bound as a step; a lost response
logs `cron_heartbeat_failed` with `cron_heartbeat_timeout` and cannot stop subsequent work or
prevent the run from returning. The alarm bounds its `watchdog_checked_at` write at 30 s and logs
`alert_evaluation_unrecorded` if it fails or times out, then still emits `alert_evaluation`.
`cron` in `GET /v1/operational-health?scope=regions` shows it with a `status`:

| `status` | Meaning |
| --- | --- |
| `ok` | a run completed within 300 s and no step failed in each of its last 5 runs |
| `failing` | a step failed in each of its last 5 completed runs (`failing_steps`) |
| `stalled` | no run completed for more than 300 s |
| `unknown` | no run has been recorded yet |

The watchdog's alarm is independent of the cron because the cron does not schedule it: the cron
only arms the alarm (idempotently, at the start of each run), and every alarm schedules the next
one before it evaluates anything. It therefore keeps firing when the Worker's cron trigger is
removed by a deployment or its invocations do not start, when a step hangs and runs never
complete, and when every step fails. It does not cover the Worker being undeployed or D1 being
unreachable. Its evaluations are visible as `watchdog_checked_at`, the start of the latest one; a
value that stops advancing means either the alarm chain stopped (check the `CRON_WATCHDOG`
binding and its `v4` migration) or its heartbeat write failed (check `alert_evaluation_unrecorded`
and whether `alert_evaluation` still appears). While the cron is stalled its step counters are
those of its last completed run, so a `control_cron_step_failing` episode is kept and neither
started nor cleared.

Reading a stall: `last_started_at` recent with `last_completed_at` old means runs begin
but do not finish (a step is slow: `cron_step_failed` with `step_timeout` and `cron_completed`'s
`step_ms` name it; the alerts keep running because they are no step), both old means no run
starts (the platform did not deliver the trigger, or the trigger or the deployment is gone:
the analytics above show which).

## Proving delivery

The notification path is proven by one real alarm rather than a test endpoint. Set
`RESEND_API_KEY` as a Worker secret, `notification_sender` on a domain verified in the
Resend account and `notification_recipient` through `PUT /v1/infrastructure-backups/config`
(this does not touch a running backup), then let any episode arm: an existing active
undelivered one is sent by the next alert evaluation of the `CronWatchdog` alarm (within a minute), or read a region's complete policy with
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

**Last drill: passed on the artifact of day 2026-10-21** (the nightly run completed at 00:00:25 UTC;
43,708,855 plaintext bytes, key version `dev1`; drilled at 00:03 and again at 00:05 UTC with the same
result). The object was downloaded from R2, decrypted and authenticated against its receipt, and
imported into a new scratch D1 in 24 chunks (the largest 5,000 statements or 2,097,085 bytes; the
largest single statement 49,223 bytes): 55 tables, 82,761 queries and 310,008 rows written, every
chunk accepted the first time. `PRAGMA foreign_key_check` returned no row; `d1_migrations` (81) and
`databases` (846) equal the live control database, `regions` 2 and `nodes` 5. The scratch database
was deleted by its ID. The window half of gate G6 is the
[window test](#the-d1-export-window) of 2026-10-22; the full record is in the ULTRA plan (11.1).

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
   installation's archive bucket (the `ARCHIVE` binding). An EU archive bucket is in the EU
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
   - cuts the SQL into chunk files of a bounded size (see [below](#how-the-tool-cuts-the-sql)),
     each statement byte for byte, in the same `0700` directory with mode `0600`, and removes the
     decrypted file; it measures every statement first and stops with `statement_too_large`,
     before anything is imported, if one is above 100,000 bytes (see "A statement above 100,000
     bytes" under step 5);
   - runs `wrangler d1 execute <database ID> --remote --yes --file <chunk>` for the chunks one
     after the other from that directory, which holds no wrangler configuration, so a configured
     binding cannot redirect the import, and removes each chunk once wrangler reports it imported;
   - runs `PRAGMA foreign_key_check` on the scratch database and refuses a database where it finds
     a row;
   - removes the directory, and counts the tables of the scratch database (tables only; the
     indexes, triggers and views the dump also creates are not in that number).

   It prints the artifact's day, region and key version, the plaintext and encrypted byte counts
   and SHA-256, the scratch database's ID, the number of chunks and a line for each chunk imported,
   `foreign_key_check: no violations`, and the counts. It never prints SQL, the keyring, the
   control database's ID or wrangler's own text about the import, which can quote a statement; if
   a chunk fails, it reports the chunk's number, its statement and byte counts, wrangler's exit
   code or `timeout`, and whether wrangler's output reports a D1 reset (yes or no, nothing else of
   it): the token `D1_RESET_DO` or the word "reset", as in Cloudflare's "D1 DB exceeded its CPU time
   limit and was reset." and wrangler's "D1 reset before execute completed!".

   **Progress.** Each chunk is one wrangler run (an upload to R2, the provider's ingest, and polling
   until it ends); the first artifact (31.8 MB) is about 18 chunks. wrangler's own lines are not
   shown, so the tool prints a line when a chunk is imported and nothing while one runs; it stops a
   chunk that runs for 10 minutes.

   **If a chunk fails.** The error reads `chunk N of M failed (S statements, B bytes): wrangler d1
   execute failed (exit code C); D1 reset in its output: yes` (or `no`), with `(timeout)` in place
   of `(exit code C)` when the tool stopped wrangler. After an exit code the chunks before N are
   committed and N itself is not (wrangler: a failed import returns the database to its original
   state); after a `timeout` that does not hold, because stopping wrangler does not cancel the
   provider's ingest, so N may still be applied afterwards, which does not matter because the
   database is deleted next. Either way the scratch database is half filled. There is no resume: a
   retry on that database is refused (`already has N schema objects`), because importing again would
   duplicate rows. Delete the scratch database (step 7) and create a new one (step 3) before
   importing again. What to change depends on the answer:
   - **`yes`, after an exit code or a `timeout`:** the output reports a reset: the provider reset
     the D1 database while it ran a chunk of S statements and B bytes. Run the import on the new
     scratch database with `--chunk-bytes` and `--chunk-statements` at half of the values the run
     printed on its `chunks of at most` line, and record the values that pass in the ULTRA plan.
     Halving cannot shrink a chunk that is never cut: the last one (sequences, indexes, triggers
     and views), one statement above the byte bound, and tables that reference each other (the
     `loaded in one chunk` line). If B is such a chunk, keep the artifact and report the numbers.
   - **`timeout` with `no`:** wrangler did not finish the chunk in 10 minutes and the tool stopped
     it. It is not established whether the chunk was too much work, the provider's ingest was stuck
     or the network stalled, so do not treat it as unrelated to the chunk size: import into a new
     scratch database with both bounds halved. If a chunk times out again with the halved bounds,
     the size of the chunk is not the whole cause: check Cloudflare's status page and the account,
     and report N, S and B.
   - **`no` with an exit code:** the output holds neither the token nor the word "reset". That is
     the absence of those words and not proof that the chunk was not a reset, so it does not say
     that smaller chunks change nothing. wrangler may have failed for another reason: D1 refused a
     statement, a token or login was refused, or the network failed. Import once more into a new
     scratch database with the same bounds; a network or provider error usually does not repeat at
     the same chunk. If the same chunk number fails again with `no` and the same S and B, import
     once into a third scratch database with both bounds halved. If that chunk fails again, the
     cause is that chunk or the account, and wrangler's message stays unprinted because it can quote
     the SQL. Write the verified SQL with `decrypt --input FILE --output FILE --keys-env NAME` (mode
     `0600`, never over an existing file), load it into a plain SQLite shell with
     `sqlite3 :memory: < FILE` to see whether the dump itself loads (if it does, D1 refused a
     statement that SQLite accepts: report N, S and B), and delete the file afterwards. Do not
     import the whole file by hand to read a chunk's error: the whole file is what D1 reset.

   **A statement above 100,000 bytes.** D1 refuses one statement above 100,000 bytes
   (`SQLITE_TOOBIG`), however small the chunk that holds it. The first complete backup (2026-10-20)
   held two such rows, both diagnostics a node had sent: the answer to a journal probe in
   `node_diagnostic_requests` (an `INSERT` of 127,397 bytes) and a boot report in `node_diagnostics`
   (212,685 bytes), so chunk 16 of 18 failed with `statement too long: SQLITE_TOOBIG` after 15
   chunks had been imported. The tool now reads every statement before it writes a chunk and, if
   one is above 100,000 bytes, stops with `statement_too_large` before it imports anything. It
   names each table with the number of such statements and the size of the largest, and never a
   byte of one. The API now bounds what it stores (a boot report or probe result row is at most 64
   KiB as its `INSERT` statement, and a larger answer is stored cut and marked `truncated`), so no
   row stored after that deploy is too large. The rows stored before it stay in the control
   database, and in every backup of it, until the 30-day cleanup or the statement below removes
   them. What to do:
   - **`node_diagnostics` or `node_diagnostic_requests`:** delete the rows from the live control
     database once, then take a new backup (or wait for the next daily run) and restore that one;
     the diagnostics are kept 30 days only, and the rows above the bound are the ones the API no
     longer stores. Look first, then delete (from a directory with no wrangler configuration, naming
     the control database by its ID):

     ```sh
     (cd "$(mktemp -d)" && wrangler d1 execute <control-database-id> --remote --command \
       "SELECT 'node_diagnostics' AS \"table\", id, length(CAST(body AS BLOB)) AS bytes FROM node_diagnostics WHERE length(CAST(body AS BLOB)) > 65536 UNION ALL SELECT 'node_diagnostic_requests', id, length(CAST(body AS BLOB)) FROM node_diagnostic_requests WHERE length(CAST(body AS BLOB)) > 65536")
     (cd "$(mktemp -d)" && wrangler d1 execute <control-database-id> --remote --command \
       "DELETE FROM node_diagnostics WHERE length(CAST(body AS BLOB)) > 65536; DELETE FROM node_diagnostic_requests WHERE length(CAST(body AS BLOB)) > 65536")
     ```

   - **any other table:** ask for support, and keep the artifact. Do not cut the dump by hand: a
     backup that was edited is no longer the backup, and the tool offers no flag to skip a
     statement.

   Ctrl-C, `kill` and a closed terminal (SIGINT, SIGTERM, SIGHUP) stop wrangler, remove the
   decrypted SQL and end the run with exit code 130, 143 or 129. A run killed with SIGKILL, or by a
   power cut, cannot clean up: delete `$TMPDIR/pgcf-restore-*` (for `import`) or `<output>.partial`
   (for `decrypt`) by hand.

   **Verified by the drill of 2026-10-21:** D1 accepts a file that opens with the dump's `PRAGMA
   defer_foreign_keys=TRUE;` and takes chunks of the default size (2 MiB, 5,000 statements): all 24
   chunks of the artifact of that day were accepted the first time, so neither the pragma at chunk 1
   nor the first chunk of rows was refused or reset. The chunks do not depend on how D1 groups a file
   into transactions: every table's rows come after the rows of the tables it references.

6. **Check the scratch database** against the live one. The tool has run `PRAGMA foreign_key_check`
   (it printed `foreign_key_check: no violations`). `d1_migrations` and `regions` must match the
   live database; the other counts may have moved since the export began. Name the database by the
   ID the tool printed on its `importing into` line, and run wrangler from an empty directory as in
   step 3, so that a wrangler configuration cannot redirect the query to another database:

   ```sh
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

### How the tool cuts the SQL

**Why one file did not work.** The first complete artifact (day 2026-10-20, 31,785,799 bytes, 55
tables, the largest `usage_samples` with 30,722 rows) decrypted, authenticated and held to its
receipt, but importing it as one file failed three times: wrangler exited with code 1 and the
error body `{"D1_RESET_DO":true}`, with no row read or written. The provider reset the D1 database
while it ran one 31 MB file. 31 MB reaches none of the size limits Cloudflare documents: an import
through `wrangler d1 execute --file` is limited to 5 GB (the file goes to R2), one statement to
100,000 bytes and one row to 2 MB; whether the 30-second limit on a query or API request applies to
an import is not documented. Cloudflare's D1 debugging page lists a query that is "trying to write a
large amount of information (e.g. GBs), and is taking too long" (written for gigabytes, which 31 MB
is not), the database's isolate exceeding its memory limit, and CPU time exceeded when "attempting
a large import/export", and advises splitting the work; it also lists an internal error or code
update, for which it says to retry. `D1_RESET_DO` itself is not documented and the response names no
reason, so **which of them it was is not established**. Each of them grows with the work one import does, and one file of
31 MB and at least 47,000 rows (the five largest tables alone) is a great deal of it. The tool therefore bounds the work of
every import and does not rely on a number it has not seen.

**What a chunk is.** The decrypted SQL is cut at statement boundaries (the scan follows quotes,
identifiers and comments, so a semicolon or a line break inside a string ends nothing, and a
trigger's pieces stay together) into files `chunk-0001.sql`, ..., and the chunks run in this order:

1. **The schema:** every `CREATE TABLE`. D1's export lists a table's rows right after its
   `CREATE TABLE` and the tables in the order they were created. A migration that rebuilt a table
   puts it after the tables that reference it: in this repository's migrations 13 of the 68
   foreign key entries point at a table created later (`nodes`, `databases` and others at `regions`).
   SQLite refuses the first row of a table whose referenced table does not exist yet (`no such
   table: main.regions`), even under `PRAGMA defer_foreign_keys`, which defers violations only.
2. **The rows, parents first.** The tool loads the `CREATE TABLE` statements into an in-memory
   SQLite and reads each table's `PRAGMA foreign_key_list`; a table's rows come after the rows of
   the tables it references, and otherwise in creation order. Because every chunk is committed
   before the next, a chunk is valid whether D1 runs a file as one transaction or statement by
   statement. Tables that reference each other, and a table that references itself, cannot be
   ordered: their rows are loaded in one chunk whatever its size, under the dump's
   `defer_foreign_keys`, and the tool names them in a line `tables that reference each other are
   loaded in one chunk`. This repository's schema has none (54 tables and 68 foreign keys in the
   migrations; no cycle, no self-reference).
3. **The rest, in the dump's order,** as one chunk: the `sqlite_sequence` rows, indexes, triggers
   and views, which the dump puts after its rows (triggers must not exist while rows load, or the
   inserts fire them). It holds no rows, only schema, so it is not cut by size.

Every chunk opens with the dump's own `PRAGMA` statements, because `defer_foreign_keys` lasts for
one transaction. The chunks hold exactly the dump's bytes (the pragma once per chunk more); the
tool checks that before it imports anything and otherwise stops with `reorder_failed`.

**The bounds** are `--chunk-bytes` (default 2 MiB) and `--chunk-statements` (default 5,000), each
at most; a statement larger than the byte bound has a chunk of its own. They are **starting values,
not measured limits**: each is about a tenth to a fifteenth of the unit that was reset (31.8 MB, at least
47,000 statements), a few thousand of this database's rows, while a chunk's fixed cost (an
upload to R2 and several API calls) stays small beside it. The statement bound matters for small
rows, where CPU time grows with the row count rather than the bytes. The tool prints the number
of chunks and the size of the largest statement; D1 refuses one above 100,000 bytes, and the tool
refuses the SQL before it imports anything when one is (the first live backup held two, in the
diagnostics; see "A statement above 100,000 bytes" under step 5).

**What was checked without the provider.** The tool's tests run a wrangler double on real SQLite
that, like the provider, resets a file above a size and loads each file as one transaction with
foreign keys enforced; and wrangler's own local D1: the export of this repository's migrations
(55 tables, 27 triggers, 80,225 bytes), cut into 19 small chunks and run with `wrangler d1 execute
--local --file`, exports the same lines as the original and has an empty `PRAGMA
foreign_key_check`. The provider's own export and import are first tried by the drill.

| The tool says | Meaning |
| --- | --- |
| `authentication failed` | The file was changed or cut, or the key is not the one that wrote it. Check the key version the artifact names and the keyring in custody. |
| `not a complete PGCFINF1 envelope` | The download is truncated, empty or not an artifact of this layout. Download it again. |
| `the keyring has no usable key version` | The keyring lacks the version the artifact names. Find the custody copy that holds it. |
| `differs from the API's receipt` | The artifact is not the one the receipt describes, or it was replaced in R2. Treat it as unverified. |
| `is the database this artifact was exported from` | The name resolves to the control database. Create a new scratch database. |
| `already has N schema objects` | The target is not empty, or an earlier import stopped in it. Delete it and create a new scratch database. |
| `the SQL holds a statement above 100000 bytes` | `statement_too_large`: D1 would refuse that statement, and nothing was imported. The message names the tables and the largest size of each. See "A statement above 100,000 bytes" under step 5. |
| `chunk N of M failed (S statements, B bytes)` | The chunk did not import; chunks before it did. The `exit code C` or `timeout`, and the `D1 reset in its output` yes or no, decide the next step: see "If a chunk fails" under step 5. |
| `PRAGMA foreign_key_check found N rows without a parent` | The scratch database is not a faithful copy of the artifact. Do not rely on it; keep the artifact and report the tables named. |

