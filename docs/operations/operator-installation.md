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
  installer writes; AddNode waits until there is one. A release is registered only with the
  signature that the release signer (a Worker that holds the release key as a Cloudflare secret) makes of
  it for CI, and running nodes update to nothing else; the image of a new node is not covered by it
  (release-signing.md, "What is and is not protected"). Deploy the signer and make the key once, as
  [release-signing.md](release-signing.md) says.
- `NODE_API_ORIGIN` is this Worker's `https` origin, which the installed node enrolls at, and
  `NODE_DNS_SERVERS` a JSON array of one to three resolvers the node is installed with.
- `CLOUDFLARE_API_TOKEN` (a private secret with edit access to Tunnels and to the zone's DNS
  records) makes the node's Tunnel when the node first reads its credentials. Its gateway gets the
  hostname `pgcf-node-<id>.<domain>` under `NODE_GATEWAY_DOMAIN`, a domain of the zone
  `NODE_GATEWAY_ZONE_ID`; the Cloudflare account is the one of the region's R2 endpoint. Without
  the token, the domain or the zone a node gets no credentials and stays closed to placement.
- `NODE_SHELL_HOSTNAME` is off unless it is the string `true`. The node's shell hostname
  `pgcf-shell-<id>.<domain>`, its DNS record and its Tunnel ingress rule exist only while it is
  `true`, and a node that has them loses them on its next credentials read when it is not. The
  same read deletes a DNS record under the shell's former name, `pgcf-node-<id>-ssh.<domain>`,
  whatever the variable says. Leave it off until Cloudflare Access guards the shell (plan 8,
  [the section below](#cloudflare-access-for-node-gateways-and-shells)): without Access the
  hostname is reachable by anyone who can run cloudflared. A change of this variable or of the
  next one reaches a running node by itself: the first desired page or credentials read built after
  the deploy raises the node's credentials revision, so the node reads its credentials again within
  one pull (at most a minute) without restarting its gateway or its Tunnel. While the deploy
  spreads and two versions of the Worker serve at once, the revision may rise once more for each
  change of hands; the last version to serve decides what the node holds.
- `NODE_SSH_USER_CA_PUBLIC_KEY` is the public key of the CA that signs the shell's certificates:
  exactly one line, `ssh-ed25519 AAAA...`, 80 characters, with no comment and no options before
  it. The private key stays with the operator and is on no Worker ([Using the shell](#using-the-shell)).
  Nodes get the key only while `NODE_SHELL_HOSTNAME` is `true`, and the agent removes it from the
  node when it goes. A line that is not exactly that gives nodes no key: the shell hostname
  exists and nobody can log in.
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
- Before it issues the tokens, AddNode verifies the signature of the region's release against the
  manifest rebuilt from the stored spec (the image's digests included) with the release public key of
  the API Worker. A row that does not verify (edited in D1, or registered by a path that did not
  check it) leaves the addition `audited` with `install_blocker` `release_unverified`; no tokens are
  issued and no rescue is requested. Register a release signed by the signer and assign it to the
  region ([release-signing.md](release-signing.md)); the next cycle goes on.
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
| `pgcf node shells` (only with `--shell`) | `pgcf-shell-*.<domain>` | `operators`: allow the named emails, through the one-time PIN identity provider if the organization has one; with `--shell-service-token` also `shell service token`: Service Auth for a second service token that is made for the shells alone (the Edge's is never on this application, and this one never on the gateways) | 1h; 15m for the token's policy |

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
4. The shell, when an operator needs it. The application comes first, then the variable. The
   [Using the shell](#using-the-shell) section below has the whole order, with the CA:

   ```sh
   node scripts/operations/setup-access.ts apply --account <ACCOUNT_ID> --domain <NODE_GATEWAY_DOMAIN> \
     --service-token <TOKEN_NAME> --shell --operator-email ops@example.org --operator-email dev@example.org \
     --shell-service-token <SHELL_TOKEN_NAME> --shell-token-file ~/.pgcf/shell-token.env
   ```

   The list of emails is the whole list: running it with fewer emails removes the others.
   `--shell-service-token` makes a second service token (720h) that only the shell application
   lets in, with a Service Auth policy of 15 minutes, and writes its client id and secret to the
   file, which must not exist yet and sit in a directory only you can enter (Cloudflare shows the
   secret once, so the script makes the token only when it knows where the secret goes, and deletes
   it again if the file cannot be written). A token that exists is used as it is and needs no file;
   one that has expired or is disabled is refused: delete it in the dashboard and run again with a
   new file. Without the flag the policy of the token is deleted again, as is any other policy
   on the shell application. Then set `NODE_SHELL_HOSTNAME` to `"true"` on the API Worker and
   deploy it; every node gets its `pgcf-shell-<id>.<domain>` hostname within a pull, and connects
   with `scripts/operations/node-shell.ts`.

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
service tokens; the gateways have only their route token again. Turn `NODE_SHELL_HOSTNAME` off
and deploy before the shell application goes, or the shell hostnames are open. `plan --remove`
shows what would go.

## Using the shell

The shell is a real root shell on one node, reached through its Tunnel. It is for the
fix-until-it-works loop, for Stage 5 acceptance tests that inject faults (`kill -9` of the
postmaster, the agent and the gateway, a full pool or volume, no free inodes) and for an
exceptional manual update. It is **off by default and fails closed**: three things must all hold
before a login can succeed, and removing any one ends it.

1. The API Worker's `NODE_SHELL_HOSTNAME` is `"true"`, so the node has the hostname, its DNS record
   and its Tunnel ingress rule.
2. The node holds your CA's public key in `/etc/ssh/pgcf_user_ca.pub`. The image ships none, sshd
   refuses every key without the file, and the agent writes the file only while the node's
   credentials carry the key (`NODE_SSH_USER_CA_PUBLIC_KEY`, valid, and the shell on), and removes
   it as soon as they do not.
3. Cloudflare Access lets the caller in (an operator's email, or the shell's own service token),
   and the caller presents a certificate signed by your CA for the principal `pgcf-break-glass`,
   valid for 15 minutes.

**1. Make the CA, once.** On your own machine; the private key never goes into the repository, a
Worker or a chat. Give it a passphrase (the helper below lets `ssh-keygen` ask for it on your terminal, and its prompt
names the key file), and keep a
copy with the encrypted operator backup. If you lose it, make a new CA and set its public key; no
node keeps trusting the old one once the variable changes.

```sh
ssh-keygen -t ed25519 -C pgcf-shell-ca -f ~/.ssh/pgcf_shell_ca
awk '{ print $1 " " $2 }' ~/.ssh/pgcf_shell_ca.pub   # the one line the Worker variable takes
```

**2. Set the key on the API Worker**, as the variable `NODE_SSH_USER_CA_PUBLIC_KEY` (a plain
variable, because it is public), with `NODE_SHELL_HOSTNAME` still off. A comment after the key, a
second line or an option before it make the whole line invalid, and nodes then get no key.

**3. Apply Access** with the shell and its service token, as in step 4 of the
[Cloudflare Access](#cloudflare-access-for-node-gateways-and-shells) section. Do it once; keep the
file it writes (`PGCF_SHELL_ACCESS_CLIENT_ID` and `PGCF_SHELL_ACCESS_CLIENT_SECRET`, mode 0600).

**4. Turn the shell on.** First make sure every node of the region runs an agent that has the
shell CA: register the release that contains it, assign it to the region and wait until
`GET /v1/nodes/{id}/release` says `converged` for each node
([Node maintenance cycle](recovery.md#node-maintenance-cycle) step 1). An agent from before it
refuses credentials that carry the key (`Cloudflare credentials invalid`), so it never applies
them, and a node added from such a release never becomes ready; it also restarts the gateway and
the Tunnel for every revision it does apply. Then set `NODE_SHELL_HOSTNAME` to `"true"` and deploy.
Within one pull, a node reads its credentials again (its credentials revision rose), the API makes
the hostname, and the agent writes the key file. Look in Workers Logs for a `node_event` line with the event
`shell_ca_written` for the node (it carries no key material). The gateway and the Tunnel are not
restarted for it.

**5. Connect.** You need `ssh`, `ssh-keygen` and `cloudflared` on your machine.

```sh
set -a; . ~/.pgcf/shell-token.env; set +a
export PGCF_SHELL_CA_KEY=~/.ssh/pgcf_shell_ca
node scripts/operations/node-shell.ts --node <NODE_ID> --domain <NODE_GATEWAY_DOMAIN> --label <you>
node scripts/operations/node-shell.ts --node <NODE_ID> --domain <NODE_GATEWAY_DOMAIN> --label <you> \
  -- 'journalctl -u pgcf-agent -n 50 --no-pager'
```

The helper takes the CA key's path and the token from environment variables (their names are
`--ca-key-env`, `--token-id-env` and `--token-secret-env` if you keep them under other names),
never from arguments, and refuses a CA key file that group or others can read. It makes a
throwaway key in a directory only you can enter, signs it with the CA (principal
`pgcf-break-glass`, key id `pgcf-shell-<UTC date>-<label>`, 15 minutes, a terminal and nothing else:
no forwarding), runs `ssh` through `cloudflared access ssh` with the token in its environment, and
deletes the key when ssh ends. ssh trusts the node's host key on first use: after a reinstall,
remove the old line from `~/.ssh/known_hosts`. Without `--` you get an interactive root shell; with
it, one command (give it as one quoted string), and the exit status is ssh's. The one-time PIN
login of `--operator-email` is the other way through Access, for an operator who has no token: use
`ssh -o ProxyCommand="cloudflared access ssh --hostname %h"` with a certificate signed by hand.

**6. Turn it off, and check that it is off.** Unset `NODE_SHELL_HOSTNAME` (or set it to anything
but `true`) and deploy; turn it off before the Access application goes. Within one pull the node
removes the hostname's ingress rule and DNS record (the API does that on the credentials read) and
the agent removes `/etc/ssh/pgcf_user_ca.pub`. Check, from outside the node:

- Workers Logs show the node's `node_event` with `shell_ca_removed`;
- the node's next sample carries the new `credentials_revision`, which the desired page names;
- `node-shell.ts` for the node no longer connects (the hostname does not resolve).

A node that is off or stale does the same as soon as it reads its page again. Until then the key
file stays, and with it the possibility of a login for whoever still reaches the hostname and holds
a certificate: that is why the CA key must stay in your hands, and why the certificates last only
15 minutes.

**Audit.** sshd logs at `VERBOSE`: for each login the journal holds the line `Accepted certificate
ID "pgcf-shell-<date>-<label>" (serial 0) signed by ED25519 CA SHA256:<fingerprint>` and the
`Accepted publickey` line of the connection, so the operator's label and the CA are on record. An
administrator reads them without a shell: the `journal` probe and the boot report include
`ssh.service`
([Looking at a node](recovery.md#looking-at-a-node)): `POST /v1/nodes/{id}/diagnostics` with
`{"probe":"journal","since_seconds":3600,"lines":2000}`, then the entries whose `unit` is
`ssh.service`. Compare the fingerprint with `ssh-keygen -l -f ~/.ssh/pgcf_shell_ca.pub`.

**Rotate or revoke.** Another CA: make it as in step 1, set the new public key and deploy; the
agent replaces the file within a pull (`shell_ca_written` again), and certificates of the old CA
stop working. A single certificate needs no revocation, because it lasts 15 minutes; to stop
everything now, turn the shell off. `/etc/ssh/pgcf_revoked.krl` stays the empty list the image
ships. The shell service token lasts 720h; when it has expired the script says so, and a new one is
made as in step 3.

### Replacing the agent by hand: a node whose agent predates host files

An agent of a build before host files cannot read the page of a release that carries them (nor,
since manifest v3, the image's facts that every page's release carries: its generated schema is
strict), and the API refuses its hello, which lacks `os.host_files_sha256`, so no release can reach
it: once, its binary is replaced through the shell. EU1 is such a node (it runs the agent of main
`bb85de7d`). A node enrolled from an image that
holds the first agent that writes host files needs none of this, and no code supports it: Dev runs
the newest release only. The databases keep running throughout (their units do not depend on the
agent, and a restart of the agent never stops one).

1. **While the node is still linked,** check that the shell reaches it (steps 1 to 4 above;
   `node-shell.ts ... -- true` exits 0): after step 2 it is the only way in. Assign nothing to the
   region.
2. **Deploy the API of the commit.** Its migrations (`0079` host files, `0080` the signed image) remove
   the registered releases and their assignments, and the API refuses the old agent's hello from then on: the node loses its link
   (`GET /v1/nodes/{id}` says `observation.state` `stale`; staleness alone never declares a node
   lost).
3. **Register the release** built and signed from that commit, from a checkout of exactly that
   commit ([release-signing.md](release-signing.md)), and do not assign it.
   `GET /v1/fleet/releases/{id}` shows `spec.binaries["pgcf-agent"]`: its `url`, `sha256` and
   `size_bytes`. Download the file from that `url` and check its sha256 on your machine against the
   spec's.
4. **Stream it into a temporary file** beside the binary the agent runs from, through the shell's
   stdin (`current` links to the release's directory, so the temporary file and the target are on
   one filesystem and the rename is atomic):

   ```sh
   node scripts/operations/node-shell.ts --node <NODE_ID> --domain <NODE_GATEWAY_DOMAIN> --label <you> \
     -- 'cat > "$(readlink -f /var/lib/pgcf/bin/current)/.pgcf-agent.part"' < pgcf-agent
   ```

5. **Check it on the node, install it and restart the agent,** in one command that stops at the
   first failed check (`<SHA256>` and `<SIZE_BYTES>` are the spec's):

   ```sh
   node scripts/operations/node-shell.ts --node <NODE_ID> --domain <NODE_GATEWAY_DOMAIN> --label <you> \
     -- 'set -e; cd "$(readlink -f /var/lib/pgcf/bin/current)"; [ "$(sha256sum .pgcf-agent.part | cut -d" " -f1)" = <SHA256> ]; [ "$(stat -c %s .pgcf-agent.part)" = <SIZE_BYTES> ]; chmod 0755 .pgcf-agent.part; mv -f .pgcf-agent.part pgcf-agent; sync; systemctl restart pgcf-agent.service'
   ```

   The rename replaces the agent's path atomically and the running process keeps its old file until
   the restart. If a check fails nothing was installed: remove the temporary file
   (`-- 'rm -f "$(readlink -f /var/lib/pgcf/bin/current)/.pgcf-agent.part"'`) and stream it again.

6. **The release path takes over.** The new agent's hello is accepted (`observation.state`
   `current`). Assign the release to the region (`PUT /v1/regions/{id}/release`): the agent runs the
   release's own agent binary already, so it installs the other three binaries and writes the host
   files itself without restarting; read `GET /v1/nodes/{id}/release` (`converged`) and
   `GET /v1/nodes/{id}` (`os_converged` true) as in [changing a unit or a configuration file](#changing-a-unit-or-a-configuration-file-no-new-image).

## The region's node policy

The rules a region's nodes decide by when they act alone (plan 4.3 to 4.7 and 7.5) are the region's
node policy. Every node's desired page carries it, and a region without one serves no page (the
nodes get a 409 "The region's node policy is not set"), so set it before the first node installs.
Read it with `GET` and replace it with `PUT` at `/v1/regions/{id}/node-policy` (an administrator
key; `PUT` needs scope `admin`). A PUT changes every node of the region that is not lost at once:
each is told to pull the new page, and admission uses the new values from then on.

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
`pgcf.slice`, the kernel's backstop under either memory rule, but the agent sets that limit only
when it starts. After a change of `awake_budget_mib`, admission follows the new value at once while
the slice keeps the old limit until the node's agent next starts (a release that changes the agent,
or a reboot), so the two disagree until then.

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
   `node_firewall_unconfirmed`) and the region's release verifies (`release_unverified`),
   `bootstrapping` while the installer runs and the node enrolls, and
   `ready` once the node has sampled with its credentials, which also opens it for placement.
   A node that does not enroll after the installer's reboot is restarted once through the API.
5. A new release reaches a running node without a reboot: assign it to the region and the node pulls
   its binaries and writes its host files (plan 9.3; the section below). Packages and kernels change
   only in the [maintenance cycle](recovery.md#node-maintenance-cycle), one node at a time. A node
   whose agent predates host files (EU1 today) first has its agent
   [replaced by hand](#replacing-the-agent-by-hand-a-node-whose-agent-predates-host-files), once.

Verify an install as described under [the node firewall](#the-node-firewall) and
[Cloudflare Access](#cloudflare-access-for-node-gateways-and-shells).

### Changing a unit or a configuration file: no new image

A systemd unit, a mask, or the sshd, journald, sysctl, tmpfiles, sysusers or modprobe configuration
of the image is a host file: it ships with the signed release, so a change needs no reinstall.

1. Edit the file in `infra/node-image/mkosi.extra` and merge it. A new file in one of the
   allow-listed directories also needs its row in `HOST_FILE_APPLY` (how it takes effect) in
   `infra/node-image/host-files.ts`; the build and the registration stop at a file the two tables do
   not name. A file outside those directories (the bootloader, `fstab`, the firewall, the presets)
   is the image's alone and still needs a new image: the
   [node image README](../../infra/node-image/README.md#what-ships-with-the-image-what-with-a-release)
   lists both.
2. CI builds the image and signs the release; register the signed build from a checkout of that
   commit and assign it to the region, as for any release. The dry run prints the number of host
   files and their digest.
3. Each node writes the files that differ after its binaries (a release that changes the agent is
   installed by the old agent, and the new one writes the files after its restart), holding the
   signed list to its own rules first. It runs `systemd-sysusers` and `systemd-tmpfiles --create` on
   the files that say so (`sysusers`, `tmpfiles`: no reboot is needed for a user or a directory),
   reads systemd's units again once, and restarts what changed: the gateway, cloudflared, ssh,
   journald and systemd-sysctl by name, the agent last. The agent's own unit is written to
   `/run/systemd/system` first and moves to its place when the agent that runs it has read its
   first page. A running per-database unit is not restarted: its stop settings (`KillSignal=`,
   `TimeoutStopSec=`, `ExecStop=`) are those of the new file at its next stop, and its process, its
   exec and namespace settings (`ExecStart=`, `MountImages=`, `PrivateMounts=`, `User=`) and the
   limits its cgroup enforces (`MemoryMax=`, `TasksMax=`, `CPUWeight=`, though `systemctl show`
   already reports the new ones) stay as they were until the database's next start.
4. Read the result with `GET /v1/nodes/{id}`: `os.host_files_sha256` equals the release's
   `spec.os.host_files_sha256` and `os_converged` is true once systemd has been told everything (a
   reload, a run or a restart that failed keeps `os_converged` false and is tried again after a
   growing wait, 5 s up to 5 min). The node's events (`host_files_applied`,
   `host_files_not_applied`, `agent_unit_promoted`, `release_refused`) carry a class and never a
   file's contents. The classes of a refusal are `host_file_path_refused`,
   `host_file_mode_refused`, `host_file_apply_refused` and `host_files_invalid`: they are the
   agent's own rules, and a node whose agent is older than the release refuses the files of a
   release that widens them (once, with the class) while it installs the binaries, which may carry
   the agent that knows them; a file that could not be read, written or told to systemd is
   `host_files_not_applied`.

Rules for the author of a change (the node image README
[states them](../../infra/node-image/README.md#changing-a-unit-or-a-configuration-file-without-a-new-image)):
a new agent starts under the previous agent unit, a host file works with the packages of the
release before (otherwise ship it in two releases), and a unit may need the users and directories
that the same release makes. A node whose new agent unit cannot start is recovered as in
[recovery](recovery.md#the-agent-does-not-come-back-after-a-release).

A release that changes `MountImages=` or `PrivateMounts=` in these files (the V4h change of the
volumes) is written to every running node, and nothing refuses it or checks it: the running
databases keep the topology they started with, each database's next start takes the new one, and
a node that holds both until every database has slept is in a state nothing has measured. Do not
assign such a release to a region that has running nodes; the change reaches EU1 with a reinstall.

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
