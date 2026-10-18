// SPDX-License-Identifier: Apache-2.0
import {
  INSTALLER_PROGRESS_PATH,
  NODE_API_PATHS,
  NODE_FENCED_ERROR,
  NODE_FENCED_PATHS,
  NODE_REQUEST_TOKEN_PREFIX,
  RELEASE_FILE_PATH,
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
export interface NodeKeyRow {
  id: string;
  node_uid: string;
  region_id: string;
  public_key: string;
  /** Declared lost, whether or not the node is marked lost yet (1), else 0. */
  fenced: number;
}

/** The token of a signed request and the record of the node it claims to come from. */
export interface NodeClaim {
  token: string;
  row: NodeKeyRow;
}

/** The paths a node calls without its key: the installer's report and the enrollment. */
const UNSIGNED_PATHS: ReadonlySet<string> = new Set([
  NODE_API_PATHS.enroll,
  INSTALLER_PROGRESS_PATH,
]);
/**
 * The files of a release are read without a node key: the installer, which has no key yet, reads
 * the image with its install token, and the agent reads what its signed page pins.
 */
const isSigned = (path: string) =>
  !UNSIGNED_PATHS.has(path) &&
  path !== "/node/v1/openapi.json" &&
  !path.startsWith(`${RELEASE_FILE_PATH}/`);

/**
 * Looks up the node a signed request claims to come from, from the token in its headers alone.
 * It runs before the body is read, so a caller that is no node of ours costs the Worker no more
 * than this one read; the signature, which covers the body, is verified once the body is in.
 */
export const nodeLookup: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!isSigned(new URL(c.req.url).pathname)) return next();
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
          `SELECT id,node_uid,region_id,public_key,
            (lost_at IS NOT NULL OR EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=nodes.id)) fenced
           FROM nodes WHERE id=? AND node_uid=? AND public_key IS NOT NULL`,
        )
          .bind(subject.node, subject.uid)
          .first<NodeKeyRow>();
  // The refusal never says which of the token, the node or the key failed.
  if (row === null)
    throw new ApiError("unauthorized", "Invalid node credentials");
  c.set("nodeClaim", { token, row } satisfies NodeClaim);
  return next();
};

/**
 * Authenticates every call a node makes with its key (`pgcf_nr1`): the signature binds the
 * request's method, its path with the query and its body, and the key is the one `nodeLookup`
 * found for the node and install the token claims. A fenced node reaches only the paths of
 * `NODE_FENCED_PATHS`; every other request is answered `403 {"error":"node_fenced"}`, which the
 * agent takes as a fence.
 */
export const nodeAuthentication: MiddlewareHandler<ApiEnv> = async (
  c,
  next,
) => {
  const url = new URL(c.req.url);
  if (!isSigned(url.pathname)) return next();
  const claim = c.get("nodeClaim");
  if (claim === undefined)
    throw new ApiError("unauthorized", "Invalid node credentials");
  const { token, row } = claim;
  const verified = await verifyNodeRequest(token, {
    publicKey: row.public_key,
    node: row.id,
    uid: row.node_uid,
    method: c.req.method,
    path: url.pathname + url.search,
    body: c.get("body") ?? new Uint8Array(),
  });
  if (!verified.ok)
    throw new ApiError("unauthorized", "Invalid node credentials");
  const fenced = row.fenced === 1;
  if (
    fenced &&
    !(NODE_FENCED_PATHS as readonly string[]).includes(url.pathname)
  )
    return c.json(
      { error: NODE_FENCED_ERROR } satisfies NodeFencedResponse,
      403,
    );
  c.set("node", {
    id: row.id,
    uid: row.node_uid,
    region_id: row.region_id,
    fenced,
  } satisfies NodeCaller);
  return next();
};

/** The node of an authenticated call. */
export const callingNode = (c: ApiContext): NodeCaller => c.get("node")!;
