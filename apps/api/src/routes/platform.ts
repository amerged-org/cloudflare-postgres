// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyId,
  ErrorBody,
  ListQuery,
  Node,
  Project,
  ProjectCreate,
  ProjectId,
  Region,
  RegionCreate,
  RegionCreated,
  RegionId,
  RegionBootstrapMaterialUpdate,
  RegionBootstrapMaterialStatus,
  SizeClass,
  SizeClassId,
  SizeClassUpsert,
  listEnvelope,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  RegionMaterialRotationStage,
  RegionMaterialRotationActivate,
  RegionMaterialRotationStaged,
} from "@pgcf/contracts/region-material-rotation";
import {
  stageRegionBootstrapRotation,
  activateRegionBootstrapRotation,
} from "../domain/region-material-revisions.ts";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
} from "../platform/api-keys.ts";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
} from "../platform/projects.ts";
import {
  createRegion,
  listNodes,
  listRegions,
  getRegionBootstrapMaterial,
  updateRegionBootstrapMaterial,
} from "../platform/regions.ts";
import { listSizeClasses, upsertSizeClass } from "../platform/size-classes.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: {
    description: "Missing or invalid credentials",
    content: json(ErrorBody),
  },
  403: { description: "Insufficient scope", content: json(ErrorBody) },
  404: { description: "Resource not found", content: json(ErrorBody) },
  409: {
    description: "Conflict or idempotency request in progress",
    content: json(ErrorBody),
  },
  500: { description: "Internal server error", content: json(ErrorBody) },
};
const security = [{ bearerAuth: [] }];
const headers = z.object({
  "Idempotency-Key": z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,128}$/)
    .optional(),
});
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const response = (schema: z.ZodType, status: 200 | 201) => ({
  ...errors,
  [status]: {
    description: status === 201 ? "Created" : "Successful response",
    content: json(schema),
  },
});
const noContent = { ...errors, 204: { description: "Deleted or revoked" } };
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

export function registerPlatform(app: ApiApp): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });
  register(
    app,
    {
      method: "post",
      path: "/v1/api-keys",
      security,
      tags: ["API keys"],
      description:
        "Creates a key. The bootstrap token creates the first admin key exactly once. Credentials are returned once; successful idempotency replays return a safe conflict.",
      request: { headers, body: body(ApiKeyCreate) },
      responses: response(ApiKeyCreated, 201),
    },
    async (c) => createApiKey(c, ApiKeyCreate.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/api-keys",
      security,
      tags: ["API keys"],
      request: { query: ListQuery },
      responses: response(listEnvelope(ApiKey), 200),
    },
    listApiKeys,
  );
  register(
    app,
    {
      method: "delete",
      path: "/v1/api-keys/{id}",
      security,
      tags: ["API keys"],
      request: { headers, params: z.object({ id: ApiKeyId }) },
      responses: noContent,
    },
    async (c) => deleteApiKey(c, ApiKeyId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/projects",
      security,
      tags: ["Projects"],
      request: { headers, body: body(ProjectCreate) },
      responses: response(Project, 201),
    },
    async (c) => createProject(c, ProjectCreate.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/projects",
      security,
      tags: ["Projects"],
      request: { query: ListQuery },
      responses: response(listEnvelope(Project), 200),
    },
    listProjects,
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/projects/{id}",
      security,
      tags: ["Projects"],
      request: { params: z.object({ id: ProjectId }) },
      responses: response(Project, 200),
    },
    async (c) => getProject(c, ProjectId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "delete",
      path: "/v1/projects/{id}",
      security,
      tags: ["Projects"],
      request: { headers, params: z.object({ id: ProjectId }) },
      responses: noContent,
    },
    async (c) => deleteProject(c, ProjectId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/size-classes",
      security,
      tags: ["Size classes"],
      request: { query: ListQuery },
      responses: response(listEnvelope(SizeClass), 200),
    },
    listSizeClasses,
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/size-classes/{id}",
      security,
      tags: ["Size classes"],
      request: {
        headers,
        params: z.object({ id: SizeClassId }),
        body: body(SizeClassUpsert),
      },
      responses: response(SizeClass, 200),
    },
    async (c) =>
      upsertSizeClass(
        c,
        SizeClassId.parse(c.req.param("id")),
        SizeClassUpsert.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/regions",
      security,
      tags: ["Regions"],
      request: { headers, body: body(RegionCreate) },
      responses: response(RegionCreated, 201),
    },
    async (c) => createRegion(c, RegionCreate.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions",
      security,
      tags: ["Regions"],
      request: { query: ListQuery },
      responses: response(listEnvelope(Region), 200),
    },
    listRegions,
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/bootstrap-material",
      security,
      tags: ["Regions"],
      request: { params: z.object({ id: RegionId }) },
      responses: response(RegionBootstrapMaterialStatus, 200),
    },
    async (c) =>
      getRegionBootstrapMaterial(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/regions/{id}/bootstrap-material",
      security,
      tags: ["Regions"],
      description:
        "Synchronizes only Kubernetes version metadata after independently verified administrator readback; immutable credentials and historical references remain unchanged.",
      request: {
        params: z.object({ id: RegionId }),
        body: body(RegionBootstrapMaterialUpdate),
      },
      responses: response(RegionBootstrapMaterialStatus, 200),
    },
    async (c) =>
      updateRegionBootstrapMaterial(
        c,
        RegionId.parse(c.req.param("id")),
        RegionBootstrapMaterialUpdate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/regions/{id}/bootstrap-material/stage",
      security,
      tags: ["Regions"],
      description:
        "Stages private complete matching next-revision cluster custody. Does not activate it, execute rotation or authorize bootstrap.",
      request: {
        headers,
        params: z.object({ id: RegionId }),
        body: body(RegionMaterialRotationStage),
      },
      responses: response(RegionMaterialRotationStaged, 200),
    },
    async (c) =>
      stageRegionBootstrapRotation(
        c,
        RegionId.parse(c.req.param("id")),
        RegionMaterialRotationStage.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/regions/{id}/bootstrap-material/activate",
      security,
      tags: ["Regions"],
      description:
        "Activates exact staged custody after fresh complete trusted-admin or reviewed Native readback and explicit retired-authority evidence. This is a trusted administrator boundary, not cryptographic attestation or physical rotation.",
      request: {
        headers,
        params: z.object({ id: RegionId }),
        body: body(RegionMaterialRotationActivate),
      },
      responses: response(RegionBootstrapMaterialStatus, 200),
    },
    async (c) =>
      activateRegionBootstrapRotation(
        c,
        RegionId.parse(c.req.param("id")),
        RegionMaterialRotationActivate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes",
      security,
      tags: ["Nodes"],
      request: { query: ListQuery },
      responses: response(listEnvelope(Node), 200),
    },
    listNodes,
  );
}
