// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_BINARY_FILES } from "../../packages/contracts/src/releases.ts";

export type BinaryDigests = Record<(typeof RELEASE_BINARY_FILES)[number], { sha256: string; size: number }>;

/**
 * The sha256 and size of the binaries an image bakes in. The build summary carries them, and the
 * release registered from the image must pin the same files: nodes installed from the image run
 * what is baked in, and only a later update downloads what the release pins.
 */
export async function digestBinaries(directory: string): Promise<BinaryDigests> {
  const digests = {} as BinaryDigests;
  for (const name of RELEASE_BINARY_FILES) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, name));
    } catch {
      throw new Error(`${name} is missing in ${directory}`);
    }
    if (bytes.byteLength === 0) throw new Error(`${name} is empty`);
    digests[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
  }
  return digests;
}
