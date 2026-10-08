// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  FleetReleaseSpec,
  FleetNodeReleaseObservation,
} from "../src/releases.ts";

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
function spec() {
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  return {
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { control_relay: role, customer: structuredClone(role) },
  };
}
it("requires explicit digests, complete product layers and closed role references", () => {
  expect(FleetReleaseSpec.safeParse(spec()).success).toBe(true);
  const missing = spec();
  missing.components.pop();
  expect(FleetReleaseSpec.safeParse(missing).success).toBe(false);
  const unknown = spec();
  unknown.roles.customer.components.push("unknown");
  expect(FleetReleaseSpec.safeParse(unknown).success).toBe(false);
  const unpinned = spec();
  unpinned.components[0]!.sha256 = "latest";
  expect(FleetReleaseSpec.safeParse(unpinned).success).toBe(false);
  const duplicate = spec();
  duplicate.components.push(duplicate.components[0]!);
  expect(FleetReleaseSpec.safeParse(duplicate).success).toBe(false);
});
it("does not treat a release-id claim or partial duplicate inventory as component observations", () => {
  expect(
    FleetNodeReleaseObservation.safeParse({
      release_id: "one",
      node_uid: crypto.randomUUID(),
    }).success,
  ).toBe(false);
});
it("forbids a different shared runtime version and contradictory image digest in one release", () => {
  const different = structuredClone(spec());
  different.roles.customer.kubernetes_version = "1.36.3";
  expect(FleetReleaseSpec.safeParse(different).success).toBe(false);
  const wrong = spec();
  wrong.components[3]!.reference = `registry.example/regional@sha256:${"e".repeat(64)}`;
  expect(FleetReleaseSpec.safeParse(wrong).success).toBe(false);
});
