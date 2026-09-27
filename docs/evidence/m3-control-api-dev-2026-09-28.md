# M3 development control API checkpoint — 2026-09-28

Status: **partial development deployment**. The Cloudflare Worker records durable management intent and now registers regional identities. It does not claim or execute operations, provision PostgreSQL, collect usage, or enforce budgets. The running PostgreSQL [M1 lab](m1-2026-09-28.md) was created manually and is not the result of an API project operation.

## Observed behavior

- The development Worker and EU-jurisdiction D1 database use migrations `0001`–`0003`. The third migration added region and region-token tables, an exact unique-name index, and an active-token uniqueness constraint. The remote migration and index were read back before the Worker update.
- Installation-token-only region registration returns an opaque UUID and a random executor token once. Its scopes are exactly `operations:claim` and `operations:report`; D1 stores the SHA-256 digest, not the token. Duplicate exact names return `409 region_name_conflict`. Installer-only list/read routes do not reveal tokens, and reissue revokes the prior token before returning a replacement once.
- One disposable lab region was registered through the live Worker. Its token is stored in an ignored, owner-readable local environment file. Live region read/list responses omitted the token; the remote D1 digest matched the locally held token. No claim/report endpoint exists yet, so registration does not grant a way to execute work.
- The earlier organization bootstrap, paginated organization recovery listing, scoped organization token, and D1-backed project intent remain available. The existing development project stays `pending` with its operation `queued`; no region was inferred or assigned to it.
- Three region-focused top-level tests were red before implementation. An additional red-first refinement enforced unique region names and checked the exact stored token digest. The frozen candidate passed the full repository gate once: format, lint, typecheck, 10 Worker tests, and `test:node`. The public commit and Worker deployment were read back, and no private environment files appeared in the remote tree.

## Next contracts to prove

1. Define an explicit region choice and a complete environment creation specification. A name-only project intent cannot honestly describe a PostgreSQL Cluster.
2. Implement region-scoped authenticated operation claim/lease/report with conditional D1 transitions, stale-lease fencing, retries, and observed state. A controller must check deterministic Kubernetes ownership before reconciling an uncertain outcome.
3. Reconcile a real environment through CloudNativePG, then add generic usage, budget, credential, and recovery APIs. Existing database connections must not depend on a Cloudflare management request per connection.

The [OpenAPI contract](../../apps/control-api/openapi.yaml) describes the shipped development routes. This checkpoint is not an operational database service or completion of M3.
