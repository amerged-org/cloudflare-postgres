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
  cilium: {
    version: "1.20.2",
    url: "https://helm.cilium.io/cilium-1.20.2.tgz",
    sha256: "b2afd87b7f75f875f92a14559f14f59b7babbb479d968e3fd625a20bf30ec20e",
    max_bytes: 1024 * 1024,
  },
  cilium_values: {
    sha256: "0de1a09a3fd450916cdb316d41fa9dcfd769708f7a6cb5b49496a64ee9b26b39",
  },
  flux: {
    version: "2.9.5",
    url: "https://github.com/fluxcd/flux2/releases/download/v2.9.5/install.yaml",
    sha256: "cc3dcd743af16215838b6937e1fce83745bf24c0dcc6c59737c59df15429caaf",
    max_bytes: 1024 * 1024,
  },
};
