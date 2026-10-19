// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { HttpsUrl } from "./api.ts";
import { bytesToHex } from "./encoding.ts";
import { NodeId, RegionId } from "./ids.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** An Ed25519 signature of a release manifest: 64 bytes as 128 lowercase hex digits. */
export const ReleaseSignature = z.string().regex(/^[0-9a-f]{128}$/);
export const FleetReleaseId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/);
/** The pattern carries the scheme into the JSON Schema, which drops the URL check. */
const Https = HttpsUrl.regex(/^https:\/\//);

export const IMAGE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** The version of a node image; the installer's seed binds an enrollment to it. */
export const ImageVersion = z.string().regex(IMAGE_VERSION_PATTERN);

/** A file the node downloads: where, its digest and its size. */
export const FleetPinnedFile = z.strictObject({
  url: Https,
  sha256: Sha256,
  size_bytes: Positive,
});
export type FleetPinnedFile = z.infer<typeof FleetPinnedFile>;
/**
 * The four binaries the agent downloads, each under its own file name, into the release's
 * directory `/var/lib/pgcf/bin/<id>/` (plan 9.3).
 */
export const FleetReleaseBinaries = z.strictObject({
  "pgcf-agent": FleetPinnedFile,
  "pgcf-native-gateway": FleetPinnedFile,
  "pgcf-archive": FleetPinnedFile,
  "pgcf-wal-fetch": FleetPinnedFile,
});
/** The kernel a node runs, as `uname -r` says it, and as the lock's `linux-image-<abi>` package is named. */
export const KernelRelease = z.string().regex(/^[!-~]{1,64}$/);

/** The operating system of the image; a maintenance cycle installs exactly this lock. */
export const FleetReleaseOs = z.strictObject({
  image_version: ImageVersion,
  debian_snapshot: z.string().regex(/^[0-9]{8}T[0-9]{6}Z$/),
  /** Every package with its version and sha256. */
  package_lock: FleetPinnedFile,
  /**
   * What a node that runs the lock reports in its hello (`packagesSha256` of the lock's packages,
   * `packages` and `extra` together, and the kernel they hold), which the API compares to say
   * whether the node's OS is the release's.
   */
  packages_sha256: Sha256,
  kernel_release: KernelRelease,
});

/**
 * The digest of a set of packages, as a node and a lock both state it: sha256 over the lines
 * `name=version\n`, sorted as whole lines, bytewise, of every package dpkg reports as installed
 * (`ii`). Package names and versions are ASCII, so the sort of the strings is the sort of their
 * bytes. A node leaves out the kernel images it does not run, because Debian keeps the previous
 * kernel after an update and the lock holds the one it installs.
 */
export async function packagesSha256(
  packages: Iterable<{ name: string; version: string }>,
): Promise<string> {
  const lines = [...packages].map(({ name, version }) => {
    const line = `${name}=${version}\n`;
    if (!/^[!-~]+\n$/.test(line))
      throw new Error("A package name and version are printable ASCII");
    return line;
  });
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(lines.sort().join("")),
      ),
    ),
  );
}

/** The disk a new node is installed from (plan 9.2); the pull installer downloads it, compressed. */
export const FleetNodeImage = z.strictObject({
  url: HttpsUrl.refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }),
  sha256: Sha256,
  format: z.literal("raw.zst"),
  size_bytes: Positive,
  raw_sha256: Sha256,
  raw_bytes: Positive.refine((value) => value % 512 === 0),
});
export type FleetNodeImage = z.infer<typeof FleetNodeImage>;

/**
 * One release is one node image with its binaries: every node of every region runs the same one
 * (plan 9.6), and the package lock changes only in a maintenance cycle. The page's `NodeRelease`
 * is the release id with `binaries` and `os`; `image` serves AddNode and no node.
 */
export const FleetReleaseSpec = z.strictObject({
  version: z.literal(2),
  image: FleetNodeImage,
  binaries: FleetReleaseBinaries,
  os: FleetReleaseOs,
  /**
   * The release key's signature of the release's manifest (`signedReleaseManifest`), made in CI.
   * The API stores it and cannot check it: a node does, with the key compiled into its agent,
   * before it installs anything of the release. It is not on the node's page; a node reads it at
   * `RELEASE_SIGNATURE_FILE` beside the binaries.
   */
  signature: ReleaseSignature,
});
export type FleetReleaseSpec = z.infer<typeof FleetReleaseSpec>;

/**
 * The files of a release (plan 9.1, 9.2). They are objects under `node-images/<version>/` in the
 * archive bucket, and the Worker serves them at `/node/v1/releases/<version>/<file>`: the image
 * to the installer with its install token, the rest to the agents. The version is the release id,
 * the image version a node enrolls as and the name of the binaries' directory.
 */
export const RELEASE_IMAGE_FILE = "pgcf-node.raw.zst";
export const RELEASE_LOCK_FILE = "packages.lock.json";
export const RELEASE_BINARY_FILES = [
  "pgcf-agent",
  "pgcf-native-gateway",
  "pgcf-archive",
  "pgcf-wal-fetch",
] as const;
export const RELEASE_FILES = [
  RELEASE_IMAGE_FILE,
  RELEASE_LOCK_FILE,
  ...RELEASE_BINARY_FILES,
] as const;
export type ReleaseFile = (typeof RELEASE_FILES)[number];
export const ReleaseFileName = z.enum(RELEASE_FILES);
export const RELEASE_FILE_PATH = "/node/v1/releases";
export const RELEASE_OBJECT_PREFIX = "node-images";
export const releaseObjectKey = (version: string, file: ReleaseFile): string =>
  `${RELEASE_OBJECT_PREFIX}/${version}/${file}`;
export const releaseFileUrl = (
  origin: string,
  version: string,
  file: ReleaseFile | typeof RELEASE_SIGNATURE_FILE,
): string => `${apiOrigin(origin)}${RELEASE_FILE_PATH}/${version}/${file}`;
function apiOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("The API origin is an https origin and nothing else");
  return url.origin;
}

/**
 * The first line of every signed manifest. It names what is signed and its format, so that a
 * signature made for any other purpose, or for another version of this format, never verifies as
 * a release's.
 */
export const RELEASE_MANIFEST_DOMAIN = "pgcf-release-manifest/v1\n";
/**
 * The file name under which the API answers with a release's signature, beside the binaries. It
 * is no uploaded file (`RELEASE_FILES`): the API serves the signature of the stored spec.
 */
export const RELEASE_SIGNATURE_FILE = "release.sig";
/**
 * Why a node refuses to install a release, as its `release_refused` event names the class: no
 * signature was served for it, or the one served is not the release key's signature of the
 * release's manifest.
 */
export const RELEASE_REFUSALS = [
  "release_signature_missing",
  "release_signature_invalid",
] as const;

const SignedDigest = z.object({ sha256: Sha256, size_bytes: Positive });
const SignedRelease = z.object({
  id: FleetReleaseId,
  binaries: z.object(
    Object.fromEntries(
      RELEASE_BINARY_FILES.map((file) => [file, SignedDigest]),
    ) as Record<(typeof RELEASE_BINARY_FILES)[number], typeof SignedDigest>,
  ),
  os: z.object({
    debian_snapshot: z.string().regex(/^[0-9]{8}T[0-9]{6}Z$/),
    package_lock: SignedDigest,
  }),
});
/**
 * What the release key signs for a release (plan 9.3): the domain line and then one `name=value`
 * line each, in this order and no other, every line ended by a line feed: the release id; the
 * sha256 and size of each of the four binaries a node runs; the Debian snapshot its packages come
 * from; the sha256 and size of the package lock, which in turn pins every package and every
 * download (cloudflared) a maintenance cycle installs. A digest is `<sha256>:<size>`. The image
 * is the installer's and not the agent's, and the kernel and the package digest a node reports
 * are derived from the lock, so they are not in it. Every value is checked against its pattern,
 * which holds no line feed: no two releases have the same manifest. The page of a node carries
 * every fact in it (`NodeRelease`), which is how the agent builds the same text.
 */
export function signedReleaseManifest(
  release: z.input<typeof SignedRelease>,
): string {
  const { id, binaries, os } = SignedRelease.parse(release);
  const pin = ({ sha256, size_bytes }: z.infer<typeof SignedDigest>) =>
    `${sha256}:${size_bytes}`;
  return [
    RELEASE_MANIFEST_DOMAIN.slice(0, -1),
    `release=${id}`,
    ...RELEASE_BINARY_FILES.map(
      (file) => `binary.${file}=${pin(binaries[file])}`,
    ),
    `os.debian_snapshot=${os.debian_snapshot}`,
    `os.package_lock=${pin(os.package_lock)}`,
    "",
  ].join("\n");
}

const Digest = z.strictObject({ sha256: Sha256, size_bytes: Positive });
/**
 * What the operator registers for a version (`PUT /v1/fleet/releases/{version}`): the digest and
 * size of each file the build produced. The Worker names the URLs itself, so the spec every node
 * receives points at its own delivery route and nowhere else.
 */
export const FleetReleaseRegistration = z.strictObject({
  image: Digest.safeExtend({
    raw_sha256: Sha256,
    raw_bytes: Positive.refine((value) => value % 512 === 0),
  }),
  binaries: z.strictObject({
    "pgcf-agent": Digest,
    "pgcf-native-gateway": Digest,
    "pgcf-archive": Digest,
    "pgcf-wal-fetch": Digest,
  }),
  os: z.strictObject({
    debian_snapshot: FleetReleaseOs.shape.debian_snapshot,
    package_lock: Digest,
    packages_sha256: FleetReleaseOs.shape.packages_sha256,
    kernel_release: FleetReleaseOs.shape.kernel_release,
  }),
  signature: ReleaseSignature,
});
export type FleetReleaseRegistration = z.infer<typeof FleetReleaseRegistration>;
/** The version of a registered release: a release id that is also a valid image version. */
export const FleetReleaseVersion = FleetReleaseId.max(64);

/** The release spec of a registration: every file served by `origin`'s delivery route. */
export function fleetReleaseSpec(
  origin: string,
  version: string,
  registration: FleetReleaseRegistration,
): FleetReleaseSpec {
  const url = (file: ReleaseFile) => releaseFileUrl(origin, version, file);
  const pinned = (file: ReleaseFile, digest: z.infer<typeof Digest>) => ({
    url: url(file),
    ...digest,
  });
  return FleetReleaseSpec.parse({
    version: 2,
    image: {
      ...pinned(RELEASE_IMAGE_FILE, registration.image),
      format: "raw.zst",
      raw_sha256: registration.image.raw_sha256,
      raw_bytes: registration.image.raw_bytes,
    },
    binaries: Object.fromEntries(
      RELEASE_BINARY_FILES.map((file) => [
        file,
        pinned(file, registration.binaries[file]),
      ]),
    ),
    os: {
      image_version: version,
      debian_snapshot: registration.os.debian_snapshot,
      package_lock: pinned(RELEASE_LOCK_FILE, registration.os.package_lock),
      packages_sha256: registration.os.packages_sha256,
      kernel_release: registration.os.kernel_release,
    },
    signature: registration.signature,
  });
}

export const FleetRelease = z.strictObject({
  id: FleetReleaseId,
  spec: FleetReleaseSpec,
  spec_sha256: Sha256,
  approved_at: z.iso.datetime(),
});
export type FleetRelease = z.infer<typeof FleetRelease>;
export const FleetRegionReleaseUpdate = z.strictObject({
  expected_revision: z.number().int().min(0).max(2147483646),
  release_id: FleetReleaseId,
});
export type FleetRegionReleaseUpdate = z.infer<typeof FleetRegionReleaseUpdate>;
export const FleetRegionReleaseStatus = z.strictObject({
  region_id: RegionId,
  revision: z.number().int().min(0),
  desired_release_id: FleetReleaseId.nullable(),
  updated_at: z.iso.datetime().nullable(),
});
/**
 * Where a node stands against its region's release: `converged` when its last hello named the
 * release and its link is fresh, `stale` when the link has been silent too long, `pending` when
 * it has not yet reported the release, `fenced` when it was declared lost. It speaks of the
 * binaries; the operating system is told apart, by `os_converged` of the node inventory.
 */
export const FleetNodeReleaseStatus = z.strictObject({
  node_id: NodeId,
  region_id: RegionId,
  node_uid: z.uuid().nullable(),
  desired_release_id: FleetReleaseId.nullable(),
  desired_spec_sha256: Sha256.nullable(),
  observed_release_id: FleetReleaseId.nullable(),
  observed_at: z.iso.datetime().nullable(),
  state: z.enum(["unassigned", "pending", "stale", "fenced", "converged"]),
});
export type FleetNodeReleaseStatus = z.infer<typeof FleetNodeReleaseStatus>;
