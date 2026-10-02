// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { ChaosRelay } from "./chaos-relay.ts";

test("relay completion waits for body consumption and subsequent successful observation", async () => {
  const bearer = randomBytes(32).toString("hex"),
    agent = randomBytes(32).toString("hex");
  const relay = new ChaosRelay(undefined, {
    API_URL: "https://pgcf-api.test.invalid",
    RUN_NAME: "pgcf-e2e-test",
    RUN_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    PROBE_BEARER: bearer,
    AGENT_KEY: agent,
    RELAY: {
      idFromName: () => "test",
      get: () => {
        throw new Error("unused_test_binding");
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: unknown, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(null, { status: 204 })
      : Response.json({
          region: {
            id: "test-region",
            backup: {
              bucket: "pgcf-test-backups",
              endpoint_url: "https://pgcf-r2.test.invalid",
              region: "auto",
            },
          },
          databases: [],
          next: null,
        });
  const control = (path: string, body?: unknown) =>
    relay.fetch(
      new Request(`https://pgcf-relay.test.invalid/control/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      }),
    );
  try {
    await control("capture-empty");
    await control("mode", {
      mode: "empty",
      cycle_id: randomBytes(24).toString("hex"),
    });
    const reply = await relay.fetch(
      new Request("https://pgcf-relay.test.invalid/agent/v1/desired", {
        headers: { Authorization: `Bearer ${agent}` },
      }),
    );
    const before = (await (await control("counts")).json()) as {
      observations_after_response: number;
    };
    assert.equal(before.observations_after_response, 0);
    await reply.text();
    const consumed = (await (await control("counts")).json()) as {
      completed_responses: number;
      observations_after_response: number;
    };
    assert.equal(consumed.completed_responses, 1);
    assert.equal(consumed.observations_after_response, 0);
    await relay.fetch(
      new Request("https://pgcf-relay.test.invalid/agent/v1/observations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          observed_at: new Date().toISOString(),
          nodes: [],
          databases: [],
          orphans: [],
        }),
      }),
    );
    const observed = (await (await control("counts")).json()) as {
      observations_after_response: number;
    };
    assert.equal(observed.observations_after_response, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired relay refuses control and agent requests", async () => {
  const relay = new ChaosRelay(undefined, {
    API_URL: "https://pgcf-api.test.invalid",
    RUN_NAME: "pgcf-e2e-test",
    RUN_EXPIRES_AT: new Date(Date.now() - 1).toISOString(),
    PROBE_BEARER: randomBytes(32).toString("hex"),
    AGENT_KEY: randomBytes(32).toString("hex"),
    RELAY: {
      idFromName: () => "test",
      get: () => {
        throw new Error("unused_test_binding");
      },
    },
  });
  assert.equal(
    (
      await relay.fetch(
        new Request("https://pgcf-relay.test.invalid/control/counts", {
          method: "POST",
        }),
      )
    ).status,
    410,
  );
  assert.equal(
    (
      await relay.fetch(
        new Request("https://pgcf-relay.test.invalid/agent/v1/desired"),
      )
    ).status,
    410,
  );
});
