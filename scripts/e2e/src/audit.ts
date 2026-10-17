// SPDX-License-Identifier: Apache-2.0
export function credentialOccurrences(
  secret: string,
  sources: readonly string[],
): number {
  if (!secret) throw new Error("empty_audit_credential");
  return sources.reduce(
    (sum, source) => sum + source.split(secret).length - 1,
    0,
  );
}
