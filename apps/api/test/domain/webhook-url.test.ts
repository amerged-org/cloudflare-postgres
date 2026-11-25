// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  checkWebhookUrl,
  webhookUrlOptions,
} from "../../src/domain/webhook-url.ts";

function outcome(
  raw: string,
  options?: Parameters<typeof checkWebhookUrl>[1],
): string {
  const check = checkWebhookUrl(raw, options);
  return check.ok ? "ok" : check.reason;
}

function normalized(raw: string): string | undefined {
  const check = checkWebhookUrl(raw);
  return check.ok ? check.url.href : undefined;
}

it("accepts https DNS names on port 443 or 8443 and normalizes the host", () => {
  expect(outcome("https://hooks.example.com/path?x=1")).toBe("ok");
  expect(normalized("https://hooks.example.com/path?x=1")).toBe(
    "https://hooks.example.com/path?x=1",
  );
  expect(normalized("https://hooks.example.com:8443/h")).toBe(
    "https://hooks.example.com:8443/h",
  );
  expect(normalized("https://hooks.example.com:443/h")).toBe(
    "https://hooks.example.com/h",
  );
  expect(normalized("https://hooks.example.com./")).toBe(
    "https://hooks.example.com/",
  );
});

it("refuses URLs that are not a plain https DNS URL with an allowed port", () => {
  expect(outcome("http://hooks.example.com/")).toBe("not_https");
  expect(outcome("https://user:secret@hooks.example.com/")).toBe("credentials");
  expect(outcome("https://user@hooks.example.com/")).toBe("credentials");
  expect(outcome("https://:pw@hooks.example.com/")).toBe("credentials");
  expect(outcome("https://hooks.example.com:8080/")).toBe("bad_port");
  expect(outcome("https://hooks.example.com:80/")).toBe("bad_port");
  expect(outcome("https://hooks.example.com/h#fragment")).toBe("malformed");
  expect(outcome(" https://hooks.example.com/")).toBe("malformed");
});

it("accepts a 2048-character URL and refuses a 2049-character one", () => {
  expect(outcome("https://hooks.example.com/".padEnd(2048, "a"))).toBe("ok");
  expect(outcome("https://hooks.example.com/".padEnd(2049, "a"))).toBe(
    "too_long",
  );
});

it("refuses IP literals and reserved or single-label hosts", () => {
  expect(outcome("https://127.0.0.1/")).toBe("ip_literal");
  expect(outcome("https://[::1]/")).toBe("ip_literal");
  expect(outcome("https://0x7f.1/")).toBe("ip_literal");
  expect(outcome("https://2130706433/")).toBe("ip_literal");
  expect(outcome("https://169.254.169.254/")).toBe("ip_literal");
  expect(outcome("https://localhost/")).toBe("reserved_host");
  expect(outcome("https://a.localhost/")).toBe("reserved_host");
  expect(outcome("https://intranet/")).toBe("reserved_host");
  expect(outcome("https://x.internal/")).toBe("reserved_host");
  expect(outcome("https://a..example.com/")).toBe("reserved_host");
  expect(outcome("https://hooks.example.com../")).toBe("reserved_host");
  const label = "a".repeat(63);
  expect(outcome(`https://${label}.${label}.${label}.${"a".repeat(61)}/`)).toBe(
    "ok",
  );
  expect(outcome(`https://${label}.${label}.${label}.${"a".repeat(62)}/`)).toBe(
    "reserved_host",
  );
  for (const platform of [
    "https://tunnel.cfargotunnel.com/hook",
    "https://acct.r2.cloudflarestorage.com/bucket",
    "https://pub-123.r2.dev/hook",
    "https://1.0.0.127.in-addr.arpa/hook",
    "https://api.invalid/hook",
  ])
    expect(outcome(platform), platform).toBe("reserved_host");
});

it("refuses deployment-internal control-plane, database, gateway and archive hosts", () => {
  const options = webhookUrlOptions(
    {
      NODE_API_ORIGIN: "https://api.pgcf.example.org",
      DB_ENDPOINT_HOST: "db.pgcf.example.org",
      NODE_GATEWAY_DOMAIN: "gw.pgcf.example.org",
      ARCHIVE_ENDPOINT_URL: "https://archive.pgcf.example.org",
      INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://alerts.pgcf.example.org/hook",
    },
    "https://self.pgcf.example.org/v1/webhooks",
  );
  for (const internal of [
    "https://api.pgcf.example.org/v1/projects",
    "https://db.pgcf.example.org/sql",
    "https://gw.pgcf.example.org/sql",
    "https://pgcf-gw-1.gw.pgcf.example.org/sql",
    "https://archive.pgcf.example.org/x",
    "https://alerts.pgcf.example.org/hook",
    "https://self.pgcf.example.org/v1/webhooks",
  ])
    expect(outcome(internal, options), internal).toBe("reserved_host");
  expect(outcome("https://hooks.customer.example.org/pgcf", options)).toBe(
    "ok",
  );
});
