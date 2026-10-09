// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { NodeId } from "@pgcf/contracts";
import { NodeOperatorKubernetesQuery } from "@pgcf/contracts/node-operator";
import { ApiError, type ApiApp } from "../app.ts";
import { operatorKubernetes } from "../domain/node-operator.ts";

export function registerNodeOperator(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/nodes/{id}/operator/kubernetes",
      tags: ["Nodes"],
      security: [{ bearerAuth: [] }],
      description:
        "Administrator WebSocket to the current sealed Kubernetes endpoint. Cloudflare retains the relay capability; operator clients retain end-to-end mTLS and must check the actual cluster/node identities.",
      request: {
        params: z.object({ id: NodeId }),
        query: NodeOperatorKubernetesQuery,
      },
      responses: {
        101: {
          description:
            "Opaque Kubernetes mTLS stream with public expected Node/Cluster identity headers",
        },
      },
    }),
    async (c) => {
      const query = new URL(c.req.url).searchParams;
      if (
        [...query.keys()].some((key) => key !== "node_uid") ||
        query.getAll("node_uid").length !== 1
      )
        throw new ApiError(
          "invalid_request",
          "Exactly one expected node UID is required",
        );
      return operatorKubernetes(
        c,
        NodeId.parse(c.req.param("id")),
        c.req.valid("query").node_uid,
      );
    },
  );
}
