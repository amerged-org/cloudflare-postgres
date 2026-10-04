// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { newNodeId } from "@pgcf/contracts";
import {
  InfrastructureCostFact,
  InfrastructureCostsResponse,
} from "@pgcf/contracts/costs";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const nodes: string[] = [];
afterEach(async () => {
  for (const node of nodes.splice(0))
    await env.DB.prepare(
      "DELETE FROM infrastructure_node_cost_facts WHERE node_id=?",
    )
      .bind(node)
      .run();
  await cleanupFixtures();
});
async function setup() {
  const f = await fixture();
  nodes.push(f.node);
  return f;
}
const fact = (f: Awaited<ReturnType<typeof fixture>>, overrides = {}) => ({
  node_id: f.node,
  region_id: f.region,
  monthly_amount: "744.0000",
  currency: "EUR",
  effective_from: "2025-01-01T00:00:00.000Z",
  effective_to: "2025-02-01T00:00:00.000Z",
  provenance: {
    kind: "contract",
    reference: `fixture-${crypto.randomUUID()}`,
    issued_at: "2025-01-01T00:00:00.000Z",
  },
  ...overrides,
});
async function record(
  f: Awaited<ReturnType<typeof fixture>>,
  body: unknown,
  key = f.admin,
  idempotency?: string,
) {
  return request("/v1/costs/node-facts", key, "POST", body, idempotency);
}
async function costs(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, string> = {},
  key = f.admin,
) {
  return request(
    `/v1/costs?${new URLSearchParams({ node_id: f.node, from: "2025-01-01T00:00:00.000Z", to: "2025-01-01T02:00:00.000Z", granularity: "hour", ...overrides })}`,
    key,
  );
}

describe("operator infrastructure cost metrics", () => {
  it("accepts only admin-recorded real facts, preserves provenance and exposes exact hourly cost", async () => {
    const f = await setup(),
      body = fact(f);
    expect((await record(f, body, f.integrator)).status).toBe(403);
    expect((await costs(f, {}, f.integrator)).status).toBe(403);
    const response = await record(f, body);
    expect(response.status).toBe(201);
    const saved = InfrastructureCostFact.parse(await response.json());
    expect(saved.verification).toBe("owner_recorded");
    expect(saved.provider).toBe("contabo");
    expect(saved.provenance).toEqual(body.provenance);
    const result = await costs(f);
    expect(result.status).toBe(200);
    const data = InfrastructureCostsResponse.parse(await result.json()).data;
    expect(data).toHaveLength(2);
    expect(data[0]!.node_cost).toMatchObject({
      currency: "EUR",
      numerator: "1",
      denominator: "1",
      amount: "1.000000000000",
      covered_seconds: 3600,
    });
    expect(data[0]!.gaps).toEqual([]);
    expect(data[0]!.facts[0]!.id).toBe(saved.id);
  });
  it("returns the same immutable fact on exact idempotent and natural replay", async () => {
    const f = await setup(),
      body = fact(f),
      key = crypto.randomUUID();
    const first = await record(f, body, f.admin, key),
      saved = await first.json();
    expect(first.status).toBe(201);
    const replay = await record(f, body, f.admin, key);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(saved);
    const natural = await record(f, body);
    expect(natural.status).toBe(201);
    expect(await natural.json()).toEqual(saved);
    expect(
      (await record(f, { ...body, monthly_amount: "745.0000" }, f.admin, key))
        .status,
    ).toBe(409);
    expect(
      (await record(f, { ...body, monthly_amount: "745.0000" })).status,
    ).toBe(409);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) n FROM infrastructure_node_cost_facts WHERE node_id=?",
        )
          .bind(f.node)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await expect(
      env.DB.prepare(
        "UPDATE infrastructure_node_cost_facts SET provider='changed' WHERE node_id=?",
      )
        .bind(f.node)
        .run(),
    ).rejects.toThrow("immutable");
  });
  it("serializes concurrent exact repeats and refuses a concurrent conflicting period", async () => {
    const f = await setup(),
      body = fact(f);
    const repeats = await Promise.all([record(f, body), record(f, body)]);
    expect(repeats.map((response) => response.status)).toEqual([201, 201]);
    expect(await repeats[0]!.json()).toEqual(await repeats[1]!.json());
    const next = {
      ...body,
      effective_from: "2025-02-01T00:00:00.000Z",
      effective_to: "2025-03-01T00:00:00.000Z",
    };
    const competing = await Promise.all([
      record(f, next),
      record(f, { ...next, monthly_amount: "672.0000" }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) n FROM infrastructure_node_cost_facts WHERE node_id=?",
        )
          .bind(f.node)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("binds facts to actual node/region ownership and refuses overlapping or future-issued evidence", async () => {
    const f = await setup(),
      body = fact(f);
    expect((await record(f, { ...body, node_id: newNodeId() })).status).toBe(
      404,
    );
    expect((await record(f, { ...body, region_id: f.foreign })).status).toBe(
      404,
    );
    expect(
      (
        await record(f, {
          ...body,
          provenance: {
            ...body.provenance,
            issued_at: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      ).status,
    ).toBe(400);
    expect((await record(f, body)).status).toBe(201);
    expect(
      (
        await record(f, {
          ...body,
          effective_from: "2025-01-15T00:00:00.000Z",
          effective_to: "2025-02-15T00:00:00.000Z",
        })
      ).status,
    ).toBe(409);
    expect((await record(f, body, f.otherKey)).status).toBe(403);
  });
  it("reports unknown and expired rates as null gaps even if runtime metadata has a price", async () => {
    const f = await setup();
    await env.DB.prepare(
      "UPDATE nodes SET monthly_price='999',currency='EUR' WHERE id=?",
    )
      .bind(f.node)
      .run();
    const unknown = InfrastructureCostsResponse.parse(
      await (await costs(f)).json(),
    ).data[0]!;
    expect(unknown.node_cost).toBeNull();
    expect(unknown.known_costs).toEqual([]);
    expect(unknown.gaps).toEqual(["node_rate"]);
    expect(unknown.unpriced_seconds).toBe(3600);
    expect((await record(f, fact(f))).status).toBe(201);
    const expired = InfrastructureCostsResponse.parse(
      await (
        await costs(f, {
          from: "2025-02-01T00:00:00.000Z",
          to: "2025-02-01T01:00:00.000Z",
        })
      ).json(),
    ).data[0]!;
    expect(expired.node_cost).toBeNull();
    expect(expired.gaps).toEqual(["node_rate"]);
  });
  it("uses the actual leap and short UTC month durations through real persisted facts", async () => {
    const f = await setup();
    expect(
      (
        await record(
          f,
          fact(f, {
            monthly_amount: "696.0000",
            effective_from: "2024-02-01T00:00:00.000Z",
            effective_to: "2024-03-01T00:00:00.000Z",
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await record(
          f,
          fact(f, {
            monthly_amount: "672.0000",
            effective_from: "2025-02-01T00:00:00.000Z",
            effective_to: "2025-03-01T00:00:00.000Z",
          }),
        )
      ).status,
    ).toBe(201);
    const leap = InfrastructureCostsResponse.parse(
      await (
        await costs(f, {
          from: "2024-02-29T00:00:00.000Z",
          to: "2024-02-29T01:00:00.000Z",
        })
      ).json(),
    ).data[0]!;
    const short = InfrastructureCostsResponse.parse(
      await (
        await costs(f, {
          from: "2025-02-28T00:00:00.000Z",
          to: "2025-02-28T01:00:00.000Z",
        })
      ).json(),
    ).data[0]!;
    expect(leap.node_cost?.amount).toBe("1.000000000000");
    expect(short.node_cost?.amount).toBe("1.000000000000");
  });
  it("distinguishes an explicit measured zero contract amount from an unknown rate", async () => {
    const f = await setup();
    expect(
      (await record(f, fact(f, { monthly_amount: "0.0000" }))).status,
    ).toBe(201);
    const row = InfrastructureCostsResponse.parse(await (await costs(f)).json())
      .data[0]!;
    expect(row.node_cost).toMatchObject({
      numerator: "0",
      denominator: "1",
      amount: "0.000000000000",
    });
    expect(row.gaps).toEqual([]);
    expect(row.unpriced_seconds).toBe(0);
  });
  it("never reinterprets immutable source facts using changed runtime node identity", async () => {
    const f = await setup(),
      original = fact(f);
    expect((await record(f, original)).status).toBe(201);
    await env.DB.prepare("UPDATE nodes SET region_id=? WHERE id=?")
      .bind(f.foreign, f.node)
      .run();
    expect(
      (
        await record(f, {
          ...original,
          region_id: f.foreign,
          effective_from: "2025-02-01T00:00:00.000Z",
          effective_to: "2025-03-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(409);
    const row = InfrastructureCostsResponse.parse(await (await costs(f)).json())
      .data[0]!;
    expect(row.region_id).toBe(f.region);
    expect(row.node_cost?.currency).toBe("EUR");
  });
  it("prorates partial coverage without inventing the unrecorded portion", async () => {
    const f = await setup();
    expect(
      (
        await record(
          f,
          fact(f, {
            effective_from: "2025-01-01T00:30:00.000Z",
            effective_to: "2025-01-01T02:30:00.000Z",
          }),
        )
      ).status,
    ).toBe(201);
    const rows = InfrastructureCostsResponse.parse(
      await (await costs(f)).json(),
    ).data;
    expect(rows[0]!.node_cost).toBeNull();
    expect(rows[0]!.unpriced_seconds).toBe(1800);
    expect(rows[0]!.known_costs[0]).toMatchObject({
      currency: "EUR",
      numerator: "1",
      denominator: "2",
      covered_seconds: 1800,
    });
    expect(rows[1]!.node_cost?.amount).toBe("1.000000000000");
  });
  it("keeps differing currencies separate and never converts or combines their totals", async () => {
    const f = await setup();
    expect(
      (
        await record(
          f,
          fact(f, {
            effective_from: "2024-12-31T23:30:00.000Z",
            effective_to: "2025-01-01T00:30:00.000Z",
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await record(
          f,
          fact(f, {
            currency: "USD",
            effective_from: "2025-01-01T00:30:00.000Z",
            effective_to: "2025-01-01T01:30:00.000Z",
          }),
        )
      ).status,
    ).toBe(201);
    const row = InfrastructureCostsResponse.parse(await (await costs(f)).json())
      .data[0]!;
    expect(row.node_cost).toBeNull();
    expect(row.unpriced_seconds).toBe(0);
    expect(row.gaps).toEqual(["mixed_currencies"]);
    expect(row.known_costs.map((cost) => cost.currency)).toEqual([
      "EUR",
      "USD",
    ]);
    expect(row.known_costs.map((cost) => cost.amount)).toEqual([
      "0.500000000000",
      "0.500000000000",
    ]);
  });
  it("preserves historical source facts after runtime node deletion and does not infer unknown periods", async () => {
    const f = await setup(),
      body = fact(f);
    expect((await record(f, body)).status).toBe(201);
    await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(f.node).run();
    const response = await costs(f);
    expect(response.status).toBe(200);
    expect(
      InfrastructureCostsResponse.parse(await response.json()).data[0]!
        .node_cost?.currency,
    ).toBe("EUR");
    expect((await record(f, body)).status).toBe(201);
    const missing = await costs(f, {
      from: "2025-02-01T00:00:00.000Z",
      to: "2025-02-01T01:00:00.000Z",
    });
    expect(
      InfrastructureCostsResponse.parse(await missing.json()).data[0]!
        .node_cost,
    ).toBeNull();
  });
  it("paginates aligned hourly history and rejects broad, excessive or unaligned queries", async () => {
    const f = await setup();
    expect((await record(f, fact(f))).status).toBe(201);
    const response = await costs(f, { limit: "1" });
    expect(response.status).toBe(200);
    const first = InfrastructureCostsResponse.parse(await response.json());
    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = InfrastructureCostsResponse.parse(
      await (await costs(f, { limit: "1", cursor: first.next_cursor! })).json(),
    );
    expect(second.data[0]!.start).toBe("2025-01-01T01:00:00.000Z");
    expect(second.next_cursor).toBeNull();
    expect(
      (
        await request(
          "/v1/costs?from=2025-01-01T00:00:00.000Z&to=2025-01-02T00:00:00.000Z",
          f.admin,
        )
      ).status,
    ).toBe(400);
    expect((await costs(f, { to: "2025-02-02T00:00:00.000Z" })).status).toBe(
      400,
    );
    expect((await costs(f, { from: "2025-01-01T00:01:00.000Z" })).status).toBe(
      400,
    );
    expect((await costs(f, { granularity: "day" })).status).toBe(400);
    expect((await costs(f, { limit: "101" })).status).toBe(400);
    expect(
      (await costs(f, { cursor: `${f.node}|2025-13-01T00:00:00.000Z` })).status,
    ).toBe(400);
    const openapi = await request("/v1/openapi.json", f.admin);
    expect(JSON.stringify(await openapi.json())).toContain(
      "/v1/costs/node-facts",
    );
  });
});
