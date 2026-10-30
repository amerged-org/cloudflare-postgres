// SPDX-License-Identifier: Apache-2.0
export type WebhookUrlRefusal =
  | "malformed"
  | "not_https"
  | "credentials"
  | "too_long"
  | "bad_port"
  | "ip_literal"
  | "reserved_host";

export type WebhookUrlCheck =
  { ok: true; url: URL } | { ok: false; reason: WebhookUrlRefusal };

const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;
const ALLOWED_PORTS: ReadonlySet<string> = new Set(["", "8443"]);
const RESERVED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".localdomain",
  ".corp",
  ".intranet",
  ".private",
];

/**
 * Accepts only an https URL whose host is a DNS name. A public DNS name that resolves to a private
 * address is not detectable here; the delivery path has to decide that at connection time.
 */
export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  const refuse = (reason: WebhookUrlRefusal): WebhookUrlCheck => ({
    ok: false,
    reason,
  });
  if (raw.length > MAX_URL_LENGTH) return refuse("too_long");
  if (raw === "" || raw !== raw.trim()) return refuse("malformed");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("malformed");
  }
  if (url.hash !== "") return refuse("malformed");
  if (url.protocol !== "https:") return refuse("not_https");
  if (url.username !== "" || url.password !== "") return refuse("credentials");
  if (!ALLOWED_PORTS.has(url.port)) return refuse("bad_port");

  // A trailing dot names the same DNS host; it is removed so that the host compares and stores
  // as one name.
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") || /^[0-9.]+$/.test(host))
    return refuse("ip_literal");
  if (
    host === "localhost" ||
    RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    !host.includes(".") ||
    host.split(".").some((label) => label === "") ||
    host.length > MAX_HOST_LENGTH
  )
    return refuse("reserved_host");
  url.hostname = host;
  return { ok: true, url };
}
