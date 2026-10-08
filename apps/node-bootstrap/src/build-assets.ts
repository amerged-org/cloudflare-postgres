// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BOOTSTRAP_CLIENTS, PLATFORM_ARTIFACTS } from "./platform-artifacts.ts";

async function checkedDownload(
  artifact: { url: string; sha256: string; max_bytes: number },
  request: typeof fetch,
  signal: AbortSignal,
) {
  const response = await request(artifact.url, { signal, redirect: "follow" });
  if (
    !response.ok ||
    new URL(response.url).protocol !== "https:" ||
    !response.body
  )
    throw new Error("bootstrap_asset_download_failed");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
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
  return bytes;
}

export function bootstrapClientArchive(
  name: keyof typeof BOOTSTRAP_CLIENTS,
  architecture: string,
) {
  if (!["amd64", "arm64"].includes(architecture))
    throw new Error("bootstrap_client_architecture_invalid");
  const matches = BOOTSTRAP_CLIENTS[name].archives.filter(
    (archive) =>
      archive.os === "linux" && archive.architecture === architecture,
  );
  if (matches.length !== 1) throw new Error("bootstrap_client_archive_invalid");
  return matches[0]!;
}

export async function downloadBootstrapClients(
  directory: string,
  architecture: string,
  request: typeof fetch = fetch,
) {
  await mkdir(directory, { recursive: true });
  for (const name of ["talos", "kubectl", "helm"] as const) {
    const archive = bootstrapClientArchive(name, architecture);
    const bytes = await checkedDownload(
      { ...archive, max_bytes: 256 * 1024 * 1024 },
      request,
      AbortSignal.timeout(480_000),
    );
    const target = join(directory, name === "talos" ? "talosctl" : name);
    if (name === "helm") {
      const temporary = join(directory, "helm.tgz");
      await writeFile(temporary, bytes, { mode: 0o644 });
      try {
        await promisify(execFile)(
          "tar",
          [
            "--extract",
            "--gzip",
            `--file=${temporary}`,
            `--directory=${directory}`,
            "--strip-components=1",
            `linux-${architecture}/helm`,
          ],
          { timeout: 60_000 },
        );
      } finally {
        await rm(temporary, { force: true });
      }
    } else await writeFile(target, bytes, { mode: 0o755 });
    await chmod(target, 0o755);
  }
}

export async function downloadBootstrapAssets(
  directory: string,
  request: typeof fetch = fetch,
) {
  await mkdir(directory, { recursive: true });
  const signal = AbortSignal.timeout(480_000);
  for (const [filename, artifact] of [
    [PLATFORM_ARTIFACTS.cilium.filename, PLATFORM_ARTIFACTS.cilium],
    ["flux-install.yaml", PLATFORM_ARTIFACTS.flux],
  ] as const) {
    const bytes = await checkedDownload(artifact, request, signal);
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
  if (process.argv[2] === "--clients" && process.argv.length === 5)
    await downloadBootstrapClients(resolve(process.argv[3]!), process.argv[4]!);
  else if (process.argv.length === 3)
    await downloadBootstrapAssets(resolve(process.argv[2]!));
  else throw new Error("bootstrap_assets_directory_required");
}
