// SPDX-License-Identifier: Apache-2.0
// The release key (ULTRA plan 9.3, docs/operations/release-signing.md): an Ed25519 key pair whose
// private half only CI holds (the GitHub Actions secret RELEASE_SIGNING_KEY) and whose public half
// the node agent has compiled in, read from apps/node-agent/release-signing.pub. CI signs the
// manifest of each release (`signedReleaseManifest`); a node checks the signature before it
// installs anything of the release; registration checks it too, so that a release no node would
// accept is never registered. This module is the shared part: nothing here prints a key.
//
// The owner makes the key pair once. The private key goes to the pipe and nowhere else, so it is
// never on a disk or in a terminal:
//
//   node scripts/operations/sign-release.ts keygen --public apps/node-agent/release-signing.pub \
//     | gh secret set RELEASE_SIGNING_KEY
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
 * which must be a pipe or a file and not a terminal, where it would stay in the scrollback. A
 * public key file that holds a key is replaced only on request (`replace`): the nodes trust what
 * it holds.
 */
export async function keygen(
  publicPath: string,
  output: { isTTY?: boolean; write(text: string): unknown },
  replace = false,
): Promise<void> {
  if (output.isTTY)
    throw new Error(
      "the private key is written to a pipe, never to a terminal: pipe the command into `gh secret set RELEASE_SIGNING_KEY`",
    );
  const pair = generateKeyPair();
  try {
    await writeFile(publicPath, `${pair.publicKey}\n`, {
      flag: replace ? "w" : "wx",
      mode: 0o644,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `${publicPath} exists: the nodes trust the key it holds, so pass --replace to make another (docs/operations/release-signing.md says when)`,
      );
    throw error;
  }
  output.write(pair.privateKey);
}
