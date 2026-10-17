# Existing-account installation

Follow the canonical [ULTRA delivery plan](../architecture/cloudflare-convergence-and-serverless-plan.md)
and record measured completion there. The deployment is EU only, with customer EU1, a Contabo
Cloud VPS with 6 vCPU and 12 GB RAM. The Kubernetes runtime was retired on 2026-10-17; the Debian
node image, the node agent and the pull installer are built in Stage 3 of the plan, and EU1 is
installed from that image in Stage 4. Use Contabo only at provider lifecycle boundaries. A future
real expansion uses the configured threshold/purchase policy.

## Reviewed deployment inputs

Use a source commit that passed the common CI checks.

Keep the private API configuration outside Git. It supplies D1, region-specific R2 bindings,
RegionLink/DatabaseActor/CronWatchdog Durable Objects and the AddNode and InfrastructureBackup
Workflows. Start from `apps/api/wrangler.example.jsonc`; replace every placeholder. Import secret
values from private custody and preserve the existing four root secrets. Export D1 before applying
additive migrations and rehearse them against the export.

The EU archive uses the EU-jurisdiction binding and EU S3 endpoint. Every other region has a
separate bucket on the account's general S3 endpoint. Choose that region's location hint when
creating its bucket; the hint does not guarantee jurisdiction. `ARCHIVE_BINDINGS` must map each
exact region ID to its actual Worker binding and bucket. A mismatching or missing binding fails
closed.

Route tokens are versioned. The Edge signs a token that the gateway verifies before it dials
PostgreSQL.

## Edge Worker

The deployed Edge Worker is the TypeScript `apps/edge`; the management API and DatabaseActor stay
in TypeScript. Start the private deployment configuration from `apps/edge/wrangler.example.jsonc`
and preserve the existing Worker name, hostname, DatabaseActor binding, rate-limit namespaces,
regional VPC/service bindings and `ROUTE_MASTER_KEYS` secret.
The example also sets `minify: true`, a `BINDING_CONNECTION_RATE_LIMITER` rate limit with a
namespace of its own for same-account Workers on a service binding (without it every such caller
is refused with `53300` "connection admission unavailable"), and `DATABASE_ACTOR_LOCATION_HINT`,
which must equal the API Worker's value; the hint places only DatabaseActor objects created after
it is set.

The Rust/Wasm replacement lives in `apps/edge-rust`. The common CI workflow builds it; it is not
deployed. Build the selected source once using the Rust toolchain and `rustEdge` tools from
`infra/platform/versions.lock.json`. Verify the pinned tool archives and exact members before
using `WASM_BINDGEN_BIN`, `WASM_OPT_BIN` and `ESBUILD_BIN`. The common CI workflow performs this
preparation.

`pnpm --filter @pgcf/edge-rust build` creates `build/index.js`, `build/index_bg.wasm`
and the compatibility entry `build/worker/shim.mjs`. Preserve their checksums and upstream
notices with the release artifact. `pnpm --filter @pgcf/edge-rust test` loads those already
built bytes in real local workerd instances with the actual DatabaseActor, D1, rate-limit
and Fetcher bindings; it does not rebuild the Worker. Local fixtures prove binding and
protocol behavior. They do not replace Dev PostgreSQL/TLS and VPC transport acceptance.

Start the replacement's private configuration from `apps/edge-rust/wrangler.example.jsonc`;
it has the same bindings and secret as the TypeScript example. The example intentionally has no
custom build command: delivery uses the qualified artifact instead of compiling again. Do not
activate the replacement until the selected bytes pass Dev database acceptance. Record the
actual Worker version and result in the ULTRA plan.

Both editions return the unopened upstream WebSocket directly to Cloudflare. PostgreSQL bytes
are not relayed through a TypeScript or Wasm application loop. Only bounded local refusal sockets
parse their own startup/SCRAM exchange. Request aborts and the absolute admission deadline cancel
the exact Actor waiter; a cancellation never retries the gateway connection or application SQL.

## Operator-configured capacity and optional notifications

The live node ceiling is removed (`max_nodes:null`) and no capacity-mail credentials or
recipient are configured. Purchases and autoscale stay off; enabling them, or any new paid
resource, needs the owner's explicit, costed go.

Management is API-only and requires an administrator key; an integrator's project key does not
control infrastructure purchases. Read `GET /v1/regions/{id}/capacity-policy`, then PUT the
intended complete policy to the same route. Existing fields retain their documented
full-replacement semantics; omitting newly added settings or `max_nodes` preserves stored values
for existing callers. Explicit `null` removes an optional value. No large sentinel count
represents an absent limit.

| Setting | Meaning |
| --- | --- |
| `ram_expansion_threshold_ppm` | Required actual-RAM threshold for automatic paid expansion;760000 means76%. Fresh policy is null/unconfigured. |
| `autoscale_enabled` | Enables automatic capacity selection, including configured adoption; false by default. |
| `purchases_enabled` | Permits purchase authorization/first dispatch; false by default. Automatic buying requires both switches and a complete configured order/authority. |
| `max_nodes` | Optional managed-allocation ceiling; null removes it. No fixed three-node limit is imposed. |
| `ram_warning_threshold_ppm` | Optional mail/webhook warning threshold; null disables this warning. |
| `node_ram_warning_threshold_ppm` | Optional warning when any node's own ten-minute RAM window reaches it; null disables it. |
| `node_cpu_warning_threshold_ppm` | Optional warning when any node's ten-minute average CPU usage reaches it against node CPU capacity; null disables it. Needs a reporter that sends the CPU sample fields: the node agent (Stage 3). Otherwise CPU stays unknown. |
| `node_storage_warning_threshold_ppm` | Optional warning when any node's fresh LVM sample reaches it: thin-pool data or metadata fill, otherwise volume-group allocation; null disables it. |
| `cap_warning_enabled` | Opt-in notice for an operator-selected finite cap; false by default. |

The configured RAM threshold applies to automatic new paid orders in both placement modes.
Retain ten fresh aligned consecutive minutes for every eligible customer node, each with stable
physical Node UID and capacity. Sum actual working-set bytes against physical bytes. Unknown or
unaligned capacity is not zero; an empty newly admitted spare must prevent repeated expansion
from an old hot node. Keep one active regional addition and revalidate current policy and pressure
before first dispatch. Policy changes invalidate stale undispatched approval while retaining the
same intent and ledger charge. Once a provider write is recorded or uncertain, reconcile its
saved request identity through reads, even if the threshold or purchase switches subsequently
change. Never repeat an uncertain order. Adoption of already allocated nodes and explicit manual
costed orders remain distinct paths.

Operators configure an exact `order` (`product_id`, `provider_region`, `image_id`, `term_months`,
`location`, and any explicitly selected add-ons) and their own standing authority. New generic RAM
profiles use `trigger:"regional_actual_ram"`; old serialized `ram_76_percent` authorities remain
readable. Profiles bind the exact order, owner reference, approval time and optional monetary,
order-count and expiry limits. Unknown prices stay null, never zero or an invented provider quote.
This installation's owner selects V159, one month, no add-on and760000PPM; those are installation
settings, not fixed product requirements. Provider credentials are protected operator secrets.
Fresh adopters receive neither these credentials nor this owner's purchase authority.

The retained EU placement settings remain actual RAM,256MiB assignment steps, maximum4096MiB
and the reviewed128MiB PostgreSQL request. Changing placement mode or the PostgreSQL request
requires an empty live cohort or complete current-generation manual suspension with no unsettled
starts. Preserve database/volume/role/custody identities and resume through fresh full-peak startup
admission. Threshold, optional-cap and notification changes do not reset databases. If an operator
selects a finite cap, count control nodes, lost paid allocations and unpaid reservations; recovery
on the same provider allocation does not consume another slot.

Email is opt-in. Configure a warning policy plus `INFRASTRUCTURE_ALERT_WEBHOOK` (service Fetcher)
or `INFRASTRUCTURE_ALERT_WEBHOOK_URL`, authenticated with the private
`INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN`. A Fetcher takes precedence; never try a second destination
after an uncertain response. The adopter's receiver owns its explicit sender, recipient and mail
provider key, for example Resend. PGCF has no hardcoded recipient or mandatory mail vendor.
Missing delivery configuration sends nothing and does not block capacity decisions.

Warning events use stable IDs and stored payloads; receivers must retain event/payload dedupe
beyond provider idempotency windows. Explicitly disabling a warning deactivates pending episodes
even when RAM is unknown; delivery also checks current policy. Unknown measurements alone do not
rearm an enabled warning. Operational health records callback acceptance; provider acceptance
and actual delivery are separate evidence.

## API-only resource profiles and regional configuration

These management routes are API-only; no PGCF administration UI is part of the product.

| Route | Purpose |
| --- | --- |
| `PUT /v1/resource-profiles/{id}` | Create an immutable resource revision using `expected_revision` and `resources` |
| `GET /v1/resource-profiles/{id}/revisions/{revision}` | Read the exact resource snapshot, generated size-class ID and SHA256 |
| `PUT /v1/databases/{id}/resource-profile` | Assign `profile_id` and `profile_revision` using the database's `expected_generation` |
| `GET /v1/databases/{id}/resource-profile` | Read the selected/target revision and actual application state |
| `PUT /v1/resource-profiles/{id}/rollout` | Select `profile_revision` for all databases currently assigned to that profile; `expected_revision` is the previous rollout target, or0 before its first selection |
| `GET /v1/resource-profiles/{id}/rollout` | Read assigned, applied, deferred and pending counts |
| `GET/PUT /v1/regions/{id}/configuration` | Read/change the gateway URL and binding through configuration-hash CAS; the route must end in `/pg` |
| `GET /v1/nodes/{id}/storage` | Read a fresh identity-bound physical LVM observation, or `sample:null` when unavailable |

Profile creation, rollout selection and regional configuration require administrator scope.
Database assignment retains project authorization. Use `Idempotency-Key` for mutations and retain
returned operation IDs. An immutable profile revision cannot be changed through the size-class API.
An enabled revision may be selected for rollout; creating a revision alone does not promote it.
The existing cron processes at most eight assignments per invocation and resumes through existing
configuration generations and database operations. Capacity conflicts leave the current desired
state intact for retry; they are not successful application.

PostgreSQL CPU request and hard CPU limit are separate fields. An omitted request equals the
limit. Use qualified resource values; a smaller request does not prove workload density or
remove PostgreSQL/Barman startup checks. Memory remains the PostgreSQL memory limit, with
backup/system overhead reported separately.

A confirmed sleeping database accepts future compute configuration while remaining suspended.
It retains zero active CPU charge while it sleeps. `deferred_until_wake` explicitly means
that no running PostgreSQL has yet proved the new settings. The next wake reacquires fresh hard
CPU/RAM startup admission and must report current configuration readiness before `applied:true`.
An uncertain stop or degraded observation is pending. A newer resource revision supersedes an
unfinished older resize explicitly; stale observations cannot acknowledge the current revision.

Node installation from capacity to Ready is rebuilt as the pull installer
([plan 9.2](../architecture/cloudflare-convergence-and-serverless-plan.md#92-installing-a-node-on-contabo-no-relay-no-ssh)),
built in Stage 3.

Use only the confirmed V159 offer (150 GiB NVMe, no storage add-on) and its reviewed costs for the
standing purchase policy. Do not select a V155 NVMe add-on
(`addOns.extraStorage.nvme`): the one test allocated an 8 vCPU, 24 GiB RAM, 600 GiB SSD server
and not the NVMe variant. Do not repeat that test; EU additions follow the configured purchase
policy.

## Customer migration handover

Moving an integrator's existing databases into PGCF is the integrator's task and a separate
reviewed cutover.

Inventory source region, roles/grants/extensions, sequences, pools, timeouts and sizing. Resource
classes are configured through the management API in 256 MiB PostgreSQL increments, with an
operator maximum of 4 GiB. A limit is not a permanent physical reservation. Actual-RAM placement,
sleeping CPU release and thin physical storage must be measured together with hard startup and
backup-peak admission; the density test in the ULTRA plan records the result. RAM overbooking does not remove CPU, storage or startup checks:
approve sufficient regional capacity before committing an integrator's databases to a region.

### Connection and cold starts

PGCF’s public transport is verified WSS; a TCP DSN hostname swap is insufficient. Use the
established Neon serverless `Pool`/`Client` WebSocket mode with its default
`pipelineConnect: "password"` and a `wsProxy` URL containing `/v2?database=<URL-encoded-PGCF-ID>&user=<URL-encoded-role>`; see
[the connection contract](../../README.md). Keep PostgreSQL authentication and TLS. Hints scope
admission; they are not credentials.

For psql and logical export/import tools, use the existing CLI:

```sh
node packages/cli/dist/main.js connect --endpoint wss://db.example.com --database <pgcf-id> --user <role>
```

Use the printed loopback port, target PGCF ID and role. `sslmode=disable` applies only to
loopback; public WSS and gateway-to-PostgreSQL TLS remain verified. Keep passwords private;
never expose a VPS database port.

Cold-wake latency on the Debian node runtime is measured in Stage 5 of the ULTRA plan. A client
connect timeout shorter than the wake can fail before the database is awake. Query and statement
timeouts are separate from the end-to-end request deadline; budget wake plus work explicitly.
Until that measurement passes, verify one fallback policy before cutover: an approved always-warm
size class (`sleep_after_seconds:null`); prewake with `POST /v1/databases/{id}/resume`,
operation/readiness polling and `SELECT 1` immediately before traffic; or bounded
connection/request deadlines covering measured wake plus query/network margin. SQL statement
timeouts are separate and do not fix shorter connection timeouts. Never retry uncertain writes.

### Create, restore and rebind

Use the authorized project-scoped integrator key, persistent mutation `Idempotency-Key`s and
existing API contracts:

- `POST /v1/databases` with `{project_id,region_id,name,size_class_id}`; save the new database and
  operation IDs. Poll `GET /v1/operations/{id}` and `GET /v1/databases/{id}`.
- `POST /v1/databases/{id}/roles` with `{"name":"<role>"}`; await role readback, then obtain
  `GET /v1/databases/{id}/roles/{role}/connection-uri`. Only integrator responses include the
  password; save them privately. Administrator responses cannot supply an application password.
  The body may also carry `valid_until`, `connection_limit`, `member_of` and `bypass_rls`.
  `DELETE /v1/databases/{id}/roles/{role}` makes a role unroutable at once and returns an
  operation that ends when PostgreSQL has dropped it; both need an `Idempotency-Key` and are
  described in the [integrator handover](integrator-handover.md#23-roles-connection-uri-and-passwords).
- PGCF archive restore: `POST /v1/databases/{source-id}/restore` with
  `{"mode":"full","name":"recovered","region_id":"<region>"}` or PITR with `target_time`.
  It returns a **new database ID** and separate storage. Reuse the same key after an uncertain
  submission; follow [recovery](recovery.md). This API restores PGCF archives, not a dump from
  another provider.

An import from another provider is the integrator's task: it freezes writes and uses a consistent
logical export/import through the normal CLI, with reviewed owners, grants, extensions and
sequences. For either import or restore, the integrator rebinds its own provider/database mapping
to the new target ID/region, updates protected role credentials/password revision and its
versioned registration, drains old connections and creates a fresh authorized pool. PGCF requires
current database/role registration; stale or unregistered hints must fail. Acceptance of the
integrator's own adapter and registration is therefore a cutover prerequisite: use supported
scoped operations; do not bypass checks or edit tables to make a DSN swap work.

Compare data/checksums, roles/grants, sequences and committed markers. Verify actual Cloudflare
TLS/region, target backup/WAL, application transactions and selected timeout/pool behavior.
Rehearse restore into another new ID and repeat rebinding. Once target writes begin, returning
to the stale source requires reconciliation. Delete trials through `DELETE /v1/databases/{id}` and
confirm operation completion plus physical reclamation; R2 archive retention is separate.
