// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { validateImageIdentity } from "./image-qualification.ts";

interface QualifiedImage {
  imageId: string;
  configDigest: string;
  revision: string;
  source: string;
  diffIDs: string[];
  registryLayerDigests?: string[];
}
function check(value: unknown): asserts value {
  if (!value) throw new Error("Registry manifest/config binding failed");
}
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const digest = (bytes: Buffer) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

export function validateRegistryBinding(
  manifestBytes: Buffer,
  manifestDigest: string,
  configBytes: Buffer,
  image: QualifiedImage,
): void {
  check(
    digestPattern.test(manifestDigest) &&
      digest(manifestBytes) === manifestDigest,
  );
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion: number;
    config: { digest: string };
    layers: { digest: string }[];
  };
  check(
    manifest.schemaVersion === 2 &&
      manifest.config?.digest === image.configDigest &&
      digest(configBytes) === image.configDigest,
  );
  check(
    image.imageId === image.configDigest || image.imageId === manifestDigest,
  );
  const config = validateImageIdentity(
    configBytes,
    image.configDigest,
    image.revision,
    image.source,
  );
  check(
    JSON.stringify(config.rootfs.diff_ids) === JSON.stringify(image.diffIDs),
  );
  check(
    Array.isArray(manifest.layers) &&
      manifest.layers.length === image.diffIDs.length &&
      manifest.layers.every((layer) => digestPattern.test(layer.digest)),
  );
  if (image.registryLayerDigests)
    check(
      JSON.stringify(manifest.layers.map((layer) => layer.digest)) ===
        JSON.stringify(image.registryLayerDigests),
    );
}

async function responseBytes(response: Response): Promise<Buffer> {
  check(response.ok && response.body);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      check(size <= 1_000_000);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export async function verifyRegistry(
  image: string,
  qualification: QualifiedImage,
  reportPath: string,
): Promise<void> {
  const reference = image.match(
    /^ghcr\.io\/([a-z0-9._-]+\/[a-z0-9._-]+):([A-Za-z0-9_.-]+)$/,
  );
  check(reference);
  const repository = reference[1]!;
  const actor = process.env.GITHUB_ACTOR;
  const credential = process.env.GH_TOKEN;
  check(actor && credential);
  const tokenResponse = await fetch(
    "https://ghcr.io/token?" +
      new URLSearchParams({
        service: "ghcr.io",
        scope: `repository:${repository}:pull`,
      }),
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${actor}:${credential}`).toString("base64"),
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  const tokenData = JSON.parse(
    (await responseBytes(tokenResponse)).toString(),
  ) as { token?: string; access_token?: string };
  const token = tokenData.token ?? tokenData.access_token;
  check(token && token.length < 100_000);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
  };
  async function get(path: string, expectedDigest?: string) {
    const response = await fetch(`https://ghcr.io/v2/${repository}/${path}`, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    const bytes = await responseBytes(response);
    const contentDigest =
      response.headers.get("docker-content-digest") ?? expectedDigest;
    check(contentDigest && digest(bytes) === contentDigest);
    if (expectedDigest) check(contentDigest === expectedDigest);
    return { bytes, contentDigest };
  }
  const root = await get(`manifests/${reference[2]}`);
  let selected = root;
  const index = JSON.parse(root.bytes.toString()) as {
    manifests?: {
      digest: string;
      platform: { os: string; architecture: string };
    }[];
  };
  if (index.manifests) {
    check(
      index.manifests.length === 1 &&
        index.manifests[0]?.platform?.os === "linux" &&
        index.manifests[0].platform.architecture === "amd64" &&
        digestPattern.test(index.manifests[0].digest),
    );
    selected = await get(`manifests/${index.manifests[0].digest}`);
    check(selected.contentDigest === index.manifests[0].digest);
  }
  const manifest = JSON.parse(selected.bytes.toString()) as {
    config: { digest: string };
  };
  check(digestPattern.test(manifest.config?.digest));
  const config = await get(
    `blobs/${manifest.config.digest}`,
    manifest.config.digest,
  );
  check(config.contentDigest === manifest.config.digest);
  validateRegistryBinding(
    selected.bytes,
    selected.contentDigest,
    config.bytes,
    qualification,
  );
  await writeFile(
    reportPath,
    JSON.stringify({
      digest: root.contentDigest,
      manifestDigest: selected.contentDigest,
      configDigest: config.contentDigest,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
