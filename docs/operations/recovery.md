# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2. A database whose sleep was proven loses nothing; an awake one loses at most its
`archive_timeout_seconds` plus the upload time, because the last recoverable commit depends on the
WAL that actually reached R2. There is no synchronous replica or zero-loss promise. Record both
recovery duration and the last restored commit in the ULTRA plan after each real drill.

The operator topology is EU only: customer EU1 (6 vCPU, 12 GB RAM), as recorded in the canonical
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md). EU1 is the region's
only node, so losing it stops every database until each is restored from R2 onto new capacity.
Never order a replacement node without the owner's explicit, costed go.

Recovery drills use separate targets while preserving the healthy source and its committed data.
Do not reset, re-adopt, fence, delete or decommission EU1 for an acceptance drill. The incident
procedures below apply to an actual loss or a separately reviewed drill that preserves or
recovers the same customer EU1.

## Restore or PITR

1. Check `/v1/operational-health?scope=databases` and the source's archive summary. Missing
   observations are unknown. A completed base backup and continuous archived WAL are required.
2. Submit `POST /v1/databases/{source-id}/restore` with a persistent `Idempotency-Key` and either
   `{"mode":"full","name":"recovered"}` or
   `{"mode":"pitr","name":"recovered","target_time":"<UTC timestamp>"}`.
   The target is in the source's region: a node reads only its own region's archives, so another
   `region_id` is refused with 409 `region_unavailable`.
3. Save the returned target ID and operation ID. Repeating the same request and key returns the
   same target; a transport failure does not justify issuing a new key or replaying SQL writes.
4. Poll the operation. The source stays unchanged. The target uses new storage and its own
   archive path in the source's region, in the installation's archive bucket (the same endpoint
   for every region); its configuration revision is independent of its storage generation. Source
   backup/WAL selection reads the source's archive path and catalog, including when the source
   has been deleted.
5. Ready means the node promoted the restored database onto a later timeline than the backup's,
   with the backup's system identifier, reset its roles and took the first base backup of the new
   timeline into the target's own archive, which counts only when it is DONE (plan 7.8). Authenticate
   to the target over the normal endpoint and compare the required tables, roles, sequences and
   committed markers. Confirm promotion by writing a new target marker. Source credentials never
   write the target's archive: the restore reads the source with a read-only credential.
6. Switch the adopter's connection only after these checks. Once writes reach the target, do not
   switch back to an older source without reconciling those writes.

A restore whose operation ends `failed` is not tried again by the node. It abandons the build once
(the unit stops, the volume and the user go) and the target stays in `error` until it is deleted;
the error is the build's, and it can read `volume_missing` after the node's agent restarts, because
the node has nothing of the target and the page names no source for a failed restore. Delete the
target and submit the restore again with a new `Idempotency-Key`; a failure that is not the
source's (a `tar` that ended early while the archive was read: 1 of 9 restores on 2026-10-23)
passed at the second request, the one time it was seen.

**The operation timeout and the node's one slot.** A node restores through one big-job slot
(`backup.base_backups` is 1): every backup listing, base fetch and base backup of every restore and
create on the node takes a turn, first come first served. The slot time of one restore, measured
on EU1, is 18.2 s for an xs-sized database and 99 s and 170 s for one with 557 MB of data (below),
so the restores of a population take the sum of their slot times, one after another. The operation timeout of 20 minutes
counts the time without a report: the node says `building` for a restore or a create with every
pull of its page, and each of these reports restarts the count. A restore that waits for the slot
behind others is therefore not failed while its node reports it, whatever its place in the queue. A
restore whose node reports nothing about it for 20 minutes (the node or its link is down, or a
credential that never arrives) is failed `operation_timeout`, 20 minutes after its placement if the
node never reported it. **A restore or a create that is still `building` 24 hours after its
placement is failed `operation_timeout` too** ("Build exceeded 24 hours after its placement"),
whatever the node reports: `building` says that the node awaits the build and not that it moves,
so a build whose task ended or whose call hangs would otherwise stay `running` for ever. A batch
as below ends in a fraction of that. This is built and tested and not yet deployed; its live
acceptance, a batch longer than 20 minutes, is open (the plan's 11.2). **On an installation whose
release does not have it** the 20 minutes ran from the first `building` report whatever the
progress and included the wait for the slot, so restores requested together on one node timed out
far below 2.5 GiB of data (on EU1, a restore of about 0.5 GiB waited 6 s for its listing and 112 s
for its first base backup behind another build) and a queue of more than about 65 xs-sized or 7 to
12 gate-sized restores failed most or all of its restores, which ended ready on the node and archived WAL while the API kept the
target `provisioning` with the operation `failed`: there submit the restores (and creates) of one
node in batches whose summed slot time ends well within 20 minutes, and delete a target left that
way and submit the restore again.

**Submit restores in batches that fit the node's awake memory.** On every release, request the
restores of a node's population in batches, and the next batch when every operation of the
previous one has ended (`succeeded` or `failed`). A batch is bounded by memory and not by the
timeout: the summed class memory of its restores must stay within the awake budget of the region's
node policy (`awake_budget_mib`, read at `GET /v1/regions/{id}/node-policy`; 9,937 MiB on EU1, so at
most 38 xs-sized (256 MiB) or 9 gate-sized (1 GiB) restores, or a mix whose memory adds up to
that; under the `reserved` memory rule count `reservation_overhead_mib` more for each, and leave
what the node's other awake databases hold). The reason is that a restore starts its PostgreSQL
through the node's admission right after its fetch and keeps it running through its first base
backup and the listing after it, and both wait for the slot behind the fetches of the other
restores of the batch. Nearly all restores of a batch are therefore awake at the same time before
the first of them is ready, and a start that does not fit within the policy's `queue_wait_ms`
(10 s on EU1) is refused: the restore fails `start_failed` and is abandoned. The placement of the
population does not prevent it, since the population was placed by the peaks of its awake memory
and not for being awake together. This bound is derived from the code and the policy and has not
been tried live; a population-sized run replaces it by a measured one (the plan's 11.2). The batch
also leaves room for the node's other base backups, which use the same slot.

**A rollout during a restore.** A release rollout restarts the node's agent, and the agent that
starts finds the restore it was building and begins it again: it stops the PostgreSQL and the
restore job of the earlier run, and then goes on according to what the earlier run left in the
database's own archive. With no finished base backup there, it removes the half-restored data
directory of the new database (never a database that was served) and fetches again, so the
restore starts over and takes its whole time again. With the first base backup DONE there, and
the cluster on the volume being the one that backup was taken of, it starts that promoted
database, checks who it is and finishes over the backup, with no second fetch and no second
backup; the stretch between the backup and the end of its listing is a long one in a batch, since
the listing waits for the slot behind the other restores. A DONE backup that is not that
cluster's refuses the restore `prefix_not_empty`; delete that target and submit the restore
again. A rollout during a batch therefore costs the time of the builds it interrupts in their
fetch, recovery or first backup, and fails none of them. Live acceptance of this is open (the
plan's 11.2); roll a release out between batches when there is a choice.

A deleted source can be restored within its configured retention window. Keep its encrypted
credentials and the corresponding `CREDENTIAL_KEYS` key IDs until that window ends. Expired
archive cleanup is bounded and uses only the exact owned prefix; do not modify archive timestamps
to simulate expiration.

The v1 catalog is limited to 16 pages, 16,000 objects, 64 backup metadata files and 64 KiB per
metadata file. A newer WAL timeline needs a completed base backup on that timeline. Unsupported,
missing or ambiguous coverage is refused rather than creating an empty database.

## Lost node

Node-loss and node-addition endpoints require an `admin` API key (an `admin_read` key reads them and
changes nothing). A node is never declared lost from staleness alone, and fencing comes before any
database moves (plan 7.11, 9.4).

1. Read `/v1/operational-health?scope=nodes` and verify the actual node UID. A node whose newest
   sample is older than 180 seconds is stale: placement excludes it, its region is no longer
   listed to integrators as accepting placement until the node reports again, and
   `regional_node_stale` fires; that does not declare it lost or authorize a replacement order.
   Its `ready`, `schedulable` and placement flags stay as they were: they are the operator's and
   the lost-node procedure's, and the closure is read from the observation each time, so nothing
   stays closed once the node reports. Look at the node
   first ([below](#looking-at-a-node)); a silent node answers nothing, so check the instance in the
   Contabo panel.
2. Submit `POST /v1/nodes/{id}/mark-lost` with
   `{"expected_node_uid":"<verified UID>","reason":"<short incident description>"}`. One batch
   writes the fence before anything else: the node's key is restricted to the fenced scope (it still
   signs the pull of its desired page and its observation reports and nothing else; every other
   signed call answers `403 node_fenced`), its page holds a `fence` order and, for each database on
   it, a `superseded` order for its current storage generation with the volume kept, and every move
   from or toward the node ends. The node is marked lost, which closes its databases at the Edge.
   Loss is terminal, repeated calls preserve the original record, and metadata, archives and
   historical provider receipts remain available. Heartbeats cannot make the node healthy again.
3. The minute cron finishes the fence one step per run and retries each step until it holds: it
   deletes the node's Tunnel (its token dies with it) and then the node's DNS records that point at
   that Tunnel (`pgcf-node-<id>`, `pgcf-shell-<id>` and the former `pgcf-node-<id>-ssh`; no other
   record of the zone), orders the instance powered off through the
   Contabo API, and reads the instance until the provider says stopped. `GET /v1/nodes/{id}/loss`
   shows `fencing` or `fenced`, the time of each step, the class of the step that failed last (a
   fence stuck for days raises `control_cron_step_failing`) and, for each database of the node, the
   proven-sleep record and the newest base backup the node last reported: the recovery point.
   Measured on EU1 (2026-10-19): `mark-lost` at 18:40:33 UTC, Tunnel deleted and instance off
   (`fenced`) by 18:41:03, within 30 s.
   **DNS records.** The step deletes the node's proxied CNAME records after its Tunnel:
   `pgcf-node-<id>`, `pgcf-shell-<id>` and the former `pgcf-node-<id>-ssh` under
   `NODE_GATEWAY_DOMAIN` (`<id>` is the node's ID without its `nod_` prefix), each only if it points
   at a Tunnel of that node (a deleted one included). A record of that name that points elsewhere,
   and every other record of the zone, stays. The Worker's `CLOUDFLARE_API_TOKEN` needs Zone: DNS:
   Edit on that zone for it ([permissions](operator-installation.md#reviewed-deployment-inputs)).
   Without it, or without a usable `NODE_GATEWAY_ZONE_ID` and `NODE_GATEWAY_DOMAIN`, the Tunnel is
   gone and the step fails (`tunnel_delete_failed`, or `fence_unconfigured` for the zone); the cron
   repeats it whole each minute and orders the instance off only when it holds. A node fenced by an
   API Worker from before 2026-10-22, which lacked this step, left its records pointing at the
   deleted Tunnel. Delete them by hand, with the `CLOUDFLARE_API_TOKEN` of the Worker from private
   custody: list the zone's CNAME records of that exact name
   (`GET /zones/{zone}/dns_records?type=CNAME&name=<hostname>`), check that each one's target is
   `<tunnel-id>.cfargotunnel.com` of that node's Tunnel, which Cloudflare lists as deleted
   (`GET /accounts/{account}/cfd_tunnel?name=pgcf-node-<id>&is_deleted=true`), and delete only those
   records (`DELETE /zones/{zone}/dns_records/{record}`). Never delete a `pgcf-` record whose Tunnel
   is alive, and never a record by name pattern alone: the cleanup of 2026-10-22 deleted only a
   record whose target was one of the account's own deleted Tunnels.
4. Only when the status is `fenced`, restore the affected databases onto healthy capacity with the
   separate-target restore procedure above. Each restore is a new database with a new ID; the
   integrator rebinds. The last archived commit is what comes back, not the last acknowledged one
   (a database with a proven-sleep record loses nothing). The node restores through one big-job
   slot, so the restores of a population take turns and take the sum of their slot times (below).
   Request them in batches that fit the node's awake memory, the next when the previous has
   ended, as above.
5. A node that comes back after the fence pulls a page that holds the fence and the superseded
   orders and no database. The agent writes them to disk before it acts, never lifts one because it
   left the page, starts and archives none of those databases, and keeps their volumes. A fence
   ends only with a reinstall, which is a new install with a new key.
6. To reinstall the same instance, or replace it, use AddNode in recover mode with the pull
   installer ([plan 9.2](../architecture/cloudflare-convergence-and-serverless-plan.md#92-installing-a-node-on-contabo-no-relay-no-ssh);
   [adding a node](operator-installation.md#adding-reinstalling-and-updating-a-node)). A replacement
   server is a purchase and needs the owner's costed go. The reinstall guard refuses recover mode
   while the fence is incomplete and while any database of the node lacks a proven-sleep record for
   its current generation, because a reinstall overwrites any WAL that never reached R2; the owner
   acknowledges that loss with `POST /v1/nodes/{id}/reinstall-override` and a reason.
7. The reinstall brings the node back empty: recover mode restores nothing, and each database
   is restored from R2 as a new database with the restore procedure above (a new ID; the
   integrator rebinds).

**Measured (EU1).** Fence: within 30 s of `mark-lost` (2026-10-19). Reinstall: AddNode in recover
mode reached `ready` after 231 s on 2026-10-19; the pull install alone took 196.5 s from the rescue
request to the enrolled node in Stage 4 (2026-10-18; the steps are under
[adding a node](operator-installation.md#adding-reinstalling-and-updating-a-node)). **Restore: per
database measured, the total extrapolated.** The test databases had been deleted before that
reinstall, so no node's population has been restored; EU1 was not wiped again. On 2026-10-23
(release `sha-967f602d5c9b`) restores into new databases took 34.5 to 50.9 s for xs-sized databases
(4 to 12 MB of archive; 18.2 s of it in the big-job slot) and 248.7 s and 319.3 s for a database
with 557 MB of data. The 248.7 s restore ran alone and is a single restore: its 557 MB came from
WAL (the base backup it fetched was small), 889 MB of which it replayed in 139 s off the slot, and
it held the slot for 99 s (listing 0.9 s, fetch 1.5 s, first base backup 96.2 s, listing 0.8 s). The 319.3
s restore was a restore of that database with its 557 MB in the base backup; it overlapped the
agent's own rebuild of a failed restore of the same backup (the defect of the plan's 11.1 row "A
build that failed is abandoned and not begun again") and waited 6.4 s for its listing and 112 s for
its first base backup for the slot, which it then held for 170 s (listing 0.9 s, fetch 40.5 s,
first base backup 125.0 s, listing 3.5 s); without the two waits it took about 200 s. The one
big-job slot serialises the listing, the base fetch and the first base backup of every restore on
the node, so the slot time summed over a population is a floor for its restore time. From the
measured slot times, 18.2 s for each of EU1's 108 xs-sized databases (33 min) and 99 to 170 s for
each of its 59 gate-sized ones (97 to 167 min; 23.4 GB of archives in all), that is 130 to 200 min,
2.2 to 3.3 h, and with the fence (30 s) and the reinstall (174 to 197 s) about 2.2 to 3.4 h for the
loss of EU1.
**That total is an extrapolation and not a measured run**: it is a floor, because the population
goes in batches that fit the awake memory (above: EU1's 167 databases have about 86 GiB of class
memory against a budget of 9,937 MiB, so at least 9 batches) and the end of a batch, the last
recovery and first backup, leaves the slot idle. It assumes that every restore succeeds at its
first request (1 of 9 attempts on 2026-10-23 failed `archive_unusable` and passed at the second
request) and that the report-based operation timeout above holds, which has not been run on a
batch longer than 20 minutes. A batch of that length, on a release that has the timeout, measures
the total, and a run of a whole population measures whether the batch bound above holds (the
plan's 11.2).

## Looking at a node

A node has no shell and opens no port, so an administrator asks its agent to read one thing and
send it back over the link. The probes only read: each is a fixed command (no shell) or a read of
fixed files, built by the agent, and a request names the probe and three integers, never a
command, a path or a unit. Asking needs an `admin` API key; an `admin_read` key reads the answers; any
other key is told 404.

Do not ask a node whose agent is older than the build with probes (SEC-09). It refuses a desired
page that carries a request, and takes no order from a full pull (maintenance, move, fence, a
release, the one that would update it) until the request expires, ten minutes later.

1. `POST /v1/nodes/{id}/diagnostics` with `{"probe":"<name>"}` and, for `journal` and `kernel`,
   `"boot"` (0 this boot, -1 the one before; default 0), `"since_seconds"` (60 to 86400; default
   3600; `journal` only) and `"lines"` (1 to 2000; default 200). It answers `202` with a
   `diagnostic_id`, records your key, and tells the node to pull its desired page, which lists
   the request.
2. `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}` is `requested` until the node's result
   arrives, `received` with the result in `body`, and `expired` after ten minutes without one.
   A node answers within two pulls of its page; a node that is stale, fenced or off answers
   nothing, and the request expires. A reboot has its own record: the boot report, listed at
   `GET /v1/nodes/{id}/diagnostics` and read with its journal lines at the `diagnostic_id` path above.

| Probe          | What the agent runs                                                                                                                                                          | What it shows                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `journal`      | `journalctl --no-pager --output=json --boot=<boot> --since=-<s>s --lines=<n>` for `pgcf-agent`, `pgcf-gateway`, `pgcf-cloudflared`, `systemd-networkd`, `ssh`, PID 1 and the kernel | the entries of the boot report, for this boot or the one before          |
| `kernel`       | `journalctl --no-pager --output=json -k --boot=<boot> --lines=<n>`                                                                                                           | the kernel's lines (out of memory kills, I/O errors, thin pool warnings) |
| `boots`        | `journalctl --list-boots --no-pager`                                                                                                                                         | the boots the journal holds, and so whether a reboot happened            |
| `failed_units` | `systemctl --failed --no-legend --plain`                                                                                                                                     | the units that failed                                                    |
| `sockets`      | `systemctl list-sockets --all --no-legend --plain`                                                                                                                           | the socket units                                                         |
| `listeners`    | `ss --listening --numeric --tcp --udp --unix --no-header`                                                                                                                    | what listens                                                             |
| `pressure`     | `/proc/pressure/{cpu,memory,io}`, `/proc/meminfo`, `/proc/loadavg` and the total CPU line of `/proc/stat`                                                                    | stalls, memory and load                                                  |
| `pool`         | `lvs --reportformat json -o lv_name,lv_attr,data_percent,metadata_percent pgcf/pgcf_thinpool`                                                                                | the thin pool's data and metadata fill                                   |

`journal` and `kernel` answer with `entries`, every other probe with `text`. `status` is `failed`
when a command ended with a status other than 0, did not end in 30 seconds, or a file could not
be read; `text` then holds the status and what the command printed, but of `journal` and `kernel`
only the status and stderr, never the lines they printed before they failed (a node that has not
rebooted answers `journal` or `kernel` with `boot` -1 as failed: `No journal boot entry found`;
a damaged journal file fails them with `Failed to iterate through journal`).

- **Loopback only.** `listeners` shows TCP listeners on loopback only (the gateway and
  cloudflared's metrics) and Unix sockets. A TCP or UDP socket on another address is an incident.
  `/run/ssh-unix-local/socket` must not be listed there, nor `sshd-unix-local` or `sshd-vsock` in
  `sockets`: the image masks the ssh generator that would bind sshd to them.
- **Volumes.** A database's volume is mounted in the agent's own mount namespace and in its
  unit's, never in PID 1's: from a shell `findmnt`, `df`, `fstrim`, `resize2fs` and `ls
  /var/lib/pgcf/db/<id>` see no volume. Run a command in the agent's namespace with `nsenter
  --target "$(systemctl show --property=MainPID --value pgcf-agent.service)" --mount -- <command>`,
  and `pgcf-agent check` the same way (it refuses to run in PID 1's namespace). `e2fsck` refuses a
  volume that a unit or a job still holds open, and so does `lvremove`; the agent's own unmount
  mounts the volume again and answers `Busy` while one holds it, and after an agent restart, which
  ends the agent's own mounts, it answers `Busy` for a volume that only a unit holds, and refuses
  to make or mount the next generation of that database (`OtherGeneration`). Never write into the
  volume of a database that runs.
- **Limits.** A node sends a result of at most 1 MiB, or a boot report of at most 1 MiB, and the
  oldest entries, or the end of a text (marked `[truncated]`), go first. The API stores at most 64
  KiB of either, measured as the `INSERT` statement that a backup of the control database writes
  for the row (D1 cannot import a statement above 100,000 bytes, so a larger row would make every
  later backup impossible to restore): what does not fit is cut again, the oldest entries first
  (a text keeps its beginning), and the stored `body` of a probe or `report` of a boot report then
  says `"truncated": true` and `"dropped_entries"`, the number of entries left out (0 when only the
  end of a text was cut). What was left out cannot be read through a probe: `journal` answers with
  the newest `lines` entries of the last `since_seconds` seconds of the boot, `kernel` with the
  newest `lines` of the boot, and the other probes with a text that ignores both numbers, and a
  probe has no upper time bound. A request with fewer `lines` or a shorter `since_seconds` therefore
  returns a subset of the entries the API kept, never the older ones it dropped; it only makes the
  answer fit whole, and a report or result that fits has neither field. The lines of a database's unit (`pgcf-pg@…`) or of a backup job
  (`pgcf-job-…`), and the lines PID 1 writes about them, are never sent; in a text, every line
  that names one is left out. A kernel line that names a database's cgroup, such as an out of
  memory kill, is kept: it holds the database's identifier and nothing of its data. A node's page
  lists at most eight open requests at a time, the oldest first; later ones wait behind them and
  may expire unanswered. The agent runs each once and keeps the identifiers of the last 64.
- **Audit.** The row of the request (`node_diagnostic_requests`) holds the key that asked and
  the time; the agent logs `probe_answered` with the probe's name. Requests and results are kept
  for 30 days, and deleted by the next request for a probe after that.

## Control plane

Keep a D1 export, the deployment source, private Worker binding configuration and Worker secret
values (including the R2 parent key and the routing keyrings) together in an encrypted operator
backup. Cloudflare cannot return previously issued secret values. Keep the decryption key outside
the repository and an independent copy outside the machine that created it.

After control loss, restore the export into a separate D1 database, check SQLite integrity and
foreign keys, and verify region, node and credential identity before switching Worker bindings.
A node's key lives on the node and its public key in D1, so a restored D1 recognises the nodes
without a reinstall; restore the secret values unchanged. If nodes were lost as well, recover
PostgreSQL through R2 into separate targets. Validate SQL and routing before opening traffic.

Open a daily D1 artifact with the
[restore drill](infrastructure-backups.md#restore-drill): `scripts/operations/restore-infrastructure-backup.ts`
verifies and decrypts it with the offline keyring and imports it into a new, empty D1 database.
Use the same command for the separate D1 database this section calls for; switching the Worker
bindings stays a separate step that needs the operator's explicit authorization. The drill has
passed on the nightly artifact of 2026-10-21 (24 chunks, no foreign key violation, the counts of the
live database).

A restored export is the control database as it was when the export was taken: every write since is
gone, including databases created, deletions, resizes, storage generations, API keys, approvals,
enrollments and usage. It is for control loss, not for undoing a migration; the rollback of a
migration is a forward migration
([migration `0082`](infrastructure-backups.md#rolling-back-below-migration-0082)).

## Integrator migration

Operator acceptance and customer migration are separate; moving existing databases from another
provider is the integrator's task. Keep the source databases in service until a reviewed
per-database cutover is accepted. Inventory roles, extensions, data/sequences, clients/pooling and
capacity in the integrator's repository, then stop source writes for the actual transfer. Verify
target contents, nonsuperuser roles and TLS through Cloudflare, plus a completed target base backup
and archived WAL, before changing application connections. Retain the source through acceptance;
after target writes, a rollback must reconcile them rather than point clients at stale data. Keep
adapter changes and customer prices outside this generic service.

## Thin storage admission and recovery

Every database lives on its own thin LVM volume of the node's one thin pool (plan 4.3). The pool is
created at full size at first boot and does not grow.

- **Room.** A node refuses a create, restore, wake and start when its own room rule fails: a pool
  sample no older than the policy's `sample_max_age_seconds`, free data of at least the policy's
  `reserve_bytes` and metadata below `metadata_no_room_percent`. The refusal is `57P03` with the
  DETAIL "storage"; running databases keep running. Cloudflare places no new database or restore on
  a node whose pool is at 80 % of its data or 50 % of its metadata, whose sold storage reached
  four times its data (counting the smallest size class on offer as sold), or that holds 1,000
  volumes, the largest count Stage 1 measured (`regional_node_pool_closed`, which fires when
  no node of the region takes the smallest size class, for the pool, the RAM or the CPU; the bound counts sleeping databases too and is no policy field: only
  a measurement at a higher count raises it). Sold sizes do not reserve space. `thin_storage_blocked` fires when the pool has no room. Free space by deleting
  databases on the node.
- **A full pool.** Writes fail at once (`--errorwhenfull y`) and no commit is acknowledged without
  durable WAL. ext4 on the affected volumes then aborts its journal and remounts read-only, so
  those databases stop. Once space is back above the reserve, the agent recovers each affected
  database itself: it stops the unit, unmounts the volume, repairs it with `e2fsck -p`, mounts it
  again and wakes the database through admission; PostgreSQL runs crash recovery from its durable
  WAL, and every acknowledged commit survives. A volume it cannot repair (`e2fsck` refuses) needs an
  operator. Running writers are never stopped for storage.
- **A full volume.** A tenant can fill its own volume by reaching its size, by using up its inodes
  or by keeping WAL during an R2 outage. The agent reports each volume's space and inodes every 60
  seconds, and `database_volume_warning` (80 %) and `database_volume_critical` (90 %) fire. Raise the
  size with `PUT /v1/databases/{id}/resources` (storage only grows) or have the integrator free
  space. When a volume is full PostgreSQL stops on the failed WAL write, and crash recovery itself
  must write: the agent frees the filesystem's 1 % root-only reserve once so that recovery can
  finish and the integrator can delete data or resize; a database that still cannot start needs its
  size raised. Nothing extends a volume by itself.

Thin physical allocation metrics stay null until a real measurement exists; neither a logical
quota nor zero stands in for an unknown measurement. The agent's full-pool and full-volume recovery
is tested against lab volumes; the live test (Stage 5.5 of the ULTRA plan) has not run yet.

## The thin pool does not activate

A node that was reset hard (a power cut, a Contabo `stop`, a host failure) can come back with its
thin pool `pgcf/pgcf_thinpool` inactive and every database on it down. lvm2 runs `thin_check -q` on
the pool's metadata when it activates the pool and refuses the pool when the check ends with a
status other than 0. EU1 was down for 27 minutes in this state (2026-10-23): one leaked data block,
`thin_check` status 64, `vgchange --activate y pgcf` status 5, and the agent restarted 798 times.

**What the agent repairs by itself.** A leaked block is a data block that the space map counts as
used and no mapping uses: free space lost, no data lost. When `vgchange` is refused, the agent
(`Storage::open`)

1. deactivates a part of the pool that is active on its own (`pgcf_thinpool_tmeta` or
   `pgcf_thinpool_tdata`, which an inspection leaves active and which keeps lvm2 from activating
   the pool) and activates again; the event is `thin_pool_parts_released`;
2. otherwise, or when that activation is refused too, activates once more with `--auto-repair`
   added to the check options the host has (`thin_check_options=["-q","--auto-repair"]`); the
   event is `thin_pool_repair_activation`.

`thin_check --auto-repair` is documented as "automatically repair any trivial issues found with the
metadata, currently only fixes metadata leaks": it rewrites the data space map after it read the
mapping trees without an error. When a tree or a checksum is wrong it writes nothing (lab: the
metadata is the same bytes afterwards) and the activation is refused as before. The agent never runs
`thin_repair` or `lvconvert --repair`: what becomes of a pool whose trees are wrong is the
operator's decision.

**Recognising the case the agent does not repair.** All of these hold:

- the node's journal (`journalctl -u pgcf-agent`, or the boot report once the node links again)
  says `agent_failed` with the class `vgchange_exit_5`, and the agent starts again about every six
  seconds (a start that fails waits five seconds before it ends, so that a node does not run the
  failing commands ten times a second; `systemctl show -p NRestarts pgcf-agent` keeps rising);
- the node is stale: `regional_node_stale` fires, its newest sample in
  `/v1/operational-health?scope=nodes` is older than 180 seconds, and its region is no longer
  listed to integrators as accepting placement;
- `lvs -a -o lv_name,lv_attr pgcf` shows the pool inactive (`twi---tz--`, no `a` in the fifth
  place), and no database is running;
- `thin_check` of the pool's metadata (below) ends with 64 and a message about a tree or a
  checksum, for example `mapping top-level: node error: checksum error`. Status 64 alone cannot
  tell a leak from damage: thin-provisioning-tools 1.1.0 ends with 64 for every error, also for an
  input that does not exist. Read the text. "N data blocks have leaked" and "data space map
  contains leaks" are the leak the agent repairs; anything else is damage.

**What to do.** Through the operator shell, which is off by default:

1. **Stop the agent first**, and only the agent: `systemctl stop pgcf-agent`. Leave
   `pgcf-mounts.service` running; it holds the volumes' mount namespace and stopping it unmounts
   them. Every start of the agent deactivates a part of the pool that it finds active and tries to
   activate the pool, so a running agent takes away the device an inspection is reading, and on
   damaged metadata repeats an activation that is refused. Do this before any inspection or repair,
   and do not start the agent again until step 4 passes.
2. Read the metadata without changing it. The component is activated read-only on its own, and
   must be deactivated again before anything activates the pool: a part left active makes
   `vgchange` refuse with "Activation of logical volume ... is prohibited while logical volume
   ..._tmeta is active".

   ```sh
   lvchange --activate y --yes pgcf/pgcf_thinpool_tmeta
   thin_check /dev/mapper/pgcf-pgcf_thinpool_tmeta; echo "status $?"
   lvchange --activate n pgcf/pgcf_thinpool_tmeta
   ```

3. A leak only: activate the pool as the agent would,
   `vgchange --activate y --config 'global{thin_check_options=["-q","--auto-repair"]}' pgcf`.
   Damage: stop here. Do not activate, repair or write; nothing on the node repairs a pool whose
   trees are wrong, and the databases of the node are restored from their R2 archives to another
   node, as for a [lost node](#lost-node) (which is declared by the operator, never from staleness
   alone).
4. Validate before the agent starts again: the pool is active (`lvs -a -o lv_name,lv_attr pgcf`
   shows `twi-aotz--` and the volumes `Vwi-a-tz--`), and a plain deactivation and activation
   (`vgchange --activate n pgcf`, then `vgchange --activate y pgcf`) both end with 0, which is
   lvm2's own `thin_check -q` passing without the repair option.
5. `systemctl start pgcf-agent`. The agent says `agent_started`, the node reports again within a
   minute, `regional_node_stale` clears and the region is listed again. The databases that ran when
   the node was reset are unproven (plan 7.10): the agent starts each one, lets PostgreSQL recover
   from its WAL and puts it to sleep with a proof, which for many of them at once waits on the WAL
   uploads (2026-10-23: 68 databases, until about 13:30), and a wake of a database that is not
   proven yet is refused with `unproven` until then.

## Node maintenance cycle

The cycle installs the packages that a release pins (a newer Debian snapshot, a kernel update) on
one node and reboots it if needed (plan 9.3). Run it one node at a time, in an announced window,
with the owner's go for a reboot. Starting a cycle requires an `admin` API key; an `admin_read` key reads its state.

1. Register the release (`PUT /v1/fleet/releases/{id}`) and assign it to the node's region
   (`PUT /v1/regions/{id}/release`). Wait until `GET /v1/nodes/{id}/release` says `converged`:
   the node installs the packages with the agent of the release, and the route refuses a node
   that runs another release with 409.
2. Verify the node's UID, then submit `POST /v1/nodes/{id}/maintenance` with a persistent
   `Idempotency-Key` and `{"expected_node_uid":"<verified UID>"}`. It answers 202 with the
   operation and a `Location`. Placement on the node is closed, and the node holds new wakes
   with `57P03`, puts every awake database to sleep with the proof, installs the packages of the
   lock and reboots if the kernel or core libraries changed (the release's host files are not
   part of the cycle: they are written when the release is assigned, users and directories
   included, [changing a unit without a new image](operator-installation.md#changing-a-unit-or-a-configuration-file-no-new-image)).
   It purges the installed packages the
   lock no longer names (never a kernel image, an essential or protected package) when nothing
   needs a reboot, or, after a reboot, in the cycle it runs for the open order once it is up; then
   it runs its check and reports. Repeating the request while the cycle is open returns the same
   operation. Until the cycle ends the capacity cron buys no node in the region at all, whatever
   the shortage: `GET /v1/regions/{id}/capacity-decision` says `maintenance`. A `failed` cycle
   leaves placement closed and the cron buys again, as it does for any closed node.
3. Poll `GET /v1/nodes/{id}/maintenance/{operation}`. `open` becomes `done` or `failed`; a
   `failed` cycle names the class of the failure in `result_reason` (such as `power_busy` or
   `power_archive` for a database that did not sleep with the proof, `release_missing`,
   `release_signature_missing` or `release_signature_invalid` for a release the node does not trust
   (its agent checks the release key's signature before it reads the lock and reports the event
   `release_refused`; [release-signing.md](release-signing.md)), `signature_not_read`,
   `lock_not_read`, `packages_not_read`, `packages_not_installed`, `reboot_failed` or
   `check_failed`; `packages_not_installed` also names a purge that dpkg refused).
4. `done` reopens placement, if this cycle closed it (`placement_closed_at` is not null). A
   placement that an operator closed before or during the cycle stays closed: open it with
   `PUT /v1/nodes/{id}/database-placement`. Either way the API hints the node when it records
   the result, and the node serves wakes again as soon as it has pulled its page; if the hint is
   lost, at its next full pull, within 60 s.
5. After `failed`, placement stays closed and the node serves wakes again; its databases are
   asleep. Read the node's events and logs, fix the cause, and submit the request again with a
   new key: the new cycle takes over the closure the failed one left, so that its `done`
   reopens placement.

A lost or fenced node is refused with 409. A node that loses its link in the middle of the cycle
keeps the order open until its agent answers after the reboot; staleness alone never declares it
lost (plan 9.4). Debian keeps the previous kernel; a bad kernel is recovered from the boot menu
over VNC or with a one-shot GRUB entry (plan 9.3).

## The agent does not come back after a release

A node that took a release and then stops reporting (no sample, no link, wakes not answered) may
have an agent that cannot start. Nothing on the node restarts it for good: `pgcf-agent.service`
has `Restart=always`, `RestartSec=100ms` and `StartLimitIntervalSec=0`, so systemd starts it again
100 ms after it ended (a start that fails waits five seconds in the agent first), and with no agent
there is no link, no wake and no WAL archiving (the archive socket is the agent's).
Two causes are known, and both are a release that broke a rule of the
[node image README](../../infra/node-image/README.md#changing-a-unit-or-a-configuration-file-without-a-new-image):
the new `pgcf-agent.service` cannot start (a path, a user, a directory, a package of the new lock
that the maintenance cycle has not installed yet), or the new binary needs a unit it has not got
(the binary is switched first and starts under the unit of the release before).

1. Look at the node first ([below](#looking-at-a-node)) and confirm that the newest sample is old
   and the node is not lost: a node that is merely slow is not this. Do not mark it lost.
2. The agent's new unit is not in `/usr/lib/systemd/system` yet: the agent writes it to
   `/run/systemd/system` and moves it to its place only after the agent that runs it has read its
   first page. So the unit of the image is the last good one, and a restart restores it. With the
   operator shell on (it is off by default): `rm -f /run/systemd/system/pgcf-agent.service`,
   `systemctl daemon-reload`, `systemctl restart pgcf-agent`.
3. Without a shell, restart the instance from the Contabo panel or its API: a restart, never a
   reinstall (the volumes stay). A boot empties `/run`, so the node runs the unit of the image.
4. The restarted agent reads the page of the region's release, which is the one that broke the
   node, and writes the new unit to `/run` again. Before the restart, assign the region the
   release it had before (`PUT /v1/regions/{id}/release`), so that the page the agent reads is
   that release's: the agent installs its binaries and writes its files, and the node is back on
   what it had. A release that could not start must not stay assigned.
5. Fix the release (a unit that starts under the previous one, or two releases) and register it
   again; check `GET /v1/nodes/{id}` for `os_converged` and the event `agent_unit_promoted`.
