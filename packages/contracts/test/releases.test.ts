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
    talos_extensions: [] as string[],
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
it("only a release whose every role runs the native gateway and controller declares route token v3", () => {
  const native = spec();
  for (const name of ["native-gateway", "native-controller"])
    native.components.push({
      name,
      kind: "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    });
  for (const role of Object.values(native.roles))
    role.components.push("native-gateway", "native-controller");
  expect(FleetReleaseSpec.safeParse(native).success).toBe(true);
  const declared = { ...native, route_token_version: 3 };
  expect(FleetReleaseSpec.parse(declared).route_token_version).toBe(3);
  expect(
    FleetReleaseSpec.safeParse({ ...native, route_token_version: 2 }).success,
  ).toBe(false);
  // The TypeScript gateway verifies only v2 and the TypeScript controller publishes no target.
  expect(
    FleetReleaseSpec.safeParse({ ...spec(), route_token_version: 3 }).success,
  ).toBe(false);
  for (const name of ["native-gateway", "native-controller"]) {
    const partial = structuredClone(declared);
    partial.roles.control_relay.components =
      partial.roles.control_relay.components.filter((n) => n !== name);
    expect(FleetReleaseSpec.safeParse(partial).success).toBe(false);
  }
});
it("declares thin sampling only with a native controller on every role", () => {
  const native = spec();
  native.components.push({
    name: "native-controller",
    kind: "image",
    version: "1.0.0",
    reference: `registry.example/native-controller@sha256:${"d".repeat(64)}`,
    sha256: "d".repeat(64),
  });
  for (const role of Object.values(native.roles))
    role.components.push("native-controller");
  expect(
    FleetReleaseSpec.parse({ ...native, thin_storage_sampling_version: 1 })
      .thin_storage_sampling_version,
  ).toBe(1);
  expect(
    FleetReleaseSpec.safeParse({ ...native, thin_storage_sampling_version: 2 })
      .success,
  ).toBe(false);
  expect(
    FleetReleaseSpec.safeParse({ ...spec(), thin_storage_sampling_version: 1 })
      .success,
  ).toBe(false);
  native.roles.control_relay.components =
    native.roles.control_relay.components.filter(
      (n) => n !== "native-controller",
    );
  expect(
    FleetReleaseSpec.safeParse({ ...native, thin_storage_sampling_version: 1 })
      .success,
  ).toBe(false);
});
it("declares admission snapshots only with v4 routing and v2 proofs on every native role", () => {
  const native = spec();
  for (const name of ["native-gateway", "native-controller"]) {
    native.components.push({
      name,
      kind: "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    });
    for (const role of Object.values(native.roles)) role.components.push(name);
  }
  const capable = {
    ...native,
    route_token_version: 4,
    runtime_attestation_version: 2,
    admission_snapshot_version: 1,
  };
  expect(FleetReleaseSpec.safeParse(capable).success).toBe(true);
  expect(
    FleetReleaseSpec.safeParse({ ...capable, route_token_version: 3 }).success,
  ).toBe(false);
  expect(
    FleetReleaseSpec.safeParse({
      ...capable,
      runtime_attestation_version: undefined,
    }).success,
  ).toBe(false);
  native.roles.customer.components = native.roles.customer.components.filter(
    (name) => name !== "native-controller",
  );
  expect(FleetReleaseSpec.safeParse(capable).success).toBe(false);
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
it("keeps the pinned cert-manager installation hook qualified without requiring a permanent running Job on every node", () => {
  const value = spec();
  value.components.push({
    name: "image/cert-manager/cert-manager-startupapicheck",
    kind: "image",
    version: "1.21.2",
    reference:
      "quay.io/jetstack/cert-manager-startupapicheck:v1.21.2@sha256:" +
      "e".repeat(64),
    sha256: "e".repeat(64),
  });
  expect(FleetReleaseSpec.safeParse(value).success).toBe(true);
  value.components.push({
    name: "image/cert-manager/unqualified-hook",
    kind: "image",
    version: "1.21.2",
    reference: "quay.io/jetstack/unqualified:v1.21.2@sha256:" + "e".repeat(64),
    sha256: "e".repeat(64),
  });
  expect(FleetReleaseSpec.safeParse(value).success).toBe(false);
});
