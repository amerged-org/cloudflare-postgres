// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExplicitRetirementRefusal,
  readEncryptedSecretRange,
  serviceAccountToken,
  verifyTalosAdministrationPair,
} from "../src/region-authority-probes.ts";
function probeToken(pem: string) {
  const issuer = "https://kubernetes.default.svc",
    [header, payload, signature] = serviceAccountToken(pem, issuer, {
      metadata: {
        name: "default",
        uid: "5b0f0c9e-1d4a-4c38-9a51-6f2b7d3e8a10",
      },
    }).split(".") as [string, string, string],
    publicKey = createPublicKey(pem);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(payload, "base64url").toString()),
    input: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, "base64url"),
    publicKey,
    // kube-apiserver's key ID: base64url SHA-256 of the signer's PKIX public key.
    kid: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url"),
  };
}
test("probe tokens are signed with the signer key's own JWS algorithm under kube-apiserver's key ID", () => {
  // Talos v1.6 and earlier generate the service-account signer as a SEC1 ECDSA P-256 key.
  const ec = probeToken(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "sec1", format: "pem" })
      .toString(),
  );
  assert.deepEqual(ec.header, { alg: "ES256", kid: ec.kid });
  assert.equal(ec.claims.sub, "system:serviceaccount:kube-system:default");
  // JWS ES256 is the fixed-width r||s signature, not DER.
  assert.equal(ec.signature.length, 64);
  assert.ok(
    verify(
      "sha256",
      ec.input,
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      ec.signature,
    ),
  );
  // Talos v1.7 and later generate an RSA signer.
  const rsa = probeToken(
    generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString(),
  );
  assert.deepEqual(rsa.header, { alg: "RS256", kid: rsa.kid });
  assert.ok(verify("RSA-SHA256", rsa.input, rsa.publicKey, rsa.signature));
});
test("worker retirement creates its private output directory before checking client material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pgcf-retirement-directory-")),
    output = join(root, "worker", "retirement");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    verifyTalosAdministrationPair({
      session: {
        binding: {
          node_uid: "11111111-1111-4111-8111-111111111111",
          cluster_uid: "22222222-2222-4222-8222-222222222222",
        },
        verify: async () => undefined,
      } as never,
      newDocuments: [],
      oldTalosconfig: "{}",
      newTalosconfig: "{}",
      talosctl: "/usr/local/bin/talosctl",
      kubectl: "/usr/local/bin/kubectl",
      outputDir: output,
    }),
    (error) => error instanceof Error && !error.message.includes("ENOENT"),
  );
  assert.equal((await stat(output)).mode & 0o777, 0o700);
});
function varint(value: number) {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
}
function field(id: number, value: Buffer | number) {
  return typeof value === "number"
    ? Buffer.concat([varint(id << 3), varint(value)])
    : Buffer.concat([varint((id << 3) | 2), varint(value.length), value]);
}
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const RANGE_END = "/registry/secrets0";
type Row = { key: string; value: Buffer; revision: number };
type Page = { revision: number; kvs: Row[]; more: boolean; count: number };
function ciphertext(keyName: string, fill = 0, size = 40) {
  return Buffer.concat([
    Buffer.from(`k8s:enc:secretbox:v1:${keyName}:`),
    Buffer.alloc(size, fill),
  ]);
}
/** Secrets in etcd key order, each sealed under the expected key. */
function secrets(count: number, size?: number): [string, Buffer][] {
  return Array.from({ length: count }, (_, index) => [
    `/registry/secrets/ns-${String(index).padStart(2, "0")}/release`,
    ciphertext("operator-key", index, size),
  ]);
}
/** The client's RangeRequest; anything beyond key, range_end, limit and revision is refused. */
function decodeRangeRequest(message: Buffer) {
  const fields = new Map<number, Buffer | number>();
  let offset = 0;
  const number = () => {
    let value = 0,
      scale = 1,
      byte: number;
    do {
      byte = message[offset++]!;
      value += (byte & 127) * scale;
      scale *= 128;
    } while (byte & 128);
    return value;
  };
  while (offset < message.length) {
    const tag = number(),
      id = tag >> 3;
    if (fields.has(id) || id < 1 || id > 4)
      throw Error(`RangeRequest field ${id}`);
    if ((tag & 7) === 2) {
      const length = number();
      fields.set(id, message.subarray(offset, (offset += length)));
    } else fields.set(id, number());
  }
  return {
    key: fields.get(1) as Buffer,
    end: fields.get(2) as Buffer,
    limit: fields.get(3) as number,
    revision: fields.get(4) as number | undefined,
  };
}
/** etcd KV/Range over an MVCC history: pinned reads, key order and etcd's header, count and more. */
function fakeEtcd(
  initial: [string, Buffer][],
  options: {
    afterPage?: (
      index: number,
      put: (key: string, value: Buffer) => void,
    ) => void;
    tamper?: (index: number, page: Page, served: Page[]) => void;
  } = {},
) {
  const history: Row[] = initial.map(([key, value], index) => ({
      key,
      value,
      revision: index + 1,
    })),
    requests: ReturnType<typeof decodeRangeRequest>[] = [],
    served: Page[] = [];
  const serve = (message: Buffer) => {
    const request = decodeRangeRequest(message),
      current = history.length,
      live = new Map<string, Row>();
    requests.push(request);
    // etcd reads at the pinned revision but reports its current revision in the header.
    for (const row of history)
      if (row.revision <= (request.revision ?? current)) live.set(row.key, row);
    const rows = [...live.values()]
      .filter(
        (row) =>
          Buffer.compare(Buffer.from(row.key), request.key) >= 0 &&
          Buffer.compare(Buffer.from(row.key), request.end) < 0,
      )
      .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const page: Page = {
      revision: current,
      kvs: rows.slice(0, request.limit),
      more: rows.length > request.limit,
      count: rows.length,
    };
    options.tamper?.(served.length, page, served);
    served.push(page);
    options.afterPage?.(served.length - 1, (key, value) =>
      history.push({ key, value, revision: history.length + 1 }),
    );
    return Buffer.concat([
      field(
        1,
        Buffer.concat([
          field(1, 7),
          field(2, 9),
          field(3, page.revision),
          field(4, 2),
        ]),
      ),
      ...page.kvs.map((row) =>
        field(
          2,
          Buffer.concat([
            field(1, Buffer.from(row.key)),
            field(2, row.revision),
            field(3, row.revision),
            field(4, 1),
            field(5, row.value),
          ]),
        ),
      ),
      ...(page.more ? [field(3, 1)] : []),
      ...(page.count ? [field(4, page.count)] : []),
    ]);
  };
  return { requests, serve };
}
let identity: Promise<{ cert: string; key: string }> | undefined;
/** One self-signed 127.0.0.1 identity for the loopback etcd endpoints. */
function loopbackIdentity() {
  identity ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "pgcf-etcd-identity-"));
    try {
      const key = join(directory, "key.pem"),
        cert = join(directory, "cert.pem"),
        generated = spawnSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "ed25519",
            "-nodes",
            "-keyout",
            key,
            "-out",
            cert,
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
          ],
          { timeout: 60_000 },
        );
      assert.equal(generated.status, 0);
      return {
        cert: await readFile(cert, "utf8"),
        key: await readFile(key, "utf8"),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return identity;
}
/** Serve KV/Range over real TLS, HTTP/2 and gRPC framing on loopback. */
async function etcdEndpoint(
  t: TestContext,
  serve: (request: Buffer) => Buffer,
) {
  const { cert, key } = await loopbackIdentity(),
    server = http2.createSecureServer({ cert, key }),
    sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => {
      const raw = Buffer.concat(chunks);
      let reply: Buffer | undefined;
      try {
        assert.equal(headers[":path"], "/etcdserverpb.KV/Range");
        assert.equal(raw.readUInt32BE(1), raw.length - 5);
        const message = serve(raw.subarray(5));
        reply = Buffer.concat([Buffer.alloc(5), message]);
        reply.writeUInt32BE(message.length, 1);
      } catch {
        // A request the fake cannot serve is answered with INVALID_ARGUMENT.
      }
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.once("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": reply ? "0" : "3" }),
      );
      stream.end(reply);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    port: (server.address() as AddressInfo).port,
    address: "127.0.0.1",
    ca: cert,
  };
}
test("only explicit remote authentication refusal proves retirement", () => {
  assert.equal(isExplicitRetirementRefusal({ status: 401 }), true);
  assert.equal(isExplicitRetirementRefusal({ grpc_status: 16 }), true);
  assert.equal(
    isExplicitRetirementRefusal({
      tls_error_code: "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
    }),
    true,
  );
  assert.equal(
    isExplicitRetirementRefusal({ tls_error_code: "ETIMEDOUT" }),
    false,
  );
  assert.equal(
    isExplicitRetirementRefusal({ tls_error_code: "ECONNRESET" }),
    false,
  );
  assert.equal(
    isExplicitRetirementRefusal({
      tls_error_code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
    false,
  );
  assert.equal(
    isExplicitRetirementRefusal({ status: 403, grpc_status: 7 }),
    false,
  );
});
test("Secret ciphertext is read as one pinned etcd snapshot in bounded pages", async (t) => {
  const initial = secrets(20),
    etcd = fakeEtcd(initial, {
      // Writes racing the read: a new Secret and an old-key rewrite on a later page.
      afterPage: (index, put) => {
        if (index !== 0) return;
        put("/registry/secrets/zz/late", ciphertext("old-key"));
        put(initial[17]![0], ciphertext("old-key"));
      },
    }),
    result = await readEncryptedSecretRange(
      await etcdEndpoint(t, etcd.serve),
      "operator-key",
    );
  assert.deepEqual(result, {
    count: 20,
    allCiphertextUsesExpectedKey: true,
    entries: initial.map(([key, value]) => ({
      key_sha256: sha256(key),
      value_sha256: sha256(value),
    })),
  });
  assert.equal(JSON.stringify(result).includes("registry"), false);
  assert.deepEqual(
    etcd.requests.map((request) => [
      request.key.toString(),
      request.end.toString(),
      request.limit,
      request.revision,
    ]),
    [
      ["/registry/secrets/", RANGE_END, 8, undefined],
      [`${initial[7]![0]}\0`, RANGE_END, 8, 20],
      [`${initial[15]![0]}\0`, RANGE_END, 8, 20],
    ],
  );
});
test("a Secret range above the former 4 MiB response cap is read across pages", async (t) => {
  // Twelve 700 KiB values: 8.2 MiB in total and 5.5 MiB in the first page.
  const etcd = fakeEtcd(secrets(12, 700 * 1024)),
    result = await readEncryptedSecretRange(
      await etcdEndpoint(t, etcd.serve),
      "operator-key",
    );
  assert.equal(result.count, 12);
  assert.equal(etcd.requests.length, 2);
});
test("truncated, drifting, repeated, oversized or old-key pages fail the whole range closed", async (t) => {
  const read = async (
    tamper: (index: number, page: Page, served: Page[]) => void,
  ) =>
    readEncryptedSecretRange(
      await etcdEndpoint(t, fakeEtcd(secrets(20), { tamper }).serve),
      "operator-key",
    );
  // A page that claims more keys without being full.
  await assert.rejects(
    read((index, page) => {
      if (index === 0) page.kvs.length = 3;
    }),
    /range_truncated/,
  );
  // A later page older than the pinned snapshot.
  await assert.rejects(
    read((index, page) => {
      if (index === 1) page.revision = 19;
    }),
    /range_snapshot_differs/,
  );
  // A later page whose remaining count left the pinned snapshot.
  await assert.rejects(
    read((index, page) => {
      if (index === 1) page.count++;
    }),
    /range_snapshot_differs/,
  );
  // A later page that repeats the previous page's last key.
  await assert.rejects(
    read((index, page, served) => {
      if (index === 1) page.kvs[0] = served[0]!.kvs[7]!;
    }),
    /range_invalid/,
  );
  // A later page still sealed under the old key.
  await assert.rejects(
    read((index, page) => {
      if (index === 2)
        page.kvs[1] = { ...page.kvs[1]!, value: ciphertext("old-key") };
    }),
    /ciphertext_key_differs/,
  );
  // More Secrets than the range bound.
  await assert.rejects(
    read((index, page) => {
      if (index === 0) page.count = 4097;
    }),
    /range_limit/,
  );
});
