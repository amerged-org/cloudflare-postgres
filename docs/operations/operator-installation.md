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

Keep the private API configuration outside Git. It supplies D1, the one R2 archive binding,
NodeActor/DatabaseActor/CronWatchdog/ActorWarmer Durable Objects and the AddNode and
InfrastructureBackup Workflows. Start from `apps/api/wrangler.example.jsonc`; replace every placeholder. Import secret
values from private custody and preserve the existing ones on every redeploy. Export D1 before
applying additive migrations and rehearse them against the export.

| Worker secret | Holds |
| --- | --- |
| `API_KEY_PEPPER` | The HMAC key of API keys and of the installer's enrollment and progress tokens |
| `CREDENTIAL_KEYS` | The keyring that encrypts role credentials and the daily D1 export |
| `ROUTE_MASTER_KEYS` | The master keyring of the route tokens, the same on the Edge Worker; each node receives only the keys derived for it |
| `BOOTSTRAP_TOKEN` | Creates the first admin key, once |
| `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_USERNAME`, `CONTABO_PASSWORD` | The Contabo API credentials |
| `R2_PARENT_ACCESS_KEY_ID`, `R2_PARENT_SECRET_ACCESS_KEY` | An R2 API token with object read and write on the archive bucket, from which the Worker signs the nodes' temporary R2 credentials (plan 7.3) |
| `CLOUDFLARE_API_TOKEN` | Makes and deletes the nodes' Tunnels and their DNS records (permissions below) |
| `INFRASTRUCTURE_BACKUP_CF_TOKEN`, `RESEND_API_KEY`, `INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN` | Optional: the D1 export, direct email and the alert webhook (see below and the [infrastructure backup runbook](infrastructure-backups.md)) |

Every region archives into one R2 bucket, named without a region. The `ARCHIVE` binding is that
bucket (with `"jurisdiction": "eu"` on an EU installation), the variable `ARCHIVE_BUCKET_NAME`
names the same bucket and the variable `ARCHIVE_ENDPOINT_URL` is its S3 endpoint:
`https://<account>.eu.r2.cloudflarestorage.com` for a bucket of the EU jurisdiction and
`https://<account>.r2.cloudflarestorage.com` for one without a jurisdiction, where `<account>` is
the 32-character ID of the Cloudflare account that holds the bucket. A region row holds neither the
bucket nor the endpoint, so a region made in any way gets the installation's: the Worker signs the
temporary credential of every node with `ARCHIVE_ENDPOINT_URL`, whatever the node's region, and
makes the nodes' Tunnels in the account the endpoint names. No API sets either, because they are
not a region's setting (`POST /v1/regions` and `PUT /v1/regions/{id}/configuration` answer 400 for
a body that names `backup_bucket` or `backup_endpoint_url`). The keys keep regions apart:
`<region>/<database>/g<generation>-<operation>/database/` for a database generation,
`node-images/<release>/` for the node image releases and `infrastructure/v1/` for the daily
infrastructure backups. A binding that is missing, or a name that is not the bucket the archive
paths in D1 name, fails closed with an internal error. A Worker whose `ARCHIVE_ENDPOINT_URL` is
missing, is not an `https` URL or does not begin with an account ID hands out no archive credential
(`archive_credentials_unavailable`), makes no Tunnel (`node_tunnel_unconfigured`) and cannot fence a
lost node (`fence_unconfigured`), so set it in the private API configuration before the first
deploy of this change, from `apps/api/wrangler.example.jsonc`. Nothing checks that the endpoint is
the bucket's: R2 serves a bucket of the EU jurisdiction only at the `.eu.` host, so the general
host (or another account's) makes every upload of every node fail and no database becomes ready.
The jurisdiction and the account are those of the bucket in the Cloudflare dashboard, and the proof
is the first base backup of a database in each region: it is done under
`s3://<bucket>/<region>/<database>/g...` before the database is ready
(`GET /v1/databases/{id}/backups`).

The nodes' temporary R2 credentials are signed for `ARCHIVE_BUCKET_NAME` and one database
generation's prefix, so the parent key (`R2_PARENT_ACCESS_KEY_ID` and
`R2_PARENT_SECRET_ACCESS_KEY`, an R2 API token) must have object read and write on that bucket.

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
- `CLOUDFLARE_API_TOKEN` (a private secret) makes the node's Tunnel when the node first reads its
  credentials. Its gateway gets the hostname `pgcf-node-<id>.<domain>` under `NODE_GATEWAY_DOMAIN`,
  a domain of the zone `NODE_GATEWAY_ZONE_ID`; the Cloudflare account is the one `ARCHIVE_ENDPOINT_URL`
  names. Without the token, the domain or the zone a node gets no credentials and stays closed
  to placement. The API Worker uses this one secret for everything it does at Cloudflare for a
  node: it makes the Tunnel and its records (`domain/node-credentials.ts`) and deletes both when
  the node is declared lost (`domain/fence-actions.ts`). Create it as an API token with exactly two
  permissions:

  | Permission | Scope | What for |
  | --- | --- | --- |
  | Account: Cloudflare Tunnel: Edit | the account of `ARCHIVE_ENDPOINT_URL` | Lists, makes and configures the node's Tunnel; deletes it and its connections when the node is lost |
  | Zone: DNS: Edit | the zone `NODE_GATEWAY_ZONE_ID`, and no other zone | Makes, corrects and removes the node's CNAME records; deletes them when the node is lost |

  Declaring a node lost deletes, after its Tunnel, the node's records under `NODE_GATEWAY_DOMAIN`:
  the gateway's `pgcf-node-<id>`, the shell's `pgcf-shell-<id>` and the shell's former
  `pgcf-node-<id>-ssh`, each only if it points at one of the node's own Tunnels; a record with that
  name that points elsewhere, and every other record of the zone, is left. The Tunnel is deleted
  first and whatever the zone is: it is what fences the node. Without the DNS permission, or
  without `NODE_GATEWAY_ZONE_ID` and `NODE_GATEWAY_DOMAIN` (or with values that are not a zone and
  its domain), the records of the same step fail after the Tunnel is gone (`tunnel_delete_failed`,
  or `fence_unconfigured` when the zone is missing); the step is retried whole each minute, and the
  node is not ordered off until it holds. The Access setup script
  below takes its own token (`PGCF_CLOUDFLARE_API_TOKEN`), and `INFRASTRUCTURE_BACKUP_CF_TOKEN` is
  a third one; neither is this one.
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
  cycle and starts the install when the firewall is confirmed. It makes 288 cycles (about 2.4 h) and
  then ends; the capacity step of the minute cron starts it again within about a minute, because
  every addition belongs to a region with a node policy and that step starts the region's oldest
  addition that is neither `ready` nor `cancelled`. Nothing has to be requested or cancelled, and an
  audited recovery cannot be cancelled anyway (its server is bound already).
- Before it issues the tokens, AddNode verifies the signature of the region's release against the
  manifest rebuilt from the stored spec (the image's digests included) with the release public key of
  the API Worker. A row that does not verify (edited in D1, or registered by a path that did not
  check it) leaves the addition `audited` with `install_blocker` `release_unverified`; no tokens are
  issued and no rescue is requested. Register a release signed by the signer and assign it to the
  region ([release-signing.md](release-signing.md)); the next cycle goes on, within the 288 cycles
  above.
- To verify an install, try a TCP connect to port 22 of the instance's public IPv4 address from
  outside during the rescue and after the reboot. Both must time out.

### Moving to another archive bucket

The archive paths stored in D1 (`s3://<bucket>/<region>/<database>/g<generation>-<operation>`), the
credentials the nodes hold and the Worker's binding name the bucket, so a move changes more than the
binding. The endpoint (`ARCHIVE_ENDPOINT_URL`) does not change: the new bucket is in the same account
and jurisdiction, because a server-side copy stays inside one endpoint. The keys below the bucket stay valid: a key never contains the bucket, and it is unique per
database generation and operation, so the objects are copied unchanged and server side (CopyObject,
which stays inside one jurisdiction's endpoint). The old bucket is only read, except by the rollback's
mirror and cleanup below, until the owner says it may go. The move needs the owner's costed go for the new bucket;
the plan puts it after the acceptance tests and before the go-live gates.

What moves, and what does not. The move copies what a database that is not deleted needs: its archive
(the `archive_path` in D1), the node image releases (`node-images/`) and the infrastructure exports
(`infrastructure/v1/`). It does not wait for a retention window to end. The archives of deleted databases,
which stay restorable for their `backup_retention_days`, and the source archives of finished moves are not
copied unless the owner wants them restorable from the new bucket (their prefixes then join the list of
step 3): the expired and still-retained archives of test databases stay in the old bucket and go with it.
The rewrite of step 6 still points their rows at the new bucket. Nothing is under those prefixes, so a
restore from such an archive fails, and the Worker's purge (`cleanupRetainedArchives`) lists the empty
prefix and deletes the row when its retention ends. Keys of any other layout, such as the legacy keys of
an earlier runtime, stay as well unless the owner decides otherwise.

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

The files of the cutover. Make one directory for the whole cutover, `D=$(mktemp -d)` (mode 0700), and keep
it until the move is over; delete it at the end, and delete a file that holds a secret (the D1 export of
step 4, the rewrite of step 6) as soon as it has served. The tool writes a list (`--copied-file`,
`--missing-file`, `--extras-file`, and the `--out` of `sql`) only as a new 0600 file in a directory that
only its owner can enter, and it never overwrites: it refuses a file that exists, before it lists or
copies anything, so a name that is used twice stops the second pass at once and leaves the first pass's
file as it was. Every pass therefore names its own files, `"$D/copied-<pass>.txt"`,
`"$D/missing-<pass>.txt"` and `"$D/extras-<pass>.txt"`, where `<pass>` is the step and the number of the
pass: `3-1` for the first round of step 3, `8`, `10-1`, `10-2` and so on, and `rb4-1`, `rb4-2`, ... for
the passes of the rollback's step 4 (its step 7 repeats them). A pass that is run again (it failed, or its
check is repeated after a gap repair or a mirror) takes a `<pass>` of its own, `10-1b` or `rb4-1b`, and
the file of the first run stays as it was. A pass that finds no key writes no file, so an absent file
means that the pass found nothing, not that nobody read it; a file that exists holds every key of its own
pass, which a name used twice would not.

1. Make `0084` the only pending migration before anything is deployed. `wrangler d1 migrations
   apply` (and a deploy script's `--migrate`, which runs it before the deploy) takes every pending
   file, and `0082` and `0084` need opposite orders: `0082` (the dead capacity fields, D-1 of the plan)
   goes first, with a fresh daily D1 export in place and its Worker straight after it, while `0084`
   needs its Worker first. So D-1 is live before this move starts, and `wrangler d1 migrations list
   <database> --remote` shows only `0084` pending (`0083`, the credentials revision, is additive and goes before the
   Worker that reads its column, so it is applied before the deploy below); if `0082` or `0083` is
   pending, finish that first and run no `migrations apply` and no deploy with `--migrate` from this
   commit meanwhile. Check, read-only, that the bucket the Worker will use is the one the databases
   name. `<old>` is the value of `ARCHIVE_BUCKET_NAME` now (the earlier Worker read it only for a
   region that `ARCHIVE_BINDINGS` did not map, so it can be stale); no live database may name another
   bucket:
   ```sql
   SELECT count(*) FROM databases WHERE deleted_at IS NULL
     AND substr(archive_path,1,length('s3://<old>/'))<>'s3://<old>/';
   ```
   It must answer 0: step 3's list takes only the databases that name `<old>`, so a database that
   names a third bucket would be left out of the copy, and every archive operation of the Worker
   refuses its path. Then deploy the Worker with `ARCHIVE_ENDPOINT_URL` set to
   the endpoint of the bucket (the old bucket's, which is the new bucket's too), the single
   `ARCHIVE` binding and `ARCHIVE_BUCKET_NAME` still naming the old bucket, and the `ARCHIVE_US`
   binding and the `ARCHIVE_BINDINGS` variable gone from the private configuration (the Worker reads
   neither), and only then apply `0084`. The Worker of this
   commit reads neither region column, so it runs on the schema before `0084` (except that `POST
   /v1/regions` fails until `0084` is applied, because its insert names no endpoint), while the Worker
   before it reads both columns and cannot run on the schema after `0084`. From the deploy on, every
   credential the Worker delivers names the endpoint of the variable, whatever the node's region: a
   region that was made with the account's general endpoint for this EU-jurisdiction bucket (`us-dev`
   was) needs no correction, because its row is no longer read. A node of such a region holds
   credentials for the wrong host until its page names a new credential id; the rewrite of step 6
   gives every page new ids, and an installation that applies this change without a move deletes the
   `archive_credentials` rows of those nodes and runs the maintenance cycle on them instead.
2. With the owner's costed go, create the new bucket (same account and jurisdiction, so
   `ARCHIVE_ENDPOINT_URL` stays as it is). Then give the Worker a
   parent key that names both buckets, in one of two ways: add the new bucket to the policy of the
   token that is the parent key now, or create a second token whose policy names both buckets and set
   `R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY` to it, both in one `wrangler secret
   bulk` (two separate `secret put` calls deploy twice and leave a mismatched key pair live between
   them), and note the time the deploy ended (T_STEP2): that token is then in production, as the
   window below says. Keep the previous token, and keep
   the old bucket in every token that is a parent key, until step 11 revokes them: until step 6 every
   node archives into old-bucket paths with the credentials it holds, each signed by the previous
   token (the access key of a credential is the parent's), so deleting or narrowing that token ends all
   of them. Archiving then fails (`database_archive_failing`) and no database can sleep until the
   rewrite of step 6 has given every path a new credential id and the nodes have read it. A rollback
   signs for the old bucket with these tokens too.
3. Copy what a database that is not deleted needs while everything runs, in rounds, and repeat
   until a round copies only what changed. A round starts with the list of prefixes, made
   read-only into a new file of the cutover's directory (`"$D/prefixes-<round>.txt"`, 0600), and copies each line:
   ```sql
   SELECT substr(archive_path,length('s3://<old>/')+1) FROM databases
     WHERE deleted_at IS NULL AND substr(archive_path,1,length('s3://<old>/'))='s3://<old>/';
   ```
   The copy and the compare take one `--prefix` a call, so run each once for every line of the list
   (`<region>/<database>/g<generation>-<operation>/`) and once each for `node-images/` and
   `infrastructure/v1/`. `copy` lists the destination under the same prefix as the source and
   refuses (it prints `refused ... Nothing was copied` and exits 2) when the destination holds a key
   that the source lacks. The copies of the first round take no flag, so that each refuses a bucket
   that already holds keys under its prefix (the wrong bucket, or one that is already serving). Every
   other copy of the move names `--allow-extra-destination-keys` (`copy --prefix <prefix>
   --allow-extra-destination-keys`) and would otherwise refuse: each later round, where a key that
   the old bucket's retention deleted since the last round is an extra in the new bucket; the warm
   copy of a second attempt after a rollback, where the new bucket holds the first attempt's keys;
   and the copies of steps 8 and 10 and of the rollback's mirror below. The flag only lifts the
   refusal: the copy never deletes, step 8 removes the extras that retention explains, and the check
   of step 10 judges the others. The last round, the one that ends before step 5, makes its own list
   at its start and starts its first copy within an hour of making the list. That is what covers a
   database created after the list: it is not on it, so no per-prefix copy brings its first base
   backup or its WAL, and only the passes by time of steps 8 and 10 can. They reach the keys
   modified since their `--since`, which step 8 takes an hour before the earliest pass of the last
   round began, so with the first copy within the hour of the list it lies before the list was made,
   and every key of a database created after the list is newer than it. A list from an earlier
   round, or a last round that begins more than an hour after its list, leaves a gap: a database
   created in between has its first base backup and its WAL in no per-prefix copy and older than
   every later `--since`, and it has no restorable base backup in the new bucket until its next
   one. The passes by time take no prefix: they copy whatever was written since, and a deleted
   database writes nothing, so they bring none of the left-behind archives along, and they catch
   a database created after the last round's list was made.
   A key counts as copied when its size and ETag, or its size and a LastModified not older
   than the source's, match, because R2 may recompute a multipart ETag on a copy. Compare sizes and
   ETags of every key of the list, the bodies of the ones whose ETag differs, and the stored sha256
   and custom metadata of the node images and infrastructure exports (a HEAD returns a checksum
   only when it asks with `x-amz-checksum-mode`). An object whose checksum the copy lost is uploaded
   again with `register-node-image.ts` run with `PGCF_R2_BUCKET` set to the new bucket: until step
   5 the variable names the old one, where the script finds the object complete and sends nothing.
4. Rehearse the rewrite below on a D1 export. Check that no create, restore, move or base backup is in flight
   and that every node runs its region's release.
5. Deploy the Worker with `ARCHIVE` bound to the new bucket and `ARCHIVE_BUCKET_NAME` set to it. Note
   the time (T_B) immediately before the deploy starts and after the last warm copy has ended: every
   copy predates it, and everything a database or the Worker writes into the new bucket postdates it
   (a time noted afterwards would cover a database created in between, whose keys exist only in the
   new bucket). From here the Worker deletes (retention, expiry) in the new bucket only. Until step 6
   ends, the minute cron's retention step reports failed every minute: it throws for each database row
   that still names the old bucket and applies no retention window meanwhile. That alert is expected
   and must stop after step 6. Point the release registration (`PGCF_R2_BUCKET` of
   `register-node-image.ts`) at the new bucket too: it uploads into that bucket and the Worker reads
   the bound one.
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
   new credential, and the old rows record when the old credentials expire. Note the time the file
   ended (T_REWRITE).
7. Run the maintenance cycle (`POST /v1/nodes/{id}/maintenance`) on every node that holds a database
   and wait until it is `done`. The node answers new wakes with `57P03`, puts every awake database to
   sleep with the proof and reopens placement; by then it has read the new credentials and accepted
   the new paths, and no database is awake. Each database of the node also has a credential row for
   its new path issued after T_B (a database created after the deploy names the new bucket from the
   start, so its row is older than the rewrite and a test against the rewrite would never pass).
   Read-only, with `<T>` = T_B, no row may answer; each row is a node and the number of databases
   that cannot have switched yet (awake or possibly awake, with no read-write credential row for the
   current path issued after `<T>`; the time is written as D1 writes it, `2026-10-19T10:00:00.000Z`):
   ```sql
   SELECT d.node_id,count(*) n FROM databases d JOIN nodes n ON n.id=d.node_id AND n.lost_at IS NULL
   WHERE d.desired_state IN ('running','suspended','deleted')
     AND (d.desired_state<>'suspended' OR d.power_operation IS NOT NULL)
     AND NOT(d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation)
     AND NOT EXISTS(SELECT 1 FROM archive_credentials c WHERE c.node_id=d.node_id AND c.archive_path=d.archive_path
       AND c.access='read_write' AND c.issued_at>'<T>') GROUP BY d.node_id
   ```
   Databases that were asleep stay asleep. If a cycle fails or
   a node is offline, do not go on: that node's awake databases may still write into the old bucket.
8. Copy again what the old bucket received since the warm copy: with no prefix and only the keys
   modified since a time a little before the last warm round, the `next_since` of the earliest pass of
   the last warm round (an hour before it began, so before that round's list was made (step 3), and no
   earlier, so that a key the new bucket's retention has deleted before is not brought back):
   `copy --since <next_since> --allow-extra-destination-keys --copied-file "$D/copied-<pass>.txt"`. The flag is not
   optional here: step 7's cycle archived the final WAL of every awake database into the new bucket
   only, and a database created after the deploy exists only there, so without it the copy refuses
   and copies nothing. Then compare: `verify --from <old> --to <new> --since <next_since>` (the same
   time; without `--since` it would report every left-behind archive as missing). Then delete from the
   new bucket the copies of what the old bucket's retention deleted before step 5 (written there at or
   before T_B, absent in the old bucket), or a deleted database's data outlives its recovery window:
   `prune --from <old> --to <new> --before <T_B>` is the dry run (it prints the count and the first
   keys), the same with `--execute` deletes. T_B was noted before the deploy of step 5,
   so a database created after it is never touched. After a rollback (a second attempt) this delete
   is allowed only when the rollback's reverse checks are done (the last chained pass, after X_NEW,
   found nothing missing, and the missing keys of every earlier pass were mirrored or found unnamed)
   and its step 4 cleaned the old bucket: it also deletes every key that the first attempt wrote into
   the new bucket before the new T_B and that the old bucket lacks, the WAL that only the new bucket
   holds, and it keeps in the new bucket every archive that the old bucket still holds, which the
   warm copy of the second attempt brings back from there.
9. Accept on the new bucket: wake a database, write, let it sleep (its WAL appears under the same
   prefix in the new bucket and the old bucket gets no new key), take a base backup, restore to a point
   in time, `HEAD` and `GET` a release file through `/node/v1/releases/<release>/<file>` (it reads the
   bound bucket; registering a known release again does not) and wait for the next infrastructure
   backup.
10. Repeat the copy and the check for new keys in the old bucket after an hour, a day and after the
    last credential for the old bucket has expired (`max(expires_at)` of the rows that name it, at
    most seven days). Each pass is `copy --since <next_since> --allow-extra-destination-keys
    --copied-file "$D/copied-<pass>.txt"`, with no prefix, and takes as `--since` the `next_since` its previous pass
    printed (its listing start minus an hour; the first pass takes the one that step 8's copy printed),
    never an earlier one. The flag is not optional: the new bucket holds what the Worker and the nodes
    wrote into it since step 5, which the old bucket lacks, so without it every pass refuses and copies
    nothing. The old bucket gets no deletion after step 5 while the new bucket's retention goes
    on, so a pass with an earlier time copies back what the new bucket deleted legitimately, such as
    the purged archive of a deleted database, and nothing deletes it again. The hour of overlap is
    needed, because uploads into the old bucket do not stop at step 7's barrier: a node whose read of
    the new credential failed keeps its registration for the old path (`ensure_archive` finds no
    endpoint for the new path and returns false, and the apply and wake paths ignore that), so its
    databases archive into the old bucket until the last old credential expires, and a multipart
    object (a base backup) carries its start time: one that began before a pass listed and ended
    after it is older than a window that began a minute before that listing, and no later pass would
    copy it. The hour costs nothing: the new bucket's retention deletes by name only what precedes a
    base backup that ended at least `backup_retention_days` (a day at least) before, and a purge or an
    expiry waits as long for a deleted database or a finished move, so the overlap copies back only a
    key that retention deletes again, or a purged prefix that the check below finds unnamed. Run
    after each pass also the tripwire, `inventory --from <old> --since <T_REWRITE>` (how many keys the
    old bucket received since step 6's file ended, with the first ten), and `verify --from <old>
    --to <new> --since <T_REWRITE> --sample-heads 0 --missing-file "$D/missing-<pass>.txt"`: every key the old bucket received since step 6's file ended, compared with
    the new bucket whatever the chain skipped (the keys of a pass are in its own file, and a pass that finds none writes none). In the passes of an hour and a day it finds nothing
    missing (the new bucket's retention cannot have acted on keys that young). After the last
    credential has expired a missing key is no gap only if no row names its prefix (below) or if it is
    older than the `backup_retention_days` of its database's size class (the line shows `modified=`:
    retention may have deleted it); any other is a gap, copied with `copy --since <T_REWRITE> --prefix
    <its prefix> --allow-extra-destination-keys` (a live prefix always needs the flag: the new bucket
    holds that database's WAL from after the switch, which the old bucket lacks), after which the check
    runs again (under a `<pass>` of its own, such as `10-1b`). A pass that copies a key is real, not noise (`"$D/copied-<pass>.txt"` holds all of them): check
    that the key's prefix is still named by a row that the Worker has not purged yet. No row of
    `databases` or `database_moves` is ever deleted: the purge of a retained archive deletes only its
    `retained_archives` row and the deleted database keeps its `archive_path` (`deleted_at` set), and
    the expiry of a superseded archive only sets `source_archive_deleted_at` or
    `target_archive_deleted_at`. So the prefix counts while a database that is not deleted is on it,
    while a `retained_archives` row names it, while the source of a done move or the staged target of a
    failed move is not marked deleted, and while it is the target of a move in flight. As a read-only
    query, where `<bucket>` is the bucket whose name the rows carry (the
    new bucket after step 6; the old one after the rollback's step 2) and `<prefix>` is
    `<region>/<database>/g<generation>-<operation>`, a row answers when the prefix is named:
    ```sql
    SELECT 1 FROM databases WHERE archive_path='s3://<bucket>/<prefix>' AND deleted_at IS NULL
    UNION ALL SELECT 1 FROM retained_archives WHERE archive_path='s3://<bucket>/<prefix>'
    UNION ALL SELECT 1 FROM database_moves WHERE
      (status='done' AND source_archive_path='s3://<bucket>/<prefix>' AND source_archive_deleted_at IS NULL)
      OR (status='restoring' AND target_archive_path='s3://<bucket>/<prefix>')
      OR (status='failed' AND target_archive_path='s3://<bucket>/<prefix>' AND target_archive_deleted_at IS NULL)
    ```
    A prefix that nothing of this names came back from a purge or an expiry and is no
    gap; the owner deletes it from the new bucket. For a real gap, find the node whose credential read
    failed (usually a parent key that lacks the new bucket) and wake its databases again. The last
    pass is the one after the last credential for the old bucket has expired. Step 11 ends that wait
    at once: the access key of a temporary credential is the parent key's, so revoking the earlier
    parent keys (step 2's) ends every credential signed with them, and the last pass then runs after
    the revocation.
11. Retire the old keys: the previous parent token (the one that was the parent key before step 2),
    the token that step 2 made when it made a second one, the mirror token if there was one, and every
    bucket-wide key, and then, after the last pass of 11.5, the token of the copy. The Worker signs every credential a node holds from the
    parent key and never stores one, a credential's access key is the parent's, and a node reads a
    credential only when its page names a new id (the API renews a row after a third of its seven
    days). Deleting an earlier parent token before the nodes hold credentials signed with the new one
    ends the credentials they hold and archiving fails until they read new ones
    (`database_archive_failing`). So, in this order:
    1. Create the new parent token: object read and write on the new bucket and no other. Set
       `R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY` to it (both in one `wrangler
       secret bulk`) and deploy the Worker. From here until 11.4 a rollback also puts the parent key
       back (the rollback's step 1); keep the tokens of step 2 and the previous one. Note
       the time the deploy ended (T_KEY): every credential the Worker delivers from then on is signed
       with the new key, and the ones the nodes already hold are not.
    2. Replace the credentials the nodes hold, in one of two ways. Wait one credential lifetime: read
       the time below at T_KEY and wait until it has passed (seven days at most), after which every
       credential a node holds was delivered after T_KEY:
       ```sql
       SELECT max(expires_at) FROM archive_credentials WHERE issued_at<'<T_KEY>';
       ```
       Or force the refresh now, which makes every page name a credential with a new id on the node's
       next pull; the node reads it and holds it instead of the old one:
       ```sql
       DELETE FROM archive_credentials WHERE issued_at<'<T_KEY>';
       ```
       Then run the maintenance cycle on every node that holds a database, as in step 7, and wait
       until each is done: a pull reads the credentials before it obeys an order, so a cycle reported
       done was obeyed after them. Check, as in step 7 with `<T>` = T_KEY, that no row answers. A node
       that was offline keeps its old credentials until it pulls: do not go on while one is offline.
    3. With the old keys still alive, check on the new key (each reads or writes through a credential
       a node read after T_KEY): a WAL archive (wake a database, write a row, let it sleep: its WAL
       appears under its prefix in the new bucket with a LastModified after T_KEY and
       `database_archive_failing` is not raised), a base backup (take one; it counts when it is done,
       and the archive summary `GET /v1/databases/<id>/archive` lists it) and a restore read (restore
       a database to a point in time as a new database and compare its rows: the restore reads the base
       backup and the WAL with a read-only credential).
    4. Only when all three pass, revoke the old keys (delete the tokens): both earlier parent tokens,
       the previous one and the one of step 2 (a single token when step 2 only added the new bucket to
       the policy of the previous one), with the mirror token and every bucket-wide key. Keep the
       token of the copy for 11.5: the last pass reads the old bucket and writes the new one with it,
       and it signs nothing in the Worker's name. From here there is no rollback to the old bucket:
       nothing can sign for it any more. Note the time (T_REVOKE).
    5. After the revocation, repeat the WAL archive check once, and run step 10's last pass, its
       cross-check and the tripwire: every credential for the old bucket is dead, so nothing is written
       into it after T_REVOKE and the pass copies what had arrived until then. A database that now
       fails to archive belongs to a node that never read a credential after T_KEY: delete the
       credential rows of its databases again (as in 2) and wait for its next pull; restarting
       `pgcf-agent` makes it read every credential again. Then delete the token of the copy.
12. Only when step 11 is done, step 10's last pass ended without a failure and its check shows no gap,
    and with the owner's word, delete the old bucket.

What can be rolled back, step by step. The rollback is the procedure under "If a step fails" below;
it returns the installation to the old bucket. It needs three things at once: a parent token that
names the old bucket (something that still signs for it), the old bucket holding every key written
there, and paths in D1 that can be swapped back. The steps end them one after the other, so the
answer differs from step to step:

- **Step 1.** The Worker with `ARCHIVE_ENDPOINT_URL` can be redeployed to its earlier version until
  `0084` is applied (with the `ARCHIVE_US` binding and the `ARCHIVE_BINDINGS` variable put back in the
  private configuration, which step 1 removed). `0084` cannot be rolled back: it drops two columns with their data, only D1
  Time Travel brings them back, and after it only a Worker of this change or a later one runs. Every
  rollback below therefore runs on the new Worker, with the old bucket in its configuration.
- **Steps 2 to 4.** What is in production depends on how step 2 gave the Worker its parent key.
  - *The new bucket added to the policy of the token that is the parent key.* No secret changed and
    nothing signs for the new bucket: the copies of step 3 run with the move's own token. Giving up
    takes the new bucket out of that token's policy again only once the bucket is unused (no copy
    runs and step 5 was never deployed), or leaves it there. The old bucket stays in the policy, whatever else is done: until
    step 11.4 every node archives into it with credentials that token signed.
  - *A second token set as `R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY`.* That token
    is in production from step 2 on. It is the Worker's parent key and so the access key of every
    credential the Worker delivers from then on (for old-bucket paths too), and the nodes hold those
    credentials for up to seven days. It does not go with the empty bucket: deleting it ends them,
    archiving fails (`database_archive_failing`) and no database can sleep until their rows renew.
    Giving up therefore has two roads. Either keep the second token as the parent key and retire the
    previous token instead; or put the previous token back with both secrets in one `secret bulk`
    (T_BACK, the time that deploy ended) and retire the second token. The token the Worker no longer
    signs with is retired as step 11.2 retires the earlier parent keys, with T_STEP2 (the first road)
    or T_BACK (the second) in place of T_KEY: after one credential lifetime, or after the forced
    refresh with the barrier. Only then delete that token. Until then both tokens stay alive, with the
    old bucket in their policies.
  A failed copy is repeated, and the move is given up by leaving the new bucket to the owner.
- **Steps 5 to 10.** The whole rollback applies (its steps 1 to 7). Redeploying the old
  configuration alone undoes nothing: the paths in D1 and the nodes' credentials name the new bucket
  until the rollback's step 2 and 3.
- **Steps 11.1 to 11.3.** The whole rollback still applies, with one addition to its step 1: the
  Worker's parent key goes back to the token that names the old bucket. Step 11.1 sets
  `R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY` to a token without the old bucket, and
  a rollback that leaves it there signs every credential for the old bucket with a key R2 refuses
  for it. This window lasts until 11.4, which is up to a credential lifetime (seven days) when
  11.2 waits instead of forcing the refresh. The delete of 11.2 needs no undoing: the rollback's step
  2 deletes the credential rows again.
- **Step 11.4 and after (the revocation).** There is no rollback. The earlier parent tokens are
  deleted, and with them every credential signed with them, so nothing the Worker or a node holds
  can write into the old bucket, and no step of this section makes it able to. The old bucket still
  holds everything written until T_REVOKE (step 11.5 copies the last of it), but returning to it is a
  new procedure that the owner decides on (a new token for it, the rollback's swap and a mirror of
  what the new bucket received since step 5), not this one. From here a fault is fixed forward in the
  new bucket.
- **Step 12.** Deleting the old bucket cannot be undone.

If a step fails. Before step 5, the Worker's bucket, the stored paths and the bucket every credential names are
unchanged (a failed copy is repeated), except that a second parent token set at step 2 is in production
and signs every credential delivered since (the windows above). From step 5
until step 11.4 revokes the earlier parent tokens, every rollback is the same whole procedure,
because nothing records whether a node switched and a check that no credential names the new bucket
races the nodes' pulls every 60 seconds (after the revocation nothing signs for the old bucket and
only fixing forward is left):

1. Redeploy the old configuration (`ARCHIVE` and `ARCHIVE_BUCKET_NAME` name the old bucket;
   `ARCHIVE_ENDPOINT_URL` stays). When step 11.1 has run, set `R2_PARENT_ACCESS_KEY_ID` and
   `R2_PARENT_SECRET_ACCESS_KEY` in the same deploy back to the token that named the old bucket
   before 11.1: the token of step 2, or the previous token when step 2 only added the new bucket to
   its policy (both are alive until 11.4). The token of 11.1 names the new bucket only. Left as the
   parent key, it signs every credential for the old bucket without that bucket, R2 refuses every
   upload, every database raises `database_archive_failing`, none can sleep, and restarting
   `pgcf-agent` (step 5) cannot help. Keep the 11.1 token until X_NEW (below) has passed: it is the
   access key of the credentials that a node which did not switch still holds for the new bucket.
   Until step 2 ends, the retention step fails again for the rows that name the new bucket (expected).
   The Worker signs nothing for the new bucket from now on. Read `max(expires_at)` of the
   `archive_credentials` rows that name the new bucket (X_NEW) now: step 2 deletes them, and with them
   the only record of when the credentials signed for the new bucket die. A node that does not switch
   keeps writing into the new bucket with one until then (steps 4 and 7).
2. Note the time (T_R2) immediately before the file runs. Run the rewrite with the two names swapped
   (every statement touches only rows that name the other bucket, a database created after step 5
   included) and in the same file delete every `archive_credentials` row that names either bucket. The
   delete is not optional: a node remembers the id of every credential it has read and keeps one
   credential per archive prefix without the bucket, and the API reuses a credential row younger than
   a third of its seven days. After a swap back the page would name the old bucket's row again, which
   the node believes it has, while the credential it holds for that prefix is signed for the new
   bucket; every upload into the old bucket would be refused for up to about 2.3 days. A row with a
   new id makes the node read the right one. The delete leaves no row older than the file's run, so
   every credential row for an old-bucket path that exists afterwards was issued after T_R2. A time
   noted after the file would miss a pull between the delete and the note: it mints a row older than
   that time, the API reuses it for about 2.3 days and step 3's check would never accept its database.
3. Run the maintenance cycle on every node again and check, as in step 7 but against T_R2, that each
   database has a credential row for its path issued after T_R2. Note the time the check passed
   (T_R3).
4. Compare the other way round, read-only (`verify --from <new> --to <old> --since <S> --sample-heads 0
   --missing-file "$D/missing-<pass>.txt" --extras-file "$D/extras-<pass>.txt"`, with `<pass>` = `rb4-1` for the first pass, in the cutover's directory).
   The first pass takes `<S>` = T_B; it prints `listing_started_at` and `next_since` (its listing
   start minus an hour), which the next pass takes (step 7). It answers two questions.
   - *Missing*: keys the new bucket received that the old one lacks (a node wrote WAL, a base backup
     or an export into the new bucket, and the upload log will not send them again). Apply the
     rollback's prefix check (below) to the keys of `--missing-file`. A key whose
     prefix a row names is a gap: mirror it. A key whose prefix no row names is no gap: the old
     bucket's Worker purged that archive since step 1, and the new bucket still holds the copy that
     step 8 or 10 made.
   - *Extras*: keys the old bucket holds that the new one lacks. They are the archives that the new
     bucket's Worker purged or expired between the deploy of step 5 and step 1 of the rollback, the
     keys a database wrote into the old bucket since step 2, and every archive that step 3 never
     copied (the prefix check keeps those that a row still names, and cleanup (b) deletes the rest,
     which the old Worker's retention would delete). Nothing in the rollback deletes in
     the old bucket, and the Worker no longer will for the first kind: while the new bucket was live,
     `cleanupRetainedArchives` emptied the prefix of a deleted database's retained archive and then
     deleted its `retained_archives` row, and `expireSupersededArchives` set
     `source_archive_deleted_at` or `target_archive_deleted_at`. Step 2's swap restores no row that
     makes the Worker select such a prefix in the old bucket again, so a deleted database's data would
     outlive its recovery window for ever in the bucket that is live again, and the warm copy of a
     second attempt would bring it into the new bucket, where step 8's delete keeps it because the old
     bucket holds it.

   The rollback's prefix check is step 10's query with `<bucket>` = the old bucket: after step 2 every
   row names the old bucket again. The query for the new bucket finds no row for any prefix after the
   swap: run with it, every key would count as unnamed, so nothing would be mirrored and the cleanup
   (b) would take the whole extras file. Fill in the old bucket's name before the first comparison.

   The mirror (a) and the cleanup (b) need the owner's separate go, because the token of the move
   has only read on the old bucket, so that nothing can write or delete there. Create a second token
   with read on the new and read and write on the old bucket (the permission that lets step 8's
   delete work in the new bucket lets this one delete in the old), use it for both and delete it
   afterwards.
   (a) Mirror the missing keys of a named prefix: a copy that only adds missing keys and never
   replaces one (`copy --from <new> --to <old> --since <S> --add-only --allow-extra-destination-keys
   --copied-file "$D/copied-<pass>.txt"`). The flag is not optional: the old bucket holds the archives that step 3
   never copied, which the new bucket lacks, so without it the copy refuses and mirrors nothing.
   Check each copied key's prefix with the rollback's prefix check: a purge there since step 1 may
   have deleted an archive whose copy the new bucket still holds, and that copy must not stay (the
   owner deletes those few keys by hand, because (b) does not take a key that the new bucket also
   holds). Run the comparison again with the same `<S>` (under a `<pass>` of its own, `rb4-1b`): nothing missing, or only keys of unnamed
   prefixes.
   (b) Clean the old bucket: take the extras file and the prefix
   `<region>/<database>/g<generation>-<operation>` of each key (its first three path segments), run
   the rollback's prefix check for each, and write the keys of the prefixes that no row names, and
   only those, into a new 0600 file of the cutover's directory, `"$D/clean-<pass>.txt"` (extras of other classes, `node-images/` and
   `infrastructure/`, are none of this: tell the owner). `prune --from <new> --to <old> --before
   <T_R2> --keys-file "$D/clean-<pass>.txt"` is the dry run, the same with `--execute` deletes. It deletes in the old
   bucket only the listed keys that the new bucket lacks and that were written at or before T_R2, and
   it refuses a list that names a key outside the archive layout. A prefix that a row names stays: a
   database wrote into it, or the old Worker's retention owns it. T_R2 and not T_R3 bounds the
   delete: every key the cleanup is meant to delete is an archive that the new bucket's Worker purged,
   written into the old bucket before T_B, while everything the swapped-back system wrote there since
   step 2 is newer than T_R2 and stays whatever the prefix check says; step 3's maintenance cycle
   archives the final WAL of every database that was awake into the old bucket between T_R2 and
   T_R3, the new bucket lacks those keys, and with T_R3 a wrongly written check would delete them
   from the bucket that is live again.

   If the go is refused while keys of named prefixes are missing, the new bucket stays as it is,
   because it is the only copy of those keys, and the old bucket has gaps for point-in-time recovery:
   say so. If it is refused while (b) has keys to delete, those keys stay in the old bucket past their
   recovery window: say so, and start no second attempt before the owner has deleted them by hand.
   One comparison is not final: a node whose read of the old credential failed accepts the old path
   all the same and keeps the registration it has for the new bucket (the agent's `ensure_archive`
   returns false and the wake path ignores that), so its databases go on writing into the new bucket
   until X_NEW; nothing records it, and the check of step 3 only sees that a row was minted. Hence
   step 7.
5. Prove archiving into the old bucket with a canary: wake a database, write, let it sleep; its WAL
   appears under the same prefix in the old bucket and the new one gets no key since T_R3 (not since
   T_R2: until step 3 is done, nodes that had not switched yet still write into the new bucket). A node
   that still refuses its uploads is restarted (`pgcf-agent` forgets what it was delivered and reads
   every credential again).
6. Point `PGCF_R2_BUCKET` back at the old bucket.
7. Repeat step 4 (and its mirror when it says so) as chained passes, each with its own `<pass>` (`rb4-2`,
   `rb4-3`, ...), one hour and one day after step 3 and once more after X_NEW, when no credential for the new bucket is alive any more. The first
   pass is step 4 with `<S>` = T_B; each later pass takes as `<S>` the `next_since` that the
   previous pass's verify printed (its listing start minus an hour: keep the hour, because nodes may
   still upload into the new bucket until X_NEW and a multipart object can carry its start time). A
   pass that failed is repeated with its own `<S>`; never T_B again, and never the same `<S>` twice.
   After step 1 the old bucket's own retention, purge and expiry act on it again, so every key that
   the new bucket holds with a LastModified after T_B and that the old bucket then deleted
   legitimately counts as missing for every pass that keeps T_B: the copies of step 8 and 10 (the new
   bucket stamps the copy time) and the new-only WAL that the first mirror put into the old bucket.
   Each mirror would copy them back and the old bucket's retention would delete them again, so the
   gate below could not be met on an installation whose retention is shorter than about seven days.
   The gate: the last chained pass, after X_NEW, found nothing missing (a missing key whose prefix no
   row names is no gap), and the missing keys of every earlier pass were mirrored or found unnamed.
   Neither the deletion of the new bucket nor a new attempt (its step 8 delete takes every key of the
   new bucket that the old one lacks and that was written before the new T_B) may happen before the
   gate is met and step 4's cleanup has run. The new bucket stays until the owner decides: delete it,
   or try again from step 3.

The migration of step 1 has no way back; D1 Time Travel is the last resort.

### Keeping the DatabaseActors warm

A DatabaseActor whose isolate has been idle for a few seconds is evicted, and the next admission
of its database then pays 200 to 600 ms to load it again: after a quiet hour that is the biggest
part of a cold first request that is not PostgreSQL's own (ULTRA plan 11.1, "Keep-warm for the
DatabaseActor", and 11.2, "Cold gate"). A call to the actor every 10 s or faster keeps it loaded,
so the API Worker visits every actor of a database that is not deleted, sleeping databases above
all, with a no-op call (`DatabaseActor.warm`) that reads and writes nothing: no row, no D1
statement, no counter, no ticket.

The visits come from `ActorWarmer` Durable Objects, one for every 78 databases at the default
interval of 8 s, each from its own alarm loop. A warmer keeps six visits in flight, the six
simultaneous outgoing connections a Durable Object has for one invocation (Cloudflare's Durable
Objects limits page, https://developers.cloudflare.com/durable-objects/platform/limits/, read
2026-10-20: "Simultaneous outgoing connections/request: 6 (same as Workers)"). The Workers limits
page it points to (https://developers.cloudflare.com/workers/platform/limits/, read 2026-10-20)
queues a seventh connection and lists fetch, KV, Cache, R2, Queues and TCP among those that count,
without naming calls to Durable Object stubs, so whether a visit counts is open; six in flight
never wait for a slot either way. A shard is as many rounds of six visits as take half the
interval at 300 ms a visit (13 rounds of 6 at 8 s, `actorWarmShardSize`). The 300 ms is what the
first live cycles of the Dev installation imply if the limit applies (167 visits in a median 9.0 s
at 16 in flight: 320 ms a visit at six at a time); if it does not apply they imply 820 to 860 ms a
visit, and shards of 56 to 78 then fit the interval only after the warmers are placed near the
actors. It is lowered once the cycle lines show the visit time near the actors (see "Observing
it"). A database ID is 20 random characters, so the
warmers split the ID space into equal ranges (warmer k of n visits the IDs between the k-th and the
(k+1)-th n-th of the space) and each holds about 78 databases give or take 11 % at one standard
deviation, so a shard twice the average still ends its cycle within the interval. The warmers are
named `v2:<shard>` (see "Placement"). The minute cron's step `actor_warmers` counts the live
databases, arms one warmer per 78 of them and renews their three-minute lease; a warmer that is no
longer armed stops by itself, so a cron that stops or an interval of 0 ends the visits within three
minutes, and a deploy or a fault that loses an alarm is repaired by the next minute. A warmer reads
the databases of its own range from D1 about every minute, not every cycle (see "D1 reads" below), so
a new database is visited within about a minute of its creation and a deleted one stops being visited
within about a minute. A visit that fails or does not answer within 3 s is counted and never delays
the admission of any connection.

| Setting | Where | Meaning |
| --- | --- | --- |
| `ACTOR_WARMER` binding, class `ActorWarmer`, and a migration with `new_sqlite_classes: ["ActorWarmer"]` (tag `v7` in `apps/api/wrangler.example.jsonc`; use the next unused tag of the deployed configuration) | private API configuration | Required while the interval is not 0. Without the binding the step `actor_warmers` fails each minute (`actor_warmer_binding_missing`) and, after five runs in a row, raises `control_cron_step_failing`; every other step still runs. |
| `DATABASE_ACTOR_WARM_INTERVAL_MS` (variable) | private API configuration | Milliseconds between two visits of an actor: unset is 8000, `0` turns the keep-warm off, any other value is 1000 to 300000; anything else makes the step fail (`invalid_actor_warm_interval`). Keep it at 10000 or below: the gap between two visits of an actor is the interval plus the alarm's jitter plus the spread of a cycle (about a second), a visit loop of 10 s or faster kept every probe fast in the measurement, and beyond it a growing share of admissions found a reloaded actor. |
| `DATABASE_ACTOR_LOCATION_HINT` (existing variable) | API and Edge Workers | The warmers are placed with the same hint as the actors, so that a visit does not cross a continent. |
| `ACTOR_WARMER_LOCATION_HINT` (variable) | private API configuration | Used only while `DATABASE_ACTOR_LOCATION_HINT` is not set: the Durable Object location hint of new warmers. Set it to where the actors live (`weur` for Dev). With neither variable set a new warmer is placed wherever the minute cron invocation that creates it runs. |

**Placement.** A location hint decides where a Durable Object is created and never moves an
existing one. A warmer created while no hint was configured ran wherever the minute cron invocation
that created it ran; a warmer on another continent than the actors pays an ocean for every visit. The warmers are therefore named `v2:<shard>` (the first release named them `shard-<shard>`,
and `ACTOR_WARMER_NAME_VERSION` in `domain/actor-warm.ts` is raised whenever the warmers must be
created again, for example after the hint changed): the first minute cron after a deploy creates
the new objects with the hint, the earlier objects are no longer armed and stop by themselves when
their three-minute lease has run out (their next alarm after it logs `actor_warm_stopped`, sets no
alarm and deletes the stored shape), and for those minutes both visit the actors. Nothing is
deleted by hand. To change the hint later, set the variable and raise the version in a release.

No secret and no other binding is needed. Deploy the API Worker with the migration; the first
minute cron afterwards arms the warmers, and their first visit comes one interval later.

**Cost.** Each visit is one Durable Object request, so the cost is proportional to the number of
databases and to the visit rate, and it is charged for sleeping databases as well. Per month of 30
days at an interval of 8 s, for 170, 300 and 1,000 databases, with one warmer for every 78
databases (3, 4 and 13 warmers). The Durable Object figures are estimated from the measured ones of
plan 11.1 at the pricing page of 2026-10-18, not from an invoice. Figures are in USD. The warmers
line is not measured either: it follows from the visit time, which the table assumes to be the 300 ms
the shards are sized for (see "The warmers line" below).

| Item | 170 databases | 300 databases | 1,000 databases | Basis |
| --- | --- | --- | --- | --- |
| DatabaseActor requests | 8.3 (55 million) | 14.6 (97 million) | 48.6 (324 million) | 324,000 visits for each database and month at USD 0.15 per million; the measured figures at 10 s and 5 s are USD 43.6 and USD 83.8 per 1,000 databases in all, and at 30 s USD 16.3 with a tail of 250 to 317 ms at p95 |
| DatabaseActor duration | 0.9 | 1.5 | 5.0 | about USD 5 per 1,000 databases; billed only while an actor runs a call, not while it is loaded |
| The warmers, at a visit of 300 ms | 5.8 | 9.6 | 31.2 | 3, 4 and 13 warmers at USD 1.94 (a shard of 57 databases: 10 rounds of six visits, 3.0 s a cycle) or USD 2.40 (75 to 77 databases: 13 rounds, 3.9 s) each: requests, rows written and 0.506 for every second of a cycle, see "The warmers line" |
| D1 rows read | 0.03 (28 million) | 0.05 (50 million) | 0.17 (167 million) | 167,400 rows for each live database and month, see "D1 reads"; inside the 25 billion rows a month the plan includes |
| **Total without Workers Logs** | **about 15** | **about 26** | **about 85** | the sum of the four lines above (15.03, 25.75 and 84.97), rounded |
| Workers Logs, if invocation logs are on | 34.2 (57.0 million events) | 59.9 (99.8 million events) | 199.5 (332.4 million events) | not measured, see "Workers Logs": one event for each visit and two for each warmer cycle (the alarm's invocation and the `actor_warm_cycle` line), 648,000 a warmer and month; USD 0.60 per million events |
| **Total with Workers Logs** | **up to about 49** | **up to about 86** | **up to about 284** | the sum of the two totals (49.23, 85.65 and 284.47), rounded |

All figures are gross: the first million requests, 400,000 GB-s, 50 million rows written, 25 billion
rows read and 20 million log events a month of the account's plan are not subtracted. Each total is
the sum of the lines above it, so the three columns agree with each other. Without the log events the
cost is about USD 85 per 1,000 databases (USD 15 for 170, USD 26 for 300, warmers included); with
them, up to about USD 284 (USD 49 for 170, USD 86 for 300) until the log setting below is decided.
If a visit takes the 50 ms the first design expected, the warmers line is 2.0, 3.0 and 9.8 and the
totals are about USD 11, 19 and 64 without Workers Logs (11.23, 19.15 and 63.57) and about 45, 79 and
263 with them.

**The warmers line.** A warmer's month at 8 s is 324,000 alarm cycles and 43,200 arm calls of the
minute cron: requests USD 0.06 (367,200 at USD 0.15 per million), rows written USD 0.37 (367,200 at
USD 1.00 per million: one `setAlarm` row for each cycle, one `put` of its shape for each arm call)
and duration USD 0.506 for every second a cycle takes (324,000 cycles x 0.125 GB x USD 12.50 per
million GB-s). That is USD 0.42 plus 0.506 x the cycle seconds for each warmer. Duration is
wall-clock time while the object is active, and waiting for the actors counts. The pricing page
(https://developers.cloudflare.com/durable-objects/platform/pricing/, read 2026-10-20) says "Durable
Objects are billed for compute duration (wall-clock time)" for "the 128 MB of memory your Durable
Object is allocated, regardless of actual usage", and the limits page
(https://developers.cloudflare.com/durable-objects/platform/limits/, read 2026-10-20) says "Durable
Objects remain active while a request, RPC call, response stream, WebSocket, or pending I/O is in
flight". A cycle of N databases with six visits in flight takes `ceil(N / 6)` x the visit time, so
the duration of all warmers together is about the number of databases / 6 x the visit time x 324,000
cycles x USD 1.5625 per million seconds, whatever the number of warmers: it falls with the visit
time, not with fewer or more warmers, and a warmer more or less changes the line only by its fixed
USD 0.42. The table assumes 300 ms a visit; the 50 ms of the first design is in the paragraph above.
Neither is measured near the actors yet (the next read of the cycle lines gives `visit_p50_ms`, see
"Observing it"). If Durable Object stubs do not count against the six connections, the live cycles
imply 820 to 860 ms a visit, and the full shards no longer fit the interval: cycles of 8.4 s (57
databases) and 10.9 s (75 to 77) overrun 8 s, each alarm then starts as soon as the one before it
has ended, and a warmer is active the whole month at most. That caps its duration at 2,592,000 s x
0.125 GB x USD 12.50 per million GB-s = USD 4.05, and the requests and rows written fall with the
cycles that fit a month (308,571 and 237,798 instead of 324,000), so the line is 13.4, 17.5 and
56.9 for 170, 300 and 1,000 databases (USD 53 of the 56.9 is duration: 13 warmers x 4.05). The
formula above, 0.506 x the cycle seconds, holds only for cycles that fit the interval; applied to
8.4 and 10.9 s it gave 14.0, 23.8 and 77.4, which counts those cycles 324,000 times a month. Six
visits in flight instead of 16 cost, if stubs do not count, up to 16 / 6 = 2.7 times the duration
of cycles that fit; with the cap they cost 1.9 times for these shards (USD 53 for 1,000 databases,
against about USD 28 at 16 in flight, where a cycle of 4.2 s fits). If stubs count, 16 in flight
take the same wall time as six and every visit's time then includes its wait, which is why six was
chosen. The first deploy on Dev (one warmer, 16 in flight, 167 databases) wrote 255 cycle lines
(19:37 to 20:17 UTC on 2026-10-20, re-read at 20:50 UTC; a median `cycle_ms` of 5.9 s, 5.4 to 9.6
s), which is USD 3.4 a month for that one warmer; its first read (19:10 to 19:28 UTC, a median of
9.0 s, a cycle longer than the interval) is USD 4.4 under the cap. 255 lines are not 255 cycles:
an 8 s loop would have written about 299, see "Lines that never arrive" under "Observing it".

The shards of 78 (instead of the 250 this was first sized for: 4 warmers for 1,000 databases at 16
visits in flight and 50 ms a visit, 0.8 s a cycle, USD 3.3) cost USD 28 more per 1,000 databases and
month in warmers at 300 ms a visit (USD 6.5 more at 50 ms) and, if invocation logs are on, USD 3.5
more in log events (332.4 instead of 326.6 million), USD 31 more with Workers Logs; for 170 and 300
databases USD 5.1 and USD 8.2 more in warmers (USD 5.9 and USD 9.0 with Workers Logs). They are what
the first live cycles required. The cost of the warmers falls with the visit time, and a larger
shard saves only the fixed USD 0.42 of each warmer it removes.

**D1 reads.** The cron's count reads two rows for each live database (the database and its
project) every minute. Each warmer reads only its own range of the primary key's index, in one query
of about 78 rows, every 64 s (it keeps the list for 60 s and a cycle comes every 8 s); a deleted
database is read as well, one row, because deleted rows stay in D1. All warmers together therefore
read each row once, not once for each warmer, and rows read a month are 43,200 x 2 x L +
40,500 x (2 x L + X) for L live and X deleted databases (the first term is the cron's count alone,
the second the warmers' lists; together 167,400 rows for each live database): 167 million for 1,000
live databases (USD 0.17 gross at USD 0.001 per million) and 10.4 billion for 50,000 live and
50,000 deleted ones, against the 25 billion a month the plan includes. D1 sees one query per
warmer and minute (about 640 for 50,000 databases) and one for the cron. Measured on the D1 of the
tests: 8 databases, one of them deleted, read 15 rows (2 for each live database, 1 for the deleted
one), the same with 2, 3 or 5 warmers (at most one row more for each statement, the first key
beyond a range). The production meter may count differently: read `rows_read` of the `SELECT d.id`
statement in D1's analytics after the deploy and put it into this model.

**Workers Logs.** The API Worker's Workers Logs hold request lines such as
`POST /node/v1/observations` (the plan reads them), so its invocation logs are on, and Cloudflare's
documentation lists RPC and alarm calls among the invocations that each produce one invocation log.
If so, every visit is one billed event, every warmer alarm another and every `actor_warm_cycle`
line a third: for 1,000 databases and a month at 8 s that is 324 million events for the visits and
8.4 million for the 13 warmers (648,000 each: 324,000 alarms and 324,000 cycle lines; the 43,200
arm calls of the cron a warmer and month, 0.2 % of the total, are not counted), 332.4
million in all, which is USD 199.5 gross at USD 0.60 per million events (USD 187 if nothing else of
the account uses the 20 million events a month the plan includes), and 57.0 million events (USD 34
gross, USD 22 if nothing else uses the 20 million included events) for 170 databases. From 1
December 2026 Cloudflare bills logs by ingested volume instead (USD 0.25 per GB beyond 50 GB a
month): USD 82 gross per 1,000 databases and month for every kilobyte an event holds. This is inferred
from the documentation (pages read 2026-10-20), not measured: the account's log usage and the size
of an event were not read. Before the costed go for the deploy:

1. Read the account's Workers Logs usage (events a day), and look in Workers Logs of the API Worker
   for events of a `DatabaseActor` RPC over the last hour: the minute cron and the Edge already call
   the actors, so if such events exist every visit will produce one, and their size gives the size
   of an event for the model.
2. After the deploy, count those events in a window of ten minutes: 75 per database at 8 s if each
   visit is logged, none if not, and compare the day's total with step 1.
3. If the cost is not accepted, set `observability.logs.invocation_logs` to `false` in the private
   API configuration (a key of the pinned wrangler's configuration schema). The visits and the
   alarms then produce no events, and the console lines (`actor_warm_cycle`, `node_event`) stay;
   what is lost is every request line of the API Worker (the `POST /node/v1/observations` kind).
   `head_sampling_rate` is no substitute: it drops whole invocations, console lines included.

**Observing it.** Each cycle of a warmer writes one line, `actor_warm_cycle`, to Workers Logs with
`shard`, `shards`, `databases`, `visited`, `failed`, `cycle_ms`, `interval_ms`, `overrun`,
`list_error`, `concurrency` (visits in flight, 6), `visit_p50_ms` and `visit_max_ms` (the median
and the longest time of a visit in this cycle, a failed visit counted with the time it took, null
when nothing was visited); there is never a console line per visit (the invocation events of
"Workers Logs" above are the platform's). Once for each warmer object in memory (after a deploy or
an eviction, not every cycle) it writes `actor_warmer_placed` with `shard`, `shards`, `colo` (the
three-letter Cloudflare colo the warmer runs in, from `https://www.cloudflare.com/cdn-cgi/trace`;
only that field is read, null if the trace could not be read within 2 s) and
`new_warmer_location_hint` (the hint that the variables of this deployment give a warmer created
now, or null). A location hint applies only when an object is created, so this field is not the hint
the warmer in front of you was placed with: a warmer created before the variable was set, or before
`ACTOR_WARMER_NAME_VERSION` was raised, still shows the new setting and runs wherever it was
created. Its `colo` is the evidence of where it runs.

Reading a line: a healthy shard shows `visited` equal to `databases`, `failed` 0, `visit_p50_ms`
of tens of milliseconds, a `cycle_ms` of about `databases / concurrency x visit_p50_ms` (a second
or less) and `overrun` false (a first cycle after a deploy, with every actor cold, can take about
ten seconds). `overrun` true again and again means the shard's cycle takes longer than the
interval. Then read the colo and the visit time together: a `colo` outside the region the actors
live in (West Europe for Dev: AMS, LHR, FRA, CDG and the like) with a `visit_p50_ms` of 100 ms or
more is the warmer's distance, and the fix is the hint and a new name version (see "Placement"); a
`colo` near the actors with a high
`visit_p50_ms` points at the actors, and a `visit_max_ms` at the 3 s timeout with `failed` above 0
at single slow actors. With six visits in flight no visit waits for a slot in the runtime's queue,
whether or not the limit counts these calls, so `visit_p50_ms` is the call's own time and
`ceil(databases / 6) x visit_p50_ms` should match `cycle_ms`; if `cycle_ms` is much larger than that
the cycle waits for something else (the list read from D1 on the cycle that reads it, shown by
`list_error` and a cycle every 64 s that is slower than the others). When `visit_p50_ms` is stable
at well below 300 ms across a day, lower `ACTOR_WARM_VISIT_PLAN_MS` in `domain/actor-warm.ts` to it
and the shards grow, with fewer warmers (this saves the fixed USD 0.42 of each warmer removed; the
warmers' duration follows `cycle_ms` itself: USD 0.506 a month for every second of a warmer's
median `cycle_ms` up to the interval and at most USD 4.05 above it, see "The warmers line").
`actor_warm_failed` is an unexpected fault of a cycle and does not stop the loop. The effect shows in the Edge's admission lines: `admit_ms` of the first
connect to a database that was idle is expected to fall from a cold actor's 200 to 600 ms to the
warm actor's 40 to 80 ms (the scratch measurement of the plan's keep-warm study found that
effect); confirm it live after the deploy.

**Lines that never arrive.** Count the lines of each shard over ten minutes, without a filter on
`$workers.eventType` (7 of the 67 lines of 19:40 to 19:50 UTC on Dev carry `jsrpc`, not `alarm`):
an 8 s loop writes 75. Take each line's start as its log time minus `cycle_ms` and read the gap
from one start to the next. A gap of 8.0 s is a healthy loop. A gap that equals the previous
`cycle_ms` after an `overrun` is a slow shard (see above). A gap of exactly k x 8 s, to within a
few milliseconds, is neither a late alarm nor a slow cycle but k - 1 lines that did not arrive:
the alarm fired and set its next alarm before it worked, so the loop went on, and either Workers
Logs dropped the line or the alarm ended without completing a cycle (then those actors went 16 to
32 s without a visit, longer than the 10 s a keep-warm needs). Which of the two is open. Dev's
first deploy (one warmer, 167 databases) wrote 62 to 68 lines in each period of ten minutes from
19:40 to 20:40 UTC on 2026-10-20, about 14 % fewer than 75. From 19:37 to 20:40, 53 of its 57
gaps of 16 s or more were exact multiples of 8 s and the other 4 were 0.4 to 2.0 s longer, which is
what an unlogged cycle of 8.4 to 10 s would leave (logged cycles overran by as much); there was no
`actor_warm_failed` and no `actor_warm_stopped` line. The plan row of this keep-warm holds the
numbers.

The shard size holds only while a visit takes about what it is planned for. A full shard of 78
fits the interval of 8 s up to 615 ms a visit (13 rounds) and the planned half of it up to 307 ms.
The signature of a shard that does not fit is `concurrency` 6, `overrun` true, `visit_p50_ms` above
about 600 ms and `cycle_ms` near `ceil(databases / 6) x visit_p50_ms`. With a `colo` near the
actors that means the call itself is slow and the limit of six connections is not the cause. Two
releases answer it: raise `ACTOR_WARM_VISIT_PLAN_MS` to the measured `visit_p50_ms`, which makes the
shards smaller and the warmers more (it works whatever the limit counts), or raise
`ACTOR_WARM_CONCURRENCY` to 16, which shortens the cycle by about two thirds only if the calls are
not counted against the six connections (then `visit_p50_ms` stays and `cycle_ms` falls) and not at
all if they are (then `visit_p50_ms` grows to about 2.7 times and `cycle_ms` stays).

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

A fresh Edge isolate parses and evaluates the whole bundle before it answers its first request, so
the bundle holds no zod: it was 487.65 KiB (gzip 107.22 KiB) with it and is 25.48 KiB (gzip 9.63
KiB) without. The Edge imports the zod-free modules of `@pgcf/contracts` (`ids-core`,
`route-token-core`, `edge-policy`, `edge-sql`, `pg-wire`) and no module that imports zod;
`apps/edge/test/bundle.node-test.ts` builds the Edge as the example configuration deploys it and
fails when a zod file is in the bundle or the bundle is over 64 KiB. To profile the startup phase
in workerd on your machine, run `wrangler check startup --args="--config <your configuration>"` in
`apps/edge`; `wrangler deploy` prints Cloudflare's own startup time.

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
it: once, its binary is replaced through the shell. EU1 was such a node (it ran the agent of main
`bb85de7d`) and was replaced on 2026-10-20. A node enrolled from an image that
holds the first agent that writes host files needs none of this, and no code supports it: Dev runs
the newest release only. It is the last such step: from the agent that ignores the properties it
does not know, a change that keeps the order of the table in
[Changing the page](#changing-the-page-no-hand-step) needs no hand replacement (a new property is one
release; a new value, a new type of order, a rename and a change of the signed manifest are two); an
agent of main `1ace7446`, which is still
strict, is moved to that agent by the release path in the order of the plan's row for the CPU
burst, and a node that needs this section again means a rule of that section was broken. The databases keep running throughout (their units do not depend on the
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
| `admission`  | `memory_rule` (`measured` or `reserved`, decision D3), `memory_floor_mib`, `awake_budget_mib`, `reservation_overhead_mib`, `start_concurrency`, `queue_wait_ms`, `retry_after_seconds`, `cpu_boost_ms` | `measured`, 600, 9,937, 8, 4, 10,000, 5, 5,000 |
| `early_sleep` | `enabled`, `min_idle_seconds` (decision D2)                                                                                                                     | enabled, 30                                |
| `storage`    | `reserve_bytes`, `metadata_no_room_percent`, `sample_max_age_seconds`                                                                                            | 6 GiB, 75, 10                              |
| `backup`     | `wal_uploads`, `base_backups`, and `memory_mib` of a WAL upload, a WAL fetch and a base backup or restore                                                        | 2, 1, 128, 128, 256                        |
| `io`         | `write_bytes_per_second` and `write_iops` of a 256 MiB database; a database of _m_ MiB gets _m_/256 times as much                                                | 16 MB/s, 1,000                             |

`cpu_boost_ms` is how long after a wake a database runs without the CPU quota of its class, counted
from the release of its writer (`0`: the quota comes with the wake). It is optional for its first
release ([Changing the page](#changing-the-page-no-hand-step)): a `PUT` that leaves it out sets 0,
and a stored policy that lacks it reads as 0 until migration `0081` or a `PUT` gives it a value. The first requests, PostgreSQL's
start-up and the reading of its buffer list (`autoprewarm`) then are not held to 0.5 CPU (0.25 for
`xs`). The weight and the memory, IO and task limits of the unit stay, so the burst lifts only the
cap of the quota: contested CPU is still divided by weight, and a database that bursts takes its
weight's share of it, which can be more than its size and can come from the gateway, `cloudflared`
and the agent (plan 4.4 states the bound: all databases together take at most half of contested CPU
from them, and every database keeps its weight's share). Each wake has a burst of its own, so the
CPU a database can take grows with how often it wakes (after an idle sleep, an early sleep, a
suspend and resume, a move or a maintenance). A change applies from the next wake: a timer that runs
keeps its time. A database that sleeps, moves or is deleted inside its window loses the timer, a
base backup that begins inside it ends it (the quota is applied before the backup), and an agent
that starts applies the quota at once to every database it finds running. The event `wake_detail`,
read 2 s after the release, carries `nr_throttled` and `throttled_usec` since the release: about
none inside a burst of 2 s or more, the quota's throttling at `0` (the A/B in the plan, 11.2,
compares the two).

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
   whose agent predates host files (EU1 did, until 2026-10-20) first has its agent
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

### Changing the page: no hand step

The desired page (a field of the policy, the release, an entry, a role, an order or a probe), the
credentials and the API's answers are read by the agent with every object open: **a property the
agent does not know is ignored**, so a release that adds one reaches a running node by the release
path, with no replacement of the agent. What the agent still refuses, whole, is a page it cannot
read: a missing required property, a wrong type, a number out of bound, a value outside a closed
set (an enum, a type of order, a kind of origin or host file, a link message), and a property of the
other kind (a move with a `target_time`, a restore with an `end`, a removed role that names a property
of a present role). The contract stays
strict on the API's side, so the API never sends or accepts a property by accident, and what the
agent sends is held to it.

**The rule for the author of a change is the table in
[plan 9.3, "Changing the page"](../architecture/cloudflare-convergence-and-serverless-plan.md); it is
written there once, by the kind of change and by the direction (what the node receives, what it
sends), and nothing of it is repeated here.** What an operator does with it:

- Before a release or an API deploy, find the row of its change in the table and keep its order.
  Where the row says "the release after every node runs it", that is `converged` on every node of
  every region (`GET /v1/nodes/{id}/release`), not a time that has passed.
- **EU1 today** runs the agent of main `1ace7446`, which is strict: the rule starts with the agent
  that ignores unknown properties, so the first change after it is not "any order". Register and
  assign that release first, while the API is still the older one, and deploy the API (with migration
  `0081`) after the node runs it: the order of the plan's row for the CPU burst (11.2). The API first
  would leave the agent unable to read the page that assigns the release, which is the hand
  replacement above.
- A change of the signed manifest is two releases as well
  ([release-signing.md](release-signing.md#changing-the-manifest)).

#### If an agent cannot read the page

It applies none of the page (no entry, no order, no release; what runs keeps running) and reports
`desired_pull_failed` with the class `cloudflare_desired_page_invalid`, or
`cloudflare_desired_page_has_an_order_this_agent_does_not_know` for an order of a type it does not
read. A rule of the table was broken, or the API sent a page that does not match its own contract.

1. **Read the refusal in Workers Logs,** not with a probe. The line has `event` `node_event`,
   `node_event` `desired_pull_failed`, the `node_id` and the `class`. Probe requests (`journal` and
   the others) travel on the desired page, which the agent refuses, and it answers a probe only after
   it has pulled a page, so none is answered. The event does reach Cloudflare: the agent posts its
   event ring by itself, with no page.
2. **Make the API send a page the agent reads.** Rolling forward with a fix is the safe way. A
   rollback of the API Worker alone is not: **it does not undo what the newer API wrote to D1**, and
   the older API refuses or misreads that, so check what it left before rolling back.
   - *A stored policy with a field the older API does not know.* The next deploy is the case:
     migration `0081` writes `policy.admission.cpu_boost_ms` into `node_region_policies`, and the API
     of `1ace7446` parses the stored policy with its strict `NodePolicy`, so after a Worker-only
     rollback `GET /v1/regions/{id}/node-policy` and every page of the region return 500 and no
     release reaches the node. With the rollback, `PUT /v1/regions/{id}/node-policy` the policy
     without `cpu_boost_ms` through the older API (it replaces the stored policy without reading it);
     after rolling forward, `PUT` it with `cpu_boost_ms` `5000` again, because migration `0081` is
     applied once and does not run a second time.
   - *Open orders of a type the older API does not know.* It reads every open order that is neither a
     `move` nor `maintenance` as `superseded`, which retires the storage generation the row names (the
     node never starts or archives it again), or it fails the page when the row has none. List them
     first (`SELECT type, count(*) FROM lifecycle_orders WHERE closed_at IS NULL GROUP BY type`) and do
     not roll back while orders of the new type are open: closing them is a write to D1 that needs the
     owner's go, and the order is lost.
3. **Then the release path works again:** assign the release whose agent reads the page, wait until
   the node is `converged`, and deploy the API again, with the `PUT` of step 2 where it applies.
   Replacing the agent by hand is the last resort.

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
