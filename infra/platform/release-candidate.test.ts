// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveFleetReleaseCandidate } from "./release-candidate.ts";

const bytes = await readFile(new URL("./versions.lock.json", import.meta.url));
test("derives only pinned existing lock evidence and reports unresolved provenance without inventing a release", () => {
  const candidate = deriveFleetReleaseCandidate(bytes),
    lock = JSON.parse(bytes.toString());
  assert.equal(
    candidate.versions_lock_sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(candidate.target.talos_version, lock.target.talosVersion);
  assert.equal(
    candidate.target.kubernetes_version,
    lock.target.kubernetesVersion,
  );
  const cilium = lock.charts.find(
    (chart: { name: string }) => chart.name === "cilium",
  );
  assert.deepEqual(
    candidate.components.find((component) => component.name === "cilium"),
    {
      name: "cilium",
      kind: "chart",
      version: cilium.chartVersion,
      reference: `${cilium.source}@${cilium.ociManifestDigest}`,
      sha256: cilium.ociManifestDigest.slice(7),
    },
  );
  assert.equal(
    candidate.components.find((component) => component.name === "postgres")
      ?.reference,
    lock.regional.postgresImage.reference,
  );
  assert.equal(candidate.spec, null);
  assert.ok(candidate.unresolved.includes("roles/customer/talos_installer"));
  assert.ok(
    candidate.unresolved.includes("roles/control_relay/talos_schematic_sha256"),
  );
  assert.ok(candidate.unresolved.includes("components/barman/sha256"));
  assert.ok(candidate.unresolved.includes("components/flux-source/sha256"));
  assert.equal(
    candidate.components.some((component) => component.name === "barman"),
    false,
  );
});
test("hashes exact source bytes and rejects evidence that contradicts an authoritative digest or version", () => {
  const lock = JSON.parse(bytes.toString()),
    cloudflared = lock.regional.images.find(
      (entry: { name: string }) => entry.name === "cloudflared",
    );
  const original = deriveFleetReleaseCandidate(bytes),
    reformatted = deriveFleetReleaseCandidate(JSON.stringify(lock));
  assert.notEqual(
    original.versions_lock_sha256,
    reformatted.versions_lock_sha256,
  );
  assert.deepEqual(original.components, reformatted.components);
  lock.fleetRelease = {
    components: [
      {
        name: "cloudflared",
        kind: "image",
        version: cloudflared.version,
        reference: `${cloudflared.reference}@sha256:${"f".repeat(64)}`,
        sha256: "f".repeat(64),
      },
    ],
  };
  assert.throws(
    () => deriveFleetReleaseCandidate(JSON.stringify(lock)),
    /release_lock_component_conflict:cloudflared/,
  );
  lock.fleetRelease.components[0]!.sha256 = cloudflared.indexDigest.slice(7);
  lock.fleetRelease.components[0]!.reference = `${cloudflared.reference}@${cloudflared.indexDigest}`;
  lock.fleetRelease.components[0]!.version = "99.0.0";
  assert.throws(
    () => deriveFleetReleaseCandidate(JSON.stringify(lock)),
    /release_lock_component_conflict:cloudflared/,
  );
});
function completeLock() {
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "regional",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
  ];
  const components = names.map((name) => ({
    name,
    kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
    version: "1.0.0",
    reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
    sha256: "d".repeat(64),
  }));
  const role = {
    installerImage: `registry.example/talos@sha256:${"a".repeat(64)}`,
    schematicSha256: "b".repeat(64),
    extensions: [],
  };
  return {
    schemaVersion: 1,
    target: { talosVersion: "1.14.1", kubernetesVersion: "1.36.5" },
    charts: [],
    regional: {
      images: [],
      postgresImage: {
        reference: `registry.example/postgres@sha256:${"d".repeat(64)}`,
        version: "1.0.0",
      },
    },
    fleetRelease: {
      configurationSchemaRevision: 1,
      components,
      talosRoles: { control_relay: role, customer: role },
      roleComponents: {
        control_relay: names.slice(3),
        customer: names.slice(3),
      },
    },
  };
}
test("constructs a schema-valid candidate only when every explicit role and artifact pin exists in the same lock", () => {
  const lock = completeLock(),
    candidate = deriveFleetReleaseCandidate(JSON.stringify(lock));
  assert.deepEqual(candidate.unresolved, []);
  assert.equal(candidate.spec?.configuration_schema_revision, 1);
  assert.equal(
    candidate.spec?.roles.customer.talos_installer,
    lock.fleetRelease.talosRoles.customer.installerImage,
  );
  assert.equal(
    candidate.spec?.components.length,
    lock.fleetRelease.components.length,
  );
  assert.equal(candidate.candidate_only, true);
  const missing = structuredClone(lock);
  missing.fleetRelease.components.pop();
  assert.throws(
    () => deriveFleetReleaseCandidate(JSON.stringify(missing)),
    /release_lock_release_spec_invalid/,
  );
});
test("rejects duplicate evidence, unpinned images and inconsistent role references", () => {
  const duplicate = completeLock();
  duplicate.fleetRelease.components.push(duplicate.fleetRelease.components[0]!);
  assert.throws(
    () => deriveFleetReleaseCandidate(JSON.stringify(duplicate)),
    /release_lock_component_duplicate/,
  );
  const unpinned = completeLock();
  unpinned.fleetRelease.components[3]!.reference =
    "registry.example/regional:latest";
  assert.throws(
    () => deriveFleetReleaseCandidate(JSON.stringify(unpinned)),
    /release_lock_image_digest_invalid/,
  );
  const wrong = completeLock();
  wrong.fleetRelease.roleComponents.customer.push("not-in-release");
  assert.throws(
    () => deriveFleetReleaseCandidate(JSON.stringify(wrong)),
    /release_lock_release_spec_invalid/,
  );
});
