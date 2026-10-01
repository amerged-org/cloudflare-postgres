// SPDX-License-Identifier: Apache-2.0
import {
  AppsV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
  Observable,
} from "@kubernetes/client-node";
import { WebSocketHandler } from "@kubernetes/client-node/dist/web-socket-handler.js";
import type { ConfigurationOptions, V1Status } from "@kubernetes/client-node";
import WebSocket from "ws";
import { PassThrough, Writable } from "node:stream";
import { isAbsolute, posix } from "node:path";
import { verifyDaemonPeer } from "./node-observer.ts";
import type {
  NodeObserverPeer,
  NodeObserverConfiguration,
} from "./node-observer.ts";
import {
  deliveryPeerProfile,
  observerView,
  validDeliveryConfiguration,
} from "./node-delivery-profile.ts";
import {
  MAX_FRAME,
  unknown,
  uncertain,
  fields,
  encoded,
  binary,
  frame,
  hash,
  challengeFor,
  permitDuration,
  decodeAgentFrame,
} from "./node-delivery-protocol.ts";
import type { PostgresExpectedManifest } from "./execution-manifest.ts";
import type {
  ExecutionPermitChallenge,
  SignedExecutionPermit,
} from "./execution-permit-types.ts";

export interface NodeDeliveryConfiguration extends Omit<
  NodeObserverConfiguration,
  "observerNamespace" | "observerNamespaceUid"
> {
  deliveryNamespace: string;
  deliveryNamespaceUid: string;
  kubeletRoot: string;
}
export interface NodeDeliveryInitialization {
  version: 1;
  requestId: string;
  scope: {
    installationId: string;
    regionId: string;
    nodeName: string;
    nodeUid: string;
    expectedBootId: string;
  };
  pod: {
    podUid: string;
    namespace: string;
    podName: string;
    containerName: "postgres";
    containerId: string;
    attempt: number;
    volumeName: string;
    containerPath: string;
    emptyDir: true;
    subPath: "";
    subPathExpr: "";
  };
  kubeletRoot: string;
  privateDirectory: string;
  guardUid: number;
  guardGid: number;
  nonce: string;
  expected: PostgresExpectedManifest;
  publicKeyPin: { version: 2; keyId: string; publicKey: string };
}
export interface NodeDeliverySelf {
  podUid: string;
  namespace: string;
  nodeName: string;
  installationId: string;
  regionId: string;
}
export interface NodeDeliveryReceipt {
  version: 1;
  type: "receipt";
  requestId: string;
  self: NodeDeliverySelf;
  challengeHash: string;
  permitHash: string;
  state: "published" | "replayed";
  deadlineBootNs: string;
}
export interface NodeDeliveryAuthority {
  check: () => void;
  expiresAt: () => number;
  revalidate: (signal: AbortSignal) => Promise<void>;
  issue: (
    challenge: ExecutionPermitChallenge,
    signal: AbortSignal,
  ) => Promise<SignedExecutionPermit>;
  signal?: AbortSignal;
}
export interface NodeDelivery {
  deliver(
    init: NodeDeliveryInitialization,
    authority: NodeDeliveryAuthority,
  ): Promise<{ receipt: NodeDeliveryReceipt; probeHash: string }>;
}

function validateInitialization(
  init: NodeDeliveryInitialization,
  config: NodeDeliveryConfiguration,
): DeliveryPeer {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
    label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
  if (
    !fields(init, [
      "version",
      "requestId",
      "scope",
      "pod",
      "kubeletRoot",
      "privateDirectory",
      "guardUid",
      "guardGid",
      "nonce",
      "expected",
      "publicKeyPin",
    ]) ||
    init.version !== 1 ||
    !uuid.test(init.requestId) ||
    !fields(init.scope, [
      "installationId",
      "regionId",
      "nodeName",
      "nodeUid",
      "expectedBootId",
    ]) ||
    !fields(init.pod, [
      "podUid",
      "namespace",
      "podName",
      "containerName",
      "containerId",
      "attempt",
      "volumeName",
      "containerPath",
      "emptyDir",
      "subPath",
      "subPathExpr",
    ]) ||
    !fields(init.expected, ["version", "binding", "command"]) ||
    init.expected.version !== 2 ||
    !fields(init.publicKeyPin, ["version", "keyId", "publicKey"]) ||
    init.publicKeyPin.version !== 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(init.publicKeyPin.keyId) ||
    !binary(init.publicKeyPin.publicKey, 32) ||
    !binary(init.nonce, 32) ||
    init.kubeletRoot !== config.kubeletRoot ||
    !label.test(init.privateDirectory) ||
    !Number.isSafeInteger(init.guardUid) ||
    init.guardUid < 1 ||
    init.guardUid > 4294967294 ||
    !Number.isSafeInteger(init.guardGid) ||
    init.guardGid < 0 ||
    init.guardGid > 4294967294
  )
    throw unknown();
  const peer = config.peers.find((p) => p.nodeName === init.scope.nodeName),
    b = init.expected.binding,
    p = init.pod;
  if (
    !peer ||
    init.scope.installationId !== config.installationId ||
    init.scope.regionId !== config.regionId ||
    init.scope.nodeUid !== peer.nodeUid ||
    init.scope.expectedBootId !== peer.bootId ||
    !fields(b, [
      "installationId",
      "organizationId",
      "projectId",
      "regionId",
      "reservationId",
      "reservationRevision",
      "reservationEpoch",
      "operationId",
      "environmentId",
      "specRevision",
      "specHash",
      "runEpoch",
      "namespace",
      "namespaceUid",
      "podUid",
      "containerName",
      "nodeName",
      "nodeUid",
      "bootId",
      "imageHash",
      "commandHash",
      "resourceEnvelopeHash",
    ]) ||
    b.installationId !== config.installationId ||
    b.regionId !== config.regionId ||
    b.nodeName !== peer.nodeName ||
    b.nodeUid !== peer.nodeUid ||
    b.bootId !== peer.bootId ||
    b.containerName !== "postgres" ||
    b.podUid !== p.podUid ||
    b.namespace !== p.namespace ||
    p.containerName !== "postgres" ||
    !uuid.test(p.podUid) ||
    !label.test(p.namespace) ||
    typeof p.podName !== "string" ||
    p.podName.length > 253 ||
    !p.podName.split(".").every((x) => label.test(x)) ||
    !/^[a-f0-9]{64}$/.test(p.containerId) ||
    !Number.isSafeInteger(p.attempt) ||
    p.attempt < 0 ||
    p.attempt > 4294967295 ||
    !label.test(p.volumeName) ||
    !posix.isAbsolute(p.containerPath) ||
    posix.normalize(p.containerPath) !== p.containerPath ||
    p.containerPath === "/" ||
    p.emptyDir !== true ||
    p.subPath !== "" ||
    p.subPathExpr !== ""
  )
    throw unknown();
  if (
    !Array.isArray(init.expected.command) ||
    init.expected.command.length < 1 ||
    init.expected.command.length > 64 ||
    !init.expected.command.every(
      (x) => typeof x === "string" && !x.includes("\0"),
    ) ||
    !posix.isAbsolute(init.expected.command[0]!) ||
    [b.imageHash, b.commandHash, b.specHash, b.resourceEnvelopeHash].some(
      (x) => !/^([a-f0-9]{64})$/.test(x),
    )
  )
    throw unknown();
  frame(init);
  return peer;
}

export function nodeDeliveryFromConfig(
  file: string,
  context: string,
  supplied: NodeDeliveryConfiguration,
): NodeDelivery {
  let config: NodeDeliveryConfiguration, kube: KubeConfig;
  try {
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      !isAbsolute(file) ||
      !context ||
      !validDeliveryConfiguration(supplied)
    )
      throw unknown();
    config = structuredClone(supplied);
    kube = new KubeConfig();
    kube.loadFromFile(file);
    if (!kube.getContexts().some((x) => x.name === context)) throw unknown();
    kube.setCurrentContext(context);
    const cluster = kube.getCurrentCluster();
    if (
      !cluster ||
      cluster.skipTLSVerify ||
      new URL(cluster.server).protocol !== "https:"
    )
      throw unknown();
  } catch {
    throw unknown();
  }
  const core = kube.makeApiClient(CoreV1Api),
    apps = kube.makeApiClient(AppsV1Api),
    view = observerView(config),
    profile = deliveryPeerProfile(config.kubeletRoot);
  return {
    async deliver(suppliedInit, authority) {
      let init: NodeDeliveryInitialization, peer: DeliveryPeer;
      try {
        init = structuredClone(suppliedInit);
        peer = validateInitialization(init, config);
        if (
          typeof authority.check !== "function" ||
          typeof authority.expiresAt !== "function" ||
          typeof authority.revalidate !== "function" ||
          typeof authority.issue !== "function"
        )
          throw unknown();
      } catch {
        throw unknown();
      }
      let publicationPossible = false;
      const remaining = authority.expiresAt() - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw unknown();
      const timeout = Math.min(20_000, remaining),
        deadline = performance.now() + timeout,
        controller = new AbortController();
      const signal = authority.signal
          ? AbortSignal.any([authority.signal, controller.signal])
          : controller.signal,
        sockets = new Set<WebSocket>();
      const streams = {
        stdin: new PassThrough(),
        stdout: null as Writable | null,
        stderr: null as Writable | null,
      };
      const error = () => (publicationPossible ? uncertain() : unknown());
      const guard = () => {
        authority.check();
        if (
          signal.aborted ||
          performance.now() >= deadline ||
          Date.now() >= authority.expiresAt()
        )
          throw error();
      };
      let onAbort: () => void = () => {};
      const expired = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          for (const socket of sockets) socket.terminate();
          reject(error());
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const timer = setTimeout(() => controller.abort(), timeout);
      const bounded = <T>(pending: Promise<T>) =>
        Promise.race([pending, expired]);
      const options: ConfigurationOptions = {
        middlewareMergeStrategy: "append",
        middleware: [
          {
            pre(request) {
              guard();
              request.setSignal(signal);
              return new Observable(Promise.resolve(request));
            },
            post(response) {
              return new Observable(Promise.resolve(response));
            },
          },
        ],
      };
      const verifyPeer = () =>
        verifyDaemonPeer(core, apps, options, view, peer, profile);
      const self: NodeDeliverySelf = {
        podUid: peer.podUid,
        namespace: config.deliveryNamespace,
        nodeName: peer.nodeName,
        installationId: config.installationId,
        regionId: config.regionId,
      };
      try {
        guard();
        await bounded(authority.revalidate(signal));
        guard();
        const before = await bounded(verifyPeer());
        guard();
        const receipt = await bounded(
          new Promise<NodeDeliveryReceipt>((resolve, reject) => {
            let phase: "initial" | "challenged" | "permit-sent" | "receipt" =
                "initial",
              settled = false,
              statusSuccess = false,
              stdoutFinished = false,
              socketClosed = false,
              stdoutBytes = 0,
              stderrBytes = 0,
              buffered = Buffer.alloc(0),
              receipt: NodeDeliveryReceipt | null = null,
              challengeHash = "",
              permitHash = "",
              anchor = 0n,
              duration = 0n;
            const fail = () => {
              if (settled) return;
              settled = true;
              for (const socket of sockets) socket.terminate();
              reject(error());
            };
            const finish = () => {
              if (!settled && statusSuccess && stdoutFinished && socketClosed) {
                if (phase !== "receipt" || !receipt || buffered.length !== 0) {
                  fail();
                  return;
                }
                settled = true;
                resolve(receipt);
              }
            };
            const refreshed = async () => {
              guard();
              const current = await bounded(verifyPeer());
              guard();
              if (encoded(current) !== encoded(before)) throw error();
              await bounded(authority.revalidate(signal));
              guard();
            };
            const received = (raw: Buffer) => {
              guard();
              if (settled || statusSuccess) throw error();
              const value = decodeAgentFrame(raw, self);
              if (value.requestId !== init.requestId) throw error();
              if (phase === "initial") {
                const expected = challengeFor(init);
                const actualHash = hash(JSON.stringify(expected));
                if (
                  value.type !== "challenge" ||
                  encoded(value.challenge) !== encoded(expected) ||
                  value.challengeHash !== actualHash ||
                  typeof value.anchorBootNs !== "string" ||
                  !/^(0|[1-9][0-9]{0,18})$/.test(value.anchorBootNs) ||
                  BigInt(value.anchorBootNs) > 9223372021854775807n
                )
                  throw error();
                challengeHash = actualHash;
                anchor = BigInt(value.anchorBootNs);
                phase = "challenged";
                void (async () => {
                  await refreshed();
                  guard();
                  if (settled || phase !== "challenged") throw error();
                  const permit = structuredClone(
                    await bounded(authority.issue(expected, signal)),
                  );
                  guard();
                  if (settled || phase !== "challenged") throw error();
                  duration = permitDuration(permit, init);
                  permitHash = hash(JSON.stringify(permit));
                  const bytes = frame({
                    version: 1,
                    type: "permit",
                    requestId: init.requestId,
                    challengeHash,
                    permit,
                  });
                  await refreshed();
                  if (settled || phase !== "challenged" || statusSuccess)
                    throw error();
                  guard();
                  // A stream write is not delivery proof. Mark uncertainty before any byte.
                  publicationPossible = true;
                  phase = "permit-sent";
                  streams.stdin.write(bytes);
                })().catch(fail);
                return;
              }
              if (
                phase !== "permit-sent" ||
                value.type !== "receipt" ||
                value.challengeHash !== challengeHash ||
                value.permitHash !== permitHash ||
                !["published", "replayed"].includes(String(value.state)) ||
                typeof value.deadlineBootNs !== "string" ||
                value.deadlineBootNs !== String(anchor + duration)
              )
                throw error();
              receipt = value as unknown as NodeDeliveryReceipt;
              phase = "receipt";
            };
            const stdout = new Writable({
              write(chunk, _encoding, done) {
                try {
                  const bytes = Buffer.from(chunk);
                  stdoutBytes += bytes.length;
                  if (stdoutBytes > 2 * (MAX_FRAME + 4)) throw error();
                  buffered = Buffer.concat([buffered, bytes]);
                  while (buffered.length >= 4) {
                    const length = buffered.readUInt32BE(0);
                    if (length < 1 || length > MAX_FRAME) throw error();
                    if (buffered.length < length + 4) break;
                    const raw = buffered.subarray(4, length + 4);
                    buffered = buffered.subarray(length + 4);
                    received(raw);
                  }
                  done();
                } catch {
                  fail();
                  done();
                }
              },
            });
            const stderr = new Writable({
              write(chunk, _encoding, done) {
                stderrBytes += Buffer.byteLength(chunk);
                if (stderrBytes > 4096) fail();
                done();
              },
            });
            streams.stdout = stdout;
            streams.stderr = stderr;
            stdout.on("error", fail);
            stderr.on("error", fail);
            streams.stdin.on("error", fail);
            stdout.on("finish", () => {
              stdoutFinished = true;
              finish();
            });
            const handler = new WebSocketHandler(
              kube,
              (uri, protocols, httpsOptions) => {
                guard();
                if (
                  !uri.startsWith("wss://") ||
                  httpsOptions.rejectUnauthorized === false
                )
                  throw error();
                const socket = new WebSocket(
                  uri,
                  protocols.filter((p) => p === "v4.channel.k8s.io"),
                  {
                    ...httpsOptions,
                    handshakeTimeout: Math.max(
                      1,
                      Math.floor(deadline - performance.now()),
                    ),
                    maxPayload: 2 * (MAX_FRAME + 4) + 1,
                    perMessageDeflate: false,
                  },
                );
                sockets.add(socket);
                socket.on("error", fail);
                socket.on("close", () => {
                  socketClosed = true;
                  if (!statusSuccess) fail();
                  else finish();
                });
                return new Proxy(socket, {
                  get(target, key) {
                    const value = Reflect.get(target, key, target);
                    return typeof value === "function"
                      ? value.bind(target)
                      : value;
                  },
                  set(target, key, value) {
                    if (key === "onmessage" && typeof value === "function")
                      return Reflect.set(
                        target,
                        key,
                        (event: WebSocket.MessageEvent) => {
                          try {
                            guard();
                            if (
                              !Buffer.isBuffer(event.data) ||
                              event.data.length < 1 ||
                              ![1, 2, 3].includes(event.data[0]!)
                            )
                              throw error();
                            value(event);
                          } catch {
                            fail();
                          }
                        },
                        target,
                      );
                    return Reflect.set(target, key, value, target);
                  },
                });
              },
              { stdin: streams.stdin, stdout, stderr },
            );
            void new Exec(kube, handler)
              .exec(
                config.deliveryNamespace,
                peer.podName,
                "delivery",
                [
                  "/node-execution-delivery",
                  "--endpoint",
                  "unix:///run/cri.sock",
                ],
                stdout,
                stderr,
                streams.stdin,
                false,
                (status: V1Status) => {
                  if (
                    status.status !== "Success" ||
                    (status.kind !== undefined && status.kind !== "Status") ||
                    (status.apiVersion !== undefined &&
                      status.apiVersion !== "v1") ||
                    phase !== "receipt"
                  ) {
                    fail();
                    return;
                  }
                  statusSuccess = true;
                  finish();
                },
              )
              .then((socket) => {
                try {
                  guard();
                  if (settled || socket.readyState !== WebSocket.OPEN)
                    throw error();
                  streams.stdin.write(frame(init));
                } catch {
                  fail();
                }
              })
              .catch(fail);
          }),
        );
        guard();
        const after = await bounded(verifyPeer());
        guard();
        if (encoded(before) !== encoded(after)) throw error();
        await bounded(authority.revalidate(signal));
        guard();
        return { receipt, probeHash: hash(encoded(receipt)) };
      } catch {
        throw error();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        for (const socket of sockets) socket.terminate();
        streams.stdin.destroy();
        streams.stdout?.destroy();
        streams.stderr?.destroy();
      }
    },
  };
}
export type DeliveryPeer = NodeObserverPeer;
