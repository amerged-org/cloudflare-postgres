// SPDX-License-Identifier: Apache-2.0
// Decryption finishes before this final authority snapshot. Its first query is
// primary; no previous session bookmark can hide a sibling revocation/rotation.
export async function plaintextFence(
  database: D1Database,
  sql: string,
  bindings: Array<string | number | null>,
  leased = false,
): Promise<boolean> {
  const started = performance.now();
  let row: { serverNow?: unknown; leaseExpiresAt?: unknown } | null;
  try {
    row = await database
      .withSession("first-primary")
      .prepare(sql)
      .bind(...bindings)
      .first<typeof row>();
  } catch {
    return false;
  }
  if (!row) return false;
  if (!leased) return true;
  const elapsed = performance.now() - started;
  if (
    typeof row.serverNow !== "string" ||
    typeof row.leaseExpiresAt !== "string"
  )
    return false;
  const observed = Date.parse(row.serverNow),
    expiry = Date.parse(row.leaseExpiresAt);
  if (
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(expiry) ||
    new Date(observed).toISOString() !== row.serverNow ||
    new Date(expiry).toISOString() !== row.leaseExpiresAt ||
    !Number.isFinite(elapsed) ||
    elapsed < 0
  )
    return false;
  // Both compared values are read from D1; this final disclosure check never
  // converts Worker wall time to authority. Existing lease issuance is unchanged.
  // Round awaited query time up and reserve one millisecond for clock precision.
  // This bounds observed query delay, not later CPU/scheduling/network delivery.
  return expiry - observed > Math.ceil(elapsed) + 1;
}
