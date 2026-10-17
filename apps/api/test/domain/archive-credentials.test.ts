// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  ArchiveCredential,
  ARCHIVE_CREDENTIAL_ID_PATTERN,
  base64urlToBytes,
  ERROR_HTTP_STATUS,
  parseArchivePath,
} from "@pgcf/contracts";
import { ApiError } from "../../src/app.ts";
import type { ApiEnv } from "../../src/env.ts";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import {
  ARCHIVE_CREDENTIAL_LIFETIME_SECONDS,
  archiveCredentialResponse,
  deliverArchiveCredential,
  ensureArchiveCredential,
  purgeArchiveCredentials,
} from "../../src/domain/archive-credentials.ts";
import { R2_ACTIONS } from "../../src/crypto/r2-credentials.ts";
import {
  ACCOUNT_ID,
  cleanup,
  ENDPOINT,
  keyedEnv,
  lifecycle,
  PARENT_KEY,
} from "./lifecycle-fixture.ts";

afterEach(cleanup);
const DAY = 86_400_000;
const claimsOf = (credential: ArchiveCredential) => {
  const jwt = atob(credential.session_token).slice(4);
  return JSON.parse(
    new TextDecoder().decode(base64urlToBytes(jwt.split(".")[1]!)!),
  ) as Record<string, unknown>;
};

it("issues one reference per scope and keeps it until a third of its lifetime has passed", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.parse("2026-10-18T10:00:00.000Z");
  const scope = {
    nodeId: f.node,
    archivePath: row.archive_path,
    access: "read_write" as const,
  };
  const first = await ensureArchiveCredential(env.DB, scope, now);
  expect(first.id).toMatch(ARCHIVE_CREDENTIAL_ID_PATTERN);
  expect(first.expires_at).toBe(
    new Date(now + ARCHIVE_CREDENTIAL_LIFETIME_SECONDS * 1000).toISOString(),
  );
  expect(ARCHIVE_CREDENTIAL_LIFETIME_SECONDS).toBe(7 * 86_400);
  expect(await ensureArchiveCredential(env.DB, scope, now + 2 * DAY)).toEqual(
    first,
  );
  // Renewed after a third (about 2.33 days): the new reference outlives the old one.
  const renewed = await ensureArchiveCredential(env.DB, scope, now + 2.5 * DAY);
  expect(renewed.id).not.toBe(first.id);
  expect(renewed.expires_at > first.expires_at).toBe(true);
  expect(await ensureArchiveCredential(env.DB, scope, now + 3 * DAY)).toEqual(
    renewed,
  );
  // Another access level or another node is another scope.
  const readOnly = await ensureArchiveCredential(
    env.DB,
    { ...scope, access: "read_only" },
    now,
  );
  expect(readOnly.id).not.toBe(first.id);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM archive_credentials")
      .first<{ n: number }>()
      .then((r) => r!.n),
  ).toBe(3);
});

it("signs the credential for the node's own prefix when the node reads it, and stores no secret", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const reference = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: row.archive_path, access: "read_write" },
    now,
  );
  const credential = await deliverArchiveCredential(
    keyedEnv(),
    f.node,
    reference.id,
    now + 1000,
  );
  expect(credential).not.toBeNull();
  expect(ArchiveCredential.parse(credential)).toEqual(credential);
  expect(credential).toMatchObject({
    id: reference.id,
    path: row.archive_path,
    access: "read_write",
    endpoint_url: ENDPOINT,
    access_key_id: PARENT_KEY.R2_PARENT_ACCESS_KEY_ID,
    expires_at: reference.expires_at,
  });
  const path = parseArchivePath(row.archive_path)!;
  expect(claimsOf(credential!)).toEqual({
    bucket: env.ARCHIVE_BUCKET_NAME,
    actions: [...R2_ACTIONS.read_write],
    paths: {
      prefixPaths: [`${path.region}/${path.database}/g1-${path.operation}/`],
      objectPaths: [],
    },
    sub: ACCOUNT_ID,
    iss: PARENT_KEY.R2_PARENT_ACCESS_KEY_ID,
    aud: `${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
    iat: Math.floor((now + 1000) / 1000),
    exp: Math.floor(Date.parse(reference.expires_at) / 1000),
  });
  // Nothing of the secret is kept: the row says only who may read what until when.
  const stored = JSON.stringify(
    (await env.DB.prepare("SELECT * FROM archive_credentials").all()).results,
  );
  for (const secret of [
    credential!.secret_access_key,
    credential!.session_token,
    PARENT_KEY.R2_PARENT_SECRET_ACCESS_KEY,
  ])
    expect(stored).not.toContain(secret);
});

it("reads only for the node it was issued to, until it expires", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const reference = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: row.archive_path, access: "read_write" },
    now,
  );
  const read = (node: string, id: string, at = now) =>
    deliverArchiveCredential(keyedEnv(), node, id, at);
  expect(await read(f.other, reference.id)).toBeNull();
  expect(await read(f.node, "crd_" + "a".repeat(20))).toBeNull();
  expect(await read(f.node, reference.id)).not.toBeNull();
  expect(
    await read(f.node, reference.id, Date.parse(reference.expires_at) - 1000),
  ).not.toBeNull();
  expect(
    await read(f.node, reference.id, Date.parse(reference.expires_at)),
  ).toBeNull();
});

it("gives a read-write credential only to the node that serves the generation, and read-only to the reader of a source", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const oldPath = row.archive_path;
  const rw = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: oldPath, access: "read_write" },
    now,
  );
  const ro = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.other, archivePath: oldPath, access: "read_only" },
    now,
  );
  // The database moves on: its next storage generation lives on the other node.
  const next = oldPath.replace(
    /\/g1-op_[a-z0-9]{20}$/,
    "/g2-op_" + "z".repeat(20),
  );
  await env.DB.prepare(
    "UPDATE databases SET node_id=?,storage_generation=2,archive_path=? WHERE id=?",
  )
    .bind(f.other, next, f.id)
    .run();
  expect(
    await deliverArchiveCredential(keyedEnv(), f.node, rw.id, now),
  ).toBeNull();
  const source = await deliverArchiveCredential(
    keyedEnv(),
    f.other,
    ro.id,
    now,
  );
  expect(source).toMatchObject({ access: "read_only", path: oldPath });
  expect(claimsOf(source!).actions).toEqual([...R2_ACTIONS.read_only]);
  // A read-write credential for the new generation is issued to its node only.
  await expect(
    ensureArchiveCredential(
      env.DB,
      { nodeId: f.node, archivePath: next, access: "read_write" },
      now,
    ),
  ).rejects.toThrow("archive_credential_refused");
  expect(
    await ensureArchiveCredential(
      env.DB,
      { nodeId: f.other, archivePath: next, access: "read_write" },
      now,
    ),
  ).toMatchObject({ id: expect.stringMatching(ARCHIVE_CREDENTIAL_ID_PATTERN) });
});

it("issues and delivers nothing to a lost or fenced node", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const scope = {
    nodeId: f.node,
    archivePath: row.archive_path,
    access: "read_write" as const,
  };
  const reference = await ensureArchiveCredential(env.DB, scope, now);
  await env.DB.prepare(
    "INSERT INTO node_losses(node_id,region_id,declared_at,reason) VALUES(?,?,?,?)",
  )
    .bind(f.node, f.region, new Date(now).toISOString(), "test")
    .run();
  expect(
    await deliverArchiveCredential(keyedEnv(), f.node, reference.id, now),
  ).toBeNull();
  await expect(
    ensureArchiveCredential(env.DB, scope, now + 3 * DAY),
  ).rejects.toThrow("archive_credential_refused");
});

it("is unavailable, with nothing to leak, while the Worker has no parent key", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const reference = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: row.archive_path, access: "read_write" },
    now,
  );
  await expect(
    deliverArchiveCredential(
      { ...env, R2_PARENT_ACCESS_KEY_ID: PARENT_KEY.R2_PARENT_ACCESS_KEY_ID },
      f.node,
      reference.id,
      now,
    ),
  ).rejects.toThrow("archive_credentials_unavailable");
});

it("refuses a region whose bucket is not the one the path names", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const reference = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: row.archive_path, access: "read_write" },
    now,
  );
  await env.DB.prepare(
    "UPDATE regions SET backup_bucket='another-bucket' WHERE id=?",
  )
    .bind(f.region)
    .run();
  await expect(
    deliverArchiveCredential(keyedEnv(), f.node, reference.id, now),
  ).rejects.toThrow("archive_credentials_unavailable");
});

it("purges credentials a day after they expired, a bounded batch at a time", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const scope = {
    nodeId: f.node,
    archivePath: row.archive_path,
    access: "read_write" as const,
  };
  const old = await ensureArchiveCredential(env.DB, scope, now - 7.5 * DAY);
  const current = await ensureArchiveCredential(env.DB, scope, now);
  expect(await purgeArchiveCredentials(env.DB, now)).toBe(0);
  expect(
    await purgeArchiveCredentials(env.DB, Date.parse(old.expires_at) + DAY + 1),
  ).toBe(1);
  expect(
    (await env.DB.prepare("SELECT id FROM archive_credentials").all()).results,
  ).toEqual([{ id: current.id }]);
});

it("answers a node's read through the handler the node router calls once it has authenticated the request", async () => {
  const f = await lifecycle(),
    row = await f.row(),
    now = Date.now();
  const reference = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.node, archivePath: row.archive_path, access: "read_write" },
    now,
  );
  // The router of the node API authenticates the signed request and names the node.
  const app = new Hono<ApiEnv>();
  app.get("/node/v1/archive-credentials/:id", (c) =>
    archiveCredentialResponse(c, c.req.query("node") ?? f.node),
  );
  app.onError((error, c) =>
    error instanceof ApiError
      ? c.json({ code: error.code }, ERROR_HTTP_STATUS[error.code])
      : c.json({ code: "internal" }, 500),
  );
  const get = (id: string, node?: string) =>
    app.request(
      `/node/v1/archive-credentials/${id}${node ? `?node=${node}` : ""}`,
      {},
      keyedEnv(),
    );
  const response = await get(reference.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(ArchiveCredential.parse(await response.json())).toMatchObject({
    id: reference.id,
    access: "read_write",
  });
  expect(await (await get(reference.id, f.other)).json()).toEqual({
    code: "not_found",
  });
  expect((await get("crd_" + "a".repeat(20))).status).toBe(404);
  expect((await get("not-an-id")).status).toBe(404);
});
