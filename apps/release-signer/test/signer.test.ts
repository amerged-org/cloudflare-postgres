// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64url, signedReleaseManifest } from "@pgcf/contracts";
import worker from "../src/index.ts";
import { createSigner, type Env } from "../src/signer.ts";
import {
  COMMIT,
  JWKS_URL,
  POLICY_VARS,
  RELEASE_ID,
  SIGNER_URL,
  claims,
  githubKey,
  jwks,
  releaseKey,
} from "./github.ts";

const github = await githubKey("kid-1");
const release = await releaseKey();
const T0 = Date.parse("2026-10-19T12:00:00Z");

const digest = (letter: string, size_bytes: number) => ({
  sha256: letter.repeat(64),
  size_bytes,
});
const fields = (id = RELEASE_ID) => ({
  id,
  binaries: {
    "pgcf-agent": digest("1", 11_000_000),
    "pgcf-native-gateway": digest("2", 12_000_000),
    "pgcf-archive": digest("3", 5_000_000),
    "pgcf-wal-fetch": digest("4", 5_100_000),
  },
  os: {
    debian_snapshot: "20261016T000000Z",
    package_lock: digest("5", 90_000),
  },
});
/** A copy of `value` with the value at `path` set to `to`, or removed when `to` is undefined. */
function tweak(value: object, path: string[], to?: unknown): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
  if (to === undefined) delete at[path.at(-1)!];
  else at[path.at(-1)!] = to;
  return copy;
}
/** The text the agent verifies, written out here and not built by the contract's function. */
const MANIFEST = [
  "pgcf-release-manifest/v1",
  `release=${RELEASE_ID}`,
  `binary.pgcf-agent=${"1".repeat(64)}:11000000`,
  `binary.pgcf-native-gateway=${"2".repeat(64)}:12000000`,
  `binary.pgcf-archive=${"3".repeat(64)}:5000000`,
  `binary.pgcf-wal-fetch=${"4".repeat(64)}:5100000`,
  "os.debian_snapshot=20261016T000000Z",
  `os.package_lock=${"5".repeat(64)}:90000`,
  "",
].join("\n");

const env = (override: Partial<Env> = {}): Env => ({
  ...POLICY_VARS,
  RELEASE_SIGNING_KEY: release.secret,
  ...override,
});

/** A signer whose clock and whose answer from GitHub the test holds. */
function harness(answer: () => Response = () => Response.json(jwks(github))) {
  const state = { clock: T0, fetched: [] as string[], answer };
  const signer = createSigner({
    fetch: async (input) => {
      state.fetched.push(String(input));
      return state.answer();
    },
    now: () => state.clock,
  });
  return {
    state,
    async post(
      options: {
        token?: string | null;
        body?: unknown;
        raw?: string;
        contentType?: string | null;
        authorization?: string;
        path?: string;
        method?: string;
        env?: Env;
      } = {},
    ) {
      const token =
        options.token === undefined
          ? await github.mint(claims(state.clock))
          : options.token;
      const headers = new Headers();
      if (options.authorization !== undefined)
        headers.set("authorization", options.authorization);
      else if (token !== null) headers.set("authorization", `Bearer ${token}`);
      if (options.contentType !== null)
        headers.set("content-type", options.contentType ?? "application/json");
      const url = options.path
        ? new URL(options.path, SIGNER_URL).href
        : SIGNER_URL;
      return signer.fetch(
        new Request(url, {
          method: options.method ?? "POST",
          headers,
          body:
            options.method === "GET"
              ? undefined
              : (options.raw ??
                JSON.stringify("body" in options ? options.body : fields())),
        }),
        options.env ?? env(),
      );
    },
  };
}
const refusal = async (response: Response) => ({
  status: response.status,
  ...((await response.json()) as { error: string }),
});

afterEach(() => vi.restoreAllMocks());

describe("what it signs", () => {
  it("answers a run of the workflow with the key's signature of the manifest, which the agent's text verifies", async () => {
    const h = harness();
    const response = await h.post();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    // The stored format: 128 lower-case hex digits and a line feed.
    expect(text).toMatch(/^[0-9a-f]{128}\n$/);
    const signature = Uint8Array.from(text.trim().match(/../g)!, (pair) =>
      parseInt(pair, 16),
    );
    const verifies = (manifest: string) =>
      crypto.subtle.verify(
        "Ed25519",
        release.publicKey,
        signature,
        new TextEncoder().encode(manifest),
      );
    expect(await verifies(MANIFEST)).toBe(true);
    expect(signedReleaseManifest(fields())).toBe(MANIFEST);
    // Not the signature of anything else: the domain line is part of what is signed.
    expect(
      await verifies(MANIFEST.replace("pgcf-release-manifest/v1\n", "")),
    ).toBe(false);
    expect(
      await verifies(MANIFEST.replace("1".repeat(64), "9".repeat(64))),
    ).toBe(false);
  });

  it("makes the same signature of the same facts every time, so that it keeps no state to refuse another", async () => {
    // Ed25519 is deterministic: asking again for the same facts gets the same bytes. The signer has
    // no state in which "once" could be counted, so the same token also gets a valid signature of
    // DIFFERENT digests under the same release id: it ties the id to the commit and cannot know
    // whether the digests are the build of that commit. What makes one content the release is where
    // it is registered: the API's 409 goes to whoever registers a release id first, and the nodes
    // check every digest against the signed text.
    const h = harness();
    const first = await (await h.post()).text();
    const second = await (await h.post()).text();
    expect(second).toBe(first);
    const other = fields();
    other.binaries["pgcf-agent"] = digest("9", 11_000_000);
    const token = await github.mint(claims(T0));
    const same = await (await h.post({ token })).text();
    const different = await (await h.post({ token, body: other })).text();
    expect(different).toMatch(/^[0-9a-f]{128}\n$/);
    expect(different).not.toBe(same);
  });

  it("signs only the release of the commit the token names", async () => {
    const h = harness();
    for (const id of [
      "sha-0123456789ac",
      "sha-012345678",
      `sha-${COMMIT.slice(0, 13)}`,
      "v1",
      COMMIT,
    ]) {
      expect(await refusal(await h.post({ body: fields(id) }))).toEqual({
        status: 403,
        error: "release_not_of_commit",
      });
    }
  });

  it("takes the manifest's facts and nothing else, checked strictly", async () => {
    const h = harness();
    const bodies: unknown[] = [
      tweak(fields(), ["extra"], 1),
      tweak(fields(), ["binaries", "pgcf-agent", "url"], "https://x.example/a"),
      tweak(fields(), ["os", "kernel_release"], "6.12.113+deb13-amd64"),
      tweak(fields(), ["os", "package_lock", "md5"], "a".repeat(32)),
      tweak(fields(), ["os"]),
      tweak(fields(), ["binaries", "pgcf-wal-fetch"]),
      tweak(fields(), ["binaries", "pgcf-agent", "sha256"], "A".repeat(64)),
      tweak(fields(), ["binaries", "pgcf-archive", "size_bytes"], 1.5),
      tweak(fields(), ["os", "debian_snapshot"], "20261016\nT000000Z"),
      [],
      null,
      "text",
    ];
    for (const body of bodies)
      expect(await refusal(await h.post({ body }))).toEqual({
        status: 400,
        error: "manifest_invalid",
      });
    expect(await refusal(await h.post({ raw: "{" }))).toEqual({
      status: 400,
      error: "manifest_invalid",
    });
    expect(await refusal(await h.post({ raw: "" }))).toEqual({
      status: 400,
      error: "manifest_invalid",
    });
    // A body of the right shape but too large is not read to its end.
    expect(
      await refusal(
        await h.post({ raw: JSON.stringify(fields()) + " ".repeat(20_000) }),
      ),
    ).toEqual({ status: 413, error: "body_too_large" });
    expect(await refusal(await h.post({ contentType: "text/plain" }))).toEqual({
      status: 415,
      error: "content_type",
    });
    expect(await refusal(await h.post({ contentType: null }))).toEqual({
      status: 415,
      error: "content_type",
    });
    // The charset parameter is allowed.
    expect(
      (await h.post({ contentType: "application/json; charset=utf-8" })).status,
    ).toBe(200);
  });

  it("has one route and nothing else", async () => {
    const h = harness();
    expect(await refusal(await h.post({ path: "/" }))).toEqual({
      status: 404,
      error: "not_found",
    });
    expect(await refusal(await h.post({ path: "/sign/" }))).toEqual({
      status: 404,
      error: "not_found",
    });
    const get = await h.post({ method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    // The deployed entry point answers the same way and takes no other route.
    const entry = await worker.fetch(
      new Request("https://signer.example/other", { method: "POST" }),
      env(),
    );
    expect(entry.status).toBe(404);
    // Nothing was asked of GitHub for a route that is not the route.
    expect(h.state.fetched).toEqual([]);
  });
});

describe("who may ask", () => {
  const cases: [string, Record<string, unknown>, number, string][] = [
    [
      "another audience",
      { aud: "https://other.example" },
      401,
      "token_audience",
    ],
    ["no audience", { aud: undefined }, 401, "token_audience"],
    [
      "an audience list",
      { aud: ["https://signer.example"] },
      401,
      "token_audience",
    ],
    ["another issuer", { iss: "https://issuer.example" }, 401, "token_issuer"],
    [
      "another repository",
      { repository: "example-org/other-repo" },
      403,
      "claim_repository",
    ],
    [
      "another owner",
      { repository_owner: "other-org" },
      403,
      "claim_repository_owner",
    ],
    // Names are freed by a rename, a transfer or a deletion, and whoever then takes the name of
    // the repository gets a token with the right names and other ids: GitHub's numeric ids do not
    // move with a name.
    [
      "the repository's name under another repository id",
      { repository_id: "999999" },
      403,
      "claim_repository_id",
    ],
    [
      "the owner's name under another owner id",
      { repository_owner_id: "999999" },
      403,
      "claim_repository_owner_id",
    ],
    [
      "no repository id",
      { repository_id: undefined },
      403,
      "claim_repository_id",
    ],
    [
      "no owner id",
      { repository_owner_id: undefined },
      403,
      "claim_repository_owner_id",
    ],
    [
      "the repository id as a number",
      { repository_id: 424242 },
      403,
      "claim_repository_id",
    ],
    ["another ref", { ref: "refs/heads/feature" }, 403, "claim_ref"],
    ["a pull request's ref", { ref: "refs/pull/7/merge" }, 403, "claim_ref"],
    ["another event", { event_name: "pull_request" }, 403, "claim_event_name"],
    [
      "a dispatched run",
      { event_name: "workflow_dispatch" },
      403,
      "claim_event_name",
    ],
    [
      "another workflow file",
      {
        job_workflow_ref:
          "example-org/example-repo/.github/workflows/other.yml@refs/heads/main",
      },
      403,
      "claim_job_workflow_ref",
    ],
    [
      "the workflow at another ref",
      {
        job_workflow_ref:
          "example-org/example-repo/.github/workflows/ci.yml@refs/heads/feature",
      },
      403,
      "claim_job_workflow_ref",
    ],
    [
      "a workflow of another repository",
      {
        job_workflow_ref:
          "other-org/example-repo/.github/workflows/ci.yml@refs/heads/main",
      },
      403,
      "claim_job_workflow_ref",
    ],
    [
      "a self-hosted runner",
      { runner_environment: "self-hosted" },
      403,
      "claim_runner_environment",
    ],
    [
      "no runner environment",
      { runner_environment: undefined },
      403,
      "claim_runner_environment",
    ],
    ["no commit", { sha: undefined }, 403, "claim_sha"],
    [
      "a commit that is not 40 hex digits",
      { sha: COMMIT.slice(0, 12) },
      403,
      "claim_sha",
    ],
  ];
  it.each(cases)("refuses %s", async (_name, override, status, error) => {
    const h = harness();
    const token = await github.mint(claims(T0, override));
    expect(await refusal(await h.post({ token }))).toEqual({ status, error });
  });

  it("accepts the right claims and refuses a token that is expired, not yet valid or without a time", async () => {
    const h = harness();
    const seconds = Math.floor(T0 / 1000);
    // A minute of skew either way.
    for (const override of [{ exp: seconds - 30 }, { nbf: seconds + 30 }])
      expect(
        (await h.post({ token: await github.mint(claims(T0, override)) }))
          .status,
      ).toBe(200);
    for (const [override, error] of [
      [{ exp: seconds - 61 }, "token_expired"],
      [{ nbf: seconds + 61 }, "token_not_yet_valid"],
      [{ exp: undefined }, "token_expired"],
      [{ nbf: undefined }, "token_not_yet_valid"],
      [{ exp: "later" }, "token_expired"],
    ] as const)
      expect(
        await refusal(
          await h.post({ token: await github.mint(claims(T0, override)) }),
        ),
      ).toEqual({ status: 401, error });
    // The clock is the signer's: a token that was fine five minutes ago is refused now.
    const old = await github.mint(claims(T0));
    h.state.clock = T0 + 7 * 60_000;
    expect(await refusal(await h.post({ token: old }))).toEqual({
      status: 401,
      error: "token_expired",
    });
  });

  it("refuses a token whose signature, algorithm or key is not GitHub's", async () => {
    const h = harness();
    const good = await github.mint(claims(T0));
    const [header, payload, signature] = good.split(".") as [
      string,
      string,
      string,
    ];
    const forged = await githubKey("kid-1");
    const bad: [string, string | null, number, string][] = [
      ["no token", null, 401, "token_missing"],
      ["no dots", "abc", 401, "token_malformed"],
      ["four parts", `${good}.x`, 401, "token_malformed"],
      ["an empty signature", `${header}.${payload}.`, 401, "token_malformed"],
      ["not base64url", `${header}.${payload}.!!!`, 401, "token_malformed"],
      [
        "another key under the same id",
        await forged.mint(claims(T0)),
        401,
        "token_signature",
      ],
      [
        "another payload under the signature",
        `${header}.${(await github.mint(claims(T0, { ref: "refs/heads/feature" }))).split(".")[1]}.${signature}`,
        401,
        "token_signature",
      ],
      [
        "an unsecured token",
        `${bytesToBase64url(new TextEncoder().encode('{"alg":"none","kid":"kid-1"}'))}.${payload}.`,
        401,
        "token_malformed",
      ],
      [
        "HS256",
        await github.mint(claims(T0), { alg: "HS256" }),
        401,
        "token_algorithm",
      ],
      [
        "ES256",
        await github.mint(claims(T0), { alg: "ES256" }),
        401,
        "token_algorithm",
      ],
      [
        "no algorithm",
        await github.mint(claims(T0), { alg: undefined }),
        401,
        "token_algorithm",
      ],
      [
        "no key id",
        await github.mint(claims(T0), { kid: undefined }),
        401,
        "token_key_unknown",
      ],
      [
        "a key id that is not a string",
        await github.mint(claims(T0), { kid: 1 }),
        401,
        "token_key_unknown",
      ],
    ];
    for (const [name, token, status, error] of bad)
      expect(await refusal(await h.post({ token })), name).toEqual({
        status,
        error,
      });
    // Without any authorization header, and with another scheme.
    const noHeader = await h.post({ token: null });
    expect(noHeader.status).toBe(401);
    expect(noHeader.headers.get("www-authenticate")).toBe("Bearer");
    expect((await h.post({ authorization: `Basic ${good}` })).status).toBe(401);
    expect((await h.post({ authorization: good })).status).toBe(401);
  });
});

describe("GitHub's keys", () => {
  it("fetches them once and keeps them for a few minutes", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) expect((await h.post()).status).toBe(200);
    expect(h.state.fetched).toEqual([JWKS_URL]);
    h.state.clock += 4 * 60_000;
    expect((await h.post()).status).toBe(200);
    expect(h.state.fetched).toHaveLength(1);
    h.state.clock += 2 * 60_000;
    expect((await h.post()).status).toBe(200);
    expect(h.state.fetched).toHaveLength(2);
  });

  it("fetches again for a key id it does not know, but not more than once in half a minute", async () => {
    const h = harness();
    expect((await h.post()).status).toBe(200);
    const next = await githubKey("kid-2");
    h.state.answer = () => Response.json(jwks(github, next));
    // A token of a key that GitHub rotated in a moment ago: the keys were fetched seconds ago, so
    // an unknown id costs the caller a refusal and GitHub no request.
    h.state.clock += 10_000;
    const token = await next.mint(claims(h.state.clock));
    expect(await refusal(await h.post({ token }))).toEqual({
      status: 401,
      error: "token_key_unknown",
    });
    expect(h.state.fetched).toHaveLength(1);
    // Half a minute later the one refetch finds the new key.
    h.state.clock += 25_000;
    expect(
      (await h.post({ token: await next.mint(claims(h.state.clock)) })).status,
    ).toBe(200);
    expect(h.state.fetched).toHaveLength(2);
    // A key id that GitHub does not have is refused after that one refetch and not more.
    h.state.clock += 31_000;
    const stranger = await githubKey("kid-3");
    expect(
      await refusal(
        await h.post({ token: await stranger.mint(claims(h.state.clock)) }),
      ),
    ).toEqual({ status: 401, error: "token_key_unknown" });
    expect(h.state.fetched).toHaveLength(3);
  });

  it("signs nothing while it cannot read them", async () => {
    for (const answer of [
      () => new Response("down", { status: 500 }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/jwks" },
        }),
      () => new Response("not json", { status: 200 }),
      () => Response.json({ keys: "no" }),
      () =>
        Response.json({
          keys: [{ kty: "RSA", kid: "kid-1", n: "x", e: "AQAB" }],
        }),
      () => {
        throw new Error("network");
      },
    ]) {
      const h = harness(answer);
      expect(await refusal(await h.post())).toEqual({
        status: 503,
        error: "jwks_unavailable",
      });
    }
  });

  it("asks GitHub for its keys without following a redirect", async () => {
    const seen: RequestInit[] = [];
    const signer = createSigner({
      fetch: async (_input, init) => {
        seen.push(init ?? {});
        return Response.json(jwks(github));
      },
      now: () => T0,
    });
    const response = await signer.fetch(
      new Request(SIGNER_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await github.mint(claims(T0))}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(fields()),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.redirect).toBe("manual");
  });
});

describe("its own configuration", () => {
  it("answers 500 and signs nothing while the key or a variable is missing or malformed", async () => {
    const h = harness();
    const broken: Env[] = [
      env({ RELEASE_SIGNING_KEY: undefined }),
      env({ RELEASE_SIGNING_KEY: "" }),
      env({ RELEASE_SIGNING_KEY: "not-a-key-SECRET-VALUE" }),
      env({ RELEASE_SIGNING_KEY: btoa("not pkcs8 at all, but base64") }),
      env({ SIGNER_REPOSITORY: undefined }),
      env({ SIGNER_REPOSITORY: "no-slash" }),
      env({ SIGNER_REPOSITORY_ID: undefined }),
      env({ SIGNER_REPOSITORY_ID: "" }),
      env({ SIGNER_REPOSITORY_ID: "example-repo" }),
      env({ SIGNER_REPOSITORY_OWNER_ID: undefined }),
      env({ SIGNER_REPOSITORY_OWNER_ID: "0x2a" }),
      env({ SIGNER_REF: "main" }),
      env({ SIGNER_WORKFLOW: "ci.yml" }),
      env({ SIGNER_WORKFLOW: undefined }),
    ];
    for (const config of broken) {
      const response = await h.post({ env: config });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: "signer_misconfigured" });
      expect(text).not.toContain("SECRET-VALUE");
    }
  });

  it("logs the release it signed and why it refused, and no token, key or digest", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    const h = harness();
    const token = await github.mint(claims(T0));
    expect((await h.post({ token })).status).toBe(200);
    expect(
      (
        await h.post({
          token: await github.mint(claims(T0, { ref: "refs/heads/x" })),
        })
      ).status,
    ).toBe(403);
    expect((await h.post({ raw: "{" })).status).toBe(400);
    const all = logged.join("\n");
    expect(all).toContain(RELEASE_ID);
    expect(all).toContain("claim_ref");
    for (const secret of [
      token,
      token.split(".")[2]!,
      release.secret,
      "1".repeat(64),
      "5".repeat(64),
    ])
      expect(all).not.toContain(secret);
  });
});
