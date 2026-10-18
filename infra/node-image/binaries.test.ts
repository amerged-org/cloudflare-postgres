// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RELEASE_BINARY_FILES } from "../../packages/contracts/src/releases.ts";
import { digestBinaries } from "./binaries.ts";

test("the image is built from exactly the four binaries a release pins, each with its digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pgcf-binaries-"));
  try {
    for (const name of RELEASE_BINARY_FILES) await writeFile(join(dir, name), `bytes of ${name}`);
    // A file beside them is not baked into the image, so it has no digest.
    await writeFile(join(dir, "pgcf-agent.d"), "dependency file");
    const digests = await digestBinaries(dir);
    assert.deepEqual(Object.keys(digests).sort(), [...RELEASE_BINARY_FILES].sort());
    assert.deepEqual(digests["pgcf-wal-fetch"], {
      sha256: createHash("sha256").update("bytes of pgcf-wal-fetch").digest("hex"),
      size: Buffer.byteLength("bytes of pgcf-wal-fetch"),
    });

    await writeFile(join(dir, "pgcf-archive"), "");
    await assert.rejects(digestBinaries(dir), /pgcf-archive is empty/);
    await rm(join(dir, "pgcf-archive"));
    await assert.rejects(digestBinaries(dir), /pgcf-archive is missing/);
    await assert.rejects(digestBinaries(join(dir, "none")), /pgcf-agent is missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
