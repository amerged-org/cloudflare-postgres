// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  IdempotencyKey,
  NodeId,
  base64urlToBytes,
} from "@pgcf/contracts";
import {
  HostStorageLease,
  NodeThinStorageSelection,
  NodeThinStorageState,
} from "@pgcf/contracts/node-thin-storage";
import { ApiError, type ApiApp } from "../app.ts";
import {
  authenticateThinStorage,
  thinStorageInput,
  thinStorageStatus,
  dispatchThinPoolAction,
  recordThinStorageReport,
  issueThinStorageTransport,
} from "../domain/node-thin-storage-execution.ts";
import { NodeThinStorageReport } from "@pgcf/contracts/node-thin-storage";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  bootstrapRelayClaimsSchema,
} from "@pgcf/contracts/bootstrap-relay";
import { hostStorageLease } from "../domain/node-thin-storage.ts";
import {
  getNodeThinStorageProfile,
  selectNodeThinStorage,
} from "../domain/node-thin-storage-selection.ts";
export function registerNodeThinStorage(app: ApiApp) {
  for (const method of ["get", "put"] as const) {
    const profileRoute: RouteConfig = {
      method,
      path: "/v1/nodes/{id}/storage-profile",
      tags: ["Physical storage"],
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ id: NodeId }),
        ...(method === "put"
          ? {
              headers: z.object({
                "Idempotency-Key": IdempotencyKey.optional(),
              }),
              body: {
                required: true,
                content: {
                  "application/json": { schema: NodeThinStorageSelection },
                },
              },
            }
          : {}),
      },
      responses: {
        200: {
          description:
            "Current selected thin profile; selection does not prove physical readiness",
          content: { "application/json": { schema: NodeThinStorageState } },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 500].map((status) => [
            status,
            {
              description: "Request refused",
              content: { "application/json": { schema: ErrorBody } },
            },
          ]),
        ),
      },
    };
    app.openapi(createRoute(profileRoute), async (c) =>
      method === "get"
        ? getNodeThinStorageProfile(c, NodeId.parse(c.req.param("id")))
        : selectNodeThinStorage(
            c,
            NodeId.parse(c.req.param("id")),
            NodeThinStorageSelection.parse(await c.req.json()),
          ),
    );
  }
  app.openapi(
    createRoute({
      method: "get",
      path: "/agent/v1/nodes/{id}/storage-guard",
      tags: ["Physical storage"],
      security: [{ AgentBearer: [] }],
      request: { params: z.object({ id: NodeId }) },
      responses: {
        200: {
          description:
            "Current CF-owned host startup and signed runtime authority",
          content: { "application/json": { schema: HostStorageLease } },
        },
      },
    }),
    (c) => hostStorageLease(c, NodeId.parse(c.req.param("id"))),
  );
  app.post("/internal/v1/node-thin-storage/:id", async (c) => {
    const id = NodeId.parse(c.req.param("id"));
    await authenticateThinStorage(c, id);
    const body = z
      .object({ kind: z.string() })
      .loose()
      .parse(await c.req.json());
    if (body.kind === "status")
      return c.json(await thinStorageStatus(c.env, id), 200);
    if (body.kind === "transport")
      return c.json(
        await issueThinStorageTransport(
          c.env,
          id,
          z.enum(["talos_api", "kubernetes_api"]).parse(body.capability),
        ),
        200,
      );
    if (body.kind === "dispatch")
      return c.json(
        await dispatchThinPoolAction(
          c.env,
          id,
          z
            .string()
            .regex(/^op_[a-z0-9]{20}$/)
            .parse(body.nonce),
          z.uuid().parse(body.driver_pod_uid),
          z.uuid().parse(body.boot_id),
        ),
        200,
      );
    if (body.kind === "report")
      return c.json(
        await recordThinStorageReport(
          c.env,
          id,
          NodeThinStorageReport.parse(body.report),
        ),
        200,
      );
    throw new ApiError(
      "invalid_request",
      "Unsupported physical storage action",
    );
  });
  app.get("/internal/v1/node-thin-storage/:id/relay", async (c) => {
    const id = NodeId.parse(c.req.param("id")),
      row = await authenticateThinStorage(c, id),
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
        "Physical storage transport grant required",
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
        "Invalid physical storage transport grant",
      );
    }
    const input = await thinStorageInput(c.env, id),
      address =
        claims.capability === "talos_api"
          ? row.address
          : new URL(input.cluster_endpoint).hostname;
    if (
      claims.operation !== row.lease_id ||
      claims.node !== id ||
      claims.region !== row.region_id ||
      claims.revision !== row.lease_revision ||
      claims.capability === "rescue_ssh" ||
      claims.target.address !== address
    )
      throw new ApiError(
        "forbidden",
        "Physical storage transport scope changed",
      );
    return c.env.BOOTSTRAP_RELAY_SERVICE.fetch(
      new Request(new URL(BOOTSTRAP_RELAY_PATH, c.env.BOOTSTRAP_RELAY_URL), {
        headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
      }),
    );
  });
}
