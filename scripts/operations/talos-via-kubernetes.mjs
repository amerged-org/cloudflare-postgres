#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import process from "node:process";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { isIP } from "node:net";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { PgcfClient } from "../../packages/contracts/src/client.ts";
import { startCapabilityProxy } from "../../apps/node-bootstrap/src/proxy-command.ts";
import {
  nativeTalosConfig,
  nativeKubeconfig,
} from "../../apps/node-bootstrap/src/bootstrap.ts";

const require = createRequire(
  new URL("../../apps/node-bootstrap/package.json", import.meta.url),
);
const { WebSocket, createWebSocketStream } = require("ws");
const { parse } = require("yaml");
const fail = (code) => {
  throw Error(code);
};
const must = (value, code) => {
  if (!value) fail(code);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const imageDigest = (value) =>
  typeof value === "string"
    ? /@sha256:([a-f0-9]{64})$/.exec(value)?.[1]
    : undefined;

export function verifyNode(binding, namespace, node, knownAddress) {
  must(
    namespace?.metadata?.uid === binding.cluster_uid &&
      node?.metadata?.uid === binding.node_uid &&
      node.metadata.name === binding.node_name &&
      node.status?.conditions?.some(
        (v) => v.type === "Ready" && v.status === "True",
      ),
    "operator_actual_identity_mismatch",
  );
  must(
    isIP(knownAddress) > 0 &&
      node.status?.addresses?.some(
        (v) => v.type === "InternalIP" && v.address === knownAddress,
      ),
    "operator_node_address_mismatch",
  );
  const info = node.status.nodeInfo;
  must(
    uuid(info?.systemUUID) && uuid(info?.bootID),
    "operator_physical_identity_unknown",
  );
  return {
    nodeName: node.metadata.name,
    address: knownAddress,
    systemUuid: info.systemUUID.toLowerCase(),
    bootId: info.bootID.toLowerCase(),
  };
}

export function selectCiliumPod(
  pods,
  daemonSet,
  node,
  expectedImage,
  expectedImageID,
) {
  must(
    daemonSet?.metadata?.name === "cilium" &&
      daemonSet.metadata.namespace === "kube-system" &&
      uuid(daemonSet.metadata.uid) &&
      imageDigest(expectedImage) &&
      imageDigest(expectedImageID),
    "operator_cilium_identity_unknown",
  );
  const template = daemonSet.spec?.template?.spec;
  must(
    template?.hostNetwork === true &&
      template.containers?.some(
        (v) => v.name === "cilium-agent" && v.image === expectedImage,
      ),
    "operator_cilium_template_mismatch",
  );
  const candidates = pods?.items?.filter(
    (p) =>
      !p.metadata?.deletionTimestamp &&
      uuid(p.metadata?.uid) &&
      p.metadata.namespace === "kube-system" &&
      p.metadata.labels?.["k8s-app"] === "cilium" &&
      p.spec?.hostNetwork === true &&
      p.spec.nodeName === node.nodeName &&
      p.status?.phase === "Running" &&
      p.status.conditions?.some(
        (v) => v.type === "Ready" && v.status === "True",
      ) &&
      p.metadata.ownerReferences?.some(
        (v) =>
          v.controller === true &&
          v.kind === "DaemonSet" &&
          v.name === "cilium" &&
          v.uid === daemonSet.metadata.uid,
      ) &&
      p.spec.containers?.some(
        (v) => v.name === "cilium-agent" && v.image === expectedImage,
      ) &&
      p.status.containerStatuses?.some(
        (v) =>
          v.name === "cilium-agent" &&
          v.ready === true &&
          v.state?.running &&
          imageDigest(v.imageID) === imageDigest(expectedImageID),
      ),
  );
  must(candidates?.length === 1, "operator_cilium_pod_mismatch");
  const pod = candidates[0];
  must(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(pod.metadata.name),
    "operator_cilium_pod_mismatch",
  );
  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    ownerUid: daemonSet.metadata.uid,
    image: expectedImage,
    imageID: expectedImageID,
  };
}

export function assertSameCarrier(before, after) {
  must(
    JSON.stringify(before) === JSON.stringify(after),
    "operator_carrier_changed",
  );
}

export function validateTalosCommand(args, outputDir) {
  must(
    Array.isArray(args) &&
      args.length > 0 &&
      args.every(
        (v) => typeof v === "string" && v.length > 0 && !v.includes("\0"),
      ),
    "operator_command_required",
  );
  if (args[0] === "upgrade-k8s")
    fail("talos_upgrade_dry_run_writes_configuration");
  must(
    !args.some(
      (v) =>
        /^--(insecure|endpoints|nodes|context|talosconfig|proxy-url)(=|$)/.test(
          v,
        ) || /^-[cen](.|$)/.test(v),
    ),
    "operator_target_override_refused",
  );
  if (args[0] === "etcd" && args[1] === "snapshot") {
    must(
      args.length === 3 &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(args[2]) &&
        basename(args[2]) === args[2] &&
        args[2] !== "-",
      "operator_snapshot_path_refused",
    );
    return ["etcd", "snapshot", join(outputDir, args[2])];
  }
  must(
    ["get", "read", "version"].includes(args[0]) ||
      (args[0] === "image" && args[1] === "list"),
    "operator_write_command_refused",
  );
  return [...args];
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 1000);
  try {
    await closed;
  } finally {
    clearTimeout(forced);
  }
}

/** Opens only the existing administrator Kubernetes channel and existing host-network carrier. */
export async function openTalosOperator(options) {
  process.umask(0o077);
  must(
    isAbsolute(options.outputDir) &&
      isAbsolute(options.kubeconfig) &&
      isAbsolute(options.talosconfig) &&
      isAbsolute(options.kubectl) &&
      isAbsolute(options.talosctl),
    "operator_private_paths_required",
  );
  must(
    Number.isInteger(options.timeoutSeconds) &&
      options.timeoutSeconds >= 1 &&
      options.timeoutSeconds <= 1800,
    "operator_lifetime_invalid",
  );
  for (const file of [options.kubeconfig, options.talosconfig]) {
    const metadata = await stat(file);
    must(
      metadata.isFile() &&
        metadata.uid === process.getuid() &&
        (metadata.mode & 0o077) === 0,
      "operator_custody_permissions_invalid",
    );
  }
  await mkdir(options.outputDir, { mode: 0o700 });
  const abort = new globalThis.AbortController(),
    timer = setTimeout(() => abort.abort(), options.timeoutSeconds * 1000);
  const sockets = new Set(),
    children = new Set();
  let kubeProxy,
    talosProxy,
    binding,
    carrier,
    closing,
    portForwardLog = "",
    connections = 0,
    sequence = 0;
  const childEnv = { ...process.env };
  delete childEnv[options.apiKeyEnv];
  const save = async (name, bytes) =>
    writeFile(join(options.outputDir, name), bytes, {
      mode: 0o600,
      flag: "wx",
    });
  const run = async (program, args, label) => {
    abort.signal.throwIfAborted();
    const child = spawn(program, args, {
      cwd: options.outputDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      excessive = false;
    const take = (kind) => (value) => {
      if (stdout.length + stderr.length + value.length > 16 * 1024 * 1024) {
        if (!excessive) void stopChild(child);
        excessive = true;
        return;
      }
      if (kind === "stdout") stdout = Buffer.concat([stdout, value]);
      else stderr = Buffer.concat([stderr, value]);
    };
    child.stdout.on("data", take("stdout"));
    child.stderr.on("data", take("stderr"));
    const stop = () => {
      void stopChild(child);
    };
    abort.signal.addEventListener("abort", stop, { once: true });
    const result = await new Promise((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", resolve);
    });
    abort.signal.removeEventListener("abort", stop);
    children.delete(child);
    await save(`${label}.stdout.private.log`, stdout);
    await save(`${label}.stderr.private.log`, stderr);
    must(
      result === 0 && !excessive && !abort.signal.aborted,
      "operator_local_command_failed",
    );
    return stdout;
  };
  const signalStop = () => {
    void close();
  };
  const close = () =>
    (closing ??= (async () => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", signalStop);
      process.removeListener("SIGINT", signalStop);
      abort.abort();
      await Promise.all([...children].map(stopChild));
      for (const socket of sockets) socket.terminate();
      await talosProxy?.close();
      await kubeProxy?.close();
      await save("portforward.private.log", portForwardLog);
    })());
  process.once("SIGTERM", signalStop);
  process.once("SIGINT", signalStop);
  abort.signal.addEventListener(
    "abort",
    () => globalThis.queueMicrotask(signalStop),
    { once: true },
  );
  try {
    const client = new PgcfClient({
      baseUrl: options.apiUrl,
      apiKey: process.env[options.apiKeyEnv],
    });
    const descriptor = client.operatorKubernetesRequest(
      options.nodeId,
      options.nodeUid,
    );
    const originalKube = await readFile(options.kubeconfig, "utf8"),
      originalTalos = await readFile(options.talosconfig, "utf8");
    abort.signal.throwIfAborted();
    const kubeConfig = parse(originalKube),
      endpoint = new URL(kubeConfig.clusters?.[0]?.cluster?.server);
    must(
      endpoint.protocol === "https:" &&
        endpoint.port === "6443" &&
        isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) > 0,
      "operator_kubernetes_target_invalid",
    );
    kubeProxy = await startCapabilityProxy(
      (authority) =>
        authority === endpoint.host ? "kubernetes_api" : undefined,
      async () => {
        abort.signal.throwIfAborted();
        const socket = new WebSocket(descriptor.url, {
          headers: descriptor.headers,
          followRedirects: false,
          handshakeTimeout: 15000,
          perMessageDeflate: false,
          maxPayload: 256 * 1024,
        });
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        const stop = () => socket.terminate();
        abort.signal.addEventListener("abort", stop, { once: true });
        try {
          let actual;
          await new Promise((resolve, reject) => {
            socket.once("upgrade", (response) => {
              try {
                actual = client.parseOperatorKubernetesResponse(
                  new globalThis.Headers(
                    Object.entries(response.headers).filter(
                      ([, value]) => typeof value === "string",
                    ),
                  ),
                  options.nodeUid,
                );
                if (binding) assertSameCarrier(binding, actual);
              } catch {
                socket.terminate();
                reject(Error("operator_binding_changed"));
              }
            });
            socket.once("open", () =>
              actual ? resolve() : reject(Error("operator_binding_missing")),
            );
            socket.once("error", () => reject(Error("operator_relay_failed")));
            socket.once("unexpected-response", (_request, response) => {
              response.resume();
              socket.terminate();
              reject(Error("operator_relay_refused"));
            });
          });
          binding ??= actual;
          connections++;
          const stream = createWebSocketStream(socket, {
            highWaterMark: 64 * 1024,
          });
          stream.once("close", () => {
            abort.signal.removeEventListener("abort", stop);
            socket.terminate();
          });
          return stream;
        } catch (error) {
          abort.signal.removeEventListener("abort", stop);
          socket.terminate();
          throw error;
        }
      },
      abort.signal,
    );
    if (abort.signal.aborted) {
      await kubeProxy.close();
      abort.signal.throwIfAborted();
    }
    const kubePath = join(options.outputDir, "kubeconfig.private.json");
    await save(
      "kubeconfig.private.json",
      nativeKubeconfig(
        originalKube,
        kubeConfig.clusters[0].cluster.server,
        kubeProxy.url,
      ),
    );
    const get = async (path) =>
      JSON.parse(
        (
          await run(
            options.kubectl,
            [
              "--kubeconfig",
              kubePath,
              "--request-timeout=20s",
              "get",
              "--raw",
              path,
            ],
            `kube-${++sequence}`,
          )
        ).toString("utf8"),
      );
    const inspect = async () => {
      const namespace = await get("/api/v1/namespaces/kube-system");
      must(binding, "operator_binding_missing");
      const node = await get(`/api/v1/nodes/${binding.node_name}`),
        physical = verifyNode(binding, namespace, node, options.nodeAddress);
      const daemon = await get(
          "/apis/apps/v1/namespaces/kube-system/daemonsets/cilium",
        ),
        pods = await get(
          `/api/v1/namespaces/kube-system/pods?fieldSelector=spec.nodeName%3D${physical.nodeName}&labelSelector=k8s-app%3Dcilium`,
        );
      return {
        physical,
        pod: selectCiliumPod(
          pods,
          daemon,
          physical,
          options.ciliumImage,
          options.ciliumImageID,
        ),
      };
    };
    carrier = await inspect();
    const forwarded = spawn(
      options.kubectl,
      [
        "--kubeconfig",
        kubePath,
        "--request-timeout=0",
        "-n",
        "kube-system",
        "port-forward",
        "--address=127.0.0.1",
        `pod/${carrier.pod.name}`,
        ":50000",
      ],
      {
        cwd: options.outputDir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(forwarded);
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(Error("operator_portforward_timeout")),
        20000,
      );
      const stop = () => reject(Error("operator_aborted"));
      abort.signal.addEventListener("abort", stop, { once: true });
      const finish = (error, value) => {
        clearTimeout(timeout);
        abort.signal.removeEventListener("abort", stop);
        if (error) reject(error);
        else resolve(value);
      };
      forwarded.stdout.on("data", (value) => {
        output += value.toString();
        portForwardLog = (portForwardLog + value.toString()).slice(-32768);
        if (output.length > 32768)
          return finish(Error("operator_portforward_output_limit"));
        const match = /Forwarding from 127\.0\.0\.1:(\d+) -> 50000/.exec(
          output,
        );
        if (match) finish(null, Number(match[1]));
      });
      forwarded.stderr.on("data", (value) => {
        portForwardLog = (portForwardLog + value.toString()).slice(-32768);
      });
      forwarded.once("error", () =>
        finish(Error("operator_portforward_failed")),
      );
      forwarded.once("close", () =>
        finish(Error("operator_portforward_closed")),
      );
    });
    must(
      Number.isInteger(port) && port > 0 && port < 65536,
      "operator_portforward_target_invalid",
    );
    talosProxy = await startCapabilityProxy(
      (authority) =>
        authority === `${options.nodeAddress}:50000` ? "talos_api" : undefined,
      async () => {
        abort.signal.throwIfAborted();
        return await new Promise((resolve, reject) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => resolve(socket));
          socket.once("error", () =>
            reject(Error("operator_portforward_connect_failed")),
          );
        });
      },
      abort.signal,
    );
    if (abort.signal.aborted) {
      await talosProxy.close();
      abort.signal.throwIfAborted();
    }
    const talosPath = join(options.outputDir, "talosconfig.private.yaml");
    await save(
      "talosconfig.private.yaml",
      nativeTalosConfig(originalTalos, options.nodeAddress, talosProxy.url),
    );
    const verify = async () => {
      assertSameCarrier(carrier, await inspect());
      const dmi = (
        await run(
          options.talosctl,
          [
            "--talosconfig",
            talosPath,
            "read",
            "/sys/class/dmi/id/product_uuid",
          ],
          `talos-identity-${++sequence}`,
        )
      )
        .toString("utf8")
        .trim()
        .toLowerCase();
      must(
        dmi === carrier.physical.systemUuid,
        "operator_talos_physical_identity_mismatch",
      );
    };
    await verify();
    return {
      talosPath,
      outputDir: options.outputDir,
      carrier,
      binding,
      verify,
      close,
      run: (args) =>
        run(
          options.talosctl,
          [
            "--talosconfig",
            talosPath,
            ...validateTalosCommand(args, options.outputDir),
          ],
          `talos-command-${++sequence}`,
        ),
      connections: () => connections,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const flags = [
  "api-url",
  "api-key-env",
  "node-id",
  "node-uid",
  "node-address",
  "kubeconfig",
  "talosconfig",
  "cilium-image",
  "cilium-image-id",
  "output-dir",
  "kubectl",
  "talosctl",
  "timeout-seconds",
];
async function main(args) {
  const split = args.indexOf("--");
  must(split >= 0, "operator_command_required");
  const values = {};
  for (let i = 0; i < split; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    must(
      flags.includes(key) &&
        !(key in values) &&
        args[i + 1] &&
        !args[i + 1].startsWith("--"),
      "operator_arguments_invalid",
    );
    values[key] = args[i + 1];
  }
  must(
    flags.filter((v) => v !== "timeout-seconds").every((v) => values[v]),
    "operator_arguments_invalid",
  );
  must(
    /^[A-Z][A-Z0-9_]{0,127}$/.test(values["api-key-env"]),
    "operator_api_key_env_invalid",
  );
  const options = {
    apiUrl: values["api-url"],
    apiKeyEnv: values["api-key-env"],
    nodeId: values["node-id"],
    nodeUid: values["node-uid"],
    nodeAddress: values["node-address"],
    kubeconfig: values.kubeconfig,
    talosconfig: values.talosconfig,
    ciliumImage: values["cilium-image"],
    ciliumImageID: values["cilium-image-id"],
    outputDir: values["output-dir"],
    kubectl: values.kubectl,
    talosctl: values.talosctl,
    timeoutSeconds: Number(values["timeout-seconds"] ?? "300"),
  };
  const command = args.slice(split + 1);
  validateTalosCommand(command, options.outputDir);
  const session = await openTalosOperator(options);
  try {
    const stdout = await session.run(command);
    await session.verify();
    let snapshot;
    if (command[0] === "etcd" && command[1] === "snapshot") {
      const file = join(options.outputDir, command[2]),
        metadata = await stat(file);
      must(
        metadata.isFile() && metadata.size > 0 && (metadata.mode & 0o077) === 0,
        "operator_snapshot_file_invalid",
      );
      const checksum = createHash("sha256");
      for await (const bytes of createReadStream(file)) checksum.update(bytes);
      snapshot = { file, bytes: metadata.size, sha256: checksum.digest("hex") };
    }
    const result = {
      ok: true,
      transport:
        "Cloudflare Kubernetes relay and existing host-network Pod port-forward; Talos mTLS",
      cluster_uid: session.binding.cluster_uid,
      node_uid: session.binding.node_uid,
      carrier: session.carrier,
      relay_connections: session.connections(),
      elapsed_output_bytes: stdout.length,
      stdout_sha256: digest(stdout),
      ...(snapshot ? { snapshot } : {}),
      provider_calls: 0,
      fleet_writes: 0,
    };
    await writeFile(
      join(options.outputDir, "result.private.json"),
      JSON.stringify(result),
      { mode: 0o600, flag: "wx" },
    );
    process.stdout.write(
      JSON.stringify({
        ok: true,
        relay_connections: result.relay_connections,
        provider_calls: 0,
        fleet_writes: 0,
        stdout_bytes: stdout.length,
        result_file: join(options.outputDir, "result.private.json"),
        ...(snapshot
          ? {
              snapshot_file: snapshot.file,
              snapshot_bytes: snapshot.bytes,
              snapshot_sha256: snapshot.sha256,
            }
          : {}),
      }) + "\n",
    );
  } finally {
    await session.close();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch((error) => {
    const code = /^[a-z][a-z0-9_]{0,95}$/.test(error?.message ?? "")
      ? error.message
      : "operator_failed";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  });
