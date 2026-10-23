// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  addNode,
  cleanupFixtures,
  fixture,
  request,
} from "../domain/fixtures.ts";
import { NODE_OBSERVATION_MAX_AGE_MS } from "../../src/domain/placement.ts";

afterEach(cleanupFixtures);

const listed = async (key: string) =>
  (
    await (await request("/v1/regions", key)).json<{ data: { id: string }[] }>()
  ).data.map((region) => region.id);
const observedAgo = (node: string, ms: number) =>
  env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(Date.now() - ms).toISOString(), node)
    .run();

// Found live (EU1, 2026-10-23): the node was down for 27 minutes and the API kept it ready,
// schedulable and open, so the region stayed in an integrator's list of regions that accept
// placement. Placement itself already skipped a node with an old sample (`choosePlacement`).
it("a region whose only node has not reported for more than 180 s is not listed as accepting placement, and is again when the node reports", async () => {
  const f = await fixture();
  expect(await listed(f.integrator)).toContain(f.region);

  await observedAgo(f.node, NODE_OBSERVATION_MAX_AGE_MS + 5_000);
  expect(await listed(f.integrator)).not.toContain(f.region);
  // The node's flags are the operator's and the lost-node procedure's: the closure is derived
  // from the observation alone, so nothing is left to reopen when the node comes back.
  const flags = await env.DB.prepare(
    "SELECT ready,schedulable,database_placement_enabled enabled,database_placement_closed_at closed FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first();
  expect(flags).toEqual({ ready: 1, schedulable: 1, enabled: 1, closed: null });

  await observedAgo(f.node, 0);
  expect(await listed(f.integrator)).toContain(f.region);
});

it("a fresh node keeps its region listed when another node of it is silent", async () => {
  const f = await fixture();
  await observedAgo(f.node, NODE_OBSERVATION_MAX_AGE_MS + 5_000);
  expect(await listed(f.integrator)).not.toContain(f.region);
  await addNode(f.region);
  expect(await listed(f.integrator)).toContain(f.region);
});

it("a node that never reported is not open either", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=NULL WHERE id=?")
    .bind(f.node)
    .run();
  expect(await listed(f.integrator)).not.toContain(f.region);
});
