// SPDX-License-Identifier: Apache-2.0
// Counts the D1 statements and round trips of a unit of work against the real local D1 binding.
// The app and the tests share one binding class, so the prototype sees every statement.
import { env } from "cloudflare:workers";
import { vi } from "vitest";

export interface StatementCount {
  /** Every executed statement, a batch's members included. */
  statements: number;
  /** Awaited calls to D1: one per lone statement and one per batch. */
  roundTrips: number;
  /** The SQL of every executed statement in execution order. */
  sql: string[];
}

/** Runs `work` with the D1 binding's `prepare` and `batch` observed, then restores both. */
export async function countStatements<T>(
  work: () => Promise<T>,
): Promise<StatementCount & { result: T }> {
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const prepare = prototype.prepare,
    batch = prototype.batch;
  const real = new WeakMap<object, D1PreparedStatement>(),
    text = new WeakMap<object, string>(),
    sql: string[] = [];
  let roundTrips = 0;
  const prepareSpy = vi
    .spyOn(prototype, "prepare")
    .mockImplementation(function (this: D1Database, query: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy: D1PreparedStatement = new Proxy(statement, {
          get(target, property) {
            if (property === "bind")
              return (...values: unknown[]) => wrap(target.bind(...values));
            if (["first", "all", "run", "raw"].includes(String(property)))
              return (...args: unknown[]) => {
                roundTrips++;
                sql.push(query);
                return Reflect.apply(
                  Reflect.get(target, property) as (...a: unknown[]) => unknown,
                  target,
                  args,
                );
              };
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
        real.set(proxy, statement);
        text.set(proxy, query);
        return proxy;
      };
      return wrap(prepare.call(this, query));
    });
  const batchSpy = vi.spyOn(prototype, "batch").mockImplementation(function (
    this: D1Database,
    statements: D1PreparedStatement[],
  ) {
    roundTrips++;
    for (const statement of statements)
      sql.push(text.get(statement) ?? "unknown statement");
    return batch.call(
      this,
      statements.map((statement) => real.get(statement) ?? statement),
    );
  });
  try {
    const result = await work();
    return { result, statements: sql.length, roundTrips, sql: [...sql] };
  } finally {
    prepareSpy.mockRestore();
    batchSpy.mockRestore();
  }
}
