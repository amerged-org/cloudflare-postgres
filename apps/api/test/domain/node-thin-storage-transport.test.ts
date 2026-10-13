// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import {
  BOOTSTRAP_RELAY_PATH,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import {
  NodeBootstrapTransport,
  NodeBootstrapTransportBatch,
} from "@pgcf/contracts/node-bootstrap";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";

const releases: string[] = [],
  regions: string[] = [];
const service = (env as unknown as { THIN_RELAY_TEST_RUNTIME: Fetcher })
  .THIN_RELAY_TEST_RUNTIME;
async function relay(region: string, action: string) {
  return service.fetch(`http://${region}.relay.test/fixture/${action}`);
}
afterEach(async () => {
  for (const region of regions.splice(0)) await relay(region, "close");
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup() {
  const f = await thinExecutionFixture(releases);
  regions.push(f.region);
  f.local.BOOTSTRAP_RELAY_SERVICE = service;
  f.local.BOOTSTRAP_RELAY_URL = `http://${f.region}.relay.test${BOOTSTRAP_RELAY_PATH}`;
  f.local.BOOTSTRAP_RELAY_ISSUER_REGION = f.region;
  const input = (await prepareThinStorageLease(f.local, f.node))!;
  return {
    ...f,
    input,
    call: (count?: number) =>
      createApp().request(
        input.callback.url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.callback.bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            kind: "transport",
            capability: "talos_api",
            ...(count === undefined ? {} : { count }),
          }),
        },
        f.local,
      ),
  };
}
it("keeps the legacy singleton and issues eight unique default-TTL grants after one real relay identity read", async () => {
  const f = await setup(),
    singleton = await f.call();
  expect(singleton.status).toBe(200);
  NodeBootstrapTransport.parse(await singleton.json());
  const before = (await (await relay(f.region, "status")).json()) as {
      requests: number;
    },
    response = await f.call(8);
  expect(response.status).toBe(200);
  const batch = NodeBootstrapTransportBatch.parse(await response.json()),
    stats = (await (await relay(f.region, "status")).json()) as {
      requests: number;
      identity: {
        region: string;
        relay_epoch: string;
        allowed_target_regions: string[];
      };
    },
    keys = await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    ),
    claims = await Promise.all(
      batch.tokens.map((token) =>
        verifyBootstrapRelay(token, {
          keys,
          region: stats.identity.region,
          issuer_region: stats.identity.region,
          relay_epoch: stats.identity.relay_epoch,
          allowedTargetRegions: stats.identity.allowed_target_regions,
        }),
      ),
    );
  expect(stats.requests - before.requests).toBe(1);
  expect(batch.tokens).toHaveLength(8);
  expect(new Set(batch.tokens).size).toBe(8);
  const nonces = [];
  for (const checked of claims) {
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error("grant_rejected");
    expect(checked.claims).toMatchObject({
      operation: f.input.lease.operation_id,
      node: f.node,
      revision: f.input.lease.revision,
      region: f.region,
      capability: "talos_api",
    });
    expect(checked.claims.exp - checked.claims.iat).toBe(30);
    nonces.push(checked.claims.nonce);
  }
  expect(new Set(nonces).size).toBe(8);
  expect(batch.expectedTarget).toEqual({
    ip: f.input.lease.address,
    port: 50000,
  });
});
it("refuses the whole batch if the real D1 lease identity changes during relay issuance", async () => {
  const f = await setup();
  await relay(f.region, "hold");
  const response = f.call(8);
  try {
    await expect
      .poll(
        async () =>
          (
            (await (await relay(f.region, "status")).json()) as {
              waiting: boolean;
            }
          ).waiting,
      )
      .toBe(true);
    await env.DB.prepare(
      "UPDATE node_thin_storage SET lease_revision=lease_revision+1 WHERE node_id=?",
    )
      .bind(f.node)
      .run();
  } finally {
    await relay(f.region, "release");
  }
  expect((await response).status).toBe(409);
});
it("rejects requests larger than the strict grant bound", async () => {
  const f = await setup();
  expect((await f.call(9)).status).toBe(400);
  expect(
    ((await (await relay(f.region, "status")).json()) as { requests: number })
      .requests,
  ).toBe(0);
});
