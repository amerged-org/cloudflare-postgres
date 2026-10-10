// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  openPreparedArtifact,
  prepareDailyBackup,
  verifyArtifactReadback,
} from "../src/infrastructure-backup.ts";
import type { InfrastructureBackupInput } from "@pgcf/contracts/infrastructure-backups";

const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
async function privateTemporaryParent(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-infra-fixture-"));
  const previous = process.env.TMPDIR;
  // File-local tests are serial; other test files have separate worker environments.
  process.env.TMPDIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function input(): InfrastructureBackupInput {
  return {
    run_id: randomUUID(),
    artifacts: [
      {
        id: "d1-control",
        kind: "d1",
        day: "2026-10-10",
        region_id: "eu1",
        source_id: randomUUID(),
        node_id: null,
        node_uid: null,
        cluster_uid: null,
        material_revision: null,
        d1_url: "https://exports.example.test/control.sql?grant=one",
      },
    ],
    encryption: { kid: "backup-1", key: randomBytes(32).toString("base64url") },
  };
}
function response(bytes: Uint8Array) {
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(offset + 17, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }),
  );
}
async function chunks(stream: Readable) {
  const values: Buffer[] = [];
  for await (const chunk of stream) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}

test("one daily run encrypts all sources and fully verifies streamed readback without emitting plaintext", async (t) => {
  const spec = input(),
    plain = Buffer.from(
      "CREATE TABLE retained (id INTEGER);\nINSERT INTO retained VALUES (7);\n",
    );
  spec.artifacts.push({
    ...spec.artifacts[0]!,
    id: "d1-second",
    source_id: randomUUID(),
    d1_url: "https://exports.example.test/second.sql",
  });
  let calls = 0;
  const prepared = await prepareDailyBackup(spec, {
    request: async (_url, init) => {
      assert.equal(init?.redirect, "error");
      calls++;
      return response(plain);
    },
  });
  t.after(() => prepared.close());
  assert.equal(calls, 2);
  assert.equal(prepared.artifacts.length, 2);
  for (const artifact of prepared.artifacts) {
    assert.equal(artifact.plaintext_sha256, sha(plain));
    assert.equal(artifact.plaintext_bytes, plain.length);
    assert.equal((await stat(artifact.private_file)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(dirname(artifact.private_file))).mode & 0o777,
      0o700,
    );
    const encrypted = await chunks(openPreparedArtifact(artifact));
    assert.equal(encrypted.subarray(0, 8).toString(), "PGCFINF1");
    assert.equal(sha(encrypted), artifact.encrypted_sha256);
    assert.equal(encrypted.length, artifact.encrypted_bytes);
    assert.equal(encrypted.includes(plain), false);
    const verified = await verifyArtifactReadback(
      Readable.from(
        (function* () {
          for (let i = 0; i < encrypted.length; i += 7)
            yield encrypted.subarray(i, i + 7);
        })(),
      ),
      spec.encryption.key,
      artifact,
    );
    assert.deepEqual(verified, {
      plaintext_sha256: artifact.plaintext_sha256,
      plaintext_bytes: plain.length,
      encrypted_sha256: artifact.encrypted_sha256,
      encrypted_bytes: encrypted.length,
    });
    await assert.rejects(
      verifyArtifactReadback(response(encrypted).body!, spec.encryption.key, {
        ...artifact,
        run_id: randomUUID(),
      }),
      /identity_mismatch/,
    );
    await assert.rejects(
      verifyArtifactReadback(
        Readable.from([encrypted]),
        randomBytes(32).toString("base64url"),
        artifact,
      ),
      /readback_failed/,
    );
  }
  const path = prepared.artifacts[0]!.private_file;
  await prepared.close();
  await prepared.close();
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.throws(
    () => openPreparedArtifact(prepared.artifacts[0]!),
    /not_prepared/,
  );
  assert.throws(
    () =>
      openPreparedArtifact({
        ...prepared.artifacts[0]!,
        private_file: "/etc/passwd",
      }),
    /not_prepared/,
  );
});

test("GCM rejects modified payloads even with an attacker-updated ciphertext checksum; truncation and extra bytes fail", async (t) => {
  const spec = input(),
    plain = randomBytes(8192);
  const prepared = await prepareDailyBackup(spec, {
    request: async () => response(plain),
  });
  t.after(() => prepared.close());
  const artifact = prepared.artifacts[0]!,
    bytes = await readFile(artifact.private_file),
    changed = Buffer.from(bytes);
  const ciphertextStart = 12 + bytes.readUInt32BE(8) + 12;
  changed[ciphertextStart + 20] = changed[ciphertextStart + 20]! ^ 1;
  await assert.rejects(
    verifyArtifactReadback(Readable.from([changed]), spec.encryption.key, {
      ...artifact,
      encrypted_sha256: sha(changed),
    }),
    /readback_failed/,
  );
  await assert.rejects(
    verifyArtifactReadback(
      Readable.from([bytes.subarray(0, -1)]),
      spec.encryption.key,
      artifact,
    ),
    /readback_failed/,
  );
  await assert.rejects(
    verifyArtifactReadback(
      Readable.from([bytes, Buffer.from([0])]),
      spec.encryption.key,
      artifact,
    ),
    /readback_failed/,
  );
});

test("oversized source cancels the stream and removes its private spool; canonical key and nonempty source are required", async (t) => {
  const directory = await privateTemporaryParent(t);
  let cancelled = false;
  const spec = input();
  await assert.rejects(
    prepareDailyBackup(spec, {
      maxSpoolBytes: 64 * 1024,
      request: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(2048));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    /source_limit/,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(
    prepareDailyBackup(
      {
        ...spec,
        encryption: { ...spec.encryption, key: "A".repeat(42) + "B" },
      },
      { request: async () => response(new Uint8Array([1])) },
    ),
    /key_invalid/,
  );
  await assert.rejects(
    prepareDailyBackup(spec, {
      request: async () => response(new Uint8Array()),
    }),
    /source_empty/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("etcd capture uses the daily scoped relay and retained custody, verifies after snapshot, then removes credentials", async (t) => {
  const spec = input(),
    nodeUID = randomUUID(),
    clusterUID = randomUUID(),
    nodeId = `nod_${"a".repeat(20)}`;
  const binding = {
    node_uid: nodeUID,
    cluster_uid: clusterUID,
    node_name: "retained-node",
    material_revision: 2,
  };
  const image = `quay.io/cilium/cilium@sha256:${"a".repeat(64)}`,
    snapshot = randomBytes(4096);
  const base = spec.artifacts[0]!;
  spec.artifacts = [
    {
      id: "etcd-us1",
      kind: "etcd",
      day: base.day,
      region_id: "us1",
      source_id: clusterUID,
      node_id: nodeId,
      node_uid: nodeUID,
      cluster_uid: clusterUID,
      material_revision: 2,
      source: {
        node_id: nodeId,
        node_uid: nodeUID,
        node_address: "192.0.2.44",
        kubeconfig: "ephemeral-test-kube",
        talosconfig: "ephemeral-test-talos",
        binding,
        operator_url: `https://api.example.test/internal/backups/${spec.run_id}/etcd-us1/kubernetes?node_uid=${nodeUID}`,
        operator_token: randomBytes(32).toString("base64url"),
        cilium_image: image,
        cilium_image_id: image,
      },
    },
  ];
  let verified = 0,
    closed = 0;
  const { mkdir, writeFile } = await import("node:fs/promises"),
    { join } = await import("node:path");
  const prepared = await prepareDailyBackup(spec, {
    openOperator: async (options) => {
      assert.equal(
        options.kubernetesRequest!.url,
        spec.artifacts[0]!.source!.operator_url.replace(/^https:/, "wss:"),
      );
      assert.equal(
        options.kubernetesRequest!.headers.Authorization,
        `Bearer ${spec.artifacts[0]!.source!.operator_token}`,
      );
      assert.deepEqual(options.expectedBinding, binding);
      assert.equal(options.nodeUid, nodeUID);
      assert.equal((await stat(options.kubeconfig)).mode & 0o777, 0o600);
      assert.equal((await stat(options.talosconfig)).mode & 0o777, 0o600);
      assert.ok(options.maxSnapshotBytes! > snapshot.length);
      await mkdir(options.outputDir, { mode: 0o700 });
      return {
        talosPath: options.talosconfig,
        outputDir: options.outputDir,
        binding,
        carrier: {
          physical: {
            nodeName: binding.node_name,
            address: options.nodeAddress,
            systemUuid: randomUUID(),
            bootId: randomUUID(),
          },
          pod: {
            name: "cilium-test",
            uid: randomUUID(),
            ownerUid: randomUUID(),
            image,
            imageID: image,
          },
        },
        verify: async () => {
          verified++;
        },
        close: async () => {
          closed++;
        },
        connections: () => 1,
        run: async (args) => {
          assert.deepEqual(args, ["etcd", "snapshot", "control.snapshot"]);
          await writeFile(join(options.outputDir, args[2]!), snapshot, {
            mode: 0o600,
            flag: "wx",
          });
          return Buffer.from("snapshot complete");
        },
      };
    },
  });
  t.after(() => prepared.close());
  assert.equal(verified, 1);
  assert.equal(closed, 1);
  const artifact = prepared.artifacts[0]!;
  assert.deepEqual(await readdir(dirname(artifact.private_file)), [
    "encrypted.private",
  ]);
  assert.equal(artifact.node_uid, nodeUID);
  assert.equal(artifact.cluster_uid, clusterUID);
  assert.equal(artifact.material_revision, 2);
  assert.equal(artifact.plaintext_sha256, sha(snapshot));
  await verifyArtifactReadback(
    openPreparedArtifact(artifact),
    spec.encryption.key,
    artifact,
  );
});

test("the daily run cannot retain ciphertexts beyond its cumulative private workspace budget", async (t) => {
  const directory = await privateTemporaryParent(t);
  const spec = input(),
    plain = randomBytes(20_000);
  const base = spec.artifacts[0]!;
  spec.artifacts = Array.from({ length: 4 }, (_, index) => ({
    ...base,
    id: `d1-${index}`,
    source_id: randomUUID(),
  }));
  await assert.rejects(
    prepareDailyBackup(spec, {
      maxSpoolBytes: 64 * 1024,
      request: async () => response(plain),
    }),
    /workspace_limit/,
  );
  assert.deepEqual(await readdir(directory), []);
});
