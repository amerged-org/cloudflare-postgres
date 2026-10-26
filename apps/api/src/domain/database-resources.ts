// SPDX-License-Identifier: Apache-2.0
import { normalizeStorage, type DatabaseResources } from "@pgcf/contracts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  databaseOperationResponse,
  hint,
  scheduleDatabaseResize,
} from "./databases.ts";
import { databaseForRequest } from "./rows.ts";

/** PUT /v1/databases/{id}/resources: an admin key sets the database's own values, as a resize. */
export async function setDatabaseResources(
  c: ApiContext,
  id: string,
  body: DatabaseResources,
): Promise<Response> {
  await requireScope(c, "admin");
  await databaseForRequest(c, id, true);
  return withIdempotency(c, {
    replay: (op, status) => databaseOperationResponse(c, op, status),
    execute: async (lease) => {
      const row = await databaseForRequest(c, id, true);
      const op = await scheduleDatabaseResize(
        c.env,
        row,
        row.size_class_id,
        new Date().toISOString(),
        lease,
        undefined,
        {
          memory_mib: body.memory_mib,
          cpu_millicores: body.cpu_millicores,
          storage_mib: normalizeStorage(body) ?? null,
        },
      );
      hint(c, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}
