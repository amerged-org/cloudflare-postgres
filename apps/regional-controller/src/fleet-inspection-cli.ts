// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { lstat, open, mkdtemp, link, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CoreV1Api, KubeConfig, Observable } from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import { load, JSON_SCHEMA } from "js-yaml";
import { inventoryPages } from "./kubernetes.ts";
import { fleetConfiguration, inspectFleet } from "./fleet-inspection.ts";
import type {
  FleetConfiguration,
  FleetInspection,
} from "./fleet-inspection.ts";
export interface FleetOperatorConfiguration extends FleetConfiguration {
  controlOrigin: string;
  installationTokenFile: string;
  kubeconfigFile: string;
  kubeconfigContext: string;
  reportPath: string;
}
const fail = () => new Error("fleet_inspection_failed");
async function privateRead(path: string, max: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      (process.getuid && before.uid !== process.getuid()) ||
      before.size < 1 ||
      before.size > max
    )
      throw fail();
    const result = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < result.length) {
      const read = await file.read(
        result,
        offset,
        result.length - offset,
        offset,
      );
      if (!read.bytesRead) throw fail();
      offset += read.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead)
      throw fail();
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw fail();
    return result;
  } finally {
    await file.close();
  }
}
export function fleetOperatorConfiguration(
  value: unknown,
): FleetOperatorConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw fail();
  const c = value as Record<string, unknown>,
    keys = [
      "schemaVersion",
      "regionId",
      "bindings",
      "controlOrigin",
      "installationTokenFile",
      "kubeconfigFile",
      "kubeconfigContext",
      "reportPath",
    ];
  if (
    Object.keys(c).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(c, k)) ||
    !["installationTokenFile", "kubeconfigFile", "reportPath"].every(
      (k) => typeof c[k] === "string" && isAbsolute(c[k] as string),
    ) ||
    typeof c.kubeconfigContext !== "string" ||
    !c.kubeconfigContext ||
    typeof c.controlOrigin !== "string"
  )
    throw fail();
  const origin = new URL(c.controlOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw fail();
  return {
    ...fleetConfiguration({
      schemaVersion: c.schemaVersion,
      regionId: c.regionId,
      bindings: c.bindings,
    }),
    controlOrigin: origin.origin,
    installationTokenFile: c.installationTokenFile as string,
    kubeconfigFile: c.kubeconfigFile as string,
    kubeconfigContext: c.kubeconfigContext,
    reportPath: c.reportPath as string,
  };
}
async function responseJson(response: Response, max: number): Promise<unknown> {
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    Number(response.headers.get("content-length")) > max ||
    !response.body
  )
    throw fail();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      length += read.value.byteLength;
      if (length > max) throw fail();
      chunks.push(read.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export async function collectFleet(
  config: FleetOperatorConfiguration,
  cancellation?: AbortSignal,
): Promise<FleetInspection> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw fail();
  const credentials = (await privateRead(config.installationTokenFile, 8192))
    .toString("utf8")
    .trim();
  if (
    !credentials ||
    Array.from(credentials).some((character) => character.charCodeAt(0) <= 32)
  )
    throw fail();
  const bytes = await privateRead(config.kubeconfigFile, 1024 * 1024),
    kube = new KubeConfig();
  // Validate before the SDK can read token-file or resolve external auth.
  const raw: unknown = load(bytes.toString("utf8"), { schema: JSON_SCHEMA });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
  const users = (raw as Record<string, unknown>).users;
  if (
    !Array.isArray(users) ||
    users.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return true;
      const user = (entry as Record<string, unknown>).user;
      return (
        !user ||
        typeof user !== "object" ||
        Array.isArray(user) ||
        ["exec", "auth-provider", "token-file"].some((key) =>
          Object.hasOwn(user, key),
        )
      );
    })
  )
    throw fail();
  kube.loadFromString(JSON.stringify(raw));
  if (!kube.getContexts().some((c) => c.name === config.kubeconfigContext))
    throw fail();
  kube.setCurrentContext(config.kubeconfigContext);
  const cluster = kube.getCurrentCluster();
  if (
    !cluster ||
    cluster.skipTLSVerify ||
    cluster.caFile ||
    new URL(cluster.server).protocol !== "https:"
  )
    throw fail();
  const user = kube.getCurrentUser();
  if (
    !user ||
    user.exec ||
    user.authProvider ||
    !cluster.caData ||
    user.certFile ||
    user.keyFile ||
    (!user.token && !(user.certData && user.keyData))
  )
    throw fail();
  const core = kube.makeApiClient(CoreV1Api),
    deadline = Date.now() + 20000,
    signal = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(cancellation ? [cancellation] : []),
    ]);
  const budget = { remainingRequests: 10, remainingResources: 1000, deadline };
  const options: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          if (signal.aborted) throw fail();
          request.setSignal(signal);
          return new Observable(Promise.resolve(request));
        },
        post(response) {
          return new Observable(Promise.resolve(response));
        },
      },
    ],
  };
  const report = await inspectFleet(
    {
      schemaVersion: config.schemaVersion,
      regionId: config.regionId,
      bindings: config.bindings,
    },
    {
      provider: async () =>
        responseJson(
          await fetch(
            config.controlOrigin +
              "/v1/installation/providers/contabo/instances",
            {
              headers: { authorization: `Bearer ${credentials}` },
              redirect: "error",
              signal,
            },
          ),
          1024 * 1024,
        ),
      nodes: () =>
        inventoryPages(
          (cursor) => core.listNode({ limit: 100, _continue: cursor }, options),
          "Node",
          "v1",
          budget,
        ),
    },
  );
  if (Date.now() > deadline || signal.aborted) throw fail();
  return report;
}
async function publishReport(
  path: string,
  report: FleetInspection,
): Promise<void> {
  const parent = dirname(path),
    info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw fail();
  const work = await mkdtemp(join(parent, ".pgcf-fleet-"));
  try {
    const source = join(work, "report"),
      file = await open(
        source,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    try {
      await file.writeFile(JSON.stringify(report));
      await file.sync();
    } finally {
      await file.close();
    }
    await link(source, path);
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
export async function runFleetInspection(args: string[]): Promise<number> {
  const cancellation = new AbortController(),
    cancel = () => cancellation.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw fail();
    const config = fleetOperatorConfiguration(
        JSON.parse((await privateRead(args[1], 65536)).toString("utf8")),
      ),
      report = await collectFleet(config, cancellation.signal);
    if (cancellation.signal.aborted) throw fail();
    await publishReport(config.reportPath, report);
    process.stdout.write(
      JSON.stringify({
        mode: "fleet-inspection",
        status: report.status,
        boundNodes: report.boundNodes.length,
        unmanagedInstances: report.unmanagedInstances.length,
        unmanagedNodes: report.unmanagedNodes.length,
        blockers: report.blockers,
        evidenceHash: report.evidenceHash,
        machineIdentityVerified: false,
        capacityReserved: false,
        actionsEnabled: false,
      }) + "\n",
    );
    return report.status === "observed" ? 0 : 1;
  } catch {
    process.stdout.write(
      JSON.stringify({
        mode: "fleet-inspection",
        status: "deferred",
        error: { code: "fleet_inspection_failed" },
        actionsEnabled: false,
      }) + "\n",
    );
    return 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
