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

/**
 * The host files of a release (plan 9.3): the files of the image that matter at run time and that
 * a release changes without a new image: systemd units and their masks, and the configuration of
 * sshd, journald, sysctl, tmpfiles, sysusers and modprobe. The agent writes a file only in one of
 * these directories, directly in it (no subdirectory, no `..`, no file whose name starts with a
 * dot): the image has the vendor form (`/usr/lib/...`) of four of them and the `/etc` form is
 * where an administrator's file would go.
 */
export const HOST_FILE_DIRECTORIES = [
  "/etc/modprobe.d",
  "/etc/ssh/sshd_config.d",
  "/etc/sysctl.d",
  "/etc/sysusers.d",
  "/etc/systemd/journald.conf.d",
  "/etc/systemd/system",
  "/etc/tmpfiles.d",
  "/usr/lib/sysctl.d",
  "/usr/lib/sysusers.d",
  "/usr/lib/systemd/journald.conf.d",
  "/usr/lib/systemd/system",
  "/usr/lib/tmpfiles.d",
] as const;
/** A file with its bytes, or a symbolic link to `/dev/null` (a unit's mask). Nothing else. */
export const HOST_FILE_KINDS = ["file", "symlink-to-dev-null"] as const;
/** The only modes of a file, owned by root. */
export const HOST_FILE_MODES = ["0644", "0755"] as const;
/** The units a release may restart; the agent's own is restarted last. */
export const HOST_FILE_UNITS = [
  "pgcf-agent.service",
  "pgcf-cloudflared.service",
  "pgcf-gateway.service",
  "ssh.service",
  "systemd-journald.service",
  "systemd-sysctl.service",
] as const;
/**
 * How a file takes effect once it is written and systemd has read its units again: `daemon_reload`
 * alone is enough; `restart_unit:<unit>` restarts a running unit; `next_start` is for a unit that
 * runs per database and is never restarted for a file: it takes the new file when it next starts
 * (its stop settings already at its next stop); `sysusers` runs
 * `systemd-sysusers <file>` and `tmpfiles` runs `systemd-tmpfiles --create <file>`, once the
 * reload is done and before any restart. Both are idempotent, as the postinst of a package runs
 * them, and neither waits for a boot: systemd-sysusers.service runs at a boot only when /usr is
 * newer than /etc/.updated, which a file in /usr/lib/sysusers.d does not make it.
 */
export const HOST_FILE_APPLIES = [
  "daemon_reload",
  "next_start",
  "sysusers",
  "tmpfiles",
  ...HOST_FILE_UNITS.map((unit) => `restart_unit:${unit}` as const),
] as const;
/** What a release may carry. */
export const HOST_FILES_MAX = 64;
export const HOST_FILE_MAX_BYTES = 1_048_576;
/**
 * The most a node's page may list. It bounds the page and is no rule: the rule is `HOST_FILES_MAX`,
 * which the agent holds the signed list to (`host_files_invalid`), so that a later release may
 * raise it without an older agent refusing every page.
 */
export const HOST_FILES_PAGE_MAX = 1024;
/** The directory beside a release's files that holds its host files, each named by its sha256. */
export const RELEASE_HOST_FILES_DIRECTORY = "host-files";

const HostFilePath = z
  .string()
  .regex(
    new RegExp(
      `^(?:${HOST_FILE_DIRECTORIES.map((directory) => directory.replaceAll(".", "\\.")).join("|")})/[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$`,
    ),
  );
const HostFileApply = z.enum(HOST_FILE_APPLIES);
export const HostFile = z.discriminatedUnion("kind", [
  z.strictObject({
    path: HostFilePath,
    kind: z.literal("file"),
    mode: z.enum(HOST_FILE_MODES),
    sha256: Sha256,
    size_bytes: z.number().int().min(0).max(HOST_FILE_MAX_BYTES),
    apply: HostFileApply,
  }),
  z.strictObject({
    path: HostFilePath,
    kind: z.literal("symlink-to-dev-null"),
    apply: HostFileApply,
  }),
]);
export type HostFile = z.infer<typeof HostFile>;
/** Ascending by path, so that no path is named twice and the list has one order. */
export const HostFiles = z
  .array(HostFile)
  .min(1)
  .max(HOST_FILES_MAX)
  .refine(
    (files) =>
      files.every((file, at) => at === 0 || files[at - 1]!.path < file.path),
    { message: "host files are listed ascending by path, each path once" },
  );
export type HostFiles = z.infer<typeof HostFiles>;

/**
 * A host file as a node's page states it: the shape and no rule. The page is what every agent
 * reads, whichever build it is, and a rule of this contract that a later release widens (a
 * directory, a unit to restart, a way to take effect, a mode, a size, the count) must not make an
 * older agent refuse the whole page, because no order, no database change, no binary and no
 * maintenance would then reach the node until it is reinstalled. The release key signs the list as
 * it is, and the agent holds it to its own rules (`hostfiles::check`) just before it writes,
 * refusing the files with the classes of `RELEASE_REFUSALS` while still installing the binaries,
 * which may carry the agent that knows the new rule. Only the kinds are fixed: the facts line of a
 * kind is a format, and a new kind changes the signed text.
 */
const PageText = (max: number) => z.string().min(1).max(max);
export const NodeHostFile = z.discriminatedUnion("kind", [
  z.strictObject({
    path: PageText(256),
    kind: z.literal("file"),
    mode: PageText(8),
    sha256: PageText(128),
    size_bytes: z.number().int().min(0),
    apply: PageText(128),
  }),
  z.strictObject({
    path: PageText(256),
    kind: z.literal("symlink-to-dev-null"),
    apply: PageText(128),
  }),
]);
export const NodeHostFiles = z.array(NodeHostFile).max(HOST_FILES_PAGE_MAX);

/**
 * What a node can tell of a host file by looking at it: the path, the kind, the mode and the
 * digest and size of its bytes (`-` for a mask, which has none). How it takes effect is not a fact
 * of the file.
 */
export function hostFileFacts(file: HostFile): string {
  return file.kind === "file"
    ? `${file.path} ${file.kind} ${file.mode} ${file.sha256}:${file.size_bytes}`
    : `${file.path} ${file.kind} - -`;
}
/** The line of the signed manifest for a host file: the facts and how it takes effect. */
export const hostFileLine = (file: HostFile): string =>
  `${hostFileFacts(file)} ${file.apply}`;
/**
 * What a node that holds a release's host files reports in its hello: sha256 over the facts of
 * each file, one line each ended by a line feed, in the list's order. A node that holds anything
 * else, or on which systemd has still to be told of a file (a reload, a run, a restart), reports
 * another digest.
 */
export async function hostFilesSha256(
  files: readonly HostFile[],
): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          HostFiles.parse(files)
            .map((file) => `${hostFileFacts(file)}\n`)
            .join(""),
        ),
      ),
    ),
  );
}

/** The operating system of the image; a maintenance cycle installs exactly this lock. */
export const FleetReleaseOs = z.strictObject({
  image_version: ImageVersion,
  debian_snapshot: z.string().regex(/^[0-9]{8}T[0-9]{6}Z$/),
  /** Every package with its version and sha256. */
  package_lock: FleetPinnedFile,
  /** The files of the image that a release changes in place, with how each takes effect. */
  host_files: HostFiles,
  /**
   * What a node that runs the lock reports in its hello (`packagesSha256` of the lock's packages,
   * `packages` and `extra` together, and the kernel they hold, and `hostFilesSha256` of the host
   * files), which the API compares to say whether the node's OS is the release's.
   */
  packages_sha256: Sha256,
  kernel_release: KernelRelease,
  host_files_sha256: Sha256,
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
  version: z.literal(3),
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
/** A host file is an object named by its digest: the page names no URL and the path is never one. */
export const hostFileObjectKey = (version: string, sha256: string): string =>
  `${RELEASE_OBJECT_PREFIX}/${version}/${RELEASE_HOST_FILES_DIRECTORY}/${Sha256.parse(sha256)}`;
export const releaseHostFileUrl = (
  origin: string,
  version: string,
  sha256: string,
): string =>
  `${apiOrigin(origin)}${RELEASE_FILE_PATH}/${version}/${RELEASE_HOST_FILES_DIRECTORY}/${Sha256.parse(sha256)}`;
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
export const RELEASE_MANIFEST_DOMAIN = "pgcf-release-manifest/v2\n";
/**
 * The file name under which the API answers with a release's signature, beside the binaries. It
 * is no uploaded file (`RELEASE_FILES`): the API serves the signature of the stored spec.
 */
export const RELEASE_SIGNATURE_FILE = "release.sig";
/**
 * Why a node refuses to install a release, as its `release_refused` event names the class: no
 * signature was served for it, the one served is not the release key's signature of the release's
 * manifest, or the signed host files break the agent's own rules: a directory or name that is not
 * allowed (`host_file_path_refused`), a mode (`host_file_mode_refused`), a way to take effect that
 * it does not know (`host_file_apply_refused`), or the list or one of its entries is malformed
 * (`host_files_invalid`: empty, longer than the bound, not ascending by path, a path twice, a
 * digest or size that is none, a mask that states facts of a file). The agent refuses these
 * although the contract does not let them be registered: a release is read from a page, and the
 * agent is the last check before a root write.
 */
export const RELEASE_REFUSALS = [
  "release_signature_missing",
  "release_signature_invalid",
  "host_file_path_refused",
  "host_file_mode_refused",
  "host_file_apply_refused",
  "host_files_invalid",
] as const;

const SignedDigest = z.strictObject({ sha256: Sha256, size_bytes: Positive });
/**
 * The facts a release's manifest is made of, and no key beyond them at any level: what a client
 * asks the signer (`RELEASE_SIGN_PATH`) to sign and what the signer accepts. Every value is
 * checked against its pattern, none of which holds a line feed.
 */
export const ReleaseManifestFields = z.strictObject({
  id: FleetReleaseId,
  binaries: z.strictObject(
    Object.fromEntries(
      RELEASE_BINARY_FILES.map((file) => [file, SignedDigest]),
    ) as Record<(typeof RELEASE_BINARY_FILES)[number], typeof SignedDigest>,
  ),
  os: z.strictObject({
    debian_snapshot: z.string().regex(/^[0-9]{8}T[0-9]{6}Z$/),
    package_lock: SignedDigest,
    host_files: HostFiles,
  }),
});
export type ReleaseManifestFields = z.infer<typeof ReleaseManifestFields>;

/**
 * The manifest's facts of anything that carries them: a registration with its id, or the release
 * of a node's page (which also holds URLs). Whatever else the value holds is left out, and a
 * fact that is missing or malformed is refused.
 */
export function releaseManifestFields(
  release: ReleaseManifestFields,
): ReleaseManifestFields {
  const pin = (digest: { sha256: string; size_bytes: number } | undefined) => ({
    sha256: digest?.sha256,
    size_bytes: digest?.size_bytes,
  });
  return ReleaseManifestFields.parse({
    id: release.id,
    binaries: Object.fromEntries(
      RELEASE_BINARY_FILES.map((file) => [file, pin(release.binaries?.[file])]),
    ),
    os: {
      debian_snapshot: release.os?.debian_snapshot,
      package_lock: pin(release.os?.package_lock),
      host_files: release.os?.host_files,
    },
  });
}

/**
 * What the release key signs for a release (plan 9.3): the domain line and then one `name=value`
 * line each, in this order and no other, every line ended by a line feed: the release id; the
 * sha256 and size of each of the four binaries a node runs; the Debian snapshot its packages come
 * from; the sha256 and size of the package lock, which in turn pins every package and every
 * download (cloudflared) a maintenance cycle installs; and one line for each host file, in path
 * order: `os.host_file=<path> <kind> <mode> <digest> <apply>`, with `-` for the mode and digest of
 * a mask. A digest is `<sha256>:<size>`. The image is the installer's and not the agent's, and the
 * kernel and the digests of packages and host files a node reports are derived from the lock and
 * the list, so they are not in it. Every value is checked against its pattern, which holds no
 * line feed or space: no two releases have the same manifest. The page of a node carries every
 * fact in it (`NodeRelease`), which is how the agent builds the same text.
 */
export function signedReleaseManifest(release: ReleaseManifestFields): string {
  const { id, binaries, os } = releaseManifestFields(release);
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
    ...os.host_files.map((file) => `os.host_file=${hostFileLine(file)}`),
    "",
  ].join("\n");
}

/**
 * The route of the signer (`apps/release-signer`) that CI posts `ReleaseManifestFields` to, with
 * a GitHub Actions identity token as its bearer credential. It answers with the signature of the
 * release's manifest as `ReleaseSignature` text and a line feed.
 */
export const RELEASE_SIGN_PATH = "/sign";
/** The Worker secret of the signer that holds the release key: an Ed25519 private key, PKCS#8 in base64. */
export const RELEASE_SIGNING_SECRET = "RELEASE_SIGNING_KEY";

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
    host_files: HostFiles,
    host_files_sha256: FleetReleaseOs.shape.host_files_sha256,
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
    version: 3,
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
      host_files: registration.os.host_files,
      host_files_sha256: registration.os.host_files_sha256,
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
 * binaries; the operating system, which is the kernel, the packages and the host files, is told
 * apart, by `os_converged` of the node inventory: the maintenance cycle that brings the packages
 * needs a node that runs the release's binaries, so the two cannot be one state.
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
