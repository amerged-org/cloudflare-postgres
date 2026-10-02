// SPDX-License-Identifier: Apache-2.0
import type { ApiKey } from "@pgcf/contracts";
import type { Context } from "hono";

export type Env = Cloudflare.Env;
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
