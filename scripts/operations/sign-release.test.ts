// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signedReleaseManifest } from "../../packages/contracts/src/releases.ts";
import type { Manifest } from "./register-node-image.ts";
import { generateKeyPair, signText } from "./release-key-fixture.ts";
import { PLACEHOLDER_RELEASE_KEY, verifyText } from "./release-signing.ts";
import { signBuild } from "./sign-release.ts";

const digest = (letter: string, size_bytes: number) => ({
  sha256: letter.repeat(64),
  size_bytes,
});
const manifest: Manifest = {
  version: "sha-0123456789ab",
  registration: {
    image: {
      ...digest("a", 512_000_000),
      raw_sha256: "b".repeat(64),
      raw_bytes: 2_147_483_648,
    },
    binaries: {
      "pgcf-agent": digest("1", 11_000_000),
      "pgcf-native-gateway": digest("2", 12_000_000),
      "pgcf-archive": digest("3", 5_000_000),
      "pgcf-wal-fetch": digest("4", 5_100_000),
    },
    os: {
      debian_snapshot: "20261016T000000Z",
      package_lock: digest("5", 90_000),
      packages_sha256: "6".repeat(64),
      kernel_release: "6.12.113+deb13-amd64",
      host_files: [
        {
          path: "/usr/lib/systemd/system/pgcf-gateway.service",
          kind: "file",
          mode: "0644",
          sha256: "7".repeat(64),
          size_bytes: 1200,
          apply: "restart_unit:pgcf-gateway.service",
        },
      ],
      host_files_sha256: "8".repeat(64),
    },
  },
  uploads: [],
};
const OIDC_REQUEST_TOKEN = "runner-request-token-SECRET-0123456789";
const IDENTITY_TOKEN = "header.payload.IDENTITY-SIGNATURE-SECRET";
const key = generateKeyPair();
const text = signedReleaseManifest({
  id: manifest.version,
  ...manifest.registration,
});

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}
type Reply = (
  seen: Seen,
  response: ServerResponse,
  request: IncomingMessage,
) => void;
/**
 * GitHub's token endpoint (`/token`) and the signer (`/sign`), on the loopback interface. The
 * signer here is a stand-in that signs with a key of the test's; what the real one accepts is the
 * Worker's own test.
 */
async function servers(options: { token?: Reply; sign?: Reply } = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const entry: Seen = {
      method: request.method!,
      url: request.url!,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body,
    };
    seen.push(entry);
    if (request.url!.startsWith("/token")) {
      if (options.token) return options.token(entry, response, request);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ value: IDENTITY_TOKEN }));
    }
    if (request.url === "/sign") {
      if (options.sign) return options.sign(entry, response, request);
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end(`${signText(key.privateKey, text)}\n`);
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    origin,
    environment: {
      RELEASE_SIGNER_URL: origin,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
    } as Record<string, string | undefined>,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const directory = () => mkdtemp(join(tmpdir(), "pgcf-sign-"));
const secrets = [
  OIDC_REQUEST_TOKEN,
  IDENTITY_TOKEN,
  "IDENTITY-SIGNATURE-SECRET",
];
const hidesSecrets = (error: Error) =>
  secrets.every((secret) => !error.message.includes(secret));

test("CI asks the signer for the signature of the manifest's facts with its identity token and keeps it beside the files", async () => {
  const root = await directory();
  const s = await servers();
  try {
    const signature = await signBuild(manifest, root, {
      environment: s.environment,
      committedKey: key.publicKey,
    });
    // The identity token was asked for with the signer as its audience, by the run's own credential.
    const [tokenRequest, signRequest] = s.seen;
    assert.equal(tokenRequest!.method, "GET");
    const asked = new URL(tokenRequest!.url, s.origin);
    assert.equal(asked.searchParams.get("audience"), s.origin);
    assert.equal(asked.searchParams.get("api-version"), "2.0");
    assert.equal(tokenRequest!.authorization, `bearer ${OIDC_REQUEST_TOKEN}`);
    // The signer got the token as the bearer credential and the facts as JSON: the release id,
    // the image's four facts (the compressed and the raw sha256 and size, which the installer checks
    // of the disk it writes), every other digest of the manifest and the host files with how each
    // takes effect, and nothing of the kernel or what a node reports.
    assert.equal(signRequest!.method, "POST");
    assert.equal(signRequest!.authorization, `Bearer ${IDENTITY_TOKEN}`);
    assert.equal(signRequest!.contentType, "application/json");
    assert.deepEqual(JSON.parse(signRequest!.body), {
      id: manifest.version,
      image: manifest.registration.image,
      binaries: manifest.registration.binaries,
      os: {
        debian_snapshot: manifest.registration.os.debian_snapshot,
        package_lock: manifest.registration.os.package_lock,
        host_files: manifest.registration.os.host_files,
      },
    });
    // The signature is the file's, in the format the registration reads.
    const file = join(root, "release.sig");
    assert.equal(await readFile(file, "utf8"), `${signature}\n`);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    assert.equal(verifyText(key.publicKey, text, signature), true);
  } finally {
    await s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("it fails, signing nothing, while the committed public key is still the placeholder, and asks nobody", async () => {
  const root = await directory();
  const s = await servers();
  try {
    await assert.rejects(
      signBuild(manifest, root, {
        environment: s.environment,
        committedKey: PLACEHOLDER_RELEASE_KEY,
      }),
      /placeholder.*docs\/operations\/release-signing\.md/s,
    );
    assert.deepEqual(s.seen, []);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("it fails, naming what is missing, outside a job that may ask for an identity token or without the signer's address", async () => {
  const root = await directory();
  const s = await servers();
  try {
    const without = (...names: string[]) =>
      Object.fromEntries(
        Object.entries(s.environment).filter(([name]) => !names.includes(name)),
      );
    await assert.rejects(
      signBuild(manifest, root, {
        environment: without("RELEASE_SIGNER_URL"),
        committedKey: key.publicKey,
      }),
      /RELEASE_SIGNER_URL/,
    );
    for (const names of [
      ["ACTIONS_ID_TOKEN_REQUEST_URL"],
      ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"],
    ])
      await assert.rejects(
        signBuild(manifest, root, {
          environment: without(...names),
          committedKey: key.publicKey,
        }),
        /id-token: write/,
      );
    await assert.rejects(
      signBuild(manifest, root, {
        environment: { ...s.environment, RELEASE_SIGNER_URL: "" },
        committedKey: key.publicKey,
      }),
      /RELEASE_SIGNER_URL/,
    );
    assert.deepEqual(s.seen, []);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("it fails, signing nothing, when the signer refuses, is unreachable or answers with something that is no signature", async () => {
  const root = await directory();
  try {
    const refusing = await servers({
      sign: (_seen, response) => {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "claim_ref", echo: IDENTITY_TOKEN }),
        );
      },
    });
    await assert.rejects(
      signBuild(manifest, root, {
        environment: refusing.environment,
        committedKey: key.publicKey,
      }),
      (error: Error) =>
        /403/.test(error.message) &&
        /claim_ref/.test(error.message) &&
        hidesSecrets(error),
    );
    await refusing.close();

    // Nothing listens at the signer's address (the identity token is had from a server that does).
    const live = await servers();
    const dead = await servers();
    await dead.close();
    await assert.rejects(
      signBuild(manifest, root, {
        environment: { ...live.environment, RELEASE_SIGNER_URL: dead.origin },
        committedKey: key.publicKey,
      }),
      (error: Error) =>
        /cannot be reached/.test(error.message) && hidesSecrets(error),
    );
    await live.close();

    for (const answer of [
      "not a signature",
      "",
      `${"a".repeat(127)}\n`,
      `${"a".repeat(128)}00\n`,
      `${"A".repeat(128)}\n`,
      `${"a".repeat(128)}\n${"a".repeat(128)}\n`,
    ]) {
      const odd = await servers({
        sign: (_seen, response) => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(answer);
        },
      });
      await assert.rejects(
        signBuild(manifest, root, {
          environment: odd.environment,
          committedKey: key.publicKey,
        }),
        /is not a signature/,
      );
      await odd.close();
    }

    // The identity token could not be had: the signer is not asked.
    const noToken = await servers({
      token: (_seen, response) => {
        response.writeHead(500);
        response.end("down");
      },
    });
    await assert.rejects(
      signBuild(manifest, root, {
        environment: noToken.environment,
        committedKey: key.publicKey,
      }),
      (error: Error) =>
        /identity token/.test(error.message) && hidesSecrets(error),
    );
    assert.equal(
      noToken.seen.some(({ url }) => url === "/sign"),
      false,
    );
    await noToken.close();
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the identity token goes to the signer's address and nowhere else", async () => {
  const root = await directory();
  const elsewhere = await servers();
  const redirecting = await servers({
    sign: (_seen, response) => {
      response.writeHead(307, { location: `${elsewhere.origin}/sign` });
      response.end();
    },
  });
  try {
    await assert.rejects(
      signBuild(manifest, root, {
        environment: redirecting.environment,
        committedKey: key.publicKey,
      }),
      hidesSecrets,
    );
    assert.deepEqual(elsewhere.seen, []);
    // The address is https, or http on this machine, and nothing but an origin.
    for (const url of [
      "http://signer.example",
      "https://signer.example/sign",
      "https://user:pw@signer.example",
      "https://signer.example/?x=1",
      "ftp://signer.example",
      "not a url",
    ])
      await assert.rejects(
        signBuild(manifest, root, {
          environment: { ...redirecting.environment, RELEASE_SIGNER_URL: url },
          committedKey: key.publicKey,
        }),
        (error: Error) =>
          /RELEASE_SIGNER_URL/.test(error.message) &&
          !error.message.includes("pw@"),
      );
    // A trailing slash is the same origin.
    const sloppy = await servers();
    await signBuild(manifest, root, {
      environment: {
        ...sloppy.environment,
        RELEASE_SIGNER_URL: `${sloppy.origin}/`,
      },
      committedKey: key.publicKey,
    });
    assert.equal(
      new URL(sloppy.seen[0]!.url, sloppy.origin).searchParams.get("audience"),
      sloppy.origin,
    );
    await sloppy.close();
  } finally {
    await redirecting.close();
    await elsewhere.close();
    await rm(root, { recursive: true, force: true });
  }
});
