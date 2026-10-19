// SPDX-License-Identifier: Apache-2.0
import { RELEASE_PUBLIC_KEY } from "@pgcf/contracts/release-key";
import {
  releaseSignatureVerifies,
  type FleetReleaseSpec,
} from "@pgcf/contracts/releases";

/**
 * Whether the release key signed this release (docs/operations/release-signing.md): the manifest
 * is rebuilt from the spec's own facts under the release's id (the image's four, the binaries, the
 * lock, the snapshot and the host files) and checked against the signature the spec holds. The key
 * is a constant of this Worker's code, generated from the file the agent's build reads
 * (`release-key.generated.ts`), so no API call, setting or secret changes it: whoever holds an
 * administrator key and write access to the archive bucket can register a release, and cannot
 * make one that is installed unless the signer signed it.
 */
export const releaseIsSigned = (
  id: string,
  spec: FleetReleaseSpec,
): Promise<boolean> =>
  releaseSignatureVerifies(RELEASE_PUBLIC_KEY, { id, ...spec }, spec.signature);
