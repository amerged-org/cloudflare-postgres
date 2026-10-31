// SPDX-License-Identifier: Apache-2.0
import type { ApiKey } from "@pgcf/contracts";
import type { Context } from "hono";
import type { ActorWarmer } from "./actor-warmer.ts";
import type { CronWatchdog } from "./cron-watchdog.ts";
import type { NodeCaller, NodeClaim } from "./domain/node-auth.ts";

export type Env = Cloudflare.Env & {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  INFRASTRUCTURE_BACKUP?: Workflow<{ run_id: string }>;
  CRON_WATCHDOG?: DurableObjectNamespace<CronWatchdog>;
  /** Keeps the DatabaseActors warm (`actor-warmer.ts`); needed while the interval below is not 0. */
  ACTOR_WARMER?: DurableObjectNamespace<ActorWarmer>;
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
  /** JSON array of qualified signed native release IDs supporting MiB storage and membership flags. */
  NATIVE_EXTENDED_RESOURCES_RELEASE_IDS?: string;
  /** "on" quiesces the control plane for a schema cutover; existing native SQL sessions continue. */
  CONTROL_PLANE_MAINTENANCE?: string;
  /**
   * The DNS zone that holds the hostnames of the nodes' gateways (and of their shells, see NODE_SHELL_HOSTNAME),
   * and its domain. CLOUDFLARE_API_TOKEN needs Zone: DNS: Edit on it: fencing a lost node deletes its records there.
   */
  NODE_GATEWAY_ZONE_ID?: string;
  NODE_GATEWAY_DOMAIN?: string;
  /**
   * "true" gives every node a shell hostname (`pgcf-shell-<id>.<domain>`, with its DNS record and
   * Tunnel ingress rule); any other value, or none, gives none and removes the one a node has. Leave
   * it off until Cloudflare Access guards the shell (`scripts/operations/setup-access.ts --shell`,
   * ULTRA plan 8): without Access the hostname is reachable by anyone who can run cloudflared.
   */
  NODE_SHELL_HOSTNAME?: string;
  /**
   * The public key of the CA that signs the operator shell's user certificates: exactly one
   * `ssh-ed25519 AAAA...` line, without comment or options. The operator holds the private key;
   * the Worker never sees it. Nodes get this key only while NODE_SHELL_HOSTNAME is "true", and
   * not at all when the line is not valid, so a mistake leaves the shell without a login.
   */
  NODE_SSH_USER_CA_PUBLIC_KEY?: string;
  DATABASE_CONNECTION_LIMIT_PER_MINUTE?: string;
  DATABASE_ACTOR_LOCATION_HINT?: string;
  /**
   * Durable Object location hint for new ActorWarmer objects when DATABASE_ACTOR_LOCATION_HINT is
   * not set: where the DatabaseActors live (`weur` for Dev), so that a visit does not cross an
   * ocean. It places only a new object; `ACTOR_WARMER_NAME_VERSION` makes new ones.
   */
  ACTOR_WARMER_LOCATION_HINT?: string;
  /**
   * Milliseconds between two visits of each DatabaseActor, which keep its isolate loaded: unset is
   * 8000, 0 turns the keep-warm off, any other value is 1000 to 300000 (`domain/actor-warm.ts`).
   */
  DATABASE_ACTOR_WARM_INTERVAL_MS?: string;
  /** The Edge Worker, through which a schedule's statements run as a request to `/sql` (`domain/schedule-job.ts`). */
  EDGE?: Fetcher;
  INFRASTRUCTURE_ALERT_WEBHOOK?: Fetcher;
  INFRASTRUCTURE_ALERT_WEBHOOK_URL?: string;
  INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN?: string;
  /**
   * The Contabo firewall every node sits behind: active, no inbound rule that accepts, created
   * once by the operator (docs/operations/operator-installation.md). AddNode assigns an instance
   * it does not list and sends no rescue until it does.
   */
  CONTABO_NODE_FIREWALL_ID: string;
  CONTABO_ORDER_DEFAULT_USER: string;
  CONTABO_ORDER_SSH_KEY_IDS: string;
};
export type AuthPrincipal = Pick<ApiKey, "id" | "scope" | "project_id">;

export interface ApiVariables {
  requestId: string;
  /** The class of an unexpected failure, set by the error handler for the request's one failure line. */
  failureCause?: string;
  auth?: AuthPrincipal;
  /** The audit row written before an administrator key's change ran; `recordAuditOutcome` completes it. */
  auditEventId?: string;
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
