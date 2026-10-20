# Node agent

`pgcf-agent` is the only local actor on a PGCF node: one Rust binary, built from the library crate
`pgcf-node-agent`, that runs as root beside the gateway and the Tunnel on the Debian node image
([ULTRA plan](../../docs/architecture/cloudflare-convergence-and-serverless-plan.md) 5.6). It
executes the desired state Cloudflare publishes for its node and reports what it finds. The image,
its units and its release registration are described in
[infra/node-image](../../infra/node-image/README.md); this file describes the agent. Unit tests
do not replace the live acceptance recorded in the plan.

## What it decides alone

The node decides three things from local facts, under rules Cloudflare sets in the region's node
policy, and reports each decision (plan 1.6, 5.2):

- **Wake admission** (`admission.rs`, plan 4.6, 4.7). Every start of a PostgreSQL unit goes through
  one serialized loop: wakes, creates, restores and their replay, move targets, recovery starts and
  the health check. A start of a database of _m_ MiB needs three things: the pool has room (a pool
  sample no older than the policy's `sample_max_age_seconds`), the memory rule holds (`measured`:
  `MemAvailable` minus every start in flight minus the floor is at least _m_; `reserved`: the
  reservations of the awake and starting databases plus _m_ and the overhead stay within the awake
  budget), and fewer than `start_concurrency` starts are in flight. Otherwise the start waits in a
  strict FIFO queue for `queue_wait_ms` and is then refused with `57P03` and the policy's retry
  hint. systemd never restarts a database by itself, so no start bypasses these rules.
- **Early sleep.** Only if the policy enables it, and only while a start waits for memory, the node
  puts one idle but awake database to sleep per waiting start, with the normal sleep proof.
- **Recovery starts.** A database that stopped without a proof is started through admission and
  proven again (below).

Cloudflare sets the policy with `PUT /v1/regions/{id}/node-policy`: the admission rule, floor,
awake budget and queue, the CPU burst after a wake, early sleep, the pool reserve, the backup
concurrency and memory limits, and the write limits of a 256 MiB database. Every node's desired page
carries it, and a region whose policy is not set serves no page.

## Commands

| Command            | What it does                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pgcf-agent run`   | The service of `pgcf-agent.service` (`Type=notify`). It opens the node's storage, restores what a boot lost, signals `READY=1`, then enrolls and links to Cloudflare in the background, so a node that is not enrolled yet waits instead of crashing                    |
| `pgcf-agent check` | Makes or wakes one scratch database (`SCRATCH`) on a thin volume, queries it over its socket and stops it, without Cloudflare. The image's boot test runs it after the first boot and again after a reboot, and a maintenance cycle runs it before it answers its order |

An agent restart never stops a database: the databases are units of their own, and the agent finds
them again from the running units. A release that changes the agent's own binary makes it exit so
that systemd starts the new one.

## Jobs and where they live

| Job (plan 5.6)             | Code                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Link to Cloudflare         | `link/`, `node_link.rs`: enrollment, the signed requests, the NodeActor WebSocket, the outbox                                                          |
| Admission                  | `admission.rs`                                                                                                                                         |
| Storage                    | `storage/`: the volume group and thin pool, one thin volume with its ext4 per database, the samples, the room rule, full-pool and full-volume recovery |
| Units                      | `units/`: `pgcf-pg@<id>.service` over systemd's D-Bus API, limits as unit properties, the Linux users                                                  |
| Database lifecycle         | `agent/`: `apply.rs` (the page becomes action), `build.rs` (create, restore, move target, resize, delete), `power.rs` (wake, sleep, recovery)          |
| Sleep proof and its record | `proof.rs`, `sleep.rs`, `pg_control.rs`, `state.rs`                                                                                                    |
| Roles                      | `roles.rs`, `scram.rs`: PostgreSQL holds exactly the roles of the page, with verifiers, never passwords                                                |
| Backups                    | `archive/`: the archive socket, the barman-cloud jobs, restore and PITR recovery, the upload log                                                       |
| Fencing                    | `fence.rs`                                                                                                                                             |
| Gateway channel            | `gateway.rs`: the writer table, the wakes, quiesce, close, status and activity                                                                         |
| Metrics and diagnostics    | `usage.rs`, `sample.rs`, `events.rs`, `diagnostics/`                                                                                       |
| Cold page cache            | `prefetch.rs`: readahead of the catalog set and the autoprewarm list with its own accounting; `cache.rs`: how files of the data directory are opened and counted |
| Updates                    | `update.rs`, `release.rs`                                                                                                                              |
| The loops                  | `service.rs`: what feeds the core and what it feeds                                                                                                    |

`machine.rs` is the seam to the machine: the Linux users, the thin volumes, the systemd units,
`initdb` and the kernel's memory figures. The flows are written against that trait; `machine/node.rs`
is the node itself and `machine/local.rs` stands in for systemd and LVM only, under a real
PostgreSQL 18.

One database has one flow at a time (a create, a wake, a sleep, a recovery or a delete finishes
before the next begins). What the gateway and the observations read is the database's view, which
every flow updates in small steps.

## What the agent keeps

| Where                                          | What                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/var/lib/pgcf/db/<id>`                        | The database's volume, mounted 0700 for `pgcf-<id>`; the data directory is `data`                                                                                                                           |
| `/var/lib/pgcf/agent/databases/<id>`           | The database's state file (proven-sleep record, roles applied, newest base backup, whether the storage generation was built) and its upload log; not on the volume, which the database's user can rearrange |
| `/var/lib/pgcf/agent/uids.json`, `fences.json` | The uid handed to each database, and the fence and superseded orders, fsynced before the agent acts on them                                                                                                 |
| `/var/lib/pgcf/agent/usage.json`, `jobs/`      | The usage meter's place, and the barman jobs' environment files                                                                                                                                             |
| `/var/lib/pgcf/agent/boot-id`, `probes-done`   | The boot ID the agent last reported (a different kernel boot ID is a reboot, and the previous boot's journal goes to Cloudflare), and the diagnostic requests it has answered, so that a page that still lists one does not run it twice |
| `/var/lib/pgcf/credentials/`                   | The node's Ed25519 key (`node-key.pk8`, readable by the agent only) and identity, the gateway's environment, the encrypted Tunnel token                                                                     |
| `/var/lib/pgcf/enrollment/seed.json`           | The installer's seed, deleted after the enrollment                                                                                                                                                          |
| `/var/lib/pgcf/bin/<release>/`, `bin/current`  | The binaries of each release and the link to the one that runs                                                                                                                                              |
| `/run/pgcf/<id>`                               | The database's socket directory (`pgcf-<id>:pgcf-gateway`, 0750), made again for every database when the agent starts                                                                                       |
| `/run/pgcf/agent/gateway.sock`, `archive.sock` | The gateway's channel (the gateway's user only) and the archive socket (the databases, known by uid)                                                                                                        |

`layout.rs` names the volumes, the agent's own directory, the databases' files, the jobs and the
sockets, and tests give it another root. The rest are named where they are used: `credentials/`,
`enrollment/seed.json` and `node-key.pk8` in `link/identity.rs` and `link/file.rs` (and
`machine/node.rs`, which writes the gateway's environment and the Tunnel token there), `usage.json`
in `agent/mod.rs`, `bin/current` in `update.rs`, `main.rs` and `machine/node.rs` (and in the image's
`pgcf-agent.service` and `pgcf-gateway.service`), `boot-id` in `diagnostics/boot_report.rs` and
`probes-done` in `service.rs`.

## PostgreSQL configuration

The agent writes `postgresql.conf`, `pg_hba.conf` and `pg_ident.conf` before every start and owns
all three (`settings.rs`); a restored database's files are the source's and are replaced first.

- **No network.** `listen_addresses` is empty and the socket directory is `/run/pgcf/<id>`.
- **Memory** follows the database's memory size _m_ in MiB: `shared_buffers` _m_/8, `effective_cache_size`
  3/4 of _m_, `work_mem` 2 MB up to 512 MiB, 4 MB up to 2 GiB and 8 MB above, `maintenance_work_mem`
  _m_/16 and at least 16 MB. For 256 MiB that is 32, 192, 2 and 16 MB; for 1 GiB, 128, 768, 4 and
  64 MB. `shared_buffers` stays small because shared memory cannot be reclaimed without swap; the
  page cache does the caching. `huge_pages` and `jit` are off.
- **From the size class:** `max_connections` and `archive_timeout`. `archive_mode` is on with
  `/usr/libexec/pgcf/pgcf-archive %p`, `wal_level` is `replica`, `wal_init_zero` is off,
  `wal_recycle` on, `min_wal_size` 32 MB, `max_wal_size` a quarter of the volume (at least 64 MiB),
  and crash recovery syncs the filesystem once (`recovery_init_sync_method = syncfs`).
- **Small databases** (512 MiB and below) run one autovacuum worker out of two slots, one I/O
  worker, no parallel query or maintenance workers, four background worker slots and no replication.
  A restore runs with more during its recovery, because a recovery checks these values against its
  source's.
- **Autoprewarm** runs in every database (`shared_preload_libraries = 'pg_prewarm'`,
  `pg_prewarm.autoprewarm = on`, `autoprewarm_interval = 0`): the list of the shared buffers is
  written at each clean stop only, so a running database pays nothing, and read again in the
  background after the next start, where it competes with the first queries for the disk. Two of
  the worker slots are its leader and its worker; the sleep guard does not count its worker as a
  session.
- **Readahead** (`prefetch.rs`, built, not called by any flow yet). Before a request the agent can
  ask the kernel to read a sleeping database's hot files ahead with `posix_fadvise(WILLNEED)`:
  the catalog set (`pg_control`, 256 KiB of WAL at the latest checkpoint, `global/`, and in each
  user database its `PG_VERSION`, `pg_filenode.map` and the login's catalogs with their indexes
  and forks; about 5 MB) and the autoprewarm list (blocks merged where contiguous, the relations
  with the fewest listed blocks first, system databases left out). The mapped catalogs
  (`pg_class`, `pg_attribute`, `pg_proc`, `pg_type` and their indexes) are found through the map
  where `VACUUM FULL` moved them; the others are read at their OID, so a rewrite of one drops it
  from the set, and the report's `missing` counts it. A plan is built first (blocking:
  directories, `pg_control`, the maps and the list are read, each file is opened once for its
  length), then issued in pieces of at most 128 KiB, because the kernel reads only the first
  `read_ahead_kb` of a range per call. The data directory is the database user's, so a plan reads
  only the real directories of `base/` (at most 32 databases) whatever the list names, stops after
  512 files of a list that are not there, and stops at a budget and a cancel as the issuing does.
  Issuing stops at a time budget, a byte bound or a cancel and returns the counts, the bytes the
  cache already held and the timings; they take the place of the residency diagnostic that
  `cache.rs` made while a wake ran (deleted) once a flow calls it. `pg_internal.init` is left out:
  PostgreSQL removes it at every start.
- **Login.** The node's root reaches the cluster's superuser `postgres` by peer authentication
  through `pg_ident.conf`; the backup role `pgcf_backup` is reached by the database's own Linux user
  the same way; every other role logs in over the socket with SCRAM-SHA-256. Replication connections
  match no rule.

## Enrollment and the link

The installer leaves a seed (node ID, region, API origin and a one-time enrollment token). At first
start the agent generates its Ed25519 key, enrolls with the token and its public key, and signs every
later request with that key, which binds the method, the path and the body. A reinstall is a new
node with a new key, and Cloudflare restricts the key of a node declared lost to the fenced scope.
The agent keeps the outbound WebSocket to the node's NodeActor, which carries its sample every 15 s
and Cloudflare's request to pull the desired page; it also pulls the whole page every 60 s. It reads
the gateway's keyring and the Tunnel token from `GET /node/v1/credentials` when it starts, and again
when the page names a higher credentials revision, and R2 temporary credentials from
`GET /node/v1/archive-credentials/{id}` as the page names them. A node never holds the R2 parent key.

The agent reads what Cloudflare sends it (the page, the credentials, the answers, the link's
messages and the enrollment seed) with every object open: a property it does not name is ignored,
so that the API can send one before every node knows it. It still refuses a page whole for a missing
property, a wrong type, a number out of bound, a value outside a closed set (an enum, a kind of
origin or host file) and an order of a type it does not read (`link/desired.rs`, event
`desired_pull_failed`, class `cloudflare_desired_page_has_an_order_this_agent_does_not_know`):
nothing of that page is applied. A new property of the page is optional with a default
(`cpu_boost_ms` is 0 when left out). What the agent sends stays closed to the contract. The rule
for changing the page, with the order of releases by kind of change and direction, is the table in
plan 9.3, "Changing the page"; it is written there once.

## A wake, a sleep and a recovery

- **Wake.** The gateway holds the client's startup and sends the agent the wake before it answers
  the upgrade. The agent checks the ticket against its page and volume, reads `pg_control` and
  compares it with the proven-sleep record, passes admission, starts the unit and waits for the job
  that ends at `READY=1`. It hands the gateway the unit's socket, uid, main PID and invocation ID in
  the writer table, applies the database's CPU quota `cpu_boost_ms` after the release (at once when
  that is 0; a build and a restart of the agent apply it at once, and a base backup that begins
  inside the burst applies it first) and reports the phases of the wake as events; about 2 s later
  a `wake_detail` event adds the split of the start, the CPU quota's throttling and the steal time.
  A wake it already serves is answered
  `wake_in_progress`, which is no result.
- **Sleep.** After the database's idle time the agent runs the sleep proof (plan 7.9): the gateway
  quiesces and closes idle sessions, the guard refuses while a session is busy or a transaction is
  prepared (`power_busy`), a checkpoint and a WAL switch close the last segment, the upload log must
  hold it and every segment before it, and only then the postmaster stops with a fast shutdown.
  `pg_control` must then say shut down, with the recorded identity and a checkpoint after the
  switched segment, and the record is written and fsynced before the sleep is reported. A refused
  proof leaves the database running and wakeable. After a clean sleep the agent trims the volume.
- **Recovery.** At boot, after a failed proof and after an unexpected stop, a database without a
  matching record is unproven: the agent starts it through admission, lets it archive and proves its
  sleep, retrying until it holds. Nothing is replayed to a client.
- **Create.** User, volume, filesystem, `initdb`, configuration, a check that the database's R2
  prefix is empty, the roles and the first base backup. The database is ready only when that backup
  is DONE. A create that a restart interrupted resumes when every backup in the archive belongs to the
  cluster on the volume.
- **Restore and move target.** `barman-cloud-restore` as the new database's user, recovery through
  the archive socket (`pgcf-recovery.conf`, included by `postgresql.conf` and removed afterwards),
  promotion on a later timeline with the backup's system identifier, then the first base backup of
  the new timeline. A move target replays through the segment named in the source's proven-sleep
  record before it may promote.

## Backups

PostgreSQL's `archive_command` and `restore_command` reach the agent through the archive clients
([apps/pgcf-archive](../pgcf-archive/README.md)). The agent knows the caller by the uid the kernel
reports, runs barman-cloud as that database's user in `pgcfbackup.slice` with one credential scoped
to the database's own prefix, and answers `ok` to an archive request only when the object is durably in
R2 and the segment is in the fsynced upload log. The agent never deletes in R2; retention runs in the
Worker. The concurrency and memory limits of the jobs come from the policy.

## Fencing, updates and diagnostics

- **Fencing** (`fence.rs`). A `fence` order and the `superseded` orders of a lost node are written
  to disk before the agent acts, are never lifted because they left the page, and are checked
  before any recovery start at boot. A fenced node neither starts nor archives the databases, and a
  fence ends only with a reinstall.
- **Updates** (`update.rs`). A release the page names changes the four binaries without a reboot:
  they are downloaded into the release's directory, checked against the pinned size and sha256, and
  only then does `current` move. A maintenance order installs the release's package lock through
  apt, reboots when a kernel or core library changed, runs `pgcf-agent check` and answers. The exact steps are in the
  [node image README](../../infra/node-image/README.md#what-the-image-expects-from-the-agent).
- **Host files** (`hostfiles.rs`). The image's systemd units and masks and its sshd, journald,
  sysctl, tmpfiles, sysusers and modprobe configuration ship with the release too, after its
  binaries and written by the agent that runs the release's own binary. The agent holds the signed
  list to its own rules just before it writes (a list they do not allow is refused for its files,
  once, and the binaries are installed all the same), and the files that differ are written
  atomically below `/` (hidden file, `fsync`, rename, `fsync` of the directory) in the allow-listed
  directories only, never through a link. `systemd-sysusers` and `systemd-tmpfiles --create` run on
  the files that say so, systemd reads its units again once, and what changed is restarted, the
  agent's own unit last (the agent leaves); a failure is tried again after a growing wait and keeps
  no other unit from its restart. The agent's own unit is written to `/run/systemd/system` first,
  and the agent that runs it moves it to its place after it has read its first page: a node whose
  new unit cannot start is restarted from the API and runs the unit it had. `agent/host-files.json`
  records the paths the agent may touch and what is left to do before the first write, so a crash
  at any point is finished by the next start. The hello reports the digest of what the disk holds
  (`os.host_files_sha256`), which is the release's only when systemd has been told everything. See
  the [node image README](../../infra/node-image/README.md#what-ships-with-the-image-what-with-a-release).
- **Events and logs** (`timing.rs`, `events.rs`). The agent logs one JSON line per event to stderr
  and names a failure by its class, never by an error's text, which can carry an address or a path.
  The lines also travel in the next observation report, reduced to the contract's fields.
- **Observations** (`agent/report.rs`). A database's observation goes to Cloudflare when what the
  API stores of it differs from what the API last accepted (its answer's verdict `accept`, one per
  database), and again once in each anti-entropy period (`NODE_OBSERVATION_RESEND_MS`, 15 minutes) at
  a point of the period that the database's identifier fixes. A refused, lost or `stale` and
  `conflict` answer keeps the database unaccepted. While Cloudflare waits for a database (an entry
  with an origin, or a move order that holds it) every pull says it. A restarted agent holds
  nothing, so its first pull says every database once.
- **Boot report and probes** (`diagnostics/`). After a reboot the agent posts the sanitized tail of
  the previous boot's journal; on request it runs one of eight read-only probes, each a fixed
  command with no shell. Neither ever reports the lines of a database's unit or of a backup job.
  See [recovery.md](../../docs/operations/recovery.md#looking-at-a-node).

## Tests

The agent's logic is tested against real PostgreSQL 18, never a mock: point
`PGCF_TEST_POSTGRES_BINDIR` at the `bin` directory of a PostgreSQL 18 (CI installs the pinned
version, see [THIRD_PARTY.md](../../THIRD_PARTY.md)); without it the database tests are skipped.
PostgreSQL's Unix socket path is limited to 103 bytes, so run them with a short `TMPDIR`.

```sh
TMPDIR=/tmp PGCF_TEST_POSTGRES_BINDIR=/usr/lib/postgresql/18/bin cargo test -p pgcf-node-agent
```

Tests that need the kernel are `#[ignore]`d. CI runs them from
[kernel-test.Dockerfile](kernel-test.Dockerfile) in a container with no network and `CAP_SYS_ADMIN`
alone (the mount API, for example).
The lab tests need a Debian 13 host with systemd as PID 1, root, LVM and the image's units
(`units/lab.rs`, `machine/node.rs`), or a privileged container with loop devices for
`storage/lab_tests.rs`, which is built only with `RUSTFLAGS='--cfg pgcf_storage_lab'`.
`start_lab.rs` is the agent's start on a node with 300 databases, on the same real parts and with a
disk that is slow to flush (its header says how to run it); the numbers it gave are in the plan
(11.1, "Agent start and stop at 300 databases").

The contract with Cloudflare is `packages/contracts/src/node-link.ts`. `node_link.rs` reads its
generated JSON Schemas, and conformance tests hold the agent and the API to the same vectors.
