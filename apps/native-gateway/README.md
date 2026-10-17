# Native regional gateway

This Rust gateway implements the regional WebSocket/PostgreSQL transport and lifecycle controls.
Its Kubernetes routing (EndpointSlice, Pod and ConfigMap watches, pool-slot targets) stays until
gateway local mode replaces it in Stage 3 of the ULTRA plan; it is not deployed while the node
runtime is rebuilt. Local protocol tests do not establish database, backup or restore acceptance;
the ULTRA plan records those.

## Local mode

`PGCF_GATEWAY_MODE=local` runs the gateway on a node beside the node agent (ULTRA plan 5.7). It
listens on `127.0.0.1:PGCF_GATEWAY_PORT` only, for cloudflared, and needs no Kubernetes identity
or permission. Its writers are the agent's table, which the agent sends over its local channel
(`PGCF_AGENT_SOCKET`, default `/run/pgcf/agent/gateway.sock`; the messages are
`pgcf_native_protocol::agent`, one JSON object per line). Only the gateway's user may connect to
that socket; the databases reach the agent on its separate archive socket.

- The agent sends its whole table first and then every change. Each database names its generation
  and operation, its route revision, its mode (`running`, `quiesce`, `sleeping`, `retired`) and,
  while PostgreSQL runs, its unit: the Unix socket, the database's uid, the unit's main PID and the
  unit's invocation ID.
- A route is admitted only on a running unit, and only as an admission route (v4) whose
  generation, route revision and `pod` (the unit's invocation ID, until the route version that
  names node and instance replaces v4) are the table's. The dial is the database's socket; the
  connection is kept only when the kernel's peer credentials are the unit's uid and main PID.
  Nothing is written to any other process, and a failed check logs the outcome `peer_mismatch`.
- A wake ticket (v5) is held as in Kubernetes mode; the gateway sends the agent the wake before it
  answers the upgrade (`wake`, again after 3 s without a result). The release is the table entry
  that shows the unit running at the ticket's generation and operation; a `wake_result` labels
  the connections or refuses them with 57P03.
- The agent's `control` requests replace the controller's control port: `begin` (quiesce),
  `close` (close idle sessions with 1000 "database sleeping") and `status`, each for a generation,
  answered with the session counts. `activity` answers the gateway's measurements of a database.
- Without the channel the gateway admits nothing new and releases no wake; established sessions
  keep their unit, which only the agent stops. A database the next table leaves out, or the agent
  removes, closes its sessions. The agent's first message on every channel is its table.

The tests in `tests/local.rs` run this mode against a real PostgreSQL 18 that the test starts
(`PGCF_TEST_POSTGRES_BINDIR`, see `packages/test-postgres`), with the test as the agent.

The production entry point is configured through `PGCF_REGION_ID`, the derived
`PGCF_ROUTE_KEY`, `PGCF_GATEWAY_POD_UID`, `PGCF_GATEWAY_PORT`, `PGCF_GATEWAY_MEMORY_BYTES` and
`PGCF_GATEWAY_DATABASE_MEMORY_BYTES`. It reads only the projected Kubernetes ServiceAccount
token and CA, and its Kubernetes permissions are read-only: ConfigMaps in `pgcf-system`,
EndpointSlices and, for the v4 route, Pods. The gateway has no Contabo credentials or provider
dependency.

- Cloudflare signs single-use, short-lived regional route tokens. The original StartupMessage
  and authentication bytes pass through unchanged; database and role must match the token before
  any PostgreSQL dial. A v3 token also names the database generation and the verified primary
  Pod, and a v4 token the admission route revision; the gateway compares them with its persisted
  running fence and refuses a stale revision or another Pod. PostgreSQL TLS verifies the
  database CA and exact service DNS name.
- An authenticated Kubernetes list/watch maintains persisted fences, revisions and ConfigMap
  identities. Missing synchronization, identity replacement or invalid history blocks admission.
  Per-database epochs avoid interrupting unrelated startup work. Quiescence includes partial
  WebSocket and PostgreSQL messages, authentication, outstanding queries, transactions and COPY.
  Retirement requires the existing hold and actual zero sessions before fence removal.
- Masked-frame lengths reserve memory before decoder allocation. Fragment and decoded-message
  charges remain owned until forwarding or closure. Startup buffering is bounded separately;
  ordinary messages support the existing 32 MiB limit and outbound frames are at most 64 KiB.
  Authenticated activity history preserves unknown/partial values and never invents zero usage.

Only certificate failures before the first StartupMessage permit one CA refresh and TLS redial.
There is no PostgreSQL write retry, credential replay or query replay after transport handoff.
Cancelled consumers cannot cancel a shared CA read or strand its bounded cache entry.
A failed session still ends PostgreSQL TLS with close_notify, unless TLS records are still queued.

Every connection that passes route verification logs one `conn_stages` JSON line to stdout when
it ends: the database ID, a fixed `outcome` class, the fixed `route` class of the writer it was
admitted on (`ready` for a Ready endpoint, `attested` for the controller's attested Pod before the
kubelet's report; null before a writer was chosen) and monotonic milliseconds `upgrade_ms`,
`startup_ms`, `dial_ms`, `first_backend_ms` and `session_ms`, null when a stage was not reached,
and `wake_path` (`warm`, or for a held wake `pool_hit` when it was released to a pool slot and
`pool_miss` otherwise). A held wake adds `held_outcome`, `wake_wait_ms` (upgrade to release), and
the controller's `miss_reason` and `controller_ms` once its result arrived.
Roles, addresses, tokens and payload bytes are never logged.

`POST /sql` (`src/sql.rs`) serves the Neon driver's HTTP query mode for the Edge. It checks the
same single-use route token, fence, revision and writer as a connection, holds a wake ticket's
request as a held connection is held, and runs the request (one statement, or a transaction
between `BEGIN` and `COMMIT`) as one extended-protocol pipeline. Its PostgreSQL sessions are
authenticated with SCRAM-SHA-256 using the password the Edge forwards in the request body; the
password is wiped after use and never logged or stored. A session is kept after `DISCARD ALL` for
at most 10 s idle and 60 s in all, reused only for a password that derives its SCRAM StoredKey,
and closed by fence actions like any idle session. Statement bytes are never resent: a session
lost after the write answers `08007`. Each request logs one `sql_stages` line with the database
ID, a fixed `outcome`, `pooled`, `wake_path`, the statement count and `dial_ms`, `auth_ms`,
`query_ms` and `request_ms`; roles, statements, parameters and passwords are never logged.

`packages/contracts/native/generate.ts` derives native schemas, wire constants and deterministic
behavior vectors from the shared Zod contracts and TypeScript implementations. The existing
contracts test command checks the generated files. Rust tests exercise those vectors and real
loopback WebSocket/TLS connections, including lifecycle controls and fence races.

`--version` reports the compiled source, Rust and input-lock identities without loading
credentials or contacting a cluster. Local unstamped builds report a null source revision.

Writer routing uses the authenticated Kubernetes EndpointSlice cache: one Ready
writer Pod UID, node and private IP, with PostgreSQL TLS verified against the
`database-rw.pgcf-db-<id>.svc` name, on the node of the database's volume. Endpoint, Pod and
ConfigMap watches run outside connection handling. A writer Pod, address, node, container or CA
change closes existing sessions and rejects new starts. Every frontend write rechecks the cached
identity; uncertain SQL is never replayed. One writer per volume is the controller's and the
node attach agent's rule (the holder file and CNPG hibernation), not the gateway's: the gateway
needs no storage token, and a thin database routes exactly as a thick one.

The kubelet reports a resumed Pod Ready up to a probe period after PostgreSQL accepts
connections. While no endpoint is Ready, the one Pod that the controller attested in the
fence's `admission_target` is the writer instead, and only on all of: the fence is running at
the revision of that target and is not retiring or deleting; the endpoint's Pod UID is the
attested one, it is not terminating, it is the only candidate, and it has one private address;
the watched Pod is on that node and address with its `postgres` container running under the
attested container ID; the watched CA is the attested one. A Ready endpoint always takes
precedence, and the route ends with the Pod watch.
Only a v4 route, which names the admitted runtime, may use such a writer; the route token is
checked exactly as for a Ready writer.

That attestation is for the wake. It is spent once this gateway has seen the attested Pod's
endpoint and `postgres` container reported Ready: for that Pod, container and revision only the
ordinary rules apply from then on, so a later not-Ready Pod refuses new connections and closes
established sessions as any writer does. It also ends 10 s (the startup bound of a connection)
after the gateway first relied on it, which covers a Pod the kubelet never reports Ready and a
gateway that started after the report was withdrawn; the kubelet's report routes the Pod as a
Ready endpoint again. A new attestation (another Pod, container or revision) starts again. A
session admitted on the attestation is closed, not drained, when the fence leaves `running` or
the container is restarted before the kubelet's report. `/readyz` requires the Pod watch, the
one that recognizes such a writer, beside the fence, EndpointSlice and ConfigMap watches.

A v5 route is the Edge's wake ticket for a sleeping database: the operation and generation the
wake claims, the admission route revision and the hash of the role revisions. The gateway checks
its `cid` against the replay cache, answers the upgrade at once, answers SSLRequest, and reads and
checks the StartupMessage, which it holds with whatever the client sends behind it; nothing is
dialled. It keeps one ticket per database (a higher generation replaces it), at most 32 held
connections per database and 512 in total, refused with HTTP 429 or 503 before the upgrade. The
controller takes the tickets with `POST /_pgcf/gateway/wakes`, signed for this Pod (`x-pgcf-wake`,
`gw1`), answered at once or with an empty list after 20 s, at most four polls at a time; a ticket
without a result is delivered again after 3 s. It answers each with `POST
/_pgcf/gateway/wake-result`: `hit` and `miss` label the connections, `refused` ends them. The
release is the fence: running at the ticket's generation and operation with an admission target
of that generation and route revision whose Pod is the writer. The connection is then routed as
the v4 route of that target; a ticket the fence has already released is routed at once. A
refusal, 25 s without release, or a fence that moves past the ticket answer FATAL 57P03; a
draining gateway and a failed dial answer 08006.

The admission target may name the Service of a pool slot, `database-rw.pgcf-slot-<8 hex>.svc`. The
writer is then that slot's Pod in its own namespace, under the same attestation rules: the
controller holds the database's volume for the slot. A slot no fence names
belongs to no database. A gateway release older than the pool fails its discovery on slot Pods, so
rolling the gateway back requires deleting every `pgcf-slot-*` namespace first.
