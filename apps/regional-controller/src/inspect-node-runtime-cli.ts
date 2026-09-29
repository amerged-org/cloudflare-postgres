// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  nodeObserverFromConfig,
  validNodeObserverConfig,
} from "./node-observer.ts";

export async function inspectNodeRuntime(
  arguments_: string[],
): Promise<number> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (
      arguments_.length !== 2 ||
      arguments_[0] !== "--config" ||
      !arguments_[1] ||
      !isAbsolute(arguments_[1])
    )
      throw new Error("invalid_config");
    const info = await lstat(arguments_[1]);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 65_536 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("invalid_config");
    const bytes = await readFile(arguments_[1]);
    if (bytes.byteLength > 65_536) throw new Error("invalid_config");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const keys = [
      "schemaVersion",
      "kubeconfigFile",
      "kubeconfigContext",
      "nodeObserver",
      "peerNodeName",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))
    )
      throw new Error("invalid_config");
    const config = value as Record<string, unknown>;
    if (
      config.schemaVersion !== 1 ||
      typeof config.kubeconfigFile !== "string" ||
      !isAbsolute(config.kubeconfigFile) ||
      typeof config.kubeconfigContext !== "string" ||
      !config.kubeconfigContext ||
      !validNodeObserverConfig(config.nodeObserver) ||
      typeof config.peerNodeName !== "string" ||
      !config.nodeObserver.peers.some(
        (peer) => peer.nodeName === config.peerNodeName,
      )
    )
      throw new Error("invalid_config");
    const observer = nodeObserverFromConfig(
      config.kubeconfigFile,
      config.kubeconfigContext,
      config.nodeObserver,
      () => shutdown.signal.throwIfAborted(),
      shutdown.signal,
    );
    const result = await observer.observeNode(config.peerNodeName);
    process.stdout.write(
      `${JSON.stringify({ mode: "node-runtime-inspection", status: "observed", counts: { sandboxes: result.envelope.snapshot.sandboxes.length, containers: result.envelope.snapshot.containers.length }, probeHash: result.probeHash })}\n`,
    );
    return 0;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ mode: "node-runtime-inspection", status: "unknown", error: { code: "node_observation_unknown" } })}\n`,
    );
    return 1;
  } finally {
    shutdown.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
