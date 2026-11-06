// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { bytesToHex, ColdSnapshotManifest } from "@pgcf/contracts";
import { nodeToken, rawRequest } from "./fixtures.ts";
import {
  sleeping,
  capturing,
  status,
  cleanupColdFixture,
} from "./cold-storage-fixture.ts";
import {
  declareColdSnapshot,
  readColdSnapshotChunk,
  coldSnapshotChunkKey,
  sealColdSnapshot,
} from "../../src/domain/cold-snapshots.ts";

const keys = new Set<string>();
afterEach(async () => {
  if (keys.size) await env.ARCHIVE.delete([...keys]);
  keys.clear();
  await cleanupColdFixture();
});
const sha = async (body: Uint8Array) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(body).buffer),
    ),
  );
async function fixture() {
  const f = await sleeping(),
    c = await capturing(f),
    row = await status(c.operation);
  const version = new TextEncoder().encode("18\n"),
    control = new Uint8Array(8192);
  control[7] = 255;
  control[8] = 128; // Non-UTF8 transport bytes, not a native PostgreSQL acceptance fixture.
  const payload = new Uint8Array(version.byteLength + control.byteLength);
  payload.set(version);
  payload.set(control, version.byteLength);
  const manifest = ColdSnapshotManifest.parse({
    version: 1,
    operation: c.operation,
    database_id: f.id,
    source_generation: c.capture.source_generation,
    source_storage_generation: c.capture.source_storage_generation,
    pg_major: 18,
    end: c.capture.end,
    total_bytes: payload.byteLength,
    directories: ["global", "pg_wal"],
    files: [
      {
        path: "PG_VERSION",
        offset: 0,
        size_bytes: version.byteLength,
        sha256: await sha(version),
      },
      {
        path: "global/pg_control",
        offset: version.byteLength,
        size_bytes: control.byteLength,
        sha256: await sha(control),
      },
    ],
    chunks: [
      { index: 0, size_bytes: payload.byteLength, sha256: await sha(payload) },
    ],
  });
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  const chunkKey = coldSnapshotChunkKey(row.snapshot_prefix, 0),
    manifestKey = `${row.snapshot_prefix}manifest.json`;
  keys.add(chunkKey);
  keys.add(manifestKey);
  const request = async (
    suffix: string,
    body: Uint8Array,
    type: string,
    signatureBody = body,
  ) => {
    const path = `/node/v1/cold-snapshots/${c.operation}/${suffix}`;
    return rawRequest(
      path,
      {
        method: "PUT",
        headers: {
          "Content-Type": type,
          Authorization: `Bearer ${await nodeToken(f, path, "PUT", signatureBody)}`,
        },
        body,
      },
      undefined,
      f.configured,
    );
  };
  return {
    f,
    c,
    row,
    payload,
    manifest,
    encoded,
    chunkKey,
    manifestKey,
    request,
  };
}

it("authenticates exact binary bytes and binds every upload to its prior immutable declaration", async () => {
  const x = await fixture();
  expect(
    (await x.request("chunks/0", x.payload, "application/octet-stream")).status,
  ).toBe(409);
  expect(await env.ARCHIVE.head(x.chunkKey)).toBeNull();
  expect(
    (await x.request("manifest", x.encoded, "application/json")).status,
  ).toBe(200);
  const altered = x.payload.slice();
  altered[20] = altered[20]! ^ 1;
  expect(
    (
      await x.request(
        "chunks/0",
        altered,
        "application/octet-stream",
        x.payload,
      )
    ).status,
  ).toBe(401);
  expect(
    (await x.request("chunks/0", altered, "application/octet-stream")).status,
  ).toBe(400);
  expect(await env.ARCHIVE.head(x.chunkKey)).toBeNull();
  expect(
    (await x.request("chunks/0", x.payload, "application/octet-stream")).status,
  ).toBe(200);
  const first = (await env.ARCHIVE.head(x.chunkKey))!;
  expect(
    (await x.request("chunks/0", x.payload, "application/octet-stream")).status,
  ).toBe(200);
  expect((await env.ARCHIVE.head(x.chunkKey))!.version).toBe(first.version);
  const sealed = await sealColdSnapshot(
    x.f.configured,
    x.c.caller,
    x.c.operation,
    await sha(x.encoded),
  );
  expect(await sealed.json()).toMatchObject({ sealed: true });
  expect(
    new Uint8Array(
      await (
        await readColdSnapshotChunk(
          x.f.configured,
          x.c.caller,
          x.c.operation,
          0,
        )
      ).arrayBuffer(),
    ),
  ).toEqual(x.payload);
});

it("rejects another node and a changed manifest without modifying the authoritative object", async () => {
  const x = await fixture();
  await expect(
    declareColdSnapshot(
      x.f.configured,
      { ...x.c.caller, id: x.f.other },
      x.c.operation,
      x.encoded,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(await env.ARCHIVE.head(x.manifestKey)).toBeNull();
  expect(
    (await x.request("manifest", x.encoded, "application/json")).status,
  ).toBe(200);
  const first = (await env.ARCHIVE.head(x.manifestKey))!;
  const changed = new TextEncoder().encode(
    JSON.stringify({
      ...x.manifest,
      files: x.manifest.files.map((file, i) =>
        i === 1 ? { ...file, sha256: "a".repeat(64) } : file,
      ),
    }),
  );
  expect(
    (await x.request("manifest", changed, "application/json")).status,
  ).toBe(409);
  expect((await env.ARCHIVE.head(x.manifestKey))!.version).toBe(first.version);
  expect((await status(x.c.operation)).snapshot_manifest_sha256).toBe(
    await sha(x.encoded),
  );
});

it("cannot publish into a retired immutable key even if a matching upload intent already exists", async () => {
  const x = await fixture();
  expect(
    (await x.request("manifest", x.encoded, "application/json")).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE cold_snapshot_chunks SET state='uploading' WHERE operation=? AND chunk_index=0",
  )
    .bind(x.c.operation)
    .run();
  await env.ARCHIVE.put(x.chunkKey, new Uint8Array(), {
    customMetadata: { retired: x.c.operation },
  });
  expect(
    (await x.request("chunks/0", x.payload, "application/octet-stream")).status,
  ).toBe(409);
  expect((await env.ARCHIVE.head(x.chunkKey))!.size).toBe(0);
  expect((await env.ARCHIVE.head(x.chunkKey))!.customMetadata?.retired).toBe(
    x.c.operation,
  );
  expect((await status(x.c.operation)).snapshot_sealed_at).toBeNull();
});

it(
  "declares a manifest larger than the D1 row limit without binding or storing that JSON in D1",
  { timeout: 30000 },
  async () => {
    const x = await fixture(),
      empty = await sha(new Uint8Array());
    const files = [...x.manifest.files];
    for (let index = files.length; index < 16_384; index++)
      files.push({
        path: `base/5/${"f".repeat(64)}${index}`,
        offset: x.payload.byteLength,
        size_bytes: 0,
        sha256: empty,
      });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let offset = 0;
    for (const file of files) {
      file.offset = offset;
      offset += file.size_bytes;
    }
    const manifest = ColdSnapshotManifest.parse({
      ...x.manifest,
      directories: [...x.manifest.directories, "base", "base/5"].sort(),
      files,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    expect(bytes.byteLength).toBeGreaterThan(2_000_000);
    expect(bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    const result = await declareColdSnapshot(
      x.f.configured,
      x.c.caller,
      x.c.operation,
      bytes,
    );
    expect(result.status).toBe(200);
    expect((await status(x.c.operation)).snapshot_manifest_bytes).toBe(
      bytes.byteLength,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM cold_snapshot_chunks WHERE operation=?",
      )
        .bind(x.c.operation)
        .first("n"),
    ).toBe(1);
    expect((await env.ARCHIVE.head(x.manifestKey))!.size).toBe(
      bytes.byteLength,
    );
  },
);
