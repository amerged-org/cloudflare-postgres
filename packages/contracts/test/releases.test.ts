// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { NodeRelease } from "../src/node-link.ts";
import {
  FleetNodeReleaseStatus,
  FleetRelease,
  FleetReleaseRegistration,
  FleetReleaseSpec,
  RELEASE_FILES,
  fleetReleaseSpec,
  packagesSha256,
  releaseFileUrl,
  releaseObjectKey,
} from "../src/releases.ts";

const pinned = (name: string, size = 4096) => ({
  url: `https://releases.example/${name}`,
  sha256: name.length.toString(16).padStart(2, "0").repeat(32),
  size_bytes: size,
});
function spec() {
  return {
    version: 2,
    image: {
      url: "https://releases.example/pgcf-node-1.2.0.raw.zst",
      sha256: "a".repeat(64),
      format: "raw.zst",
      size_bytes: 1_500_000_000,
      raw_sha256: "b".repeat(64),
      raw_bytes: 8_589_934_592,
    },
    binaries: {
      "pgcf-agent": pinned("pgcf-agent"),
      "pgcf-native-gateway": pinned("pgcf-native-gateway"),
      "pgcf-archive": pinned("pgcf-archive"),
      "pgcf-wal-fetch": pinned("pgcf-wal-fetch"),
    },
    os: {
      image_version: "1.2.0",
      debian_snapshot: "20261015T000000Z",
      package_lock: pinned("packages.lock.json"),
      packages_sha256: "d".repeat(64),
      kernel_release: "6.12.113+deb13-amd64",
    },
    signature: "5".repeat(128),
  };
}

it("one release is one node image, four binaries and the package lock, nothing else", () => {
  expect(FleetReleaseSpec.safeParse(spec()).success).toBe(true);
  for (const change of [
    (value: ReturnType<typeof spec>) => ({ ...value, version: 1 }),
    (value: ReturnType<typeof spec>) => ({ ...value, roles: {} }),
    (value: ReturnType<typeof spec>) => ({ ...value, components: [] }),
    (value: ReturnType<typeof spec>) => ({ ...value, route_token_version: 6 }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      binaries: { ...value.binaries, "pgcf-agent": undefined },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      binaries: { ...value.binaries, extra: pinned("extra") },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      os: { ...value.os, debian_snapshot: "latest" },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      os: { ...value.os, package_lock: { ...pinned("lock"), sha256: "x" } },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      os: { ...value.os, packages_sha256: undefined },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      os: { ...value.os, kernel_release: undefined },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      os: { ...value.os, kernel_release: "6.12.113 amd64" },
    }),
    (value: ReturnType<typeof spec>) => ({
      ...value,
      os: { ...value.os, kernel_release: "k".repeat(65) },
    }),
  ])
    expect(FleetReleaseSpec.safeParse(change(spec())).success).toBe(false);
});

it("pins every download by an https URL, a digest and a size", () => {
  const insecure = spec();
  insecure.binaries["pgcf-agent"].url = "http://releases.example/pgcf-agent";
  expect(FleetReleaseSpec.safeParse(insecure).success).toBe(false);
  const unsized = spec();
  unsized.binaries["pgcf-archive"].size_bytes = 0;
  expect(FleetReleaseSpec.safeParse(unsized).success).toBe(false);
  const credentials = spec();
  credentials.image.url = "https://user:secret@releases.example/image.raw.zst";
  expect(FleetReleaseSpec.safeParse(credentials).success).toBe(false);
  const query = spec();
  query.image.url = "https://releases.example/image.raw.zst?token=x";
  expect(FleetReleaseSpec.safeParse(query).success).toBe(false);
});

it("an image is always the compressed one, and a raw disk is whole sectors", () => {
  const raw = spec();
  raw.image.format = "raw";
  raw.image.sha256 = raw.image.raw_sha256;
  raw.image.size_bytes = raw.image.raw_bytes;
  expect(FleetReleaseSpec.safeParse(raw).success).toBe(false);
  const odd = spec();
  odd.image.raw_bytes += 1;
  expect(FleetReleaseSpec.safeParse(odd).success).toBe(false);
});

it("the page's release is the spec's binaries and the operating system a node installs, under the release id", () => {
  const release = FleetRelease.parse({
    id: "release-1-2-0",
    spec: spec(),
    spec_sha256: "c".repeat(64),
    approved_at: "2026-10-18T10:00:00.000Z",
  });
  // What the node is expected to report back is the API's to compare and is not on the page: an
  // agent of an older build refuses a page that carries more than it knows.
  const { packages_sha256, kernel_release, ...installed } = release.spec.os;
  expect([packages_sha256, kernel_release]).toEqual([
    "d".repeat(64),
    "6.12.113+deb13-amd64",
  ]);
  const page = { id: release.id, binaries: release.spec.binaries };
  expect(NodeRelease.safeParse({ ...page, os: installed }).success).toBe(true);
  expect(NodeRelease.safeParse({ ...page, os: release.spec.os }).success).toBe(
    false,
  );
});

it("a package set has one digest: sha256 over its sorted lines name=version", async () => {
  // The lines are sorted as whole lines, bytewise: "libc6-dev=" sorts before "libc6=" because
  // "-" is below "=", where sorting the names would put "libc6" first.
  const packages = [
    ["linux-image-amd64", "6.12.113-1"],
    ["libc6", "2.41-1"],
    ["bsdutils", "1:2.41.5-0+deb13u1"],
    ["linux-image-6.12.113+deb13-amd64", "6.12.113-1"],
    ["libc6-dev", "2.41-1"],
    ["bash", "5.2"],
  ].map(([name, version]) => ({ name: name!, version: version! }));
  const digest =
    "462f968f28c0d5a21b9cc9e4eaa820b91bdf64ec67a812b5acad20336bdef3d7";
  expect(await packagesSha256(packages)).toBe(digest);
  expect(await packagesSha256([...packages].reverse())).toBe(digest);
  expect(await packagesSha256(packages.slice(1))).not.toBe(digest);
  await expect(
    packagesSha256([{ name: "bash", version: "5.2\n" }]),
  ).rejects.toThrow();
});

it("a node is converged only on the release it reports, and a lost node says so", () => {
  const status = {
    node_id: `nod_${"a".repeat(20)}`,
    region_id: "eu-1",
    node_uid: crypto.randomUUID(),
    desired_release_id: "release-1-2-0",
    desired_spec_sha256: "c".repeat(64),
    observed_release_id: "release-1-2-0",
    observed_at: "2026-10-18T10:00:00.000Z",
    state: "converged",
  };
  expect(FleetNodeReleaseStatus.safeParse(status).success).toBe(true);
  for (const state of ["unassigned", "pending", "stale", "fenced"])
    expect(FleetNodeReleaseStatus.safeParse({ ...status, state }).success).toBe(
      true,
    );
  for (const state of ["drifted", "identity_changed"])
    expect(FleetNodeReleaseStatus.safeParse({ ...status, state }).success).toBe(
      false,
    );
});

const digest = (letter: string, size_bytes: number) => ({
  sha256: letter.repeat(64),
  size_bytes,
});
function registration() {
  return {
    image: {
      ...digest("a", 512_000_000),
      raw_sha256: "b".repeat(64),
      raw_bytes: 2_147_483_648,
    },
    binaries: {
      "pgcf-agent": digest("1", 11_000_000),
      "pgcf-native-gateway": digest("2", 12_000_000),
      "pgcf-archive": digest("3", 5_000_000),
      "pgcf-wal-fetch": digest("4", 5_100_000),
    },
    os: {
      debian_snapshot: "20261016T000000Z",
      package_lock: digest("5", 90_000),
      packages_sha256: "6".repeat(64),
      kernel_release: "6.12.113+deb13-amd64",
    },
    signature: "7".repeat(128),
  };
}

it("a release is registered by its digests and sizes alone, never by a URL", () => {
  expect(FleetReleaseRegistration.safeParse(registration()).success).toBe(true);
  for (const change of [
    (value: ReturnType<typeof registration>) => ({
      ...value,
      image: { ...value.image, url: "https://x.example/i" },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      image: { ...value.image, format: "raw" },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      image: { ...value.image, raw_bytes: 2_147_483_649 },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      binaries: { ...value.binaries, "pgcf-agent": undefined },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      binaries: { ...value.binaries, extra: digest("6", 1) },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      os: { ...value.os, image_version: "other" },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      os: {
        ...value.os,
        package_lock: { ...digest("5", 1), url: "https://x.example/l" },
      },
    }),
    (value: ReturnType<typeof registration>) => ({ ...value, version: 2 }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      os: { ...value.os, packages_sha256: undefined },
    }),
    (value: ReturnType<typeof registration>) => ({
      ...value,
      os: { ...value.os, kernel_release: undefined },
    }),
  ])
    expect(
      FleetReleaseRegistration.safeParse(change(registration())).success,
    ).toBe(false);
});

it("a release's files are stored under one prefix and served at one path, and the spec names exactly those", () => {
  expect(RELEASE_FILES).toEqual([
    "pgcf-node.raw.zst",
    "packages.lock.json",
    "pgcf-agent",
    "pgcf-native-gateway",
    "pgcf-archive",
    "pgcf-wal-fetch",
  ]);
  expect(releaseObjectKey("sha-0123456789ab", "pgcf-agent")).toBe(
    "node-images/sha-0123456789ab/pgcf-agent",
  );
  expect(
    releaseFileUrl(
      "https://api.example.org/",
      "sha-0123456789ab",
      "pgcf-node.raw.zst",
    ),
  ).toBe(
    "https://api.example.org/node/v1/releases/sha-0123456789ab/pgcf-node.raw.zst",
  );
  const spec = fleetReleaseSpec(
    "https://api.example.org:8443",
    "sha-0123456789ab",
    registration(),
  );
  expect(FleetReleaseSpec.parse(spec)).toEqual(spec);
  // The version is the release id, the image version the node enrolls as and the name of the
  // binaries' directory: one name for everything.
  expect(spec.os.image_version).toBe("sha-0123456789ab");
  expect(spec.image).toMatchObject({
    format: "raw.zst",
    url: "https://api.example.org:8443/node/v1/releases/sha-0123456789ab/pgcf-node.raw.zst",
    sha256: "a".repeat(64),
  });
  expect(spec.binaries["pgcf-wal-fetch"].url).toBe(
    "https://api.example.org:8443/node/v1/releases/sha-0123456789ab/pgcf-wal-fetch",
  );
  expect(spec.os.package_lock.url).toBe(
    "https://api.example.org:8443/node/v1/releases/sha-0123456789ab/packages.lock.json",
  );
  // What a node that runs the lock reports back is registered with the release and immutable.
  expect(spec.os).toMatchObject({
    packages_sha256: "6".repeat(64),
    kernel_release: "6.12.113+deb13-amd64",
  });
  expect(() =>
    fleetReleaseSpec("http://api.example.org", "v1", registration()),
  ).toThrow();
  expect(() =>
    fleetReleaseSpec("https://api.example.org/path", "v1", registration()),
  ).toThrow();
});
