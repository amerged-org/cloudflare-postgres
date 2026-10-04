// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, OperationId, RegionId } from "./ids.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
import type { RouteKeyring } from "./route-token.ts";

export const GATEWAY_CONTROL_PATH_PREFIX = "/_pgcf/gateway/";
export const GATEWAY_CONTROL_HEADER = "X-PGCF-Control";
export const GATEWAY_CONTROL_MAX_LENGTH = 1024;
export const GATEWAY_RETIRE_HOLD_MS = 65_000;
export const GATEWAY_FENCE_NAMESPACE = "pgcf-system";
export const GATEWAY_FENCE_LABEL = "pgcf.io/gateway-fence";
export const GATEWAY_FENCE_SELECTOR = `${GATEWAY_FENCE_LABEL}=true`;
export const gatewayPodUidSchema = z.uuid();
export const gatewayControlActionSchema = z.enum([
  "begin",
  "status",
  "close",
  "release",
  "retire",
]);
export type GatewayControlAction = z.infer<typeof gatewayControlActionSchema>;
/** Regional execution intent published from Cloudflare desired state; retain the running revision after resume. */
export const gatewayIntentSchema = z.strictObject({
  database: DatabaseId,
  operation: OperationId,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["quiesce", "running", "retired"]),
});
export type GatewayIntent = z.infer<typeof gatewayIntentSchema>;
export const gatewayControlClaimsSchema = z.strictObject({
  v: z.literal(1),
  region: RegionId,
  database: DatabaseId,
  operation: OperationId,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pod: gatewayPodUidSchema,
  action: gatewayControlActionSchema,
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type GatewayControlClaims = z.infer<typeof gatewayControlClaimsSchema>;
export const gatewayControlReportSchema = gatewayIntentSchema
  .extend({
    pod: gatewayPodUidSchema,
    status: z.enum(["idle", "busy", "closed", "running", "retired"]),
    connections: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    busyConnections: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    pendingDials: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (report) =>
      report.mode === "retired"
        ? report.status === "retired" &&
          report.connections === 0 &&
          report.busyConnections === 0 &&
          report.pendingDials === 0
        : report.status !== "retired",
    { message: "Retirement requires zero database sessions" },
  );
export type GatewayControlReport = z.infer<typeof gatewayControlReportSchema>;
export const gatewayFenceName = (database: string): string =>
  `gateway-fence-${DatabaseId.parse(database)}`;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const signingPurpose = "pgcf-gateway-control/v1\n";
const keyPurpose = "pgcf-gateway-control-key/v1\n";
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(value)),
  );
}
export async function signGatewayControl(input: {
  /** Existing DERIVED regional route keyring, never the master keyring. */
  keyring: RouteKeyring;
  region: string;
  database: string;
  operation: string;
  revision: number;
  pod: string;
  action: GatewayControlAction;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl = input.ttlSeconds ?? 30;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30)
    throw new Error("invalid control lifetime");
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0)
    throw new Error("invalid control clock");
  const key = input.keyring.keys.get(input.keyring.active);
  if (!key || key.length < 32) throw new Error("control key unavailable");
  const iat = Math.floor(now / 1000);
  const claims = gatewayControlClaimsSchema.parse({
    v: 1,
    region: input.region,
    database: input.database,
    operation: input.operation,
    revision: input.revision,
    pod: input.pod,
    action: input.action,
    kid: input.keyring.active,
    iat,
    exp: iat + ttl,
  });
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmac(
    await hmac(key, keyPurpose),
    signingPurpose + payload,
  );
  return `gc1.${payload}.${bytesToBase64url(signature)}`;
}
export async function verifyGatewayControl(
  value: unknown,
  expected: {
    keys: ReadonlyMap<string, Uint8Array>;
    region: string;
    pod: string;
    action: GatewayControlAction;
    now?: number;
  },
): Promise<{ ok: true; claims: GatewayControlClaims } | { ok: false }> {
  try {
    if (typeof value !== "string" || value.length > GATEWAY_CONTROL_MAX_LENGTH)
      return { ok: false };
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "gc1") return { ok: false };
    const bytes = base64urlToBytes(parts[1]!),
      signature = base64urlToBytes(parts[2]!);
    if (
      !bytes ||
      !signature ||
      signature.length !== 32 ||
      bytesToBase64url(signature) !== parts[2]
    )
      return { ok: false };
    const parsed = gatewayControlClaimsSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    if (!parsed.success) return { ok: false };
    const claims = parsed.data,
      key = expected.keys.get(claims.kid);
    if (!key || key.length < 32) return { ok: false };
    const wanted = await hmac(
      await hmac(key, keyPurpose),
      signingPurpose + parts[1],
    );
    let difference = 0;
    for (let index = 0; index < 32; index++)
      difference |= wanted[index]! ^ signature[index]!;
    const now = (expected.now ?? Date.now()) / 1000;
    if (
      difference !== 0 ||
      !Number.isFinite(now) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 30 ||
      now < claims.iat ||
      now > claims.exp ||
      claims.region !== expected.region ||
      claims.pod !== expected.pod ||
      claims.action !== expected.action
    )
      return { ok: false };
    return { ok: true, claims };
  } catch {
    return { ok: false };
  }
}
