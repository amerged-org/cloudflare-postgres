// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { fixture, cleanupFixtures, request, observedBody, observation } from "./fixtures.ts";
import { keyring } from "../../src/crypto/keyring.ts";
import type { RoleRow } from "../../src/domain/rows.ts";
const keys: string[]=[];
afterEach(async()=>{if(keys.length) await env.ARCHIVE.delete(keys.splice(0)); await cleanupFixtures();});
async function archived() {
 const f=await fixture(), response=await f.create();
 const {database}=await response.json() as {database:{id:string;generation:number}};
 const row=await env.DB.prepare("SELECT archive_path FROM databases WHERE id=?").bind(database.id).first<{archive_path:string}>();
 const prefix=row!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`,"")+"/database/";
 const backupId="20261001T000000", end="2026-10-01T00:02:00.000Z";
 const objects=[[`${prefix}base/${backupId}/backup.info`,`backup_id=${backupId}\nstatus=DONE\nbegin_time=2026-10-01T00:00:00.000Z\nend_time=${end}\nbegin_wal=${"0".repeat(23)}1\nend_wal=${"0".repeat(23)}1\n`],[`${prefix}base/${backupId}/data.tar.gz`,"payload"],[`${prefix}wals/${"0".repeat(16)}/${"0".repeat(23)}1.gz`,"wal"]];
 for(const [key,value] of objects){keys.push(key!);await env.ARCHIVE.put(key!,value!);}
 return {...f,id:database.id,generation:database.generation,prefix};
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
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"pitr",name:"deleted-restore",target_time:"2026-10-01T00:03:00.000Z"})).status).toBe(202);
 await env.DB.prepare("UPDATE retained_archives SET deleted_at='2026-09-01T00:00:00.000Z',expires_at=? WHERE source_database_id=?").bind("2026-10-01T00:00:00.000Z",f.id).run();
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"full",name:"expired"})).status).toBe(409);
});
it("refuses missing WAL and a target before a completed base backup without reserving target storage",async()=>{
 const f=await archived();
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"pitr",name:"too-early",target_time:"2026-10-01T00:01:00.000Z"})).status).toBe(409);
 await env.ARCHIVE.delete(keys.filter(k=>k.includes("/wals/")));
 expect((await request(`/v1/databases/${f.id}/restore`,f.integrator,"POST",{mode:"full",name:"missing-wal"})).status).toBe(409);
 expect(await env.DB.prepare("SELECT COUNT(*) count FROM database_restores").first<{count:number}>()).toEqual({count:0});
});
