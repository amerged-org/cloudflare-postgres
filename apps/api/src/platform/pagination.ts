// SPDX-License-Identifier: Apache-2.0
import {
  decodeCursor,
  encodeCursor,
  ListQuery,
  type Cursor,
  type ListEnvelope,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";

export interface Page {
  limit: number;
  cursor: Cursor | null;
  where(
    column?: string,
    idColumn?: string,
  ): { sql: string; bindings: string[] };
  envelope<T extends Cursor>(rows: T[]): ListEnvelope<T>;
}

export function page(c: ApiContext, query: unknown = c.req.query()): Page {
  const parsed = ListQuery.safeParse(query);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid list query");
  const limit = parsed.data.limit;
  const cursor =
    parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor);
  if (parsed.data.cursor !== undefined && cursor === null)
    throw new ApiError("invalid_request", "Invalid pagination cursor");
  return {
    limit,
    cursor,
    where(column = "created_at", idColumn = "id") {
      // Identifiers are supplied by route code, never directly from a request.
      if (
        ![column, idColumn].every((name) => /^[a-z_][a-z0-9_.]*$/i.test(name))
      )
        throw new TypeError("Invalid pagination column");
      return cursor === null
        ? { sql: "1 = 1", bindings: [] }
        : {
            sql: `(${column} < ? OR (${column} = ? AND ${idColumn} < ?))`,
            bindings: [cursor.created_at, cursor.created_at, cursor.id],
          };
    },
    envelope<T extends Cursor>(rows: T[]): ListEnvelope<T> {
      const data = rows.slice(0, limit);
      const last = data.at(-1);
      return {
        data,
        next_cursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },
  };
}
