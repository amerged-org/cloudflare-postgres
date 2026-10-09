// SPDX-License-Identifier: Apache-2.0
// Publication transport only. Qualification and adoption remain separate gates.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { extract } from "tar-stream";
import versions from "../../platform/versions.lock.json" with { type: "json" };

export const PUBLICATION_LIMITS = {
  asset_bytes: 2 * 1024 ** 3 - 1,
  metadata_bytes: 2 * 1024 ** 2,
  request_ms: 120_000,
  transfer_ms: 10 * 60_000,
  total_ms: 25 * 60_000,
  redirects: 5,
  pages: 10,
  page_size: 100,
} as const;
const sha = /^[a-f0-9]{64}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const apiVersion = "2026-03-10";
const bodyPrefix = "PGCF_TALOS_PUBLICATION_V1\n";
// REST/archive metadata is validated at its use site; it is never forwarded as authority.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + canonical(object[key]))
    .join(",")}}`;
}
async function boundedJson(
  path: string,
  maximum: number = PUBLICATION_LIMITS.metadata_bytes,
): Promise<Json> {
  const info = await lstat(path);
  check(info.isFile() && info.size <= maximum, "publication_metadata_invalid");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function fileIdentity(path: string) {
  const before = await lstat(path);
  check(
    before.isFile() &&
      before.size > 0 &&
      before.size <= PUBLICATION_LIMITS.asset_bytes,
    "publication_asset_size_invalid",
  );
  const value = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    value.update(chunk);
    size += chunk.length;
  }
  const after = await lstat(path);
  check(
    size === before.size &&
      before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs &&
      after.size === size,
    "publication_input_changed",
  );
  return { sha256: value.digest("hex"), size };
}
async function atomic(path: string, value: unknown) {
  const pending = path + ".pending";
  const file = await open(pending, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(pending, path);
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export function loadedInstallerId(log: string) {
  check(Buffer.byteLength(log) <= 64 * 1024, "installer_load_reply_invalid");
  const replies = log
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Loaded image"));
  check(replies.length === 1, "installer_load_reply_invalid");
  const match = replies[0]!.match(/^Loaded image ID: (sha256:[a-f0-9]{64})$/);
  check(match, "installer_load_reply_invalid");
  return match[1]!;
}

/** An existing content-addressed tag may be reused, never overwritten. Full blob readback follows. */
export async function installerRegistryPresence(
  image: string,
  expectedManifest: string,
  auth: { actor: string; token: string; request?: typeof fetch },
) {
  const reference = image.match(
    /^ghcr\.io\/([a-z0-9._-]+\/[a-z0-9._-]+):([A-Za-z0-9_.-]+)$/,
  );
  check(
    reference && digest.test(expectedManifest) && auth.actor && auth.token,
    "installer_registry_scope_invalid",
  );
  const request = auth.request ?? fetch,
    signal = AbortSignal.timeout(PUBLICATION_LIMITS.request_ms);
  const tokenResponse = await request(
    "https://ghcr.io/token?" +
      new URLSearchParams({
        service: "ghcr.io",
        scope: `repository:${reference[1]}:pull`,
      }),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${auth.actor}:${auth.token}`).toString("base64"),
      },
      redirect: "error",
      signal,
    },
  );
  async function metadata(response: Response) {
    check(response.ok && response.body, "installer_registry_read_unresolved");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      check(
        size <= PUBLICATION_LIMITS.metadata_bytes,
        "installer_registry_metadata_bound",
      );
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const grant = JSON.parse((await metadata(tokenResponse)).toString()),
    token = grant.token ?? grant.access_token;
  check(
    typeof token === "string" && token.length > 0 && token.length < 100000,
    "installer_registry_auth_invalid",
  );
  const response = await request(
    `https://ghcr.io/v2/${reference[1]}/manifests/${reference[2]}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
      redirect: "error",
      signal,
    },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return "absent";
  }
  const bytes = await metadata(response);
  check(
    response.headers.get("docker-content-digest") === `sha256:${hash(bytes)}`,
    "installer_registry_digest_invalid",
  );
  const manifest = JSON.parse(bytes.toString());
  if (Array.isArray(manifest.manifests))
    check(
      manifest.manifests.length === 1 &&
        manifest.manifests[0]?.digest === expectedManifest &&
        manifest.manifests[0]?.platform?.os === "linux" &&
        manifest.manifests[0]?.platform?.architecture === "amd64",
      "installer_registry_tag_conflict",
    );
  else
    check(
      `sha256:${hash(bytes)}` === expectedManifest,
      "installer_registry_tag_conflict",
    );
  return "present";
}

/** Docker's transport wrapper may change, but qualified config and gzip bytes may not. */
export async function verifyInstallerTransport(
  archive: string,
  report: Json,
  source: string,
) {
  check(
    revision.test(source) &&
      report.passed === true &&
      report.source_commit === source,
    "installer_gate_unbound",
  );
  const expected = report.installer;
  check(
    digest.test(expected?.configDigest) &&
      Array.isArray(expected.diffIDs) &&
      Array.isArray(expected.layerDigests) &&
      expected.diffIDs.length > 0 &&
      expected.diffIDs.length <= 32 &&
      expected.diffIDs.length === expected.layerDigests.length,
    "installer_gate_unbound",
  );
  const blobs = new Map<
    string,
    { sha256: string; size: number; bytes?: Buffer }
  >();
  const info = await lstat(archive);
  check(
    info.isFile() && info.size > 0 && info.size <= 8 * 1024 ** 3,
    "installer_transport_size_invalid",
  );
  const unpack = extract();
  let entries = 0,
    metadataBytes = 0;
  unpack.on("entry", (header, stream, next) => {
    (async () => {
      const name = header.name.replace(/\/$/, "");
      check(
        ++entries <= 128 &&
          !name.startsWith("/") &&
          !name.split("/").includes("..") &&
          !name.includes("\\"),
        "installer_transport_path_invalid",
      );
      if (header.type === "directory") {
        stream.resume();
        next();
        return;
      }
      check(
        (header.type === "file" &&
          !blobs.has(name) &&
          ["manifest.json", "index.json", "oci-layout"].includes(name)) ||
          (header.type === "file" &&
            /^blobs\/sha256\/[a-f0-9]{64}$/.test(name) &&
            !blobs.has(name)),
        "installer_transport_entry_invalid",
      );
      check(header.size <= 8 * 1024 ** 3, "installer_transport_size_invalid");
      const value = createHash("sha256"),
        chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const data = Buffer.from(chunk as Uint8Array);
        value.update(data);
        size += data.length;
        if (header.size <= PUBLICATION_LIMITS.metadata_bytes) chunks.push(data);
      }
      check(size === header.size, "installer_transport_truncated");
      if (chunks.length) {
        metadataBytes += size;
        check(
          metadataBytes <= 16 * 1024 ** 2,
          "installer_transport_metadata_bound",
        );
      }
      blobs.set(name, {
        sha256: "sha256:" + value.digest("hex"),
        size,
        ...(chunks.length ? { bytes: Buffer.concat(chunks) } : {}),
      });
      next();
    })().catch((error) => unpack.destroy(error));
  });
  await pipeline(createReadStream(archive), unpack);
  const json = (name: string) => {
    const value = blobs.get(name);
    check(value?.bytes, "installer_transport_metadata_missing");
    return JSON.parse(value.bytes.toString()) as Json;
  };
  const legacy = json("manifest.json"),
    index = json("index.json");
  check(
    Array.isArray(legacy) &&
      legacy.length === 1 &&
      Array.isArray(index.manifests) &&
      index.manifests.length === 1,
    "installer_transport_manifest_invalid",
  );
  const descriptor = index.manifests[0];
  check(
    digest.test(descriptor.digest) &&
      [
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(descriptor.mediaType),
    "installer_transport_manifest_invalid",
  );
  const manifestPath = "blobs/sha256/" + descriptor.digest.slice(7),
    manifest = json(manifestPath);
  check(
    blobs.get(manifestPath)?.sha256 === descriptor.digest &&
      manifest.schemaVersion === 2 &&
      manifest.config?.digest === expected.configDigest &&
      Array.isArray(manifest.layers) &&
      manifest.layers.length === expected.layerDigests.length,
    "installer_transport_manifest_invalid",
  );
  const configPath = "blobs/sha256/" + expected.configDigest.slice(7),
    config = json(configPath);
  check(
    blobs.get(configPath)?.sha256 === expected.configDigest &&
      config.os === "linux" &&
      config.architecture === "amd64" &&
      canonical(config.rootfs?.diff_ids) === canonical(expected.diffIDs),
    "installer_transport_config_changed",
  );
  check(
    config.config?.Labels?.["org.opencontainers.image.source"] ===
      "https://github.com/siderolabs/talos" &&
      config.config?.Labels?.["alpha.talos.dev/version"] ===
        `v${versions.target.talosVersion}` &&
      canonical(config.config?.Entrypoint) === canonical(["/bin/installer"]),
    "installer_transport_upstream_identity_changed",
  );
  const names = new Set([
    "manifest.json",
    "index.json",
    "oci-layout",
    manifestPath,
    configPath,
  ]);
  let compressedBytes = 0;
  for (const [position, layer] of manifest.layers.entries()) {
    const path = "blobs/sha256/" + String(layer.digest).slice(7),
      blob = blobs.get(path);
    check(blob, "installer_transport_layer_missing");
    check(
      layer.digest === expected.layerDigests[position] &&
        blob?.sha256 === layer.digest &&
        blob.size === layer.size &&
        [
          "application/vnd.oci.image.layer.v1.tar+gzip",
          "application/vnd.docker.image.rootfs.diff.tar.gzip",
        ].includes(layer.mediaType) &&
        !layer.urls,
      "installer_transport_layer_changed",
    );
    compressedBytes += blob.size;
    names.add(path);
  }
  check(
    [...blobs.keys()].every((name) => names.has(name)) &&
      legacy[0].Config === configPath &&
      canonical(legacy[0].Layers) ===
        canonical(
          manifest.layers.map(
            (layer: Json) => "blobs/sha256/" + layer.digest.slice(7),
          ),
        ),
    "installer_transport_unexpected_payload",
  );
  return {
    source_commit: source,
    manifestDigest: descriptor.digest,
    configDigest: expected.configDigest,
    diffIDs: expected.diffIDs,
    layerDigests: expected.layerDigests,
    compressedBytes,
    upstreamLabelsPreserved: true,
  };
}

interface Asset {
  name: string;
  sha256: string;
  size: number;
  content_type: string;
  path: string;
}
interface PublicAsset {
  name: string;
  sha256: string;
  size: number;
}
interface Manifest {
  version: 1;
  source_commit: string;
  repository: string;
  recipe_sha256: string;
  installer_ref: string;
  raw: PublicAsset;
  report: PublicAsset;
  recipe: PublicAsset;
}
interface State {
  version: 1;
  manifest: Manifest;
  report_base64: string;
  authorized_initial_push: boolean;
  creation_attempted: boolean;
  publication_attempted: boolean;
  uploads: Record<string, "attempted" | "confirmed">;
}
interface Options {
  token: string;
  fresh: boolean;
  request?: typeof fetch;
}
function publicAsset(asset: Asset): PublicAsset {
  return { name: asset.name, sha256: asset.sha256, size: asset.size };
}
function compatible(a: Manifest, b: Manifest) {
  return (
    a.version === 1 &&
    a.source_commit === b.source_commit &&
    a.repository === b.repository &&
    a.recipe_sha256 === b.recipe_sha256 &&
    a.installer_ref === b.installer_ref &&
    canonical(a.raw) === canonical(b.raw) &&
    canonical(a.recipe) === canonical(b.recipe)
  );
}
function boundReport(
  report: Json,
  source: string,
  recipeSha: string,
  raw: PublicAsset,
) {
  check(
    report.passed === true &&
      report.source_commit === source &&
      report.recipe_sha256 === recipeSha &&
      report.raw?.compressed?.sha256 === raw.sha256 &&
      report.raw.compressed.size === raw.size,
    "publication_report_unbound",
  );
}
async function prepare(
  directory: string,
  source: string,
  repository: string,
  installerRef: string,
) {
  check(
    revision.test(source) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(
        installerRef,
      ),
    "publication_scope_invalid",
  );
  const reportPath = join(directory, "whole-os-qualification.json"),
    report = await boundedJson(reportPath),
    plan = await boundedJson(join(directory, "recipe-context", "plan.json"));
  const recipeBytes = Buffer.from(canonical(plan.recipe)),
    recipeSha = hash(recipeBytes);
  check(
    plan.recipe?.source_commit === source &&
      plan.recipe.architecture === "amd64" &&
      plan.recipeSha256 === recipeSha,
    "publication_recipe_unbound",
  );
  const staging = join(directory, "publication");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const recipePath = join(staging, "recipe.json");
  await writeFile(recipePath, recipeBytes, { mode: 0o600 });
  const rawPath = join(directory, "out", "nocloud-amd64.raw.xz"),
    rawIdentity = await fileIdentity(rawPath),
    reportIdentity = await fileIdentity(reportPath);
  const raw: Asset = {
    ...rawIdentity,
    name: `nocloud-amd64-${rawIdentity.sha256}.raw.xz`,
    content_type: "application/x-xz",
    path: rawPath,
  };
  boundReport(report, source, recipeSha, raw);
  const originalInstaller = await fileIdentity(
    join(directory, "out", "installer-amd64.tar"),
  );
  check(
    originalInstaller.sha256 === report.installer?.archive_sha256 &&
      originalInstaller.size === report.installer.archive_bytes,
    "publication_installer_archive_changed",
  );
  const registry = await boundedJson(
      join(directory, "installer-gate", "registry.json"),
    ),
    transport = await boundedJson(
      join(directory, "installer-gate", "transport.json"),
    );
  check(
    transport.source_commit === source &&
      transport.upstreamLabelsPreserved === true &&
      transport.configDigest === report.installer.configDigest &&
      canonical(transport.diffIDs) === canonical(report.installer.diffIDs) &&
      registry.configDigest === report.installer.configDigest &&
      registry.manifestDigest === transport.manifestDigest &&
      registry.digest === installerRef.split("@")[1] &&
      registry.layersVerified === report.installer.layerDigests.length &&
      Number.isSafeInteger(registry.compressedBytes) &&
      registry.compressedBytes > 0 &&
      registry.compressedBytes === transport.compressedBytes &&
      canonical(transport.layerDigests) ===
        canonical(report.installer.layerDigests),
    "publication_installer_registry_unbound",
  );
  const assets: Asset[] = [
    raw,
    {
      ...reportIdentity,
      name: `whole-os-qualification-${reportIdentity.sha256}.json`,
      content_type: "application/json",
      path: reportPath,
    },
    {
      name: `talos-recipe-${recipeSha}.json`,
      sha256: recipeSha,
      size: recipeBytes.length,
      content_type: "application/json",
      path: recipePath,
    },
  ];
  const manifest: Manifest = {
    version: 1,
    source_commit: source,
    repository,
    recipe_sha256: recipeSha,
    installer_ref: installerRef,
    raw: publicAsset(assets[0]!),
    report: publicAsset(assets[1]!),
    recipe: publicAsset(assets[2]!),
  };
  return { assets, manifest, report, staging };
}

export async function publishTalosArtifacts(
  directory: string,
  source: string,
  repository: string,
  installerRef: string,
  options: Options,
) {
  const input = await prepare(directory, source, repository, installerRef),
    request = options.request ?? fetch;
  check(
    options.token.length > 0 && options.token.length < 16384,
    "publication_auth_missing",
  );
  const tag = "talos-sha-" + source,
    base = `https://api.github.com/repos/${repository}`,
    deadline = AbortSignal.timeout(PUBLICATION_LIMITS.total_ms);
  const signal = (transfer = false) =>
    AbortSignal.any([
      deadline,
      AbortSignal.timeout(
        transfer
          ? PUBLICATION_LIMITS.transfer_ms
          : PUBLICATION_LIMITS.request_ms,
      ),
    ]);
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": apiVersion,
    "User-Agent": "pgcf-talos-artifact-publication",
  };
  async function bytes(
    response: Response,
    limit = PUBLICATION_LIMITS.metadata_bytes,
  ) {
    check(response.body, "publication_response_missing");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      check(size <= limit, "publication_metadata_bound");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async function api(path: string, init: RequestInit = {}) {
    const response = await request(base + path, {
      ...init,
      headers: { ...headers, ...init.headers },
      redirect: "error",
      signal: signal(),
    });
    if (response.status === 404 && (!init.method || init.method === "GET"))
      return undefined;
    check(response.ok, "publication_api_failed");
    return JSON.parse((await bytes(response)).toString()) as Json;
  }
  async function list(path: string) {
    const values: Json[] = [];
    for (let page = 1; page <= PUBLICATION_LIMITS.pages; page++) {
      const response = await request(
        `${base}${path}?per_page=100&page=${page}`,
        { headers, redirect: "error", signal: signal() },
      );
      check(response.ok, "publication_list_unresolved");
      const rows = JSON.parse((await bytes(response)).toString());
      check(Array.isArray(rows), "publication_list_invalid");
      values.push(...rows);
      if (!response.headers.get("link")?.includes('rel="next"')) return values;
    }
    throw Error("publication_list_incomplete");
  }
  async function release() {
    const exact = await api(`/releases/tags/${tag}`);
    if (exact) return exact;
    const drafts = (await list("/releases")).filter(
      (value) => value.tag_name === tag,
    );
    check(drafts.length <= 1, "publication_release_ambiguous");
    return drafts[0];
  }
  async function tagCommit(required: boolean) {
    const ref = await api(`/git/ref/tags/${tag}`);
    if (!ref) {
      check(!required, "publication_tag_missing");
      return;
    }
    check(ref.ref === `refs/tags/${tag}`, "publication_tag_mismatch");
    let object = ref.object;
    const seen = new Set<string>();
    for (let depth = 0; depth < 5; depth++) {
      check(
        revision.test(object?.sha) && !seen.has(object.sha),
        "publication_tag_invalid",
      );
      seen.add(object.sha);
      if (object.type === "commit") {
        check(object.sha === source, "publication_tag_mismatch");
        return;
      }
      check(object.type === "tag", "publication_tag_invalid");
      object = (await api(`/git/tags/${object.sha}`))?.object;
    }
    throw Error("publication_tag_depth");
  }
  const repo = await api("");
  check(
    repo?.private === false && repo.full_name === repository,
    "publication_repository_not_public",
  );
  await tagCommit(false);
  const statePath = join(directory, "publication-state.json");
  let state: State | undefined;
  try {
    state = (await boundedJson(statePath, 4 * 1024 ** 2)) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let manifest = input.manifest,
    assets = input.assets;
  function useFrozen(value: Manifest, reportBytes: Buffer) {
    check(
      compatible(value, input.manifest) &&
        sha.test(value.report.sha256) &&
        value.report.name ===
          `whole-os-qualification-${value.report.sha256}.json` &&
        hash(reportBytes) === value.report.sha256 &&
        reportBytes.length === value.report.size,
      "publication_state_unbound",
    );
    const prior = JSON.parse(reportBytes.toString());
    boundReport(prior, source, value.recipe_sha256, value.raw);
    check(
      canonical(prior.installer) === canonical(input.report.installer) &&
        canonical(prior.raw) === canonical(input.report.raw) &&
        prior.extension_ref === input.report.extension_ref &&
        prior.recipe_extension_ref === input.report.recipe_extension_ref,
      "publication_report_inputs_changed",
    );
    manifest = value;
    const path = join(input.staging, "frozen-report.json");
    assets = [
      assets[0]!,
      { ...value.report, content_type: "application/json", path },
      assets[2]!,
    ];
    return writeFile(path, reportBytes, { mode: 0o600 });
  }
  if (state) {
    check(
      state.version === 1 &&
        typeof state.authorized_initial_push === "boolean" &&
        state.uploads &&
        typeof state.uploads === "object",
      "publication_state_invalid",
    );
    await useFrozen(state.manifest, Buffer.from(state.report_base64, "base64"));
  }
  let selected = await release();
  if (!state && selected && !selected.draft) {
    check(
      typeof selected.body === "string" && selected.body.startsWith(bodyPrefix),
      "publication_release_unbound",
    );
    const prior = JSON.parse(
      selected.body.slice(bodyPrefix.length),
    ) as Manifest;
    check(compatible(prior, input.manifest), "publication_release_unbound");
    const old = (await list(`/releases/${selected.id}/assets`)).find(
      (asset) => asset.name === prior.report.name,
    );
    check(old, "publication_asset_missing");
    const reportBytes = await download(old, prior.report, true, true);
    await useFrozen(prior, reportBytes!);
  }
  if (!state) {
    state = {
      version: 1,
      manifest,
      report_base64: (await readFile(assets[1]!.path)).toString("base64"),
      authorized_initial_push: options.fresh,
      creation_attempted: false,
      publication_attempted: false,
      uploads: {},
    };
    await atomic(statePath, state);
  }
  const mutable = state.authorized_initial_push === true;
  if (!selected) {
    check(
      mutable && !state.creation_attempted,
      "publication_creation_unresolved",
    );
    state.creation_attempted = true;
    await atomic(statePath, state);
    try {
      selected = await api("/releases", {
        method: "POST",
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: source,
          name: `Talos ${source}`,
          body: bodyPrefix + canonical(manifest),
          draft: true,
          prerelease: true,
          make_latest: "false",
          generate_release_notes: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      selected = await release();
    }
    check(selected, "publication_creation_unresolved");
  }
  function identity(value: Json) {
    check(
      Number.isSafeInteger(value.id) &&
        value.id > 0 &&
        value.tag_name === tag &&
        value.target_commitish === source &&
        value.prerelease === true &&
        value.body === bodyPrefix + canonical(manifest),
      "publication_release_unbound",
    );
  }
  identity(selected);
  const existing = await list(`/releases/${selected.id}/assets`);
  async function download(
    asset: Json,
    expected: PublicAsset,
    anonymous: boolean,
    keep = false,
  ) {
    check(
      asset.name === expected.name &&
        asset.state === "uploaded" &&
        asset.size === expected.size &&
        (!asset.digest || asset.digest === `sha256:${expected.sha256}`),
      "publication_asset_mismatch",
    );
    let url = anonymous
      ? asset.browser_download_url
      : `${base}/releases/assets/${asset.id}`;
    let first = true;
    const transfer = signal(true);
    for (let hop = 0; hop <= PUBLICATION_LIMITS.redirects; hop++) {
      const parsed = new URL(url);
      check(
        parsed.protocol === "https:" && !parsed.username && !parsed.password,
        "publication_download_url_invalid",
      );
      const response = await request(url, {
        headers: {
          ...(!anonymous && first ? headers : {}),
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
        },
        redirect: "manual",
        signal: transfer,
      });
      first = false;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        check(location, "publication_redirect_invalid");
        await response.body?.cancel();
        url = new URL(location, url).href;
        continue;
      }
      check(
        response.status === 200 &&
          response.body &&
          (!response.headers.get("content-encoding") ||
            response.headers.get("content-encoding") === "identity"),
        "publication_download_failed",
      );
      const value = createHash("sha256"),
        chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= expected.size, "publication_download_overflow");
        value.update(chunk);
        if (keep) {
          check(
            size <= PUBLICATION_LIMITS.metadata_bytes,
            "publication_metadata_bound",
          );
          chunks.push(Buffer.from(chunk));
        }
      }
      check(
        size === expected.size && value.digest("hex") === expected.sha256,
        "publication_download_mismatch",
      );
      return keep ? Buffer.concat(chunks) : undefined;
    }
    throw Error("publication_redirect_bound");
  }
  const uploaded: Json[] = [];
  for (const asset of assets) {
    const matches = existing.filter((value) => value.name === asset.name);
    check(matches.length <= 1, "publication_asset_ambiguous");
    let remote = matches[0];
    if (!remote) {
      check(
        selected.draft === true &&
          mutable &&
          state.uploads[asset.name] === undefined,
        "publication_upload_unresolved",
      );
      state.uploads[asset.name] = "attempted";
      await atomic(statePath, state);
      const target = `https://uploads.github.com/repos/${repository}/releases/${selected.id}/assets?name=${encodeURIComponent(asset.name)}`;
      try {
        const response = await request(target, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": asset.content_type,
            "Content-Length": String(asset.size),
          },
          body: Readable.toWeb(createReadStream(asset.path)) as NonNullable<
            RequestInit["body"]
          >,
          duplex: "half",
          redirect: "error",
          signal: signal(true),
        } as RequestInit);
        check(response.status === 201, "publication_upload_failed");
        remote = JSON.parse((await bytes(response)).toString());
      } catch {
        const rows = (await list(`/releases/${selected.id}/assets`)).filter(
          (value) => value.name === asset.name,
        );
        check(rows.length <= 1, "publication_asset_ambiguous");
        remote = rows[0];
      }
      check(remote, "publication_upload_unresolved");
    }
    await download(remote, asset, !selected.draft);
    state.uploads[asset.name] = "confirmed";
    await atomic(statePath, state);
    uploaded.push(remote);
  }
  // Rehash every published local input after upload, before making a draft public.
  for (const asset of assets) {
    const actual = await fileIdentity(asset.path);
    check(
      actual.sha256 === asset.sha256 && actual.size === asset.size,
      "publication_input_changed",
    );
  }
  if (selected.draft) {
    check(
      mutable && !state.publication_attempted,
      "publication_publish_unresolved",
    );
    state.publication_attempted = true;
    await atomic(statePath, state);
    try {
      selected = await api(`/releases/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: false,
          prerelease: true,
          make_latest: "false",
        }),
      });
    } catch {
      selected = await release();
    }
    check(
      selected && selected.draft === false,
      "publication_publish_unresolved",
    );
    identity(selected);
  }
  await tagCommit(true);
  const finalAssets = await list(`/releases/${selected.id}/assets`);
  const resultAssets: Record<
    string,
    { url: string; sha256: string; size: number }
  > = {};
  for (const [position, asset] of assets.entries()) {
    const matches = finalAssets.filter((value) => value.name === asset.name);
    check(matches.length === 1, "publication_asset_missing");
    await download(matches[0]!, asset, true);
    resultAssets[["raw", "report", "recipe"][position]!] = {
      url: matches[0]!.browser_download_url,
      sha256: asset.sha256,
      size: asset.size,
    };
  }
  const result = {
    version: 1,
    source_commit: source,
    release_url: `https://github.com/${repository}/releases/tag/${tag}`,
    installer_ref: installerRef,
    recipe_sha256: manifest.recipe_sha256,
    assets: resultAssets,
    anonymous_readback: true,
    raw_adoption: false,
  };
  await atomic(join(directory, "publication.json"), result);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    const [command, ...args] = process.argv.slice(2);
    if (command === "load-id" && args.length === 1) {
      console.log(loadedInstallerId(await readFile(args[0]!, "utf8")));
      return;
    }
    if (command === "verify-transport" && args.length === 4) {
      const result = await verifyInstallerTransport(
        args[0]!,
        await boundedJson(args[1]!),
        args[2]!,
      );
      await atomic(args[3]!, result);
      return;
    }
    if (command === "registry-presence" && args.length === 2) {
      console.log(
        await installerRegistryPresence(args[0]!, args[1]!, {
          actor: process.env.GITHUB_ACTOR ?? "",
          token: process.env.GH_TOKEN ?? "",
        }),
      );
      return;
    }
    check(
      command === "publish" &&
        args.length === 3 &&
        process.env.CI === "true" &&
        process.env.GITHUB_SHA === args[1],
      "publication_invocation_invalid",
    );
    const result = await publishTalosArtifacts(
      args[0]!,
      args[1]!,
      process.env.GITHUB_REPOSITORY ?? "",
      args[2]!,
      {
        token: process.env.GH_TOKEN ?? "",
        fresh:
          process.env.GITHUB_EVENT_NAME === "push" &&
          process.env.GITHUB_RUN_ATTEMPT === "1",
      },
    );
    console.log(JSON.stringify(result));
  })().catch((error) => {
    const code =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "publication_failed";
    console.error(`Talos artifact publication failed: ${code}`);
    process.exitCode = 1;
  });
}
