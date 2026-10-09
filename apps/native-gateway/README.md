# Native regional gateway

This Rust gateway implements the existing regional WebSocket/PostgreSQL transport and lifecycle
controls. The deployed TypeScript gateway remains authoritative until the Rust image passes the
same Dev acceptance. Local protocol tests do not establish database, backup or restore acceptance.

The production entry point uses the same `PGCF_REGION_ID`, derived `PGCF_ROUTE_KEY`,
`PGCF_GATEWAY_POD_UID`, `PGCF_GATEWAY_PORT`, `PGCF_GATEWAY_MEMORY_BYTES` and
`PGCF_GATEWAY_DATABASE_MEMORY_BYTES` configuration. It reads only the projected Kubernetes
ServiceAccount token and CA; its existing read-only ConfigMap permissions are sufficient.
The gateway has no Contabo credentials or provider dependency.

- Cloudflare signs single-use, short-lived regional route tokens. The original StartupMessage
  and authentication bytes pass through unchanged; database and role must match the token before
  any PostgreSQL dial. PostgreSQL TLS verifies the database CA and exact service DNS name.
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
