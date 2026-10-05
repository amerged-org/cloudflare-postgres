// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLATFORM_ARTIFACTS } from "./platform-artifacts.ts";

export async function downloadBootstrapAssets(
  directory: string,
  request: typeof fetch = fetch,
) {
  await mkdir(directory, { recursive: true });
  for (const [filename, artifact] of [
    ["cilium-1.20.2.tgz", PLATFORM_ARTIFACTS.cilium],
    ["flux-install.yaml", PLATFORM_ARTIFACTS.flux],
  ] as const) {
    const signal = AbortSignal.timeout(480_000);
    const response = await request(artifact.url, {
      signal,
      redirect: "follow",
    });
    if (
      !response.ok ||
      new URL(response.url).protocol !== "https:" ||
      !response.body
    )
      throw new Error("bootstrap_asset_download_failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > artifact.max_bytes)
          throw new Error("bootstrap_asset_too_large");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
      throw new Error("bootstrap_asset_checksum_mismatch");
    await writeFile(join(directory, filename), bytes, { mode: 0o644 });
  }
  if (
    createHash("sha256")
      .update(await readFile(join(directory, "cilium-values.yaml")))
      .digest("hex") !== PLATFORM_ARTIFACTS.cilium_values.sha256
  )
    throw new Error("bootstrap_values_checksum_mismatch");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error("bootstrap_assets_directory_required");
  await downloadBootstrapAssets(resolve(process.argv[2]!));
}
