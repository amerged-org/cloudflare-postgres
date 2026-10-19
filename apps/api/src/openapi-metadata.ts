// SPDX-License-Identifier: Apache-2.0
export type DocumentationAuth =
  "none" | "api" | "project" | "admin" | "admin_read" | "node" | "installer";
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
  "GET /node/v1/openapi.json": route(
    "getNodeApiReference",
    "Read the node API reference",
    "none",
    [500],
  ),
  "POST /v1/api-keys": route("createApiKey", "Create an API key", "admin"),
  "GET /v1/api-keys": route("listApiKeys", "List API keys", "admin_read"),
  "DELETE /v1/api-keys/{id}": route(
    "revokeApiKey",
    "Revoke an API key",
    "admin",
  ),
  "GET /v1/audit-events": route(
    "listAuditEvents",
    "List the audit log of the administrator keys",
    "admin_read",
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
    "admin_read",
  ),
  "GET /v1/nodes": route("listNodes", "List registered nodes", "admin_read"),
  "GET /v1/nodes/{id}": route(
    "getNode",
    "Read registered node inventory and physical identity",
    "admin_read",
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
  "PUT /v1/databases/{id}/resources": route(
    "setDatabaseResources",
    "Set a database's own memory, CPU and storage",
    "admin",
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
    "admin_read",
  ),
  "POST /v1/costs/node-facts": route(
    "refreshNodeCostFacts",
    "Record an immutable infrastructure cost fact",
    "admin",
  ),
  "PUT /v1/nodes/{id}/database-placement": route(
    "setNodeDatabasePlacement",
    "Set the node gate for new database placement",
    "admin",
  ),
  "GET /v1/nodes/{id}/diagnostics": route(
    "listNodeDiagnostics",
    "List the boot reports of a node",
    "admin_read",
  ),
  "POST /v1/nodes/{id}/diagnostics": route(
    "requestNodeProbe",
    "Ask a node for a read-only probe",
    "admin",
  ),
  "GET /v1/nodes/{id}/diagnostics/{diagnostic_id}": route(
    "getNodeDiagnostic",
    "Read a boot report or the result of a probe",
    "admin_read",
  ),
  "POST /v1/nodes/{id}/mark-lost": route(
    "markNodeLost",
    "Declare a physical node lost and fence it",
    "admin",
  ),
  "GET /v1/nodes/{id}/loss": route(
    "getNodeLoss",
    "Read the fencing and the recovery points of a lost node",
    "admin_read",
  ),
  "POST /v1/nodes/{id}/maintenance": route(
    "startNodeMaintenance",
    "Run the maintenance cycle on one node",
    "admin",
  ),
  "GET /v1/nodes/{id}/maintenance/{operation}": route(
    "getNodeMaintenance",
    "Read a maintenance cycle of a node",
    "admin_read",
  ),
  "POST /v1/nodes/{id}/reinstall-override": route(
    "overrideNodeReinstallGuard",
    "Acknowledge that reinstalling a lost node may overwrite unarchived WAL",
    "admin",
  ),
  "POST /v1/databases/{id}/move": route(
    "moveDatabase",
    "Move a database to another node under the same ID",
    "admin",
  ),
  "GET /v1/databases/{id}/moves": route(
    "listDatabaseMoves",
    "List the moves of a database",
    "admin_read",
  ),
  "POST /v1/nodes/additions": route(
    "proposeNodeAddition",
    "Propose a provider node addition",
    "admin",
  ),
  "GET /v1/nodes/additions": route(
    "listNodeAdditions",
    "List node addition operations",
    "admin_read",
  ),
  "GET /v1/nodes/additions/{id}": route(
    "getNodeAddition",
    "Read a node addition operation",
    "admin_read",
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
    "admin_read",
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
    "admin_read",
  ),
  "GET /v1/fleet/releases": route(
    "listFleetReleases",
    "List approved immutable fleet releases",
    "admin_read",
  ),
  "PUT /v1/regions/{id}/release": route(
    "assignRegionFleetRelease",
    "Assign a fleet release to a region",
    "admin",
  ),
  "GET /v1/regions/{id}/release": route(
    "getRegionFleetRelease",
    "Read regional fleet release assignment",
    "admin_read",
  ),
  "GET /v1/nodes/{id}/release": route(
    "getNodeFleetRelease",
    "Read how a node stands against its region's release",
    "admin_read",
  ),
  "GET /v1/resource-profiles/{id}/rollout": route(
    "getResourceProfileRollout",
    "Read central resource profile rollout state",
    "admin_read",
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
  "GET /v1/regions/{id}/capacity-policy": route(
    "getRegionCapacityPolicy",
    "Read regional capacity and purchase policy",
    "admin_read",
  ),
  "PUT /v1/regions/{id}/capacity-policy": route(
    "setRegionCapacityPolicy",
    "Update regional capacity and purchase policy",
    "admin",
  ),
  "GET /v1/regions/{id}/capacity-decision": route(
    "getRegionCapacityDecision",
    "Read current regional placement and expansion decisions",
    "admin_read",
  ),
  "GET /v1/infrastructure-backups/config": route(
    "getInfrastructureBackupConfig",
    "Read infrastructure backup and alert delivery settings",
    "admin_read",
  ),
  "PUT /v1/infrastructure-backups/config": route(
    "setInfrastructureBackupConfig",
    "Update infrastructure backup and alert delivery settings",
    "admin",
  ),
  "GET /v1/infrastructure-backups": route(
    "getInfrastructureBackupStatus",
    "Read infrastructure backup receipts and freshness",
    "admin_read",
  ),
  "GET /v1/operational-health": route(
    "getOperationalHealth",
    "Read measured operational health and alert episodes",
    "admin_read",
  ),
  "GET /v1/regions/{id}/node-policy": route(
    "getRegionNodePolicy",
    "Read the rules a region's nodes decide by when they act alone",
    "admin_read",
  ),
  "PUT /v1/regions/{id}/node-policy": route(
    "setRegionNodePolicy",
    "Set the rules a region's nodes decide by when they act alone",
    "admin",
  ),
  "POST /node/v1/enroll": route(
    "enrollNode",
    "Enroll a node with the installer's one-time token and its key",
    "none",
  ),
  "POST /node/v1/installer/progress": route(
    "reportInstallerProgress",
    "Report a checkpoint of the pull installer",
    "installer",
  ),
  "GET /node/v1/releases/{version}/pgcf-node.raw.zst": route(
    "getNodeImage",
    "Read a release's node image with the installer's token",
    "installer",
  ),
  "GET /node/v1/releases/{version}/{file}": route(
    "getReleaseFile",
    "Read a binary or the package lock of a release",
    "none",
  ),
  "GET /node/v1/link": route(
    "openNodeLink",
    "Open the node's WebSocket link",
    "node",
  ),
  "GET /node/v1/desired": route(
    "getNodeDesiredPage",
    "Read the node's desired page",
    "node",
  ),
  "GET /node/v1/credentials": route(
    "getNodeCredentials",
    "Read the node's route keyring, the token of its Tunnel and, while the operator shell is on, its CA public key",
    "node",
  ),
  "GET /node/v1/archive-credentials/{id}": route(
    "getNodeArchiveCredential",
    "Read a temporary R2 credential the node's desired page names",
    "node",
  ),
  "POST /node/v1/observations": route(
    "reportNodeObservations",
    "Report the state of the node's databases and the results of its orders",
    "node",
  ),
  "POST /node/v1/volumes": route(
    "reportNodeVolumes",
    "Report every thin volume of the node",
    "node",
  ),
  "POST /node/v1/events": route(
    "reportNodeEvents",
    "Report the node's admission, early sleep and wake events",
    "node",
  ),
  "POST /node/v1/usage": route(
    "reportNodeUsage",
    "Report the node's metered usage of its databases",
    "node",
  ),
  "POST /node/v1/diagnostics": route(
    "reportNodeBoot",
    "Report the previous boot's journal after a reboot, or the result of a probe",
    "node",
  ),
};
