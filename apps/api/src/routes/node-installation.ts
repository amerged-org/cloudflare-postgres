// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, OperationId, RegionId } from "@pgcf/contracts";
import {
  NodeInstallationProfile,
  NodeInstallationProfileStatus,
  NodeInstallationBindingRequest,
  NodeInstallationBindingStatus,
  NodeInstallationInspectionStatus,
  NodeInstallationInspectionRequest,
  NodeInspectionTransportRequest,
} from "@pgcf/contracts/node-installation";
import { NodeBootstrapTransport } from "@pgcf/contracts/node-bootstrap";
import { ApiError, type ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  storeNodeInstallationProfile,
  readNodeInstallationProfile,
  bindNodeInstallation,
  readNodeInstallationBinding,
  installationBindingStatus,
  authenticateNodeInstallationInspection,
  recordNodeInstallationInspection,
} from "../domain/node-installation.ts";
import {
  issueNodeInspectionTransport,
  relayNodeInspection,
} from "../domain/node-inspection.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const responses = (schema: z.ZodType, status = 200) => ({
  [status]: {
    description: "Protected installation configuration state",
    content: json(schema),
  },
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: {
    description: "Administrator or inspection authority required",
    content: json(ErrorBody),
  },
  404: { description: "Configuration unavailable", content: json(ErrorBody) },
  409: {
    description: "Configuration identity changed",
    content: json(ErrorBody),
  },
});
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
) {
  app.openapi(createRoute(route), handler);
}
export function registerNodeInstallation(app: ApiApp) {
  const region = { params: z.object({ id: RegionId }) },
    operation = { params: z.object({ id: OperationId }) },
    security = [{ bearerAuth: [] }];
  register(
    app,
    {
      method: "post",
      path: "/internal/v1/node-installation/{id}/transport",
      security,
      tags: ["Nodes"],
      request: { ...operation, body: body(NodeInspectionTransportRequest) },
      responses: responses(NodeBootstrapTransport),
    },
    async (c) => {
      const id = OperationId.parse(c.req.param("id"));
      await authenticateNodeInstallationInspection(c, id);
      const request = NodeInspectionTransportRequest.parse(await c.req.json());
      return c.json(
        await issueNodeInspectionTransport(
          c.env,
          id,
          request.expected_generation,
        ),
      );
    },
  );
  app.get("/internal/v1/node-installation/:id/relay", (c) =>
    relayNodeInspection(c, OperationId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/regions/{id}/installation-profile",
      security,
      tags: ["Nodes"],
      request: { ...region, body: body(NodeInstallationProfile) },
      responses: responses(NodeInstallationProfileStatus, 201),
    },
    async (c) => {
      await requireScope(c, "admin");
      return c.json(
        await storeNodeInstallationProfile(
          c.env,
          RegionId.parse(c.req.param("id")),
          NodeInstallationProfile.parse(await c.req.json()),
        ),
        201,
      );
    },
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/installation-profile",
      security,
      tags: ["Nodes"],
      request: region,
      responses: responses(NodeInstallationProfileStatus),
    },
    async (c) => {
      await requireScope(c, "admin");
      const id = RegionId.parse(c.req.param("id")),
        installed = await readNodeInstallationProfile(c.env, id);
      if (!installed)
        throw new ApiError("not_found", "Installation profile unavailable");
      return c.json({
        region_id: id,
        configured: true,
        profile_sha256: installed.profile_sha256,
      });
    },
  );
  // Repair/import path. Normal headless composition calls the same domain function inside AddNode.
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/installation-binding",
      security,
      tags: ["Nodes"],
      request: { ...operation, body: body(NodeInstallationBindingRequest) },
      responses: responses(NodeInstallationBindingStatus, 201),
    },
    async (c) => {
      await requireScope(c, "admin");
      const request = NodeInstallationBindingRequest.parse(await c.req.json());
      return c.json(
        await bindNodeInstallation(
          c.env,
          OperationId.parse(c.req.param("id")),
          request.expected_revision,
          request.firewall_id,
        ),
        201,
      );
    },
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions/{id}/installation-binding",
      security,
      tags: ["Nodes"],
      request: operation,
      responses: responses(NodeInstallationBindingStatus),
    },
    async (c) => {
      await requireScope(c, "admin");
      const row = await readNodeInstallationBinding(
        c.env.DB,
        OperationId.parse(c.req.param("id")),
      );
      if (!row)
        throw new ApiError("not_found", "Installation binding unavailable");
      return c.json(installationBindingStatus(row));
    },
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions/{id}/inspection",
      security,
      tags: ["Nodes"],
      request: operation,
      responses: responses(NodeInstallationInspectionStatus),
    },
    async (c) => {
      await requireScope(c, "admin");
      const id = OperationId.parse(c.req.param("id"));
      const binding = await c.env.DB.prepare(
        "SELECT 1 present FROM node_installation_bindings WHERE operation_id=?",
      )
        .bind(id)
        .first<{ present: number }>();
      if (!binding)
        throw new ApiError("not_found", "Installation binding unavailable");
      const status = await c.env.NODE_BOOTSTRAP.get(
        c.env.NODE_BOOTSTRAP.idFromName(id),
      ).inspectionStatus(id);
      return c.json(NodeInstallationInspectionStatus.parse(status));
    },
  );
  register(
    app,
    {
      method: "post",
      path: "/internal/v1/node-installation/{id}/inspection",
      security,
      tags: ["Nodes"],
      request: { ...operation, body: body(NodeInstallationInspectionRequest) },
      responses: responses(NodeInstallationBindingStatus, 202),
    },
    async (c) => {
      const id = OperationId.parse(c.req.param("id"));
      await authenticateNodeInstallationInspection(c, id);
      const request = NodeInstallationInspectionRequest.parse(
        await c.req.json(),
      );
      return c.json(
        await recordNodeInstallationInspection(
          c.env,
          id,
          request.expected_generation,
          request.inspection,
        ),
        202,
      );
    },
  );
}
