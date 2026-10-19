// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { NodeOs, NodeRelease } from "../src/node-link.ts";
import {
  FleetReleaseRegistration,
  FleetReleaseSpec,
  HOST_FILE_APPLIES,
  HOST_FILE_DIRECTORIES,
  HOST_FILES_MAX,
  HostFile,
  HostFiles,
  type ReleaseManifestFields,
  RELEASE_MANIFEST_DOMAIN,
  fleetReleaseSpec,
  hostFileFacts,
  hostFileLine,
  hostFileObjectKey,
  hostFilesSha256,
  releaseHostFileUrl,
  signedReleaseManifest as signed,
} from "../src/releases.ts";

interface Host {
  path: string;
  kind: string;
  mode?: string;
  sha256?: string;
  size_bytes?: number;
  apply: string;
}
/** The contract's text of a release whose values a test has bent out of its types. */
const signedReleaseManifest = (value: unknown): string =>
  signed(value as ReleaseManifestFields);
const unit: Host = {
  path: "/usr/lib/systemd/system/pgcf-gateway.service",
  kind: "file",
  mode: "0644",
  sha256: "1".repeat(64),
  size_bytes: 1200,
  apply: "restart_unit:pgcf-gateway.service",
};
const mask: Host = {
  path: "/etc/systemd/system/modprobe@loop.service",
  kind: "symlink-to-dev-null",
  apply: "daemon_reload",
};
const script: Host = {
  path: "/usr/lib/systemd/system/pgcf-pg@.service",
  kind: "file",
  mode: "0755",
  sha256: "2".repeat(64),
  size_bytes: 0,
  apply: "next_start",
};
// Ascending by path, as every list of a release is.
const list = (): Host[] => [
  structuredClone(mask),
  structuredClone(unit),
  structuredClone(script),
];

it("a host file is a file of a fixed mode or a mask, in an allow-listed directory, with a stated way to take effect", () => {
  expect(HostFiles.safeParse(list()).success).toBe(true);
  expect(HOST_FILE_DIRECTORIES).toEqual([
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
  ]);
  for (const directory of HOST_FILE_DIRECTORIES)
    expect(
      HostFile.safeParse({ ...unit, path: `${directory}/pgcf.conf` }).success,
      directory,
    ).toBe(true);
  expect(HOST_FILE_APPLIES).toEqual([
    "daemon_reload",
    "next_start",
    "sysusers",
    "tmpfiles",
    "restart_unit:pgcf-agent.service",
    "restart_unit:pgcf-cloudflared.service",
    "restart_unit:pgcf-gateway.service",
    "restart_unit:ssh.service",
    "restart_unit:systemd-journald.service",
    "restart_unit:systemd-sysctl.service",
  ]);
});

it("a path outside the allow-list, with traversal, hidden, nested or indirect, is not a host file", () => {
  const refused = [
    "/etc/passwd",
    "/etc/shadow",
    "/usr/bin/pgcf-agent",
    "/usr/libexec/pgcf/pgcf-archive",
    "/etc/systemd/system",
    "/etc/systemd/system/",
    "/etc/systemd/system/../../passwd",
    "/etc/systemd/system/..",
    "/etc/systemd/system/a/b.service",
    "/etc/systemd/system/x.service.d/override.conf",
    "/etc/systemd/system-generators/systemd-ssh-generator",
    "/etc/systemd/system/.hidden.service",
    "/etc/systemd/system/.pgcf-new",
    "/etc/systemd/system/a b.service",
    "/etc/systemd/system/a\nb.service",
    "/etc/systemd/system/a:b.service",
    "/etc/systemd/systemx/a.service",
    "/etc/ssh/sshd_config",
    "/etc/ssh/principals/root",
    "/etc/nftables.conf",
    "/var/lib/pgcf/bin/current",
    "etc/systemd/system/a.service",
    "//etc/systemd/system/a.service",
    "/etc/systemd/system//a.service",
    `/etc/systemd/system/${"a".repeat(129)}`,
    "",
  ];
  for (const path of refused)
    expect(HostFile.safeParse({ ...unit, path }).success, path).toBe(false);
  for (const path of refused)
    expect(HostFile.safeParse({ ...mask, path }).success, path).toBe(false);
});

it("a file has the mode 0644 or 0755, a digest and a size; a mask has none of these", () => {
  const broken: unknown[] = [
    { ...unit, mode: "0600" },
    { ...unit, mode: "0664" },
    { ...unit, mode: "0777" },
    { ...unit, mode: "4755" },
    { ...unit, mode: "644" },
    { ...unit, mode: 420 },
    { ...unit, mode: undefined },
    { ...unit, sha256: undefined },
    { ...unit, sha256: "A".repeat(64) },
    { ...unit, size_bytes: -1 },
    { ...unit, size_bytes: 1.5 },
    { ...unit, size_bytes: 1_048_577 },
    { ...unit, owner: "root" },
    { ...unit, url: "https://x.example/f" },
    { ...unit, kind: "symlink" },
    { ...unit, kind: "directory" },
    { ...unit, apply: "restart_unit:sshd.service" },
    { ...unit, apply: "restart_unit:postgresql.service" },
    { ...unit, apply: "restart_unit:" },
    { ...unit, apply: "restart" },
    { ...unit, apply: "reload" },
    { ...unit, apply: undefined },
    { ...mask, mode: "0644" },
    { ...mask, sha256: "1".repeat(64) },
    { ...mask, size_bytes: 9 },
    { ...mask, target: "/etc/passwd" },
  ];
  for (const value of broken)
    expect(HostFile.safeParse(value).success, JSON.stringify(value)).toBe(
      false,
    );
  expect(HostFile.safeParse({ ...unit, size_bytes: 1_048_576 }).success).toBe(
    true,
  );
});

it("a list is ascending by path with no path twice, has at least one file and at most the bound", () => {
  const [a, b, c] = list();
  expect(HostFiles.safeParse([a, b, c]).success).toBe(true);
  for (const unordered of [
    [b, a, c],
    [a, c, b],
    [c, b, a],
    [a, a, b],
    [a, b, b],
  ])
    expect(HostFiles.safeParse(unordered).success).toBe(false);
  expect(HostFiles.safeParse([]).success).toBe(false);
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...unit,
      path: `/etc/sysctl.d/${String(index).padStart(3, "0")}.conf`,
    }));
  expect(HostFiles.safeParse(many(HOST_FILES_MAX)).success).toBe(true);
  expect(HostFiles.safeParse(many(HOST_FILES_MAX + 1)).success).toBe(false);
});

it("the manifest of a release lists each host file after the lock, one line each, in path order", () => {
  expect(RELEASE_MANIFEST_DOMAIN).toBe("pgcf-release-manifest/v2\n");
  const text = signedReleaseManifest(release());
  const lines = text.split("\n");
  expect(lines[0]).toBe("pgcf-release-manifest/v2");
  expect(lines.slice(-5)).toEqual([
    `os.package_lock=${"5".repeat(64)}:90000`,
    "os.host_file=/etc/systemd/system/modprobe@loop.service symlink-to-dev-null - - daemon_reload",
    `os.host_file=/usr/lib/systemd/system/pgcf-gateway.service file 0644 ${"1".repeat(64)}:1200 restart_unit:pgcf-gateway.service`,
    `os.host_file=/usr/lib/systemd/system/pgcf-pg@.service file 0755 ${"2".repeat(64)}:0 next_start`,
    "",
  ]);
  expect(text.endsWith("\n")).toBe(true);
});

it("a signature covers every part of every host file and the list's length", () => {
  const signed = signedReleaseManifest(release());
  const changes: ((value: ReturnType<typeof release>) => void)[] = [
    (value) => (value.os.host_files[0]!.apply = "next_start"),
    (value) => (value.os.host_files[1]!.apply = "next_start"),
    (value) => (value.os.host_files[1]!.sha256 = "9".repeat(64)),
    (value) => (value.os.host_files[1]!.size_bytes! += 1),
    (value) => (value.os.host_files[2]!.mode = "0644"),
    (value) =>
      (value.os.host_files[2]!.path =
        "/usr/lib/systemd/system/pgcf-pq@.service"),
    (value) => value.os.host_files.pop(),
    (value) => value.os.host_files.shift(),
  ];
  for (const change of changes) {
    const other = release();
    change(other);
    expect(signedReleaseManifest(other)).not.toBe(signed);
  }
  // What a node is expected to report is derived from the list: it adds nothing to the text.
  const derived = release();
  derived.os.host_files_sha256 = "9".repeat(64);
  expect(signedReleaseManifest(derived)).toBe(signed);
});

it("a manifest is never built of a list that could read as another", () => {
  const broken: ((value: ReturnType<typeof release>) => void)[] = [
    (value) =>
      (value.os.host_files[1]!.path = "/etc/systemd/system/a\nos.host_file=x"),
    (value) => value.os.host_files.reverse(),
    (value) => (value.os.host_files.length = 0),
    (value) => (value.os.host_files[1]!.apply = "restart_unit:x.service"),
    (value) => (value.os.host_files[0] = { ...value.os.host_files[1]! }),
  ];
  for (const change of broken) {
    const other = release();
    change(other);
    expect(() => signedReleaseManifest(other)).toThrow();
  }
});

it("the digest a node reports is one fixed text of the facts, which leaves out how a file takes effect", async () => {
  expect(hostFileFacts(unit as HostFile)).toBe(
    `/usr/lib/systemd/system/pgcf-gateway.service file 0644 ${"1".repeat(64)}:1200`,
  );
  expect(hostFileFacts(mask as HostFile)).toBe(
    "/etc/systemd/system/modprobe@loop.service symlink-to-dev-null - -",
  );
  expect(hostFileLine(mask as HostFile)).toBe(
    `${hostFileFacts(mask as HostFile)} daemon_reload`,
  );
  const digest = await hostFilesSha256(list() as HostFile[]);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const text = (list() as HostFile[])
    .map((file) => `${hostFileFacts(file)}\n`)
    .join("");
  expect(digest).toBe(
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
  const other = list();
  other[0]!.apply = "next_start";
  expect(await hostFilesSha256(other as HostFile[])).toBe(digest);
  other[1] = { ...unit, size_bytes: 1201 };
  expect(await hostFilesSha256(other as HostFile[])).not.toBe(digest);
});

it("the files are stored by digest beside the release and served at one path, which the page does not carry", () => {
  expect(hostFileObjectKey("sha-0123456789ab", "1".repeat(64))).toBe(
    `node-images/sha-0123456789ab/host-files/${"1".repeat(64)}`,
  );
  expect(
    releaseHostFileUrl(
      "https://api.example.org/",
      "sha-0123456789ab",
      "1".repeat(64),
    ),
  ).toBe(
    `https://api.example.org/node/v1/releases/sha-0123456789ab/host-files/${"1".repeat(64)}`,
  );
  expect(() => hostFileObjectKey("v1", "../x")).toThrow();
  expect(() =>
    releaseHostFileUrl("https://api.example.org", "v1", "X".repeat(64)),
  ).toThrow();
});

it("a release registers its host files and the digest a node reports, and the spec and the page carry them", async () => {
  const registration = FleetReleaseRegistration.parse(registered());
  expect(registration.os.host_files_sha256).toBe(
    await hostFilesSha256(list() as HostFile[]),
  );
  const spec = fleetReleaseSpec("https://api.example.org", "v1", registration);
  expect(FleetReleaseSpec.parse(spec)).toEqual(spec);
  expect(spec.version).toBe(3);
  expect(spec.os.host_files).toEqual(list());
  expect(spec.os.host_files_sha256).toBe(registration.os.host_files_sha256);
  // The page names the files and not the digest of what a node reports, and no URL.
  const { packages_sha256, kernel_release, host_files_sha256, ...installed } =
    spec.os;
  void [packages_sha256, kernel_release, host_files_sha256];
  const page = { id: "v1", binaries: spec.binaries };
  expect(NodeRelease.safeParse({ ...page, os: installed }).success).toBe(true);
  expect(NodeRelease.safeParse({ ...page, os: spec.os }).success).toBe(false);
  expect(
    NodeRelease.safeParse({
      ...page,
      os: { ...installed, host_files: undefined },
    }).success,
  ).toBe(false);
  for (const change of [
    (value: ReturnType<typeof registered>) => ({
      ...value,
      os: { ...value.os, host_files: undefined },
    }),
    (value: ReturnType<typeof registered>) => ({
      ...value,
      os: { ...value.os, host_files: [] },
    }),
    (value: ReturnType<typeof registered>) => ({
      ...value,
      os: { ...value.os, host_files_sha256: undefined },
    }),
    (value: ReturnType<typeof registered>) => ({
      ...value,
      os: {
        ...value.os,
        host_files: [{ ...unit, url: "https://x.example/f" }],
      },
    }),
  ])
    expect(
      FleetReleaseRegistration.safeParse(change(registered())).success,
    ).toBe(false);
});

it("the page states the shape of the host files and no rule: what the contract may later allow never makes an older node refuse the whole page", () => {
  const spec = fleetReleaseSpec(
    "https://api.example.org",
    "v1",
    FleetReleaseRegistration.parse(registered()),
  );
  const { packages_sha256, kernel_release, host_files_sha256, ...installed } =
    spec.os;
  void [packages_sha256, kernel_release, host_files_sha256];
  const page = (host_files: unknown) => ({
    id: "v1",
    binaries: spec.binaries,
    os: { ...installed, host_files },
  });
  // A directory, a unit to restart, a way to take effect, a mode, a size, a digest and a count that
  // a later contract allows and this agent does not: the page still reads, and the agent's own
  // rules refuse the files (`hostfiles::check`) once the binaries are in place.
  const later: unknown[] = [
    { ...unit, path: "/etc/udev/rules.d/90-pgcf.rules" },
    { ...unit, apply: "restart_unit:new.service" },
    { ...unit, apply: "a_new_way_to_take_effect" },
    { ...unit, mode: "0600" },
    { ...unit, size_bytes: 5_000_000 },
    { ...unit, sha256: "a".repeat(128) },
    { ...mask, apply: "restart_unit:new.service" },
  ];
  for (const file of later) {
    expect(HostFiles.safeParse([file]).success, JSON.stringify(file)).toBe(
      false,
    );
    expect(
      NodeRelease.safeParse(page([file])).success,
      JSON.stringify(file),
    ).toBe(true);
  }
  expect(NodeRelease.safeParse(page([])).success).toBe(true);
  expect(
    NodeRelease.safeParse(
      page(
        Array.from({ length: 3 * HOST_FILES_MAX }, (_, index) => ({
          ...unit,
          path: `/etc/sysctl.d/${String(index).padStart(3, "0")}.conf`,
        })),
      ),
    ).success,
  ).toBe(true);
  // The shape is still checked: a kind the facts line has no form for, a field the manifest has no
  // place for, a missing or mistyped value, an unbounded text and an unbounded list.
  const broken: unknown[] = [
    { ...unit, kind: "directory" },
    { ...unit, owner: "root" },
    { ...mask, mode: "0644" },
    { ...unit, apply: undefined },
    { ...unit, apply: 7 },
    { ...unit, path: undefined },
    { ...unit, path: `/etc/sysctl.d/${"a".repeat(300)}` },
    { ...unit, apply: "a".repeat(300) },
    { ...unit, mode: undefined },
    { ...unit, size_bytes: -1 },
    { ...unit, size_bytes: "12" },
    "a path",
    null,
  ];
  for (const file of broken)
    expect(
      NodeRelease.safeParse(page([file])).success,
      JSON.stringify(file),
    ).toBe(false);
  expect(NodeRelease.safeParse(page(undefined)).success).toBe(false);
  expect(
    NodeRelease.safeParse(
      page(
        Array.from({ length: 100 * HOST_FILES_MAX }, (_, index) => ({
          ...unit,
          path: `/etc/sysctl.d/${index}.conf`,
        })),
      ),
    ).success,
  ).toBe(false);
});

it("the hello of a node reports the digest of the host files it holds", () => {
  const os = {
    boot_id: crypto.randomUUID(),
    booted_at: "2026-10-18T10:00:00.000Z",
    kernel_release: "6.12.113+deb13-amd64",
    packages_sha256: "6".repeat(64),
    host_files_sha256: "8".repeat(64),
  };
  expect(NodeOs.safeParse(os).success).toBe(true);
  expect(
    NodeOs.safeParse({ ...os, host_files_sha256: undefined }).success,
  ).toBe(false);
  expect(
    NodeOs.safeParse({ ...os, host_files_sha256: "8".repeat(63) }).success,
  ).toBe(false);
});

function registered() {
  return {
    image: {
      sha256: "a".repeat(64),
      size_bytes: 512_000_000,
      raw_sha256: "b".repeat(64),
      raw_bytes: 2_147_483_648,
    },
    binaries: {
      "pgcf-agent": { sha256: "1".repeat(64), size_bytes: 11_000_000 },
      "pgcf-native-gateway": { sha256: "2".repeat(64), size_bytes: 12_000_000 },
      "pgcf-archive": { sha256: "3".repeat(64), size_bytes: 5_000_000 },
      "pgcf-wal-fetch": { sha256: "4".repeat(64), size_bytes: 5_100_000 },
    },
    os: {
      debian_snapshot: "20261016T000000Z",
      package_lock: { sha256: "5".repeat(64), size_bytes: 90_000 },
      packages_sha256: "6".repeat(64),
      kernel_release: "6.12.113+deb13-amd64",
      host_files: list(),
      host_files_sha256: hostDigest,
    },
    signature: "7".repeat(128),
  };
}
function release() {
  const { signature: _signature, image: _image, ...rest } = registered();
  void [_signature, _image];
  return { id: "sha-0123456789ab", ...rest };
}
// The digest of `list()`, computed once for the fixtures above.
const hostDigest = await hostFilesSha256(list() as HostFile[]);
