// SPDX-License-Identifier: Apache-2.0
/** Selected architecture-specific manifest is authoritative; the original index is legacy/provenance only. */
export function selectedImageManifestDigest(
  value: unknown,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("image_manifest_entry_invalid");
  const image = value as Record<string, unknown>;
  if (Object.hasOwn(image, "manifestDigest")) {
    if (
      typeof image.manifestDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(image.manifestDigest)
    )
      throw new Error("image_selected_manifest_invalid");
    return image.manifestDigest;
  }
  if (image.indexDigest === undefined) return undefined;
  if (
    typeof image.indexDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(image.indexDigest)
  )
    throw new Error("image_legacy_index_invalid");
  return image.indexDigest;
}

const repository = (reference: string) => {
  const raw = reference.split("@")[0]!,
    colon = raw.lastIndexOf(":"),
    slash = raw.lastIndexOf("/");
  return colon > slash ? raw.slice(0, colon) : raw;
};
export { repository as imageRepository };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("image_runtime_metadata_invalid");
  return value as Record<string, unknown>;
}
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("image_runtime_metadata_invalid");
  return value.map(object);
}
async function metadataDigest(body: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
async function runtimeMetadataBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!response.body) throw new Error("image_runtime_metadata_body_missing");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error("image_runtime_metadata_body_limit");
      chunks.push(next.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
type RuntimeImageCommands = { request?: typeof fetch; signal?: AbortSignal };
const runtimeIndexes = new WeakMap<
  typeof fetch,
  Map<string, Record<string, unknown>>
>();
/** Cache only verified data, never request-owned I/O promises shared across Worker requests. */
async function runtimeIndex(
  imageRepository: string,
  sha256: string,
  commands: RuntimeImageCommands,
) {
  const key = `${imageRepository}@sha256:${sha256}`,
    request = commands.request ?? fetch;
  let cache = runtimeIndexes.get(request);
  if (!cache) {
    cache = new Map();
    runtimeIndexes.set(request, cache);
  }
  const completed = cache.get(key);
  if (completed) return completed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = await (async () => {
      if (
        !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*$/.test(
          imageRepository,
        ) ||
        imageRepository
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new Error("patch_kubernetes_runtime_reference_invalid");
      const deadline = new AbortController();
      timer = setTimeout(() => deadline.abort(), 15_000);
      const separator = imageRepository.indexOf("/"),
        signal = commands.signal
          ? AbortSignal.any([commands.signal, deadline.signal])
          : deadline.signal,
        repositoryName = imageRepository.slice(separator + 1),
        imageHost = imageRepository.slice(0, separator),
        registryHost =
          imageHost === "docker.io" ? "registry-1.docker.io" : imageHost;
      let url = new URL(
          `https://${registryHost}/v2/${repositoryName}/manifests/sha256:${sha256}`,
        ),
        redirects = 0,
        pullToken: string | undefined;
      const originalHost = url.hostname;
      const authentication =
        !url.port && originalHost === "ghcr.io"
          ? { realm: "https://ghcr.io/token", service: "ghcr.io" }
          : !url.port && originalHost === "registry-1.docker.io"
            ? {
                realm: "https://auth.docker.io/token",
                service: "registry.docker.io",
              }
            : undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        signal.throwIfAborted();
        const headers = new Headers({
          accept:
            "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json",
        });
        const requestedRepository = url.pathname.match(
          /^\/v2\/(.+)\/manifests\/sha256:[a-f0-9]{64}$/,
        )?.[1];
        if (
          pullToken &&
          url.hostname === originalHost &&
          !url.port &&
          requestedRepository === repositoryName
        )
          headers.set("authorization", `Bearer ${pullToken}`);
        const response = await request(url.href, {
          redirect: "manual",
          signal,
          headers,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || ++redirects > 3)
            throw new Error("patch_kubernetes_runtime_redirect_invalid");
          const next = new URL(location, url);
          if (
            next.protocol !== "https:" ||
            next.username ||
            next.password ||
            next.hash
          )
            throw new Error("patch_kubernetes_runtime_redirect_invalid");
          url = next;
          continue;
        }
        if (
          response.status === 401 &&
          authentication &&
          url.hostname === originalHost &&
          !url.port &&
          requestedRepository === repositoryName &&
          !pullToken
        ) {
          const challenge = response.headers.get("www-authenticate") ?? "";
          await response.body?.cancel();
          const realm = challenge.match(/\brealm="([^"]+)"/)?.[1],
            service = challenge.match(/\bservice="([^"]+)"/)?.[1],
            scope = challenge.match(/\bscope="([^"]+)"/)?.[1];
          if (
            !/^Bearer /i.test(challenge) ||
            realm !== authentication.realm ||
            service !== authentication.service ||
            scope !== `repository:${repositoryName}:pull`
          )
            throw new Error("patch_kubernetes_runtime_challenge_invalid");
          const tokenURL = new URL(realm);
          tokenURL.searchParams.set("service", service);
          tokenURL.searchParams.set("scope", scope);
          const tokenResponse = await request(tokenURL.href, {
            redirect: "manual",
            signal,
          });
          if (!tokenResponse.ok) {
            await tokenResponse.body?.cancel();
            throw new Error("patch_kubernetes_runtime_metadata_unavailable");
          }
          const tokenBody = object(
              JSON.parse(
                await runtimeMetadataBody(tokenResponse, 64 * 1024, signal),
              ),
            ),
            token = tokenBody.token ?? tokenBody.access_token;
          if (
            typeof token !== "string" ||
            token.length < 1 ||
            token.length > 16_384 ||
            !/^[A-Za-z0-9._~+/=-]+$/.test(token)
          )
            throw new Error("patch_kubernetes_runtime_token_invalid");
          pullToken = token;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("patch_kubernetes_runtime_metadata_unavailable");
        }
        const body = await runtimeMetadataBody(response, 512 * 1024, signal);
        if (
          (await metadataDigest(body)) !== sha256 ||
          response.headers.get("docker-content-digest") !== `sha256:${sha256}`
        )
          throw new Error("patch_kubernetes_runtime_digest_mismatch");
        const parsed = object(JSON.parse(body));
        if (
          parsed.schemaVersion !== 2 ||
          ![
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
          ].includes(String(parsed.mediaType))
        )
          throw new Error("patch_kubernetes_runtime_index_invalid");
        objects(parsed.manifests);
        return parsed;
      }
      throw new Error("patch_kubernetes_runtime_redirect_invalid");
    })();
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, verified);
    return verified;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** The caller binds actual Linux/AMD64 Node identity and boot; raw observations remain unchanged. */
export async function normalizeRuntimeImageManifest(
  reference: string,
  expectedSHA: string,
  reportedSHA: string,
  commands: RuntimeImageCommands,
): Promise<string | undefined> {
  if (
    !/^[a-f0-9]{64}$/.test(expectedSHA) ||
    !/^[a-f0-9]{64}$/.test(reportedSHA) ||
    !reference.endsWith(`@sha256:${expectedSHA}`)
  )
    return undefined;
  if (reportedSHA === expectedSHA) return expectedSHA;
  const index = await runtimeIndex(
    repository(reference),
    reportedSHA,
    commands,
  );
  if (!index) return undefined;
  const selected = objects(index.manifests).filter((entry) => {
      const platform = object(entry.platform ?? {});
      return platform.architecture === "amd64" && platform.os === "linux";
    }),
    child = selected[0];
  return selected.length === 1 &&
    child?.digest === `sha256:${expectedSHA}` &&
    Number.isSafeInteger(child.size) &&
    Number(child.size) > 0 &&
    [
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].includes(String(child.mediaType))
    ? expectedSHA
    : undefined;
}
