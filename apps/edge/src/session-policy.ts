// SPDX-License-Identifier: Apache-2.0
export const ADMISSION_DEADLINE_MS = 30_000;

/** IPv4 admission is per address; IPv6 admission is per canonical /64. */
export function connectionRateKey(ip: string | null): string | null {
  if (ip === null || ip.length > 45 || ip.length < 2) return null;
  if (!ip.includes(":")) {
    const octets = ipv4Octets(ip);
    return octets ? `ipv4:${octets.join(".")}` : null;
  }
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  let address = ip;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const octets = ipv4Octets(address.slice(lastColon + 1));
    if (!octets) return null;
    address = `${address.slice(0, lastColon + 1)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const compressed = address.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] === "" ? [] : compressed[0]!.split(":");
  const right =
    compressed.length === 1 || compressed[1] === ""
      ? []
      : compressed[1]!.split(":");
  const written = [...left, ...right];
  if (written.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  const missing = 8 - written.length;
  if (
    (compressed.length === 1 && missing !== 0) ||
    (compressed.length === 2 && missing < 1)
  )
    return null;
  const parts = [...left, ...Array<string>(missing).fill("0"), ...right];
  return `ipv6:${parts
    .slice(0, 4)
    .map((part) => parseInt(part, 16).toString(16).padStart(4, "0"))
    .join(":")}/64`;
}

function ipv4Octets(ip: string): number[] | null {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(ip))
    return null;
  const octets = ip.split(".").map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}
