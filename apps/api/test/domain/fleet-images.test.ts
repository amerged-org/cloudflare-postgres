// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { bytesToHex } from "@pgcf/contracts";
import { createApp } from "../../src/app.ts";
import { FLEET_IMAGE_PREFIX } from "../../src/domain/fleet-images.ts";

const keys: string[] = [],
  releases: string[] = [];
const origin = "https://api.invalid";
const manifestType = "application/vnd.docker.distribution.manifest.v2+json";
const configType = "application/vnd.docker.container.image.v1+json";
const layerType = "application/vnd.docker.image.rootfs.diff.tar.gzip";
async function hash(bytes: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}
afterEach(async () => {
  await Promise.all(keys.splice(0).map((key) => env.ARCHIVE.delete(key)));
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function call(path: string, method = "GET", headers?: HeadersInit) {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(origin + path, { method, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function fixture() {
  const encode = (value: string) => new TextEncoder().encode(value);
  const config = encode(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      marker: crypto.randomUUID(),
    }),
  );
  const layer = crypto.getRandomValues(new Uint8Array(61));
  const raw = crypto.getRandomValues(new Uint8Array(83));
  const configHash = await hash(config),
    layerHash = await hash(layer),
    rawHash = await hash(raw);
  const manifest = encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: manifestType,
      config: {
        mediaType: configType,
        digest: `sha256:${configHash}`,
        size: config.byteLength,
      },
      layers: [
        {
          mediaType: layerType,
          digest: `sha256:${layerHash}`,
          size: layer.byteLength,
        },
      ],
    }),
  );
  const manifestHash = await hash(manifest);
  async function put(
    digest: string,
    body: Uint8Array,
    kind: string,
    type: string,
    parent?: string,
  ) {
    const key = FLEET_IMAGE_PREFIX + digest;
    if (!keys.includes(key)) keys.push(key);
    await env.ARCHIVE.put(key, body, {
      customMetadata: {
        artifact_kind: kind,
        sha256: digest,
        bytes: String(body.byteLength),
        ...(parent ? { manifest_sha256: parent } : {}),
      },
      httpMetadata: { contentType: type },
    });
  }
  await put(manifestHash, manifest, "manifest", manifestType);
  await put(configHash, config, "blob", configType, manifestHash);
  await put(layerHash, layer, "blob", layerType, manifestHash);
  await put(rawHash, raw, "raw", "application/x-xz");
  const rawPath = `/fleet-images/v1/raw/sha256:${rawHash}`;
  const spec = {
    roles: {
      customer: {
        talos_installer: `api.invalid/pgcf-talos-installer@sha256:${manifestHash}`,
      },
    },
    talos_raw_image: {
      url: origin + rawPath,
      sha256: rawHash,
      format: "raw.xz",
      bytes: raw.byteLength,
      raw_sha256: rawHash,
      raw_bytes: 512,
    },
  };
  const id = "artifact-test-" + crypto.randomUUID();
  releases.push(id);
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
  )
    .bind(
      id,
      JSON.stringify(spec),
      await hash(encode(JSON.stringify(spec))),
      new Date().toISOString(),
    )
    .run();
  return {
    id,
    spec,
    manifest,
    manifestHash,
    config,
    configHash,
    layer,
    layerHash,
    raw,
    rawHash,
    rawPath,
    put,
  };
}

it("serves approved OCI bytes and raw GET/HEAD anonymously with original media types and client-verifiable digests", async () => {
  const f = await fixture();
  const ping = await call("/v2/");
  expect(ping.status).toBe(200);
  expect(ping.headers.get("Docker-Distribution-Api-Version")).toBe(
    "registry/2.0",
  );
  for (const [path, digest, body, type] of [
    [
      `/v2/pgcf-talos-installer/manifests/sha256:${f.manifestHash}`,
      f.manifestHash,
      f.manifest,
      manifestType,
    ],
    [
      `/v2/pgcf-talos-installer/blobs/sha256:${f.configHash}`,
      f.configHash,
      f.config,
      configType,
    ],
    [
      `/v2/pgcf-talos-installer/blobs/sha256:${f.layerHash}`,
      f.layerHash,
      f.layer,
      layerType,
    ],
    [f.rawPath, f.rawHash, f.raw, "application/x-xz"],
  ] as const) {
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(type);
    expect(response.headers.get("Docker-Content-Digest")).toBe(
      `sha256:${digest}`,
    );
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(await hash(new Uint8Array(await response.arrayBuffer()))).toBe(
      digest,
    );
    const head = await call(path, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(body.byteLength));
    expect(await head.text()).toBe("");
  }
  const range = await call(f.rawPath, "GET", { Range: "bytes=3-9" });
  expect(range.status).toBe(206);
  expect(range.headers.get("Content-Range")).toBe(
    `bytes 3-9/${f.raw.byteLength}`,
  );
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(f.raw.slice(3, 10));
});

it("authorizes a shared blob through its approved manifest when the first metadata owner was abandoned", async () => {
  const f = await fixture(),
    abandoned = new TextEncoder().encode(
      JSON.stringify({
        ...JSON.parse(new TextDecoder().decode(f.manifest)),
        annotations: { abandoned: "true" },
      }),
    ),
    abandonedHash = await hash(abandoned),
    path = `/v2/pgcf-talos-installer/blobs/sha256:${f.configHash}`;
  await f.put(abandonedHash, abandoned, "manifest", manifestType);
  await f.put(f.configHash, f.config, "blob", configType, abandonedHash);
  const accepted = await call(path);
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("Content-Type")).toBe(configType);
  expect(await hash(new Uint8Array(await accepted.arrayBuffer()))).toBe(
    f.configHash,
  );
  expect((await call(path, "HEAD")).status).toBe(200);

  await f.put(
    f.configHash,
    new Uint8Array(f.config.byteLength + 1),
    "blob",
    configType,
    abandonedHash,
  );
  expect((await call(path)).status).toBe(404);
  await f.put(f.configHash, f.config, "blob", layerType, abandonedHash);
  expect((await call(path)).status).toBe(404);
  await f.put(f.configHash, f.config, "blob", configType, abandonedHash);
  await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
    .bind(f.id)
    .run();
  expect((await call(path)).status).toBe(404);
  const unrelated = await fixture();
  expect(unrelated.manifestHash).not.toBe(f.manifestHash);
  expect((await call(path)).status).toBe(404);
  const foreignId = "foreign-host-" + crypto.randomUUID();
  releases.push(foreignId);
  f.spec.roles.customer.talos_installer = `api.invalid.evil/pgcf-talos-installer@sha256:${f.manifestHash}`;
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
  )
    .bind(
      foreignId,
      JSON.stringify(f.spec),
      "b".repeat(64),
      new Date().toISOString(),
    )
    .run();
  expect((await call(path)).status).toBe(404);
});

it("never exposes tenant keys, tags, writes, unapproved hashes or incorrect manifest/child identities", async () => {
  const f = await fixture();
  const tenant = `eu-private/customer-${crypto.randomUUID()}/credentials`;
  keys.push(tenant);
  await env.ARCHIVE.put(tenant, "private-backup");
  expect(
    (
      await call(
        `/v2/pgcf-talos-installer/manifests/sha256:${f.manifestHash}`,
        "PUT",
      )
    ).status,
  ).toBe(405);
  expect((await call("/v2/_catalog")).status).toBe(404);
  expect((await call("/v2/pgcf-talos-installer/manifests/latest")).status).toBe(
    404,
  );
  expect(
    (await call(`/fleet-images/v1/raw/${encodeURIComponent(tenant)}`)).status,
  ).toBe(404);
  expect((await call(`/v2/other/blobs/sha256:${f.configHash}`)).status).toBe(
    404,
  );
  await f.put(f.configHash, f.config, "blob", layerType, "f".repeat(64));
  expect(
    (await call(`/v2/pgcf-talos-installer/blobs/sha256:${f.configHash}`))
      .status,
  ).toBe(404);
  await f.put(f.rawHash, f.raw, "blob", "application/x-xz");
  expect((await call(f.rawPath)).status).toBe(404);
  const changed = crypto.getRandomValues(new Uint8Array(f.manifest.byteLength));
  await f.put(f.manifestHash, changed, "manifest", manifestType);
  expect(
    (await call(`/v2/pgcf-talos-installer/manifests/sha256:${f.manifestHash}`))
      .status,
  ).toBe(404);
});
