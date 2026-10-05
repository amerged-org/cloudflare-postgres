// SPDX-License-Identifier: Apache-2.0
import type { ApiKey } from "@pgcf/contracts";
import type { Context } from "hono";

export type Env = Cloudflare.Env & {
  DATABASE_CONNECTION_LIMIT_PER_MINUTE?: string;
  ARCHIVE_BINDINGS?: string;
  [binding: `ARCHIVE_${string}`]: R2Bucket | string | undefined;
  NODE_BOOTSTRAP_CALLBACK_URL: string;
  BOOTSTRAP_RELAY_URL: string;
  BOOTSTRAP_RELAY_SERVICE?: Fetcher;
  BOOTSTRAP_RELAY_ISSUER_REGION: string;
  BOOTSTRAP_VERIFIER_KEYS: string;
  BOOTSTRAP_FIREWALL_BINDINGS: string;
  BOOTSTRAP_OPERATOR_SOURCES: string;
  BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID: string;
  BOOTSTRAP_SCAN_CONTROL: string;
  CONTABO_ORDER_DEFAULT_USER: string;
  CONTABO_ORDER_SSH_KEY_IDS: string;
  CONTABO_RESCUE_SSH_KEY_IDS: string;
};
export type AuthPrincipal = Pick<ApiKey, "id" | "scope" | "project_id">;

export interface ApiVariables {
  requestId: string;
  auth?: AuthPrincipal;
}

export interface ApiEnv {
  Bindings: Env;
  Variables: ApiVariables;
}

export type ApiContext = Context<ApiEnv>;
