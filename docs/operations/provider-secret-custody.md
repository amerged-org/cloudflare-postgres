# Provider secret custody

Cloudflare hosts the authoritative management layer. D1 stores control resources and verification hashes for platform API tokens. Worker Secrets hold provider credentials and cryptographic keys. Dynamic database credentials are encrypted before D1 persistence; regional Kubernetes Secrets supply the minimal credentials needed by the workload. This does not put customer PostgreSQL data in D1.

Configure provider credentials only in the adopter's selected control Worker/account:

| Worker Secret | Purpose |
| --- | --- |
| `CONTABO_CLIENT_ID` | Contabo API OAuth client identifier. |
| `CONTABO_CLIENT_SECRET` | Contabo API OAuth client secret. |
| `CONTABO_API_USERNAME` | Account API username. |
| `CONTABO_API_PASSWORD` | Dedicated account API password. |
| `CONTABO_VPS_ROOT_PASSWORD` | Existing development/rescue bootstrap credential, when required. This is not a shared credential for newly provisioned Talos machines. |

The provider adapter must obtain short-lived access tokens using these credentials; token refresh and provider operations remain implementation work. Merely storing a credential does not provision, patch or update a server. Talos administration uses its own scoped machine identity and API credentials.

Use the authenticated Cloudflare tooling against an explicit installation configuration. Supply secret values interactively or through a private stdin stream; retain no plaintext bulk-upload file. List secret names to verify custody without retrieving values. Preserve existing bootstrap/signing secrets during updates. Each adopter must define provider revocation and key recovery separately from ordinary database operation.

For local development, `.env.local` remains owner-readable, Git-ignored and excluded from container contexts. Private tools/cache/evidence use `.local/`, which is separately ignored. Never print environment values, commit credentials, attach private configurations to public issues or give customers provider/Kubernetes administration access.

On 2026-09-28, the existing Dev control Worker accepted these five provider-secret writes through stdin in 2.932 seconds. Readback verified all five names and preservation of the two existing platform-secret names. The local environment file remained byte-identical; an existing anonymous protected route still returned 401. This is secret-custody evidence, not provider-authentication or fleet-operation qualification. No provider server operation was performed by this transfer.
