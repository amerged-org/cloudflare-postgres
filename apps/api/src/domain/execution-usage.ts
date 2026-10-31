// SPDX-License-Identifier: Apache-2.0
import {
  EXECUTION_METRICS,
  USAGE_FINAL_DELAY_MS,
  USAGE_HOUR_MS,
  type ExecutionMetric,
  type ExecutionUsageQuery,
  type ExecutionUsageResponse,
  type ExecutionUsageRow,
} from "@pgcf/contracts/execution-usage";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import { databaseForRequest } from "./rows.ts";

type Row = {
  database_id: string;
  project_id: string;
  start: string;
  metric: ExecutionMetric;
  value: number;
};

/**
 * What the schedules, events and webhook deliveries of a project or database did, by hour or day.
 * A period without a row had no executions. A row is final two hours after its period ended, by
 * when every closed hour has been written (an actor writes an hour a minute after it ends).
 */
export async function queryExecutionUsage(
  c: ApiContext,
  query: ExecutionUsageQuery,
): Promise<ExecutionUsageResponse> {
  await getAuth(c);
  let scopeSql: string, scopeId: string;
  if (query.database_id) {
    await databaseForRequest(c, query.database_id, true);
    scopeSql = "database_id = ?";
    scopeId = query.database_id;
  } else {
    scopeId = query.project_id!;
    await assertProjectAccess(c, scopeId);
    const project = await c.env.DB.prepare(
      "SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL",
    )
      .bind(scopeId)
      .first();
    if (!project) throw new ApiError("not_found", "Project not found");
    scopeSql = "project_id = ?";
  }
  const day = query.granularity === "day";
  const bucket = (column: string) =>
    day ? `substr(${column},1,10) || 'T00:00:00.000Z'` : column;
  const [cursorDatabase = "", cursorStart = ""] =
    query.cursor?.split("|") ?? [];
  const result = await c.env.DB.prepare(
    `WITH keys AS (
       SELECT database_id, ${bucket("hour_start")} AS start FROM execution_usage
       WHERE ${scopeSql} AND hour_start >= ? AND hour_start < ?
         AND (database_id > ? OR (database_id = ? AND ${bucket("hour_start")} > ?))
       GROUP BY database_id, start ORDER BY database_id, start LIMIT ?
     )
     SELECT e.database_id, e.project_id, k.start, e.metric, SUM(e.value) AS value
     FROM keys k JOIN execution_usage e
       ON e.database_id = k.database_id AND ${bucket("e.hour_start")} = k.start
      AND e.hour_start >= ? AND e.hour_start < ?
     GROUP BY e.database_id, e.project_id, k.start, e.metric
     ORDER BY e.database_id, k.start`,
  )
    .bind(
      scopeId,
      query.from,
      query.to,
      cursorDatabase,
      cursorDatabase,
      cursorStart,
      query.limit + 1,
      query.from,
      query.to,
    )
    .all<Row>();
  const step = day ? 24 * USAGE_HOUR_MS : USAGE_HOUR_MS;
  const grouped = new Map<string, ExecutionUsageRow>();
  for (const row of result.results) {
    const key = `${row.database_id}|${row.start}`;
    let entry = grouped.get(key);
    if (!entry) {
      const end = new Date(Date.parse(row.start) + step).toISOString();
      entry = {
        database_id: row.database_id,
        project_id: row.project_id,
        start: row.start,
        end,
        final: Date.parse(end) + USAGE_FINAL_DELAY_MS <= Date.now(),
        metrics: Object.fromEntries(
          EXECUTION_METRICS.map((metric) => [metric, 0]),
        ) as ExecutionUsageRow["metrics"],
      };
      grouped.set(key, entry);
    }
    entry.metrics[row.metric] = row.value;
  }
  const all = [...grouped.values()];
  const data = all.slice(0, query.limit);
  const last = data.at(-1);
  return {
    data,
    next_cursor:
      all.length > query.limit && last
        ? `${last.database_id}|${last.start}`
        : null,
  };
}
