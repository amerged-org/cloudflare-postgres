# Control API first slice

This Worker implements a small, generic `/v1` management API backed by one D1 database. It records organizations, registered regions, scoped API tokens, projects, idempotency identities, and audit operations. A project is a global logical container created immediately in D1. Its `active` status does not mean that a PostgreSQL cluster, database, credential, or connection endpoint exists. Registering a region does not execute work or provision PostgreSQL.

## Operator setup

Create a D1 database in the adopter's Cloudflare account, copy `wrangler.example.jsonc` to `wrangler.jsonc` in this directory, and set its database name and ID to that database. `wrangler.jsonc` is ignored by Git. From this directory, apply the migrations with `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc` before serving requests. Configure a high-entropy `INSTALLATION_BOOTSTRAP_TOKEN` as a Worker Secret for this Worker, for example with `pnpm exec wrangler secret put INSTALLATION_BOOTSTRAP_TOKEN --config wrangler.jsonc`. The example configuration contains no account ID or secret. Keep all Worker configuration and any local development secret files in this directory; a parent directory's operator credentials are outside the Worker's configuration boundary. See Cloudflare's [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) documentation for operator details.

The separate `wrangler.test.jsonc` binds a disposable local D1 database. Its fixed ID and installation token are test fixtures only. Tests apply the real migrations in Miniflare through Cloudflare's Vitest plugin. Run the focused tests with `pnpm exec vitest run test/api.test.ts` from this directory.

## API behavior

Send `POST /v1/organizations` with `Authorization: Bearer <installation bootstrap token>` and JSON `{ "name": "..." }`. A successful response creates an organization and returns a random `cporg_...` API token with `projects:read`, `projects:write`, and `operations:read` scopes. D1 stores only its SHA-256 digest. The token is returned in this response only; store it securely at creation. The installation token is for organization bootstrap, not ordinary organization requests.

If the bootstrap response is lost after the database commits, use the installation token to call `GET /v1/organizations` and find the new organization. Results are newest first, with 1000 entries per page by default; `limit` accepts 1–1000. Follow each non-null `nextCursor` as the `cursor` query parameter until the target appears or `nextCursor` is null. The cursor advances by creation time and ID; concurrent creations or deletions can change later pages. Invalid pagination parameters return `400 invalid_request`. Then call `POST /v1/organizations/{organizationId}/tokens/reissue`. The response reveals a replacement token once and revokes every previously active token for that organization. A repeated reissue creates another replacement and invalidates the previous one; keep the final successful response. These installation routes never accept an ordinary organization token.

JSON bodies are limited to 4096 UTF-8 bytes, including when the caller omits `Content-Length`. Oversized or invalid bodies return `400 invalid_request` without buffering the full request.

Send `POST /v1/organizations/{organizationId}/projects` with the organization token, JSON `{ "name": "..." }`, and an `Idempotency-Key` of 1–128 ASCII letters, digits, `.`, `_`, `~`, or `-`. A successful `201` response contains an `active` logical project and a `succeeded` `project.create` audit operation, with `observedAt` and `resultCode: logical_container_created`. The same key and same request return the same IDs and `201` response for a completed pair. An unmatched legacy `pending`/`queued` pair instead returns `202` with its original IDs and requires operator review. Reusing the key with a different name returns `409 idempotency_conflict`. Idempotency records currently have no expiry. D1 inserts the project, completed operation, and idempotency identity in one atomic batch, so a failed insert does not leave an orphan.

Migration `0004_logical_projects.sql` updates only legacy name-only `project.create` pairs in `pending`/`queued` state with exactly one operation per project. It preserves IDs and creation timestamps, and records when the pre-existing D1 container was observed. Rows with other states or multiple operations remain unchanged for operator review. No region is inferred or provisioned.

The rollout has two phases because an older Worker could write another legacy pair after migration. Pause all project-creation clients, review unexpected legacy states, and apply `0004` before deploying the new Worker. After deployment, run `pnpm exec wrangler d1 execute DB --remote --config wrangler.jsonc --file scripts/reconcile-logical-projects.sql`. This repeatable script contains only the guarded backfill updates, not schema changes or runtime auto-repair. Verify that the following query returns zero eligible legacy pairs, then resume project clients:

```sql
SELECT COUNT(*) AS eligible_legacy_projects
FROM projects AS project
WHERE project.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM operations AS operation
    WHERE operation.project_id = project.id
      AND operation.organization_id = project.organization_id
      AND operation.kind = 'project.create'
      AND operation.status = 'queued'
  )
  AND (
    SELECT COUNT(*) FROM operations AS related
    WHERE related.project_id = project.id
      AND related.organization_id = project.organization_id
  ) = 1;
```

This zero-count check is separate from the preflight review of unmatched states; it does not make those records safe to convert.

Use the organization token to read `GET /v1/organizations/{organizationId}/projects/{projectId}` and `GET /v1/organizations/{organizationId}/operations/{operationId}`. Token lookup and resource reads use the D1 primary. Missing or invalid tokens return `401`; a valid token for another organization receives `404`. All API responses set `Cache-Control: no-store`. The [OpenAPI contract](openapi.yaml) records request and response shapes.

The current slice has no database-environment creation, organization-token rotation API, idempotency archival, rate limiting, or regional reconciliation. It is development groundwork for the later control-plane milestone, not an operational PostgreSQL service.

## Region registration

An installation operator sends `POST /v1/regions` with the installation bearer token and JSON `{ "name": "..." }`. Region names are unique under exact, case-sensitive matching; registering an existing name returns `409 region_name_conflict`. The response contains an opaque region UUID, `registered` status, and a random `cprgn_...` executor token with `operations:claim` and `operations:report` scopes. D1 stores only the token's SHA-256 digest. The token has no executable API until the regional claim/report protocol exists; store it in the regional controller's secret store, never in a public configuration file.

If the creation response is lost, `GET /v1/regions` pages through registered regions with `limit` 1–1000 and `nextCursor`; `GET /v1/regions/{regionId}` reads one registration. Neither route reveals tokens. Call `POST /v1/regions/{regionId}/tokens/reissue` with the installation token to revoke the prior token and receive a replacement once. A repeated reissue invalidates the previous replacement, so retain the final successful response. These routes reject organization tokens. Projects have no region; a future database environment must select one explicitly.
