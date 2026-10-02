// SPDX-License-Identifier: Apache-2.0
import { ARCHIVE_SERVER_NAME, DesiredDatabase, DesiredResponse, type DesiredQuery, type DesiredSize } from "@pgcf/contracts";
import { keyring } from "../crypto/keyring.ts";
import type { ApiContext } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import type { DatabaseRow, RoleRow } from "./rows.ts";

interface DesiredRow extends DatabaseRow, DesiredSize { k8s_node_name:string; }
export async function desired(c:ApiContext,query:DesiredQuery):Promise<Response> {
  const region=await agentRegion(c);
  const result=await c.env.DB.prepare(`SELECT d.*,n.k8s_node_name,s.memory_mib,s.cpu_millicores,s.storage_gib,s.max_connections,s.archive_timeout_seconds,s.backup_retention_days
    FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id JOIN size_classes s ON s.id=d.size_class_id
    WHERE d.region_id=? AND NOT(d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation)
    ${query.after ? "AND d.id>?" : ""} ORDER BY d.id LIMIT ?`).bind(region.id,...(query.after ? [query.after] : []),query.limit+1).all<DesiredRow>();
  const rows=result.results.slice(0,query.limit),databases:DesiredDatabase[]=[];
  const credentials=keyring(c.env.CREDENTIAL_KEYS);
  for(const row of rows) {
    const roles:DesiredDatabase['roles']=[];
    // Deletion can recover even if a credential key has been retired.
    if(row.desired_state!=='deleted') {
      const stored=await c.env.DB.prepare("SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name").bind(row.id).all<RoleRow>();
      for(const role of stored.results)roles.push({name:role.name,owner:Boolean(role.owner),revision:role.password_revision,password:await credentials.decrypt(row.id,role.name,{ciphertext:role.password_ciphertext,iv:role.password_iv,kid:role.password_kid})});
    }
    databases.push(DesiredDatabase.parse({id:row.id,generation:row.generation,desired_state:row.desired_state,node:row.k8s_node_name,pg_major:row.pg_major,
      size:{memory_mib:row.memory_mib,cpu_millicores:row.cpu_millicores,storage_gib:row.storage_gib,max_connections:row.max_connections,archive_timeout_seconds:row.archive_timeout_seconds,backup_retention_days:row.backup_retention_days},roles,
      archive:{destination_path:row.archive_path,server_name:ARCHIVE_SERVER_NAME}}));
  }
  return c.json(DesiredResponse.parse({region:{id:region.id,backup:{bucket:region.backup_bucket,endpoint_url:region.backup_endpoint_url,region:'auto'}},databases,next:result.results.length>query.limit ? rows.at(-1)!.id : null}));
}
