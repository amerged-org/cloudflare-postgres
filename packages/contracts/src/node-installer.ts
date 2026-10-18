// SPDX-License-Identifier: Apache-2.0
// Renders the pull installer's userData for Contabo's rescue action (plan 9.2). The text of
// `infra/node-image/installer/cloud-config.yaml` and `install.sh` is the generated module
// `node-installer-files.generated.ts`; install.sh validates the same parameters again.
import {
  INSTALLER_CLOUD_CONFIG,
  INSTALLER_SCRIPT,
} from "./node-installer-files.generated.ts";

export { INSTALLER_CLOUD_CONFIG, INSTALLER_SCRIPT };

export interface InstallerParameters {
  imageUrl: string;
  imageZstSha256: string;
  imageZstBytes: number;
  imageRawSha256: string;
  imageRawBytes: number;
  diskBytes: number;
  memoryMinKib: number;
  mac: string;
  ipv4: string;
  ipv4Prefix: number;
  ipv4Gateway: string;
  ipv6?: { address: string; prefix: number; gateway: string };
  dns: string[];
  hostname: string;
  progressUrl: string;
  progressToken: string;
  nodeId: string;
  region: string;
  apiUrl: string;
  enrollmentToken: string;
}

// Contabo accepts at most 32 KiB of userData.
export const userDataLimit = 32 * 1024;

// A URL of the installer has no query: the image is read with the install's token, so no presigned
// URL, key or signature ever travels in the userData.
const https = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~%/+-]*)?$/;
const hex64 = /^[0-9a-f]{64}$/;
const ipv4 = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
const token = /^[A-Za-z0-9._~-]{16,512}$/;
// The seed the agent reads (`NodeEnrollmentSeed` of packages/contracts/src/node-link.ts) takes these
// shapes and no others: the installer refuses what the agent would refuse after the disk is written.
const nodeId = /^nod_[a-z0-9]{20}$/;
const region = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const enrollmentToken = /^pgcf_et_[A-Za-z0-9_-]{43}$/;
const apiOrigin = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/?$/;

function count(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return String(value);
}

function match(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

export function installerParameters(p: InstallerParameters): string {
  if (p.imageRawBytes >= p.diskBytes)
    throw new Error("the image does not fit the disk");
  if (p.dns.length < 1 || p.dns.length > 3)
    throw new Error("one to three DNS servers");
  if (!Number.isInteger(p.ipv4Prefix) || p.ipv4Prefix < 1 || p.ipv4Prefix > 32)
    throw new Error("invalid ipv4Prefix");
  if (
    p.ipv6 &&
    (!Number.isInteger(p.ipv6.prefix) ||
      p.ipv6.prefix < 1 ||
      p.ipv6.prefix > 128)
  ) {
    throw new Error("invalid ipv6 prefix");
  }
  const values: [string, string][] = [
    ["PGCF_IMAGE_URL", match(p.imageUrl, https, "imageUrl")],
    ["PGCF_IMAGE_ZST_SHA256", match(p.imageZstSha256, hex64, "imageZstSha256")],
    ["PGCF_IMAGE_ZST_BYTES", count(p.imageZstBytes, "imageZstBytes")],
    ["PGCF_IMAGE_RAW_SHA256", match(p.imageRawSha256, hex64, "imageRawSha256")],
    ["PGCF_IMAGE_RAW_BYTES", count(p.imageRawBytes, "imageRawBytes")],
    ["PGCF_DISK_BYTES", count(p.diskBytes, "diskBytes")],
    ["PGCF_MEMORY_MIN_KIB", count(p.memoryMinKib, "memoryMinKib")],
    ["PGCF_MAC", match(p.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, "mac")],
    ["PGCF_IPV4", match(p.ipv4, ipv4, "ipv4")],
    ["PGCF_IPV4_PREFIX", String(p.ipv4Prefix)],
    ["PGCF_IPV4_GATEWAY", match(p.ipv4Gateway, ipv4, "ipv4Gateway")],
    [
      "PGCF_IPV6",
      p.ipv6 ? match(p.ipv6.address, /^[0-9a-f:]{2,39}$/, "ipv6 address") : "",
    ],
    ["PGCF_IPV6_PREFIX", p.ipv6 ? String(p.ipv6.prefix) : ""],
    [
      "PGCF_IPV6_GATEWAY",
      p.ipv6 ? match(p.ipv6.gateway, /^[0-9a-f:]{2,39}$/, "ipv6 gateway") : "",
    ],
    [
      "PGCF_DNS",
      p.dns.map((server) => match(server, /^[0-9a-f.:]+$/, "dns")).join(" "),
    ],
    ["PGCF_HOSTNAME", match(p.hostname, /^[a-z][a-z0-9-]{0,62}$/, "hostname")],
    ["PGCF_PROGRESS_URL", match(p.progressUrl, https, "progressUrl")],
    ["PGCF_PROGRESS_TOKEN", match(p.progressToken, token, "progressToken")],
    ["PGCF_NODE_ID", match(p.nodeId, nodeId, "nodeId")],
    ["PGCF_REGION", match(p.region, region, "region")],
    ["PGCF_API_URL", match(p.apiUrl, apiOrigin, "apiUrl")],
    [
      "PGCF_ENROLLMENT_TOKEN",
      match(p.enrollmentToken, enrollmentToken, "enrollmentToken"),
    ],
  ];
  return values.map(([name, value]) => `${name}=${value}\n`).join("");
}

const utf8 = new TextEncoder();
function base64(text: string): string {
  let binary = "";
  for (const byte of utf8.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function renderUserData(
  template: string,
  installScript: string,
  parameters: InstallerParameters,
): string {
  if (!template.startsWith("#cloud-config\n"))
    throw new Error("the template is not a cloud-config document");
  const rendered = template
    .replace("@@INSTALL_SH@@", () => base64(installScript))
    .replace("@@PARAMS@@", () => base64(installerParameters(parameters)));
  if (rendered.includes("@@"))
    throw new Error("unfilled placeholder in the installer template");
  const size = utf8.encode(rendered).length;
  if (size >= userDataLimit)
    throw new Error(
      `installer userData is ${size} bytes, above the 32 KiB limit`,
    );
  return rendered;
}

/** The userData of the pull installer for one node, from the files the image ships with. */
export function installerUserData(parameters: InstallerParameters): string {
  return renderUserData(INSTALLER_CLOUD_CONFIG, INSTALLER_SCRIPT, parameters);
}
