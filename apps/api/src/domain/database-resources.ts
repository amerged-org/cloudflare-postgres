// SPDX-License-Identifier: Apache-2.0
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  databaseOperationResponse,
  hint,
  scheduleDatabaseResize,
} from "./databases.ts";
import type { ResourceOverrides } from "./resources.ts";
import { databaseForRequest } from "./rows.ts";

/** PUT /v1/databases/{id}/resources: an admin key sets the database's own values, as a resize. */
export async function setDatabaseResources(
  c: ApiContext,
  id: string,
  body: ResourceOverrides,
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
        body,
      );
      hint(c, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}
