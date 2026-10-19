// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signedReleaseManifest } from "../../packages/contracts/src/releases.ts";
import type { Manifest } from "./register-node-image.ts";
import {
  PLACEHOLDER_RELEASE_KEY,
  generateKeyPair,
  verifyText,
} from "./release-signing.ts";
import { signBuild } from "./sign-release.ts";

const digest = (letter: string, size_bytes: number) => ({
  sha256: letter.repeat(64),
  size_bytes,
});
const manifest: Manifest = {
  version: "sha-0123456789ab",
  registration: {
    image: {
      ...digest("a", 512_000_000),
      raw_sha256: "b".repeat(64),
      raw_bytes: 2_147_483_648,
    },
    binaries: {
      "pgcf-agent": digest("1", 11_000_000),
      "pgcf-native-gateway": digest("2", 12_000_000),
      "pgcf-archive": digest("3", 5_000_000),
      "pgcf-wal-fetch": digest("4", 5_100_000),
    },
    os: {
      debian_snapshot: "20261016T000000Z",
      package_lock: digest("5", 90_000),
      packages_sha256: "6".repeat(64),
      kernel_release: "6.12.113+deb13-amd64",
    },
  },
  uploads: [],
};

test("CI signs the manifest of the build with the key of its secret and keeps the signature beside the files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-sign-"));
  try {
    const key = generateKeyPair();
    const signature = await signBuild(
      manifest,
      root,
      { RELEASE_SIGNING_KEY: key.privateKey },
      key.publicKey,
    );
    const file = join(root, "release.sig");
    assert.equal(await readFile(file, "utf8"), `${signature}\n`);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    assert.equal(
      verifyText(
        key.publicKey,
        signedReleaseManifest({
          id: manifest.version,
          ...manifest.registration,
        }),
        signature,
      ),
      true,
    );
    // A secret that GitHub hands over with a trailing line feed is the same key.
    assert.equal(
      await signBuild(
        manifest,
        root,
        { RELEASE_SIGNING_KEY: `${key.privateKey}\n` },
        key.publicKey,
      ),
      signature,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a build is not signed without the secret, and the failure says what to do and shows no key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-sign-"));
  try {
    const committed = generateKeyPair().publicKey;
    for (const environment of [{}, { RELEASE_SIGNING_KEY: "" }]) {
      await assert.rejects(
        signBuild(manifest, root, environment, committed),
        (error: Error) => {
          assert.match(error.message, /RELEASE_SIGNING_KEY is not set/);
          assert.match(error.message, /docs\/operations\/release-signing\.md/);
          return true;
        },
      );
    }
    await assert.rejects(
      signBuild(
        manifest,
        root,
        { RELEASE_SIGNING_KEY: "not-a-key-SECRET" },
        committed,
      ),
      (error: Error) => {
        assert.match(error.message, /RELEASE_SIGNING_KEY/);
        assert.doesNotMatch(error.message, /SECRET/);
        return true;
      },
    );
    // Nothing was written for a build that could not be signed.
    await assert.rejects(stat(join(root, "release.sig")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a build is not signed while the checked-in public key is the placeholder, even when the secret is set", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-sign-"));
  try {
    // The real private key may be in the secret before the commit that carries its public key has
    // reached main: a build of the placeholder would be signed by a key that its agent does not trust.
    const key = generateKeyPair();
    await assert.rejects(
      signBuild(
        manifest,
        root,
        { RELEASE_SIGNING_KEY: key.privateKey },
        PLACEHOLDER_RELEASE_KEY,
      ),
      (error: Error) => {
        assert.match(error.message, /placeholder/);
        assert.match(error.message, /docs\/operations\/release-signing\.md/);
        assert.doesNotMatch(error.message, /PRIVATE|BEGIN/);
        return true;
      },
    );
    await assert.rejects(stat(join(root, "release.sig")));
    // The same secret signs once the checked-in key is another one.
    await signBuild(
      manifest,
      root,
      { RELEASE_SIGNING_KEY: key.privateKey },
      key.publicKey,
    );
    assert.match(
      await readFile(join(root, "release.sig"), "utf8"),
      /^[0-9a-f]{128}\n$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
