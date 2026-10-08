// SPDX-License-Identifier: Apache-2.0
export const HELM_ARTIFACT = {
  version: "4.3.0",
  release_url: "https://github.com/helm/helm/releases/tag/v4.3.0",
  linux_amd64_sha256:
    "86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb",
  linux_arm64_sha256:
    "31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08",
};
export const PLATFORM_ARTIFACTS = {
  cloudflared: {
    image:
      "docker.io/cloudflare/cloudflared@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07",
  },
  cilium: {
    version: "1.20.2",
    oci_digest:
      "sha256:a7c12d330dd96bfcda3bf057b24be8f36566c34868265f930f776dff6f42d838",
    url: "https://helm.cilium.io/cilium-1.20.2.tgz",
    sha256: "b2afd87b7f75f875f92a14559f14f59b7babbb479d968e3fd625a20bf30ec20e",
    max_bytes: 1024 * 1024,
  },
  cilium_values: {
    sha256: "0de1a09a3fd450916cdb316d41fa9dcfd769708f7a6cb5b49496a64ee9b26b39",
  },
  flux: {
    version: "2.9.6",
    url: "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
    sha256: "9c1fda7e401429531ed1478f67ba06b3edff6513b75da7ee47bde9f1c4d4251c",
    max_bytes: 1024 * 1024,
  },
};
