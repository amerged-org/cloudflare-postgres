// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import versions from "../../platform/versions.lock.json" with { type: "json" };
import {
  installerRegistryPresence,
  loadedInstallerId,
  publishTalosArtifacts,
  verifyInstallerTransport,
} from "./publish-artifacts.ts";

const source = "a".repeat(40);
const repository = "publication-fixture/talos";
const tokenCanary = "publication-test-token-canary-never-forward";
const tag = `talos-sha-${source}`;
const prefix = "PGCF_TALOS_PUBLICATION_V1\n";
interface Qualification {
  passed: boolean;
  source_commit: string;
  recipe_sha256: string;
  raw: { compressed: { sha256: string; size: number } };
  installer: {
    configDigest: string;
    diffIDs: string[];
    layerDigests: string[];
    archive_sha256: string;
    archive_bytes: number;
  };
  generated_at?: string;
}
interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  prerelease: boolean;
  draft: boolean;
  body: string;
}
interface RemoteAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  digest?: string;
  browser_download_url: string;
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
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-publication-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  return directory;
}

async function json(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function tar(entries: Record<string, Buffer>) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive)
      chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  })();
  for (const [name, bytes] of Object.entries(entries)) {
    archive.entry(
      { name, size: bytes.length, mode: 0o600, mtime: new Date(0) },
      bytes,
    );
  }
  archive.finalize();
  return collected;
}

async function transportFixture(directory: string) {
  const layer = await tar({
    "bin/installer": Buffer.from("qualified installer fixture\n"),
  });
  const gzip = gzipSync(layer, { level: 9 });
  const diffID = `sha256:${hash(layer)}`;
  const config = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      rootfs: { type: "layers", diff_ids: [diffID] },
      config: {
        Entrypoint: ["/bin/installer"],
        Labels: {
          "org.opencontainers.image.source":
            "https://github.com/siderolabs/talos",
          "alpha.talos.dev/version": `v${versions.target.talosVersion}`,
        },
      },
    }),
  );
  const report = {
    passed: true,
    source_commit: source,
    installer: {
      configDigest: `sha256:${hash(config)}`,
      diffIDs: [diffID],
      layerDigests: [`sha256:${hash(gzip)}`],
    },
  };
  async function archive(
    filename: string,
    configuration = config,
    compressed = gzip,
    repoTag = "local/qualified:fixture",
  ) {
    const configDigest = `sha256:${hash(configuration)}`;
    const layerDigest = `sha256:${hash(compressed)}`;
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: configDigest,
          size: configuration.length,
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
            digest: layerDigest,
            size: compressed.length,
          },
        ],
      }),
    );
    const manifestDigest = `sha256:${hash(manifest)}`;
    const configPath = `blobs/sha256/${configDigest.slice(7)}`;
    const layerPath = `blobs/sha256/${layerDigest.slice(7)}`;
    const bytes = await tar({
      "manifest.json": Buffer.from(
        JSON.stringify([
          { Config: configPath, Layers: [layerPath], RepoTags: [repoTag] },
        ]),
      ),
      "index.json": Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          manifests: [
            {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              digest: manifestDigest,
              size: manifest.length,
            },
          ],
        }),
      ),
      "oci-layout": Buffer.from('{"imageLayoutVersion":"1.0.0"}'),
      [`blobs/sha256/${manifestDigest.slice(7)}`]: manifest,
      [configPath]: configuration,
      [layerPath]: compressed,
    });
    const path = join(directory, filename);
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, bytes, manifestDigest };
  }
  return { layer, gzip, config, report, archive };
}

async function publicationFixture(directory: string) {
  await mkdir(join(directory, "out"), { mode: 0o700 });
  await mkdir(join(directory, "recipe-context"), { mode: 0o700 });
  await mkdir(join(directory, "installer-gate"), { mode: 0o700 });
  const transport = await transportFixture(directory);
  const installer = await transport.archive("installer.tar");
  const raw = Buffer.from("qualified raw xz fixture\n");
  const recipe = { source_commit: source, architecture: "amd64", version: 1 };
  const recipeBytes = Buffer.from(canonical(recipe));
  const recipeSha = hash(recipeBytes);
  const installerRef = `ghcr.io/publication-fixture/talos@${installer.manifestDigest}`;
  const report: Qualification = {
    ...transport.report,
    recipe_sha256: recipeSha,
    raw: { compressed: { sha256: hash(raw), size: raw.length } },
    installer: {
      ...transport.report.installer,
      archive_sha256: hash(installer.bytes),
      archive_bytes: installer.bytes.length,
    },
  };
  const verifiedTransport = await verifyInstallerTransport(
    installer.path,
    report,
    source,
  );
  const registry = {
    digest: installer.manifestDigest,
    manifestDigest: installer.manifestDigest,
    configDigest: report.installer.configDigest,
    layersVerified: 1,
    compressedBytes: transport.gzip.length,
  };
  const paths = {
    report: join(directory, "whole-os-qualification.json"),
    plan: join(directory, "recipe-context", "plan.json"),
    raw: join(directory, "out", "nocloud-amd64.raw.xz"),
    installer: join(directory, "out", "installer-amd64.tar"),
    registry: join(directory, "installer-gate", "registry.json"),
    transport: join(directory, "installer-gate", "transport.json"),
  };
  await writeFile(paths.raw, raw, { mode: 0o600 });
  await writeFile(paths.installer, installer.bytes, { mode: 0o600 });
  await json(paths.plan, { recipe, recipeSha256: recipeSha });
  await json(paths.report, report);
  await json(paths.registry, registry);
  await json(paths.transport, verifiedTransport);
  const reportBytes = await readFile(paths.report);
  const manifest = {
    version: 1,
    source_commit: source,
    repository,
    recipe_sha256: recipeSha,
    installer_ref: installerRef,
    raw: {
      name: `nocloud-amd64-${hash(raw)}.raw.xz`,
      sha256: hash(raw),
      size: raw.length,
    },
    report: {
      name: `whole-os-qualification-${hash(reportBytes)}.json`,
      sha256: hash(reportBytes),
      size: reportBytes.length,
    },
    recipe: {
      name: `talos-recipe-${recipeSha}.json`,
      sha256: recipeSha,
      size: recipeBytes.length,
    },
  };
  return {
    directory,
    paths,
    report,
    registry,
    verifiedTransport,
    manifest,
    installerRef,
    raw,
  };
}

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
type Call = { method: string; url: string; authorization: boolean };

class GitHubFixture {
  calls: Call[] = [];
  release: Release | undefined;
  assets: RemoteAsset[] = [];
  contents = new Map<number, Buffer>();
  tagCommit: string | undefined;
  uncertainCreate = false;
  uncertainUpload = false;
  missingUpload = false;
  private nextAssetId = 100;
  readonly fixture: Fixture;

  constructor(fixture: Fixture) {
    this.fixture = fixture;
  }

  seedDraft() {
    this.release = {
      id: 42,
      tag_name: tag,
      target_commitish: source,
      prerelease: true,
      draft: true,
      body: prefix + canonical(this.fixture.manifest),
    };
  }

  asset(name: string, bytes: Buffer, omitDigest = false) {
    const id = this.nextAssetId++;
    const asset = {
      id,
      name,
      size: bytes.length,
      state: "uploaded",
      ...(!omitDigest ? { digest: `sha256:${hash(bytes)}` } : {}),
      browser_download_url: `https://release.invalid/${id}`,
    };
    this.contents.set(id, bytes);
    this.assets.push(asset);
    return asset;
  }

  readonly request: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const authorization = headers.has("Authorization");
    this.calls.push({ method, url: url.href, authorization });
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    const response = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (
      ["release.invalid", "redirect.invalid", "blob.invalid"].includes(
        url.hostname,
      )
    ) {
      assert.equal(method, "GET");
      assert.equal(
        authorization,
        false,
        "download redirects must remain anonymous",
      );
      assert.equal(headers.get("Accept-Encoding"), "identity");
      assert.equal(init.redirect, "manual");
      const id = Number(url.pathname.slice(1));
      assert.ok(this.contents.has(id));
      if (url.hostname === "release.invalid") {
        return new Response(null, {
          status: 302,
          headers: { location: `https://redirect.invalid/${id}` },
        });
      }
      if (url.hostname === "redirect.invalid") {
        return new Response(null, {
          status: 307,
          headers: { location: `https://blob.invalid/${id}` },
        });
      }
      return new Response(new Uint8Array(this.contents.get(id)!));
    }
    assert.ok(
      ["api.github.com", "uploads.github.com"].includes(url.hostname),
      "unexpected request target",
    );
    assert.equal(
      headers.get("Authorization") === `Bearer ${tokenCanary}`,
      true,
      "API authentication missing",
    );
    assert.equal(url.pathname.startsWith(`/repos/${repository}`), true);
    assert.equal(headers.get("X-GitHub-Api-Version"), "2026-03-10");
    const path = url.pathname.slice(`/repos/${repository}`.length);
    if (url.hostname === "uploads.github.com") {
      assert.equal(path, "/releases/42/assets");
      assert.equal(method, "POST");
      assert.equal(this.release?.draft, true);
      const name = url.searchParams.get("name");
      assert.ok(name);
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      assert.equal(bytes.length, Number(headers.get("Content-Length")));
      if (this.missingUpload)
        throw new Error("simulated_upload_outcome_unknown");
      const asset = this.asset(name, bytes);
      if (this.uncertainUpload) {
        this.uncertainUpload = false;
        throw new Error("simulated_upload_reply_lost");
      }
      return response(asset, 201);
    }
    if (path.startsWith("/releases/assets/")) {
      assert.equal(method, "GET");
      assert.equal(headers.get("Accept"), "application/octet-stream");
      assert.equal(init.redirect, "manual");
      const id = Number(path.split("/").at(-1));
      assert.ok(this.contents.has(id));
      return new Response(null, {
        status: 302,
        headers: { location: `https://release.invalid/${id}` },
      });
    }
    assert.equal(init.redirect, "error");
    if (path === "" && method === "GET")
      return response({ full_name: repository, private: false });
    if (path === `/git/ref/tags/${tag}` && method === "GET") {
      return this.tagCommit
        ? response({
            ref: `refs/tags/${tag}`,
            object: { type: "commit", sha: this.tagCommit },
          })
        : response({}, 404);
    }
    if (path === `/releases/tags/${tag}` && method === "GET") {
      return this.release && !this.release.draft
        ? response(this.release)
        : response({}, 404);
    }
    if (path === "/releases" && method === "GET")
      return response(this.release ? [this.release] : []);
    if (path === "/releases" && method === "POST") {
      assert.equal(
        this.release,
        undefined,
        "release creation must not be replayed",
      );
      const body = JSON.parse(String(init.body)) as Omit<Release, "id"> & {
        make_latest: string;
        generate_release_notes: boolean;
      };
      assert.equal(body.target_commitish, source);
      assert.equal(body.draft, true);
      assert.equal(body.prerelease, true);
      assert.equal(body.make_latest, "false");
      assert.equal(body.generate_release_notes, false);
      this.release = { ...body, id: 42 };
      if (this.uncertainCreate) throw new Error("simulated_create_reply_lost");
      return response(this.release, 201);
    }
    if (path === "/releases/42/assets" && method === "GET")
      return response(this.assets);
    if (path === "/releases/42" && method === "PATCH") {
      assert.equal(this.assets.length, 3);
      assert.ok(this.release);
      assert.equal(this.release?.draft, true);
      assert.deepEqual(JSON.parse(String(init.body)), {
        draft: false,
        prerelease: true,
        make_latest: "false",
      });
      this.release = { ...this.release, draft: false };
      this.tagCommit = source;
      return response(this.release);
    }
    throw new Error(`unexpected_fake_request_${method}_${path}`);
  };
}

function publish(fixture: Fixture, server: GitHubFixture, fresh = true) {
  return publishTalosArtifacts(
    fixture.directory,
    source,
    repository,
    fixture.installerRef,
    {
      token: tokenCanary,
      fresh,
      request: server.request,
    },
  );
}

function mutations(server: GitHubFixture) {
  return server.calls.filter((call) => call.method !== "GET");
}

function registryRequest(manifestResponse: Response) {
  const methods: string[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    methods.push(init.method ?? "GET");
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(url.hostname, "ghcr.io");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (url.pathname === "/token") {
      assert.equal(
        headers.get("Authorization") ===
          `Basic ${Buffer.from(`fixture:${tokenCanary}`).toString("base64")}`,
        true,
      );
      assert.equal(
        url.searchParams.get("scope"),
        "repository:publication-fixture/talos:pull",
      );
      return new Response(JSON.stringify({ token: "registry-grant-canary" }));
    }
    assert.equal(
      url.pathname,
      `/v2/publication-fixture/talos/manifests/${tag}`,
    );
    assert.equal(headers.get("Authorization"), "Bearer registry-grant-canary");
    return manifestResponse;
  };
  return { request, methods };
}

test("installer registry presence returns absent for a confirmed 404 using GET only", async () => {
  const registry = registryRequest(new Response(null, { status: 404 }));
  const result = await installerRegistryPresence(
    `ghcr.io/publication-fixture/talos:${tag}`,
    `sha256:${"c".repeat(64)}`,
    { actor: "fixture", token: tokenCanary, request: registry.request },
  );
  assert.equal(result, "absent");
  assert.deepEqual(registry.methods, ["GET", "GET"]);
});

test("installer registry presence reuses an exact single manifest using GET only", async () => {
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: 2, config: {}, layers: [] }),
  );
  const digest = `sha256:${hash(bytes)}`;
  const registry = registryRequest(
    new Response(bytes, { headers: { "docker-content-digest": digest } }),
  );
  const result = await installerRegistryPresence(
    `ghcr.io/publication-fixture/talos:${tag}`,
    digest,
    { actor: "fixture", token: tokenCanary, request: registry.request },
  );
  assert.equal(result, "present");
  assert.deepEqual(registry.methods, ["GET", "GET"]);
});

test("installer registry presence refuses a conflicting tag without PUT or POST", async () => {
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: 2, config: {}, layers: [] }),
  );
  const registry = registryRequest(
    new Response(bytes, {
      headers: { "docker-content-digest": `sha256:${hash(bytes)}` },
    }),
  );
  await assert.rejects(
    installerRegistryPresence(
      `ghcr.io/publication-fixture/talos:${tag}`,
      `sha256:${"c".repeat(64)}`,
      { actor: "fixture", token: tokenCanary, request: registry.request },
    ),
    /installer_registry_tag_conflict/,
  );
  assert.deepEqual(registry.methods, ["GET", "GET"]);
});

test("draft assets are byte verified before publication and completely read back anonymously", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  const result = await publish(fixture, server);
  assert.equal(result.anonymous_readback, true);
  assert.equal(result.raw_adoption, false);
  assert.equal(result.source_commit, source);
  assert.equal(result.installer_ref, fixture.installerRef);
  assert.equal(
    mutations(server).filter((call) => call.method === "POST").length,
    4,
  );
  assert.equal(
    mutations(server).filter((call) => call.method === "PATCH").length,
    1,
  );
  const patchIndex = server.calls.findIndex((call) => call.method === "PATCH");
  assert.equal(
    server.calls
      .slice(0, patchIndex)
      .filter((call) => call.url.includes("/releases/assets/")).length,
    3,
  );
  const afterPublication = server.calls.slice(patchIndex + 1);
  assert.equal(
    afterPublication.filter(
      (call) => new URL(call.url).hostname === "blob.invalid",
    ).length,
    3,
  );
  assert.ok(
    afterPublication
      .filter((call) => new URL(call.url).hostname.endsWith(".invalid"))
      .every((call) => !call.authorization),
  );
  assert.equal(
    server.calls.filter((call) => call.url.includes("/releases/assets/"))
      .length,
    3,
  );
  for (const name of ["publication-state.json", "publication.json"]) {
    const bytes = await readFile(join(fixture.directory, name), "utf8");
    assert.equal(bytes.includes(tokenCanary), false);
    assert.equal(
      (await stat(join(fixture.directory, name))).mode & 0o777,
      0o600,
    );
  }
});

test("a failed qualification and a changed source both refuse network access", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  fixture.report.passed = false;
  await json(fixture.paths.report, fixture.report);
  await assert.rejects(publish(fixture, server), /publication_report_unbound/);
  fixture.report.passed = true;
  fixture.report.source_commit = "b".repeat(40);
  await json(fixture.paths.report, fixture.report);
  await assert.rejects(publish(fixture, server), /publication_report_unbound/);
  assert.equal(server.calls.length, 0);
});

test("recipe source and canonical recipe hash are bound before network access", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  const plan = JSON.parse(await readFile(fixture.paths.plan, "utf8"));
  plan.recipe.source_commit = "b".repeat(40);
  plan.recipeSha256 = hash(Buffer.from(canonical(plan.recipe)));
  await json(fixture.paths.plan, plan);
  await assert.rejects(publish(fixture, server), /publication_recipe_unbound/);
  plan.recipe.source_commit = source;
  await json(fixture.paths.plan, plan);
  await assert.rejects(publish(fixture, server), /publication_recipe_unbound/);
  assert.equal(server.calls.length, 0);
});

test("changed raw bytes and changed installer archive refuse publication", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  await writeFile(fixture.paths.raw, Buffer.alloc(fixture.raw.length, 0x78));
  await assert.rejects(publish(fixture, server), /publication_report_unbound/);
  await writeFile(fixture.paths.raw, fixture.raw);
  await writeFile(fixture.paths.installer, "changed installer archive\n");
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_archive_changed/,
  );
  assert.equal(server.calls.length, 0);
});

test("transport source, config, diffIDs and upstream identity must match the qualified registry gate", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  await json(fixture.paths.transport, {
    ...fixture.verifiedTransport,
    source_commit: "b".repeat(40),
  });
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_registry_unbound/,
  );
  await json(fixture.paths.transport, {
    ...fixture.verifiedTransport,
    configDigest: `sha256:${"b".repeat(64)}`,
  });
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_registry_unbound/,
  );
  await json(fixture.paths.transport, {
    ...fixture.verifiedTransport,
    diffIDs: [`sha256:${"b".repeat(64)}`],
  });
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_registry_unbound/,
  );
  await json(fixture.paths.transport, {
    ...fixture.verifiedTransport,
    upstreamLabelsPreserved: false,
  });
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_registry_unbound/,
  );
  assert.equal(server.calls.length, 0);
});

test("registry digest and complete compressed layer accounting bind the installer reference", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  await json(fixture.paths.registry, {
    ...fixture.registry,
    digest: `sha256:${"b".repeat(64)}`,
  });
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_registry_unbound/,
  );
  await json(fixture.paths.registry, {
    ...fixture.registry,
    compressedBytes: fixture.registry.compressedBytes - 1,
  });
  await assert.rejects(
    publish(fixture, server),
    /publication_installer_registry_unbound/,
  );
  assert.equal(server.calls.length, 0);
});

test("lost create and upload replies are resolved with GET without replaying either POST", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  server.uncertainCreate = true;
  server.uncertainUpload = true;
  await publish(fixture, server);
  assert.equal(
    server.calls.filter(
      (call) =>
        call.method === "POST" &&
        new URL(call.url).pathname.endsWith("/releases"),
    ).length,
    1,
  );
  const rawUploads = server.calls.filter(
    (call) =>
      call.method === "POST" &&
      new URL(call.url).searchParams.get("name") === fixture.manifest.raw.name,
  );
  assert.equal(rawUploads.length, 1);
  const firstUpload = server.calls.findIndex((call) => call === rawUploads[0]);
  assert.equal(server.calls[firstUpload + 1]!.method, "GET");
  assert.equal(
    new URL(server.calls[firstUpload + 1]!.url).pathname.endsWith(
      "/releases/42/assets",
    ),
    true,
  );
});

test("an unresolved upload attempt blocks another POST even on an authorized rerun", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  server.missingUpload = true;
  await assert.rejects(
    publish(fixture, server),
    /publication_upload_unresolved/,
  );
  const state = JSON.parse(
    await readFile(join(fixture.directory, "publication-state.json"), "utf8"),
  );
  assert.equal(state.uploads[fixture.manifest.raw.name], "attempted");
  server.calls = [];
  server.missingUpload = false;
  await assert.rejects(
    publish(fixture, server),
    /publication_upload_unresolved/,
  );
  assert.equal(mutations(server).length, 0);
  assert.equal(server.assets.length, 0);
});

test("an existing same-name asset with wrong bytes is refused without overwrite", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  server.seedDraft();
  server.asset(
    fixture.manifest.raw.name,
    Buffer.alloc(fixture.raw.length, 0x78),
    true,
  );
  await assert.rejects(
    publish(fixture, server),
    /publication_download_mismatch/,
  );
  assert.equal(mutations(server).length, 0);
  assert.equal(server.assets.length, 1);
});

test("an existing tag targeting another commit blocks all publication mutations", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  server.tagCommit = "b".repeat(40);
  await assert.rejects(publish(fixture, server), /publication_tag_mismatch/);
  assert.equal(mutations(server).length, 0);
  assert.equal(server.release, undefined);
});

test("a rerun without a local receipt uses only GET and the published qualification bytes", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  const original = await publish(fixture, server);
  await rm(join(fixture.directory, "publication-state.json"));
  await rm(join(fixture.directory, "publication.json"));
  fixture.report.generated_at =
    "a later qualification report with the same qualified inputs";
  await json(fixture.paths.report, fixture.report);
  assert.notEqual(
    hash(await readFile(fixture.paths.report)),
    original.assets.report!.sha256,
  );
  server.calls = [];
  const replay = await publish(fixture, server, false);
  assert.deepEqual(replay, original);
  assert.equal(mutations(server).length, 0);
  assert.ok(
    server.calls.some((call) => new URL(call.url).hostname === "blob.invalid"),
  );
  assert.ok(
    server.calls
      .filter((call) => new URL(call.url).hostname.endsWith(".invalid"))
      .every((call) => !call.authorization),
  );
});

test("a rerun without prior state cannot create a missing release", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  await assert.rejects(
    publish(fixture, server, false),
    /publication_creation_unresolved/,
  );
  assert.equal(mutations(server).length, 0);
});

test("a published report with a valid asset hash cannot change the qualified installer", async (t) => {
  const fixture = await publicationFixture(await temporary(t));
  const server = new GitHubFixture(fixture);
  const priorReport = structuredClone(fixture.report);
  priorReport.installer.configDigest = `sha256:${"b".repeat(64)}`;
  const reportBytes = Buffer.from(`${JSON.stringify(priorReport)}\n`);
  const manifest = structuredClone(fixture.manifest);
  manifest.report = {
    name: `whole-os-qualification-${hash(reportBytes)}.json`,
    sha256: hash(reportBytes),
    size: reportBytes.length,
  };
  server.seedDraft();
  assert.ok(server.release);
  server.release.draft = false;
  server.release.body = prefix + canonical(manifest);
  server.tagCommit = source;
  server.asset(manifest.report.name, reportBytes);
  await assert.rejects(
    publish(fixture, server, false),
    /publication_report_inputs_changed/,
  );
  assert.equal(mutations(server).length, 0);
  assert.equal(
    server.calls.filter((call) => new URL(call.url).hostname === "blob.invalid")
      .length,
    1,
  );
});

test("Docker transport wrapper changes preserve exact qualified config, gzip and diffIDs", async (t) => {
  const directory = await temporary(t);
  const fixture = await transportFixture(directory);
  const archive = await fixture.archive(
    "transport.tar",
    fixture.config,
    fixture.gzip,
    "renamed/local:wrapper",
  );
  const result = await verifyInstallerTransport(
    archive.path,
    fixture.report,
    source,
  );
  assert.equal(result.configDigest, fixture.report.installer.configDigest);
  assert.deepEqual(result.diffIDs, fixture.report.installer.diffIDs);
  assert.deepEqual(result.layerDigests, fixture.report.installer.layerDigests);
  assert.equal(result.compressedBytes, fixture.gzip.length);
  assert.equal(result.upstreamLabelsPreserved, true);
  const changedDiffID = structuredClone(fixture.report);
  changedDiffID.installer.diffIDs = [`sha256:${"b".repeat(64)}`];
  await assert.rejects(
    verifyInstallerTransport(archive.path, changedDiffID, source),
    /installer_transport_config_changed/,
  );
});

test("transport refuses normalized config or recompressed gzip despite equivalent contents", async (t) => {
  const directory = await temporary(t);
  const fixture = await transportFixture(directory);
  const normalized = Buffer.from(
    JSON.stringify(JSON.parse(fixture.config.toString()), null, 2),
  );
  assert.notEqual(hash(normalized), hash(fixture.config));
  const changedConfig = await fixture.archive(
    "normalized-config.tar",
    normalized,
  );
  await assert.rejects(
    verifyInstallerTransport(changedConfig.path, fixture.report, source),
    /installer_transport_manifest_invalid/,
  );
  const recompressed = gzipSync(fixture.layer, { level: 1 });
  assert.deepEqual(gunzipSync(recompressed), gunzipSync(fixture.gzip));
  assert.notEqual(hash(recompressed), hash(fixture.gzip));
  const changedLayer = await fixture.archive(
    "normalized-layer.tar",
    fixture.config,
    recompressed,
  );
  await assert.rejects(
    verifyInstallerTransport(changedLayer.path, fixture.report, source),
    /installer_transport_layer_changed/,
  );
});

test("loaded installer ID parsing accepts one exact ID and refuses ambiguous or tagged output", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  assert.equal(
    loadedInstallerId(`Docker progress\nLoaded image ID: ${digest}\n`),
    digest,
  );
  assert.throws(
    () => loadedInstallerId(`Loaded image: local/installer:latest\n`),
    /installer_load_reply_invalid/,
  );
  assert.throws(
    () =>
      loadedInstallerId(
        `Loaded image ID: ${digest}\nLoaded image ID: ${digest}\n`,
      ),
    /installer_load_reply_invalid/,
  );
  assert.throws(
    () =>
      loadedInstallerId(
        `Loaded image ID: ${digest}\nLoaded image ID: malformed\n`,
      ),
    /installer_load_reply_invalid/,
  );
  assert.throws(
    () =>
      loadedInstallerId(`Loaded image ID: ${digest}\n${"x".repeat(64 * 1024)}`),
    /installer_load_reply_invalid/,
  );
});
