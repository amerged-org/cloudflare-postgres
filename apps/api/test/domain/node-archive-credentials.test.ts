// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { ArchiveCredential, NODE_API_PATHS } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { declareNodeLost } from "../../src/domain/node-loss.ts";
import { cleanup, keyedEnv, lifecycle } from "./lifecycle-fixture.ts";
import { desiredPage, nodeToken } from "./fixtures.ts";

afterEach(cleanup);

/** A signed `GET` of the node's credential route, to a Worker with or without the parent key. */
async function read(
  f: Awaited<ReturnType<typeof lifecycle>>,
  id: string,
  worker: object = keyedEnv(),
) {
  const path = `${NODE_API_PATHS.archiveCredentials}${id}`,
    context = createExecutionContext();
  const response = await createApp().fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
      headers: { Authorization: `Bearer ${await nodeToken(f, path, "GET")}` },
    }),
    worker as typeof env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

it("hands a node the credential its desired page names, signed now and never cached", async () => {
  const f = await lifecycle();
  const named = (await desiredPage(f)).databases.find(
    (d) => d.id === f.id,
  )!.archive;
  const response = await read(f, named.credential.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(ArchiveCredential.parse(await response.json())).toMatchObject({
    id: named.credential.id,
    path: named.path,
    access: "read_write",
    expires_at: named.credential.expires_at,
  });
});

it("finds nothing for a credential that is not the node's or does not exist", async () => {
  const f = await lifecycle();
  const own = (await desiredPage(f)).databases.find((d) => d.id === f.id)!
    .archive.credential;
  expect((await read(f, `crd_${"z".repeat(20)}`)).status).toBe(404);
  // The credential of the other node's scope is not this node's to read.
  const foreign = await env.DB.prepare(
    "UPDATE archive_credentials SET node_id=? WHERE id=?",
  )
    .bind(f.other, own.id)
    .run();
  expect(foreign.meta.changes).toBe(1);
  expect((await read(f, own.id)).status).toBe(404);
});

it("refuses an identifier that is no credential's and a Worker without the parent key", async () => {
  const f = await lifecycle();
  expect((await read(f, "not-an-id")).status).toBe(400);
  const own = (await desiredPage(f)).databases.find((d) => d.id === f.id)!
    .archive.credential;
  // Without the key nothing can be signed: the answer is an error, never a credential.
  expect((await read(f, own.id, env)).status).toBeGreaterThanOrEqual(500);
});

it("answers a node declared lost that it is fenced, and signs it nothing", async () => {
  const f = await lifecycle();
  const own = (await desiredPage(f)).databases.find((d) => d.id === f.id)!
    .archive.credential;
  await declareNodeLost(env, f.node, {
    expected_node_uid: f.nodeUid,
    reason: "gone",
  });
  const response = await read(f, own.id);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "node_fenced" });
});
