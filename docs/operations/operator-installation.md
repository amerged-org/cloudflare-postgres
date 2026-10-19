# Existing-account installation

Follow the canonical [ULTRA delivery plan](../architecture/cloudflare-convergence-and-serverless-plan.md)
and record measured completion there. The deployment is EU only, with customer EU1, a Contabo
Cloud VPS with 6 vCPU and 12 GB RAM, which Cloudflare installed from the node image: a Debian 13
image with one sandboxed systemd PostgreSQL service per database on its own thin LVM volume, one
Rust node agent, the gateway and a Tunnel. There is no Kubernetes and no control server. Use
Contabo only at provider lifecycle boundaries. Buying a node, or any other paid resource, needs the
owner's explicit, costed go.

## Reviewed deployment inputs

Use a source commit that passed the common CI checks.

Keep the private API configuration outside Git. It supplies D1, region-specific R2 bindings,
NodeActor/DatabaseActor/CronWatchdog Durable Objects and the AddNode and InfrastructureBackup
Workflows. Start from `apps/api/wrangler.example.jsonc`; replace every placeholder. Import secret
values from private custody and preserve the existing ones on every redeploy. Export D1 before
applying additive migrations and rehearse them against the export.

| Worker secret | Holds |
| --- | --- |
| `API_KEY_PEPPER` | The HMAC key of API keys and of the installer's enrollment and progress tokens |
| `CREDENTIAL_KEYS` | The keyring that encrypts role credentials and the daily D1 export |
| `ROUTE_MASTER_KEYS` | The master keyring of the route tokens, the same on the Edge Worker; each node receives only the keys derived for it |
| `BOOTSTRAP_TOKEN` | Creates the first admin key, once |
| `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_USERNAME`, `CONTABO_PASSWORD` | The Contabo API credentials |
| `R2_PARENT_ACCESS_KEY_ID`, `R2_PARENT_SECRET_ACCESS_KEY` | An R2 API token with object read and write on the archive buckets, from which the Worker signs the nodes' temporary R2 credentials (plan 7.3) |
| `CLOUDFLARE_API_TOKEN` | Makes and deletes the nodes' Tunnels and DNS records |
| `INFRASTRUCTURE_BACKUP_CF_TOKEN`, `RESEND_API_KEY`, `INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN` | Optional: the D1 export, direct email and the alert webhook (see below and the [infrastructure backup runbook](infrastructure-backups.md)) |

The EU archive uses the EU-jurisdiction binding and EU S3 endpoint. Every other region has a
separate bucket on the account's general S3 endpoint. Choose that region's location hint when
creating its bucket; the hint does not guarantee jurisdiction. `ARCHIVE_BINDINGS` must map each
exact region ID to its actual Worker binding and bucket. A mismatching or missing binding fails
closed.

Route tokens are versioned. The Edge signs a token that the node's gateway verifies, with the key
derived for that node, before it dials PostgreSQL.

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

## Edge Worker

The deployed Edge Worker is the TypeScript `apps/edge`; the management API and DatabaseActor stay
in TypeScript. Start the private deployment configuration from `apps/edge/wrangler.example.jsonc`
and preserve the existing Worker name, hostname, DatabaseActor binding, rate-limit namespaces,
gateway service bindings (if a region uses one) and `ROUTE_MASTER_KEYS` secret.
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
protocol behavior. They do not replace live acceptance on the EU1 stack: a real PostgreSQL behind a
node's gateway, reached through its Tunnel.

Start the replacement's private configuration from `apps/edge-rust/wrangler.example.jsonc`;
it has the same bindings, variable and secret as the TypeScript example, and serves the same
routes (`/v2` WebSocket connections and `/sql` HTTP queries). The example intentionally has no
custom build command: delivery uses the qualified artifact instead of compiling again. Do not
activate the replacement until the selected bytes pass live database acceptance on the EU1
stack. Record the actual Worker version and result in the ULTRA plan.

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

## The region's node policy

The rules a region's nodes decide by when they act alone (plan 4.3 to 4.7 and 7.5) are the region's
node policy. Every node's desired page carries it, and a region without one serves no page (the
nodes get a 409 "The region's node policy is not set"), so set it before the first node installs.
Read and replace it with an administrator key at `GET` and `PUT /v1/regions/{id}/node-policy`; the
nodes of the region pull the new page at once.

| Group        | Fields                                                                                                                                                           | The plan's starting values for EU1 (12 GB) |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `admission`  | `memory_rule` (`measured` or `reserved`, decision D3), `memory_floor_mib`, `awake_budget_mib`, `reservation_overhead_mib`, `start_concurrency`, `queue_wait_ms`, `retry_after_seconds` | `measured`, 600, 9,937, 8, 4, 10,000, 5 |
| `early_sleep` | `enabled`, `min_idle_seconds` (decision D2)                                                                                                                     | enabled, 30                                |
| `storage`    | `reserve_bytes`, `metadata_no_room_percent`, `sample_max_age_seconds`                                                                                            | 6 GiB, 75, 10                              |
| `backup`     | `wal_uploads`, `base_backups`, and `memory_mib` of a WAL upload, a WAL fetch and a base backup or restore                                                        | 2, 1, 128, 128, 256                        |
| `io`         | `write_bytes_per_second` and `write_iops` of a 256 MiB database; a database of _m_ MiB gets _m_/256 times as much                                                | 16 MB/s, 1,000                             |

The starting values come from plan sections 4.3 to 4.6 and 7.5 and stay estimates until Stage 5
measures the node; the memory budget is the visible RAM minus the system, the mounted volumes, the
backup jobs and the page-cache floor (plan 4.5). `awake_budget_mib` is also the memory limit of
`pgcf.slice`, the kernel's backstop under either memory rule.

## Capacity policy, purchases and notifications

Placement follows plan 4.8 and needs no policy: a node takes new databases until its active RAM or
its CPU load reaches 80 %, each measured as the highest 30-minute average of the last seven days,
and the fullest qualifying node wins. The capacity policy (`GET` and `PUT /v1/regions/{id}/capacity-policy`) holds
the purchase switches and the alert thresholds. The live node ceiling is removed (`max_nodes:null`),
and the alert webhook is the delivery destination; no direct email is configured. Purchases and
autoscale stay off; enabling them, or any new paid resource, needs the owner's explicit, costed go.

Management is API-only and requires an administrator key of scope `admin` (`admin_read` only
reads); an integrator's project key does not control infrastructure purchases. Read the policy,
then PUT the intended complete policy to the same route. Existing fields retain their documented
full-replacement semantics; omitting `max_nodes`, `ram_expansion_threshold_ppm`, the warning
thresholds or `cap_warning_enabled` preserves the stored values, and an explicit `null` removes an
optional value. No large sentinel count represents an absent limit.

| Setting                                                              | Meaning                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autoscale_enabled`                                                  | Lets the minute capacity cron add a node when no node fits the database that waits (the smallest enabled size class when none waits): it adopts the first unused `adopt_instance_ids` entry, else reserves an addition of `order`, at most one purchase attempt per hour of continued shortage. False by default. |
| `purchases_enabled`                                                  | Permits a paid provider order: an order addition is dispatched only while this is true and its order equals `order`. Requires `order`. False by default.                                                                               |
| `order`                                                              | The exact provider order (`product_id`, `provider_region`, `image_id`, `term_months`, `location`, optional add-ons) of every order addition; manual order requests must equal it. `null` means no orders.                            |
| `adopt_instance_ids`                                                 | Provider instances that autoscale may adopt, in list order.                                                                                                                                                                           |
| `standing_cost_profile`                                              | The owner's standing approval for orders of exactly `order`. With `trigger: "regional_actual_ram"` it approves only the capacity cron's automatic orders; without a trigger it also approves manual order additions and needs an expiry and finite limits. `null`: every order waits for `POST /v1/nodes/additions/{id}/approve`. |
| `max_nodes` | Optional regional node ceiling; `null` removes it. It counts the region's nodes (lost ones included) and held node additions, once per provider instance; recovering a lost node on its own allocation is exempt. |
| `cap_warning_enabled`                                                | Opt-in notice for a finite `max_nodes`; false by default.                                                                                                                                                                             |
| `node_ram_warning_threshold_ppm`                                     | Optional warning when any node's 30-minute average of active RAM, (MemTotal - MemAvailable) / MemTotal, reaches it; judged from samples spanning at least ten minutes, the newest at most 180 s old. `null` disables it.               |
| `node_cpu_warning_threshold_ppm`                                     | Optional warning when any node's 30-minute average CPU load, busy time over all its cores, reaches it; judged the same way. `null` disables it.                                                                                       |
| `node_storage_warning_threshold_ppm`                                 | Optional warning when the fuller of any node's thin-pool data and metadata, in its newest sample (at most 180 s old), reaches it; placement closes a pool at 800,000 (data) and 500,000 (metadata). `null` disables it.                |
| `ram_warning_threshold_ppm`, `ram_expansion_threshold_ppm`           | The regional RAM window these two read needs ten fresh one-minute samples of every node, which no node reports yet, so the warning stays unknown and never fires. The contract still requires an expansion threshold when autoscale, purchases and an order are all set (409 otherwise); the capacity cron does not read it. |
| `maximum_database_memory_mib`                                        | The most memory one database of the region may have, for a size class and for its own memory; `null` means 4096.                                                                                                                      |
| `placement_mode`, `postgres_memory_request_mib`                      | Stored, and read by no placement or admission code: the 80 % rule and the node's own admission decide. Leave `reserved` and `null`.                                                                                                   |

`GET /v1/regions/{id}/capacity-decision` is a dry run of the capacity cron for the region. Its
`action` says what the next step is, for example `idle`, `placement_pending` (a waiting database fits a node),
`maintenance` (an open maintenance cycle holds placement closed, which is no reason to buy),
`observations_stale` (a node that should report is quiet, which is no reason to buy), `disabled`,
`cap_reached`, `selection_unconfigured` (neither an adoptable instance nor an `order`),
`waiting_for_approval`, `addition_in_progress`, `adopt` or `order`.

Operators configure an exact `order` and their own standing authority. A standing profile binds the
exact order, an owner reference, an approval time and optional monetary, order-count and expiry
limits. Unknown prices stay null, never zero or an invented provider quote. Once a provider write is
recorded or uncertain, reconcile its saved request identity through reads, even if the switches
change afterwards, and never repeat an uncertain order. Adoption of already allocated nodes and
explicit manual costed orders remain distinct paths. Provider credentials are protected operator
secrets; fresh adopters receive neither them nor this owner's purchase authority.

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
and actual delivery are separate evidence. The alert kinds and their runbook actions are in the
[infrastructure backup runbook](infrastructure-backups.md#alert-kinds-and-runbook-actions).

## Adding, reinstalling and updating a node

1. Register a release and assign it to the region
   ([node image README](../../infra/node-image/README.md#registering-a-release)). A node installs
   from, and updates to, the release its region has assigned.
2. Set the region's node policy and capacity policy (above), create the node firewall and, for the
   gateways, the Access application.
3. `POST /v1/nodes/additions` (admin, `Idempotency-Key` required) with
   `{"region_id","mode":"adopt","provider_instance_id"}` for an instance the account already holds,
   `{"region_id","mode":"order","order"}` for a purchase (it must equal the region's `order` and
   needs the owner's costed go), or `{"region_id","mode":"recover","provider_instance_id",
   "predecessor_node_id","expected_node_uid"}` to reinstall a node declared lost (the reinstall guard
   of [recovery](recovery.md#lost-node) applies). `GET /v1/nodes/additions/{id}` reads the addition;
   `POST .../cancel` (with the addition's `expected_revision`) cancels it.
4. AddNode confirms the node firewall, then requests the Contabo rescue with the pull installer
   (plan 9.2). The addition is `audited` until the firewall is confirmed (`install_blocker`
   `node_firewall_unconfirmed`), `bootstrapping` while the installer runs and the node enrolls, and
   `ready` once the node has sampled with its credentials, which also opens it for placement.
   A node that does not enroll after the installer's reboot is restarted once through the API.
5. A new release reaches a running node without a reboot: assign it to the region and the node pulls
   its binaries (plan 9.3). Packages and kernels change only in the
   [maintenance cycle](recovery.md#node-maintenance-cycle), one node at a time.

Verify an install as described under [the node firewall](#the-node-firewall) and
[Cloudflare Access](#cloudflare-access-for-node-gateways-and-shells).

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
| `GET/PUT /v1/regions/{id}/configuration` | Read/change the region's fallback gateway URL and binding through configuration-hash CAS; the route must end in `/pg` |

Profile creation, rollout selection and regional configuration require administrator scope.
Database assignment retains project authorization. Use `Idempotency-Key` for mutations and retain
returned operation IDs. An immutable profile revision cannot be changed through the size-class API.
An enabled revision may be selected for rollout; creating a revision alone does not promote it.
The existing cron processes at most eight assignments per invocation and resumes through existing
configuration generations and database operations. Capacity conflicts leave the current desired
state intact for retry; they are not successful application.

A profile revision is a size class (`resources`): memory, CPU, storage, `max_connections`,
`sleep_after_seconds`, `archive_timeout_seconds` and `backup_retention_days`. The node reads the
memory, the CPU limit and the storage: the memory is the database's hard ceiling, and its CPU is a
weight proportional to the CPU size plus a quota of that size once started (plan 4.4). The class's
optional `cpu_request_millicores` is accepted and stored, and no node reads it.

A confirmed sleeping database accepts a new revision while it sleeps: its `application_state` is
`deferred_until_wake`, and the next wake is admitted against the new size and must report the
current configuration before `applied` is true. An awake database is admitted again at the new
size; an uncertain stop or a degraded observation is `pending`. A newer revision supersedes an
unfinished older resize explicitly, and a stale observation cannot acknowledge the current one.
A resize the node cannot take now answers `503 capacity_exhausted` with `Retry-After`.

The gateway URL of a region is the fallback the Edge dials only for a node that has no gateway
hostname of its own, which the API writes when it makes the node's Tunnel.

## Customer migration handover

Moving an integrator's existing databases into PGCF is the integrator's task and a separate
reviewed cutover.

Inventory source region, roles/grants/extensions, sequences, pools, timeouts and sizing. Resource
classes are configured through the management API in 256 MiB PostgreSQL increments, with an
operator maximum of 4 GiB. A limit is not a permanent physical reservation: a sleeping database
holds no RAM or CPU and only the thin-volume space it has written. The awake RAM and CPU of a node,
its thin pool and its own wake admission together decide how many databases it carries (plan 4);
the density test (Stage 5.6) records the measured result. RAM overbooking does not remove the CPU
and storage limits: approve sufficient regional capacity before committing an integrator's
databases to a region.

### Connection and cold starts

PGCF’s public transport is verified WSS; a TCP DSN hostname swap is insufficient. Use the
established Neon serverless `Pool`/`Client` WebSocket mode with its default
`pipelineConnect: "password"` and a `wsProxy` URL containing `/v2?database=<URL-encoded-PGCF-ID>&user=<URL-encoded-role>`; see
[the connection contract](../../README.md). Keep PostgreSQL authentication; the WebSocket is the
encryption. Hints scope admission; they are not credentials.

For psql and logical export/import tools, use the existing CLI:

```sh
node packages/cli/dist/main.js connect --endpoint wss://db.example.com --database <pgcf-id> --user <role>
```

Use the printed loopback port, target PGCF ID and role. `sslmode=disable` applies only to
loopback; public WSS remains verified, and the gateway reaches PostgreSQL over a Unix socket on the
node. Keep passwords private; never expose a VPS database port.

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
