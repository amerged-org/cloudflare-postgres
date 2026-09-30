// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
const sha = async (bytes: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", bytes));
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const keys = JSON.stringify({
  active: "fixture-v1",
  keys: { "fixture-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
const bucket = (env as typeof env & { USAGE_ARCHIVES: R2Bucket })
  .USAGE_ARCHIVES;

it("publishes immutable source custody through orphan chunks and a lost receipt response, then recovers only with the retained receipt and recovery authority", async () => {
  const f = await accountingFixture("Usage archive custody");
  const issued = await accountingCall(
    `/v1/regions/${f.regionId}/usage-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(issued.status).toBe(201);
  const source = (await issued.json()) as {
    sourceId: string;
    sourceEpoch: number;
    apiToken: string;
  };
  let meterToken = source.apiToken;
  const identity = {
    regionId: f.regionId,
    sourceId: source.sourceId,
    sourceEpoch: source.sourceEpoch,
  };
  // Worker custody verifies opaque bytes; the Node recovery story separately
  // verifies a real SQLite journal and its exact source/session/schema.
  const journal = encoder.encode(
    "SQLite format 3\u0000private-journal-custody-sentinel",
  );
  const journalSha = await sha(journal);
  const manifest = encoder.encode(
    JSON.stringify({
      schemaVersion: 2,
      identity,
      sha256: journalSha,
      bytes: journal.byteLength,
      pendingFacts: 4096,
      activationSupported: false,
    }),
  );
  const manifestSha = await sha(manifest);
  const descriptor = {
    version: 1,
    identity,
    sessionId: "11111111-1111-4111-8111-111111111111",
    capturedAt: new Date().toISOString(),
    files: [
      {
        kind: "journal",
        id: "journal",
        bytes: journal.byteLength,
        sha256: journalSha,
        chunks: [{ bytes: journal.byteLength, sha256: journalSha }],
      },
      {
        kind: "manifest",
        id: "manifest",
        bytes: manifest.byteLength,
        sha256: manifestSha,
        chunks: [{ bytes: manifest.byteLength, sha256: manifestSha }],
      },
    ],
  };
  const base = `/v1/regions/${f.regionId}/usage-archives`;
  const invoke = (
    path: string,
    init: RequestInit<IncomingRequestCfProperties> = {},
    selected = bucket,
  ) =>
    worker.fetch(
      new Request<unknown, IncomingRequestCfProperties>(
        `https://control.example.test${path}`,
        init,
      ),
      {
        ...env,
        USAGE_ARCHIVES: selected,
        USAGE_ARCHIVE_KEYS: keys,
      } as typeof env,
    );
  const auth = () => ({
    authorization: `Bearer ${meterToken}`,
    "content-type": "application/json",
  });
  const prepared = await invoke(`${base}/prepare`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify(descriptor),
  });
  expect(prepared.status).toBe(201);
  const preparation = (await prepared.json()) as {
    descriptorId: string;
    descriptorSha256: string;
    descriptor: typeof descriptor;
  };
  expect(preparation.descriptor).toEqual(descriptor);
  expect(preparation.descriptorId).toBe(
    await sha(
      encoder.encode(
        "cloudflare-postgres/usage-archive/descriptor/v1\u0000" +
          JSON.stringify(canonical(descriptor)),
      ),
    ),
  );
  expect(preparation.descriptorSha256).toBe(
    await sha(encoder.encode(JSON.stringify(canonical(descriptor)))),
  );
  const artifact = `${base}/${source.sourceId}/${source.sourceEpoch}/${preparation.descriptorId}`;
  const objectPrefix = `usage-archives/v1/${f.regionId}/${source.sourceId}/${source.sourceEpoch}/${preparation.descriptorId}`;
  let cut = false;
  const revokeAfterPut = new Proxy(bucket, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          if (!cut && args[0] === `${objectPrefix}/chunks/0`) {
            cut = true;
            const next = await accountingCall(
              `/v1/regions/${f.regionId}/usage-tokens/reissue`,
              { method: "POST", headers: installerHeaders },
            );
            expect(next.status).toBe(201);
            meterToken = ((await next.json()) as { apiToken: string }).apiToken;
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const denied = await invoke(
    `${artifact}/chunks/0`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${source.apiToken}`,
        "content-type": "application/octet-stream",
      },
      body: journal,
    },
    revokeAfterPut,
  );
  expect(cut).toBe(true);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({
    error: { code: "usage_archive_authority_changed" },
  });
  const originalChunk = await bucket.get(`${objectPrefix}/chunks/0`);
  expect(originalChunk).not.toBeNull();
  const encryptedBefore = await originalChunk!.arrayBuffer();
  expect(new TextDecoder().decode(encryptedBefore)).not.toContain(
    "private-journal-custody-sentinel",
  );
  const recoveredChunk = await invoke(`${artifact}/chunks/0`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${meterToken}`,
      "content-type": "application/octet-stream",
    },
    body: journal,
  });
  expect(recoveredChunk.status).toBe(200);
  const incomplete = await invoke(`${artifact}/finalize`, {
    method: "POST",
    headers: auth(),
    body: "{}",
  });
  expect(incomplete.status).toBe(409);
  expect(await incomplete.json()).toEqual({
    error: { code: "usage_archive_incomplete" },
  });
  expect(
    (
      await invoke(`${artifact}/chunks/1`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${meterToken}`,
          "content-type": "application/octet-stream",
        },
        body: manifest,
      })
    ).status,
  ).toBe(200);
  const receiptKey = `usage-archives/v1/${f.regionId}/${source.sourceId}/${source.sourceEpoch}/receipts/${preparation.descriptorId}`;
  let dropped = false;
  const lostReceipt = new Proxy(bucket, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          if (!dropped && args[0] === receiptKey) {
            dropped = true;
            throw new Error("synthetic_lost_reply");
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lost = await invoke(
    `${artifact}/finalize`,
    { method: "POST", headers: auth(), body: "{}" },
    lostReceipt,
  );
  expect(dropped).toBe(true);
  expect(lost.status).toBe(503);
  const finalized = await invoke(`${artifact}/finalize`, {
    method: "POST",
    headers: auth(),
    body: "{}",
  });
  expect(finalized.status).toBe(200);
  const complete = (await finalized.json()) as {
    receipt: {
      identity: typeof identity;
      files: Array<{ kind: string; id: string; bytes: number; sha256: string }>;
    };
    receiptSha256: string;
  };
  expect(complete.receipt.identity).toEqual(identity);
  expect(complete.receipt.files).toEqual(
    descriptor.files.map(({ kind, id, bytes, sha256 }) => ({
      kind,
      id,
      bytes,
      sha256,
    })),
  );
  expect(complete.receiptSha256).toBe(
    await sha(encoder.encode(JSON.stringify(canonical(complete.receipt)))),
  );
  expect(
    await (await bucket.get(`${objectPrefix}/chunks/0`))!.arrayBuffer(),
  ).toEqual(encryptedBefore);
  const forbidden = await invoke(
    `${artifact}/chunks/0?receiptSha256=${complete.receiptSha256}`,
    { headers: { authorization: `Bearer ${meterToken}` } },
  );
  expect(forbidden.status).toBe(401);
  const recovery = await invoke(`${artifact}/recovery`, {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ expectedReceiptSha256: complete.receiptSha256 }),
  });
  expect(recovery.status).toBe(200);
  expect(await recovery.json()).toEqual({ descriptor, ...complete });
  const download = await invoke(
    `${artifact}/chunks/0?receiptSha256=${complete.receiptSha256}`,
    { headers: installerHeaders },
  );
  expect(download.status).toBe(200);
  expect(await download.arrayBuffer()).toEqual(journal.buffer);
  const wrongEpoch = await invoke(
    `${base}/${source.sourceId}/${source.sourceEpoch + 1}/${preparation.descriptorId}/finalize`,
    { method: "POST", headers: auth(), body: "{}" },
  );
  expect(wrongEpoch.status).toBe(404);
});
