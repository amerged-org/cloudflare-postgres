// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { basename } from "node:path";
import { blocked, execute, ip } from "./node-network-native.ts";
import type { ReviewedCommand } from "./node-network-native.ts";

export interface PeerBinding {
  node_id: string;
  provider_instance_id: string;
  address: string;
}
export function wireguardPeers(
  interfaces: string,
  endpoints: string,
  handshakes: string,
  device: string,
  expected: PeerBinding[],
  observedAt: string,
) {
  if (
    !/^[A-Za-z0-9_.-]{1,32}$/.test(device) ||
    !interfaces.trim().split(/\s+/).includes(device)
  )
    blocked("wireguard_interface_missing");
  const endpointRows = new Map<string, string>(),
    handshakeRows = new Map<string, string>();
  const parse = (text: string, rows: Map<string, string>) => {
    if (Buffer.byteLength(text) > 65536) blocked("wireguard_bytes");
    for (const line of text.trim().split("\n").filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (
        fields.length !== 3 ||
        fields[0] !== device ||
        !/^[A-Za-z0-9+/]{43}=$/.test(fields[1]!) ||
        rows.has(fields[1]!)
      )
        blocked("wireguard_readback_invalid");
      rows.set(fields[1]!, fields[2]!);
    }
  };
  parse(endpoints, endpointRows);
  parse(handshakes, handshakeRows);
  if (
    endpointRows.size !== expected.length ||
    handshakeRows.size !== expected.length
  )
    blocked("wireguard_peer_set");
  const used = new Set<string>();
  return expected.map((peer) => {
    const matches = [...endpointRows].filter(([, endpoint]) => {
      const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(endpoint);
      return (
        match &&
        Number(match[3]) === 51871 &&
        ip(match[1] ?? match[2]!) === ip(peer.address)
      );
    });
    if (matches.length !== 1 || used.has(matches[0]![0]))
      blocked("wireguard_endpoint_binding");
    const public_key = matches[0]![0];
    used.add(public_key);
    const seconds = handshakeRows.get(public_key);
    if (!seconds || !/^[1-9][0-9]{0,11}$/.test(seconds))
      blocked("wireguard_handshake_missing");
    const at = Number(seconds) * 1000,
      observed = Date.parse(observedAt);
    if (at < observed - 180000 || at > observed + 5000)
      blocked("wireguard_handshake_stale");
    return {
      ...peer,
      public_key,
      last_handshake_at: new Date(at).toISOString(),
    };
  });
}
interface Packet {
  source: string;
  destination: string;
  protocol: number;
  transport: Buffer;
  at: number;
}
function packet(data: Buffer, at: number): Packet | null {
  if (data.length < 14) blocked("capture_truncated");
  let offset = 14,
    ether = data.readUInt16BE(12),
    tags = 0;
  while (ether === 0x8100 || ether === 0x88a8) {
    if (++tags > 2 || data.length < offset + 4) blocked("capture_invalid");
    ether = data.readUInt16BE(offset + 2);
    offset += 4;
  }
  if (ether !== 0x0800 && ether !== 0x86dd) return null;
  const body = data.subarray(offset);
  if (ether === 0x0800) {
    const header = (body[0]! & 15) * 4;
    if (
      body.length < 20 ||
      body[0]! >> 4 !== 4 ||
      header < 20 ||
      body.length < header ||
      body.readUInt16BE(2) < header ||
      body.readUInt16BE(2) > body.length ||
      (body.readUInt16BE(6) & 0x3fff) !== 0
    )
      blocked("capture_ip_inconclusive");
    return {
      source: [...body.subarray(12, 16)].join("."),
      destination: [...body.subarray(16, 20)].join("."),
      protocol: body[9]!,
      transport: body.subarray(header, body.readUInt16BE(2)),
      at,
    };
  }
  if (
    body.length < 40 ||
    body[0]! >> 4 !== 6 ||
    body.readUInt16BE(4) + 40 > body.length
  )
    blocked("capture_ip_inconclusive");
  const address = (start: number) =>
    ip(
      Array.from({ length: 8 }, (_, index) =>
        body.readUInt16BE(start + index * 2).toString(16),
      ).join(":"),
    );
  let protocol = body[6]!,
    position = 40,
    extensions = 0;
  while ([0, 43, 60].includes(protocol)) {
    if (++extensions > 8 || position + 2 > body.length)
      blocked("capture_ip_inconclusive");
    const length = (body[position + 1]! + 1) * 8;
    protocol = body[position]!;
    position += length;
    if (position > body.length) blocked("capture_ip_inconclusive");
  }
  if (protocol === 44 || protocol === 50 || protocol === 51)
    blocked("capture_ip_inconclusive");
  return {
    source: address(8),
    destination: address(24),
    protocol,
    transport: body.subarray(position, body.readUInt16BE(4) + 40),
    at,
  };
}
function plaintextPacket(value: Packet, pods: Set<string>, depth = 0): boolean {
  if (pods.has(value.source) || pods.has(value.destination)) return true;
  if (depth > 2) blocked("capture_encapsulation_inconclusive");
  let inner: Buffer | undefined;
  if (value.protocol === 4 || value.protocol === 41) {
    const ethernet = Buffer.alloc(14);
    ethernet.writeUInt16BE(value.protocol === 4 ? 0x0800 : 0x86dd, 12);
    inner = Buffer.concat([ethernet, value.transport]);
  } else if (value.protocol === 17 && value.transport.length >= 8) {
    const udp = value.transport,
      ports = [udp.readUInt16BE(0), udp.readUInt16BE(2)];
    if (ports.includes(6081)) blocked("capture_encapsulation_unsupported");
    if (ports.some((port) => [8472, 4789].includes(port))) {
      if (udp.length < 16 || udp.readUInt16BE(4) !== udp.length || udp[8] !== 8)
        blocked("capture_encapsulation_inconclusive");
      inner = udp.subarray(16);
    }
  }
  if (!inner) return false;
  const decoded = packet(inner, value.at);
  if (!decoded) blocked("capture_encapsulation_inconclusive");
  return plaintextPacket(decoded, pods, depth + 1);
}
export function packetEvidence(
  bytes: Buffer,
  stderr: string,
  source: string,
  peers: PeerBinding[],
  podAddresses: string[],
  startedAt: string,
  finishedAt: string,
) {
  if (bytes.length < 24 || bytes.length > 32 * 1024 * 1024)
    blocked("capture_bytes");
  const magic = bytes.subarray(0, 4).toString("hex"),
    little = ["d4c3b2a1", "4d3cb2a1"].includes(magic),
    nano = ["4d3cb2a1", "a1b23c4d"].includes(magic);
  if (!["d4c3b2a1", "a1b2c3d4", "4d3cb2a1", "a1b23c4d"].includes(magic))
    blocked("capture_format_unsupported");
  const u32 = (offset: number) =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const u16 = (offset: number) =>
    little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  if (u16(4) !== 2 || u16(6) !== 4 || u32(20) !== 1)
    blocked("capture_link_unsupported");
  const pods = new Set(podAddresses.map(ip)),
    counts = new Map(peers.map((peer) => [ip(peer.address), 0]));
  let offset = 24,
    total = 0,
    plaintext = 0,
    latest = Date.parse(startedAt);
  while (offset < bytes.length) {
    if (offset + 16 > bytes.length) blocked("capture_truncated");
    const length = u32(offset + 8),
      original = u32(offset + 12),
      fraction = u32(offset + 4);
    if (
      length !== original ||
      length > 1024 * 1024 ||
      offset + 16 + length > bytes.length ||
      fraction >= (nano ? 1e9 : 1e6)
    )
      blocked("capture_truncated");
    const at = u32(offset) * 1000 + fraction / (nano ? 1e6 : 1000);
    if (at < Date.parse(startedAt) - 1000 || at > Date.parse(finishedAt) + 1000)
      blocked("capture_stale");
    const parsed = packet(
      bytes.subarray(offset + 16, offset + 16 + length),
      at,
    );
    total++;
    offset += 16 + length;
    latest = Math.max(latest, at);
    if (!parsed) continue;
    if (plaintextPacket(parsed, pods)) plaintext++;
    if (parsed.protocol !== 17 || parsed.transport.length < 40) continue;
    const udp = parsed.transport;
    if (
      udp.readUInt16BE(4) !== udp.length ||
      udp.readUInt32LE(8) !== 4 ||
      ![udp.readUInt16BE(0), udp.readUInt16BE(2)].includes(51871)
    )
      continue;
    for (const peer of counts.keys())
      if (
        (parsed.source === ip(source) && parsed.destination === peer) ||
        (parsed.destination === ip(source) && parsed.source === peer)
      )
        counts.set(peer, counts.get(peer)! + 1);
  }
  const stats =
    /(?:^|\n)(\d+) packets? captured\n(\d+) packets? received by filter\n(\d+) packets? dropped by kernel(?:\n|$)/.exec(
      stderr,
    );
  if (
    !stats ||
    Number(stats[1]) !== total ||
    Number(stats[2]) < total ||
    Number(stats[3]) !== 0
  )
    blocked("capture_loss_or_unproven");
  if (plaintext !== 0) blocked("plaintext_pod_traffic");
  return peers.map((peer) => {
    const encrypted_packets = counts.get(ip(peer.address)) ?? 0;
    if (!encrypted_packets) blocked("encrypted_traffic_missing");
    return {
      peer,
      captured_at: new Date(Math.ceil(latest)).toISOString(),
      encrypted_packets,
      plaintext_pod_packets: 0 as const,
    };
  });
}
export async function capturePackets(
  command: ReviewedCommand,
  traffic: ReviewedCommand,
  device: string,
  durationMs: number,
  deadline: number,
) {
  // Unfiltered full packets are necessary to make zero plaintext meaningful.
  if (
    basename(command.program) !== "tcpdump" ||
    JSON.stringify(command.args) !==
      JSON.stringify(["-i", device, "-s", "0", "-U", "-w", "-", "-n"]) ||
    !/^[A-Za-z0-9_.-]{1,32}$/.test(device) ||
    durationMs < 1000 ||
    durationMs > 30000 ||
    deadline - Date.now() < durationMs + 3000
  )
    blocked("capture_command_unreviewed");
  const started_at = new Date().toISOString();
  const capture = execute(
    command,
    Math.min(deadline, Date.now() + durationMs + 2000),
    { stopAfterMs: durationMs },
  );
  const exercise = execute(
    traffic,
    Math.min(deadline, Date.now() + durationMs),
  );
  const results = await Promise.allSettled([capture, exercise]);
  if (results[0]!.status !== "fulfilled" || results[1]!.status !== "fulfilled")
    blocked("capture_or_traffic_failed");
  return {
    ...results[0]!.value,
    started_at,
    finished_at: new Date().toISOString(),
  };
}
export function assertPodAddress(value: string): string {
  if (!isIP(value)) blocked("pod_address_invalid");
  return ip(value);
}
