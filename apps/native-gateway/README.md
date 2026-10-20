# Native gateway

This Rust gateway runs on every node beside the node agent and carries the node's PostgreSQL
traffic: WebSocket connections and HTTP SQL from the Edge, through cloudflared (ULTRA plan 5.7).
Local protocol tests do not establish database, backup or restore acceptance; the ULTRA plan
records those.

## Configuration

`PGCF_REGION_ID`, `PGCF_NODE_ID`, the node's derived `PGCF_ROUTE_KEY`, `PGCF_GATEWAY_PORT`,
`PGCF_GATEWAY_MEMORY_BYTES`, `PGCF_GATEWAY_DATABASE_MEMORY_BYTES` and `PGCF_AGENT_SOCKET`
(default `/run/pgcf/agent/gateway.sock`). The gateway listens on `127.0.0.1:PGCF_GATEWAY_PORT` only, for
cloudflared. It holds no provider credentials and no PostgreSQL credentials of its own.

## The agent's table

The gateway's writers are the node agent's table, which the agent sends over its local channel
(`PGCF_AGENT_SOCKET`; the messages are `pgcf_native_protocol::agent`, one JSON object per line).
Only the gateway's user may connect to that socket; the databases reach the agent on its separate
archive socket.

- The agent sends its whole table first and then every change. Each database names its generation
  and operation, its route revision, its mode (`running`, `quiesce`, `sleeping`, `retired`) and,
  while PostgreSQL runs, its unit: the Unix socket, the database's uid, the unit's main PID and the
  unit's invocation ID.
- A route is admitted only on a running unit, and only as a v6 route made for this node (its
  key is derived for the node, and the route names it) whose generation, route revision and
  instance (the unit's invocation ID) are the table's. The dial is the database's socket; the
  connection is kept only when the kernel's peer credentials are the unit's uid and main PID.
  Nothing is written to any other process, and a failed check logs the outcome `peer_mismatch`.
- The agent's `control` requests are `begin` (quiesce), `close` (close idle sessions with 1000
  "database sleeping") and `status`, each for a generation, answered with the session counts.
  `activity` answers the gateway's measurements of a database.
- Without the channel the gateway admits nothing new and releases no wake, and `/readyz` answers
  503; established sessions keep their unit, which only the agent stops. A database the next table
  leaves out, or the agent removes, closes its sessions. The agent's first message on every channel
  is its table.

## Connections

- Cloudflare signs single-use, short-lived route tokens for the node. The original StartupMessage
  and authentication bytes pass through unchanged; database and role must match the token before
  any byte reaches PostgreSQL. The dial begins with the admission, so it overlaps the client's own
  round trips.
- A connection or request is admitted on the database's running unit and keeps that admission for
  as long as the table shows the database running on that unit. An entry the agent publishes again
  for the same unit, such as the page that carries Cloudflare's claim of a wake moving the route
  revision, interrupts nothing, and a wake that was released is admitted under the revision of its
  release or a later one. While a database quiesces, no client byte reaches PostgreSQL: it waits,
  and runs once the database runs again; an HTTP request that finds the database quiescing,
  asleep or retired before its first statement answers `57P03` with nothing written to
  PostgreSQL. Quiescence includes partial WebSocket and PostgreSQL messages, authentication,
  outstanding queries, transactions and COPY. A unit that changes (another PID, socket or
  invocation ID) closes its sessions with 1012 and is never written to.
- Masked-frame lengths reserve memory before decoder allocation. Fragment and decoded-message
  charges remain owned until forwarding or closure. Startup buffering is bounded separately;
  ordinary messages support the existing 32 MiB limit and outbound frames are at most 64 KiB.
  Authenticated activity history preserves unknown/partial values and never invents zero usage.
- There is no PostgreSQL write retry, credential replay or query replay after transport handoff.

## Wakes

A v5 route is the Edge's wake ticket for a sleeping database: the operation and generation the
wake claims, the admission route revision and the hash of the role revisions. The gateway checks
its `cid` against the replay cache, answers the upgrade at once, answers SSLRequest, and reads and
checks the StartupMessage, which it holds with whatever the client sends behind it; nothing is
dialled. It keeps one ticket per database (a higher generation replaces it), at most 32 held
connections per database and 512 in total, refused with HTTP 429 or 503 before the upgrade.

The gateway sends the agent the wake before it answers the upgrade (`wake`, again after 3 s
without a result). The release is the table entry that shows the unit running at the ticket's
generation and operation, at the ticket's route revision or a later one. The connection is then
routed as the route of that unit; a ticket the table has already released is routed at once.
The agent's `wake_result` is `started` or `refused`; a refusal, 25 s without release, or a table
that moves past the ticket answer FATAL 57P03; a draining gateway and a failed dial answer 08006.
A refusal for want of room carries the DETAIL "storage", one for awake capacity the DETAIL "node
at awake capacity" and the HINT "retry after <n> s" (the agent's retry hint), on a WebSocket and
in the JSON error of HTTP SQL alike; the other reasons answer the 57P03 alone
(`refusalFields` of `packages/contracts/src/node-local.ts`).
The reason `wake_in_progress` is no result: the agent already serves that wake, so the held
connections keep waiting for the answer of the first delivery and the ticket is delivered again
after 3 s (`WAKE_AGAIN_REASON`).

## Logs

Every connection that passes route verification logs one `conn_stages` JSON line to stdout when
it ends: the database ID, a fixed `outcome` class, monotonic milliseconds `upgrade_ms`,
`startup_ms`, `dial_ms`, `first_backend_ms` and `session_ms`, null when a stage was not reached,
and `wake_path`: `warm` when the route was admitted on the running unit when the connection
arrived, `cold` when the connection was held for its wake, null when it was refused before
either. A held wake adds `held_outcome`, `wake_wait_ms` (upgrade to release), and the agent's
`wake_reason` and `agent_ms` once its result arrived. Roles, addresses, tokens and payload bytes
are never logged.

A connection held for a wake (`wake_path` `cold`) also sends its marks to the agent on the channel
when it ends, as the message `conn_stages` (`FromGateway::ConnStages`): the database ID, the
`outcome`, `held_outcome` and `wake_reason` tokens and the milliseconds it reached, without
`agent_ms` (the agent has its own steps in its `wake` event). The agent logs them as the event
`conn_stages`, which reaches Cloudflare in an observation report. The marks wait in a queue of 64
of their own and are dropped when it is full; no connection ever waits for them. The channel's
writer takes a mark only when no wake or answer waits, so the marks delay neither. HTTP SQL
requests send none.

## HTTP SQL

`POST /sql` (`src/sql.rs`) serves the Neon driver's HTTP query mode for the Edge. It checks the
same single-use route token and unit as a connection, holds a wake ticket's request as a held
connection is held, and runs the request (one statement, or a transaction between `BEGIN` and
`COMMIT`) as one extended-protocol pipeline. Its PostgreSQL sessions are authenticated with
SCRAM-SHA-256 using the password the Edge forwards in the request body; the password is wiped
after use and never logged or stored. A session is kept after `DISCARD ALL` for at most 10 s idle
and 60 s in all, reused only for a password that derives its SCRAM StoredKey, and closed by the
agent's actions like any idle session. Statement bytes are never resent: a session lost after the
write answers `08007`. Each request logs one `sql_stages` line with the database ID, a fixed
`outcome`, `pooled`, `wake_path` (`warm`, `cold` or null, as for a connection), the statement
count and `dial_ms`, `auth_ms`, `query_ms` and `request_ms`; roles, statements, parameters and
passwords are never logged.

## Tests and contracts

`packages/contracts/native/generate.ts` derives native schemas, wire constants and deterministic
behavior vectors from the shared Zod contracts and TypeScript implementations. The existing
contracts test command checks the generated files. `tests/transport.rs` and `tests/sql.rs` run
real loopback WebSocket and HTTP connections against a PostgreSQL double that the test process
serves on a Unix socket as the unit. `tests/local.rs` runs the gateway against a real PostgreSQL 18
that the test starts (`PGCF_TEST_POSTGRES_BINDIR`, see `packages/test-postgres`), with the test as
the agent on its channel.

`--version` reports the compiled source, Rust and input-lock identities without loading
credentials. Local unstamped builds report a null source revision.
