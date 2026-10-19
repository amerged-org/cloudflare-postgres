// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ARCHIVE_CREDENTIAL_ID_PATTERN,
  ArchiveCredential,
  ErrorBody,
  InstallerProgress,
  NODE_API_PATHS,
  INSTALLER_PROGRESS_PATH,
  NodeBootReport,
  NodeCredentials,
  NodeDesiredPage,
  NodeDesiredQuery,
  NodeEnrollmentRequest,
  NodeEnrollmentResponse,
  NodeEventReport,
  NodeFencedResponse,
  NodeObservationReport,
  NodePolicy,
  NodeProbeResult,
  NodeUsageReport,
  NodeVolumeReport,
  RegionId,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { archiveCredentialResponse } from "../domain/archive-credentials.ts";
import { callingNode, nodeAuthentication } from "../domain/node-auth.ts";
import { nodeCredentials } from "../domain/node-credentials.ts";
import { desiredResponse } from "../domain/node-desired.ts";
import { nodeDiagnosticUpload } from "../domain/node-diagnostics.ts";
import { enrollNode, recordInstallerProgress } from "../domain/node-install.ts";
import { nodeEvents, nodeUsage, nodeVolumes } from "../domain/node-intake.ts";
import { nodeObservations } from "../domain/node-observations.ts";
import { getNodePolicy, setNodePolicy } from "../domain/node-policy.ts";
import { NODE_HEADER, NODE_UID_HEADER } from "../node-actor.ts";
import { nodeActor } from "../domain/node-hints.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((status) => [
    status,
    { description: "Request failed", content: json(ErrorBody) },
  ]),
);
const fenced = {
  403: {
    description:
      "The node was declared lost: its key signs the desired page and its observations only",
    content: json(NodeFencedResponse),
  },
};
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const responses = (schema: z.ZodType) => ({
  ...errors,
  200: { description: "Successful response", content: json(schema) },
});
const nodeResponses = (schema: z.ZodType) => ({
  ...responses(schema),
  ...fenced,
});
const verdicts = z.enum(["accept", "stale", "conflict"]);
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}
const tags = ["Node"];
const node = [{ NodeBearer: [] }];

export function registerNodeLink(app: ApiApp): void {
  app.use("/node/v1/*", nodeAuthentication);
  app.openAPIRegistry.registerComponent("securitySchemes", "NodeBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "NodeRequest",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "EnrollmentBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "InstallerProgress",
  });
  register(
    app,
    {
      method: "post",
      path: NODE_API_PATHS.enroll,
      tags,
      description:
        "Exchanges the installer's one-time enrollment token and the node's Ed25519 public key for the node's identity. The token is burnt by the first enrollment; the same token with the same key answers the same identity.",
      request: { body: body(NodeEnrollmentRequest) },
      responses: responses(NodeEnrollmentResponse),
    },
    async (c) => enrollNode(c, await c.req.json()),
  );
  register(
    app,
    {
      method: "post",
      path: INSTALLER_PROGRESS_PATH,
      tags,
      security: [{ EnrollmentBearer: [] }],
      request: { body: body(InstallerProgress) },
      responses: responses(z.strictObject({ accepted: z.literal(true) })),
    },
    async (c) => recordInstallerProgress(c, await c.req.json()),
  );
  register(
    app,
    {
      method: "get",
      path: NODE_API_PATHS.link,
      tags,
      security: node,
      responses: {
        ...errors,
        ...fenced,
        101: { description: "The node's WebSocket link" },
      },
    },
    async (c) => {
      const caller = callingNode(c);
      return nodeActor(c.env, caller.id).fetch(
        new Request(c.req.raw.url, {
          headers: {
            Upgrade: c.req.header("Upgrade") ?? "",
            [NODE_HEADER]: caller.id,
            [NODE_UID_HEADER]: caller.uid,
          },
        }),
      );
    },
  );
  register(
    app,
    {
      method: "get",
      path: NODE_API_PATHS.desired,
      tags,
      security: node,
      request: { query: NodeDesiredQuery },
      responses: nodeResponses(NodeDesiredPage),
    },
    async (c) =>
      desiredResponse(c, callingNode(c), NodeDesiredQuery.parse(c.req.query())),
  );
  register(
    app,
    {
      method: "get",
      path: NODE_API_PATHS.credentials,
      tags,
      security: node,
      description:
        "Reads what the node's gateway and its Tunnel need: the route keyring derived for this node and the token of its Tunnel, which is made, with its hostnames, at the first read. The secrets are in the body only and the response is never cached. The node reads it when its desired page names a newer revision than the one it applied.",
      responses: nodeResponses(NodeCredentials),
    },
    async (c) => nodeCredentials(c, callingNode(c)),
  );
  register(
    app,
    {
      method: "get",
      path: `${NODE_API_PATHS.archiveCredentials}{id}`,
      tags,
      security: node,
      description:
        "Reads the temporary R2 credential the node's desired page names, signed now. A credential that is not the node's, has expired or is withheld from a node declared lost is not found. The secret is in the body only and the response is never cached.",
      request: {
        params: z.object({
          id: z.string().regex(ARCHIVE_CREDENTIAL_ID_PATTERN),
        }),
      },
      responses: nodeResponses(ArchiveCredential),
    },
    async (c) => archiveCredentialResponse(c, callingNode(c).id),
  );
  register(
    app,
    {
      method: "post",
      path: NODE_API_PATHS.observations,
      tags,
      security: node,
      request: { body: body(NodeObservationReport) },
      responses: nodeResponses(
        z.strictObject({
          databases: z.array(
            z.strictObject({ id: z.string(), verdict: verdicts }),
          ),
          orders: z.number().int().nonnegative(),
        }),
      ),
    },
    async (c) => nodeObservations(c, callingNode(c), await c.req.json()),
  );
  register(
    app,
    {
      method: "post",
      path: NODE_API_PATHS.volumes,
      tags,
      security: node,
      request: { body: body(NodeVolumeReport) },
      responses: nodeResponses(
        z.strictObject({ accepted: z.number().int().nonnegative() }),
      ),
    },
    async (c) => nodeVolumes(c, callingNode(c), await c.req.json()),
  );
  register(
    app,
    {
      method: "post",
      path: NODE_API_PATHS.events,
      tags,
      security: node,
      request: { body: body(NodeEventReport) },
      responses: nodeResponses(
        z.strictObject({
          accepted: z.number().int().nonnegative(),
          duplicates: z.number().int().nonnegative(),
        }),
      ),
    },
    async (c) => nodeEvents(c, callingNode(c), await c.req.json()),
  );
  register(
    app,
    {
      method: "post",
      path: NODE_API_PATHS.usage,
      tags,
      security: node,
      request: { body: body(NodeUsageReport) },
      responses: nodeResponses(
        z.strictObject({
          recorded: z.number().int().nonnegative(),
          duplicates: z.number().int().nonnegative(),
          refused: z.number().int().nonnegative(),
        }),
      ),
    },
    async (c) => nodeUsage(c, callingNode(c), await c.req.json()),
  );
  register(
    app,
    {
      method: "post",
      path: NODE_API_PATHS.diagnostics,
      tags,
      security: node,
      description:
        "Either the tail of the previous boot's journal, sent once after a reboot, or, with kind probe, the answer to a probe an administrator asked the node for. The boot report carries at most 1,000 lines of the agent, the gateway, cloudflared, networkd, PID 1 and the kernel, and is at most 1 MiB. expected_reboot is true when a maintenance order of the node was open when its last sample of the previous boot arrived, or closed after it; when it is false the minute cron raises node_unexpected_reboot; it is null when the agent knew no earlier boot. A boot report that arrives before the hello of its boot is stored is refused with 503 (capacity_exhausted, reason not_ready) and a Retry-After, and the agent sends it again. A probe result is at most 1 MiB and answers one request of the node's desired page, once: a request that is not the node's is not found, and a second answer changes nothing. It is answered with the request's id alone.",
      request: { body: body(z.union([NodeBootReport, NodeProbeResult])) },
      responses: nodeResponses(
        z.union([
          z.strictObject({
            id: z.uuid(),
            expected_reboot: z.boolean().nullable(),
          }),
          z.strictObject({ id: z.uuid() }),
        ]),
      ),
    },
    async (c) => nodeDiagnosticUpload(c, callingNode(c), await c.req.json()),
  );
  const security = [{ bearerAuth: [] }];
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/node-policy",
      tags: ["Regions"],
      security,
      request: { params: z.object({ id: RegionId }) },
      responses: responses(NodePolicy),
    },
    async (c) => getNodePolicy(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/regions/{id}/node-policy",
      tags: ["Regions"],
      security,
      description:
        "Sets the rules the region's nodes decide by when they act alone. Every node's desired page carries them.",
      request: { params: z.object({ id: RegionId }), body: body(NodePolicy) },
      responses: responses(NodePolicy),
    },
    async (c) =>
      setNodePolicy(
        c,
        RegionId.parse(c.req.param("id")),
        NodePolicy.parse(await c.req.json()),
      ),
  );
}
