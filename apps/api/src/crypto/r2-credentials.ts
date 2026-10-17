// SPDX-License-Identifier: Apache-2.0
import { bytesToBase64url, bytesToHex } from "@pgcf/contracts";

/**
 * Temporary R2 credentials signed locally with the Worker's parent key (ULTRA plan 7.3, Cloudflare's
 * local-signing method): an HS256 JWT over the parent secret names the bucket, the S3 actions and
 * the key prefixes; the temporary access key is the parent's, the temporary secret is the SHA-256
 * digest of the JWT, and the session token is `base64("jwt/" + JWT)`. Only this method accepts an
 * explicit list of actions, so a credential can be made unable to delete.
 *
 * HeadBucket and GetBucketLocation are left out on purpose: Barman needs neither for archiving,
 * backing up or restoring (Stage 1 ran all four jobs with credentials that cannot call HeadBucket).
 */
export const R2_ACTIONS = {
  read_only: ["HeadObject", "GetObject", "ListObjectsV2"],
  read_write: [
    "HeadObject",
    "GetObject",
    "ListObjectsV2",
    "PutObject",
    "CreateMultipartUpload",
    "UploadPart",
    "CompleteMultipartUpload",
    "AbortMultipartUpload",
    "ListMultipartUploads",
    "ListParts",
  ],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export interface R2ParentKey {
  accessKeyId: string;
  secretAccessKey: string;
}
export interface R2CredentialRequest {
  /** The Cloudflare account that owns the bucket (the `sub` claim). */
  accountId: string;
  /** The bucket's S3 endpoint; its host is the audience. */
  endpoint: string;
  bucket: string;
  /** Every key the credential may touch starts with this prefix. */
  prefix: string;
  actions: readonly [string, ...string[]];
  /** Seconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
}
export interface R2TemporaryCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const encoder = new TextEncoder();
const invalid = () => new Error("r2_credential_invalid");

export async function signR2Credential(
  parent: R2ParentKey,
  request: R2CredentialRequest,
): Promise<R2TemporaryCredential> {
  let audience: string;
  try {
    audience = new URL(request.endpoint).host;
  } catch {
    throw invalid();
  }
  if (
    parent.accessKeyId === "" ||
    parent.secretAccessKey === "" ||
    request.accountId === "" ||
    request.bucket === "" ||
    request.prefix === "" ||
    request.actions.length === 0 ||
    !Number.isSafeInteger(request.issuedAt) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= request.issuedAt
  )
    throw invalid();
  const part = (value: unknown) =>
    bytesToBase64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({
    bucket: request.bucket,
    actions: request.actions,
    paths: { prefixPaths: [request.prefix], objectPaths: [] },
    sub: request.accountId,
    iss: parent.accessKeyId,
    aud: audience,
    iat: request.issuedAt,
    exp: request.expiresAt,
  })}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(parent.secretAccessKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned)),
  );
  const jwt = `${unsigned}.${bytesToBase64url(signature)}`;
  return {
    accessKeyId: parent.accessKeyId,
    secretAccessKey: bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(jwt)),
      ),
    ),
    sessionToken: btoa(`jwt/${jwt}`),
  };
}
