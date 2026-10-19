# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2; the last recoverable commit depends on the WAL that actually reached R2. There is no
synchronous replica or zero-loss promise. Record both recovery duration and the last restored
commit in the ULTRA plan after each real drill.

The operator topology is EU only: customer EU1 (6 vCPU, 12 GB RAM), as recorded in the canonical
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md). The Kubernetes
runtime was retired on 2026-10-17; no node executes databases until the Debian node runtime of
the plan is installed. Never order a replacement node without the owner's explicit, costed go.

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
   region's bucket, endpoint and archive path; its configuration revision is independent of its
   storage generation. Source backup/WAL selection still uses the source region's catalog and
   bucket, including when the source has been deleted.
5. Ready requires recovery promotion, SQL database-name mapping, actual role/settings and volume
   checks, and removal of the temporary restore administrator. Authenticate to the target over
   the normal endpoint and compare the required tables, roles, sequences and committed markers.
   Confirm promotion by writing a new target marker, then obtain a completed base backup and
   archived WAL in the target's own archive. Source credentials must not write those objects.
6. Switch the adopter's connection only after these checks. Once writes reach the target, do not
   switch back to an older source without reconciling those writes.

A deleted source can be restored within its configured retention window. Keep its encrypted
credentials and the corresponding `CREDENTIAL_KEYS` key IDs until that window ends. Expired
archive cleanup is bounded and uses only the exact owned prefix; do not modify archive timestamps
to simulate expiration.

The v1 catalog is limited to 16 pages, 16,000 objects, 64 backup metadata files and 64 KiB per
metadata file. A newer WAL timeline needs a completed base backup on that timeline. Unsupported,
missing or ambiguous coverage is refused rather than creating an empty database.

## Lost node

Node-loss and node-addition endpoints require an `admin` API key (an `admin_read` key reads them and
changes nothing).

1. Read `/v1/operational-health?scope=nodes` and verify the actual node UID. A stale heartbeat
   excludes placement after 180 seconds; it does not automatically authorize a replacement order.
2. Submit `POST /v1/nodes/{id}/mark-lost` with
   `{"expected_node_uid":"<verified UID>","reason":"<short incident description>"}`.
   Loss is terminal and repeated calls preserve the original record. Metadata, archives and
   historical provider receipts remain available. Heartbeats cannot make the node healthy again.
3. Restore affected databases onto available healthy capacity using the separate-target restore
   procedure above. An established database on a lost node must report recovery required.
4. Reinstalling a node uses AddNode in recover mode with the pull installer
   ([plan 9.2](../architecture/cloudflare-convergence-and-serverless-plan.md#92-installing-a-node-on-contabo-no-relay-no-ssh)
   and [9.4](../architecture/cloudflare-convergence-and-serverless-plan.md#94-node-loss-and-recovery)),
   which is built in Stage 3. Until then, recover databases by restore.

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
- **Limits.** A result is at most 1 MiB; the oldest entries, or the end of a text (marked
  `[truncated]`), go first. The lines of a database's unit (`pgcf-pg@…`) or of a backup job
  (`pgcf-job-…`), and the lines PID 1 writes about them, are never sent; in a text, every line
  that names one is left out. A kernel line that names a database's cgroup, such as an out of
  memory kill, is kept: it holds the database's identifier and nothing of its data. A node's page
  lists at most eight open requests at a time, the oldest first; later ones wait behind them and
  may expire unanswered. The agent runs each once and keeps the identifiers of the last 64.
- **Audit.** The row of the request (`node_diagnostic_requests`) holds the key that asked and
  the time; the agent logs `probe_answered` with the probe's name. Requests and results are kept
  for 30 days, and deleted by the next request for a probe after that.

## Control plane

Keep a D1 export, the deployment source, private Worker binding configuration, Worker secret
values, agent credentials and routing keyrings together in an encrypted operator backup.
Cloudflare cannot return previously issued secret values. Keep the decryption key outside the
repository and an independent copy outside the machine that created it.

After control loss, restore the export into a separate D1 database, check SQLite integrity and
foreign keys, and verify region/node/credential identity before switching Worker bindings.
Restore secret values without replacing the retained agent identity. Recover PostgreSQL through
R2 into separate targets. Validate SQL and routing before opening traffic.

Restoring a daily D1 export into a scratch D1 database is open as go-live gate G6 of the ULTRA
plan; the daily artifacts have so far only been read back.

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

Thin storage is enabled per node. Existing thick volumes keep their backend and data. A thin
volume keeps its class, Node UID, volume-group UUID and pool UUID; logical quota growth is
forward-only within the configured finite maximum.

- Room: the node refuses a create, restore, wake and start when its pool has no room (its own room
  rule: a pool sample at most 10 s old, free data at least the reserve, metadata below 75 %).
  Cloudflare places no new database or restore on a node whose pool is at 80 % of its data or 50 %
  of its metadata, or whose sold storage reached four times its data. Logical quota totals do not
  reserve extents. `thin_storage_blocked` fires when the pool has no room. The pool does not grow.
- A full pool fails writes at once (`--errorwhenfull y`). PostgreSQL then stops with PANIC and no
  commit is acknowledged without durable WAL. Free pool space by deleting databases on the node;
  the next start recovers from WAL.
  Running writers are never stopped for storage.

Thin physical allocation metrics stay null until a real measurement exists; neither a logical
quota nor zero stands in for an unknown measurement. The node agent's full-pool and full-volume
recovery ([plan 4.3](../architecture/cloudflare-convergence-and-serverless-plan.md#43-disk-thin-lvm))
is built in Stage 3.

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
   lock and reboots if the kernel or core libraries changed. It purges the installed packages the
   lock no longer names (never a kernel image, an essential or protected package) when nothing
   needs a reboot, or, after a reboot, in the cycle it runs for the open order once it is up; then
   it runs its check and reports. Repeating the request while the cycle is open returns the same
   operation. Until the cycle ends the capacity cron buys no node in the region at all, whatever
   the shortage: `GET /v1/regions/{id}/capacity-decision` says `maintenance`. A `failed` cycle
   leaves placement closed and the cron buys again, as it does for any closed node.
3. Poll `GET /v1/nodes/{id}/maintenance/{operation}`. `open` becomes `done` or `failed`; a
   `failed` cycle names the class of the failure in `result_reason` (such as `power_busy` or
   `power_archive` for a database that did not sleep with the proof, `release_missing`,
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
