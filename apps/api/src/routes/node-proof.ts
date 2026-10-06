// SPDX-License-Identifier: Apache-2.0
import {
  NodeProofNonce,
  NodeProofBinding,
  NodeProofReport,
} from "@pgcf/contracts/node-proof";
import {
  BootstrapCapability,
  NodeBootstrapMaintenanceObservation,
} from "@pgcf/contracts/node-bootstrap";
import { z } from "zod";
import { ApiError, type ApiApp } from "../app.ts";
import { nodeProofSourceControl } from "../domain/node-proof-session.ts";
import { authenticateNodeProofRequest } from "../domain/node-proof-session.ts";
import {
  issueNodeProofTransport,
  relayNodeProof,
  collectNodeProofAccess,
} from "../domain/node-proof-execution.ts";
import { acceptNodeProofReport } from "../domain/node-proof-artifacts.ts";
import { startAddNode } from "../platform/nodes.ts";
import { bearer } from "../middleware/auth.ts";

function proofBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid network proof request");
  return parsed.data;
}
export function registerNodeProof(app: ApiApp) {
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
