// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { NodeId, RegionId } from "./ids.ts";
export const COST_HOUR_MS = 3_600_000;
export const MonthlyInfrastructureAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})\.\d{4}$/);
export const InfrastructureCurrency = z.string().regex(/^[A-Z]{3}$/);
export const InfrastructureCostFactCreate = z
  .strictObject({
    node_id: NodeId,
    region_id: RegionId,
    monthly_amount: MonthlyInfrastructureAmount,
    currency: InfrastructureCurrency,
    effective_from: Timestamp,
    effective_to: Timestamp,
    provenance: z.strictObject({
      kind: z.enum(["contract", "invoice"]),
      reference: z.string().trim().min(1).max(200),
      issued_at: Timestamp,
    }),
  })
  .superRefine((fact, context) => {
    const duration =
      Date.parse(fact.effective_to) - Date.parse(fact.effective_from);
    if (duration < COST_HOUR_MS || duration > 366 * 24 * COST_HOUR_MS)
      context.addIssue({
        code: "custom",
        message:
          "A fixed-rate effective period must cover one hour to 366 days",
      });
  })
  .meta({ id: "InfrastructureCostFactCreate" });
export type InfrastructureCostFactCreate = z.infer<
  typeof InfrastructureCostFactCreate
>;
export const InfrastructureCostFact = InfrastructureCostFactCreate.safeExtend({
  id: z.uuid(),
  provider: z.string().min(2).max(32),
  recorded_at: Timestamp,
  verification: z.literal("owner_recorded"),
}).meta({ id: "InfrastructureCostFact" });
export type InfrastructureCostFact = z.infer<typeof InfrastructureCostFact>;
const Cursor = z
  .string()
  .regex(/^nod_[a-z0-9]{20}\|\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
export const InfrastructureCostsQuery = z
  .strictObject({
    node_id: NodeId.optional(),
    region_id: RegionId.optional(),
    from: Timestamp,
    to: Timestamp,
    granularity: z.literal("hour").default("hour"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Cursor.optional(),
  })
  .superRefine((query, context) => {
    const from = Date.parse(query.from),
      to = Date.parse(query.to);
    if (query.cursor !== undefined) {
      const [node, time] = query.cursor.split("|");
      if (
        !Timestamp.safeParse(time).success ||
        Date.parse(time!) < from ||
        Date.parse(time!) >= to ||
        (query.node_id !== undefined && node !== query.node_id)
      )
        context.addIssue({
          code: "custom",
          path: ["cursor"],
          message: "Cursor must belong to this node scope and UTC interval",
        });
    }
    if (
      (query.node_id === undefined) === (query.region_id === undefined) ||
      to <= from ||
      to - from > 31 * 24 * COST_HOUR_MS ||
      from % COST_HOUR_MS !== 0 ||
      to % COST_HOUR_MS !== 0
    )
      context.addIssue({
        code: "custom",
        message:
          "Use exactly one node/region scope and aligned hourly UTC boundaries of at most 31 days",
      });
  })
  .meta({ id: "InfrastructureCostsQuery" });
export type InfrastructureCostsQuery = z.infer<typeof InfrastructureCostsQuery>;
const FractionInteger = z.string().regex(/^\d{1,80}$/);
export const ExactInfrastructureAmount = z.strictObject({
  amount: z.string().regex(/^\d+\.\d{12}$/),
  numerator: FractionInteger,
  denominator: FractionInteger.refine((value) => BigInt(value) > 0n),
});
export type ExactInfrastructureAmount = z.infer<
  typeof ExactInfrastructureAmount
>;
export const InfrastructureCurrencyCost = ExactInfrastructureAmount.safeExtend({
  currency: InfrastructureCurrency,
  covered_seconds: z.number().nonnegative().max(3600),
});
export const InfrastructureCostHour = z
  .strictObject({
    node_id: NodeId,
    region_id: RegionId,
    start: Timestamp,
    end: Timestamp,
    node_cost: InfrastructureCurrencyCost.nullable(),
    known_costs: z.array(InfrastructureCurrencyCost).max(2),
    unpriced_seconds: z.number().nonnegative().max(3600),
    gaps: z.array(z.enum(["node_rate", "mixed_currencies"])).max(2),
    facts: z.array(InfrastructureCostFact).max(2),
  })
  .meta({ id: "InfrastructureCostHour" });
export type InfrastructureCostHour = z.infer<typeof InfrastructureCostHour>;
export const InfrastructureCostsResponse = z
  .strictObject({
    data: z.array(InfrastructureCostHour).max(100),
    next_cursor: Cursor.nullable(),
  })
  .meta({ id: "InfrastructureCostsResponse" });
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}
export function exactInfrastructureAmount(
  numerator: bigint,
  denominator: bigint,
): ExactInfrastructureAmount {
  if (numerator < 0n || denominator <= 0n)
    throw new TypeError("Invalid infrastructure fraction");
  const factor = gcd(numerator, denominator),
    n = numerator / factor,
    d = denominator / factor;
  const precision = 1_000_000_000_000n,
    display = (n * precision + d / 2n) / d;
  return ExactInfrastructureAmount.parse({
    numerator: n.toString(),
    denominator: d.toString(),
    amount: `${display / precision}.${(display % precision).toString().padStart(12, "0")}`,
  });
}
export function sumInfrastructureAmounts(
  values: ExactInfrastructureAmount[],
): ExactInfrastructureAmount {
  let numerator = 0n,
    denominator = 1n;
  for (const value of values) {
    ExactInfrastructureAmount.parse(value);
    const n = BigInt(value.numerator),
      d = BigInt(value.denominator);
    numerator = numerator * d + n * denominator;
    denominator *= d;
    const factor = gcd(numerator, denominator);
    numerator /= factor;
    denominator /= factor;
  }
  return exactInfrastructureAmount(numerator, denominator);
}
export function prorateMonthlyCost(
  monthlyAmount: string,
  from: string,
  to: string,
): ExactInfrastructureAmount {
  MonthlyInfrastructureAmount.parse(monthlyAmount);
  Timestamp.parse(from);
  Timestamp.parse(to);
  const end = Date.parse(to);
  let cursor = Date.parse(from);
  if (end <= cursor || end - cursor > 366 * 24 * COST_HOUR_MS)
    throw new TypeError("Invalid infrastructure interval");
  const units = BigInt(monthlyAmount.replace(".", "")),
    parts: ExactInfrastructureAmount[] = [];
  while (cursor < end) {
    const month = new Date(cursor);
    month.setUTCDate(1);
    month.setUTCHours(0, 0, 0, 0);
    const next = new Date(month);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const finish = Math.min(end, next.getTime());
    parts.push(
      exactInfrastructureAmount(
        units * BigInt(finish - cursor),
        10_000n * BigInt(next.getTime() - month.getTime()),
      ),
    );
    cursor = finish;
  }
  return sumInfrastructureAmounts(parts);
}
