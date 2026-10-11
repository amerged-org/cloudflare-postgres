// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEncryptedSecretRange,
  isExplicitRetirementRefusal,
  serviceAccountToken,
  verifyTalosAdministrationPair,
} from "../src/region-authority-probes.ts";
function probeToken(pem: string) {
  const issuer = "https://kubernetes.default.svc",
    [header, payload, signature] = serviceAccountToken(pem, issuer, {
      metadata: {
        name: "default",
        uid: "5b0f0c9e-1d4a-4c38-9a51-6f2b7d3e8a10",
      },
    }).split(".") as [string, string, string],
    publicKey = createPublicKey(pem);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(payload, "base64url").toString()),
    input: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, "base64url"),
    publicKey,
    // kube-apiserver's key ID: base64url SHA-256 of the signer's PKIX public key.
    kid: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url"),
  };
}
test("probe tokens are signed with the signer key's own JWS algorithm under kube-apiserver's key ID", () => {
  // Talos v1.6 and earlier generate the service-account signer as a SEC1 ECDSA P-256 key.
  const ec = probeToken(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "sec1", format: "pem" })
      .toString(),
  );
  assert.deepEqual(ec.header, { alg: "ES256", kid: ec.kid });
  assert.equal(ec.claims.sub, "system:serviceaccount:kube-system:default");
  // JWS ES256 is the fixed-width r||s signature, not DER.
  assert.equal(ec.signature.length, 64);
  assert.ok(
    verify(
      "sha256",
      ec.input,
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      ec.signature,
    ),
  );
  // Talos v1.7 and later generate an RSA signer.
  const rsa = probeToken(
    generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString(),
  );
  assert.deepEqual(rsa.header, { alg: "RS256", kid: rsa.kid });
  assert.ok(verify("RSA-SHA256", rsa.input, rsa.publicKey, rsa.signature));
});
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
