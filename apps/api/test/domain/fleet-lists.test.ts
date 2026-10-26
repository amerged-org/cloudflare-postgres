// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { bytesToHex, listEnvelope } from "@pgcf/contracts";
import { FleetRelease, FleetReleaseSpec } from "@pgcf/contracts/releases";
import { cleanupFixtures, fixture, releaseSpec, request } from "./fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

async function approved(id: string, at = "2026-10-01T00:00:00.000Z") {
  const spec = FleetReleaseSpec.parse(releaseSpec());
  const value = FleetRelease.parse({
    id,
    spec,
    spec_sha256: bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(spec)),
        ),
      ),
    ),
    approved_at: at,
  });
  releases.push(id);
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
  )
    .bind(id, JSON.stringify(spec), value.spec_sha256, at)
    .run();
  return value;
}

it("lists actual immutable approvals by approved timestamp and full release ID across tied cursor pages", async () => {
  const f = await fixture(),
    earlier = await approved("8r2.6-older"),
    tied = await approved("r2.6-alpha"),
    latest = await approved(
      `9r2.6-${"a".repeat(90)}`,
      "2026-10-02T00:00:00.000Z",
    );
  const first = await request("/v1/fleet/releases?limit=1", f.admin);
  expect(first.status).toBe(200);
  const one = listEnvelope(FleetRelease).parse(await first.json());
  expect(one.data).toEqual([latest]);
  expect(one.next_cursor).not.toBeNull();
  const second = await request(
    `/v1/fleet/releases?limit=1&cursor=${one.next_cursor}`,
    f.admin,
  );
  expect(second.status).toBe(200);
  const two = listEnvelope(FleetRelease).parse(await second.json());
  expect(two.data).toEqual([tied]);
  expect(two.next_cursor).not.toBeNull();
  const third = await request(
    `/v1/fleet/releases?limit=1&cursor=${two.next_cursor}`,
    f.admin,
  );
  expect(third.status).toBe(200);
  const three = listEnvelope(FleetRelease).parse(await third.json());
  expect(three).toEqual({ data: [earlier], next_cursor: null });
  const detail = await request(`/v1/fleet/releases/${tied.id}`, f.admin);
  expect(await detail.json()).toEqual(two.data[0]);
  expect(JSON.stringify([one.data, two.data, three.data])).not.toContain(
    "created_at",
  );
});

it("requires administrator scope for the release list", async () => {
  const f = await fixture();
  expect((await request("/v1/fleet/releases", f.integrator)).status).toBe(403);
});

it("documents unique list operation IDs, meaningful summaries and only actual error responses", async () => {
  const f = await fixture();
  const response = await request("/v1/openapi.json", f.admin);
  expect(response.status).toBe(200);
  const document = await response.json<{
    paths: Record<
      string,
      Record<
        string,
        {
          operationId?: string;
          summary?: string;
          responses: Record<
            string,
            { content: Record<string, { schema: unknown }> }
          >;
        }
      >
    >;
  }>();
  const releases = document.paths["/v1/fleet/releases"]!.get!;
  expect({
    operationId: releases.operationId,
    summary: releases.summary,
  }).toEqual({
    operationId: "listFleetReleases",
    summary: "List approved fleet releases",
  });
  const ids = Object.values(document.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  expect(ids.filter((id) => id === releases.operationId)).toHaveLength(1);
  expect(Object.keys(releases.responses).sort()).toEqual([
    "200",
    "400",
    "401",
    "403",
    "500",
    "503",
  ]);
  const error =
    document.paths["/v1/fleet/releases/{id}"]!.get!.responses["500"]!.content[
      "application/json"
    ]!.schema;
  expect(
    releases.responses["500"]!.content["application/json"]!.schema,
  ).toEqual(error);
});

it("returns an empty envelope for empty history", async () => {
  const f = await fixture();
  const release = await request("/v1/fleet/releases", f.admin);
  expect(release.status).toBe(200);
  expect(await release.json()).toEqual({ data: [], next_cursor: null });
});

it("rejects invalid bounds, cursors and unknown filters", async () => {
  const f = await fixture();
  expect((await request("/v1/fleet/releases?limit=101", f.admin)).status).toBe(
    400,
  );
  expect(
    (await request("/v1/fleet/releases?cursor=not-base64!", f.admin)).status,
  ).toBe(400);
  expect(
    (await request("/v1/fleet/releases?region_id=unrelated", f.admin)).status,
  ).toBe(400);
});
