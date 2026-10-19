// SPDX-License-Identifier: Apache-2.0
// Registers a built node image release (ULTRA plan 9.1 step 5, 9.2): uploads the six files of the
// release to the archive bucket's `node-images/<version>/` prefix and registers their digests with
// the management API. Every node installs from, and updates to, what is registered.
//
//   node scripts/operations/register-node-image.ts --image-dir DIR --binaries DIR [--lock FILE] [--dry-run]
//
//   --image-dir  the `out` directory of `node infra/node-image/node-image.ts build`:
//                pgcf-node.raw.zst and pgcf-node.json. The release name is the one the image was
//                built as (`--release`), which is also the image version a node enrolls as.
//   --binaries   the directory the build took pgcf-agent, pgcf-native-gateway, pgcf-archive and
//                pgcf-wal-fetch from; they must be the files the image was built with.
//   --lock       the package lock the image was built from (default infra/node-image/packages.lock.json).
//   --dry-run    reads the files, prints the manifest and stops before any network call.
//
// Credentials come from these environment variables, in memory only. Their values are never
// printed or written, and an error names a variable, never its value:
//   PGCF_R2_ENDPOINT           the bucket's S3 endpoint, https://<account>.r2.cloudflarestorage.com
//                              (https://<account>.eu.r2.cloudflarestorage.com for an EU bucket)
//   PGCF_R2_BUCKET             the archive bucket the API binds as ARCHIVE
//   PGCF_R2_ACCESS_KEY_ID      an R2 API token with object read and write on that bucket
//   PGCF_R2_SECRET_ACCESS_KEY
//   PGCF_API_URL               the management API's origin, https://...
//   PGCF_API_KEY               an administrator API key
//
// The registration also states what a node that runs the lock reports in its hello (SEC-03): the
// kernel the lock holds and the digest of its packages, which the API compares with each node's.
//
// The API refuses the registration unless every file is in the bucket at the registered size with
// the sha256 R2 verified at upload, so each file is sent with `x-amz-checksum-sha256`. A file that
// is already there with the same content and that sha256 is not sent again; one stored without the
// sha256 is sent again, and one that differs is never overwritten, because a registered release is
// immutable.
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { API_KEY_PATTERN } from "../../packages/contracts/src/auth.ts";
import {
  FleetRelease,
  FleetReleaseRegistration,
  FleetReleaseVersion,
  RELEASE_BINARY_FILES,
  RELEASE_IMAGE_FILE,
  RELEASE_LOCK_FILE,
  packagesSha256,
  releaseObjectKey,
  type FleetPinnedFile,
  type FleetReleaseSpec,
  type ReleaseFile,
} from "../../packages/contracts/src/releases.ts";

export interface FileDigest {
  sha256: string;
  md5: string;
  size_bytes: number;
}
/** The sha256, md5 and size of a file, read once as a stream. */
export async function digestFile(path: string): Promise<FileDigest> {
  const sha256 = createHash("sha256"),
    md5 = createHash("md5");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    sha256.update(chunk);
    md5.update(chunk);
    size += chunk.byteLength;
  }
  return {
    sha256: sha256.digest("hex"),
    md5: md5.digest("hex"),
    size_bytes: size,
  };
}

/** `pgcf-node.json`, which `node-image.ts build` writes beside the image. */
export interface BuildSummary {
  release: string;
  debian_snapshot: string;
  lock_sha256: string;
  raw: { sha256: string; size: number };
  zst: { sha256: string; size: number };
  /** The binaries baked into the image, which are the ones the release pins. */
  binaries: Record<
    (typeof RELEASE_BINARY_FILES)[number],
    { sha256: string; size: number }
  >;
}
const sha256Pattern = /^[0-9a-f]{64}$/;
const isDigest = (value: unknown): value is { sha256: string; size: number } =>
  typeof value === "object" &&
  value !== null &&
  "sha256" in value &&
  typeof value.sha256 === "string" &&
  sha256Pattern.test(value.sha256) &&
  "size" in value &&
  Number.isSafeInteger(value.size) &&
  (value.size as number) > 0;
export function parseBuildSummary(text: string): BuildSummary {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the build summary is not JSON");
  }
  const summary = value as Partial<BuildSummary> | null;
  if (
    typeof summary?.release !== "string" ||
    typeof summary.debian_snapshot !== "string" ||
    !/^[0-9]{8}T[0-9]{6}Z$/.test(summary.debian_snapshot) ||
    typeof summary.lock_sha256 !== "string" ||
    !sha256Pattern.test(summary.lock_sha256) ||
    !isDigest(summary.raw) ||
    !isDigest(summary.zst) ||
    typeof summary.binaries !== "object" ||
    summary.binaries === null ||
    !RELEASE_BINARY_FILES.every((file) => isDigest(summary.binaries?.[file]))
  )
    throw new Error("the build summary is not what node-image.ts build writes");
  return summary as BuildSummary;
}

export interface Upload {
  file: ReleaseFile;
  key: string;
  path: string;
  digest: FileDigest;
}
export interface Manifest {
  version: string;
  registration: FleetReleaseRegistration;
  uploads: Upload[];
}

/**
 * What a node that runs the lock reports in its hello (SEC-03): the digest of the lock's packages,
 * `packages` and `extra` together (the extra ones are in the image too), and the kernel they hold,
 * the one `linux-image-<abi>` package that is no meta package. The API compares both with the node's.
 */
export async function lockOs(
  text: string,
): Promise<{ packages_sha256: string; kernel_release: string }> {
  const malformed = () =>
    new Error("the package lock is not what node-image.ts writes");
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw malformed();
  }
  const packages = new Map<string, string>();
  for (const list of [lock.packages, lock.extra]) {
    if (!Array.isArray(list)) throw malformed();
    for (const entry of list as Record<string, unknown>[]) {
      const { name, version } = entry ?? {};
      if (typeof name !== "string" || typeof version !== "string")
        throw malformed();
      if (packages.get(name) !== undefined && packages.get(name) !== version)
        throw new Error(`${name} is locked in two versions`);
      packages.set(name, version);
    }
  }
  const kernels = [...packages.keys()].filter((name) =>
    /^linux-image-[0-9]/.test(name),
  );
  if (kernels.length !== 1)
    throw new Error(
      `the package lock must hold exactly one kernel image, it holds ${kernels.length}`,
    );
  return {
    packages_sha256: await packagesSha256(
      [...packages].map(([name, version]) => ({ name, version })),
    ),
    kernel_release: kernels[0]!.slice("linux-image-".length),
  };
}

const defaultLock = join(
  import.meta.dirname,
  "../../infra/node-image/packages.lock.json",
);

/**
 * What a build produced, as the API registers it. The image, the lock and the binaries must be the
 * ones the build summarized, so a stale file, another build's lock or binaries rebuilt since are
 * refused here, before a byte is sent: a node installed from the image runs the binaries baked into
 * it, and the release must pin exactly those.
 */
export async function releaseManifest(options: {
  imageDir: string;
  binariesDir: string;
  lockPath?: string;
}): Promise<Manifest> {
  const summary = parseBuildSummary(
    await readFile(join(options.imageDir, "pgcf-node.json"), "utf8"),
  );
  const version = FleetReleaseVersion.safeParse(summary.release);
  if (!version.success)
    throw new Error(
      `the release name "${summary.release}" is no version: lower-case letters, digits, ".", "_" and "-", at most 64 characters`,
    );
  const uploads: Upload[] = [];
  const add = async (file: ReleaseFile, path: string) => {
    let digest: FileDigest;
    try {
      digest = await digestFile(path);
    } catch {
      throw new Error(`${file} is missing at ${path}`);
    }
    if (digest.size_bytes === 0) throw new Error(`${file} is empty`);
    uploads.push({
      file,
      key: releaseObjectKey(version.data, file),
      path,
      digest,
    });
    return { sha256: digest.sha256, size_bytes: digest.size_bytes };
  };
  const image = await add(
    RELEASE_IMAGE_FILE,
    join(options.imageDir, RELEASE_IMAGE_FILE),
  );
  if (
    image.sha256 !== summary.zst.sha256 ||
    image.size_bytes !== summary.zst.size
  )
    throw new Error(
      "the compressed image is not the one the build summary describes",
    );
  const lockPath = options.lockPath ?? defaultLock;
  const lock = await add(RELEASE_LOCK_FILE, lockPath);
  if (lock.sha256 !== summary.lock_sha256)
    throw new Error("the package lock is not the one the image was built from");
  const lockFacts = await lockOs(await readFile(lockPath, "utf8"));
  const binaries = {} as Record<
    (typeof RELEASE_BINARY_FILES)[number],
    typeof image
  >;
  for (const file of RELEASE_BINARY_FILES) {
    binaries[file] = await add(file, join(options.binariesDir, file));
    if (
      binaries[file].sha256 !== summary.binaries[file].sha256 ||
      binaries[file].size_bytes !== summary.binaries[file].size
    )
      throw new Error(`${file} is not the one the image was built with`);
  }
  return {
    version: version.data,
    registration: FleetReleaseRegistration.parse({
      image: {
        ...image,
        raw_sha256: summary.raw.sha256,
        raw_bytes: summary.raw.size,
      },
      binaries,
      os: {
        debian_snapshot: summary.debian_snapshot,
        package_lock: lock,
        ...lockFacts,
      },
    }),
    uploads,
  };
}

// ---------- R2 over S3, signed with AWS Signature Version 4 ----------

export interface R2Credentials {
  endpoint: URL;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
/** The credentials of the bucket, from named variables; a missing one is named, never shown. */
export function r2Credentials(
  environment: Record<string, string | undefined>,
): R2Credentials {
  const names = [
    "PGCF_R2_ENDPOINT",
    "PGCF_R2_BUCKET",
    "PGCF_R2_ACCESS_KEY_ID",
    "PGCF_R2_SECRET_ACCESS_KEY",
  ] as const;
  const missing = names.filter((name) => !environment[name]);
  if (missing.length > 0) throw new Error(`set ${missing.join(", ")}`);
  // The key id is sent in a header; a malformed value is refused by name, because the runtime
  // would quote it whole in the error for an invalid header value.
  if (!/^[A-Za-z0-9_-]+$/.test(environment.PGCF_R2_ACCESS_KEY_ID!))
    throw new Error("PGCF_R2_ACCESS_KEY_ID is not an R2 access key id");
  const endpoint = new URL(environment.PGCF_R2_ENDPOINT!);
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/")
    throw new Error("PGCF_R2_ENDPOINT must be an https origin");
  return {
    endpoint,
    bucket: environment.PGCF_R2_BUCKET!,
    accessKeyId: environment.PGCF_R2_ACCESS_KEY_ID!,
    secretAccessKey: environment.PGCF_R2_SECRET_ACCESS_KEY!,
  };
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

/**
 * The headers that authorize one S3 request (Signature Version 4, header form). `headers` are the
 * request's other signed headers, in any case; the host, the date and the payload hash are added.
 * Object keys here use only letters, digits, ".", "_", "-" and "/", so the URL's path is already
 * the canonical URI.
 */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = amzDate.slice(0, 8),
    service = "s3";
  const signed: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers))
    signed[name.toLowerCase()] = value.trim();
  signed.host = input.url.host;
  signed["x-amz-content-sha256"] = input.payloadHash;
  signed["x-amz-date"] = amzDate;
  const names = Object.keys(signed).sort();
  const canonical = [
    input.method,
    input.url.pathname,
    [...input.url.searchParams]
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .sort()
      .join("&"),
    ...names.map((name) => `${name}:${signed[name]}`),
    "",
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const key = [day, input.region, service, "aws4_request"].reduce(
    (secret, part) => hmac(secret, part),
    Buffer.from(`AWS4${input.credentials.secretAccessKey}`),
  );
  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(";")}, ` +
      `Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`,
  };
}

type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const emptyPayload = createHash("sha256").update("").digest("hex");
const objectUrl = (credentials: R2Credentials, key: string) =>
  new URL(`/${credentials.bucket}/${key}`, credentials.endpoint);

/**
 * Whether the object is in the bucket already: `absent`; `same` when its size and md5 (the ETag of
 * a single-part upload) are the file's and R2 holds the file's sha256 for it, which is what the API
 * requires of every file; `unverified` when size and md5 match but R2 holds no sha256, because
 * another tool stored the object: it is sent again with the checksum, identical bytes. Another
 * content is an error, because a release is never overwritten.
 */
export async function existingObject(
  credentials: R2Credentials,
  upload: Upload,
  fetchImpl: Fetch = fetch,
): Promise<"absent" | "unverified" | "same"> {
  const url = objectUrl(credentials, upload.key),
    // R2 returns the stored checksum on HEAD only when asked.
    headers = { "x-amz-checksum-mode": "ENABLED" };
  const response = await fetchImpl(url, {
    method: "HEAD",
    headers: {
      ...headers,
      ...signV4({
        method: "HEAD",
        url,
        headers,
        payloadHash: emptyPayload,
        credentials,
        region: "auto",
        now: new Date(),
      }),
    },
  });
  if (response.status === 404) return "absent";
  if (response.status !== 200)
    throw new Error(`R2 answered ${response.status} for HEAD ${upload.key}`);
  const etag = response.headers.get("etag")?.replaceAll('"', "").toLowerCase(),
    checksum = response.headers.get("x-amz-checksum-sha256");
  if (
    response.headers.get("content-length") !==
      String(upload.digest.size_bytes) ||
    etag !== upload.digest.md5 ||
    (checksum !== null && checksum !== sha256Header(upload))
  )
    throw new Error(
      `${upload.key} is in the bucket with another content; a registered release is never overwritten, so build a new version`,
    );
  return checksum === null ? "unverified" : "same";
}

/** The file's sha256 as `x-amz-checksum-sha256` carries it. */
const sha256Header = (upload: Upload) =>
  Buffer.from(upload.digest.sha256, "hex").toString("base64");

/** One signed PUT of the file, streamed, with the sha256 for R2 to verify. */
export async function uploadObject(
  credentials: R2Credentials,
  upload: Upload,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const url = objectUrl(credentials, upload.key),
    headers = {
      "content-length": String(upload.digest.size_bytes),
      "x-amz-checksum-sha256": sha256Header(upload),
    };
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      ...headers,
      ...signV4({
        method: "PUT",
        url,
        headers,
        payloadHash: "UNSIGNED-PAYLOAD",
        credentials,
        region: "auto",
        now: new Date(),
      }),
    },
    body: Readable.toWeb(createReadStream(upload.path)) as ReadableStream,
    duplex: "half",
  } as RequestInit);
  // R2's error body can echo the request's canonical form; only the status is shown.
  if (!response.ok)
    throw new Error(`R2 answered ${response.status} for PUT ${upload.key}`);
}

// ---------- The management API ----------

const pin = ({ sha256, size_bytes }: FleetPinnedFile) => ({
  sha256,
  size_bytes,
});
/** The digests a stored release pins, in the shape of a registration. */
const registeredPins = (spec: FleetReleaseSpec): FleetReleaseRegistration => ({
  image: {
    ...pin(spec.image),
    raw_sha256: spec.image.raw_sha256,
    raw_bytes: spec.image.raw_bytes,
  },
  binaries: Object.fromEntries(
    RELEASE_BINARY_FILES.map((file) => [file, pin(spec.binaries[file])]),
  ) as FleetReleaseRegistration["binaries"],
  os: {
    debian_snapshot: spec.os.debian_snapshot,
    package_lock: pin(spec.os.package_lock),
    packages_sha256: spec.os.packages_sha256,
    kernel_release: spec.os.kernel_release,
  },
});

/**
 * Registers the manifest as the release `version`; the API checks the bucket before it records it.
 * Its answer is the whole stored release, which must be this version with the registered digests.
 */
export async function registerRelease(
  api: { apiUrl: string; apiKey: string },
  manifest: Manifest,
  fetchImpl: Fetch = fetch,
): Promise<FleetRelease> {
  const origin = new URL(api.apiUrl);
  if (origin.protocol !== "https:")
    throw new Error("PGCF_API_URL must be an https URL");
  const response = await fetchImpl(
    new URL(`/v1/fleet/releases/${manifest.version}`, origin),
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${api.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(manifest.registration),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (
      body as { error?: { code?: string; message?: string } } | null
    )?.error;
    throw new Error(
      `the API refused the release: ${response.status} ${error?.code ?? "error"}: ${error?.message ?? "no message"}`,
    );
  }
  const release = FleetRelease.parse(body);
  if (release.id !== manifest.version)
    throw new Error(
      `the API stored the release as "${release.id}", not "${manifest.version}"`,
    );
  if (!isDeepStrictEqual(registeredPins(release.spec), manifest.registration))
    throw new Error(
      "the API stored a release whose pins differ from the registered ones",
    );
  return release;
}

// ---------- The command ----------

/** The management API's origin and administrator key; a malformed key is refused by name, never quoted (it is a header value). */
export function apiCredentials(
  environment: Record<string, string | undefined>,
): { apiUrl: string; apiKey: string } {
  const missing = ["PGCF_API_URL", "PGCF_API_KEY"].filter(
    (name) => !environment[name],
  );
  if (missing.length > 0) throw new Error(`set ${missing.join(", ")}`);
  if (!API_KEY_PATTERN.test(environment.PGCF_API_KEY!))
    throw new Error("PGCF_API_KEY is not an API key");
  return {
    apiUrl: environment.PGCF_API_URL!,
    apiKey: environment.PGCF_API_KEY!,
  };
}

async function main(
  argv: string[],
  environment: Record<string, string | undefined>,
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "image-dir": { type: "string" },
      binaries: { type: "string" },
      lock: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values["image-dir"] || !values.binaries)
    throw new Error(
      "usage: register-node-image.ts --image-dir DIR --binaries DIR [--lock FILE] [--dry-run]",
    );
  // The credentials come first, so a missing one fails before gigabytes are read.
  const credentials = values["dry-run"]
    ? undefined
    : r2Credentials(environment);
  const api = values["dry-run"] ? undefined : apiCredentials(environment);
  const manifest = await releaseManifest({
    imageDir: resolve(values["image-dir"]),
    binariesDir: resolve(values.binaries),
    ...(values.lock ? { lockPath: resolve(values.lock) } : {}),
  });
  console.log(`release ${manifest.version}`);
  console.log(
    `  kernel ${manifest.registration.os.kernel_release}  packages sha256 ${manifest.registration.os.packages_sha256}`,
  );
  for (const { key, digest } of manifest.uploads)
    console.log(
      `  ${key}  ${digest.size_bytes} bytes  sha256 ${digest.sha256}`,
    );
  if (credentials === undefined || api === undefined) return;
  for (const upload of manifest.uploads) {
    const existing = await existingObject(credentials, upload);
    if (existing === "same") {
      console.log(`  ${upload.key} is in the bucket already`);
      continue;
    }
    await uploadObject(credentials, upload);
    console.log(
      `  uploaded ${upload.key}${existing === "unverified" ? " (R2 held no sha256 for it)" : ""}`,
    );
  }
  const release = await registerRelease(api, manifest);
  console.log(`registered ${release.id} (spec sha256 ${release.spec_sha256})`);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
