// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  ListQuery,
  OperationId,
  RegionId,
  NodeId,
  NodeDiagnostic,
  NodeDiagnosticSummary,
  NodeProbeAccepted,
  NodeProbeDiagnostic,
  NodeProbeRequest,
  listEnvelope,
} from "@pgcf/contracts";
import {
  NodeAddition,
  NodeAdditionRequest,
  NodeMaintenance,
  NodeMaintenanceRequest,
  NodeMarkLost,
  NodeLoss,
} from "@pgcf/contracts/nodes";
import type { ApiContext } from "../env.ts";
import type { ApiApp } from "../app.ts";
import {
  getNodeDiagnostic,
  listNodeDiagnostics,
  requestNodeProbe,
} from "../domain/node-diagnostics.ts";
import {
  approvePurchase,
  capacityDecision,
  cancelNodeAddition,
  getCapacityPolicy,
  getNodeAddition,
  getNodeMaintenance,
  listNodeAdditions,
  NodeCapacityPolicy,
  NodePurchaseApproval,
  NodeRevision,
  requestNodeAddition,
  requestNodeMaintenance,
  setCapacityPolicy,
  markLostNode,
  NodeDatabasePlacement,
  setNodeDatabasePlacement,
} from "../platform/nodes.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: {
    description: "Administrator scope required",
    content: json(ErrorBody),
  },
  404: { description: "Resource unavailable", content: json(ErrorBody) },
  409: { description: "State or approval conflict", content: json(ErrorBody) },
  503: { description: "Capacity cap unavailable", content: json(ErrorBody) },
};
const responses = (
  schema: z.ZodType,
  status = 200,
  description = "Node state",
) => ({
  ...errors,
  [status]: { description, content: json(schema) },
});
const headers = z.object({
  "Idempotency-Key": z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,128}$/)
    .optional(),
});
const params = z.object({ id: OperationId }),
  regionParams = z.object({ id: RegionId });
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const security = [{ bearerAuth: [] }];
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
) {
  app.openapi(createRoute(route), handler);
}
export function registerNodes(app: ApiApp): void {
  register(
    app,
    {
      method: "put",
      path: "/v1/nodes/{id}/database-placement",
      security,
      tags: ["Nodes"],
      request: {
        params: z.object({ id: NodeId }),
        body: body(NodeDatabasePlacement),
      },
      responses: responses(
        NodeDatabasePlacement.safeExtend({ node_id: NodeId }),
      ),
    },
    async (c) =>
      setNodeDatabasePlacement(
        c,
        NodeId.parse(c.req.param("id")),
        NodeDatabasePlacement.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/{id}/mark-lost",
      security,
      tags: ["Nodes"],
      request: { params: z.object({ id: NodeId }), body: body(NodeMarkLost) },
      responses: responses(NodeLoss),
    },
    async (c) =>
      markLostNode(
        c,
        NodeId.parse(c.req.param("id")),
        NodeMarkLost.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/{id}/diagnostics",
      security,
      tags: ["Nodes"],
      summary: "List a node's boot reports",
      description:
        "The reports a node sent after each reboot, newest first, without their journal lines. expected_reboot is true when a maintenance order of the node was open when its last sample of the previous boot arrived, or closed after it, false when none was (the node_unexpected_reboot alert), and null when the agent knew no earlier boot. Reports are kept for 30 days. Administrator keys only: any other key is told 404.",
      request: { params: z.object({ id: NodeId }), query: ListQuery },
      responses: responses(
        listEnvelope(NodeDiagnosticSummary),
        200,
        "Boot reports",
      ),
    },
    async (c) => listNodeDiagnostics(c, NodeId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/{id}/diagnostics",
      security,
      tags: ["Nodes"],
      summary: "Ask a node for a read-only probe",
      description: [
        "The node has no shell. This asks its agent to read one thing and send it back: the probe is one of journal (the lines of the agent, the gateway, cloudflared, networkd, PID 1 and the kernel), kernel, boots (the boots the journal holds), failed_units, sockets (the socket units), listeners (the listening TCP, UDP and Unix sockets), pressure (kernel pressure, memory and load figures) and pool (the thin pool's fill). Each is a fixed command or a read of fixed files that the agent builds itself; there is no command, path or unit to give.",
        "boot is 0 (this boot, the default) or -1 (the one before) and lines is 1 to 2000 (default 200); they bound the journal and kernel probes. since_seconds is 60 to 86400 (default 3600) and bounds the journal probe only. The others ignore all three. The node caps its answer at 1 MiB, the API stores at most 64 KiB of it (the newest entries that fit, marked truncated; see GET), and it never holds a line of a database's unit or of a backup job. The node learns of the request within a pull of its desired page, which it is told to make now, runs it once and posts the result. The page lists at most eight open requests of a node at a time, the oldest first: later ones wait for an answer to make room, and expire after ten minutes if none does.",
        "202 with the id of the request. Read it with GET on the same path and that id: requested, received or expired. The key that asked is recorded. Only an admin key may ask: a read-only admin_read key is refused with 403, and any other key is told 404.",
      ].join("\n\n"),
      request: {
        params: z.object({ id: NodeId }),
        body: body(NodeProbeRequest),
      },
      responses: responses(NodeProbeAccepted, 202, "Probe requested"),
    },
    async (c) => requestNodeProbe(c, NodeId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/{id}/diagnostics/{diagnostic_id}",
      security,
      tags: ["Nodes"],
      summary: "Read a node's boot report or probe",
      description: [
        "A boot report (kind boot) holds the tail of the previous boot's journal: at most 1,000 lines of the agent, the gateway, cloudflared, networkd, PID 1 and the kernel, oldest first, each with its time, unit, program, transport, syslog priority and text (at most 2,048 bytes). An event line of the agent keeps only the fields an observation event may carry; lines of the databases' units and of backup jobs are never reported.",
        "A probe (kind probe, asked for with POST on the node's diagnostics) is requested until the node's result arrives, received once it has (body holds the result: journal and kernel answer with entries, every other probe with text, and status failed says the command ended with a status other than 0 or could not be run), and expired when ten minutes pass without one. A result is kept for 30 days.",
        "A node may send a report or result of up to 1 MiB, but a row is stored at most 64 KiB, measured as the INSERT statement that a backup of the control database writes for it (D1 cannot import a statement above 100,000 bytes). What is larger is cut: the oldest entries are dropped and the newest that fit are kept (a text keeps its beginning), and the report or result then says truncated true and dropped_entries, the number of entries dropped (0 when only the end of a text was cut). One that fits is stored whole and has neither field.",
        "Administrator keys only: any other key is told 404.",
      ].join("\n\n"),
      request: {
        params: z.object({ id: NodeId, diagnostic_id: z.uuid() }),
      },
      responses: responses(
        z.discriminatedUnion("kind", [NodeDiagnostic, NodeProbeDiagnostic]),
        200,
        "Boot report or probe",
      ),
    },
    async (c) =>
      getNodeDiagnostic(
        c,
        NodeId.parse(c.req.param("id")),
        z.uuid().parse(c.req.param("diagnostic_id")),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/{id}/maintenance",
      security,
      tags: ["Nodes"],
      summary: "Run the maintenance cycle on one node",
      description:
        "Closes placement on the node (unless it is closed already) and orders its maintenance cycle (ULTRA plan 9.3): the node holds new wakes with 57P03 and puts every awake database to sleep with the proof, installs exactly the packages that the release of its region pins, reboots if the kernel or core libraries changed, runs its check and reports. A cycle that is done reopens placement if this cycle closed it; a placement an operator closed stays closed, and so does placement after a failed cycle until the next cycle that is done or an operator opens it. Answers 202 with the operation; read it with GET /v1/nodes/{id}/maintenance/{operation}. While a cycle is open, every request answers that cycle. 409: expected_node_uid is not the node's physical identity, the node is lost or fenced, or the node does not run the release of its region yet (assign the release and wait until GET /v1/nodes/{id}/release says converged).",
      request: {
        headers,
        params: z.object({ id: NodeId }),
        body: body(NodeMaintenanceRequest),
      },
      responses: responses(NodeMaintenance, 202, "Maintenance cycle"),
    },
    async (c) =>
      requestNodeMaintenance(
        c,
        NodeId.parse(c.req.param("id")),
        NodeMaintenanceRequest.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/{id}/maintenance/{operation}",
      security,
      tags: ["Nodes"],
      summary: "Read a maintenance cycle of a node",
      description:
        "open until the node answers its order, then done or failed with the class of the failure in result_reason, and the times the cycle closed placement, started and ended.",
      request: { params: z.object({ id: NodeId, operation: OperationId }) },
      responses: responses(NodeMaintenance, 200, "Maintenance cycle"),
    },
    async (c) =>
      getNodeMaintenance(
        c,
        NodeId.parse(c.req.param("id")),
        OperationId.parse(c.req.param("operation")),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions",
      security,
      tags: ["Nodes"],
      request: { headers, body: body(NodeAdditionRequest) },
      responses: responses(NodeAddition, 202),
    },
    async (c) =>
      requestNodeAddition(c, NodeAdditionRequest.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions",
      security,
      tags: ["Nodes"],
      request: { query: ListQuery },
      responses: responses(listEnvelope(NodeAddition)),
    },
    listNodeAdditions,
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions/{id}",
      security,
      tags: ["Nodes"],
      request: { params },
      responses: responses(NodeAddition),
    },
    async (c) => getNodeAddition(c, OperationId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/approve",
      security,
      tags: ["Nodes"],
      request: { params, body: body(NodePurchaseApproval) },
      responses: responses(NodeAddition, 202),
    },
    async (c) =>
      approvePurchase(
        c,
        OperationId.parse(c.req.param("id")),
        NodePurchaseApproval.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/cancel",
      security,
      tags: ["Nodes"],
      request: { params, body: body(NodeRevision) },
      responses: responses(NodeAddition),
    },
    async (c) =>
      cancelNodeAddition(
        c,
        OperationId.parse(c.req.param("id")),
        NodeRevision.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/capacity-policy",
      security,
      tags: ["Nodes"],
      summary: "Read a region's capacity policy",
      description:
        "Returns the stored policy: node ceiling, purchase and autoscale switches, the per-database memory maximum and the infrastructure alert thresholds. Unset values are null or false, so the body can be edited and sent back with PUT. 404 until a policy has been created with PUT.",
      request: { params: regionParams },
      responses: responses(NodeCapacityPolicy, 200, "Stored capacity policy"),
    },
    async (c) => getCapacityPolicy(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/regions/{id}/capacity-policy",
      security,
      tags: ["Nodes"],
      summary: "Replace a region's capacity policy and alert thresholds",
      description: [
        "Replaces the policy and returns it as stored. Read it with GET, change fields and send the complete object back; region_id must equal the path id.",
        "Omitted fields with a default are reset to it: purchases_enabled, autoscale_enabled, adopt_instance_ids, order, maximum_database_memory_mib and standing_cost_profile. Omitted max_nodes, the three node_*_warning_threshold_ppm fields and cap_warning_enabled keep their stored values; send null (false for cap_warning_enabled) to clear them.",
        "Thresholds are integers in parts per million (ppm): 1000000 = 100 %, 800000 = 80 %, valid 1 to 1000000; null disables. A warning is active while its measured value is at or above the threshold. Unknown measurements neither start nor clear an episode; disabling a warning clears it. The minute cron evaluates the first four regions with a policy, in region ID order, and delivers each new episode at least once through the alert webhook or email (see PUT /v1/infrastructure-backups/config); GET /v1/operational-health?scope=regions shows each episode. Alert kinds without a threshold (node heartbeats, daily backups, a database's WAL archive and base backup, the thin pool and the cron heartbeat) are not part of this policy: they follow fixed rules in every region and are described there.",
        "400: invalid body, including purchases_enabled without order, a standing_cost_profile bound to another order, or a region_id that differs from the path. 404: unknown or non-Contabo region.",
      ].join("\n\n"),
      request: { params: regionParams, body: body(NodeCapacityPolicy) },
      responses: responses(
        NodeCapacityPolicy,
        200,
        "Capacity policy as stored after the update",
      ),
    },
    async (c) =>
      setCapacityPolicy(
        c,
        RegionId.parse(c.req.param("id")),
        NodeCapacityPolicy.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/capacity-decision",
      security,
      tags: ["Nodes"],
      summary: "Preview the capacity decision for a region",
      description:
        "Dry run of the minute capacity cron step for this region under its current capacity policy and measurements. Nothing is placed, reserved, approved or ordered, and no provider is called.",
      request: { params: regionParams },
      responses: responses(
        z.strictObject({
          region_id: RegionId,
          dry_run: z
            .literal(true)
            .describe("Always true: nothing was changed."),
          placed: z
            .number()
            .int()
            .nonnegative()
            .describe("Databases placed by this call; always 0 in a dry run."),
          action: z
            .string()
            .describe(
              "Next capacity step: unconfigured (no policy); idle (a node can take the smallest size class, and no database waits); waiting_for_approval or addition_in_progress (a held node addition, see operation_id); maintenance (an open maintenance cycle holds a node's placement closed; nothing is bought until it ends); observations_stale (a placement-enabled node has no sample within 180 s); size_policy_unavailable (the waiting database's size class is disabled, or its memory is above the region's per-database maximum); placement_pending (a node can take the waiting database now; the next run places it); disabled (autoscale_enabled is false); cap_reached (max_nodes reached); selection_unconfigured (no unused adopt_instance_ids entry and no order); adopt or order (the next cron run starts this kind of addition).",
            ),
          operation_id: OperationId.nullable().describe(
            "Held node addition for waiting_for_approval and addition_in_progress; otherwise null.",
          ),
        }),
        200,
        "Dry-run capacity decision",
      ),
    },
    (c) => capacityDecision(c, RegionId.parse(c.req.param("id"))),
  );
}
