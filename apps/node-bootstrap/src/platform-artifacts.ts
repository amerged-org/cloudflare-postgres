// SPDX-License-Identifier: Apache-2.0
import lock from "../../../infra/platform/versions.lock.json" with { type: "json" };

export const TALOS_VERSION = lock.target.talosVersion;
export const KUBERNETES_VERSION = lock.target.kubernetesVersion;
export const BOOTSTRAP_CLIENTS = {
  ...lock.bootstrapClients,
  talos: { ...lock.bootstrapClients.talos, version: TALOS_VERSION },
  kubectl: { ...lock.bootstrapClients.kubectl, version: KUBERNETES_VERSION },
};
const cilium = lock.charts.find((chart) => chart.name === "cilium");
const cloudflared = lock.regional.images.find(
  (image) => image.name === "cloudflared",
);
if (
  !cilium?.ociManifestDigest ||
  !cilium.archiveURL ||
  !cloudflared?.indexDigest
)
  throw new Error("bootstrap_version_lock_invalid");
export const PLATFORM_ARTIFACTS = {
  cloudflared: { image: `${cloudflared.reference}@${cloudflared.indexDigest}` },
  cilium: {
    version: cilium.chartVersion,
    filename: `cilium-${cilium.chartVersion}.tgz`,
    oci_digest: cilium.ociManifestDigest,
    url: cilium.archiveURL,
    sha256: cilium.archiveSha256,
    max_bytes: 1024 * 1024,
  },
  cilium_values: { sha256: lock.bootstrapValues.cilium.sha256 },
  flux: {
    version: lock.flux.version.replace(/^v/, ""),
    url: lock.flux.installManifestURL,
    sha256: lock.flux.installManifestSha256,
    max_bytes: 1024 * 1024,
  },
};
