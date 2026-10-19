// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import {
  FleetNodeReleaseStatus,
  FleetRegionReleaseStatus,
  FleetRelease,
  hostFileObjectKey,
  hostFilesSha256,
  releaseFileUrl,
  releaseObjectKey,
} from "@pgcf/contracts/releases";
import { createApp } from "../../src/app.ts";
import {
  API_ORIGIN,
  GATEWAY_UNIT_SHA256,
  HOST_FILES,
  HOST_FILE_BODIES,
  cleanupFixtures,
  fixture,
  nodeOs,
  nodeSample,
  refusal,
  request,
  stageRelease,
} from "./fixtures.ts";
import { NODE_HEADER, NODE_UID_HEADER } from "../../src/node-actor.ts";
import { heldLink } from "./node-fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup() {
  const f = await fixture(),
    id = `release-${crypto.randomUUID()}`,
    value = await stageRelease(id);
  releases.push(id);
  const approve = (body: unknown = value, key?: string) =>
    request(`/v1/fleet/releases/${id}`, f.admin, "PUT", body, key);
  const assign = (revision = 0, release = id) =>
    request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
      expected_revision: revision,
      release_id: release,
    });
  const status = async () =>
    FleetNodeReleaseStatus.parse(
      await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
    );
  return { ...f, id, value, approve, assign, status };
}
/** A node says hello over its link, naming the release it runs, and sends its first sample. */
async function hello(
  f: Awaited<ReturnType<typeof setup>>,
  release: string | null,
  sampleAt = Date.now() - 1000,
) {
  const stub = env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node));
  const response = await stub.fetch(
    new Request(`https://${["link", "invalid"].join(".")}/node/v1/link`, {
      headers: {
        Upgrade: "websocket",
        [NODE_HEADER]: f.node,
        [NODE_UID_HEADER]: f.nodeUid,
      },
    }),
  );
  const socket = response.webSocket!;
  socket.accept();
  const welcome = new Promise<void>((resolve) =>
    socket.addEventListener("message", () => resolve(), { once: true }),
  );
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "0.1.0",
      release_id: release,
      os: nodeOs(),
    }),
  );
  await welcome;
  socket.send(JSON.stringify({ type: "sample", sample: nodeSample(sampleAt) }));
  for (let i = 0; i < 200; i++) {
    const row = await env.DB.prepare(
      "SELECT last_sample_json FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ last_sample_json: string | null }>();
    if (row?.last_sample_json) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return socket;
}

it("approves immutable releases with idempotent replay and rejects a changed one", async () => {
  const f = await setup(),
    key = crypto.randomUUID();
  const first = await f.approve(f.value, key);
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(await (await f.approve(f.value, key)).json()).toEqual(result);
  expect(await (await f.approve()).json()).toEqual(result);
  const changed = structuredClone(f.value);
  changed.binaries["pgcf-agent"].sha256 = "e".repeat(64);
  expect((await f.approve(changed)).status).toBe(409);
  expect((await request(`/v1/fleet/releases/${f.id}`, f.admin)).status).toBe(
    200,
  );
  expect((await f.assign(0, "missing")).status).toBe(404);
  await expect(
    env.DB.prepare("UPDATE fleet_releases SET spec_json='{}' WHERE id=?")
      .bind(f.id)
      .run(),
  ).rejects.toThrow();
});

it("refuses a body that is not a registration: a full spec, a URL, an unknown field or an unpinned digest", async () => {
  const f = await setup();
  for (const body of [
    { ...f.value, version: 2 },
    { ...f.value, roles: {} },
    {
      ...f.value,
      image: { ...f.value.image, url: "https://elsewhere.example/i" },
    },
    { ...f.value, image: { ...f.value.image, format: "raw" } },
    {
      ...f.value,
      binaries: {
        ...f.value.binaries,
        "pgcf-agent": { ...f.value.binaries["pgcf-agent"], sha256: "latest" },
      },
    },
    { ...f.value, os: { ...f.value.os, debian_snapshot: "today" } },
    { ...f.value, os: { ...f.value.os, image_version: "other" } },
    { ...f.value, os: { ...f.value.os, packages_sha256: undefined } },
    { ...f.value, os: { ...f.value.os, packages_sha256: "latest" } },
    { ...f.value, os: { ...f.value.os, kernel_release: undefined } },
    { ...f.value, os: { ...f.value.os, kernel_release: "6.12 amd64" } },
    // The host files: all of them, in the contract's shape, with the digest a node reports.
    { ...f.value, os: { ...f.value.os, host_files: undefined } },
    { ...f.value, os: { ...f.value.os, host_files: [] } },
    { ...f.value, os: { ...f.value.os, host_files_sha256: undefined } },
    {
      ...f.value,
      os: { ...f.value.os, host_files: [...HOST_FILES].reverse() },
    },
    {
      ...f.value,
      os: {
        ...f.value.os,
        host_files: [{ ...HOST_FILES[1], path: "/etc/passwd" }],
      },
    },
    {
      ...f.value,
      os: {
        ...f.value.os,
        host_files: [{ ...HOST_FILES[1], url: "https://elsewhere.example/f" }],
      },
    },
    {},
  ])
    expect((await f.approve(body)).status).toBe(400);
  // The version is the node's image version and its directory: a name, at most 64 characters.
  const long = `release-${"a".repeat(60)}`;
  expect(
    (
      await request(
        `/v1/fleet/releases/${long}`,
        f.admin,
        "PUT",
        await stageRelease(long),
      )
    ).status,
  ).toBe(400);
});

it("registers a release only with a signature of 64 bytes in hex, which it stores and shows but cannot check", async () => {
  const f = await setup();
  const { signature, ...unsigned } = f.value;
  for (const body of [
    unsigned,
    { ...unsigned, signature: null },
    { ...unsigned, signature: "" },
    { ...unsigned, signature: signature.slice(1) },
    { ...unsigned, signature: signature.toUpperCase() },
    { ...unsigned, signature: `${signature}00` },
  ])
    expect((await f.approve(body)).status).toBe(400);
  expect(
    await env.DB.prepare("SELECT 1 FROM fleet_releases WHERE id=?")
      .bind(f.id)
      .first(),
  ).toBeNull();
  // The API has no key to check it against: whatever the registration states is what it stores
  // and every reader sees, in the release and in the list.
  const stored = FleetRelease.parse(await (await f.approve()).json());
  expect(stored.spec.signature).toBe(signature);
  expect(
    FleetRelease.parse(
      await (await request(`/v1/fleet/releases/${f.id}`, f.admin)).json(),
    ).spec.signature,
  ).toBe(signature);
  const listed = (await (
    await request("/v1/fleet/releases?limit=100", f.admin)
  ).json()) as {
    data: { id: string; spec: { signature: string } }[];
  };
  expect(
    listed.data.find((release) => release.id === f.id)?.spec.signature,
  ).toBe(signature);
  // A release is immutable with its signature: another one is another release.
  const resigned = { ...f.value, signature: "0".repeat(128) };
  expect((await f.approve(resigned)).status).toBe(409);
});

it("names the URLs of the spec itself: every file of the release is served by this Worker", async () => {
  const f = await setup();
  const release = FleetRelease.parse(await (await f.approve()).json());
  const url = (file: Parameters<typeof releaseFileUrl>[2]) =>
    releaseFileUrl(API_ORIGIN, f.id, file);
  expect(release.spec.image).toMatchObject({
    url: url("pgcf-node.raw.zst"),
    format: "raw.zst",
    sha256: f.value.image.sha256,
    size_bytes: f.value.image.size_bytes,
    raw_sha256: f.value.image.raw_sha256,
    raw_bytes: f.value.image.raw_bytes,
  });
  expect(release.spec.binaries["pgcf-native-gateway"]).toEqual({
    url: url("pgcf-native-gateway"),
    ...f.value.binaries["pgcf-native-gateway"],
  });
  expect(release.spec.os).toEqual({
    image_version: f.id,
    debian_snapshot: f.value.os.debian_snapshot,
    package_lock: {
      url: url("packages.lock.json"),
      ...f.value.os.package_lock,
    },
    // The files of the image a node holds, with how each takes effect, and no URL: a node reads
    // one by its digest beside the release's files.
    host_files: HOST_FILES,
    // What a node that runs the lock and holds the files reports back, fixed with the release.
    packages_sha256: f.value.os.packages_sha256,
    kernel_release: f.value.os.kernel_release,
    host_files_sha256: f.value.os.host_files_sha256,
  });
  expect(release.spec.image.url).toMatch(
    new RegExp(
      `^https://[^/]+/node/v1/releases/${f.id}/pgcf-node\\.raw\\.zst$`,
    ),
  );
});

it("registers only what the archive bucket holds: every file, at its size, with the sha256 R2 verified", async () => {
  const f = await setup();
  const conflict = async (
    version: string,
    body: Awaited<ReturnType<typeof stageRelease>>,
    file: string,
  ) => {
    const response = await request(
      `/v1/fleet/releases/${version}`,
      f.admin,
      "PUT",
      body,
    );
    expect(await refusal(response.clone())).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(JSON.stringify(await response.json())).toContain(file);
    expect(
      await env.DB.prepare("SELECT 1 FROM fleet_releases WHERE id=?")
        .bind(version)
        .first(),
    ).toBeNull();
  };
  // A file that was never uploaded.
  const missing = `${f.id}-a`;
  await conflict(
    missing,
    await stageRelease(missing, { skip: ["pgcf-archive"] }),
    "pgcf-archive",
  );
  // An object of another size than the registered one.
  const resized = `${f.id}-b`;
  const sized = await stageRelease(resized);
  sized.binaries["pgcf-agent"].size_bytes += 1;
  await conflict(resized, sized, "pgcf-agent");
  // An object whose digest differs from the registered one.
  const forged = `${f.id}-c`;
  const digests = await stageRelease(forged);
  digests.os.package_lock.sha256 = "0".repeat(64);
  await conflict(forged, digests, "packages.lock.json");
  // An object uploaded without a sha256 that R2 verified: nothing proves its digest.
  const unverified = `${f.id}-d`;
  const registration = await stageRelease(unverified, {
    skip: ["pgcf-wal-fetch"],
  });
  await env.ARCHIVE.put(
    releaseObjectKey(unverified, "pgcf-wal-fetch"),
    new TextEncoder().encode(`${unverified}/pgcf-wal-fetch`),
  );
  await conflict(unverified, registration, "pgcf-wal-fetch");
  await env.ARCHIVE.delete(releaseObjectKey(unverified, "pgcf-wal-fetch"));
  // A host file that was never uploaded, one of another size, and one stored without the sha256
  // R2 verified are refused as the six files are, naming the object.
  const noHost = `${f.id}-e`;
  await conflict(
    noHost,
    await stageRelease(noHost, { skipHostFiles: [HOST_FILES[1]!.path] }),
    hostFileObjectKey(noHost, GATEWAY_UNIT_SHA256),
  );
  const bigHost = `${f.id}-f`;
  const bigger = await stageRelease(bigHost);
  (bigger.os.host_files[1] as { size_bytes: number }).size_bytes += 1;
  // The digest a node reports covers the sizes: the registration states it again for its list.
  bigger.os.host_files_sha256 = await hostFilesSha256(bigger.os.host_files);
  await conflict(
    bigHost,
    bigger,
    hostFileObjectKey(bigHost, GATEWAY_UNIT_SHA256),
  );
  const looseHost = `${f.id}-g`;
  const loose = await stageRelease(looseHost, {
    skipHostFiles: [HOST_FILES[1]!.path],
  });
  const looseKey = hostFileObjectKey(looseHost, GATEWAY_UNIT_SHA256);
  await env.ARCHIVE.put(looseKey, HOST_FILE_BODIES.gateway);
  await conflict(looseHost, loose, looseKey);
  await env.ARCHIVE.delete(looseKey);
  // The registration works once the files are there.
  expect((await f.approve()).status).toBe(200);
});

it("states the digest a node reports for the host files itself: a registration whose digest is not the list's is refused", async () => {
  const f = await setup();
  const wrong = structuredClone(f.value);
  wrong.os.host_files_sha256 = "0".repeat(64);
  expect(await refusal(await f.approve(wrong))).toMatchObject({
    status: 400,
    code: "invalid_request",
  });
  expect(
    await env.DB.prepare("SELECT 1 FROM fleet_releases WHERE id=?")
      .bind(f.id)
      .first(),
  ).toBeNull();
  expect((await f.approve()).status).toBe(200);
});

it("refuses to register where the Worker has no origin to name the URLs by", async () => {
  const f = await setup();
  const response = await createApp().fetch(
    new Request(`https://api.example.org/v1/fleet/releases/${f.id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${f.admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(f.value),
    }),
    { ...env, NODE_API_ORIGIN: undefined },
    createExecutionContext(),
  );
  expect(await refusal(response)).toMatchObject({
    status: 409,
    code: "conflict",
  });
});

it("enforces admin scope and the revision compare-and-set of a region's release", async () => {
  const f = await setup();
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.integrator, "PUT", f.value))
      .status,
  ).toBe(403);
  expect((await request(`/v1/fleet/releases/${f.id}`, "invalid")).status).toBe(
    401,
  );
  expect((await f.assign()).status).toBe(404);
  expect((await f.approve()).status).toBe(200);
  expect(
    FleetRegionReleaseStatus.parse(
      await (await request(`/v1/regions/${f.region}/release`, f.admin)).json(),
    ),
  ).toMatchObject({ revision: 0, desired_release_id: null });
  const key = crypto.randomUUID();
  const assign = () =>
    request(
      `/v1/regions/${f.region}/release`,
      f.admin,
      "PUT",
      { expected_revision: 0, release_id: f.id },
      key,
    );
  expect((await assign()).status).toBe(200);
  expect((await assign()).status).toBe(200);
  expect(
    FleetRegionReleaseStatus.parse(
      await (await request(`/v1/regions/${f.region}/release`, f.admin)).json(),
    ),
  ).toMatchObject({ revision: 1, desired_release_id: f.id });
  expect((await f.assign(0)).status).toBe(409);
  expect((await f.assign(7)).status).toBe(409);
  expect(
    (await request(`/v1/regions/${f.foreign}/release`, f.admin)).status,
  ).toBe(200);
  expect(
    (await request("/v1/regions/eu-unknown/release", f.admin)).status,
  ).toBe(404);
});

it("elects one of two competing assignments", async () => {
  const f = await setup();
  await f.approve();
  const responses = await Promise.all([f.assign(0), f.assign(9)]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
});

it("tells the region's nodes to pull the page that names the release", async () => {
  const f = await setup();
  await f.approve();
  const socket = await hello(f, null);
  const hint = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    }),
  );
  expect((await f.assign()).status).toBe(200);
  expect(JSON.parse(await hint)).toEqual({ type: "desired" });
  expect((await heldLink(f.node)).connected).toBe(true);
  socket.close(1000);
});

it("converges a node when it runs the release of its region and its link is fresh", async () => {
  const f = await setup();
  expect(await f.status()).toMatchObject({
    state: "unassigned",
    desired_release_id: null,
  });
  await f.approve();
  await f.assign();
  // The node has not said hello with the release yet.
  expect(await f.status()).toMatchObject({
    state: "pending",
    desired_release_id: f.id,
    observed_release_id: null,
  });
  const socket = await hello(f, f.id);
  const converged = await f.status();
  expect(converged).toMatchObject({
    state: "converged",
    node_uid: f.nodeUid,
    desired_release_id: f.id,
    observed_release_id: f.id,
  });
  expect(converged.desired_spec_sha256).toMatch(/^[0-9a-f]{64}$/);
  // A node that runs another release is pending, whatever its link says.
  await env.DB.prepare(
    "UPDATE nodes SET reported_release_id='older' WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(await f.status()).toMatchObject({
    state: "pending",
    observed_release_id: "older",
  });
  // A link that has been silent for too long is stale, a lost node is fenced.
  await env.DB.prepare(
    "UPDATE nodes SET reported_release_id=?,last_observed_at=? WHERE id=?",
  )
    .bind(f.id, new Date(Date.now() - 181_000).toISOString(), f.node)
    .run();
  expect(await f.status()).toMatchObject({ state: "stale" });
  await env.DB.prepare(
    "UPDATE nodes SET last_observed_at=?,lost_at=?,lost_reason='test' WHERE id=?",
  )
    .bind(new Date().toISOString(), new Date().toISOString(), f.node)
    .run();
  expect(await f.status()).toMatchObject({ state: "fenced" });
  socket.close(1000);
});

it("shows the release and the link of every node in the inventory", async () => {
  const f = await setup();
  await f.approve();
  await f.assign();
  const socket = await hello(f, f.id);
  const listed = (await (await request("/v1/nodes", f.admin)).json()) as {
    data: {
      id: string;
      release: { state: string; desired_release_id: string };
      observation: { state: string; agent_version: string | null };
    }[];
  };
  const node = listed.data.find((entry) => entry.id === f.node)!;
  expect(node.release).toMatchObject({
    state: "converged",
    desired_release_id: f.id,
  });
  expect(node.observation).toMatchObject({
    state: "current",
    agent_version: "0.1.0",
  });
  expect((await request(`/v1/nodes/${f.node}`, f.admin)).status).toBe(200);
  socket.close(1000);
});

it("no longer assigns a release to a single node", async () => {
  const f = await setup();
  await f.approve();
  await f.assign();
  expect(
    (
      await request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: f.id,
        node_uid: f.nodeUid,
      })
    ).status,
  ).toBe(404);
  expect(
    (await request("/node/v1/fleet-observations", f.admin, "POST", {})).status,
  ).toBe(401);
});
