// SPDX-License-Identifier: Apache-2.0
// The release key in the API's tests. The key the Workers verify releases with is generated into
// `@pgcf/contracts/release-key` from the committed public key, whose private half only the signer
// holds; vitest.config.ts replaces that module with this one, so a test can sign a release the way
// the signer does. The seed is fixed and public, and belongs to no node, signer or release.
import {
  base64urlToBytes,
  bytesToHex,
  type ReleaseManifestFields,
} from "@pgcf/contracts";
import { signedReleaseManifest } from "@pgcf/contracts/releases";

const SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
const privateKey = await crypto.subtle.importKey(
  "pkcs8",
  Uint8Array.from([...PKCS8_ED25519, ...SEED]),
  "Ed25519",
  true,
  ["sign"],
);
const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;

/** What `@pgcf/contracts/release-key` exports in production: the public key, 64 hex digits. */
export const RELEASE_PUBLIC_KEY = bytesToHex(base64urlToBytes(jwk.x!)!);

/** The signature of `text` as the signer makes it: 128 hex digits. */
export async function signText(text: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        new TextEncoder().encode(text),
      ),
    ),
  );
}

/** The signature of the manifest of `release`, which carries its id. */
export const signRelease = (release: ReleaseManifestFields): Promise<string> =>
  signText(signedReleaseManifest(release));
