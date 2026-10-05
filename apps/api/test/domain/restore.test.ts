// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { fixture, cleanupFixtures, request, observedBody, observation } from "./fixtures.ts";
import {createApp} from "../../src/app.ts";
import {createExecutionContext,waitOnExecutionContext} from "cloudflare:test";
import type {Env} from "../../src/env.ts";
import {cleanupRetainedArchives} from "../../src/domain/retained-archives.ts";
import { keyring } from "../../src/crypto/keyring.ts";
import type { RoleRow } from "../../src/domain/rows.ts";
const keys: string[]=[];
afterEach(async()=>{if(keys.length) await env.ARCHIVE.delete(keys.splice(0)); await cleanupFixtures();});
async function archived() {
 const f=await fixture(), response=await f.create();
 const {database}=await response.json() as {database:{id:string;generation:number}};
 const row=await env.DB.prepare("SELECT archive_path FROM databases WHERE id=?").bind(database.id).first<{archive_path:string}>();
 const prefix=row!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`,"")+"/database/";
 const start=Date.now()-60*60*1000,begin=new Date(start).toISOString(),end=new Date(start+120000).toISOString(),backupId=begin.replace(/[-:]/g,"").slice(0,15),target=new Date(start+180000).toISOString(),before=new Date(start+60000).toISOString();
 const objects=[[`${prefix}base/${backupId}/backup.info`,`backup_id=${backupId}\nstatus=DONE\nbegin_time=${begin}\nend_time=${end}\nbegin_wal=${"0".repeat(23)}1\nend_wal=${"0".repeat(23)}1\n`],[`${prefix}base/${backupId}/data.tar.gz`,"payload"],[`${prefix}wals/${"0".repeat(16)}/${"0".repeat(23)}1.gz`,"wal"]];
 for(const [key,value] of objects){keys.push(key!);await env.ARCHIVE.put(key!,value!);}
 return {...f,id:database.id,generation:database.generation,prefix,target,before};
}
it("restores into one separate target on replay with credentials encrypted for its ID",async()=>{
 const f=await archived();
 const body={mode:"full",name:"restored"};
 const first=await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",body,"restore-once");
 expect(first.status).toBe(202);
 const result=await first.json() as {target_database:{id:string;observed_state:string};operation:{id:string;kind:string}};
 expect(result.target_database.id).not.toBe(f.id);expect(result.target_database.observed_state).toBe("pending");expect(result.operation.kind).toBe("database.restore");
 const replay=await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",body,"restore-once");
 expect(replay.status).toBe(202);expect(await replay.json()).toEqual(result);
 const source=await env.DB.prepare("SELECT * FROM roles WHERE database_id=? AND owner=1").bind(f.id).first<RoleRow>();
 const target=await env.DB.prepare("SELECT * FROM roles WHERE database_id=? AND owner=1").bind(result.target_database.id).first<RoleRow>();
 const decrypt=(r:RoleRow)=>keyring(env.CREDENTIAL_KEYS).decrypt(r.database_id,r.name,{ciphertext:r.password_ciphertext,iv:r.password_iv,kid:r.password_kid});
 expect(await decrypt(target!)).toBe(await decrypt(source!));
 expect(target!.password_ciphertext).not.toBe(source!.password_ciphertext);
 const desired=await request("/agent/v1/desired",f.agent);const page=await desired.json() as {databases:{id:string;recovery?:{source_database_id:string}}[]};
 expect(page.databases.find(d=>d.id===result.target_database.id)?.recovery?.source_database_id).toBe(f.id);
 const ack=await request("/agent/v1/observations",f.agent,"POST",observedBody([observation(result.target_database.id,1)]));
 expect(await ack.json()).toEqual({accepted:0});
});
it("retains deleted-source restore authority and rejects another tenant, region and expired archive",async()=>{
 const f=await archived();expect((await request(`/v1/databases/${f.id}`,f.integrator,"DELETE")).status).toBe(202);
 expect((await request(`/v1/databases/${f.id}/restore`,f.otherKey,"POST",{mode:"full",name:"foreign"})).status).toBe(404);
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"full",name:"wrong-region",region_id:f.foreign})).status).toBe(400);
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"pitr",name:"deleted-restore",target_time:f.target})).status).toBe(202);
 await env.DB.prepare("UPDATE retained_archives SET deleted_at=?,expires_at=? WHERE source_database_id=?").bind(new Date(Date.now()-8*86400000).toISOString(),new Date(Date.now()-86400000).toISOString(),f.id).run();
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"full",name:"expired"})).status).toBe(409);
});
it("refuses missing WAL and a target before a completed base backup without reserving target storage",async()=>{
 const f=await archived();
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"pitr",name:"too-early",target_time:f.before})).status).toBe(409);
 await env.ARCHIVE.delete(keys.filter(k=>k.includes("/wals/")));
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"full",name:"missing-wal"})).status).toBe(409);
 expect(await env.DB.prepare("SELECT COUNT(*) count FROM database_restores").first<{count:number}>()).toEqual({count:0});
});

async function overridden(path:string,key:string,body:unknown,override:Partial<Env>,idempotency:string) {
 const ctx=createExecutionContext();
 const result=await createApp().fetch(new Request(new URL(path,`https://${["api","invalid"].join(".")}`),{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json","Idempotency-Key":idempotency},body:JSON.stringify(body)}),{...env,...override} as Env,ctx);
 await waitOnExecutionContext(ctx);return result;
}
it("completed reservation survives a lost response and replay creates neither credentials nor another target",async()=>{
 const f=await archived(),body={mode:"full",name:"lost-response"},path=`/v1/databases/${f.id}/restore`;
 const actor={idFromName:(id:string)=>env.DATABASE_ACTOR.idFromName(id),get:()=>({seed:async()=>{throw new Error("response_ack_lost");}})} as unknown as Env["DATABASE_ACTOR"];
 expect((await overridden(path,f.integrator,body,{DATABASE_ACTOR:actor},"lost-response")).status).toBe(500);
 const count=await env.DB.prepare("SELECT COUNT(*) count FROM database_restores WHERE source_database_id=?").bind(f.id).first();expect(count).toEqual({count:1});
 const replay=await request(path,f.integrator,"POST",body,"lost-response");expect(replay.status).toBe(202);
 expect(await env.DB.prepare("SELECT COUNT(*) count FROM database_restores WHERE source_database_id=?").bind(f.id).first()).toEqual(count);
});
it("concurrent source deletion refuses a stale restore reservation",async()=>{
 const f=await archived();let deleted=false;
 const bucket={list:async(options:R2ListOptions)=>{if(!deleted){deleted=true;expect((await request(`/v1/databases/${f.id}`,f.integrator,"DELETE")).status).toBe(202);}return env.ARCHIVE.list(options);},get:env.ARCHIVE.get.bind(env.ARCHIVE),delete:env.ARCHIVE.delete.bind(env.ARCHIVE)} as unknown as R2Bucket;
 expect((await overridden(`/v1/databases/${f.id}/restore`,f.integrator,{mode:"full",name:"raced"},{ARCHIVE:bucket},"delete-race")).status).toBe(409);
 expect(await env.DB.prepare("SELECT COUNT(*) count FROM database_restores WHERE source_database_id=?").bind(f.id).first()).toEqual({count:0});
});
it("expiry cleanup deletes only the owned prefix and releases retained credentials after complete deletion",async()=>{
 const f=await archived();expect((await request(`/v1/databases/${f.id}`,f.integrator,"DELETE")).status).toBe(202);
 await request("/agent/v1/observations",f.agent,"POST",observedBody([observation(f.id,2,"deleted")]));
 const retention=await env.DB.prepare("SELECT expires_at FROM retained_archives WHERE source_database_id=?").bind(f.id).first<{expires_at:string}>();
 const sibling=`${f.prefix}other-generation`,outside=f.prefix.replace("/g1-","/g2-")+"sibling";keys.push(sibling,outside);await env.ARCHIVE.put(sibling,"owned");await env.ARCHIVE.put(outside,"sibling");
 expect(await cleanupRetainedArchives(env,Date.parse(retention!.expires_at)-1)).toEqual({purged:0,objects:0});
 expect((await cleanupRetainedArchives(env,Date.parse(retention!.expires_at))).objects).toBe(4);
 expect(await env.ARCHIVE.get(outside)).not.toBeNull();
 expect(await cleanupRetainedArchives(env,Date.parse(retention!.expires_at))).toEqual({purged:1,objects:0});
 expect(await env.DB.prepare("SELECT COUNT(*) count FROM roles WHERE database_id=?").bind(f.id).first()).toEqual({count:0});
 expect(await env.DB.prepare("SELECT id FROM databases WHERE id=? AND desired_state='deleted'").bind(f.id).first()).toEqual({id:f.id});
});
