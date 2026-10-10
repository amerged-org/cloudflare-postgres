// SPDX-License-Identifier: Apache-2.0
// https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations
export function workerScanUnsupported(port: number, message = ""): boolean {
  return (
    port === 25 ||
    /TCP Loop|not allowed|disallowed|unsupported|prohibited|too many|limit exceeded|proxy request failed, cannot connect/i.test(
      message,
    )
  );
}

/** Keep standardized transport facts; exception text can contain connection credentials. */
export function safeProbeError(error: unknown): {
  error_class: string;
  sqlstate: string | null;
  errno: string | null;
} {
  const value = error as { name?: unknown; code?: unknown } | null;
  const name = value?.name;
  const code = value?.code;
  return {
    error_class:
      typeof name === "string" &&
      [
        "Error",
        "DatabaseError",
        "TypeError",
        "AbortError",
        "TimeoutError",
      ].includes(name)
        ? name
        : "unknown",
    sqlstate:
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null,
    errno:
      typeof code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENETUNREACH",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENOTFOUND",
      ].includes(code)
        ? code
        : null,
  };
}
