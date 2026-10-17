// SPDX-License-Identifier: Apache-2.0
import type { ApiKey } from "@pgcf/contracts";
import type { Context } from "hono";
import type { CronWatchdog } from "./cron-watchdog.ts";

export type Env = Cloudflare.Env & {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  INFRASTRUCTURE_BACKUP?: Workflow<{ run_id: string }>;
  CRON_WATCHDOG?: DurableObjectNamespace<CronWatchdog>;
  INFRASTRUCTURE_BACKUP_CF_TOKEN?: string;
  RESEND_API_KEY?: string;
  /** The parent R2 key that signs the temporary credentials of the nodes (ULTRA plan 7.3). */
  R2_PARENT_ACCESS_KEY_ID?: string;
  R2_PARENT_SECRET_ACCESS_KEY?: string;
  /** Deletes the Tunnel of a node declared lost (ULTRA plan 9.4). */
  CLOUDFLARE_API_TOKEN?: string;
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
}

export interface ApiEnv {
  Bindings: Env;
  Variables: ApiVariables;
}

export type ApiContext = Context<ApiEnv>;
