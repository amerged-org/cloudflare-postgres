// SPDX-License-Identifier: Apache-2.0
import { newNodeId, ObservationRequest, type DatabaseObservation } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import type { DatabaseRow } from "./rows.ts";

export function truncateAgentText(value:string):string {
  const bytes=new TextEncoder().encode(value);
  return bytes.length<=4096 ? value : new TextDecoder("utf-8",{ignoreBOM:false}).decode(bytes.subarray(0,4096),{stream:true});
}
export function observationApplies(row:DatabaseRow,regionId:string,observation:DatabaseObservation,observedAt:string):boolean {
  if(row.region_id!==regionId || observation.generation!==row.generation || observation.generation<row.observed_generation || observedAt<row.updated_at)return false;
  if(row.desired_state==='deleted')return ['deleting','deleted','error'].includes(observation.state) && (row.observed_state!=='deleted' || observation.state==='deleted');
  if(row.desired_state!=='running' || ['deleting','deleted'].includes(observation.state))return false;
  if(row.observed_state==='ready' && observation.state==='provisioning')return false;
  return true;
}
export async function observations(c:ApiContext,raw:unknown):Promise<Response> {
  const region=await agentRegion(c);
  if(raw && typeof raw==='object' && 'databases' in raw && Array.isArray(raw.databases)) {
    for(const db of raw.databases)if(db && typeof db==='object' && 'message' in db && typeof db.message==='string')db.message=truncateAgentText(db.message);
  }
  const parsed=ObservationRequest.safeParse(raw);
  if(!parsed.success)throw new ApiError("invalid_request","Invalid observations");
  const body=parsed.data,now=new Date().toISOString();
  if(Date.parse(body.observed_at)>Date.now()+300_000)throw new ApiError("invalid_request","Observation time is in the future");
  const names=new Set<string>(),ids=new Set<string>();
  if(body.nodes.some(n=>names.has(n.name) || (names.add(n.name),false)) || body.databases.some(d=>ids.has(d.id) || (ids.add(d.id),false)))throw new ApiError("invalid_request","Duplicate observation subject");
  for(const node of body.nodes) {
    await c.env.DB.prepare(`INSERT INTO nodes (id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,last_observed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(region_id,k8s_node_name) DO UPDATE SET ready=excluded.ready,allocatable_memory_mib=excluded.allocatable_memory_mib,
      allocatable_cpu_millicores=excluded.allocatable_cpu_millicores,storage_gib_total=excluded.storage_gib_total,platform_reserved_memory_mib=excluded.platform_reserved_memory_mib,
      last_observed_at=excluded.last_observed_at,updated_at=excluded.updated_at WHERE nodes.last_observed_at IS NULL OR excluded.last_observed_at>=nodes.last_observed_at`).bind(newNodeId(),region.id,node.name,Number(node.ready),node.allocatable_memory_mib,node.allocatable_cpu_millicores,node.storage_gib_total,node.platform_reserved_memory_mib,body.observed_at,now,body.observed_at).run();
  }
  let accepted=0;
  for(const observation of body.databases) {
    const row=await c.env.DB.prepare("SELECT * FROM databases WHERE id=? AND region_id=?").bind(observation.id,region.id).first<DatabaseRow>();
    if(!row || !observationApplies(row,region.id,observation,body.observed_at))continue;
    const health=observation.archive.continuous ? (observation.archive.ready_wal_files===null ? 'unknown' : 'ok') : 'failing';
    const applied=observation.state==='ready' || observation.state==='deleted';
    const event=observation.state==='ready' ? 'ready' : observation.state==='deleted' ? 'deleted' : null;
    const statements=[c.env.DB.prepare(`UPDATE databases SET observed_state=?,observed_generation=CASE WHEN ? THEN ? ELSE observed_generation END,status_message=?,
      archiving_health_since=CASE WHEN archiving_health<>? THEN ? ELSE archiving_health_since END,archiving_health=?,updated_at=?
      WHERE id=? AND region_id=? AND generation=? AND observed_generation<=? AND updated_at<=? AND desired_state=? AND observed_state=?`).bind(observation.state,Number(applied),observation.generation,observation.message===undefined ? null : truncateAgentText(observation.message),health,body.observed_at,health,body.observed_at,row.id,region.id,observation.generation,observation.generation,body.observed_at,row.desired_state,row.observed_state)];
    if(event)statements.push(c.env.DB.prepare(`INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at)
      SELECT id,?,node_id,size_class_id,generation,? FROM databases WHERE changes()=1 AND id=? AND region_id=?
      AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=? AND kind=? AND generation=?)`).bind(event,body.observed_at,row.id,region.id,row.id,event,observation.generation));
    if(applied)statements.push(c.env.DB.prepare(`UPDATE operations SET status='succeeded',updated_at=?,completed_at=? WHERE database_id=? AND project_id=? AND generation<=? AND status IN('pending','running') AND kind=?
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.project_id=operations.project_id AND d.region_id=? AND d.generation=? AND d.observed_generation=? AND d.observed_state=? AND d.updated_at=?)`).bind(now,now,row.id,row.project_id,observation.generation,observation.state==='ready' ? 'database.create' : 'database.delete',region.id,observation.generation,observation.generation,observation.state,body.observed_at));
    else if(observation.state==='error')statements.push(c.env.DB.prepare(`UPDATE operations SET status='failed',error_code='reconcile_failed',error_message=?,updated_at=?,completed_at=? WHERE database_id=? AND project_id=? AND generation<=? AND status IN('pending','running')
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.region_id=? AND d.generation=? AND d.observed_state='error' AND d.updated_at=?)`).bind(truncateAgentText(observation.message ?? 'Regional reconciliation failed'),now,now,row.id,row.project_id,observation.generation,region.id,observation.generation,body.observed_at));
    else statements.push(c.env.DB.prepare(`UPDATE operations SET status='running',updated_at=? WHERE database_id=? AND project_id=? AND generation<=? AND status='pending'
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.region_id=? AND d.generation=? AND d.observed_state=? AND d.updated_at=?)`).bind(now,row.id,row.project_id,observation.generation,region.id,observation.generation,observation.state,body.observed_at));
    const result=await c.env.DB.batch(statements);accepted+=result[0]!.meta.changes;
  }
  await c.env.REGION_LINK.get(c.env.REGION_LINK.idFromName(region.id)).reportOrphans(body.observed_at,body.orphans);
  await c.env.DB.prepare("UPDATE regions SET agent_last_seen_at=? WHERE id=?").bind(now,region.id).run();
  return c.json({accepted});
}
