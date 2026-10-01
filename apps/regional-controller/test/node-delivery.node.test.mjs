// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:https";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadAll } from "js-yaml";
import { WebSocketServer } from "ws";
import { nodeDeliveryFromConfig } from "../src/node-delivery.ts";

const golden = JSON.parse(
  readFileSync(
    new URL(
      "../../execution-guard/testdata/signed-window-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const payload = JSON.parse(golden.payload),
  b = payload.binding;
const id = {
  ns: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  pod: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  owner: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  foreign: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const digest = (char) => `sha256:${char.repeat(64)}`;
const config = {
  installationId: b.installationId,
  regionId: b.regionId,
  deliveryNamespace: "pgcf-runtime-delivery",
  deliveryNamespaceUid: id.ns,
  owner: { kind: "DaemonSet", name: "node-execution-delivery", uid: id.owner },
  image: {
    reference: `ghcr.io/amerged-org/cloudflare-postgres/node-execution-delivery@${digest("d")}`,
    indexDigest: digest("d"),
    amd64Digest: digest("e"),
    configDigest: digest("f"),
  },
  peers: [
    {
      nodeName: b.nodeName,
      nodeUid: b.nodeUid,
      bootId: b.bootId,
      podName: "delivery-fixture",
      podUid: id.pod,
    },
  ],
  kubeletRoot: "/var/lib/kubelet",
};
const labels = {
  "app.kubernetes.io/managed-by": "cloudflare-postgres",
  "pgcf.io/component": "node-execution-delivery",
};
const yaml = readFileSync(
  new URL(
    "../../node-runtime-observer/deploy/delivery.example.yaml",
    import.meta.url,
  ),
  "utf8",
)
  .replaceAll("REPLACE_DIGEST_PINNED_DELIVERY_IMAGE", config.image.reference)
  .replaceAll("REPLACE_INSTALLATION_ID", config.installationId)
  .replaceAll("REPLACE_REGION_ID", config.regionId);
const template = loadAll(yaml).find((x) => x.kind === "DaemonSet").spec
  .template;
const spec = { ...template.spec, nodeName: b.nodeName };
const init = {
  version: 1,
  requestId: "12345678-1234-4234-8234-123456789abc",
  scope: {
    installationId: b.installationId,
    regionId: b.regionId,
    nodeName: b.nodeName,
    nodeUid: b.nodeUid,
    expectedBootId: b.bootId,
  },
  pod: {
    podUid: b.podUid,
    namespace: b.namespace,
    podName: "database-1",
    containerName: "postgres",
    containerId: "a".repeat(64),
    attempt: 1,
    volumeName: "pgcf-execution-ipc-postgres",
    containerPath: "/pgcf/ipc/postgres",
    emptyDir: true,
    subPath: "",
    subPathExpr: "",
  },
  kubeletRoot: config.kubeletRoot,
  privateDirectory: "private",
  guardUid: 26,
  guardGid: 26,
  nonce: payload.nonce,
  expected: { version: 2, binding: b, command: golden.command },
  publicKeyPin: {
    version: 2,
    keyId: golden.keyId,
    publicKey: golden.publicKey,
  },
};
const permit = {
  version: 2,
  keyId: golden.keyId,
  payload: Buffer.from(golden.payload).toString("base64url"),
  signature: golden.signature,
};
const challenge = {
  version: 2,
  nonce: payload.nonce,
  binding: {
    installationId: b.installationId,
    namespaceUid: b.namespaceUid,
    podUid: b.podUid,
    containerName: b.containerName,
    nodeName: b.nodeName,
    nodeUid: b.nodeUid,
    bootId: b.bootId,
    imageHash: b.imageHash,
    commandHash: b.commandHash,
  },
};
const self = {
  podUid: id.pod,
  namespace: config.deliveryNamespace,
  nodeName: b.nodeName,
  installationId: b.installationId,
  regionId: b.regionId,
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}
function agentFrame(value) {
  return frame(
    Object.fromEntries(
      Object.entries(value).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)),
    ),
  );
}

async function fixture(t, mode = "success") {
  const issuedPermit = structuredClone(permit);
  const directory = mkdtempSync(join(tmpdir(), "pgcf-delivery-tls-"));
  const cert = readFileSync(
      new URL("./fixtures/node-observer-tls/cert.pem", import.meta.url),
    ),
    key = readFileSync(
      new URL("./fixtures/node-observer-tls/key.pem", import.meta.url),
    );
  const state = {
    reads: 0,
    execs: 0,
    issued: 0,
    revalidated: 0,
    inputFrames: [],
    replaced: false,
    protocols: [],
  };
  const server = createServer(
    { key, cert, ca: cert, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      assert.equal(request.socket.authorized, true);
      state.reads++;
      const path = new URL(request.url, "https://localhost").pathname;
      let object;
      if (path === `/api/v1/nodes/${b.nodeName}`)
        object = {
          apiVersion: "v1",
          kind: "Node",
          metadata: { name: b.nodeName, uid: b.nodeUid },
          status: { nodeInfo: { bootID: b.bootId, architecture: "amd64" } },
        };
      if (path === `/api/v1/namespaces/${config.deliveryNamespace}`)
        object = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: config.deliveryNamespace, uid: id.ns, labels },
        };
      if (
        path ===
        `/api/v1/namespaces/${config.deliveryNamespace}/pods/delivery-fixture`
      )
        object = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: "delivery-fixture",
            namespace: config.deliveryNamespace,
            uid: state.replaced ? id.foreign : id.pod,
            labels,
            ownerReferences: [
              {
                kind: "DaemonSet",
                apiVersion: "apps/v1",
                name: config.owner.name,
                uid: id.owner,
                controller: true,
              },
            ],
          },
          spec,
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
            containerStatuses: [
              {
                name: "delivery",
                image: config.image.reference,
                imageID: config.image.configDigest,
                containerID: `containerd://${"b".repeat(64)}`,
                restartCount: 0,
                ready: true,
                state: { running: { startedAt: "2026-10-01T00:00:00Z" } },
              },
            ],
          },
        };
      if (
        path ===
        `/apis/apps/v1/namespaces/${config.deliveryNamespace}/daemonsets/${config.owner.name}`
      )
        object = {
          apiVersion: "apps/v1",
          kind: "DaemonSet",
          metadata: {
            name: config.owner.name,
            namespace: config.deliveryNamespace,
            uid: id.owner,
            generation: 1,
            labels,
          },
          spec: { selector: { matchLabels: labels }, template },
          status: { observedGeneration: 1 },
        };
      if (!object) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(object));
    },
  );
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => "v4.channel.k8s.io",
  });
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.socket.authorized, true);
    state.protocols = request.headers["sec-websocket-protocol"]
      .split(",")
      .map((x) => x.trim());
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request),
    );
  });
  wss.on("connection", (ws, request) => {
    state.execs++;
    const url = new URL(request.url, "https://localhost");
    assert.equal(url.searchParams.get("stdin"), "true");
    assert.equal(url.searchParams.get("tty"), "false");
    assert.equal(url.searchParams.get("container"), "delivery");
    assert.deepEqual(url.searchParams.getAll("command"), [
      "/node-execution-delivery",
      "--endpoint",
      "unix:///run/cri.sock",
    ]);
    let buffered = Buffer.alloc(0);
    ws.on("message", (raw) => {
      assert.equal(raw[0], 0);
      buffered = Buffer.concat([buffered, raw.subarray(1)]);
      while (
        buffered.length >= 4 &&
        buffered.length >= 4 + buffered.readUInt32BE(0)
      ) {
        const length = buffered.readUInt32BE(0),
          message = JSON.parse(buffered.subarray(4, 4 + length));
        buffered = buffered.subarray(4 + length);
        state.inputFrames.push(message);
        if (state.inputFrames.length === 1) {
          assert.deepEqual(message, init);
          if (mode === "replace-on-challenge") state.replaced = true;
          const out = agentFrame({
            version: 1,
            type: "challenge",
            requestId: init.requestId,
            self,
            challenge,
            challengeHash: hash(JSON.stringify(challenge)),
            anchorBootNs: "1000000000",
          });
          ws.send(Buffer.concat([Buffer.from([1]), out.subarray(0, 7)]));
          ws.send(Buffer.concat([Buffer.from([1]), out.subarray(7)]));
        } else {
          assert.equal(state.inputFrames.length, 2);
          assert.equal(message.type, "permit");
          assert.equal(message.requestId, init.requestId);
          if (mode !== "mutate-issued-permit")
            assert.deepEqual(message.permit, permit);
          if (mode === "lost-after-permit") {
            ws.close();
            return;
          }
          ws.send(
            Buffer.concat([
              Buffer.from([1]),
              agentFrame({
                version: 1,
                type: "receipt",
                requestId: init.requestId,
                self,
                challengeHash: message.challengeHash,
                permitHash: hash(JSON.stringify(message.permit)),
                state: "published",
                deadlineBootNs: "11000000000",
              }),
            ]),
          );
          ws.send(
            Buffer.concat([
              Buffer.from([3]),
              Buffer.from(
                JSON.stringify({
                  kind: "Status",
                  apiVersion: "v1",
                  status: "Success",
                }),
              ),
            ]),
          );
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const file = join(directory, "kubeconfig.json");
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "local",
          cluster: {
            server: `https://127.0.0.1:${server.address().port}`,
            "tls-server-name": "localhost",
            "certificate-authority-data": cert.toString("base64"),
          },
        },
      ],
      contexts: [
        { name: "test", context: { cluster: "local", user: "fixture" } },
      ],
      "current-context": "test",
      users: [
        {
          name: "fixture",
          user: {
            "client-certificate-data": cert.toString("base64"),
            "client-key-data": key.toString("base64"),
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const authority = {
    check() {},
    expiresAt: () => Date.now() + 30_000,
    revalidate: async () => {
      state.revalidated++;
      if (mode === "mutate-issued-permit" && state.revalidated === 3)
        issuedPermit.signature = Buffer.alloc(64, 1).toString("base64url");
    },
    issue: async (received) => {
      assert.deepEqual(received, challenge);
      state.issued++;
      return issuedPermit;
    },
  };
  return {
    state,
    authority,
    client: nodeDeliveryFromConfig(file, "test", config),
  };
}

test("delivers exactly one signed permit through authenticated duplex SDK frames and completes only after matching receipt, success and unchanged peer", async (t) => {
  const f = await fixture(t, "mutate-issued-permit");
  const result = await f.client.deliver(init, f.authority);
  assert.equal(result.receipt.state, "published");
  assert.equal(result.receipt.self.podUid, id.pod);
  assert.equal(result.receipt.permitHash, hash(JSON.stringify(permit)));
  assert.match(result.probeHash, /^[a-f0-9]{64}$/);
  assert.equal(f.state.execs, 1);
  assert.equal(f.state.issued, 1);
  assert.equal(f.state.inputFrames.length, 2);
  assert.deepEqual(
    f.state.inputFrames[1].permit,
    permit,
    "transmitted bytes must retain the verified issuer snapshot across revalidation",
  );
  assert.deepEqual(f.state.protocols, ["v4.channel.k8s.io"]);
  assert.ok(f.state.reads >= 12);
  assert.ok(f.state.revalidated >= 3);
});
test("retains an uncertain outcome after permit send and lost publication acknowledgement without issuing or dispatching again", async (t) => {
  const f = await fixture(t, "lost-after-permit");
  await assert.rejects(
    f.client.deliver(init, f.authority),
    /^Error: node_execution_publication_uncertain$/,
  );
  assert.equal(f.state.issued, 1);
  assert.equal(f.state.execs, 1);
  assert.equal(f.state.inputFrames.length, 2);
});
test("refuses a replaced challenged delivery peer before requesting a permit", async (t) => {
  const f = await fixture(t, "replace-on-challenge");
  await assert.rejects(
    f.client.deliver(init, f.authority),
    /^Error: node_execution_delivery_unknown$/,
  );
  assert.equal(f.state.execs, 1);
  assert.equal(f.state.issued, 0);
  assert.equal(f.state.inputFrames.length, 1);
});
