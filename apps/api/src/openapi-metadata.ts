// SPDX-License-Identifier: Apache-2.0
export type DocumentationAuth = "none" | "api" | "project" | "admin" | "agent";
export interface RouteMetadata {
  operationId: string;
  summary: string;
  auth: DocumentationAuth;
  errors?: readonly number[];
}
const route = (
  operationId: string,
  summary: string,
  auth: DocumentationAuth,
  errors?: readonly number[],
): RouteMetadata => ({ operationId, summary, auth, errors });

/** Human-authored operation identities and summaries for the actual registered interfaces.
 * This describes routes; it neither installs a handler nor changes its validation or authorization. */
export const routeMetadata: Readonly<Record<string, RouteMetadata>> = {
  "GET /healthz": route("checkWorkerHealth", "Check Worker health", "none"),
  "GET /v1/openapi.json": route(
    "getPublicApiReference",
    "Read the management API reference",
    "none",
    [500],
  ),
  "GET /agent/v1/openapi.json": route(
    "getAgentApiReference",
    "Read the regional agent API reference",
    "none",
    [500],
  ),
  "POST /v1/api-keys": route("createApiKey", "Create an API key", "admin"),
  "GET /v1/api-keys": route("listApiKeys", "List API keys", "admin"),
  "DELETE /v1/api-keys/{id}": route(
    "revokeApiKey",
    "Revoke an API key",
    "admin",
  ),
  "POST /v1/projects": route("createProject", "Create a project", "admin"),
  "GET /v1/projects": route("listProjects", "List accessible projects", "api"),
  "GET /v1/projects/{id}": route("getProject", "Read a project", "project"),
  "DELETE /v1/projects/{id}": route(
    "deleteProject",
    "Delete an empty project",
    "project",
  ),
  "GET /v1/size-classes": route(
    "listSizeClasses",
    "List database size classes",
    "api",
  ),
  "PUT /v1/size-classes/{id}": route(
    "upsertSizeClass",
    "Create or update a database size class",
    "admin",
  ),
  "POST /v1/regions": route("createRegion", "Create a region", "admin"),
  "GET /v1/regions": route(
    "listRegions",
    "List regions, or for an integrator the regions that accept placement",
    "api",
  ),
  "GET /v1/regions/{id}": route(
    "getRegion",
    "Read regional inventory",
    "admin",
  ),
  "GET /v1/nodes": route("listNodes", "List registered nodes", "admin"),
  "GET /v1/nodes/{id}": route(
    "getNode",
    "Read registered node inventory and physical identity",
    "admin",
  ),
  "POST /v1/databases": route("createDatabase", "Create a database", "project"),
  "GET /v1/databases": route(
    "listDatabases",
    "List databases with placement and public state filters",
    "project",
    [400, 401, 404, 500],
  ),
  "GET /v1/databases/{id}": route(
    "getDatabase",
    "Read database state and assigned node",
    "project",
    [400, 401, 404, 500],
  ),
  "PATCH /v1/databases/{id}": route(
    "resizeDatabase",
    "Change a database size class",
    "project",
  ),
  "PUT /v1/databases/{id}/idle-time": route(
    "setDatabaseIdleTime",
    "Set a database's idle time before it sleeps",
    "project",
  ),
  "DELETE /v1/databases/{id}": route(
    "deleteDatabase",
    "Delete a database and retain its eligible archive",
    "project",
  ),
  "POST /v1/databases/{id}/restore": route(
    "restoreDatabase",
    "Restore a database from its archive",
    "project",
  ),
  "POST /v1/databases/{id}/suspend": route(
    "suspendDatabase",
    "Suspend a database",
    "project",
  ),
  "POST /v1/databases/{id}/resume": route(
    "resumeDatabase",
    "Resume a suspended database",
    "project",
  ),
  "GET /v1/databases/{id}/roles": route(
    "listDatabaseRoles",
    "List database roles",
    "project",
  ),
  "POST /v1/databases/{id}/roles": route(
    "createDatabaseRole",
    "Create a database role",
    "project",
  ),
  "POST /v1/databases/{id}/roles/{name}/reset-password": route(
    "resetDatabaseRolePassword",
    "Reset a database role password",
    "project",
  ),
  "DELETE /v1/databases/{id}/roles/{name}": route(
    "deleteDatabaseRole",
    "Delete a database role",
    "project",
  ),
  "GET /v1/databases/{id}/roles/{name}/connection-uri": route(
    "getDatabaseConnectionUri",
    "Read a Cloudflare database connection URI",
    "project",
  ),
  "GET /v1/operations/{id}": route(
    "getDatabaseOperation",
    "Read a database operation",
    "project",
  ),
  "GET /v1/databases/{id}/operations": route(
    "listDatabaseOperations",
    "List the operations of a database, newest first",
    "project",
  ),
  "GET /v1/databases/{id}/archive": route(
    "getDatabaseArchive",
    "Count the base backups, WAL segments and bytes of a database archive",
    "project",
  ),
  "GET /v1/databases/{id}/backups": route(
    "getDatabaseBackups",
    "Read the restorable window and base backups of a database",
    "project",
  ),
  "GET /v1/usage": route("getUsage", "Read measured usage rollups", "project"),
  "GET /v1/costs": route(
    "getInfrastructureCosts",
    "Read measured infrastructure costs",
    "admin",
  ),
  "POST /v1/costs/node-facts": route(
    "refreshNodeCostFacts",
    "Record an immutable infrastructure cost fact",
    "admin",
  ),
  "GET /v1/nodes/{id}/storage": route(
    "getNodeStorage",
    "Read observed physical node storage",
    "admin",
  ),
  "PUT /v1/nodes/{id}/database-placement": route(
    "setNodeDatabasePlacement",
    "Set the node gate for new database placement",
    "admin",
  ),
  "POST /v1/nodes/{id}/mark-lost": route(
    "markNodeLost",
    "Mark a physical node lost with its current identity fence",
    "admin",
  ),
  "POST /v1/nodes/additions": route(
    "proposeNodeAddition",
    "Propose a provider node addition",
    "admin",
  ),
  "GET /v1/nodes/additions": route(
    "listNodeAdditions",
    "List node addition operations",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}": route(
    "getNodeAddition",
    "Read a node addition operation",
    "admin",
  ),
  "POST /v1/nodes/additions/{id}/approve": route(
    "approveNodeAddition",
    "Approve a proposed node purchase",
    "admin",
  ),
  "POST /v1/nodes/additions/{id}/cancel": route(
    "cancelNodeAddition",
    "Cancel a node addition",
    "admin",
  ),
  "GET /v1/regions/{id}/configuration": route(
    "getRegionConfiguration",
    "Read regional PostgreSQL and storage configuration",
    "admin",
  ),
  "PUT /v1/regions/{id}/configuration": route(
    "setRegionConfiguration",
    "Update regional gateway routing",
    "admin",
  ),
  "PUT /v1/fleet/releases/{id}": route(
    "approveFleetRelease",
    "Approve an immutable fleet release",
    "admin",
  ),
  "GET /v1/fleet/releases/{id}": route(
    "getFleetRelease",
    "Read an immutable fleet release",
    "admin",
  ),
  "GET /v1/fleet/releases": route(
    "listFleetReleases",
    "List approved immutable fleet releases",
    "admin",
  ),
  "PUT /v1/regions/{id}/release": route(
    "assignRegionFleetRelease",
    "Assign a fleet release to a region",
    "admin",
  ),
  "GET /v1/regions/{id}/release": route(
    "getRegionFleetRelease",
    "Read regional fleet release assignment",
    "admin",
  ),
  "PUT /v1/nodes/{id}/release": route(
    "assignNodeFleetRelease",
    "Assign a fleet release to a physical node identity",
    "admin",
  ),
  "GET /v1/nodes/{id}/release": route(
    "getNodeFleetRelease",
    "Read node release assignment and runtime convergence",
    "admin",
  ),
  "GET /v1/fleet/update-policy": route(
    "getFleetUpdatePolicy",
    "Read automatic fleet update policy",
    "admin",
  ),
  "PUT /v1/fleet/update-policy": route(
    "setFleetUpdatePolicy",
    "Set automatic fleet update policy",
    "admin",
  ),
  "GET /v1/fleet/update-candidates": route(
    "listFleetUpdateCandidates",
    "List tracked fleet update candidates",
    "admin",
  ),
  "GET /v1/fleet/update-candidates/{id}": route(
    "getFleetUpdateCandidate",
    "Read fleet update candidate and qualification state",
    "admin",
  ),
  "POST /v1/fleet/update-candidates/{id}/reject": route(
    "rejectFleetUpdateCandidate",
    "Reject a fleet update candidate",
    "admin",
  ),
  "POST /v1/fleet/update-candidates/{id}/resume": route(
    "resumeFleetUpdateCandidate",
    "Resume supported fleet update candidate processing",
    "admin",
  ),
  "GET /v1/resource-profiles/{id}/rollout": route(
    "getResourceProfileRollout",
    "Read central resource profile rollout state",
    "admin",
  ),
  "PUT /v1/resource-profiles/{id}/rollout": route(
    "setResourceProfileRollout",
    "Select central resource profile rollout policy",
    "admin",
  ),
  "GET /v1/resource-profiles/{id}": route(
    "getResourceProfile",
    "Read a central resource profile",
    "api",
  ),
  "PUT /v1/resource-profiles/{id}": route(
    "setResourceProfile",
    "Create a successor central resource profile revision",
    "admin",
  ),
  "GET /v1/resource-profiles/{id}/revisions/{revision}": route(
    "getResourceProfileRevision",
    "Read an immutable resource profile revision",
    "api",
  ),
  "GET /v1/databases/{id}/resource-profile": route(
    "getDatabaseResourceProfile",
    "Read a database resource profile assignment",
    "project",
  ),
  "PUT /v1/databases/{id}/resource-profile": route(
    "assignDatabaseResourceProfile",
    "Assign a resource profile to a database",
    "project",
  ),
  "GET /v1/regions/{target}/archive-sources/{source}": route(
    "getRegionArchiveSource",
    "Read a regional archive source binding",
    "admin",
  ),
  "PUT /v1/regions/{target}/archive-sources/{source}": route(
    "setRegionArchiveSource",
    "Configure a source archive for regional restores",
    "admin",
  ),
  "GET /v1/regions/{id}/capacity-policy": route(
    "getRegionCapacityPolicy",
    "Read regional capacity and purchase policy",
    "admin",
  ),
  "PUT /v1/regions/{id}/capacity-policy": route(
    "setRegionCapacityPolicy",
    "Update regional capacity and purchase policy",
    "admin",
  ),
  "GET /v1/regions/{id}/capacity-decision": route(
    "getRegionCapacityDecision",
    "Read current regional placement and expansion decisions",
    "admin",
  ),
  "GET /v1/infrastructure-backups/config": route(
    "getInfrastructureBackupConfig",
    "Read infrastructure backup and alert delivery settings",
    "admin",
  ),
  "PUT /v1/infrastructure-backups/config": route(
    "setInfrastructureBackupConfig",
    "Update infrastructure backup and alert delivery settings",
    "admin",
  ),
  "GET /v1/infrastructure-backups": route(
    "getInfrastructureBackupStatus",
    "Read infrastructure backup receipts and freshness",
    "admin",
  ),
  "GET /v1/operational-health": route(
    "getOperationalHealth",
    "Read measured operational health and alert episodes",
    "admin",
  ),
  "GET /agent/v1/desired": route(
    "getAgentDesiredState",
    "Read authoritative regional desired state",
    "agent",
  ),
  "POST /agent/v1/observations": route(
    "reportAgentObservations",
    "Report regional database and node observations",
    "agent",
  ),
  "GET /agent/v1/link": route(
    "openAgentHintLink",
    "Open the regional desired-state hint WebSocket",
    "agent",
  ),
  "POST /agent/v1/activity": route(
    "reportAgentActivity",
    "Report database activity observations",
    "agent",
  ),
  "POST /agent/v1/usage": route(
    "reportAgentUsage",
    "Report measured database and node usage",
    "agent",
  ),
  "POST /agent/v1/fleet-observations": route(
    "reportAgentFleetInventory",
    "Report authenticated component runtime inventory",
    "agent",
  ),
};
