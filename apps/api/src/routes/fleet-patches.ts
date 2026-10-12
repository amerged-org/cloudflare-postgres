// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { ApiContext } from "../env.ts";
import { NodeId, OperationId, base64urlToBytes } from "@pgcf/contracts";
import {
  FleetPatchCheckpoint,
  FleetPatchRequest,
  FleetPatchStatus,
} from "@pgcf/contracts/fleet-patches";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  bootstrapRelayClaimsSchema,
} from "@pgcf/contracts/bootstrap-relay";
import {
  RELAY_GRANT_BATCH_MAX,
  RelayGrantCount,
} from "@pgcf/contracts/node-bootstrap";
import { ApiError, type ApiApp } from "../app.ts";
import {
  authenticateFleetPatch,
  authenticateFleetPatchRow,
  assertFleetPatchAuthority,
  assertFleetPatchCurrent,
  createFleetPatch,
  fleetPatchInput,
  fleetPatchTransportTargets,
  getFleetPatch,
  haltFleetPatch,
  issueFleetPatchTransport,
  recordFleetPatchCheckpoint,
  resumeFleetPatch,
} from "../domain/fleet-patches.ts";
import { reconcileFleetPostgresRelease } from "../domain/fleet-postgres.ts";

export function registerFleetPatches(app: ApiApp) {
  const register = (
    route: RouteConfig,
    handler: (c: ApiContext) => Promise<Response>,
  ) => app.openapi(createRoute(route), handler);
  register(
    {
      method: "post",
      path: "/v1/nodes/{id}/patches",
      tags: ["Fleet patches"],
      security: [{ bearerAuth: [] }],
      description:
        "Starts a separate in-place OS, Kubernetes, platform and database release patch. Requires acknowledged maintenance. Host-ready members await regional activation before a separate idempotent final pass; installation jobs stay terminal.",
      request: {
        params: z.object({ id: NodeId }),
        body: {
          required: true,
          content: { "application/json": { schema: FleetPatchRequest } },
        },
      },
      responses: {
        202: {
          description: "Retained-node patch",
          content: { "application/json": { schema: FleetPatchStatus } },
        },
      },
    },
    async (c) =>
      createFleetPatch(
        c,
        NodeId.parse(c.req.param("id")),
        FleetPatchRequest.parse(await c.req.json()),
      ),
  );
  register(
    {
      method: "get",
      path: "/v1/fleet/patches/{operation_id}",
      tags: ["Fleet patches"],
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ operation_id: OperationId }) },
      responses: {
        200: {
          description:
            "Observed retained-node patch state; contains no private material",
          content: { "application/json": { schema: FleetPatchStatus } },
        },
      },
    },
    async (c) =>
      getFleetPatch(c, OperationId.parse(c.req.param("operation_id"))),
  );
  register(
    {
      method: "post",
      path: "/v1/fleet/patches/{operation_id}/resume",
      tags: ["Fleet patches"],
      security: [{ bearerAuth: [] }],
      description:
        "Renews this same operation's bounded maintenance deadline and resumes from its persisted dispatch state. Does not clear uncertain writes or authorize a replacement installation.",
      request: { params: z.object({ operation_id: OperationId }) },
      responses: {
        200: {
          description: "Resumed same retained-node operation",
          content: { "application/json": { schema: FleetPatchStatus } },
        },
      },
    },
    async (c) =>
      resumeFleetPatch(c, OperationId.parse(c.req.param("operation_id"))),
  );
  register(
    {
      method: "post",
      path: "/v1/fleet/patches/{operation_id}/halt",
      tags: ["Fleet patches"],
      security: [{ bearerAuth: [] }],
      description:
        "Permanently halts this operation with `operator_hold_superseded` while it is at the declarative Flux, platform or regional stage, where only idempotent Flux desired state is in flight and every OS, host and Kubernetes-version write has completed. Other stages are refused with 409. A racing executor checkpoint fails closed. The superseded operation never resumes and a repeated request returns it unchanged; `POST /v1/fleet/rollouts` with `expected_previous_rollout_id` then selects a successor release.",
      request: { params: z.object({ operation_id: OperationId }) },
      responses: {
        200: {
          description: "Superseded fleet patch operation",
          content: { "application/json": { schema: FleetPatchStatus } },
        },
      },
    },
    async (c) =>
      haltFleetPatch(c, OperationId.parse(c.req.param("operation_id"))),
  );
  app.post("/internal/v1/fleet-patches/:operation_id", async (c) => {
    const id = OperationId.parse(c.req.param("operation_id")),
      authenticated = await authenticateFleetPatchRow(c, id);
    const raw = (await c.req.json()) as {
      kind?: unknown;
      expected_compute_pool_revision?: unknown;
    };
    if (raw.kind === "transport") {
      const body = raw as {
          capability?: unknown;
          target?: unknown;
          count?: unknown;
        },
        count =
          body.count === undefined
            ? undefined
            : RelayGrantCount.safeParse(body.count);
      if (count && !count.success)
        throw new ApiError(
          "invalid_request",
          `Transport grant count must be 1-${RELAY_GRANT_BATCH_MAX}`,
        );
      const batch = await issueFleetPatchTransport(
        c.env,
        authenticated,
        z.enum(["talos_api", "kubernetes_api"]).parse(body.capability),
        z.enum(["node", "control"]).default("node").parse(body.target),
        count?.data ?? 1,
      );
      // An executor without `count` predates batches and strictly parses exactly one grant.
      return c.json(
        count
          ? batch
          : {
              websocket_url: batch.websocket_url,
              token: batch.tokens[0],
              expectedTarget: batch.expectedTarget,
            },
        200,
      );
    }
    await assertFleetPatchAuthority(c.env, authenticated);
    if (raw.kind === "postgres_rollout") {
      const row = await authenticateFleetPatch(c, id);
      if (row.stage !== "postgres")
        throw new ApiError(
          "conflict",
          "PostgreSQL release rollout is not current",
        );
      return c.json(
        await reconcileFleetPostgresRelease(
          c.env,
          row.region_id,
          row.release_id,
          id,
        ),
        200,
      );
    }
    if (raw.kind === "status") {
      const current = await fleetPatchInput(c.env, id);
      if (
        raw.expected_compute_pool_revision !== undefined &&
        z
          .number()
          .int()
          .positive()
          .parse(raw.expected_compute_pool_revision) !==
          current.compute_pool?.revision
      )
        throw new ApiError(
          "conflict",
          "Compute pool policy changed before fleet actuation",
        );
      if (
        raw.expected_compute_pool_revision !== undefined &&
        !current.regional_hosts_ready
      )
        throw new ApiError(
          "conflict",
          "Regional hosts are not qualified for runtime activation",
        );
      return c.json(
        raw.expected_compute_pool_revision !== undefined
          ? {
              ...current.status,
              compute_pool_observation:
                current.compute_pool_observation ?? null,
            }
          : current.status,
        200,
      );
    }
    if (raw.kind === "checkpoint") {
      const value = { ...raw };
      delete value.kind;
      return c.json(
        await recordFleetPatchCheckpoint(
          c.env,
          id,
          FleetPatchCheckpoint.parse(value),
        ),
        200,
      );
    }
    throw new ApiError("invalid_request", "Unsupported fleet patch action");
  });
  app.get("/internal/v1/fleet-patches/:operation_id/relay", async (c) => {
    const id = OperationId.parse(c.req.param("operation_id")),
      row = await authenticateFleetPatchRow(c, id),
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
        "Fleet patch transport grant required",
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
      throw new ApiError("unauthorized", "Invalid fleet patch transport grant");
    }
    const targets = await fleetPatchTransportTargets(c.env, row),
      addresses =
        claims.capability === "talos_api"
          ? [
              targets.node,
              ...(row.stage === "kubernetes" ? [targets.cluster] : []),
            ]
          : [targets.cluster];
    if (
      claims.operation !== id ||
      claims.node !== row.node_id ||
      claims.region !== row.region_id ||
      claims.revision !== row.assignment_revision ||
      claims.capability === "rescue_ssh" ||
      !addresses.includes(claims.target.address)
    )
      throw new ApiError("forbidden", "Fleet patch transport scope changed");
    // The regional relay verifies the signature, expiry, nonce, target and relay epoch.
    await assertFleetPatchCurrent(c.env, row);
    const response = await c.env.BOOTSTRAP_RELAY_SERVICE.fetch(
      new Request(new URL(BOOTSTRAP_RELAY_PATH, c.env.BOOTSTRAP_RELAY_URL), {
        headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
      }),
    );
    try {
      await assertFleetPatchCurrent(c.env, row);
    } catch (error) {
      try {
        response.webSocket?.accept();
        response.webSocket?.close(1008, "authority_changed");
      } catch {
        /* The upstream may already have closed. */
      }
      throw error;
    }
    return response;
  });
}
