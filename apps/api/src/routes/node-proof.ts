// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import type { Next } from "hono";
import {
  NodeProofNonce,
  NodeProofBinding,
  NodeProofReport,
  NodeProofMode,
  NodeProofStatus,
  NodeProofJournalStatus,
  NodeProofSourceStatus,
} from "@pgcf/contracts/node-proof";
import { ErrorBody, OperationId } from "@pgcf/contracts";
import {
  BootstrapCapability,
  NodeBootstrapMaintenanceObservation,
} from "@pgcf/contracts/node-bootstrap";
import { ApiError, type ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { nodeProofSourceControl } from "../domain/node-proof-session.ts";
import { authenticateNodeProofRequest } from "../domain/node-proof-session.ts";
import {
  issueNodeProofTransport,
  relayNodeProof,
  collectNodeProofAccess,
} from "../domain/node-proof-execution.ts";
import { acceptNodeProofReport } from "../domain/node-proof-artifacts.ts";
import { startAddNode } from "../platform/nodes.ts";
import { bearer, requireScope } from "../middleware/auth.ts";

function proofBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid network proof request");
  return parsed.data;
}
export function registerNodeProof(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/nodes/additions/{id}/proof/source",
      security: [{ bearerAuth: [] }],
      tags: ["Nodes"],
      middleware: async (c: ApiContext, next: Next) => {
        await requireScope(c, "admin");
        await next();
      },
      request: { params: z.object({ id: OperationId }) },
      responses: {
        200: {
          description: "Read-only retained public proof source identity",
          content: { "application/json": { schema: NodeProofSourceStatus } },
        },
        400: {
          description: "Invalid request",
          content: { "application/json": { schema: ErrorBody } },
        },
        401: {
          description: "Invalid credentials",
          content: { "application/json": { schema: ErrorBody } },
        },
        403: {
          description:
            "Administrator scope or current proof authority required",
          content: { "application/json": { schema: ErrorBody } },
        },
        404: {
          description: "Installation binding or retained source unavailable",
          content: { "application/json": { schema: ErrorBody } },
        },
        409: {
          description: "Retained source identity is no longer current",
          content: { "application/json": { schema: ErrorBody } },
        },
        500: {
          description: "Invalid retained source response",
          content: { "application/json": { schema: ErrorBody } },
        },
      },
    }),
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
      const source = await c.env.NODE_BOOTSTRAP.get(
        c.env.NODE_BOOTSTRAP.idFromName(id),
      ).proofSourceStatus(id);
      return c.json(NodeProofSourceStatus.parse(source), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/nodes/additions/{id}/proof/preparation/journal",
      security: [{ bearerAuth: [] }],
      tags: ["Nodes"],
      middleware: async (c: ApiContext, next: Next) => {
        await requireScope(c, "admin");
        await next();
      },
      request: { params: z.object({ id: OperationId }) },
      responses: {
        200: {
          description: "Read-only preparation journal hashes and stages",
          content: { "application/json": { schema: NodeProofJournalStatus } },
        },
        400: {
          description: "Invalid request",
          content: { "application/json": { schema: ErrorBody } },
        },
        401: {
          description: "Invalid credentials",
          content: { "application/json": { schema: ErrorBody } },
        },
        403: {
          description: "Administrator scope required",
          content: { "application/json": { schema: ErrorBody } },
        },
        404: {
          description: "Installation binding unavailable",
          content: { "application/json": { schema: ErrorBody } },
        },
        500: {
          description: "Invalid journal response",
          content: { "application/json": { schema: ErrorBody } },
        },
      },
    }),
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
      ).proofJournalStatus(id);
      return c.json(NodeProofJournalStatus.parse(status), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/nodes/additions/{id}/proof/{mode}",
      security: [{ bearerAuth: [] }],
      tags: ["Nodes"],
      middleware: async (c: ApiContext, next: Next) => {
        await requireScope(c, "admin");
        await next();
      },
      request: { params: z.object({ id: OperationId, mode: NodeProofMode }) },
      responses: {
        200: {
          description: "Read-only proof status",
          content: { "application/json": { schema: NodeProofStatus } },
        },
        400: {
          description: "Invalid request",
          content: { "application/json": { schema: ErrorBody } },
        },
        401: {
          description: "Invalid credentials",
          content: { "application/json": { schema: ErrorBody } },
        },
        403: {
          description: "Administrator scope required",
          content: { "application/json": { schema: ErrorBody } },
        },
        404: {
          description: "Installation binding unavailable",
          content: { "application/json": { schema: ErrorBody } },
        },
        500: {
          description: "Invalid status response",
          content: { "application/json": { schema: ErrorBody } },
        },
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      const id = OperationId.parse(c.req.param("id")),
        mode = NodeProofMode.parse(c.req.param("mode"));
      const binding = await c.env.DB.prepare(
        "SELECT 1 present FROM node_installation_bindings WHERE operation_id=?",
      )
        .bind(id)
        .first<{ present: number }>();
      if (!binding)
        throw new ApiError("not_found", "Installation binding unavailable");
      const status = await c.env.NODE_BOOTSTRAP.get(
        c.env.NODE_BOOTSTRAP.idFromName(id),
      ).proofStatus(id, mode);
      return c.json(NodeProofStatus.parse(status), 200);
    },
  );
  app.post("/source-control", async (c) => {
    const body = NodeProofNonce.safeParse(await c.req.json());
    if (!body.success)
      throw new ApiError("invalid_request", "Invalid source-control nonce");
    return nodeProofSourceControl(c, body.data.nonce);
  });
  app.post("/internal/v1/node-proof/:id/transport", async (c) => {
    const id = c.req.param("id");
    await authenticateNodeProofRequest(c, id);
    const body = proofBody(
      z.strictObject({
        capability: BootstrapCapability,
        direction: z.enum(["target", "source"]),
      }),
      await c.req.json(),
    );
    return c.json(
      await issueNodeProofTransport(c, id, body.capability, body.direction),
    );
  });
  app.get("/internal/v1/node-proof/:id/relay", async (c) =>
    relayNodeProof(c, c.req.param("id")),
  );
  app.post("/internal/v1/node-proof/:id/access", async (c) => {
    const id = c.req.param("id");
    await authenticateNodeProofRequest(c, id);
    const body = proofBody(
      z.strictObject({
        binding: NodeProofBinding,
        maintenance_observation: NodeBootstrapMaintenanceObservation.optional(),
      }),
      await c.req.json(),
    );
    return c.json(await collectNodeProofAccess(c, id, body));
  });
  app.post("/internal/v1/node-proof/:id/report", async (c) => {
    const id = c.req.param("id");
    await authenticateNodeProofRequest(c, id);
    const result = await acceptNodeProofReport(
      c.env,
      bearer(c),
      proofBody(NodeProofReport, await c.req.json()),
    );
    if (result.operation_id !== id)
      throw new ApiError("forbidden", "Network proof operation differs");
    if (result.verified) c.executionCtx.waitUntil(startAddNode(c.env, id));
    return c.json(result);
  });
  app.post("/internal/v1/node-proof/:id/ownership", async (c) => {
    const id = c.req.param("id"),
      claims = await authenticateNodeProofRequest(c, id);
    const request = proofBody(
      z.strictObject({
        action: z.enum(["read", "save", "expired"]),
        kind: z.enum(["source", "postjoin"]),
        key: z.string().max(64).optional(),
        state: z.record(z.string(), z.unknown()).optional(),
        originalInput: z.record(z.string(), z.unknown()).optional(),
        publicSource: z.record(z.string(), z.unknown()).optional(),
      }),
      await c.req.json(),
    );
    const store = c.env.NODE_BOOTSTRAP.get(
      c.env.NODE_BOOTSTRAP.idFromName(id),
    ) as unknown as {
      proofOwnership(
        op: string,
        sess: string,
        input: typeof request,
      ): Promise<unknown>;
    };
    return c.json(await store.proofOwnership(id, claims.session_id, request));
  });
}
