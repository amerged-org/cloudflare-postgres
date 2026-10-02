// SPDX-License-Identifier: Apache-2.0
import { ARCHIVE_DESTINATION_PATTERN } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { databaseForRequest } from "./rows.ts";

export async function archiveSummary(c:ApiContext,id:string):Promise<Response> {
  const row=await databaseForRequest(c,id,true);
  const region=await c.env.DB.prepare("SELECT backup_bucket FROM regions WHERE id=?").bind(row.region_id).first<{backup_bucket:string}>();
  const path=ARCHIVE_DESTINATION_PATTERN.exec(row.archive_path);
  if(!region || !path || path[1]!==region.backup_bucket || path[2]!==row.region_id || path[3]!==row.id || Number(path[4])>row.generation || c.env.ARCHIVE_BUCKET_NAME!==region.backup_bucket)throw new ApiError("internal","The region archive bucket is not bound to this installation");
  const prefix=`${row.region_id}/${row.id}/${row.archive_path.slice(row.archive_path.lastIndexOf('/')+1)}/database/`;
  let baseBackups=0,walCount=0,bytes=0;
  const catalogs=new Set<string>();
  let cursor:string|undefined;
  do {
    const listing=await c.env.ARCHIVE.list({prefix,delimiter:'/',...(cursor ? {cursor} : {})});
    for(const object of listing.objects)bytes+=object.size;
    for(const child of listing.delimitedPrefixes) {
      let childCursor:string|undefined;
      do {
        const contents=await c.env.ARCHIVE.list({prefix:child,...(childCursor ? {cursor:childCursor} : {})});
        for(const object of contents.objects) {
          bytes+=object.size;
          if(object.key.includes('/base/') && object.key.endsWith('/backup.info'))catalogs.add(object.key);
          if(object.key.includes('/wals/') && /^[0-9A-F]{24}(?:\.(?:gz|bz2|lz4|zst))?$/.test(object.key.slice(object.key.lastIndexOf('/')+1)))walCount++;
        }
        childCursor=contents.truncated ? contents.cursor : undefined;
      }while(childCursor!==undefined);
    }
    cursor=listing.truncated ? listing.cursor : undefined;
  }while(cursor!==undefined);
  baseBackups=catalogs.size;
  return c.json({database_id:row.id,base_backup_count:baseBackups,wal_count:walCount,bytes});
}
