// SPDX-License-Identifier: Apache-2.0
// What the signer's tests stand in for GitHub with: an RSA key pair made here, its JWKS, and
// identity tokens in the form GitHub Actions issues, signed by it. Nothing here is a real key,
// and it uses WebCrypto only, so that the Worker's tests (workerd) and the scripts' tests (Node)
// both run it.
import { bytesToBase64url } from "@pgcf/contracts";

export const ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;
/** The signer's own address in the tests, which the token's audience must be. */
export const SIGNER_ORIGIN = "https://signer.example";
export const SIGNER_URL = `${SIGNER_ORIGIN}/sign`;
/** What the signer's variables say in `wrangler.jsonc`, in the tests. */
export const POLICY_VARS = {
  SIGNER_REPOSITORY: "example-org/example-repo",
  SIGNER_REF: "refs/heads/main",
  SIGNER_WORKFLOW: ".github/workflows/ci.yml",
};
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
/** The release a build of `COMMIT` is named: CI builds `sha-<first 12 digits of the commit>`. */
export const RELEASE_ID = `sha-${COMMIT.slice(0, 12)}`;

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;
const encoder = new TextEncoder();
const json = (value: unknown) =>
  bytesToBase64url(encoder.encode(JSON.stringify(value)));

/** One GitHub signing key: the public half as a JWKS entry and the means to mint a token. */
export interface GithubKey {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  mint(
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ): Promise<string>;
}
export async function githubKey(kid: string): Promise<GithubKey> {
  const pair = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid,
    use: "sig",
    alg: "RS256",
  };
  return {
    kid,
    jwk,
    async mint(claims, header = {}) {
      const input = `${json({ alg: "RS256", typ: "JWT", kid, ...header })}.${json(claims)}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          pair.privateKey,
          encoder.encode(input),
        ),
      );
      return `${input}.${bytesToBase64url(signature)}`;
    },
  };
}

/** The claims of a run of the workflow that may sign, at `now` (milliseconds). */
export function claims(
  now: number,
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  const seconds = Math.floor(now / 1000);
  const [owner] = POLICY_VARS.SIGNER_REPOSITORY.split("/");
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: SIGNER_ORIGIN,
    sub: `repo:${POLICY_VARS.SIGNER_REPOSITORY}:ref:${POLICY_VARS.SIGNER_REF}`,
    repository: POLICY_VARS.SIGNER_REPOSITORY,
    repository_owner: owner,
    ref: POLICY_VARS.SIGNER_REF,
    sha: COMMIT,
    event_name: "push",
    job_workflow_ref: `${POLICY_VARS.SIGNER_REPOSITORY}/${POLICY_VARS.SIGNER_WORKFLOW}@${POLICY_VARS.SIGNER_REF}`,
    runner_environment: "github-hosted",
    iat: seconds,
    nbf: seconds - 5,
    exp: seconds + 300,
  };
  for (const [name, value] of Object.entries(override))
    if (value === undefined) delete claims[name];
    else claims[name] = value;
  return claims;
}

/** The answer of GitHub's JWKS endpoint for these keys. */
export const jwks = (...keys: GithubKey[]) => ({
  keys: keys.map((key) => key.jwk),
});

/** An Ed25519 key pair for the release key: the secret as the signer reads it, and the public key. */
export async function releaseKey(): Promise<{
  secret: string;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  return { secret: btoa(binary), publicKey: pair.publicKey };
}
