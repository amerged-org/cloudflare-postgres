// SPDX-License-Identifier: Apache-2.0
// The step of CI's job `sign-release` (ULTRA plan 9.3, docs/operations/release-signing.md):
//
//   node scripts/operations/sign-release.ts sign --image-dir DIR --binaries DIR [--lock FILE]
//
// It takes the release's manifest (the digests the registration states, `ReleaseManifestFields`:
// the image's compressed and raw sha256 and size from the build summary `pgcf-node.json`, the four
// binaries, the package lock, the snapshot and the host files) and has the signer Worker
// (`apps/release-signer`) sign it. The job holds no key and no secret:
// it proves who it is to the signer with the identity token of its own GitHub Actions run, which
// the runner hands to a job that has `id-token: write`, requested here for the signer's address
// as its audience. The signature is written to DIR/release.sig, which the registration reads and
// the API verifies and stores. The options are those of register-node-image.ts, and the files are checked the
// same way. The signer's address is the variable RELEASE_SIGNER_URL (the repository variable of
// that name, an origin). The step fails, and writes nothing, while the committed public key is
// still the placeholder, while the signer cannot be reached, and when it answers with anything
// but a signature. Neither token is ever printed.
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  RELEASE_SIGNATURE_FILE,
  RELEASE_SIGN_PATH,
  ReleaseSignature,
  releaseManifestFields,
  type ReleaseManifestFields,
} from "../../packages/contracts/src/releases.ts";
import { releaseManifest, type Manifest } from "./register-node-image.ts";
import {
  PLACEHOLDER_RELEASE_KEY,
  RELEASE_KEY_FILE,
  readReleaseKey,
} from "./release-signing.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Environment = Record<string, string | undefined>;

/** The signer's origin, which is also the audience of the identity token: https, or http on this machine. */
function signerOrigin(environment: Environment): string {
  const url = URL.parse(environment.RELEASE_SIGNER_URL ?? "");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    url?.hostname ?? "",
  );
  if (!environment.RELEASE_SIGNER_URL)
    throw new Error(
      "RELEASE_SIGNER_URL is not set: it is the repository variable that holds the signer Worker's https origin (docs/operations/release-signing.md)",
    );
  if (
    !url ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(
      "RELEASE_SIGNER_URL must be an https origin and nothing more: a scheme, a host and no path, query or credentials",
    );
  return url.origin;
}

/** The identity token of this run, for the signer as its audience. */
async function identityToken(
  environment: Environment,
  audience: string,
  fetchImpl: Fetch,
): Promise<string> {
  const requestUrl = URL.parse(environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  const credential = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !credential)
    throw new Error(
      "no identity token can be requested: the job needs `permissions: id-token: write`, which is what gives a step ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    );
  requestUrl.searchParams.set("audience", audience);
  let value: unknown;
  try {
    const response = await fetchImpl(requestUrl.href, {
      headers: {
        authorization: `bearer ${credential}`,
        accept: "application/json; api-version=2.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("status");
    value = ((await response.json()) as { value?: unknown }).value;
  } catch {
    throw new Error("the runner did not give an identity token for this job");
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{20,8000}$/.test(value))
    throw new Error("the runner did not give an identity token for this job");
  return value;
}

/** The facts of the manifest that the registration states, which are what the signer signs. */
export const signedFields = (manifest: Manifest): ReleaseManifestFields =>
  releaseManifestFields({ id: manifest.version, ...manifest.registration });

/**
 * Has the signer sign the manifest of a build and writes the signature, 128 hex digits and a line
 * feed, as `release.sig` into `directory`. Nothing is written for a build that cannot be signed,
 * and while `committedKey`, the public key of this checkout that the build's agent trusts, is
 * still the placeholder, nobody is asked: the signer's key would sign a build whose agents trust
 * a key that nobody holds.
 */
export async function signBuild(
  manifest: Manifest,
  directory: string,
  options: {
    environment: Environment;
    committedKey: string;
    fetchImpl?: Fetch;
  },
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.committedKey === PLACEHOLDER_RELEASE_KEY)
    throw new Error(
      "apps/node-agent/release-signing.pub still holds the placeholder key, so the agent of this build trusts a key that nobody holds: commit the public key that `release-signing.ts provision` wrote, with the constant `generate-release-key.ts` makes of it, before this commit reaches main (docs/operations/release-signing.md)",
    );
  const origin = signerOrigin(options.environment);
  const fields = signedFields(manifest);
  const token = await identityToken(options.environment, origin, fetchImpl);

  let response: Response;
  try {
    response = await fetchImpl(`${origin}${RELEASE_SIGN_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(fields),
      // The token goes to the signer's address and to no address that answers in its place.
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`the signer at ${origin} cannot be reached`);
  }
  const answer = await response.text().catch(() => "");
  if (response.status !== 200) {
    const code = (() => {
      try {
        const { error } = JSON.parse(answer) as { error?: unknown };
        return typeof error === "string" && /^[a-z0-9_]{1,64}$/.test(error)
          ? error
          : undefined;
      } catch {
        return undefined;
      }
    })();
    throw new Error(
      `the signer refused to sign ${manifest.version}: ${response.status}${code ? ` ${code}` : ""}`,
    );
  }
  const signature = ReleaseSignature.safeParse(answer.replace(/\n$/, ""));
  if (!signature.success)
    throw new Error("the signer's answer is not a signature");
  const path = join(directory, RELEASE_SIGNATURE_FILE);
  await writeFile(path, `${signature.data}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
  return signature.data;
}

async function main(argv: string[], environment: Environment) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "image-dir": { type: "string" },
      binaries: { type: "string" },
      lock: { type: "string" },
    },
  });
  if (command === "sign" && values["image-dir"] && values.binaries) {
    const imageDir = resolve(values["image-dir"]);
    const manifest = await releaseManifest({
      imageDir,
      binariesDir: resolve(values.binaries),
      ...(values.lock ? { lockPath: resolve(values.lock) } : {}),
    });
    const signature = await signBuild(manifest, imageDir, {
      environment,
      committedKey: await readReleaseKey(RELEASE_KEY_FILE),
    });
    console.log(
      `signed ${manifest.version}: ${RELEASE_SIGNATURE_FILE} ${signature}`,
    );
    return;
  }
  throw new Error(
    "usage: sign-release.ts sign --image-dir DIR --binaries DIR [--lock FILE]",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
