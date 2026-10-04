// SPDX-License-Identifier: Apache-2.0
import {
  COST_HOUR_MS,
  InfrastructureCostFact,
  InfrastructureCostFactCreate,
  InfrastructureCostHour,
  InfrastructureCostsQuery,
  InfrastructureCostsResponse,
  prorateMonthlyCost,
  sumInfrastructureAmounts,
  type ExactInfrastructureAmount,
} from "@pgcf/contracts/costs";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";

interface FactRow {
  id: string;
  node_id: string;
  region_id: string;
  provider: string;
  effective_from: string;
  effective_to: string;
  payload: string;
  recorded_at: string;
}
function factView(row: FactRow): InfrastructureCostFact {
  const payload = InfrastructureCostFactCreate.parse(JSON.parse(row.payload));
  if (
    payload.node_id !== row.node_id ||
    payload.region_id !== row.region_id ||
    payload.effective_from !== row.effective_from ||
    payload.effective_to !== row.effective_to
  )
    throw new Error("Invalid infrastructure fact identity");
  return InfrastructureCostFact.parse({
    ...payload,
    id: row.id,
    provider: row.provider,
    recorded_at: row.recorded_at,
    verification: "owner_recorded",
  });
}
const naturalFact = (db: D1Database, input: InfrastructureCostFactCreate) =>
  db
    .prepare(
      "SELECT * FROM infrastructure_node_cost_facts WHERE node_id=? AND effective_from=? AND effective_to=?",
    )
    .bind(input.node_id, input.effective_from, input.effective_to)
    .first<FactRow>();

export async function createInfrastructureCostFact(
  c: ApiContext,
  value: InfrastructureCostFactCreate,
): Promise<Response> {
  const principal = await requireScope(c, "admin"),
    input = InfrastructureCostFactCreate.parse(value),
    payload = JSON.stringify(input);
  if (Date.parse(input.provenance.issued_at) > Date.now() + 5000)
    throw new ApiError(
      "invalid_request",
      "Cost provenance cannot claim a future issue time",
    );
  return withIdempotency(c, {
    replay: async (id) => {
      const row = await c.env.DB.prepare(
        "SELECT * FROM infrastructure_node_cost_facts WHERE id=?",
      )
        .bind(id)
        .first<FactRow>();
      if (!row)
        throw new ApiError("not_found", "Infrastructure cost fact not found");
      return c.json(factView(row), 201);
    },
    execute: async (lease) => {
      const completeExisting = async (row: FactRow): Promise<Response> => {
        if (row.payload !== payload)
          throw new ApiError(
            "conflict",
            "The effective period already has a different immutable cost fact",
          );
        await lease.completeStatement(row.id, 201).run();
        return c.json(factView(row), 201);
      };
      const previous = await naturalFact(c.env.DB, input);
      if (previous) return completeExisting(previous);
      const node = await c.env.DB.prepare(
        "SELECT n.id,n.region_id,r.provider FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=? AND n.region_id=?",
      )
        .bind(input.node_id, input.region_id)
        .first<{ id: string; region_id: string; provider: string }>();
      if (!node)
        throw new ApiError(
          "not_found",
          "Node not found in the specified region",
        );
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      try {
        const results = await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO infrastructure_node_cost_facts(id,node_id,region_id,provider,effective_from,effective_to,payload,recorded_at,recorded_by_key_id)
            SELECT ?,n.id,n.region_id,r.provider,?,?,?,?,? FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=? AND n.region_id=? AND r.provider=?`,
          ).bind(
            id,
            input.effective_from,
            input.effective_to,
            payload,
            now,
            principal.id,
            node.id,
            node.region_id,
            node.provider,
          ),
          lease.completeStatement(id, 201, {
            sql: "EXISTS(SELECT 1 FROM infrastructure_node_cost_facts WHERE id=?)",
            bindings: [id],
          }),
        ]);
        if (results[0]!.meta.changes !== 1)
          throw new ApiError(
            "conflict",
            "Node identity changed during cost recording",
          );
      } catch (error) {
        if (
          error instanceof Error &&
          /infrastructure_cost_period_overlap|UNIQUE constraint failed/.test(
            error.message,
          )
        ) {
          const raced = await naturalFact(c.env.DB, input);
          if (raced) return completeExisting(raced);
          throw new ApiError(
            "conflict",
            "Infrastructure cost effective periods cannot overlap",
          );
        }
        if (
          error instanceof Error &&
          /infrastructure_cost_node_identity_changed/.test(error.message)
        )
          throw new ApiError(
            "conflict",
            "Recorded infrastructure node identity cannot change",
          );
        throw error;
      }
      return c.json(
        InfrastructureCostFact.parse({
          ...input,
          id,
          provider: node.provider,
          recorded_at: now,
          verification: "owner_recorded",
        }),
        201,
      );
    },
  });
}

function hourlyCost(
  node: string,
  region: string,
  hour: number,
  facts: InfrastructureCostFact[],
): InfrastructureCostHour {
  const end = hour + COST_HOUR_MS,
    currencies = new Map<
      string,
      { amounts: ExactInfrastructureAmount[]; milliseconds: number }
    >();
  let covered = 0;
  const ordered = [...facts].sort((a, b) =>
    a.effective_from.localeCompare(b.effective_from),
  );
  let previous = hour;
  for (const fact of ordered) {
    const start = Math.max(hour, Date.parse(fact.effective_from)),
      finish = Math.min(end, Date.parse(fact.effective_to));
    if (
      start < previous ||
      start >= finish ||
      fact.node_id !== node ||
      fact.region_id !== region
    )
      throw new Error("Invalid infrastructure cost coverage");
    previous = finish;
    covered += finish - start;
    const currency = currencies.get(fact.currency) ?? {
      amounts: [],
      milliseconds: 0,
    };
    currency.amounts.push(
      prorateMonthlyCost(
        fact.monthly_amount,
        new Date(start).toISOString(),
        new Date(finish).toISOString(),
      ),
    );
    currency.milliseconds += finish - start;
    currencies.set(fact.currency, currency);
  }
  const known = [...currencies]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, value]) => ({
      currency,
      ...sumInfrastructureAmounts(value.amounts),
      covered_seconds: value.milliseconds / 1000,
    }));
  const missing = (COST_HOUR_MS - covered) / 1000;
  return InfrastructureCostHour.parse({
    node_id: node,
    region_id: region,
    start: new Date(hour).toISOString(),
    end: new Date(end).toISOString(),
    known_costs: known,
    node_cost: missing === 0 && known.length === 1 ? known[0] : null,
    unpriced_seconds: missing,
    gaps: [
      ...(missing > 0 ? ["node_rate"] : []),
      ...(known.length > 1 ? ["mixed_currencies"] : []),
    ],
    facts: ordered,
  });
}

interface PeriodRow {
  node_id: string;
  region_id: string;
  start: number;
  facts: string;
}
export async function queryInfrastructureCosts(
  c: ApiContext,
  value: InfrastructureCostsQuery,
): Promise<Response> {
  await requireScope(c, "admin");
  const query = InfrastructureCostsQuery.parse(value),
    scopeId = query.node_id ?? query.region_id!;
  const exists = query.node_id
    ? await c.env.DB.prepare(
        "SELECT id FROM nodes WHERE id=? UNION SELECT node_id id FROM infrastructure_node_cost_facts WHERE node_id=? LIMIT 1",
      )
        .bind(scopeId, scopeId)
        .first()
    : await c.env.DB.prepare(
        "SELECT id FROM regions WHERE id=? UNION SELECT region_id id FROM infrastructure_node_cost_facts WHERE region_id=? LIMIT 1",
      )
        .bind(scopeId, scopeId)
        .first();
  if (!exists)
    throw new ApiError("not_found", "Infrastructure cost scope not found");
  const [afterNode = "", afterHour = ""] = query.cursor?.split("|") ?? [];
  const count = (Date.parse(query.to) - Date.parse(query.from)) / COST_HOUR_MS,
    nodeLimit = Math.ceil((query.limit + 1) / count) + 1;
  const periods = await c.env.DB.prepare(
    `WITH RECURSIVE hours(start) AS (SELECT ? UNION ALL SELECT start+? FROM hours WHERE start+?<?),
    fact_nodes AS (
      SELECT node_id,region_id FROM infrastructure_node_cost_facts WHERE ${query.node_id ? "node_id" : "region_id"}=? AND node_id>=? GROUP BY node_id ORDER BY node_id LIMIT ?
    ), runtime_nodes AS (
      SELECT n.id node_id,n.region_id FROM nodes n WHERE ${query.node_id ? "n.id" : "n.region_id"}=? AND n.id>=?
        AND NOT EXISTS(SELECT 1 FROM infrastructure_node_cost_facts f WHERE f.node_id=n.id) ORDER BY n.id LIMIT ?
    ), scoped_nodes AS (SELECT * FROM (SELECT * FROM fact_nodes UNION ALL SELECT * FROM runtime_nodes) ORDER BY node_id LIMIT ?)
    SELECT n.node_id,n.region_id,h.start,json_group_array(CASE WHEN f.id IS NULL THEN NULL ELSE json_object('id',f.id,'node_id',f.node_id,'region_id',f.region_id,'provider',f.provider,'effective_from',f.effective_from,'effective_to',f.effective_to,'payload',f.payload,'recorded_at',f.recorded_at) END) facts
    FROM scoped_nodes n CROSS JOIN hours h LEFT JOIN infrastructure_node_cost_facts f ON f.node_id=n.node_id AND f.effective_from<strftime('%Y-%m-%dT%H:00:00.000Z',(h.start+?)/1000,'unixepoch') AND f.effective_to>strftime('%Y-%m-%dT%H:00:00.000Z',h.start/1000,'unixepoch')
    WHERE (n.node_id>? OR (n.node_id=? AND h.start>?)) GROUP BY n.node_id,h.start ORDER BY n.node_id,h.start LIMIT ?`,
  )
    .bind(
      Date.parse(query.from),
      COST_HOUR_MS,
      COST_HOUR_MS,
      Date.parse(query.to),
      scopeId,
      afterNode,
      nodeLimit,
      scopeId,
      afterNode,
      nodeLimit,
      nodeLimit,
      COST_HOUR_MS,
      afterNode,
      afterNode,
      afterHour ? Date.parse(afterHour) : -8640000000000000,
      query.limit + 1,
    )
    .all<PeriodRow>();
  const data = periods.results
    .slice(0, query.limit)
    .map((row) =>
      hourlyCost(
        row.node_id,
        row.region_id,
        row.start,
        (JSON.parse(row.facts) as (FactRow | null)[])
          .filter((fact): fact is FactRow => fact !== null)
          .map(factView),
      ),
    );
  const last = data.at(-1);
  return c.json(
    InfrastructureCostsResponse.parse({
      data,
      next_cursor:
        periods.results.length > query.limit && last
          ? `${last.node_id}|${last.start}`
          : null,
    }),
    200,
  );
}
