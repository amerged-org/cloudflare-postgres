// SPDX-License-Identifier: Apache-2.0
import { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import { ProviderInstanceId } from "@pgcf/contracts/nodes";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";

const RescueConfiguration = NodeBootstrapInput.shape.rescue
  .pick({ ssh_host_key: true, ssh_host_fingerprint: true })
  .safeExtend({
    user_data: z
      .string()
      .max(32768)
      .regex(/^#cloud-config(?:\r?\n|$)/),
  });
type RescueConfiguration = z.infer<typeof RescueConfiguration>;
interface RescueBinding {
  spec: { rescue_host_fingerprint: string };
  rescue: { ssh_host_key: string; ssh_host_fingerprint: string };
}
const refuse = (): never => {
  throw new ApiError(
    "conflict",
    "Configured rescue host identity is unavailable or mismatched",
  );
};
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Private installation configuration; no key or cloud-config text is returned in diagnostics. */
export async function validateRescueConfiguration(
  env: Pick<Env, "CONTABO_RESCUE_CONFIGURATION">,
  providerInstanceId: string,
  binding?: RescueBinding,
): Promise<RescueConfiguration | undefined> {
  const configured = env.CONTABO_RESCUE_CONFIGURATION;
  if (configured === undefined) return undefined;
  if (
    !ProviderInstanceId.safeParse(providerInstanceId).success ||
    configured.length > 1024 * 1024
  )
    return refuse();
  let map: unknown;
  try {
    map = JSON.parse(configured);
  } catch {
    return refuse();
  }
  if (
    !map ||
    typeof map !== "object" ||
    Array.isArray(map) ||
    !Object.hasOwn(map, providerInstanceId)
  )
    return refuse();
  const parsed = RescueConfiguration.safeParse(
    (map as Record<string, unknown>)[providerInstanceId],
  );
  if (!parsed.success) return refuse();
  const entry = parsed.data;
  if (new TextEncoder().encode(entry.user_data).byteLength > 32768)
    return refuse();
  let blob: Uint8Array;
  try {
    blob = Uint8Array.from(
      atob(entry.ssh_host_key.split(" ")[1]!),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return refuse();
  }
  const keyType = new TextEncoder().encode("ssh-ed25519");
  if (blob.length !== 51 || base64(blob) !== entry.ssh_host_key.split(" ")[1])
    return refuse();
  const lengths = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (
    lengths.getUint32(0) !== keyType.length ||
    lengths.getUint32(15) !== 32 ||
    !keyType.every((byte, index) => blob[4 + index] === byte)
  )
    return refuse();
  const fingerprint = `SHA256:${base64(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(blob)))).replaceAll("=", "")}`;
  if (
    entry.ssh_host_fingerprint !== fingerprint ||
    (binding &&
      (binding.spec.rescue_host_fingerprint !== fingerprint ||
        binding.rescue.ssh_host_fingerprint !== fingerprint ||
        binding.rescue.ssh_host_key !== entry.ssh_host_key))
  )
    return refuse();
  return entry;
}
