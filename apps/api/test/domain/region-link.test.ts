// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { newDatabaseId } from "@pgcf/contracts";
import { expect, it } from "vitest";
import { fixture, request } from "./fixtures.ts";

function nextMessage(socket:WebSocket):Promise<string> { return new Promise(resolve=>socket.addEventListener('message',event=>resolve(String(event.data)),{once:true})); }
async function connect(stub:ReturnType<typeof env.REGION_LINK.get>):Promise<WebSocket> {
  const response=await stub.fetch(new Request(`https://${['link','invalid'].join('.')}/agent/v1/link`,{headers:{Upgrade:'websocket'}}));
  expect(response.status).toBe(101);const socket=response.webSocket!;socket.accept();
  const welcome=nextMessage(socket);socket.send(JSON.stringify({type:'hello',protocol:1,agent_version:'test',instance_id:crypto.randomUUID()}));
  expect(JSON.parse(await welcome)).toEqual({type:'welcome',protocol:1});return socket;
}
it('sends real DO hints after hibernation and replaces the previous agent socket',async()=>{
  const stub=env.REGION_LINK.get(env.REGION_LINK.idFromName(crypto.randomUUID())),id=newDatabaseId();
  const first=await connect(stub);
  const hint=nextMessage(first);expect(await stub.notify([id])).toBe(1);expect(JSON.parse(await hint)).toEqual({type:'desired',ids:[id]});
  await evictDurableObject(stub);
  const resumed=nextMessage(first);expect(await stub.notify([id])).toBe(1);expect(JSON.parse(await resumed)).toEqual({type:'desired',ids:[id]});
  const replaced=new Promise<number>(resolve=>first.addEventListener('close',event=>resolve(event.code),{once:true}));
  const second=await connect(stub);expect(await replaced).toBe(1012);
  const next=nextMessage(second);expect(await stub.notify([id])).toBe(1);expect(JSON.parse(await next)).toEqual({type:'desired',ids:[id]});
  second.close(1000);
});
it('persists latest orphan observations in the real region DO',async()=>{
  const stub=env.REGION_LINK.get(env.REGION_LINK.idFromName(crypto.randomUUID()));
  const observedAt=new Date().toISOString(),orphans=[{namespace:'pgcf-db-'+newDatabaseId(),database_id:null}];
  await stub.reportOrphans(observedAt,orphans);
  await stub.reportOrphans(new Date(Date.now()-1000).toISOString(),[]);
  await evictDurableObject(stub);
  const rows=await runInDurableObject(stub,(_instance,state)=>state.storage.sql.exec<{observed_at:string;orphans:string}>('SELECT observed_at,orphans FROM orphan_reports').toArray());
  expect(rows).toEqual([{observed_at:observedAt,orphans:JSON.stringify(orphans)}]);
});
it('authenticates the public agent link and rejects ordinary HTTP requests',async()=>{
  const f=await fixture();expect((await request('/agent/v1/link',f.integrator)).status).toBe(401);
  expect((await request('/agent/v1/link',f.agent)).status).toBe(426);
});
