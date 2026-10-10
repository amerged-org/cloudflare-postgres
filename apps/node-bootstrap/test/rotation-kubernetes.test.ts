// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteRotationSecrets } from "../src/rotation-kubernetes.ts";

const secret = () => ({
  apiVersion: "v1",
  kind: "Secret",
  type: "Opaque",
  metadata: {
    namespace: "example",
    name: "application",
    uid: "1381b49b-643f-4ec5-af52-d30f00841417",
    resourceVersion: "1",
  },
  data: { value: "c2FtcGxl" },
});
test("a lost Secret replacement response is reconciled without a second write", async () => {
  let actual = secret(),
    writes = 0,
    saved: unknown;
  const commands = {
    async authorize() {},
    async checkpoint(value: unknown) {
      saved = structuredClone(value);
    },
    async kube(args: string[], payload?: string) {
      if (args[0] === "replace") {
        writes++;
        actual = JSON.parse(payload!);
        actual.metadata.resourceVersion = "2";
        throw Error("response_lost");
      }
      return JSON.stringify(
        args[2] === "/api/v1/secrets"
          ? { items: [actual], metadata: {} }
          : actual,
      );
    },
  };
  await assert.rejects(
    rewriteRotationSecrets({ key_name: "replacement" }, commands),
  );
  const result = await rewriteRotationSecrets(
    { key_name: "replacement", cursor: saved },
    commands,
  );
  assert.equal(writes, 1);
  assert.equal(result.secret_count, 1);
  assert.equal(result.physical_ciphertext_verification_pending, true);
});
test("an uncommitted uncertain Secret replacement remains unresolved and never replays", async () => {
  const actual = secret();
  let saved: unknown,
    writes = 0;
  const commands = {
    async authorize() {},
    async checkpoint(value: unknown) {
      saved = structuredClone(value);
    },
    async kube(args: string[]) {
      if (args[0] === "replace") {
        writes++;
        throw Error("response_lost");
      }
      return JSON.stringify(
        args[2] === "/api/v1/secrets"
          ? { items: [actual], metadata: {} }
          : actual,
      );
    },
  };
  await assert.rejects(
    rewriteRotationSecrets({ key_name: "replacement" }, commands),
  );
  await assert.rejects(
    rewriteRotationSecrets(
      { key_name: "replacement", cursor: saved },
      commands,
    ),
    /rotation_secret_write_unresolved/,
  );
  assert.equal(writes, 1);
});
test("replacement preserves Secret data and rejects a changed physical object", async () => {
  let actual = secret(),
    saved: unknown;
  const writes: unknown[] = [];
  const commands = {
    async authorize() {},
    async checkpoint(value: unknown) {
      saved = structuredClone(value);
    },
    async kube(args: string[], payload?: string) {
      if (args[0] === "replace") {
        writes.push(JSON.parse(payload!));
        actual = JSON.parse(payload!);
        actual.metadata.resourceVersion = "2";
      }
      return JSON.stringify(
        args[2] === "/api/v1/secrets"
          ? { items: [actual], metadata: {} }
          : actual,
      );
    },
  };
  await rewriteRotationSecrets({ key_name: "replacement" }, commands);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    (writes[0] as ReturnType<typeof secret>).data,
    secret().data,
  );
  actual.metadata.uid = "ce118d92-7141-4218-8b99-afab70cf9874";
  await assert.rejects(
    rewriteRotationSecrets(
      { key_name: "replacement", cursor: saved },
      commands,
    ),
    /rotation_secret_identity_changed/,
  );
});

import { generateKeyPairSync, sign } from "node:crypto";
import {
  renewRotationConsumers,
  retireRotationBootstrapToken,
} from "../src/rotation-kubernetes.ts";
const issuer = "https://kubernetes.default.svc";
const accountUid = "658d527d-9960-4c38-af3e-f03e5d196773";
const controllerUid = "7ae8268a-766f-4eba-aec3-c1131c479103";
const oldPod = "a9371465-8b63-40d2-aeeb-10f7c0f46e60",
  newPod = "246f6d70-acfb-4c51-8173-e81a0a42b6e6";
function signer() {
  const pair = generateKeyPairSync("ed25519");
  return {
    key: pair.privateKey,
    private: pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}
function jwt(key: ReturnType<typeof signer>, now: number) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString(
      "base64url",
    ),
    body = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: [issuer],
        sub: "system:serviceaccount:default:default",
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 600,
        "kubernetes.io": {
          namespace: "default",
          serviceaccount: { name: "default", uid: accountUid },
        },
      }),
    ).toString("base64url"),
    input = `${header}.${body}`;
  return `${input}.${sign(null, Buffer.from(input), key.key).toString("base64url")}`;
}
test("consumer renewal waits for the actual replacement signer and never patches under an old signer", async () => {
  const target = signer(),
    old = signer(),
    now = 1700000000000;
  let patches = 0;
  const commands = {
    now: () => now,
    async authorize() {},
    async checkpoint() {},
    async kube(args: string[]) {
      if (args[0] === "create")
        return JSON.stringify({ status: { token: jwt(old, now) } });
      if (args[0] === "patch") patches++;
      return JSON.stringify({
        kind: "ServiceAccount",
        metadata: { name: "default", namespace: "default", uid: accountUid },
      });
    },
  };
  await assert.rejects(
    renewRotationConsumers(
      {
        issuer_private_key: target.private,
        issuer_url: issuer,
        annotation_value: "rotation",
      },
      commands,
    ),
    /rotation_serviceaccount_issuer_not_loaded/,
  );
  assert.equal(patches, 0);
});
test("CNPG token consumers use its supported restart annotation with a timestamp and resume lost responses", async () => {
  const target = signer(),
    now = 1700000000000;
  let saved: unknown,
    patches = 0,
    restarted = false;
  const cluster = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "database",
      namespace: "example",
      uid: controllerUid,
      resourceVersion: "1",
      annotations: undefined as Record<string, string> | undefined,
    },
    spec: { instances: 1 },
  };
  const commands = {
    now: () => now,
    async authorize() {},
    async checkpoint(value: unknown) {
      saved = structuredClone(value);
    },
    async kube(args: string[]) {
      if (args[0] === "create")
        return JSON.stringify({ status: { token: jwt(target, now) } });
      if (args[0] === "patch") {
        patches++;
        const ops = JSON.parse(args.at(-1)!);
        assert.ok(
          cluster.metadata.annotations ||
            ops.some(
              (op: { op: string; path: string }) =>
                op.op === "add" && op.path === "/metadata/annotations",
            ),
        );
        cluster.metadata.annotations ??= {};
        cluster.metadata.annotations["kubectl.kubernetes.io/restartedAt"] =
          ops.at(-1).value;
        cluster.metadata.resourceVersion = "2";
        restarted = true;
        throw Error("reply_lost");
      }
      const route = args[2];
      if (route?.endsWith("/serviceaccounts/default"))
        return JSON.stringify({
          kind: "ServiceAccount",
          metadata: { name: "default", namespace: "default", uid: accountUid },
        });
      if (route === "/apis/apps/v1/replicasets")
        return JSON.stringify({ items: [], metadata: {} });
      if (route === "/api/v1/pods")
        return JSON.stringify({
          items: [
            {
              kind: "Pod",
              metadata: {
                namespace: "example",
                name: "database-1",
                uid: restarted ? newPod : oldPod,
                ownerReferences: [
                  {
                    kind: "Cluster",
                    name: "database",
                    uid: controllerUid,
                    controller: true,
                  },
                ],
              },
              spec: {
                volumes: [
                  {
                    projected: {
                      sources: [{ serviceAccountToken: { path: "token" } }],
                    },
                  },
                ],
              },
              status: {
                phase: "Running",
                conditions: [{ type: "Ready", status: "True" }],
              },
            },
          ],
          metadata: {},
        });
      return JSON.stringify(cluster);
    },
  };
  const input = {
    issuer_private_key: target.private,
    issuer_url: issuer,
    annotation_value: "rotation",
  };
  await assert.rejects(renewRotationConsumers(input, commands));
  const result = await renewRotationConsumers(
    { ...input, cursor: saved },
    commands,
  );
  assert.equal(patches, 1);
  assert.equal(result.controllers_renewed, 1);
  assert.equal(
    cluster.metadata.annotations!["kubectl.kubernetes.io/restartedAt"],
    new Date(now).toISOString(),
  );
  assert.deepEqual(cluster.spec, { instances: 1 });
});
test("bootstrap-token retirement uses UID/RV preconditions and reconciles a lost delete response", async () => {
  const oldToken = "abcdef.abcdefghijklmnop",
    newToken = "ghijkl.qrstuvwxyzabcdef";
  const make = (token: string, uid: string) => ({
    kind: "Secret",
    type: "bootstrap.kubernetes.io/token",
    metadata: {
      namespace: "kube-system",
      name: `bootstrap-token-${token.split(".")[0]}`,
      uid,
      resourceVersion: "1",
    },
    data: {
      "token-id": Buffer.from(token.split(".")[0]!).toString("base64"),
      "token-secret": Buffer.from(token.split(".")[1]!).toString("base64"),
    },
  });
  let all = [make(oldToken, oldPod), make(newToken, newPod)],
    saved: unknown,
    writes = 0;
  const commands = {
    async authorize() {},
    async checkpoint(value: unknown) {
      saved = structuredClone(value);
    },
    async kube(args: string[], payload?: string) {
      if (args[0] === "delete") {
        writes++;
        assert.deepEqual(JSON.parse(payload!).preconditions, {
          uid: oldPod,
          resourceVersion: "1",
        });
        all = all.slice(1);
        throw Error("reply_lost");
      }
      return JSON.stringify({ items: all, metadata: {} });
    },
  };
  const input = { old_token: oldToken, new_token: newToken };
  await assert.rejects(retireRotationBootstrapToken(input, commands));
  const result = await retireRotationBootstrapToken(
    { ...input, cursor: saved },
    commands,
  );
  assert.equal(writes, 1);
  assert.equal(result.old_secret_absent, true);
  assert.equal(all[0]!.metadata.uid, newPod);
});

test("a pre-write authority failure leaves Secret rewrite pending and permits the same intent after recovery", async () => {
  let actual = secret(),
    saved: unknown,
    allowed = false,
    writes = 0;
  const commands = {
    async authorize() {
      if (!allowed) throw Error("carrier_changed");
    },
    async checkpoint(value: unknown) {
      saved = structuredClone(value);
    },
    async kube(args: string[], payload?: string) {
      if (args[0] === "replace") {
        writes++;
        actual = JSON.parse(payload!);
        actual.metadata.resourceVersion = "2";
      }
      return JSON.stringify(
        args[2] === "/api/v1/secrets"
          ? { items: [actual], metadata: {} }
          : actual,
      );
    },
  };
  await assert.rejects(
    rewriteRotationSecrets({ key_name: "replacement" }, commands),
    /carrier_changed/,
  );
  assert.equal((saved as { state: string }).state, "pending");
  assert.equal(writes, 0);
  allowed = true;
  await rewriteRotationSecrets(
    { key_name: "replacement", cursor: saved },
    commands,
  );
  assert.equal(writes, 1);
});
