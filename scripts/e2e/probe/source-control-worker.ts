// SPDX-License-Identifier: Apache-2.0
export const HTTPS_SOURCE_CONTROL_DOMAIN =
  "pgcf-node-https-source-control/v1\n";

export interface SourceControlEnv {
  PROBE_BEARER: string;
  SOURCE_CONTROL_SIGNING_JWK: string;
  SOURCE_CONTROL_KID: string;
  SOURCE_CONTROL_ORIGIN: string;
  RUN_EXPIRES_AT: string;
}

function reply(code: string, status: number): Response {
  return Response.json(
    { code },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function active(expiresAt: string, now = Date.now()): boolean {
  if (typeof expiresAt !== "string") return false;
  const expiry = Date.parse(expiresAt);
  return (
    Number.isFinite(expiry) &&
    new Date(expiry).toISOString() === expiresAt &&
    expiry > now &&
    expiry - now <= 600_000
  );
}

function address(value: string | null): string | undefined {
  if (!value || value.length > 45) return undefined;
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) {
    const octets = value.split(".").map(Number);
    // Cloudflare's Pseudo IPv4 override is not a native client observation.
    return octets.every((octet) => octet <= 255) && octets[0]! < 240
      ? value
      : undefined;
  }
  if (!value.includes(":") || !/^[a-fA-F0-9:]+$/.test(value)) return undefined;
  try {
    return new URL(`https://[${value}]`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

function sourceAddress(request: Request): string | undefined {
  const source = address(request.headers.get("CF-Connecting-IP"));
  if (!source) return undefined;
  if (request.headers.has("CF-Connecting-IPv6")) {
    const ipv6 = address(request.headers.get("CF-Connecting-IPv6"));
    // Never infer the native family from an IPv6 header paired with IPv4.
    if (!source.includes(":") || ipv6 !== source) return undefined;
  }
  return source;
}

async function readNonce(request: Request): Promise<string | Response> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared))
      return reply("invalid_input", 400);
    if (Number(declared) > 128) return reply("input_too_large", 413);
  }
  if (!request.body) return reply("invalid_input", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), 5000);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === "timed_out") {
        // Cancellation acknowledgements must not extend the read deadline.
        void reader.cancel().catch(() => undefined);
        return reply("input_timeout", 408);
      }
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 128) {
        void reader.cancel().catch(() => undefined);
        return reply("input_too_large", 413);
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const match =
      /^[ \t\r\n]*\{[ \t\r\n]*"nonce"[ \t\r\n]*:[ \t\r\n]*"([a-f0-9]{64})"[ \t\r\n]*\}[ \t\r\n]*$/.exec(
        body,
      );
    return match?.[1] ?? reply("invalid_input", 400);
  } catch {
    return reply("invalid_input", 400);
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
}

async function sign(
  payload: {
    nonce: string;
    observed_at: string;
    origin: string;
    source: string;
  },
  env: SourceControlEnv,
): Promise<Response> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(env.SOURCE_CONTROL_KID) ||
    typeof env.SOURCE_CONTROL_SIGNING_JWK !== "string" ||
    env.SOURCE_CONTROL_SIGNING_JWK.length > 4096
  ) {
    return reply("signing_failed", 500);
  }
  try {
    const jwk = JSON.parse(env.SOURCE_CONTROL_SIGNING_JWK) as JsonWebKey;
    if (
      jwk?.kty !== "OKP" ||
      jwk.crv !== "Ed25519" ||
      typeof jwk.d !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(jwk.d) ||
      typeof jwk.x !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)
    ) {
      return reply("signing_failed", 500);
    }
    const key = await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, [
      "sign",
    ]);
    // The fixed payload is constructed in sorted key order for canonical JSON.
    const signature = await crypto.subtle.sign(
      "Ed25519",
      key,
      new TextEncoder().encode(
        HTTPS_SOURCE_CONTROL_DOMAIN + JSON.stringify(payload),
      ),
    );
    if (!active(env.RUN_EXPIRES_AT)) return reply("run_expired", 410);
    const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    return Response.json(
      { kid: env.SOURCE_CONTROL_KID, payload, signature: encoded },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return reply("signing_failed", 500);
  }
}

export default {
  async fetch(request: Request, env: SourceControlEnv): Promise<Response> {
    if (!active(env.RUN_EXPIRES_AT)) return reply("run_expired", 410);
    if (
      typeof env.PROBE_BEARER !== "string" ||
      !env.PROBE_BEARER ||
      env.PROBE_BEARER.length > 256 ||
      request.headers.get("Authorization") !== `Bearer ${env.PROBE_BEARER}`
    ) {
      return reply("unauthorized", 401);
    }
    if (request.headers.has("CF-Worker"))
      return reply("subrequest_refused", 403);
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.origin !== env.SOURCE_CONTROL_ORIGIN ||
      url.username ||
      url.password
    )
      return reply("origin_invalid", 400);
    if (request.method !== "POST") return reply("method_not_allowed", 405);
    if (url.pathname !== "/source-control" || url.search)
      return reply("not_found", 404);
    const source = sourceAddress(request);
    if (!source) return reply("source_unproven", 400);
    const nonce = await readNonce(request);
    if (typeof nonce !== "string") return nonce;
    if (!active(env.RUN_EXPIRES_AT)) return reply("run_expired", 410);
    return sign(
      {
        nonce,
        observed_at: new Date().toISOString(),
        origin: url.origin,
        source,
      },
      env,
    );
  },
};
