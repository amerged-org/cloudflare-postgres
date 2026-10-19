// SPDX-License-Identifier: Apache-2.0

/** Public handler errors, not a default set for every method or resource family.
 * Validation/body failures are 400; API-key authentication is 401 and admin scope is 403.
 * D1, custody, actor and upstream failures reach app.ts's 500 boundary.
 * assertProjectAccess/databaseForRequest hide foreign project resources as 404, not 403.
 */
export const publicRouteErrors: Readonly<Record<string, readonly number[]>> = {
  "GET /healthz": [],
  "GET /v1/openapi.json": [500],

  "POST /v1/api-keys": [400, 401, 403, 404, 409, 500],
  "GET /v1/api-keys": [400, 401, 403, 500],
  "DELETE /v1/api-keys/{id}": [400, 401, 403, 404, 409, 500],
  "POST /v1/projects": [400, 401, 403, 404, 409, 500],
  "GET /v1/projects": [400, 401, 500],
  "GET /v1/projects/{id}": [400, 401, 404, 500],
  "DELETE /v1/projects/{id}": [400, 401, 404, 409, 500],
  "GET /v1/size-classes": [400, 401, 500],
  "PUT /v1/size-classes/{id}": [400, 401, 403, 404, 409, 500],
  "POST /v1/regions": [400, 401, 403, 409, 500],
  "GET /v1/regions": [400, 401, 500],
  "GET /v1/regions/{id}": [400, 401, 403, 404, 500],
  // inventoryRows rejects a Node UID change between its bounded base and fleet reads.
  "GET /v1/nodes": [400, 401, 403, 409, 500],
  "GET /v1/nodes/{id}": [400, 401, 403, 404, 409, 500],

  "POST /v1/databases": [400, 401, 404, 409, 500],
  "GET /v1/databases": [400, 401, 404, 500],
  "GET /v1/databases/{id}": [400, 401, 404, 500],
  // scheduleDatabaseResize is the public database path that can refuse capacity with 503.
  "PATCH /v1/databases/{id}": [400, 401, 404, 409, 500, 503],
  // 409: the database is deleted.
  "PUT /v1/databases/{id}/idle-time": [400, 401, 404, 409, 500],
  // 403: not an admin key; 503: the node cannot take the growth.
  "PUT /v1/databases/{id}/resources": [400, 401, 403, 404, 409, 500, 503],
  "DELETE /v1/databases/{id}": [400, 401, 404, 409, 500],
  "POST /v1/databases/{id}/restore": [400, 401, 404, 409, 500],
  "POST /v1/databases/{id}/suspend": [400, 401, 404, 409, 500],
  "POST /v1/databases/{id}/resume": [400, 401, 404, 409, 500],
  "GET /v1/databases/{id}/roles": [400, 401, 404, 500],
  "POST /v1/databases/{id}/roles": [400, 401, 404, 409, 500],
  "POST /v1/databases/{id}/roles/{name}/reset-password": [
    400, 401, 404, 409, 500,
  ],
  // 400: the owner or the maintenance role; 409: a member_of target, a change in progress.
  "DELETE /v1/databases/{id}/roles/{name}": [400, 401, 404, 409, 500],
  "GET /v1/databases/{id}/roles/{name}/connection-uri": [400, 401, 404, 500],
  "GET /v1/operations/{id}": [400, 401, 404, 500],
  "GET /v1/databases/{id}/operations": [400, 401, 404, 500],
  "GET /v1/databases/{id}/archive": [400, 401, 404, 500],
  "GET /v1/databases/{id}/backups": [400, 401, 404, 500],
  "GET /v1/usage": [400, 401, 404, 500],
  "GET /v1/costs": [400, 401, 403, 404, 500],
  "POST /v1/costs/node-facts": [400, 401, 403, 404, 409, 500],

  // setNodeDatabasePlacement's failed identity CAS is 409 even for a missing/lost node.
  "PUT /v1/nodes/{id}/database-placement": [400, 401, 403, 409, 500],
  // Only an administrator reads a report: any other key is told 404, as for a resource it does not own.
  "GET /v1/nodes/{id}/diagnostics": [400, 401, 404, 500],
  "POST /v1/nodes/{id}/diagnostics": [400, 401, 404, 500],
  "GET /v1/nodes/{id}/diagnostics/{diagnostic_id}": [400, 401, 404, 500],
  "POST /v1/nodes/{id}/mark-lost": [400, 401, 403, 404, 409, 500],
  "GET /v1/nodes/{id}/loss": [400, 401, 403, 404, 500],
  "POST /v1/nodes/{id}/reinstall-override": [400, 401, 403, 404, 409, 500],
  "POST /v1/databases/{id}/move": [400, 401, 403, 404, 409, 500],
  "GET /v1/databases/{id}/moves": [400, 401, 403, 404, 500],
  // reserveNodeAddition's slot refusal is NodeStateError.capacity_unavailable -> 503.
  "POST /v1/nodes/additions": [400, 401, 403, 404, 409, 500, 503],
  // This list reads each stored addition through readNodeAddition and its intent-integrity guard.
  "GET /v1/nodes/additions": [400, 401, 403, 404, 409, 500],
  "GET /v1/nodes/additions/{id}": [400, 401, 403, 404, 409, 500],
  "POST /v1/nodes/additions/{id}/approve": [400, 401, 403, 404, 409, 500],
  "POST /v1/nodes/additions/{id}/cancel": [400, 401, 403, 404, 409, 500],

  "GET /v1/regions/{id}/configuration": [400, 401, 403, 404, 500],
  "PUT /v1/regions/{id}/configuration": [400, 401, 403, 404, 409, 500],
  "PUT /v1/fleet/releases/{id}": [400, 401, 403, 404, 409, 500],
  "GET /v1/fleet/releases/{id}": [400, 401, 403, 404, 500],
  // Immutable global history lists do not check existence/current assignment or refuse empty pages.
  "GET /v1/fleet/releases": [400, 401, 403, 500],
  "PUT /v1/regions/{id}/release": [400, 401, 403, 404, 409, 500],
  "GET /v1/regions/{id}/node-policy": [400, 401, 403, 404, 500],
  "PUT /v1/regions/{id}/node-policy": [400, 401, 403, 404, 500],
  "GET /v1/regions/{id}/release": [400, 401, 403, 404, 500],
  "GET /v1/nodes/{id}/release": [400, 401, 403, 404, 500],
  "GET /v1/resource-profiles/{id}/rollout": [400, 401, 403, 404, 500],
  "PUT /v1/resource-profiles/{id}/rollout": [400, 401, 403, 404, 409, 500],
  "GET /v1/resource-profiles/{id}": [400, 401, 404, 500],
  "PUT /v1/resource-profiles/{id}": [400, 401, 403, 404, 409, 500],
  "GET /v1/resource-profiles/{id}/revisions/{revision}": [400, 401, 404, 500],
  "GET /v1/databases/{id}/resource-profile": [400, 401, 404, 500],
  "PUT /v1/databases/{id}/resource-profile": [400, 401, 404, 409, 500, 503],
  "GET /v1/regions/{id}/capacity-policy": [400, 401, 403, 404, 500],
  "PUT /v1/regions/{id}/capacity-policy": [400, 401, 403, 404, 409, 500],
  // A dry-run decision for an absent policy/region is 200/action=unconfigured.
  // An active addition's persisted-intent conflict propagates through runNodeCapacity's dry-run read.
  "GET /v1/regions/{id}/capacity-decision": [400, 401, 403, 409, 500],
  "GET /v1/infrastructure-backups/config": [400, 401, 403, 500],
  "PUT /v1/infrastructure-backups/config": [400, 401, 403, 404, 409, 500],
  "GET /v1/infrastructure-backups": [400, 401, 403, 500],
  "GET /v1/operational-health": [400, 401, 403, 500],
};

/** These handlers call withIdempotency, directly or through resizeDatabase.
 * POST api-keys supports it for authenticated admin creation; the one-time bootstrap branch bypasses it.
 * Other configuration/approval/cancel/inspection handlers do not gain idempotency from their method.
 */
export const idempotentPublicRoutes: ReadonlySet<string> = new Set([
  "POST /v1/api-keys",
  "DELETE /v1/api-keys/{id}",
  "POST /v1/projects",
  "DELETE /v1/projects/{id}",
  "PUT /v1/size-classes/{id}",
  "POST /v1/regions",
  "POST /v1/databases",
  "PATCH /v1/databases/{id}",
  "PUT /v1/databases/{id}/idle-time",
  "PUT /v1/databases/{id}/resources",
  "DELETE /v1/databases/{id}",
  "POST /v1/databases/{id}/restore",
  "POST /v1/databases/{id}/suspend",
  "POST /v1/databases/{id}/resume",
  "POST /v1/databases/{id}/roles",
  "POST /v1/databases/{id}/roles/{name}/reset-password",
  "DELETE /v1/databases/{id}/roles/{name}",
  "POST /v1/costs/node-facts",
  "POST /v1/nodes/additions",
  "PUT /v1/regions/{id}/configuration",
  "PUT /v1/fleet/releases/{id}",
  "PUT /v1/regions/{id}/release",
  "PUT /v1/resource-profiles/{id}/rollout",
  "PUT /v1/resource-profiles/{id}",
  "PUT /v1/databases/{id}/resource-profile",
]);

/** withIdempotency refuses an omitted key on these routes (400) before submitting durable work, and
 * the served document marks the header required from the same set: the long-running platform
 * operations and every mutation of a database an integrator calls, whose retries must be safe.
 */
export const requiredIdempotentPublicRoutes: ReadonlySet<string> = new Set([
  "POST /v1/nodes/additions",
  "POST /v1/databases",
  "PATCH /v1/databases/{id}",
  "PUT /v1/databases/{id}/idle-time",
  "PUT /v1/databases/{id}/resources",
  "DELETE /v1/databases/{id}",
  "POST /v1/databases/{id}/restore",
  "POST /v1/databases/{id}/suspend",
  "POST /v1/databases/{id}/resume",
  "PUT /v1/databases/{id}/resource-profile",
  "POST /v1/databases/{id}/roles",
  "POST /v1/databases/{id}/roles/{name}/reset-password",
  "DELETE /v1/databases/{id}/roles/{name}",
]);

/** Explicit Location writes in platform/*.ts, databaseOperationResponse and restore.response.
 * Cost facts, purchase approvals and Fleet/qualification acceptance do not emit Location; a role
 * mutation does only when it answers 202 with an operation.
 */
export const locationResponses: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "POST /v1/projects": {
    "201":
      "Created project resource path, also returned on a completed idempotency replay.",
  },
  "POST /v1/regions": {
    "201":
      "Created region resource path, also returned on a completed idempotency replay.",
  },
  "POST /v1/databases": {
    "202": "Database operation resource path.",
  },
  "PATCH /v1/databases/{id}": {
    "202": "Database resize operation resource path.",
  },
  "DELETE /v1/databases/{id}": {
    "202": "Database deletion operation resource path.",
  },
  "POST /v1/databases/{id}/restore": {
    "202": "Database restore operation resource path.",
  },
  "POST /v1/databases/{id}/suspend": {
    "202": "Database suspension operation resource path.",
  },
  "POST /v1/databases/{id}/resume": {
    "202": "Database resume operation resource path.",
  },
  "PUT /v1/databases/{id}/resource-profile": {
    "202":
      "Database resize operation resource path for the selected resource profile.",
  },
  "PUT /v1/databases/{id}/resources": {
    "202": "Database resize operation resource path for the new resources.",
  },
  "DELETE /v1/databases/{id}/roles/{name}": {
    "202": "Role deletion operation resource path.",
  },
  "POST /v1/nodes/additions": {
    "202":
      "Node addition operation resource path, also returned on a completed idempotency replay.",
  },
};
