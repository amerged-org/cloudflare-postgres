// SPDX-License-Identifier: Apache-2.0
import {
  INSTALLER_PROGRESS_PATH,
  NODE_API_PATHS,
  NODE_FENCED_ERROR,
  NODE_FENCED_PATHS,
  NODE_REQUEST_TOKEN_PREFIX,
  nodeRequestSubject,
  verifyNodeRequest,
  type NodeFencedResponse,
} from "@pgcf/contracts";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../app.ts";
import type { ApiContext, ApiEnv } from "../env.ts";

/** The node a signed request came from, as D1 holds it. */
export interface NodeCaller {
  id: string;
  uid: string;
  region_id: string;
  /** Declared lost (plan 9.4): its key signs the desired page and its observations only. */
  fenced: boolean;
}
interface NodeKeyRow {
  id: string;
  node_uid: string;
  region_id: string;
  public_key: string;
  lost_at: string | null;
}

/**
 * Authenticates a request signed with a node's key (`pgcf_nr1`): the key is looked up by the
 * node and install the token claims, and the signature binds the request's method, its path with
 * the query and its body. The refusal never says which of them failed.
 */
export async function authenticateNode(c: ApiContext): Promise<NodeCaller> {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const subject = token.startsWith(`${NODE_REQUEST_TOKEN_PREFIX}.`)
    ? nodeRequestSubject(token)
    : null;
  const row =
    subject === null
      ? null
      : await c.env.DB.prepare(
          "SELECT id,node_uid,region_id,public_key,lost_at FROM nodes WHERE id=? AND node_uid=? AND public_key IS NOT NULL",
        )
          .bind(subject.node, subject.uid)
          .first<NodeKeyRow>();
  if (row === null)
    throw new ApiError("unauthorized", "Invalid node credentials");
  const url = new URL(c.req.url),
    body = c.get("body") ?? new Uint8Array();
  const verified = await verifyNodeRequest(token, {
    publicKey: row.public_key,
    node: row.id,
    uid: row.node_uid,
    method: c.req.method,
    path: url.pathname + url.search,
    body,
  });
  if (!verified.ok)
    throw new ApiError("unauthorized", "Invalid node credentials");
  return {
    id: row.id,
    uid: row.node_uid,
    region_id: row.region_id,
    fenced: row.lost_at !== null,
  };
}

/** The two paths a node calls without its key: the installer's report and the enrollment. */
const UNSIGNED_PATHS: ReadonlySet<string> = new Set([
  NODE_API_PATHS.enroll,
  INSTALLER_PROGRESS_PATH,
]);

/**
 * Authenticates every call a node makes with its key, before the request is read any further. A
 * fenced node reaches only the paths of `NODE_FENCED_PATHS`; every other request is answered
 * `403 {"error":"node_fenced"}`, which the agent takes as a fence.
 */
export const nodeAuthentication: MiddlewareHandler<ApiEnv> = async (
  c,
  next,
) => {
  const path = new URL(c.req.url).pathname;
  if (UNSIGNED_PATHS.has(path) || path === "/node/v1/openapi.json")
    return next();
  const node = await authenticateNode(c);
  if (node.fenced && !(NODE_FENCED_PATHS as readonly string[]).includes(path))
    return c.json(
      { error: NODE_FENCED_ERROR } satisfies NodeFencedResponse,
      403,
    );
  c.set("node", node);
  return next();
};

/** The node of an authenticated call. */
export const callingNode = (c: ApiContext): NodeCaller => c.get("node")!;
