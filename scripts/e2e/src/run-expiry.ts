// SPDX-License-Identifier: Apache-2.0
export function runActive(
  expiresAt: string | undefined,
  now = Date.now(),
): boolean {
  if (typeof expiresAt !== "string" || !Number.isFinite(now)) return false;
  const expiry = Date.parse(expiresAt);
  return (
    Number.isFinite(expiry) &&
    new Date(expiry).toISOString() === expiresAt &&
    expiry > now &&
    expiry - now <= 86_400_000
  );
}
