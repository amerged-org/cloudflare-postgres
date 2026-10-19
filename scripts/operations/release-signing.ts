// SPDX-License-Identifier: Apache-2.0
// The release key (ULTRA plan 9.3, docs/operations/release-signing.md): an Ed25519 key pair whose
// private half only the GitHub environment `release-signing` holds (the environment secret
// RELEASE_SIGNING_KEY; the environment's deployment branch policy allows only main) and whose
// public half the node agent has compiled in, read from apps/node-agent/release-signing.pub. CI
// signs the manifest of each release (`signedReleaseManifest`) in its own job; a node checks the
// signature before it installs anything of the release; registration checks it too, so that a
// release no node would accept is never registered. This module is the shared part: nothing here
// prints a key.
//
// The owner makes the key pair once, after the environment exists. The private key goes to the
// pipe and nowhere else, so it is never on a disk or in a terminal. The file of the placeholder
// key is replaced without a flag; a key that is already there is replaced only with --replace,
// which is the rotation procedure and never a second first key:
//
//   node scripts/operations/sign-release.ts keygen --public apps/node-agent/release-signing.pub \
//     | gh secret set RELEASE_SIGNING_KEY --env release-signing
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The public key the agent is built with: 64 lowercase hex digits and a line feed. */
export const RELEASE_KEY_FILE = join(
  import.meta.dirname,
  "../../apps/node-agent/release-signing.pub",
);

/**
 * The public key the repository carries until the owner makes the real one, so that every build
 * compiles before the key exists. Nobody holds its private half: a release it "verifies" can
 * not exist, and CI refuses to sign a build that carries it.
 */
export const PLACEHOLDER_RELEASE_KEY =
  // A public key, the one in release-signing.pub: not a secret.
  "5f55de98ed55bfff7955cdadcbc582a996720851145505902423f8842e32fedc"; // gitleaks:allow

// The DER header of an Ed25519 SubjectPublicKeyInfo; the 32 bytes of the key follow it.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyPattern = /^[0-9a-f]{64}$/;

/** A key pair: the private key as PKCS#8 PEM and the public key as 64 hex digits. */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    publicKey: Buffer.from(
      pair.publicKey.export({ type: "spki", format: "der" }),
    )
      .subarray(SPKI_ED25519.length)
      .toString("hex"),
  };
}

/**
 * The signature of `text` (128 hex digits). The error names the variable and never shows what it
 * was given: a key that fails to parse is still a key.
 */
export function signText(privateKey: string, text: string): string {
  let key;
  try {
    key = createPrivateKey(privateKey.trim());
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
  } catch {
    throw new Error(
      "RELEASE_SIGNING_KEY is not an Ed25519 private key in PEM form",
    );
  }
  return sign(null, Buffer.from(text), key).toString("hex");
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

/**
 * Makes a key pair: the public key goes to `publicPath`, and the private key goes to `output`,
 * which must be a pipe or a file and not a terminal, where it would stay in the scrollback. The
 * file of the placeholder (or no file) takes the first key without a flag. A file that holds
 * anything else is replaced only on request (`replace`): the nodes trust what it holds, and the
 * private half of the key it holds exists in one place only (the secret cannot be read back), so
 * a second run of the first-key command must never overwrite it.
 */
export async function keygen(
  publicPath: string,
  output: { isTTY?: boolean; write(text: string): unknown },
  replace = false,
): Promise<void> {
  if (output.isTTY)
    throw new Error(
      "the private key is written to a pipe, never to a terminal: pipe the command into `gh secret set RELEASE_SIGNING_KEY --env release-signing`",
    );
  let held: string | undefined;
  try {
    held = (await readFile(publicPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (held !== undefined && held !== PLACEHOLDER_RELEASE_KEY && !replace)
    throw new Error(
      `${publicPath} holds a key that is not the placeholder: the nodes trust it, and nothing but the secret holds its private half. A new key is a key change, the rotation procedure of docs/operations/release-signing.md; pass --replace only for that`,
    );
  const pair = generateKeyPair();
  await writeFile(publicPath, `${pair.publicKey}\n`, { mode: 0o644 });
  output.write(pair.privateKey);
}
