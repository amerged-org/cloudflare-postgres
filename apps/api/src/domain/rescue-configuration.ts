// SPDX-License-Identifier: Apache-2.0
import { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import { ProviderInstanceId } from "@pgcf/contracts/nodes";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { installationRescueBinding } from "./node-installation.ts";

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
  env: Pick<Env, "CONTABO_RESCUE_CONFIGURATION"> &
    Partial<Pick<Env, "DB" | "CREDENTIAL_KEYS">>,
  providerInstanceId: string,
  binding?: RescueBinding,
): Promise<RescueConfiguration | undefined> {
  let configured = env.CONTABO_RESCUE_CONFIGURATION;
  const saved =
    env.DB && env.CREDENTIAL_KEYS
      ? await installationRescueBinding(
          { DB: env.DB, CREDENTIAL_KEYS: env.CREDENTIAL_KEYS },
          providerInstanceId,
        )
      : undefined;
  const stored = saved
    ? {
        ssh_host_key: saved.ssh_host_key,
        ssh_host_fingerprint: saved.ssh_host_fingerprint,
        user_data: saved.user_data,
      }
    : undefined;
  if (stored && configured === undefined)
    configured = JSON.stringify({ [providerInstanceId]: stored });
  else if (stored && configured !== undefined) {
    let map: unknown;
    try {
      map = JSON.parse(configured);
    } catch {
      return refuse();
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) return refuse();
    if (!Object.hasOwn(map, providerInstanceId))
      configured = JSON.stringify({ ...map, [providerInstanceId]: stored });
  }
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
