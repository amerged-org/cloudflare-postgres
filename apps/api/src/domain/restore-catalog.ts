// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "../app.ts";
const WAL = /^[0-9A-F]{24}$/;
const BACKUP = /^[0-9]{8}T[0-9]{6}$/;
const CATALOG_PAGE_LIMIT=16, CATALOG_OBJECT_LIMIT=16000;
export interface RestoreBackup { id:string; begin:string; end:string; beginWal:string; endWal:string; }
export function parseBackupInfo(text:string,id:string): RestoreBackup | null {
 if(text.length>65536 || !BACKUP.test(id)) return null;
 const fields=new Map<string,string>();
 for(const line of text.split("\n")) {const at=line.indexOf("="); if(at<1)continue; const key=line.slice(0,at), value=line.slice(at+1); if(fields.has(key))return null;fields.set(key,value);}
 const begin=Date.parse(fields.get("begin_time") ?? ""),end=Date.parse(fields.get("end_time") ?? "");
 const beginWal=fields.get("begin_wal")??"",endWal=fields.get("end_wal")??"";
 if(fields.get("status")!=="DONE" || fields.get("backup_id")!==id || !Number.isFinite(begin)||!Number.isFinite(end)||begin>end || !WAL.test(beginWal)||!WAL.test(endWal))return null;
 return {id,begin:new Date(begin).toISOString(),end:new Date(end).toISOString(),beginWal,endWal};
}
export async function restoreBackup(bucket:R2Bucket,prefix:string,target?:string):Promise<RestoreBackup> {
 const objects=new Map<string,R2Object>(),cursors=new Set<string>();let cursor:string|undefined;
 for(let page=0;page<CATALOG_PAGE_LIMIT;page++) {
  const result=await bucket.list({prefix,limit:1000,...(cursor?{cursor}:{})});
  if(result.delimitedPrefixes.length || result.objects.length>1000)throw new ApiError("conflict","Archive listing is incomplete");
  for(const o of result.objects){if(!o.key.startsWith(prefix)||objects.has(o.key)||objects.size>=CATALOG_OBJECT_LIMIT)throw new ApiError("conflict","Archive listing is invalid");objects.set(o.key,o);}
  if(!result.truncated){cursor=undefined;break;}
  if(!result.cursor||cursors.has(result.cursor))throw new ApiError("conflict","Archive listing is incomplete");cursors.add(result.cursor);cursor=result.cursor;
 }
 if(cursor)throw new ApiError("conflict","Archive listing exceeds the bounded recovery catalog");
 const backups:RestoreBackup[]=[];
 for(const key of objects.keys()) {
  const match=/^base\/([0-9]{8}T[0-9]{6})\/backup\.info$/.exec(key.slice(prefix.length));
  if(!match)continue;
  if(backups.length>=64)throw new ApiError("conflict","Archive recovery catalog exceeds the backup limit");
  const value=await bucket.get(key);if(!value||value.size>65536)continue;
  const info=parseBackupInfo(await value.text(),match[1]!);if(!info)continue;
  const dataPrefix=`${prefix}base/${info.id}/`;
  if(![...objects.keys()].some(k=>k.startsWith(dataPrefix)&&/\.tar(?:\.(?:gz|bz2|lz4|zst))?$/.test(k)))continue;
  const endWal=[...objects.keys()].some(k=> k.startsWith(`${prefix}wals/`) && k.slice(k.lastIndexOf("/")+1).replace(/\.(?:gz|bz2|lz4|zst)$/,"")===info.endWal);
  if(endWal && (target===undefined || info.end<=target))backups.push(info);
 }
 const selected=backups.sort((a,b)=>b.end.localeCompare(a.end)||b.id.localeCompare(a.id))[0];
 if(!selected)throw new ApiError("conflict","No complete base backup and required WAL are available for the requested recovery");
 return selected;
}
