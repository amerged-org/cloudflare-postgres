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

export interface WebhookUrlOptions {
  readonly blockedHosts?: readonly string[];
  readonly blockedSuffixes?: readonly string[];
}

export interface WebhookUrlEnv {
  readonly NODE_API_ORIGIN?: string;
  readonly DB_ENDPOINT_HOST?: string;
  readonly NODE_GATEWAY_DOMAIN?: string;
  readonly ARCHIVE_ENDPOINT_URL?: string;
  readonly INFRASTRUCTURE_ALERT_WEBHOOK_URL?: string;
}

const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;
const ALLOWED_PORTS: ReadonlySet<string> = new Set(["", "8443"]);
const RESERVED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".arpa",
  ".invalid",
  ".localdomain",
  ".corp",
  ".intranet",
  ".private",
  ".cfargotunnel.com",
  ".r2.cloudflarestorage.com",
  ".r2.dev",
];

function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function hostFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const host = normalizeHost(new URL(raw).hostname);
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** Collects deployment-internal hosts and domains that no customer webhook may target. */
export function webhookUrlOptions(
  env: WebhookUrlEnv,
  requestUrl?: string,
): WebhookUrlOptions {
  const blockedHosts = new Set<string>();
  const blockedSuffixes = new Set<string>();
  for (const candidate of [
    hostFromUrl(env.NODE_API_ORIGIN),
    hostFromUrl(env.ARCHIVE_ENDPOINT_URL),
    hostFromUrl(env.INFRASTRUCTURE_ALERT_WEBHOOK_URL),
    hostFromUrl(requestUrl),
  ]) {
    if (candidate) blockedHosts.add(candidate);
  }
  if (env.DB_ENDPOINT_HOST) {
    const host = normalizeHost(env.DB_ENDPOINT_HOST);
    if (host) blockedHosts.add(host);
  }
  if (env.NODE_GATEWAY_DOMAIN) {
    const domain = normalizeHost(env.NODE_GATEWAY_DOMAIN);
    if (domain) {
      blockedHosts.add(domain);
      blockedSuffixes.add(`.${domain}`);
    }
  }
  return {
    blockedHosts: [...blockedHosts],
    blockedSuffixes: [...blockedSuffixes],
  };
}

/**
 * Accepts only an https URL whose host is a DNS name. Literal IP addresses, localhost, reserved
 * names, Cloudflare tunnel/R2 hosts and the installation's own control-plane/gateway hosts are
 * refused here, at create and at delivery. A public DNS name that resolves to a private address is
 * not detectable here, and nothing in the delivery path resolves it: the Worker's
 * `global_fetch_strictly_public` flag makes the runtime refuse such a destination at connection time.
 */
export function checkWebhookUrl(
  raw: string,
  options?: WebhookUrlOptions,
): WebhookUrlCheck {
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
  const host = normalizeHost(url.hostname);
  if (host.startsWith("[") || /^[0-9.]+$/.test(host))
    return refuse("ip_literal");
  const blockedHosts = options?.blockedHosts?.map(normalizeHost) ?? [];
  const blockedSuffixes =
    options?.blockedSuffixes?.map((suffix) =>
      suffix.startsWith(".")
        ? `.${normalizeHost(suffix.slice(1))}`
        : `.${normalizeHost(suffix)}`,
    ) ?? [];
  if (
    host === "localhost" ||
    RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    blockedHosts.includes(host) ||
    blockedSuffixes.some((suffix) => host.endsWith(suffix)) ||
    !host.includes(".") ||
    host.split(".").some((label) => label === "") ||
    host.length > MAX_HOST_LENGTH
  )
    return refuse("reserved_host");
  url.hostname = host;
  return { ok: true, url };
}
