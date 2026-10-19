// SPDX-License-Identifier: Apache-2.0
// The caller's identity: a GitHub Actions OIDC token, an RS256 JWT that GitHub signs for one run of
// one workflow and that the run asks for with an audience of its own choosing. The signer accepts
// it only when GitHub's key signed it, it names this signer as its audience, it is current, and
// its claims say that it belongs to a push to the one ref of the one repository whose one workflow
// file asked, on a runner GitHub hosts. The repository and its owner are named twice, by name and
// by GitHub's numeric id: a name is freed by a rename, a transfer or a deletion and can be taken by
// someone else, an id never moves.
import { base64urlToBytes } from "@pgcf/contracts";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
/** How long the keys are kept, and the youngest keys that an unknown key id fetches again. */
const KEY_TTL_MS = 5 * 60_000;
const REFETCH_AFTER_MS = 30_000;
const SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** What the signer takes from its environment: the clock and the network, as the Worker's own. */
export interface Runtime {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

/** A request that is refused: its HTTP status and a short code that says why, never a value. */
export class Refusal extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** The workflow that may ask: the variables of the Worker. */
export interface Policy {
  repository: string;
  /** GitHub's numeric ids of the repository and of its owner, as the token's claims spell them. */
  repositoryId: string;
  repositoryOwnerId: string;
  ref: string;
  workflow: string;
  /** The signer's own address, which the run asked GitHub to put in the token. */
  audience: string;
}

/**
 * GitHub's signing keys, from its JWKS endpoint: kept for a few minutes, and fetched again, once
 * per half minute at most, for a key id that the kept keys do not hold (GitHub rotates them).
 */
export function githubKeys(runtime: Runtime) {
  let kept: { at: number; keys: Map<string, CryptoKey> } | undefined;

  async function load(): Promise<void> {
    try {
      // `manual`: a redirect is an answer that is not the keys, and is refused with any other status.
      const response = await runtime.fetch(GITHUB_JWKS_URL, {
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200) throw new Error("status");
      const body = (await response.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error("shape");
      const keys = new Map<string, CryptoKey>();
      for (const entry of body.keys as Record<string, unknown>[]) {
        const { kty, kid, n, e, alg, use } = entry ?? {};
        if (
          kty !== "RSA" ||
          typeof kid !== "string" ||
          typeof n !== "string" ||
          typeof e !== "string" ||
          (alg !== undefined && alg !== "RS256") ||
          (use !== undefined && use !== "sig")
        )
          continue;
        try {
          keys.set(
            kid,
            await crypto.subtle.importKey(
              "jwk",
              { kty, n, e, alg: "RS256", ext: true },
              RS256,
              false,
              ["verify"],
            ),
          );
        } catch {
          // A key that cannot be imported is not one to verify with.
        }
      }
      if (keys.size === 0) throw new Error("no keys");
      kept = { at: runtime.now(), keys };
    } catch {
      throw new Refusal(503, "jwks_unavailable");
    }
  }

  return async (kid: string): Promise<CryptoKey | undefined> => {
    const age = kept ? runtime.now() - kept.at : Infinity;
    if (kept === undefined || age >= KEY_TTL_MS) await load();
    else if (!kept.keys.has(kid) && age >= REFETCH_AFTER_MS) await load();
    return kept?.keys.get(kid);
  };
}

function segment(text: string): Uint8Array {
  const bytes = base64urlToBytes(text);
  if (bytes === null || bytes.length === 0)
    throw new Refusal(401, "token_malformed");
  return bytes;
}
function object(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new Refusal(401, "token_malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Refusal(401, "token_malformed");
  return value as Record<string, unknown>;
}

/**
 * The commit of the run that the token names, once the token is GitHub's, current, meant for
 * this signer, and of the workflow the policy names. A token that fails is refused with the
 * claim's name and never its value.
 */
export async function verifyGithubToken(
  token: string,
  policy: Policy,
  key: (kid: string) => Promise<CryptoKey | undefined>,
  nowMs: number,
): Promise<{ sha: string }> {
  if (token.length > MAX_TOKEN_LENGTH)
    throw new Refusal(401, "token_malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Refusal(401, "token_malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  const header = object(segment(headerPart));
  const payload = object(segment(payloadPart));
  const signature = segment(signaturePart);
  // The one algorithm GitHub signs with; an unsecured token or one under a shared secret is not accepted.
  if (header.alg !== "RS256") throw new Refusal(401, "token_algorithm");
  const verifier =
    typeof header.kid === "string" ? await key(header.kid) : undefined;
  if (verifier === undefined) throw new Refusal(401, "token_key_unknown");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    verifier,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Refusal(401, "token_signature");

  if (payload.iss !== GITHUB_ISSUER) throw new Refusal(401, "token_issuer");
  if (payload.aud !== policy.audience) throw new Refusal(401, "token_audience");
  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS < now)
    throw new Refusal(401, "token_expired");
  if (typeof payload.nbf !== "number" || payload.nbf - SKEW_SECONDS > now)
    throw new Refusal(401, "token_not_yet_valid");

  const owner = policy.repository.slice(0, policy.repository.indexOf("/"));
  const expected: [string, string][] = [
    ["repository", policy.repository],
    ["repository_id", policy.repositoryId],
    ["repository_owner", owner],
    ["repository_owner_id", policy.repositoryOwnerId],
    ["ref", policy.ref],
    ["event_name", "push"],
    [
      "job_workflow_ref",
      `${policy.repository}/${policy.workflow}@${policy.ref}`,
    ],
    ["runner_environment", "github-hosted"],
  ];
  for (const [name, value] of expected)
    if (payload[name] !== value) throw new Refusal(403, `claim_${name}`);
  if (typeof payload.sha !== "string" || !/^[0-9a-f]{40}$/.test(payload.sha))
    throw new Refusal(403, "claim_sha");
  return { sha: payload.sha };
}
