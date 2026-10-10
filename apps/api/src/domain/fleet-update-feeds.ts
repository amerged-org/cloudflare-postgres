// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { bytesToHex } from "@pgcf/contracts";
import {
  FleetUpdateAdvisory,
  FleetUpdateFacts,
  FleetUpdateVersion,
  type FleetUpdateComponent,
} from "@pgcf/contracts/fleet-updates";

/** Fixed upstream identities. Release text can never add a source or executable command. */
export const FLEET_UPDATE_SOURCES = {
  talos: "siderolabs/talos",
  kubernetes: "kubernetes/kubernetes",
  postgres: null,
  "flux-source": "fluxcd/source-controller",
  "flux-kustomize": "fluxcd/kustomize-controller",
  "flux-helm": "fluxcd/helm-controller",
  "flux-notification": "fluxcd/notification-controller",
  cilium: "cilium/cilium",
  "cert-manager": "cert-manager/cert-manager",
  "cloudnative-pg": "cloudnative-pg/cloudnative-pg",
  "plugin-barman-cloud": "cloudnative-pg/plugin-barman-cloud",
  // The release's logical barman pin is the CNPG plugin sidecar, not Python Barman's package version.
  barman: "cloudnative-pg/plugin-barman-cloud",
  "openebs-lvm": "openebs/lvm-localpv",
  cloudflared: "cloudflare/cloudflared",
} as const satisfies Record<FleetUpdateComponent, string | null>;
const MAX_BYTES = 256 * 1024;
const Release = z.object({
  id: z.number().int().positive(),
  tag_name: z.string().max(128),
  html_url: z.string().max(512),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.iso.datetime().nullable(),
  body: z
    .string()
    .max(128 * 1024)
    .nullable(),
});
const Advisory = z.object({
  ghsa_id: FleetUpdateAdvisory.shape.id,
  severity: z.enum(["low", "medium", "high", "critical"]).nullable(),
  published_at: z.iso.datetime(),
  vulnerabilities: z
    .array(
      z.object({
        vulnerable_version_range: z.string().max(256).nullable(),
        patched_versions: z.string().max(64).nullable().optional(),
      }),
    )
    .max(50),
});

export async function fleetUpdateSha256(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

async function boundedText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const advertised = response.headers.get("Content-Length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BYTES)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("upstream_response_too_large");
  }
  if (!response.body) throw new Error("upstream_response_missing");
  const reader = response.body.getReader(),
    bytes = new Uint8Array(MAX_BYTES);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw new Error("upstream_timeout");
      if (part.done) break;
      if (length + part.value.byteLength > MAX_BYTES)
        throw new Error("upstream_response_too_large");
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    bytes.subarray(0, length),
  );
}

async function readOfficial(
  url: string,
  request: typeof fetch,
): Promise<string> {
  const abort = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Covers fetch AND streamed body; abort alone need not settle an arbitrary fetch implementation.
    return await Promise.race([
      (async () => {
        const response = await request(url, {
          redirect: "manual",
          signal: abort.signal,
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "pgcf-fleet-updates",
            "X-GitHub-Api-Version": "2026-03-10",
          },
        });
        if (expired) {
          void response.body?.cancel().catch(() => {});
          throw new Error("upstream_timeout");
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error("upstream_unavailable");
        }
        return boundedText(response, abort.signal);
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          abort.abort();
          reject(new Error("upstream_timeout"));
        }, 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readFleetUpdateFeed(
  component: FleetUpdateComponent,
  now: number,
  request: typeof fetch = fetch,
): Promise<FleetUpdateFacts[]> {
  const observed = new Date(now).toISOString(),
    repository = FLEET_UPDATE_SOURCES[component];
  if (repository === null) {
    const text = await readOfficial(
      "https://www.postgresql.org/versions.rss",
      request,
    );
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw new Error("upstream_feed_invalid");
    const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    if (!items.length || items.length > 64)
      throw new Error("upstream_feed_invalid");
    const facts: FleetUpdateFacts[] = [];
    for (const [, item] of items.slice(0, 20)) {
      const field = (name: string) =>
        new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`)
          .exec(item!)?.[1]
          ?.trim();
      const version = field("title"),
        description = field("description"),
        date = field("pubDate"),
        link = field("link");
      if (
        !version ||
        !/^\d+\.\d+$/.test(version) ||
        !date ||
        !description ||
        description.includes("unsupported")
      )
        continue;
      const url = `https://www.postgresql.org/docs/${version.split(".")[0]}/release-${version.replaceAll(".", "-")}.html`;
      if (link !== url || !Number.isFinite(Date.parse(date)))
        throw new Error("upstream_feed_invalid");
      facts.push(
        FleetUpdateFacts.parse({
          source: component,
          release_id: version,
          version,
          url,
          source_text_sha256: await fleetUpdateSha256(description),
          published_at: new Date(date).toISOString(),
          observed_at: observed,
          advisories: [],
          advisory_status: "not_provided",
        }),
      );
    }
    return facts;
  }
  const prefix = `https://api.github.com/repos/${repository}`;
  const [releaseResult, advisoryResult] = await Promise.allSettled([
    readOfficial(`${prefix}/releases?per_page=20`, request),
    readOfficial(`${prefix}/security-advisories?per_page=20`, request),
  ]);
  if (releaseResult.status === "rejected") throw releaseResult.reason;
  const releases = z
    .array(Release)
    .max(20)
    .parse(JSON.parse(releaseResult.value));
  const advisories: z.infer<typeof FleetUpdateAdvisory>[] = [];
  let advisoryStatus: FleetUpdateFacts["advisory_status"] = "unavailable";
  if (advisoryResult.status === "fulfilled") {
    // An invalid advisory response is unknown, never a clean bill of health.
    let input: unknown;
    try {
      input = JSON.parse(advisoryResult.value);
    } catch {
      input = null;
    }
    const parsed = z.array(Advisory).max(20).safeParse(input);
    if (parsed.success) {
      advisoryStatus = "observed";
      for (const advisory of parsed.data)
        advisories.push(
          FleetUpdateAdvisory.parse({
            id: advisory.ghsa_id,
            severity: advisory.severity ?? "unknown",
            published_at: advisory.published_at,
            affected_version_range:
              advisory.vulnerabilities.length === 1
                ? advisory.vulnerabilities[0]!.vulnerable_version_range
                : null,
            first_patched_version:
              advisory.vulnerabilities.length === 1
                ? (advisory.vulnerabilities[0]!.patched_versions ?? null)
                : null,
          }),
        );
    }
  }
  const facts: FleetUpdateFacts[] = [];
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, "");
    if (
      release.draft ||
      release.prerelease ||
      !release.published_at ||
      !FleetUpdateVersion.safeParse(version).success
    )
      continue;
    const url = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
    if (
      release.html_url !== url ||
      Date.parse(release.published_at) > now + 5000
    )
      throw new Error("upstream_feed_invalid");
    facts.push(
      FleetUpdateFacts.parse({
        source: component,
        release_id: String(release.id),
        version,
        url,
        source_text_sha256: await fleetUpdateSha256(release.body ?? ""),
        published_at: release.published_at,
        observed_at: observed,
        advisories,
        advisory_status: advisoryStatus,
      }),
    );
  }
  return facts;
}
