// SPDX-License-Identifier: Apache-2.0
// The release key (ULTRA plan 9.3, docs/operations/release-signing.md): an Ed25519 key pair whose
// private half is the Worker secret RELEASE_SIGNING_KEY of the signer (apps/release-signer),
// which Cloudflare does not let anyone read back, and whose public half the node agent has
// compiled in, read from apps/node-agent/release-signing.pub. The signer signs the manifest of a
// release for CI's job `sign-release` (sign-release.ts); a node checks the signature before it
// installs anything of the release, and the API Worker checks it with the same public key (a
// constant generated from the file, packages/contracts/native/generate-release-key.ts) when the
// release is registered and again before a node is installed from its image. The registration
// script checks it too, so that no release that the API and every node would refuse is uploaded. This module holds what the checks share and the
// operator's one command that makes the key. Nothing here prints a key.
//
//   node scripts/operations/release-signing.ts provision --token-env NAME --account-env NAME
//     [--worker NAME] [--public FILE] [--api-base URL] [--rotate]
//
//     Makes the key pair in memory, sets the private half as the Worker's secret through the
//     Cloudflare API, and only after the API accepted it writes the public half to FILE (default
//     apps/node-agent/release-signing.pub), then prints the public key's fingerprint and the next
//     steps. The private key is never written to a disk, a log or a terminal; nobody ever sees
//     it. --token-env and --account-env name the environment variables that hold the API token
//     (Workers Scripts edit on the account) and the account id: a value never goes on the
//     command line. --worker is the signer (default pgcf-release-signer-dev), which has to be
//     deployed already. The command NEVER replaces a secret: it refuses while the Worker already
//     holds RELEASE_SIGNING_KEY, whatever else is given, because a secret cannot be read back and
//     the one the Worker holds may be the only copy of the key every node trusts. A new key goes to
//     a Worker that holds none (the second signer of a rotation, or the new Worker after a loss).
//     The command also refuses while FILE already holds a key other than the placeholder; --rotate
//     lifts that one refusal, and the procedure that goes with it, which keeps the old key signing
//     until every node trusts the new one, is in the runbook.
//
// The order of the steps leaves the previous key usable after a failure of any of them: the
// files are read first, the secret is listed before it is set, the file is replaced only once
// the API has accepted the secret, and it is replaced atomically.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_SIGNING_SECRET } from "../../packages/contracts/src/releases.ts";

/** The public key the agent is built with: 64 lowercase hex digits and a line feed. */
export const RELEASE_KEY_FILE = join(
  import.meta.dirname,
  "../../apps/node-agent/release-signing.pub",
);

/**
 * The public key the repository carries until `provision` makes the real one, so that every
 * build compiles before the key exists. Nobody holds its private half: a release it "verifies"
 * can not exist, and CI refuses to sign a build that carries it.
 */
export const PLACEHOLDER_RELEASE_KEY =
  // A public key, the one in release-signing.pub: not a secret.
  "5f55de98ed55bfff7955cdadcbc582a996720851145505902423f8842e32fedc"; // gitleaks:allow

// The DER header of an Ed25519 SubjectPublicKeyInfo; the 32 bytes of the key follow it.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyPattern = /^[0-9a-f]{64}$/;

/**
 * A new key pair: the private key as the signer reads it from its secret (PKCS#8 in base64) and
 * the public key as 64 hex digits.
 */
export function generateReleaseKey(): { secret: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const secret = der.toString("base64");
  der.fill(0);
  return {
    secret,
    publicKey: Buffer.from(
      pair.publicKey.export({ type: "spki", format: "der" }),
    )
      .subarray(SPKI_ED25519.length)
      .toString("hex"),
  };
}

/** Whether `signature` is the signature of `text` by the holder of `publicKey`. */
export function verifyText(
  publicKey: string,
  text: string,
  signature: string,
): boolean {
  if (!publicKeyPattern.test(publicKey) || !/^[0-9a-f]{128}$/.test(signature))
    return false;
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, "hex")]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(text), key, Buffer.from(signature, "hex"));
}

/** The public key of a release key file; anything but one key is refused. */
export async function readReleaseKey(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`the release key file ${path} cannot be read`);
  }
  const key = text.replace(/\n$/, "");
  if (!publicKeyPattern.test(key))
    throw new Error(
      `the release key file ${path} holds no public key: 64 lowercase hex digits and a line feed`,
    );
  return key;
}

// ---------- The Cloudflare API ----------

export interface ProvisionOptions {
  /** The API's origin and path prefix: https, or http on this machine. */
  apiBase: string;
  apiToken: string;
  accountId: string;
  worker: string;
  publicPath: string;
  rotate: boolean;
}
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What the API answered, without any value of the request that it may have echoed. */
function refusal(
  action: string,
  response: Response,
  body: unknown,
  hidden: string[],
): Error {
  const clean = (text: string) =>
    hidden.reduce((rest, value) => rest.replaceAll(value, "[redacted]"), text);
  const errors = (
    body as { errors?: { code?: unknown; message?: unknown }[] } | null
  )?.errors;
  const reasons = (Array.isArray(errors) ? errors : [])
    .slice(0, 3)
    .map(({ code, message }) =>
      `${typeof code === "number" ? code : "?"} ${typeof message === "string" ? clean(message).slice(0, 160) : ""}`.trim(),
    );
  return new Error(
    `the Cloudflare API refused to ${action}: ${response.status}${reasons.length > 0 ? ` ${reasons.join("; ")}` : ""}`,
  );
}

function call(
  options: ProvisionOptions,
  method: "GET" | "PUT",
  body: unknown,
  fetchImpl: Fetch,
): Promise<Response> {
  const url = `${options.apiBase.replace(/\/$/, "")}/accounts/${options.accountId}/workers/scripts/${options.worker}/secrets`;
  return fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

/** The names of the secrets the Worker holds; values are never listed by the API. */
async function secretNames(
  options: ProvisionOptions,
  fetchImpl: Fetch,
): Promise<string[]> {
  const hidden = [options.apiToken];
  let response: Response;
  try {
    response = await call(options, "GET", undefined, fetchImpl);
  } catch {
    throw new Error("the Cloudflare API cannot be reached");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404)
    throw new Error(
      `the Worker ${options.worker} does not exist in this account: deploy it first (cd apps/release-signer && npx wrangler deploy)`,
    );
  const result = (body as { success?: boolean; result?: unknown } | null)
    ?.result;
  if (
    !response.ok ||
    (body as { success?: boolean } | null)?.success !== true ||
    !Array.isArray(result)
  )
    throw refusal("list the secrets of the Worker", response, body, hidden);
  return result
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string");
}

/** Replaces the file at `path` with the public key, all at once. */
async function writePublicKey(path: string, publicKey: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${publicKey}\n`, { mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The SHA-256 of the 32 bytes of the public key, in hex: what the owner compares. */
const fingerprintOf = (publicKey: string) =>
  createHash("sha256").update(Buffer.from(publicKey, "hex")).digest("hex");

/**
 * Makes the key and sets it as the signer's secret, then records its public half. See the
 * header for the order, which is the point.
 */
export async function provision(
  options: ProvisionOptions,
  fetchImpl: Fetch = fetch,
): Promise<{ publicKey: string; fingerprint: string }> {
  const base = URL.parse(options.apiBase);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    base?.hostname ?? "",
  );
  if (
    !base ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    base.username !== "" ||
    base.password !== ""
  )
    throw new Error("the API base is https, or http on this machine");

  // 1. Read before anything is asked or made: a file that is none stops here, and a real key in
  //    it stops the command unless it was asked to rotate.
  const held = await readReleaseKey(options.publicPath);
  if (held !== PLACEHOLDER_RELEASE_KEY && !options.rotate)
    throw new Error(
      `${options.publicPath} holds a key that is not the placeholder: the nodes trust it, and nothing but the Worker secret holds its private half. Pass --rotate only for the key change that docs/operations/release-signing.md describes`,
    );
  // 2. The Worker holds a key already: the one the nodes trust may be that one, and a secret
  //    cannot be read back. Nothing lifts this refusal, --rotate included.
  if ((await secretNames(options, fetchImpl)).includes(RELEASE_SIGNING_SECRET))
    throw new Error(
      `the Worker ${options.worker} already holds the secret ${RELEASE_SIGNING_SECRET}, which cannot be read back: this command never replaces it, because it may be the only copy of the key the nodes trust. Deploy another Worker under another name and pass it as --worker (docs/operations/release-signing.md), or, only if that key is lost, delete the secret first with: npx wrangler secret delete ${RELEASE_SIGNING_SECRET} --name ${options.worker}`,
    );

  // 3. The key exists only from here, in memory.
  const { secret, publicKey } = generateReleaseKey();
  const hidden = [options.apiToken, secret];
  let response: Response;
  try {
    response = await call(
      options,
      "PUT",
      { name: RELEASE_SIGNING_SECRET, text: secret, type: "secret_text" },
      fetchImpl,
    );
  } catch {
    // The answer did not arrive: the API may or may not have set the secret. The Worker held none
    // before (step 2), so deleting what may be there loses no key anyone trusts.
    throw new Error(
      `the Cloudflare API did not answer the request that sets the secret, so it is not known whether the Worker now holds a new key. The new key's public half is ${publicKey}; the file ${options.publicPath} is unchanged. The Worker held no secret before this command: delete the one it may hold with \`npx wrangler secret delete ${RELEASE_SIGNING_SECRET} --name ${options.worker}\` and run the command again`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || (body as { success?: boolean } | null)?.success !== true)
    throw refusal("set the secret", response, body, hidden);

  // 4. The Worker signs with the new key from here on; the file follows, and if it cannot, the
  //    public half is in the message, which is no secret.
  try {
    await writePublicKey(options.publicPath, publicKey);
  } catch {
    throw new Error(
      `the secret is set, but ${options.publicPath} could not be written: put this public key in it, 64 hex digits and a line feed: ${publicKey}`,
    );
  }
  return { publicKey, fingerprint: fingerprintOf(publicKey) };
}

// ---------- The command ----------

// An upper-case name, as variables are named: a token typed in its place is not one, and is
// refused without being quoted.
const variableName = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** The value of the variable that a command-line option names; a missing or malformed one is named, never shown. */
function fromVariable(
  environment: Record<string, string | undefined>,
  name: string | undefined,
  pattern: RegExp,
  what: string,
): string {
  if (name === undefined || !variableName.test(name))
    throw new Error(
      `the option names the environment variable that holds ${what}: it takes a variable name, never the value itself`,
    );
  const value = environment[name];
  if (!value) throw new Error(`set ${name}, which holds ${what}`);
  if (!pattern.test(value)) throw new Error(`${name} does not hold ${what}`);
  return value;
}

export async function main(
  argv: string[],
  environment: Record<string, string | undefined>,
  print: (line: string) => void,
): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "token-env": { type: "string" },
      "account-env": { type: "string" },
      worker: { type: "string", default: "pgcf-release-signer-dev" },
      public: { type: "string" },
      "api-base": { type: "string", default: DEFAULT_API_BASE },
      rotate: { type: "boolean", default: false },
    },
  });
  if (command !== "provision" || !values["token-env"] || !values["account-env"])
    throw new Error(
      "usage: release-signing.ts provision --token-env NAME --account-env NAME [--worker NAME] [--public FILE] [--api-base URL] [--rotate]",
    );
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.worker))
    throw new Error("--worker is the name of a Worker");
  const publicPath = values.public ?? RELEASE_KEY_FILE;
  const { fingerprint } = await provision({
    apiBase: values["api-base"],
    apiToken: fromVariable(
      environment,
      values["token-env"],
      /^[A-Za-z0-9_-]{20,128}$/,
      "a Cloudflare API token",
    ),
    accountId: fromVariable(
      environment,
      values["account-env"],
      /^[0-9a-f]{32}$/,
      "the Cloudflare account id",
    ),
    worker: values.worker,
    publicPath,
    rotate: values.rotate,
  });
  print(
    `set the secret ${RELEASE_SIGNING_SECRET} of the Worker ${values.worker}; the private key was never written or printed`,
  );
  print(`wrote the public key to ${publicPath}`);
  print(`public key fingerprint (sha256 of its 32 bytes): ${fingerprint}`);
  print("next:");
  print(
    "  1. run `node packages/contracts/native/generate-release-key.ts`: it copies the public key into the",
  );
  print(
    "     constant the API Worker verifies releases with (CI fails while the two differ)",
  );
  print(
    "  2. commit both files on the branch that carries the sign-release job, and merge only with them:",
  );
  print(
    "     a main without the key is red at the signing job (docs/operations/release-signing.md)",
  );
  print(
    "  3. set the repository variable RELEASE_SIGNER_URL to the Worker's https origin",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env, console.log).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "failed");
      process.exitCode = 1;
    },
  );
}
