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

export function redactKnownCredentials(
  source: string,
  credentials: readonly string[],
): string {
  let result = source;
  for (const credential of credentials)
    if (credential) result = result.replaceAll(credential, "[credential]");
  return result;
}
