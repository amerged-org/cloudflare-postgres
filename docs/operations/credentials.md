# Manual credential changes

Operational Cloudflare, R2 and PGCF credentials have no configured expiry in the current
operator installation, except the Edge's Access service token below and the PGCF API keys, which
carry an optional expiry ([API keys](#api-keys)). Keep their scopes limited to
the account, buckets and services they use.
Routing capabilities, control messages, provider access tokens and certificates retain their
security deadlines.

## API keys

Using a working administrator key, call `POST /v1/api-keys` with an explicit `Idempotency-Key`.
For a replacement administrator use `{"scope":"admin","name":"operator replacement"}`;
integrator keys additionally require their existing `project_id`. Save the creation response
directly in private credential custody. The full key is returned once; replay does not reissue or
silently replace it. Verify the replacement's scoped access, update the consumer, then revoke the
old key with `DELETE /v1/api-keys/{id}`. Keep a working administrator throughout the change.

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
`expires_at` in `GET /v1/api-keys`.

**Audit log.** `GET /v1/audit-events` (either administrator scope; newest first, the usual `limit`
and `cursor`) lists every request an `admin` or `admin_read` key made with a method other than
`GET`, and every refusal of a key that carries an administrator key's identifier but a wrong
secret, or was revoked or has expired. An event holds the key's ID and scope, the method, the
route template (`/v1/api-keys/{id}`, never the path that was asked for), the HTTP status, the
`X-Request-Id` and the time. It holds no body, query, key, secret or address; to tie an event to
what it did, read the resource it names in the route (the key that asked is also kept on role
and probe records). An event is listed for 90 days; the next change or refused administrator key
deletes the older ones (the minute cron has no statement to spare: its tests hold it to 850).
Not recorded: successful reads, a refused key that matches no key row or an integrator's (anyone
could otherwise grow the log), and the one bootstrap request, which has no key to name.

A change is written to the log **before** it runs, and its status is added when the answer is
known. This order is deliberate: a change cannot be taken back, so a row written afterwards could
be lost with the change already made. If the row cannot be written, the request is not run and
answers `500` (log line `audit_write_failed`); the retry is safe. If only the status cannot be
written, the answer stands and the event keeps `status: null`, which says the outcome is unknown
(also after a Worker that stopped mid-request), never that it succeeded. A refused key is
refused whatever the log says. Look for `null` statuses after an incident.

## Worker and routing secrets

Maintain the exact Worker binding names from the private deployment configuration. Write values
from a protected file through Wrangler secret import; keep command output private. Deploy to the
verified account and compare secret **names**, never print values.

For `ROUTE_MASTER_KEYS`, retain the old key ID while adding the replacement. Derive each node's
gateway keyring with the shared `deriveNodeKeyring` contract (the node reads it from Cloudflare
with its other credentials) and update the gateways first; activate the new master signing key
only after the gateways accept it. Existing routing tokens
expire within their configured short window. Verify a fresh connection before retiring the old
key. Do not change an agent key as a side effect of a redeploy.

For the Edge's Access service token (`ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`), rotate the
token's secret in Zero Trust with a grace period; the Client ID stays the same. Set the new
`ACCESS_CLIENT_SECRET` on the Edge, check a fresh connection and an HTTP query, then let the grace
period end (or end it early on the rotate call). Never revoke or delete the token itself: Access
revokes by deleting the token, which removes the new secret too, and every public-gateway
connection and HTTP query then fails. The token expires after the duration chosen when it was
created (8760h in the operator installation), after which Access refuses the Edge in the same way.
Refresh it in Zero Trust (or with the Refresh endpoint, one more year) before then, and turn on the
Zero Trust "Expiring Access Service Token" notification, which warns a week ahead.

For `CREDENTIAL_KEYS`, adding a new active key ID does not make old ciphertext disposable. Retain
all key IDs referenced by database roles, deleted-source archives and older D1 exports. Back up
the complete keyring before changing it. Re-encryption and automatic rotation
are later work; removing a referenced key makes recovery impossible.

`API_KEY_PEPPER` binds existing API and agent key hashes. Changing it requires a coordinated
rehash of known retained keys and private custody; replacing the Worker secret alone is not a
supported rotation. There is no agent-key rotation API in v1. Keep the current imported agent
identity until that coordinated operation has been implemented and checked. A Worker isolate keeps
a region's agent key hash for 5 s (`AGENT_REGION_CACHE_MS`), so a change made in D1 itself stops
authenticating the old key everywhere within that time and accepts the new key at once.

## R2, Tunnel and provider credentials

Create a replacement with the same scoped authority, update the private Worker secret, then check
its real use before revoking the old value. R2 requires an actual base backup, WAL archive and
restore read. A Tunnel requires Ready connectors and a real database connection. Contabo requires
an authenticated inventory read; changing credentials must never issue a test order.

Kubernetes-era credentials (the Talos and Kubernetes authority, relay credentials, region agent
keys, bucket-wide R2 keys and old Tunnel tokens) are revoked under Stage 0 step 4 of the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md). Keep every
`CREDENTIAL_KEYS` ID that older D1 exports reference.

Record changed key IDs, dates and successful checks in private custody. Refresh the encrypted
operator backup and its independent offline copy. Do not record secret values in `PLAN.md`, Git,
logs or incident messages.
