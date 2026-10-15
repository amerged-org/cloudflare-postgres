# Native regional gateway

This Rust gateway implements the regional WebSocket/PostgreSQL transport and lifecycle controls.
It is the gateway deployed on the EU fleet (Deployment `pgcf-gateway`). Local protocol tests do
not establish database, backup or restore acceptance; the ULTRA plan records those.

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
it ends: the database ID, a fixed `outcome` class and monotonic milliseconds `upgrade_ms`,
`startup_ms`, `dial_ms`, `first_backend_ms` and `session_ms`, null when a stage was not reached.
Roles, addresses, tokens and payload bytes are never logged.

`packages/contracts/native/generate.ts` derives native schemas, wire constants and deterministic
behavior vectors from the shared Zod contracts and TypeScript implementations. The existing
contracts test command checks the generated files. Rust tests exercise those vectors and real
loopback WebSocket/TLS connections, including lifecycle controls and fence races.

The Dockerfile uses the immutable Rust compiler from `versions.lock.json` and produces a static,
non-root scratch image. CI supplies the exact source commit. `--version` reports the compiled
source, Rust and input-lock identities without loading credentials or contacting a cluster.
Local unstamped builds report a null source revision and cannot pass release qualification.
Upstream notices and actual input-lock/schema bytes remain under `/licenses`.

Writer routing uses the authenticated Kubernetes EndpointSlice cache: one Ready
writer Pod UID, node and private IP, with PostgreSQL TLS verified against the
`database-rw.pgcf-db-<id>.svc` name. Endpoint discovery and storage-ledger watches
run outside connection handling. A Pod/volume/node/profile change or expired
physical write lease closes existing sessions and rejects new starts. Every
frontend write rechecks the cached identities and lease; uncertain SQL is never
replayed. Quiet sessions also check expiry. Healthy signed renewal preserves the
connection and ordinary power-fence history.

The kubelet reports a resumed Pod Ready up to a probe period after PostgreSQL accepts
connections. While no endpoint is Ready, the one Pod that the controller attested in the
fence's `admission_target` is the writer instead, and only on all of: the fence is running at
the revision of that target and is not retiring or deleting; the endpoint's Pod UID is the
attested one, it is not terminating, it is the only candidate, and it has one private address;
the watched Pod is on that node and address with its `postgres` container running under the
attested container ID; the watched CA is the attested one. A Ready endpoint always takes
precedence, a pool binding never falls through to it, and the route ends with the Pod watch.
Only a v4 route, which names the admitted runtime, may use such a writer; route token,
storage binding and signed authority are checked exactly as for a Ready writer.

The gateway accepts thin write authority only from the public-key map pinned by
`PGCF_STORAGE_AUTHORITY_KEYS` and its canonical SHA-256 in
`PGCF_STORAGE_AUTHORITY_KEYS_SHA256`; the private signer remains in Cloudflare.
The existing storage ConfigMap carries the token under the shared
`STORAGE_AUTHORITY_LEDGER_KEY`. It does not establish its own trust anchor.

Retained thick databases require immutable Deployment configuration in
`PGCF_GATEWAY_LEGACY_BINDINGS_JSON`: an array of the shared
`LegacyStorageBinding` contract, derived by the high-trust CF/Native patch path
from the retained assignment and actual storage identities. It binds database
ID, storage/namespace/Cluster UIDs, physical generation and exact volume
identity. The default empty array permits no legacy bypass. Changing the
regional storage ledger cannot add a legacy assignment. No customer IDs or
volume identities are compiled into the public executable.
