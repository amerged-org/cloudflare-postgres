// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UsageJournal } from "../src/usage-journal.ts";
import { runArchiveCycle, recoverUsageArchive } from "../src/usage-archive.ts";
import {
  UsageArchiveClient,
  UsageArchiveRecoveryClient,
} from "../src/usage-archive-client.ts";

const identity = {
  regionId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceEpoch: 1,
};
const start = Date.parse("2026-09-29T00:00:00.000Z");
const allocation = {
  key: "33333333-3333-4333-8333-333333333333:pod:memory",
  environmentId: "33333333-3333-4333-8333-333333333333",
  specHash: "a".repeat(64),
  resourceUid: "pod:postgres",
  metric: "memory_byte_ms",
  attribution: "primary",
  rate: "512",
  continuity: { version: 1, hash: "b".repeat(64) },
  evidenceHash: "c".repeat(64),
};
const sample = (at) => ({
  observedAt: at,
  complete: true,
  allocations: [allocation],
  issues: [],
  volumeBindings: [],
});
const accepted = (fact, sequence) => ({
  fact: structuredClone(fact),
  regionId: identity.regionId,
  organizationId: "44444444-4444-4444-8444-444444444444",
  projectId: "55555555-5555-4555-8555-555555555555",
  acceptanceSequence: String(sequence),
  acceptedAt: "2026-09-29T00:01:00.000Z",
});

test(
  "retains one complete copied-session/history artifact across an uncertain encrypted upload and independently verifies its inactive download",
  { timeout: 90000 },
  async (t) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "pgcf-usage-offnode-")),
    );
    chmodSync(directory, 0o700);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sourcePath = join(directory, "usage.sqlite"),
      roots = join(directory, "accepted"),
      custody = join(directory, "custody");
    mkdirSync(roots, { mode: 0o700 });
    mkdirSync(custody, { mode: 0o700 });
    const journal = new UsageJournal(sourcePath, identity);
    journal.beginSession(start);
    journal.observe(sample(start));
    journal.observe(sample(start + 1));
    journal.acknowledgeAccepted(accepted(journal.pending()[0], 1));
    const first = journal.archiveAccepted(join(roots, "first.json"));
    journal.observe(sample(start + 2));
    journal.acknowledgeAccepted(accepted(journal.pending()[0], 2));
    const second = journal.archiveAccepted(join(roots, "second.json"));
    journal.observe(sample(start + 3));
    journal.close();
    const db = new DatabaseSync(sourcePath, { readOnly: true });
    const sessionId = db
      .prepare("SELECT session_id FROM journal_state")
      .get().session_id;
    db.close();
    const before = readFileSync(sourcePath),
      oldFirst = readFileSync(first.path),
      oldSecond = readFileSync(second.path);
    let codec,
      prepared,
      descriptor,
      scope,
      receipt,
      receiptSha256,
      preparedRecord;
    const chunks = new Map(),
      prepareIds = [];
    let loseReply = true,
      maxChunk = 0;
    const ring = JSON.stringify({
      active: "archive-fixture",
      keys: {
        "archive-fixture": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const backend = {
      async prepare(value) {
        codec ??= await import("../../control-api/src/usage-archive-crypto.ts");
        const valid = codec.validateDescriptor(value);
        assert.ok(valid);
        const ids = await codec.descriptorIdentity(valid);
        prepareIds.push(ids.descriptorId);
        if (!preparedRecord) {
          descriptor = structuredClone(valid);
          scope = { ...identity, descriptorId: ids.descriptorId };
          preparedRecord = await codec.encryptPrepared(ring, scope, descriptor);
          prepared = await codec.decryptPrepared(ring, scope, preparedRecord);
        } else assert.deepEqual(valid, descriptor);
        if (loseReply) {
          loseReply = false;
          throw new Error("reply_lost_after_prepare_commit");
        }
        return { ...ids, descriptor: structuredClone(descriptor) };
      },
      async putChunk(id, ordinal, plain) {
        assert.equal(id, scope.descriptorId);
        maxChunk = Math.max(maxChunk, plain.byteLength);
        assert.ok(plain.byteLength <= 1048576);
        const encrypted = await codec.encryptChunk(
          prepared,
          id,
          ordinal,
          plain,
        );
        if (!chunks.has(ordinal)) chunks.set(ordinal, encrypted);
        else
          assert.deepEqual(
            await codec.decryptChunk(
              prepared,
              id,
              ordinal,
              chunks.get(ordinal),
            ),
            plain,
          );
        const expected = codec.flattened(descriptor)[ordinal].chunk;
        return { descriptorId: id, ordinal, ...expected };
      },
      async finalize(id) {
        const flat = codec.flattened(descriptor);
        assert.equal(chunks.size, flat.length);
        for (
          let fileIndex = 0;
          fileIndex < descriptor.files.length;
          fileIndex++
        ) {
          const hash = createHash("sha256");
          let bytes = 0;
          for (let ordinal = 0; ordinal < flat.length; ordinal++)
            if (flat[ordinal].fileIndex === fileIndex) {
              const plain = await codec.decryptChunk(
                prepared,
                id,
                ordinal,
                chunks.get(ordinal),
              );
              hash.update(plain);
              bytes += plain.length;
            }
          assert.equal(hash.digest("hex"), descriptor.files[fileIndex].sha256);
          assert.equal(bytes, descriptor.files[fileIndex].bytes);
        }
        const ids = await codec.descriptorIdentity(descriptor);
        receipt = {
          version: 1,
          ...ids,
          identity,
          sessionId,
          capturedAt: descriptor.capturedAt,
          files: descriptor.files.map(({ kind, id, bytes, sha256 }) => ({
            kind,
            id,
            bytes,
            sha256,
          })),
          chunkCount: flat.length,
          keyId: prepared.keyId,
          completedAt: "2026-09-30T00:00:00.000Z",
        };
        receiptSha256 = await codec.hashBytes(
          new TextEncoder().encode(JSON.stringify(codec.canonical(receipt))),
        );
        return { receipt: structuredClone(receipt), receiptSha256 };
      },
    };
    const meterToken = "cpmtr_" + "A".repeat(43),
      installerToken = "private-installation-fixture";
    const prefix = `/v1/regions/${identity.regionId}/usage-archives`;
    const fakeFetch = async (url, init) => {
      const request = new Request(url, init),
        parsed = new URL(request.url),
        path = parsed.pathname;
      const reply = (value) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path === prefix + "/prepare") {
        assert.equal(
          request.headers.get("authorization"),
          "Bearer " + meterToken,
        );
        assert.equal(request.method, "POST");
        return reply(await backend.prepare(await request.json()));
      }
      const scoped = prefix + `/${identity.sourceId}/${identity.sourceEpoch}/`;
      assert.ok(path.startsWith(scoped));
      const [id, action, ordinal] = path.slice(scoped.length).split("/");
      if (action === "chunks" && request.method === "PUT") {
        assert.equal(
          request.headers.get("authorization"),
          "Bearer " + meterToken,
        );
        return reply(
          await backend.putChunk(
            id,
            Number(ordinal),
            new Uint8Array(await request.arrayBuffer()),
          ),
        );
      }
      if (action === "finalize") {
        assert.equal(
          request.headers.get("authorization"),
          "Bearer " + meterToken,
        );
        assert.equal(request.method, "POST");
        assert.deepEqual(await request.json(), {});
        return reply(await backend.finalize(id));
      }
      assert.equal(
        request.headers.get("authorization"),
        "Bearer " + installerToken,
      );
      if (action === "recovery") {
        assert.equal(request.method, "POST");
        assert.deepEqual(await request.json(), {
          expectedReceiptSha256: receiptSha256,
        });
        return reply({
          descriptor: structuredClone(prepared.descriptor),
          receipt: structuredClone(receipt),
          receiptSha256,
        });
      }
      assert.equal(action, "chunks");
      assert.equal(request.method, "GET");
      assert.equal(parsed.searchParams.get("receiptSha256"), receiptSha256);
      const plain = await codec.decryptChunk(
        prepared,
        id,
        Number(ordinal),
        chunks.get(Number(ordinal)),
      );
      return new Response(plain, {
        headers: { "content-type": "application/octet-stream" },
      });
    };
    const transport = new UsageArchiveClient(
      "https://control.example.test",
      identity,
      async () => meterToken,
      fakeFetch,
    );
    const input = {
      sourcePath,
      directory: custody,
      acceptedArchiveRoots: [roots],
      identity,
      transport,
    };
    await runArchiveCycle(input);
    const completed = await runArchiveCycle(input);
    assert.equal(
      completed.status,
      "completed",
      "missing scheduled durable off-node custody workflow",
    );
    assert.equal(prepareIds.length, 2);
    assert.equal(prepareIds[0], prepareIds[1]);
    assert.equal(completed.descriptorId, scope.descriptorId);
    assert.equal(completed.receiptSha256, receiptSha256);
    assert.equal(descriptor.sessionId, sessionId);
    assert.equal(
      descriptor.files.filter((f) => f.kind === "accepted").length,
      2,
    );
    assert.deepEqual(
      descriptor.files
        .filter((f) => f.kind === "accepted")
        .map((f) => f.sha256)
        .sort(),
      [first.sha256, second.sha256].sort(),
    );
    assert.deepEqual(readFileSync(sourcePath), before);
    assert.deepEqual(readFileSync(first.path), oldFirst);
    assert.deepEqual(readFileSync(second.path), oldSecond);
    assert.ok(maxChunk <= 1048576);
    const recoveryTransport = new UsageArchiveRecoveryClient(
      "https://control.example.test",
      identity,
      async () => installerToken,
      fakeFetch,
    );
    const recovered = join(directory, "inactive-recovered");
    const verified = await recoverUsageArchive({
      identity,
      descriptorId: completed.descriptorId,
      expectedReceiptSha256: receiptSha256,
      targetDirectory: recovered,
      transport: recoveryTransport,
    });
    assert.equal(verified.status, "verified_archive_custody");
    assert.equal(verified.activationSupported, false);
    assert.equal(verified.sessionId, sessionId);
    assert.equal(verified.acceptedArchives, 2);
    assert.equal(verified.pendingFacts, 1);
    assert.equal(statSync(recovered).mode & 0o777, 0o700);
    assert.deepEqual(
      readFileSync(join(recovered, "usage.sqlite")),
      readFileSync(
        join(custody, "artifacts", completed.descriptorId, "usage.sqlite"),
      ),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(recovered, "manifest.json"), "utf8")),
      JSON.parse(
        readFileSync(
          join(custody, "artifacts", completed.descriptorId, "manifest.json"),
          "utf8",
        ),
      ),
    );
    assert.deepEqual(readFileSync(sourcePath), before);
  },
);
