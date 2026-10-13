// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { listEnvelope, newOperationId } from "@pgcf/contracts";
import { FleetRelease, FleetReleaseSpec } from "@pgcf/contracts/releases";
import { FleetPatchStatus } from "@pgcf/contracts/fleet-patches";
import { installationHash } from "../../src/domain/node-installation.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approved(id: string, at = "2026-10-01T00:00:00.000Z") {
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "regional",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
  ];
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const spec = FleetReleaseSpec.parse({
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { control_relay: role, customer: role },
  });
  const value = FleetRelease.parse({
    id,
    spec,
    spec_sha256: await installationHash(spec),
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

async function patch(
  f: Fixture,
  release: FleetRelease,
  operation = newOperationId(),
  at = "2026-10-02T00:00:00.000Z",
) {
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid");
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,bootstrap_joined_reference,revision,stage,state,created_at,updated_at,deadline_at)
    VALUES(?,?,?,?,?,?,?,1,1,1,'private-transport-address','[{"private_transport_marker":"must-not-leak"}]','private-kubeconfig-reference',2,'complete','confirmed',?,?,?)`,
  )
    .bind(
      operation,
      f.node,
      f.region,
      uid,
      crypto.randomUUID(),
      release.id,
      release.spec_sha256,
      at,
      at,
      "2026-10-03T00:00:00.000Z",
    )
    .run();
  const response = await request(`/v1/fleet/patches/${operation}`, f.admin);
  expect(response.status).toBe(200);
  return FleetPatchStatus.parse(await response.json());
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

it("lists actual public patch statuses across timestamp ties without transport columns or cursor aliases", async () => {
  const f = await fixture(),
    release = await approved("r2.6-patches"),
    earlier = await patch(f, release, `op_${"a".repeat(20)}`),
    tied = await patch(f, release, `op_${"b".repeat(20)}`),
    latest = await patch(
      f,
      release,
      `op_${"c".repeat(20)}`,
      "2026-10-02T01:00:00.000Z",
    );
  const first = await request("/v1/fleet/patches?limit=2", f.admin);
  expect(first.status).toBe(200);
  const one = listEnvelope(FleetPatchStatus).parse(await first.json());
  expect(one.data).toEqual([latest, tied]);
  expect(one.next_cursor).not.toBeNull();
  const second = await request(
    `/v1/fleet/patches?limit=2&cursor=${one.next_cursor}`,
    f.admin,
  );
  expect(second.status).toBe(200);
  const two = listEnvelope(FleetPatchStatus).parse(await second.json());
  expect(two).toEqual({ data: [earlier], next_cursor: null });
  expect(JSON.stringify([one.data, two.data])).not.toContain("private-");
  expect(one.data[0]).not.toHaveProperty("id");
  expect(one.data[0]).not.toHaveProperty("address");
  expect(one.data[0]).not.toHaveProperty("cluster_nodes_json");
  expect(one.data[0]).not.toHaveProperty("bootstrap_joined_reference");
});

it("combines node, region and release filters on actual patch records without current assignment joins", async () => {
  const f = await fixture(),
    other = await fixture(),
    release = await approved("r2.6-selected"),
    different = await approved("r2.6-other"),
    matching = await patch(f, release),
    alsoMatching = await patch(f, release),
    otherRelease = await patch(f, different),
    otherRegion = await patch(other, release);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  const query = new URLSearchParams({
    node_id: f.node,
    region_id: f.region,
    release_id: release.id,
    limit: "1",
  });
  const response = await request(`/v1/fleet/patches?${query}`, f.admin);
  expect(response.status).toBe(200);
  const one = listEnvelope(FleetPatchStatus).parse(await response.json()),
    expected = [matching, alsoMatching].sort((a, b) =>
      b.operation_id.localeCompare(a.operation_id),
    );
  expect(one.data).toEqual([expected[0]]);
  expect(one.next_cursor).not.toBeNull();
  query.set("cursor", one.next_cursor!);
  const next = await request(`/v1/fleet/patches?${query}`, f.admin);
  expect(listEnvelope(FleetPatchStatus).parse(await next.json())).toEqual({
    data: [expected[1]],
    next_cursor: null,
  });
  query.delete("cursor");
  query.delete("limit");
  query.delete("node_id");
  query.delete("region_id");
  const releaseMatches = await request(`/v1/fleet/patches?${query}`, f.admin);
  expect(
    listEnvelope(FleetPatchStatus).parse(await releaseMatches.json()).data,
  ).toEqual(
    [matching, alsoMatching, otherRegion].sort((a, b) =>
      b.operation_id.localeCompare(a.operation_id),
    ),
  );
  query.set("region_id", f.region);
  query.delete("release_id");
  const regionMatches = await request(`/v1/fleet/patches?${query}`, f.admin);
  expect(
    listEnvelope(FleetPatchStatus).parse(await regionMatches.json()).data,
  ).toEqual(
    [matching, alsoMatching, otherRelease].sort((a, b) =>
      b.operation_id.localeCompare(a.operation_id),
    ),
  );
  query.set("node_id", other.node);
  const none = await request(`/v1/fleet/patches?${query}`, f.admin);
  expect(await none.json()).toEqual({ data: [], next_cursor: null });
});

it("requires administrator scope for both lists", async () => {
  const f = await fixture();
  expect((await request("/v1/fleet/releases", f.integrator)).status).toBe(403);
  expect((await request("/v1/fleet/patches", f.integrator)).status).toBe(403);
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
  const releases = document.paths["/v1/fleet/releases"]!.get!,
    patches = document.paths["/v1/fleet/patches"]!.get!;
  expect({
    operationId: releases.operationId,
    summary: releases.summary,
  }).toEqual({
    operationId: "listFleetReleases",
    summary: "List approved fleet releases",
  });
  expect({
    operationId: patches.operationId,
    summary: patches.summary,
  }).toEqual({
    operationId: "listFleetPatches",
    summary: "List recorded fleet patch operations",
  });
  const ids = Object.values(document.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  expect(ids.filter((id) => id === releases.operationId)).toHaveLength(1);
  expect(ids.filter((id) => id === patches.operationId)).toHaveLength(1);
  expect(Object.keys(releases.responses).sort()).toEqual([
    "200",
    "400",
    "401",
    "403",
    "500",
  ]);
  expect(Object.keys(patches.responses).sort()).toEqual([
    "200",
    "400",
    "401",
    "403",
    "500",
  ]);
  const error =
    document.paths["/v1/fleet/releases/{id}"]!.get!.responses["500"]!.content[
      "application/json"
    ]!.schema;
  expect(
    releases.responses["500"]!.content["application/json"]!.schema,
  ).toEqual(error);
  expect(patches.responses["500"]!.content["application/json"]!.schema).toEqual(
    error,
  );
});

it("returns empty envelopes for empty history and valid unknown patch filters", async () => {
  const f = await fixture();
  const release = await request("/v1/fleet/releases", f.admin);
  expect(release.status).toBe(200);
  expect(await release.json()).toEqual({ data: [], next_cursor: null });
  const patches = await request(
    "/v1/fleet/patches?release_id=missing.release&region_id=missing-region",
    f.admin,
  );
  expect(patches.status).toBe(200);
  expect(await patches.json()).toEqual({ data: [], next_cursor: null });
});

it("rejects invalid bounds, cursors, patch identifiers and unknown filters", async () => {
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
  expect(
    (await request("/v1/fleet/patches?node_id=invalid", f.admin)).status,
  ).toBe(400);
  expect(
    (await request("/v1/fleet/patches?region_id=INVALID", f.admin)).status,
  ).toBe(400);
  expect(
    (await request("/v1/fleet/patches?release_id=invalid%2Frelease", f.admin))
      .status,
  ).toBe(400);
  expect(
    (await request("/v1/fleet/patches?address=private", f.admin)).status,
  ).toBe(400);
  expect(
    (await request("/v1/fleet/patches?cursor=not-base64!", f.admin)).status,
  ).toBe(400);
});
