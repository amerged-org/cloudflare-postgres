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
