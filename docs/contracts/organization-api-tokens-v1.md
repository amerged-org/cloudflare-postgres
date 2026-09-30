# Organization API tokens v1

Status: source qualified; Dev qualification pending. This extends organization management with
installation-operated, scoped integration credentials. It adds no customer
billing, identity-provider integration, project-specific privileges or schema.

## Authority and lifecycle

The collection is `/v1/organizations/{organizationId}/tokens` and an item appends
`/{tokenId}`. Every method requires the installation bootstrap credential.
Organization, region, meter and grantor credentials never manage these resources.
The existing `/tokens/reissue` emergency operation retains its behavior: revoke
all active organization tokens and issue a replacement with all existing scopes.

`POST` accepts exactly `{id, scopes}`. The caller retains a lowercase UUID before
sending the request. Scopes are a nonempty, unique subset of `projects:read`,
`projects:write` and `operations:read`. Their canonical order is lexical; the
server never adds implicit privileges. The initial response is `201 {token,
apiToken}`; an identical active replay returns `200` with the same credential.
These are organization-wide permissions, not per-project restrictions.

The token metadata is `{id, organizationId, scopes, createdAt, revokedAt}`.
`GET` collection/item returns metadata only, including revoked and legacy token
history; plaintext and stored digests never appear. Collection pagination defaults
to 50, permits at most 1000 records, and uses a signed parent/limit-bound cursor.
It is ordered by creation time and ID, not a frozen view across requests.

`DELETE` an item retains its row and records revocation. Repeated revocation
returns the same metadata and original timestamp. Other organization credentials
continue working. To rotate one integration, issue a new UUID with its exact
scope set, verify its use, then revoke the previous UUID. No automatic replay
resurrects a revoked credential or changes an existing scope set.

All responses use `Cache-Control: no-store`. Missing/wrong-parent resources are
`404`; invalid bodies, duplicate/unknown scopes and malformed pagination are
`400`. Changed scope replay conflicts, revoked replay and unavailable historical
replay material are `409`. Missing issuance keys or an invalid/unavailable whole master ring are `503`; a valid ring without
a matching historical key returns `409`. Unavailable control reads/writes return
`500`. Errors expose fixed
codes, never keys, credentials, hashes or provider exception text.

## Durable secret replay

D1 retains only the token digest and existing metadata columns. Issuance uses the
existing `ROLE_CREDENTIAL_KEYS` master ring through a separate HKDF-SHA256 context
for organization tokens and its key version, then HMAC-SHA256 over the canonical
organization UUID, token UUID and scope set. Its full 32-byte output keeps the
existing `cporg_` credential shape. Role-password AES-GCM behavior remains
unchanged; neither provider credentials nor allowance keys supply this master.
[HKDF context separation](https://www.rfc-editor.org/rfc/rfc5869.html#section-3.2)
binds derived key material to its purpose; raw AES keys are not used as HMAC keys.

Before replay, bind the stored organization, UUID, exact scopes and active state.
Derive candidates from at most eight retained versions and match the persisted
credential digest. Reobserve the winning active row before disclosure. A lost
insert reply or concurrent issuance recovers that committed winner rather than
issuing another credential. Never rewrite a stored digest, invent historical
keys, adopt a legacy random credential or resurrect a revoked row.

Normal credential authentication uses the stored digest and does not depend on
master-key availability. Metadata reads and revocation also remain available
without the role master. Their cursor signature derives separately from the
already-required installation credential; bootstrap rotation invalidates old
cursors, so start a new metadata listing with the new installation credential.

Retain historical master versions while replay may be needed. Existing control
recovery retains this ring, but its role/allowance ciphertext verifier does **not**
prove replay-key completeness for API-token digests. An independently restored
control database remains inactive; this feature neither implements disaster
activation fences nor claims account-loss recovery. Legacy random token secrets
cannot be reconstructed; installation-owned emergency reissue remains explicit.

## Qualification

Use three bounded, meaningful red-first stories: stable scoped issuance through
an uncertain insert and actual read/write behavior; parent-bound metadata and
selective revocation through an in-flight project request; historical replay and
refusal after key/scope changes. Then freeze and run the canonical gate once.
Dev qualification must independently observe the same public Worker source,
metadata-only listing, exact replay and scope denial, targeted revocation and
preserved unrelated credentials/control counts. No PostgreSQL operation or
customer admission is required to qualify this management capability.
