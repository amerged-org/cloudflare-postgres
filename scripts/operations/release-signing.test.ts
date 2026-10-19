// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signedReleaseManifest } from "../../packages/contracts/src/releases.ts";
import { generateKeyPair, signText } from "./release-key-fixture.ts";
import {
  PLACEHOLDER_RELEASE_KEY,
  main,
  provision,
  readReleaseKey,
  verifyText,
} from "./release-signing.ts";

const TOKEN = "cfapitoken0123456789_ABCDEFGHIJKLMNOPQRSTUV";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WORKER = "pgcf-release-signer-test";

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
  /** The key file as the operator's checkout held it when this request arrived. */
  keyFile: string | undefined;
}
/** A Cloudflare API on the loopback interface that holds the secrets of one Worker. */
async function cloudflare(
  keyPath: string,
  options: {
    secrets?: string[];
    worker?: boolean;
    put?: (
      request: IncomingMessage,
      response: ServerResponse,
      body: string,
    ) => boolean;
  } = {},
) {
  const seen: Seen[] = [];
  const secrets = new Set(options.secrets ?? []);
  const base = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`;
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({
      method: request.method!,
      path: request.url!,
      authorization: request.headers.authorization,
      body,
      keyFile: await readFile(keyPath, "utf8").catch(() => undefined),
    });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url !== base)
      return reply(404, {
        success: false,
        errors: [{ code: 7003, message: "no route" }],
      });
    if (options.worker === false)
      return reply(404, {
        success: false,
        errors: [
          {
            code: 10007,
            message: "This Worker does not exist on your account.",
          },
        ],
      });
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return reply(403, {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      });
    if (request.method === "GET")
      return reply(200, {
        success: true,
        errors: [],
        result: [...secrets].map((name) => ({ name, type: "secret_text" })),
      });
    if (request.method === "PUT") {
      if (options.put?.(request, response, body)) return;
      secrets.add((JSON.parse(body) as { name: string }).name);
      return reply(200, {
        success: true,
        errors: [],
        result: { name: "RELEASE_SIGNING_KEY", type: "secret_text" },
      });
    }
    return reply(405, { success: false, errors: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    secrets,
    apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A checkout's key file, holding `key`, in a directory of its own. */
async function checkout(key = PLACEHOLDER_RELEASE_KEY) {
  const root = await mkdtemp(join(tmpdir(), "pgcf-provision-"));
  const publicPath = join(root, "release-signing.pub");
  await writeFile(publicPath, `${key}\n`);
  return { root, publicPath };
}
const options = (apiBase: string, publicPath: string, extra = {}) => ({
  apiBase,
  apiToken: TOKEN,
  accountId: ACCOUNT,
  worker: WORKER,
  publicPath,
  rotate: false,
  ...extra,
});
const MANIFEST = signedReleaseManifest({
  id: "sha-0123456789ab",
  binaries: Object.fromEntries(
    ["pgcf-agent", "pgcf-native-gateway", "pgcf-archive", "pgcf-wal-fetch"].map(
      (name, index) => [
        name,
        { sha256: String(index + 1).repeat(64), size_bytes: 1000 },
      ],
    ),
  ) as never,
  os: {
    debian_snapshot: "20261016T000000Z",
    package_lock: { sha256: "5".repeat(64), size_bytes: 1000 },
  },
});

test("provisioning sets the Worker secret first and writes the public key only after the API accepted it", async () => {
  const { root, publicPath } = await checkout();
  const api = await cloudflare(publicPath);
  try {
    const result = await provision(options(api.apiBase, publicPath));
    assert.deepEqual(
      api.seen.map(({ method }) => method),
      ["GET", "PUT"],
    );
    // While the API was asked to set the secret the checkout still held the placeholder.
    for (const request of api.seen)
      assert.equal(request.keyFile, `${PLACEHOLDER_RELEASE_KEY}\n`);
    assert.equal(api.seen[1]!.authorization, `Bearer ${TOKEN}`);
    // The secret is an Ed25519 private key as PKCS#8 in base64, which the signer imports, under
    // the name the signer reads.
    const put = JSON.parse(api.seen[1]!.body) as Record<string, string>;
    assert.deepEqual(Object.keys(put).sort(), ["name", "text", "type"]);
    assert.equal(put.name, "RELEASE_SIGNING_KEY");
    assert.equal(put.type, "secret_text");
    const der = Buffer.from(put.text!, "base64");
    assert.equal(der.toString("base64"), put.text);
    await crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"]);
    assert.equal(
      createPrivateKey({ key: der, format: "der", type: "pkcs8" })
        .asymmetricKeyType,
      "ed25519",
    );
    // The file holds the public half of that key, and a signature of the secret verifies with it:
    // what the agent trusts is what the signer signs with.
    const published = await readReleaseKey(publicPath);
    assert.notEqual(published, PLACEHOLDER_RELEASE_KEY);
    assert.equal(await readFile(publicPath, "utf8"), `${published}\n`);
    assert.equal(
      verifyText(published, MANIFEST, signText(put.text!, MANIFEST)),
      true,
    );
    // What it reports: the fingerprint of the public key and nothing of the private one.
    assert.equal(
      result.fingerprint,
      createHash("sha256").update(Buffer.from(published, "hex")).digest("hex"),
    );
    assert.equal(JSON.stringify(result).includes(put.text!), false);
    assert.deepEqual(await readdir(root), ["release-signing.pub"]);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a secret the API did not accept leaves the key file as it was", async () => {
  const { root, publicPath } = await checkout();
  const api = await cloudflare(publicPath, {
    put: (_request, response, body) => {
      // An answer that echoes the request, as a proxy in front of the API might.
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: `broke on ${body} for ${TOKEN}` }],
        }),
      );
      return true;
    },
  });
  try {
    await assert.rejects(
      provision(options(api.apiBase, publicPath)),
      (error: Error) => {
        assert.match(error.message, /500/);
        assert.match(error.message, /1000/);
        // The private key and the token are in what the API echoed, and in no message.
        assert.equal(error.message.includes(TOKEN), false);
        const sent = (JSON.parse(api.seen[1]!.body) as { text: string }).text;
        assert.equal(error.message.includes(sent), false);
        assert.equal(JSON.stringify(error).includes(sent), false);
        return true;
      },
    );
    assert.equal(
      await readFile(publicPath, "utf8"),
      `${PLACEHOLDER_RELEASE_KEY}\n`,
    );
    assert.deepEqual(await readdir(root), ["release-signing.pub"]);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("it never replaces a secret the Worker holds, with or without --rotate, and --rotate only lifts the refusal for a real key in the checkout", async () => {
  const held = await checkout();
  const hasSecret = await cloudflare(held.publicPath, {
    secrets: ["RELEASE_SIGNING_KEY", "OTHER"],
  });
  const heldReal = await checkout(generateKeyPair().publicKey);
  const hasSecretAndKey = await cloudflare(heldReal.publicPath, {
    secrets: ["RELEASE_SIGNING_KEY"],
  });
  const real = await checkout(generateKeyPair().publicKey);
  const noSecret = await cloudflare(real.publicPath);
  try {
    // The secret exists: nothing is generated, set or written, and the secret cannot be read back,
    // so the message says what to do instead. --rotate does not change that: the runbook's
    // rotation command without its --worker flag points at the signer the nodes trust.
    for (const rotate of [false, true])
      await assert.rejects(
        provision(options(hasSecret.apiBase, held.publicPath, { rotate })),
        /already holds the secret RELEASE_SIGNING_KEY.*never replaces.*another Worker.*secret delete/s,
      );
    // The dangerous case: a real key in the checkout, the Worker that signs it, and --rotate. It is
    // refused after the one request that lists the secrets: no PUT, and the file as it was.
    const keyBefore = await readFile(heldReal.publicPath, "utf8");
    await assert.rejects(
      provision(
        options(hasSecretAndKey.apiBase, heldReal.publicPath, { rotate: true }),
      ),
      /already holds the secret RELEASE_SIGNING_KEY/,
    );
    assert.equal(await readFile(heldReal.publicPath, "utf8"), keyBefore);
    assert.deepEqual(
      hasSecretAndKey.seen.map(({ method }) => method),
      ["GET"],
    );
    assert.deepEqual(
      hasSecret.seen.map(({ method }) => method),
      ["GET", "GET"],
    );
    assert.equal(
      await readFile(held.publicPath, "utf8"),
      `${PLACEHOLDER_RELEASE_KEY}\n`,
    );
    assert.equal(
      hasSecret.secrets.size,
      2,
      "the secrets of the Worker are as they were",
    );
    // The checkout holds a real key: refused before the API is asked anything.
    const before = await readFile(real.publicPath, "utf8");
    await assert.rejects(
      provision(options(noSecret.apiBase, real.publicPath)),
      /not the placeholder.*--rotate/s,
    );
    assert.deepEqual(noSecret.seen, []);
    assert.equal(await readFile(real.publicPath, "utf8"), before);
    // With --rotate, against a Worker that holds no secret (the second signer of a rotation, or the
    // new one after a loss), the secret is set by one PUT and then the file is replaced.
    const rotated = await provision(
      options(noSecret.apiBase, real.publicPath, { rotate: true }),
    );
    assert.deepEqual(
      noSecret.seen.map(({ method }) => method),
      ["GET", "PUT"],
    );
    assert.notEqual(await readFile(real.publicPath, "utf8"), before);
    assert.equal(await readReleaseKey(real.publicPath), rotated.publicKey);
  } finally {
    await hasSecret.close();
    await hasSecretAndKey.close();
    await noSecret.close();
    await rm(held.root, { recursive: true, force: true });
    await rm(heldReal.root, { recursive: true, force: true });
    await rm(real.root, { recursive: true, force: true });
  }
});

test("an answer to the request that sets the secret that never arrives leaves the file as it was and says how to go on without the secret", async () => {
  const { root, publicPath } = await checkout();
  const api = await cloudflare(publicPath, {
    put: (request) => {
      request.socket.destroy();
      return true;
    },
  });
  try {
    await assert.rejects(
      provision(options(api.apiBase, publicPath)),
      (error: Error) => {
        assert.match(error.message, /not known whether the Worker now holds/);
        // The Worker held no secret before this command, so deleting what may be there loses no key.
        assert.match(
          error.message,
          /npx wrangler secret delete RELEASE_SIGNING_KEY --name pgcf-release-signer-test/,
        );
        assert.match(error.message, /[0-9a-f]{64}/);
        const sent = (JSON.parse(api.seen[1]!.body) as { text: string }).text;
        assert.equal(error.message.includes(sent), false);
        return true;
      },
    );
    assert.equal(
      await readFile(publicPath, "utf8"),
      `${PLACEHOLDER_RELEASE_KEY}\n`,
    );
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Worker that is not deployed, a token the account refuses and a key file that is none are named and change nothing", async () => {
  const { root, publicPath } = await checkout();
  const missing = await cloudflare(publicPath, { worker: false });
  const refused = await cloudflare(publicPath);
  try {
    await assert.rejects(
      provision(options(missing.apiBase, publicPath)),
      /does not exist.*deploy/s,
    );
    await assert.rejects(
      provision(
        options(refused.apiBase, publicPath, { apiToken: "x".repeat(40) }),
      ),
      (error: Error) =>
        /403/.test(error.message) && !error.message.includes("x".repeat(40)),
    );
    assert.deepEqual(
      missing.seen.map(({ method }) => method),
      ["GET"],
    );
    await writeFile(publicPath, "not a key\n");
    await assert.rejects(
      provision(options(refused.apiBase, publicPath)),
      /holds no public key/,
    );
    await rm(publicPath);
    await assert.rejects(
      provision(options(refused.apiBase, publicPath)),
      /cannot be read/,
    );
    // No request was made for a file that is none: it is read first.
    assert.equal(refused.seen.length, 1);
  } finally {
    await missing.close();
    await refused.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("when the file cannot be written after the secret is set, the error says so and gives the public key to put there", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can write anywhere");
  const { root, publicPath } = await checkout();
  const api = await cloudflare(publicPath);
  try {
    // The file can be read and the directory cannot take a new file: the one step after the API call fails.
    await chmod(root, 0o555);
    await assert.rejects(
      provision(options(api.apiBase, publicPath)),
      (error: Error) => {
        assert.match(error.message, /secret is set/);
        assert.match(error.message, /[0-9a-f]{64}/);
        const sent = (JSON.parse(api.seen[1]!.body) as { text: string }).text;
        assert.equal(error.message.includes(sent), false);
        return true;
      },
    );
  } finally {
    await chmod(root, 0o755);
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the command takes the names of the variables that hold the token and the account, never their values", async () => {
  const { root, publicPath } = await checkout();
  const api = await cloudflare(publicPath);
  const out: string[] = [];
  const argv = (...extra: string[]) => [
    "provision",
    "--token-env",
    "PGCF_TEST_TOKEN",
    "--account-env",
    "PGCF_TEST_ACCOUNT",
    "--worker",
    WORKER,
    "--public",
    publicPath,
    "--api-base",
    api.apiBase,
    ...extra,
  ];
  const environment = { PGCF_TEST_TOKEN: TOKEN, PGCF_TEST_ACCOUNT: ACCOUNT };
  try {
    // A variable that is not set is named, and a value that is not a token is not shown.
    await assert.rejects(
      main(argv(), {}, (line) => out.push(line)),
      /set PGCF_TEST_TOKEN/,
    );
    await assert.rejects(
      main(
        argv(),
        { ...environment, PGCF_TEST_TOKEN: "bad token SECRET" },
        (line) => out.push(line),
      ),
      (error: Error) =>
        /PGCF_TEST_TOKEN/.test(error.message) &&
        !error.message.includes("SECRET"),
    );
    // A value on the command line is not a variable name.
    await assert.rejects(
      main(argv("--token-env", TOKEN), environment, (line) => out.push(line)),
      (error: Error) =>
        /variable name/.test(error.message) && !error.message.includes(TOKEN),
    );
    await assert.rejects(
      main(["provision"], environment, (line) => out.push(line)),
      /usage/,
    );
    assert.equal(api.seen.length, 0);

    await main(argv(), environment, (line) => out.push(line));
    const published = await readReleaseKey(publicPath);
    const sent = (JSON.parse(api.seen[1]!.body) as { text: string }).text;
    const printed = out.join("\n");
    // It prints the fingerprint and the next steps, and neither the key, the token nor the public key.
    assert.match(printed, /fingerprint/);
    assert.match(
      printed,
      new RegExp(
        createHash("sha256")
          .update(Buffer.from(published, "hex"))
          .digest("hex"),
      ),
    );
    assert.match(printed, /release-signing\.pub/);
    for (const secret of [sent, TOKEN, published, ACCOUNT])
      assert.equal(printed.includes(secret), false);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the API base is https, or http on this machine", async () => {
  const { root, publicPath } = await checkout();
  try {
    for (const apiBase of [
      "http://api.example.org",
      "ftp://127.0.0.1",
      "https://user:pw@api.example.org",
      "not a url",
    ])
      await assert.rejects(provision(options(apiBase, publicPath)), /API base/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
