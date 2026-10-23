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
  hint: DETAIL "node at awake capacity" (`no_headroom`) when the memory rule held it back, or a
  start ahead of it, and DETAIL "node busy starting databases" (`start_queue`) when the start cap
  alone did. systemd never restarts a database by itself, so no start bypasses these rules.
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
| `pgcf-agent run`   | The service of `pgcf-agent.service` (`Type=notify`). It enrolls and links to Cloudflare and asks for its first page while it opens the node's storage, restores what a boot lost and signals `READY=1`, link or no link, so a node that is not enrolled yet waits instead of crashing |
| `pgcf-agent check` | Makes or wakes one scratch database (`SCRATCH`) on a thin volume, queries it over its socket and stops it, without Cloudflare. The image's boot test runs it after the first boot and again after a reboot, and a maintenance cycle runs it before it answers its order |
| `pgcf-agent hold`  | The one process of the transient unit `pgcf-mounts.service`, which `run` starts when the node has none and whose mount namespace it joins (`mount_holder.rs`, below). It tells systemd that it is ready and waits to be stopped, then unmounts the volumes 16 at a time |

An agent restart never stops a database: PostgreSQL runs in slots (units of their own, below), and
the agent reads them back from the kernel. A release that changes the agent's own binary makes it
exit so that systemd starts the new one.

**The volumes' mount namespace outlives the agent** (`mount_holder.rs`). The agent mounts the
volume of every database it knows in a mount namespace of its own, so that the mounts stay out of
PID 1's. A process that dies leaves its mount namespace and the kernel unmounts what it holds one
volume after the other, each as slow as the disk's flushes: after a `kill -9` of the agent the old
process took 14 s to exit on EU1 with 312 volumes (lab, 300 volumes on a disk with 10 ms flushes:
13 to 21 s), and systemd starts the next agent only after that. So the namespace is held by
`pgcf-agent hold`, the one process of the transient unit `pgcf-mounts.service`
(`PrivateMounts=yes`, `Type=notify`; `systemd-run` makes it, once a boot), and `run` joins it with
`setns(2)` before the runtime starts a thread. A killed agent then leaves nothing to unmount (lab,
the real agent under systemd: 11 ms), the next agent finds the volumes mounted and joins in 12 ms,
and the page cache of the sleeping databases stays. The agent's own exit no longer unmounts
anything when it joined; where it could not (no systemd, the unit does not start, `setns` is
refused) it says `mount_holder_unavailable` with a class and works in the namespace its unit gives
it, as it did before, and its exit unmounts as before. The holder unmounts the volumes 16 at a time
when it is stopped (a shutdown, `systemctl stop pgcf-mounts`), so stop the agent first. A shell
reaches the namespace with
`nsenter --target "$(systemctl show --property=MainPID --value pgcf-mounts.service)" --mount`.
An agent of a release before this one does not know the holder: going back to such a release needs
`systemctl stop pgcf-agent pgcf-mounts` first, or the volumes stay mounted in the holder's
namespace, where the old agent's unmounts find them held (`Busy`).

**The agent's start** (`main.rs`, `Service::start_with_page`) is a short path to the first served wake
and a longer one behind it, because a restarted agent is a database's wake that waits (EU1,
2026-10-23: 46 s from `kill -9` to the first served wake, of which the old process took 14 s to
exit, the adoption of the slots 13.7 s, the archive credentials 4.7 s and the decisions on the
databases that ran 7.1 s). The path to the first wake is: systemd starts the next process 100 ms
after the old one ended (`RestartSec=100ms`); the connection to systemd and the node's tables; the
link and the first page, which need the node's boot and packages and nothing of LVM, **at the same
time as** the storage opening (`Node::connect_unopened`, `Node::open_storage`; a node that is set up
asks lvm2 for `pvs`, `vgs` and `lvs` at once and activates nothing when the pool and every volume
are active, which is what an agent that restarts finds); the device links and the runtime
(`restore_runtime`); the slots and units read back from the kernel, with up to 16 independent
slot checks and idle-limit restorations at once; the first page applied (the
fences, the generations, the decisions on the databases that ran, which come first); and the
gateway served once those are decided (`Core::settled`). A wake is never served before the first
page, the fences and the generations are known. The first thin-pool sample runs beside slot
adoption and completes before admission starts. A sample that fails or exceeds one second leaves
capacity unknown and starts refused until a later sample succeeds; it never prevents the service
from coming up indefinitely. **The credentials are not on that path.** The
archive credentials (one read each, 32 at a time, those of the databases that ran first) and the
node's own (the Tunnel and the route keyring) are read after the first page is applied, in the
background (`Service::pull_page`): a database that ran is registered with the archive socket when
its credential arrives (`Core::deliver`), a build waits for its own up to `Timing::credential_wait`
(300 s), begins when it arrives and fails with `archive_unusable` after the wait, and a page after
the first reads its credentials before it is applied, as before. The phases `agent_start_phase` names: `storage_open`, `device_links`,
`restore_runtime`, `linked` (how long the link outlasted the storage), `slots_adopted`,
`units_read`, `apply`, `settled`, `gateway_table`, `service_started`, and beside the row (read by
`at_ms`) `link_started`, `link_hello`, `first_page`, `initial_pool_sample`, `credentials` and
`first_wake_served`. The last phase requires a successful `started` wake, never a refusal; it
measures agent-side readiness. The client measures successful first SQL and the complete cold
request separately. A start
that fails (the pool will not activate, `vgchange_exit_5`) says `agent_failed` and waits five
seconds before it ends (`pause_after_failed_start`), so that the 100 ms restart does not run the
failing commands ten times a second; a stop ends the wait. systemd's `RestartSteps=` is not used:
it is not reset by a long run (systemd 257.13, measured), so it would slow the restart after a
kill for as long as the node lives.

## Jobs and where they live

| Job (plan 5.6)             | Code                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Link to Cloudflare         | `link/`, `node_link.rs`: enrollment, the signed requests, the NodeActor WebSocket, the outbox                                                          |
| Admission                  | `admission.rs`                                                                                                                                         |
| Storage                    | `storage/`: the volume group and thin pool, one thin volume with its ext4 per database, the samples, the room rule, full-pool and full-volume recovery |
| Units and slots            | `units/`: the pool of slots (`slots.rs`), the node's systemd and kernel for it (`system.rs`), the idmapped handoff (`idmap.rs`), limits as unit properties, the Linux users; the units of their own an earlier agent started |
| Database lifecycle         | `agent/`: `apply.rs` (the page becomes action, and the delete), `remove.rs` (the machine's part of a delete), `build.rs` (create, restore, move target), `power.rs` (wake, sleep, recovery), `repair.rs` (the volumes of sleeping databases after a pool without writes) |
| Sleep proof and its record | `proof.rs`, `sleep.rs`, `pg_control.rs`, `state.rs`                                                                                                    |
| Roles                      | `roles.rs`, `scram.rs`: PostgreSQL holds exactly the roles of the page, with verifiers, never passwords                                                |
| Backups                    | `archive/`: the archive socket, the barman-cloud jobs, restore and PITR recovery, the upload log                                                       |
| Fencing                    | `fence.rs`                                                                                                                                             |
| Gateway channel            | `gateway.rs`: the writer table, the wakes, quiesce, close, status and activity                                                                         |
| Metrics and diagnostics    | `usage.rs`, `sample.rs`, `events.rs`, `diagnostics/`                                                                                       |
| Cold page cache            | `prefetch.rs`: readahead of the start set, the catalog set, the autoprewarm list and whole files with its own accounting; `program.rs`: the files of PostgreSQL's program; `cache.rs`: how files of the data directory are opened and counted |
| Updates                    | `update.rs`, `release.rs`                                                                                                                              |
| The loops                  | `service.rs`: what feeds the core and what it feeds                                                                                                    |

`machine.rs` is the seam to the machine: the Linux users, the thin volumes, the systemd units,
`initdb` and the kernel's memory figures. The flows are written against that trait; `machine/node.rs`
is the node itself and `machine/local.rs` stands in for systemd and LVM only, under a real
PostgreSQL 18.

One database has one flow at a time (a create, a wake, a sleep, a recovery or a delete finishes
before the next begins). What the gateway and the observations read is the database's view, which
every flow updates in small steps.

**Filesystem growth.** New volumes use `meta_bg` without `resize_inode`, so their 8 MiB journal
can grow online without the reserved-descriptor credit exhaustion of the earlier layout. Every
filesystem leaves 4 MiB at the end of its volume for signature isolation. Existing filesystems
are never reformatted: the earlier layout grows offline after all holders release it, with
`e2fsck -p -f` before `resize2fs`. A warm database uses the existing quiesce/archive/stop proof;
a busy database defers growth. A crashed database stays unproven while the agent applies an
explicitly requested grow before PostgreSQL recovery, then archives and proves it normally.
An interrupted offline grow is tagged suspect and checked before remounting. Every ready or
asleep observation carries the measured filesystem size; no size means no resize completion.
No tenant project quota is installed. Full-volume recovery is by growing the volume, without a
guarantee that arbitrary SQL cleanup can run with no available space.

**The pool after a reset that was not clean** (`Storage::open`, `activate_group`). A hard power-off
left one leaked data block in the pool's metadata on EU1 (2026-10-23): `thin_check -q` found it
(exit 64), `vgchange --activate y` ended with 5, the agent crash-looped 798 times and every
database of the node was down for 27 minutes. When the plain activation fails, the agent (1)
deactivates a part of the pool that is active on its own (`pgcf_thinpool_tdata`, `_tmeta`: an
inspection of the metadata with `lvchange --activate y --yes` leaves it so, and lvm2 then refuses
the pool) and tries the plain activation again, and otherwise (2) activates once more with
`thin_check --auto-repair` added to the host's own `thin_check_options` (`commands::REPAIRING_CHECK`),
and reports `thin_pool_parts_released` and `thin_pool_repair_activation`. What `--auto-repair`
does, from thin-provisioning-tools 1.1.0 and the lab: it "automatically repairs any trivial issues
found with the metadata; currently only fixes metadata leaks", by rewriting the space map of a leak
(a block the map counts as used that no mapping refers to) once the trees have been read without an
error. It writes nothing when a tree or a checksum is wrong, because the leak check comes after the
walk of the trees: a metadata image with a leaked block and a wrong checksum in the mapping tree is
left byte for byte as it was, and the activation ends with the same exit 5. The exit status cannot
tell a leak from damage (the Rust `thin_check` ends with 64 for every error, the man page's 1
notwithstanding), so the option, not the status, is what keeps the repair to the leak. A damaged
pool stays down: the agent exits with `vgchange_exit_5`, the node goes stale and
`regional_node_stale` and `thin_storage_blocked` fire; no `thin_repair` and no `lvconvert
--repair` run. The pool does not set `--clear-needs-check-flag`, which the host's list does not
have either.

## Slots

PostgreSQL runs in a slot, the unit `pgcf-slot@<n>.service`, as the slot's own user
(`pgcf-slot-<n>`, uid 300000 + _n_). The agent builds slots before a wake, for no database, and
keeps four idle for each start that may run at once (`IDLE_PER_START`, so 32 on EU1 at 8 starts)
while no start is in flight or waits (`agent/power.rs`, `refill_pass`). The pool must hold what a
storm takes, because it is refilled only on a quiet node: a storm of 40 wakes found 8 idle slots
and built the other 32 inside the wakes, 1 to 4 s each (EU1, 2026-10-23). An idle slot holds about
0.6 MiB (live, with 309 volumes mounted), so the 32 cost about 20 MiB. A pool that a storm emptied
is built `BUILDS_AT_ONCE` (4) slots at a time; the refills decide one at a time in the pool's turn
(`Pool::refill`), so together they build no more than the target and make each user once. A build
costs about 80 ms of CPU, which a wake must not wait for, and runs at the idle CPU weight from its
first moment; a fence or a maintenance order stops the idle slots. An idle slot runs the supervisor (`pgcf-archive slot <n>`),
which takes one order, from root. Every start takes one path: the admission permit, then

1. **Take or build** (`slots::Pool::bind`): an idle slot, or a new one built inside the permit, so
   that `start_concurrency` bounds the builds as it bounds the starts. The claim is one step under
   the table's lock: no slot holds the database in any state, and then an idle slot becomes the
   database's, or a free number is entered as being built for it (a slot being built already holds
   its database). A wake makes no slot user (`groupadd` and `useradd` cost about 75 ms per user
   and lock the node's account files): a miss takes only a free number that has a user. The
   refill makes the users of the whole range, lowest number first, one at a time in its quiet
   passes once the idle slots are in place (they persist in `/etc/passwd`, so a node makes them
   once), so that no storm runs out of numbers: a number is in use only while its database is
   awake, and using up the 1023 numbers would take over a thousand awake databases of at least
   256 MiB each. A node that was just installed has only the users the refill has made so far
   (the first minutes of its life: 75 ms each), and a miss that finds no free number with a user
   fails with `no slot` (a `release_failed` wake) until the next quiet pass. A build that fails (the unit
   refuses its start over a process left in its cgroup, a user that cannot be made) keeps its
   number out of the next builds while another is free and is reported as `slot_build_failed`.
   Where every free number with a user has failed, the refill makes the next user first and builds
   there, and a failed build does not end the pass before that user is made, so a node that has
   only the users of the slots it built is not stuck on a number that fails.
2. **Bind**, in parallel: the database's limits as runtime properties of the slot, its volume and
   its socket directory moved into the slot's mount namespace as idmapped clones (`units/idmap.rs`),
   and a check that no unit of its own (`pgcf-pg@`) holds the database.
3. **Order** (`exec`): sent only after all of that succeeded, because an idle slot's memory ceiling
   is below `shared_buffers`. A failure before the order stops the slot, and the database stays
   asleep with its proof: no PostgreSQL ran.
4. **Ready**: an `inotify` watch on `postmaster.pid` and the slot's pidfd, never a poll.

The wake's phases are `slot` (take or build), `bind` (properties, mounts, order) and `start`
(order to ready), and its detail says `slot_from` (`pool` or `demand`), `slot_wait_us`, `bind_us`
and `order_us`. A slot serves one database for one awake period and ends with its stop; only its
number and its user come back, for a new, empty unit, and the refill sets the idle limits again
because a runtime property outlives the stop of its unit.

**One writer.** A slot's name says nothing of the database, so the pool enforces what one unit name
per database used to: it binds no database while any slot holds it in any state, in any generation
of its volume, until the slot has reached `inactive` (checked again in the step that claims the
slot, so two starts of one database cannot both claim); it binds none while the database's unit of
its own (`pgcf-pg@`) is awake or has ended with a process left in its cgroup (that unit never took
the lock below); and the supervisor takes `flock` on the data directory before it executes
PostgreSQL (the agent try-locks it before every bind and holds it while it writes a sleeping
database's configuration). PostgreSQL's own guard cannot do it across two
users: `kill(pid, 0)` of another user's process is `EPERM`, which `miscinit.c` takes for a stale
`postmaster.pid`, and a segment in another IPC namespace is not found (the slot lab shows the second
postmaster coming up without the lock).

**The archive socket** knows a caller by the slot that holds it: the pool's table says which
database a slot's uid belongs to, and only a process in that slot's cgroup and invocation (read from
`/proc/<pid>/cgroup` and the `trusted.invocation_id` systemd keeps on the cgroup) is the holder's. A
uid with no database now gets `peer_unknown`.

**Adoption.** The table is never written to disk. When the agent starts it reads the units, each
main process, `/proc/<pid>/exe`, its mount table and `/proc/locks` (`Pool::adopt`; the volume a
mount is names itself from one listing of `lvs` for all the slots, where it ran `lvs` for each:
13.7 s of the 28.7 s to the first wake with 104 slots on EU1, 2026-10-23): an idle slot
stays; one that holds a database it was never ordered to run, or whose postmaster does not hold the
lock, is stopped and its database stays asleep (every mount at a database's directory counts as
holding it, also one the agent cannot name as a volume of that database: unknown means tainted, and
such a slot is never kept idle); one whose PostgreSQL runs is kept, ready or still
starting; one that is stopping is waited for, and its database is then decided by its control file.
The units of their own that an earlier agent started are served and put to sleep as before, and the
archive socket knows their callers by uid until they sleep; the release after the one that finds
none left deletes that path.

**Rolling back to an earlier release.** An agent of a release before this one knows no slots, and
a release assigned to a region as a rollback (plan 9.3: how a bad release is rolled back) must not
be assigned while a slot holds a database. That agent starts, reads `pgcf-pg@<id>` as not awake and
takes the database for asleep (`adopt_asleep`); its sleep check fails, because `pg_control` says
"in production" while the slot's PostgreSQL runs (`proof::wake_check`), so the database goes to
recovery (`go_unproven`), and recovery starts `pgcf-pg@<id>`: a second postmaster on the data
directory. Nothing in that agent refuses it. Its refusal to start over a stray process reads only
that unit's own cgroup, not the slot's. PostgreSQL's own guard fails across the two users (see
**One writer**). And it never takes the supervisor's `flock`. The slot lab shows PostgreSQL
accepting exactly that second postmaster
(`postgresql_alone_accepts_a_second_postmaster_of_another_slot_on_the_same_directory`). Two
writers corrupt the cluster.

**The rule:** before an older release is assigned to a node's region, every database on the node
sleeps with its proof, so that no slot holds a database, none wakes and nothing is placed on the
node before the older agent runs. Idle slots hold no database and cannot corrupt one: the older
agent ignores them (its host files drop the slot template, and units that run keep running), and
the first release that runs slots again adopts them. Three things do it.

- **The drain is the `maintenance` order** (`POST /v1/nodes/{id}/maintenance`): it holds new wakes
  with `57P03`, puts every database that is `ready` to sleep with the proof (the sleep stops its
  slot and waits until the unit is inactive), stops the idle slots and builds none while it is open.
  It sleeps only the databases in `Phase::Ready` (`obey_maintenance`): a wake that is in flight
  when the order arrives ends awake, in a slot, after the order has looked at it.
- **The hold across the swap is a manual suspension of every database on the node**
  (`POST /v1/databases/{id}/suspend`). The order's hold ends when its cycle is answered, within
  seconds when the node holds the release's packages already, and no order holds the wakes across
  the swap of the agent. A manual suspension is a desired state, and a connection never wakes a
  database in it, whatever agent is running. It reaches every database that is not in a wake or a
  sleep: one that is `ready` goes through the sleep proof, and one that hibernates (a verified idle sleeper) is claimed by the API
  with no sleep to run (`verifiedIdle` in `apps/api/src/domain/lifecycle.ts`; the node reports the
  new generation asleep on its next pull; the test
  "manual suspension can claim an already verified idle sleeper and keeps connect auto-wake
  disabled" proves it). Its costs: an integrator's `resume` of one of these databases wakes it
  (the integrator has to be told), the operator resumes every database afterwards, one by one, and
  a resume answers `409` with `node_capacity` where the node cannot hold what is resumed at once.
- **Closed placement across the swap** (`PUT /v1/nodes/{id}/database-placement` with
  `expected_node_uid` and `database_placement_enabled: false`). A node that is open for placement
  takes new databases: the API places a create, a restore (which makes a new database) or a move on
  it, and a move reads the same rule (`targetOpen` in `apps/api/src/domain/database-moves.ts`). The
  agent builds the database and starts its PostgreSQL in a slot, and the older agent then finds
  `pgcf-pg@<id>` inactive and runs `adopt_asleep`: the database has no sleep record, or `pg_control`
  says "in production", so it goes unproven and recovery starts `pgcf-pg@<id>` beside the slot's
  postmaster, the second writer that this rule exists to prevent, and over a tenant's real data
  when the database is a restore or a move. The `maintenance` order does not keep placement closed
  for the swap: a cycle that ends `done` opens placement again if the cycle closed it itself
  (`recordOrderResults` in `apps/api/src/domain/lifecycle-orders.ts`). So the operator closes it
  first: the cycle then records no closure of its own and leaves this one closed (test "keeps
  closed the placement that an operator closed, before the cycle or during it" in
  `apps/api/test/domain/node-maintenance.test.ts`). A move that began before the closure is the
  other way in, and the check cannot see it (step 3).

**The order of the operator.**

1. Close the node's placement first (`PUT /v1/nodes/{id}/database-placement`,
   `database_placement_enabled: false`), and then suspend every database of the node
   (`POST /v1/databases/{id}/suspend`). A database whose wake is under way, or whose idle sleep has
   not ended, answers `409` `not_ready` and stays as it was (the claim of a wake has set its
   `desired_state` to `running`): suspend it again when the node has reported the wake `ready` or
   the sleep `asleep`.
2. Run the `maintenance` order and wait for `done`. The drain sleeps only the databases that are
   `ready`: what it leaves is what the next two steps read. The cycle leaves placement closed,
   because step 1 closed it.
3. **Read the moves, and the node's own count.** In D1, no row of `database_moves` with `status` in
   `proving` or `restoring` names the node as `source_node_id` or `target_node_id`. A move whose
   target is the node restores its database in a slot of the node, and D1 lists that database
   under its source node until the move is done, so step 4 does not see it; a move whose source is
   the node still has the node prove a sleep and remove a volume. Wait until the move is `done` or
   `failed` and read again. Then the two newest complete minutes of the node in
   `node_minutes` (folded from its 15 s samples) have `samples` of at least 3 and `awake_max` 0: no
   sample counted a database whose PostgreSQL is active or starting. The node's admission counts
   every wake and every start of a recovery (`Admitter::snapshot`), at the instant of a sample, and
   it holds nothing between two attempts of a recovery: it is no check of a database that is
   `unproven` (step 4 and the paragraph "What the check cannot see").
4. **Read the check, last.** List the node's databases (`GET /v1/databases?node_id=<node>`, every
   page, admin key). Every one reads `observed_state` `hibernated` and `suspension_reason`
   `manual`. In D1 that is
   `desired_state='suspended' AND suspension_reason='manual' AND observed_generation=generation AND observed_power='hibernated'`.
   And the reinstall guard's query returns no row for the node (`reinstallBlockers` in
   `apps/api/src/domain/reinstall-guard.ts`; D1 only, it has no route):
   `SELECT d.id FROM databases d WHERE d.node_id=<node> AND d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM database_recovery_points p WHERE p.database_id=d.id AND p.node_id=d.node_id AND p.storage_generation=d.storage_generation AND p.generation>=d.generation AND p.state='asleep')`.
   Every database of the node has a recovery point `asleep` at its current storage generation and
   generation: the node's last word on it is a proven sleep, and nothing took that back. A database
   that fails either half is suspended again or waited for (a database the query names is one whose
   recovery has not proven its sleep yet: wait until the node reports it asleep), and steps 3 and 4
   are read again.
5. Assign the older release. Until the older agent runs, nothing is placed on the node (placement
   stays closed: `GET /v1/nodes/{id}` reads `database_placement_enabled` `false`, and no one starts
   a move), no integrator resumes a database of the node and nothing restarts the agent but the
   swap. The agent that installs the older release is this one: it does not look at its slots
   before it switches its link. Reopen placement (`database_placement_enabled: true`, if the node
   was open before step 1) only after the older agent has reported its release
   (`GET /v1/nodes/{id}/release` reads `converged` for the older release).

**Why `observed_power` is not the check.** It is the power of the node's last report, and no report
comes while a wake runs. The claim of a wake (an integrator's `resume`, or a connection's wake
ticket) sets `desired_state` `running` and raises the generation and leaves `observed_power` as it
was; the agent sends no observation while it starts PostgreSQL (`Phase::Starting`; `observe` in
`agent/report.rs`: "a wake under way has nothing to report"), and its first report is `ready`. A
database whose wake began before its suspension reads `observed_power` `hibernated` with its
PostgreSQL coming up in a slot, and an agent of the earlier release would then start a second
postmaster over it. The reports `unproven`, `building` and `error` keep the earlier power too
(`applyObservation` in `apps/api/src/domain/node-observations.ts`). The public `hibernated`
(`databaseView` in `apps/api/src/domain/rows.ts`) needs `desired_state` `suspended`,
`observed_generation` equal to `generation` and `observed_power` `hibernated` together: the
suspension of a database in its wake is refused, one accepted after the wake's `ready` raises the
generation, and the generation is observed only when the node says the database asleep at it.
`manual` is needed because a database suspended for idleness reads `hibernated` too, and a
connection wakes it into a slot at any time. The tests are
`apps/api/test/domain/rollback-check.test.ts` (the public view, the guard's query and the case below)
and `a_wake_under_way_has_nothing_to_report_and_an_unproven_database_says_so` (`agent/report.rs`).

**What the check cannot see, and what sees it.** When the agent starts and cannot prove the sleep
of a database (`adopt_asleep`), it reports `unproven`. The API keeps the power, the generation and
the state as they were, so the listing of step 4 still reads `hibernated` and `manual`, and the
recovery starts PostgreSQL in a slot while D1 says so (the third test of `rollback-check.test.ts`
shows it). The report does change the recovery point: it becomes `unproven`
(`recordRecoveryPoints` in `apps/api/src/domain/lifecycle-observations.ts`, migration 0065), and the
reinstall guard's query, the second half of step 4, lists every database of the node without an
`asleep` point at its current storage generation and generation. It is that query that sees the
recovery, until the node reports the sleep proven again. The node's count does not: it sees an
unproven database only while the recovery's PostgreSQL is starting or running at a sample (every
15 s). Between attempts nothing counts it. `recover_once` (`agent/power.rs`) returns `Retry` before
it starts anything when the archive credential is not delivered yet, when the node cannot read,
repair or mount the volume, when the configuration cannot be refreshed, and when the start itself
fails (no slot, a failed build, a refused admission); `spawn_recovery` then waits from 1 s up to
30 s (`Timing::recovery_retry`) and admission holds nothing meanwhile, so `awake_max` is 0. The
minutes of step 3 are also one to two minutes old when step 4 is read. D1 keeps the database
`held` throughout, and the next attempt can start PostgreSQL in a slot while the older agent runs:
the older agent's `adopt_asleep` finds `pg_control` "in production", recovers it and starts
`pgcf-pg@<id>` beside the slot's postmaster. The cases the count does see are the ones D1 lists
under no database of the node: a database whose delete was requested is no longer listed, and the
count keeps its unit until the agent has stopped it; a database that a move restores on the node is
listed under its source node until the move is done, which the read of the moves in step 3 sees and
the count also does once its PostgreSQL runs. This is a rule for the operator and no guard, and it
follows from reading the agent of `origin/main`; it was not run on a node.

**The health check** runs the scratch database in the slot of its own (number 1023), so it takes no
idle slot of the agent's pool and leaves none; it builds that slot (and makes its user) with its own
refill before the bind.

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
| `/run/pgcf/slot/<n>/control`                   | A slot's supervisor socket (`RuntimeDirectory=` of the unit, mode 0700 for the slot's user; only root is served)                                                                                              |
| `/run/pgcf/agent/gateway.sock`, `archive.sock` | The gateway's channel (the gateway's user only) and the archive socket (the databases, known by the slot that holds them)                                                                                     |

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
- **ANALYZE and autovacuum** are bounded by the memory for the table's own columns, and not for
  the values of an index expression. `ANALYZE` keeps a sample of 300 × `default_statistics_target`
  rows, each as it lies on its page: up to 8,200 bytes for rows that are never toasted
  (`STORAGE PLAIN`; a row of ordinary columns is cut to 2 KB) and 9,260 with the expanded copy of one
  compressed value (`settings.rs`, checked against PostgreSQL 18 by a test). PostgreSQL's default of
  100 is 30,000 rows, 265 MiB at the widest rows: more than a 256 MiB database has.
  `autovacuum_max_workers` is 1 up to 512 MiB, 2 up to 1 GiB and 3 above, and
  `default_statistics_target` is the largest multiple of ten, from 10 to 100, at which the samples
  of every autovacuum worker and of one manual `ANALYZE`, all at the widest rows, take at most half
  of the memory: 20 for 256 MiB, 40 for 512 MiB, 60 for 1 GiB, 90 for 2 GiB and 100 from 2,304 MiB.
  A vacuum's dead-item store is `maintenance_work_mem` (_m_/16), which is smaller than a sample's
  share. What a tenant can still change: its session's or role's or database's
  `default_statistics_target`, a column's target (`ALTER TABLE ... SET STATISTICS`, up to 10,000) and
  its session's `maintenance_work_mem`. Each raises the sample, or the vacuum's store, in proportion;
  past the class's bound the database is throttled at the unit's soft limit (every session of it, not
  only the ANALYZE) and, at the ceiling, a backend is killed and the database runs crash recovery.
  The workers and `autovacuum_work_mem` are the postmaster's, which the tenant's roles cannot set.
  A lower target gives a column fewer most-common values and histogram buckets (20 for 256 MiB),
  which planner estimates for skewed columns of large tables can show.
  **Index and statistics expressions are not bounded by any class setting.** While the sample lives,
  `ANALYZE` also copies the value of every index expression for every sampled row
  (`compute_index_stats` in `analyze.c`; `CREATE STATISTICS` expressions do the same in
  `compute_expr_stats`), one index or statistics object at a time, and the width of such a value is
  whatever the expression makes it, not the row's. A full-text index on
  `to_tsvector('simple', body)` over documents of 22 KB holds a tsvector of 26 KB for each sampled
  row: 152 MiB for the 6,000 rows of a 256 MiB database (measured on the real unit, plan 4.4), where
  the model above says 53 MiB; at the class's target a table with enough rows holds 455 MiB in 1 GiB,
  682 MiB in 2 GiB and 758 MiB in 4 GiB (rows × width, not measured at those sizes). One such
  `ANALYZE` fits every class (xs: 204 MiB of 230 MiB that the unit cannot give back), but the
  autovacuum worker and a session at once do not fit xs: the unit stalled for memory about 30 % of
  the time and the two had not ended after 700 s. A tenant ends it with `ALTER INDEX ... ALTER COLUMN
  1 SET STATISTICS 0` (the expression gets no new statistics, +0 MiB) or with a stored generated
  column that the index is on instead of the expression (+1 MiB); plan 4.4 and the integrator
  handover give the cost of each. A `CREATE STATISTICS` object over expressions holds the same, and
  `ALTER STATISTICS ... SET STATISTICS 0` skips it (read in `extended_stats.c`, not measured).
- **From the size class:** `max_connections` and `archive_timeout`. `archive_mode` is on with
  `/usr/libexec/pgcf/pgcf-archive %p`, `wal_level` is `replica`, `wal_init_zero` is off,
  `wal_recycle` on, `min_wal_size` 32 MB, `max_wal_size` a quarter of the volume (at least 64 MiB),
  and crash recovery syncs the filesystem once (`recovery_init_sync_method = syncfs`).
- **Small databases** (512 MiB and below) run two autovacuum worker slots (one worker, above),
  one I/O worker, no parallel query or maintenance workers, four background worker slots and no
  replication.
  A restore runs with the larger of the backup's and the class's values during its recovery,
  because a recovery checks `max_connections`, the process, sender, prepared transaction and lock
  settings against its source's, and restarts onto the class's own afterwards.
- **Autoprewarm** runs in every database (`shared_preload_libraries = 'pg_prewarm'`,
  `pg_prewarm.autoprewarm = on`, `autoprewarm_interval = 0`): the list of the shared buffers is
  written at each clean stop only, so a running database pays nothing, and read again in the
  background after the next start, where it competes with the first queries for the disk. Two of
  the worker slots are its leader and its worker; the sleep guard does not count its worker as a
  session.
- **Readahead** (`prefetch.rs` and `program.rs`, called from `agent/readahead.rs`). The agent
  asks the kernel to read ahead with `posix_fadvise(WILLNEED)` the files a cold start and request
  read, in four sets of a sleeping database and the program of PostgreSQL:
  - the **start set**: what PostgreSQL reads between its exec and its ready (the configuration
    and `PG_VERSION`; `pg_control`; 256 KiB of WAL at the latest checkpoint record and, after a
    crash, at the redo point that `pg_control` holds; the last segment of `pg_xact` and of
    `pg_multixact`'s two directories; `pg_stat/pgstat.stat`; `pg_logical/replorigin_checkpoint`;
    `global/`; about 1 MB). `pg_internal.init` is left out: PostgreSQL removes it at every start;
  - the **catalog set**: in each user database its `PG_VERSION`, `pg_filenode.map` and the
    login's catalogs with their indexes and forks; about 5 MB. The mapped catalogs (`pg_class`,
    `pg_attribute`, `pg_proc`, `pg_type` and their indexes) are found through the map where
    `VACUUM FULL` moved them; the others are read at their OID, so a rewrite of one drops it from
    the set, and the report's `missing` counts it;
  - the **hot list**: the autoprewarm list (blocks merged where contiguous, the relations with
    the fewest listed blocks first, system databases left out);
  - the **program** (`program.rs`): the `postgres` binary, the libraries it links (found from the
    `DT_NEEDED` entries of the binary and of each library, on the loader's default path), the
    extension libraries of `settings::PRELOAD_LIBRARIES`, and the system files a postmaster
    opens at its start (the time zone abbreviations, the C.UTF-8 locale, OpenSSL's configuration);
    ICU's 32 MB data library, of which a postmaster touches 72 KiB, is left out because it is
    data.

  A plan is built first (blocking: directories, `pg_control`, the maps and the list are read,
  each file is opened once for its length), then issued in pieces of at most 128 KiB, because the
  kernel reads only the first `read_ahead_kb` of a range per call. A piece that `cachestat(2)`
  shows the cache holds entirely is not advised, so a pass over a resident set reads nothing. The
  data directory is the database user's, so a plan reads only the real directories of `base/` (at
  most 32 databases) whatever the list names, stops after 512 files of a list that are not there,
  and stops at a budget and a cancel as the issuing does. Issuing stops at a time budget, a byte
  bound or a cancel and returns the counts, the bytes the cache already held and the timings; they
  go to an event (`prefetch`: set, hook, why it ended and the counts; `program_warm` for the
  program), which takes the place of the residency diagnostic that `cache.rs` made while a wake
  ran (deleted).

  Three hooks, and one constant of the build (`agent::PREFETCH`, not a policy of the node, so the
  A/B needs a release and no API change) says which run:
  - the **program**, from the pool's refill: one pass at the first refill after the agent starts
    and then one every `Timing::program_every` (60 s), never while a start is in flight or waits,
    and a start that begins ends the pass that runs (shipped);
  - the **start set and the catalogs at the bind**, from the start's permit, in a task the order
    does not wait for, for at most 50 ms (shipped as `Start::Alternate` for the live interleaved
    A/B on the pooled path: it reads for every second start and says which in a `prefetch_arm`
    event; the release after the A/B sets `Start::On` or `Start::Off`);
  - the **hot list** from ready, with a budget of 150 ms (shipped).

  `settings::AUTOPREWARM` is the build's other switch, for the A/B arm without PostgreSQL's own
  autoprewarm.
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
the gateway's keyring and the Tunnel token from `GET /node/v1/credentials` after it has applied its
first page, and again when the page names a higher credentials revision, and R2 temporary credentials from
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
  compares it with the proven-sleep record, passes admission, takes a slot, binds the database to
  it, orders PostgreSQL to execute and waits until it is ready (see Slots). It hands the gateway the
  slot's socket, uid, main PID and invocation ID in the writer table, applies the database's CPU
  quota `cpu_boost_ms` after the release (at once when that is 0; a build and a restart of the agent
  apply it at once, and a base backup that begins inside the burst applies it first), reads the hot
  list ahead and reports the phases of the wake as events; about 2 s later a `wake_detail` event adds
  the slot's origin and what the bind and the order took, the split of the start, the CPU quota's
  throttling and the steal time. A ticket that is ahead of the agent's page (a connection right
  after an idle sleep brings the generation the sleep made, and the page follows in 1 to 7 s) makes
  the agent pull that database's page at once and hold the wake for it, up to `page_wait` (8 s)
  after the gateway queued the wake (`Service::catch_up`, asked again every second): the checks
  then run against the page it has, so a ticket the page does not order is refused `desired_stale`
  as before, after the wait. A wake it already serves is answered `wake_in_progress`, which is
  no result. A start that fails writes a `unit_start_failed` event with the class of the error and
  answers `release_failed`; a slot that is awake or cannot be read at that point is stopped without a
  proof and recovered, so no database stays `starting`.
- **Sleep.** After the database's idle time, `start_concurrency` databases at a time (the idle pass
  looks at every database each five seconds, and a sleep that waits for the archive holds up none
  of the others), the agent runs the sleep proof (plan 7.9): the gateway
  quiesces and closes idle sessions, the guard refuses while a session is busy or a transaction is
  prepared (`power_busy`), a checkpoint and a WAL switch close the last segment, the upload log must
  hold it and every segment before it, and only then the postmaster stops with a fast shutdown.
  `pg_control` must then say shut down, with the recorded identity and a checkpoint after the
  switched segment, and the record is written and fsynced before the sleep is reported. A refused
  proof leaves the database running and wakeable. After a clean sleep the agent trims the volume.
- **Recovery.** At boot, after a failed proof, after an unexpected stop and after a failed start
  whose unit is awake or cannot be read, a database without a matching record is unproven: the
  agent starts it through admission, lets it archive and proves its sleep, retrying until it
  holds. Nothing is replayed to a client.
- **Create.** User, volume, filesystem, `initdb`, configuration, a check that the database's R2
  prefix is empty, the roles and the first base backup. The database is ready only when that backup
  is DONE. A create that a restart interrupted resumes when every backup in the archive belongs to the
  cluster on the volume.
- **Restore and move target.** `barman-cloud-restore` as the new database's user, recovery through
  the archive socket (`pgcf-recovery.conf`, included by `postgresql.conf` and removed afterwards),
  promotion on a later timeline with the backup's system identifier, then the first base backup of
  the new timeline. The recovery runs with the larger of the settings in the backup's `pg_control`
  and the class's (`settings::Capacity`); when that is more than the class's, the database restarts
  onto the class's own before the first backup, and a source whose settings the class has no memory
  for is refused before it starts. A recovery that PostgreSQL pauses (the source's WAL raised a
  setting above both the backup's and the class's) fails the restore with `no_recovery_point`. A
  move target replays through the segment named in the source's proven-sleep record before it may
  promote. A restore or a move target that a restart of the agent interrupted (every release
  restarts it; its state file names the generation, the build is not built) is begun again from an
  empty directory, because `barman-cloud-restore` refuses a destination that holds anything and
  the units of the earlier run outlive the agent: the agent stops the PostgreSQL of that run, stops
  the unit of its restore job if it runs (`pgcf-job-restore-<database>-<sequence>`, found with
  `systemctl list-units`), and removes the generation's data directory and its spool before the
  fetch. Only the generation being built is touched, never a served one. When the database's own
  archive already holds a DONE base backup the earlier run got that far, and the WAL this run
  archives next would replace the earlier run's under that backup, so nothing is fetched and
  nothing is removed: if the newest DONE backup has the system identifier and the timeline of the
  cluster on the volume, that cluster is the promoted database of the earlier run, and the build
  starts it, checks who it is and finishes over that backup, taking no second one (a rollout
  during a batch finds many restores in this stretch, since the listing that follows the first
  backup waits for the one big-job slot behind the other restores); any other DONE backup refuses
  the build with `prefix_not_empty`. A backup the earlier run began and did not finish (`STARTED`)
  is no reason.
- **A build that fails** (a create, a restore, a point-in-time restore or a move target, with any
  of the errors above) is abandoned once: the unit stops, the generation's volume goes, the user
  goes with the database's last volume, and the node's files of that generation go (its state and
  upload logs; a build that failed before it wrote anything of its own, because the credential of
  its archive had not arrived, leaves the files of the generation the database is served from).
  It is not begun again in this run, however often the page still names it
  (`View::abandoned_build`, keyed by the build's archive path). What follows depends on the build:
  - A create, a restore or a point-in-time restore: the API fails the operation on the report,
    refuses a `ready` report for a failed restore, and stops naming the build (no `origin`) once
    its operation failed, a create as well as a restore. The database stays in `error` until it is
    deleted; the code of that error is the build's in this run, and `volume_missing` after the
    agent restarted (every rollout of the fleet restarts it), because it finds nothing of the
    database on its disk and its page names no origin. Nothing is started either way. A create or
    a restore that a restart interrupted before any failure was reported is begun again, since the
    page still names it: a create over its cluster, a restore over an emptied data directory (see
    Create and Restore above).
  - A move target on another node: the API ends the move (`failMove`), the source serves again, and
    the target retires the staged generation through the superseded order. The database is not
    left in `error` for the customer to delete.
  - A move target on the node of its source: the page returns to the source's entry, whose
    generation is below the staged one that the agent holds, and the agent never lowers a
    generation (`Core::accept`). In this run the staged entry stays in `error` and the source is not
    served; its volume and its archive are untouched (plan 11.2).
  A build that was refused before it began (the previous storage generation is still held) wrote
  nothing and is not abandoned: the node tries it at the next pull. Meanwhile it is reported as an
  `error` (`build_failed`), and the API fails a move to the node of its source on that report
  (`progressMoves`), so for that move the next attempt does not come (plan 11.2).

  A build whose archive credential, its own or its source's, was not delivered at the pull that
  begins or resumes it has not begun either, and is not refused: it reports nothing, writes
  nothing and is tried at the next pull (`View::credential_missing_since_ms`, `Core::build`). The
  first pull after a start reads every credential of the node and resumes every build in the same
  turn, and a credential whose read failed once is read again by the next pull (seen live as
  `credential_not_delivered` on the first attempt after a deploy). After `credential_wait` (300 s)
  without it the build fails with `archive_unusable` like any build without its archive, and is
  abandoned.

  While a build runs, every pull of the page says `building` for it again, whatever the API
  holds: an entry that names an origin is awaited (`Core::report`). The API takes each of these
  reports as a sign of life of the create or restore (`running()` in `node-observations.ts`): its
  operation timeout of 20 minutes counts the time without such a report, so a restore that queues
  for the node's one big-job slot behind others is not failed while its node reports it. The
  report says that the entry is awaited and not that the build moves: a build whose task ended (a
  panic leaves `Building` for good) or whose call hangs reports `building` for ever, and the API
  ends its create or restore 24 hours after its placement (`BUILD_CEILING_MS` in `cron.ts`),
  whatever the node reports.

## Backups

PostgreSQL's `archive_command` and `restore_command` reach the agent through the archive clients
([apps/pgcf-archive](../pgcf-archive/README.md)). The agent knows the caller by the uid the kernel
reports, runs barman-cloud as that database's user in `pgcfbackup.slice` with one credential scoped
to the database's own prefix, and answers `ok` to an archive request only when the object is durably in
R2 and the segment is in the fsynced upload log. The agent never deletes in R2; retention runs in the
Worker. The concurrency and memory limits of the jobs come from the policy.

A base backup is due when the newest of the database's timeline is a day old (plan 7.6). It is taken
at the database's idle sleep, and daily for an always-warm database, never by waking one. It is put
off while a start is queued or in flight on the node, and in the first minute after any database on
the node became ready (a wake, a build, the adoption of a unit that runs), so that the first
statements of a cold database do not share the disk and the CPU with the backup of another one
(`backup_waits`, `backup_put_off` in the agent's log). The minute is node-wide because a database's
idle time is at least a minute: its own first minute is over before its own idle sleep. A database
whose idle sleep is put off is not put to sleep: nothing would wake it for the backup later. It
stays up and the next idle pass (every five seconds) asks again. Ten minutes after the first
put-off of an awake session (the wait after a failed backup) the backup is taken whatever the node
does: at the idle sleep of a database that stays idle, and, for one that is used meanwhile and so
never idles, while it serves, as the daily backup of an always-warm database is. So a database that
stays up has it within ten minutes and one idle pass of the first put-off. One case is not bounded:
an early sleep, which a wake that waits for room orders and which picks the database unused
longest, usually the one that was put off, takes no backup and ends the session with the wait; the
backup is then taken at the idle sleep after the database's next wake, which may be days away. WAL
archiving goes on meanwhile, so only the age of the newest base backup, and the WAL a restore
replays, grow. The disk side is in `pgcfbackup.slice` (`infra/node-image`): the read and write
bandwidth of the jobs on the data disk is capped. A release that lifts the cap writes `infinity` as
the size; deleting the two lines leaves a running node capped until it reboots. A runtime change
(`systemctl set-property --runtime`, such as an `infinity` or another size for a measurement on one
node) leaves a drop-in that overrides every later release of the slice until the node reboots, so
it ends with `systemctl revert pgcfbackup.slice`; the next job in the slice then applies the file.

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
  directories only, never through a link. `systemd-sysusers` and `systemd-tmpfiles --create
  --remove` run on the files that say so (`--create` alone ignores a file's `r` lines, which
  remove: `pgcf-journal.conf` removes the per-uid journal files the split left behind), systemd reads its units again once, and what changed is restarted, the
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
`storage/lab_tests.rs`, which is built only with `RUSTFLAGS='--cfg pgcf_storage_lab'`. Besides root,
LVM and loop devices, it needs PostgreSQL 18 (`PGCF_TEST_POSTGRES_BINDIR`) and a user with uid
1234 and a passwd entry. These tests exercise growth under real writes, full-volume recovery by
growth, inode exhaustion, and legacy offline growth while another namespace holds the volume.
`units/idmap_lab.rs` runs the idmapped handoff of a database's volume and socket directory into
a systemd sandbox (`units/idmap.rs`); it is built only with `RUSTFLAGS='--cfg pgcf_idmap_lab'` and
runs as root on a systemd host inside `systemd-run --wait --pipe -p PrivateMounts=yes`, the mount
namespace and propagation of `pgcf-agent.service`, where every mount is shared (its header says
how). A namespace made with `unshare --mount --propagation slave` has private mounts and hides a
clone that is still a peer of the agent's mount, so the lab refuses it.
`units/slot_lab.rs` runs the pool against the real stack (systemd, the kernel, the supervisor and a
PostgreSQL 18): a database in a pooled slot, the one-writer lock and the hole it closes, readiness
by `inotify` against the postmaster's `READY=1`, the reset of a slot's limits, the memory of idle
slots, adoption after the agent dies and after a boot, and the bind's time against the agent's
size. It is built only with `RUSTFLAGS='--cfg pgcf_slot_lab'` and runs as root on a systemd host
with the image's `pgcf-slot@.service`, `pgcf.slice`, the supervisor at
`/usr/libexec/pgcf/pgcf-archive` (a link through `/var/lib/pgcf/bin/current` to the release's
directory, as in the image: the kernel names the process's file by its real path, and the agent
knows the supervisor by the file the link leads to now) and PostgreSQL 18, inside `systemd-run --wait --pipe -p
PrivateMounts=yes <test binary> --ignored --test-threads=1 units::slot_lab` (its header says how).
`units/slot_lab/analyze.rs` is part of it: a database of each class of the catalog (256 MiB to 4 GiB) in
a pooled slot with the class's limits and its own `postgresql.conf`, tables of 100,000 rows of 8 KB that
are never toasted, of 2 KB, and of the widest row an `ANALYZE` keeps, and a manual `ANALYZE`, a `VACUUM`,
the autovacuum worker and as many `ANALYZE` at once as the class has workers plus one beside connections,
each read from the unit's cgroup every 10 ms (peak memory, the ceiling, kills, stalls). Three tables of
6,000 documents of 22 KB show what the model does not cover: a full-text index on an expression
(+152 MiB in every class), the same with the statistics of its column off (+0) and a stored generated
column (+1). It needs 8 GiB of disk and runs with the filter `units::slot_lab::analyze`.
`start_lab.rs` is the agent's start on a node with 300 databases, on the same real parts and with a
disk that is slow to flush (its header says how to run it); the numbers it gave are in the plan
(11.1, "Agent start and stop at 300 databases").

The contract with Cloudflare is `packages/contracts/src/node-link.ts`. `node_link.rs` reads its
generated JSON Schemas, and conformance tests hold the agent and the API to the same vectors.
