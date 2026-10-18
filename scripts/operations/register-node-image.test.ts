// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FleetReleaseRegistration,
  fleetReleaseSpec,
} from "../../packages/contracts/src/releases.ts";
import {
  apiCredentials,
  digestFile,
  existingObject,
  lockOs,
  parseBuildSummary,
  r2Credentials,
  registerRelease,
  releaseManifest,
  signV4,
  uploadObject,
  type Manifest,
} from "./register-node-image.ts";

const sha = (text: string, algorithm = "sha256") =>
  createHash(algorithm).update(text).digest("hex");

const BINARIES = [
  "pgcf-agent",
  "pgcf-native-gateway",
  "pgcf-archive",
  "pgcf-wal-fetch",
];
const binaryBytes = (name: string) => `binary ${name}`;

// A package lock as the builder writes it: every package of the image, and the extra ones (which
// the image holds too, so they are listed twice).
const locked = (name: string, version: string) => ({
  name,
  version,
  architecture: "amd64",
  url: `https://snapshot.example/${name}_${version}.deb`,
  sha256: sha(name),
  size: 100,
});
const lockText = (packages: [string, string][], extra: [string, string][]) =>
  `${JSON.stringify({
    debian: { snapshot: "20261016T000000Z" },
    extra: extra.map(([name, version]) => locked(name, version)),
    packages: packages.map(([name, version]) => locked(name, version)),
  })}\n`;
const PACKAGES: [string, string][] = [
  ["linux-image-amd64", "6.12.113-1"],
  ["libc6", "2.41-1"],
  ["bash", "5.2"],
  ["linux-image-6.12.113+deb13-amd64", "6.12.113-1"],
  ["libc6-dev", "2.41-1"],
  ["cloudflared", "2026.10.0"],
];
const LOCK = lockText(PACKAGES, [["cloudflared", "2026.10.0"]]);
// What a node that runs that lock reports: the lines sorted as lines, so "libc6-dev=" is before
// "libc6=", and the extra package that is also locked once.
const LOCK_PACKAGES_SHA256 = sha(
  "bash=5.2\ncloudflared=2026.10.0\nlibc6-dev=2.41-1\nlibc6=2.41-1\n" +
    "linux-image-6.12.113+deb13-amd64=6.12.113-1\nlinux-image-amd64=6.12.113-1\n",
);

// What `node infra/node-image/node-image.ts build` writes beside the image.
function summary(release: string, files: { zst: string; lock: string }) {
  return {
    release,
    debian_snapshot: "20261016T000000Z",
    lock_sha256: sha(files.lock),
    raw: { sha256: sha("the raw disk"), size: 2 * 1024 ** 3 },
    zst: { sha256: sha(files.zst), size: Buffer.byteLength(files.zst) },
    binaries: Object.fromEntries(
      BINARIES.map((name) => [
        name,
        {
          sha256: sha(binaryBytes(name)),
          size: Buffer.byteLength(binaryBytes(name)),
        },
      ]),
    ),
  };
}

/** A build output directory, a binaries directory and the lock the image was built from. */
async function build(release = "sha-0123456789ab") {
  const root = await mkdtemp(join(tmpdir(), "pgcf-register-"));
  const [imageDir, binariesDir] = [join(root, "out"), join(root, "binaries")];
  await mkdir(imageDir);
  await mkdir(binariesDir);
  const files = { zst: "compressed image bytes", lock: LOCK };
  await writeFile(join(imageDir, "pgcf-node.raw.zst"), files.zst);
  await writeFile(
    join(imageDir, "pgcf-node.json"),
    JSON.stringify(summary(release, files)),
  );
  await writeFile(join(root, "packages.lock.json"), files.lock);
  for (const name of BINARIES)
    await writeFile(join(binariesDir, name), binaryBytes(name));
  return {
    root,
    options: {
      imageDir,
      binariesDir,
      lockPath: join(root, "packages.lock.json"),
    },
    files,
  };
}

test("a file's digest is its sha256, its md5 and its size, read as a stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-register-"));
  try {
    await writeFile(join(root, "abc"), "abc");
    assert.deepEqual(await digestFile(join(root, "abc")), {
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      md5: "900150983cd24fb0d6963f7d28e17f72",
      size_bytes: 3,
    });
    await assert.rejects(digestFile(join(root, "missing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the build's summary is read as the builder writes it and nothing else", () => {
  const good = summary("sha-0123456789ab", { zst: "z", lock: "l" });
  assert.deepEqual(parseBuildSummary(JSON.stringify(good)), good);
  for (const bad of [
    { ...good, release: undefined },
    { ...good, debian_snapshot: "latest" },
    { ...good, zst: { ...good.zst, sha256: "abc" } },
    { ...good, raw: { ...good.raw, size: 0 } },
    { ...good, lock_sha256: "x" },
    { ...good, binaries: undefined },
    { ...good, binaries: { ...good.binaries, "pgcf-agent": undefined } },
    {
      ...good,
      binaries: {
        ...good.binaries,
        "pgcf-wal-fetch": { sha256: "abc", size: 1 },
      },
    },
  ])
    assert.throws(() => parseBuildSummary(JSON.stringify(bad)), /summary/);
  assert.throws(() => parseBuildSummary("not json"), /summary/);
});

test("the manifest registers the digests of the files the build produced, under the name the image was built as", async () => {
  const b = await build();
  try {
    const manifest = await releaseManifest(b.options);
    assert.equal(manifest.version, "sha-0123456789ab");
    // Exactly what the API accepts: no URLs, no version, nothing the Worker names itself.
    const registration = FleetReleaseRegistration.parse(manifest.registration);
    assert.deepEqual(registration.image, {
      sha256: sha(b.files.zst),
      size_bytes: Buffer.byteLength(b.files.zst),
      raw_sha256: sha("the raw disk"),
      raw_bytes: 2 * 1024 ** 3,
    });
    assert.deepEqual(registration.binaries["pgcf-wal-fetch"], {
      sha256: sha("binary pgcf-wal-fetch"),
      size_bytes: Buffer.byteLength("binary pgcf-wal-fetch"),
    });
    assert.deepEqual(registration.os, {
      debian_snapshot: "20261016T000000Z",
      package_lock: {
        sha256: sha(b.files.lock),
        size_bytes: Buffer.byteLength(b.files.lock),
      },
      // What a node that runs the lock reports in its hello, from the lock the image was built from.
      packages_sha256: LOCK_PACKAGES_SHA256,
      kernel_release: "6.12.113+deb13-amd64",
    });
    // Six files go to the prefix the API reads them from.
    assert.deepEqual(
      manifest.uploads.map((upload) => upload.key).sort(),
      [
        "packages.lock.json",
        "pgcf-agent",
        "pgcf-archive",
        "pgcf-native-gateway",
        "pgcf-node.raw.zst",
        "pgcf-wal-fetch",
      ].map((file) => `node-images/sha-0123456789ab/${file}`),
    );
    assert.equal(
      manifest.uploads.find((upload) => upload.key.endsWith("pgcf-agent"))
        ?.digest.md5,
      sha("binary pgcf-agent", "md5"),
    );
  } finally {
    await rm(b.root, { recursive: true, force: true });
  }
});

test("a lock states the OS a node that runs it reports: the digest of its packages and its one kernel", async () => {
  assert.deepEqual(await lockOs(LOCK), {
    packages_sha256: LOCK_PACKAGES_SHA256,
    kernel_release: "6.12.113+deb13-amd64",
  });
  // The committed lock is read the way the build writes it.
  const committed = await readFile(
    new URL("../../infra/node-image/packages.lock.json", import.meta.url),
    "utf8",
  );
  const kernels = (
    JSON.parse(committed) as { packages: { name: string }[] }
  ).packages
    .map((entry) => entry.name)
    .filter((name) => /^linux-image-[0-9]/.test(name));
  assert.equal(kernels.length, 1);
  const os = await lockOs(committed);
  assert.equal(os.kernel_release, kernels[0]!.slice("linux-image-".length));
  assert.match(os.packages_sha256, /^[0-9a-f]{64}$/);
  const without = PACKAGES.filter(
    ([name]) => !name.startsWith("linux-image-6"),
  );
  for (const [text, problem] of [
    [lockText(without, []), /exactly one kernel/],
    [
      lockText(
        [...PACKAGES, ["linux-image-6.12.111+deb13-amd64", "6.12.111-1"]],
        [],
      ),
      /exactly one kernel/,
    ],
    [lockText(PACKAGES, [["bash", "5.3"]]), /bash is locked in two versions/],
    [JSON.stringify({ packages: [{ name: "bash" }], extra: [] }), /lock/],
    [JSON.stringify({ packages: [] }), /lock/],
    ["not json", /lock/],
  ] as const)
    await assert.rejects(lockOs(text), problem);
});

test("a release is refused when the files are not the ones the build summarized", async () => {
  const b = await build();
  try {
    // The compressed image is not the one the summary names.
    await writeFile(
      join(b.options.imageDir, "pgcf-node.raw.zst"),
      "another image",
    );
    await assert.rejects(releaseManifest(b.options), /compressed image/);
    await writeFile(join(b.options.imageDir, "pgcf-node.raw.zst"), b.files.zst);
    // The lock is not the one the image was built from.
    await writeFile(b.options.lockPath, '{"packages":["changed"]}\n');
    await assert.rejects(releaseManifest(b.options), /package lock/);
    await writeFile(b.options.lockPath, b.files.lock);
    // A binary is not the one the image was built with: the nodes installed from it would run
    // other code than the release pins.
    await writeFile(join(b.options.binariesDir, "pgcf-agent"), "rebuilt");
    await assert.rejects(
      releaseManifest(b.options),
      /pgcf-agent is not the one the image was built with/,
    );
    await writeFile(
      join(b.options.binariesDir, "pgcf-agent"),
      binaryBytes("pgcf-agent"),
    );
    // A binary is missing or empty.
    await rm(join(b.options.binariesDir, "pgcf-archive"));
    await assert.rejects(releaseManifest(b.options), /pgcf-archive/);
    await writeFile(join(b.options.binariesDir, "pgcf-archive"), "");
    await assert.rejects(releaseManifest(b.options), /pgcf-archive/);
  } finally {
    await rm(b.root, { recursive: true, force: true });
  }
});

test("a release name that is not a version is refused before anything is uploaded", async () => {
  for (const release of ["Release-1", "-x", "a".repeat(65), "has space"]) {
    const b = await build("sha-0123456789ab");
    try {
      const files = b.files;
      await writeFile(
        join(b.options.imageDir, "pgcf-node.json"),
        JSON.stringify(summary(release, files)),
      );
      await assert.rejects(releaseManifest(b.options), /release name/, release);
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  }
});

test("signing follows AWS Signature Version 4 (the documentation's GET Object example)", () => {
  const signed = signV4({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { range: "bytes=0-9" },
    payloadHash:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    region: "us-east-1",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(signed["x-amz-date"], "20130524T000000Z");
  assert.equal(
    signed.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("the R2 credentials are read from named variables and a missing one is named, never its value", () => {
  const environment = {
    PGCF_R2_ENDPOINT: "https://account.eu.r2.cloudflarestorage.com",
    PGCF_R2_BUCKET: "bucket",
    PGCF_R2_ACCESS_KEY_ID: "id-value",
    PGCF_R2_SECRET_ACCESS_KEY: "secret-value",
  };
  const read = r2Credentials(environment);
  assert.equal(
    read.endpoint.href,
    "https://account.eu.r2.cloudflarestorage.com/",
  );
  assert.deepEqual(
    { ...read, endpoint: undefined },
    {
      bucket: "bucket",
      accessKeyId: "id-value",
      secretAccessKey: "secret-value",
      endpoint: undefined,
    },
  );
  const { PGCF_R2_SECRET_ACCESS_KEY: _omitted, ...incomplete } = environment;
  void _omitted;
  assert.throws(
    () => r2Credentials(incomplete),
    (error: Error) => {
      assert.match(error.message, /PGCF_R2_SECRET_ACCESS_KEY/);
      assert.doesNotMatch(error.message, /id-value|secret-value/);
      return true;
    },
  );
  assert.throws(
    () =>
      r2Credentials({
        ...environment,
        PGCF_R2_ENDPOINT: "http://account.r2.example",
      }),
    /PGCF_R2_ENDPOINT/,
  );
});

test("a credential that reaches a request header is checked first: a malformed one is refused by name and never quoted", () => {
  const apiUrl = "https://api.example.org";
  const apiKey = `pgcf_sk_${"a".repeat(12)}_${"B".repeat(43)}`;
  assert.deepEqual(
    apiCredentials({ PGCF_API_URL: apiUrl, PGCF_API_KEY: apiKey }),
    { apiUrl, apiKey },
  );
  assert.throws(
    () => apiCredentials({ PGCF_API_URL: apiUrl }),
    /set PGCF_API_KEY/,
  );
  const refused = (error: Error) => {
    assert.doesNotMatch(error.message, /SECOND-LINE|pgcf_sk_|id-value/);
    return true;
  };
  assert.throws(
    () =>
      apiCredentials({
        PGCF_API_URL: apiUrl,
        PGCF_API_KEY: `${apiKey}\nSECOND-LINE`,
      }),
    (error: Error) => /PGCF_API_KEY/.test(error.message) && refused(error),
  );
  assert.throws(
    () =>
      r2Credentials({
        PGCF_R2_ENDPOINT: "https://account.eu.r2.cloudflarestorage.com",
        PGCF_R2_BUCKET: "bucket",
        PGCF_R2_ACCESS_KEY_ID: "id-value\nSECOND-LINE",
        PGCF_R2_SECRET_ACCESS_KEY: "secret-value",
      }),
    (error: Error) =>
      /PGCF_R2_ACCESS_KEY_ID/.test(error.message) && refused(error),
  );
});

// The bucket as the script sees it: S3 over HTTPS. A recording function stands in for the network.
const credentials = r2Credentials({
  PGCF_R2_ENDPOINT: "https://account.eu.r2.cloudflarestorage.com",
  PGCF_R2_BUCKET: "bucket",
  PGCF_R2_ACCESS_KEY_ID: "id-value",
  PGCF_R2_SECRET_ACCESS_KEY: "secret-value",
});
const upload = {
  key: "node-images/sha-0123456789ab/pgcf-agent",
  path: "/nonexistent",
  file: "pgcf-agent" as const,
  digest: { sha256: sha("x"), md5: sha("x", "md5"), size_bytes: 1 },
};

test("an object that is already in the bucket is left alone when R2 holds its sha256, sent again when it holds none, and refused when it differs", async () => {
  const checksum = Buffer.from(upload.digest.sha256, "hex").toString("base64");
  const answer =
    (status: number, headers: Record<string, string> = {}) =>
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, "HEAD");
      assert.equal(
        String(url),
        "https://account.eu.r2.cloudflarestorage.com/bucket/node-images/sha-0123456789ab/pgcf-agent",
      );
      const sent = new Headers(init?.headers);
      assert.match(
        sent.get("authorization") ?? "",
        /^AWS4-HMAC-SHA256 Credential=id-value\//,
      );
      // R2 reports the checksum only when asked, and the header is signed like any other.
      assert.equal(sent.get("x-amz-checksum-mode"), "ENABLED");
      assert.match(
        sent.get("authorization") ?? "",
        /SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date,/,
      );
      return new Response(null, { status, headers });
    };
  const stored = { "content-length": "1", etag: `"${upload.digest.md5}"` };
  assert.equal(
    await existingObject(credentials, upload, answer(404)),
    "absent",
  );
  assert.equal(
    await existingObject(
      credentials,
      upload,
      answer(200, { ...stored, "x-amz-checksum-sha256": checksum }),
    ),
    "same",
  );
  // The same bytes stored without the sha256 (another tool put them) would fail the registration,
  // so they are sent again with it: the content is identical, so the release stays immutable.
  assert.equal(
    await existingObject(credentials, upload, answer(200, stored)),
    "unverified",
  );
  await assert.rejects(
    existingObject(
      credentials,
      upload,
      answer(200, {
        ...stored,
        "x-amz-checksum-sha256": Buffer.from(sha("y"), "hex").toString(
          "base64",
        ),
      }),
    ),
    /another content/,
  );
  await assert.rejects(
    existingObject(
      credentials,
      upload,
      answer(200, { "content-length": "1", etag: '"0123"' }),
    ),
    /another content/,
  );
  await assert.rejects(
    existingObject(
      credentials,
      upload,
      answer(200, { "content-length": "2", etag: `"${upload.digest.md5}"` }),
    ),
    /another content/,
  );
  await assert.rejects(existingObject(credentials, upload, answer(403)), /403/);
});

test("an upload is one signed PUT of the file with the sha256 R2 verifies, and its credentials stay out of the error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-register-"));
  try {
    await writeFile(join(root, "pgcf-agent"), "x");
    const seen: { url: string; init: RequestInit }[] = [];
    await uploadObject(
      credentials,
      { ...upload, path: join(root, "pgcf-agent") },
      async (url, init) => {
        seen.push({ url: String(url), init: init! });
        // The body is consumed like a network would.
        const body = init!.body as AsyncIterable<Uint8Array> | undefined;
        const chunks: Buffer[] = [];
        if (body)
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString(), "x");
        return new Response(null, { status: 200 });
      },
    );
    assert.equal(seen.length, 1);
    const headers = new Headers(seen[0]!.init.headers);
    assert.equal(seen[0]!.init.method, "PUT");
    assert.equal(
      seen[0]!.url,
      "https://account.eu.r2.cloudflarestorage.com/bucket/node-images/sha-0123456789ab/pgcf-agent",
    );
    assert.equal(headers.get("x-amz-content-sha256"), "UNSIGNED-PAYLOAD");
    assert.equal(
      headers.get("x-amz-checksum-sha256"),
      Buffer.from(sha("x"), "hex").toString("base64"),
    );
    assert.equal(headers.get("content-length"), "1");
    assert.match(
      headers.get("authorization")!,
      /SignedHeaders=content-length;host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date,/,
    );
    await assert.rejects(
      uploadObject(
        credentials,
        { ...upload, path: join(root, "pgcf-agent") },
        async () =>
          new Response("SignatureDoesNotMatch secret-value", { status: 403 }),
      ),
      (error: Error) => {
        assert.match(error.message, /403/);
        assert.doesNotMatch(error.message, /secret-value|id-value/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// What `PUT /v1/fleet/releases/{version}` answers: the whole stored release, its spec named by the Worker.
const stored = (manifest: Manifest, id = manifest.version) => ({
  id,
  spec: fleetReleaseSpec(
    "https://api.example.org",
    manifest.version,
    manifest.registration,
  ),
  spec_sha256: "a".repeat(64),
  approved_at: "2026-10-16T12:00:00.000Z",
});

test("the registration is one admin PUT of the manifest to the version, and the answer's refusal is shown without the key", async () => {
  const b = await build();
  try {
    const manifest = await releaseManifest(b.options);
    const seen: { url: string; init: RequestInit }[] = [];
    const release = await registerRelease(
      { apiUrl: "https://api.example.org/", apiKey: "pgcf_sk_secret" },
      manifest,
      async (url, init) => {
        seen.push({ url: String(url), init: init! });
        return Response.json(stored(manifest));
      },
    );
    assert.equal(release.id, manifest.version);
    assert.equal(release.spec_sha256, "a".repeat(64));
    assert.equal(
      seen[0]!.url,
      "https://api.example.org/v1/fleet/releases/sha-0123456789ab",
    );
    assert.equal(seen[0]!.init.method, "PUT");
    assert.equal(
      new Headers(seen[0]!.init.headers).get("authorization"),
      "Bearer pgcf_sk_secret",
    );
    assert.deepEqual(
      JSON.parse(String(seen[0]!.init.body)),
      manifest.registration,
    );
    await assert.rejects(
      registerRelease(
        { apiUrl: "https://api.example.org", apiKey: "pgcf_sk_secret" },
        manifest,
        async () =>
          Response.json(
            {
              error: {
                code: "conflict",
                message:
                  "node-images/x/pgcf-agent is not in the archive bucket",
                request_id: "r",
              },
            },
            { status: 409 },
          ),
      ),
      (error: Error) => {
        assert.match(
          error.message,
          /409 conflict: node-images\/x\/pgcf-agent is not in the archive bucket/,
        );
        assert.doesNotMatch(error.message, /pgcf_sk_secret/);
        return true;
      },
    );
    // A stored release that is not the registered one is not a success, whatever the status says.
    const answer = (body: unknown) => async () => Response.json(body);
    const api = { apiUrl: "https://api.example.org", apiKey: "k" };
    await assert.rejects(
      registerRelease(api, manifest, answer(stored(manifest, "other"))),
      /stored the release as "other"/,
    );
    const changed = stored(manifest);
    changed.spec.binaries["pgcf-agent"].sha256 = sha("another agent");
    await assert.rejects(
      registerRelease(api, manifest, answer(changed)),
      /pins differ/,
    );
    await assert.rejects(
      registerRelease(api, manifest, answer({ id: manifest.version })),
      { name: "ZodError" },
    );
    await assert.rejects(
      registerRelease(
        { apiUrl: "http://api.example.org", apiKey: "k" },
        manifest,
        async () => new Response(),
      ),
      /https/,
    );
  } finally {
    await rm(b.root, { recursive: true, force: true });
  }
});
