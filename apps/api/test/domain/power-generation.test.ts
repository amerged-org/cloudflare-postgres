// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, ErrorBody } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  report,
  request,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

async function ready() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  expect(await verdicts(await report(f, created.database.id, 1))).toEqual([
    "accept",
  ]);
  return { ...f, id: created.database.id };
}
type Fixture = Awaited<ReturnType<typeof ready>>;
const power = (
  f: Fixture,
  action: "suspend" | "resume",
  body?: unknown,
  key?: string,
  DB?: D1Database,
  auth = f.integrator,
) =>
  request(
    `/v1/databases/${f.id}/${action}`,
    auth,
    "POST",
    body,
    key,
    undefined,
    DB ? { DB } : undefined,
  );
const accepted = async (response: Response) => {
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json());
};
const generationChanged = async (response: Response) => {
  expect(response.status).toBe(409);
  expect(ErrorBody.parse(await response.json()).error).toMatchObject({
    code: "conflict",
    details: { reason: "generation_changed" },
  });
};

/** Forward to real D1; interleave operator requests after a database read or committed noop. */
function afterPowerBoundary(
  read: number | "noop",
  callback: () => Promise<void>,
): D1Database {
  let reads = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const noopStatements = new WeakSet<D1PreparedStatement>();
  const isNoop = (sql: string) =>
    sql.includes("SELECT ?,'database.resume','succeeded'");
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...args: Parameters<D1PreparedStatement["bind"]>) =>
            wrap(target.bind(...args), sql);
        if (property === "first" && sql.startsWith("SELECT d.*,"))
          return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            const result = await target.first(...args);
            if (++reads === read) await callback();
            return result;
          };
        if (property === "run" && read === "noop" && isNoop(sql))
          return async () => {
            const result = await target.run();
            await callback();
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    if (isNoop(sql)) noopStatements.add(proxy);
    return proxy;
  };
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(
            statements.map(
              (statement) => originals.get(statement) ?? statement,
            ),
          );
          if (
            read === "noop" &&
            statements.some((statement) => noopStatements.has(statement))
          )
            await callback();
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("refuses an old policy resume after an operator resumes and stops the database again", async () => {
  const f = await ready();
  const policy = await accepted(
    await power(f, "suspend", { expected_generation: 1 }),
  );
  const resumed = await accepted(
    await power(f, "resume", undefined, undefined, undefined, f.admin),
  );
  expect(
    await verdicts(await report(f, f.id, resumed.database.generation)),
  ).toEqual(["accept"]);
  const stopped = await accepted(
    await power(f, "suspend", undefined, undefined, undefined, f.admin),
  );
  await generationChanged(
    await power(f, "resume", {
      expected_generation: policy.database.generation,
    }),
  );
  expect(
    await env.DB.prepare(
      "SELECT generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    generation: stopped.database.generation,
    power_operation: stopped.operation.id,
  });
});

it("refuses a stale suspend instead of adopting the operator's same-state operation", async () => {
  const f = await ready();
  const stopped = await accepted(
    await power(f, "suspend", undefined, undefined, undefined, f.admin),
  );
  await generationChanged(
    await power(f, "suspend", { expected_generation: 1 }),
  );
  expect(
    (
      await accepted(
        await power(f, "suspend", {
          expected_generation: stopped.database.generation,
        }),
      )
    ).operation.id,
  ).toBe(stopped.operation.id);
});

it("checks the generation at the same-state lease completion after its authoritative read races", async () => {
  const f = await ready();
  const stopped = await accepted(await power(f, "suspend"));
  let operatorOperation: string | undefined;
  const DB = afterPowerBoundary(2, async () => {
    const resumed = await accepted(
      await power(f, "resume", undefined, undefined, undefined, f.admin),
    );
    expect(
      await verdicts(await report(f, f.id, resumed.database.generation)),
    ).toEqual(["accept"]);
    operatorOperation = (
      await accepted(
        await power(f, "suspend", undefined, undefined, undefined, f.admin),
      )
    ).operation.id;
  });
  await generationChanged(
    await power(
      f,
      "suspend",
      { expected_generation: stopped.database.generation },
      undefined,
      DB,
    ),
  );
  expect(
    await env.DB.prepare("SELECT power_operation FROM databases WHERE id=?")
      .bind(f.id)
      .first("power_operation"),
  ).toBe(operatorOperation);
});

it("refuses a ready resume noop when an operator stops after the authoritative read", async () => {
  const f = await ready();
  const DB = afterPowerBoundary(2, async () => {
    await accepted(
      await power(f, "suspend", undefined, undefined, undefined, f.admin),
    );
  });
  await generationChanged(
    await power(f, "resume", { expected_generation: 1 }, undefined, DB),
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resume'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("guards a normal power transition when an operator wins after the authoritative read", async () => {
  const f = await ready();
  const DB = afterPowerBoundary(2, async () => {
    await accepted(
      await power(f, "suspend", undefined, undefined, undefined, f.admin),
    );
  });
  await generationChanged(
    await power(f, "suspend", { expected_generation: 1 }, undefined, DB),
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.suspend'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});

it("replays its accepted operation after a lost response and later operator generation changes", async () => {
  const f = await ready();
  const key = crypto.randomUUID();
  const body = { expected_generation: 1 };
  const DB = afterPowerBoundary(3, async () => {
    throw new Error("Network connection lost.");
  });
  expect((await power(f, "suspend", body, key, DB)).status).toBe(500);
  const ownOperation = await env.DB.prepare(
    "SELECT resource_id FROM idempotency_keys WHERE key=? AND state='completed'",
  )
    .bind(key)
    .first("resource_id");
  expect(ownOperation).toBeTypeOf("string");
  const resumed = await accepted(
    await power(f, "resume", undefined, undefined, undefined, f.admin),
  );
  expect(
    await verdicts(await report(f, f.id, resumed.database.generation)),
  ).toEqual(["accept"]);
  await accepted(
    await power(f, "suspend", undefined, undefined, undefined, f.admin),
  );
  expect(
    (await accepted(await power(f, "suspend", body, key))).operation.id,
  ).toBe(ownOperation);
  expect(
    (await power(f, "suspend", { expected_generation: 4 }, key)).status,
  ).toBe(409);
});

it("validates the optional strict power body while preserving empty requests with either content type", async () => {
  const f = await ready();
  for (const body of [
    { expected_generation: 0 },
    { expected_generation: 1.5 },
    { expected_generation: Number.MAX_SAFE_INTEGER + 1 },
    { expected_generation: "1" },
    { unexpected: 1 },
    null,
  ]) {
    const response = await power(f, "resume", body);
    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).error.code).toBe(
      "invalid_request",
    );
  }
  for (const headers of [undefined, { "Content-Type": "application/json" }]) {
    await accepted(
      await request(
        `/v1/databases/${f.id}/resume`,
        f.integrator,
        "POST",
        undefined,
        undefined,
        headers,
      ),
    );
  }
  await accepted(await power(f, "resume", {}));
  await accepted(await power(f, "resume", { expected_generation: 1 }));
});

it("commits a ready resume noop and its replay identity atomically before an operator wins", async () => {
  const f = await ready();
  const key = crypto.randomUUID();
  const body = { expected_generation: 1 };
  const DB = afterPowerBoundary("noop", async () => {
    await accepted(
      await power(f, "suspend", undefined, undefined, undefined, f.admin),
    );
    throw new Error("Network connection lost.");
  });
  expect((await power(f, "resume", body, key, DB)).status).toBe(500);
  const ownOperation = await env.DB.prepare(
    "SELECT resource_id FROM idempotency_keys WHERE key=? AND state='completed'",
  )
    .bind(key)
    .first("resource_id");
  expect(ownOperation).toBeTypeOf("string");
  const replay = await accepted(await power(f, "resume", body, key));
  expect(replay.operation).toMatchObject({
    id: ownOperation,
    kind: "database.resume",
    generation: 1,
    status: "succeeded",
  });
  expect(replay.database).toMatchObject({
    generation: 2,
    desired_state: "suspended",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resume'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});

it("publishes the optional strict generation precondition on both power endpoints", async () => {
  const f = await fixture();
  const response = await request("/v1/openapi.json", f.integrator);
  expect(response.status).toBe(200);
  const document = await response.json<{
    paths: Record<
      string,
      {
        post: {
          description: string;
          requestBody: {
            required: boolean;
            content: {
              "application/json": {
                schema: {
                  type: string;
                  additionalProperties: boolean;
                  required?: string[];
                  properties: {
                    expected_generation: {
                      type: string;
                      maximum: number;
                      description: string;
                    };
                  };
                };
              };
            };
          };
        };
      }
    >;
  }>();
  for (const action of ["suspend", "resume"]) {
    const operation = document.paths[`/v1/databases/{id}/${action}`]!.post;
    expect(operation.description).toContain(
      "original operation even after the generation advances",
    );
    expect(operation.requestBody.required).toBe(false);
    const schema = operation.requestBody.content["application/json"].schema;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(schema.required ?? []).not.toContain("expected_generation");
    expect(schema.properties.expected_generation).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(schema.properties.expected_generation.description).toContain(
      "current generation",
    );
  }
});
