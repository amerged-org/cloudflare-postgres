// SPDX-License-Identifier: Apache-2.0
// A node that is being installed, on real D1: the addition that reached its audit, the tokens of
// its install, the installer's checkpoints and the enrollment.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import {
  INSTALLER_CHECKPOINTS,
  NodeSample,
  nodePublicKey,
  randomString,
  type NodeKey,
} from "@pgcf/contracts";
import { issueNodeInstall } from "../../src/domain/node-install.ts";
import {
  configureNodeRegionPolicy,
  recordNodeAudit,
  recordNodeReceipt,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { NODE_HEADER, NODE_UID_HEADER } from "../../src/node-actor.ts";
import { fixture, rawRequest } from "./fixtures.ts";

const installs: string[] = [];
/** Removes the installs the test made; the fixtures' own cleanup removes the nodes and additions. */
export async function forgetInstalls(): Promise<void> {
  for (const id of installs.splice(0))
    await env.DB.prepare("DELETE FROM node_installs WHERE node_id=?")
      .bind(id)
      .run();
}

export const v4 = "192.0.2.10";
/** An address of the instance's IPv6 prefix: the provider reports it, and no enrollment may use it. */
export const v6 = "2001:db8:1234:5678::10";
export const sources = [v4];
const providerId = () => String(BigInt("1" + randomString("0123456789", 9)));

/** An addition that has reached its audit: the instance exists and the installer may run. */
export async function auditedAddition() {
  const f = await fixture();
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(f.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: false,
    order: {
      product_id: crypto.randomUUID(),
      provider_region: "EU",
      image_id: crypto.randomUUID(),
      term_months: 1,
      location: crypto.randomUUID(),
    },
  });
  const instance = providerId();
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      region_id: f.region,
      mode: "adopt",
      provider_instance_id: instance,
    },
  });
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: instance,
      request_id: null,
      reference: crypto.randomUUID(),
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: instance,
      provider_region: "EU",
      product_id: crypto.randomUUID(),
      image_id: crypto.randomUUID(),
      reference: crypto.randomUUID(),
      observed_at: new Date().toISOString(),
    },
  );
  const id = addition.intent.node_id;
  installs.push(id);
  return { f, id, instance, addition };
}
export async function newKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    key: pair.privateKey as NodeKey,
    publicKey: await nodePublicKey(pair.publicKey as NodeKey),
  };
}
export const progress = (token: string, checkpoint: string, detail = "") =>
  rawRequest("/node/v1/installer/progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ checkpoint, detail }),
  });
export const enroll = (
  body: Record<string, unknown>,
  address: string | null = v4,
) =>
  rawRequest("/node/v1/enroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(address ? { "CF-Connecting-IP": address } : {}),
    },
    body: JSON.stringify(body),
  });
export async function installed(
  checkpoints: readonly string[] = INSTALLER_CHECKPOINTS.filter(
    (c) => c !== "failed",
  ),
) {
  const a = await auditedAddition();
  const issued = await issueNodeInstall(env, {
    node_id: a.id,
    image_version: "1.2.0",
    sources,
  });
  for (const checkpoint of checkpoints)
    expect((await progress(issued.progress_token, checkpoint)).status).toBe(
      200,
    );
  const { key, publicKey } = await newKey();
  const request = {
    node_id: a.id,
    enrollment_token: issued.enrollment_token,
    public_key: publicKey,
    image_version: "1.2.0",
  };
  return { ...a, issued, key, publicKey, request };
}

/** The next message a socket receives. */
export const nextMessage = (socket: WebSocket) =>
  new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    }),
  );
/**
 * What the NodeActor of a node holds of its link, read from the object's own storage and sockets:
 * whether an agent that said hello is connected, and the newest sample with when it arrived.
 */
export const heldLink = (node: string) =>
  runInDurableObject(
    env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(node)),
    (_instance, state) => {
      const row = state.storage.sql
        .exec<{ sample: string | null; received_at: number | null }>(
          "SELECT sample,received_at FROM node_link WHERE singleton=1",
        )
        .toArray()[0];
      return {
        connected: state
          .getWebSockets("agent")
          .some(
            (socket) =>
              (socket.deserializeAttachment() as { hello?: boolean } | null)
                ?.hello === true,
          ),
        received_at: row?.received_at ?? null,
        sample: row?.sample ? NodeSample.parse(JSON.parse(row.sample)) : null,
      };
    },
  );
/** The link of a node as the Worker hands it to the NodeActor, greeted with a hello unless told not to. */
export async function openLink(
  f: { node: string; nodeUid: string },
  greet = true,
): Promise<WebSocket> {
  const response = await env.NODE_ACTOR.get(
    env.NODE_ACTOR.idFromName(f.node),
  ).fetch(
    new Request(`https://${["link", "invalid"].join(".")}/node/v1/link`, {
      headers: {
        Upgrade: "websocket",
        [NODE_HEADER]: f.node,
        [NODE_UID_HEADER]: f.nodeUid,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  if (greet) {
    const welcome = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        agent_version: "0.1.0",
        release_id: null,
      }),
    );
    expect(JSON.parse(await welcome)).toEqual({ type: "welcome", protocol: 1 });
  }
  return socket;
}
