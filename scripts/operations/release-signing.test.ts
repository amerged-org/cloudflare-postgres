// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RELEASE_KEY_FILE,
  generateKeyPair,
  keygen,
  readReleaseKey,
  signText,
  verifyText,
} from "./release-signing.ts";

const text = "pgcf-release-manifest/v1\nrelease=sha-0123456789ab\n";

test("a release key signs a manifest and verifies only that manifest, with only its own public key", () => {
  const key = generateKeyPair();
  assert.match(key.publicKey, /^[0-9a-f]{64}$/);
  const signature = signText(key.privateKey, text);
  assert.match(signature, /^[0-9a-f]{128}$/);
  assert.equal(verifyText(key.publicKey, text, signature), true);
  // Ed25519 signs deterministically: the same key and text give the same signature.
  assert.equal(signText(key.privateKey, text), signature);
  assert.equal(verifyText(key.publicKey, `${text}x`, signature), false);
  assert.equal(verifyText(key.publicKey, text.slice(1), signature), false);
  assert.equal(verifyText(generateKeyPair().publicKey, text, signature), false);
  // A signature that is not 64 bytes of hex is no signature: false, not an exception.
  for (const malformed of [
    "",
    "00",
    signature.slice(2),
    `${signature}00`,
    "z".repeat(128),
  ])
    assert.equal(verifyText(key.publicKey, text, malformed), false);
});

test("a key that is not an Ed25519 private key is refused without quoting it", () => {
  // Built at run time: a PEM literal is what a secret scanner looks for.
  const label = ["PRIVATE", "KEY"].join(" ");
  const secret = `-----BEGIN ${label}-----\nSECRET-BYTES\n-----END ${label}-----`;
  for (const bad of ["", "not a key", secret]) {
    assert.throws(
      () => signText(bad, text),
      (error: Error) => {
        assert.match(error.message, /RELEASE_SIGNING_KEY/);
        assert.doesNotMatch(error.message, /SECRET-BYTES|not a key/);
        return true;
      },
    );
  }
});

test("the key pair is made for the owner: the public key goes to a file, the private key only to a pipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-keygen-"));
  try {
    const publicPath = join(root, "release-signing.pub");
    // A terminal would keep the private key in its scrollback: nothing is written.
    const written: string[] = [];
    await assert.rejects(
      keygen(publicPath, {
        isTTY: true,
        write: (chunk) => written.push(chunk),
      }),
      /pipe/,
    );
    assert.equal(written.length, 0);
    await assert.rejects(stat(publicPath));
    await keygen(publicPath, {
      isTTY: false,
      write: (chunk) => written.push(chunk),
    });
    const privateKey = written.join("");
    assert.match(privateKey, /^-----BEGIN PRIVATE[ ]KEY-----\n/);
    const publicFile = await readFile(publicPath, "utf8");
    assert.match(publicFile, /^[0-9a-f]{64}\n$/);
    assert.equal(
      (await stat(publicPath)).mode & 0o777,
      0o644,
      "the public key is public",
    );
    const signature = signText(privateKey, text);
    assert.equal(verifyText(publicFile.trim(), text, signature), true);
    // The file of a key that is there is replaced only on request: the nodes trust it.
    await assert.rejects(
      keygen(publicPath, { isTTY: false, write: () => {} }),
      /--replace/,
    );
    assert.equal(await readFile(publicPath, "utf8"), publicFile);
    await keygen(publicPath, { isTTY: false, write: () => {} }, true);
    assert.notEqual(await readFile(publicPath, "utf8"), publicFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a release key file holds one public key as 64 lowercase hex digits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-key-"));
  try {
    const path = join(root, "release-signing.pub");
    const { publicKey } = generateKeyPair();
    await writeFile(path, `${publicKey}\n`);
    assert.equal(await readReleaseKey(path), publicKey);
    await writeFile(path, publicKey);
    assert.equal(await readReleaseKey(path), publicKey);
    for (const bad of [
      "",
      "\n",
      `${publicKey}00\n`,
      publicKey.slice(2),
      publicKey.toUpperCase(),
      `# a comment\n${publicKey}\n`,
    ]) {
      await writeFile(path, bad);
      await assert.rejects(readReleaseKey(path), /release key/, bad);
    }
    await assert.rejects(readReleaseKey(join(root, "missing")), /release key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the key checked in for the agent is a well-formed public key, which the agent's build reads as a constant", async () => {
  const key = await readReleaseKey(RELEASE_KEY_FILE);
  assert.match(key, /^[0-9a-f]{64}$/);
  // Whoever holds no private half cannot make a signature that it verifies: a made-up one fails.
  assert.equal(verifyText(key, text, "0".repeat(128)), false);
});
