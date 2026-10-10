// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { readSelectedNodeGoldenImage } from "../../src/domain/node-golden-image.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup(golden = true) {
  const f = await fixture(),
    id = `golden-${crypto.randomUUID()}`,
    names = [
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
  releases.push(id);
  const role = {
    talos_version: "1.14.2",
    talos_installer: `registry.example/installer@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const raw = {
    url: `https://artifacts.example/v1/sha256/${"e".repeat(64)}`,
    sha256: "e".repeat(64),
    format: "raw.xz",
    bytes: 104857600,
    raw_sha256: "f".repeat(64),
    raw_bytes: 4294967296,
  };
  const spec = {
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    ...(golden ? { talos_raw_image: raw } : {}),
    components: names.map((name) => ({
      name,
      kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { customer: role, control_relay: structuredClone(role) },
  };
  return { ...f, id, raw, spec };
}
it("only an unselected region retains the original Factory fallback", async () => {
  const f = await setup(false);
  expect(await readSelectedNodeGoldenImage(env, f.region)).toBeNull();
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.admin, "PUT", f.spec))
      .status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        release_id: f.id,
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);
  await expect(readSelectedNodeGoldenImage(env, f.region)).rejects.toThrow(
    /golden|raw/i,
  );
});
it("an approved selected release supplies the same pinned raw disk and installer before AddNode postjoin", async () => {
  const f = await setup();
  const approved = await request(
    `/v1/fleet/releases/${f.id}`,
    f.admin,
    "PUT",
    f.spec,
  );
  expect(approved.status).toBe(200);
  const release = (await approved.json()) as { spec_sha256: string };
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        release_id: f.id,
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);
  expect(await readSelectedNodeGoldenImage(env, f.region)).toEqual({
    release_id: f.id,
    spec_sha256: release.spec_sha256,
    region_revision: 1,
    talos_version: "1.14.2",
    schematic_id: f.spec.roles.customer.talos_schematic_sha256,
    installer: f.spec.roles.customer.talos_installer,
    raw: f.raw,
  });
});
it("raw artifact URLs cannot contain credentials or an unpinned plain HTTP source", async () => {
  const f = await setup();
  f.spec.talos_raw_image!.url = "http://artifacts.example/image.raw.xz";
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.admin, "PUT", f.spec))
      .status,
  ).toBe(400);
  f.spec.talos_raw_image!.url =
    "https://token:secret@artifacts.example/image.raw.xz";
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.admin, "PUT", f.spec))
      .status,
  ).toBe(400);
});
