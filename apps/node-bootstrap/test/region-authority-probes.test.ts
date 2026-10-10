// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEncryptedSecretRange,
  isExplicitRetirementRefusal,
  verifyTalosAdministrationPair,
} from "../src/region-authority-probes.ts";
test("worker retirement creates its private output directory before checking client material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-retirement-directory-")),
    output = join(root, "worker", "retirement");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    verifyTalosAdministrationPair({
      session: {
        binding: {
          node_uid: "11111111-1111-4111-8111-111111111111",
          cluster_uid: "22222222-2222-4222-8222-222222222222",
        },
        verify: async () => undefined,
      } as never,
      newDocuments: [],
      oldTalosconfig: "{}",
      newTalosconfig: "{}",
      talosctl: "/usr/local/bin/talosctl",
      kubectl: "/usr/local/bin/kubectl",
      outputDir: output,
    }),
    (error) => error instanceof Error && !error.message.includes("ENOENT"),
  );
  assert.equal((await stat(output)).mode & 0o777, 0o700);
});
function varint(value: number) {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
}
function field(id: number, value: Buffer | number) {
  return typeof value === "number"
    ? Buffer.concat([varint(id << 3), varint(value)])
    : Buffer.concat([varint((id << 3) | 2), varint(value.length), value]);
}
function range(keyName: string, extra: Buffer = Buffer.alloc(0)) {
  const key = Buffer.from("/registry/secrets/kube-system/test"),
    value = Buffer.concat([
      Buffer.from(`k8s:enc:secretbox:v1:${keyName}:`),
      Buffer.alloc(40),
    ]),
    kv = Buffer.concat([field(1, key), field(5, value)]);
  return Buffer.concat([field(2, kv), field(4, 1), extra]);
}
test("only explicit remote authentication refusal proves retirement", () => {
  assert.equal(isExplicitRetirementRefusal({ status: 401 }), true);
  assert.equal(isExplicitRetirementRefusal({ grpc_status: 16 }), true);
  assert.equal(
    isExplicitRetirementRefusal({
      tls_error_code: "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
    }),
    true,
  );
  assert.equal(
    isExplicitRetirementRefusal({ tls_error_code: "ETIMEDOUT" }),
    false,
  );
  assert.equal(
    isExplicitRetirementRefusal({ tls_error_code: "ECONNRESET" }),
    false,
  );
  assert.equal(
    isExplicitRetirementRefusal({
      tls_error_code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
    false,
  );
  assert.equal(
    isExplicitRetirementRefusal({ status: 403, grpc_status: 7 }),
    false,
  );
});
test("a real bounded encrypted range yields only key/value hashes", () => {
  const result = decodeEncryptedSecretRange(
    range("operator-key"),
    "operator-key",
  );
  assert.equal(result.count, 1);
  assert.equal(result.allCiphertextUsesExpectedKey, true);
  assert.match(result.entries[0]!.key_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.entries[0]!.value_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("kube-system"), false);
});
test("old-key ciphertext, truncated ranges and count ambiguity fail closed", () => {
  assert.throws(
    () => decodeEncryptedSecretRange(range("old-key"), "operator-key"),
    /ciphertext_key_differs/,
  );
  assert.throws(
    () =>
      decodeEncryptedSecretRange(
        range("operator-key", field(3, 1)),
        "operator-key",
      ),
    /range_truncated/,
  );
  assert.throws(
    () =>
      decodeEncryptedSecretRange(
        range("operator-key", field(4, 1)),
        "operator-key",
      ),
    /range_invalid/,
  );
  assert.throws(
    () => decodeEncryptedSecretRange(Buffer.from([32, 0]), "operator-key"),
    /range_count_invalid/,
  );
});
