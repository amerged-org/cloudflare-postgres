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
import { Writable, PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export interface NodeObserverPeer {
  nodeName: string;
  nodeUid: string;
  bootId: string;
  podName: string;
  podUid: string;
}
export interface NodeObserverConfiguration {
  installationId: string;
  regionId: string;
  observerNamespace: string;
  observerNamespaceUid: string;
  owner: { kind: "DaemonSet"; name: string; uid: string };
  image: {
    reference: string;
    indexDigest: string;
    amd64Digest: string;
    configDigest: string;
  };
  peers: NodeObserverPeer[];
}
export interface RuntimeSandbox {
  id: string;
  podUid: string;
  namespace: string;
  name: string;
  state: string;
  createdAtUnixNs: string;
}
export interface RuntimeContainer {
  id: string;
  sandboxId: string;
  podUid: string;
  namespace: string;
  name: string;
  attempt: number;
  state: string;
  createdAtUnixNs: string;
  startedAtUnixNs: string;
  finishedAtUnixNs: string;
}
export interface NodeRuntimeSnapshot {
  version: 1;
  scope: {
    installationId: string;
    regionId: string;
    nodeName: string;
    nodeUid: string;
    expectedBootId: string;
  };
  bootId: string;
  startedAt: string;
  finishedAt: string;
  sandboxes: RuntimeSandbox[];
  containers: RuntimeContainer[];
}
export interface NodeObserverEnvelope {
  version: 1;
  requestId: string;
  observerPodUid: string;
  observerNamespace: string;
  observerNodeName: string;
  snapshot: NodeRuntimeSnapshot;
}
export interface NodeObserverResult {
  envelope: NodeObserverEnvelope;
  probeHash: string;
}
export interface NodeObserver {
  observeNode(nodeName: string): Promise<NodeObserverResult>;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const runtimeId = /^[a-f0-9]{64}$/;
const scope = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const MAX_STDOUT = 8 * 1024 * 1024,
  MAX_STDERR = 4096;
const unknown = () => new Error("node_observation_unknown");
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function dns(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.split(".").every((part) => label.test(part))
  );
}
function uid(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
function nanoseconds(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() ===
      value.replace(/(\.\d{3})\d{6}Z$/, "$1Z")
  );
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const encoded = (value: unknown) => JSON.stringify(canonical(value));
export function validNodeObserverConfig(
  value: unknown,
): value is NodeObserverConfiguration {
  if (
    !fields(value, [
      "installationId",
      "regionId",
      "observerNamespace",
      "observerNamespaceUid",
      "owner",
      "image",
      "peers",
    ]) ||
    typeof value.installationId !== "string" ||
    !scope.test(value.installationId) ||
    typeof value.regionId !== "string" ||
    !scope.test(value.regionId) ||
    typeof value.observerNamespace !== "string" ||
    !label.test(value.observerNamespace) ||
    !uid(value.observerNamespaceUid) ||
    !fields(value.owner, ["kind", "name", "uid"]) ||
    value.owner.kind !== "DaemonSet" ||
    !dns(value.owner.name) ||
    !uid(value.owner.uid) ||
    !fields(value.image, [
      "reference",
      "indexDigest",
      "amd64Digest",
      "configDigest",
    ]) ||
    typeof value.image.indexDigest !== "string" ||
    !digest.test(value.image.indexDigest) ||
    typeof value.image.amd64Digest !== "string" ||
    !digest.test(value.image.amd64Digest) ||
    typeof value.image.configDigest !== "string" ||
    !digest.test(value.image.configDigest) ||
    typeof value.image.reference !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(
      value.image.reference,
    ) ||
    !value.image.reference.endsWith(`@${value.image.indexDigest}`) ||
    !Array.isArray(value.peers) ||
    value.peers.length < 1 ||
    value.peers.length > 32
  )
    return false;
  const names = new Set<string>(),
    nodeUids = new Set<string>(),
    pods = new Set<string>(),
    podUids = new Set<string>();
  for (const peer of value.peers) {
    if (
      !fields(peer, ["nodeName", "nodeUid", "bootId", "podName", "podUid"]) ||
      !dns(peer.nodeName) ||
      !uid(peer.nodeUid) ||
      !uid(peer.bootId) ||
      !dns(peer.podName) ||
      !uid(peer.podUid) ||
      names.has(peer.nodeName) ||
      nodeUids.has(peer.nodeUid) ||
      pods.has(peer.podName) ||
      podUids.has(peer.podUid)
    )
      return false;
    names.add(peer.nodeName);
    nodeUids.add(peer.nodeUid);
    pods.add(peer.podName);
    podUids.add(peer.podUid);
  }
  return true;
}
function validSnapshot(
  value: unknown,
  config: NodeObserverConfiguration,
  peer: NodeObserverPeer,
): value is NodeRuntimeSnapshot {
  if (
    !fields(value, [
      "version",
      "scope",
      "bootId",
      "startedAt",
      "finishedAt",
      "sandboxes",
      "containers",
    ]) ||
    value.version !== 1 ||
    value.bootId !== peer.bootId ||
    !fields(value.scope, [
      "installationId",
      "regionId",
      "nodeName",
      "nodeUid",
      "expectedBootId",
    ]) ||
    value.scope.installationId !== config.installationId ||
    value.scope.regionId !== config.regionId ||
    value.scope.nodeName !== peer.nodeName ||
    value.scope.nodeUid !== peer.nodeUid ||
    value.scope.expectedBootId !== peer.bootId ||
    !instant(value.startedAt) ||
    !instant(value.finishedAt) ||
    value.finishedAt < value.startedAt ||
    Date.parse(value.finishedAt) - Date.parse(value.startedAt) > 10_000 ||
    !Array.isArray(value.sandboxes) ||
    !Array.isArray(value.containers) ||
    value.sandboxes.length + value.containers.length > 4096
  )
    return false;
  const sandboxes = new Map<string, RuntimeSandbox>(),
    containers = new Set<string>();
  for (const sandbox of value.sandboxes) {
    if (
      !fields(sandbox, [
        "id",
        "podUid",
        "namespace",
        "name",
        "state",
        "createdAtUnixNs",
      ]) ||
      typeof sandbox.id !== "string" ||
      !runtimeId.test(sandbox.id) ||
      sandboxes.has(sandbox.id) ||
      typeof sandbox.podUid !== "string" ||
      !scope.test(sandbox.podUid) ||
      typeof sandbox.namespace !== "string" ||
      !label.test(sandbox.namespace) ||
      !dns(sandbox.name) ||
      !["ready", "not_ready"].includes(String(sandbox.state)) ||
      !nanoseconds(sandbox.createdAtUnixNs) ||
      sandbox.createdAtUnixNs === "0"
    )
      return false;
    sandboxes.set(sandbox.id, sandbox as unknown as RuntimeSandbox);
  }
  for (const container of value.containers) {
    if (
      !fields(container, [
        "id",
        "sandboxId",
        "podUid",
        "namespace",
        "name",
        "attempt",
        "state",
        "createdAtUnixNs",
        "startedAtUnixNs",
        "finishedAtUnixNs",
      ]) ||
      typeof container.id !== "string" ||
      !runtimeId.test(container.id) ||
      containers.has(container.id) ||
      typeof container.sandboxId !== "string" ||
      typeof container.name !== "string" ||
      !label.test(container.name) ||
      !Number.isSafeInteger(container.attempt) ||
      Number(container.attempt) < 0 ||
      Number(container.attempt) > 4294967295 ||
      !["created", "running", "exited"].includes(String(container.state)) ||
      !nanoseconds(container.createdAtUnixNs) ||
      container.createdAtUnixNs === "0" ||
      !nanoseconds(container.startedAtUnixNs) ||
      !nanoseconds(container.finishedAtUnixNs)
    )
      return false;
    const sandbox = sandboxes.get(container.sandboxId);
    if (
      !sandbox ||
      container.podUid !== sandbox.podUid ||
      container.namespace !== sandbox.namespace ||
      (container.startedAtUnixNs !== "0" &&
        BigInt(container.startedAtUnixNs) <
          BigInt(container.createdAtUnixNs)) ||
      (container.finishedAtUnixNs !== "0" &&
        BigInt(container.finishedAtUnixNs) <
          BigInt(container.startedAtUnixNs)) ||
      (container.state === "created" &&
        (container.startedAtUnixNs !== "0" ||
          container.finishedAtUnixNs !== "0")) ||
      (container.state === "running" &&
        (BigInt(container.startedAtUnixNs) <
          BigInt(container.createdAtUnixNs) ||
          container.finishedAtUnixNs !== "0")) ||
      (container.state === "exited" &&
        BigInt(container.finishedAtUnixNs) < BigInt(container.createdAtUnixNs))
    )
      return false;
    containers.add(container.id);
  }
  return true;
}
function envelope(
  value: unknown,
  requestId: string,
  config: NodeObserverConfiguration,
  peer: NodeObserverPeer,
): NodeObserverEnvelope {
  if (
    !fields(value, [
      "version",
      "requestId",
      "observerPodUid",
      "observerNamespace",
      "observerNodeName",
      "snapshot",
    ]) ||
    value.version !== 1 ||
    value.requestId !== requestId ||
    value.observerPodUid !== peer.podUid ||
    value.observerNamespace !== config.observerNamespace ||
    value.observerNodeName !== peer.nodeName ||
    !validSnapshot(value.snapshot, config, peer)
  )
    throw unknown();
  return value as unknown as NodeObserverEnvelope;
}
function controlledLabels(
  value: unknown,
  component = "node-runtime-observer",
): boolean {
  return (
    object(value) &&
    value["app.kubernetes.io/managed-by"] === "cloudflare-postgres" &&
    value["pgcf.io/component"] === component
  );
}
function arrayEmpty(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}
const presentKeys = (value: Record<string, unknown>) =>
  Object.keys(value).filter((key) => value[key] !== undefined);
export function safeObserverPodSpec(
  value: unknown,
  config: NodeObserverConfiguration,
  nodeName?: string,
): boolean {
  if (
    !object(value) ||
    value.hostNetwork === true ||
    value.hostPID === true ||
    value.hostIPC === true ||
    value.automountServiceAccountToken !== false ||
    (nodeName !== undefined && value.nodeName !== nodeName) ||
    !arrayEmpty(value.initContainers) ||
    !arrayEmpty(value.ephemeralContainers) ||
    !Array.isArray(value.containers) ||
    value.containers.length !== 1 ||
    !Array.isArray(value.volumes) ||
    value.volumes.length !== 1
  )
    return false;
  const security = object(value.securityContext) ? value.securityContext : {};
  if (
    !object(security.seccompProfile) ||
    security.seccompProfile.type !== "RuntimeDefault"
  )
    return false;
  const container = value.containers[0],
    volume = value.volumes[0];
  if (
    !object(container) ||
    container.name !== "observer" ||
    container.image !== config.image.reference ||
    encoded(container.command) !== encoded(["/node-runtime-observer"]) ||
    encoded(container.args) !== encoded(["agent"]) ||
    !arrayEmpty(container.envFrom) ||
    container.lifecycle !== undefined ||
    !Array.isArray(container.env) ||
    container.env.length !== 5 ||
    !Array.isArray(container.volumeMounts) ||
    container.volumeMounts.length !== 1 ||
    !object(container.securityContext)
  )
    return false;
  const sec = container.securityContext;
  if (
    sec.seccompProfile !== undefined &&
    (!fields(sec.seccompProfile, ["type"]) ||
      sec.seccompProfile.type !== "RuntimeDefault")
  )
    return false;
  if (
    sec.runAsUser !== 0 ||
    sec.runAsGroup !== 0 ||
    sec.privileged === true ||
    sec.allowPrivilegeEscalation !== false ||
    sec.readOnlyRootFilesystem !== true ||
    !object(sec.capabilities) ||
    encoded(sec.capabilities.drop) !== encoded(["ALL"]) ||
    !arrayEmpty(sec.capabilities.add)
  )
    return false;
  const mount = container.volumeMounts[0];
  if (
    !object(volume) ||
    volume.name !== "cri-socket" ||
    !object(volume.hostPath) ||
    volume.hostPath.path !== "/run/containerd/containerd.sock" ||
    volume.hostPath.type !== "Socket" ||
    presentKeys(volume).length !== 2 ||
    !object(mount) ||
    mount.name !== "cri-socket" ||
    mount.mountPath !== "/run/cri.sock" ||
    mount.readOnly !== true ||
    mount.subPath !== undefined ||
    mount.subPathExpr !== undefined ||
    (mount.mountPropagation !== undefined && mount.mountPropagation !== "None")
  )
    return false;
  const expected = new Map<string, string>([
    ["PGCF_OBSERVER_POD_UID", "metadata.uid"],
    ["PGCF_OBSERVER_NAMESPACE", "metadata.namespace"],
    ["PGCF_OBSERVER_NODE_NAME", "spec.nodeName"],
  ]);
  const seen = new Set<string>();
  for (const variable of container.env) {
    if (
      !object(variable) ||
      typeof variable.name !== "string" ||
      seen.has(variable.name)
    )
      return false;
    seen.add(variable.name);
    const field = expected.get(variable.name);
    if (field) {
      if (
        (variable.value !== undefined && variable.value !== "") ||
        !object(variable.valueFrom) ||
        presentKeys(variable.valueFrom).length !== 1 ||
        !object(variable.valueFrom.fieldRef) ||
        variable.valueFrom.fieldRef.fieldPath !== field ||
        (variable.valueFrom.fieldRef.apiVersion !== undefined &&
          variable.valueFrom.fieldRef.apiVersion !== "v1")
      )
        return false;
    } else if (variable.name === "PGCF_OBSERVER_INSTALLATION_ID") {
      if (
        variable.value !== config.installationId ||
        variable.valueFrom !== undefined
      )
        return false;
    } else if (variable.name === "PGCF_OBSERVER_REGION_ID") {
      if (
        variable.value !== config.regionId ||
        variable.valueFrom !== undefined
      )
        return false;
    } else return false;
  }
  return true;
}
function qualifiedImageId(
  value: unknown,
  config: NodeObserverConfiguration,
): value is string {
  return (
    value === config.image.configDigest || value === config.image.reference
  );
}
export interface ObservationIdentity {
  podUid: string;
  containerId: string;
  imageId: string;
  restartCount: number;
  ownerGeneration: number;
  ownerTemplate: string;
}
export async function verifyDaemonPeer(
  core: CoreV1Api,
  apps: AppsV1Api,
  options: ConfigurationOptions,
  config: NodeObserverConfiguration,
  peer: NodeObserverPeer,
  profile: {
    component: string;
    containerName: string;
    safeSpec: typeof safeObserverPodSpec;
  } = {
    component: "node-runtime-observer",
    containerName: "observer",
    safeSpec: safeObserverPodSpec,
  },
): Promise<ObservationIdentity> {
  const [namespace, node, pod, owner] = await Promise.all([
    core.readNamespace({ name: config.observerNamespace }, options),
    core.readNode({ name: peer.nodeName }, options),
    core.readNamespacedPod(
      { namespace: config.observerNamespace, name: peer.podName },
      options,
    ),
    apps.readNamespacedDaemonSet(
      { namespace: config.observerNamespace, name: config.owner.name },
      options,
    ),
  ]);
  if (
    namespace.metadata?.uid !== config.observerNamespaceUid ||
    namespace.metadata.name !== config.observerNamespace ||
    namespace.metadata.deletionTimestamp ||
    !controlledLabels(namespace.metadata.labels, profile.component) ||
    node.metadata?.uid !== peer.nodeUid ||
    node.metadata.name !== peer.nodeName ||
    node.metadata.deletionTimestamp ||
    node.status?.nodeInfo?.bootID !== peer.bootId ||
    node.status.nodeInfo.architecture !== "amd64" ||
    pod.metadata?.uid !== peer.podUid ||
    pod.metadata.name !== peer.podName ||
    pod.metadata.deletionTimestamp ||
    pod.metadata.namespace !== config.observerNamespace ||
    !controlledLabels(pod.metadata.labels, profile.component) ||
    !profile.safeSpec(pod.spec, config, peer.nodeName) ||
    pod.status?.phase !== "Running" ||
    !pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) ||
    owner.metadata?.uid !== config.owner.uid ||
    owner.metadata.name !== config.owner.name ||
    owner.metadata.namespace !== config.observerNamespace ||
    owner.metadata.deletionTimestamp ||
    !Number.isSafeInteger(owner.metadata.generation) ||
    Number(owner.metadata.generation) < 1 ||
    owner.status?.observedGeneration !== owner.metadata.generation ||
    !controlledLabels(owner.metadata.labels, profile.component) ||
    !owner.spec?.template ||
    !profile.safeSpec(owner.spec.template.spec, config) ||
    !controlledLabels(owner.spec.template.metadata?.labels, profile.component)
  )
    throw unknown();
  const owners = pod.metadata.ownerReferences?.filter(
    (reference) => reference.controller === true,
  );
  if (
    owners?.length !== 1 ||
    owners[0]?.kind !== "DaemonSet" ||
    owners[0].apiVersion !== "apps/v1" ||
    owners[0].name !== config.owner.name ||
    owners[0].uid !== config.owner.uid ||
    pod.metadata.ownerReferences?.length !== 1
  )
    throw unknown();
  const statuses = pod.status.containerStatuses;
  if (
    statuses?.length !== 1 ||
    statuses[0]?.name !== profile.containerName ||
    statuses[0].ready !== true ||
    !statuses[0].state?.running ||
    !Number.isSafeInteger(statuses[0].restartCount) ||
    statuses[0].restartCount < 0 ||
    !qualifiedImageId(statuses[0].imageID, config) ||
    typeof statuses[0].containerID !== "string" ||
    !/^containerd:\/\/[a-f0-9]{64}$/.test(statuses[0].containerID)
  )
    throw unknown();
  return {
    podUid: pod.metadata.uid,
    containerId: statuses[0].containerID,
    imageId: statuses[0].imageID,
    restartCount: statuses[0].restartCount,
    ownerGeneration: owner.metadata.generation!,
    ownerTemplate: encoded(owner.spec.template),
  };
}
export function nodeObserverFromConfig(
  file: string,
  context: string,
  supplied: NodeObserverConfiguration,
  authorized: () => void = () => {},
  signal?: AbortSignal,
): NodeObserver {
  let config: NodeObserverConfiguration, kube: KubeConfig;
  try {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw unknown();
    if (!isAbsolute(file) || !context || !validNodeObserverConfig(supplied))
      throw unknown();
    config = JSON.parse(JSON.stringify(supplied)) as NodeObserverConfiguration;
    kube = new KubeConfig();
    kube.loadFromFile(file);
    if (!kube.getContexts().some((entry) => entry.name === context))
      throw unknown();
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
    apps = kube.makeApiClient(AppsV1Api);
  return {
    async observeNode(nodeName: string): Promise<NodeObserverResult> {
      const peer = config.peers.find((entry) => entry.nodeName === nodeName);
      if (!peer) throw unknown();
      const controller = new AbortController(),
        deadline = performance.now() + 20_000;
      const activeSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const sockets = new Set<WebSocket>();
      const guard = () => {
        authorized();
        if (activeSignal.aborted || performance.now() >= deadline)
          throw unknown();
      };
      let abort: () => void = () => {};
      const expired = new Promise<never>((_, reject) => {
        abort = () => {
          for (const socket of sockets) socket.terminate();
          reject(unknown());
        };
        activeSignal.addEventListener("abort", abort, { once: true });
      });
      const timer = setTimeout(() => controller.abort(), 20_000);
      const bounded = <T>(pending: Promise<T>): Promise<T> =>
        Promise.race([pending, expired]);
      const options: ConfigurationOptions = {
        middlewareMergeStrategy: "append",
        middleware: [
          {
            pre(request) {
              guard();
              request.setSignal(activeSignal);
              return new Observable(Promise.resolve(request));
            },
            post(response) {
              return new Observable(Promise.resolve(response));
            },
          },
        ],
      };
      try {
        guard();
        const before = await bounded(
          verifyDaemonPeer(core, apps, options, config, peer),
        );
        guard();
        const requestId = randomUUID();
        const bytes = await bounded(
          new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let stdoutBytes = 0,
              stderrBytes = 0,
              statusSuccess = false,
              stdoutFinished = false,
              socketClosed = false,
              settled = false;
            const fail = () => {
              if (settled) return;
              settled = true;
              for (const socket of sockets) socket.terminate();
              reject(unknown());
            };
            const finish = () => {
              if (!settled && statusSuccess && stdoutFinished && socketClosed) {
                settled = true;
                resolve(Buffer.concat(chunks));
              }
            };
            const stdout = new Writable({
              write(chunk, _encoding, done) {
                const buffer = Buffer.from(chunk);
                stdoutBytes += buffer.length;
                if (stdoutBytes > MAX_STDOUT) {
                  fail();
                  done();
                  return;
                }
                chunks.push(buffer);
                done();
              },
            });
            const stderr = new Writable({
              write(chunk, _encoding, done) {
                stderrBytes += Buffer.byteLength(chunk);
                if (stderrBytes > MAX_STDERR) fail();
                done();
              },
            });
            stdout.on("error", fail);
            stderr.on("error", fail);
            stdout.on("finish", () => {
              stdoutFinished = true;
              finish();
            });
            const streams = { stdin: new PassThrough(), stdout, stderr };
            const handler = new WebSocketHandler(
              kube,
              (uri, protocols, httpsOptions) => {
                guard();
                if (
                  !uri.startsWith("wss://") ||
                  httpsOptions.rejectUnauthorized === false
                )
                  throw unknown();
                const socket = new WebSocket(
                  uri,
                  protocols.filter(
                    (protocol) => protocol === "v4.channel.k8s.io",
                  ),
                  {
                    ...httpsOptions,
                    handshakeTimeout: Math.max(
                      1,
                      Math.floor(deadline - performance.now()),
                    ),
                    maxPayload: MAX_STDOUT,
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
                            const data = event.data;
                            if (
                              !Buffer.isBuffer(data) ||
                              data.length < 1 ||
                              data.length > MAX_STDOUT
                            )
                              throw unknown();
                            const stream = data[0];
                            if (![1, 2, 3].includes(stream!)) throw unknown();
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
              streams,
            );
            const command = [
              "/node-runtime-observer",
              "observe",
              "--request-id",
              requestId,
              "--endpoint",
              "unix:///run/cri.sock",
              "--installation-id",
              config.installationId,
              "--region-id",
              config.regionId,
              "--node-name",
              peer.nodeName,
              "--node-uid",
              peer.nodeUid,
              "--expected-boot-id",
              peer.bootId,
              "--timeout",
              "10s",
              "--max-entries",
              "4096",
            ];
            new Exec(kube, handler)
              .exec(
                config.observerNamespace,
                peer.podName,
                "observer",
                command,
                stdout,
                stderr,
                null,
                false,
                (status: V1Status) => {
                  if (
                    status.status !== "Success" ||
                    (status.kind !== undefined && status.kind !== "Status") ||
                    (status.apiVersion !== undefined &&
                      status.apiVersion !== "v1")
                  ) {
                    fail();
                    return;
                  }
                  statusSuccess = true;
                  finish();
                },
              )
              .catch(fail);
          }),
        );
        guard();
        const received = envelope(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          requestId,
          config,
          peer,
        );
        const after = await bounded(
          verifyDaemonPeer(core, apps, options, config, peer),
        );
        guard();
        if (encoded(before) !== encoded(after)) throw unknown();
        return {
          envelope: received,
          probeHash: createHash("sha256")
            .update(encoded(received))
            .digest("hex"),
        };
      } catch {
        throw unknown();
      } finally {
        clearTimeout(timer);
        activeSignal.removeEventListener("abort", abort);
        controller.abort();
        for (const socket of sockets) socket.terminate();
      }
    },
  };
}
