# Existing-account installation

Follow the canonical [ULTRA delivery plan](../architecture/cloudflare-convergence-and-serverless-plan.md)
and record measured completion there. The deployment is EU only, with customer EU1, a Contabo
Cloud VPS with 6 vCPU and 12 GB RAM. The Kubernetes runtime was retired on 2026-10-17; the Debian
node image, the node agent and the pull installer are built in Stage 3 of the plan, and EU1 is
installed from that image in Stage 4. Use Contabo only at provider lifecycle boundaries. A future
real expansion uses the configured threshold/purchase policy.

## Reviewed deployment inputs

Use a source commit that passed the common CI checks.

Keep the private API configuration outside Git. It supplies D1, the one R2 archive binding,
NodeActor/DatabaseActor/CronWatchdog Durable Objects and the AddNode and InfrastructureBackup
Workflows. Start from `apps/api/wrangler.example.jsonc`; replace every placeholder. Import secret
values from private custody and preserve the existing four root secrets. Export D1 before applying
additive migrations and rehearse them against the export.

Every region archives into one R2 bucket, named without a region. The `ARCHIVE` binding is that
bucket (with `"jurisdiction": "eu"` on an EU installation) and the variable `ARCHIVE_BUCKET_NAME`
names the same bucket. A region row holds no bucket, only the S3 endpoint of it
(`backup_endpoint_url`, `https://<account>.eu.r2.cloudflarestorage.com` for the EU jurisdiction),
which is the same for every region. The keys keep regions apart:
`<region>/<database>/g<generation>-<operation>/database/` for a database generation,
`node-images/<release>/` for the node image releases and `infrastructure/v1/` for the daily
infrastructure backups. A binding that is missing, or a name that is not the bucket the archive
paths in D1 name, fails closed with an internal error.

The nodes' temporary R2 credentials are signed for `ARCHIVE_BUCKET_NAME` and one database
generation's prefix, so the parent key (`R2_PARENT_ACCESS_KEY_ID` and
`R2_PARENT_SECRET_ACCESS_KEY`, an R2 API token) must have object read and write on that bucket.

Route tokens are versioned. The Edge signs a token that the gateway verifies before it dials
PostgreSQL.

Adding a node installs it from the region's release (plan 9.2) and gives it its own Tunnel:

- The region has a release assigned (`PUT /v1/regions/{id}/release`). Its image is what the pull
  installer writes; AddNode waits until there is one.
- `NODE_API_ORIGIN` is this Worker's `https` origin, which the installed node enrolls at, and
  `NODE_DNS_SERVERS` a JSON array of one to three resolvers the node is installed with.
- `CLOUDFLARE_API_TOKEN` (a private secret with edit access to Tunnels and to the zone's DNS
  records) makes the node's Tunnel when the node first reads its credentials. Its gateway gets the
  hostname `<node>.<domain>` under `NODE_GATEWAY_DOMAIN`, a domain of the zone
  `NODE_GATEWAY_ZONE_ID`; the Cloudflare account is the one of the region's R2 endpoint. Without
  the token, the domain or the zone a node gets no credentials and stays closed to placement.
- `NODE_SHELL_HOSTNAME` is off unless it is the string `true`. The node's shell hostname
  `pgcf-shell-<id>.<domain>`, its DNS record and its Tunnel ingress rule exist only while it is
  `true`, and a node that has them loses them on its next credentials read when it is not. The
  same read deletes a DNS record under the shell's former name, `pgcf-node-<id>-ssh.<domain>`,
  whatever the variable says. Leave it off until Cloudflare Access guards the shell (plan 8,
  [the section below](#cloudflare-access-for-node-gateways-and-shells)): without Access the
  hostname is reachable by anyone who can run cloudflared.
- `CONTABO_ORDER_SSH_KEY_IDS` also names the keys the provider's rescue action wants beside the
  installer; the installer itself uses none.
- `CONTABO_NODE_FIREWALL_ID` names the Contabo firewall every node sits behind (plan 8). AddNode
  requests the rescue only once that firewall is `active`, has no inbound rule that accepts and
  lists the instance with the status `ok`, because the rescue system's `sshd` is reachable on the
  public port 22 until the installer turns password login off. Without the firewall no node gets
  its installer; create it once, as below.

### The node firewall

Create the firewall once, in the Contabo customer control panel or with `POST /v1/firewalls` and
the body `{"name":"pgcf-nodes","status":"active","rules":{"inbound":[]}}`: active, with no inbound
rule. A firewall that no rule opens admits no inbound connection, and the pull install and the
node's Tunnel only connect outward, so nothing needs to be opened. Contabo lists the firewall as
included with every VPS (contabo.com/blog/contabo-firewall); confirm that on the account first,
because a new paid resource needs the owner's explicit, costed go. Put the firewall's id in the
`CONTABO_NODE_FIREWALL_ID` Worker variable (an identifier, not a secret) and deploy.

- Assign a node that exists already, such as EU1, to the firewall by hand before AddNode runs for
  it. AddNode finds it listed and does not assign it again.
- AddNode assigns any other instance itself, then reads the firewall back. Contabo applies an
  assignment on its own time, so the first read may not list the instance yet, or list it with a
  status other than `ok` (`processing`); the next cycle reads again and does not assign it twice.
- AddNode never takes an instance off the firewall. An addition that is cancelled or fails after
  the assignment leaves the instance behind it, and an adopted server that served inbound traffic
  before loses it. Unassign such a server in the Contabo customer control panel.
- While the firewall is not confirmed the addition stays `audited`, no rescue is requested and the
  addition's `install_blocker` reads `node_firewall_unconfirmed`. The cause is one of: the variable
  is unset or wrong, or the provider cannot be read; the firewall is not `active`; it has a rule
  that accepts (a rule that drops is fine); the instance is not listed yet, or listed with a status
  other than `ok`, and stays so (`error_processing`). Fix the cause; AddNode asks again on every
  cycle and starts the install when the firewall is confirmed.
- To verify an install, try a TCP connect to port 22 of the instance's public IPv4 address from
  outside during the rescue and after the reboot. Both must time out.

### Moving to another archive bucket

The archive paths stored in D1 (`s3://<bucket>/<region>/<database>/g<generation>-<operation>`), the
credentials the nodes hold and the Worker's binding name the bucket, so a move changes more than the
binding. The keys below the bucket stay valid: a key never contains the bucket, and it is unique per
database generation and operation, so the objects are copied unchanged and server side (CopyObject,
which stays inside one jurisdiction's endpoint). The old bucket is only read, except by the rollback
mirror below, until the owner says it may go. The move needs the owner's costed go for the new bucket;
the plan puts it after the acceptance tests and before the go-live gates.

Why the order matters. A node archives into the path of the page entry it holds, with the credential
it holds (seven days, signed for the old bucket), and switches when it applies a page that names the
new path and has read the new credential. A database that is awake, or wakes, before that writes its
WAL into the old bucket only, and the node never sends that segment again. Nothing on the wake path
looks at the bucket, so the Worker refuses no wake, and nothing records that a node applied a page or
read an archive credential. The one acknowledgement is an order a node reports done: a pull reads
the credentials, accepts the entries and only then obeys the orders, and the maintenance cycle puts
every awake database to sleep with the proof. WAL segment keys are written once under unique names,
so the union of both buckets holds every segment, and a last copy of what exists only in the old
bucket, made after the last write into it, closes any gap.

1. Deploy the Worker with the single `ARCHIVE` binding still naming the old bucket, then apply
   migration `0078` (the old Worker cannot run on the new schema, the new one runs on the old).
2. With the owner's costed go, create the new bucket (same jurisdiction). Replace the parent key
   (`R2_PARENT_ACCESS_KEY_ID`, `R2_PARENT_SECRET_ACCESS_KEY`) by a token whose policy names both
   buckets, and keep the old one in it until the old bucket is deleted.
3. Copy every object that has a reader (the archive keys, `node-images/`, `infrastructure/v1/`) while
   everything runs, and repeat until a pass copies only what changed. A key counts as copied when its
   size and ETag, or its size and a LastModified not older than the source's, match, because R2 may
   recompute a multipart ETag on a copy. Compare sizes and ETags of every key, the bodies of the ones
   whose ETag differs, and the stored sha256 and custom metadata of the node images and infrastructure
   exports (a HEAD returns a checksum only when it asks with `x-amz-checksum-mode`).
4. Rehearse the rewrite below on a D1 export. Check that no create, restore, move or base backup is in
   flight and that every node runs its region's release.
5. Deploy the Worker with `ARCHIVE` bound to the new bucket and `ARCHIVE_BUCKET_NAME` set to it. From
   here the Worker deletes (retention, expiry) in the new bucket only. Point the release registration
   (`PGCF_R2_BUCKET` of `register-node-image.ts`) at the new bucket too: it uploads into that bucket
   and the Worker reads the bound one.
6. Rewrite the stored paths from a 0600 file in a 0700 directory (`wrangler d1 execute <database>
   --remote --file <file>`), and delete the file. Every statement touches only rows that still name
   the old bucket, so the file is run again after a partial failure:
   ```sql
   UPDATE databases SET archive_path='s3://<new>/'||substr(archive_path,length('s3://<old>/')+1)
     WHERE substr(archive_path,1,length('s3://<old>/'))='s3://<old>/';
   ```
   The same for `retained_archives.archive_path`, `database_restores.source_archive_path`,
   `backup_retention_runs.archive_path` and, when a move row exists, `database_moves.source_archive_path`
   and `target_archive_path` (the trigger `database_moves_monotonic` refuses that change: drop it
   and create it again, text for text, from migration `0065` around the statements). The credential
   rows stay: a credential is found by node, path and access, so the new paths make every page name a
   new credential, and the old rows record when the old credentials expire.
7. Run the maintenance cycle (`POST /v1/nodes/{id}/maintenance`) on every node that holds a database
   and wait until it is `done`. The node answers new wakes with `57P03`, puts every awake database to
   sleep with the proof and reopens placement; by then it has read the new credentials and accepted
   the new paths, and no database is awake. Each database of the node also has a credential row for
   its new path issued after the rewrite. Databases that were asleep stay asleep. If a cycle fails or
   a node is offline, do not go on: that node's awake databases may still write into the old bucket.
8. Copy again what the old bucket received since the warm copy (only keys modified since a time a
   little before the last warm pass, so that a key the new bucket's retention has deleted since is not
   brought back), and compare. Then delete from the new bucket the copies of what the old bucket's
   retention deleted before step 5 (written there at or before step 5, absent in the old bucket), or
   a deleted database's data outlives its recovery window.
9. Accept on the new bucket: wake a database, write, let it sleep (its WAL appears under the same
   prefix in the new bucket and the old bucket gets no new key), take a base backup, restore to a point
   in time, `HEAD` and `GET` a release file through `/node/v1/releases/<release>/<file>` (it reads the
   bound bucket; registering a known release again does not) and wait for the next infrastructure
   backup.
10. Repeat the last copy of step 8 and the check for new keys in the old bucket after an hour, a day
    and after the last credential for the old bucket has expired (`max(expires_at)` of the rows that
    name it, at most seven days). A pass that finds a key means a node still wrote into the old bucket:
    the copy closed the gap; find the node (its credential read failed, usually a parent key that
    lacks the new bucket) and wake its databases again. Only then, and with the owner's word, delete the
    old bucket and its scope in the old token.

If a step fails. Before step 5, nothing in production changed (a failed copy is repeated). After
step 5 and while no credential row names the new bucket, redeploy the old configuration and run the
rewrite with the two names swapped. Once a node has pulled a page that names the new bucket, do not
swap back: fix forward, or first mirror what the new bucket holds and the old one lacks (a copy that
only adds missing keys and never replaces one, which writes into the old bucket), then swap one
database at a time. The migration of step 1 has no way back; D1 Time Travel is the last resort.

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

Two optional Worker secrets, `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`, are the Cloudflare
Access service token that the Edge presents (headers `CF-Access-Client-Id` and
`CF-Access-Client-Secret`) to a gateway on a public hostname, once Access guards it; the Access
application's policy for the gateway hostnames must use the Service Auth action for this token.
Set them as secrets (`wrangler secret put` or the API), never as variables. Set both or neither:
without them the Edge sends nothing and an installation without Access works as before, and one
alone refuses every connection and HTTP query to a public gateway with `08006` before anything is
sent, and logs `config_error: "access_secrets_incomplete"` (never a value). A gateway on a service
binding does not go through Access and never receives the token. An Access refusal (401, 403, or
a redirect to the login page, which the Edge does not follow) shows in the log as the
`gateway_status` of the refused connection. The token expires after the duration chosen when it
was created: refresh it before then and rotate it as described in
[credentials](credentials.md).

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
it has the same bindings, variable and secret as the TypeScript example, and serves the same
routes (`/v2` WebSocket connections and `/sql` HTTP queries). The example intentionally has no
custom build command: delivery uses the qualified artifact instead of compiling again. Do not
activate the replacement until the selected bytes pass Dev database acceptance. Record the
actual Worker version and result in the ULTRA plan.

Both editions return the unopened upstream WebSocket directly to Cloudflare. PostgreSQL bytes
are not relayed through a TypeScript or Wasm application loop. Only bounded local refusal sockets
parse their own startup/SCRAM exchange. Request aborts and the absolute admission deadline cancel
the exact Actor waiter; a cancellation never retries the gateway connection or application SQL.

## Cloudflare Access for node gateways and shells

A node's gateway hostname, `pgcf-node-<id>.<NODE_GATEWAY_DOMAIN>`, is public: without Access only
the route token protects it, and anyone on the internet can reach it past the Edge's limiters
([plan 5.8](../architecture/cloudflare-convergence-and-serverless-plan.md#58-the-path-from-the-edge-to-the-node)).
`scripts/operations/setup-access.ts` puts Cloudflare Access in front of two families of hostnames
that do not overlap, because Cloudflare does not document which of two overlapping wildcard
applications wins:

| Application | Hostnames | Policy | Session |
| --- | --- | --- | --- |
| `pgcf node gateways` | `pgcf-node-*.<domain>` | `edge service token`: Service Auth for one service token, nothing else (no login, no email) | 24h |
| `pgcf node shells` (only with `--shell`) | `pgcf-shell-*.<domain>` | `operators`: allow the named emails, through the one-time PIN identity provider if the organization has one | 1h |

Both are self-hosted applications, hidden from the App Launcher, with HttpOnly cookies and no CORS
headers. The gateways' application answers a request without credentials with 401, never with a
login page. The shells use the native client (`cloudflared access ssh`); the SSH application
type is the browser-rendered terminal and is not used. The script is idempotent: it reads what is
there, changes only what differs (an application or policy edited by hand is put back, and any
second policy on an application is deleted), and a second `apply` makes no write.

**What it needs.** A Zero Trust organization on the account (the free plan is enough), and an
account API token with these permissions, read from the environment and never printed or written
(a value that is not a Cloudflare API token, such as one with a second line, is refused by name
before any request):

| Permission | When |
| --- | --- |
| Access: Apps and Policies Write | always |
| Access: Service Tokens Write | always |
| Access: Organizations, Identity Providers, and Groups Read | with `--shell` |
| Workers Scripts Write | with `--edge-worker` |

**Order.** The gateways refuse the Edge from the moment the application exists, so:

1. Deploy the Edge release that presents the service token (the headers `CF-Access-Client-Id` and
   `CF-Access-Client-Secret`, from its secrets `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`).
2. Read the plan, which writes nothing, then apply it:

   ```sh
   read -rs PGCF_CLOUDFLARE_API_TOKEN && export PGCF_CLOUDFLARE_API_TOKEN
   node scripts/operations/setup-access.ts plan --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
     --service-token <TOKEN_NAME> --edge-worker <EDGE_WORKER>
   node scripts/operations/setup-access.ts apply --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
     --service-token <TOKEN_NAME> --edge-worker <EDGE_WORKER>
   ```

   `--service-token` names the token the Edge presents. If it does not exist, `apply` creates it
   (duration 8760h) and sets its client id and secret as the Edge Worker's secrets in the same run;
   Cloudflare shows the secret once, so the script refuses to create or rotate a token without
   `--edge-worker`, deletes a token it just made when the secrets cannot be set, and never prints
   or writes the client id or the secret. With a token that exists, `--edge-worker` also checks
   that the Worker holds both secrets and refuses to go on without them, because the Edge would be
   locked out.
3. Verify from outside, with a node's own hostname unless the zone resolves every name (a wildcard
   record), because the name must resolve to reach Cloudflare at all:

   ```sh
   node scripts/operations/setup-access.ts plan --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
     --service-token <TOKEN_NAME> --verify --verify-hostname pgcf-node-<id>.<NODE_GATEWAY_DOMAIN>
   ```

   It sends a GET without credentials and expects `verify ok ... answered 401` or `403`. A 200, a
   redirect (a login page) or a 404 (the request got past Access to the node's Tunnel) is a failure
   and exits non-zero. Changes take a moment to reach Cloudflare's edge: repeat once before
   treating the first answer as final. Then open a connection through the Edge as usual to see that
   the Edge still gets in.
4. The shell, when an operator needs it. The application comes first, then the variable:

   ```sh
   node scripts/operations/setup-access.ts apply --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
     --service-token <TOKEN_NAME> --shell --operator-email ops@example.org --operator-email dev@example.org
   ```

   The list of emails is the whole list: running it with fewer emails removes the others. Then set
   `NODE_SHELL_HOSTNAME` to `"true"` on the API Worker and deploy it; a node gets its
   `pgcf-shell-<id>.<domain>` hostname on its next credentials read. Connect with
   `ssh -o ProxyCommand="cloudflared access ssh --hostname %h" <user>@pgcf-shell-<id>.<domain>`;
   `cloudflared` opens the Access login, which needs one of the named emails.

**Renew or rotate the service token.** The two are different steps. A token lasts the duration it
was made with (8760h) and stops working then: Access refuses the Edge at every `pgcf-node-*`
hostname and no database can be reached. Only a refresh moves that date; rotating replaces the
secret and leaves the date as it was. The script prints the `expires` date of an existing token,
warns when it is less than 30 days away and refuses to go on with an expired one. Cloudflare also
sends the "Expiring Access Service Token" notification a week before; turn it on under
Notifications in the dashboard.

Renew (Cloudflare adds one year; the secret stays, so no `--edge-worker`):

```sh
node scripts/operations/setup-access.ts apply --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
  --service-token <TOKEN_NAME> --refresh-service-token
```

Rotate (after a leak report or on a schedule of your own):

```sh
node scripts/operations/setup-access.ts apply --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
  --service-token <TOKEN_NAME> --edge-worker <EDGE_WORKER> --rotate-service-token --grace 1h
```

The token keeps its id, so the applications do not change. The new secret goes into the Edge
Worker's secrets and the old one stays valid for `--grace` (default 1h), so the Edge keeps
connecting while the new Worker version rolls out. If the new secret cannot be set, the run says
so and the old one stays valid for the grace period: run it again. A disabled token (for example
after a leak report) is not enabled by the script; delete it in the dashboard to have a new one
made, which also has a new expiry.

**Roll back.** `apply --account <ACCOUNT_ID> --remove` deletes both applications and their
policies (the same as deleting them in the dashboard under Access, Applications) and keeps the
service token; the gateways have only their route token again. Turn `NODE_SHELL_HOSTNAME` off
and deploy before the shell application goes, or the shell hostnames are open. `plan --remove`
shows what would go.

## Operator-configured capacity and optional notifications

The live node ceiling is removed (`max_nodes:null`) and no capacity-mail credentials or
recipient are configured. Purchases and autoscale stay off; enabling them, or any new paid
resource, needs the owner's explicit, costed go.

Management is API-only and requires an administrator key of scope `admin` (`admin_read` only reads); an integrator's project key does not
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
