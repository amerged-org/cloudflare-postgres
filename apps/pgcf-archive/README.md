# Archive clients

`pgcf-archive` and `pgcf-wal-fetch` are the small static clients a database's PostgreSQL runs to
reach the node agent's archive socket (ULTRA plan 7.5 and 7.8). They have no dependencies beyond
the Rust standard library and hold no credential; the agent knows the database by the uid the
kernel reports for the connection and runs barman-cloud as that database's user.

| Client | PostgreSQL setting | Exit status |
| --- | --- | --- |
| `pgcf-archive` | `archive_command = '/usr/libexec/pgcf/pgcf-archive %p'` | 0 only when the agent answered that the segment is durable in R2 and in its upload log; 1 otherwise, and PostgreSQL retries |
| `pgcf-wal-fetch` | `restore_command = '/usr/libexec/pgcf/pgcf-wal-fetch %f %p'` | 0 when the agent restored the file; 1 when the archive does not hold it (the end of the archived WAL); 255 for any failure, which aborts the recovery instead of ending it early |

The socket is `/run/pgcf/agent/archive.sock`, or `PGCF_AGENT_ARCHIVE_SOCKET` in PostgreSQL's
environment. A request is one line, `pgcf-archive/1 archive <WAL file>` or
`pgcf-archive/1 fetch <WAL file> pg_wal/<destination>`, and the answer one line, `ok`, `missing`
or `failed [reason]`; the agent answers within 60 s and a client waits at most 70 s. The crate's
library holds the protocol for the agent's side.

The tests run both clients under a real PostgreSQL 18 (`PGCF_TEST_POSTGRES_BINDIR`): archiving
only after the agent's `ok`, recovery of a base backup through the agent, and an aborted recovery
that completes once the agent can fetch again.

## Slot supervisor

`pgcf-archive slot <n>` is the same binary in a second role (a separate binary would change the
signed release's set of files): the supervisor that waits in the idle PostgreSQL sandbox
`pgcf-slot@<n>.service` as the slot's own user, with no capability, until the node agent orders
the start of one database (the slot pool of ULTRA plan 3.1; the slot unit and the agent's side are
separate changes, so nothing starts this mode yet). It listens on `$RUNTIME_DIRECTORY/control`,
reports `READY=1` to systemd, and answers only a peer whose uid is 0, one line per connection:

| Line | Answer |
| --- | --- |
| `ping` | `pgcf-slot/1 idle` |
| `exec <database> <major>` | `exec <CLOCK_MONOTONIC microseconds>`, then it replaces itself with the command line of `ExecStart=` in `pgcf-pg@.service` |
| anything else, or a failed check | `refused order`, `id`, `major`, `unbound`, `held` or `lock`, then exit status 1 |

The agent sends `exec` after it set the database's limits on the slot and mounted the volume and
the socket directory into it. The supervisor opens `/var/lib/pgcf/db/<database>/data` without
following a link and checks that this directory and `/run/pgcf/<database>` belong to its own uid
(the proof that the mounts are in place), takes `flock(LOCK_EX | LOCK_NB)` on the data directory
and keeps that descriptor across the exec. PostgreSQL's own guard against a second postmaster does
not hold between two uids (`kill(pid, 0)` fails with `EPERM`, which `miscinit.c` reads as a stale
`postmaster.pid`, and `shmget` fails with `EACCES`, which `sysv_shmem.c` reads as a foreign
segment), so this lock is the guard: PostgreSQL and its backends inherit it, and it lasts until
the last process of the slot has ended. A second supervisor on the same directory gets
`refused held`. The supervisor never forks, mounts or accepts a second order; after a refusal or
a failure the slot is not used again.

The tests run the supervisor as a real process (the test program starts itself again, because a
process that execs cannot run inside a test). They exec a script in place of PostgreSQL to show
the lock surviving the process that took it, and, with `PGCF_TEST_POSTGRES_BINDIR`, a real
PostgreSQL 18 as the target.
