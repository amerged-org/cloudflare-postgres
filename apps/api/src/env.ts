// SPDX-License-Identifier: Apache-2.0
import type { ApiKey } from "@pgcf/contracts";
import type { Context } from "hono";
import type { CronWatchdog } from "./cron-watchdog.ts";
import type { NodeCaller, NodeClaim } from "./domain/node-auth.ts";

export type Env = Cloudflare.Env & {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  INFRASTRUCTURE_BACKUP?: Workflow<{ run_id: string }>;
  CRON_WATCHDOG?: DurableObjectNamespace<CronWatchdog>;
  INFRASTRUCTURE_BACKUP_CF_TOKEN?: string;
  RESEND_API_KEY?: string;
  /** The parent R2 key that signs the temporary credentials of the nodes (ULTRA plan 7.3). */
  R2_PARENT_ACCESS_KEY_ID?: string;
  R2_PARENT_SECRET_ACCESS_KEY?: string;
  /** Makes the Tunnel and the DNS records of a node and deletes the Tunnel of a node declared lost (ULTRA plan 5.8, 9.4). */
  CLOUDFLARE_API_TOKEN?: string;
  /** The API's origin, which a node's installer enrolls at, and the resolvers it configures (a JSON array). */
  NODE_API_ORIGIN?: string;
  NODE_DNS_SERVERS?: string;
  /** The DNS zone that holds the hostnames of the nodes' gateways (and of their shells, see NODE_SHELL_HOSTNAME), and its domain. */
  NODE_GATEWAY_ZONE_ID?: string;
  NODE_GATEWAY_DOMAIN?: string;
  /**
   * "true" gives every node a shell hostname (`<node>-ssh.<domain>`, with its DNS record and Tunnel
   * ingress rule); any other value, or none, gives none and removes the one a node has. Leave it
   * off until Cloudflare Access guards the shell (ULTRA plan 8): without Access the hostname is
   * reachable by anyone who can run cloudflared.
   */
  NODE_SHELL_HOSTNAME?: string;
  DATABASE_CONNECTION_LIMIT_PER_MINUTE?: string;
  DATABASE_ACTOR_LOCATION_HINT?: string;
  INFRASTRUCTURE_ALERT_WEBHOOK?: Fetcher;
  INFRASTRUCTURE_ALERT_WEBHOOK_URL?: string;
  INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN?: string;
  ARCHIVE_BINDINGS?: string;
  ARCHIVE_EU?: R2Bucket;
  ARCHIVE_US?: R2Bucket;
  BOOTSTRAP_FIREWALL_BINDINGS: string;
  CONTABO_ORDER_DEFAULT_USER: string;
  CONTABO_ORDER_SSH_KEY_IDS: string;
};
export type AuthPrincipal = Pick<ApiKey, "id" | "scope" | "project_id">;

export interface ApiVariables {
  requestId: string;
  /** The class of an unexpected failure, set by the error handler for the request's one failure line. */
  failureCause?: string;
  auth?: AuthPrincipal;
  /** The record of the node a signed call claims to come from, found before its body is read. */
  nodeClaim?: NodeClaim;
  /** The node of a call signed with its key. */
  node?: NodeCaller;
  /** The bytes of the request body as they arrived; a node's signature covers them. */
  body?: Uint8Array;
}

export interface ApiEnv {
  Bindings: Env;
  Variables: ApiVariables;
}

export type ApiContext = Context<ApiEnv>;
