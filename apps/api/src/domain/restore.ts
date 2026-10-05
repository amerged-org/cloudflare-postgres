// SPDX-License-Identifier: Apache-2.0
import { archiveDestinationPath, type DatabaseRestore, newDatabaseId, newOperationId } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { keyring } from "../crypto/keyring.ts";
import { databaseInsertStatement, hint } from "./databases.ts";
import { generateMaintenanceCredential, maintenanceCreationStatement } from "./maintenance.ts";
import { choosePlacement, placementNodes } from "./placement.ts";
import { databaseForRequest, databaseView, isConstraintError, operationForRequest, operationView, type RoleRow, type RegionRow, type SizeRow } from "./rows.ts";
import { syncDatabaseActor } from "./database-actor-sync.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { regionArchive } from "./archive-bindings.ts";
import { restoreBackup } from "./restore-catalog.ts";
interface Retained { roles_json:string; expires_at:string; cleanup_claim:string|null; archive_path:string;storage_generation:number; }
async function response(c:ApiContext,id:string,status=202):Promise<Response>{
 const operation=await operationForRequest(c,id), database=await databaseForRequest(c,operation.database_id,true);
 await syncDatabaseActor(c,database.id);c.header("Location",`/v1/operations/${id}`);
 return Response.json({target_database:databaseView(database),operation:operationView(operation)},{status,headers:c.res.headers});
}
export async function restoreDatabase(c:ApiContext,sourceId:string,body:DatabaseRestore):Promise<Response> {
 await databaseForRequest(c,sourceId,true);
 return withIdempotency(c,{replay:(id,status)=>response(c,id,status),execute:async lease=>{
  const source=await databaseForRequest(c,sourceId,true),now=new Date().toISOString();
  if(body.mode==="pitr"&&body.target_time>now)throw new ApiError("invalid_request","Recovery time must not be in the future");
  const retained=source.deleted_at===null?null:await c.env.DB.prepare("SELECT * FROM retained_archives WHERE source_database_id=? AND project_id=? AND region_id=?").bind(sourceId,source.project_id,source.region_id).first<Retained>();
  if(source.deleted_at!==null && (!retained||retained.expires_at<=now||retained.cleanup_claim!==null || retained.archive_path!==source.archive_path ||retained.storage_generation!==(source.storage_generation??1)))throw new ApiError("conflict","The deleted source archive is outside recovery retention");
  const [region,size]=await Promise.all([c.env.DB.prepare("SELECT id,backup_bucket,backup_endpoint_url,agent_key_hash FROM regions WHERE id=?").bind(source.region_id).first<RegionRow>(),c.env.DB.prepare("SELECT * FROM size_classes WHERE id=? AND enabled=1").bind(source.size_class_id).first<SizeRow>()]);
  if(!region||!size)throw new ApiError("conflict","Source region or size is unavailable");
  const selected=regionArchive(c.env,region), prefix=validatedArchivePrefix(source,region,selected.bucketName);
  const backup=await restoreBackup(selected.bucket,prefix,body.mode==="pitr"?body.target_time:undefined);
  const stored=retained?JSON.parse(retained.roles_json) as RoleRow[]:(await c.env.DB.prepare("SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name").bind(sourceId).all<RoleRow>()).results;
  if(stored.filter(r=>r.owner===1).length!==1)throw new ApiError("conflict","Source credentials are unavailable");
  const targetId=newDatabaseId(),op=newOperationId(),storageGeneration=(source.storage_generation??1)+1, credentials=keyring(c.env.CREDENTIAL_KEYS);
  const roles=await Promise.all(stored.map(async r=>({row:r,encrypted:await credentials.encrypt(targetId,r.name,await credentials.decrypt(sourceId,r.name,{ciphertext:r.password_ciphertext,iv:r.password_iv,kid:r.password_kid}))})));
  const maintenance=await generateMaintenanceCredential(c.env.CREDENTIAL_KEYS,targetId);
  const node=choosePlacement(await placementNodes(c.env.DB,source.region_id),source.region_id,size);
  const archive=archiveDestinationPath(region.backup_bucket,region.id,targetId,storageGeneration,op);
  const authority={sql:`EXISTS(SELECT 1 FROM databases src WHERE src.id=? AND src.project_id=? AND src.region_id=? AND src.generation=? AND src.updated_at=? AND src.archive_path=? AND src.storage_generation=? AND src.deleted_at IS ?
   AND (src.deleted_at IS NULL OR EXISTS(SELECT 1 FROM retained_archives ra WHERE ra.source_database_id=src.id AND ra.archive_path=src.archive_path AND ra.storage_generation=src.storage_generation AND ra.expires_at>? AND ra.cleanup_claim IS NULL AND ra.roles_json=?)))
   AND (SELECT json_group_array(json_object('name',r.name,'revision',r.password_revision,'ciphertext',r.password_ciphertext)) FROM (SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name) r)=?`,
   bindings:[sourceId,source.project_id,source.region_id,source.generation,source.updated_at,source.archive_path,source.storage_generation??1,source.deleted_at,now,retained?.roles_json??"",sourceId,JSON.stringify(stored.sort((a,b)=>a.name.localeCompare(b.name)).map(r=>({name:r.name,revision:r.password_revision,ciphertext:r.password_ciphertext})))]};
  const guard={sql:"EXISTS(SELECT 1 FROM database_restores WHERE target_database_id=? AND operation_id=?)",bindings:[targetId,op]};
  const statements=[databaseInsertStatement(c.env.DB,{body:{project_id:source.project_id,region_id:source.region_id,size_class_id:source.size_class_id,name:body.name},size,region,nodeId:node?.id??null,id:targetId,archivePath:archive,now,authority}),maintenanceCreationStatement(c.env.DB,{databaseId:targetId,projectId:source.project_id,createdAt:now,creationGeneration:1},maintenance),
   c.env.DB.prepare("UPDATE databases SET storage_generation=? WHERE id=? AND project_id=? AND created_at=?").bind(storageGeneration,targetId,source.project_id,now),
   ...roles.map(({row:r,encrypted:e})=>c.env.DB.prepare("INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at) SELECT id,?,?,?,?,?,?,?,? FROM databases WHERE id=? AND project_id=? AND created_at=?").bind(r.name,r.owner,e.ciphertext,e.iv,e.kid,r.password_revision,now,now,targetId,source.project_id,now)),
   c.env.DB.prepare("INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.restore','pending',project_id,id,generation,?,? FROM databases WHERE id=? AND project_id=? AND created_at=?").bind(op,now,now,targetId,source.project_id,now),
   c.env.DB.prepare("INSERT INTO database_restores(target_database_id,operation_id,source_database_id,source_archive_path,source_storage_generation,backup_id,target_time,created_at) SELECT id,?,?,?,?,?,?,? FROM databases WHERE id=? AND project_id=? AND created_at=?").bind(op,sourceId,source.archive_path,source.storage_generation??1,backup.id,body.mode==="pitr"?body.target_time:null,now,targetId,source.project_id,now),lease.completeStatement(op,202,guard)];
  let result:D1Result[];try{result=await c.env.DB.batch(statements);}catch(error){if(isConstraintError(error))throw new ApiError("conflict","A database with this target name already exists");throw error;}
  if(result[0]!.meta.changes!==1)throw new ApiError("conflict","Source credentials, retention or placement changed; retry the request");
  if(node)hint(c,source.region_id,[targetId]);return response(c,op);
 }});
}
