// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import versions from "../../platform/versions.lock.json" with { type: "json" };
export const TALOS_SANDBOX_BUILD_INPUTS = {
  talosVersion: versions.target.talosVersion,
  imager: versions.talosBoot.imager,
  baseInstaller: versions.talosBoot.baseInstaller,
} as const;
const immutable = (value: string) =>
  typeof value === "string" &&
  value.length <= 512 &&
  /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value);
const canonical = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ":" +
              canonical((value as Record<string, unknown>)[key]),
          )
          .join(",")}}`;
/** Public, common boot recipe. Per-node credentials and network configuration are excluded by construction. */
export function sandboxImagePlan(input: {
  sourceCommit: string;
  architecture: "amd64" | "arm64";
  sandboxExtension: string;
  otherExtensions: readonly string[];
}) {
  if (
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !["amd64", "arm64"].includes(input.architecture) ||
    !immutable(input.sandboxExtension) ||
    input.otherExtensions.length > 30 ||
    input.otherExtensions.some((value) => !immutable(value))
  )
    throw Error("talos_build_input_invalid");
  const extensions = [input.sandboxExtension, ...input.otherExtensions].sort();
  if (new Set(extensions).size !== extensions.length)
    throw Error("talos_extension_duplicate");
  // Talos1.14 MinRAWDiskSize; imager adds expanded BOOT/BIOS geometry itself.
  // https://github.com/siderolabs/talos/blob/v1.14.2/pkg/imager/profile/default.go
  const rawImage = {
      nominal_disk_bytes: 1246 * 1024 ** 2,
      disk_format: "raw",
      bootloader: input.architecture === "arm64" ? "sd-boot" : "dual-boot",
      out_format: ".xz",
    } as const,
    recipe = {
      version: 1,
      source_commit: input.sourceCommit,
      sandbox_extension: input.sandboxExtension,
      talos_version: TALOS_SANDBOX_BUILD_INPUTS.talosVersion,
      architecture: input.architecture,
      platform: "nocloud",
      imager: TALOS_SANDBOX_BUILD_INPUTS.imager,
      base_installer: TALOS_SANDBOX_BUILD_INPUTS.baseInstaller,
      system_extensions: extensions,
      extra_kernel_args: ["net.ifnames=0"],
      raw_image: rawImage,
    },
    recipeSha256 = createHash("sha256").update(canonical(recipe)).digest("hex");
  const common = {
    arch: input.architecture,
    platform: "nocloud",
    secureboot: false,
    version: `v${TALOS_SANDBOX_BUILD_INPUTS.talosVersion}`,
    input: {
      kernel: { path: `/usr/install/${input.architecture}/vmlinuz` },
      initramfs: { path: `/usr/install/${input.architecture}/initramfs.xz` },
      sdStub: { path: `/usr/install/${input.architecture}/systemd-stub.efi` },
      sdBoot: { path: `/usr/install/${input.architecture}/systemd-boot.efi` },
      baseInstaller: { imageRef: TALOS_SANDBOX_BUILD_INPUTS.baseInstaller },
    },
    customization: { extraKernelArgs: recipe.extra_kernel_args },
  };
  return {
    recipe,
    recipeSha256,
    schematicManifest: {
      version: "v1alpha1",
      metadata: {
        name: "schematic",
        version: recipeSha256,
        author:
          "PGCF imager (https://github.com/amerged-org/cloudflare-postgres)",
        description:
          "Public reproducible PGCF imager recipe; not an Image Factory hosted schematic.",
        compatibility: {
          talos: { version: `= v${TALOS_SANDBOX_BUILD_INPUTS.talosVersion}` },
        },
      },
    },
    installerProfile: {
      ...common,
      output: { kind: "installer", outFormat: "raw" },
    },
    rawProfile: {
      ...common,
      output: {
        kind: "image",
        imageOptions: {
          diskSize: recipe.raw_image.nominal_disk_bytes,
          diskFormat: recipe.raw_image.disk_format,
          bootloader: recipe.raw_image.bootloader,
        },
        outFormat: recipe.raw_image.out_format,
      },
    },
  };
}
/** Attach the independently built recipe extension without hashing its own digest recursively. */
export function bindSandboxImageProfiles(
  plan: ReturnType<typeof sandboxImagePlan>,
  recipeExtension: string,
) {
  if (!immutable(recipeExtension))
    throw Error("talos_recipe_extension_unbound");
  const systemExtensions = [
    ...plan.recipe.system_extensions,
    recipeExtension,
  ].map((imageRef) => ({ imageRef }));
  return {
    installer: {
      ...plan.installerProfile,
      input: { ...plan.installerProfile.input, systemExtensions },
    },
    raw: {
      ...plan.rawProfile,
      input: { ...plan.rawProfile.input, systemExtensions },
    },
  };
}
