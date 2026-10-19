// SPDX-License-Identifier: Apache-2.0
// The release key's two commands (ULTRA plan 9.3, docs/operations/release-signing.md). The key
// itself is in release-signing.ts.
//
//   node scripts/operations/sign-release.ts keygen --public FILE [--replace]
//     Makes the key pair for the owner. The public key goes to FILE
//     (apps/node-agent/release-signing.pub), the private key to the pipe, so that it is never on a
//     disk or in a terminal. It runs once, after the GitHub environment `release-signing` exists:
//       node scripts/operations/sign-release.ts keygen --public apps/node-agent/release-signing.pub \
//         | gh secret set RELEASE_SIGNING_KEY --env release-signing
//     FILE holds the placeholder key until then, which the first key replaces without a flag. A
//     second run refuses: it would overwrite the public half of the only copy of the private key
//     (the secret cannot be read back). --replace is the rotation procedure and nothing else; if
//     `gh secret set` failed, FILE already holds a key whose private half is gone, so run it again
//     with --replace before committing.
//
//   node scripts/operations/sign-release.ts sign --image-dir DIR --binaries DIR [--lock FILE]
//     The step of CI's job `sign-release`, the only job that holds the environment secret: signs
//     the manifest of the release (the digests the registration states, `signedReleaseManifest`)
//     with the private key of the variable RELEASE_SIGNING_KEY and writes DIR/release.sig, which
//     the registration reads and the API stores. The options are those of register-node-image.ts,
//     and the files are checked the same way. It refuses while apps/node-agent/release-signing.pub
//     still holds the placeholder key. RELEASE_SIGNING_KEY is read from the environment, in
//     memory; its value is never printed.
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  RELEASE_SIGNATURE_FILE,
  signedReleaseManifest,
} from "../../packages/contracts/src/releases.ts";
import { releaseManifest, type Manifest } from "./register-node-image.ts";
import {
  PLACEHOLDER_RELEASE_KEY,
  RELEASE_KEY_FILE,
  keygen,
  readReleaseKey,
  signText,
} from "./release-signing.ts";

/**
 * Signs the manifest of a build and writes the signature, 128 hex digits and a line feed, as
 * `release.sig` into `directory`. Nothing is written for a build that cannot be signed: without
 * the secret, or while `committedKey`, the public key of this checkout that the build's agent
 * trusts, is still the placeholder. A real key in the secret would otherwise sign a build whose
 * agents trust a key that nobody holds.
 */
export async function signBuild(
  manifest: Manifest,
  directory: string,
  environment: Record<string, string | undefined>,
  committedKey: string,
): Promise<string> {
  const key = environment.RELEASE_SIGNING_KEY;
  if (!key?.trim())
    throw new Error(
      "RELEASE_SIGNING_KEY is not set: make the key pair and the secret as docs/operations/release-signing.md says; the nodes refuse a release that is not signed",
    );
  if (committedKey === PLACEHOLDER_RELEASE_KEY)
    throw new Error(
      "apps/node-agent/release-signing.pub still holds the placeholder key, so the agent of this build trusts a key that nobody holds: commit the public key that the keygen command wrote before this commit reaches main (docs/operations/release-signing.md)",
    );
  const signature = signText(
    key,
    signedReleaseManifest({ id: manifest.version, ...manifest.registration }),
  );
  const path = join(directory, RELEASE_SIGNATURE_FILE);
  await writeFile(path, `${signature}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
  return signature;
}

async function main(
  argv: string[],
  environment: Record<string, string | undefined>,
) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      public: { type: "string" },
      replace: { type: "boolean", default: false },
      "image-dir": { type: "string" },
      binaries: { type: "string" },
      lock: { type: "string" },
    },
  });
  if (command === "keygen" && values.public) {
    await keygen(resolve(values.public), process.stdout, values.replace);
    return;
  }
  if (command === "sign" && values["image-dir"] && values.binaries) {
    const imageDir = resolve(values["image-dir"]);
    const manifest = await releaseManifest({
      imageDir,
      binariesDir: resolve(values.binaries),
      ...(values.lock ? { lockPath: resolve(values.lock) } : {}),
    });
    const signature = await signBuild(
      manifest,
      imageDir,
      environment,
      await readReleaseKey(RELEASE_KEY_FILE),
    );
    console.log(
      `signed ${manifest.version}: ${RELEASE_SIGNATURE_FILE} ${signature}`,
    );
    return;
  }
  throw new Error(
    "usage: sign-release.ts keygen --public FILE [--replace] | sign --image-dir DIR --binaries DIR [--lock FILE]",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
