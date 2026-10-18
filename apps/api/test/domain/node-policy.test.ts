// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { NodePolicy } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  nodePolicy,
  refusal,
  request,
} from "./fixtures.ts";
import { nextMessage, openLink } from "./node-fixtures.ts";

afterEach(cleanupFixtures);

const path = (region: string) => `/v1/regions/${region}/node-policy`;

it("is read and set by an administrator, region by region, and refuses what the contract does not allow", async () => {
  const f = await fixture();
  expect((await request(path(f.region), f.admin)).status).toBe(404);
  const set = await request(path(f.region), f.admin, "PUT", nodePolicy());
  expect(set.status).toBe(200);
  expect(NodePolicy.parse(await set.json())).toEqual(nodePolicy());
  expect(
    NodePolicy.parse(await (await request(path(f.region), f.admin)).json()),
  ).toEqual(nodePolicy());
  // Another region keeps no policy of its own until it is set.
  expect((await request(path(f.foreign), f.admin)).status).toBe(404);
  expect((await request(path(f.region), f.integrator)).status).toBe(403);
  expect(
    (await request(path(f.region), f.integrator, "PUT", nodePolicy())).status,
  ).toBe(403);
  const invalid = await request(path(f.region), f.admin, "PUT", {
    ...nodePolicy(),
    extra: true,
  });
  expect((await refusal(invalid)).status).toBe(400);
  expect(
    (await request(path("no-such-region"), f.admin, "PUT", nodePolicy()))
      .status,
  ).toBe(404);
  expect(
    await env.DB.prepare(
      "SELECT node_policy_json FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first("node_policy_json"),
  ).toBe(JSON.stringify(nodePolicy()));
});

it("tells the connected nodes of the region to pull their page", async () => {
  const f = await fixture();
  const socket = await openLink(f);
  const hint = nextMessage(socket);
  expect(
    (await request(path(f.region), f.admin, "PUT", nodePolicy())).status,
  ).toBe(200);
  expect(JSON.parse(await hint)).toEqual({ type: "desired" });
  socket.close(1000);
});
