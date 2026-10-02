// SPDX-License-Identifier: Apache-2.0
import { hashApiKey, parseAgentKey, timingSafeEqual } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import type { RegionRow } from "./rows.ts";

export async function agentRegion(c:ApiContext):Promise<RegionRow> {
  const authorization=c.req.header("Authorization");
  const key=authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const parsed=parseAgentKey(key);
  if(!parsed)throw new ApiError("unauthorized","Invalid agent credentials");
  const row=await c.env.DB.prepare("SELECT id,backup_bucket,backup_endpoint_url,agent_key_hash FROM regions WHERE id=?").bind(parsed.regionId).first<RegionRow>();
  const hash=await hashApiKey(c.env.API_KEY_PEPPER,key);
  if(!row || !timingSafeEqual(row.agent_key_hash,hash))throw new ApiError("unauthorized","Invalid agent credentials");
  return row;
}
