#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import process from "node:process";
import { stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openTalosOperator,
  validateTalosCommand,
} from "../../apps/node-bootstrap/src/talos-operator.ts";
export {
  openTalosOperator,
  verifyNode,
  selectCiliumPod,
  assertSameCarrier,
  validateTalosCommand,
  stopChild,
} from "../../apps/node-bootstrap/src/talos-operator.ts";
const fail = (code) => {
  throw Error(code);
};
const must = (value, code) => {
  if (!value) fail(code);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");

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
