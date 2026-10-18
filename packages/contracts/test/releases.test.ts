// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { NodeRelease } from "../src/node-link.ts";
import {
  FleetNodeReleaseStatus,
  FleetRelease,
  FleetReleaseSpec,
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
    },
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

it("an uncompressed image pins identical transport and raw bytes, and a raw disk is whole sectors", () => {
  const raw = spec();
  raw.image.format = "raw";
  expect(FleetReleaseSpec.safeParse(raw).success).toBe(false);
  raw.image.sha256 = raw.image.raw_sha256;
  raw.image.size_bytes = raw.image.raw_bytes;
  expect(FleetReleaseSpec.safeParse(raw).success).toBe(true);
  const odd = spec();
  odd.image.raw_bytes += 1;
  expect(FleetReleaseSpec.safeParse(odd).success).toBe(false);
});

it("the page's release is the spec's binaries and operating system under the release id", () => {
  const release = FleetRelease.parse({
    id: "release-1-2-0",
    spec: spec(),
    spec_sha256: "c".repeat(64),
    approved_at: "2026-10-18T10:00:00.000Z",
  });
  expect(
    NodeRelease.safeParse({
      id: release.id,
      binaries: release.spec.binaries,
      os: release.spec.os,
    }).success,
  ).toBe(true);
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
