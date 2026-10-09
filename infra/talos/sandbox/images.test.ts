// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import versions from "../../platform/versions.lock.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import { NodeBootstrapSpec } from "../../../packages/contracts/src/node-bootstrap.ts";
import { fixture } from "../../../apps/node-bootstrap/test/fixture.ts";
import {
  sandboxImagePlan,
  bindSandboxImageProfiles,
  TALOS_SANDBOX_BUILD_INPUTS,
} from "./images.ts";
test("one pinned public recipe produces installer and raw images with the same actual extension set and no node data", () => {
  const sandbox = "ghcr.io/example/sandbox@sha256:" + "a".repeat(64),
    other = "ghcr.io/example/official@sha256:" + "b".repeat(64),
    recipe = "ghcr.io/example/recipe@sha256:" + "c".repeat(64),
    plan = sandboxImagePlan({
      sourceCommit: "d".repeat(40),
      architecture: "amd64",
      sandboxExtension: sandbox,
      otherExtensions: [other],
    }),
    profiles = bindSandboxImageProfiles(plan, recipe);
  assert.match(TALOS_SANDBOX_BUILD_INPUTS.imager, /@sha256:[a-f0-9]{64}$/);
  assert.equal(plan.recipeSha256, plan.schematicManifest.metadata.version);
  assert.equal(plan.schematicManifest.metadata.name, "schematic");
  assert.match(plan.schematicManifest.metadata.author, /^PGCF imager /);
  assert.deepEqual(
    profiles.installer.input.systemExtensions,
    profiles.raw.input.systemExtensions,
  );
  assert.equal(profiles.installer.output.kind, "installer");
  assert.equal(profiles.raw.output.kind, "image");
  assert.equal(profiles.raw.output.imageOptions.diskSize, 1246 * 1024 ** 2);
  assert.equal(profiles.raw.output.imageOptions.bootloader, "dual-boot");
  assert.equal(profiles.raw.output.outFormat, ".xz");
  assert.deepEqual(plan.recipe.extra_kernel_args, ["net.ifnames=0"]);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /agent_key|node_uid|kubeconfig|talos\.config|ip=/,
  );
  assert.throws(() =>
    sandboxImagePlan({
      sourceCommit: "d".repeat(40),
      architecture: "amd64",
      sandboxExtension: "ghcr.io/example/sandbox:latest",
      otherExtensions: [],
    }),
  );
  assert.throws(() =>
    sandboxImagePlan({
      sourceCommit: "d".repeat(40),
      architecture: "amd64",
      sandboxExtension: sandbox,
      otherExtensions: [sandbox],
    }),
  );
  assert.throws(() =>
    bindSandboxImageProfiles(plan, "ghcr.io/example/recipe:latest"),
  );
});
test("fixed host service waits for protected files and CRI while custom runtime does not change defaults", async () => {
  const service = await readFile(
      new URL("service.yaml", import.meta.url),
      "utf8",
    ),
    cri = await readFile(
      new URL("20-pgcf-prestarted.part", import.meta.url),
      "utf8",
    );
  assert.match(service, /runnerMode: host/);
  assert.match(service, /--cri-host-context/);
  assert.match(service, /service: cri/);
  assert.match(service, /path: \/var\/lib\/pgcf-sandbox\/agent-key/);
  assert.doesNotMatch(service, /mounts:|configuration: true|secret|TOKEN=/);
  assert.match(cri, /\[proxy_plugins\.pgcf\]/);
  assert.match(cri, /sandboxer = "pgcf"/);
  assert.doesNotMatch(
    cri,
    /default_runtime_name|privileged_without_host_devices|SystemdCgroup/,
  );
});

test("Talos version and immutable assembly inputs come from the one release lock", () => {
  const plan = sandboxImagePlan({
    sourceCommit: "d".repeat(40),
    architecture: "amd64",
    sandboxExtension: "ghcr.io/example/sandbox@sha256:" + "a".repeat(64),
    otherExtensions: [],
  });
  assert.equal(
    TALOS_SANDBOX_BUILD_INPUTS.talosVersion,
    versions.target.talosVersion,
  );
  assert.equal(plan.recipe.imager, versions.talosBoot.imager);
  assert.equal(plan.recipe.base_installer, versions.talosBoot.baseInstaller);
  assert.equal(
    plan.installerProfile.version,
    "v" + versions.target.talosVersion,
  );
  assert.equal(plan.rawProfile.version, "v" + versions.target.talosVersion);
  assert.equal(
    plan.schematicManifest.metadata.compatibility.talos.version,
    "= v" + versions.target.talosVersion,
  );
});

test("vendor minimum is nominal once, recipe-bound, and preserves actual rescue RAM refusal", () => {
  const plan = sandboxImagePlan({
    sourceCommit: "d".repeat(40),
    architecture: "amd64",
    sandboxExtension: "ghcr.io/example/sandbox@sha256:" + "a".repeat(64),
    otherExtensions: [],
  });
  // Talos1.14.2 default.go MinRAWDiskSize and output.go FillDefaults:
  // expanded BOOT plus dual-boot BIOS/BOOT are added by imager, not by this profile.
  const nominal = plan.rawProfile.output.imageOptions.diskSize,
    expanded = nominal + (2000 - 1000 + 1 + 2000) * 1024 ** 2;
  assert.equal(nominal, 1246 * 1024 ** 2);
  assert.equal(expanded, 4453302272);
  assert.deepEqual(plan.recipe.raw_image, {
    nominal_disk_bytes: nominal,
    disk_format: "raw",
    bootloader: "dual-boot",
    out_format: ".xz",
  });
  const spec = fixture().spec,
    image = { ...spec.image, raw_bytes: expanded, compressed_bytes: 231981404 },
    hardware = { ...spec.hardware, rescue_ram_min_bytes: 8326418432 };
  assert.doesNotThrow(() =>
    NodeBootstrapSpec.parse({ ...spec, hardware, image }),
  );
  assert.throws(
    () =>
      NodeBootstrapSpec.parse({
        ...spec,
        hardware,
        image: { ...image, raw_bytes: 7600078848 },
      }),
    /rescue RAM cannot hold verified image/,
  );
});
