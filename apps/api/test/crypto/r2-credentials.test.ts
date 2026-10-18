// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  ArchiveCredential,
  base64urlToBytes,
  bytesToHex,
} from "@pgcf/contracts";
import {
  R2_ACTIONS,
  signR2Credential,
} from "../../src/crypto/r2-credentials.ts";

const parent = {
  accessKeyId: "a".repeat(32),
  secretAccessKey: "parent-secret-" + "b".repeat(40),
};
const request = {
  accountId: "0123456789abcdef0123456789abcdef",
  endpoint:
    "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
  bucket: "pgcf-archive",
  prefix: "eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst/",
  actions: R2_ACTIONS.read_write,
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_000 + 7 * 86_400,
};
const decoder = new TextDecoder();

function parts(jwt: string) {
  const [header, payload, signature] = jwt.split(".") as [
    string,
    string,
    string,
  ];
  return {
    header: JSON.parse(decoder.decode(base64urlToBytes(header)!)),
    payload: JSON.parse(decoder.decode(base64urlToBytes(payload)!)),
    signed: `${header}.${payload}`,
    signature: base64urlToBytes(signature)!,
  };
}
const jwtOf = (sessionToken: string) => {
  const text = atob(sessionToken);
  expect(text.startsWith("jwt/")).toBe(true);
  return text.slice(4);
};

it("signs an HS256 JWT with the parent secret and derives the temporary secret from its digest", async () => {
  const credential = await signR2Credential(parent, request);
  const jwt = jwtOf(credential.sessionToken),
    { header, payload, signed, signature } = parts(jwt);
  expect(header).toEqual({ alg: "HS256", typ: "JWT" });
  expect(payload).toEqual({
    bucket: "pgcf-archive",
    actions: [...R2_ACTIONS.read_write],
    paths: { prefixPaths: [request.prefix], objectPaths: [] },
    sub: request.accountId,
    iss: parent.accessKeyId,
    aud: "0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
    iat: request.issuedAt,
    exp: request.expiresAt,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(parent.secretAccessKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(signature),
      new TextEncoder().encode(signed),
    ),
  ).toBe(true);
  expect(credential.accessKeyId).toBe(parent.accessKeyId);
  expect(credential.secretAccessKey).toBe(
    bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt)),
      ),
    ),
  );
});

it("never lets a credential delete, copy or call HeadBucket, and reads only with read_only", () => {
  const forbidden = new Set([
    "DeleteObject",
    "DeleteObjects",
    "CopyObject",
    "UploadPartCopy",
    "HeadBucket",
    "GetBucketLocation",
  ]);
  for (const actions of Object.values(R2_ACTIONS))
    expect(actions.filter((action) => forbidden.has(action))).toEqual([]);
  expect(R2_ACTIONS.read_only).toEqual([
    "GetObject",
    "HeadObject",
    "ListObjectsV2",
  ]);
  for (const action of R2_ACTIONS.read_only)
    expect(R2_ACTIONS.read_write).toContain(action);
  // Everything a Barman upload needs: single and multipart puts, and cleaning up an aborted one.
  expect(R2_ACTIONS.read_write).toEqual(
    expect.arrayContaining([
      "PutObject",
      "CreateMultipartUpload",
      "UploadPart",
      "CompleteMultipartUpload",
      "AbortMultipartUpload",
      "ListMultipartUploads",
      "ListParts",
    ]),
  );
});

it("produces values the node contract accepts and signs differently for another prefix", async () => {
  const credential = await signR2Credential(parent, request);
  const other = await signR2Credential(parent, {
    ...request,
    prefix: "eu-dev/abcdefghijklmnopqrst/g2-op_abcdefghijklmnopqrst/",
  });
  expect(other.secretAccessKey).not.toBe(credential.secretAccessKey);
  const asContract = {
    id: "crd_" + "a".repeat(20),
    path: "s3://pgcf-archive/eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst",
    access: "read_write",
    endpoint_url: request.endpoint,
    access_key_id: credential.accessKeyId,
    secret_access_key: credential.secretAccessKey,
    session_token: credential.sessionToken,
    expires_at: new Date(request.expiresAt * 1000).toISOString(),
  } satisfies ArchiveCredential;
  expect(ArchiveCredential.parse(asContract)).toEqual(asContract);
});

it("refuses a lifetime that is not positive and an empty prefix, without echoing the secret", async () => {
  await expect(
    signR2Credential(parent, { ...request, expiresAt: request.issuedAt }),
  ).rejects.toThrow("r2_credential_invalid");
  await expect(
    signR2Credential(parent, { ...request, prefix: "" }),
  ).rejects.toThrow("r2_credential_invalid");
  await expect(
    signR2Credential({ ...parent, secretAccessKey: "" }, request),
  ).rejects.toThrow("r2_credential_invalid");
  try {
    await signR2Credential(parent, { ...request, prefix: "" });
  } catch (error) {
    expect(String(error)).not.toContain(parent.secretAccessKey);
  }
});

/** The first 16 hexadecimal characters of the SHA-256 of `text`: a pin, not a secret. */
const sha256Prefix = async (text: string) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ).slice(0, 16);

/**
 * Cloudflare's page on local signing names the payload only in part (`actions`, `paths`); the
 * claims `bucket`, `sub`, `iss`, `aud`, `iat` and `exp` and their order are the Stage 1 lab
 * signer's, whose tokens R2 accepted. This vector is that signer's output on the same inputs. What
 * it signs is pinned by the start of the SHA-256 digest of each value, so that the values
 * themselves do not stand in the repository.
 */
it("signs byte for byte what the Stage 1 lab signer signed and R2 accepted", async () => {
  const lab = await signR2Credential(
    {
      accessKeyId: "parentkeyid0123456789",
      secretAccessKey: "parent-secret-" + "0123456789abcdef",
    },
    {
      accountId: "0123456789abcdef0123456789abcdef",
      endpoint:
        "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
      bucket: "pgcf-eu",
      prefix: "eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst/",
      actions: [
        "GetObject",
        "HeadObject",
        "PutObject",
        "ListObjectsV2",
        "CreateMultipartUpload",
        "UploadPart",
        "CompleteMultipartUpload",
        "AbortMultipartUpload",
        "ListMultipartUploads",
        "ListParts",
      ],
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_000 + 7 * 86_400,
    },
  );
  expect([
    await sha256Prefix(lab.secretAccessKey),
    await sha256Prefix(lab.sessionToken),
  ]).toEqual(["5c4f7e2de304f19a", "16a8a2454c7bd1f8"]);
});

it("mints the lab's action lists", () => {
  expect(R2_ACTIONS.read_write).toEqual([
    "GetObject",
    "HeadObject",
    "PutObject",
    "ListObjectsV2",
    "CreateMultipartUpload",
    "UploadPart",
    "CompleteMultipartUpload",
    "AbortMultipartUpload",
    "ListMultipartUploads",
    "ListParts",
  ]);
});
