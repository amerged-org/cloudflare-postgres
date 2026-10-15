// SPDX-License-Identifier: Apache-2.0
export type DocumentationAuth =
  "none" | "api" | "project" | "admin" | "agent" | "callback";
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
  "POST /v1/nodes/{id}/postgres-pool/qualifications": route(
    "startPostgresPoolQualification",
    "Start one scoped thin-backed PostgreSQL pool qualification",
    "admin",
  ),
  "GET /v1/postgres-pool/qualifications/{id}": route(
    "getPostgresPoolQualification",
    "Read measured pool qualification evidence and cleanup",
    "admin",
  ),
  "POST /v1/postgres-pool/qualifications/{id}/cancel": route(
    "cancelPostgresPoolQualification",
    "Cancel measurements while retaining the cleanup reservation",
    "admin",
  ),
  "GET /agent/v1/nodes/{id}/postgres-pool/qualification": route(
    "getPostgresPoolQualificationInput",
    "Read the current scoped one-use measurement challenge",
    "agent",
  ),
  "POST /agent/v1/nodes/{id}/postgres-pool/qualification": route(
    "reportPostgresPoolQualification",
    "Record scoped progress or consume measured qualification evidence",
    "agent",
  ),
  "POST /agent/v1/nodes/{id}/postgres-pool/preparations": route(
    "reportPostgresPoolPreparation",
    "Report authenticated tenant-free Kubernetes preparation",
    "agent",
  ),
  "GET /agent/v1/nodes/{id}/postgres-pool/bindings": route(
    "readNodePostgresPoolBindings",
    "Read complete durable pool holder inventory",
    "agent",
  ),
  "POST /agent/v1/nodes/{id}/postgres-pool/inventory": route(
    "reportPostgresPoolInventory",
    "Report actual attested pool Pod inventory",
    "agent",
  ),
  "GET /agent/v1/pool-bindings/{id}": route(
    "readPostgresPoolBinding",
    "Read immutable binding and retained runtime cleanup evidence",
    "agent",
  ),
  "POST /agent/v1/databases/{id}/postgres-pool/storage": route(
    "reportPostgresPoolStorage",
    "Report exact physical pool volume readback",
    "agent",
  ),
  "POST /agent/v1/databases/{id}/postgres-pool/sleep": route(
    "reportPostgresPoolSleep",
    "Report verified clean PostgreSQL sleep",
    "agent",
  ),
  "POST /agent/v1/pool-bindings/{id}/node": route(
    "reportPostgresPoolNodeOutcome",
    "Report actual pool mount or physical release outcome",
    "agent",
  ),
  "POST /agent/v1/pool-bindings/{id}/serving": route(
    "reportPostgresPoolServing",
    "Report joint verified pool runtime readiness",
    "agent",
  ),
  "POST /agent/v1/pool-bindings/{id}/supervisor": route(
    "reportPostgresPoolSupervisor",
    "Report actual scoped PostgreSQL supervisor state",
    "agent",
  ),
  "POST /agent/v1/pool-bindings/{id}/io": route(
    "reportPostgresPoolIo",
    "Report every actual writer and shared Pod IO budget",
    "agent",
  ),
  "POST /agent/v1/pool-bindings/{id}/cleanup-io": route(
    "reportPostgresPoolCleanupIo",
    "Report stopped tenant writers and actual cleanup worker IO custody",
    "agent",
  ),
  "GET /fleet-images/v1/raw/{digest}": route(
    "downloadFleetRawImage",
    "Download an approved immutable Talos image",
    "none",
  ),
  "HEAD /fleet-images/v1/raw/{digest}": route(
    "getFleetRawImageHeaders",
    "Read approved immutable Talos image headers",
    "none",
  ),
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
  "GET /internal/v1/openapi.json": route(
    "getInternalApiReference",
    "Read the operation callback API reference",
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
  "GET /v1/regions/{id}/bootstrap-material": route(
    "getRegionBootstrapMaterial",
    "Read regional bootstrap material status",
    "admin",
  ),
  "POST /v1/regions/{id}/bootstrap-material": route(
    "setRegionBootstrapMaterial",
    "Synchronize verified regional version metadata",
    "admin",
  ),
  "POST /v1/regions/{id}/bootstrap-material/stage": route(
    "stageRegionBootstrapMaterial",
    "Stage successor regional bootstrap material",
    "admin",
  ),
  "POST /v1/regions/{id}/bootstrap-material/activate": route(
    "activateRegionBootstrapMaterial",
    "Activate staged regional bootstrap material",
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
  "POST /v1/nodes/additions/{id}/bootstrap": route(
    "prepareNodeBootstrap",
    "Prepare protected node bootstrap input",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}/bootstrap": route(
    "getNodeBootstrap",
    "Read node bootstrap status",
    "admin",
  ),
  "POST /v1/nodes/additions/{id}/verify": route(
    "verifyNodeAddition",
    "Verify the current physical node installation",
    "admin",
  ),
  "GET /v1/nodes/{id}/operator/kubernetes": route(
    "openOperatorKubernetes",
    "Open an administrator Kubernetes mTLS relay",
    "admin",
    [400, 401, 403, 404, 409, 500],
  ),
  "GET /v1/nodes/{id}/compute-pool/observations": route(
    "getComputePoolObservations",
    "Read compute pool observations and freshness",
    "admin",
  ),
  "GET /v1/nodes/{id}/compute-pool": route(
    "getComputePoolPolicy",
    "Read selected compute pool policy",
    "admin",
  ),
  "PUT /v1/nodes/{id}/compute-pool": route(
    "setComputePoolPolicy",
    "Select compute pool policy for the current node",
    "admin",
  ),
  "GET /v1/nodes/{id}/storage-profile": route(
    "getNodeThinStorageProfile",
    "Read selected thin storage profile and readiness",
    "admin",
  ),
  "PUT /v1/nodes/{id}/storage-profile": route(
    "selectNodeThinStorageProfile",
    "Select thin storage profile and database admission gate",
    "admin",
  ),
  "POST /v1/nodes/{id}/thin-qualifications": route(
    "startThinQualification",
    "Start isolated thin storage qualification",
    "admin",
  ),
  "GET /v1/thin-qualifications/{id}": route(
    "getThinQualification",
    "Read thin storage qualification evidence and gates",
    "admin",
  ),
  "POST /v1/thin-qualifications/{id}/resume": route(
    "resumeThinQualification",
    "Resume a supported thin qualification turn",
    "admin",
  ),
  "POST /v1/thin-qualifications/{id}/cancel": route(
    "cancelThinQualification",
    "Cancel thin qualification and request cleanup",
    "admin",
  ),
  "GET /v1/databases/{id}/warm-reclaim": route(
    "getWarmReclaimPolicy",
    "Read optional database warm reclaim policy",
    "admin",
  ),
  "PUT /v1/databases/{id}/warm-reclaim": route(
    "setWarmReclaimPolicy",
    "Set optional database warm reclaim policy",
    "admin",
  ),
  "GET /v1/nodes/{id}/warm-reclaim-qualification": route(
    "getWarmReclaimQualification",
    "Read node warm reclaimer qualification",
    "admin",
  ),
  "PUT /v1/nodes/{id}/warm-reclaim-qualification": route(
    "setWarmReclaimQualification",
    "Record current node warm reclaimer qualification",
    "admin",
  ),
  "GET /v1/nodes/{id}/host-configuration": route(
    "getNodeHostConfiguration",
    "Read selected protected host configuration",
    "admin",
  ),
  "PUT /v1/nodes/{id}/host-configuration": route(
    "setNodeHostConfiguration",
    "Select protected host configuration for the current node",
    "admin",
  ),
  "PUT /v1/regions/{id}/installation-profile": route(
    "setNodeInstallationProfile",
    "Select immutable regional node installation profile",
    "admin",
  ),
  "GET /v1/regions/{id}/installation-profile": route(
    "getNodeInstallationProfile",
    "Read selected regional node installation profile",
    "admin",
  ),
  "POST /v1/nodes/additions/{id}/installation-binding": route(
    "bindNodeInstallation",
    "Bind a purchased node to its installation profile",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}/installation-binding": route(
    "getNodeInstallationBinding",
    "Read the node installation binding",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}/inspection": route(
    "getNodeInstallationInspection",
    "Read current node installation inspection status",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}/proof/source": route(
    "getNodeSourceProof",
    "Read public node source ownership proof",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}/proof/preparation/journal": route(
    "getNodeProofPreparationJournal",
    "Read node proof preparation journal",
    "admin",
  ),
  "GET /v1/nodes/additions/{id}/proof/{mode}": route(
    "getNodeProofStatus",
    "Read selected node proof status and receipt",
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
  "POST /v1/nodes/{id}/patches": route(
    "startFleetPatch",
    "Start a fenced fleet patch on a selected node",
    "admin",
  ),
  "GET /v1/fleet/patches": route(
    "listFleetPatches",
    "List retained fleet patch operations",
    "admin",
  ),
  "GET /v1/fleet/patches/{operation_id}": route(
    "getFleetPatch",
    "Read fleet patch progress and physical readback",
    "admin",
  ),
  "POST /v1/fleet/patches/{operation_id}/resume": route(
    "resumeFleetPatch",
    "Resume a supported fleet patch stage",
    "admin",
  ),
  "POST /v1/fleet/patches/{operation_id}/halt": route(
    "haltFleetPatch",
    "Halt a fleet patch at its supported boundary",
    "admin",
  ),
  "POST /v1/fleet/rollouts": route(
    "startFleetRollout",
    "Atomically assign and start an ordered fleet rollout",
    "admin",
  ),
  "GET /v1/fleet/rollouts/{id}": route(
    "getFleetRollout",
    "Read whole fleet rollout progress",
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
  "GET /agent/v1/nodes/{id}/compute-pool": route(
    "getAgentComputePoolLease",
    "Read the current compute pool execution lease",
    "agent",
  ),
  "POST /agent/v1/nodes/{id}/compute-pool": route(
    "reportAgentComputePool",
    "Report current compute pool runtime observations",
    "agent",
  ),
  "GET /agent/v1/nodes/{id}/storage-guard": route(
    "getAgentStorageGuard",
    "Read current signed host storage guard state",
    "agent",
  ),
  "POST /agent/v1/nodes/{id}/storage-headroom": route(
    "reportAgentStorageHeadroom",
    "Submit a nonce-bound physical storage headroom sample",
    "agent",
  ),
  "GET /agent/v1/nodes/{id}/reclaim": route(
    "getAgentReclaimIntents",
    "Read current qualified memory reclaim intents",
    "agent",
  ),
  "POST /agent/v1/nodes/{id}/reclaim-observations": route(
    "reportAgentReclaim",
    "Report qualified memory reclaim outcomes",
    "agent",
  ),
  "POST /agent/v1/fleet-observations": route(
    "reportAgentFleetInventory",
    "Report authenticated component runtime inventory",
    "agent",
  ),
  "POST /internal/v1/node-installation/{id}/transport": route(
    "issueNodeInspectionTransport",
    "Issue scoped node inspection byte transport",
    "callback",
  ),
  "POST /internal/v1/node-installation/{id}/inspection": route(
    "reportNodeInspection",
    "Record the authorized node inspection report",
    "callback",
  ),
  "GET /internal/v1/node-installation/{id}/relay": route(
    "openNodeInspectionRelay",
    "Open scoped node inspection byte relay",
    "callback",
  ),
  "POST /internal/v1/node-bootstrap/{operation_id}": route(
    "executeNodeBootstrapCallback",
    "Read bootstrap authority or checkpoint bootstrap execution",
    "callback",
  ),
  "GET /internal/v1/node-bootstrap/{operation_id}/relay": route(
    "openNodeBootstrapRelay",
    "Open scoped bootstrap byte relay",
    "callback",
  ),
  "POST /internal/v1/node-thin-storage/{id}": route(
    "executeNodeThinStorageTurn",
    "Read thin storage authority or report mutation progress",
    "callback",
  ),
  "GET /internal/v1/node-thin-storage/{id}/relay": route(
    "openNodeThinStorageRelay",
    "Open scoped thin storage byte relay",
    "callback",
  ),
  "POST /internal/v1/thin-qualifications/{id}": route(
    "executeThinQualificationTurn",
    "Read qualification authority or checkpoint measured evidence",
    "callback",
  ),
  "GET /internal/v1/thin-qualifications/{id}/relay": route(
    "openThinQualificationRelay",
    "Open scoped qualification byte relay",
    "callback",
  ),
  "POST /internal/v1/fleet-patches/{operation_id}": route(
    "executeFleetPatchTurn",
    "Read patch authority or checkpoint fleet patch progress",
    "callback",
  ),
  "GET /internal/v1/fleet-patches/{operation_id}/relay": route(
    "openFleetPatchRelay",
    "Open scoped fleet patch byte relay",
    "callback",
  ),
  "POST /internal/v1/node-proof/{id}/transport": route(
    "issueNodeProofTransport",
    "Issue scoped node proof byte transport",
    "callback",
  ),
  "GET /internal/v1/node-proof/{id}/relay": route(
    "openNodeProofRelay",
    "Open scoped node proof byte relay",
    "callback",
  ),
  "POST /internal/v1/node-proof/{id}/access": route(
    "collectNodeProofAccess",
    "Collect authorized node proof access evidence",
    "callback",
  ),
  "POST /internal/v1/node-proof/{id}/report": route(
    "reportNodeProof",
    "Record the scoped physical node proof report",
    "callback",
  ),
  "POST /internal/v1/node-proof/{id}/ownership": route(
    "checkpointNodeProofOwnership",
    "Read or checkpoint scoped node proof ownership state",
    "callback",
  ),
  "POST /internal/v1/fleet-rollouts/{rollout}/regions/{region}/rotation": route(
    "checkpointFleetRegionRotation",
    "Checkpoint authorized regional authority rotation",
    "callback",
  ),
  "GET /internal/v1/fleet-rollouts/{rollout}/regions/{region}/rotation/kubernetes/{node}":
    route(
      "openFleetRotationKubernetes",
      "Open fenced regional rotation Kubernetes relay",
      "callback",
    ),
  "GET /internal/v1/infrastructure-backups/{run}/{artifact}/kubernetes": route(
    "openBackupKubernetes",
    "Open scoped infrastructure backup Kubernetes relay",
    "callback",
  ),
  "POST /source-control": route(
    "checkNodeProofSourceControl",
    "Read the authorized node proof source-control nonce",
    "callback",
  ),
};
