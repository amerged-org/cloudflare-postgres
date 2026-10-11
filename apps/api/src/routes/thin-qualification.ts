// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  IdempotencyKey,
  NodeId,
  OperationId,
  base64urlToBytes,
} from "@pgcf/contracts";
import {
  ThinQualificationCheckpoint,
  ThinQualificationReport,
  ThinQualificationRequest,
  ThinQualificationRun,
} from "@pgcf/contracts/thin-qualification";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  bootstrapRelayClaimsSchema,
} from "@pgcf/contracts/bootstrap-relay";
import { ApiError, type ApiApp } from "../app.ts";
import {
  authenticateThinQualification,
  cancelThinQualification,
  getThinQualification,
  issueThinQualificationTransport,
  recordThinQualificationCheckpoint,
  recordThinQualificationReport,
  releaseThinQualificationTurn,
  resumeThinQualification,
  startThinQualification,
  thinQualificationInput,
  thinQualificationStatus,
} from "../domain/thin-qualification.ts";

const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((status) => [
    status,
    {
      description: "Request refused",
      content: { "application/json": { schema: ErrorBody } },
    },
  ]),
);
export function registerThinQualification(app: ApiApp) {
  // Idempotent creation returns its stored replay, so the handler keeps a plain Response.
  const start: RouteConfig = {
    method: "post",
    path: "/v1/nodes/{id}/thin-qualifications",
    tags: ["Physical storage"],
    security: [{ bearerAuth: [] }],
    description:
      "Starts one fenced scratch qualification of a complete thin profile on a current placement node. It creates and removes its own pool, LVs and namespace and never selects thin storage.",
    request: {
      params: z.object({ id: NodeId }),
      headers: z.object({ "Idempotency-Key": IdempotencyKey }),
      body: {
        required: true,
        content: {
          "application/json": { schema: ThinQualificationRequest },
        },
      },
    },
    responses: {
      202: {
        description: "Running qualification",
        content: { "application/json": { schema: ThinQualificationRun } },
      },
      ...errors,
    },
  };
  app.openapi(createRoute(start), async (c) =>
    startThinQualification(
      c,
      NodeId.parse(c.req.param("id")),
      ThinQualificationRequest.parse(await c.req.json()),
    ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/thin-qualifications/{id}",
      tags: ["Physical storage"],
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ id: OperationId }) },
      responses: {
        200: {
          description:
            "Measured gate evidence and decisions; a completed run includes its exact release receipt",
          content: { "application/json": { schema: ThinQualificationRun } },
        },
        ...errors,
      },
    }),
    async (c) => getThinQualification(c, OperationId.parse(c.req.param("id"))),
  );
  for (const [action, description, handler] of [
    [
      "resume",
      "Drives a running qualification again from its persisted step, for example after a lost Workflow start or a stopped instance. It never repeats an uncertain write or reopens an ended run.",
      resumeThinQualification,
    ],
    [
      "cancel",
      "Ends the measurements of a running qualification with thin_qualification_cancelled. Cleanup still runs; the run then fails without a receipt.",
      cancelThinQualification,
    ],
  ] as const)
    app.openapi(
      createRoute({
        method: "post",
        path: `/v1/thin-qualifications/{id}/${action}`,
        tags: ["Physical storage"],
        security: [{ bearerAuth: [] }],
        description,
        request: { params: z.object({ id: OperationId }) },
        responses: {
          200: {
            description: "Running qualification",
            content: { "application/json": { schema: ThinQualificationRun } },
          },
          ...errors,
        },
      }),
      async (c) => handler(c, OperationId.parse(c.req.param("id"))),
    );
  app.post("/internal/v1/thin-qualifications/:id", async (c) => {
    const id = OperationId.parse(c.req.param("id"));
    await authenticateThinQualification(c, id);
    const body = z
      .object({ kind: z.string() })
      .loose()
      .parse(await c.req.json());
    if (body.kind === "status")
      return c.json(await thinQualificationStatus(c.env, id), 200);
    if (body.kind === "transport")
      return c.json(
        await issueThinQualificationTransport(
          c.env,
          id,
          z.enum(["talos_api", "kubernetes_api"]).parse(body.capability),
        ),
        200,
      );
    if (body.kind === "checkpoint")
      return c.json(
        await recordThinQualificationCheckpoint(
          c.env,
          id,
          ThinQualificationCheckpoint.parse({
            expected_revision: body.expected_revision,
            entry: body.entry,
          }),
        ),
        200,
      );
    if (body.kind === "report")
      return c.json(
        await recordThinQualificationReport(
          c.env,
          id,
          ThinQualificationReport.parse(body.report),
        ),
        200,
      );
    if (body.kind === "release")
      return c.json(await releaseThinQualificationTurn(c.env, id), 200);
    throw new ApiError("invalid_request", "Unsupported qualification action");
  });
  app.get("/internal/v1/thin-qualifications/:id/relay", async (c) => {
    const id = OperationId.parse(c.req.param("id")),
      row = await authenticateThinQualification(c, id),
      token = c.req.header(BOOTSTRAP_RELAY_HEADER);
    if (
      c.req.header("Upgrade")?.toLowerCase() !== "websocket" ||
      !token ||
      token.length > BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH ||
      !/^br1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
      !c.env.BOOTSTRAP_RELAY_SERVICE
    )
      throw new ApiError(
        "unauthorized",
        "Thin qualification transport grant required",
      );
    let claims;
    try {
      claims = bootstrapRelayClaimsSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            base64urlToBytes(token.split(".")[1]!) ?? new Uint8Array(),
          ),
        ),
      );
    } catch {
      throw new ApiError(
        "unauthorized",
        "Invalid thin qualification transport grant",
      );
    }
    const input = await thinQualificationInput(c.env, id),
      address =
        claims.capability === "talos_api"
          ? row.address
          : new URL(input.cluster_endpoint).hostname;
    if (
      claims.operation !== row.lease_id ||
      claims.node !== row.node_id ||
      claims.region !== row.region_id ||
      claims.revision !== row.lease_revision ||
      claims.capability === "rescue_ssh" ||
      claims.target.address !== address
    )
      throw new ApiError(
        "forbidden",
        "Thin qualification transport scope changed",
      );
    return c.env.BOOTSTRAP_RELAY_SERVICE.fetch(
      new Request(new URL(BOOTSTRAP_RELAY_PATH, c.env.BOOTSTRAP_RELAY_URL), {
        headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
      }),
    );
  });
}
