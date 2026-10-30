// SPDX-License-Identifier: Apache-2.0
import { connection, statements, transaction } from "@pgcf/contracts/edge-sql";
import { describe, expect, it } from "vitest";
import {
  buildJobRequest,
  classifyJobResponse,
} from "../../src/domain/schedule-outcome.ts";

const CONNECTION =
  "postgres://job:test-password@db.example.com/abcdefghijklmnopqrst";

describe("classifyJobResponse", () => {
  it("reports no response as an unknown outcome and a 200 as a success", () => {
    expect(
      classifyJobResponse({
        status: null,
        body: null,
        retryAfterSeconds: null,
      }),
    ).toEqual({
      outcome: "outcome_unknown",
      sqlstate: null,
      retryAfterSeconds: null,
    });
    expect(
      classifyJobResponse({
        status: 200,
        body: { results: [] },
        retryAfterSeconds: null,
      }),
    ).toEqual({
      outcome: "succeeded",
      sqlstate: null,
      retryAfterSeconds: null,
    });
  });

  it("classifies a 400 by its SQLSTATE: timeouts, unknown outcomes, refusals with nothing run, configuration and other failures", () => {
    const at = (code: string, retryAfterSeconds: number | null = null) =>
      classifyJobResponse({
        status: 400,
        body: { message: "m", code, severity: "ERROR" },
        retryAfterSeconds,
      });
    expect(at("57014")).toEqual({
      outcome: "timed_out",
      sqlstate: "57014",
      retryAfterSeconds: null,
    });
    expect(at("08007")).toEqual({
      outcome: "outcome_unknown",
      sqlstate: "08007",
      retryAfterSeconds: null,
    });
    for (const code of ["57P03", "08006", "53300"]) {
      expect(at(code, 4)).toEqual({
        outcome: "capacity_refused",
        sqlstate: code,
        retryAfterSeconds: 4,
      });
    }
    for (const code of ["28P01", "28000", "3D000", "0A000", "08P01"]) {
      expect(at(code, 4)).toEqual({
        outcome: "rejected",
        sqlstate: code,
        retryAfterSeconds: null,
      });
    }
    expect(at("42601")).toEqual({
      outcome: "failed",
      sqlstate: "42601",
      retryAfterSeconds: null,
    });
  });

  it("classifies the HTTP statuses of refusals and an uncertain answer", () => {
    expect(
      classifyJobResponse({ status: 429, body: null, retryAfterSeconds: 7 }),
    ).toEqual({
      outcome: "capacity_refused",
      sqlstate: null,
      retryAfterSeconds: 7,
    });
    for (const status of [401, 403, 404, 400]) {
      expect(
        classifyJobResponse({ status, body: null, retryAfterSeconds: 7 }),
      ).toEqual({
        outcome: "rejected",
        sqlstate: null,
        retryAfterSeconds: null,
      });
    }
    expect(
      classifyJobResponse({ status: 502, body: null, retryAfterSeconds: null }),
    ).toEqual({
      outcome: "outcome_unknown",
      sqlstate: null,
      retryAfterSeconds: null,
    });
  });

  it("never reads a SQLSTATE from a response that may have been forwarded", () => {
    for (const status of [500, 502]) {
      expect(
        classifyJobResponse({
          status,
          body: { code: "42601" },
          retryAfterSeconds: 3,
        }),
      ).toEqual({
        outcome: "outcome_unknown",
        sqlstate: null,
        retryAfterSeconds: null,
      });
    }
    for (const status of [301, 413]) {
      expect(
        classifyJobResponse({ status, body: null, retryAfterSeconds: null }),
      ).toEqual({
        outcome: "outcome_unknown",
        sqlstate: null,
        retryAfterSeconds: null,
      });
    }
  });

  it("treats a 400 whose code is not a string, or whose body is not an object, as a plain rejection", () => {
    expect(
      classifyJobResponse({
        status: 400,
        body: { code: 57014 },
        retryAfterSeconds: null,
      }),
    ).toEqual({
      outcome: "rejected",
      sqlstate: null,
      retryAfterSeconds: null,
    });
    expect(
      classifyJobResponse({
        status: 400,
        body: [{ code: "57014" }],
        retryAfterSeconds: null,
      }),
    ).toEqual({
      outcome: "rejected",
      sqlstate: null,
      retryAfterSeconds: null,
    });
  });
});

describe("buildJobRequest", () => {
  it("rejects a timeout outside 1 s to 900 s and a statement list of the wrong size", () => {
    const base = { connectionString: CONNECTION, statements: ["SELECT 1"] };
    expect(() => buildJobRequest({ ...base, timeoutMs: 999 })).toThrow(
      RangeError,
    );
    expect(() => buildJobRequest({ ...base, timeoutMs: 900_001 })).toThrow(
      RangeError,
    );
    expect(() => buildJobRequest({ ...base, timeoutMs: 1_500.5 })).toThrow(
      RangeError,
    );
    expect(() => buildJobRequest({ ...base, timeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() =>
      buildJobRequest({
        connectionString: CONNECTION,
        statements: [],
        timeoutMs: 1_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildJobRequest({
        connectionString: CONNECTION,
        statements: [" "],
        timeoutMs: 1_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildJobRequest({
        connectionString: CONNECTION,
        statements: Array.from({ length: 256 }, () => "SELECT 1"),
        timeoutMs: 1_000,
      }),
    ).toThrow(RangeError);
  });

  it("accepts the inclusive timeout bounds and the largest statement list", () => {
    const one = ["SELECT 1"];
    expect(() =>
      buildJobRequest({
        connectionString: CONNECTION,
        statements: one,
        timeoutMs: 1_000,
      }),
    ).not.toThrow();
    expect(() =>
      buildJobRequest({
        connectionString: CONNECTION,
        statements: one,
        timeoutMs: 900_000,
      }),
    ).not.toThrow();
    const { body } = buildJobRequest({
      connectionString: CONNECTION,
      statements: Array.from({ length: 255 }, () => "SELECT 1"),
      timeoutMs: 1_000,
    });
    expect(statements(body).queries).toHaveLength(256);
  });

  it("rejects sparse statement lists and non-string statements as a RangeError", () => {
    const base = { connectionString: CONNECTION, timeoutMs: 1_000 };
    expect(() =>
      buildJobRequest({ ...base, statements: new Array(2) }),
    ).toThrow(RangeError);
    expect(() =>
      buildJobRequest({ ...base, statements: [1 as never] }),
    ).toThrow(RangeError);
    expect(() =>
      buildJobRequest({ ...base, statements: [null as never] }),
    ).toThrow(RangeError);
  });

  it("is accepted by the Edge's real parsers, with the timeout as the first statement", () => {
    const { headers, body } = buildJobRequest({
      connectionString: CONNECTION,
      statements: ["SELECT $1::int", "UPDATE jobs SET done = true"],
      timeoutMs: 30_000,
    });
    const parsed = new Headers(headers);
    expect(connection(parsed)).toEqual({
      database: "abcdefghijklmnopqrst",
      user: "job",
      password: "test-password",
    });
    expect(transaction(parsed)).toEqual({});
    expect(parsed.get("Content-Type")).toBe("application/json");
    expect(body).not.toContain("test-password");
    expect(body).not.toContain(CONNECTION);
    const understood = statements(body);
    expect(understood.batch).toBe(true);
    expect(understood.queries.map((query) => query.query)).toEqual([
      "SET LOCAL statement_timeout = 30000",
      "SELECT $1::int",
      "UPDATE jobs SET done = true",
    ]);
  });
});
