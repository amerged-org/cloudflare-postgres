// SPDX-License-Identifier: Apache-2.0
// The release signer (docs/operations/release-signing.md): signs the manifest of a release for the
// one workflow that may ask, and for nothing else. The private key is the Worker secret
// RELEASE_SIGNING_KEY. Cloudflare secrets are write-only through the API and the dashboard, so no
// person, no CI job and no other Worker can read it back; but this Worker's own code can, so
// whoever can deploy a version of this Worker (an account member, or any API token with Workers
// Scripts: Edit) can deploy code that returns it. The caller proves who it is with the identity
// token of its GitHub Actions run (github-token.ts); what it asks to sign is the manifest's facts
// (`ReleaseManifestFields`), from which the signer builds the text itself
// (`signedReleaseManifest`), so that no caller can have another text signed.
//
// The signer keeps no state. Ed25519 signatures are deterministic: the same facts give the same
// signature byte for byte, and there is nothing to count. That also means that a valid token gets
// ANY digests signed as the release `sha-<12 digits of its own commit>` until it expires: the
// signer ties the release id to the commit and cannot know whether the digests are the build of
// that commit. Which content a release id has is decided where it is registered: the API refuses
// a second spec for a registered version (409 for whoever registers second) and R2 never
// overwrites a file of one, and every node checks each digest of its release against the signed
// text.
import {
  RELEASE_SIGNING_SECRET,
  RELEASE_SIGN_PATH,
  ReleaseManifestFields,
  bytesToHex,
  signedReleaseManifest,
} from "@pgcf/contracts";
import {
  Refusal,
  githubKeys,
  verifyGithubToken,
  type Policy,
  type Runtime,
} from "./github-token.ts";

/** The Worker's secret and variables (wrangler.jsonc, and `provision` for the secret). */
export interface Env {
  /** The secret `provision` sets, under the name the contract gives it: the key's PKCS#8 in base64. */
  [RELEASE_SIGNING_SECRET]?: string;
  SIGNER_REPOSITORY?: string;
  SIGNER_REPOSITORY_ID?: string;
  SIGNER_REPOSITORY_OWNER_ID?: string;
  SIGNER_REF?: string;
  SIGNER_WORKFLOW?: string;
}

/** The manifest's facts are about 1 KB; a body beyond this is not read. */
const MAX_BODY_BYTES = 8192;

function answer(status: number, body: string, type: string, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": type, "cache-control": "no-store", ...extra },
  });
}
function refuse(refusal: Refusal): Response {
  console.warn(JSON.stringify({ event: "refused", code: refusal.code }));
  return answer(
    refusal.status,
    JSON.stringify({ error: refusal.code }),
    "application/json",
    refusal.status === 401
      ? { "www-authenticate": "Bearer" }
      : refusal.status === 405
        ? { allow: "POST" }
        : {},
  );
}

/** The request's body as text, or undefined for one longer than `limit` bytes (not read to its end). */
async function boundedText(
  request: Request,
  limit: number,
): Promise<string | undefined> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new Refusal(400, "manifest_invalid");
  }
}

function policyOf(env: Env, request: Request): Policy {
  const { SIGNER_REPOSITORY: repository, SIGNER_REF: ref } = env;
  const { SIGNER_REPOSITORY_ID: repositoryId } = env;
  const { SIGNER_REPOSITORY_OWNER_ID: repositoryOwnerId } = env;
  const workflow = env.SIGNER_WORKFLOW;
  if (
    !repository ||
    !repositoryId ||
    !repositoryOwnerId ||
    !ref ||
    !workflow ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[0-9]{1,20}$/.test(repositoryId) ||
    !/^[0-9]{1,20}$/.test(repositoryOwnerId) ||
    !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref) ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)
  )
    throw new Refusal(500, "signer_misconfigured");
  // The audience is the address the run reached this Worker at, which it asked GitHub for.
  return {
    repository,
    repositoryId,
    repositoryOwnerId,
    ref,
    workflow,
    audience: new URL(request.url).origin,
  };
}

export function createSigner(runtime: Runtime) {
  const githubKey = githubKeys(runtime);
  let imported: { secret: string; key: CryptoKey } | undefined;

  async function signingKey(env: Env): Promise<CryptoKey> {
    const secret = env[RELEASE_SIGNING_SECRET];
    if (!secret) throw new Refusal(500, "signer_misconfigured");
    if (imported?.secret === secret) return imported.key;
    try {
      const der = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey(
        "pkcs8",
        der,
        "Ed25519",
        false,
        ["sign"],
      );
      imported = { secret, key };
      return key;
    } catch {
      throw new Refusal(500, "signer_misconfigured");
    }
  }

  async function sign(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== RELEASE_SIGN_PATH) throw new Refusal(404, "not_found");
    if (request.method !== "POST") throw new Refusal(405, "method_not_allowed");
    const policy = policyOf(env, request);
    const bearer = /^Bearer ([^\s]+)$/.exec(
      request.headers.get("authorization") ?? "",
    );
    if (bearer === null) throw new Refusal(401, "token_missing");
    const { sha } = await verifyGithubToken(
      bearer[1]!,
      policy,
      githubKey,
      runtime.now(),
    );

    const type = request.headers.get("content-type")?.split(";")[0]?.trim();
    if (type?.toLowerCase() !== "application/json")
      throw new Refusal(415, "content_type");
    const text = await boundedText(request, MAX_BODY_BYTES);
    if (text === undefined) throw new Refusal(413, "body_too_large");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Refusal(400, "manifest_invalid");
    }
    const fields = ReleaseManifestFields.safeParse(value);
    if (!fields.success) throw new Refusal(400, "manifest_invalid");
    // The build of a commit is named for it: a run signs the release of its own commit only.
    if (fields.data.id !== `sha-${sha.slice(0, 12)}`)
      throw new Refusal(403, "release_not_of_commit");

    const key = await signingKey(env);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        new TextEncoder().encode(signedReleaseManifest(fields.data)),
      ),
    );
    console.log(JSON.stringify({ event: "signed", release: fields.data.id }));
    return answer(
      200,
      `${bytesToHex(signature)}\n`,
      "text/plain; charset=utf-8",
    );
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        return await sign(request, env);
      } catch (error) {
        if (error instanceof Refusal) return refuse(error);
        // Whatever else went wrong is logged as a class and never with its message, which could
        // hold part of a token or a key.
        console.error(JSON.stringify({ event: "failed" }));
        return answer(
          500,
          JSON.stringify({ error: "internal" }),
          "application/json",
        );
      }
    },
  };
}
