# Manual credential changes

Operational Cloudflare, R2 and PGCF credentials have no configured expiry in the current operator
installation, except these: the Edge's Access service token below, the PGCF API keys, which carry
an optional expiry ([API keys](#api-keys)), a node's temporary R2 credentials (7 days, renewed by
Cloudflare), the installer's enrollment token (30 minutes) and the route tokens (30 seconds). Keep
their scopes limited to the account, buckets and services they use. Routing capabilities, control
messages, provider access tokens and certificates retain their security deadlines.

## API keys

Using a working administrator key, call `POST /v1/api-keys` with an explicit `Idempotency-Key`.
For a replacement administrator use `{"scope":"admin","name":"operator replacement"}`;
integrator keys additionally require their existing `project_id`. Save the creation response
directly in private credential custody. The full key is returned once; replay does not reissue or
silently replace it. Verify the replacement's scoped access, update the consumer, then revoke the
old key with `DELETE /v1/api-keys/{id}`. Keep a working administrator throughout the change.

`BOOTSTRAP_TOKEN` creates the first administrator key once and then answers `401`; it creates no
integrator key and no second administrator.

**Scopes.** An operator holds keys of two scopes. `admin` changes anything: it buys servers, starts
rollouts and maintenance, declares nodes lost and makes keys. `admin_read` reads what an
administrator reads (nodes, regions, health, costs, fleet, the key list and the audit log) and
changes nothing: every request that is not a GET is refused with `403` before it runs, on every
route, and it is recorded. Give monitoring, dashboards and anything else that only looks an
`admin_read` key (`{"scope":"admin_read","name":"monitoring"}`); a leaked one shows the fleet and
cannot touch it. A read-only key reads no more than an `admin` key does: the connection URI of a
role never carries its password for either.

**Expiry.** Every key may carry `expires_at` (a future time, set at creation and not changeable;
make another key to move it). From that instant the key is refused with `401` like a revoked one.
An `admin` or `admin_read` key made by an administrator key expires 90 days after its creation
unless `expires_at` asks for another time, and at most 366 days ahead is accepted; an integrator key
never expires unless it asks. The first administrator key, made with the bootstrap token, does not
expire unless it asks: no earlier key exists to make its successor, and `POST /v1/api-keys` with the
bootstrap token works once only, so a first key that lapsed could not be replaced through the API.
Keys made before the audit migration (`0076`) have no expiry; replace them with keys that do, then
revoke them. Make the successor of an administrator key before the key expires, and read
`expires_at` in `GET /v1/api-keys`; nothing warns before a key lapses, and if every `admin` key has
lapsed see [Lapsed administrator keys](#lapsed-administrator-keys).

**Audit log.** `GET /v1/audit-events` (either administrator scope; newest first, the usual `limit`
and `cursor`) lists every request an `admin` or `admin_read` key made with a method other than
`GET`, and every refusal of an administrator key that was revoked or has expired and was presented
with its real secret. An event holds the key's ID and scope, the method, the
route template (`/v1/api-keys/{id}`, never the path that was asked for), the HTTP status, the
`X-Request-Id` and the time. It holds no body, query, key, secret or address; to tie an event to
what it did, read the resource it names in the route (the key that asked is also kept on role
and probe records). An event is listed for 90 days; the next change or refused administrator key
deletes the older ones (the minute cron has no statement to spare: its tests hold it to 850).
Not recorded: successful reads; a key with a wrong secret, one that matches no key row and an
integrator's key (the identifier in a key string is not secret and `GET /v1/api-keys` lists it, so
anyone could otherwise grow the log by sending it); and the one bootstrap request, which has no key
to name.

A change is written to the log **before** it runs, and its status is added when the answer is
known. This order is deliberate: a change cannot be taken back, so a row written afterwards could
be lost with the change already made. If the row cannot be written, the request is not run and
answers `500` (log line `audit_write_failed`); the retry is safe. If only the status cannot be
written, the answer stands and the event keeps `status: null`, which says the outcome is unknown
(also after a Worker that stopped mid-request), never that it succeeded. A refused key is
refused whatever the log says. Look for `null` statuses after an incident.

## Lapsed administrator keys

An administrator key made by an administrator expires after at most 366 days, and nothing warns
before it does: write down each key's `expires_at` when you make it. If the last working `admin`
key has lapsed (or was revoked), the API cannot make another. The bootstrap token creates a key
only while no `admin` row exists at all, and a lapsed or revoked row counts.

With access to the Cloudflare account, open the PGCF database in the D1 console, find an `admin`
key whose secret you still hold and move its `expires_at` ahead (add `, revoked_at = NULL` to
bring back a revoked one):

```sql
SELECT id, name, expires_at, revoked_at FROM api_keys WHERE scope = 'admin';
UPDATE api_keys SET expires_at = '2026-12-31T00:00:00.000Z' WHERE id = '<key id>';
```

Use a time a few days ahead in exactly that form (UTC, milliseconds, `Z`); the table refuses any
other. Then make the successor with that key at once (`POST /v1/api-keys`) and let the extended key
lapse or revoke it. The edit goes around the API, so **it is not in the audit log**
(`GET /v1/audit-events`): write down when and why it was made.

## Worker and routing secrets

Maintain the exact Worker binding names from the private deployment configuration. Write values
from a protected file through Wrangler secret import; keep command output private. Deploy to the
verified account and compare secret **names**, never print values.

For `ROUTE_MASTER_KEYS` (`{"active":"<kid>","keys":{"<kid>":"<base64url>"}}`), the API and the Edge
Worker hold the master keyring and sign with the active key. A node's gateway verifies with the
keys derived for that node from every master key. The agent reads them from Cloudflare when it
starts (and again when its desired page names a higher credentials revision, which no API route
raises today) and writes them to `gateway.env`; a running gateway reads that file only when its
unit starts. **This rotation has never been exercised, and nothing reports which key IDs a node's
gateway holds**, so no check tells you beforehand that every gateway has the new key. The only
restarts of a running gateway are a release that changes the gateway's binary and a reboot that is
due anyway (a maintenance cycle in its announced window; never a reboot made for this purpose, which
needs the owner's go and, from the canary on, an announced window, plan 9.3). A gateway restart
ends every open client session: the gateway stops accepting (its socket is systemd's, so a
connection that arrives meanwhile waits for the next gateway), closes the idle sessions at once,
gives a busy one 10 seconds, and clients reconnect. A
release that changes both the agent and the gateway restarts the gateway before the agent has
written the new file, so the gateway needs a later release or reboot of its own. To rotate: add the
new key beside the old one with the old one still active, deploy the API and the Edge, let every
node's agent start once (a release that changes the agent), let every gateway start afterwards,
make the new key active and deploy both again. Existing routing tokens expire within 30 seconds.
After the switch open a fresh connection to a database on every node: a node whose gateway lacks the
key refuses it, and making the old key active again, which is still in the keyring, restores it.
Retire the old key from the keyring only after every node passed. Until `credentials_revision` can
be raised by an API route, treat rotating this key as a planned operation with the owner's go, not
as routine.

For the Edge's Access service token (`ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`), rotate the
token's secret in Zero Trust with a grace period; the Client ID stays the same
([operator installation](operator-installation.md#cloudflare-access-for-node-gateways-and-shells)).
Set the new `ACCESS_CLIENT_SECRET` on the Edge, check a fresh connection and an HTTP query, then let
the grace period end (or end it early on the rotate call). Never revoke or delete the token itself:
Access revokes by deleting the token, which removes the new secret too, and every public-gateway
connection and HTTP query then fails. The token expires after the duration chosen when it was
created (8760h in the operator installation), after which Access refuses the Edge in the same way.
Refresh it in Zero Trust (or with the Refresh endpoint, one more year) before then, and turn on the
Zero Trust "Expiring Access Service Token" notification, which warns a week ahead.

Choose short `CREDENTIAL_KEYS` IDs (the live one has 4 characters): the ID is written into every
role of a database, and a deleted database's retained archive holds all of them in one row, which D1
cannot import into a restore if it passes 100,000 bytes. The largest set of roles the contracts
allow stays below that with an ID of 18 characters or fewer, whatever the revision of the passwords,
and from 34 characters even a first password can pass it.

For `CREDENTIAL_KEYS`, adding a new active key ID does not make old ciphertext disposable. Retain
all key IDs referenced by database roles, deleted-source archives and older D1 exports. Back up
the complete keyring before changing it. Re-encryption and automatic rotation
are later work; removing a referenced key makes recovery impossible.

`API_KEY_PEPPER` binds the hashes of every API key and of the installer's enrollment and progress
tokens. Changing it requires a coordinated rehash of known retained keys and private custody;
replacing the Worker secret alone is not a supported rotation, and it would refuse every existing
key.

## Node credentials

A node holds no secret of the image. Its credentials come from the install and from the link:

- **The node key.** At its first start the agent generates an Ed25519 key that never leaves the
  node, enrolls with the installer's one-time token and its public key, and signs every later
  request with it. There is no rotation: a reinstall is a new install with a new token and a new
  key. Cloudflare restricts the key of a node declared lost to the fenced scope (see
  [recovery](recovery.md#lost-node)). An enrollment token that is presented again with another key,
  or after it expired, is refused and raises `node_enrollment_refused`: treat it as leaked and
  reinstall.
- **Tunnel token and route keyring.** The API makes the node's Tunnel with `CLOUDFLARE_API_TOKEN`
  when the node first reads its credentials and hands it the token and its derived route keyring;
  the node stores the token as an encrypted systemd credential. Declaring a node lost deletes its
  Tunnel, which ends the token.
- **R2 credentials.** The Worker signs each node's temporary credentials locally from the parent key
  (`R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY`): one archive prefix of one
  database generation, no delete right, 7 days, renewed after a third of that. Nodes never hold the
  parent key or a bucket-wide key. To replace the parent key, create the new R2 API token (object
  read and write on the archive buckets), set both Worker secrets and deploy; credentials delivered
  afterwards are signed with the new key. Delete the old token only after the credentials it signed
  have expired, 7 days after the deploy: deleting it earlier ends the credentials the nodes hold,
  and archiving fails until they read new ones (`database_archive_failing`).

## Provider and account credentials

Create a replacement with the same scoped authority, update the private Worker secret, then check
its real use before revoking the old value. R2 requires an actual base backup, WAL archive and
restore read. `CLOUDFLARE_API_TOKEN` requires a node's credentials read that finds its Tunnel.
`INFRASTRUCTURE_BACKUP_CF_TOKEN` requires the next daily D1 export to complete. Contabo requires an
authenticated inventory read; changing credentials must never issue a test order.

Credentials of the retired Kubernetes runtime (the Talos and Kubernetes authority, relay
credentials, region agent keys, bucket-wide R2 keys and old Tunnel tokens) are revoked under
Stage 0 step 4 of the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md).
Keep every `CREDENTIAL_KEYS` ID that older D1 exports reference.

Record changed key IDs, dates and successful checks in private custody. Refresh the encrypted
operator backup and its independent offline copy. Do not record secret values in `PLAN.md`, Git,
logs or incident messages.
